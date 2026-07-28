/**
 * PZ-017: users tenía ".read": "auth != null", así que cualquier autenticado
 * podía descargar el padrón completo (nicks, rango, Steam, tokens, settings,
 * flags de moderación...) con un simple .once('value'). database.rules.json
 * cierra esa lectura global salvo para Commander/Boss (que sí la necesitan
 * para moderación), y este archivo mantiene sincronizado un espejo mínimo en
 * publicProfiles/{uid} con SOLO los campos que ya se muestran públicamente
 * (Jugadores de Play Zone, buscadores de invitación, muro de pensamientos,
 * ranking de honor). Cualquier campo sensible (tokens, steamID, blocked,
 * settings, registro exacto, etc.) se queda fuera a propósito.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

// Lista blanca: si un campo no está aquí, NUNCA se copia a publicProfiles.
function projectPublicProfile(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {};

  function copy(key) {
    if (u[key] !== undefined && u[key] !== null) out[key] = u[key];
  }

  copy('nick');
  copy('nick_lowercase');
  copy('nickname');
  copy('displayName');
  copy('photoURL');
  copy('rango');
  copy('communityHonor');
  copy('playZoneOnboardingComplete');
  copy('mainGame');
  copy('mainGames');
  copy('secondaryGames');
  copy('playStyle');
  copy('timezone');
  copy('teamId');
  copy('thought');
  copy('preferSteamAvatar');
  copy('avatarSource');
  // Insignias públicas (p.ej. Lealtad). Solo IDs; el arte lo resuelve el cliente.
  if (Array.isArray(u.badges)) {
    out.badges = u.badges.filter(function (id) { return typeof id === 'string' && id; }).slice(0, 20);
  } else if (u.badges && typeof u.badges === 'object') {
    out.badges = Object.keys(u.badges).reduce(function (list, key) {
      var val = u.badges[key];
      if (val === true || val === 1) list.push(key);
      else if (typeof val === 'string' && val) list.push(val);
      return list;
    }, []).slice(0, 20);
  }

  // Del objeto steam solo se exponen las URLs de avatar, nunca steamid/personaname.
  if (u.steam && typeof u.steam === 'object') {
    const steamAvatar = {};
    if (u.steam.avatarfull) steamAvatar.avatarfull = u.steam.avatarfull;
    if (u.steam.avatarmedium) steamAvatar.avatarmedium = u.steam.avatarmedium;
    if (u.steam.avatar) steamAvatar.avatar = u.steam.avatar;
    if (Object.keys(steamAvatar).length) out.steam = steamAvatar;
  }

  return Object.keys(out).length ? out : null;
}

exports.projectPublicProfile = projectPublicProfile;

// Se dispara con cualquier escritura dentro de users/{uid} y reproyecta el
// subconjunto público completo (así un cambio en, por ejemplo, users/{uid}/nick
// también actualiza publicProfiles/{uid} sin tener que listar cada campo).
exports.syncPublicProfile = functions.database
  .ref('/users/{uid}')
  .onWrite(async (change, context) => {
    const uid = context.params.uid;
    const publicRef = admin.database().ref('publicProfiles/' + uid);

    if (!change.after.exists()) {
      await publicRef.remove();
      return null;
    }

    const projected = projectPublicProfile(change.after.val());
    if (!projected) {
      await publicRef.remove();
      return null;
    }
    await publicRef.set(projected);
    return null;
  });

/**
 * Migración única para cuentas que ya existían antes de este fix: recorre
 * users/ entero (Admin SDK, no pasa por reglas) y reconstruye publicProfiles/
 * desde cero. Se puede repetir sin riesgo (siempre sobrescribe con el estado
 * real de users/, es puramente derivada, y no devuelve ningún dato sensible
 * al llamador, solo un conteo). Mismo patrón que backfillSteamIndexes en
 * steamLink.js: POST sin auth, pensado para ejecutarse una vez desde consola/admin.
 */
exports.backfillPublicProfiles = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }
  try {
    const snap = await admin.database().ref('users').once('value');
    const updates = {};
    let count = 0;

    snap.forEach((child) => {
      const projected = projectPublicProfile(child.val());
      if (projected) {
        updates['publicProfiles/' + child.key] = projected;
        count++;
      }
    });

    if (count > 0) {
      await admin.database().ref().update(updates);
    }

    res.json({ success: true, count: count });
  } catch (err) {
    console.error('backfillPublicProfiles:', err);
    res.status(500).json({ success: false, error: 'internal' });
  }
});
