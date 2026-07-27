/**
 * Estadísticas de CS2 vía Steam Web API
 * ======================================
 * Devuelve el K/D de por vida y datos de la última partida (K/D y ganó/perdió)
 * de un usuario a partir de su SteamID64 (guardado en users/{uid}/steam/steamid).
 *
 * - La API key vive SOLO en el servidor (aquí). Nunca se expone al cliente.
 * - Se cachea el resultado en users/{uid}/cs2Stats para no gastar cuota ni
 *   ralentizar el dashboard (se refresca como máximo cada CACHE_TTL_MS).
 * - Requiere que el perfil de Steam del usuario sea PÚBLICO (detalles del juego).
 *
 * === Instalación (functions/index.js) ===
 *   const steamStats = require('./steamStats');
 *   exports.getSteamCs2Stats = steamStats.getSteamCs2Stats;
 * Desplegar:
 *   firebase deploy --only functions:getSteamCs2Stats
 */

const functions = require('firebase-functions');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

// Clave de la Steam Web API (studiosgamesrs.com). Vive en Secret Manager, nunca en el repo.
const STEAM_API_KEY = defineSecret('STEAM_API_KEY');
const CS2_APPID = 730;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

// Convierte el array de stats de Steam en un objeto { nombre: valor }.
function statsArrayToMap(statsArr) {
  const map = {};
  if (Array.isArray(statsArr)) {
    statsArr.forEach(function (s) {
      if (s && typeof s.name === 'string') map[s.name] = s.value;
    });
  }
  return map;
}

function safeKd(kills, deaths) {
  kills = Number(kills || 0);
  deaths = Number(deaths || 0);
  if (deaths <= 0) return kills > 0 ? kills : 0;
  return Math.round((kills / deaths) * 100) / 100; // 2 decimales
}

// Interpreta los datos crudos de Steam en un resumen limpio para el front.
function buildSummary(map) {
  const kills = Number(map.total_kills || 0);
  const deaths = Number(map.total_deaths || 0);
  const wins = Number(map.total_wins || 0);
  const matchesWon = Number(map.total_matches_won || 0);
  const matchesPlayed = Number(map.total_matches_played || 0);
  const timePlayed = Number(map.total_time_played || 0);

  // Última partida
  const lmKills = Number(map.last_match_kills || 0);
  const lmDeaths = Number(map.last_match_deaths || 0);
  const lmWinsRounds = Number(map.last_match_wins || 0);     // rondas ganadas por tu equipo
  const lmRounds = Number(map.last_match_rounds || 0);       // rondas totales de la partida
  const hasLastMatch = lmRounds > 0 || lmKills > 0 || lmDeaths > 0;

  // Ganó/perdió: tu equipo ganó si tus rondas > la mitad del total.
  let lastResult = 'unknown';
  if (lmRounds > 0) {
    const enemyRounds = lmRounds - lmWinsRounds;
    if (lmWinsRounds > enemyRounds) lastResult = 'win';
    else if (lmWinsRounds < enemyRounds) lastResult = 'loss';
    else lastResult = 'tie';
  }

  return {
    available: true,
    kd: safeKd(kills, deaths),
    kills: kills,
    deaths: deaths,
    wins: wins,
    matchesWon: matchesWon,
    matchesPlayed: matchesPlayed,
    timePlayedHours: Math.round(timePlayed / 3600),
    lastMatch: {
      available: hasLastMatch,
      kills: lmKills,
      deaths: lmDeaths,
      kd: safeKd(lmKills, lmDeaths),
      roundsWon: lmWinsRounds,
      rounds: lmRounds,
      result: lastResult // 'win' | 'loss' | 'tie' | 'unknown'
    }
  };
}

exports.getSteamCs2Stats = functions.runWith({ secrets: [STEAM_API_KEY] }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const db = admin.database();
  const uid = (data && data.uid) ? String(data.uid) : context.auth.uid;
  const force = !!(data && data.force);

  // 1. SteamID del usuario objetivo
  const steamSnap = await db.ref('users/' + uid + '/steam').once('value');
  const steam = steamSnap.val() || {};
  const steamId = steam.steamid;
  if (!steamId) {
    return { available: false, reason: 'no_steam', message: 'El usuario no tiene Steam vinculado.' };
  }

  // 2. Cache: si es reciente, la devolvemos sin llamar a Steam
  if (!force) {
    const cacheSnap = await db.ref('users/' + uid + '/cs2Stats').once('value');
    const cache = cacheSnap.val();
    if (cache && cache.fetchedAt && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
      return Object.assign({}, cache.summary, { cached: true, fetchedAt: cache.fetchedAt });
    }
  }

  // 3. Llamada a la Steam Web API
  const url = 'https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/'
    + '?appid=' + CS2_APPID
    + '&key=' + STEAM_API_KEY.value()
    + '&steamid=' + encodeURIComponent(steamId);

  let summary;
  try {
    const resp = await fetch(url);
    if (resp.status === 403) {
      return { available: false, reason: 'private', message: 'El perfil de Steam es privado. Ponlo público para ver tus stats de CS2.' };
    }
    if (!resp.ok) {
      // 500 suele significar perfil sin stats públicas de CS2
      return { available: false, reason: 'no_stats', message: 'No se encontraron estadísticas públicas de CS2.' };
    }
    const json = await resp.json();
    const playerstats = json && json.playerstats;
    if (!playerstats || !Array.isArray(playerstats.stats) || playerstats.stats.length === 0) {
      return { available: false, reason: 'no_stats', message: 'No se encontraron estadísticas públicas de CS2.' };
    }
    const map = statsArrayToMap(playerstats.stats);
    summary = buildSummary(map);
  } catch (err) {
    console.error('Error consultando Steam:', err);
    throw new functions.https.HttpsError('internal', 'No se pudo consultar Steam en este momento.');
  }

  // 4. Guardar en cache
  try {
    await db.ref('users/' + uid + '/cs2Stats').set({
      summary: summary,
      steamId: steamId,
      fetchedAt: admin.database.ServerValue.TIMESTAMP
    });
  } catch (e) {
    console.warn('No se pudo cachear cs2Stats:', e);
  }

  return Object.assign({}, summary, { cached: false, fetchedAt: Date.now() });
});
