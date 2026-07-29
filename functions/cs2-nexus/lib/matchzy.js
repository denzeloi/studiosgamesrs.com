'use strict';

/**
 * Build MatchZy match JSON from Nexus teams (roster + Steam IDs).
 * Schema: https://shobhit-pathak.github.io/MatchZy/match_setup/
 */

const admin = require('firebase-admin');

function steamIdFromUser(user) {
  if (!user) return null;
  if (user.steamID) return String(user.steamID).trim();
  if (user.steam && user.steam.steamid) return String(user.steam.steamid).trim();
  return null;
}

async function loadTeamPlayers(teamId) {
  const db = admin.database();
  const teamSnap = await db.ref('teams/' + teamId).once('value');
  const team = teamSnap.val() || {};
  const name = team.name || teamId;
  const roster = team.roster || team.members || {};
  const uids = Object.keys(roster);
  if (team.captain && uids.indexOf(team.captain) === -1) uids.push(team.captain);

  const players = {};
  for (let i = 0; i < uids.length; i += 1) {
    const uid = uids[i];
    const userSnap = await db.ref('users/' + uid).once('value');
    const user = userSnap.val() || {};
    const steamId = steamIdFromUser(user);
    if (!steamId || !/^\d{17}$/.test(steamId)) continue;
    players[steamId] = user.nick || user.displayName || steamId;
  }

  return { id: teamId, name: String(name), players: players, playerCount: Object.keys(players).length };
}

function numericMatchId(matchId) {
  var digits = String(matchId || '').replace(/\D/g, '');
  if (digits) return Number(digits.slice(-9)) || Date.now() % 1000000000;
  return Date.now() % 1000000000;
}

async function buildMatchConfig({ tournamentId, matchId, map, teamIds }) {
  const ids = (teamIds || []).filter(Boolean);
  let team1Id = ids[0];
  let team2Id = ids[1];

  // Prefer bracket slot teams when available
  const tSnap = await admin.database().ref('tournaments/' + tournamentId).once('value');
  const tournament = tSnap.val() || {};
  const bracketMatch = tournament.bracket && tournament.bracket.matches && tournament.bracket.matches[matchId];
  if (bracketMatch) {
    if (bracketMatch.teamA && bracketMatch.teamA.teamId) team1Id = bracketMatch.teamA.teamId;
    if (bracketMatch.teamB && bracketMatch.teamB.teamId) team2Id = bracketMatch.teamB.teamId;
  }

  if (!team1Id || !team2Id) {
    return {
      ok: false,
      reason: 'Need two teams (register teams or build bracket first)',
      config: null,
    };
  }

  const team1 = await loadTeamPlayers(team1Id);
  const team2 = await loadTeamPlayers(team2Id);
  const mapName = map || tournament.activeMap || 'de_mirage';

  const config = {
    matchid: numericMatchId(matchId),
    num_maps: 1,
    maplist: [mapName],
    map_sides: ['knife'],
    players_per_team: Math.max(team1.playerCount, team2.playerCount, 1),
    clinch_series: true,
    team1: {
      id: team1.id,
      name: team1.name,
      players: team1.players,
    },
    team2: {
      id: team2.id,
      name: team2.name,
      players: team2.players,
    },
    cvars: {
      hostname: 'Studiosgamesrs | ' + team1.name + ' vs ' + team2.name,
      tv_enable: '1',
    },
  };

  const hasSteam = team1.playerCount > 0 && team2.playerCount > 0;
  return {
    ok: true,
    hasSteamRosters: hasSteam,
    team1Id,
    team2Id,
    config,
    reason: hasSteam
      ? null
      : 'Teams are missing linked Steam IDs — MatchZy will start in open pug mode (players .ready in-game).',
  };
}

async function storeMatchConfig(tournamentId, matchId, config) {
  await admin.database().ref('matchConfigs/' + tournamentId + '/' + matchId).set({
    config: config,
    updatedAt: Date.now(),
  });
}

async function getStoredMatchConfig(tournamentId, matchId) {
  const snap = await admin.database().ref('matchConfigs/' + tournamentId + '/' + matchId + '/config').once('value');
  return snap.val();
}

module.exports = {
  buildMatchConfig,
  storeMatchConfig,
  getStoredMatchConfig,
  loadTeamPlayers,
};
