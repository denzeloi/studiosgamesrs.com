#!/usr/bin/env node
'use strict';

/**
 * Comprobación del tablero en vivo de la sala del torneo, de punta a punta y
 * sin tocar Firebase.
 *
 * Cubre las dos mitades del mismo camino: lo que el puente publica cuando
 * NexusBridge avisa de una conexión o de una baja, y lo que td-live-board.js
 * pinta con ese parte. Se cargan los módulos de verdad y solo se sustituyen sus
 * escrituras por grabadoras, así que lo que se prueba es el acuerdo entre los
 * dos lados, que es justo donde se rompe.
 */

const path = require('path');
const fs = require('fs');

// Deja que firebase-admin arranque sin red ni credenciales: firebase-rtdb.js
// llama a admin.database() al cargarse y solo necesita una databaseURL.
process.env.FIREBASE_CONFIG = JSON.stringify({
  databaseURL: 'https://verify-only.firebaseio.com',
  projectId: 'verify-only',
});
process.env.GCLOUD_PROJECT = 'verify-only';

const rootDir = path.join(__dirname, '..');
const libDir = path.join(rootDir, 'functions', 'cs2-nexus', 'lib');
const rtdb = require(path.join(libDir, 'firebase-rtdb.js'));
const matchzy = require(path.join(libDir, 'matchzy.js'));
const stats = require(path.join(libDir, 'match-stats.js'));
const webhook = require(path.join(libDir, 'webhook.js'));

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

function truthy(label, value) {
  if (value) ok(label);
  else {
    console.error('FAIL', label, '— esperaba algo cierto y llegó', JSON.stringify(value));
    failed += 1;
  }
}

function falsy(label, value) {
  if (!value) ok(label);
  else {
    console.error('FAIL', label, '— esperaba algo falso y llegó', JSON.stringify(value));
    failed += 1;
  }
}

/* ————————————————————— Puente ————————————————————— */

const ALPHA = ['76561190000000001', '76561190000000002'];
const BRAVO = ['76561190000000011', '76561190000000012'];

const STEAM_MAP = {};
STEAM_MAP[ALPHA[0]] = 'uid-a1';
STEAM_MAP[ALPHA[1]] = 'uid-a2';
STEAM_MAP[BRAVO[0]] = 'uid-b1';
// BRAVO[1] no vinculó Steam: sale en la tabla y no cobra.

const STORED_CONFIG = {
  map_sides: ['team1_ct'],
  team1: { id: 'team-alpha', name: 'Alpha', players: { [ALPHA[0]]: 'p0', [ALPHA[1]]: 'p1' } },
  team2: { id: 'team-bravo', name: 'Bravo', players: { [BRAVO[0]]: 'p0', [BRAVO[1]]: 'p1' } },
};

const recorded = { live: [], liveMatches: [], tournaments: [] };

rtdb.writeMatchLive = async function (tournamentId, matchId, data) {
  recorded.live.push(data);
};
rtdb.writeTournamentLiveMatch = async function (tournamentId, matchId, data) {
  recorded.liveMatches.push(data);
};
rtdb.writeTournament = async function (tournamentId, data) {
  recorded.tournaments.push(data);
};
matchzy.getStoredMatchConfig = async function () {
  return STORED_CONFIG;
};
stats.getSteamMap = async function () {
  return STEAM_MAP;
};

function lastLive() {
  return recorded.live[recorded.live.length - 1];
}

function livePlayers(kills, deaths) {
  const players = {};
  players[ALPHA[0]] = { name: 'Carry', side: 'CT', bot: false, kills: kills, deaths: deaths, assists: 2, damage: 700, roundMvps: 1 };
  players[BRAVO[0]] = { name: 'Anon', side: 'T', bot: false, kills: 3, deaths: 5, assists: 1, damage: 320, roundMvps: 0 };
  players['bot:Wolf'] = { name: 'Wolf', side: 'T', bot: true, kills: 0, deaths: 1, assists: 0, damage: 40, roundMvps: 0 };
  return players;
}

async function runBridge() {
  console.log('\n--- lobby: quién está dentro antes de que arranque ---');
  recorded.live = [];
  await webhook.processMatchEvent({
    event: 'lobby',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    phase: 'warmup',
    connected: [
      { steamId: ALPHA[0], name: 'Carry', side: 'CT', bot: false },
      { steamId: BRAVO[0], name: 'Anon', side: 'T', bot: false },
      { steamId: null, name: 'Wolf', side: 'T', bot: true },
      { steamId: ALPHA[1], name: 'Tarde', side: 'SPEC', bot: false },
      { steamId: '76561190000000099', name: 'Mirón', side: 'SPEC', bot: false },
    ],
  });

  const lobby = lastLive().lobby;
  eq('el parte de sala solo cuenta a los del cruce', lobby.count, 4);
  eq('uno en CT', lobby.ct, 1);
  eq('dos en T', lobby.t, 2);
  eq('la fase queda en calentamiento', lastLive().phase, 'warmup');

  const carry = lobby.players.find(function (p) { return p.name === 'Carry'; });
  eq('el jugador vinculado llega con su cuenta de Nexus', carry.uid, 'uid-a1');
  // partida_en_vivo lo lee cualquiera sin identificarse: ahí no puede acabar
  // el SteamID64 de nadie.
  falsy('no se publica el SteamID64', 'steamId' in carry);
  eq('el bando viaja para poder partir la tabla', carry.side, 'CT');

  const bot = lobby.players.find(function (p) { return p.name === 'Wolf'; });
  eq('al bot no se le asigna cuenta', bot.uid, null);
  eq('y queda marcado como bot', bot.bot, true);

  const spec = lobby.players.find(function (p) { return p.name === 'Tarde'; });
  eq('el que aún no eligió equipo sigue en la lista', spec.uid, 'uid-a2');
  eq('y se publica sin bando', spec.side, null);

  // La IP del servidor circula: cualquiera puede entrar a mirar y no tiene por
  // qué salir en el tablero del torneo.
  falsy(
    'el que no está inscrito no aparece',
    lobby.players.some(function (p) { return p.name === 'Mirón'; })
  );
  eq('pero al organizador se le dice que hay gente de fuera', lobby.intruders, 1);

  // Sin plantilla resuelta no se puede juzgar a nadie, y dejar la sala vacía
  // sería peor que enseñar a quien está dentro.
  const openLobby = stats.buildLobby(
    [{ steamId: '76561190000000099', name: 'Mirón', side: 'CT', bot: false }],
    {}
  );
  eq('sin plantilla conocida no se descarta a nadie', openLobby.count, 1);

  console.log('\n--- kill: la tabla y el feed se mueven en cada baja ---');
  recorded.live = [];
  const feed = [];
  for (let i = 0; i < 12; i += 1) {
    feed.push({ at: 1000 + i, killer: 'Carry', killerSide: 'CT', victim: 'Anon', victimSide: 'T', weapon: 'ak47', headshot: i % 2 === 0 });
  }
  await webhook.processMatchEvent({
    event: 'kill',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    phase: 'live',
    killer: 'Carry',
    killerSteamId: ALPHA[0],
    kills: { Carry: 9, Anon: 3 },
    players: livePlayers(9, 4),
    recentKills: feed,
    scoreCT: 5,
    scoreT: 3,
    roundsPlayed: 8,
  });

  const live = lastLive();
  eq('el feed se recorta antes de publicarlo', live.recentKills.length, 8);
  eq('y conserva las últimas por orden', live.recentKills[0].at, 1000);
  eq('el marcador viaja con la baja', live.scoreCT, 5);
  eq('la fase pasa a en juego', live.phase, 'live');
  eq('la tabla se rehace sin esperar al fin de ronda', live.scoreboard.length, 3);

  const rowCarry = live.scoreboard.find(function (r) { return r.name === 'Carry'; });
  eq('cada fila dice su bando', rowCarry.side, 'CT');
  eq('y su cuenta de Nexus', rowCarry.uid, 'uid-a1');
  falsy('la fila no arrastra el SteamID64', 'steamId' in rowCarry);

  const rowBot = live.scoreboard.find(function (r) { return r.name === 'Wolf'; });
  eq('el bot entra en la tabla', rowBot.bot, true);
  eq('sin cuenta a la que pagar', rowBot.uid, null);

  console.log('\n--- match_start: no se hereda el tablero de la partida anterior ---');
  recorded.live = [];
  await webhook.processMatchEvent({
    event: 'match_start',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    pluginVersion: '1.2.0',
  });
  const started = lastLive();
  eq('el feed arranca vacío', started.recentKills.length, 0);
  eq('la tabla anterior se borra', started.scoreboard, null);
  eq('y el MVP también', started.mvp, null);
  eq('se arranca en calentamiento', started.phase, 'warmup');

  console.log('\n--- round_end: sigue publicando la tabla completa ---');
  recorded.live = [];
  await webhook.processMatchEvent({
    event: 'round_end',
    tournamentId: 't-001',
    matchId: 'r1_m1',
    round: 8,
    scoreCT: 5,
    scoreT: 3,
    ctSteamIds: ALPHA,
    tSteamIds: BRAVO,
    durationSeconds: 600,
    kills: { Carry: 9 },
    players: livePlayers(9, 4),
  });
  const round = lastLive();
  eq('la ronda queda publicada', round.currentRound, 8);
  eq('con los bandos resueltos', round.sideByTeam['team-alpha'], 'CT');
  eq('y la fase en juego', round.phase, 'live');
}

/* ————————————————————— Tablero ————————————————————— */

/**
 * DOM mínimo: el tablero solo lee elementos por id y les escribe innerHTML,
 * texto y clases. Con esto se puede comprobar lo que pinta sin arrastrar un
 * navegador entero a la comprobación.
 */
function makeDom(ids) {
  const nodes = {};
  ids.forEach(function (id) {
    const classes = new Set();
    nodes[id] = {
      id: id,
      innerHTML: '',
      textContent: '',
      hidden: false,
      style: {},
      attrs: {},
      classList: {
        toggle: function (name, on) {
          if (on) classes.add(name);
          else classes.delete(name);
        },
        contains: function (name) { return classes.has(name); },
      },
      setAttribute: function (key, value) { this.attrs[key] = value; },
      querySelectorAll: function () { return []; },
      addEventListener: function () {},
    };
  });

  global.window = global.window || {};
  global.document = {
    getElementById: function (id) { return nodes[id] || null; },
    querySelectorAll: function () { return []; },
  };
  return nodes;
}

function rowCount(html) {
  return (html.match(/<tr/g) || []).length;
}

function runBoard() {
  const dom = makeDom([
    'tdBoard', 'tdBoardCtBody', 'tdBoardTBody', 'tdBoardBench', 'tdLobbyCheck',
    'tdKillFeed', 'tdKillFeedEmpty', 'tdBoardPhase', 'tdRound', 'tdDuration',
    'tdScoreCt', 'tdScoreT', 'tdMvp',
  ]);

  delete require.cache[require.resolve(path.join(rootDir, 'td-live-board.js'))];
  require(path.join(rootDir, 'td-live-board.js'));
  const board = global.window.TDLiveBoard;
  truthy('td-live-board.js publica TDLiveBoard', !!board);

  console.log('\n--- tablero: calentamiento ---');
  board.render({
    currentUid: 'uid-a1',
    live: {
      status: 'live',
      phase: 'warmup',
      lobby: {
        count: 4,
        ct: 1,
        t: 2,
        players: [
          { uid: 'uid-a1', name: 'Carry', side: 'CT', bot: false },
          { uid: 'uid-b1', name: 'Anon', side: 'T', bot: false },
          { uid: null, name: 'Wolf', side: 'T', bot: true },
          { uid: 'uid-a2', name: 'Tarde', side: null, bot: false },
        ],
      },
    },
  });

  eq('el que ya entró ocupa su hueco en CT', rowCount(dom.tdBoardCtBody.innerHTML), 1);
  eq('y los dos de T el suyo', rowCount(dom.tdBoardTBody.innerHTML), 2);
  truthy('la fila se marca como pendiente de estadísticas', dom.tdBoardCtBody.innerHTML.indexOf('is-pending') !== -1);
  truthy('el jugador se reconoce a sí mismo', dom.tdBoardCtBody.innerHTML.indexOf('is-you') !== -1);
  truthy('el bot va etiquetado', dom.tdBoardTBody.innerHTML.indexOf('td-board-tag') !== -1);
  truthy('el pie cuenta a los conectados', dom.tdBoardPhase.innerHTML.indexOf('4 conectados') !== -1);
  truthy('el pie avisa de que es calentamiento', dom.tdBoardPhase.classList.contains('is-warmup'));
  eq('sin bajas el feed lo dice', dom.tdKillFeedEmpty.style.display, 'block');

  // Estar en espectadores no puede sacarte del tablero: es justo el rato en el
  // que uno mira la sala para comprobar que el servidor lo ve.
  falsy('el que no eligió equipo no desaparece', dom.tdBoardBench.hidden);
  truthy('y sale por su nombre', dom.tdBoardBench.innerHTML.indexOf('Tarde') !== -1);

  console.log('\n--- tablero: partida en juego ---');
  board.render({
    currentUid: 'uid-a1',
    live: {
      status: 'live',
      phase: 'live',
      currentRound: 8,
      scoreCT: 5,
      scoreT: 3,
      scoreboard: [
        { uid: 'uid-a1', name: 'Carry', side: 'CT', kills: 9, deaths: 4, assists: 2, kd: 2.25, score: 41 },
        { uid: 'uid-b1', name: 'Anon', side: 'T', kills: 3, deaths: 9, assists: 1, kd: 0.33, score: 7 },
      ],
      recentKills: [
        { at: 20, killer: 'Carry', killerSide: 'CT', victim: 'Anon', victimSide: 'T', weapon: 'weapon_ak47', headshot: true },
        { at: 10, killer: null, victim: 'Wolf', victimSide: 'T', weapon: 'world', headshot: false },
      ],
    },
  });

  eq('el marcador de CT sale del parte', dom.tdScoreCt.textContent, 5);
  eq('y el de T también', dom.tdScoreT.textContent, 3);
  eq('la ronda se lee en el pie', dom.tdRound.textContent, 'Ronda 8');
  truthy('el pie ya no dice calentamiento', dom.tdBoardPhase.classList.contains('is-live'));
  truthy('la diferencia positiva se marca', dom.tdBoardCtBody.innerHTML.indexOf('>+5<') !== -1);
  truthy('la negativa también', dom.tdBoardTBody.innerHTML.indexOf('>-6<') !== -1);
  truthy('el K/D sale con dos decimales', dom.tdBoardCtBody.innerHTML.indexOf('>2.25<') !== -1);
  truthy('el feed nombra el arma', dom.tdKillFeed.innerHTML.indexOf('[AK47]') !== -1);
  truthy('marca el headshot', dom.tdKillFeed.innerHTML.indexOf('td-kf-hs') !== -1);
  truthy('colorea al atacante por su bando', dom.tdKillFeed.innerHTML.indexOf('td-kf-ct') !== -1);
  truthy('una muerte sin atacante se atribuye al mundo', dom.tdKillFeed.innerHTML.indexOf('Mundo') !== -1);
  eq('con bajas se esconde el aviso de feed vacío', dom.tdKillFeedEmpty.style.display, 'none');

  console.log('\n--- tablero: casos que rompían ---');
  // Build antiguo del plugin: sin bando no se puede partir la tabla, y repartir
  // a ojo etiqueta a media plantilla en el equipo contrario.
  board.render({
    live: {
      status: 'live',
      scoreboard: [
        { uid: 'u1', name: 'Carry', kills: 4, deaths: 1, score: 20 },
        { uid: 'u2', name: 'Anon', kills: 1, deaths: 4, score: 5 },
      ],
    },
  });
  truthy('sin bandos el tablero se enseña de una pieza', dom.tdBoard.classList.contains('is-unsided'));
  eq('con todos los jugadores', rowCount(dom.tdBoardCtBody.innerHTML), 2);
  truthy('y sin repetirlos en la lista de espera', dom.tdBoardBench.hidden);

  board.render({
    live: {
      status: 'live',
      scoreboard: [{ uid: 'u1', name: '<img src=x onerror=alert(1)>', side: 'CT', kills: 1, deaths: 0, score: 3 }],
      recentKills: [{ at: 1, killer: '<b>hack</b>', killerSide: 'CT', victim: 'Anon', victimSide: 'T', weapon: '<i>x</i>' }],
    },
  });
  falsy('un nombre con etiquetas no se inyecta en la tabla', dom.tdBoardCtBody.innerHTML.indexOf('<img') !== -1);
  falsy('ni en el feed', dom.tdKillFeed.innerHTML.indexOf('<b>hack</b>') !== -1);

  board.clear();
  eq('al vaciar el tablero el marcador vuelve a cero', dom.tdScoreCt.textContent, '0');
  truthy('y las tablas explican por qué están vacías', dom.tdBoardCtBody.innerHTML.indexOf('td-board-empty') !== -1);

  board.setClock('Duración: 12m 0s');
  eq('el reloj lo escribe la sala', dom.tdDuration.textContent, 'Duración: 12m 0s');

  return { dom: dom, board: board };
}

/* ————————————————————— Asistencia por plantilla ————————————————————— */

/**
 * El parte de sala dice quién está dentro, pero la pregunta del que espera es
 * la contraria: quién falta. Con solo la lista de conectados, un equipo a
 * cuatro y otro completo se veían igual.
 */
function runAttendance(dom, board) {
  console.log('\n--- asistencia: quién falta por entrar ---');

  const TEAMS = [
    {
      teamId: 'team-alpha',
      name: 'Alpha',
      players: [
        { uid: 'uid-a1', nick: 'Carry' },
        { uid: 'uid-a2', nick: 'Tarde' },
        { uid: 'uid-a3', nick: 'Ausente' },
      ],
    },
    {
      teamId: 'team-bravo',
      name: 'Bravo',
      players: [
        { uid: 'uid-b1', nick: 'Anon' },
        // Sin Steam vinculado: el servidor no le resuelve uid y solo llega el
        // nombre. Antes salía como ausente estando dentro.
        { uid: 'uid-b2', nick: 'SinSteam' },
      ],
    },
  ];

  const LIVE = {
    status: 'live',
    phase: 'warmup',
    lobby: {
      count: 5,
      players: [
        { uid: 'uid-a1', name: 'Carry', side: 'CT', bot: false },
        { uid: 'uid-b1', name: 'Anon', side: 'T', bot: false },
        { uid: null, name: 'sinsteam', side: 'T', bot: false },
        { uid: null, name: 'Wolf', side: 'T', bot: true },
        { uid: null, name: 'Colado', side: null, bot: false },
      ],
    },
  };

  const check = board.buildLobbyCheck(LIVE, TEAMS);
  eq('Alpha tiene uno de tres dentro', check.teams[0].inCount, 1);
  eq('sobre una plantilla de tres', check.teams[0].total, 3);
  eq('Bravo tiene dos de dos', check.teams[1].inCount, 2);
  truthy('el que no vinculó Steam se reconoce por el nombre',
    check.teams[1].players.find(function (p) { return p.nick === 'SinSteam'; }).connected);
  falsy('el que no ha entrado sale como ausente',
    check.teams[0].players.find(function (p) { return p.nick === 'Ausente'; }).connected);
  eq('el bando del conectado viaja para la ficha',
    check.teams[0].players.find(function (p) { return p.nick === 'Carry'; }).side, 'CT');
  eq('quien está dentro sin salir en ninguna plantilla se nombra',
    check.guests.join(','), 'Colado');
  falsy('y un bot no cuenta como intruso', check.guests.indexOf('Wolf') !== -1);

  // Dos jugadores con el mismo apodo no pueden repartirse un solo conectado.
  const dupe = board.buildLobbyCheck(
    { lobby: { players: [{ uid: null, name: 'Clon', bot: false }] } },
    [{ teamId: 'x', name: 'X', players: [{ uid: 'u1', nick: 'Clon' }, { uid: 'u2', nick: 'Clon' }] }]
  );
  eq('un conectado solo cubre a un jugador', dupe.teams[0].inCount, 1);
  eq('y no se le cuenta además como intruso', dupe.guests.length, 0);

  const empty = board.buildLobbyCheck(null, TEAMS);
  eq('sin nadie dentro la plantilla sigue listada', empty.teams[0].total, 3);
  eq('con cero presentes', empty.teams[0].inCount, 0);
  eq('sin plantillas conocidas no se inventa nada', board.buildLobbyCheck(LIVE, []), null);

  board.render({ currentUid: 'uid-a1', live: LIVE, teams: TEAMS });
  falsy('la lista de asistencia se pinta en calentamiento', dom.tdLobbyCheck.hidden);
  truthy('con el marcador de cada equipo', dom.tdLobbyCheck.innerHTML.indexOf('1/3') !== -1);
  truthy('el ausente se marca', dom.tdLobbyCheck.innerHTML.indexOf('is-out') !== -1);
  truthy('el presente también', dom.tdLobbyCheck.innerHTML.indexOf('is-in') !== -1);
  truthy('el jugador se reconoce en la lista', dom.tdLobbyCheck.innerHTML.indexOf('is-you') !== -1);
  truthy('la plantilla completa se destaca', dom.tdLobbyCheck.innerHTML.indexOf('is-full') !== -1);
  truthy('y se avisa del que no pinta nada ahí',
    dom.tdLobbyCheck.innerHTML.indexOf('Colado') !== -1);

  board.render({
    live: { status: 'live', phase: 'live', scoreboard: [{ uid: 'uid-a1', name: 'Carry', side: 'CT', kills: 1, deaths: 0, score: 3 }] },
    teams: TEAMS,
  });
  truthy('en cuanto hay estadísticas la asistencia sobra', dom.tdLobbyCheck.hidden);

  board.render({
    live: { status: 'finished', lobby: { players: [] } },
    teams: TEAMS,
  });
  truthy('con el cruce cerrado tampoco se listan ausentes', dom.tdLobbyCheck.hidden);

  // Sin máquina ni parte de sala no hay a quién esperar: la lista solo sería
  // una fila de ausentes de una partida que nadie ha empezado a montar.
  board.render({ live: null, teams: TEAMS, server: {} });
  truthy('antes de que exista el servidor no se pinta la asistencia', dom.tdLobbyCheck.hidden);

  board.render({ live: null, teams: TEAMS, server: { status: 'provisioning' } });
  falsy('en cuanto se está levantando la máquina sí', dom.tdLobbyCheck.hidden);
  truthy('con toda la plantilla todavía fuera',
    dom.tdLobbyCheck.innerHTML.indexOf('0/3') !== -1);

  board.render({
    live: LIVE,
    teams: [{ teamId: 'x', name: '<img src=x>', players: [{ uid: 'u1', nick: '<b>hack</b>' }] }],
  });
  falsy('un nombre con etiquetas no se inyecta',
    dom.tdLobbyCheck.innerHTML.indexOf('<img src=x>') !== -1);

  console.log('\n--- la espera dice en qué punto está el servidor ---');

  board.render({ live: null, teams: [], server: { status: 'provisioning' } });
  truthy('con la máquina creándose se dice eso',
    dom.tdBoardCtBody.innerHTML.indexOf('Levantando el servidor') !== -1);

  board.render({
    live: { status: 'starting', phase: 'warmup' },
    teams: [],
    server: { status: 'starting', ip: '10.0.0.9', port: 27015, canConnect: true },
  });
  truthy('con servidor en pie se dice que no ha entrado nadie',
    dom.tdBoardCtBody.innerHTML.indexOf('Todavía no ha entrado nadie') !== -1);
  truthy('y al jugador se le recuerda dónde',
    dom.tdBoardCtBody.innerHTML.indexOf('10.0.0.9:27015') !== -1);

  // El tablero es público y el panel de conexión está cerrado a los
  // espectadores: la IP no puede escaparse por aquí.
  board.render({
    live: { status: 'starting', phase: 'warmup' },
    teams: [],
    server: { status: 'starting', ip: '10.0.0.9', port: 27015, canConnect: false },
  });
  falsy('al espectador no se le da la IP',
    dom.tdBoardCtBody.innerHTML.indexOf('10.0.0.9') !== -1);
  truthy('pero sí se le dice que el servidor está en pie',
    dom.tdBoardCtBody.innerHTML.indexOf('está en pie') !== -1);

  board.render({ live: null, teams: [], server: {} });
  truthy('sin servidor todavía se mantiene el texto de siempre',
    dom.tdBoardCtBody.innerHTML.indexOf('cuando arranca la partida') !== -1);
}

/* ————————————————————— Pestañas de los dos cruces ————————————————————— */

/**
 * En modo dos servidores las dos semifinales se preparan a la vez. Mirando solo
 * a las que ya están en vivo, media sala no tenía forma de llegar a su partida
 * hasta que alguien le daba al saque en la otra.
 */
function runTabs() {
  console.log('\n--- las dos semifinales son elegibles desde que tienen máquina ---');
  const page = fs.readFileSync(path.join(rootDir, 'tournament-details.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  const found = /\n  function selectableMatchIds\([\s\S]*?\n  \}\n/.exec(page);
  if (!found) {
    console.error('FAIL no se encontró selectableMatchIds() en tournament-details.js');
    failed += 1;
    return;
  }

  const build = new Function('liveMatches', [
    '"use strict";',
    'function toNum(v) { var n = Number(v); return isFinite(n) ? n : 0; }',
    'var TAB_STATUSES = ["provisioning", "starting", "live"];',
    found[0],
    'return selectableMatchIds;',
  ].join('\n'));

  const bracket = {
    bracket: {
      matches: {
        r1_m1: { id: 'r1_m1', round: 1 },
        r1_m2: { id: 'r1_m2', round: 1 },
        r2_m1: { id: 'r2_m1', round: 2 },
      },
    },
  };

  const dual = build({
    r1_m2: { status: 'provisioning' },
    r1_m1: { status: 'live' },
  });
  eq('una en vivo y otra preparándose dan dos pestañas',
    dual(bracket).join(','), 'r1_m1,r1_m2');

  const bothWarm = build({ r1_m1: { status: 'provisioning' }, r1_m2: { status: 'provisioning' } });
  eq('las dos preparándose también', bothWarm(bracket).join(','), 'r1_m1,r1_m2');

  const closed = build({ r1_m1: { status: 'finished' }, r1_m2: { status: 'live' } });
  eq('un cruce cerrado no sigue ofreciéndose', closed(bracket).join(','), 'r1_m2');

  const stopped = build({ r1_m1: { status: 'stopped' }, r1_m2: { status: 'live' } });
  eq('ni uno con la máquina apagada', stopped(bracket).join(','), 'r1_m2');

  const mixedRounds = build({ r2_m1: { status: 'live' }, r1_m2: { status: 'live' } });
  eq('las pestañas salen en orden de cuadro',
    mixedRounds(bracket).join(','), 'r1_m2,r2_m1');

  const none = build({});
  eq('sin cruces con máquina se cae al puntero del torneo',
    none({ activeMatchId: 'r1_m1', status: 'en_vivo' }).join(','), 'r1_m1');

  truthy('la pestaña que aún prepara no se anuncia como en vivo',
    /is-warmup/.test(page) && /td-match-tab-state/.test(page));
  truthy('elegir cruce a mano lo fija', /pinnedMatchId = mid/.test(page));
  truthy('y el enganche automático lo respeta',
    /if \(pinnedMatchId\) nextId = pinnedMatchId/.test(page));
  truthy('el tablero recibe las plantillas del cruce', /teams: matchRosterTeams\(/.test(page));
  truthy('y en qué punto está su máquina', /server: matchServerHint\(/.test(page));
  truthy('las plantillas salen de las congeladas al inscribirse',
    /registeredRosters/.test(page) && /SGTournamentRoster/.test(page));

  const css = fs.readFileSync(path.join(rootDir, 'td-live-board.css'), 'utf8');
  truthy('la asistencia tiene estilos', /\.td-lobby-check/.test(css));
}

/* ————————————————————— Cableado de la página ————————————————————— */

function runWiring() {
  console.log('\n--- la sala carga el tablero ---');
  const html = fs.readFileSync(path.join(rootDir, 'tournament-details.html'), 'utf8');

  truthy('tournament-details.html enlaza td-live-board.css', /td-live-board\.css/.test(html));
  truthy('y carga td-live-board.js', /td-live-board\.js/.test(html));
  truthy('el tablero se carga antes que la sala',
    html.indexOf('td-live-board.js') < html.indexOf('tournament-details.js'));

  [
    'tdBoard', 'tdBoardCtBody', 'tdBoardTBody', 'tdBoardBench', 'tdLobbyCheck',
    'tdKillFeed', 'tdKillFeedEmpty', 'tdBoardPhase', 'tdRound', 'tdDuration',
    'tdScoreCt', 'tdScoreT', 'tdMvp',
    'tdSbLive', 'tdSbMap', 'tdSbTeamA', 'tdSbTeamB', 'tdSbSideA', 'tdSbSideB',
  ].forEach(function (id) {
    truthy('el markup trae ' + id, html.indexOf('id="' + id + '"') !== -1);
  });

  // Lo que el encargo dejó fuera: el resto de la sala no se toca.
  ['tdConnectInfo', 'tdSteamCta', 'tdMatchTabs', 'tdBracket', 'tdTeams', 'tdInfoRows'].forEach(function (id) {
    truthy('sigue en pie ' + id, html.indexOf('id="' + id + '"') !== -1);
  });

  const page = fs.readFileSync(path.join(rootDir, 'tournament-details.js'), 'utf8');
  falsy('la sala ya no pinta la tabla a mano', /tdStatsBody|tdKillsBody/.test(page));
  truthy('delega en TDLiveBoard', /TDLiveBoard\.render/.test(page));
}

/* ————————————————————— El servidor sabe dónde juega ————————————————————— */

/**
 * El puente descarta todo evento mientras no sepa a qué cruce pertenece, y el
 * único que se lo decía era el lanzamiento de la partida. Con un servidor recién
 * levantado eso significaba que quien entraba a calentar no existía para la
 * sala, que es exactamente el fallo que se está arreglando aquí.
 */
function runContext() {
  console.log('\n--- el servidor sabe a qué cruce pertenece desde que arranca ---');
  const read = function (rel) {
    return fs.readFileSync(path.join(rootDir, rel), 'utf8');
  };

  ['functions/cs2-nexus/cloud-init.sh', 'functions/cs2-nexus/cloud-init-snapshot.sh']
    .forEach(function (rel) {
      const sh = read(rel);
      truthy(rel + ' graba el torneo en bridge.env', /NEXUS_TOURNAMENT_ID=/.test(sh));
      truthy(rel + ' graba el cruce', /NEXUS_MATCH_ID=/.test(sh));
    });

  const pack = read('functions/cs2-nexus/lib/cloud-init-pack.js');
  truthy('el paquete sustituye el torneo', /__NEXUS_TOURNAMENT_ID__/.test(pack));
  truthy('y el cruce', /__NEXUS_MATCH_ID__/.test(pack));
  truthy('sin dejar pasar nada que rompa el archivo de entorno',
    /A-Za-z0-9_-/.test(pack));

  const index = read('functions/cs2-nexus/index.js');
  truthy('la provisión le pasa el cruce a la máquina',
    /gsltSlot: slot,[\s\S]{0,400}tournamentId,\s*\n\s*matchId,/.test(index));
  truthy('y en cuanto responde RCON se le fija el contexto',
    /rcon\.setMatchContext\(/.test(index));

  // El arranque desde imagen solo compilaba el puente si la máquina ya traía
  // dotnet, y si no lo traía se saltaba el bloque en silencio: el servidor
  // quedaba con MatchZy y sin puente, que es por qué la web no veía a nadie.
  const snapshot = read('functions/cs2-nexus/cloud-init-snapshot.sh');
  truthy('el arranque desde imagen instala dotnet si falta',
    /dotnet missing[\s\S]{0,200}dotnet-sdk-8\.0/.test(snapshot));
  truthy('el build del puente deja registro en vez de tragárselo',
    /cs2-nexus-bridge-build\.log/.test(snapshot));
  truthy('y se comprueba que el DLL acabó donde CS2 lo busca',
    /NexusBridge\.dll missing/.test(snapshot));

  const plugin = read('cs2-server/plugins/NexusBridge/NexusBridgePlugin.cs');
  truthy('el plugin lee el torneo de su entorno', /NEXUS_TOURNAMENT_ID/.test(plugin));
  truthy('y el cruce', /NEXUS_MATCH_ID/.test(plugin));
  truthy('repasa la sala cada pocos segundos por si se perdió un evento',
    /LobbyHeartbeatSeconds/.test(plugin) && /TimerFlags\.REPEAT/.test(plugin));
  truthy('y solo publica cuando la lista cambia', /_lobbySignature/.test(plugin));

  // Aquí estaba el fallo de verdad: fijar el contexto colgaba de la tarea suelta
  // del aprovisionamiento, y Cloud Run le corta la CPU en cuanto responde. Ese
  // bucle no llegaba nunca al final, así que ninguna máquina supo nunca a qué
  // cruce pertenecía y el puente tiraba todo lo que pasaba dentro.
  truthy('la pasada programada reintenta el contexto hasta que el plugin conteste',
    /ensureBridgeContextCore/.test(index) && /cs2BridgeContext/.test(index));
  truthy('y se guarda el resultado para poder mirarlo desde fuera',
    /bridgeContextError/.test(index) && /bridgePluginVersion/.test(index));
  truthy('cuando no contesta se apunta qué capas cargó la máquina',
    /rcon\.probeBridge\(/.test(index) && /bridgeProbe/.test(index));

  // Sin respuesta reconocible, un servidor con el DLL viejo se veía idéntico a
  // uno bien configurado.
  truthy('el plugin contesta al comando con su versión',
    /ReplyToCommand\("NexusBridge " \+ ModuleVersion/.test(plugin));
  const rcon = require(path.join(libDir, 'rcon.js'));
  eq('un comando desconocido no se toma por bueno',
    rcon.readContextReply('Unknown command "css_nexus_setcontext"').ok, false);
  eq('y de la respuesta buena se saca el build cargado',
    rcon.readContextReply('NexusBridge 1.4.0 context t-001 r1_m1').pluginVersion, '1.4.0');
}

async function main() {
  await runBridge();
  const board = runBoard();
  runAttendance(board.dom, board.board);
  runTabs();
  runWiring();
  runContext();

  if (failed) {
    console.error('\n' + failed + ' comprobación(es) fallida(s)');
    process.exit(1);
  }
  console.log('\nTablero en vivo: todo correcto.');
}

main().catch(function (err) {
  console.error('La comprobación reventó:', err);
  process.exit(1);
});
