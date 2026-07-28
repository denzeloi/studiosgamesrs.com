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

module.exports = {
  db,
  writeMatchLive,
  writeTournament,
  writeGameServer,
  removeGameServer,
  clearTournamentServerFields,
  gameServerExists,
  getTournament,
  writeBracketMatch,
};
