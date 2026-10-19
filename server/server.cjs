// B2 Bridge v3 - Express backend. Port of v2 logic (stdlib) to Express.
// Auth (v3.1): SESSION ONLY untuk semua route. Basic Auth DIHAPUS TOTAL.
// Alasan: browser nyimpen Basic lama dari v1/v2 dan otomatis ngirim di semua request,
// jadi server kira masih login dan SPA langsung masuk dashboard tanpa password.
// Dengan session-only, Basic yang ke-cache diabaikan, user wajib login form.
// /login GET always serves the SPA (200) - Svelte checks /api/me and redirects itself.
// Logout: deletes server-side session + clears cookie with Max-Age=0.
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const BRIDGE_DIR = __dirname; // v3/server
const CONTAINER_ROOT = path.join(BRIDGE_DIR, '..'); // v3/
const APPS_FILE = path.join(BRIDGE_DIR, 'apps.json');
const ENV_FILE = path.join(BRIDGE_DIR, '.env');
const DIST_DIR = path.join(BRIDGE_DIR, '..', 'frontend', 'dist');
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '5013', 10);
const HOST = '0.0.0.0';
const BRIDGE_USER = process.env.BRIDGE_USER || 'admin';
const STARTED_AT = Date.now();

function log(...a) { console.log(new Date().toISOString(), '[bridge-v3]', ...a); }

function loadPassword() {
  if (process.env.BRIDGE_PASSWORD) return process.env.BRIDGE_PASSWORD;
  try {
    if (fs.existsSync(ENV_FILE)) {
      const txt = fs.readFileSync(ENV_FILE, 'utf8');
      const m = txt.match(/^BRIDGE_PASSWORD=(.+)$/m);
      if (m) return m[1].trim();
    }
  } catch (e) { log('read .env failed', e.message); }
  // Legacy fallback: v2 password di bridge/.env (agar password tidak berubah saat migrasi v2 -> v3).
  // Path di Pterodactyl: /home/container/bridge/.env. Lokal: ../../bridge/.env (tidak ada, jadi skip).
  try {
    const legacy = path.join(BRIDGE_DIR, '..', '..', 'bridge', '.env');
    if (fs.existsSync(legacy)) {
      const txt = fs.readFileSync(legacy, 'utf8');
      const m = txt.match(/^BRIDGE_PASSWORD=(.+)$/m);
      if (m) { log('Using legacy password from bridge/.env'); return m[1].trim(); }
    }
  } catch (e) { log('read legacy .env failed', e.message); }
  const pw = crypto.randomBytes(15).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  try { fs.writeFileSync(ENV_FILE, 'BRIDGE_PASSWORD=' + pw + '\n', { mode: 0o600 }); log('Bridge password auto-generated and saved to server/.env'); }
  catch (e) { log('could not save .env', e.message); }
  return pw;
}
const BRIDGE_PASSWORD = loadPassword();

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

// ---- sessions ----
const sessions = new Map();
const loginAttempts = new Map();
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); } }
  });
  return out;
}
function checkSession(req) {
  const c = parseCookies(req);
  if (!c.bridge_session) return false;
  const s = sessions.get(c.bridge_session);
  if (s && s.exp > Date.now()) return true;
  if (s) sessions.delete(c.bridge_session);
  return false;
}
// checkBasic sengaja tidak dipakai lagi (Basic dihapus total di v3.1).
// Dibiarkan sebagai fungsi mati agar tidak ada yang tidak sengaja mengaktifkan lagi
// tanpa sadar soal cache Basic di browser. Jangan panggil fungsi ini untuk auth.
function checkBasic(req) { return false; }
// API / proxy auth: SESSION ONLY (Basic diabaikan, walau browser ngirim header-nya)
function isApiAuthed(req) { return checkSession(req); }
function loginRateLimited(ip) {
  const now = Date.now();
  const e = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - e.first > 5 * 60 * 1000) { loginAttempts.set(ip, { count: 0, first: now }); return false; }
  return e.count >= 5;
}
function recordLoginFail(ip) {
  const now = Date.now();
  const e = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - e.first > 5 * 60 * 1000) loginAttempts.set(ip, { count: 1, first: now });
  else { e.count += 1; loginAttempts.set(ip, e); }
}

// ---- apps ----
let appConfigs = [];
function loadApps() {
  try { appConfigs = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8')); if (!Array.isArray(appConfigs)) appConfigs = []; }
  catch (e) { log('apps.json missing/invalid:', e.message); appConfigs = []; }
}
function saveApps() { fs.writeFileSync(APPS_FILE, JSON.stringify(appConfigs, null, 2) + '\n'); }
loadApps();
const apps = new Map();
function pushLog(app, line) {
  app.logs.push({ t: Date.now(), line: String(line).slice(0, 2000) });
  if (app.logs.length > 1000) app.logs.splice(0, app.logs.length - 1000);
}
function initApp(cfg) {
  if (!apps.has(cfg.name)) apps.set(cfg.name, { cfg, proc: null, status: 'stopped', logs: [], restarts: 0, crashWindow: [], manualStop: false, lastStart: 0 });
  else apps.get(cfg.name).cfg = cfg;
}
appConfigs.forEach(initApp);

// ---- Domain (Cloudflare Tunnel, embedded, BUKAN app) ----
// Config: v3/server/domain.json (mode 600). Berisi tunnelToken (buat cloudflared jalan)
// + apiToken (buat kelola tunnel/DNS via Cloudflare API, diisi user lewat menu Domain).
// Tunnel token + apiToken TIDAK pernah dikirim ke frontend (hanya boolean + hostname + tunnelId).
// Migrasi otomatis: kalau masih ada app "cloudflared" di apps.json (setup lama), pindahkan
// token + binary ke lokasi sistem, hapus app-nya, jalankan tunnel via domain manager.
// Domain tetap live (tunnel yang sama, token yang sama), cuma pindah dari "app" ke "menu Domain".
const DOMAIN_FILE = path.join(BRIDGE_DIR, 'domain.json');
const DOMAIN_BIN_DIR = path.join(BRIDGE_DIR, 'cloudflared-bin');
let domainConfig = null; // { hostname, tunnelId, tunnelName, tunnelToken, apiToken, zoneId, accountId, dnsRecordId }
let domainProc = null, domainLogs = [], domainStatus = 'stopped', domainManualStop = false, domainCrashWindow = [];
function loadDomain() { try { domainConfig = JSON.parse(fs.readFileSync(DOMAIN_FILE, 'utf8')); if (!domainConfig || typeof domainConfig !== 'object') domainConfig = null; } catch { domainConfig = null; } }
function saveDomain() { try { fs.writeFileSync(DOMAIN_FILE, JSON.stringify(domainConfig || {}, null, 2) + '\n', { mode: 0o600 }); } catch (e) { log('save domain failed', e.message); } }
loadDomain();
function domainPushLog(line) {
  domainLogs.push({ t: Date.now(), line: String(line).slice(0, 2000) });
  if (domainLogs.length > 500) domainLogs.splice(0, domainLogs.length - 500);
}
function decodeTunnelToken(tok) {
  try {
    const j = JSON.parse(Buffer.from(String(tok || '').trim(), 'base64').toString('utf8'));
    return { tunnelId: j.t || j.tunnelId || null, accountId: j.a || j.accountId || null };
  } catch { return { tunnelId: null, accountId: null }; }
}
function migrateCloudflaredApp() {
  const idx = appConfigs.findIndex((c) => c.name === 'cloudflared');
  if (idx === -1) return false;
  const cfg = appConfigs[idx];
  const appDir = resolveCwd(cfg);
  let token = '';
  try { token = fs.readFileSync(path.join(appDir, 'token.txt'), 'utf8').trim(); } catch {}
  let hostname = '';
  const m = String(cfg.description || '').match(/([a-z0-9][a-z0-9.-]+\.[a-z]{2,})/i);
  if (m) hostname = m[1];
  try {
    const srcBin = path.join(appDir, 'cloudflared');
    if (fs.existsSync(srcBin)) { fs.mkdirSync(DOMAIN_BIN_DIR, { recursive: true }); fs.renameSync(srcBin, path.join(DOMAIN_BIN_DIR, 'cloudflared')); }
  } catch (e) { log('migrate cloudflared binary failed', e.message); }
  const dec = decodeTunnelToken(token);
  domainConfig = {
    hostname, tunnelId: dec.tunnelId || '', tunnelName: 'controlpetro-' + (hostname.split('.')[0] || 'tunnel'),
    tunnelToken: token, apiToken: (domainConfig && domainConfig.apiToken) || '',
    zoneId: '', accountId: dec.accountId || '', dnsRecordId: '',
  };
  saveDomain();
  appConfigs.splice(idx, 1);
  saveApps();
  apps.delete('cloudflared');
  try { fs.rmSync(appDir, { recursive: true, force: true }); } catch {}
  log('migrated cloudflared app to Domain menu, hostname=', hostname, 'tunnelId=', dec.tunnelId);
  return true;
}
migrateCloudflaredApp();
async function ensureDomainBinary() {
  const bin = path.join(DOMAIN_BIN_DIR, 'cloudflared');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(DOMAIN_BIN_DIR, { recursive: true });
  const file = (process.arch === 'arm64') ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + file;
  domainPushLog('[domain] mengunduh cloudflared (' + file + ')...');
  return new Promise((resolve, reject) => {
    const dl = spawn('curl -fsSL -o "' + bin + '" "' + url + '" || wget -q -O "' + bin + '" "' + url + '"', { shell: true, cwd: DOMAIN_BIN_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    dl.on('exit', (code) => {
      if (code === 0 && fs.existsSync(bin)) { try { fs.chmodSync(bin, 0o755); } catch {} resolve(bin); }
      else reject(new Error('gagal download cloudflared, exit=' + code));
    });
    dl.on('error', reject);
  });
}
async function startDomain() {
  if (!domainConfig || !domainConfig.tunnelToken) { domainStatus = 'stopped'; return false; }
  if (domainProc) return true;
  domainManualStop = false;
  let bin;
  try { bin = await ensureDomainBinary(); } catch (e) { domainPushLog('[domain] ' + e.message); domainStatus = 'stopped'; return false; }
  const env = Object.assign({}, process.env, { TUNNEL_TOKEN: domainConfig.tunnelToken });
  domainStatus = 'starting';
  domainPushLog('[domain] memulai tunnel ' + (domainConfig.hostname || '(tanpa hostname)') + '...');
  let proc;
  try { proc = spawn('"' + bin + '" tunnel run', { shell: true, detached: true, cwd: DOMAIN_BIN_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { domainPushLog('[domain] spawn failed: ' + e.message); domainStatus = 'stopped'; return false; }
  domainProc = proc; domainStatus = 'running';
  proc.stdout.on('data', (d) => { d.toString().split('\n').forEach((l) => { if (l) domainPushLog(l); }); });
  proc.stderr.on('data', (d) => { d.toString().split('\n').forEach((l) => { if (l) domainPushLog(l); }); });
  proc.on('exit', (code, signal) => {
    domainPushLog('[domain] exited code=' + code + ' signal=' + signal);
    domainProc = null;
    if (domainManualStop) { domainStatus = 'stopped'; return; }
    const now = Date.now();
    domainCrashWindow = domainCrashWindow.filter((t) => now - t < 60000);
    domainCrashWindow.push(now);
    if (domainCrashWindow.length > 5) { domainStatus = 'crashed'; domainPushLog('[domain] terlalu sering crash, auto-restart dihentikan. Restart manual dari menu Domain.'); return; }
    domainStatus = 'restarting';
    setTimeout(() => { if (!domainManualStop) startDomain(); }, 2000);
  });
  return true;
}
function stopDomain() {
  domainManualStop = true;
  if (domainProc) { try { killGroup(domainProc, 'SIGTERM'); } catch {} domainProc = null; }
  domainStatus = 'stopped';
}
// Bangun ingress tunnel: domain utama -> PORT, domain tambahan -> port masing-masing.
function buildIngress() {
  const rules = [];
  if (domainConfig && domainConfig.hostname) {
    rules.push({ hostname: domainConfig.hostname, service: 'http://localhost:' + PORT });
  }
  for (const d of ((domainConfig && domainConfig.extraDomains) || [])) {
    if (d && d.hostname && d.port) rules.push({ hostname: d.hostname, service: 'http://localhost:' + d.port });
  }
  rules.push({ service: 'http_status:404' });
  return { ingress: rules };
}
// Sinkron ingress tunnel ke PORT saat ini (penting habis pindah server: alokasi port baru
// beda dengan port waktu tunnel dibuat). Idempotent, jalan di background saat startup.
// Kalau restart=true, tunnel di-restart biar config baru langsung ke-apply.
async function syncDomainIngress(restart) {
  try {
    if (!domainConfig || !domainConfig.apiToken || !domainConfig.tunnelId || !domainConfig.accountId) return;
    const cfg = buildIngress();
    await cfApi(domainConfig.apiToken, 'PUT', '/accounts/' + domainConfig.accountId + '/cfd_tunnel/' + domainConfig.tunnelId + '/configurations', {
      config: cfg,
    });
    domainPushLog('[domain] ingress disinkron (' + (cfg.ingress.length - 1) + ' hostname)');
    if (restart) {
      domainPushLog('[domain] restart tunnel biar config baru ke-apply...');
      stopDomain(); domainManualStop = false; await startDomain();
    }
  } catch (e) {
    domainPushLog('[domain] sinkron ingress gagal: ' + (e.message || e));
  }
}
function domainPublic() {
  return {
    connected: !!(domainConfig && domainConfig.tunnelToken),
    hostname: (domainConfig && domainConfig.hostname) || '',
    tunnelId: (domainConfig && domainConfig.tunnelId) || '',
    tunnelName: (domainConfig && domainConfig.tunnelName) || '',
    status: domainStatus,
    hasApiToken: !!(domainConfig && domainConfig.apiToken),
    extraDomains: ((domainConfig && domainConfig.extraDomains) || []).map((d) => ({
      hostname: d.hostname || '', port: d.port || 0, zoneName: d.zoneName || '',
    })),
    logs: domainLogs.slice(-50).map((l) => l.line),
  };
}
function resolveCwd(cfg) {
  if (!cfg.cwd) return path.join(BRIDGE_DIR, 'apps', cfg.name);
  if (path.isAbsolute(cfg.cwd)) return cfg.cwd;
  return path.resolve(BRIDGE_DIR, cfg.cwd);
}
// Deteksi app static HTML (global, tanpa perlu file server per app).
// Kembali: { entry } (nama file entry) kalau app harus di-serve static, null kalau pakai command biasa.
// Aturan: stack === 'static' ATAU (tidak ada file server DAN (ada index.html ATAU tepat satu *.html)).
function detectStaticApp(cfg, cwd) {
  let files = [];
  try { files = fs.readdirSync(cwd); } catch { return null; }
  const hasServerFile = files.some((f) => ['server.cjs', 'server.js', 'app.js', 'index.js', 'package.json', 'app.py', 'main.py'].includes(f));
  const hasIndex = files.includes('index.html');
  const htmls = files.filter((f) => f.toLowerCase().endsWith('.html'));
  const isStaticStack = String(cfg.stack || '').toLowerCase() === 'static';
  if (isStaticStack) {
    if (hasIndex) return { entry: 'index.html' };
    if (htmls.length === 1) return { entry: htmls[0] };
    if (htmls.length > 1) return { entry: 'index.html' }; // tidak ada index, static-server akan 404 dengan pesan jelas
    return null; // stack static tapi tidak ada HTML sama sekali -> pakai command biasa
  }
  if (hasServerFile) return null;
  if (hasIndex) return { entry: 'index.html' };
  if (htmls.length === 1) return { entry: htmls[0] };
  return null;
}
function startApp(name) {
  const app = apps.get(name);
  if (!app) return false;
  app.manualStop = false;
  if (app.proc) {
    if (app.status === 'running') return true;
    setTimeout(() => { if (!app.manualStop) startApp(name); }, 600);
    return false;
  }
  const cfg = app.cfg;
  const cwd = resolveCwd(cfg);
  const env = Object.assign({}, process.env, cfg.env || {}, { PORT: String(cfg.port), HOST: '127.0.0.1' });
  // App static HTML: pakai static-server global, abaikan command (mis. 'node server.cjs' yang filenya tidak ada).
  // Jadi app static cukup punya index.html (atau satu file .html), tanpa perlu file server sendiri.
  const staticInfo = detectStaticApp(cfg, cwd);
  let spawnCmd = cfg.command;
  if (staticInfo) {
    const staticServer = path.join(BRIDGE_DIR, 'static-server.cjs');
    spawnCmd = 'node "' + staticServer + '"';
    env.STATIC_DIR = cwd;
    env.STATIC_ENTRY = staticInfo.entry;
    log('starting app', name, 'static: serving', staticInfo.entry, 'cwd=', cwd, 'port=', cfg.port, '(command diabaikan:', cfg.command + ')');
    pushLog(app, '[bridge] static: menyajikan ' + staticInfo.entry + ' (tanpa file server, command diabaikan: ' + cfg.command + ')');
  } else {
    log('starting app', name, 'cmd=', cfg.command, 'cwd=', cwd, 'port=', cfg.port);
  }
  let proc;
  try { proc = spawn(spawnCmd, { shell: true, detached: true, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { pushLog(app, '[bridge] spawn failed: ' + e.message); app.status = 'crashed'; return false; }
  app.proc = proc; app.status = 'running'; app.lastStart = Date.now();
  pushLog(app, '[bridge] started: ' + spawnCmd + ' (port ' + cfg.port + ')');
  proc.stdout.on('data', (d) => { d.toString().split('\n').forEach((l) => { if (l) pushLog(app, l); }); });
  proc.stderr.on('data', (d) => { d.toString().split('\n').forEach((l) => { if (l) pushLog(app, l); }); });
  proc.on('exit', (code, signal) => {
    pushLog(app, '[bridge] exited code=' + code + ' signal=' + signal);
    app.proc = null;
    if (app.manualStop) { app.status = 'stopped'; return; }
    const now = Date.now();
    app.crashWindow = app.crashWindow.filter((t) => now - t < 60000);
    app.crashWindow.push(now);
    if (app.crashWindow.length > 5) { app.status = 'crashed'; pushLog(app, '[bridge] too many crashes in 60s, auto-restart stopped.'); return; }
    app.status = 'restarting'; app.restarts += 1;
    setTimeout(() => { if (!app.manualStop) startApp(name); }, 2000);
  });
  proc.on('error', (e) => { pushLog(app, '[bridge] error: ' + e.message); });
  return true;
}
function killGroup(proc, sig) { try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} } }
function stopApp(name) {
  const app = apps.get(name);
  if (!app) return false;
  if (!app.proc) { app.status = 'stopped'; return true; }
  app.manualStop = true; app.status = 'stopping';
  killGroup(app.proc, 'SIGTERM');
  setTimeout(() => { if (app.proc) killGroup(app.proc, 'SIGKILL'); }, 3000);
  return true;
}

// ---- terminal ----
const terms = new Map();
let termSeq = 0;
// PTY beneran via `script -qec` (util-linux, stdlib-only, tanpa dep native seperti node-pty).
// `script` mengalokasikan PTY untuk bash, jadi readline / arrow history / Ctrl+C /
// vim / nano / htop jalan seperti Termux. Kalau `script` tidak ada di image
// (misal egg Pterodactyl tanpa util-linux), fallback ke spawn pipes + TERM=xterm-256color.
let SCRIPT_PTY = null;
function hasScriptPty() {
  if (SCRIPT_PTY !== null) return SCRIPT_PTY;
  try { const r = spawnSync('script', ['--version'], { timeout: 5000, encoding: 'utf8' }); SCRIPT_PTY = r.status === 0; }
  catch { SCRIPT_PTY = false; }
  return SCRIPT_PTY;
}
function createTerm(opts) {
  const id = 't' + (++termSeq) + '-' + crypto.randomBytes(4).toString('hex');
  let cwd = CONTAINER_ROOT, env = process.env, appName = null;
  if (opts && opts.app) {
    const cfg = (apps.get(opts.app) || {}).cfg || appConfigs.find((c) => c.name === opts.app);
    if (!cfg) { const e = new Error('app not found'); e.status = 404; throw e; }
    const resolved = resolveCwd(cfg);
    if (!resolved.startsWith(BRIDGE_DIR)) { const e = new Error('cwd app tidak diizinkan'); e.status = 400; throw e; }
    if (!fs.existsSync(resolved)) { const e = new Error('folder app tidak ditemukan'); e.status = 404; throw e; }
    cwd = resolved;
    env = Object.assign({}, process.env, cfg.env || {}, { PORT: String(cfg.port), HOST: '127.0.0.1' });
    appName = opts.app;
  }
  env = Object.assign({}, env, { TERM: 'xterm-256color' });
  const usePty = hasScriptPty();
  let proc;
  if (usePty) {
    // script -qec "bash ..." /dev/null : -q diam (tanpa header), -e kembalikan exit code, -c perintah.
    proc = spawn('script', ['-qec', 'bash --noprofile --norc', '/dev/null'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  } else {
    proc = spawn('bash', ['--noprofile', '--norc'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  }
  const s = { id, proc, out: [], created: Date.now(), app: appName, cwd, pty: usePty, cols: 80, rows: 24 };
  const push = (d) => { s.out.push(d.toString()); if (s.out.join('').length > 200000) s.out = [s.out.join('').slice(-100000)]; };
  proc.stdout.on('data', push); proc.stderr.on('data', push);
  proc.on('exit', () => { s.out.push('\n[terminal closed]\n'); });
  terms.set(id, s); return s;
}

function appListJson() {
  return Array.from(apps.values()).map((a) => ({
    name: a.cfg.name, description: a.cfg.description || '', command: a.cfg.command,
    port: a.cfg.port, status: a.status, restarts: a.restarts, autostart: !!a.cfg.autostart,
    proxy: '/app/' + a.cfg.name + '/', public: !!a.cfg.public,
    installCommand: a.cfg.installCommand || '', buildCommand: a.cfg.buildCommand || '',
  }));
}

// ---- wizard: detect + install jobs (stdlib-only) ----
const installJobs = new Map(); // name -> { status, logs: [{t,line}], exitCode, command }
function detectApp(name) {
  const dir = path.join(BRIDGE_DIR, 'apps', name);
  const cfg = (apps.get(name) || {}).cfg || appConfigs.find((c) => c.name === name) || {};
  let pkg = null;
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) { try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = null; } }
  const hasPackageJson = !!pkg || fs.existsSync(pkgPath);
  const hasRequirements = fs.existsSync(path.join(dir, 'requirements.txt'));
  const hasPipfile = fs.existsSync(path.join(dir, 'Pipfile'));
  let suggestedInstall = '', suggestedStart = String(cfg.command || ''), suggestedBuild = '';
  if (pkg) {
    suggestedInstall = 'npm install';
    const scripts = pkg.scripts || {};
    if (scripts.start) suggestedStart = 'npm start';
    else if (!suggestedStart) suggestedStart = 'node server.cjs';
    if (scripts.build) suggestedBuild = 'npm run build';
  } else if (hasRequirements) {
    suggestedInstall = 'pip install -r requirements.txt';
    if (!suggestedStart) suggestedStart = 'python3 app.py';
    else if (/node|npm/.test(suggestedStart)) suggestedStart = 'python3 app.py';
  }
  return {
    hasPackageJson, hasRequirements, hasPipfile,
    packageJson: pkg ? { scripts: pkg.scripts || {}, dependencies: pkg.dependencies || {} } : null,
    suggestedInstall, suggestedStart, suggestedBuild,
  };
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '12mb' }));
// Multipart (FormData) untuk upload file: file dikirim sebagai binary asli,
// bukan base64 JSON, jadi tidak ngembang 33% dan bisa sampai 100 MB.
// Parser stdlib-only (tanpa multer) supaya tidak tambah dependensi.
app.use(express.raw({ type: 'multipart/form-data', limit: '100mb' }));
function parseMultipart(req) {
  const ct = String(req.headers['content-type'] || '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const fields = {}; const files = [];
  let start = body.indexOf(boundary);
  while (start >= 0) {
    let pos = start + boundary.length;
    if (body[pos] === 13 && body[pos + 1] === 10) pos += 2;
    else if (body[pos] === 10) pos += 1;
    if (body[pos] === 45 && body[pos + 1] === 45) break; // -- penutup
    const next = body.indexOf(boundary, pos);
    if (next < 0) break;
    let part = body.subarray(pos, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const disp = /Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/.exec(headers);
      if (disp) {
        if (disp[2] !== undefined) {
          const ctMatch = /Content-Type:\s*([^\r\n]+)/.exec(headers);
          files.push({ field: disp[1], filename: disp[2], contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data: Buffer.from(content) });
        } else {
          fields[disp[1]] = content.toString('utf8');
        }
      }
    }
    start = next;
  }
  return { fields, files };
}
const MULTIPART_MAX = 100 * 1024 * 1024;

// ---- public: health ----
app.get('/health', (req, res) => res.json({ ok: true, apps: appListJson() }));

// ---- public: login / logout ----
app.post('/api/login', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  if (loginRateLimited(ip)) return res.status(429).json({ error: 'too many login attempts, try again in 5 minutes' });
  const body = req.body || {};
  if (safeEqual(String(body.username || ''), BRIDGE_USER) && safeEqual(String(body.password || ''), BRIDGE_PASSWORD)) {
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const maxAge = body.remember ? 30 * 24 * 3600 : 24 * 3600;
    sessions.set(token, { user: BRIDGE_USER, exp: Date.now() + maxAge * 1000 });
    res.setHeader('Set-Cookie', 'bridge_session=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + maxAge);
    return res.json({ ok: true, user: BRIDGE_USER });
  }
  recordLoginFail(ip);
  return res.status(401).json({ error: 'username atau password salah' });
});
app.post('/api/logout', (req, res) => {
  const c = parseCookies(req);
  if (c.bridge_session) sessions.delete(c.bridge_session);
  res.setHeader('Set-Cookie', 'bridge_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  // No-cache headers so the browser never serves a cached dashboard after logout
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.json({ ok: true });
});

// ---- halaman error HTML (buat browser) ----
// Browser yang buka path terlarang / tidak ketemu dapat halaman error ControlPetro
// yang didesain (Liquid Glass, tanpa emoji), bukan JSON mentah.
// Client API (fetch/curl, Accept */* atau application/json) tetap dapat JSON,
// supaya dashboard tidak pecah saat parsing response.
const ERROR_ICONS = {
  401: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  404: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  502: '<path d="M12 3v9"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>',
};
function wantsHtml(req) { return String(req.headers.accept || '').includes('text/html'); }
function errorPage(status, title, msg, ctaLabel, ctaHref) {
  const icon = ERROR_ICONS[status] || ERROR_ICONS[404];
  return '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + status + ' ' + title + ' | ControlPetro</title><style>'
    + '*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:#0a0a0c;color:#f2f2f4;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;background-image:radial-gradient(600px 300px at 50% -50px,rgba(80,120,255,.18),transparent 70%);overflow:hidden}'
    + '.card{width:100%;max-width:440px;text-align:center;padding:36px 28px 30px;border-radius:28px;background:rgba(255,255,255,.06);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);border:1px solid rgba(255,255,255,.14);box-shadow:0 30px 80px rgba(0,0,0,.5)}'
    + '.brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:22px}.mono{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:#f2f2f4;color:#0a0a0c;font-weight:800;font-size:14px;letter-spacing:-.5px}.brand span{font-weight:700;font-size:15px}'
    + '.code{font-size:76px;font-weight:800;letter-spacing:-4px;line-height:1;margin:6px 0 14px;background:linear-gradient(180deg,#fff,#8a8a93);-webkit-background-clip:text;background-clip:text;color:transparent}'
    + '.ic{width:56px;height:56px;margin:0 auto 16px;border-radius:18px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)}.ic svg{width:26px;height:26px;fill:none;stroke:#f2f2f4;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}'
    + 'h1{font-size:21px;font-weight:750;letter-spacing:-.3px;margin-bottom:10px}p{font-size:14.5px;line-height:1.65;color:#a1a1aa;margin-bottom:24px}'
    + '.btn{display:inline-block;padding:13px 26px;border-radius:999px;background:#f2f2f4;color:#0a0a0c;font-weight:700;font-size:14.5px;text-decoration:none;transition:transform .15s ease}.btn:active{transform:scale(.96)}'
    + '.foot{margin-top:22px;font-size:12px;color:#636366}'
    + '</style></head><body><div class="card"><div class="brand"><div class="mono">CP</div><span>ControlPetro</span></div>'
    + '<div class="code">' + status + '</div><div class="ic"><svg viewBox="0 0 24 24">' + icon + '</svg></div>'
    + '<h1>' + title + '</h1><p>' + msg + '</p>'
    + '<a class="btn" href="' + ctaHref + '">' + ctaLabel + '</a>'
    + '<div class="foot">ControlPetro &middot; Panel kendali app kamu</div></div></body></html>';
}
// Kirim error: HTML kalau browser, JSON kalau client API.
function sendError(req, res, status, jsonErr, title, msg, ctaLabel, ctaHref) {
  if (wantsHtml(req)) return res.status(status).type('html').send(errorPage(status, title, msg, ctaLabel, ctaHref));
  return res.status(status).json(jsonErr);
}

// ---- auth guard for /api/* (except login/logout/health) ----
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  if (!isApiAuthed(req)) return sendError(req, res, 401, { error: 'auth required' }, 'Login dulu', 'Endpoint ini butuh login. Masuk ke ControlPetro dulu buat lanjut.', 'Masuk ke ControlPetro', '/login');
  next();
});

app.get('/api/me', (req, res) => res.json({ user: BRIDGE_USER }));
// ---- Monitor: riwayat pemakaian per app (Task Manager style) ----
// Bridge sampling tiap 2 detik (background, jalan terus walau tidak ada yang buka dashboard),
// nyimpen 60 titik terakhir (2 menit). Disimpan ke monitor-history.json tiap 30 detik + pas
// shutdown, di-load pas startup (buang sampel >5 menit). Jadi grafik tidak mulai dari kosong
// pas refresh halaman, bahkan survive restart bridge.
// Per app: RAM (MB, jumlah RSS seluruh proses di grup app) + CPU (% , jumlah %cpu grup) via `ps`,
// Disk (MB, ukuran folder app, dihitung tiap 60 detik karena lambat berubah).
const MONITOR_FILE = path.join(BRIDGE_DIR, 'monitor-history.json');
const MONITOR_MAX = 60, MONITOR_INTERVAL_MS = 2000;
let monitorHistory = []; // [{ t, apps: { name: { ram, cpu, disk } } }]
let monitorDiskCache = {}; // name -> { mb, at }
try {
  const raw = JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8'));
  if (Array.isArray(raw)) monitorHistory = raw.filter((s) => s && typeof s.t === 'number' && Date.now() - s.t < 5 * 60 * 1000).slice(-MONITOR_MAX);
} catch {}
function monitorSave() {
  try { fs.writeFileSync(MONITOR_FILE, JSON.stringify(monitorHistory), { mode: 0o600 }); } catch {}
}
// Pemakaian grup proses via /proc (tanpa dependensi `ps`, yang belum tentu ada di container).
// /proc/<pid>/stat: pid (comm) state ppid pgrp ... utime stime ... rss ...
// comm bisa berisi spasi/kurung, jadi parsing dari ')' terakhir, lalu field setelahnya:
// [0]=state [1]=ppid [2]=pgrp [11]=utime [12]=stime [21]=rss (dalam page, 4096 B).
// RAM = jumlah RSS grup (MB). CPU% = delta (utime+stime) / elapsed / USER_HZ(100) / cpuCount * 100.
const MONITOR_PREV_TICKS = {}; // pgid -> { ticks, at }
function monitorGroupUsage(pgid) {
  let rssPages = 0, ticks = 0;
  try {
    const pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    for (const pid of pids) {
      let stat = '';
      try { stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); } catch { continue; }
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const fields = stat.slice(close + 2).split(' ');
      if (fields.length < 22) continue;
      if (parseInt(fields[2], 10) !== pgid) continue;
      ticks += (parseInt(fields[11], 10) || 0) + (parseInt(fields[12], 10) || 0);
      rssPages += parseInt(fields[21], 10) || 0;
    }
  } catch { return { ram: 0, cpu: 0 }; }
  const ram = Math.round(rssPages * 4096 / (1024 * 1024) * 10) / 10;
  const now = Date.now();
  const prev = MONITOR_PREV_TICKS[pgid];
  let cpu = 0;
  if (prev && now > prev.at) {
    const dt = (now - prev.at) / 1000;
    cpu = Math.round(((ticks - prev.ticks) / 100 / dt / Math.max(1, os.cpus().length)) * 100 * 10) / 10;
    if (cpu < 0) cpu = 0;
  }
  MONITOR_PREV_TICKS[pgid] = { ticks, at: now };
  return { ram, cpu };
}
function monitorDiskMB(name, cwd) {
  const cached = monitorDiskCache[name];
  if (cached && Date.now() - cached.at < 60000) return cached.mb;
  let mb = 0;
  try { const s = backupWalkSize(cwd); mb = Math.round(s.bytes / (1024 * 1024) * 10) / 10; } catch {}
  monitorDiskCache[name] = { mb, at: Date.now() };
  return mb;
}
function monitorSample() {
  const entry = { t: Date.now(), apps: {} };
  for (const [name, a] of apps) {
    const cwd = resolveCwd(a.cfg);
    let ram = 0, cpu = 0;
    if (a.proc && a.status === 'running') {
      const u = monitorGroupUsage(a.proc.pid);
      ram = u.ram; cpu = u.cpu;
    }
    entry.apps[name] = { ram, cpu, disk: monitorDiskMB(name, cwd) };
  }
  monitorHistory.push(entry);
  if (monitorHistory.length > MONITOR_MAX) monitorHistory.splice(0, monitorHistory.length - MONITOR_MAX);
}
setInterval(monitorSample, MONITOR_INTERVAL_MS);
setInterval(monitorSave, 30000);
// TIDAK panggil monitorSample() di sini: dipanggil saat module load, sebelum const BACKUP_SKIP_*
// (di bagian backup, lebih bawah) terinisialisasi, jadi backupWalkSize akan throw (TDZ) dan
// disk ke-cache 0 selama 60 detik. Sampel pertama diambil interval 2 detik kemudian (setelah
// seluruh module selesai di-load), jadi history terisi dengan benar.
app.get('/api/stats', (req, res) => {
  let disk = null;
  try { const s = fs.statfsSync(CONTAINER_ROOT); disk = { free: s.bfree * s.bsize, total: s.blocks * s.bsize }; } catch {}
  const latest = monitorHistory.length ? monitorHistory[monitorHistory.length - 1].apps : {};
  res.json({
    bridgeUptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    node: process.version, cpuCount: os.cpus().length, load: os.loadavg(),
    mem: { total: os.totalmem(), free: os.freemem() }, osUptimeSec: Math.floor(os.uptime()),
    disk, apps: appListJson(),
    monitor: { history: monitorHistory, latest },
  });
});
app.get('/api/config', (req, res) => res.json({ user: BRIDGE_USER, node: process.version, bridgeUptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000), apps: appConfigs, port: PORT }));
app.get('/api/logs', (req, res) => {
  const name = req.query.app || '';
  const limit = parseInt(req.query.limit || '300', 10);
  if (name) {
    const a = apps.get(name);
    if (!a) return res.status(404).json({ error: 'app not found' });
    return res.json({ logs: a.logs.slice(-limit).map((l) => ({ ...l, app: name })) });
  }
  const all = [];
  for (const [n, a] of apps) for (const l of a.logs) all.push({ ...l, app: n });
  all.sort((a, b) => a.t - b.t);
  return res.json({ logs: all.slice(-limit) });
});
app.get('/api/apps', (req, res) => res.json({ apps: appListJson() }));
app.post('/api/apps', (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.command || !body.port) return res.status(400).json({ error: 'need name, command, port' });
  const cfg = { name: body.name, command: body.command, port: Number(body.port), cwd: body.cwd || ('apps/' + body.name), description: body.description || '', autostart: !!body.autostart, env: body.env || {} };
  const exists = appConfigs.find((c) => c.name === cfg.name);
  if (exists) Object.assign(exists, cfg); else appConfigs.push(cfg);
  saveApps(); initApp(cfg);
  if (cfg.autostart) startApp(cfg.name);
  return res.json({ ok: true, app: cfg.name });
});
app.post('/api/apps/create', (req, res) => {
  let body = req.body || {};
  let mpFiles = [];
  // Multipart (FormData) dari frontend baru: field teks + file binary asli.
  // JSON base64 lama tetap didukung sebagai fallback (maks 5 MB).
  if (req.is('multipart/form-data')) {
    const mp = parseMultipart(req);
    if (!mp) return res.status(400).json({ error: 'multipart tidak valid' });
    const f = mp.fields;
    let envObj = {};
    try { envObj = f.env ? JSON.parse(f.env) : {}; } catch {}
    body = { name: f.name, description: f.description, stack: f.stack, port: f.port, command: f.command, env: envObj, autostart: f.autostart !== 'false', wizard: f.wizard === 'true', installCommand: f.installCommand || '', buildCommand: f.buildCommand || '', source: { type: f.sourceType } };
    if (f.sourceType === 'git') { body.source.url = f.gitUrl; body.source.branch = f.gitBranch; }
    if (f.sourceType === 'empty') body.source.template = f.template;
    mpFiles = mp.files.filter((x) => x.field === 'files');
  }
  const isWizard = body.wizard === true || body.wizard === 'true';
  const name = String(body.name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) return res.status(400).json({ error: 'nama tidak valid' });
  if (apps.has(name) || appConfigs.some((c) => c.name === name)) return res.status(400).json({ error: 'nama sudah dipakai' });
  let port = parseInt(body.port, 10);
  const usedPorts = new Set(appConfigs.map((c) => c.port));
  if (!port || port < 3101 || port > 3999) { port = 3101; while (usedPorts.has(port)) port++; }
  if (usedPorts.has(port)) return res.status(400).json({ error: 'port sudah dipakai' });
  const command = String(body.command || '').trim();
  if (!command) return res.status(400).json({ error: 'command wajib diisi' });
  const src = body.source || {};
  const targetDir = path.join(BRIDGE_DIR, 'apps', name);
  if (fs.existsSync(targetDir)) return res.status(400).json({ error: 'folder app sudah ada' });
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    if (src.type === 'git') {
      const url = String(src.url || '').trim();
      if (!url.startsWith('https://')) throw new Error('URL Git harus diawali https://');
      const args = ['clone', '--depth', '1'];
      if (src.branch) args.push('-b', String(src.branch));
      args.push(url, targetDir);
      const r = spawnSync('git', args, { timeout: 120000, encoding: 'utf8' });
      if (r.status !== 0) throw new Error('git clone gagal: ' + (r.stderr || r.stdout || '').slice(0, 500));
      // Wizard: JANGAN auto npm install diam-diam, biar Tab 2 Instalasi yang jalanin dengan log live.
      if (!isWizard && fs.existsSync(path.join(targetDir, 'package.json'))) {
        const inst = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: targetDir, timeout: 120000, encoding: 'utf8' });
        if (inst.status !== 0) log('npm install warning for', name, (inst.stderr || '').slice(0, 500));
      }
    } else if (src.type === 'upload') {
      if (mpFiles.length) {
        // Jalur multipart: file binary asli, maks 100 MB.
        let total = 0;
        for (const f of mpFiles) {
          total += f.data.length;
          const rel = String(f.filename || '').replace(/\\/g, '/');
          if (!rel || rel.startsWith('/') || rel.includes('..')) throw new Error('nama file tidak aman: ' + rel);
          const dest = path.join(targetDir, rel);
          if (!dest.startsWith(targetDir)) throw new Error('nama file tidak aman');
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, f.data);
        }
        if (total > MULTIPART_MAX) throw new Error('total file melebihi 100 MB');
      } else {
        // Fallback JSON base64 lama, maks 5 MB.
        const files = Array.isArray(src.files) ? src.files : [];
        if (!files.length) throw new Error('tidak ada file upload');
        let total = 0;
        for (const f of files) {
          total += f.size || 0;
          const rel = String(f.path || '').replace(/\\/g, '/');
          if (!rel || rel.startsWith('/') || rel.includes('..')) throw new Error('nama file tidak aman: ' + rel);
          const dest = path.join(targetDir, rel);
          if (!dest.startsWith(targetDir)) throw new Error('nama file tidak aman');
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, Buffer.from(String(f.contentBase64 || ''), 'base64'));
        }
        if (total > 5 * 1024 * 1024) throw new Error('total file melebihi 5 MB');
      }
    } else if (src.type === 'empty') {
      const tpl = src.template || 'node';
      if (tpl === 'node') {
        fs.writeFileSync(path.join(targetDir, 'server.cjs'), "// Hello app - edit me\nconst http = require('http');\nconst port = process.env.PORT || 3101;\nhttp.createServer((req, res) => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({app:'" + name + "', ok:true, path:req.url})); }).listen(port, '127.0.0.1', () => console.log('listening on '+port));\n");
      } else if (tpl === 'python') {
        fs.writeFileSync(path.join(targetDir, 'app.py'), "import os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\nport = int(os.environ.get('PORT', '3101'))\nclass H(BaseHTTPRequestHandler):\n    def do_GET(self):\n        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{\"app\":\"" + name + "\",\"ok\":true}')\n    def log_message(self, *a): pass\nHTTPServer(('127.0.0.1', port), H).serve_forever()\n");
      }
    } else {
      throw new Error('sumber tidak dikenal');
    }
  } catch (e) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    return res.status(400).json({ error: e.message });
  }
  const cfg = { name, command, port, cwd: 'apps/' + name, description: String(body.description || ''), autostart: isWizard ? false : (body.autostart !== false), env: (body.env && typeof body.env === 'object') ? body.env : {}, stack: String(body.stack || ''), installCommand: String(body.installCommand || ''), buildCommand: String(body.buildCommand || ''), public: body.public === true };
  appConfigs.push(cfg); saveApps(); initApp(cfg);
  if (!isWizard && cfg.autostart) startApp(name);
  // Wizard: app dibuat BERHENTI, sertakan deteksi untuk Tab 2.
  if (isWizard) return res.json({ ok: true, app: name, wizard: true, detect: detectApp(name) });
  return res.json({ ok: true, app: name });
});
// ---- Wizard endpoints (HARUS sebelum POST /api/apps/:name/:act, kalau tidak
// "install"/"deploy" akan ketelan sebagai :act) ----
app.get('/api/apps/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const a = apps.get(name);
  if (!a) return res.status(404).json({ error: 'app not found' });
  return res.json({ ok: true, app: { name: a.cfg.name, description: a.cfg.description || '', command: a.cfg.command, port: a.cfg.port, status: a.status, autostart: !!a.cfg.autostart, env: a.cfg.env || {}, stack: a.cfg.stack || '', installCommand: a.cfg.installCommand || '', buildCommand: a.cfg.buildCommand || '', public: !!a.cfg.public } });
});
app.get('/api/apps/:name/detect', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!apps.has(name)) return res.status(404).json({ error: 'app not found' });
  return res.json({ ok: true, app: name, detect: detectApp(name) });
});
app.post('/api/apps/:name/install', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const a = apps.get(name);
  if (!a) return res.status(404).json({ error: 'app not found' });
  const command = String((req.body || {}).command || '').trim();
  if (!command) return res.status(400).json({ error: 'command install wajib diisi' });
  if (command.length > 2000) return res.status(400).json({ error: 'command terlalu panjang' });
  const existing = installJobs.get(name);
  if (existing && existing.status === 'running') return res.status(409).json({ error: 'install sedang berjalan' });
  const job = { status: 'running', logs: [], exitCode: null, command };
  installJobs.set(name, job);
  const push = (line) => { const l = String(line).slice(0, 2000); if (l) { job.logs.push({ t: Date.now(), line: l }); if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000); } };
  const cwd = resolveCwd(a.cfg);
  const env = Object.assign({}, process.env, a.cfg.env || {}, { PORT: String(a.cfg.port), HOST: '127.0.0.1' });
  let proc;
  try { proc = spawn(command, { shell: true, detached: true, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { job.status = 'failed'; job.exitCode = 1; push('[install] spawn failed: ' + e.message); return res.json({ ok: true, status: 'failed' }); }
  push('[install] menjalankan: ' + command);
  proc.stdout.on('data', (d) => { d.toString().split('\n').forEach(push); });
  proc.stderr.on('data', (d) => { d.toString().split('\n').forEach(push); });
  proc.on('exit', (code) => { job.status = code === 0 ? 'done' : 'failed'; job.exitCode = code; push('[install] selesai, exit code=' + code); });
  proc.on('error', (e) => { job.status = 'failed'; job.exitCode = 1; push('[install] error: ' + e.message); });
  return res.json({ ok: true, status: 'running' });
});
app.get('/api/apps/:name/install', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!apps.has(name)) return res.status(404).json({ error: 'app not found' });
  const job = installJobs.get(name);
  if (!job) return res.json({ ok: true, status: 'idle', logs: [], exitCode: null, command: '' });
  return res.json({ ok: true, status: job.status, logs: job.logs.map((l) => l.line), exitCode: job.exitCode, command: job.command });
});
app.post('/api/apps/:name/deploy', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const a = apps.get(name);
  if (!a) return res.status(404).json({ error: 'app not found' });
  const body = req.body || {};
  const port = parseInt(body.port, 10);
  if (!port || port < 3101 || port > 3999) return res.status(400).json({ error: 'port harus 3101-3999' });
  if (appConfigs.some((c) => c.name !== name && Number(c.port) === port)) return res.status(400).json({ error: 'port sudah dipakai app lain' });
  const command = String(body.command || '').trim();
  if (!command) return res.status(400).json({ error: 'command (start) wajib diisi' });
  const buildCommand = String(body.buildCommand || '').trim();
  const env = (body.env && typeof body.env === 'object') ? body.env : {};
  const autostart = body.autostart !== false;
  const installCommand = body.installCommand !== undefined ? String(body.installCommand || '') : (a.cfg.installCommand || '');
  // Build dulu (kalau ada), jangan start kalau build gagal.
  let buildLogs = [];
  if (buildCommand) {
    const cwd = resolveCwd(a.cfg);
    const benv = Object.assign({}, process.env, env, { PORT: String(port), HOST: '127.0.0.1' });
    try {
      const r = spawnSync(buildCommand, { shell: true, cwd, env: benv, timeout: 120000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      const out = ((r.stdout || '') + '\n' + (r.stderr || '')).split('\n').filter(Boolean).slice(-200);
      buildLogs = out;
      if (r.status !== 0) return res.status(400).json({ error: 'build gagal (exit ' + r.status + ')', buildLogs });
    } catch (e) { return res.status(400).json({ error: 'build gagal: ' + e.message, buildLogs }); }
  }
  a.cfg.port = port; a.cfg.command = command; a.cfg.buildCommand = buildCommand;
  a.cfg.installCommand = installCommand; a.cfg.env = env; a.cfg.autostart = autostart;
  saveApps();
  try { if (a.proc) stopApp(name); } catch {}
  // Tunggu sebentar biar proses lama benar-benar mati sebelum start ulang.
  setTimeout(() => { try { startApp(name); } catch {} }, 1200);
  return res.json({ ok: true, app: name, buildLogs });
});
// Toggle Publik per app (HARUS sebelum POST /api/apps/:name/:act).
// Kalau public=true, proxy /app/:name/ bisa dibuka siapa aja tanpa login.
// Dashboard (/api/*) tetap butuh login, tidak ikut kebuka.
app.post('/api/apps/:name/public', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const a = apps.get(name);
  if (!a) return res.status(404).json({ error: 'app not found' });
  const val = (req.body || {}).public;
  if (typeof val !== 'boolean') return res.status(400).json({ error: 'public harus boolean' });
  a.cfg.public = val;
  saveApps();
  log('app public toggled', name, 'public=', val);
  return res.json({ ok: true, app: name, public: val });
});
// ---- Backup custom (reimage) ----
// GET /api/backup/info -> breakdown ukuran (sistem, password, per app) + total default (semua dicentang).
// GET /api/backup/download?password=1&apps=nama1,nama2 -> zip (atau .tar.gz kalau `zip` tidak ada)
//   berisi item terpilih. apps.json di zip difilter hanya app terpilih.
//   Yang TIDAK ikut: node_modules, .git, binary cloudflared, *.log, .env di v3/ (password diatur terpisah).
//   Restore: upload archive, extract di /home/container/, set CMD_RUN `node v3/run.cjs`, Start.
//   Password ikut kalau password=1 (file .env yang benar-benar dipakai, v3/server/.env atau bridge/.env).
const HOME_CONTAINER = path.join(BRIDGE_DIR, '..', '..'); // /home/container
const BACKUP_SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);
const BACKUP_SKIP_FILES = new Set(['cloudflared', 'cloudflared.exe']);
function backupWalkSize(dir, depth = 0) {
  let bytes = 0, files = 0;
  if (depth > 12) return { bytes, files };
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { bytes, files }; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue; // symlink tidak diikuti (aman dari traversal)
      if (e.isDirectory()) {
        if (BACKUP_SKIP_DIRS.has(e.name)) continue;
        const sub = backupWalkSize(p, depth + 1);
        bytes += sub.bytes; files += sub.files;
      } else if (e.isFile()) {
        if (BACKUP_SKIP_FILES.has(e.name)) continue;
        if (e.name.endsWith('.log')) continue;
        bytes += st.size; files += 1;
      }
    } catch {}
  }
  return { bytes, files };
}
function backupPasswordFile() {
  // File .env yang benar-benar dipakai loadPassword() (urutan sama: v3/server/.env lalu bridge/.env).
  if (fs.existsSync(ENV_FILE)) {
    try { if (/^BRIDGE_PASSWORD=.+/m.test(fs.readFileSync(ENV_FILE, 'utf8'))) return ENV_FILE; } catch {}
  }
  const legacy = path.join(BRIDGE_DIR, '..', '..', 'bridge', '.env');
  if (fs.existsSync(legacy)) return legacy;
  return null;
}
function backupInfo() {
  // Sistem = seluruh v3/ KECUALI apps/, node_modules, apps.json, .env, domain.json (diatur terpisah).
  const sys = { bytes: 0, files: 0 };
  const v3dir = path.join(HOME_CONTAINER, 'v3');
  const walkSys = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (e.name === 'apps' && dir === path.join(v3dir, 'server')) continue;
          if (BACKUP_SKIP_DIRS.has(e.name)) continue;
          walkSys(p, depth + 1);
        } else if (e.isFile()) {
          if (e.name === 'apps.json' && dir === path.join(v3dir, 'server')) continue;
          if (e.name === 'domain.json' && dir === path.join(v3dir, 'server')) continue;
          if (e.name === '.env') continue;
          if (BACKUP_SKIP_FILES.has(e.name) || e.name.endsWith('.log')) continue;
          sys.bytes += st.size; sys.files += 1;
        }
      } catch {}
    }
  };
  walkSys(v3dir, 0);
  // apps.json terfilter (ukuran perkiraan = apps.json asli, bedanya kecil).
  try { const st = fs.statSync(APPS_FILE); sys.bytes += st.size; sys.files += 1; } catch {}
  const pwFile = backupPasswordFile();
  const pw = pwFile ? (() => { try { const st = fs.statSync(pwFile); return { exists: true, bytes: st.size, file: path.relative(HOME_CONTAINER, pwFile) }; } catch { return { exists: false, bytes: 0, file: null }; } })() : { exists: false, bytes: 0, file: null };
  const appsInfo = appConfigs.map((cfg) => {
    const cwd = resolveCwd(cfg);
    const s = backupWalkSize(cwd);
    let hasSession = false;
    try { hasSession = fs.existsSync(path.join(cwd, 'session')) || fs.existsSync(path.join(cwd, 'sessions')) || fs.existsSync(path.join(cwd, 'auth_info_baileys')); } catch {}
    return { name: cfg.name, bytes: s.bytes, files: s.files, stack: cfg.stack || '', public: !!cfg.public, autostart: !!cfg.autostart, hasSession, description: cfg.description || '' };
  });
  // Domain: domain.json LENGKAP termasuk apiToken (biar habis restore langsung nyambung
  // tanpa paste token ulang; jaga file backup jangan sampai bocor).
  const dom = (() => {
    try {
      if (!fs.existsSync(DOMAIN_FILE)) return { exists: false, bytes: 0, hostname: '' };
      const raw = JSON.parse(fs.readFileSync(DOMAIN_FILE, 'utf8'));
      const txt = JSON.stringify(raw, null, 2) + '\n';
      return { exists: !!(raw && raw.tunnelToken), bytes: Buffer.byteLength(txt), hostname: (raw && raw.hostname) || '' };
    } catch { return { exists: false, bytes: 0, hostname: '' }; }
  })();
  const total = sys.bytes + pw.bytes + dom.bytes + appsInfo.reduce((a, x) => a + x.bytes, 0);
  return { system: sys, password: pw, domain: dom, apps: appsInfo, totalBytes: total, generatedAt: Date.now() };
}
app.get('/api/backup/info', (req, res) => {
  try { return res.json({ ok: true, backup: backupInfo() }); }
  catch (e) { return res.status(500).json({ error: 'gagal hitung backup: ' + e.message }); }
});
app.get('/api/backup/download', (req, res) => {
  const includePassword = String(req.query.password || '') === '1';
  const includeDomain = String(req.query.domain || '') === '1';
  const wanted = String(req.query.apps || '').split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean);
  const selected = appConfigs.filter((c) => wanted.includes(c.name));
  if (wanted.length && selected.length !== wanted.length) return res.status(400).json({ error: 'ada app yang tidak ditemukan' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const useZip = (() => { try { const r = spawnSync('which', ['zip'], { encoding: 'utf8' }); return r.status === 0 && String(r.stdout || '').trim() !== ''; } catch { return false; } })();
  const ext = useZip ? 'zip' : 'tar.gz';
  const fileName = 'controlpetro-backup-' + stamp + '.' + ext;
  let staging = null, archivePath = null;
  try {
    staging = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cp-backup-'));
    const stage = (...parts) => path.join(staging, ...parts);
    // Sistem: copy v3/ dengan filter (tanpa apps/, node_modules, apps.json, .env, domain.json).
    const copyFilter = (src) => {
      const base = path.basename(src);
      if (base === 'apps' && path.dirname(src) === path.join(HOME_CONTAINER, 'v3', 'server')) return false;
      if (base === 'apps.json' && path.dirname(src) === path.join(HOME_CONTAINER, 'v3', 'server')) return false;
      if (base === 'domain.json' && path.dirname(src) === path.join(HOME_CONTAINER, 'v3', 'server')) return false;
      if (base === '.env') return false;
      if (BACKUP_SKIP_DIRS.has(base)) return false;
      if (BACKUP_SKIP_FILES.has(base) || base.endsWith('.log')) return false;
      try { if (fs.lstatSync(src).isSymbolicLink()) return false; } catch { return false; }
      return true;
    };
    fs.cpSync(path.join(HOME_CONTAINER, 'v3'), stage('v3'), { recursive: true, filter: copyFilter });
    // apps.json terfilter (hanya app terpilih).
    fs.mkdirSync(stage('v3', 'server'), { recursive: true });
    fs.writeFileSync(stage('v3', 'server', 'apps.json'), JSON.stringify(selected, null, 2) + '\n');
    // Password (kalau dipilih).
    if (includePassword) {
      const pwFile = backupPasswordFile();
      if (pwFile) {
        const rel = path.relative(HOME_CONTAINER, pwFile);
        fs.mkdirSync(path.dirname(stage(...rel.split(path.sep))), { recursive: true });
        fs.copyFileSync(pwFile, stage(...rel.split(path.sep)));
      }
    }
    // Domain (kalau dipilih): domain.json LENGKAP termasuk apiToken
    // (biar habis restore tunnel langsung nyambung tanpa paste token ulang).
    if (includeDomain && fs.existsSync(DOMAIN_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(DOMAIN_FILE, 'utf8'));
        fs.writeFileSync(stage('v3', 'server', 'domain.json'), JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
      } catch {}
    }
    // package.json di root container (biar `npm start` bawaan egg langsung jalan habis restore,
    // tanpa perlu ubah CMD_RUN manual).
    try {
      const rootPkg = path.join(HOME_CONTAINER, 'package.json');
      if (fs.existsSync(rootPkg)) fs.copyFileSync(rootPkg, stage('package.json'));
    } catch {}
    // App terpilih.
    for (const cfg of selected) {
      const src = resolveCwd(cfg);
      const rel = path.relative(HOME_CONTAINER, src);
      fs.mkdirSync(path.dirname(stage(...rel.split(path.sep))), { recursive: true });
      fs.cpSync(src, stage(...rel.split(path.sep)), { recursive: true, filter: copyFilter });
    }
    // Arsipkan staging -> archive (di /tmp, dihapus setelah download).
    archivePath = path.join(require('os').tmpdir(), fileName);
    let r;
    if (useZip) r = spawnSync('zip', ['-r', '-q', archivePath, '.'], { cwd: staging, encoding: 'utf8', timeout: 120000 });
    else r = spawnSync('tar', ['-czf', archivePath, '-C', staging, '.'], { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) throw new Error((r.stderr || r.error && r.error.message || 'gagal arsip') + '');
    const cleanup = () => { try { fs.rmSync(staging, { recursive: true, force: true }); } catch {} try { fs.unlinkSync(archivePath); } catch {} };
    res.on('finish', cleanup); res.on('close', cleanup);
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    res.setHeader('Content-Type', useZip ? 'application/zip' : 'application/gzip');
    return res.sendFile(archivePath);
  } catch (e) {
    try { if (staging) fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { if (archivePath) fs.unlinkSync(archivePath); } catch {}
    log('backup download failed', e.message);
    return res.status(500).json({ error: 'gagal buat backup: ' + e.message });
  }
});
// ---- Domain: Cloudflare API (pakai apiToken user, TIDAK pernah dikirim ke frontend) ----
async function cfApi(apiToken, method, path, body) {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) {
    const msg = (j.errors && j.errors[0] && j.errors[0].message) || ('Cloudflare API ' + r.status);
    throw new Error(msg);
  }
  return j.result;
}
app.get('/api/domain/status', (req, res) => res.json({ ok: true, domain: domainPublic() }));
app.post('/api/domain/connect', async (req, res) => {
  const apiToken = String((req.body || {}).apiToken || '').trim();
  if (!apiToken) return res.status(400).json({ error: 'apiToken wajib diisi' });
  try {
    await cfApi(apiToken, 'GET', '/user/tokens/verify');
    const zones = await cfApi(apiToken, 'GET', '/zones?status=active&per_page=100');
    const list = (Array.isArray(zones) ? zones : []).map((z) => ({ id: z.id, name: z.name, accountId: z.account && z.account.id }));
    if (!domainConfig) domainConfig = {};
    domainConfig.apiToken = apiToken;
    if (list[0] && list[0].accountId) domainConfig.accountId = list[0].accountId;
    saveDomain();
    return res.json({ ok: true, zones: list });
  } catch (e) { return res.status(400).json({ error: 'gagal hubungkan Cloudflare: ' + e.message }); }
});
app.post('/api/domain/setup', async (req, res) => {
  const zoneId = String((req.body || {}).zoneId || '').trim();
  const subdomain = String((req.body || {}).subdomain || '').trim().toLowerCase();
  if (!zoneId || !subdomain) return res.status(400).json({ error: 'zoneId + subdomain wajib diisi' });
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) return res.status(400).json({ error: 'subdomain tidak valid (huruf/angka/dash, tanpa spasi)' });
  const apiToken = domainConfig && domainConfig.apiToken;
  if (!apiToken) return res.status(400).json({ error: 'hubungkan Cloudflare dulu (paste API token)' });
  try {
    const zone = await cfApi(apiToken, 'GET', '/zones/' + zoneId);
    const hostname = subdomain + '.' + zone.name;
    const accountId = (zone.account && zone.account.id) || domainConfig.accountId;
    if (!accountId) throw new Error('accountId tidak ketemu');
    // Hapus tunnel + DNS lama (kalau ada) sebelum bikin yang baru.
    if (domainConfig.tunnelId) {
      try { await cfApi(apiToken, 'DELETE', '/accounts/' + accountId + '/cfd_tunnel/' + domainConfig.tunnelId); } catch {}
    }
    // Bersihkan tunnel yatim dengan nama sama (misal habis "Putuskan" saat tanpa API token:
    // tunnel di Cloudflare tidak terhapus tapi domain.json sudah ke-reset, sehingga
    // pembuatan tunnel baru gagal dengan "already have a tunnel with this name").
    try {
      const namaTunnel = 'controlpetro-' + subdomain;
      const daftar = await cfApi(apiToken, 'GET', '/accounts/' + accountId + '/cfd_tunnel?name=' + encodeURIComponent(namaTunnel));
      for (const t of (Array.isArray(daftar) ? daftar : [])) {
        if (t && t.name === namaTunnel && t.id) {
          try { await cfApi(apiToken, 'DELETE', '/accounts/' + accountId + '/cfd_tunnel/' + t.id); } catch {}
        }
      }
    } catch {}
    if (domainConfig.dnsRecordId && domainConfig.zoneId) {
      try { await cfApi(apiToken, 'DELETE', '/zones/' + domainConfig.zoneId + '/dns_records/' + domainConfig.dnsRecordId); } catch {}
    }
    // Bikin tunnel baru.
    const tunnel = await cfApi(apiToken, 'POST', '/accounts/' + accountId + '/cfd_tunnel', { name: 'controlpetro-' + subdomain });
    const tunnelId = tunnel.id, tunnelToken = tunnel.token;
    if (!tunnelId || !tunnelToken) throw new Error('tunnel dibuat tapi token tidak dikembalikan');
    // Ingress: hostname -> bridge (port dari env panel).
    await cfApi(apiToken, 'PUT', '/accounts/' + accountId + '/cfd_tunnel/' + tunnelId + '/configurations', {
      config: { ingress: [{ hostname, service: 'http://localhost:' + PORT }, { service: 'http_status:404' }] },
    });
    // DNS CNAME: hostname -> <tunnelId>.cfargotunnel.com (proxied).
    const dns = await cfApi(apiToken, 'POST', '/zones/' + zoneId + '/dns_records', {
      type: 'CNAME', name: hostname, content: tunnelId + '.cfargotunnel.com', proxied: true,
    });
    // Pertahankan domain tambahan (kalau ada): arahkan DNS-nya ke tunnel baru.
    const keepExtras = (domainConfig && domainConfig.extraDomains) || [];
    for (const d of keepExtras) {
      if (d && d.dnsRecordId && d.zoneId) {
        try {
          await cfApi(apiToken, 'PUT', '/zones/' + d.zoneId + '/dns_records/' + d.dnsRecordId, {
            type: 'CNAME', name: d.hostname, content: tunnelId + '.cfargotunnel.com', proxied: true,
          });
        } catch (e) { domainPushLog('[domain] gagal update DNS ' + d.hostname + ': ' + (e.message || e)); }
      }
    }
    domainConfig = {
      hostname, tunnelId, tunnelName: 'controlpetro-' + subdomain, tunnelToken,
      apiToken, zoneId, accountId, dnsRecordId: dns.id || '',
      extraDomains: keepExtras,
    };
    saveDomain();
    await syncDomainIngress(false);
    stopDomain(); domainManualStop = false; await startDomain();
    return res.json({ ok: true, hostname, tunnelId });
  } catch (e) { return res.status(400).json({ error: 'gagal pasang domain: ' + e.message }); }
});
// GET /api/domain/zones -> daftar zone aktif (pakai apiToken tersimpan).
app.get('/api/domain/zones', async (req, res) => {
  const apiToken = domainConfig && domainConfig.apiToken;
  if (!apiToken) return res.status(400).json({ error: 'hubungkan Cloudflare dulu (paste API token)' });
  try {
    const zones = await cfApi(apiToken, 'GET', '/zones?status=active&per_page=100');
    const list = (Array.isArray(zones) ? zones : []).map((z) => ({ id: z.id, name: z.name }));
    return res.json({ ok: true, zones: list });
  } catch (e) { return res.status(400).json({ error: 'gagal ambil zones: ' + e.message }); }
});
// POST /api/domain/extra/add {zoneId, subdomain, port} -> tambah domain ke tunnel yang sama.
app.post('/api/domain/extra/add', async (req, res) => {
  const zoneId = String((req.body || {}).zoneId || '').trim();
  const subdomain = String((req.body || {}).subdomain || '').trim().toLowerCase();
  const port = parseInt((req.body || {}).port, 10);
  if (!zoneId || !subdomain) return res.status(400).json({ error: 'zoneId + subdomain wajib diisi' });
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) return res.status(400).json({ error: 'subdomain tidak valid (huruf/angka/dash, tanpa spasi)' });
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'port harus angka 1-65535' });
  const apiToken = domainConfig && domainConfig.apiToken;
  if (!apiToken) return res.status(400).json({ error: 'hubungkan Cloudflare dulu (paste API token)' });
  if (!domainConfig || !domainConfig.tunnelId || !domainConfig.accountId) return res.status(400).json({ error: 'pasang domain utama dulu' });
  try {
    const zone = await cfApi(apiToken, 'GET', '/zones/' + zoneId);
    const hostname = subdomain + '.' + zone.name;
    const extras = domainConfig.extraDomains || [];
    if (domainConfig.hostname === hostname || extras.some((d) => d.hostname === hostname)) {
      return res.status(400).json({ error: 'domain sudah ada' });
    }
    // DNS CNAME: hostname -> <tunnelId>.cfargotunnel.com (proxied).
    const dns = await cfApi(apiToken, 'POST', '/zones/' + zoneId + '/dns_records', {
      type: 'CNAME', name: hostname, content: domainConfig.tunnelId + '.cfargotunnel.com', proxied: true,
    });
    if (!Array.isArray(domainConfig.extraDomains)) domainConfig.extraDomains = [];
    domainConfig.extraDomains.push({ hostname, zoneId, zoneName: zone.name, dnsRecordId: (dns && dns.id) || '', port });
    saveDomain();
    await syncDomainIngress(true);
    return res.json({ ok: true, hostname, port });
  } catch (e) { return res.status(400).json({ error: 'gagal tambah domain: ' + e.message }); }
});
// POST /api/domain/extra/delete {hostname} -> hapus domain tambahan (+ DNS + ingress di Cloudflare).
app.post('/api/domain/extra/delete', async (req, res) => {
  const hostname = String((req.body || {}).hostname || '').trim().toLowerCase();
  if (!hostname) return res.status(400).json({ error: 'hostname wajib diisi' });
  const apiToken = domainConfig && domainConfig.apiToken;
  if (!apiToken) return res.status(400).json({ error: 'hubungkan Cloudflare dulu (paste API token)' });
  try {
    const extras = (domainConfig && domainConfig.extraDomains) || [];
    const idx = extras.findIndex((d) => d && d.hostname === hostname);
    if (idx < 0) return res.status(404).json({ error: 'domain tidak ditemukan' });
    const item = extras[idx];
    // Hapus DNS record di Cloudflare.
    if (item.dnsRecordId && item.zoneId) {
      try { await cfApi(apiToken, 'DELETE', '/zones/' + item.zoneId + '/dns_records/' + item.dnsRecordId); } catch {}
    }
    extras.splice(idx, 1);
    saveDomain();
    await syncDomainIngress(true);
    return res.json({ ok: true, hostname });
  } catch (e) { return res.status(400).json({ error: 'gagal hapus domain: ' + e.message }); }
});
app.post('/api/domain/disconnect', async (req, res) => {
  const apiToken = domainConfig && domainConfig.apiToken;
  const old = domainConfig || {};
  try {
    if (apiToken && old.tunnelId && old.accountId) {
      try { await cfApi(apiToken, 'DELETE', '/accounts/' + old.accountId + '/cfd_tunnel/' + old.tunnelId); } catch {}
    }
    if (apiToken && old.dnsRecordId && old.zoneId) {
      try { await cfApi(apiToken, 'DELETE', '/zones/' + old.zoneId + '/dns_records/' + old.dnsRecordId); } catch {}
    }
    // Hapus juga DNS domain tambahan.
    for (const d of (old.extraDomains || [])) {
      if (apiToken && d && d.dnsRecordId && d.zoneId) {
        try { await cfApi(apiToken, 'DELETE', '/zones/' + d.zoneId + '/dns_records/' + d.dnsRecordId); } catch {}
      }
    }
  } catch {}
  stopDomain();
  // API token dipertahankan (biar bisa pasang domain baru tanpa paste ulang).
  // Tunnel di Cloudflare yang tidak terhapus (kalau tanpa API token) harus dihapus manual.
  domainConfig = { hostname: '', tunnelId: '', tunnelName: '', tunnelToken: '', apiToken: apiToken || '', zoneId: '', accountId: old.accountId || '', dnsRecordId: '', extraDomains: [] };
  saveDomain();
  return res.json({ ok: true, note: apiToken ? 'Tunnel + DNS dihapus dari Cloudflare.' : 'Tunnel dihentikan lokal. Hapus tunnel + DNS manual di dashboard Cloudflare (tanpa API token).' });
});
app.post('/api/domain/restart', async (req, res) => {
  stopDomain(); domainManualStop = false;
  const ok = await startDomain();
  return res.json({ ok, status: domainStatus });
});
app.post('/api/apps/:name/:act', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const act = req.params.act;
  const a = apps.get(name);
  if (!a) return res.status(404).json({ error: 'app not found' });
  if (act === 'logs') { const limit = parseInt(req.query.limit || '200', 10); return res.json({ logs: a.logs.slice(-limit) }); }
  if (act === 'start') startApp(name);
  else if (act === 'stop') stopApp(name);
  else if (act === 'restart') { stopApp(name); setTimeout(() => startApp(name), 4000); }
  else return res.status(404).json({ error: 'unknown action' });
  return res.json({ ok: true, app: name, action: act });
});
app.get('/api/apps/:name/logs', (req, res) => {
  const a = apps.get(decodeURIComponent(req.params.name));
  if (!a) return res.status(404).json({ error: 'app not found' });
  const limit = parseInt(req.query.limit || '200', 10);
  return res.json({ logs: a.logs.slice(-limit) });
});
// DELETE /api/apps/:name — hapus app dari registry + hapus foldernya.
// Penting: hapus folder saja (via File Manager) TIDAK menghapus registry, jadi app
// tetap muncul di dashboard. Endpoint ini yang dipakai tombol Hapus App dan
// File Manager saat menghapus folder root app (apps/<nama>). Folder boleh sudah
// hilang (misal sudah dihapus duluan) — registry tetap dibersihkan.
app.delete('/api/apps/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const idx = appConfigs.findIndex((c) => c.name === name);
  if (idx < 0 && !apps.has(name)) return res.status(404).json({ error: 'app not found' });
  const a = apps.get(name);
  if (a && a.proc) { try { stopApp(name); } catch {} }
  if (idx >= 0) appConfigs.splice(idx, 1);
  apps.delete(name);
  installJobs.delete(name);
  try { saveApps(); } catch (e) { return res.status(500).json({ error: 'gagal simpan apps.json: ' + e.message }); }
  const dir = path.join(BRIDGE_DIR, 'apps', name);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { log('delete app folder failed', name, e.message); }
  return res.json({ ok: true, app: name });
});
// ---- File Manager (session-only, via /api guard) ----
// Allowed: v3/server/apps/ (semua app) + v3/server/apps.json saja.
// Blokir: .env (semua level), node_modules, .git, path absolut, traversal, symlink keluar.
const APPS_DIR = path.join(BRIDGE_DIR, 'apps');
let APPS_DIR_REAL = APPS_DIR;
try { APPS_DIR_REAL = fs.realpathSync(APPS_DIR); } catch {}
function modeToStr(st) {
  const m = st.mode;
  const bits = [[0o400, 'r'], [0o200, 'w'], [0o100, 'x'], [0o040, 'r'], [0o020, 'w'], [0o010, 'x'], [0o004, 'r'], [0o002, 'w'], [0o001, 'x']];
  return (st.isDirectory() ? 'd' : '-') + bits.map(([b, c]) => (m & b) ? c : '-').join('');
}
function fmErr(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }
function resolveFMPath(rel) {
  let r = String(rel || 'apps').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (r === '') r = 'apps';
  if (r === 'apps') return { rel: 'apps', fsPath: APPS_DIR, kind: 'dir' };
  if (r === 'apps.json') return { rel: 'apps.json', fsPath: APPS_FILE, kind: 'file' };
  if (!r.startsWith('apps/')) throw fmErr('path tidak diizinkan', 400);
  const rest = r.slice(5);
  const segs = rest.split('/');
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || s.includes('\0')) throw fmErr('nama path tidak valid', 400);
    if (s === '.env' || s === 'node_modules' || s === '.git') throw fmErr('path tidak diizinkan: ' + s, 403);
  }
  const fsPath = path.join(APPS_DIR, rest);
  let cur = fsPath;
  while (!fs.existsSync(cur)) { const p = path.dirname(cur); if (p === cur) break; cur = p; }
  let realAncestor;
  try { realAncestor = fs.realpathSync(cur); } catch { realAncestor = cur; }
  if (!(realAncestor === APPS_DIR_REAL || realAncestor.startsWith(APPS_DIR_REAL + path.sep))) throw fmErr('symlink di luar apps/', 403);
  return { rel: r, fsPath, kind: (fs.existsSync(fsPath) && fs.statSync(fsPath).isDirectory()) ? 'dir' : 'file' };
}
const FM_BINARY_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'mp3', 'mp4', 'mov', 'wav', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'bin', 'exe', 'dll', 'so', 'sqlite', 'db', 'wasm']);
app.get('/api/files', (req, res) => {
  try {
    const { rel, fsPath } = resolveFMPath(req.query.path || 'apps');
    if (!fs.existsSync(fsPath)) return res.status(404).json({ error: 'folder tidak ditemukan' });
    const st = fs.statSync(fsPath);
    if (!st.isDirectory()) return res.status(400).json({ error: 'bukan folder' });
    const entries = fs.readdirSync(fsPath, { withFileTypes: true })
      .filter((d) => d.name !== '.env' && d.name !== '.git' && d.name !== 'node_modules')
      .map((d) => {
        const p = path.join(fsPath, d.name);
        let s; try { s = fs.statSync(p); } catch { return null; }
        return { name: d.name, path: rel === 'apps' ? 'apps/' + d.name : rel + '/' + d.name, type: s.isDirectory() ? 'dir' : 'file', size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs, mode: (s.mode & 0o777).toString(8).padStart(3, '0'), modeStr: modeToStr(s), ext: s.isDirectory() ? '' : (d.name.includes('.') ? d.name.split('.').pop().toLowerCase() : '') };
      }).filter(Boolean);
    entries.sort((a, b) => (a.type === b.type ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : (a.type === 'dir' ? -1 : 1)));
    const parent = rel === 'apps' ? null : (rel.split('/').slice(0, -1).join('/') || 'apps');
    return res.json({ path: rel, parent, entries });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
app.get('/api/files/content', (req, res) => {
  try {
    const { rel, fsPath } = resolveFMPath(req.query.path || '');
    if (rel === 'apps') return res.status(400).json({ error: 'bukan file' });
    if (!fs.existsSync(fsPath)) return res.status(404).json({ error: 'file tidak ditemukan' });
    const st = fs.statSync(fsPath);
    if (st.isDirectory()) return res.status(400).json({ error: 'bukan file' });
    const download = req.query.download === '1';
    const limit = download ? 10 * 1024 * 1024 : 1024 * 1024;
    if (st.size > limit) return res.status(400).json({ error: 'file terlalu besar (maks ' + (download ? '10 MB' : '1 MB') + ')' });
    const buf = fs.readFileSync(fsPath);
    if (download) {
      res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(fsPath).replace(/"/g, '') + '"');
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.send(buf);
    }
    const ext = path.basename(fsPath).includes('.') ? path.basename(fsPath).split('.').pop().toLowerCase() : '';
    if (FM_BINARY_EXTS.has(ext) || buf.slice(0, 8000).includes(0)) return res.status(400).json({ error: 'file binary, gunakan unduh' });
    return res.json({ path: rel, content: buf.toString('utf8'), size: st.size, mode: (st.mode & 0o777).toString(8).padStart(3, '0'), modeStr: modeToStr(st) });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/files/write', (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.content !== 'string') return res.status(400).json({ error: 'content wajib string' });
    if (Buffer.byteLength(body.content, 'utf8') > 1024 * 1024) return res.status(400).json({ error: 'content melebihi 1 MB' });
    const { rel, fsPath } = resolveFMPath(body.path || '');
    if (rel === 'apps') return res.status(400).json({ error: 'tidak bisa menulis ke folder root' });
    if (fs.existsSync(fsPath) && fs.statSync(fsPath).isDirectory()) return res.status(400).json({ error: 'target adalah folder' });
    if (rel === 'apps.json') { try { JSON.parse(body.content); } catch { return res.status(400).json({ error: 'apps.json harus JSON valid' }); } }
    fs.mkdirSync(path.dirname(fsPath), { recursive: true });
    fs.writeFileSync(fsPath, body.content, 'utf8');
    if (rel === 'apps.json') { try { loadApps(); appConfigs.forEach(initApp); } catch {} }
    return res.json({ ok: true, path: rel });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/files/mkdir', (req, res) => {
  try {
    const { rel, fsPath } = resolveFMPath((req.body || {}).path || '');
    if (rel === 'apps' || rel === 'apps.json') return res.status(400).json({ error: 'path tidak valid untuk folder baru' });
    if (fs.existsSync(fsPath)) return res.status(400).json({ error: 'sudah ada' });
    fs.mkdirSync(fsPath, { recursive: true });
    return res.json({ ok: true, path: rel });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/files/delete', (req, res) => {
  try {
    const { rel, fsPath } = resolveFMPath((req.body || {}).path || '');
    if (rel === 'apps' || rel === 'apps.json') return res.status(400).json({ error: 'tidak boleh menghapus ' + rel });
    if (!fs.existsSync(fsPath)) return res.status(404).json({ error: 'tidak ditemukan' });
    if (fs.statSync(fsPath).isDirectory()) fs.rmSync(fsPath, { recursive: true, force: true });
    else fs.unlinkSync(fsPath);
    return res.json({ ok: true, path: rel });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/files/rename', (req, res) => {
  try {
    const body = req.body || {};
    const from = resolveFMPath(body.from || '');
    const to = resolveFMPath(body.to || '');
    if (from.rel === 'apps' || from.rel === 'apps.json') return res.status(400).json({ error: 'tidak boleh memindah ' + from.rel });
    if (!fs.existsSync(from.fsPath)) return res.status(404).json({ error: 'sumber tidak ditemukan' });
    if (fs.existsSync(to.fsPath)) return res.status(400).json({ error: 'tujuan sudah ada' });
    fs.mkdirSync(path.dirname(to.fsPath), { recursive: true });
    fs.renameSync(from.fsPath, to.fsPath);
    return res.json({ ok: true, from: from.rel, to: to.rel });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/files/chmod', (req, res) => {
  try {
    const body = req.body || {};
    if (!/^[0-7]{3}$/.test(String(body.mode || ''))) return res.status(400).json({ error: 'mode harus 3 digit octal (000-777)' });
    const { rel, fsPath } = resolveFMPath(body.path || '');
    if (!fs.existsSync(fsPath)) return res.status(404).json({ error: 'tidak ditemukan' });
    fs.chmodSync(fsPath, parseInt(String(body.mode), 8));
    return res.json({ ok: true, path: rel, mode: String(body.mode) });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/files/upload', (req, res) => {
  try {
    // Multipart (FormData) dari frontend baru: file binary asli, maks 100 MB.
    // JSON base64 lama tetap didukung sebagai fallback (maks 5 MB).
    if (req.is('multipart/form-data')) {
      const mp = parseMultipart(req);
      if (!mp) return res.status(400).json({ error: 'multipart tidak valid' });
      const { rel, fsPath } = resolveFMPath(mp.fields.path || 'apps');
      if (!fs.existsSync(fsPath) || !fs.statSync(fsPath).isDirectory()) return res.status(400).json({ error: 'folder tujuan tidak ditemukan' });
      const mpFiles = mp.files.filter((x) => x.field === 'files');
      if (!mpFiles.length) return res.status(400).json({ error: 'tidak ada file' });
      let total = 0;
      const decoded = [];
      for (const f of mpFiles) {
        const name = String(f.filename || '');
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0') || name === '.env' || name === '.git' || name === 'node_modules') return res.status(400).json({ error: 'nama file tidak aman: ' + name });
        total += f.data.length;
        decoded.push({ name, buf: f.data });
      }
      if (total > MULTIPART_MAX) return res.status(400).json({ error: 'total file melebihi 100 MB' });
      const names = [];
      for (const { name, buf } of decoded) { fs.writeFileSync(path.join(fsPath, name), buf); names.push(name); }
      return res.json({ ok: true, path: rel, uploaded: names });
    }
    const body = req.body || {};
    const { rel, fsPath } = resolveFMPath(body.path || 'apps');
    if (!fs.existsSync(fsPath) || !fs.statSync(fsPath).isDirectory()) return res.status(400).json({ error: 'folder tujuan tidak ditemukan' });
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) return res.status(400).json({ error: 'tidak ada file' });
    let total = 0;
    const decoded = [];
    for (const f of files) {
      const name = String(f.name || '');
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0') || name === '.env' || name === '.git' || name === 'node_modules') return res.status(400).json({ error: 'nama file tidak aman: ' + name });
      const buf = Buffer.from(String(f.contentBase64 || ''), 'base64');
      total += buf.length;
      decoded.push({ name, buf });
    }
    if (total > 5 * 1024 * 1024) return res.status(400).json({ error: 'total file melebihi 5 MB' });
    const names = [];
    for (const { name, buf } of decoded) {
      fs.writeFileSync(path.join(fsPath, name), buf);
      names.push(name);
    }
    return res.json({ ok: true, path: rel, uploaded: names });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});

app.post('/api/term', (req, res) => {
  const appName = String((req.body || {}).app || '').trim();
  try {
    if (appName) {
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(appName)) return res.status(400).json({ error: 'nama app tidak valid' });
      const s = createTerm({ app: appName });
      return res.json({ id: s.id, app: s.app });
    }
    const s = createTerm();
    return res.json({ id: s.id, app: null });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
});
// Daftar terminal aktif. Didefinisikan SEBELUM /api/term/:id/* supaya tidak ketelan.
app.get('/api/term/list', (req, res) => {
  return res.json({ terms: Array.from(terms.values()).map((s) => ({ id: s.id, app: s.app || null, cwd: s.cwd, createdAt: s.created, pty: !!s.pty })) });
});
app.get('/api/term/:id/output', (req, res) => {
  const s = terms.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'term not found' });
  const since = parseInt(req.query.since || '0', 10);
  const joined = s.out.join('');
  return res.json({ output: joined.slice(since), next: joined.length });
});
app.post('/api/term/:id/input', (req, res) => {
  const s = terms.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'term not found' });
  // Input MENTAH, tanpa newline otomatis: frontend xterm kirim keystroke apa adanya
  // (huruf, \r untuk Enter, \x03 untuk Ctrl+C, escape sequence panah, dll).
  // Backend teruskan persis ke stdin proses terminal / PTY.
  try { s.proc.stdin.write(String((req.body || {}).input || '')); } catch (e) { return res.status(500).json({ error: e.message }); }
  return res.json({ ok: true });
});
app.post('/api/term/:id/resize', (req, res) => {
  const s = terms.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'term not found' });
  const cols = parseInt((req.body || {}).cols, 10), rows = parseInt((req.body || {}).rows, 10);
  if (cols > 0 && cols <= 500) s.cols = cols;
  if (rows > 0 && rows <= 200) s.rows = rows;
  // Catatan: PTY via `script` tidak mengekspos ioctl winsize, jadi ukuran PTY
  // tidak bisa diubah dari sini (tetap ukuran awal). Nilai disimpan untuk
  // diagnostik + kalau suatu saat PTY diganti ke yang mendukung resize.
  return res.json({ ok: true, cols: s.cols, rows: s.rows });
});
app.delete('/api/term/:id', (req, res) => {
  const s = terms.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'term not found' });
  try { killGroup(s.proc, 'SIGTERM'); } catch {}
  setTimeout(() => { try { if (s.proc && !s.proc.killed) killGroup(s.proc, 'SIGKILL'); } catch {} }, 2000);
  terms.delete(req.params.id);
  return res.json({ ok: true });
});

// ---- proxy /app/:name/* (session, kecuali app Publik) ----
// App dengan cfg.public=true bisa dibuka siapa aja tanpa login (mis. game static).
// App private tetap butuh session. Dashboard (/api/*) tetap butuh login.
app.use('/app', (req, res, next) => {
  const raw = (req.originalUrl || req.url || '').split('?')[0];
  const m = raw.match(/\/app\/([^\/]+)/);
  const entry = m && apps.get(decodeURIComponent(m[1]));
  if (entry && entry.cfg && entry.cfg.public) return next();
  if (!isApiAuthed(req)) return sendError(req, res, 401, { error: 'auth required' }, 'Login dulu', 'App ini private. Masuk ke ControlPetro dulu buat buka.', 'Masuk ke ControlPetro', '/login');
  next();
});
app.all(/^\/app\/([^\/]+)\/?(.*)$/, (req, res) => {
  const m = req.path.match(/^\/app\/([^\/]+)\/?(.*)$/);
  const appEntry = apps.get(decodeURIComponent(m[1]));
  if (!appEntry) return sendError(req, res, 404, { error: 'app not found' }, 'App tidak ketemu', 'Nama app-nya salah atau app-nya sudah dihapus.', 'Kembali ke Beranda', '/');
  if (!appEntry.proc || appEntry.status !== 'running') return sendError(req, res, 502, { error: 'app not running', app: appEntry.cfg.name, status: appEntry.status }, 'App belum jalan', 'App "' + appEntry.cfg.name + '" sedang ' + appEntry.status + '. Coba lagi sebentar, atau login buat cek statusnya.', 'Masuk ke ControlPetro', '/login');
  const rest = m[2] || '';
  const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
  const headers = { ...req.headers };
  delete headers.host; delete headers.authorization; delete headers.cookie; delete headers.connection;
  const preq = http.request({ host: '127.0.0.1', port: appEntry.cfg.port, method: req.method, path: '/' + rest + qs, headers }, (pres) => {
    res.writeHead(pres.statusCode, pres.headers); pres.pipe(res);
  });
  preq.on('error', (e) => { if (!res.headersSent) return sendError(req, res, 502, { error: 'proxy failed: ' + e.message }, 'App belum jalan', 'Tidak bisa nyambung ke app ini (' + e.message + '). Coba lagi sebentar, atau login buat cek statusnya.', 'Masuk ke ControlPetro', '/login'); });
  req.pipe(preq);
});

// ---- pages: SESSION ONLY (never Basic) ----
function serveIndex(res) {
  const idx = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(idx)) { res.setHeader('Cache-Control', 'no-store'); return res.sendFile(idx); }
  return res.status(500).send('<h1>Frontend belum di-build</h1><p>Jalankan npm run build di frontend/.</p>');
}
app.get('/login', (req, res) => serveIndex(res)); // ALWAYS 200, never redirect
app.get('/term', (req, res) => {
  if (!checkSession(req)) return res.redirect(302, '/login');
  return res.redirect(302, '/#terminal');
});
function serveLanding(res) {
  const lp = path.join(__dirname, '..', 'landing', 'index.html');
  if (fs.existsSync(lp)) { res.setHeader('Cache-Control', 'no-store'); return res.sendFile(lp); }
  return res.redirect(302, '/login');
}
app.get('/', (req, res) => {
  if (!checkSession(req)) return serveLanding(res); // belum login: landing page publik
  return serveIndex(res); // sudah login: dashboard SPA
});

// ---- static assets (public so login page can load JS/CSS) ----
app.use(express.static(DIST_DIR, { maxAge: '1h', index: false }));

// ---- SPA fallback: unknown non-API routes ----
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/app/')) return res.status(404).json({ error: 'not found' });
  if (!checkSession(req)) return res.redirect(302, '/login');
  return serveIndex(res);
});

app.use((err, req, res, next) => { log('request error', err && err.message); if (!res.headersSent) res.status(500).json({ error: err.message || 'server error' }); });

// Auto-install di startup (habis restore backup): kalau app punya package.json tapi
// node_modules belum ada, jalankan installCommand dulu (background), baru startApp.
// Ini yang bikin restore "tempel tancap gas" tanpa npm install manual per app.
function needsAutoInstall(cfg) {
  const installCmd = String(cfg.installCommand || '').trim();
  if (!installCmd) return false;
  const cwd = resolveCwd(cfg);
  try {
    if (fs.existsSync(path.join(cwd, 'package.json')) && !fs.existsSync(path.join(cwd, 'node_modules'))) return true;
  } catch {}
  return false;
}
function autoInstallThenStart(cfg) {
  if (!needsAutoInstall(cfg)) return startApp(cfg.name);
  const app = apps.get(cfg.name);
  const cwd = resolveCwd(cfg);
  const cmd = String(cfg.installCommand).trim();
  log('auto-install', cfg.name, 'cmd=', cmd, '(package.json tanpa node_modules, kemungkinan habis restore backup)');
  if (app) pushLog(app, '[bridge] auto-install: ' + cmd + ' (habis restore, node_modules belum ada)');
  const env = Object.assign({}, process.env, cfg.env || {}, { PORT: String(cfg.port), HOST: '127.0.0.1' });
  let done = false;
  const finish = () => { if (done) return; done = true; startApp(cfg.name); };
  let proc;
  try { proc = spawn(cmd, { shell: true, detached: false, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { log('auto-install spawn failed', cfg.name, e.message); return finish(); }
  const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} finish(); }, 5 * 60 * 1000);
  proc.stdout.on('data', (d) => { if (app) d.toString().split('\n').forEach((l) => { if (l) pushLog(app, '[install] ' + l); }); });
  proc.stderr.on('data', (d) => { if (app) d.toString().split('\n').forEach((l) => { if (l) pushLog(app, '[install] ' + l); }); });
  proc.on('exit', (code) => { clearTimeout(timer); log('auto-install done', cfg.name, 'exit=', code); if (app) pushLog(app, '[bridge] auto-install selesai, exit=' + code); finish(); });
  proc.on('error', () => { clearTimeout(timer); finish(); });
}
const server = app.listen(PORT, HOST, () => {
  log('bridge v3 listening on ' + HOST + ':' + PORT + ' (user=' + BRIDGE_USER + ')');
  appConfigs.forEach((cfg) => { initApp(cfg); if (cfg.autostart) autoInstallThenStart(cfg); });
  if (domainConfig && domainConfig.tunnelToken) { startDomain(); syncDomainIngress(false); }
});
function shutdown(sig) {
  log('shutdown', sig);
  try { monitorSave(); } catch {}
  for (const a of apps.values()) { if (a.proc) killGroup(a.proc, 'SIGTERM'); }
  for (const s of terms.values()) { try { s.proc.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
