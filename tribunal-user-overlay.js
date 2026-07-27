/**
 * Tribunal of Appeals – User-side overlay (Studiosgamesrs)
 * Restaura el diseño original + ban forzado en tiempo real (sin minimizar).
 */
(function() {
  'use strict';

  if (window.__sgTribunalOverlayBooted) return;
  window.__sgTribunalOverlayBooted = true;

  var MODERATOR_RANGOS = { commander: 1, boss_of_the_state: 1, divisional_commander: 1 };

  var db = null;
  var tribunalRef = null;
  var tribunalMessagesRef = null;
  var unsubscribe = null;
  var overlayEl = null;
  var messagesEl = null;
  var inputEl = null;
  var sendBtn = null;
  var minimizeBtn = null;
  var badgeEl = null;
  var banPanelEl = null;
  var countdownEl = null;
  var banEndsEl = null;
  var banStartedEl = null;
  var backdropEl = null;
  var lastMessagesSnap = null;
  var currentUid = null;
  var banUntil = null;
  var banAppliedAt = null;
  var tickTimer = null;
  var isBanLocked = false;
  var attachedUid = null;
  var uiBound = false;

  function getDb() {
    if (db) return db;
    if (typeof firebase !== 'undefined' && firebase.database) {
      db = firebase.database();
      return db;
    }
    return null;
  }

  function normalizeRango(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '_');
  }

  function isModeratorPage() {
    return /commander-panel/i.test(window.location.pathname || '');
  }

  function formatRemaining(ms) {
    if (ms <= 0) return '00:00:00';
    var totalSec = Math.floor(ms / 1000);
    var days = Math.floor(totalSec / 86400);
    var hours = Math.floor((totalSec % 86400) / 3600);
    var minutes = Math.floor((totalSec % 3600) / 60);
    var seconds = totalSec % 60;
    if (days > 0) {
      return days + 'd ' + String(hours).padStart(2, '0') + ':' +
        String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }
    return String(hours).padStart(2, '0') + ':' +
      String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  function formatDateTime(ts) {
    return new Date(ts).toLocaleString('es-ES', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function createOverlayDOM() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'tribunalUserOverlay';
    overlayEl.className = 'tribunal-user-overlay';
    overlayEl.setAttribute('aria-label', 'Tribunal of Appeals');
    overlayEl.innerHTML =
      '<div class="tribunal-user-overlay-backdrop"></div>' +
      '<div class="tribunal-user-overlay-box">' +
        '<div class="tribunal-user-overlay-header">' +
          '<div class="tribunal-user-overlay-seal"><i class="fas fa-gavel"></i></div>' +
          '<h2 class="tribunal-user-overlay-title">TRIBUNAL OF APPEALS</h2>' +
          '<p class="tribunal-user-overlay-subtitle">Official communication from Studiosgamesrs.com — you may reply below.</p>' +
          '<div class="tribunal-user-overlay-notice">' +
            '<p>You are being contacted directly by Studiosgamesrs administration. This channel cannot be declined while a sanction is active. Respectful replies are required; disrespect or abuse may result in sanctions or <strong>permanent ban</strong>.</p>' +
          '</div>' +
          '<div id="tribunalUserBanPanel" class="tribunal-user-ban-panel" style="display:none;">' +
            '<span class="tribunal-user-ban-label">Overlay forzado — sanción activa</span>' +
            '<div id="tribunalUserBanCountdown" class="tribunal-user-ban-countdown">--:--:--</div>' +
            '<div class="tribunal-user-ban-meta">' +
              '<span id="tribunalUserBanEnds">Finaliza: —</span>' +
              '<span id="tribunalUserBanStarted">Aplicado: —</span>' +
            '</div>' +
            '<p class="tribunal-user-ban-note">No puedes usar StudiosGamesRS ni minimizar este overlay hasta que expire el ban.</p>' +
          '</div>' +
          '<button type="button" class="tribunal-user-overlay-minimize" id="tribunalUserMinimizeBtn" aria-label="Minimize">Minimize</button>' +
        '</div>' +
        '<div id="tribunalUserMessages" class="tribunal-user-overlay-messages"></div>' +
        '<div class="tribunal-user-overlay-input-row">' +
          '<input type="text" id="tribunalUserInput" class="tribunal-user-overlay-input" placeholder="Type your reply..." maxlength="500" autocomplete="off">' +
          '<button type="button" id="tribunalUserSendBtn" class="tribunal-user-overlay-send"><i class="fas fa-paper-plane"></i> Send</button>' +
        '</div>' +
      '</div>' +
      '<div id="tribunalUserBadge" class="tribunal-user-badge" style="display:none;" aria-label="Tribunal message"><i class="fas fa-gavel"></i></div>';

    var target = document.body || document.documentElement;
    target.appendChild(overlayEl);

    messagesEl = overlayEl.querySelector('#tribunalUserMessages');
    inputEl = overlayEl.querySelector('#tribunalUserInput');
    sendBtn = overlayEl.querySelector('#tribunalUserSendBtn');
    minimizeBtn = overlayEl.querySelector('#tribunalUserMinimizeBtn');
    badgeEl = overlayEl.querySelector('#tribunalUserBadge');
    banPanelEl = overlayEl.querySelector('#tribunalUserBanPanel');
    countdownEl = overlayEl.querySelector('#tribunalUserBanCountdown');
    banEndsEl = overlayEl.querySelector('#tribunalUserBanEnds');
    banStartedEl = overlayEl.querySelector('#tribunalUserBanStarted');
    backdropEl = overlayEl.querySelector('.tribunal-user-overlay-backdrop');
    return overlayEl;
  }

  function escapeHtml(s) {
    if (!s) return '';
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function clearAppealLocalState(uid) {
    if (!uid || typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem('tribunalOverlayMinimized_' + uid);
      localStorage.removeItem('tribunalLastSeenCommanderTs_' + uid);
    } catch (e) {}
  }

  function dismissAppealUI(uid) {
    hideOverlay();
    if (badgeEl) badgeEl.style.display = 'none';
    clearAppealLocalState(uid);
  }

  function refreshAppealVisibility() {
    if (isBanLocked) return;
    if (!tribunalRef) {
      hideOverlay();
      return;
    }
    tribunalRef.child('active').once('value', function(activeSnap) {
      decideShowOrBadge(lastMessagesSnap, activeSnap && activeSnap.val() === true);
    });
  }

  function updateBanUI() {
    var now = Date.now();
    isBanLocked = !!(banUntil && banUntil > now);

    if (banPanelEl) banPanelEl.style.display = isBanLocked ? 'block' : 'none';
    if (minimizeBtn) minimizeBtn.style.display = isBanLocked ? 'none' : '';
    if (badgeEl && isBanLocked) badgeEl.style.display = 'none';

    if (banStartedEl) {
      banStartedEl.textContent = banAppliedAt
        ? ('Aplicado: ' + formatDateTime(banAppliedAt))
        : 'Aplicado: —';
    }

    if (isBanLocked) {
      document.body.classList.add('tribunal-ban-locked');
      if (backdropEl) backdropEl.style.cursor = 'default';
      startCountdownTicker();
      showOverlay();
    } else {
      document.body.classList.remove('tribunal-ban-locked');
      if (backdropEl) backdropEl.style.cursor = 'pointer';
      stopCountdownTicker();
      refreshAppealVisibility();
    }
  }

  function updateCountdownDisplay() {
    if (!countdownEl || !banUntil) return;
    var remaining = banUntil - Date.now();
    countdownEl.textContent = formatRemaining(remaining);
    if (banEndsEl) banEndsEl.textContent = 'Finaliza: ' + formatDateTime(banUntil);
    if (remaining <= 0) {
      isBanLocked = false;
      banUntil = null;
      updateBanUI();
      refreshAppealVisibility();
    }
  }

  function startCountdownTicker() {
    stopCountdownTicker();
    updateCountdownDisplay();
    tickTimer = setInterval(updateCountdownDisplay, 1000);
  }

  function stopCountdownTicker() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function showOverlay() {
    createOverlayDOM();
    if (!overlayEl) return;
    overlayEl.classList.add('tribunal-user-overlay-visible');
    if (badgeEl && !isBanLocked) badgeEl.style.display = 'none';
  }

  function hideOverlay() {
    if (isBanLocked) return;
    if (overlayEl) overlayEl.classList.remove('tribunal-user-overlay-visible');
    if (badgeEl) {
      badgeEl.style.display = 'none';
      badgeEl.style.pointerEvents = '';
    }
  }

  function showBadgeOnly(uid) {
    if (isBanLocked) return;
    createOverlayDOM();
    if (overlayEl) overlayEl.classList.remove('tribunal-user-overlay-visible');
    if (badgeEl) {
      badgeEl.style.display = 'flex';
      badgeEl.style.pointerEvents = 'auto';
    }
    if (uid && typeof localStorage !== 'undefined') {
      try { localStorage.setItem('tribunalOverlayMinimized_' + uid, '1'); } catch (e) {}
    }
  }

  function saveLastSeenCommanderTs(uid, snap) {
    if (!uid || !snap || typeof localStorage === 'undefined') return;
    try {
      var maxTs = 0;
      snap.forEach(function(c) {
        var v = c.val();
        if (v && v.from === 'commander' && v.ts) maxTs = Math.max(maxTs, v.ts);
      });
      localStorage.setItem('tribunalLastSeenCommanderTs_' + uid, String(maxTs));
    } catch (e) {}
  }

  function getMinimized(uid) {
    if (isBanLocked) return false;
    if (!uid || typeof localStorage === 'undefined') return false;
    try { return localStorage.getItem('tribunalOverlayMinimized_' + uid) === '1'; } catch (e) { return false; }
  }

  function getLastSeenCommanderTs(uid) {
    if (!uid || typeof localStorage === 'undefined') return 0;
    try {
      var v = localStorage.getItem('tribunalLastSeenCommanderTs_' + uid);
      return v ? parseInt(v, 10) || 0 : 0;
    } catch (e) { return 0; }
  }

  function getMaxCommanderTs(snap) {
    if (!snap || !snap.exists()) return 0;
    var maxTs = 0;
    snap.forEach(function(c) {
      var v = c.val();
      if (v && v.from === 'commander' && v.ts) maxTs = Math.max(maxTs, v.ts);
    });
    return maxTs;
  }

  function renderMessages(snap) {
    lastMessagesSnap = snap;
    if (!messagesEl) return;
    messagesEl.innerHTML = '';
    if (!snap || !snap.exists()) {
      messagesEl.innerHTML = '<div class="tribunal-user-msg-empty">Administration may send you a message. Waiting...</div>';
      return;
    }
    var arr = [];
    snap.forEach(function(c) {
      var v = c.val();
      arr.push({ id: c.key, from: v.from, text: v.text || '', ts: v.ts || 0 });
    });
    arr.sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
    arr.forEach(function(m) {
      var div = document.createElement('div');
      var isCommander = m.from === 'commander';
      div.className = 'tribunal-user-msg-line ' + (isCommander ? 'tribunal-user-msg-commander' : 'tribunal-user-msg-you');
      var who = isCommander ? 'Administration' : 'You';
      var time = m.ts ? new Date(m.ts).toLocaleString() : '';
      div.innerHTML =
        '<span class="tribunal-user-msg-who">' + who + '</span>' +
        '<span class="tribunal-user-msg-time">' + time + '</span>' +
        '<span class="tribunal-user-msg-text">' + escapeHtml(m.text) + '</span>';
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function decideShowOrBadge(snap, active) {
    if (isBanLocked) {
      renderMessages(snap);
      showOverlay();
      return;
    }
    var hasMessages = snap && snap.exists() && snap.numChildren() > 0;
    if (!active || !hasMessages) {
      renderMessages(snap);
      if (!active) {
        dismissAppealUI(currentUid);
      }
      return;
    }
    renderMessages(snap);
    var minimized = getMinimized(currentUid);
    var maxCommanderTs = getMaxCommanderTs(snap);
    var lastSeen = getLastSeenCommanderTs(currentUid);
    if (minimized && maxCommanderTs <= lastSeen) {
      if (badgeEl) {
        badgeEl.style.display = 'flex';
        badgeEl.style.pointerEvents = 'auto';
      }
      hideOverlay();
    } else {
      showOverlay();
    }
  }

  function attachListeners(uid) {
    if (!uid) return;
    if (attachedUid === uid && unsubscribe) return;
    var database = getDb();
    if (!database) return;

    currentUid = uid;
    if (unsubscribe) unsubscribe();

    tribunalRef = database.ref('tribunalAppeals/' + uid);
    tribunalMessagesRef = tribunalRef.child('messages');

    createOverlayDOM();
    if (!messagesEl) return;

    if (typeof tribunalRef.keepSynced === 'function') {
      tribunalRef.keepSynced(true);
    }

    tribunalRef.child('banUntil').on('value', function(banSnap) {
      var val = banSnap && banSnap.val();
      banUntil = val != null ? Number(val) : null;
      if (banUntil && isNaN(banUntil)) banUntil = null;
      updateBanUI();
    });

    tribunalRef.child('banAppliedAt').on('value', function(snap) {
      var val = snap && snap.val();
      banAppliedAt = val != null ? Number(val) : null;
      if (banAppliedAt && isNaN(banAppliedAt)) banAppliedAt = null;
      if (banStartedEl && banAppliedAt) {
        banStartedEl.textContent = 'Aplicado: ' + formatDateTime(banAppliedAt);
      }
    });

    tribunalMessagesRef.on('value', function(snap) {
      lastMessagesSnap = snap;
      var hasMessages = snap && snap.exists() && snap.numChildren() > 0;
      if (isBanLocked) {
        decideShowOrBadge(snap, true);
        return;
      }
      if (!hasMessages) {
        renderMessages(snap);
        tribunalRef.child('active').once('value', function(activeSnap) {
          if (activeSnap && activeSnap.val() === true) showOverlay();
          else {
            hideOverlay();
            if (badgeEl) badgeEl.style.display = 'none';
          }
        });
        return;
      }
      tribunalRef.child('active').once('value', function(activeSnap) {
        decideShowOrBadge(snap, activeSnap && activeSnap.val() === true);
      });
    }, function(err) {
      if (err) console.error('[Tribunal] Error listening:', err);
    });

    tribunalRef.child('active').on('value', function(snap) {
      if (isBanLocked) return;
      var active = snap && snap.val() === true;
      if (active) {
        tribunalMessagesRef.once('value', function(msgSnap) {
          decideShowOrBadge(msgSnap, true);
        });
      } else {
        dismissAppealUI(currentUid);
      }
    });

    tribunalMessagesRef.on('child_added', function(childSnap) {
      var v = childSnap && childSnap.val();
      var isNewFromCommander = v && v.from === 'commander';
      tribunalMessagesRef.once('value', function(snap) {
        if (!snap || !snap.exists() || snap.numChildren() === 0) return;
        if (isBanLocked) {
          decideShowOrBadge(snap, true);
          return;
        }
        if (isNewFromCommander) {
          var ts = v.ts || 0;
          if (typeof localStorage !== 'undefined' && uid) {
            try { localStorage.setItem('tribunalLastSeenCommanderTs_' + uid, String(ts)); } catch (e) {}
          }
          renderMessages(snap);
          showOverlay();
        } else {
          tribunalRef.child('active').once('value', function(activeSnap) {
            if (activeSnap && activeSnap.val() === true) decideShowOrBadge(snap, true);
          });
        }
      });
    });

    unsubscribe = function() {
      stopCountdownTicker();
      if (tribunalMessagesRef) {
        tribunalMessagesRef.off('value');
        tribunalMessagesRef.off('child_added');
      }
      if (tribunalRef) {
        tribunalRef.child('active').off('value');
        tribunalRef.child('banUntil').off('value');
        tribunalRef.child('banAppliedAt').off('value');
        if (typeof tribunalRef.keepSynced === 'function') tribunalRef.keepSynced(false);
      }
      document.body.classList.remove('tribunal-ban-locked');
    };
    attachedUid = uid;
  }

  function sendReply() {
    if (!inputEl || !tribunalMessagesRef) return;
    var text = (inputEl.value || '').trim();
    if (!text) return;
    tribunalMessagesRef.push({ from: 'user', text: text, ts: Date.now() }).then(function() {
      inputEl.value = '';
    }).catch(function(err) {
      console.error('Tribunal reply error:', err);
    });
  }

  function bindUI(uid) {
    createOverlayDOM();
    if (!overlayEl || uiBound) return;
    uiBound = true;
    if (backdropEl) {
      backdropEl.addEventListener('click', function() {
        if (!isBanLocked) hideOverlay();
      });
    }
    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', function() {
        if (isBanLocked) return;
        saveLastSeenCommanderTs(uid, lastMessagesSnap);
        showBadgeOnly(uid);
      });
    }
    if (badgeEl) {
      badgeEl.addEventListener('click', function() {
        if (isBanLocked) return;
        showOverlay();
        if (typeof localStorage !== 'undefined' && uid) {
          try { localStorage.removeItem('tribunalOverlayMinimized_' + uid); } catch (e) {}
        }
      });
    }
    if (sendBtn && inputEl) {
      sendBtn.addEventListener('click', sendReply);
      inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          sendReply();
        }
      });
    }
  }

  function initForUser(uid) {
    if (!uid || isModeratorPage()) return;
    if (attachedUid === uid && unsubscribe) return;
    bindUI(uid);
    attachListeners(uid);
  }

  function onTribunalReady(e) {
    var uid = e && e.detail && e.detail.uid;
    if (uid) initForUser(uid);
  }

  window.SGTribunalOverlay = {
    initForUser: initForUser
  };

  window.addEventListener('nexusTribunalReady', onTribunalReady);

  document.addEventListener('keydown', function(e) {
    if (!isBanLocked) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  function bootAuth() {
    if (isModeratorPage()) return;
    if (typeof firebase === 'undefined' || !firebase.auth) return;
    firebase.auth().onAuthStateChanged(function(user) {
      if (unsubscribe) unsubscribe();
      currentUid = null;
      attachedUid = null;
      banUntil = null;
      banAppliedAt = null;
      isBanLocked = false;
      hideOverlay();
      if (badgeEl) badgeEl.style.display = 'none';
      if (!user) return;

      getDb();
      var database = getDb();
      if (!database) return;

      database.ref('users/' + user.uid + '/rango').once('value').then(function(snap) {
        if (MODERATOR_RANGOS[normalizeRango(snap.val())]) return;
        initForUser(user.uid);
      }).catch(function() {
        initForUser(user.uid);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAuth);
  } else {
    bootAuth();
  }
})();
