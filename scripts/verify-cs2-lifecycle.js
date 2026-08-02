#!/usr/bin/env node
'use strict';

/**
 * Comprueba el fin de vida de los servidores de partida
 * (functions/cs2-nexus/lib/lifecycle.js).
 *
 * Lo que se protege aquí es la factura: una máquina que termina su partida y
 * nadie apaga sigue cobrando cada hora. Y lo contrario también importa — no se
 * puede borrar por debajo a diez jugadores que están en mitad de un mapa.
 *
 * Es lógica pura: sin red, sin Firebase y sin proveedor.
 */

const path = require('path');
const lifecycle = require(path.join(
  __dirname, '..', 'functions', 'cs2-nexus', 'lib', 'lifecycle.js'
));

let failed = 0;
function ok(msg) { console.log('OK  ', msg); }
function fail(msg, expected, actual) {
  console.error('FAIL', msg, '— expected', JSON.stringify(expected), 'got', JSON.stringify(actual));
  failed += 1;
}
function eq(label, actual, expected) {
  if (actual === expected) ok(label);
  else fail(label, expected, actual);
}
function deepEq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else fail(label, expected, actual);
}

const MIN = 60000;
const NOW = 1750000000000;
const ON = {};                              // valores por defecto
const OFF = { CS2_AUTOSHUTDOWN: '0' };

// ── Interruptor y márgenes ─────────────────────────────────────────────────
eq('el apagado viene activado de fábrica', lifecycle.autoShutdownEnabled(ON), true);
eq('se puede desactivar a mano', lifecycle.autoShutdownEnabled(OFF), false);
eq('margen por defecto de 15 minutos', lifecycle.shutdownGraceMs(ON), 15 * MIN);
eq('margen configurable', lifecycle.shutdownGraceMs({ CS2_AUTOSHUTDOWN_GRACE_MIN: '30' }), 30 * MIN);
eq('margen con tope por arriba', lifecycle.shutdownGraceMs({ CS2_AUTOSHUTDOWN_GRACE_MIN: '9999' }), 240 * MIN);
eq('margen con tope por abajo', lifecycle.shutdownGraceMs({ CS2_AUTOSHUTDOWN_GRACE_MIN: '0' }), 1 * MIN);
eq('un margen sin sentido no rompe nada', lifecycle.shutdownGraceMs({ CS2_AUTOSHUTDOWN_GRACE_MIN: 'pronto' }), 15 * MIN);
eq('la máquina ociosa aguanta 3 horas', lifecycle.idleMaxMs(ON), 180 * MIN);

// ── Lo que se escribe al acabar y al relanzar ──────────────────────────────
deepEq('al acabar la partida se programa el apagado',
  lifecycle.scheduleShutdownPatch(NOW, ON),
  { shutdownAfter: NOW + 15 * MIN, shutdownReason: 'match_complete' });
deepEq('desactivado no se programa nada', lifecycle.scheduleShutdownPatch(NOW, OFF), {});
deepEq('relanzar cancela el apagado pendiente',
  lifecycle.cancelShutdownPatch(), { shutdownAfter: null, shutdownReason: null });

// ── Decisión servidor a servidor ───────────────────────────────────────────
function reason(gs, opts) {
  const o = opts || {};
  return lifecycle.shutdownReasonFor(gs, o.now || NOW, o.env || ON, !!o.busy);
}

eq('plazo cumplido: se apaga',
  reason({ status: 'match_complete', shutdownAfter: NOW - 1 }), 'grace_elapsed');
eq('plazo aún no vencido: se queda',
  reason({ status: 'match_complete', shutdownAfter: NOW + 5 * MIN }), null);
eq('con partida en pie no se apaga aunque toque',
  reason({ status: 'match_complete', shutdownAfter: NOW - 1 }, { busy: true }), null);
eq('partida terminada sin plazo escrito, y fría: se apaga',
  reason({ status: 'match_complete', updatedAt: NOW - 20 * MIN }), 'finished_idle');
eq('partida recién terminada sin plazo: se espera',
  reason({ status: 'match_complete', updatedAt: NOW - 2 * MIN }), null);
eq('servidor parado también entra', reason({ status: 'stopped', updatedAt: NOW - 60 * MIN }), 'finished_idle');
eq('servidor con error también entra', reason({ status: 'error', updatedAt: NOW - 60 * MIN }), 'finished_idle');
eq('encendido y sin jugar durante horas: se apaga',
  reason({ status: 'online', updatedAt: NOW - 200 * MIN }), 'never_used');
eq('encendido hace un rato: se respeta',
  reason({ status: 'online', updatedAt: NOW - 30 * MIN }), null);
eq('arrancando no se toca', reason({ status: 'booting', updatedAt: NOW - 30 * MIN }), null);
eq('provisionando no se toca', reason({ status: 'provisioning', createdAt: NOW - 10 * MIN }), null);
eq('sin fecha de nada no se decide a ciegas', reason({ status: 'match_complete' }), null);
eq('un registro vacío no se apaga', reason(null), null);
eq('la fecha más reciente manda',
  reason({ status: 'match_complete', createdAt: NOW - 300 * MIN, updatedAt: NOW - 2 * MIN }), null);

// ── Plan completo ──────────────────────────────────────────────────────────
const servers = {
  s1: { status: 'match_complete', shutdownAfter: NOW - MIN, tournamentId: 't1', lastMatchId: 'r1_m1' },
  s2: { status: 'live', updatedAt: NOW - MIN, tournamentId: 't1' },
  s3: { status: 'match_complete', shutdownAfter: NOW + 10 * MIN, tournamentId: 't2' },
  s4: { status: 'online', updatedAt: NOW - 300 * MIN, tournamentId: 't3' },
  s5: { status: 'match_complete', shutdownAfter: NOW - MIN, tournamentId: 't4' },
};

const plan = lifecycle.planAutoShutdown(servers, NOW, ON, { s5: true });
deepEq('se apaga lo que toca y solo eso',
  plan.map(function (p) { return p.serverId; }).sort(), ['s1', 's4']);
eq('el plan lleva el torneo para liberar su cruce', plan[0].tournamentId, 't1');
eq('el plan explica el motivo', plan[0].reason, 'grace_elapsed');
eq('el que sigue jugando se salva del barrido',
  plan.some(function (p) { return p.serverId === 's5'; }), false);
deepEq('desactivado no se apaga nada', lifecycle.planAutoShutdown(servers, NOW, OFF, {}), []);
deepEq('sin servidores no hay plan', lifecycle.planAutoShutdown({}, NOW, ON, {}), []);

// ── Huérfanas en el proveedor ──────────────────────────────────────────────
function iso(ms) { return new Date(ms).toISOString(); }

const instances = [
  { id: 's1', name: 'cs2-a', createdAt: iso(NOW - 120 * MIN) },   // registrada
  { id: 'x9', name: 'cs2-huerfana', createdAt: iso(NOW - 120 * MIN) },
  { id: 'x8', name: 'cs2-recien-creada', createdAt: iso(NOW - 2 * MIN) },
  { id: 'x7', name: 'cs2-sin-fecha', createdAt: null },
];

const orphans = lifecycle.planOrphanCleanup(instances, servers, NOW, ON);
deepEq('solo se borra la huérfana vieja',
  orphans.map(function (o) { return o.serverId; }), ['x9']);
eq('una máquina registrada nunca se toca',
  orphans.some(function (o) { return o.serverId === 's1'; }), false);
eq('una recién creada se deja en paz',
  orphans.some(function (o) { return o.serverId === 'x8'; }), false);
eq('sin fecha fiable no se borra',
  orphans.some(function (o) { return o.serverId === 'x7'; }), false);
deepEq('sin instancias no hay nada que borrar',
  lifecycle.planOrphanCleanup([], servers, NOW, ON), []);
deepEq('con la base vacía todas las viejas son huérfanas',
  lifecycle.planOrphanCleanup(instances, {}, NOW, ON).map(function (o) { return o.serverId; }),
  ['s1', 'x9']);

if (failed) {
  console.error('\n' + failed + ' check(s) failed');
  process.exit(1);
}
console.log('\nAll CS2 lifecycle checks passed');
