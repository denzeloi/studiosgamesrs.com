/**
 * Sincroniza el índice steamID cuando se vincula Steam a una cuenta.
 * El login con Steam busca users/{uid}/steamID; la vinculación desde el dashboard
 * guardaba solo users/{uid}/steam/steamid — este trigger lo corrige automáticamente.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: 'https://studiosgamesrs-default-rtdb.firebaseio.com'
  });
}

const RTDB_URL = 'https://studiosgamesrs-default-rtdb.firebaseio.com';

function normalizeSteamId(id) {
  return id == null ? '' : String(id).trim();
}

function extractSteamIdFromUser(d) {
  if (!d || typeof d !== 'object') return '';
  if (d.steamID != null && d.steamID !== '') return String(d.steamID).trim();
  if (d.steam && d.steam.steamid != null && d.steam.steamid !== '') return String(d.steam.steamid).trim();
  if (d.steamid != null && d.steamid !== '') return String(d.steamid).trim();
  return '';
}

async function findUidBySteamId(db, steamId) {
  let uid = null;
  const indexSnap = await db.ref('steamIndex/' + steamId).once('value');
  if (indexSnap.exists()) return String(indexSnap.val());

  const indexedSnap = await db.ref('users').orderByChild('steamID').equalTo(steamId).limitToFirst(1).once('value');
  if (indexedSnap.exists()) {
    indexedSnap.forEach(function (ch) { uid = ch.key; });
    if (uid) return uid;
  }

  const allSnap = await db.ref('users').once('value');
  if (allSnap.exists()) {
    allSnap.forEach(function (ch) {
      if (uid) return;
      if (extractSteamIdFromUser(ch.val()) === steamId) uid = ch.key;
    });
  }
  return uid;
}

/**
 * Migración única: recorre todos los usuarios y crea steamID + steamIndex
 * desde steam/steamid. Útil si ya había datos vinculados antes del fix.
 * POST sin auth (solo ejecutar una vez desde consola/admin).
 */
exports.backfillSteamIndexes = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  const db = admin.database();
  try {
    const allSnap = await db.ref('users').once('value');
    let updated = 0;
    const tasks = [];
    allSnap.forEach(function (ch) {
      const uid = ch.key;
      const sid = extractSteamIdFromUser(ch.val());
      if (!sid) return;
      updated++;
      tasks.push(db.ref('users/' + uid).update({ steamID: sid }));
      tasks.push(db.ref('steamIndex/' + sid).set(uid));
    });
    await Promise.all(tasks);
    res.json({ success: true, updated: updated });
  } catch (err) {
    console.error('backfillSteamIndexes:', err);
    res.status(500).json({ success: false, error: 'internal' });
  }
});

exports.syncSteamIdIndex = functions.database
  .ref('/users/{uid}/steam')
  .onWrite(async (change, context) => {
    const uid = context.params.uid;
    const steam = change.after.exists() ? (change.after.val() || {}) : null;
    const steamId = steam && steam.steamid ? String(steam.steamid) : '';

    const userRef = admin.database().ref('users/' + uid);
    if (!steamId) {
      const prev = change.before.exists() ? (change.before.val() || {}) : null;
      const prevId = prev && prev.steamid ? String(prev.steamid) : '';
      await userRef.child('steamID').remove();
      if (prevId) await admin.database().ref('steamIndex/' + prevId).remove();
      return null;
    }

    await userRef.update({ steamID: steamId });
    await admin.database().ref('steamIndex/' + steamId).set(uid);
    return null;
  });

/**
 * Resuelve el UID de Firebase para un SteamID64 y devuelve un custom token.
 * Usado por steam_login.php (intent=login) cuando el usuario ya vinculó Steam
 * a su cuenta Google/Email.
 *
 * POST JSON: { "steamId": "7656..." }
 * Respuesta: { "success": true, "uid": "...", "token": "..." }
 */
exports.steamLoginResolve = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }

  let steamId = normalizeSteamId((req.body && req.body.steamId) ? req.body.steamId : '');
  if (!steamId && req.rawBody) {
    try {
      const parsed = JSON.parse(req.rawBody.toString());
      if (parsed && parsed.steamId) steamId = normalizeSteamId(parsed.steamId);
    } catch (e) { /* ignore */ }
  }
  if (!steamId || !/^\d{17}$/.test(steamId)) {
    res.status(400).json({ success: false, error: 'invalid_steam_id' });
    return;
  }

  const db = admin.database();

  try {
    const uid = await findUidBySteamId(db, steamId);

    if (!uid) {
      console.log('steamLoginResolve: not_linked for', steamId);
      res.status(404).json({
        success: false,
        error: 'not_linked',
        message: 'Tu cuenta de Steam no está vinculada a ninguna cuenta de Studiosgamesrs.'
      });
      return;
    }

    // Backfill índices para futuros logins
    await db.ref('users/' + uid).update({ steamID: steamId });
    await db.ref('steamIndex/' + steamId).set(uid);

    const token = await admin.auth().createCustomToken(uid);
    res.json({ success: true, uid: uid, token: token });
  } catch (err) {
    console.error('steamLoginResolve error:', err);
    res.status(500).json({ success: false, error: 'internal' });
  }
});
