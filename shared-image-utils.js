/**
 * Compresión ligera de imágenes para uploads comunitarios (costo-eficiente).
 */
(function(global) {
  'use strict';

  function dataURLToBlob(dataURL) {
    var parts = dataURL.split(',');
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    var bin = atob(parts[1]);
    var len = bin.length;
    var arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function compressImageToBlob(file, opts) {
    opts = opts || {};
    var maxDim = opts.maxDim || 1920;
    var quality = opts.quality || 0.85;
    var targetBytes = opts.targetBytes || (800 * 1024);

    return new Promise(function(resolve, reject) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) {
        reject(new Error('El archivo no es una imagen válida.'));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function() { reject(new Error('No se pudo leer la imagen.')); };
      reader.onload = function(e) {
        var img = new Image();
        img.onerror = function() { reject(new Error('Imagen corrupta o no compatible.')); };
        img.onload = function() {
          try {
            var attempts = [
              { dim: maxDim, q: quality },
              { dim: 1600, q: 0.8 },
              { dim: 1280, q: 0.75 }
            ];
            var idx = 0;

            function render(dim) {
              var w = img.width;
              var h = img.height;
              if (!w || !h) throw new Error('Imagen sin dimensiones.');
              if (w >= h && w > dim) { h = Math.round(h * dim / w); w = dim; }
              else if (h > w && h > dim) { w = Math.round(w * dim / h); h = dim; }
              var canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = h;
              var ctx = canvas.getContext('2d');
              ctx.fillStyle = '#121212';
              ctx.fillRect(0, 0, w, h);
              ctx.drawImage(img, 0, 0, w, h);
              return canvas;
            }

            function tryNext() {
              var a = attempts[idx];
              var canvas = render(a.dim);
              function done(blob) {
                if (!blob) { advance(); return; }
                if (blob.size <= targetBytes || idx >= attempts.length - 1) resolve(blob);
                else advance();
              }
              function advance() {
                idx += 1;
                if (idx >= attempts.length) {
                  try {
                    resolve(dataURLToBlob(render(1280).toDataURL('image/jpeg', 0.72)));
                  } catch (err) {
                    reject(new Error('No se pudo comprimir la imagen.'));
                  }
                  return;
                }
                tryNext();
              }
              if (canvas.toBlob) canvas.toBlob(done, 'image/jpeg', a.q);
              else done(dataURLToBlob(canvas.toDataURL('image/jpeg', a.q)));
            }
            tryNext();
          } catch (err) {
            reject(err);
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  global.SGImageUtils = {
    compressImageToBlob: compressImageToBlob
  };
})(typeof window !== 'undefined' ? window : this);
