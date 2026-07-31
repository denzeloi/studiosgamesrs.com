#!/usr/bin/env node
'use strict';

/**
 * Comprueba el tope de partidas simultáneas por torneo (modo un servidor vs dos).
 *
 *   node scripts/verify-cs2-concurrency.js
 */

const path = require('path');
const fs = require('fs');

const concurrency = require(path.join(__dirname, '..', 'functions', 'cs2-nexus', 'lib', 'concurrency.js'));

let failed = 0;

function ok(msg) { console.log('OK  ', msg); }
function fail(msg) { console.error('FAIL', msg); failed += 1; }
function check(cond, msg) { (cond ? ok : fail)(msg); }

function tournament(mode, liveMatches) {
  return { serverMode: mode, liveMatches: liveMatches || {} };
}

// --- Modo por defecto: servidor único, aunque no haya campo en el torneo ---

check(concurrency.modeOf({}) === 'single', 'sin serverMode el torneo corre en modo servidor único');
check(concurrency.modeOf({ serverMode: 'DUAL' }) === 'dual', 'serverMode acepta mayúsculas');
check(concurrency.modeOf({ serverMode: 'triple' }) === 'single', 'un modo desconocido cae a servidor único, no a barra libre');
check(concurrency.limitOf({ serverMode: 'dual' }) === 2, 'modo dual permite dos partidas');

// --- Un servidor: la segunda partida no arranca ---

let plan = concurrency.plan(tournament('single', {}), 'r1_m1', 0);
check(plan.allowed && plan.slot === 0, 'primera partida en modo único usa el slot 0');

plan = concurrency.plan(tournament('single', { r1_m1: { status: 'live', gsltIndex: 0 } }), 'r1_m2', 1);
check(!plan.allowed, 'modo único bloquea un segundo cruce mientras el primero está vivo');
check(
  /servidor único/.test(concurrency.blockedMessage(plan, 'levantar otro servidor')) &&
  /r1_m1/.test(concurrency.blockedMessage(plan, 'levantar otro servidor')),
  'el mensaje de bloqueo dice el modo y qué cruce ocupa el servidor'
);

plan = concurrency.plan(tournament('single', { r1_m1: { status: 'live' } }), 'r1_m1', 0);
check(plan.allowed && plan.slot === 0, 'relanzar el mismo cruce no cuenta como segunda partida');

plan = concurrency.plan(tournament('single', { r1_m1: { status: 'finished' } }), 'r1_m2', 0);
check(plan.allowed, 'una partida terminada libera el servidor para el siguiente cruce');

concurrency.BUSY_STATUSES.forEach(function (status) {
  const p = concurrency.plan(tournament('single', { r1_m1: { status: status } }), 'r1_m2', 0);
  check(!p.allowed, 'estado ' + status + ' cuenta como servidor ocupado');
});

// --- Dos servidores: reparto de slot GSLT ---

plan = concurrency.plan(tournament('dual', { r1_m1: { status: 'live', gsltIndex: 0 } }), 'r1_m2', 0);
check(plan.allowed && plan.slot === 1, 'con el slot 0 ocupado el segundo cruce cae al slot 1 aunque pida el 0');

plan = concurrency.plan(tournament('dual', { r1_m1: { status: 'live', gsltIndex: 1 } }), 'r1_m2', 0);
check(plan.allowed && plan.slot === 0, 'si el ocupado es el slot 1, el nuevo cruce toma el 0');

plan = concurrency.plan(tournament('dual', {
  r1_m1: { status: 'live', gsltIndex: 0 },
  r1_m2: { status: 'starting', gsltIndex: 1 },
}), 'r2_m1', 0);
check(!plan.allowed && plan.busy.length === 2, 'con los dos servidores ocupados no cabe un tercer cruce');
check(/máximo/.test(concurrency.blockedMessage(plan, 'lanzar este cruce')), 'el bloqueo en dual habla del máximo del torneo');

// --- Las funciones tienen que usar el módulo, no una copia suelta ---

const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'functions', 'cs2-nexus', 'index.js'),
  'utf8'
);
check(/require\('\.\/lib\/concurrency'\)/.test(indexSrc), 'index.js carga lib/concurrency');
check(
  (indexSrc.match(/concurrency\.plan\(/g) || []).length >= 2,
  'provision y launch pasan por el mismo tope'
);
check(
  /labels: \{ tournamentId, matchId, gslt: String\(slot\) \}/.test(indexSrc),
  'la VM se etiqueta con el slot resuelto por el backend, no con el que pidió el panel'
);

if (failed) {
  console.error('\n' + failed + ' check(s) failed');
  process.exit(1);
}
console.log('\nAll concurrency checks passed');
