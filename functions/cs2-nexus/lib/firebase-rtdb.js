'use strict';

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.database();

/**
 * Marcador público del cruce.
 *
 * Vivía en partida_en_vivo/{cruce}, y los identificadores de cruce se repiten
 * entre torneos: dos campeonatos con un 'r1_m1' en marcha escribían en el mismo
 * sitio y se pisaban el marcador delante de los espectadores. Ahora cuelga del
 * torneo. Sin torneo (eventos sueltos de un servidor sin contexto) se queda
 * donde estaba, que es mejor que perderlo.
 */
function matchLivePath(tournamentId, matchId) {
  return tournamentId
    ? `partida_en_vivo/${tournamentId}/${matchId}`
    : `partida_en_vivo/${matchId}`;
}

async function writeMatchLive(tournamentId, matchId, data) {
  if (!matchId) return;
  await db.ref(matchLivePath(tournamentId, matchId)).update({
    ...data,
    updatedAt: Date.now(),
  });
}

async function writeTournamentLiveMatch(tournamentId, matchId, data) {
  if (!tournamentId || !matchId) return;
  await db.ref(`tournaments/${tournamentId}/liveMatches/${matchId}`).update({
    ...data,
    updatedAt: Date.now(),
  });
}

async function getTournamentLiveMatch(tournamentId, matchId) {
  if (!tournamentId || !matchId) return null;
  const snap = await db.ref(`tournaments/${tournamentId}/liveMatches/${matchId}`).once('value');
  return snap.val() || null;
}

async function writeTournament(tournamentId, data) {
  await db.ref(`tournaments/${tournamentId}`).update({
    ...data,
    updatedAt: Date.now(),
  });
}

async function writeGameServer(serverId, data) {
  await db.ref(`gameServers/${serverId}`).update({
    ...data,
    updatedAt: Date.now(),
  });
}

async function removeGameServer(serverId) {
  await db.ref(`gameServers/${serverId}`).remove();
}

async function clearTournamentServerFields(tournamentId) {
  await db.ref(`tournaments/${tournamentId}`).update({
    activeServerId: null,
    serverIp: null,
    serverPort: null,
    activeMap: null,
    activeMatchId: null,
    status: 'pendiente',
    updatedAt: Date.now(),
  });
}

async function gameServerExists(serverId) {
  const snap = await db.ref(`gameServers/${serverId}`).once('value');
  return snap.exists();
}

async function getGameServer(serverId) {
  const snap = await db.ref(`gameServers/${serverId}`).once('value');
  return snap.val() || null;
}

/**
 * Todas las máquinas que dicen ser de este torneo, estén colgadas de un cruce o
 * no. Al cerrar el torneo hay que apagarlas todas, y las que se quedaron sin
 * cruce (un aprovisionamiento a medias, un cruce liberado) no aparecen por
 * ningún otro sitio: son justo las que se quedaban encendidas facturando.
 */
async function getGameServersByTournament(tournamentId) {
  if (!tournamentId) return {};
  const snap = await db
    .ref('gameServers')
    .orderByChild('tournamentId')
    .equalTo(String(tournamentId))
    .once('value');
  return snap.val() || {};
}

async function getTournament(tournamentId) {
  const snap = await db.ref(`tournaments/${tournamentId}`).once('value');
  return snap.val();
}

async function writeBracketMatch(tournamentId, matchId, data) {
  await db.ref(`tournaments/${tournamentId}/bracket/matches/${matchId}`).update({
    ...data,
    updatedAt: Date.now(),
  });
}

async function getBracketMatch(tournamentId, matchId) {
  if (!tournamentId || !matchId) return null;
  const snap = await db
    .ref(`tournaments/${tournamentId}/bracket/matches/${matchId}`)
    .once('value');
  return snap.val() || null;
}

async function getTeamSummary(teamId) {
  if (!teamId) return null;
  const snap = await db.ref(`teams/${teamId}`).once('value');
  const team = snap.val() || {};
  const roster = team.roster || team.members || {};
  const uids = Object.keys(roster);
  if (team.captain && !uids.includes(team.captain)) uids.push(team.captain);
  return { id: String(teamId), name: team.name || String(teamId), uids };
}

async function rosterUidsOf(teamId) {
  const summary = await getTeamSummary(teamId);
  return (summary && summary.uids) || [];
}

/**
 * Deja el mismo aviso en la campana de todo el roster.
 *
 * Es la única forma de que un jugador se entere de algo cuando no tiene la sala
 * abierta. El identificador del aviso es determinista por cruce, así que un
 * reintento del webhook no llena el panel de copias, y nunca se pisa uno ya
 * escrito: si el jugador lo leyó, se queda leído.
 */
async function notifyTeamRosters(teamIds, notificationId, payload) {
  const ids = (teamIds || []).filter(Boolean);
  if (!ids.length || !notificationId || !payload || !payload.text) return 0;

  const uids = [];
  for (const teamId of ids) {
    const rosterUids = await rosterUidsOf(teamId);
    rosterUids.forEach((uid) => {
      if (uid && !uids.includes(uid)) uids.push(uid);
    });
  }
  if (!uids.length) return 0;

  const notice = {
    text: String(payload.text),
    icon: payload.icon || 'fa-trophy',
    link: payload.link || null,
    type: payload.type || 'tournament',
    timestamp: Date.now(),
    read: false,
  };

  let written = 0;
  await Promise.all(
    uids.map(async (uid) => {
      const ref = db.ref(`users/${uid}/notifications/${notificationId}`);
      const existing = await ref.once('value');
      if (existing.exists()) return;
      await ref.set(notice);
      written += 1;
    })
  );
  return written;
}

/**
 * El resultado de la partida, uno por jugador.
 *
 * De aquí cuelgan dos cosas que llevaban tiempo sin dispararse: la animación de
 * victoria o derrota que welcome-overlay.js enseña al volver a la página, y la
 * EXP de torneo, que reparte un trigger sobre este mismo nodo. Nadie escribía
 * aquí, así que ni una ni otra llegaban a ocurrir nunca.
 *
 * Se escribe una sola vez por jugador y cruce: el trigger de EXP es onCreate y
 * un reintento del webhook no puede pagar dos veces.
 */
async function writeMatchResults(resultId, entries) {
  const rows = (entries || []).filter((e) => e && e.uid && e.data);
  if (!resultId || !rows.length) return 0;

  let written = 0;
  await Promise.all(
    rows.map(async (row) => {
      const ref = db.ref(`tournamentMatchResults/${row.uid}/${resultId}`);
      const existing = await ref.once('value');
      if (existing.exists()) return;
      await ref.set(row.data);
      written += 1;
    })
  );
  return written;
}

module.exports = {
  db,
  matchLivePath,
  writeMatchLive,
  writeTournamentLiveMatch,
  getTournamentLiveMatch,
  writeTournament,
  writeGameServer,
  removeGameServer,
  clearTournamentServerFields,
  gameServerExists,
  getGameServer,
  getGameServersByTournament,
  getTournament,
  writeBracketMatch,
  getBracketMatch,
  getTeamSummary,
  rosterUidsOf,
  notifyTeamRosters,
  writeMatchResults,
};
