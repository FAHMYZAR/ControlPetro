// Static server bersama (global) untuk app static HTML di ControlPetro.
// Dipakai otomatis oleh bridge (startApp) kalau app terdeteksi static:
//  - stack === 'static', ATAU
//  - folder app tidak punya file server (server.cjs/server.js/app.js/index.js/package.json)
//    tapi punya index.html ATAU tepat satu file *.html.
// App static jadi tidak perlu file server sendiri di tiap folder.
// Env: PORT (dari bridge), STATIC_DIR (folder app), STATIC_ENTRY (nama file entry, opsional).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3101', 10);
const DIR = path.resolve(process.env.STATIC_DIR || process.cwd());
const ENTRY = process.env.STATIC_ENTRY || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

function entryFile() {
  if (ENTRY) {
    const p = path.join(DIR, ENTRY);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  const idx = path.join(DIR, 'index.html');
  if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx;
  let htmls = [];
  try { htmls = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.html') && fs.statSync(path.join(DIR, f)).isFile()); } catch {}
  if (htmls.length === 1) return path.join(DIR, htmls[0]);
  return null;
}

const server = http.createServer((req, res) => {
  let urlPath = '/';
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0] || '/'); } catch { urlPath = '/'; }
  if (urlPath === '/' || urlPath === '/index.html') {
    const entry = entryFile();
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Static app: tidak ada index.html atau file .html di folder app.');
    }
    fs.readFile(entry, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  const filePath = path.join(DIR, urlPath);
  if (!filePath.startsWith(DIR + path.sep) && filePath !== DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[static-server] serving ' + DIR + ' on 127.0.0.1:' + PORT + (ENTRY ? ' (entry=' + ENTRY + ')' : ''));
});
