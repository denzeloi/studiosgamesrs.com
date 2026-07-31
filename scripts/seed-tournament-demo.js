#!/usr/bin/env node
'use strict';

/**
 * Seeds a 4-team demo tournament so tournament-details can be validated
 * without a full matchday. Writes under tournaments/demo-player-flow by default.
 *
 * Dos modos, porque un campeonato se puede correr de dos maneras:
 *   --mode=single (por defecto) un servidor, una partida viva, el resto en cola
 *   --mode=dual                 dos servidores, dos cruces en vivo a la vez
 *
 * Usage:
 *   node scripts/seed-tournament-demo.js --dry-run
 *   node scripts/seed-tournament-demo.js --mode=dual
 *   node scripts/seed-tournament-demo.js --mode=dual --id=demo-dual
 *   node scripts/seed-tournament-demo.js --out=tmp-seed   (JSON por ruta, sin escribir)
 *
 * Real writes need Application Default Credentials (or GOOGLE_APPLICATION_CREDENTIALS)
 * for project studiosgamesrs. Si no las hay, --out deja el payload en disco para
 * empujarlo con la CLI de Firebase, que se autentica con la cuenta del navegador:
 *   firebase database:update /tournaments/<id> tmp-seed/tournament.json
 */

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const NOW = Date.now();

function argValue(name, fallback) {
  const hit = process.argv.find(function (a) { return a.indexOf('--' + name + '=') === 0; });
  return hit ? hit.slice(name.length + 3) : fallback;
}

const MODE = String(argValue('mode', 'single')).toLowerCase() === 'dual' ? 'dual' : 'single';
const TID = argValue('id', 'demo-player-flow');
const OUT_DIR = argValue('out', null);

const TEAMS = [
  { id: 'demo-team-alpha', name: 'Alpha Squad', captain: 'demo-uid-a1' },
  { id: 'demo-team-bravo', name: 'Bravo Force', captain: 'demo-uid-b1' },
  { id: 'demo-team-charlie', name: 'Charlie Unit', captain: 'demo-uid-c1' },
  { id: 'demo-team-delta', name: 'Delta Core', captain: 'demo-uid-d1' },
];

function roster(captain, suffix) {
  const uids = {};
  for (var i = 1; i <= 5; i += 1) {
    uids['demo-uid-' + suffix + i] = { role: 'demo-uid-' + suffix + i === captain ? 'Captain' : 'Member' };
  }
  uids[captain] = { role: 'Captain' };
  return uids;
}

/** Misma forma que escribe tournament-roster.js al aceptar la invitación. */
function rosterSnapshot(team, members) {
  const uids = Object.keys(members);
  const players = {};
  let steamReady = 0;
  uids.forEach(function (uid, i) {
    // Un jugador por equipo se deja sin Steam para ver el aviso en la interfaz.
    const linked = i !== uids.length - 1;
    if (linked) steamReady += 1;
    players[uid] = {
      nick: uid.replace('demo-uid-', '').toUpperCase(),
      role: uid === team.captain ? 'Captain' : 'Member',
      steam: linked,
    };
  });
  return {
    name: team.name,
    emblem: null,
    captain: team.captain,
    uids: uids,
    size: uids.length,
    steamReady: steamReady,
    players: players,
    updatedAt: NOW,
  };
}

const MATCH_ONE = {
  matchId: 'r1_m1',
  map: 'de_mirage',
  serverId: 'demo-server-1',
  serverIp: '203.0.113.10',
  startingSide: 'team1_ct',
  startedAt: NOW - 12 * 60 * 1000,
  durationSeconds: 720,
  currentRound: 13,
  scoreCT: 7,
  scoreT: 5,
  sideByTeam: { 'demo-team-alpha': 'CT', 'demo-team-bravo': 'T' },
  team1Side: 'CT',
  team2Side: 'T',
  kills: { Ace: 14, Brick: 11, Ghost: 9, Nova: 8, Pulse: 6 },
};

const MATCH_TWO = {
  matchId: 'r1_m2',
  map: 'de_inferno',
  serverId: 'demo-server-2',
  serverIp: '203.0.113.11',
  startingSide: 'team1_t',
  startedAt: NOW - 9 * 60 * 1000,
  durationSeconds: 540,
  currentRound: 11,
  scoreCT: 4,
  scoreT: 6,
  sideByTeam: { 'demo-team-charlie': 'T', 'demo-team-delta': 'CT' },
  team1Side: 'T',
  team2Side: 'CT',
  kills: { Ember: 12, Frost: 10, Volt: 9, Shade: 7, Orbit: 5 },
};

function liveMatchEntry(m) {
  return {
    status: 'live',
    serverId: m.serverId,
    serverIp: m.serverIp,
    serverPort: 27015,
    map: m.map,
    startingSide: m.startingSide,
    startedAt: m.startedAt,
    scoreCT: m.scoreCT,
    scoreT: m.scoreT,
    currentRound: m.currentRound,
    durationSeconds: m.durationSeconds,
    sideByTeam: m.sideByTeam,
    rconOk: true,
  };
}

function livePayload(m) {
  return {
    status: 'live',
    tournamentId: TID,
    map: m.map,
    startingSide: m.startingSide,
    serverIp: m.serverIp,
    serverPort: 27015,
    serverId: m.serverId,
    startedAt: m.startedAt,
    durationSeconds: m.durationSeconds,
    currentRound: m.currentRound,
    scoreCT: m.scoreCT,
    scoreT: m.scoreT,
    sideByTeam: m.sideByTeam,
    team1Side: m.team1Side,
    team2Side: m.team2Side,
    kills: m.kills,
    updatedAt: NOW,
  };
}

function buildPayload() {
  const dual = MODE === 'dual';
  const registeredTeams = {};
  const registeredRosters = {};
  const teams = {};

  TEAMS.forEach(function (t, idx) {
    const suffix = String.fromCharCode(97 + idx);
    const members = roster(t.captain, suffix);
    registeredTeams[t.id] = true;
    registeredRosters[t.id] = rosterSnapshot(t, members);
    teams[t.id] = {
      name: t.name,
      captain: t.captain,
      roster: members,
      game: 'cs2',
      demo: true,
    };
  });

  const bracket = {
    rounds: 2,
    bracketSize: 4,
    currentMatchId: 'r1_m1',
    matches: {
      r1_m1: {
        id: 'r1_m1',
        round: 1,
        status: 'live',
        teamA: { teamId: TEAMS[0].id, seed: 1 },
        teamB: { teamId: TEAMS[1].id, seed: 4 },
        nextMatchId: 'r2_m1',
        nextSlot: 'teamA',
        map: MATCH_ONE.map,
        scheduledAt: NOW - 5 * 60 * 1000,
      },
      r1_m2: {
        id: 'r1_m2',
        round: 1,
        // En modo servidor único el segundo cruce espera turno: así se ve en el
        // cuadro la cola real, no dos "EN VIVO" que nunca van a existir.
        status: dual ? 'live' : 'pending',
        teamA: { teamId: TEAMS[2].id, seed: 2 },
        teamB: { teamId: TEAMS[3].id, seed: 3 },
        nextMatchId: 'r2_m1',
        nextSlot: 'teamB',
        map: MATCH_TWO.map,
        scheduledAt: dual ? NOW - 5 * 60 * 1000 : NOW + 25 * 60 * 1000,
      },
      r2_m1: {
        id: 'r2_m1',
        round: 2,
        status: 'pending',
        teamA: { teamId: null },
        teamB: { teamId: null },
        map: null,
        scheduledAt: NOW + 45 * 60 * 1000,
      },
    },
  };

  const liveMatches = { r1_m1: liveMatchEntry(MATCH_ONE) };
  const live = { r1_m1: livePayload(MATCH_ONE) };
  if (dual) {
    liveMatches.r1_m2 = liveMatchEntry(MATCH_TWO);
    live.r1_m2 = livePayload(MATCH_TWO);
  }

  const tournament = {
    name: 'Demo Player Flow (4 teams, ' + (dual ? 'dos servidores' : 'servidor único') + ')',
    game: 'cs2',
    status: 'en_vivo',
    format: 'SingleElim',
    region: 'LATAM',
    schedule: NOW - 10 * 60 * 1000,
    maxTeams: 4,
    prizePool: 5000,
    prizes: {
      tokenPool: 5000,
      entryFee: 0,
      mvpTokens: 250,
      cashCurrency: 'USD',
      updatedAt: NOW,
      notes: 'Torneo demo para validar look en vivo.',
    },
    serverMode: MODE,
    registeredTeams: registeredTeams,
    registeredRosters: registeredRosters,
    bracket: bracket,
    currentMatchId: 'r1_m1',
    activeMatchId: 'r1_m1',
    activeMap: MATCH_ONE.map,
    activeServerId: MATCH_ONE.serverId,
    serverIp: MATCH_ONE.serverIp,
    serverPort: 27015,
    liveMatches: liveMatches,
    demo: true,
    createdAt: NOW,
    updatedAt: NOW,
  };

  return { tournament: tournament, teams: teams, live: live };
}

async function writeLive(admin, payload) {
  const db = admin.database();
  const updates = {};
  updates['tournaments/' + TID] = payload.tournament;
  Object.keys(payload.teams).forEach(function (id) {
    updates['teams/' + id] = payload.teams[id];
  });
  // El modo único deja limpio lo que sembró el modo dual, si no el marcador
  // seguiría mostrando una segunda partida que ya no existe en el torneo.
  ['r1_m1', 'r1_m2'].forEach(function (mid) {
    updates['partida_en_vivo/' + mid] = payload.live[mid] || null;
  });
  await db.ref().update(updates);
}

/**
 * Deja el payload en disco, un archivo por ruta de la base. Sirve para dos
 * cosas: empujarlo con la CLI de Firebase cuando no hay credenciales de
 * aplicación, y alimentar la vista previa local sin tocar producción.
 */
function emitFiles(payload) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  function write(name, value) {
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    files.push(file);
  }
  write('tournament.json', payload.tournament);
  Object.keys(payload.teams).forEach(function (id) {
    write('team-' + id + '.json', payload.teams[id]);
  });
  ['r1_m1', 'r1_m2'].forEach(function (mid) {
    if (payload.live[mid]) write('live-' + mid + '.json', payload.live[mid]);
  });
  write('all.json', {
    tournamentId: TID,
    mode: MODE,
    tournament: payload.tournament,
    teams: payload.teams,
    live: payload.live,
  });
  console.log('[seed-tournament-demo] escritos ' + files.length + ' archivo(s) en ' + OUT_DIR);
}

async function main() {
  const payload = buildPayload();
  console.log('[seed-tournament-demo] tournamentId =', TID, '· modo =', MODE);
  console.log('[seed-tournament-demo] open /tournament-details?id=' + TID);

  if (OUT_DIR) {
    emitFiles(payload);
    return;
  }

  if (DRY) {
    console.log('[seed-tournament-demo] dry-run — payload summary:');
    console.log(JSON.stringify({
      mode: MODE,
      serverMode: payload.tournament.serverMode,
      teams: Object.keys(payload.teams),
      registered: Object.keys(payload.tournament.registeredTeams),
      liveMatches: Object.keys(payload.tournament.liveMatches),
      partida_en_vivo: Object.keys(payload.live),
      bracket: Object.keys(payload.tournament.bracket.matches).map(function (mid) {
        return mid + ':' + payload.tournament.bracket.matches[mid].status;
      }),
    }, null, 2));
    return;
  }

  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'studiosgamesrs';
  process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({
    projectId: 'studiosgamesrs',
    databaseURL: 'https://studiosgamesrs-default-rtdb.firebaseio.com',
  });

  const admin = require(path.join(__dirname, '..', 'functions', 'cs2-nexus', 'node_modules', 'firebase-admin'));
  if (!admin.apps.length) {
    admin.initializeApp({
      databaseURL: 'https://studiosgamesrs-default-rtdb.firebaseio.com',
    });
  }

  await writeLive(admin, payload);
  console.log('[seed-tournament-demo] wrote demo tournament + ' +
    Object.keys(payload.live).length + ' live match(es) en modo ' + MODE + '.');
}

main().catch(function (err) {
  console.error('[seed-tournament-demo] failed:', err && err.message ? err.message : err);
  process.exit(1);
});
