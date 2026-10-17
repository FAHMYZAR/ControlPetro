// Contoh app 2 - counter demo
const http = require('http');
const port = process.env.PORT || 3102;
let hits = 0;
http.createServer((req, res) => {
  hits += 1;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><body><h1>demo app</h1><p>hits: ' + hits + '</p><p>path: ' + req.url + '</p><p><a href="/">refresh</a></p></body></html>');
}).listen(port, '127.0.0.1', () => console.log('demo listening on 127.0.0.1:' + port));
