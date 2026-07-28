'use strict';

const net = require('net');

function tcpProbe(host, port, ms) {
  return new Promise(function (resolve) {
    const s = new net.Socket();
    s.setTimeout(ms || 3000);
    s.once('connect', function () { s.destroy(); resolve(true); });
    s.once('timeout', function () { s.destroy(); resolve(false); });
    s.once('error', function () { s.destroy(); resolve(false); });
    s.connect(Number(port) || 27015, String(host || '').trim());
  });
}

async function probePortOpen(host, port, attempts) {
  const tries = attempts || 3;
  for (let i = 0; i < tries; i += 1) {
    if (await tcpProbe(host, port, 8000)) return true;
  }
  return false;
}

module.exports = { tcpProbe, probePortOpen };
