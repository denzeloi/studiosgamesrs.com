'use strict';

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.database();

async function writeMatchLive(matchId, data) {
  await db.ref(`partida_en_vivo/${matchId}`).update({
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

async function rosterUidsOf(teamId) {
  const snap = await db.ref(`teams/${teamId}`).once('value');
  const team = snap.val() || {};
  const roster = team.roster || team.members || {};
  const uids = Object.keys(roster);
  if (team.captain && !uids.includes(team.captain)) uids.push(team.captain);
  return uids;
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

module.exports = {
  db,
  writeMatchLive,
  writeTournamentLiveMatch,
  getTournamentLiveMatch,
  writeTournament,
  writeGameServer,
  removeGameServer,
  clearTournamentServerFields,
  gameServerExists,
  getTournament,
  writeBracketMatch,
  getBracketMatch,
  notifyTeamRosters,
};
