#!/usr/bin/env node
'use strict';

/**
 * Asks a running CS2 server which MatchZy branding it actually has.
 *
 * The chat prefix cannot be read back — MatchZy registers it as a console command, not a
 * convar — so this reads the two convars that the same config file sets and that do report
 * their value. If they still hold the plugin defaults, cfg/MatchZy/config.cfg never reached
 * the machine and the game chat is calling itself MatchZy.
 *
 *   RCON_PASSWORD=... node scripts/probe-cs2-branding.js 203.0.113.10
 *
 * The IP is in gameServers/{id}/ip. The backend also records its own reading of this in
 * gameServers/{id}/branding every time a server comes online, so normally you do not need
 * to run this by hand.
 */

const path = require('path');
const rcon = require(path.join(__dirname, '..', 'functions', 'cs2-nexus', 'lib', 'rcon.js'));

const host = process.argv[2];
const port = Number(process.argv[3] || 27015);
const password = process.env.RCON_PASSWORD || '';

if (!host) {
  console.error('Uso: RCON_PASSWORD=... node scripts/probe-cs2-branding.js <ip> [puerto]');
  process.exit(2);
}
if (!password) {
  console.error('Falta RCON_PASSWORD en el entorno (es la misma que usa la funcion cs2-nexus).');
  process.exit(2);
}

(async function () {
  console.log('Consultando ' + host + ':' + port + ' ...\n');
  const report = await rcon.brandServer(host, port, password, 15000);

  if (report.error) {
    console.error('No se pudo hablar con el servidor: ' + report.error);
    process.exit(1);
  }

  (rcon.BRANDING_PROBES || []).forEach(function (probe) {
    const got = (report.values || {})[probe.cvar];
    const good = String(got).toLowerCase() === String(probe.expect).toLowerCase();
    console.log((good ? 'OK   ' : 'MAL  ') + probe.cvar
      + '\n       tiene:  ' + got
      + '\n       espera: ' + probe.expect);
  });

  if (report.ok) {
    console.log('\nEl servidor lleva el branding de Studiosgamesrs.');
    return;
  }
  console.log('\nEl servidor NO tiene el branding: los cfg de MatchZy no llegaron a la maquina.');
  console.log('Este mismo comando ya se lo empujo por RCON, asi que el chat deberia');
  console.log('decir Studiosgamesrs de aqui en adelante. Vuelve a correrlo para confirmar.');
  process.exitCode = 1;
})().catch(function (err) {
  console.error('FALLO: ' + err.message);
  process.exit(1);
});
