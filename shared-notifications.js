/**
 * Notificaciones unificadas — TODAS las páginas StudiosGamesRS
 * Fuentes: sistema, amistad, chat privado, misiones, Creator Market, equipo, chats, partidas, visitas
 */
(function() {
  'use strict';

  var SECTION_ORDER = ['Creator Market', 'Social', 'Mensajes', 'Misiones', 'Sistema', 'Visitas'];

  var state = {
    uid: null,
    notifications: {},
    friendRequests: {},
    missionInvites: {},
    privateChatRequests: {},
    creatorApp: null,
    userData: null,
    dynamic: [],
    attached: false,
    refreshing: false,
    panelWasOpen: false,
    // Claves ya vistas al abrir la campana (persistidas en localStorage).
    ack: {},
    // Para toasts en vivo: claves ya vistas (evita spam al montar listeners)
    seenFriendKeys: null,
    seenMissionKeys: null,
    seenChatReqKeys: null,
    seenNotifKeys: null,
    // Mensajes privados uno a uno
    pmAttached: false,
    pmMountAt: 0,
    pmRooms: {},
    pmUnread: {},
    pmSeen: {},
    pmToasted: {},
    pmActivePartner: null,
    pmLinksRef: null,
    pmLinksHandler: null
  };

  // Cola de mensajes que se lee por sala: nunca se descarga el historial entero.
  var PM_TAIL = 6;
  // Al montar los listeners solo se avisa de lo llegado en esta ventana.
  var PM_FRESH_MS = 2 * 60 * 1000;
  // Memoria de mensajes ya avisados, para no repetir el aviso al cambiar de página.
  var PM_TOAST_MEMORY_MS = 45 * 60 * 1000;
  var PM_DEFAULT_AVATAR = '/dragon_profile_studiosgamesrs.png';

  function getSeen() {
    var ud = state.userData || {};
    return ud.notificationSeen || {};
  }

  function isFriendUnread(uid) {
    var seen = getSeen().friends || {};
    return !seen[uid];
  }

  function isMissionInviteUnread(mid) {
    var seen = getSeen().missionInvites || {};
    return !seen[mid];
  }

  function isPrivateChatUnread(uid) {
    var seen = getSeen().privateChat || {};
    return !seen[uid];
  }

  // Todo lo que sale de aquí acaba dentro de HTML, a veces como valor de un
  // atributo: las comillas también se escapan (los nicks los eligen los jugadores).
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parseTime(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      var n = Date.parse(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = typeof ts === 'number' ? new Date(ts) : new Date();
    return d.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function getDb() {
    return (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
  }

  // ---------------------------------------------------------------------------
  // Mensajes privados uno a uno (privateChats/{roomId}/messages)
  // ---------------------------------------------------------------------------

  function pmRoomId(partnerUid) {
    if (!state.uid || !partnerUid || partnerUid === state.uid) return null;
    return [state.uid, partnerUid].sort().join('_');
  }

  function pmSeenStorageKey() {
    return 'sgPmSeen_' + (state.uid || 'anon');
  }

  function pmToastedStorageKey() {
    return 'sgPmToasted_' + (state.uid || 'anon');
  }

  function pmLoadSeen() {
    try {
      var raw = localStorage.getItem(pmSeenStorageKey());
      state.pmSeen = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      state.pmSeen = {};
    }
  }

  function pmSaveSeen() {
    try { localStorage.setItem(pmSeenStorageKey(), JSON.stringify(state.pmSeen || {})); } catch (e) {}
  }

  function pmLoadToasted() {
    try {
      var raw = localStorage.getItem(pmToastedStorageKey());
      state.pmToasted = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      state.pmToasted = {};
    }
    var cut = Date.now() - PM_TOAST_MEMORY_MS;
    Object.keys(state.pmToasted).forEach(function(k) {
      if (!(parseTime(state.pmToasted[k]) > cut)) delete state.pmToasted[k];
    });
  }

  function pmSaveToasted() {
    try { localStorage.setItem(pmToastedStorageKey(), JSON.stringify(state.pmToasted || {})); } catch (e) {}
  }

  /** Marca de último leído de la sala: el espejo local y el de la base, lo más nuevo. */
  function pmSeenAt(roomId) {
    var local = parseTime((state.pmSeen || {})[roomId]);
    var remote = parseTime((getSeen().privateChats || {})[roomId]);
    return local > remote ? local : remote;
  }

  function pmSafePhoto(url) {
    var s = url == null ? '' : String(url);
    if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
    if (/^\/?[\w\-./]+\.(png|jpe?g|gif|webp|svg)$/i.test(s)) return s;
    return PM_DEFAULT_AVATAR;
  }

  function pmExcerpt(msg) {
    var text = msg && msg.text != null ? String(msg.text) : '';
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) {
      if (msg && (msg.imageUrl || msg.type === 'image')) return 'Te ha enviado una imagen';
      return 'Nuevo mensaje';
    }
    return text.length > 90 ? text.slice(0, 90) + '…' : text;
  }

  function pmRoomCount(room) {
    return room && room.msgs ? Object.keys(room.msgs).length : 0;
  }

  function countUnread() {
    var unread = Object.keys(state.notifications).filter(function(id) {
      var n = state.notifications[id];
      return n && !n.read;
    }).length;
    // Las invitaciones cuentan mientras sigan pendientes de aceptar o rechazar.
    var friends = Object.keys(state.friendRequests).length;
    var missions = Object.keys(state.missionInvites).length;
    var chats = Object.keys(state.privateChatRequests).length;
    var privateMessages = 0;
    Object.keys(state.pmUnread).forEach(function(roomId) {
      var room = state.pmUnread[roomId];
      if (room && !room.acked) privateMessages += pmRoomCount(room);
    });
    var dynamic = state.dynamic.filter(function(d) { return d.unread; }).length;
    var creatorPending = 0;
    if (state.creatorApp && state.creatorApp.status === 'pending') {
      var seenCreator = getSeen().creatorMarket;
      var dup = Object.keys(state.notifications).some(function(id) {
        var n = state.notifications[id];
        return n && n.type === 'creator_market' && !n.read;
      });
      creatorPending = (!seenCreator && !dup) ? 1 : 0;
    }
    return unread + friends + missions + chats + privateMessages + dynamic + creatorPending;
  }

  // ---------------------------------------------------------------------------
  // Punto rojo de la campana
  // ---------------------------------------------------------------------------
  // El punto se dibuja con un elemento propio y estilos inyectados desde aquí,
  // para no depender del CSS ni del <span> de cada página (cada header tenía su
  // propia versión del badge y unas reglas lo ocultaban).
  //
  // Qué se considera "nuevo": cada pendiente tiene una clave; las claves que el
  // usuario ya vio al abrir la campana quedan guardadas en localStorage. Así el
  // punto sobrevive a cambiar de página y no reaparece hasta que llegue algo que
  // no estaba en esa lista.

  /** Claves de todo lo que está pendiente ahora mismo. */
  function currentKeys() {
    var keys = [];
    Object.keys(state.notifications).forEach(function(id) {
      var n = state.notifications[id];
      if (n && !n.read) keys.push('notif:' + id);
    });
    Object.keys(state.friendRequests).forEach(function(uid) { keys.push('friend:' + uid); });
    Object.keys(state.privateChatRequests).forEach(function(uid) { keys.push('chat:' + uid); });
    Object.keys(state.missionInvites).forEach(function(mid) { keys.push('mission:' + mid); });
    // Una clave por mensaje: así el punto vuelve a encenderse con cada mensaje
    // nuevo de la misma conversación, no solo con la primera.
    Object.keys(state.pmUnread).forEach(function(roomId) {
      var room = state.pmUnread[roomId];
      if (!room || !room.msgs) return;
      Object.keys(room.msgs).forEach(function(msgId) { keys.push('pm:' + roomId + ':' + msgId); });
    });
    state.dynamic.forEach(function(d) {
      if (d.unread && d.seenKey) keys.push('dyn:' + d.seenKey);
    });
    if (state.creatorApp && state.creatorApp.status === 'pending' && !getSeen().creatorMarket) {
      keys.push('creator');
    }
    return keys;
  }

  function ackStorageKey() {
    return 'sgNotifAck_' + (state.uid || 'anon');
  }

  function loadAck() {
    try {
      var raw = localStorage.getItem(ackStorageKey());
      state.ack = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) {
      state.ack = {};
    }
  }

  function saveAck() {
    try { localStorage.setItem(ackStorageKey(), JSON.stringify(state.ack || {})); } catch (e) {}
  }

  /** Marca como vistas todas las pendientes actuales (al abrir la campana). */
  function ackAll() {
    var ack = {};
    currentKeys().forEach(function(k) { ack[k] = 1; });
    state.ack = ack;
    saveAck();
  }

  function hasUnseen() {
    var ack = state.ack || {};
    return currentKeys().some(function(k) { return !ack[k]; });
  }

  function ensureDotStyles() {
    if (document.getElementById('sgNotifDotStyles')) return;
    var style = document.createElement('style');
    style.id = 'sgNotifDotStyles';
    style.textContent =
      '@keyframes sgNotifDotPulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(229,57,53,.55),0 0 8px rgba(229,57,53,.7)}' +
      '50%{transform:scale(1.2);box-shadow:0 0 0 5px rgba(229,57,53,0),0 0 14px rgba(229,57,53,.95)}}' +
      '@keyframes sgNotifBellShake{0%,100%{transform:rotate(0)}20%{transform:rotate(14deg)}40%{transform:rotate(-12deg)}' +
      '60%{transform:rotate(8deg)}80%{transform:rotate(-6deg)}}' +
      '#sgNotifDot.is-on{display:block!important;animation:sgNotifDotPulse 1.5s ease-in-out infinite}' +
      '#notificationsToggleBtn.notif-bell-pulse > i{animation:sgNotifBellShake .7s ease}';
    document.head.appendChild(style);
  }

  function ensureDot() {
    ensureDotStyles();
    var toggle = document.getElementById('notificationsToggleBtn');
    if (!toggle) return null;

    // El <span> heredado de cada header queda fuera de juego: lo maneja este módulo.
    var legacy = document.getElementById('headerNotifBadge');
    if (legacy) {
      legacy.style.setProperty('display', 'none', 'important');
      legacy.textContent = '';
    }

    var wrap = toggle.closest('.header-notifications-wrap') || toggle.parentNode;
    if (wrap && wrap.style) {
      wrap.style.setProperty('overflow', 'visible', 'important');
    }
    toggle.style.setProperty('position', 'relative', 'important');
    toggle.style.setProperty('overflow', 'visible', 'important');

    var dot = document.getElementById('sgNotifDot');
    if (dot && dot.parentNode === toggle) return dot;
    if (dot && dot.parentNode) dot.parentNode.removeChild(dot);

    dot = document.createElement('span');
    dot.id = 'sgNotifDot';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.cssText = [
      'position:absolute', 'top:-4px', 'right:-4px', 'min-width:12px', 'height:12px',
      'padding:0', 'box-sizing:border-box', 'border-radius:999px', 'background:#e53935',
      'border:2px solid rgba(10,12,15,0.95)', 'color:#fff', 'font-size:9px', 'font-weight:800',
      'line-height:8px', 'text-align:center', 'z-index:2147483000', 'pointer-events:none',
      'display:none'
    ].join(';') + ';';
    toggle.appendChild(dot);
    return dot;
  }

  /** Enciende el punto rojo de la campana (tiempo real) y agita la campanita. */
  function pulseAlert() {
    updateBadge();
    var toggle = document.getElementById('notificationsToggleBtn');
    if (toggle) {
      toggle.classList.remove('notif-bell-pulse');
      void toggle.offsetWidth; // reinicia la animación
      toggle.classList.add('notif-bell-pulse');
      setTimeout(function() { toggle.classList.remove('notif-bell-pulse'); }, 1200);
    }
  }

  function setNested(obj, keys, val) {
    var cur = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = val;
  }

  function mergeSeenFromUpdates(updates) {
    if (!state.uid) return;
    var prefix = 'users/' + state.uid + '/notificationSeen/';
    if (!state.userData) state.userData = {};
    if (!state.userData.notificationSeen) state.userData.notificationSeen = {};
    Object.keys(updates).forEach(function(path) {
      if (path.indexOf(prefix) !== 0) return;
      var rel = path.slice(prefix.length);
      if (!rel) return;
      setNested(state.userData.notificationSeen, rel.split('/'), updates[path]);
    });
  }

  async function markAsReviewed() {
    if (!state.uid) return;
    var db = getDb();
    if (!db) return;
    var uid = state.uid;
    var now = Date.now();
    var updates = {};
    var seen = getSeen();

    Object.keys(state.notifications).forEach(function(id) {
      var n = state.notifications[id];
      if (n && !n.read) {
        updates['users/' + uid + '/notifications/' + id + '/read'] = true;
        n.read = true;
      }
    });

    Object.keys(state.friendRequests).forEach(function(senderUid) {
      updates['users/' + uid + '/notificationSeen/friends/' + senderUid] = now;
    });

    Object.keys(state.missionInvites).forEach(function(missionId) {
      updates['users/' + uid + '/notificationSeen/missionInvites/' + missionId] = now;
    });

    Object.keys(state.privateChatRequests).forEach(function(senderUid) {
      updates['users/' + uid + '/notificationSeen/privateChat/' + senderUid] = now;
    });

    // Las conversaciones quedan por leídas, pero sus entradas siguen visibles en
    // el panel que el jugador acaba de abrir.
    Object.keys(state.pmUnread).forEach(function(roomId) {
      var pmAt = Math.max(now, state.pmUnread[roomId].lastTs || 0);
      updates['users/' + uid + '/notificationSeen/privateChats/' + roomId] = pmAt;
      state.pmSeen[roomId] = pmAt;
      state.pmUnread[roomId].acked = true;
    });
    pmSaveSeen();

    if (state.creatorApp && state.creatorApp.status === 'pending') {
      updates['users/' + uid + '/notificationSeen/creatorMarket'] = now;
    }

    try {
      var teamSnap = await db.ref('teamInvites/' + uid).once('value');
      updates['users/' + uid + '/notificationSeen/teamInvites/count'] = teamSnap.exists() ? teamSnap.numChildren() : 0;
      updates['users/' + uid + '/notificationSeen/teamInvites/at'] = now;
    } catch (e) {}

    try {
      var pzSnap = await db.ref('playzoneChatInvites/' + uid).once('value');
      updates['users/' + uid + '/notificationSeen/playzoneChat/count'] = pzSnap.exists() ? pzSnap.numChildren() : 0;
      updates['users/' + uid + '/notificationSeen/playzoneChat/at'] = now;
    } catch (e) {}

    var match = state.userData && state.userData.competitive && state.userData.competitive.match;
    if (match && match.opponent) {
      updates['users/' + uid + '/notificationSeen/upcomingMatch'] = String(match.time || '') + '|' + String(match.opponent || '');
    }

    state.dynamic.forEach(function(d) {
      if (!d.seenKey) return;
      updates['users/' + uid + '/notificationSeen/dynamic/' + d.seenKey] = now;
      if (d.seenKey.indexOf('mission_') === 0) {
        updates['users/' + uid + '/notificationSeen/missions/' + d.seenKey.slice(8)] = now;
      }
      if (d.seenKey.indexOf('visit_') === 0) {
        updates['users/' + uid + '/notificationSeen/visits/' + d.seenKey.slice(6)] = now;
      }
    });

    updates['users/' + uid + '/notificationSeen/lastPanelOpen'] = now;

    try {
      await db.ref().update(updates);
      mergeSeenFromUpdates(updates);
    } catch (err) {
      console.warn('SGNotifications markAsReviewed:', err);
    }

    state.dynamic.forEach(function(d) { d.unread = false; });
    await refreshDynamic();
    ackAll();
    updateBadge();
  }

  function updateBadge() {
    var dot = ensureDot();
    if (!dot) return;
    var toggle = document.getElementById('notificationsToggleBtn');
    var show = hasUnseen();
    var total = countUnread();

    if (show) {
      dot.classList.add('is-on');
      dot.style.setProperty('display', 'block', 'important');
      if (total > 1) {
        dot.textContent = total > 99 ? '99+' : String(total);
        dot.style.minWidth = '16px';
        dot.style.height = '16px';
        dot.style.lineHeight = '12px';
        dot.style.padding = '0 3px';
        dot.style.fontSize = '9px';
      } else {
        dot.textContent = '';
        dot.style.minWidth = '12px';
        dot.style.height = '12px';
        dot.style.padding = '0';
      }
      if (toggle) toggle.classList.add('has-notif-alert');
    } else {
      dot.classList.remove('is-on');
      dot.style.setProperty('display', 'none', 'important');
      dot.textContent = '';
      if (toggle) toggle.classList.remove('has-notif-alert');
    }
  }

  function itemHtml(opts) {
    var cls = 'header-notif-item' + (opts.unread ? ' unread' : '') + (opts.extraClass ? ' ' + opts.extraClass : '');
    var attrs = opts.attrs || '';
    var actions = opts.actions || '';
    var iconHtml = '';
    if (opts.icon) {
      if (String(opts.icon).indexOf('fa-') === 0) {
        iconHtml = '<i class="fas ' + esc(opts.icon) + '"></i> ';
      } else {
        iconHtml = '<span class="header-notif-emoji" aria-hidden="true">' + esc(opts.icon) + '</span> ';
      }
    }
    return '<div class="' + cls + '" ' + attrs + '>' +
      '<strong>' + iconHtml + esc(opts.title) + '</strong>' +
      '<p>' + esc(opts.text) + '</p>' +
      (opts.time ? '<span class="header-notif-time">' + esc(opts.time) + '</span>' : '') +
      actions + '</div>';
  }

  function buildItems() {
    var items = [];

    if (state.creatorApp) {
      var st = state.creatorApp.status;
      if (st === 'pending') {
        var creatorUnread = !getSeen().creatorMarket;
        items.push({ section: 'Creator Market', sort: Date.now(), unread: creatorUnread,
          html: itemHtml({ title: 'Creator Market — solicitud enviada', text: 'Tu petición está en revisión por los Commanders.',
            icon: 'fa-store', time: fmtTime(state.creatorApp.submittedAt), unread: true, extraClass: 'creator-pending',
            attrs: 'data-creator-action="open-market"' }) });
      } else if (st === 'approved') {
        items.push({ section: 'Creator Market', sort: (state.creatorApp.reviewedAt || 0) + 1e12, unread: false,
          html: itemHtml({ title: 'Creator Market — aprobado', text: 'Ya puedes publicar en Facebook y ganar por métricas.',
            icon: 'fa-check-circle', time: fmtTime(state.creatorApp.reviewedAt), extraClass: 'creator-approved',
            attrs: 'data-creator-action="open-market"' }) });
      } else if (st === 'rejected') {
        items.push({ section: 'Creator Market', sort: (state.creatorApp.reviewedAt || 0) + 5e11, unread: true,
          html: itemHtml({ title: 'Creator Market — no aprobado', text: state.creatorApp.reviewNote || 'Puedes enviar una nueva solicitud.',
            icon: 'fa-times-circle', time: fmtTime(state.creatorApp.reviewedAt), extraClass: 'creator-rejected',
            attrs: 'data-creator-action="open-market"' }) });
      }
    }

    Object.keys(state.friendRequests).forEach(function(senderUid) {
      var req = state.friendRequests[senderUid] || {};
      items.push({ section: 'Social', sort: req.timestamp || 0, unread: isFriendUnread(senderUid),
        html: itemHtml({ title: req.senderNick || 'Jugador', text: 'Solicitud de amistad' + (req.message ? ': "' + req.message + '"' : ''),
          icon: 'fa-user-plus', unread: isFriendUnread(senderUid),
          actions: '<div class="header-notif-actions">' +
            '<button type="button" class="header-notif-btn accept" data-friend-accept="' + esc(senderUid) + '">Aceptar</button>' +
            '<button type="button" class="header-notif-btn decline" data-friend-decline="' + esc(senderUid) + '">Rechazar</button></div>' }) });
    });

    Object.keys(state.privateChatRequests).forEach(function(senderUid) {
      var req = state.privateChatRequests[senderUid] || {};
      items.push({ section: 'Mensajes', sort: req.timestamp || 0, unread: isPrivateChatUnread(senderUid),
        html: itemHtml({ title: req.senderNick || 'Jugador',
          text: 'Quiere chatear en privado' + (req.initialMessage ? ': "' + String(req.initialMessage).slice(0, 80) + '"' : ''),
          icon: 'fa-comment-dots', unread: isPrivateChatUnread(senderUid),
          actions: '<div class="header-notif-actions">' +
            '<button type="button" class="header-notif-btn accept" data-chat-accept="' + esc(senderUid) + '">Aceptar</button>' +
            '<button type="button" class="header-notif-btn decline" data-chat-decline="' + esc(senderUid) + '">Rechazar</button></div>' }) });
    });

    Object.keys(state.pmUnread).forEach(function(roomId) {
      var room = state.pmUnread[roomId];
      var count = pmRoomCount(room);
      if (!count) return;
      var nick = room.nick || 'Jugador';
      var last = null;
      Object.keys(room.msgs).forEach(function(msgId) {
        var m = room.msgs[msgId];
        if (!last || (m.ts || 0) >= (last.ts || 0)) last = m;
      });
      var title = count > 1 ? (count + ' mensajes nuevos de ' + nick) : ('Mensaje nuevo de ' + nick);
      items.push({ section: 'Mensajes', sort: room.lastTs || 0, unread: !room.acked,
        html: itemHtml({ title: title, text: (last && last.text) || 'Nuevo mensaje',
          icon: 'fa-comments', time: fmtTime(room.lastTs), unread: !room.acked,
          attrs: 'data-pm-open="' + esc(room.partnerUid) + '" data-pm-nick="' + esc(nick) +
            '" data-pm-photo="' + esc(pmSafePhoto(room.photoURL)) + '"' }) });
    });

    Object.keys(state.missionInvites).forEach(function(missionId) {
      var inv = state.missionInvites[missionId] || {};
      items.push({ section: 'Misiones', sort: inv.timestamp || inv.at || Date.now(), unread: isMissionInviteUnread(missionId),
        html: itemHtml({ title: 'Invitación a misión', text: (inv.fromNick || 'Jugador') + ': ' + (inv.missionTitle || 'Misión'),
          icon: 'fa-crosshairs', unread: isMissionInviteUnread(missionId),
          actions: '<div class="header-notif-actions">' +
            '<button type="button" class="header-notif-btn accept" data-mission-open="' + esc(missionId) + '">Ver misión</button>' +
            '<button type="button" class="header-notif-btn decline" data-mission-dismiss="' + esc(missionId) + '">Cerrar</button></div>' }) });
    });

    state.dynamic.forEach(function(d) {
      items.push(d);
    });

    Object.keys(state.notifications).forEach(function(id) {
      var n = state.notifications[id];
      if (!n || !n.text) return;
      if (state.creatorApp && n.type === 'creator_market') return;
      var icon = n.icon || 'fa-bell';
      items.push({ section: 'Sistema', sort: n.timestamp || n.at || 0, unread: !n.read,
        html: itemHtml({ title: 'StudiosGamesRS', text: n.text, icon: icon, time: fmtTime(n.timestamp || n.at),
          unread: !n.read, attrs: 'data-notif-id="' + esc(id) + '"' + (n.link ? ' data-notif-link="' + esc(n.link) + '"' : '') }) });
    });

    return items;
  }

  function renderList() {
    var list = document.getElementById('headerNotificationsList');
    // El badge debe actualizarse aunque el panel aún no exista en el DOM.
    if (!list) {
      updateBadge();
      return;
    }

    var items = buildItems();
    items.sort(function(a, b) { return (b.sort || 0) - (a.sort || 0); });

    if (!items.length) {
      list.innerHTML = '<p class="header-notif-empty">No tienes notificaciones.</p>';
      updateBadge();
      return;
    }

    var grouped = {};
    items.forEach(function(it) {
      var sec = it.section || 'Sistema';
      if (!grouped[sec]) grouped[sec] = [];
      grouped[sec].push(it);
    });

    var html = '';
    SECTION_ORDER.forEach(function(sec) {
      if (!grouped[sec] || !grouped[sec].length) return;
      html += '<div class="header-notif-section">' + esc(sec) + '</div>';
      grouped[sec].forEach(function(it) { html += it.html; });
    });
    Object.keys(grouped).forEach(function(sec) {
      if (SECTION_ORDER.indexOf(sec) !== -1) return;
      html += '<div class="header-notif-section">' + esc(sec) + '</div>';
      grouped[sec].forEach(function(it) { html += it.html; });
    });

    list.innerHTML = html;
    bindItemEvents(list);
    updateBadge();
  }

  function flashFeedback(type, text) {
    if (typeof showFloatingMessage === 'function') {
      try { showFloatingMessage(type, text); return; } catch (e) {}
    }
    showLiveToast({
      icon: type === 'error' ? 'fa-exclamation-circle' : (type === 'success' ? 'fa-check-circle' : 'fa-info-circle'),
      title: type === 'error' ? 'Error' : 'StudiosGamesRS',
      text: text,
      tone: type
    });
  }

  function myProfileLite() {
    var ud = state.userData || {};
    var auth = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null;
    return {
      nick: ud.nick || ud.nickname || (auth && auth.displayName) || 'Usuario',
      photoURL: ud.photoURL || (auth && auth.photoURL) || '/dragon_profile_studiosgamesrs.png'
    };
  }

  async function acceptFriendRequestShared(senderUid) {
    var db = getDb();
    if (!db || !state.uid || !senderUid) return;
    var req = state.friendRequests[senderUid] || {};
    var me = myProfileLite();
    var ts = firebase.database.ServerValue.TIMESTAMP;
    try {
      await db.ref('sgFriends/' + state.uid + '/' + senderUid).set({
        nick: req.senderNick || 'Usuario',
        photoURL: req.senderAvatar || '/dragon_profile_studiosgamesrs.png',
        since: ts
      });
      await db.ref('sgFriends/' + senderUid + '/' + state.uid).set({
        nick: me.nick,
        photoURL: me.photoURL,
        since: ts
      });
      await db.ref('friendRequests/' + state.uid + '/' + senderUid).remove();
      flashFeedback('success', '¡Ahora son amigos!');
    } catch (err) {
      console.error('SGNotifications acceptFriend:', err);
      flashFeedback('error', 'No se pudo aceptar la solicitud.');
    }
  }

  async function declineFriendRequestShared(senderUid) {
    var db = getDb();
    if (!db || !state.uid || !senderUid) return;
    try {
      await db.ref('friendRequests/' + state.uid + '/' + senderUid).remove();
      flashFeedback('info', 'Solicitud de amistad rechazada.');
    } catch (err) {
      console.error('SGNotifications declineFriend:', err);
      flashFeedback('error', 'No se pudo rechazar la solicitud.');
    }
  }

  async function acceptPrivateChatShared(senderUid) {
    var db = getDb();
    if (!db || !state.uid || !senderUid) return;
    var req = state.privateChatRequests[senderUid] || {};
    try {
      await db.ref('privateChatRequests/' + state.uid + '/' + senderUid).remove();
      await db.ref('sgChatLinks/' + state.uid + '/' + senderUid).set(true);
      await db.ref('sgChatLinks/' + senderUid + '/' + state.uid).set(true);
      if (typeof openPrivateChat === 'function') {
        openPrivateChat(senderUid, req.senderNick || 'Jugador', req.senderAvatar || '/dragon_profile_studiosgamesrs.png');
      } else {
        flashFeedback('success', 'Chat privado aceptado. Ábrelo desde Play Zone o Dashboard.');
        // En páginas sin ventana de chat, dejamos el enlace listo y mandamos a Play Zone.
        setTimeout(function() { window.location.href = '/playzone'; }, 700);
      }
    } catch (err) {
      console.error('SGNotifications acceptChat:', err);
      flashFeedback('error', 'No se pudo aceptar el chat.');
    }
  }

  async function declinePrivateChatShared(senderUid) {
    var db = getDb();
    if (!db || !state.uid || !senderUid) return;
    try {
      await db.ref('privateChatRequests/' + state.uid + '/' + senderUid).remove();
      flashFeedback('info', 'Solicitud de chat rechazada.');
    } catch (err) {
      console.error('SGNotifications declineChat:', err);
      flashFeedback('error', 'No se pudo rechazar el chat.');
    }
  }

  async function dismissMissionInviteShared(missionId) {
    var db = getDb();
    if (!db || !state.uid || !missionId) return;
    try {
      await db.ref('missionInvites/' + state.uid + '/' + missionId).remove();
    } catch (err) {
      console.error('SGNotifications dismissMission:', err);
    }
  }

  function openMissionInviteShared(missionId) {
    dismissMissionInviteShared(missionId);
    if (typeof joinMission === 'function') {
      try { joinMission(missionId); return; } catch (e) {}
    }
    window.location.href = '/playzone?mission=' + encodeURIComponent(missionId);
  }

  /**
   * Deja la conversación por leída. Solo se llama cuando el jugador la abre de
   * verdad o al abrir la campana: que el aviso flotante se cierre por tiempo no
   * cuenta como leído.
   */
  function markPrivateChatRead(partnerUid) {
    var roomId = pmRoomId(partnerUid);
    if (!roomId) return;
    var room = state.pmUnread[roomId];
    // El reloj del navegador puede ir por detrás del servidor: la marca nunca
    // debe quedar por debajo del último mensaje ya visto.
    var now = Math.max(Date.now(), (room && room.lastTs) || 0);
    state.pmSeen[roomId] = now;
    pmSaveSeen();
    delete state.pmUnread[roomId];
    var toastEl = document.getElementById('sg-pm-toast-' + roomId);
    if (toastEl && toastEl.parentNode) toastEl.remove();
    var db = getDb();
    if (db && state.uid) {
      db.ref('users/' + state.uid + '/notificationSeen/privateChats/' + roomId).set(now).catch(function() {});
      if (!state.userData) state.userData = {};
      if (!state.userData.notificationSeen) state.userData.notificationSeen = {};
      if (!state.userData.notificationSeen.privateChats) state.userData.notificationSeen.privateChats = {};
      state.userData.notificationSeen.privateChats[roomId] = now;
    }
    renderList();
  }

  /**
   * Abre el chat privado con la función de la página actual; si no existe en
   * esta página, manda al Dashboard con ?dm={uid}, que lo abre al cargar.
   */
  function openPrivateChatShared(partnerUid, nick, photoURL) {
    if (!partnerUid) return;
    var safeNick = nick || 'Jugador';
    var safeAvatar = pmSafePhoto(photoURL);
    markPrivateChatRead(partnerUid);
    if (typeof window.openPrivateChat === 'function') {
      try { window.openPrivateChat(partnerUid, safeNick, safeAvatar); return; } catch (e) {}
    }
    if (typeof window.openDashboardPrivateChatWith === 'function') {
      try { window.openDashboardPrivateChatWith(partnerUid, safeNick); return; } catch (e) {}
    }
    window.location.href = '/dashboard?dm=' + encodeURIComponent(partnerUid);
  }

  function ensureToastHost() {
    var host = document.getElementById('sgNotifToastHost');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'sgNotifToastHost';
    host.className = 'sg-notif-toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
  }

  function showLiveToast(opts) {
    opts = opts || {};
    var host = ensureToastHost();
    var el = document.createElement('div');
    el.className = 'sg-notif-toast' + (opts.tone ? ' is-' + opts.tone : '');
    if (opts.id) el.id = opts.id;
    var icon = opts.icon || 'fa-bell';
    var iconHtml = String(icon).indexOf('fa-') === 0
      ? '<i class="fas ' + esc(icon) + '"></i>'
      : '<span>' + esc(icon) + '</span>';
    var actionsHtml = '';
    if (opts.actions && opts.actions.length) {
      actionsHtml = '<div class="sg-notif-toast-actions">' + opts.actions.map(function(a, i) {
        return '<button type="button" class="sg-notif-toast-action ' + (a.primary ? 'is-primary' : 'is-ghost') + '" data-sg-action="' + i + '">' +
          esc(a.label) + '</button>';
      }).join('') + '</div>';
    }
    el.innerHTML =
      '<div class="sg-notif-toast-icon">' + iconHtml + '</div>' +
      '<div class="sg-notif-toast-body">' +
        '<strong>' + esc(opts.title || 'Notificación') + '</strong>' +
        '<p>' + esc(opts.text || '') + '</p>' +
        actionsHtml +
      '</div>' +
      '<button type="button" class="sg-notif-toast-close" aria-label="Cerrar"><i class="fas fa-times"></i></button>';
    host.appendChild(el);
    requestAnimationFrame(function() { el.classList.add('is-in'); });

    function dismiss() {
      el.classList.remove('is-in');
      el.classList.add('is-out');
      setTimeout(function() { if (el.parentNode) el.remove(); }, 280);
    }
    el.querySelector('.sg-notif-toast-close').addEventListener('click', function(e) {
      e.stopPropagation();
      dismiss();
    });
    if (opts.actions && opts.actions.length) {
      el.querySelectorAll('[data-sg-action]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var idx = parseInt(btn.getAttribute('data-sg-action'), 10);
          var action = opts.actions[idx];
          dismiss();
          if (action && typeof action.onClick === 'function') action.onClick();
        });
      });
    } else {
      el.addEventListener('click', function() {
        dismiss();
        if (opts.onClick) opts.onClick();
        else openPanel();
      });
    }
    setTimeout(dismiss, opts.ttl || (opts.actions ? 20000 : 9000));
  }

  function ensureMissionInviteHost() {
    // En Play Zone reusamos su contenedor para que los avisos de misión y los de
    // chat se apilen en la misma columna en vez de superponerse.
    var pzHost = document.getElementById('privateChatNotificationContainer');
    if (pzHost) return pzHost;
    var host = document.getElementById('sgMissionInviteHost');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'sgMissionInviteHost';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
  }

  /**
   * Invitación a misión: el mismo aviso de Play Zone (arriba a la derecha), ahora
   * en todas las páginas. Lleva clases propias porque cada página define
   * .notification-item con su propio aspecto.
   *
   * Se cierra solo a los 4 segundos y en ese caso NO borra la invitación: sigue
   * en la campana con su punto rojo hasta que el jugador la abra o la cierre.
   */
  function showMissionInviteToast(missionId, inv) {
    inv = inv || {};
    var host = ensureMissionInviteHost();
    var toastId = 'sg-mission-invite-toast-' + missionId;
    var existing = document.getElementById(toastId);
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.id = toastId;
    el.className = 'sg-mission-invite';
    el.innerHTML =
      '<i class="fas fa-envelope"></i>' +
      '<div class="sg-mission-invite-body">' +
      '<strong>' + esc(inv.fromNick || 'Jugador') + '</strong> te invita a una misión:' +
      '<p>' + esc(inv.missionTitle || 'Misión') + '</p>' +
      '<div class="sg-mission-invite-actions">' +
      '<button type="button" class="sg-mission-invite-accept">Ver misión</button>' +
      '<button type="button" class="sg-mission-invite-dismiss">Cerrar</button>' +
      '</div></div>';
    host.appendChild(el);

    var timer = null;
    function closeToast() {
      if (timer) { clearTimeout(timer); timer = null; }
      el.classList.add('is-out');
      setTimeout(function() { if (el.parentNode) el.remove(); }, 350);
    }
    el.querySelector('.sg-mission-invite-accept').addEventListener('click', function(e) {
      e.stopPropagation();
      closeToast();
      openMissionInviteShared(missionId);
    });
    el.querySelector('.sg-mission-invite-dismiss').addEventListener('click', function(e) {
      e.stopPropagation();
      closeToast();
      dismissMissionInviteShared(missionId);
    });
    timer = setTimeout(closeToast, 4000);

    pulseAlert();
  }

  /**
   * Aviso de mensaje privado nuevo: mismo sitio y misma duración que el de
   * invitación a misión. Cerrarlo (a mano o por tiempo) no marca nada como
   * leído; el punto rojo sigue encendido hasta abrir la campana o el chat.
   */
  function showPrivateMessageToast(roomId, room, msgId) {
    if (!room || !room.msgs || !room.msgs[msgId]) return;
    var host = ensureMissionInviteHost();
    var toastId = 'sg-pm-toast-' + roomId;
    var existing = document.getElementById(toastId);
    if (existing) existing.remove();

    var nick = room.nick || 'Jugador';
    var el = document.createElement('div');
    el.id = toastId;
    el.className = 'sg-pm-toast';
    el.innerHTML =
      '<img class="sg-pm-toast-avatar" src="' + esc(pmSafePhoto(room.photoURL)) + '" alt="">' +
      '<div class="sg-pm-toast-body">' +
      '<strong>' + esc(nick) + '</strong> te ha escrito:' +
      '<p>' + esc(room.msgs[msgId].text) + '</p>' +
      '<div class="sg-pm-toast-actions">' +
      '<button type="button" class="sg-pm-toast-open">Abrir chat</button>' +
      '<button type="button" class="sg-pm-toast-dismiss">Cerrar</button>' +
      '</div></div>';
    host.appendChild(el);

    var avatar = el.querySelector('.sg-pm-toast-avatar');
    if (avatar) avatar.onerror = function() { this.onerror = null; this.src = PM_DEFAULT_AVATAR; };

    var timer = null;
    function closeToast() {
      if (timer) { clearTimeout(timer); timer = null; }
      el.classList.add('is-out');
      setTimeout(function() { if (el.parentNode) el.remove(); }, 350);
    }
    el.querySelector('.sg-pm-toast-open').addEventListener('click', function(e) {
      e.stopPropagation();
      closeToast();
      openPrivateChatShared(room.partnerUid, nick, room.photoURL);
    });
    el.querySelector('.sg-pm-toast-dismiss').addEventListener('click', function(e) {
      e.stopPropagation();
      closeToast();
    });
    timer = setTimeout(closeToast, 4000);

    pulseAlert();
  }

  function handlePrivateMessage(roomId, partnerUid, msgId, msg) {
    if (!msgId || !msg) return;
    var from = msg.userId || msg.senderUid || '';
    if (!from || from === state.uid) return;
    var ts = parseTime(msg.timestamp);
    if (ts <= pmSeenAt(roomId)) return;
    // La conversación está abierta delante del jugador: se da por leída.
    if (partnerUid && partnerUid === state.pmActivePartner) {
      markPrivateChatRead(partnerUid);
      return;
    }

    var room = state.pmUnread[roomId];
    if (!room) {
      room = state.pmUnread[roomId] = { partnerUid: partnerUid, nick: '', photoURL: '', lastTs: 0, acked: false, msgs: {} };
    }
    if (room.msgs[msgId]) return;
    room.msgs[msgId] = { ts: ts, text: pmExcerpt(msg) };
    room.acked = false;
    if (msg.nick) room.nick = String(msg.nick);
    if (msg.photoURL) room.photoURL = String(msg.photoURL);
    if (ts > room.lastTs) room.lastTs = ts;

    var fresh = ts >= (state.pmMountAt - PM_FRESH_MS) && !state.pmToasted[msgId];
    if (fresh) {
      state.pmToasted[msgId] = Date.now();
      pmSaveToasted();
      showPrivateMessageToast(roomId, room, msgId);
    }
    renderList();
  }

  function subscribePrivateRoom(partnerUid) {
    var db = getDb();
    var roomId = pmRoomId(partnerUid);
    if (!db || !roomId || state.pmRooms[roomId]) return;
    var ref = db.ref('privateChats/' + roomId + '/messages').limitToLast(PM_TAIL);
    var handler = ref.on('child_added', function(snap) {
      handlePrivateMessage(roomId, partnerUid, snap.key, snap.val());
    }, function() {});
    state.pmRooms[roomId] = { ref: ref, handler: handler, partnerUid: partnerUid };
  }

  function unsubscribePrivateRoom(roomId) {
    var room = state.pmRooms[roomId];
    if (!room) return;
    try { room.ref.off('child_added', room.handler); } catch (e) {}
    delete state.pmRooms[roomId];
  }

  function detachPrivateChatRooms() {
    Object.keys(state.pmRooms).forEach(unsubscribePrivateRoom);
    if (state.pmLinksRef && state.pmLinksHandler) {
      try { state.pmLinksRef.off('value', state.pmLinksHandler); } catch (e) {}
    }
    state.pmLinksRef = null;
    state.pmLinksHandler = null;
    state.pmAttached = false;
    state.pmUnread = {};
  }

  /**
   * Las conversaciones abiertas del usuario salen de sgChatLinks (se escribe en
   * los dos sentidos al aceptar o abrir un chat privado). Se engancha un
   * listener por sala, siempre acotado a la cola de mensajes.
   */
  function attachPrivateChatRooms(uid) {
    var db = getDb();
    if (!db || !uid || state.pmAttached) return;
    state.pmAttached = true;
    state.pmMountAt = Date.now();
    pmLoadSeen();
    pmLoadToasted();

    state.pmLinksRef = db.ref('sgChatLinks/' + uid);
    state.pmLinksHandler = function(snap) {
      var links = snap.val() || {};
      Object.keys(links).forEach(function(partnerUid) {
        if (links[partnerUid]) subscribePrivateRoom(partnerUid);
      });
      Object.keys(state.pmRooms).forEach(function(roomId) {
        var room = state.pmRooms[roomId];
        if (room && !links[room.partnerUid]) unsubscribePrivateRoom(roomId);
      });
    };
    state.pmLinksRef.on('value', state.pmLinksHandler, function() {});
  }

  function diffAndToast(kind, nextMap, prevKeyName, buildToast) {
    var nextKeys = Object.keys(nextMap || {});
    var prev = state[prevKeyName];
    if (prev === null) {
      // Primera carga: no toastear el backlog, solo registrar y pintar el punto
      // si quedó algo sin ver de una sesión anterior.
      state[prevKeyName] = {};
      nextKeys.forEach(function(k) { state[prevKeyName][k] = true; });
      updateBadge();
      return;
    }
    var arrived = false;
    nextKeys.forEach(function(k) {
      if (prev[k]) return;
      prev[k] = true;
      arrived = true;
      var toast = buildToast(k, nextMap[k] || {});
      if (toast) {
        if (toast.kind === 'mission-invite') {
          showMissionInviteToast(k, nextMap[k] || {});
        } else {
          showLiveToast(toast);
        }
      }
    });
    Object.keys(prev).forEach(function(k) {
      if (!nextMap[k]) delete prev[k];
    });
    if (arrived) pulseAlert();
    else updateBadge();
  }

  function bindItemEvents(list) {
    list.querySelectorAll('[data-notif-id]').forEach(function(el) {
      el.addEventListener('click', function() {
        var nid = el.getAttribute('data-notif-id');
        var link = el.getAttribute('data-notif-link');
        if (nid && state.uid) {
          getDb().ref('users/' + state.uid + '/notifications/' + nid).update({ read: true });
          if (state.notifications[nid]) state.notifications[nid].read = true;
          el.classList.remove('unread');
          updateBadge();
        }
        if (link) window.location.href = link;
      });
    });
    list.querySelectorAll('[data-creator-action="open-market"]').forEach(function(el) {
      el.addEventListener('click', function() {
        if (window.location.pathname.indexOf('nexus') !== -1 && typeof toggleNexusPanel === 'function') {
          toggleNexusPanel('creator-market', true);
        } else {
          window.location.href = '/nexus';
        }
      });
    });
    list.querySelectorAll('[data-mission-open]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        openMissionInviteShared(btn.getAttribute('data-mission-open'));
      });
    });
    list.querySelectorAll('[data-mission-dismiss]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        dismissMissionInviteShared(btn.getAttribute('data-mission-dismiss'));
      });
    });
    list.querySelectorAll('[data-friend-accept]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var uid = btn.getAttribute('data-friend-accept');
        if (typeof window.acceptFriendRequest === 'function' && window.acceptFriendRequest !== acceptFriendRequestShared) {
          window.acceptFriendRequest(Object.assign({ senderUid: uid }, state.friendRequests[uid] || {}));
        } else {
          acceptFriendRequestShared(uid);
        }
      });
    });
    list.querySelectorAll('[data-friend-decline]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var uid = btn.getAttribute('data-friend-decline');
        if (typeof window.declineFriendRequest === 'function' && window.declineFriendRequest !== declineFriendRequestShared) {
          window.declineFriendRequest(uid);
        } else {
          declineFriendRequestShared(uid);
        }
      });
    });
    list.querySelectorAll('[data-chat-accept]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        acceptPrivateChatShared(btn.getAttribute('data-chat-accept'));
      });
    });
    list.querySelectorAll('[data-chat-decline]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        declinePrivateChatShared(btn.getAttribute('data-chat-decline'));
      });
    });
    list.querySelectorAll('[data-pm-open]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        openPrivateChatShared(el.getAttribute('data-pm-open'), el.getAttribute('data-pm-nick'), el.getAttribute('data-pm-photo'));
      });
    });
    list.querySelectorAll('[data-dynamic-link]').forEach(function(el) {
      el.addEventListener('click', function() {
        var link = el.getAttribute('data-dynamic-link');
        if (link) window.location.href = link;
        var chatMark = el.getAttribute('data-chat-mark');
        if (chatMark && state.uid) {
          var parts = chatMark.split('/');
          if (parts.length === 2) {
            getDb().ref('users/' + state.uid + '/notificationSeen/chat/' + parts[0] + '/' + parts[1]).set(Date.now());
          }
        }
      });
    });
  }

  function pushDynamic(section, sort, unread, title, text, icon, link, extra) {
    state.dynamic.push({
      section: section,
      sort: sort,
      unread: !!unread,
      seenKey: extra && extra.seenKey ? extra.seenKey : null,
      html: itemHtml({
        title: title,
        text: text,
        icon: icon || 'fa-bell',
        unread: !!unread,
        attrs: (link ? 'data-dynamic-link="' + esc(link) + '" ' : '') + (extra && extra.attrs ? extra.attrs : ''),
        time: extra && extra.time ? fmtTime(extra.time) : ''
      })
    });
  }

  async function refreshDynamic() {
    if (!state.uid || state.refreshing) return;
    var db = getDb();
    if (!db) return;
    state.refreshing = true;
    var uid = state.uid;
    var ud = state.userData || {};
    var seen = getSeen();
    state.dynamic = [];

    try {
      var teamSnap = await db.ref('teamInvites/' + uid).once('value');
      if (teamSnap.exists()) {
        var tc = teamSnap.numChildren();
        var seenTeamCount = (seen.teamInvites && seen.teamInvites.count) || 0;
        if (tc > seenTeamCount) {
          pushDynamic('Mensajes', Date.now() - 1000, true, 'Invitaciones de equipo',
            tc + ' invitación' + (tc > 1 ? 'es' : '') + ' pendiente' + (tc > 1 ? 's' : ''), 'fa-users', '/competition-hub',
            { seenKey: 'teamInvites' });
        }
      }

      var pzChatSnap = await db.ref('playzoneChatInvites/' + uid).once('value');
      if (pzChatSnap.exists()) {
        var pc = pzChatSnap.numChildren();
        var seenPzCount = (seen.playzoneChat && seen.playzoneChat.count) || 0;
        if (pc > seenPzCount) {
          pushDynamic('Mensajes', Date.now() - 1500, true, 'Chat de misión',
            pc + ' invitación' + (pc > 1 ? 'es' : '') + ' a chat', 'fa-comments', '/playzone',
            { seenKey: 'playzoneChat' });
        }
      }

      var seenRoot = (ud.notificationSeen && ud.notificationSeen.chat) || {};
      var chatChecks = [];
      if (ud.teamId) chatChecks.push({ node: 'teamChats', chatId: ud.teamId, label: 'Chat de equipo' });

      try {
        var missionsSnap = await db.ref('missions').once('value');
        if (missionsSnap.exists()) {
          missionsSnap.forEach(function(ch) {
            var m = ch.val() || {};
            if (m.participants && m.participants[uid]) {
              chatChecks.push({ node: 'missionChats', chatId: ch.key, label: m.title || 'Chat de misión' });
            }
          });
        }
      } catch (e) {}

      await Promise.all(chatChecks.map(async function(c) {
        try {
          var snap = await db.ref(c.node + '/' + c.chatId + '/messages').orderByChild('timestamp').limitToLast(1).once('value');
          if (!snap.exists()) return;
          var last = null;
          snap.forEach(function(m) { last = m.val(); });
          if (!last) return;
          var ts = parseTime(last.timestamp);
          var fromMe = last.userId && last.userId === uid;
          var seenAt = parseTime(seenRoot[c.node] && seenRoot[c.node][c.chatId]);
          if (!fromMe && ts > seenAt) {
            pushDynamic('Mensajes', ts, true, c.label, last.text || 'Nuevo mensaje', 'fa-comment',
              '/dashboard', { attrs: 'data-chat-mark="' + esc(c.node + '/' + c.chatId) + '"', time: ts });
          }
        } catch (e) {}
      }));

      var match = ud.competitive && ud.competitive.match ? ud.competitive.match : null;
      if (match && match.opponent && match.opponent !== 'Ninguno') {
        var mt = parseTime(match.time);
        var matchKey = String(match.time || '') + '|' + String(match.opponent || '');
        if (seen.upcomingMatch !== matchKey) {
          pushDynamic('Misiones', mt || Date.now() - 2000, true, 'Próxima partida',
            'vs ' + match.opponent + (match.tournament ? ' (' + match.tournament + ')' : ''), 'fa-flag-checkered',
            '/competition-hub', { time: mt, seenKey: 'upcomingMatch' });
        }
      }

      try {
        var allMissions = await db.ref('missions').once('value');
        if (allMissions.exists()) {
          allMissions.forEach(function(ch) {
            var m = ch.val() || {};
            if (!m.participants || !m.participants[uid]) return;
            var at = parseTime(m.ingressTime || m.startAt || m.scheduledAt);
            var missionSeen = seen.missions && seen.missions[ch.key];
            if (at && at >= Date.now() - 15 * 60 * 1000 && (!missionSeen || missionSeen < at)) {
              pushDynamic('Misiones', at, true, 'Misión próxima', m.title || 'Misión sin título', 'fa-crosshairs',
                '/playzone', { time: at, seenKey: 'mission_' + ch.key });
            }
          });
        }
      } catch (e) {}

      try {
        var visSnap = await db.ref('users/' + uid + '/profileVisitors').orderByChild('visitedAt').limitToLast(3).once('value');
        var visitors = [];
        var seenVisits = seen.visits || {};
        if (visSnap.exists()) visSnap.forEach(function(c) { visitors.push(Object.assign({ id: c.key }, c.val())); });
        visitors.sort(function(a, b) { return parseTime(b.visitedAt) - parseTime(a.visitedAt); });
        visitors.forEach(function(v) {
          var vKey = v.visitorUid || v.id || '';
          var vAt = parseTime(v.visitedAt);
          var seenAt = parseTime(seenVisits[vKey]);
          if (vAt > seenAt) {
            pushDynamic('Visitas', vAt, true, 'Visita al perfil',
              (v.nick || 'Un jugador') + ' visitó tu perfil', 'fa-eye',
              v.visitorUid ? '/dashboard?uid=' + v.visitorUid : '/dashboard',
              { time: v.visitedAt, seenKey: 'visit_' + vKey });
          }
        });
      } catch (e) {}
    } catch (err) {
      console.warn('SGNotifications refresh:', err);
    }

    state.refreshing = false;
    renderList();
  }

  function cleanupLegacyPanels() {
    var legacy = document.getElementById('notificationsPanel');
    if (legacy) legacy.remove();
  }

  function positionPanel(toggle, panel) {
    if (!toggle || !panel) return;
    var rect = toggle.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = Math.round(rect.bottom + 8) + 'px';
    panel.style.right = Math.round(window.innerWidth - rect.right) + 'px';
    panel.style.left = 'auto';
    panel.style.bottom = 'auto';
    panel.style.width = 'min(360px, 92vw)';
  }

  function portalPanel(toggle, panel) {
    if (!panel || panel._sgPortaled) return;
    panel._sgPortalWrap = toggle ? toggle.closest('.header-notifications-wrap') : null;
    document.body.appendChild(panel);
    panel.classList.add('is-portaled');
    panel._sgPortaled = true;
  }

  // Animación con Motion (motion.dev, cargado vía CDN en cada página): si no
  // está disponible, el panel sigue abriendo/cerrando igual, solo sin el
  // fade+escala.
  function notifMotionFx(el, keyframes, opts) {
    if (!el || typeof window.Motion === 'undefined' || !window.Motion.animate) return null;
    try { return window.Motion.animate(el, keyframes, opts); } catch (e) { return null; }
  }

  function closePanel(toggle, panel) {
    if (!panel) panel = document.getElementById('headerNotificationsPanel');
    if (!panel || !panel.classList.contains('is-open')) return;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    var anim = notifMotionFx(panel, { opacity: [1, 0], scale: [1, 0.95], y: [0, -6] }, { duration: 0.15, ease: 'easeIn' });
    if (anim && anim.finished) {
      anim.finished.then(function () { panel.classList.remove('is-open'); }).catch(function () { panel.classList.remove('is-open'); });
    } else {
      panel.classList.remove('is-open');
    }
  }

  function openPanel(toggle, panel) {
    if (!toggle) toggle = document.getElementById('notificationsToggleBtn');
    if (!panel) panel = document.getElementById('headerNotificationsPanel');
    if (!toggle || !panel) return;
    portalPanel(toggle, panel);
    positionPanel(toggle, panel);
    panel.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    // Al abrir, apagar el punto de inmediato; no vuelve hasta que llegue algo nuevo.
    ackAll();
    updateBadge();
    notifMotionFx(panel, { opacity: [0, 1], scale: [0.95, 1], y: [-6, 0] }, { duration: 0.18, ease: 'easeOut' });
    refreshDynamic().then(function() {
      return markAsReviewed();
    });
  }

  function handleToggleClick(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    var toggle = document.getElementById('notificationsToggleBtn');
    var panel = document.getElementById('headerNotificationsPanel');
    if (!toggle || !panel) return false;
    if (panel.classList.contains('is-open')) closePanel(toggle, panel);
    else openPanel(toggle, panel);
    return false;
  }

  function setupToggle() {
    cleanupLegacyPanels();

    var toggle = document.getElementById('notificationsToggleBtn');
    var panel = document.getElementById('headerNotificationsPanel');
    if (!toggle || !panel) return;

    if (!toggle._sgDirectBound) {
      toggle._sgDirectBound = true;
      toggle.onclick = function(e) { return handleToggleClick(e); };
    }

    if (!window._sgNotifOutsideBound) {
      window._sgNotifOutsideBound = true;
      document.addEventListener('click', function(e) {
        var refreshBtn = e.target.closest('#headerNotifRefreshBtn');
        if (refreshBtn) {
          e.preventDefault();
          e.stopPropagation();
          refreshBtn.classList.add('spinning');
          refreshDynamic().finally(function() {
            setTimeout(function() { refreshBtn.classList.remove('spinning'); }, 400);
          });
          return;
        }

        var panelEl = document.getElementById('headerNotificationsPanel');
        if (!panelEl || !panelEl.classList.contains('is-open')) return;
        if (e.target.closest('#headerNotificationsPanel') || e.target.closest('#notificationsToggleBtn')) return;
        closePanel(document.getElementById('notificationsToggleBtn'), panelEl);
      });
      window.addEventListener('resize', function() {
        var panelEl = document.getElementById('headerNotificationsPanel');
        var btn = document.getElementById('notificationsToggleBtn');
        if (panelEl && panelEl.classList.contains('is-open')) positionPanel(btn, panelEl);
      });
    }
  }

  function bindAuthWhenReady() {
    try {
      if (typeof firebase === 'undefined' || !firebase.auth) return false;
      if (!firebase.apps || !firebase.apps.length) return false;
      if (authBound) return true;
      authBound = true;
      firebase.auth().onAuthStateChanged(function(user) {
        if (!user) {
          state.attached = false;
          detachPrivateChatRooms();
          state.uid = null;
          state.dynamic = [];
          renderList();
          return;
        }
        state.attached = false;
        attachListeners(user.uid);
      });
      return true;
    } catch (err) {
      console.warn('SGNotifications auth deferred:', err);
      authBound = false;
      return false;
    }
  }

  function scheduleAuthBind() {
    if (bindAuthWhenReady()) return;
    var tries = 0;
    var timer = setInterval(function() {
      tries += 1;
      if (bindAuthWhenReady() || tries >= 60) clearInterval(timer);
    }, 100);
  }

  function attachListeners(uid) {
    var db = getDb();
    if (!db || !uid) return;
    if (state.attached && state.uid === uid) return;
    state.attached = true;
    detachPrivateChatRooms();
    state.uid = uid;
    loadAck();
    ensureDot();
    state.seenFriendKeys = null;
    state.seenMissionKeys = null;
    state.seenChatReqKeys = null;
    state.seenNotifKeys = null;

    db.ref('users/' + uid + '/notifications').limitToLast(50).on('value', function(snap) {
      var next = snap.val() || {};
      state.notifications = next;
      diffAndToast('notif', next, 'seenNotifKeys', function(id, n) {
        if (!n || n.read || !n.text) return null;
        return {
          icon: n.icon || 'fa-bell',
          title: 'StudiosGamesRS',
          text: n.text,
          onClick: function() {
            if (n.link) window.location.href = n.link;
            else openPanel();
          }
        };
      });
      renderList();
    });

    db.ref('friendRequests/' + uid).on('value', function(snap) {
      var next = snap.val() || {};
      state.friendRequests = next;
      diffAndToast('friend', next, 'seenFriendKeys', function(senderUid, req) {
        return {
          icon: 'fa-user-plus',
          title: 'Solicitud de amistad',
          text: (req.senderNick || 'Alguien') + ' quiere ser tu amigo',
          tone: 'social'
        };
      });
      renderList();
    });

    db.ref('privateChatRequests/' + uid).on('value', function(snap) {
      var next = snap.val() || {};
      state.privateChatRequests = next;
      diffAndToast('chat', next, 'seenChatReqKeys', function(senderUid, req) {
        return {
          icon: 'fa-comment-dots',
          title: 'Chat privado',
          text: (req.senderNick || 'Alguien') + ' quiere chatear contigo',
          tone: 'chat'
        };
      });
      renderList();
    });

    db.ref('nexus/creatorApplications/' + uid).on('value', function(snap) {
      state.creatorApp = snap.val();
      renderList();
    });

    db.ref('missionInvites/' + uid).on('value', function(snap) {
      var next = snap.val() || {};
      state.missionInvites = next;
      diffAndToast('mission', next, 'seenMissionKeys', function(missionId, inv) {
        return { kind: 'mission-invite', missionId: missionId, inv: inv };
      });
      renderList();
    });
    // child_added refuerza el tiempo real (algunos clientes solo ven el value
    // agregado y el punto/toast deben dispararse igual).
    db.ref('missionInvites/' + uid).on('child_added', function(snap) {
      var missionId = snap.key;
      var inv = snap.val() || {};
      if (!missionId || !inv) return;
      if (state.seenMissionKeys === null) return; // aún no hubo value inicial
      if (state.seenMissionKeys[missionId]) return;
      state.seenMissionKeys[missionId] = true;
      state.missionInvites[missionId] = inv;
      showMissionInviteToast(missionId, inv);
      renderList();
    });
    db.ref('missionInvites/' + uid).on('child_removed', function(snap) {
      var missionId = snap.key;
      if (!missionId) return;
      if (state.seenMissionKeys) delete state.seenMissionKeys[missionId];
      delete state.missionInvites[missionId];
      var toastEl = document.getElementById('sg-mission-invite-toast-' + missionId);
      if (toastEl) toastEl.remove();
      renderList();
    });

    db.ref('users/' + uid).on('value', function(snap) {
      state.userData = snap.val() || {};
      // Las salas se enganchan con notificationSeen ya cargado, para no avisar
      // de mensajes que el jugador ya había leído.
      attachPrivateChatRooms(uid);
      refreshDynamic();
    });

    refreshDynamic();
    if (!state._refreshInterval) {
      state._refreshInterval = setInterval(refreshDynamic, 45000);
    }
  }

  var authBound = false;

  function init() {
    cleanupLegacyPanels();
    setupToggle();
    ensureDot();
    // Algunos headers se inyectan después de este script (shared-unified-header):
    // se reintenta para que el punto quede siempre colgado de la campana.
    setTimeout(function() { setupToggle(); ensureDot(); updateBadge(); }, 200);
    setTimeout(function() { setupToggle(); ensureDot(); updateBadge(); }, 1000);
    setTimeout(function() { ensureDot(); updateBadge(); }, 3000);
    scheduleAuthBind();
  }

  window.SGNotifications = {
    init: init,
    toggle: handleToggleClick,
    open: function() { openPanel(); },
    close: function() { closePanel(); },
    push: function(uid, payload) {
      var db = getDb();
      if (!db || !uid) return Promise.resolve();
      return db.ref('users/' + uid + '/notifications').push({
        text: payload.text || '',
        icon: payload.icon || 'fa-bell',
        timestamp: Date.now(),
        read: false,
        type: payload.type || 'general',
        link: payload.link || null
      });
    },
    toast: showLiveToast,
    showMissionInviteToast: showMissionInviteToast,
    showPrivateMessageToast: function(partnerUid, msg) {
      var roomId = pmRoomId(partnerUid) || ('preview_' + String(partnerUid || 'demo'));
      var m = msg || {};
      var room = { partnerUid: partnerUid, nick: m.nick || 'Jugador', photoURL: m.photoURL || '', lastTs: Date.now(), msgs: {} };
      room.msgs.preview = { ts: Date.now(), text: pmExcerpt(m) };
      showPrivateMessageToast(roomId, room, 'preview');
    },
    openPrivateChatWith: openPrivateChatShared,
    markPrivateChatRead: markPrivateChatRead,
    setActivePrivateChat: function(partnerUid) {
      state.pmActivePartner = partnerUid || null;
    },
    pulseAlert: pulseAlert,
    handlesLiveToasts: true,
    refresh: function() { return refreshDynamic(); },
    render: renderList,
    markAsReviewed: markAsReviewed,
    acceptFriendRequest: acceptFriendRequestShared,
    declineFriendRequest: declineFriendRequestShared,
    acceptPrivateChat: acceptPrivateChatShared,
    declinePrivateChat: declinePrivateChatShared
  };

  // Acciones disponibles en cualquier página (si la página no define las suyas).
  if (typeof window.acceptFriendRequest !== 'function') {
    window.acceptFriendRequest = function(req) {
      return acceptFriendRequestShared(req && (req.senderUid || req.uid));
    };
  }
  if (typeof window.declineFriendRequest !== 'function') {
    window.declineFriendRequest = declineFriendRequestShared;
  }

  if (window.StudiosGamesRS) {
    window.StudiosGamesRS.addNotification = function(uid, text, icon, link) {
      return window.SGNotifications.push(uid, { text: text, icon: icon, link: link, type: 'general' });
    };
  } else {
    window.StudiosGamesRS = {
      addNotification: function(uid, text, icon, link) {
        return window.SGNotifications.push(uid, { text: text, icon: icon, link: link, type: 'general' });
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
