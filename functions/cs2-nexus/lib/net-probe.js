'use strict';

const net = require('net');
const dgram = require('dgram');

/** Source engine A2S_INFO query — same UDP path CS2 clients use to reach the game port. */
const A2S_INFO = Buffer.from('\xff\xff\xff\xffTSource Engine Query\x00', 'latin1');

/**
 * Cloud Run (which backs Firebase Functions v2) drops outbound UDP unless the service is
 * deployed with Direct VPC egress + Cloud NAT. Without that, an A2S_INFO probe always times
 * out even when CS2 is perfectly healthy, so probing from here would report a false negative.
 * Set UDP_PROBE_ENABLED=1 only on a runtime that can actually send UDP.
 */
function udpProbeEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.UDP_PROBE_ENABLED || ''));
}

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

/** Resolves true (reachable), false (no answer) or null (cannot be verified from here). */
function udpGameProbe(host, port, ms) {
  if (!udpProbeEnabled()) return Promise.resolve(null);
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

/** Resolves true (reachable), false (no answer) or null (cannot be verified from here). */
async function probeGamePortOpen(host, port, attempts) {
  if (!udpProbeEnabled()) return null;
  const tries = attempts || 3;
  for (let i = 0; i < tries; i += 1) {
    if (await udpGameProbe(host, port, 5000)) return true;
    await new Promise(function (r) { setTimeout(r, 1500); });
  }
  return false;
}

module.exports = { tcpProbe, udpGameProbe, probePortOpen, probeGamePortOpen, udpProbeEnabled };
