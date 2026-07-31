#!/usr/bin/env node
'use strict';

/**
 * Comprueba la foto del roster que se guarda cuando el capitán acepta entrar a
 * un torneo (tournament-roster.js).
 *
 * Lo que se protege aquí: que entren TODOS los del roster y no solo el capitán,
 * que se detecte a quién le falta Steam (sin eso MatchZy no puede asignarlo a su
 * equipo) y que el resincronizado no pise la foto cuando nada ha cambiado ni lo
 * intente alguien que no es el capitán.
 *
 * Corre con un Firebase falso en memoria: sin emulador ni red.
 */

const path = require('path');

// El módulo es un IIFE de navegador; en Node el objeto global que recibe es
// module.exports, así que ahí es donde se cuelga el firebase de mentira.
const mod = require(path.join(__dirname, '..', 'tournament-roster.js'));
const SGTournamentRoster = mod.SGTournamentRoster;

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
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) ok(label);
  else fail(label, expected, actual);
}

// ── Firebase falso ─────────────────────────────────────────────────────────
const writes = [];
let data = {};

function valueAt(pathStr) {
  return pathStr.split('/').reduce(function (node, key) {
    return node && typeof node === 'object' ? node[key] : undefined;
  }, data);
}

function ref(pathStr) {
  return {
    once: function () {
      const val = valueAt(pathStr);
      return Promise.resolve({ val: function () { return val === undefined ? null : val; } });
    },
    set: function (value) {
      writes.push({ path: pathStr, value: value });
      return Promise.resolve();
    },
  };
}

mod.firebase = { database: function () { return { ref: ref }; } };

function seed() {
  writes.length = 0;
  data = {
    teams: {
      alpha: {
        name: 'Alpha Squad',
        captain: 'u1',
        roster: {
          u1: { role: 'Captain' },
          u2: { role: 'Member' },
          u3: { role: 'Member' },
        },
      },
    },
    users: {
      u1: { nick: 'Zeta', steamID: '76561190000000001' },
      u2: { nick: 'Alpha', steam: { steamid: '76561190000000002' } },
      // Sin Steam vinculado: tiene que salir contado aparte.
      u3: { nick: 'Nova' },
    },
    tournaments: { t1: {} },
  };
}

// ── snapshotFor ────────────────────────────────────────────────────────────
seed();
SGTournamentRoster.snapshotFor('alpha').then(function (snap) {
  eq('entra el roster completo, no solo el capitán', snap.size, 3);
  deepEq('uids del snapshot', snap.uids.slice().sort(), ['u1', 'u2', 'u3']);
  eq('nombre del equipo copiado', snap.name, 'Alpha Squad');
  eq('capitán copiado', snap.captain, 'u1');
  eq('cuenta de Steam vinculadas', snap.steamReady, 2);
  eq('steam por jugador (users/steamID)', snap.players.u1.steam, true);
  eq('steam por jugador (users/steam/steamid)', snap.players.u2.steam, true);
  eq('jugador sin Steam marcado', snap.players.u3.steam, false);
  eq('rol del capitán', snap.players.u1.role, 'Captain');
  eq('nick resuelto desde users/', snap.players.u3.nick, 'Nova');
  // El SteamID64 no se copia: este nodo lo lee cualquiera que vea el torneo.
  eq('no se filtra el SteamID64', JSON.stringify(snap).indexOf('76561190000000001'), -1);

  // Capitán primero, luego alfabético: así se pinta en la sala del torneo.
  const ordered = SGTournamentRoster.playersOf(snap).map(function (p) { return p.nick; });
  deepEq('orden de la lista de jugadores', ordered, ['Zeta', 'Alpha', 'Nova']);

  // Fotos viejas (solo uids) siguen listándose aunque sin nicks ni Steam.
  const legacy = SGTournamentRoster.playersOf({ uids: ['u9'], captain: 'u9' });
  eq('foto antigua sin players sigue dando jugadores', legacy.length, 1);
  eq('foto antigua marca al capitán', legacy[0].role, 'Captain');

  // ── registrationUpdates ─────────────────────────────────────────────────
  const updates = SGTournamentRoster.registrationUpdates('t1', 'alpha', snap);
  eq('marca el equipo como inscrito', updates['tournaments/t1/registeredTeams/alpha'], true);
  eq('guarda la foto del roster', updates['tournaments/t1/registeredRosters/alpha'], snap);

  // ── isStale ─────────────────────────────────────────────────────────────
  eq('foto idéntica no se reescribe', SGTournamentRoster.isStale(snap, snap), false);
  eq('sin foto previa hay que escribir', SGTournamentRoster.isStale(null, snap), true);
  const smaller = JSON.parse(JSON.stringify(snap));
  smaller.uids = ['u1', 'u2'];
  smaller.size = 2;
  eq('jugador que se fue del equipo invalida la foto',
    SGTournamentRoster.isStale(smaller, snap), true);
  const linked = JSON.parse(JSON.stringify(snap));
  linked.steamReady = 3;
  eq('alguien que vincula Steam invalida la foto',
    SGTournamentRoster.isStale(linked, snap), true);

  return runEnsure();
}).then(function () {
  if (failed) {
    console.error('\n' + failed + ' check(s) failed');
    process.exit(1);
  }
  console.log('\nAll tournament roster checks passed');
}).catch(function (err) {
  console.error('FAIL unexpected error', err);
  process.exit(1);
});

// ── ensureSnapshot ─────────────────────────────────────────────────────────
function runEnsure() {
  seed();
  // Quien no es capitán no puede escribir el nodo (database.rules.json), así
  // que ni se intenta.
  return SGTournamentRoster.ensureSnapshot('t1', 'alpha', 'u2').then(function (res) {
    eq('un miembro no reescribe la foto', res, null);
    eq('un miembro no escribe nada', writes.length, 0);
    return SGTournamentRoster.ensureSnapshot('t1', 'alpha', 'u1');
  }).then(function (res) {
    eq('el capitán rellena la foto que falta', !!res, true);
    eq('una sola escritura', writes.length, 1);
    eq('ruta de escritura', writes[0].path, 'tournaments/t1/registeredRosters/alpha');
    eq('la foto rellenada trae al equipo entero', writes[0].value.size, 3);

    // Ya guardada e igual: no debe volver a escribir en cada visita.
    data.tournaments.t1.registeredRosters = { alpha: writes[0].value };
    return SGTournamentRoster.ensureSnapshot('t1', 'alpha', 'u1');
  }).then(function (res) {
    eq('foto al día no se reescribe', res, null);
    eq('sigue habiendo una sola escritura', writes.length, 1);

    // Entra un jugador nuevo al equipo: la foto tiene que actualizarse.
    data.teams.alpha.roster.u4 = { role: 'Member' };
    data.users.u4 = { nick: 'Kilo', steamID: '76561190000000004' };
    return SGTournamentRoster.ensureSnapshot('t1', 'alpha', 'u1');
  }).then(function (res) {
    eq('fichaje nuevo actualiza la foto', res && res.size, 4);
    eq('el fichaje suma en Steam vinculadas', res && res.steamReady, 3);
  });
}
