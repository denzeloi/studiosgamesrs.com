/**
 * Tendencias gaming para Creator Market (Reddit r/gaming hot + caché)
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.database();
const CACHE_MS = 60 * 60 * 1000;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'you', 'are', 'was', 'have', 'has',
  'como', 'para', 'pero', 'esta', 'este', 'solo', 'más', 'mas', 'que', 'por', 'con', 'una', 'los', 'las'
]);

function extractKeywords(text) {
  const words = String(text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/i)
    .filter(function (w) { return w.length >= 4 && !STOP_WORDS.has(w); });
  const freq = {};
  words.forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });
  return Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 24);
}

async function fetchRedditGamingTrends() {
  const res = await fetch('https://www.reddit.com/r/gaming/hot.json?limit=15', {
    headers: { 'User-Agent': 'StudiosGamesRS-CreatorMarket/1.0 (contact: studiosgamesrs.com)' }
  });
  if (!res.ok) throw new Error('Reddit API HTTP ' + res.status);
  const json = await res.json();
  const topics = [];
  (json.data && json.data.children ? json.data.children : []).forEach(function (ch) {
    const title = ch.data && ch.data.title;
    if (title) topics.push(String(title).trim());
  });
  const keywords = extractKeywords(topics.join(' '));
  return {
    topics: topics.slice(0, 12),
    keywords: keywords,
    updatedAt: Date.now(),
    source: 'reddit_r_gaming_hot'
  };
}

exports.getCreatorMarketTrends = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }

  const cacheSnap = await db.ref('creatorMarket/trendsCache').once('value');
  const cache = cacheSnap.val();
  if (cache && cache.expiresAt > Date.now() && cache.payload) {
    return cache.payload;
  }

  try {
    const payload = await fetchRedditGamingTrends();
    await db.ref('creatorMarket/trendsCache').set({
      payload: payload,
      expiresAt: Date.now() + CACHE_MS
    });
    return payload;
  } catch (e) {
    functions.logger.warn('getCreatorMarketTrends fallback', e.message);
    const fallback = {
      topics: [
        'Counter-Strike 2 highlights',
        'Co-op gaming sessions',
        'New game updates and patches',
        'Indie games worth playing',
        'Esports moments'
      ],
      keywords: ['cs2', 'valorant', 'minecraft', 'coop', 'ranked', 'update', 'indie', 'esports', 'clip', 'gaming'],
      updatedAt: Date.now(),
      source: 'fallback_static'
    };
    return fallback;
  }
});
