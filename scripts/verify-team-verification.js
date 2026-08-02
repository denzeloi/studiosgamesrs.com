#!/usr/bin/env node
'use strict';

/**
 * Comprueba la puerta de verificación de equipos en el circuito de torneos.
 *
 * La verificación se paga estando ya inscrito, así que no se puede exigir al
 * entrar al torneo: la puerta va justo antes de lanzar la partida y se descuenta
 * una de las tres al terminar. Aquí se prueba la decisión pura (quién bloquea,
 * cómo se gasta) y que el lanzamiento y el webhook siguen enchufados a ella.
 */

const fs = require('fs');
const path = require('path');

process.env.FIREBASE_CONFIG = JSON.stringify({
  databaseURL: 'https://verify-only.firebaseio.com',
  projectId: 'verify-only',
});
process.env.GCLOUD_PROJECT = 'verify-only';

const repoRoot = path.join(__dirname, '..');
const verification = require(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'verification.js'));

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

function verified(matchesRemaining) {
  return { verification: { status: 'verified', matchesRemaining: matchesRemaining } };
}

console.log('--- estado de verificación ---');

eq('un equipo verificado con partidas puede jugar', verification.statusOf(verified(3)).verified, true);
eq('un equipo sin nodo de verificación no puede', verification.statusOf({}).verified, false);
eq('un equipo verificado sin partidas ya no puede',
  verification.statusOf(verified(0)).verified, false);
eq('un equipo a medio pagar no puede',
  verification.statusOf({ verification: { status: 'pending', matchesRemaining: 3 } }).verified, false);
// Los equipos viejos no tienen contador: si el estado dice verificado, se juega.
eq('un equipo verificado antiguo sin contador sí puede',
  verification.statusOf({ verification: { status: 'verified' } }).verified, true);

console.log('\n--- quién bloquea el cruce ---');

const blocked = verification.blockingTeams([
  { teamId: 'team-alpha', team: Object.assign({ name: 'Alpha' }, verified(2)) },
  { teamId: 'team-bravo', team: { name: 'Bravo' } },
]);
eq('solo bloquea el equipo sin verificar', blocked.length, 1);
eq('y se le nombra para poder avisarle', blocked[0] && blocked[0].name, 'Bravo');
eq('con los dos verificados no bloquea nadie',
  verification.blockingTeams([
    { teamId: 'a', team: verified(1) },
    { teamId: 'b', team: verified(3) },
  ]).length, 0);
eq('un equipo que no existe se trata como sin verificar',
  verification.blockingTeams([{ teamId: 'fantasma', team: null }]).length, 1);
eq('sin equipos no hay nada que bloquear', verification.blockingTeams([]).length, 0);

const msg = verification.blockedMessage(blocked);
eq('el aviso nombra al equipo', msg.indexOf('Bravo') !== -1, true);
eq('el aviso explica que vale para tres partidas', msg.indexOf('tres partidas') !== -1, true);

console.log('\n--- gastar una de las tres ---');

eq('de tres quedan dos', verification.spendOne(verified(3).verification).matchesRemaining, 2);
eq('la tercera deja el equipo sin verificar',
  verification.spendOne(verified(1).verification).status, 'unverified');
eq('y sin partidas pendientes',
  verification.spendOne(verified(1).verification).matchesRemaining, 0);
// Los pagos se reinician para que el siguiente ciclo empiece limpio.
eq('los pagos del ciclo se borran al agotarse',
  verification.spendOne({ status: 'verified', matchesRemaining: 1, payments: { u1: true } }).payments, null);
eq('un equipo sin verificar no gasta nada',
  verification.spendOne({ status: 'unverified', matchesRemaining: 0 }).matchesRemaining, 0);

console.log('\n--- el lanzamiento y el fin de partida siguen enchufados ---');

const indexSrc = fs.readFileSync(path.join(repoRoot, 'functions', 'cs2-nexus', 'index.js'), 'utf8');
const webhookSrc = fs.readFileSync(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'webhook.js'), 'utf8');
const warroomSrc = fs.readFileSync(path.join(repoRoot, 'commander-warroom.js'), 'utf8');
const systemSrc = fs.readFileSync(path.join(repoRoot, 'tournament-system.js'), 'utf8');

eq('el lanzamiento comprueba la verificación',
  /verification\.checkTeams/.test(indexSrc), true);
eq('la negativa lleva un motivo que el panel entiende',
  /reason: 'teams_unverified'/.test(indexSrc), true);
eq('el Commander puede saltársela para amistosos',
  /allowUnverifiedTeams !== true/.test(indexSrc), true);
eq('el fin de partida descuenta una partida',
  /verification\.consumeForMatch/.test(webhookSrc), true);
eq('el War Room explica quién falta por verificar',
  /teams_unverified/.test(warroomSrc), true);
eq('y el permiso viaja hasta la función',
  /allowUnverifiedTeams/.test(systemSrc), true);

if (failed) {
  console.error('\n[verify-team-verification]', failed, 'comprobación(es) fallida(s)');
  process.exit(1);
}
console.log('\n[verify-team-verification] Todas las comprobaciones pasaron.');
