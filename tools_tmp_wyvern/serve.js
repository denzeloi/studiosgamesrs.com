// Servidor estatico minimo solo para revisar el modelo en el navegador.
const http = require('http');
const fs = require('fs');
const path = require('path');

// Se sirve la raiz del repositorio para poder comparar el dragon nuevo con los
// .glb del soldado y del golem que ya estan publicados.
const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.js': 'text/javascript', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/tools_tmp_wyvern/preview.html';
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('no existe: ' + rel); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}).listen(8099, () => console.log('preview en http://127.0.0.1:8099/'));
