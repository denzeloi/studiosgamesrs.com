#!/usr/bin/env node
'use strict';

/**
 * El cuadro no puede avanzar dos veces.
 *
 * El fin de partida lo cierran dos manos distintas: el webhook del servidor y el
 * piloto automático del War Room. Con la ranura elegida como "la primera libre",
 * el segundo en llegar metía al mismo ganador en las dos ranuras del cruce
 * siguiente y la ronda se jugaba contra sí misma. Aquí se comprueba que repetir
 * la operación deja exactamente el mismo cuadro.
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

let failed = 0;

function ok(msg) {
  console.log('OK  ', msg);
}

function eq(label, actual, expected) {
  if (actual === expected) ok(label);
  else {
    console.error('FAIL', label, '— esperaba', JSON.stringify(expected), 'y llegó', JSON.stringify(actual));
    failed += 1;
  }
}

console.log('--- la ranura del ganador sale del cruce de origen ---');

eq('el cruce 1 sube arriba', bracket.slotForFeeder('r1_m1', {}), 'teamA');
eq('el cruce 2 sube abajo', bracket.slotForFeeder('r1_m2', {}), 'teamB');
eq('el cruce 3 sube arriba de la siguiente llave', bracket.slotForFeeder('r1_m3', {}), 'teamA');
eq('el cruce 4 sube abajo', bracket.slotForFeeder('r1_m4', {}), 'teamB');
eq('en semifinales manda el mismo número', bracket.slotForFeeder('r2_m2', {}), 'teamB');
// Un cuadro importado con otros nombres no puede reventar: se cae al hueco libre.
eq('un identificador raro cae en el hueco libre',
  bracket.slotForFeeder('final', { teamA: { teamId: 'x' } }), 'teamB');

console.log('\n--- avanzar dos veces deja el mismo cuadro ---');

function fourTeamBracket() {
  return bracket.buildSingleElimBracket(['alpha', 'bravo', 'charlie', 'delta']);
}

const b = fourTeamBracket();
eq('el cuadro de cuatro tiene dos rondas', b.rounds, 2);
eq('y el primer cruce es r1_m1', b.currentMatchId, 'r1_m1');

const first = bracket.planAdvance(b, 'r1_m1', 'alpha', { a: 13, b: 9 });
eq('el ganador de r1_m1 entra arriba de la final', first.slot, 'teamA');
eq('la final se queda esperando al otro', first.nextPatch.status, 'waiting');
eq('y no cierra el torneo todavía', first.complete, false);

// --- La final no es lanzable con media semifinal jugada ---
//
// Cerrada una semi, currentMatchId apuntaba a la final: el War Room la daba por
// partida del momento y ofrecía lanzarla contra un hueco vacío, mientras la otra
// semi, que era lo que tocaba jugar, dejaba de ser la actual.
eq('la final no se convierte en la partida del momento', first.ready, false);
eq('el cruce que falta es el que pasa a ser el actual',
  first.tournamentPatch.currentMatchId, 'r1_m2');
eq('y se dice cuál es ese cruce', first.peerMatchId, 'r1_m2');

// Se aplica el plan al cuadro, como haría la base.
b.matches.r1_m1.status = 'finished';
b.matches.r1_m1.winnerTeamId = 'alpha';
b.matches.r2_m1.teamA = { teamId: 'alpha', fromMatchId: 'r1_m1' };
b.matches.r2_m1.status = 'waiting';

// El piloto automático llega tarde con el mismo resultado.
const repeat = bracket.planAdvance(b, 'r1_m1', 'alpha', { a: 13, b: 9 });
eq('la repetición no vuelve a mover nada', repeat.skip, true);
eq('pero sigue siendo una operación válida', repeat.ok, true);

// El otro semifinal entra por la ranura de abajo, nunca encima del primero.
const second = bracket.planAdvance(b, 'r1_m2', 'charlie', {});
eq('el ganador de r1_m2 entra abajo', second.slot, 'teamB');
eq('con los dos dentro la final está lista', second.nextPatch.status, 'ready');
eq('y ahora sí es la partida del momento',
  second.tournamentPatch.currentMatchId, 'r2_m1');
eq('y respeta al que ya estaba arriba',
  b.matches.r2_m1.teamA.teamId, 'alpha');

console.log('\n--- el gate de ronda mira al otro feeder, no solo a la ranura ---');

// Un cuadro de ocho: los cuartos se cierran salteados y cada llave tiene que
// esperar a su propio par, no al primero que caiga.
const b8 = bracket.buildSingleElimBracket(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
eq('r1_m3 desemboca en la otra semifinal', b8.matches.r1_m3.nextMatchId, 'r2_m2');
eq('el par de r1_m1 es r1_m2', bracket.peerFeederId(b8.matches, 'r1_m1', 'r2_m1'), 'r1_m2');
eq('el par de r1_m4 es r1_m3', bracket.peerFeederId(b8.matches, 'r1_m4', 'r2_m2'), 'r1_m3');

const q3 = bracket.planAdvance(b8, 'r1_m3', 'e', {});
eq('cerrar un cuarto deja su semifinal esperando', q3.nextPatch.status, 'waiting');
eq('y manda al cruce que le falta a esa llave',
  q3.tournamentPatch.currentMatchId, 'r1_m4');

b8.matches.r1_m3.status = 'finished';
b8.matches.r1_m3.winnerTeamId = 'e';
b8.matches.r2_m2.teamA = { teamId: 'e', fromMatchId: 'r1_m3' };
b8.matches.r2_m2.status = 'waiting';

const q4 = bracket.planAdvance(b8, 'r1_m4', 'g', {});
eq('con los dos cuartos cerrados la semifinal está lista', q4.nextPatch.status, 'ready');
eq('y pasa a ser la partida del momento',
  q4.tournamentPatch.currentMatchId, 'r2_m2');

// Un feeder solitario (cuadro con pase directo) no puede esperar a nadie.
const solo = {
  matches: {
    r1_m1: { id: 'r1_m1', round: 1, nextMatchId: 'r2_m1', status: 'ready',
      teamA: { teamId: 'a' }, teamB: { teamId: 'b' } },
    r2_m1: { id: 'r2_m1', round: 2, teamA: null, teamB: { teamId: 'z' }, nextMatchId: null },
  },
};
const soloPlan = bracket.planAdvance(solo, 'r1_m1', 'a', {});
eq('sin otro feeder no se espera a nadie', soloPlan.peerMatchId, null);
eq('y la siguiente ronda queda lista', soloPlan.nextPatch.status, 'ready');
eq('y es la partida del momento', soloPlan.tournamentPatch.currentMatchId, 'r2_m1');

console.log('\n--- casos raros ---');

const conflict = bracket.planAdvance(b, 'r1_m1', 'bravo', {});
eq('dos ganadores distintos para el mismo cruce se rechazan', conflict.ok, false);
eq('y se dice quién figuraba', conflict.current, 'alpha');

eq('un cruce que no existe se rechaza',
  bracket.planAdvance(b, 'r9_m9', 'alpha', {}).reason, 'match_not_found');
eq('sin ganador no se avanza',
  bracket.planAdvance(b, 'r1_m2', null, {}).reason, 'no_winner');

b.matches.r2_m1.teamB = { teamId: 'charlie', fromMatchId: 'r1_m2' };
const finalPlan = bracket.planAdvance(b, 'r2_m1', 'alpha', {});
eq('ganar la final cierra el torneo', finalPlan.complete, true);
eq('y corona al campeón', finalPlan.tournamentPatch.championTeamId, 'alpha');

console.log('\n--- las dos manos siguen sincronizadas ---');

const warroom = fs.readFileSync(path.join(repoRoot, 'commander-warroom.js'), 'utf8');

if (!/function bracketSlotForFeeder/.test(warroom)) {
  console.error('FAIL El War Room volvió a elegir la ranura a ojo');
  failed += 1;
} else {
  ok('el War Room usa la misma regla de ranura que el servidor');
}

if (!/autopilotBusy/.test(warroom) || !/\.transaction\(function \(current\) \{\s*return current === 'finished'/.test(warroom)) {
  console.error('FAIL El piloto automático escribe sin reclamar el cruce primero');
  failed += 1;
} else {
  ok('el piloto automático reclama el cruce con una transacción antes de escribir');
}

// El piloto automático pasa por advanceWinner, así que el gate del War Room
// tiene que vivir ahí y no en el botón de cerrar cruce.
if (!/function bracketPeerFeederId/.test(warroom)) {
  console.error('FAIL El War Room no busca el otro feeder: adelantaría la final con media ronda jugada');
  failed += 1;
} else {
  ok('el War Room aplica el mismo gate de ronda que el servidor');
}

if (!/updates\[base \+ '\/currentMatchId'\] = becomesCurrent;/.test(warroom)) {
  console.error('FAIL El War Room vuelve a marcar la siguiente ronda como partida en curso sin comprobar el otro feeder');
  failed += 1;
} else {
  ok('la partida en curso solo salta de ronda cuando los dos feeders han cerrado');
}

if (!/advanceWinner\(mid, winner, score\)/.test(warroom)) {
  console.error('FAIL El piloto automático ya no pasa por advanceWinner y se saltaría el gate');
  failed += 1;
} else {
  ok('el piloto automático cierra por la misma puerta que el Commander');
}

if (failed) {
  console.error('\n[verify-cs2-bracket]', failed, 'comprobación(es) fallida(s)');
  process.exit(1);
}
console.log('\n[verify-cs2-bracket] Todas las comprobaciones pasaron.');
