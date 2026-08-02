#!/usr/bin/env node
'use strict';

/**
 * Comprueba el emblema por defecto de equipo y la ventana "Juega ahora".
 *
 * Lo que se protege aquí es lo que se rompe callado: si alguien vuelve a meter
 * un placehold.co en una tarjeta de equipo, nadie se entera hasta que ese
 * servicio se cae y la página se llena de cuadros grises; y si el archivo del
 * emblema desaparece del repo, la única pista es un hueco roto en producción.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function check(label, condition) {
  if (condition) {
    console.log('OK   ' + label);
  } else {
    console.log('FALLA ' + label);
    failures += 1;
  }
}

function section(title) {
  console.log('\n--- ' + title + ' ---');
}

// ---------------------------------------------------------------------------

section('el emblema de la casa existe y pesa poco');

const EMBLEMS = ['team-default-emblem.jpg', 'team-default-emblem-small.jpg'];
EMBLEMS.forEach(function (name) {
  const full = path.join(ROOT, name);
  const exists = fs.existsSync(full);
  check('está ' + name, exists);
  if (!exists) return;
  const kb = fs.statSync(full).size / 1024;
  // Se pinta en cada tarjeta de equipo: por encima de 120 KB deja de ser gratis.
  check(name + ' pesa menos de 120 KB (' + Math.round(kb) + ' KB)', kb < 120);
});

section('un solo emblema para todo el sitio');

const emblemModule = read('team-emblem.js');
check('el módulo expone urlFor, bind e imgTag',
  /urlFor:/.test(emblemModule) && /bind:/.test(emblemModule) && /imgTag:/.test(emblemModule));
check('descarta los placeholders viejos guardados en la base',
  /placehold\.co/.test(emblemModule) && /dragon_profile_studiosgamesrs/.test(emblemModule));

const USERS = [
  ['competition-hub-logic.js', 'el Competition Hub'],
  ['dashboard-logic.js', 'el Dashboard'],
  ['commander-warroom.js', 'el War Room'],
  ['play-now.js', 'la ventana Juega ahora'],
];
USERS.forEach(function (entry) {
  const text = read(entry[0]);
  check(entry[1] + ' usa el módulo compartido', /SGTeamEmblem/.test(text));
});

section('nadie vuelve a los placeholders de fuera');

const NO_PLACEHOLDER = [
  'competition-hub.html',
  'competition-hub-logic.js',
  'dashboard-logic.js',
  'commander-warroom.js',
  'play-now.js',
];
NO_PLACEHOLDER.forEach(function (file) {
  check('sin placehold.co en ' + file, !/placehold\.co/.test(read(file)));
});

section('las páginas cargan el módulo antes de usarlo');

const PAGES = [
  ['competition-hub.html', 'competition-hub-logic.js'],
  ['dashboard.html', 'dashboard-logic.js'],
  ['commander-panel.html', 'commander-warroom.js'],
];
PAGES.forEach(function (entry) {
  const html = read(entry[0]);
  const emblemAt = html.indexOf('team-emblem.js');
  const userAt = html.indexOf(entry[1]);
  check(entry[0] + ' carga team-emblem.js', emblemAt !== -1);
  check('y lo hace antes de ' + entry[1],
    emblemAt !== -1 && userAt !== -1 && emblemAt < userAt);
});

section('la ventana Juega ahora');

const hub = read('competition-hub.html');
check('el botón está en la página', /id="playNowBtn"/.test(hub));
check('y la ventana también', /id="playNowModal"/.test(hub));
check('el botón vive en el widget My Competitive Status',
  /id="teamStatus"[\s\S]{0,400}id="playNowBtn"/.test(hub) &&
  /sg-playnow-bar is-sidebar/.test(hub));
check('el botón no lleva el trueno',
  !/<button[^>]*id="playNowBtn"[\s\S]{0,200}fa-bolt/.test(hub));
check('los torneos ya no cuelgan del final de la página, sino de la ventana',
  hub.indexOf('id="playNowModal"') < hub.indexOf('id="tournamentsList"'));
check('la ventana carga play-now.js', /play-now\.js/.test(hub));

const playNow = read('play-now.js');
check('el marcador sale del mismo nodo que la sala del torneo',
  /partida_en_vivo\/'\s*\+\s*id/.test(playNow));
check('solo se escuchan los torneos en vivo, no la base entera',
  /syncLiveSubscriptions/.test(playNow) && /\.off\(\)/.test(playNow));
check('los equipos se piden de uno en uno', /ensureTeam/.test(playNow));
check('se enseña la tabla de la partida, no solo las bajas',
  /scoreboard/.test(playNow) && /adr/.test(playNow));
check('la portada del torneo entra en la tarjeta', /bannerUrl/.test(playNow));

const css = read('sg-tournament-hub.css');
check('el botón reusa el efecto eléctrico del login',
  /\.sg-playnow-btn:hover::before/.test(css) && /linear-gradient\(90deg, transparent, #fff, transparent\)/.test(css));
check('la ventana tiene un solo scroll', /\.sg-playnow-body/.test(css));

section('los torneos se listan por su clave, no por un campo opcional');

const hubLogic = read('competition-hub-logic.js');
check('el identificador viene de la clave del nodo',
  /Object\.keys\(allTournaments\)/.test(hubLogic));
check('ya no se pierde con Object.values',
  !/Object\.values\(allTournaments\)/.test(hubLogic));

// ---------------------------------------------------------------------------

console.log('');
if (failures) {
  console.error('[verify-play-now] ' + failures + ' comprobación(es) fallaron.');
  process.exit(1);
}
console.log('[verify-play-now] Todas las comprobaciones pasaron.');
