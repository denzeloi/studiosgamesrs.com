/**
 * Creator Market — publicación automática en Facebook y métricas reales
 * =====================================================================
 * Requiere en creatorMarket/config (Commander Panel):
 *   - facebookPageId
 *   - facebookPageAccessToken  (token de página con pages_manage_posts + pages_read_engagement)
 *   - facebookPageUrl (opcional, solo referencia)
 *
 * Desplegar:
 *   firebase deploy --only functions:publishCreatorContent,functions:syncCreatorMarketMetrics
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.database();
const GRAPH = 'https://graph.facebook.com/v21.0';
const COMMANDER_RANGOS = new Set(['commander', 'divisional_commander', 'boss_of_the_state']);
const CREATOR_RATES = {
  viewsPer1000Usd: 0.67,
  videoPlaysPer1000Usd: 0.60,
  referralUsd: 2,
  referralTokens: 50
};

function normalizeRango(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

async function assertCommander(uid) {
  const snap = await db.ref('users/' + uid + '/rango').once('value');
  const r = normalizeRango(snap.val());
  if (!COMMANDER_RANGOS.has(r)) {
    throw new functions.https.HttpsError('permission-denied', 'Solo Commanders pueden hacer esta acción.');
  }
}

async function assertBossOfTheState(uid) {
  const snap = await db.ref('users/' + uid + '/rango').once('value');
  const r = normalizeRango(snap.val());
  if (r !== 'boss_of_the_state') {
    throw new functions.https.HttpsError('permission-denied', 'Solo Boss of the State puede hacer esta acción.');
  }
}

async function maybeMarkPublicationEarningsPaid(uid, publicationId) {
  if (!uid || !publicationId) return;
  const ledgerSnap = await db.ref('nexus/users/' + uid + '/creatorMarket/walletLedger').once('value');
  let hasUnpaidForPub = false;
  ledgerSnap.forEach(function (ch) {
    const e = ch.val() || {};
    if (e.publicationId === publicationId && !e.paid) hasUnpaidForPub = true;
  });
  if (hasUnpaidForPub) return;
  const pubRef = db.ref('creatorMarket/publications/' + publicationId);
  const pubSnap = await pubRef.once('value');
  if (!pubSnap.exists()) return;
  const p = pubSnap.val() || {};
  if (p.authorUid !== uid) return;
  await pubRef.child('earnings').update({
    status: 'paid',
    paidAt: Date.now()
  });
}

function isValidFacebookPageId(pageId) {
  const id = String(pageId || '').trim();
  return /^[0-9]{5,20}$/.test(id) && id !== '0';
}

async function resolvePageIdFromToken(token, configuredPageId) {
  const configured = String(configuredPageId || '').trim();
  if (isValidFacebookPageId(configured)) return configured;
  const me = await graphRequest('me', token, {
    method: 'GET',
    body: { fields: 'id,name' }
  });
  const resolved = String(me.id || '').trim();
  if (!isValidFacebookPageId(resolved)) {
    throw new Error('No se pudo obtener un Page ID válido desde el token.');
  }
  return resolved;
}

async function getFacebookConfig() {
  const snap = await db.ref('creatorMarket/config').once('value');
  const cfg = snap.val() || {};
  if (!cfg.facebookPageAccessToken) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Configura el token de acceso de Facebook en Commander Panel → Creator Market.'
    );
  }
  let pageId;
  try {
    pageId = await resolvePageIdFromToken(cfg.facebookPageAccessToken, cfg.facebookPageId);
  } catch (e) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Page ID inválido o token incorrecto. En Graph API Explorer usa GET me/accounts, copia el id y access_token de tu PÁGINA, y pulsa Guardar token.'
    );
  }
  if (String(cfg.facebookPageId || '').trim() !== pageId) {
    await db.ref('creatorMarket/config').update({
      facebookPageId: pageId,
      facebookPageName: cfg.facebookPageName || null
    }).catch(function () {});
    cfg.facebookPageId = pageId;
  }
  return cfg;
}

function formatFacebookError(err) {
  const msg = String(err && err.message ? err.message : err);
  if (msg.indexOf('pages_manage_posts') >= 0 && (msg.indexOf('(#200)') >= 0 || msg.indexOf('not available') >= 0)) {
    return 'El token NO tiene el permiso pages_manage_posts. ' +
      'En Meta for Developers → tu app → Permisos: activa pages_manage_posts, pages_read_engagement y pages_show_list. ' +
      'Luego genera un NUEVO token de PÁGINA en Graph API Explorer (GET me/accounts) con esos permisos marcados. ' +
      'Tu usuario debe ser Admin de la app Y Admin de la página. En modo Desarrollo solo funciona para roles de la app; en producción necesitas App Review.';
  }
  if (msg.indexOf('publish_video') >= 0) {
    return 'Para videos falta el permiso publish_video en el token de página.';
  }
  if (msg.indexOf('OAuthException') >= 0 || msg.indexOf('Invalid OAuth') >= 0) {
    return 'Token de Facebook inválido o expirado. Genera uno nuevo (me/accounts) y guárdalo otra vez.';
  }
  if (msg.indexOf('(#100)') >= 0 && (msg.indexOf('0 does not resolve') >= 0 || msg.indexOf('valid user ID') >= 0)) {
    return 'Page ID inválido (0 o incorrecto). En Graph API Explorer → GET me/accounts → copia el campo "id" numérico de tu página (no el token de usuario) y el "access_token" de esa misma fila. Guarda ambos en Commander Panel.';
  }
  return msg;
}

async function debugTokenScopes(pageToken, appId, appSecret) {
  if (!appId || !appSecret) return null;
  const appToken = appId + '|' + appSecret;
  const debug = await graphRequest('debug_token', appToken, {
    method: 'GET',
    body: { input_token: pageToken }
  });
  return (debug.data && debug.data.scopes) ? debug.data.scopes : [];
}

async function graphRequest(path, token, options) {
  const opts = options || {};
  const method = opts.method || 'GET';
  const body = opts.body;
  let url = GRAPH + '/' + path.replace(/^\//, '');

  if (method === 'POST') {
    const params = new URLSearchParams();
    if (token) params.set('access_token', token);
    if (body && typeof body === 'object') {
      Object.keys(body).forEach(function (k) {
        if (body[k] != null) params.set(k, String(body[k]));
      });
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const json = await res.json().catch(function () { return {}; });
    if (!res.ok || json.error) {
      const msg = (json.error && json.error.message) || ('Facebook API HTTP ' + res.status);
      throw new Error(msg);
    }
    return json;
  }

  const params = new URLSearchParams();
  if (token) params.set('access_token', token);
  if (body && typeof body === 'object') {
    Object.keys(body).forEach(function (k) {
      if (body[k] != null) params.set(k, String(body[k]));
    });
  }
  url += (url.indexOf('?') >= 0 ? '&' : '?') + params.toString();
  const res = await fetch(url, { method: 'GET' });
  const json = await res.json().catch(function () { return {}; });
  if (!res.ok || json.error) {
    const msg = (json.error && json.error.message) || ('Facebook API HTTP ' + res.status);
    throw new Error(msg);
  }
  return json;
}

function calcPublicationEarnings(mediaType, metrics) {
  const views = Number(metrics && metrics.views) || 0;
  const plays = Number(metrics && metrics.videoPlays) || views;
  const isVideo = mediaType === 'video';
  const amount = isVideo
    ? (plays / 1000) * CREATOR_RATES.videoPlaysPer1000Usd
    : (views / 1000) * CREATOR_RATES.viewsPer1000Usd;
  return Math.round(amount * 100) / 100;
}

async function fetchGeoByCountry(postId, token, mediaType) {
  const geoByCountry = {};
  const metrics = mediaType === 'video'
    ? ['post_video_views_by_country', 'post_impressions_by_country']
    : ['post_impressions_by_country'];
  for (let i = 0; i < metrics.length; i++) {
    try {
      const ins = await graphRequest(postId + '/insights', token, {
        method: 'GET',
        body: { metric: metrics[i], period: 'lifetime' }
      });
      const val = ins.data && ins.data[0] && ins.data[0].values && ins.data[0].values[0] && ins.data[0].values[0].value;
      if (val && typeof val === 'object') {
        Object.keys(val).forEach(function (k) {
          geoByCountry[k] = (geoByCountry[k] || 0) + (Number(val[k]) || 0);
        });
      }
    } catch (e) {
      functions.logger.warn('FB geo ' + metrics[i], postId, e.message);
    }
  }
  return geoByCountry;
}

async function checkFacebookPostStatus(postId, token) {
  try {
    const post = await graphRequest(postId, token, {
      method: 'GET',
      body: { fields: 'id,is_published,permalink_url' }
    });
    return {
      exists: true,
      isPublished: post.is_published !== false,
      permalink: post.permalink_url || null
    };
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.indexOf('does not exist') >= 0 || msg.indexOf('(#100)') >= 0 || msg.indexOf('Unsupported get request') >= 0) {
      return { exists: false, isPublished: false, permalink: null };
    }
    return { exists: true, isPublished: true, permalink: null, uncertain: true };
  }
}

async function fetchPostMetrics(postId, token, mediaType) {
  let likes = 0;
  let comments = 0;
  let views = 0;
  let videoPlays = 0;
  const fbStatus = await checkFacebookPostStatus(postId, token);

  if (fbStatus.exists) {
    try {
      const post = await graphRequest(postId, token, {
        method: 'GET',
        body: { fields: 'likes.summary(true),comments.summary(true)' }
      });
      likes = (post.likes && post.likes.summary && post.likes.summary.total_count) || 0;
      comments = (post.comments && post.comments.summary && post.comments.summary.total_count) || 0;
    } catch (e) {
      functions.logger.warn('FB likes/comments', postId, e.message);
    }

    const insightMetrics = mediaType === 'video'
      ? ['post_video_views', 'post_impressions', 'post_media_view']
      : ['post_impressions', 'post_media_view'];
    for (let i = 0; i < insightMetrics.length && views === 0; i++) {
      try {
        const ins = await graphRequest(postId + '/insights', token, {
          method: 'GET',
          body: { metric: insightMetrics[i], period: 'lifetime' }
        });
        if (ins.data && ins.data[0] && ins.data[0].values && ins.data[0].values[0]) {
          views = Number(ins.data[0].values[0].value) || 0;
        }
      } catch (e) {
        functions.logger.warn('FB insight ' + insightMetrics[i], postId, e.message);
      }
    }

    if (mediaType === 'video') {
      try {
        const vins = await graphRequest(postId + '/insights', token, {
          method: 'GET',
          body: { metric: 'post_video_views', period: 'lifetime' }
        });
        if (vins.data && vins.data[0] && vins.data[0].values && vins.data[0].values[0]) {
          videoPlays = Number(vins.data[0].values[0].value) || views;
        } else {
          videoPlays = views;
        }
      } catch (e) {
        videoPlays = views;
      }
    }
  }

  const geoByCountry = fbStatus.exists
    ? await fetchGeoByCountry(postId, token, mediaType)
    : {};

  return {
    views: views,
    likes: likes,
    comments: comments,
    videoPlays: videoPlays,
    geoByCountry: geoByCountry,
    fbStatus: fbStatus
  };
}

async function appendWalletLedger(uid, entry) {
  if (!uid || !entry) return;
  const ref = db.ref('nexus/users/' + uid + '/creatorMarket/walletLedger').push();
  await ref.set(entry);
  await db.ref('nexus/users/' + uid + '/creatorMarket').update({
    lastWalletEntry: entry,
    lastWalletAt: entry.createdAt || Date.now()
  });
}

async function recordEarningsDelta(uid, publication, prevAmount, newAmount, metrics, mediaType) {
  const delta = Math.round((newAmount - prevAmount) * 100) / 100;
  if (delta <= 0) return;
  const isVideo = mediaType === 'video';
  const metricVal = isVideo ? (metrics.videoPlays || metrics.views || 0) : (metrics.views || 0);
  const unit = isVideo ? 'reproducciones' : 'vistas';
  await appendWalletLedger(uid, {
    type: isVideo ? 'video_plays' : 'views',
    amount: delta,
    currency: 'USD',
    tokens: 0,
    reason: '+' + delta.toFixed(2) + ' USD por ' + metricVal.toLocaleString() + ' ' + unit + ' en "' + (publication.title || 'Publicación') + '"',
    publicationId: publication.id || null,
    publicationTitle: publication.title || null,
    metricsSnapshot: {
      views: metrics.views || 0,
      videoPlays: metrics.videoPlays || 0
    },
    createdAt: Date.now()
  });
}

async function recordReferralReward(referrerUid, newUid, nick) {
  const cmSnap = await db.ref('nexus/users/' + referrerUid + '/creatorMarket').once('value');
  const cm = cmSnap.val() || {};
  if (cm.applicationStatus !== 'approved') return;
  const ledgerSnap = await db.ref('nexus/users/' + referrerUid + '/creatorMarket/walletLedger')
    .orderByChild('referralUid').equalTo(newUid).limitToFirst(1).once('value');
  if (ledgerSnap.exists()) return;

  await appendWalletLedger(referrerUid, {
    type: 'referral',
    amount: CREATOR_RATES.referralUsd,
    currency: 'USD',
    tokens: CREATOR_RATES.referralTokens,
    reason: '+$' + CREATOR_RATES.referralUsd.toFixed(2) + ' y +' + CREATOR_RATES.referralTokens + ' tokens por referido registrado: ' + (nick || newUid),
    referralUid: newUid,
    createdAt: Date.now()
  });

  const userRef = db.ref('users/' + referrerUid);
  await userRef.child('tokens').transaction(function (cur) {
    return (Number(cur) || 0) + CREATOR_RATES.referralTokens;
  });
  await userRef.child('creatorMarketReferralCount').transaction(function (cur) {
    return (Number(cur) || 0) + 1;
  });
  await updateCreatorEarnings(referrerUid);
  await notifyUser(referrerUid, 'Creator Market: +' + CREATOR_RATES.referralUsd + ' USD y +' + CREATOR_RATES.referralTokens + ' tokens por nuevo referido.', 'fa-user-plus');
}

async function notifyUser(uid, text, icon) {
  return db.ref('users/' + uid + '/notifications').push({
    text: text,
    icon: icon || 'fa-store',
    timestamp: Date.now(),
    read: false,
    type: 'creator_market'
  });
}

async function updateCreatorEarnings(uid) {
  if (!uid) return;
  let ledgerPending = 0;
  let ledgerPaid = 0;
  const ledgerSnap = await db.ref('nexus/users/' + uid + '/creatorMarket/walletLedger').once('value');
  ledgerSnap.forEach(function (ch) {
    const e = ch.val() || {};
    const amt = Number(e.amount) || 0;
    if (e.paid) ledgerPaid += amt;
    else ledgerPending += amt;
  });
  await db.ref('nexus/users/' + uid + '/creatorMarket').update({
    totalEarnings: Math.round((ledgerPaid + ledgerPending) * 100) / 100,
    pendingEarnings: Math.round(ledgerPending * 100) / 100,
    paidEarnings: Math.round(ledgerPaid * 100) / 100
  });
}

exports.publishCreatorContent = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  await assertCommander(context.auth.uid);

  const uid = String((data && data.uid) || '').trim();
  const submissionId = String((data && data.submissionId) || '').trim();
  if (!uid || !submissionId) {
    throw new functions.https.HttpsError('invalid-argument', 'uid y submissionId son obligatorios.');
  }

  const cfg = await getFacebookConfig();
  const token = cfg.facebookPageAccessToken;
  const pageId = String(cfg.facebookPageId || '').trim();
  if (!isValidFacebookPageId(pageId)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Page ID inválido. Debe ser el número de la página desde me/accounts, no 0.'
    );
  }

  const subRef = db.ref('nexus/users/' + uid + '/mercadoSubmissions/' + submissionId);
  const subSnap = await subRef.once('value');
  const sub = subSnap.val();
  if (!sub) {
    throw new functions.https.HttpsError('not-found', 'Envío no encontrado.');
  }
  if (sub.status && sub.status !== 'pending') {
    throw new functions.https.HttpsError('failed-precondition', 'Este envío ya fue procesado.');
  }

  let message = String(sub.caption || '').trim();
  const title = String(sub.title || '').trim();
  const mediaUrl = sub.mediaUrl && /^https?:\/\//i.test(sub.mediaUrl) ? sub.mediaUrl : null;
  const mediaType = sub.mediaType || (sub.contentType && String(sub.contentType).indexOf('video') === 0 ? 'video' : 'image');

  if (!message && !title && !mediaUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'El envío no tiene contenido para publicar.');
  }

  let postId;
  let postUrl;
  try {
    if (mediaUrl && mediaType === 'video') {
      const videoBody = {
        file_url: mediaUrl,
        description: message || title,
        title: title || 'StudiosGamesRS'
      };
      const created = await graphRequest(pageId + '/videos', token, { method: 'POST', body: videoBody });
      postId = created.id;
    } else if (mediaUrl && mediaType === 'image') {
      const photoBody = {
        url: mediaUrl,
        caption: message || title
      };
      const created = await graphRequest(pageId + '/photos', token, { method: 'POST', body: photoBody });
      postId = created.post_id || created.id;
    } else {
      const feedBody = { message: message || title };
      if (mediaUrl) feedBody.link = mediaUrl;
      const created = await graphRequest(pageId + '/feed', token, { method: 'POST', body: feedBody });
      postId = created.id;
    }

    if (!postId) throw new Error('Facebook no devolvió ID de publicación.');
    const permalink = await graphRequest(postId, token, {
      method: 'GET',
      body: { fields: 'permalink_url' }
    });
    postUrl = permalink.permalink_url || ('https://www.facebook.com/' + String(postId).replace('_', '/posts/'));
  } catch (e) {
    functions.logger.error('publishCreatorContent FB', e);
    throw new functions.https.HttpsError('internal', 'No se pudo publicar en Facebook: ' + formatFacebookError(e));
  }

  const metrics = await fetchPostMetrics(postId, token, mediaType);
  const now = Date.now();
  const earnings = calcPublicationEarnings(mediaType, metrics);

  const pubRef = db.ref('creatorMarket/publications').push();
  await pubRef.set({
    authorUid: uid,
    authorNick: sub.authorName || uid,
    title: sub.title || 'Publicación',
    caption: sub.caption || '',
    mediaUrl: sub.mediaUrl || null,
    mediaType: sub.mediaType || null,
    storagePath: sub.storagePath || null,
    insightScore: sub.insightScore != null ? sub.insightScore : null,
    submissionId: submissionId,
    submissionPath: 'nexus/users/' + uid + '/mercadoSubmissions/' + submissionId,
    facebookPostId: postId,
    facebookPostUrl: postUrl,
    status: 'live',
    publishedAt: now,
    createdAt: now,
    publishedByUid: context.auth.uid,
    metrics: {
      views: metrics.views,
      likes: metrics.likes,
      comments: metrics.comments,
      videoPlays: metrics.videoPlays || 0,
      geoByCountry: metrics.geoByCountry || {},
      fbLive: metrics.fbStatus && metrics.fbStatus.exists && metrics.fbStatus.isPublished !== false,
      lastUpdatedAt: now,
      scanStatus: 'facebook_api'
    },
    earnings: {
      amount: earnings,
      currency: 'USD',
      status: 'pending',
      calculatedAt: now
    }
  });

  await subRef.update({
    status: 'published',
    publicationId: pubRef.key,
    facebookPostId: postId,
    facebookPostUrl: postUrl,
    publishedAt: now
  });

  await db.ref('creatorMarket/submissionQueue/' + uid + '/' + submissionId).remove().catch(function () {});

  if (earnings > 0) {
    await appendWalletLedger(uid, {
      type: mediaType === 'video' ? 'video_plays' : 'views',
      amount: earnings,
      currency: 'USD',
      tokens: 0,
      reason: 'Publicación inicial en Facebook: "' + (sub.title || 'Contenido') + '"',
      publicationId: pubRef.key,
      publicationTitle: sub.title || null,
      metricsSnapshot: { views: metrics.views, videoPlays: metrics.videoPlays },
      createdAt: now
    });
  }
  await updateCreatorEarnings(uid);
  await notifyUser(
    uid,
    '¡Tu contenido fue publicado en Facebook! Revisa métricas y comparte el enlace en Creator Market.',
    'fa-store'
  );

  return {
    ok: true,
    publicationId: pubRef.key,
    facebookPostId: postId,
    facebookPostUrl: postUrl,
    metrics: metrics,
    earnings: earnings
  };
});

exports.rejectCreatorContent = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  await assertCommander(context.auth.uid);

  const uid = String((data && data.uid) || '').trim();
  const submissionId = String((data && data.submissionId) || '').trim();
  const note = String((data && data.note) || '').trim() || 'Contenido no aprobado.';
  if (!uid || !submissionId) {
    throw new functions.https.HttpsError('invalid-argument', 'uid y submissionId son obligatorios.');
  }

  const subRef = db.ref('nexus/users/' + uid + '/mercadoSubmissions/' + submissionId);
  const subSnap = await subRef.once('value');
  if (!subSnap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Envío no encontrado.');
  }

  await subRef.update({
    status: 'rejected',
    rejectedAt: Date.now(),
    reviewNote: note
  });
  await db.ref('creatorMarket/submissionQueue/' + uid + '/' + submissionId).remove().catch(function () {});
  await notifyUser(uid, 'Creator Market: tu envío no fue aprobado. ' + note, 'fa-store');

  return { ok: true };
});

exports.syncCreatorMarketMetrics = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  await assertCommander(context.auth.uid);
  const result = await runSyncAllPublicationMetrics(context.auth.uid, null);
  return result;
});

async function assertApprovedCreator(uid) {
  const snap = await db.ref('nexus/users/' + uid + '/creatorMarket/applicationStatus').once('value');
  if (snap.val() !== 'approved') {
    throw new functions.https.HttpsError('permission-denied', 'Solo creadores aprobados pueden actualizar métricas.');
  }
}

async function runSyncAllPublicationMetrics(scanByUid, authorUidFilter) {
  const cfg = await getFacebookConfig();
  const token = cfg.facebookPageAccessToken;
  const snap = await db.ref('creatorMarket/publications').once('value');
  const pubs = snap.val() || {};
  const ids = Object.keys(pubs).filter(function (id) {
    const p = pubs[id];
    if (!p.facebookPostId || p.status === 'closed') return false;
    if (authorUidFilter && p.authorUid !== authorUidFilter) return false;
    return true;
  });

  if (!ids.length) {
    return { ok: true, updated: 0, message: 'No hay publicaciones activas para actualizar.' };
  }

  const now = Date.now();
  const batch = {};
  let updated = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const p = pubs[id];
    const mediaType = p.mediaType || 'image';
    const prevAmount = Number(p.earnings && p.earnings.amount) || 0;
    try {
      const metrics = await fetchPostMetrics(p.facebookPostId, token, mediaType);
      const earn = calcPublicationEarnings(mediaType, metrics);
      const isLiveOnFb = metrics.fbStatus && metrics.fbStatus.exists && metrics.fbStatus.isPublished !== false;
      batch[id + '/metrics'] = {
        views: metrics.views,
        likes: metrics.likes,
        comments: metrics.comments,
        videoPlays: metrics.videoPlays || 0,
        geoByCountry: metrics.geoByCountry || {},
        fbLive: isLiveOnFb,
        lastUpdatedAt: now,
        scanStatus: 'facebook_api'
      };
      batch[id + '/earnings'] = {
        amount: earn,
        currency: 'USD',
        status: (p.earnings && p.earnings.status) || 'pending',
        calculatedAt: now
      };
      if (!isLiveOnFb) {
        batch[id + '/status'] = 'removed';
        batch[id + '/removedAt'] = now;
      } else if (p.status === 'removed') {
        batch[id + '/status'] = 'live';
      }
      updated++;
      if (p.authorUid) {
        await recordEarningsDelta(p.authorUid, { id: id, title: p.title }, prevAmount, earn, metrics, mediaType);
        await updateCreatorEarnings(p.authorUid);
      }
    } catch (e) {
      functions.logger.warn('sync metrics', id, e.message);
    }
  }

  if (Object.keys(batch).length) {
    await db.ref('creatorMarket/publications').update(batch);
  }
  if (scanByUid) {
    await db.ref('creatorMarket/config').update({
      lastScanAt: now,
      lastScanBy: scanByUid,
      lastScanCount: updated
    });
  } else {
    await db.ref('creatorMarket/config').update({
      lastScanAt: now,
      lastScanCount: updated
    });
  }

  return { ok: true, updated: updated };
}

exports.refreshMyCreatorMarketMetrics = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  await assertApprovedCreator(context.auth.uid);
  return runSyncAllPublicationMetrics(context.auth.uid, context.auth.uid);
});

exports.syncCreatorMarketMetricsScheduled = functions.pubsub
  .schedule('every 10 minutes')
  .onRun(async function () {
    try {
      await runSyncAllPublicationMetrics(null, null);
    } catch (e) {
      functions.logger.warn('scheduled sync', e.message);
    }
    return null;
  });

exports.validateCreatorMarketFacebook = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  await assertCommander(context.auth.uid);

  const cfg = await getFacebookConfig();
  const token = cfg.facebookPageAccessToken;
  const pageId = cfg.facebookPageId;
  const required = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
  const report = {
    ok: false,
    pageId: pageId,
    pageName: null,
    scopes: [],
    missing: required.slice(),
    hints: []
  };

  try {
    const page = await graphRequest(pageId, token, {
      method: 'GET',
      body: { fields: 'id,name' }
    });
    report.pageName = page.name || null;
  } catch (e) {
    report.hints.push('No se pudo leer la página con este token: ' + formatFacebookError(e));
    return report;
  }

  try {
    const scopes = await debugTokenScopes(token, cfg.facebookAppId, cfg.facebookAppSecret);
    if (scopes && scopes.length) {
      report.scopes = scopes;
      report.missing = required.filter(function (p) { return scopes.indexOf(p) < 0; });
      report.ok = report.missing.length === 0;
      if (report.missing.length) {
        report.hints.push('Faltan permisos en el token: ' + report.missing.join(', '));
        report.hints.push('Graph API Explorer → Generar token → marca pages_manage_posts, pages_read_engagement, pages_show_list → GET me/accounts → copia el access_token de la PÁGINA.');
      } else {
        report.hints.push('Token OK para publicar (permisos requeridos presentes).');
      }
    } else {
      report.hints.push('La página es legible. Para ver permisos exactos, guarda también App ID y App Secret de Meta abajo y vuelve a probar.');
      report.hints.push('Si al publicar falla con (#200) pages_manage_posts, regenera el token con ese permiso marcado.');
    }
  } catch (e) {
    report.hints.push('No se pudo inspeccionar permisos: ' + e.message);
  }

  return report;
});

exports.connectFacebookPagePermanent = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  await assertCommander(context.auth.uid);

  const cfgSnap = await db.ref('creatorMarket/config').once('value');
  const cfg = cfgSnap.val() || {};
  const appId = String((data && data.appId) || cfg.facebookAppId || '').trim();
  const appSecret = String((data && data.appSecret) || cfg.facebookAppSecret || '').trim();
  const pageId = String((data && data.pageId) || cfg.facebookPageId || '').trim();
  const userToken = String((data && data.userToken) || '').trim();

  if (!appId || !appSecret || !pageId || !userToken) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Necesitas App ID, App Secret, Page ID y token de USUARIO (corto) del Graph API Explorer con permisos de página.'
    );
  }

  let longLivedUserToken;
  try {
    const exchange = await graphRequest('oauth/access_token', '', {
      method: 'GET',
      body: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: userToken
      }
    });
    longLivedUserToken = exchange.access_token;
    if (!longLivedUserToken) throw new Error('Meta no devolvió token de larga duración.');
  } catch (e) {
    throw new functions.https.HttpsError('internal', 'Error al intercambiar token: ' + e.message);
  }

  let pageToken = null;
  let pageName = null;
  try {
    const accounts = await graphRequest('me/accounts', longLivedUserToken, { method: 'GET' });
    const list = accounts.data || [];
    const match = list.find(function (p) { return String(p.id) === pageId; }) || list[0];
    if (!match || !match.access_token) {
      throw new Error('No se encontró la página en me/accounts. Verifica Page ID y permisos.');
    }
    pageToken = match.access_token;
    pageName = match.name || null;
  } catch (e) {
    throw new functions.https.HttpsError('internal', 'Error obteniendo token de página: ' + e.message);
  }

  const now = Date.now();
  await db.ref('creatorMarket/config').update({
    facebookAppId: appId,
    facebookAppSecret: appSecret,
    facebookPageId: pageId,
    facebookPageAccessToken: pageToken,
    facebookPageName: pageName,
    facebookTokenType: 'page_permanent',
    facebookTokenUpdatedAt: now,
    facebookTokenExpiresAt: null
  });

  return {
    ok: true,
    pageName: pageName,
    message: 'Token de página guardado. Los tokens de página obtenidos así no expiran mientras no cambies la contraseña de Facebook ni revoques permisos.'
  };
});

exports.onCreatorReferralRegistered = functions.database
  .ref('users/{referrerUid}/referrals/{newUid}')
  .onCreate(async (snap, context) => {
    const referrerUid = context.params.referrerUid;
    const newUid = context.params.newUid;
    const val = snap.val() || {};
    try {
      await recordReferralReward(referrerUid, newUid, val.nick || val.displayName || newUid);
    } catch (e) {
      functions.logger.warn('referral reward', referrerUid, e.message);
    }
    return null;
  });

exports.listCreatorPendingPayouts = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  await assertBossOfTheState(context.auth.uid);

  const appsSnap = await db.ref('nexus/creatorApplications').once('value');
  const apps = appsSnap.val() || {};
  const items = [];

  await Promise.all(Object.keys(apps).map(async function (uid) {
    if ((apps[uid] && apps[uid].status) !== 'approved') return;
    const ledgerSnap = await db.ref('nexus/users/' + uid + '/creatorMarket/walletLedger').once('value');
    ledgerSnap.forEach(function (ch) {
      const e = ch.val() || {};
      if (e.paid) return;
      items.push({
        uid: uid,
        nick: (apps[uid] && apps[uid].nick) || uid,
        ledgerId: ch.key,
        amount: Number(e.amount) || 0,
        tokens: Number(e.tokens) || 0,
        reason: e.reason || null,
        type: e.type || null,
        publicationId: e.publicationId || null,
        publicationTitle: e.publicationTitle || null,
        createdAt: e.createdAt || null
      });
    });
  }));

  items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  return { items: items };
});

exports.approveCreatorPayout = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesión.');
  }
  await assertBossOfTheState(context.auth.uid);

  const uid = String((data && data.uid) || '').trim();
  const ledgerId = String((data && data.ledgerId) || '').trim();
  if (!uid || !ledgerId) {
    throw new functions.https.HttpsError('invalid-argument', 'uid y ledgerId son obligatorios.');
  }

  const ref = db.ref('nexus/users/' + uid + '/creatorMarket/walletLedger/' + ledgerId);
  const snap = await ref.once('value');
  if (!snap.exists()) {
    throw new functions.https.HttpsError('not-found', 'Movimiento no encontrado.');
  }
  const entry = snap.val() || {};
  if (entry.paid) {
    return { ok: true, alreadyPaid: true };
  }

  await ref.update({
    paid: true,
    paidAt: Date.now(),
    paidBy: context.auth.uid
  });
  await updateCreatorEarnings(uid);
  if (entry.publicationId) {
    await maybeMarkPublicationEarningsPaid(uid, entry.publicationId);
  }
  const amt = Number(entry.amount) || 0;
  await notifyUser(
    uid,
    'Creator Market: ingreso verificado' + (amt > 0 ? (' ($' + amt.toFixed(2) + ')') : '') + '.',
    'fa-check-circle'
  );
  return { ok: true };
});
