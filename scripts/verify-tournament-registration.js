#!/usr/bin/env node
'use strict';

/**
 * Comprueba la inscripción de equipos en torneos
 * (functions/tournamentRegistration.js).
 *
 * Lo que se protege aquí es todo lo que antes no comprobaba nadie, porque el
 * capitán escribía directo en la base:
 *   - que haya invitación de verdad;
 *   - que el torneo siga admitiendo equipos;
 *   - que el roster llegue al tamaño que pide el torneo;
 *   - que la última plaza no se la queden dos equipos a la vez;
 *   - que la cuota se cobre, y que si no hay saldo se devuelva la plaza;
 *   - que la foto del roster la escriba el servidor y no llegue inventada.
 *
 * Corre con un Firebase falso en memoria: sin emulador ni red.
 */

const path = require('path');
const Module = require('module');

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

/** Espera que la llamada reviente con ese código de error. */
async function rejects(label, promise, code) {
  try {
    await promise;
    fail(label, 'error ' + code, 'sin error');
  } catch (err) {
    if (err && err.code === code) ok(label);
    else fail(label, code, (err && err.code) || String(err));
  }
}

// ── Firebase falso ─────────────────────────────────────────────────────────

let data = {};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function valueAt(pathStr) {
  return pathStr.split('/').filter(Boolean).reduce(function (node, key) {
    return node && typeof node === 'object' ? node[key] : undefined;
  }, data);
}

function setAt(pathStr, value) {
  const parts = pathStr.split('/').filter(Boolean);
  if (!parts.length) return;
  let node = data;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  if (value === null) delete node[leaf];
  // Incremento del servidor: el valor llega como marcador, no como número.
  else if (value && typeof value === 'object' && value.__increment !== undefined) {
    node[leaf] = Number(node[leaf] || 0) + value.__increment;
  } else node[leaf] = value;
}

function snapshotOf(pathStr) {
  const val = valueAt(pathStr);
  return {
    val: function () { return val === undefined ? null : clone(val); },
    exists: function () { return val !== undefined && val !== null; },
  };
}

/** Enganche para simular que alguien más escribe justo antes de la transacción. */
let beforeTransaction = null;

function ref(pathStr) {
  const clean = String(pathStr || '').replace(/^\/+|\/+$/g, '');
  return {
    once: function () { return Promise.resolve(snapshotOf(clean)); },
    set: function (value) { setAt(clean, value); return Promise.resolve(); },
    remove: function () { setAt(clean, null); return Promise.resolve(); },
    update: function (updates) {
      Object.keys(updates).forEach(function (key) {
        setAt(clean ? clean + '/' + key : key, updates[key]);
      });
      return Promise.resolve();
    },
    transaction: function (fn) {
      if (beforeTransaction) { beforeTransaction(); beforeTransaction = null; }
      const current = clone(valueAt(clean));
      const next = fn(current === undefined ? null : current);
      const committed = next !== undefined;
      if (committed) setAt(clean, next);
      return Promise.resolve({
        committed: committed,
        snapshot: { val: function () { return committed ? clone(next) : clone(valueAt(clean)) || null; } },
      });
    },
  };
}

function HttpsError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.message = message;
  return err;
}

const fakeFunctions = {
  https: {
    // onCall devuelve el handler tal cual para poder invocarlo directo.
    onCall: function (handler) { return handler; },
    HttpsError: HttpsError,
  },
};

const fakeAdmin = {
  database: Object.assign(function () { return { ref: ref }; }, {
    ServerValue: {
      TIMESTAMP: 1700000000000,
      increment: function (delta) { return { __increment: delta }; },
    },
  }),
};

const stubs = { 'firebase-functions': fakeFunctions, 'firebase-admin': fakeAdmin };
const origLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};

const registration = require(path.join(__dirname, '..', 'functions', 'tournamentRegistration.js'));
const accept = registration.acceptTournamentRegistration;
const decline = registration.declineTournamentInviteAsCaptain;
const resync = registration.resyncTournamentRoster;

const CAPTAIN = { auth: { uid: 'u1' } };
const MEMBER = { auth: { uid: 'u2' } };
const ARGS = { teamId: 'alpha', tournamentId: 't1' };

function seed(overrides) {
  data = {
    teams: {
      alpha: {
        name: 'Alpha Squad',
        captain: 'u1',
        roster: { u1: { role: 'Captain' }, u2: {}, u3: {}, u4: {}, u5: {} },
      },
      bravo: { name: 'Bravo', captain: 'u9', roster: { u9: {} } },
    },
    users: {
      u1: { nick: 'Zeta', tokens: 500, steamID: '76561190000000001' },
      u2: { nick: 'Alpha', steam: { steamid: '76561190000000002' } },
      u3: { nick: 'Nova' },
      u4: { nick: 'Kilo', steamID: '76561190000000004' },
      u5: { nick: 'Delta', steamID: '76561190000000005' },
    },
    tournaments: {
      t1: {
        name: 'Copa Studios',
        status: 'pendiente',
        playersPerTeam: 5,
        maxTeams: 4,
        entryFee: 100,
        prizes: { entryFee: 100, collectedTokens: 0 },
        teams: { max: 4, registered: 0 },
        registeredTeams: {},
      },
    },
    tournamentInvites: { alpha: { t1: { tournamentName: 'Copa Studios' } } },
  };
  if (overrides) overrides(data);
}

async function run() {
  // ── Permisos y requisitos previos ────────────────────────────────────────
  seed();
  await rejects('sin sesión no se inscribe', accept(ARGS, {}), 'unauthenticated');
  await rejects('faltan datos', accept({ teamId: 'alpha' }, CAPTAIN), 'invalid-argument');
  await rejects('un miembro no inscribe al equipo', accept(ARGS, MEMBER), 'permission-denied');
  await rejects('equipo inexistente',
    accept({ teamId: 'zzz', tournamentId: 't1' }, CAPTAIN), 'not-found');
  await rejects('torneo inexistente',
    accept({ teamId: 'alpha', tournamentId: 'zzz' }, CAPTAIN), 'not-found');

  seed(function (d) { delete d.tournamentInvites.alpha; });
  await rejects('sin invitación no se entra', accept(ARGS, CAPTAIN), 'failed-precondition');

  seed(function (d) { d.tournaments.t1.status = 'en_vivo'; });
  await rejects('torneo en vivo no admite equipos', accept(ARGS, CAPTAIN), 'failed-precondition');

  seed(function (d) { d.tournaments.t1.status = 'finalizado'; });
  await rejects('torneo finalizado no admite equipos', accept(ARGS, CAPTAIN), 'failed-precondition');

  seed(function (d) { delete d.teams.alpha.roster.u4; delete d.teams.alpha.roster.u5; });
  await rejects('roster corto para un 5v5', accept(ARGS, CAPTAIN), 'failed-precondition');

  seed(function (d) { d.tournaments.t1.registeredTeams = { alpha: true }; });
  await rejects('no se inscribe dos veces', accept(ARGS, CAPTAIN), 'already-exists');

  seed(function (d) {
    d.tournaments.t1.registeredTeams = { b: true, c: true, d: true, e: true };
  });
  await rejects('torneo lleno', accept(ARGS, CAPTAIN), 'resource-exhausted');

  // ── Cupo: la última plaza es de uno solo ─────────────────────────────────
  seed(function (d) { d.tournaments.t1.registeredTeams = { b: true, c: true, d: true }; });
  // Otro capitán se queda con la plaza justo antes de que corra la transacción.
  beforeTransaction = function () { data.tournaments.t1.registeredTeams.e = true; };
  await rejects('dos equipos no comparten la última plaza', accept(ARGS, CAPTAIN), 'resource-exhausted');
  eq('el equipo que llegó tarde no queda inscrito',
    !!(data.tournaments.t1.registeredTeams || {}).alpha, false);

  // ── Cuota ────────────────────────────────────────────────────────────────
  seed(function (d) { d.users.u1.tokens = 30; });
  await rejects('sin saldo no hay inscripción', accept(ARGS, CAPTAIN), 'failed-precondition');
  eq('la plaza se devuelve si el cobro falla',
    !!(data.tournaments.t1.registeredTeams || {}).alpha, false);
  eq('no se toca el saldo cuando el cobro falla', data.users.u1.tokens, 30);
  eq('la invitación sigue en pie tras fallar el cobro',
    !!(data.tournamentInvites.alpha || {}).t1, true);

  // ── Inscripción correcta ─────────────────────────────────────────────────
  seed();
  const res = await accept(ARGS, CAPTAIN);
  const t = data.tournaments.t1;
  eq('el equipo queda inscrito', t.registeredTeams.alpha, true);
  eq('se cobró la cuota', data.users.u1.tokens, 400);
  eq('la respuesta dice lo que se cobró', res.entryFeePaid, 100);
  eq('el recaudado sube', t.prizes.collectedTokens, 100);
  eq('el contador de equipos se mantiene', t.teams.registered, 1);
  eq('la foto del roster la escribe el servidor', t.registeredRosters.alpha.size, 5);
  eq('cuenta bien los Steam vinculados', t.registeredRosters.alpha.steamReady, 4);
  eq('avisa de los que faltan por vincular', res.steamPending, 1);
  eq('no se filtra el SteamID64 en la foto',
    JSON.stringify(t.registeredRosters.alpha).indexOf('76561190000000001'), -1);
  eq('la invitación desaparece', (data.tournamentInvites.alpha || {}).t1, undefined);
  eq('desaparece también del panel del Commander', (t.outboundInvites || {}).alpha, undefined);
  eq('queda el registro para avisar al roster',
    data.tournamentRegistrations.alpha.t1.tournamentName, 'Copa Studios');
  eq('el registro guarda lo pagado', data.tournamentRegistrations.alpha.t1.entryFeePaid, 100);

  // ── Torneo gratuito ──────────────────────────────────────────────────────
  seed(function (d) {
    d.tournaments.t1.entryFee = 0;
    d.tournaments.t1.prizes.entryFee = 0;
    d.users.u1.tokens = 0;
  });
  const free = await accept(ARGS, CAPTAIN);
  eq('sin cuota se entra con saldo cero', free.entryFeePaid, 0);
  eq('no se descuenta nada', data.users.u1.tokens, 0);

  // ── Tamaño exigido por la modalidad ──────────────────────────────────────
  seed(function (d) {
    delete d.tournaments.t1.playersPerTeam;
    d.tournaments.t1.modality = '2v2';
    d.teams.alpha.roster = { u1: { role: 'Captain' }, u2: {} };
  });
  const small = await accept(ARGS, CAPTAIN);
  eq('un 2v2 acepta dos jugadores', small.size, 2);

  // ── Rechazar ─────────────────────────────────────────────────────────────
  seed(function (d) { d.tournaments.t1.outboundInvites = { alpha: { teamId: 'alpha' } }; });
  await rejects('un miembro no rechaza por el equipo', decline(ARGS, MEMBER), 'permission-denied');
  await decline(ARGS, CAPTAIN);
  eq('rechazar borra la invitación', (data.tournamentInvites.alpha || {}).t1, undefined);
  eq('rechazar la borra también del panel del Commander',
    (data.tournaments.t1.outboundInvites || {}).alpha, undefined);

  // ── Resincronizar la foto ────────────────────────────────────────────────
  seed(function (d) { d.tournaments.t1.registeredTeams = { alpha: true }; });
  await rejects('un miembro no resincroniza', resync(ARGS, MEMBER), 'permission-denied');
  seed();
  await rejects('no se resincroniza un equipo que no está inscrito',
    resync(ARGS, CAPTAIN), 'failed-precondition');
  seed(function (d) { d.tournaments.t1.registeredTeams = { alpha: true }; });
  const again = await resync(ARGS, CAPTAIN);
  eq('el resincronizado rehace la foto entera', again.size, 5);
  deepEq('la foto guardada trae a los cinco',
    Object.keys(data.tournaments.t1.registeredRosters.alpha.players).sort(),
    ['u1', 'u2', 'u3', 'u4', 'u5']);
}

run().then(function () {
  Module._load = origLoad;
  if (failed) {
    console.error('\n' + failed + ' check(s) failed');
    process.exit(1);
  }
  console.log('\nAll tournament registration checks passed');
}).catch(function (err) {
  Module._load = origLoad;
  console.error('FAIL unexpected error', err);
  process.exit(1);
});
