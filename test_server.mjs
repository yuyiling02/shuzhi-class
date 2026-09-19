// 极简静态服务器：供无头渲染调试用（端口 8321）
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = 'C:/Users/未知/Desktop/szkt/Huishi-class-1';
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.glb':'model/gltf-binary', '.json':'application/json', '.png':'image/png' };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let fp = path.join(ROOT, urlPath);
  if (urlPath === '/' ) fp = path.join(ROOT, 'index.html');
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8321, () => console.log('serving on 8321'));
