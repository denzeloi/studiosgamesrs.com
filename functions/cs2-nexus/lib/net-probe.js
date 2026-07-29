'use strict';

const net = require('net');
const dgram = require('dgram');

/** Source engine A2S_INFO query — same UDP path CS2 clients use to reach the game port. */
const A2S_INFO = Buffer.from('\xff\xff\xff\xffTSource Engine Query\x00', 'latin1');

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

function udpGameProbe(host, port, ms) {
  return new Promise(function (resolve) {
    const socket = dgram.createSocket('udp4');
    const targetPort = Number(port) || 27015;
    const targetHost = String(host || '').trim();
    let settled = false;

    function finish(ok) {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch (e) { /* ignore */ }
      resolve(!!ok);
    }

    socket.on('message', function () { finish(true); });
    socket.on('error', function () { finish(false); });

    socket.send(A2S_INFO, 0, A2S_INFO.length, targetPort, targetHost, function (err) {
      if (err) finish(false);
    });

    setTimeout(function () { finish(false); }, ms || 4000);
  });
}

async function probePortOpen(host, port, attempts) {
  const tries = attempts || 3;
  for (let i = 0; i < tries; i += 1) {
    if (await tcpProbe(host, port, 8000)) return true;
  }
  return false;
}

async function probeGamePortOpen(host, port, attempts) {
  const tries = attempts || 3;
  for (let i = 0; i < tries; i += 1) {
    if (await udpGameProbe(host, port, 5000)) return true;
    await new Promise(function (r) { setTimeout(r, 1500); });
  }
  return false;
}

module.exports = { tcpProbe, udpGameProbe, probePortOpen, probeGamePortOpen };
