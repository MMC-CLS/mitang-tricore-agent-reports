const http = require('http');
const fs = require('fs');
const path = require('path');

const base = __dirname;
const mime = { html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', png: 'image/png', svg: 'image/svg+xml' };

http.createServer((req, res) => {
  let url = req.url === '/' ? '/subagents.html' : req.url;
  let file = path.join(base, url);
  fs.readFile(file, (err, data) => {
    if (err) {
      // 尝试从 shared 目录读取
      file = path.join(base, '..', 'shared', path.basename(url));
      fs.readFile(file, (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('404 Not Found'); }
        else { const ext = path.extname(file).slice(1); res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' }); res.end(data2); }
      });
    } else {
      const ext = path.extname(file).slice(1);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    }
  });
}).listen(8080, () => console.log('Server running at http://localhost:8080'));
