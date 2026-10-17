// v3 launcher (stdlib-only, no deps).
// Pterodactyl egg runs CMD_RUN as /usr/local/bin/${CMD_RUN}, so CMD_RUN must be
// a single node command (no && / shell operators). This launcher installs
// express once if missing, then spawns the real Express server.
// Run: node v3/run.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const V3_DIR = __dirname;
const SERVER_DIR = path.join(V3_DIR, 'server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.cjs');
const EXPRESS_PKG = path.join(SERVER_DIR, 'node_modules', 'express', 'package.json');

function log(...a) { console.log(new Date().toISOString(), '[v3-run]', ...a); }

if (!fs.existsSync(EXPRESS_PKG)) {
  log('express not found, running npm install in', SERVER_DIR);
  const r = spawnSync('npm', ['--prefix', SERVER_DIR, 'install', '--no-audit', '--no-fund'], { stdio: 'inherit', timeout: 180000 });
  if (r.status !== 0) {
    log('npm install failed with status', r.status, '- retrying once');
    const r2 = spawnSync('npm', ['--prefix', SERVER_DIR, 'install', '--no-audit', '--no-fund'], { stdio: 'inherit', timeout: 180000 });
    if (r2.status !== 0) { log('npm install failed twice, exiting'); process.exit(1); }
  }
  log('npm install done');
} else {
  log('express found, skipping npm install');
}

const child = spawn(process.execPath, [SERVER_ENTRY], { stdio: 'inherit', cwd: V3_DIR, env: process.env });
child.on('exit', (code, signal) => {
  log('server exited code=' + code + ' signal=' + signal);
  process.exit(code === null ? 0 : code);
});
child.on('error', (e) => { log('spawn server failed', e.message); process.exit(1); });
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} });
process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch {} });
