// Contoh app 1 - hello
const http = require('http');
const port = process.env.PORT || 3101;
const started = Date.now();
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ app: 'hello', ok: true, path: req.url, uptime_sec: Math.floor((Date.now() - started) / 1000), time: new Date().toISOString() }));
}).listen(port, '127.0.0.1', () => console.log('hello listening on 127.0.0.1:' + port));
