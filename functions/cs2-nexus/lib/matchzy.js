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
  // Kept separate from the MatchZy config: the server never needs Nexus uids,
  // but the webhook does, to credit stats and MVPs to the right account.
  const uidBySteamId = {};
  // A player with no linked SteamID64 cannot be put in the config, so MatchZy has no
  // way to know which team they belong to and will let them join either one. Their
  // names are collected so the panel can say exactly who to fix.
  const missing = [];
  for (let i = 0; i < uids.length; i += 1) {
    const uid = uids[i];
    const userSnap = await db.ref('users/' + uid).once('value');
    const user = userSnap.val() || {};
    const steamId = steamIdFromUser(user);
    const label = user.nick || user.displayName || uid;
    if (!steamId || !/^\d{17}$/.test(steamId)) {
      missing.push(String(label));
      continue;
    }
    players[steamId] = label;
    uidBySteamId[steamId] = uid;
  }

  return {
    id: teamId,
    name: String(name),
    players: players,
    playerCount: Object.keys(players).length,
    rosterSize: uids.length,
    missingSteam: missing,
    uidBySteamId: uidBySteamId,
  };
}

function numericMatchId(matchId) {
  var digits = String(matchId || '').replace(/\D/g, '');
  if (digits) return Number(digits.slice(-9)) || Date.now() % 1000000000;
  return Date.now() % 1000000000;
}

/**
 * Who starts on which side.
 *
 * MatchZy has no captain concept: after a knife round *any* player on the winning team
 * can type .stay/.switch/.ct/.t, and those same commands double as team-join commands
 * outside the side-selection window. A player picking a side by hand desyncs the roster,
 * so MatchZy refuses to go live and drops back to warmup with team choice wide open.
 *
 * So the side is decided here and handed to the server fixed. The default is a coin
 * flip, which is the fair answer when neither team earned the choice. 'knife' stays
 * available for whoever wants the traditional flow, with the caveat above.
 */
const DEFAULT_SIDE = 'random';

function normalizeSide(value) {
  const side = String(value || '').trim().toLowerCase();
  if (side === 'team1_ct' || side === 'team2_t') return 'team1_ct';
  if (side === 'team1_t' || side === 'team2_ct') return 'team1_t';
  if (side === 'knife') return 'knife';
  if (side === 'random') return 'random';
  return DEFAULT_SIDE;
}

/**
 * Turns the request into the value MatchZy actually receives. The coin flip happens
 * once, here, and is stored with the match config: MatchZy re-fetches that config URL,
 * and re-rolling would hand the teams a different side than the panel announced.
 */
function resolveSide(value, rng) {
  const side = normalizeSide(value);
  if (side !== 'random') return side;
  const roll = typeof rng === 'function' ? rng() : Math.random();
  return roll < 0.5 ? 'team1_ct' : 'team1_t';
}

async function buildMatchConfig({ tournamentId, matchId, map, teamIds, startingSide }) {
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
  const sideRequest = normalizeSide(startingSide);
  const side = resolveSide(sideRequest);

  const config = {
    matchid: numericMatchId(matchId),
    num_maps: 1,
    maplist: [mapName],
    map_sides: [side],
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
  const missingSteam = { team1: team1.missingSteam, team2: team2.missingSteam };
  const missingCount = team1.missingSteam.length + team2.missingSteam.length;

  // Only a fully linked roster can be locked. With even one player missing, MatchZy
  // never learns their team and they are free to join the wrong side.
  const rostersLocked = hasSteam && missingCount === 0;

  let reason = null;
  if (!hasSteam) {
    reason = 'Teams are missing linked Steam IDs — MatchZy will start in open pug mode (players .ready in-game).';
  } else if (missingCount > 0) {
    reason = missingCount + ' player(s) have no linked Steam account, so they cannot be locked to a team.';
  }

  return {
    ok: true,
    hasSteamRosters: hasSteam,
    rostersLocked,
    missingSteam,
    missingCount,
    team1Id,
    team2Id,
    team1Name: team1.name,
    team2Name: team2.name,
    sideRequest,
    startingSide: side,
    config,
    steamMap: Object.assign({}, team1.uidBySteamId, team2.uidBySteamId),
    reason,
  };
}

async function storeMatchConfig(tournamentId, matchId, config, steamMap) {
  await admin.database().ref('matchConfigs/' + tournamentId + '/' + matchId).set({
    config: config,
    steamMap: steamMap || {},
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
  normalizeSide,
  resolveSide,
  DEFAULT_SIDE,
};
