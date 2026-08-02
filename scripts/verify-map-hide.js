#!/usr/bin/env node
'use strict';

/**
 * El mapa no se canta antes del saque.
 *
 * El mapa se escribe en el cruce al lanzar, pero la máquina todavía tarda en
 * responder: entre `provisioning`/`starting` y el saque hay una ventana en la
 * que la sala pública lo mostraba y el juego aún no. Quien mirase la web sabía
 * dónde se juega antes que su rival y llegaba con la ronda preparada.
 *
 * Aquí no se maqueta nada: se extraen las funciones tal cual están en
 * tournament-details.js y se ejecutan con el estado inyectado, así que si
 * alguien afloja el filtro en la página, esto se entera.
 *
 *   node scripts/verify-map-hide.js
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const detailsPath = path.join(repoRoot, 'tournament-details.js');
const src = fs.readFileSync(detailsPath, 'utf8');

let failed = 0;

function ok(msg) { console.log('OK  ', msg); }
function fail(msg) { console.error('FAIL', msg); failed += 1; }
function check(cond, msg) { (cond ? ok : fail)(msg); }
function eq(label, actual, expected) {
  if (actual === expected) ok(label);
  else fail(label + ' — esperaba ' + JSON.stringify(expected) + ' y llegó ' + JSON.stringify(actual));
}

/** El texto de una función de nivel módulo, tal cual está en el archivo. */
function extract(name) {
  const re = new RegExp('\\n  function ' + name + '\\([\\s\\S]*?\\n  \\}\\n');
  const found = re.exec(src);
  if (!found) {
    fail('no se encontró la función ' + name + '() en tournament-details.js');
    return 'function ' + name + '() { throw new Error("missing"); }';
  }
  return found[0];
}

const buildGate = new Function('state', [
  '"use strict";',
  'var liveMatches = state.liveMatches || {};',
  'var tournamentData = state.tournamentData || null;',
  'var selectedMatchId = state.selectedMatchId || null;',
  'var lastLivePayload = state.lastLivePayload || null;',
  extract('shownMatchId'),
  extract('isMapPublicForMatch'),
  extract('publicMapForMatch'),
  'return {',
  '  shownMatchId: shownMatchId,',
  '  isMapPublicForMatch: isMapPublicForMatch,',
  '  publicMapForMatch: publicMapForMatch,',
  '};',
].join('\n'));

function gate(state) {
  return buildGate(state);
}

function roomWith(status, extra) {
  const live = {};
  if (status) live.r1_m1 = Object.assign({ status: status, map: 'de_mirage' }, extra || {});
  return {
    liveMatches: live,
    tournamentData: {
      status: 'en_vivo',
      activeMatchId: 'r1_m1',
      activeMap: 'de_mirage',
      bracket: { matches: { r1_m1: { id: 'r1_m1', round: 1, status: 'pending', map: 'de_mirage' } } },
    },
  };
}

console.log('--- el mapa solo sale cuando el cruce está en juego ---');

['provisioning', 'starting'].forEach(function (status) {
  const g = gate(roomWith(status));
  eq('con status ' + status + ' el mapa no es público', g.isMapPublicForMatch('r1_m1'), false);
  eq('y no se devuelve ningún mapa que pintar', g.publicMapForMatch('r1_m1'), null);
});

let g = gate(roomWith('live'));
eq('con status live el mapa ya es público', g.isMapPublicForMatch('r1_m1'), true);
eq('y se devuelve el mapa del cruce', g.publicMapForMatch('r1_m1'), 'de_mirage');

g = gate(roomWith(null));
eq('sin entrada en liveMatches no hay mapa', g.publicMapForMatch('r1_m1'), null);
eq('y sin cruce tampoco', g.publicMapForMatch(null), null);

console.log('\n--- lo ya jugado no es secreto ---');

g = gate(roomWith('finished'));
eq('un cruce terminado conserva su mapa', g.publicMapForMatch('r1_m1'), 'de_mirage');

// Cuadro cerrado a mano por el Commander: no queda entrada viva del cruce.
g = gate({
  liveMatches: {},
  tournamentData: {
    status: 'en_vivo',
    activeMatchId: 'r1_m1',
    bracket: { matches: { r1_m1: { id: 'r1_m1', status: 'finished', map: 'de_nuke' } } },
  },
});
eq('un cruce cerrado en el cuadro también deja ver el mapa', g.isMapPublicForMatch('r1_m1'), true);
// Se lee del cruce, no del cuadro: el mapa del cuadro es lo que el Commander
// programó, que no tiene por qué ser lo que se jugó.
eq('pero el valor sale del cruce, no del cuadro', g.publicMapForMatch('r1_m1'), null);

console.log('\n--- los campos de nivel torneo no destapan nada ---');

g = gate({
  liveMatches: { r1_m1: { status: 'starting', map: 'de_mirage' } },
  tournamentData: {
    status: 'en_vivo',
    activeMatchId: 'r1_m1',
    activeMap: 'de_mirage',
    bracket: { matches: { r1_m1: { id: 'r1_m1', status: 'ready', map: 'de_mirage' } } },
  },
});
eq('activeMap no revela el mapa de un cruce que no ha sacado',
  g.publicMapForMatch('r1_m1'), null);

// Modo dos servidores: cada cruce responde por sí mismo.
const dual = {
  liveMatches: {
    r1_m1: { status: 'live', map: 'de_mirage' },
    r1_m2: { status: 'starting', map: 'de_nuke' },
  },
  tournamentData: {
    status: 'en_vivo',
    activeMatchId: 'r1_m1',
    activeMap: 'de_mirage',
    bracket: { matches: {} },
  },
};

g = gate(Object.assign({ selectedMatchId: 'r1_m1' }, dual));
eq('la semi en juego enseña su mapa', g.publicMapForMatch('r1_m1'), 'de_mirage');
eq('y es la que mira la sala', g.shownMatchId(dual.tournamentData), 'r1_m1');

g = gate(Object.assign({ selectedMatchId: 'r1_m2' }, dual));
eq('la semi que todavía arranca no enseña el suyo', g.publicMapForMatch('r1_m2'), null);
eq('ni hereda el de la otra', g.publicMapForMatch('r1_m2'), null);
eq('la sala está mirando esa', g.shownMatchId(dual.tournamentData), 'r1_m2');

// El parte en vivo solo sirve de respaldo para el cruce seleccionado, y solo
// cuando el cruce ya pasó el filtro.
g = gate({
  liveMatches: { r1_m1: { status: 'live' } },
  selectedMatchId: 'r1_m1',
  lastLivePayload: { map: 'de_ancient' },
  tournamentData: { status: 'en_vivo', activeMatchId: 'r1_m1' },
});
eq('sin mapa en el cruce se cae al parte en vivo', g.publicMapForMatch('r1_m1'), 'de_ancient');

g = gate({
  liveMatches: { r1_m1: { status: 'starting' } },
  selectedMatchId: 'r1_m1',
  lastLivePayload: { map: 'de_ancient' },
  tournamentData: { status: 'en_vivo', activeMatchId: 'r1_m1' },
});
eq('pero el parte en vivo no se salta el filtro', g.publicMapForMatch('r1_m1'), null);

console.log('\n--- todas las superficies públicas pasan por el filtro ---');

function block(label, re) {
  const found = re.exec(src);
  if (!found) {
    fail('no se pudo localizar ' + label + ' en tournament-details.js');
    return '';
  }
  return found[0];
}

const widget = block('renderMapWidget()', /\n  function renderMapWidget\([\s\S]*?\n  \}\n/);
check(/publicMapForMatch\(shownMatchId\(t\)\)/.test(widget),
  'el widget de mapa del hero pregunta por el cruce que se está mirando');
check(!/activeMap/.test(widget), 'y ya no se cuela por activeMap');

const meta = block('renderScoreboardMeta()', /\n  function renderScoreboardMeta\([\s\S]*?\n  \}\n/);
check(/publicMapForMatch\(shownMatchId\(t\)\)/.test(meta),
  'la línea de mapa del marcador pasa por el filtro');
check(/En preparación/.test(meta),
  'y mientras el cruce se monta dice eso en vez del mapa');

const bracketBox = block('renderBracket()', /\n  function renderBracket\([\s\S]*?\n  \}\n\n/);
check(/var mapName = publicMapForMatch\(mid\);/.test(bracketBox),
  'el chip de mapa de cada cruce del cuadro pasa por el filtro');

const sched = block('el calendario', /var currentId = t\.activeMatchId[\s\S]*?\}\)\.join\(''\);/);
check(/publicMapForMatch\(mid\)/.test(sched),
  'el calendario no publica el mapa programado antes de tiempo');
check(!/escHtml\(m\.map\)/.test(sched),
  'y ya no imprime m.map a pelo');

// El filtro depende de liveMatches, así que la sala tiene que repintar cuando
// ese nodo cambia: si no, el mapa seguiría escondido hasta el siguiente evento
// del servidor y el marcador se quedaría en "En preparación" con la partida ya
// en juego.
const liveListener = block('el listener de liveMatches',
  /\n  function attachLiveMatchesListener\([\s\S]*?\n  \}\n/);
check(/renderScoreboardMeta\(tournamentData\)/.test(liveListener),
  'al cambiar el estado de un cruce se repinta el marcador');
check(/renderSchedule\(tournamentData\)/.test(liveListener),
  'y el calendario, que también esconde el mapa');

const rulesMeta = block('tournamentRulesMeta()', /\n  function tournamentRulesMeta\([\s\S]*?\n  \}\n/);
check(/publicMapForMatch\(/.test(rulesMeta),
  'el chip de mapa del reglamento pasa por el filtro');
check(!/t\.activeMap/.test(rulesMeta),
  'el reglamento ya no lee activeMap');

// Fuera de la sala: la ventana "Juega ahora" del hub lista solo partidas en
// juego, pero su miniatura se caía a activeMap y ese campo puede estar
// hablando del otro cruce, que quizá ni ha sacado.
const playNow = fs.readFileSync(path.join(repoRoot, 'play-now.js'), 'utf8');
check(!/tournament\.activeMap/.test(playNow),
  'la ventana Juega ahora no saca el mapa del campo de nivel torneo');
check(/String\(match\.status \|\| ''\)\.toLowerCase\(\) !== 'live'/.test(playNow),
  'y sigue listando solo cruces en juego');

// El War Room es la otra mitad del trato: el Commander tiene que seguir
// eligiendo y viendo el mapa antes del saque.
const warroom = fs.readFileSync(path.join(repoRoot, 'commander-warroom.js'), 'utf8');
check(/cwrLaunchMap/.test(warroom),
  'el War Room conserva su selector de mapa');

if (failed) {
  console.error('\n[verify-map-hide] ' + failed + ' comprobación(es) fallida(s)');
  process.exit(1);
}
console.log('\n[verify-map-hide] Todas las comprobaciones pasaron.');
