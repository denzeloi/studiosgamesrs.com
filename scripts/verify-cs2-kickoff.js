#!/usr/bin/env node
'use strict';

/**
 * El saque: comenzar un cruce, o los dos de la primera ronda, sin perder el cuadro.
 *
 * El fallo que cubre esto era silencioso y caro: lanzar un cruce mandaba al
 * backend los dos equipos de ese cruce, y el backend rehacía el cuadro entero
 * con lo que le llegara. Comenzar r1_m1 de un torneo de cuatro lo convertía en
 * un torneo de dos: r1_m2 y la final desaparecían con sus equipos y sus horas,
 * y nadie se enteraba hasta que la otra semifinal iba a empezar.
 *
 * Se comprueban las dos mitades: la decisión pura del backend (lib/bracket.js)
 * y las reglas del War Room, extraídas tal cual del archivo y ejecutadas con
 * estado inyectado, para que aflojar el filtro en el panel se note aquí.
 *
 *   node scripts/verify-cs2-kickoff.js
 */

const fs = require('fs');
const path = require('path');

process.env.FIREBASE_CONFIG = JSON.stringify({
  databaseURL: 'https://verify-only.firebaseio.com',
  projectId: 'verify-only',
});
process.env.GCLOUD_PROJECT = 'verify-only';

const repoRoot = path.join(__dirname, '..');
const bracket = require(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'bracket.js'));

const indexSrc = fs.readFileSync(path.join(repoRoot, 'functions', 'cs2-nexus', 'index.js'), 'utf8');
const systemSrc = fs.readFileSync(path.join(repoRoot, 'tournament-system.js'), 'utf8');
// Sin normalizar, el \n de los recortes no encuentra nada en un archivo CRLF.
const warRoomSrc = fs
  .readFileSync(path.join(repoRoot, 'commander-warroom.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const panelSrc = fs.readFileSync(path.join(repoRoot, 'commander-panel.html'), 'utf8');

let failed = 0;

function ok(msg) { console.log('OK  ', msg); }
function fail(msg) { console.error('FAIL', msg); failed += 1; }
function check(cond, msg) { (cond ? ok : fail)(msg); }
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) ok(label);
  else fail(label + ' — esperaba ' + b + ' y llegó ' + a);
}

// ---------------------------------------------------------------------------
// 1. La decisión de sembrar el cuadro (lib/bracket.js)
// ---------------------------------------------------------------------------

const fourTeams = ['alpha', 'bravo', 'charlie', 'delta'];
const cuadro = bracket.buildSingleElimBracket(fourTeams);
const torneo = { serverMode: 'dual', bracket: cuadro };

check(
  bracket.shouldSeedBracket(torneo, ['alpha', 'bravo'], undefined) === false,
  'cuadro de 4 ya sembrado: comenzar r1_m1 con sus 2 equipos no lo resiembra'
);
check(
  bracket.shouldSeedBracket(torneo, ['charlie', 'delta'], undefined) === false,
  'cuadro de 4 ya sembrado: comenzar r1_m2 con sus 2 equipos tampoco'
);
check(
  bracket.shouldSeedBracket(torneo, fourTeams, undefined) === false,
  'ni siquiera con los 4 equipos: el cuadro que existe manda'
);
check(
  bracket.shouldSeedBracket({}, ['alpha', 'bravo'], undefined) === true,
  'sin cuadro todavía: lanzar sí lo siembra (atajo de siempre)'
);
check(
  bracket.shouldSeedBracket({ bracket: { matches: {} } }, ['alpha', 'bravo'], undefined) === true,
  'cuadro vacío cuenta como sin sembrar'
);
check(
  bracket.shouldSeedBracket({}, ['alpha', 'bravo'], true) === false,
  'skipBracketRebuild corta la siembra aunque no haya cuadro'
);
check(
  bracket.shouldSeedBracket({}, ['alpha'], undefined) === false,
  'un solo equipo no siembra nada'
);
check(
  bracket.shouldSeedBracket({}, undefined, undefined) === false,
  'sin teamIds no siembra nada'
);

eq('teamIdsForMatch lee los dos equipos del cruce',
  bracket.teamIdsForMatch(torneo, 'r1_m1'),
  [cuadro.matches.r1_m1.teamA.teamId, cuadro.matches.r1_m1.teamB.teamId]);
eq('teamIdsForMatch de la final vacía devuelve []',
  bracket.teamIdsForMatch(torneo, 'r2_m1'), []);
eq('teamIdsForMatch de un cruce inexistente devuelve []',
  bracket.teamIdsForMatch(torneo, 'r9_m9'), []);
eq('teamIdsForMatch sin cuadro devuelve []',
  bracket.teamIdsForMatch({}, 'r1_m1'), []);

// ---------------------------------------------------------------------------
// 2. Hecho cuando: se lanzan las dos semis y r2_m1 sigue en pie y vacía
// ---------------------------------------------------------------------------

/** Lo que launchMatchCore le hace al cuadro al comenzar un cruce. */
function simulateLaunch(t, matchId, teamIds, skipRebuild) {
  const next = JSON.parse(JSON.stringify(t));
  if (bracket.shouldSeedBracket(next, teamIds, skipRebuild)) {
    const seeded = bracket.buildSingleElimBracket(teamIds);
    next.bracket = seeded;
    next.currentMatchId = seeded.currentMatchId;
  }
  return next;
}

let corriendo = JSON.parse(JSON.stringify(torneo));
corriendo = simulateLaunch(corriendo, 'r1_m1', ['alpha', 'bravo'], true);
corriendo = simulateLaunch(corriendo, 'r1_m2', ['charlie', 'delta'], true);

const tras = corriendo.bracket.matches;
eq('tras comenzar las dos semis siguen los 3 cruces',
  Object.keys(tras).sort(), ['r1_m1', 'r1_m2', 'r2_m1']);
check(!!tras.r2_m1, 'la final r2_m1 sigue existiendo');
check(
  !(tras.r2_m1.teamA && tras.r2_m1.teamA.teamId) && !(tras.r2_m1.teamB && tras.r2_m1.teamB.teamId),
  'la final sigue vacía, esperando a los ganadores'
);
eq('r1_m2 conserva sus equipos',
  [tras.r1_m2.teamA.teamId, tras.r1_m2.teamB.teamId].sort(),
  [cuadro.matches.r1_m2.teamA.teamId, cuadro.matches.r1_m2.teamB.teamId].sort());
eq('las rondas del cuadro no cambian', corriendo.bracket.rounds, cuadro.rounds);

// El mismo lanzamiento sin la corrección: así de destructivo era.
const sinFix = simulateLaunch(
  { bracket: null },
  'r1_m1',
  ['alpha', 'bravo'],
  false
);
eq('control: sembrar con 2 equipos deja un cuadro de un solo cruce',
  Object.keys(sinFix.bracket.matches), ['r1_m1']);

// ---------------------------------------------------------------------------
// 3. Reglas del War Room, ejecutadas tal cual están en el archivo
// ---------------------------------------------------------------------------

function extract(name) {
  const re = new RegExp('\\n  function ' + name + '\\([\\s\\S]*?\\n  \\}\\n');
  const found = re.exec(warRoomSrc);
  if (!found) {
    fail('no se encontró la función ' + name + '() en commander-warroom.js');
    return 'function ' + name + '() { throw new Error("missing"); }';
  }
  return found[0];
}

const buildRules = new Function('state', [
  '"use strict";',
  'function num(v, d) { var n = Number(v); return isNaN(n) ? (d || 0) : n; }',
  'function keys(o) { return o ? Object.keys(o) : []; }',
  'function serverMode(t) { return (t && t.serverMode) === "dual" ? "dual" : "single"; }',
  extract('serverReadyVerified'),
  extract('bracketMatchNumber'),
  extract('firstRoundMatchIds'),
  extract('matchCanStart'),
  extract('semisReadyToStart'),
  'return { matchCanStart: matchCanStart, semisReadyToStart: semisReadyToStart };',
].join('\n'));

function warRoom(servers) {
  return buildRules({ servers: servers || {} });
}

function dualTournament(live) {
  return {
    serverMode: 'dual',
    bracket: JSON.parse(JSON.stringify(cuadro)),
    liveMatches: live || {},
  };
}

const readyServers = {
  'srv-1': { rconReady: true },
  'srv-2': { readyVerified: true },
  'srv-boot': { status: 'online', readyVerified: false, readyReason: 'boot_grace' },
};
const rules = warRoom(readyServers);

const dosListas = dualTournament({
  r1_m1: { serverId: 'srv-1', status: 'online' },
  r1_m2: { serverId: 'srv-2', status: 'online' },
});
check(rules.matchCanStart(dosListas, 'r1_m1'), 'cruce con VM confirmada se puede comenzar');
eq('con las dos VMs confirmadas se ofrecen las dos semis',
  rules.semisReadyToStart(dosListas), ['r1_m1', 'r1_m2']);

check(
  !rules.matchCanStart(dualTournament({ r1_m1: { serverId: 'srv-boot' } }), 'r1_m1'),
  'una VM dada por buena solo por antigüedad no habilita el saque'
);
check(
  !rules.matchCanStart(dualTournament({}), 'r1_m1'),
  'sin servidor asignado no hay saque'
);
check(
  !rules.matchCanStart(dualTournament({ r1_m1: { serverId: 'srv-1', status: 'live' } }), 'r1_m1'),
  'un cruce ya en vivo no se vuelve a lanzar'
);
check(
  rules.matchCanStart(dualTournament({ r1_m1: { serverId: 'srv-1', status: 'starting' } }), 'r1_m1'),
  'un lanzamiento que se quedó en starting sí se puede reintentar'
);
check(
  !rules.matchCanStart(dosListas, 'r2_m1'),
  'la final sin equipos no se puede comenzar aunque hubiera máquina'
);

const finalizada = dualTournament({ r1_m1: { serverId: 'srv-1' } });
finalizada.bracket.matches.r1_m1.status = 'finished';
check(!rules.matchCanStart(finalizada, 'r1_m1'), 'un cruce cerrado no se relanza');

eq('con una sola VM confirmada no se ofrece el saque doble',
  rules.semisReadyToStart(dualTournament({ r1_m1: { serverId: 'srv-1' } })), []);

const single = dualTournament({
  r1_m1: { serverId: 'srv-1' },
  r1_m2: { serverId: 'srv-2' },
});
single.serverMode = 'single';
eq('en modo un servidor no existe el saque doble', rules.semisReadyToStart(single), []);
check(rules.matchCanStart(single, 'r1_m1'), 'pero el saque por cruce sigue disponible');

// ---------------------------------------------------------------------------
// 4. Que el cableado siga puesto
// ---------------------------------------------------------------------------

check(
  /skipBracketRebuild/.test(indexSrc) && /bracket\.shouldSeedBracket\(/.test(indexSrc),
  'launchMatchCore decide la siembra con bracket.shouldSeedBracket'
);
check(
  !/if \(teamIds && teamIds\.length >= 2\) \{\s*const bracketData/.test(indexSrc),
  'launchMatchCore ya no resiembra el cuadro solo por recibir 2 teamIds'
);
check(
  /bracket\.teamIdsForMatch\(tournament, matchId\)/.test(indexSrc),
  'launchMatchCore saca los equipos del cuadro cuando no se los mandan'
);
check(
  /teamIds: roster/.test(indexSrc),
  'la plantilla de MatchZy sale de ese mismo roster'
);
check(
  /skipBracketRebuild: opts\.skipBracketRebuild === true/.test(systemSrc),
  'tournament-system.js manda skipBracketRebuild solo si se lo piden'
);
check(
  /skipBracketRebuild: true/.test(warRoomSrc),
  'el War Room lo pide al comenzar un cruce'
);
check(
  /data-cwr-launch/.test(warRoomSrc) && /\[data-cwr-launch\]/.test(warRoomSrc),
  'el botón Comenzar del cruce está pintado y enganchado'
);
check(
  /function launchBothSemis\(/.test(warRoomSrc),
  'existe el saque de las dos semis'
);
check(
  /launchMatch\(\{ matchId: semis\[0\] \}\)[\s\S]{0,200}launchMatch\(\{ matchId: semis\[1\] \}\)/.test(warRoomSrc),
  'las dos semis se lanzan en fila, no a la vez'
);
check(
  /id="cwrBtnLaunchBoth"/.test(panelSrc),
  'el panel tiene el botón Comenzar ambas semis'
);
check(
  /on\('cwrBtnLaunchBoth', 'click', launchBothSemis\)/.test(warRoomSrc),
  'el botón Comenzar ambas semis está enganchado'
);
check(
  /var matchId = options\.matchId \|\| t\.currentMatchId/.test(warRoomSrc),
  'launchMatch acepta el cruce al que se le da el saque'
);
check(
  /options\.matchId\s*\n\s*\? \(\(match && match\.map\)/.test(warRoomSrc),
  'el saque por cruce respeta el mapa de su tarjeta, no el desplegable de arriba'
);
check(
  /matchId: options && options\.matchId/.test(warRoomSrc),
  'el reintento tras saltarse una puerta vuelve al mismo cruce'
);

console.log('');
if (failed) {
  console.error(failed + ' comprobación(es) fallaron.');
  process.exit(1);
}
console.log('Saque por cruce y doble semifinal: cuadro intacto.');
