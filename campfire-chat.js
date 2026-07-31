/* =====================================================================
 * campfire-chat.js — Fuego de Campamento 2.0
 * Motor completo del chat de El Nexo: render incremental, reacciones,
 * respuestas, fijados, encuestas, LFG, comandos, menciones, búsqueda,
 * moderación, rachas y XP.
 *
 * Se carga DESPUÉS de community.js y reutiliza sus globales
 * (rtdb, currentUser, userProfile, presenceByUid, showNotification…).
 * ===================================================================== */

(function () {
  'use strict';

  // ============================================================
  // 0. Puentes con community.js (tolerantes a fallos)
  // ============================================================
  function db() {
    try { if (typeof rtdb !== 'undefined' && rtdb) return rtdb; } catch (e) {}
    return firebase.database();
  }
  function me() {
    try { if (typeof currentUser !== 'undefined' && currentUser) return currentUser; } catch (e) {}
    try { return firebase.auth().currentUser || null; } catch (e) { return null; }
  }
  function myUid() { var u = me(); return u ? u.uid : null; }
  function prof() {
    try { if (typeof userProfile !== 'undefined' && userProfile) return userProfile; } catch (e) {}
    return {};
  }
  function presence() {
    try { if (typeof presenceByUid !== 'undefined' && presenceByUid) return presenceByUid; } catch (e) {}
    return {};
  }
  function toast(msg, type) {
    try { if (typeof showNotification === 'function') return showNotification(msg, type || 'info'); } catch (e) {}
    try { console.log('[Campfire]', msg); } catch (e) {}
  }
  function grantHonor(uid, pts) {
    try { if (typeof addHonorPoints === 'function') addHonorPoints(uid, pts); } catch (e) {}
  }
  function pushFeed(type, html) {
    try { if (typeof pushActivity === 'function') pushActivity(type, html); } catch (e) {}
  }
  function bindUserClicks(el) {
    try { if (typeof bindCommunityUserClicks === 'function') bindCommunityUserClicks(el); } catch (e) {}
  }
  function playerStatuses() {
    try { if (typeof PLAYER_STATUSES !== 'undefined' && PLAYER_STATUSES) return PLAYER_STATUSES; } catch (e) {}
    return [];
  }
  function botRef() {
    try { if (typeof getBotRef === 'function') return getBotRef(); } catch (e) {}
    return db().ref('globalChatBot/main');
  }
  function fallbackAvatar() {
    try { if (typeof DEFAULT_AVATAR !== 'undefined' && DEFAULT_AVATAR) return DEFAULT_AVATAR; } catch (e) {}
    return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMjAiIGZpbGw9IiMzMzMiLz48L3N2Zz4=';
  }

  // ============================================================
  // 1. Configuración
  // ============================================================
  var NODE = 'globalChat';
  var ROOM = 'main';
  var BOT_UID = 'nexus_bot';
  /** Pausado: no mostrar mensajes del Nexo Bot (cofres/trivias/anuncios). */
  var HIDE_BOT_MESSAGES = true;

  function isBotMessage(d) {
    return !!(d && (d.type === 'bot' || d.userId === BOT_UID));
  }
  var PAGE = 60;
  var MAX_LEN = 500;
  var MAX_DOM = 220;
  var GROUP_WINDOW_MS = 5 * 60 * 1000;
  var TYPING_TTL = 6000;
  var MIN_SEND_GAP = 900;
  var BURST_LIMIT = 6;
  var BURST_WINDOW = 10000;
  var BURST_COOLDOWN = 7000;
  var IMG_MAX_BYTES = 3.5 * 1024 * 1024;

  var CHANNELS = [
    { id: 'general', label: 'General', icon: 'fa-fire', hint: 'Charla libre del campamento' },
    { id: 'lfg', label: 'Buscar equipo', icon: 'fa-user-plus', hint: 'Arma escuadrón para tu próxima partida' },
    { id: 'clips', label: 'Clips', icon: 'fa-film', hint: 'Comparte tus mejores jugadas' },
    { id: 'help', label: 'Ayuda', icon: 'fa-life-ring', hint: 'Pide y ofrece ayuda táctica' }
  ];

  var REACTIONS = ['🔥', '😂', '💀', '🎯', '❤️', '👏', '🤝', '😮'];

  var EMOJI_CATS = [
    { id: 'recientes', icon: '🕘', list: [] },
    { id: 'gaming', icon: '🎮', list: ['🎮', '🕹️', '🎯', '🏆', '🥇', '🥈', '🥉', '⚔️', '🛡️', '🗡️', '🏹', '💣', '🔫', '🧨', '💥', '☠️', '💀', '👾', '🤖', '🎲', '♟️', '🚩', '🏁', '⏱️', '🔥', '⚡', '💎', '🪙', '🎖️', '🧠'] },
    { id: 'caras', icon: '😀', list: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😍', '🤩', '😘', '😜', '🤪', '🤨', '🧐', '😎', '🥳', '😏', '😒', '😞', '😔', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '🤔', '🤫', '🤭', '😴', '🤤', '🤢', '🤮', '🥴', '😵', '🫠', '🙃'] },
    { id: 'gestos', icon: '👍', list: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👋', '🙌', '👏', '🙏', '💪', '🫡', '🤝', '✊', '👊', '🖐️', '☝️', '👀', '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯'] },
    { id: 'objetos', icon: '🍕', list: ['🍕', '🍔', '🌮', '🍟', '🍿', '🥤', '☕', '🍺', '🧃', '🎂', '🍩', '🍪', '🎁', '🎉', '🎊', '📯', '🔔', '📢', '🎵', '🎧', '🎬', '📸', '🖥️', '💻', '⌨️', '🖱️', '📱', '🔌', '🪫', '🔋'] },
    { id: 'naturaleza', icon: '🌋', list: ['🌋', '🏔️', '🌲', '🌳', '🍀', '🌙', '⭐', '🌟', '✨', '☄️', '🌈', '🌊', '❄️', '🌪️', '🐉', '🦅', '🐺', '🦁', '🐻', '🦊', '🐸', '🦖', '🕷️', '🐍', '🦂', '🌸', '🔥', '💨', '🌞', '🌑'] }
  ];

  var COMMANDS = [
    { cmd: '/me', args: '<acción>', desc: 'Envía una acción en tercera persona' },
    { cmd: '/shrug', args: '', desc: 'Añade ¯\\_(ツ)_/¯' },
    { cmd: '/roll', args: '[2d20]', desc: 'Tira dados' },
    { cmd: '/flip', args: '', desc: 'Lanza una moneda' },
    { cmd: '/poll', args: 'pregunta | op1 | op2', desc: 'Crea una encuesta en vivo' },
    { cmd: '/lfg', args: 'juego | plazas | nota', desc: 'Publica búsqueda de equipo' },
    { cmd: '/help', args: '<qué necesitas>', desc: 'Pide ayuda destacada' },
    { cmd: '/gif', args: '<emoji grande>', desc: 'Envía un emoji gigante' },
    { cmd: '/top', args: '', desc: 'Muestra el top de la semana' },
    { cmd: '/stats', args: '', desc: 'Tus estadísticas de chat' },
    { cmd: '/search', args: '<texto>', desc: 'Busca en el chat' },
    { cmd: '/mute', args: '@nick', desc: 'Oculta a alguien solo para ti' },
    { cmd: '/unmute', args: '@nick', desc: 'Vuelve a mostrar a alguien' },
    { cmd: '/theme', args: 'ember|ice|toxic|gold|violet', desc: 'Cambia el acento del chat' },
    { cmd: '/density', args: 'compact|cozy|roomy', desc: 'Cambia la densidad' },
    { cmd: '/clear', args: '', desc: 'Limpia tu vista (no borra nada)' },
    { cmd: '/shortcuts', args: '', desc: 'Muestra los atajos de teclado' },
    { cmd: '/topic', args: '<tema>', desc: 'Fija el tema del día (mods)' },
    { cmd: '/slow', args: '<segundos>', desc: 'Modo lento (mods)' },
    { cmd: '/clearpins', args: '', desc: 'Quita todos los fijados (mods)' }
  ];

  var PROMPTS = [
    '¿Cuál fue tu mejor clutch de la semana?',
    '¿Qué mapa odias con toda tu alma?',
    'Recomienda un juego barato que valga la pena',
    '¿Buscas equipo? Usa /lfg y te encontramos',
    '¿Sensibilidad y DPI? Comparte tu setup',
    '¿Qué mejorarías del Nexo?'
  ];

  var BAD_WORDS = ['puta', 'puto', 'mierda', 'gilipollas', 'cabron', 'cabrón', 'pendejo', 'idiota', 'imbecil', 'imbécil', 'maricon', 'maricón', 'joder', 'coño', 'verga', 'culero', 'zorra'];

  var MOD_RANGOS = ['commander', 'divisional_commander', 'boss_of_the_state'];

  // Marcos en el chat: el cambio se refleja en vivo, pero con retraso para
  // que nadie pueda spamear cambios de marco y distraer el campamento.
  var FRAME_CHAT_DELAY_MS = 30000;
  var frameCache = {}; // uid -> { applied, pending, timer, listening }

  // ============================================================
  // 2. Estado
  // ============================================================
  var S = {
    booted: false,
    channel: 'general',
    msgs: {},
    nodes: {},
    order: [],
    oldestTs: null,
    exhausted: false,
    atBottom: true,
    unread: 0,
    unreadMarkerId: null,
    replyTo: null,
    editing: null,
    attach: null,
    lastSendAt: 0,
    sendTimes: [],
    cooldownUntil: 0,
    typingSentAt: 0,
    typingUsers: {},
    typingVisible: false,
    pins: {},
    meta: {},
    pollVotes: {},
    lfgMembers: {},
    mutesServer: {},
    mutedLocal: {},
    recentEmojis: [],
    filter: 'all',
    query: '',
    suggest: { open: false, kind: null, items: [], index: 0, token: '', start: 0 },
    emojiCat: 'gaming',
    listeners: [],
    chatStats: null,
    titleBase: document.title,
    settings: {
      accent: 'ember',
      density: 'cozy',
      sidebar: 'off',
      sounds: true,
      notifs: false,
      profanity: true,
      timestamps: true
    },
    toolsOpen: false,
    hoverCard: null,
    hoverTimer: null,
    hoverHideTimer: null,
    hoverUid: null,
    profileCache: {},
    bgAssets: null
  };

  var D = {};

  // ============================================================
  // 3. Utilidades
  // ============================================================
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // Envoltorio defensivo para Motion (motion.dev, cargado vía CDN en community.html):
  // si la librería no cargó (red lenta, bloqueador, etc.) el chat sigue funcionando
  // igual, simplemente sin la animación de turno.
  function motionFx(el, keyframes, opts) {
    if (!el || typeof window.Motion === 'undefined' || !window.Motion.animate) return null;
    try { return window.Motion.animate(el, keyframes, opts); } catch (e) { return null; }
  }
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function dayKey(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function dayLabel(ts) {
    var d = new Date(ts || Date.now());
    var today = new Date();
    var yest = new Date(Date.now() - 86400000);
    if (dayKey(d.getTime()) === dayKey(today.getTime())) return 'Hoy';
    if (dayKey(d.getTime()) === dayKey(yest.getTime())) return 'Ayer';
    try {
      return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
    } catch (e) { return d.toLocaleDateString(); }
  }
  function clockLabel(ts) {
    var d = new Date(ts || Date.now());
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function weekKey(ts) {
    var d = new Date(ts || Date.now());
    var day = d.getDay();
    d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
    d.setHours(0, 0, 0, 0);
    return String(d.getTime());
  }
  function myNick() {
    var p = prof();
    var u = me();
    return (p && p.nickname) || (u && u.displayName) || 'Jugador';
  }
  function myPhoto() {
    var p = prof();
    var u = me();
    return (p && p.photoURL) || (u && u.photoURL) || fallbackAvatar();
  }
  function normRango(v) { return String(v || '').toLowerCase(); }
  function isMod() { return MOD_RANGOS.indexOf(normRango(prof().rango)) !== -1; }
  function honorTierOf(honor) {
    var h = Number(honor || 0);
    if (h >= 1000) return 'legend';
    if (h >= 500) return 'gold';
    if (h >= 200) return 'silver';
    if (h >= 50) return 'bronze';
    return 'none';
  }
  function messagesRef(ch) {
    var base = NODE + '/' + ROOM;
    return (ch || S.channel) === 'general'
      ? db().ref(base + '/messages')
      : db().ref(base + '/channels/' + (ch || S.channel) + '/messages');
  }
  function roomRef(path) { return db().ref(NODE + '/' + ROOM + (path ? '/' + path : '')); }
  function track(ref, event, cb) {
    ref.on(event, cb);
    S.listeners.push({ ref: ref, event: event, cb: cb });
  }
  function untrackAll() {
    S.listeners.forEach(function (l) { try { l.ref.off(l.event, l.cb); } catch (e) {} });
    S.listeners = [];
  }

  // --- Sonidos sintéticos (sin assets) ---
  var audioCtx = null;
  function tone(freq, dur, type, gain, delay) {
    if (!S.settings.sounds) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var t0 = audioCtx.currentTime + (delay || 0);
      var osc = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain || 0.05, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (dur || 0.12));
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + (dur || 0.12) + 0.02);
    } catch (e) {}
  }
  function sfxSend() { tone(660, 0.08, 'triangle', 0.04); }
  function sfxRecv() { tone(420, 0.1, 'sine', 0.03); }
  function sfxMention() { tone(720, 0.1, 'triangle', 0.06); tone(980, 0.12, 'triangle', 0.05, 0.09); }
  function sfxPop() { tone(880, 0.06, 'square', 0.03); }

  function maskProfanity(text) {
    if (!S.settings.profanity) return text;
    var out = text;
    BAD_WORDS.forEach(function (w) {
      var re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      out = out.replace(re, function (m) { return m.charAt(0) + '*'.repeat(Math.max(1, m.length - 1)); });
    });
    return out;
  }

  // --- Formato enriquecido seguro (escapa primero, luego formatea) ---
  function formatText(raw) {
    var tokens = [];
    function stash(html) {
      tokens.push(html);
      return '\u0001' + (tokens.length - 1) + '\u0001';
    }

    var text = esc(maskProfanity(String(raw == null ? '' : raw)));

    // Código en línea
    text = text.replace(/`([^`\n]{1,200})`/g, function (m, code) {
      return stash('<code>' + code + '</code>');
    });

    // Enlaces (solo http/https)
    text = text.replace(/(https?:\/\/[^\s<]{4,300})/g, function (m, url) {
      var clean = url.replace(/[.,;:!?)\]]+$/, '');
      var tail = url.slice(clean.length);
      var label = clean.replace(/^https?:\/\//, '');
      if (label.length > 48) label = label.slice(0, 45) + '…';
      return stash('<a class="cf-link" href="' + clean + '" target="_blank" rel="noopener noreferrer nofollow">' + label + '</a>') + tail;
    });

    // Spoilers
    text = text.replace(/\|\|([^|]{1,300})\|\|/g, '<span class="cf-spoiler" tabindex="0" role="button" title="Mostrar spoiler">$1</span>');

    // Negrita, cursiva, tachado
    text = text.replace(/\*\*([^*\n]{1,300})\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|\s)\*([^*\n]{1,300})\*/g, '$1<em>$2</em>');
    text = text.replace(/(^|\s)_([^_\n]{1,300})_/g, '$1<em>$2</em>');
    text = text.replace(/~~([^~\n]{1,300})~~/g, '<del>$1</del>');

    // Citas
    text = text.replace(/^&gt;\s?(.*)$/gm, '<span class="cf-quote-inline">$1</span>');

    // Menciones
    var mine = String(myNick() || '').toLowerCase();
    text = text.replace(/@([A-Za-z0-9_.\-]{2,24})/g, function (m, nick) {
      var low = nick.toLowerCase();
      var isMe = low === mine || low === 'everyone' || low === 'todos';
      return '<span class="message-mention' + (isMe ? ' cf-mention-me' : '') + '" data-mention="' + esc(nick) + '">@' + esc(nick) + '</span>';
    });

    // Restaurar tokens
    text = text.replace(/\u0001(\d+)\u0001/g, function (m, i) { return tokens[Number(i)] || ''; });
    return text;
  }

  function isEmojiOnly(text) {
    var t = String(text || '').replace(/\s/g, '');
    if (!t || t.length > 12) return false;
    return !/[A-Za-z0-9]/.test(t) && /[\u203C-\u3299\u{1F000}-\u{1FAFF}\u2600-\u27BF]/u.test(t);
  }

  function mentionsMe(text) {
    var nick = String(myNick() || '').toLowerCase();
    var low = String(text || '').toLowerCase();
    if (!nick) return false;
    return low.indexOf('@' + nick) !== -1 || low.indexOf('@everyone') !== -1 || low.indexOf('@todos') !== -1;
  }

  // ============================================================
  // 4. Arranque
  // ============================================================
  function boot(opts) {
    if (S.booted) return;
    D.shell = document.getElementById('cfShell');
    D.stream = document.getElementById('campfireMessages');
    if (!D.shell || !D.stream) return;
    if (opts && opts.node) NODE = opts.node;
    if (opts && opts.room) ROOM = opts.room;
    S.booted = true;

    cacheDom();
    loadSettings();
    S.mutedLocal = lsGet('cf.mutedUsers', {}) || {};
    S.recentEmojis = lsGet('cf.recentEmojis', []) || [];
    EMOJI_CATS[0].list = S.recentEmojis.slice(0, 30);

    buildEmojiPicker();
    bindTopbar();
    bindComposer();
    bindStream();
    bindGlobalKeys();
    startEmbers();
    startClockTicker();
    initPresenceUi();

    watchConnection();
    watchBot();
    watchMeta();
    watchPins();
    watchTyping();
    watchPolls();
    watchLfg();
    watchLeaderboard();
    watchServerMutes();
    watchMyStats();

    openChannel('general', true);
    restoreDraft();
    maybeDeepLink();
    ensureChatFrameAssets();
    if (myUid()) ensureFrameListener(myUid());
  }

  function cacheDom() {
    [
      'cfEmbers', 'cfConnBanner', 'cfPinned', 'cfSearchBar', 'cfSearchInput',
      'cfSearchCount', 'cfSearchClose', 'cfSettings', 'cfTyping',
      'cfJump', 'cfJumpCount', 'cfLoadOlder', 'cfComposer', 'cfReplyChip', 'cfAttachPreview',
      'cfSuggest', 'cfEmojiPop', 'cfEmojiBtn', 'cfAttachBtn', 'cfFileInput', 'cfInput',
      'cfSend', 'cfTopicText', 'cfSearchToggle', 'cfSettingsToggle', 'cfHelpToggle',
      'cfExpandToggle', 'cfMenuToggle', 'cfMenu', 'cfPresence', 'cfPresenceBtn',
      'cfPresenceLabel', 'cfPresenceMenu', 'cfPresenceTip', 'cfPresenceMenuCount'
    ].forEach(function (id) { D[id] = document.getElementById(id); });
  }

  function loadSettings() {
    var saved = lsGet('cf.settings', null);
    if (saved && typeof saved === 'object') {
      Object.keys(S.settings).forEach(function (k) {
        if (typeof saved[k] !== 'undefined') S.settings[k] = saved[k];
      });
    }
    applySettings();
    setMenuOpen(false);
    setPresenceMenuOpen(false);
  }
  function saveSettings() { lsSet('cf.settings', S.settings); }
  function applySettings() {
    D.shell.setAttribute('data-cf-accent', S.settings.accent);
    D.shell.setAttribute('data-cf-density', S.settings.density || 'cozy');
  }

  function setMenuOpen(open) {
    S.toolsOpen = !!open;
    if (D.cfMenu) {
      if (open) D.cfMenu.removeAttribute('hidden');
      else D.cfMenu.setAttribute('hidden', '');
    }
    if (D.cfMenuToggle) {
      D.cfMenuToggle.classList.toggle('active', open);
      D.cfMenuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (open) setPresenceMenuOpen(false);
  }

  function setPresenceMenuOpen(open) {
    if (D.cfPresenceMenu) {
      if (open) D.cfPresenceMenu.removeAttribute('hidden');
      else D.cfPresenceMenu.setAttribute('hidden', '');
    }
    if (D.cfPresenceBtn) D.cfPresenceBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (D.cfPresence) D.cfPresence.classList.toggle('open', !!open);
    if (open) setMenuOpen(false);
  }

  function initPresenceUi() {
    var p = prof();
    var statuses = playerStatuses();
    var current = statuses.find(function (s) { return s.value === (p.status || ''); }) || statuses[0] || { emoji: '🟢', label: 'En línea', value: '' };
    setPresenceLabel(current);
    var tipCount = document.getElementById('onlineCount');
    if (tipCount && tipCount.textContent) refreshPresence(tipCount.textContent);
  }

  function setPresenceLabel(status) {
    if (!D.cfPresenceLabel) return;
    var s = status || { emoji: '🟢', label: 'En línea' };
    D.cfPresenceLabel.textContent = s.label || 'En línea';
    if (D.cfPresenceBtn) {
      D.cfPresenceBtn.setAttribute('data-status', s.value || '');
      D.cfPresenceBtn.title = 'Tu estado: ' + (s.label || 'En línea');
    }
  }

  function refreshPresence(count) {
    var n = (count === 0 || count) ? String(count) : '—';
    var tip = document.getElementById('onlineCount');
    if (tip) tip.textContent = n;
    if (D.cfPresenceMenuCount) D.cfPresenceMenuCount.textContent = n;
    if (D.cfPresenceTip) D.cfPresenceTip.setAttribute('data-count', n);
  }

  // ============================================================
  // 5. Canales
  // ============================================================
  function renderChannels() {
    if (!D.cfChannels) return;
    D.cfChannels.innerHTML = '';
    CHANNELS.forEach(function (ch) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-chan' + (ch.id === S.channel ? ' active' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('data-cf-chan', ch.id);
      b.title = ch.hint;
      b.innerHTML = '<i class="fas ' + ch.icon + '"></i> ' + esc(ch.label);
      b.addEventListener('click', function () { openChannel(ch.id); });
      D.cfChannels.appendChild(b);
    });
  }

  function openChannel(id, force) {
    if (!force && id === S.channel) return;
    var ch = CHANNELS.filter(function (c) { return c.id === id; })[0];
    if (!ch) return;

    saveDraft();
    if (S.msgQuery && S.msgListeners) {
      try {
        S.msgQuery.off('child_added', S.msgListeners.added);
        S.msgQuery.off('child_changed', S.msgListeners.changed);
        S.msgQuery.off('child_removed', S.msgListeners.removed);
      } catch (e) {}
    }

    S.channel = id;
    S.msgs = {};
    S.nodes = {};
    S.order = [];
    S.oldestTs = null;
    S.exhausted = false;
    S.unread = 0;
    S.unreadMarkerId = null;
    S.atBottom = true;
    setReply(null);
    cancelEdit();

    if (D.cfInput) {
      D.cfInput.placeholder = 'Escribe algo para el campamento…';
    }
    renderPinnedBar();
    showSkeleton();
    subscribeMessages();
    restoreDraft();
    updateJump();
  }

  function showSkeleton() {
    D.stream.innerHTML = '';
    for (var i = 0; i < 4; i += 1) {
      var sk = document.createElement('div');
      sk.className = 'cf-skeleton-msg';
      sk.innerHTML = '<div class="cf-skel-avatar"></div><div><div class="cf-skel-line short" style="margin-bottom:6px"></div><div class="cf-skel-line" style="width:' + (55 + i * 8) + '%"></div></div>';
      D.stream.appendChild(sk);
    }
  }

  function showEmptyState() {
    D.stream.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'campfire-empty-state';
    var prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    wrap.innerHTML =
      '<i class="fas fa-fire" style="font-size:1.6rem;color:#ff8a3d"></i>' +
      '<p style="margin:0.5rem 0 0">El fuego está encendido pero nadie habla. ¡Enciende la conversación!</p>' +
      '<div class="cf-empty-prompts"></div>';
    var chips = wrap.querySelector('.cf-empty-prompts');
    [prompt, '¡Hola campamento! 👋', '/lfg CS2 | 4 | ranked chill'].forEach(function (p) {
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'cf-prompt-chip';
      c.textContent = p;
      c.addEventListener('click', function () {
        D.cfInput.value = p;
        D.cfInput.focus();
        updateCounter();
      });
      chips.appendChild(c);
    });
    D.stream.appendChild(wrap);
  }

  // ============================================================
  // 6. Suscripción a mensajes (incremental)
  // ============================================================
  function subscribeMessages() {
    var ref = messagesRef();
    var q = ref.orderByChild('timestamp').limitToLast(PAGE);
    S.msgQuery = q;
    var firstBatch = true;
    var pendingFirst = 0;

    var added = function (snap) {
      var data = snap.val() || {};
      var id = snap.key;
      if (HIDE_BOT_MESSAGES && isBotMessage(data)) return;
      if (firstBatch) pendingFirst += 1;
      if (S.order.indexOf(id) === -1 && !S.msgs[id]) {
        S.msgs[id] = data;
        insertMessage(id, data, false);
        var ts = Number(data.timestamp || 0);
        if (ts && (!S.oldestTs || ts < S.oldestTs)) S.oldestTs = ts;
        if (!firstBatch) onIncoming(id, data);
      } else {
        S.msgs[id] = data;
        rerenderMessage(id);
      }
    };
    var changed = function (snap) {
      S.msgs[snap.key] = snap.val() || {};
      rerenderMessage(snap.key);
    };
    var removed = function (snap) {
      var id = snap.key;
      messagesRef().child(id).once('value').then(function (s) {
        if (!s.exists()) dropMessage(id);
      }).catch(function () { dropMessage(id); });
    };

    S.msgListeners = { added: added, changed: changed, removed: removed };
    q.on('child_added', added, onStreamError);
    q.on('child_changed', changed);
    q.on('child_removed', removed);

    q.once('value').then(function (snap) {
      firstBatch = false;
      if (!snap.exists() || !snap.hasChildren()) {
        showEmptyState();
      } else {
        cleanupSkeleton();
        relayout();
        scrollToBottom(true);
      }
      if (D.cfLoadOlder) D.cfLoadOlder.hidden = pendingFirst < PAGE;
    }).catch(onStreamError);
  }

  function onStreamError(err) {
    console.error('[Campfire] stream', err);
    banner('No se pudo cargar el chat. Revisa las reglas de Realtime Database (globalChat).', 'error');
  }

  function cleanupSkeleton() {
    Array.prototype.forEach.call(D.stream.querySelectorAll('.cf-skeleton-msg, .campfire-empty-state'), function (n) {
      n.remove();
    });
  }

  function loadOlder() {
    if (S.exhausted || !S.oldestTs) return;
    D.cfLoadOlder.disabled = true;
    D.cfLoadOlder.textContent = 'Cargando…';
    var prevH = D.stream.scrollHeight;
    messagesRef().orderByChild('timestamp').endAt(S.oldestTs - 1).limitToLast(PAGE).once('value')
      .then(function (snap) {
        var items = [];
        snap.forEach(function (child) { items.push({ id: child.key, val: child.val() || {} }); });
        if (!items.length) {
          S.exhausted = true;
          D.cfLoadOlder.hidden = true;
          return;
        }
        items.sort(function (a, b) { return (a.val.timestamp || 0) - (b.val.timestamp || 0); });
        items.forEach(function (it) {
          if (S.msgs[it.id]) return;
          if (HIDE_BOT_MESSAGES && isBotMessage(it.val)) return;
          S.msgs[it.id] = it.val;
          insertMessage(it.id, it.val, true);
          var ts = Number(it.val.timestamp || 0);
          if (ts && (!S.oldestTs || ts < S.oldestTs)) S.oldestTs = ts;
        });
        relayout();
        D.stream.scrollTop = D.stream.scrollHeight - prevH;
        if (items.length < PAGE) {
          S.exhausted = true;
          D.cfLoadOlder.hidden = true;
        }
      })
      .catch(function () { toast('No se pudieron cargar mensajes anteriores', 'error'); })
      .finally(function () {
        D.cfLoadOlder.disabled = false;
        D.cfLoadOlder.textContent = 'Cargar mensajes anteriores';
      });
  }

  function onIncoming(id, data) {
    var mine = data.userId === myUid();
    if (mine) return;
    if (mentionsMe(data.text)) {
      sfxMention();
      notifyMention(data);
    } else {
      sfxRecv();
    }
    if (!S.atBottom) {
      S.unread += 1;
      if (!S.unreadMarkerId) S.unreadMarkerId = id;
      updateJump();
      relayout();
    }
    if (document.hidden) {
      S.hiddenCount = (S.hiddenCount || 0) + 1;
      document.title = '(' + S.hiddenCount + ') ' + S.titleBase;
    }
  }

  function notifyMention(data) {
    toast('💬 ' + (data.userNick || data.nick || 'Alguien') + ' te mencionó en el chat', 'info');
    if (!S.settings.notifs || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    try {
      new Notification('Te mencionaron en el Fuego de Campamento', {
        body: String(data.text || '').slice(0, 120),
        icon: '/community.png'
      });
    } catch (e) {}
  }

  // ============================================================
  // 7. Render de mensajes
  // ============================================================
  function insertMessage(id, data, prepend) {
    var node = buildMessage(id, data);
    S.nodes[id] = node;
    cleanupSkeleton();

    var ts = Number(data.timestamp || 0);
    if (prepend) {
      var first = D.stream.querySelector('.cf-msg');
      if (first) D.stream.insertBefore(node, first);
      else D.stream.appendChild(node);
      S.order.unshift(id);
    } else {
      var wasBottom = S.atBottom;
      var idx = S.order.length;
      while (idx > 0 && Number((S.msgs[S.order[idx - 1]] || {}).timestamp || 0) > ts) idx -= 1;
      if (idx >= S.order.length) {
        D.stream.appendChild(node);
        S.order.push(id);
      } else {
        var refNode = S.nodes[S.order[idx]];
        if (refNode) D.stream.insertBefore(node, refNode);
        else D.stream.appendChild(node);
        S.order.splice(idx, 0, id);
      }
      if (wasBottom) scrollToBottom();
    }
    // Nota: la entrada de cada mensaje ya se anima vía CSS (@keyframes cfMsgIn
    // en campfire-chat.css), así que no se duplica aquí con Motion.
    scheduleRelayout();
    trimDom();
  }

  function dropMessage(id) {
    var node = S.nodes[id];
    if (node) node.remove();
    delete S.nodes[id];
    delete S.msgs[id];
    var i = S.order.indexOf(id);
    if (i !== -1) S.order.splice(i, 1);
    scheduleRelayout();
    if (!S.order.length) showEmptyState();
  }

  function rerenderMessage(id) {
    var old = S.nodes[id];
    if (!old) return;
    var fresh = buildMessage(id, S.msgs[id] || {});
    old.replaceWith(fresh);
    S.nodes[id] = fresh;
    scheduleRelayout();
  }

  function trimDom() {
    while (S.order.length > MAX_DOM) {
      var id = S.order.shift();
      if (S.nodes[id]) S.nodes[id].remove();
      delete S.nodes[id];
      delete S.msgs[id];
    }
  }

  function authorOf(d) { return d.userNick || d.nick || 'Anónimo'; }
  function photoOf(d) {
    if (d.userId === BOT_UID || d.type === 'bot') return 'community.png';
    return d.userPhoto || d.photoURL || fallbackAvatar();
  }

  function ensureChatFrameAssets() {
    var SG = window.SGProfileCustomization;
    if (!SG || typeof SG.loadAssets !== 'function' || typeof firebase === 'undefined') return Promise.resolve();
    return SG.loadAssets(firebase.database()).catch(function () {});
  }

  function applyChatFrame(wrap, frameId) {
    if (!wrap) return;
    var SG = window.SGProfileCustomization;
    if (!SG || typeof SG.applyFrameId !== 'function') return;
    ensureChatFrameAssets().then(function () {
      SG.applyFrameId(wrap, frameId || null);
    });
  }

  function paintFramesForUid(uid, frameId) {
    if (!uid || !D.stream) return;
    var nodes = D.stream.querySelectorAll('.cf-msg[data-cf-uid="' + uid + '"] .cf-avatar-wrap');
    for (var i = 0; i < nodes.length; i += 1) applyChatFrame(nodes[i], frameId);
    if (S.hoverUid === uid && S.hoverCard) {
      var cardWrap = S.hoverCard.querySelector('.cf-user-card-avatar-wrap');
      if (cardWrap) applyChatFrame(cardWrap, frameId);
    }
    if (S.profileCache && S.profileCache[uid]) S.profileCache[uid].frameId = frameId;
  }

  function effectiveChatFrame(uid, msgData) {
    var entry = frameCache[uid];
    if (entry && entry.applied !== undefined) return entry.applied;
    return (msgData && (msgData.equippedFrame || msgData.frameId)) || null;
  }

  function onRemoteFrameChange(uid, rawFrameId) {
    var next = rawFrameId && rawFrameId !== 'default' ? String(rawFrameId) : null;
    var entry = frameCache[uid] || (frameCache[uid] = {});
    if (entry.applied === undefined) {
      // Primera lectura: se pinta ya, sin delay (carga inicial del chat).
      entry.applied = next;
      paintFramesForUid(uid, next);
      return;
    }
    if (next === entry.applied) {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      entry.pending = null;
      return;
    }
    // Cambio detectado: se aplica al chat solo tras el delay anti-abuso.
    entry.pending = next;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(function () {
      entry.applied = entry.pending;
      entry.pending = null;
      entry.timer = null;
      paintFramesForUid(uid, entry.applied);
    }, FRAME_CHAT_DELAY_MS);
  }

  function ensureFrameListener(uid) {
    if (!uid || uid === BOT_UID) return;
    var entry = frameCache[uid] || (frameCache[uid] = {});
    if (entry.listening) return;
    entry.listening = true;
    try {
      var ref = db().ref('users/' + uid + '/profileCustomization/equippedFrame');
      track(ref, 'value', function (snap) {
        onRemoteFrameChange(uid, snap.val());
      });
    } catch (e) {
      entry.listening = false;
    }
  }

  function myEquippedFrame() {
    var entry = frameCache[myUid()];
    if (entry && entry.applied !== undefined) return entry.applied;
    var p = prof();
    var cust = (p && p.profileCustomization) || {};
    var id = cust.equippedFrame || cust.equippedFrameId || cust.frameId || null;
    return id && id !== 'default' ? id : null;
  }

  function buildMessage(id, d) {
    var el = document.createElement('div');
    var isBot = d.type === 'bot' || d.userId === BOT_UID;
    var mine = d.userId && d.userId === myUid();
    var nick = authorOf(d);
    var text = String(d.text || '');

    el.className = 'campfire-message cf-msg' + (isBot ? ' campfire-message-bot' : '');
    el.id = 'cf-msg-' + id;
    el.setAttribute('data-cf-id', id);
    el.setAttribute('data-cf-uid', d.userId || '');
    el.setAttribute('data-cf-nick', nick);
    el.setAttribute('data-cf-ts', String(d.timestamp || 0));
    el.setAttribute('data-cf-type', d.type || 'text');
    if (mine) el.setAttribute('data-cf-own', '1');
    if (d.deleted) el.setAttribute('data-cf-deleted', '1');
    if (d.action) el.setAttribute('data-cf-action', '1');
    if (!isBot && !mine && mentionsMe(text)) el.setAttribute('data-cf-mentioned', '1');
    if (isEmojiOnly(text) && !d.imageURL && !d.poll) el.setAttribute('data-cf-jumbo', '1');

    var tier = honorTierOf(d.honor);
    if (mine) tier = honorTierOf(prof().communityHonor);
    if (tier !== 'none') el.setAttribute('data-cf-tier', tier);

    // Avatar + marco (wrap para poder colocar el overlay encima)
    var wrap = document.createElement('div');
    wrap.className = 'cf-avatar-wrap';
    var av = document.createElement('img');
    av.className = 'message-avatar' + (isBot ? '' : ' community-user-link');
    av.alt = '';
    av.loading = 'lazy';
    av.src = photoOf(d);
    av.addEventListener('error', function () { av.src = fallbackAvatar(); });
    if (!isBot) {
      av.setAttribute('data-community-uid', d.userId || '');
      av.setAttribute('data-community-nick', nick);
      bindAvatarHover(av, d.userId || '', nick, photoOf(d));
      if (d.userId) {
        ensureFrameListener(d.userId);
        applyChatFrame(wrap, effectiveChatFrame(d.userId, d));
      }
    }
    wrap.appendChild(av);
    el.appendChild(wrap);

    var col = document.createElement('div');
    col.className = 'cf-msg-col';

    // Cabecera
    var head = document.createElement('div');
    head.className = 'cf-msg-head';
    var author = document.createElement('span');
    author.className = 'message-author' + (isBot ? '' : ' community-user-link');
    author.textContent = nick;
    if (!isBot) {
      author.setAttribute('data-community-uid', d.userId || '');
      author.setAttribute('data-community-nick', nick);
    }
    head.appendChild(author);

    if (isBot) head.appendChild(badge('bot', 'Nexo'));
    else if (MOD_RANGOS.indexOf(normRango(d.rango)) !== -1) {
      head.appendChild(badge(normRango(d.rango) === 'boss_of_the_state' ? 'boss' : 'commander',
        normRango(d.rango) === 'boss_of_the_state' ? 'Boss' : 'Cmdr'));
    }
    if (Number(d.streak) > 1) {
      var st = document.createElement('span');
      st.className = 'cf-streak-badge';
      st.title = 'Racha de ' + d.streak + ' días en el chat';
      st.textContent = '🔥' + d.streak;
      head.appendChild(st);
    }
    if (S.settings.timestamps) {
      var time = document.createElement('span');
      time.className = 'cf-msg-time';
      time.textContent = clockLabel(d.timestamp);
      time.title = new Date(d.timestamp || Date.now()).toLocaleString();
      head.appendChild(time);
    }
    col.appendChild(head);

    // Burbuja
    var bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (d.replyTo && d.replyTo.id) {
      var q = document.createElement('div');
      q.className = 'cf-reply-quote';
      q.innerHTML = '<i class="fas fa-reply"></i><strong>' + esc(d.replyTo.nick || '') + '</strong><span>' + esc(String(d.replyTo.text || '').slice(0, 90)) + '</span>';
      q.addEventListener('click', function () { jumpTo(d.replyTo.id); });
      bubble.appendChild(q);
    }

    var body = document.createElement('div');
    body.className = 'message-text';
    if (d.deleted) {
      body.textContent = 'Mensaje eliminado';
    } else if (d.action) {
      body.innerHTML = '✳ ' + formatText(nick + ' ' + text);
    } else if (text) {
      body.innerHTML = formatText(text);
    }
    if (d.editedAt && !d.deleted) {
      var ed = document.createElement('span');
      ed.className = 'cf-edited';
      ed.textContent = '(editado)';
      body.appendChild(ed);
    }
    if (body.textContent || body.innerHTML) bubble.appendChild(body);

    // Media
    if (!d.deleted && (d.imageURL || d.videoURL)) {
      if (d.videoURL) {
        var vid = document.createElement('video');
        vid.className = 'cf-msg-image';
        vid.src = d.videoURL;
        vid.controls = true;
        vid.muted = true;
        vid.playsInline = true;
        bubble.appendChild(vid);
      } else {
        var img = document.createElement('img');
        img.className = 'cf-msg-image';
        img.src = d.imageURL;
        img.alt = d.title ? String(d.title) : 'Imagen del chat';
        img.loading = 'lazy';
        img.addEventListener('click', function () { openLightbox(d.imageURL); });
        bubble.appendChild(img);
      }
      if (d.title) {
        var cap = document.createElement('div');
        cap.className = 'cf-card-meta';
        cap.textContent = String(d.title).slice(0, 120);
        bubble.appendChild(cap);
      }
    }

    if (!d.deleted && d.poll) bubble.appendChild(buildPoll(id, d));
    if (!d.deleted && d.lfg) bubble.appendChild(buildLfg(id, d));
    if (!d.deleted && d.type === 'help') bubble.appendChild(buildHelpCard(id, d));

    if (!d.deleted) {
      var reactions = buildReactions(id, d);
      if (reactions) bubble.appendChild(reactions);
    }

    col.appendChild(bubble);
    el.appendChild(col);

    if (!d.deleted) el.appendChild(buildActions(id, d, mine, isBot));

    // Spoilers
    Array.prototype.forEach.call(el.querySelectorAll('.cf-spoiler'), function (sp) {
      sp.addEventListener('click', function () { sp.classList.toggle('revealed'); });
      sp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sp.classList.toggle('revealed'); }
      });
    });
    // Menciones clicables
    Array.prototype.forEach.call(el.querySelectorAll('.message-mention'), function (mn) {
      mn.addEventListener('click', function () {
        insertAtCursor('@' + mn.getAttribute('data-mention') + ' ');
      });
    });

    if (!isBot) bindUserClicks(el);
    if (S.mutedLocal[d.userId]) el.classList.add('cf-hidden-by-filter');
    if (S.mutesServer[d.userId] && Number(S.mutesServer[d.userId].until || 0) > Date.now()) {
      el.classList.add('cf-hidden-by-filter');
    }
    return el;
  }

  function badge(role, label) {
    var b = document.createElement('span');
    b.className = 'cf-role-badge';
    b.setAttribute('data-cf-role', role);
    b.textContent = label;
    return b;
  }

  function buildReactions(id, d) {
    var reactions = d.reactions || {};
    var keys = Object.keys(reactions).filter(function (k) {
      var m = reactions[k];
      return m && typeof m === 'object' && Object.keys(m).length > 0;
    });
    if (!keys.length) return null;
    var wrap = document.createElement('div');
    wrap.className = 'cf-reactions';
    keys.forEach(function (emo) {
      var users = Object.keys(reactions[emo] || {});
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-react' + (users.indexOf(myUid()) !== -1 ? ' mine' : '');
      b.innerHTML = '<span>' + esc(emo) + '</span><span class="cf-react-count">' + users.length + '</span>';
      b.title = users.length + (users.length === 1 ? ' reacción' : ' reacciones');
      b.addEventListener('click', function () { toggleReaction(id, emo); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function buildActions(id, d, mine, isBot) {
    var bar = document.createElement('div');
    bar.className = 'cf-msg-actions';

    bar.appendChild(action('far fa-smile', 'Reaccionar', function (e) { openQuickReact(id, e.currentTarget); }));
    bar.appendChild(action('fas fa-reply', 'Responder', function () { setReply({ id: id, nick: authorOf(d), text: String(d.text || '').slice(0, 120) }); }));
    bar.appendChild(action('fas fa-copy', 'Copiar texto', function () {
      copyText(String(d.text || ''));
    }));
    bar.appendChild(action('fas fa-link', 'Copiar enlace', function () {
      copyText(location.origin + location.pathname + '#msg-' + id);
    }));
    if (mine && !isBot) {
      bar.appendChild(action('fas fa-pen', 'Editar', function () { startEdit(id); }));
    }
    if (isMod()) {
      bar.appendChild(action('fas fa-thumbtack', 'Fijar', function () { togglePin(id, d); }));
    }
    if (mine || isMod()) {
      bar.appendChild(action('fas fa-trash', 'Eliminar', function () { deleteMessage(id, mine); }, true));
    }
    if (!mine && !isBot) {
      bar.appendChild(action('fas fa-flag', 'Reportar', function () { reportMessage(id, d); }));
      bar.appendChild(action('fas fa-user-slash', 'Silenciar para mí', function () { muteLocal(d.userId, authorOf(d)); }));
    }
    return bar;
  }

  function action(icon, title, handler, danger) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cf-msg-action' + (danger ? ' danger' : '');
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = '<i class="' + icon + '"></i>';
    b.addEventListener('click', handler);
    return b;
  }

  function copyText(text) {
    try {
      navigator.clipboard.writeText(text).then(function () { toast('Copiado', 'success'); });
    } catch (e) { toast('No se pudo copiar', 'error'); }
  }

  // Popover rápido de reacciones
  function openQuickReact(id, anchor) {
    var existing = document.querySelector('.cf-quick-react');
    if (existing) existing.remove();
    var pop = document.createElement('div');
    pop.className = 'cf-msg-actions cf-quick-react';
    pop.style.opacity = '1';
    pop.style.pointerEvents = 'auto';
    pop.style.transform = 'none';
    pop.style.top = '-40px';
    pop.style.right = '4px';
    REACTIONS.forEach(function (emo) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-msg-action';
      b.textContent = emo;
      b.addEventListener('click', function () {
        toggleReaction(id, emo);
        pop.remove();
      });
      pop.appendChild(b);
    });
    var host = S.nodes[id];
    if (host) host.appendChild(pop);
    setTimeout(function () {
      document.addEventListener('click', function once(ev) {
        if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('click', once); }
      });
    }, 10);
  }

  function toggleReaction(id, emoji) {
    var uid = myUid();
    if (!uid) return;
    var ref = messagesRef().child(id).child('reactions').child(emoji).child(uid);
    ref.once('value').then(function (s) {
      if (s.exists()) return ref.remove();
      sfxPop();
      return ref.set(true);
    }).catch(function () { toast('No se pudo reaccionar', 'error'); });
  }

  // ============================================================
  // 8. Layout: separadores de día, agrupado, no leídos, filtros
  // ============================================================
  var relayoutRaf = null;
  function scheduleRelayout() {
    if (relayoutRaf) return;
    relayoutRaf = requestAnimationFrame(function () {
      relayoutRaf = null;
      relayout();
    });
  }

  function relayout() {
    Array.prototype.forEach.call(D.stream.querySelectorAll('.cf-day-sep, .cf-unread-sep'), function (n) { n.remove(); });
    var lastDay = null;
    var prev = null;
    S.order.forEach(function (id) {
      var node = S.nodes[id];
      var d = S.msgs[id];
      if (!node || !d) return;
      var ts = Number(d.timestamp || 0);
      var dk = dayKey(ts);
      if (dk !== lastDay) {
        var sep = document.createElement('div');
        sep.className = 'cf-day-sep';
        sep.textContent = dayLabel(ts);
        D.stream.insertBefore(sep, node);
        lastDay = dk;
        prev = null;
      }
      if (S.unreadMarkerId === id && S.unread > 0) {
        var us = document.createElement('div');
        us.className = 'cf-unread-sep';
        us.textContent = 'Mensajes nuevos';
        D.stream.insertBefore(us, node);
        prev = null;
      }
      var grouped = !!prev
        && prev.userId === d.userId
        && !d.replyTo
        && !d.poll && !d.lfg && !d.imageURL && !d.videoURL
        && d.type !== 'help'
        && (ts - Number(prev.timestamp || 0)) < GROUP_WINDOW_MS;
      node.classList.toggle('cf-grouped', grouped);
      prev = d;
    });
    applyFilters();
  }

  function applyFilters() {
    var q = String(S.query || '').trim().toLowerCase();
    var hits = 0;
    S.order.forEach(function (id) {
      var node = S.nodes[id];
      var d = S.msgs[id];
      if (!node || !d) return;
      var hide = false;
      if (S.mutedLocal[d.userId]) hide = true;
      if (S.mutesServer[d.userId] && Number(S.mutesServer[d.userId].until || 0) > Date.now()) hide = true;
      if (!hide) {
        switch (S.filter) {
          case 'mentions': hide = !mentionsMe(d.text); break;
          case 'images': hide = !(d.imageURL || d.videoURL); break;
          case 'mine': hide = d.userId !== myUid(); break;
          case 'pinned': hide = !S.pins[id]; break;
          case 'bot': hide = !(d.type === 'bot' || d.userId === BOT_UID); break;
          default: hide = false;
        }
      }
      if (!hide && q) {
        var hay = (String(d.text || '') + ' ' + authorOf(d)).toLowerCase();
        hide = hay.indexOf(q) === -1;
        if (!hide) hits += 1;
      }
      node.classList.toggle('cf-hidden-by-filter', hide);
      var textEl = node.querySelector('.message-text');
      if (textEl) {
        if (q && !hide) highlight(textEl, q);
        else clearHighlight(textEl);
      }
    });
    if (D.cfSearchCount) {
      D.cfSearchCount.textContent = q ? (hits + (hits === 1 ? ' resultado' : ' resultados')) : '';
    }
  }

  function highlight(el, query) {
    if (typeof el._cfOrig === 'undefined') el._cfOrig = el.innerHTML;
    else el.innerHTML = el._cfOrig;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var targets = [];
    while (walker.nextNode()) {
      var n = walker.currentNode;
      if (n.nodeValue && n.nodeValue.toLowerCase().indexOf(query) !== -1) targets.push(n);
    }
    targets.forEach(function (n) {
      var frag = document.createDocumentFragment();
      var text = n.nodeValue;
      var low = text.toLowerCase();
      var i = 0;
      var at;
      while ((at = low.indexOf(query, i)) !== -1) {
        if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)));
        var mark = document.createElement('mark');
        mark.className = 'cf-hit';
        mark.textContent = text.substr(at, query.length);
        frag.appendChild(mark);
        i = at + query.length;
      }
      if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
      n.parentNode.replaceChild(frag, n);
    });
  }

  function clearHighlight(el) {
    if (typeof el._cfOrig !== 'undefined') {
      el.innerHTML = el._cfOrig;
      delete el._cfOrig;
    }
  }

  // ============================================================
  // 9. Scroll, salto, no leídos
  // ============================================================
  function bindStream() {
    D.stream.addEventListener('scroll', function () {
      hideUserCard(true);
      var gap = D.stream.scrollHeight - D.stream.scrollTop - D.stream.clientHeight;
      S.atBottom = gap < 40;
      if (S.atBottom) {
        S.unread = 0;
        S.unreadMarkerId = null;
        updateJump();
      }
      if (D.stream.scrollTop < 60 && !S.exhausted && D.cfLoadOlder && !D.cfLoadOlder.hidden) loadOlder();
    }, { passive: true });

    if (D.cfLoadOlder) D.cfLoadOlder.addEventListener('click', loadOlder);
    if (D.cfJump) D.cfJump.addEventListener('click', function () { scrollToBottom(true); });

    D.stream.addEventListener('contextmenu', function (e) {
      var msg = e.target.closest ? e.target.closest('.cf-msg') : null;
      if (!msg) return;
      e.preventDefault();
      var btn = msg.querySelector('.cf-msg-actions .cf-msg-action');
      msg.classList.add('cf-flash');
      setTimeout(function () { msg.classList.remove('cf-flash'); }, 900);
      if (btn) btn.focus();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        S.hiddenCount = 0;
        document.title = S.titleBase;
      }
    });
  }

  function scrollToBottom(force) {
    requestAnimationFrame(function () {
      D.stream.scrollTop = D.stream.scrollHeight;
      if (force) {
        S.atBottom = true;
        S.unread = 0;
        S.unreadMarkerId = null;
        updateJump();
        relayout();
      }
    });
  }

  function updateJump() {
    if (!D.cfJump) return;
    var show = !S.atBottom;
    D.cfJump.hidden = !show;
    if (D.cfJumpCount) {
      D.cfJumpCount.textContent = S.unread > 0 ? (S.unread + ' nuevo' + (S.unread === 1 ? '' : 's')) : 'Ir al final';
    }
  }

  function jumpTo(id) {
    var node = S.nodes[id];
    if (!node) {
      toast('Ese mensaje ya no está cargado', 'info');
      return;
    }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('cf-flash');
    setTimeout(function () { node.classList.remove('cf-flash'); }, 1300);
  }

  function maybeDeepLink() {
    var m = /^#msg-(.+)$/.exec(location.hash || '');
    if (!m) return;
    setTimeout(function () { jumpTo(m[1]); }, 1200);
  }

  // ============================================================
  // 10. Composer
  // ============================================================
  function bindComposer() {
    var input = D.cfInput;
    if (!input) return;

    input.addEventListener('input', function () {
      autoGrow();
      updateCounter();
      saveDraft();
      handleSuggest();
      sendTyping();
    });

    input.addEventListener('keydown', function (e) {
      if (S.suggest.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSuggest(); return; }
        if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
        return;
      }
      if (e.key === 'Escape') {
        if (S.editing) cancelEdit();
        else if (S.replyTo) setReply(null);
        else if (S.attach) clearAttach();
        return;
      }
      if (e.key === 'ArrowUp' && !input.value && !S.editing) {
        var lastMine = null;
        for (var i = S.order.length - 1; i >= 0; i -= 1) {
          var d = S.msgs[S.order[i]];
          if (d && d.userId === myUid() && !d.deleted && d.text) { lastMine = S.order[i]; break; }
        }
        if (lastMine) { e.preventDefault(); startEdit(lastMine); }
      }
    });

    input.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          var file = items[i].getAsFile();
          if (file) { e.preventDefault(); setAttach(file); }
          return;
        }
      }
    });

    D.cfSend.addEventListener('click', submit);
    D.cfAttachBtn.addEventListener('click', function () { D.cfFileInput.click(); });
    D.cfFileInput.addEventListener('change', function () {
      if (D.cfFileInput.files && D.cfFileInput.files[0]) setAttach(D.cfFileInput.files[0]);
    });
    D.cfEmojiBtn.addEventListener('click', function () {
      if (D.cfEmojiPop.hidden) {
        openEmojiPicker();
      } else {
        closeEmojiPicker();
      }
    });

    // Arrastrar y soltar imágenes
    ['dragover', 'drop'].forEach(function (ev) {
      D.cfComposer.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          setAttach(e.dataTransfer.files[0]);
        }
      });
    });

    updateCounter();
  }

  function autoGrow() {
    var i = D.cfInput;
    i.style.height = 'auto';
    i.style.height = Math.min(120, i.scrollHeight) + 'px';
  }

  function updateCounter() {
    if (!D.cfInput || !D.cfSend) return;
    var len = D.cfInput.value.length;
    D.cfSend.disabled = (!len && !S.attach) || Date.now() < S.cooldownUntil;
    D.cfInput.setAttribute('data-cf-len', len);
  }

  function draftKey() { return 'cf.draft.' + S.channel; }
  function saveDraft() {
    try { localStorage.setItem(draftKey(), D.cfInput.value || ''); } catch (e) {}
  }
  function restoreDraft() {
    try {
      var v = localStorage.getItem(draftKey()) || '';
      D.cfInput.value = v;
      autoGrow();
      updateCounter();
    } catch (e) {}
  }

  function insertAtCursor(text) {
    var i = D.cfInput;
    var start = i.selectionStart || 0;
    var end = i.selectionEnd || 0;
    i.value = i.value.slice(0, start) + text + i.value.slice(end);
    i.selectionStart = i.selectionEnd = start + text.length;
    i.focus();
    autoGrow();
    updateCounter();
    saveDraft();
  }

  function setReply(info) {
    S.replyTo = info;
    if (!D.cfReplyChip) return;
    if (!info) {
      D.cfReplyChip.hidden = true;
      D.cfReplyChip.innerHTML = '';
      return;
    }
    D.cfReplyChip.hidden = false;
    D.cfReplyChip.innerHTML =
      '<i class="fas fa-reply"></i><span class="cf-chip-text">Respondiendo a <strong>' + esc(info.nick) + '</strong>: ' + esc(info.text) + '</span>' +
      '<button type="button" class="cf-chip-close" aria-label="Cancelar respuesta">&times;</button>';
    D.cfReplyChip.querySelector('.cf-chip-close').addEventListener('click', function () { setReply(null); });
    D.cfInput.focus();
  }

  function setAttach(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('Solo imágenes por ahora', 'error'); return; }
    if (file.size > IMG_MAX_BYTES) { toast('La imagen supera 3.5 MB', 'error'); return; }
    S.attach = file;
    D.cfAttachPreview.hidden = false;
    var url = URL.createObjectURL(file);
    D.cfAttachPreview.innerHTML =
      '<img src="' + url + '" alt="">' +
      '<span class="cf-chip-text">' + esc(file.name) + ' · ' + Math.round(file.size / 1024) + ' KB</span>' +
      '<div class="cf-attach-bar"><div class="cf-attach-fill"></div></div>' +
      '<button type="button" class="cf-chip-close" aria-label="Quitar imagen">&times;</button>';
    D.cfAttachPreview.querySelector('.cf-chip-close').addEventListener('click', clearAttach);
    updateCounter();
  }

  function clearAttach() {
    S.attach = null;
    if (D.cfFileInput) D.cfFileInput.value = '';
    if (D.cfAttachPreview) {
      D.cfAttachPreview.hidden = true;
      D.cfAttachPreview.innerHTML = '';
    }
    updateCounter();
  }

  function startEdit(id) {
    var d = S.msgs[id];
    if (!d) return;
    S.editing = id;
    setReply(null);
    D.cfInput.value = String(d.text || '');
    D.cfInput.focus();
    autoGrow();
    updateCounter();
    if (D.cfReplyChip) {
      D.cfReplyChip.hidden = false;
      D.cfReplyChip.innerHTML = '<i class="fas fa-pen"></i><span class="cf-chip-text">Editando mensaje · Esc para cancelar</span>' +
        '<button type="button" class="cf-chip-close" aria-label="Cancelar edición">&times;</button>';
      D.cfReplyChip.querySelector('.cf-chip-close').addEventListener('click', cancelEdit);
    }
  }

  function cancelEdit() {
    if (!S.editing) return;
    S.editing = null;
    D.cfInput.value = '';
    autoGrow();
    updateCounter();
    setReply(null);
  }

  // --- Escribiendo… ---
  function sendTyping() {
    var uid = myUid();
    if (!uid) return;
    var now = Date.now();
    if (now - S.typingSentAt < 2500) return;
    S.typingSentAt = now;
    var ref = roomRef('typing/' + uid);
    ref.set({ n: myNick(), at: now, ch: S.channel }).catch(function () {});
    try { ref.onDisconnect().remove(); } catch (e) {}
  }

  function clearTyping() {
    var uid = myUid();
    if (!uid) return;
    roomRef('typing/' + uid).remove().catch(function () {});
    S.typingSentAt = 0;
  }

  function watchTyping() {
    track(roomRef('typing'), 'value', function (snap) {
      S.typingUsers = snap.val() || {};
      renderTyping();
    });
    setInterval(renderTyping, 2500);
  }

  function renderTyping() {
    if (!D.cfTyping) return;
    var now = Date.now();
    var uid = myUid();
    var names = Object.keys(S.typingUsers || {}).filter(function (k) {
      var t = S.typingUsers[k];
      return t && k !== uid && (t.ch || 'general') === S.channel && (now - Number(t.at || 0)) < TYPING_TTL;
    }).map(function (k) { return S.typingUsers[k].n || 'Alguien'; });

    var wasVisible = S.typingVisible;
    if (!names.length) {
      D.cfTyping.innerHTML = '';
      if (wasVisible) motionFx(D.cfTyping, { opacity: [1, 0], y: [0, 4] }, { duration: 0.15, ease: 'easeIn' });
      S.typingVisible = false;
      return;
    }
    var label = names.length === 1
      ? esc(names[0]) + ' está escribiendo'
      : (names.length === 2
        ? esc(names[0]) + ' y ' + esc(names[1]) + ' están escribiendo'
        : names.length + ' personas están escribiendo');
    D.cfTyping.innerHTML = '<span class="cf-typing-dots"><i></i><i></i><i></i></span> ' + label;
    // Solo se anima la aparición (cuando pasa de vacío a mostrando algo), no
    // cada refresco de 2.5s mientras ya está visible.
    if (!wasVisible) motionFx(D.cfTyping, { opacity: [0, 1], y: [4, 0] }, { duration: 0.18, ease: 'easeOut' });
    S.typingVisible = true;
  }

  // ============================================================
  // 11. Envío
  // ============================================================
  function canSend() {
    var uid = myUid();
    if (!uid) { toast('Inicia sesión para escribir', 'error'); return false; }
    var mute = S.mutesServer[uid];
    if (mute && Number(mute.until || 0) > Date.now()) {
      toast('Estás silenciado hasta ' + new Date(mute.until).toLocaleTimeString(), 'error');
      return false;
    }
    var now = Date.now();
    if (now < S.cooldownUntil) {
      toast('Espera ' + Math.ceil((S.cooldownUntil - now) / 1000) + 's antes de escribir de nuevo', 'info');
      return false;
    }
    if (now - S.lastSendAt < MIN_SEND_GAP) return false;
    var slow = Number((S.meta || {}).slowSec || 0) * 1000;
    if (slow && !isMod() && now - S.lastSendAt < slow) {
      toast('Modo lento activo: espera ' + Math.ceil((slow - (now - S.lastSendAt)) / 1000) + 's', 'info');
      return false;
    }
    S.sendTimes = S.sendTimes.filter(function (t) { return now - t < BURST_WINDOW; });
    if (S.sendTimes.length >= BURST_LIMIT) {
      startCooldown(BURST_COOLDOWN);
      toast('Vas muy rápido. Pausa de ' + (BURST_COOLDOWN / 1000) + 's para cuidar el chat.', 'info');
      return false;
    }
    return true;
  }

  function startCooldown(ms) {
    S.cooldownUntil = Date.now() + ms;
    updateCounter();
    var bar = document.createElement('div');
    bar.className = 'cf-cooldown';
    D.cfComposer.appendChild(bar);
    var start = Date.now();
    var timer = setInterval(function () {
      var pct = 1 - (Date.now() - start) / ms;
      if (pct <= 0) {
        clearInterval(timer);
        bar.remove();
        updateCounter();
        return;
      }
      bar.style.transform = 'scaleX(' + pct + ')';
    }, 90);
  }

  function submit() {
    var raw = String(D.cfInput.value || '').trim();
    if (!raw && !S.attach) return;
    motionFx(D.cfSend, { scale: [1, 0.82, 1] }, { duration: 0.24, ease: 'easeOut' });

    if (S.editing) {
      var id = S.editing;
      var text = raw.slice(0, MAX_LEN);
      if (!text) { toast('El mensaje no puede quedar vacío', 'error'); return; }
      messagesRef().child(id).update({ text: text, editedAt: Date.now() })
        .then(function () { toast('Mensaje editado', 'success'); })
        .catch(function () { toast('No se pudo editar', 'error'); });
      cancelEdit();
      saveDraft();
      return;
    }

    if (raw.charAt(0) === '/') {
      var handled = runCommand(raw);
      // 'blocked' = el comando no pudo ejecutarse (modo lento / cooldown): conservamos el texto.
      if (handled === 'blocked') return;
      if (handled) {
        D.cfInput.value = '';
        autoGrow();
        updateCounter();
        saveDraft();
        return;
      }
    }

    if (!canSend()) return;

    // Comandos del bot (cofre / trivia) — se conserva la mecánica original
    if (handleBotClaim(raw)) return;

    var text = raw.slice(0, MAX_LEN);
    var mentions = (text.match(/@([A-Za-z0-9_.\-]{2,24})/g) || []);
    if (mentions.length > 5) { toast('Demasiadas menciones en un mensaje', 'error'); return; }
    if (/@(everyone|todos)/i.test(text) && !isMod()) {
      text = text.replace(/@(everyone|todos)/gi, 'todos');
    }
    if (/(.)\1{9,}/.test(text)) text = text.replace(/(.)\1{9,}/g, '$1$1$1');
    if (text.length > 12 && text === text.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(text)) {
      text = text.charAt(0) + text.slice(1).toLowerCase();
    }
    if (S.lastText === text && Date.now() - S.lastSendAt < 8000) {
      toast('No repitas el mismo mensaje', 'info');
      return;
    }

    var payload = baseMessage(text);
    if (S.replyTo) payload.replyTo = { id: S.replyTo.id, nick: S.replyTo.nick, text: S.replyTo.text };

    var file = S.attach;
    D.cfInput.value = '';
    autoGrow();
    updateCounter();
    saveDraft();
    setReply(null);
    clearTyping();

    if (file) uploadThenSend(file, payload);
    else pushMessage(payload);
  }

  function baseMessage(text) {
    var nick = myNick();
    var photo = myPhoto();
    var msg = {
      userId: myUid(),
      nick: nick,
      userNick: nick,
      photoURL: photo,
      userPhoto: photo,
      text: String(text || ''),
      channel: S.channel,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    };
    var rango = normRango(prof().rango);
    if (MOD_RANGOS.indexOf(rango) !== -1) msg.rango = rango;
    var honor = Number(prof().communityHonor || 0);
    if (honor) msg.honor = honor;
    var streak = Number((S.chatStats || {}).streak || 0);
    if (streak > 1) msg.streak = streak;
    var frameId = myEquippedFrame();
    if (frameId) msg.equippedFrame = String(frameId).slice(0, 64);
    return msg;
  }

  function pushMessage(payload, opts) {
    var now = Date.now();
    S.lastSendAt = now;
    S.sendTimes.push(now);
    S.lastText = payload.text;
    sfxSend();

    return messagesRef().push(payload).then(function (ref) {
      afterSend(payload);
      return ref;
    }).catch(function (err) {
      console.error('[Campfire] push', err);
      toast('No se pudo enviar. Revisa las reglas de Realtime Database (globalChat).', 'error');
    });
  }

  function uploadThenSend(file, payload) {
    var uid = myUid();
    var fill = D.cfAttachPreview ? D.cfAttachPreview.querySelector('.cf-attach-fill') : null;
    var name = 'cf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var ref = firebase.storage().ref('chat_images/globalChat/' + uid + '_' + name);
    var task = ref.put(file, { contentType: file.type });
    task.on('state_changed', function (snap) {
      if (fill) fill.style.width = Math.round((snap.bytesTransferred / snap.totalBytes) * 100) + '%';
    });
    task.then(function () {
      return ref.getDownloadURL();
    }).then(function (url) {
      payload.imageURL = url;
      payload.mediaType = 'image';
      clearAttach();
      return pushMessage(payload);
    }).catch(function (err) {
      console.error('[Campfire] upload', err);
      toast(err && err.code === 'storage/unauthorized'
        ? 'Storage denegó la subida (chat_images). Publica las reglas de Storage.'
        : 'No se pudo subir la imagen', 'error');
      clearAttach();
    });
  }

  function afterSend(payload) {
    bumpStats(payload);
    bumpLeaderboard();
    pushFeed('chat', '<strong>' + esc(myNick()) + '</strong> en el Fuego de Campamento');
    var uid = myUid();
    if (uid) {
      db().ref('users/' + uid + '/firstChatAt').once('value').then(function (s) {
        if (!s.exists()) db().ref('users/' + uid).update({ firstChatAt: Date.now() }).catch(function () {});
      }).catch(function () {});
    }
    scrollToBottom(true);
  }

  // Cofre / trivia del Nexo Bot (estado en caché, sin lecturas por mensaje)
  function watchBot() {
    track(botRef(), 'value', function (snap) { S.bot = snap.val() || {}; });
  }

  function botAnnounce(text) {
    messagesRef('general').push({
      userId: BOT_UID,
      userNick: 'Nexo Bot',
      userPhoto: 'community.png',
      type: 'bot',
      text: text,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    }).catch(function () {});
  }

  function handleBotClaim(raw) {
    var lower = raw.toLowerCase();
    var d = S.bot || {};
    var nick = myNick();
    var claimsLoot = lower === '!loot' && d.lootEventId && !d.lootClaimedBy;
    var claimsTrivia = d.triviaAnswer && !d.triviaClaimedBy
      && lower === String(d.triviaAnswer || '').toLowerCase();
    if (!claimsLoot && !claimsTrivia) return false;

    D.cfInput.value = '';
    autoGrow();
    updateCounter();
    saveDraft();

    if (claimsLoot) {
      botRef().update({ lootClaimedBy: myUid() }).then(function () {
        grantHonor(myUid(), 25);
        toast('¡Cofre reclamado! +25 Honor', 'success');
        botAnnounce('🎉 ¡' + nick + ' ha reclamado el cofre! +25 Honor.');
      }).catch(function () { toast('El cofre ya fue reclamado', 'info'); });
    } else {
      botRef().update({ triviaClaimedBy: myUid() }).then(function () {
        grantHonor(myUid(), 15);
        toast('¡Respuesta correcta! +15 Honor', 'success');
        botAnnounce('✅ ¡' + nick + ' acertó la trivia! +15 Honor.');
      }).catch(function () { toast('Alguien respondió antes', 'info'); });
    }
    return true;
  }

  // ============================================================
  // 12. Estadísticas, racha y XP
  // ============================================================
  function bumpStats(payload) {
    var uid = myUid();
    if (!uid) return;
    var today = dayKey();
    var prevDayBefore = (S.chatStats || {}).lastDay || '';
    db().ref('users/' + uid + '/chatStats').transaction(function (cur) {
      var c = cur || {};
      var prevDay = c.lastDay || '';
      var streak = Number(c.streak || 0);
      if (prevDay !== today) {
        var yest = dayKey(Date.now() - 86400000);
        streak = prevDay === yest ? streak + 1 : 1;
      }
      return {
        msgs: Number(c.msgs || 0) + 1,
        xp: Number(c.xp || 0) + (payload.imageURL ? 4 : 2),
        streak: streak,
        lastDay: today,
        lastAt: Date.now()
      };
    }).then(function (res) {
      var val = res && res.snapshot ? res.snapshot.val() : null;
      if (!val) return;
      S.chatStats = val;
      renderMyStats();
      if (prevDayBefore !== today) {
        grantHonor(uid, 5);
        toast('Primer mensaje del día: +5 Honor · racha 🔥' + val.streak, 'success');
      }
      [10, 50, 100, 250, 500, 1000].forEach(function (goal) {
        if (val.msgs === goal) {
          toast('🏅 Logro: ' + goal + ' mensajes en el Fuego de Campamento', 'success');
          pushFeed('chat', '<strong>' + esc(myNick()) + '</strong> alcanzó ' + goal + ' mensajes en el chat');
        }
      });
    }).catch(function () {});
  }

  function bumpLeaderboard() {
    var uid = myUid();
    if (!uid) return;
    roomRef('stats/' + weekKey() + '/' + uid).transaction(function (cur) {
      var c = cur || {};
      return { n: myNick(), p: myPhoto(), c: Number(c.c || 0) + 1 };
    }).catch(function () {});
  }

  function watchMyStats() {
    var uid = myUid();
    if (!uid) return;
    track(db().ref('users/' + uid + '/chatStats'), 'value', function (snap) {
      S.chatStats = snap.val() || {};
      renderMyStats();
    });
  }

  function renderMyStats() {
    // Panel "Tu actividad" eliminado del layout; se conserva el cálculo de stats en silencio.
  }

  function watchLeaderboard() {
    track(roomRef('stats/' + weekKey()), 'value', function (snap) {
      var rows = [];
      snap.forEach(function (ch) {
        var v = ch.val() || {};
        rows.push({ uid: ch.key, nick: v.n || 'Jugador', count: Number(v.c || 0) });
      });
      rows.sort(function (a, b) { return b.count - a.count; });
      renderLeaderboard(rows.slice(0, 8));
    });
  }

  function renderLeaderboard(rows) {
    if (!D.cfLeaderboard) return;
    if (!rows.length) {
      D.cfLeaderboard.innerHTML = '<li class="cf-lb-item"><span class="cf-lb-nick" style="color:var(--cf-muted)">Aún sin datos esta semana</span></li>';
      return;
    }
    D.cfLeaderboard.innerHTML = '';
    rows.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'cf-lb-item';
      li.innerHTML = '<span class="cf-lb-pos">' + (i + 1) + '</span>' +
        '<span class="cf-lb-nick community-user-link" data-community-uid="' + esc(r.uid) + '" data-community-nick="' + esc(r.nick) + '">' + esc(r.nick) + '</span>' +
        '<span class="cf-lb-count">' + r.count + '</span>';
      bindUserClicks(li);
      D.cfLeaderboard.appendChild(li);
    });
  }

  // ============================================================
  // 13. Presencia en la barra lateral
  // ============================================================
  function watchPresenceSidebar() {
    track(db().ref('presence'), 'value', function (snap) {
      renderOnline(snap.val() || {});
    });
  }

  function renderOnline(map) {
    if (!D.cfOnlineList) return;
    var uids = Object.keys(map || {});
    if (D.cfSideOnlineCount) D.cfSideOnlineCount.textContent = uids.length;
    if (!uids.length) {
      D.cfOnlineList.innerHTML = '<div style="font-size:0.74rem;color:var(--cf-muted)">Nadie más por ahora</div>';
      return;
    }
    var groups = { '': [], buscando_partida: [], en_partida: [], forjando_estrategias: [] };
    uids.forEach(function (uid) {
      var p = map[uid] || {};
      var st = p.status || '';
      if (!groups[st]) groups[st] = [];
      groups[st].push({ uid: uid, nick: p.nick || 'Jugador', status: st });
    });
    D.cfOnlineList.innerHTML = '';
    var order = playerStatuses().length ? playerStatuses() : [{ value: '', label: 'En línea', emoji: '🟢' }];
    order.forEach(function (def) {
      var list = groups[def.value] || [];
      if (!list.length) return;
      var label = document.createElement('div');
      label.className = 'cf-online-group-label';
      label.textContent = def.emoji + ' ' + def.label + ' (' + list.length + ')';
      D.cfOnlineList.appendChild(label);
      list.sort(function (a, b) { return a.nick.localeCompare(b.nick); }).forEach(function (u) {
        var row = document.createElement('div');
        row.className = 'cf-online-item';
        row.title = 'Clic para mencionar · doble clic para ver perfil';
        row.innerHTML = '<i class="cf-dot" data-cf-st="' + esc(u.status) + '"></i><span>' + esc(u.nick) + '</span>';
        row.addEventListener('click', function () { insertAtCursor('@' + u.nick.replace(/\s+/g, '') + ' '); });
        row.addEventListener('dblclick', function () {
          var probe = document.createElement('span');
          probe.className = 'community-user-link';
          probe.setAttribute('data-community-uid', u.uid);
          probe.setAttribute('data-community-nick', u.nick);
          bindUserClicks(probe);
          probe.click();
        });
        D.cfOnlineList.appendChild(row);
      });
    });
  }

  // ============================================================
  // 14. Fijados, tema del día, modo lento
  // ============================================================
  function watchPins() {
    track(roomRef('pins'), 'value', function (snap) {
      S.pins = snap.val() || {};
      renderPinnedBar();
      applyFilters();
    });
  }

  function renderPinnedBar() {
    if (!D.cfPinned) return;
    var ids = Object.keys(S.pins || {}).filter(function (id) {
      var p = S.pins[id] || {};
      return (p.ch || 'general') === S.channel;
    });
    if (!ids.length) {
      D.cfPinned.hidden = true;
      D.cfPinned.innerHTML = '';
      return;
    }
    ids.sort(function (a, b) { return Number((S.pins[b] || {}).at || 0) - Number((S.pins[a] || {}).at || 0); });
    var id = ids[0];
    var p = S.pins[id] || {};
    D.cfPinned.hidden = false;
    D.cfPinned.innerHTML =
      '<i class="fas fa-thumbtack cf-pin-ico"></i>' +
      '<span class="cf-pinned-text" title="Ir al mensaje"><span class="cf-pinned-nick">' + esc(p.n || '') + ':</span> ' + esc(String(p.t || '').slice(0, 140)) + '</span>' +
      (ids.length > 1 ? '<span style="font-size:0.68rem;color:var(--cf-muted)">+' + (ids.length - 1) + '</span>' : '') +
      (isMod() ? '<button type="button" class="cf-chip-close" title="Quitar fijado">&times;</button>' : '');
    D.cfPinned.querySelector('.cf-pinned-text').addEventListener('click', function () { jumpTo(id); });
    var close = D.cfPinned.querySelector('.cf-chip-close');
    if (close) close.addEventListener('click', function () { roomRef('pins/' + id).remove(); });
  }

  function togglePin(id, d) {
    if (!isMod()) { toast('Solo Commanders pueden fijar mensajes', 'error'); return; }
    var ref = roomRef('pins/' + id);
    ref.once('value').then(function (s) {
      if (s.exists()) return ref.remove();
      return ref.set({
        t: String(d.text || '(multimedia)').slice(0, 200),
        n: authorOf(d),
        by: myNick(),
        at: Date.now(),
        ch: S.channel
      }).then(function () { toast('Mensaje fijado', 'success'); });
    }).catch(function () { toast('No se pudo fijar', 'error'); });
  }

  function watchMeta() {
    track(roomRef('meta'), 'value', function (snap) {
      S.meta = snap.val() || {};
      var topic = S.meta.topic;
      if (D.cfTopicText) {
        D.cfTopicText.textContent = topic
          ? '📌 ' + topic
          : 'Charla, busca equipo y comparte clips con el Nexo';
        D.cfTopicText.title = topic ? ('Tema fijado por ' + (S.meta.topicBy || 'un Commander')) : '';
      }
      if (Number(S.meta.slowSec || 0) > 0) {
        banner('Modo lento activo: 1 mensaje cada ' + S.meta.slowSec + 's', 'warn');
      } else if (D.cfConnBanner && D.cfConnBanner.getAttribute('data-cf-src') === 'slow') {
        hideBanner(D.cfConnBanner);
      }
    });
  }

  function banner(text, tone, src) {
    if (!D.cfConnBanner) return;
    var wasHidden = D.cfConnBanner.hidden;
    D.cfConnBanner.hidden = false;
    D.cfConnBanner.setAttribute('data-cf-tone', tone || 'warn');
    D.cfConnBanner.setAttribute('data-cf-src', src || 'slow');
    D.cfConnBanner.innerHTML = '<i class="fas fa-info-circle"></i> ' + esc(text);
    if (wasHidden) motionFx(D.cfConnBanner, { opacity: [0, 1], y: [-8, 0] }, { duration: 0.22, ease: 'easeOut' });
  }

  function hideBanner(el) {
    if (!el || el.hidden) return;
    var anim = motionFx(el, { opacity: [1, 0], y: [0, -8] }, { duration: 0.16, ease: 'easeIn' });
    if (anim && anim.finished) {
      anim.finished.then(function () { el.hidden = true; }).catch(function () { el.hidden = true; });
    } else {
      el.hidden = true;
    }
  }

  function watchConnection() {
    track(db().ref('.info/connected'), 'value', function (snap) {
      var online = snap.val() === true;
      if (!online) {
        banner('Sin conexión con el chat. Reintentando…', 'error', 'conn');
      } else if (D.cfConnBanner && D.cfConnBanner.getAttribute('data-cf-src') === 'conn') {
        hideBanner(D.cfConnBanner);
      }
      if (D.cfInput) D.cfInput.setAttribute('aria-busy', online ? 'false' : 'true');
    });
  }

  // ============================================================
  // 15. Encuestas
  // ============================================================
  function watchPolls() {
    track(roomRef('polls'), 'value', function (snap) {
      S.pollVotes = snap.val() || {};
      S.order.forEach(function (id) {
        if (S.msgs[id] && S.msgs[id].poll) rerenderMessage(id);
      });
    });
  }

  function buildPoll(id, d) {
    var wrap = document.createElement('div');
    wrap.className = 'cf-poll';
    var poll = d.poll || {};
    var opts = Array.isArray(poll.opts) ? poll.opts : [];
    var votes = ((S.pollVotes[id] || {}).votes) || {};
    var counts = opts.map(function () { return 0; });
    var mine = -1;
    Object.keys(votes).forEach(function (uid) {
      var idx = Number(votes[uid]);
      if (idx >= 0 && idx < counts.length) counts[idx] += 1;
      if (uid === myUid()) mine = idx;
    });
    var total = counts.reduce(function (a, b) { return a + b; }, 0);

    var q = document.createElement('div');
    q.className = 'cf-poll-q';
    q.textContent = '📊 ' + String(poll.q || 'Encuesta');
    wrap.appendChild(q);

    opts.forEach(function (label, i) {
      var pct = total ? Math.round((counts[i] / total) * 100) : 0;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-poll-opt' + (mine === i ? ' mine' : '');
      b.innerHTML = '<div class="cf-poll-fill" style="width:' + pct + '%"></div>' +
        '<span>' + esc(label) + '<span class="cf-poll-pct">' + pct + '% · ' + counts[i] + '</span></span>';
      b.addEventListener('click', function () { votePoll(id, i, mine === i); });
      wrap.appendChild(b);
    });

    var tot = document.createElement('div');
    tot.className = 'cf-poll-total';
    tot.textContent = total + (total === 1 ? ' voto' : ' votos') + (mine >= 0 ? ' · toca de nuevo para quitar tu voto' : '');
    wrap.appendChild(tot);
    return wrap;
  }

  function votePoll(msgId, idx, remove) {
    var uid = myUid();
    if (!uid) return;
    var ref = roomRef('polls/' + msgId + '/votes/' + uid);
    (remove ? ref.remove() : ref.set(idx))
      .then(function () { sfxPop(); })
      .catch(function () { toast('No se pudo votar', 'error'); });
  }

  // ============================================================
  // 16. LFG y ayuda
  // ============================================================
  function watchLfg() {
    track(roomRef('lfg'), 'value', function (snap) {
      S.lfgMembers = snap.val() || {};
      S.order.forEach(function (id) {
        if (S.msgs[id] && S.msgs[id].lfg) rerenderMessage(id);
      });
    });
  }

  function buildLfg(id, d) {
    var lfg = d.lfg || {};
    var members = ((S.lfgMembers[id] || {}).members) || {};
    var uids = Object.keys(members);
    var slots = Math.max(1, Math.min(20, Number(lfg.slots || 4)));
    var joined = uids.indexOf(myUid()) !== -1;
    var full = uids.length >= slots;

    var card = document.createElement('div');
    card.className = 'cf-card';
    card.setAttribute('data-cf-kind', 'lfg');
    card.innerHTML =
      '<div class="cf-card-title"><i class="fas fa-user-plus"></i> Buscando equipo · ' + esc(lfg.game || 'Juego') + '</div>' +
      '<div class="cf-card-meta">' + esc(lfg.note || 'Sin notas') + ' · ' + uids.length + '/' + slots + ' plazas</div>' +
      '<div class="cf-card-members"></div>';
    var box = card.querySelector('.cf-card-members');
    uids.forEach(function (uid) {
      var chip = document.createElement('span');
      chip.className = 'cf-member-chip';
      chip.textContent = (members[uid] || {}).n || 'Jugador';
      box.appendChild(chip);
    });
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cf-card-btn' + (joined ? ' joined' : '');
    btn.textContent = joined ? '✓ Estás dentro (salir)' : (full ? 'Escuadrón completo' : 'Unirme al escuadrón');
    btn.disabled = full && !joined;
    btn.addEventListener('click', function () { toggleLfg(id, joined); });
    card.appendChild(btn);
    return card;
  }

  function toggleLfg(msgId, joined) {
    var uid = myUid();
    if (!uid) return;
    var ref = roomRef('lfg/' + msgId + '/members/' + uid);
    (joined ? ref.remove() : ref.set({ n: myNick(), at: Date.now() }))
      .then(function () {
        sfxPop();
        if (!joined) toast('Te uniste al escuadrón', 'success');
      })
      .catch(function () { toast('No se pudo actualizar el escuadrón', 'error'); });
  }

  function buildHelpCard(id, d) {
    var card = document.createElement('div');
    card.className = 'cf-card';
    card.setAttribute('data-cf-kind', 'help');
    card.innerHTML =
      '<div class="cf-card-title"><i class="fas fa-life-ring"></i> Petición de ayuda</div>' +
      '<div class="cf-card-meta">' + esc(String(d.helpText || d.text || '').slice(0, 200)) + '</div>';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cf-card-btn';
    btn.textContent = 'Ofrecer ayuda';
    btn.addEventListener('click', function () {
      setReply({ id: id, nick: authorOf(d), text: String(d.text || '').slice(0, 120) });
      insertAtCursor('@' + String(authorOf(d)).replace(/\s+/g, '') + ' te ayudo ');
    });
    card.appendChild(btn);
    return card;
  }

  // ============================================================
  // 17. Moderación
  // ============================================================
  function deleteMessage(id, mine) {
    var label = mine ? '¿Borrar tu mensaje?' : '¿Borrar este mensaje como moderador?';
    if (!window.confirm(label)) return;
    if (mine) {
      messagesRef().child(id).update({ deleted: true, text: '', imageURL: null, deletedAt: Date.now() })
        .catch(function () { toast('No se pudo borrar', 'error'); });
    } else {
      messagesRef().child(id).remove().then(function () {
        pushFeed('chat', '<strong>' + esc(myNick()) + '</strong> moderó un mensaje del chat');
      }).catch(function () { toast('No se pudo borrar', 'error'); });
    }
    roomRef('pins/' + id).remove().catch(function () {});
  }

  function reportMessage(id, d) {
    var reason = window.prompt('¿Por qué reportas este mensaje? (spam, insultos, etc.)', '');
    if (reason === null) return;
    db().ref('chatModeration/reports').push({
      msgId: id,
      channel: S.channel,
      targetUid: d.userId || '',
      targetNick: authorOf(d),
      text: String(d.text || '').slice(0, 300),
      reason: String(reason || '').slice(0, 200),
      byUid: myUid(),
      byNick: myNick(),
      at: Date.now()
    }).then(function () {
      toast('Reporte enviado a los Commanders', 'success');
    }).catch(function () { toast('No se pudo reportar', 'error'); });
  }

  function muteLocal(uid, nick) {
    if (!uid) return;
    S.mutedLocal[uid] = nick || true;
    lsSet('cf.mutedUsers', S.mutedLocal);
    applyFilters();
    toast('Silenciaste a ' + (nick || 'ese usuario') + ' solo para ti (/unmute para revertir)', 'info');
  }

  function unmuteLocal(nick) {
    var found = null;
    Object.keys(S.mutedLocal).forEach(function (uid) {
      if (String(S.mutedLocal[uid]).toLowerCase() === String(nick).toLowerCase()) found = uid;
    });
    if (!found) { toast('No encuentro a ' + nick + ' en tu lista de silenciados', 'info'); return; }
    delete S.mutedLocal[found];
    lsSet('cf.mutedUsers', S.mutedLocal);
    applyFilters();
    toast('Volverás a ver a ' + nick, 'success');
  }

  function watchServerMutes() {
    track(db().ref('chatModeration/mutes'), 'value', function (snap) {
      S.mutesServer = snap.val() || {};
      applyFilters();
      var mine = S.mutesServer[myUid()];
      if (mine && Number(mine.until || 0) > Date.now()) {
        banner('Estás silenciado en el chat hasta ' + new Date(mine.until).toLocaleTimeString(), 'error', 'mute');
        if (D.cfInput) D.cfInput.disabled = true;
      } else if (D.cfInput) {
        D.cfInput.disabled = false;
        if (D.cfConnBanner && D.cfConnBanner.getAttribute('data-cf-src') === 'mute') hideBanner(D.cfConnBanner);
      }
    });
  }

  // ============================================================
  // 18. Comandos
  // ============================================================
  function runCommand(raw) {
    var parts = raw.slice(1).split(/\s+/);
    var cmd = (parts.shift() || '').toLowerCase();
    var rest = parts.join(' ').trim();

    switch (cmd) {
      case 'me':
        if (!rest) return true;
        if (!canSend()) return 'blocked';
        var m = baseMessage(rest.slice(0, MAX_LEN));
        m.action = true;
        pushMessage(m);
        return true;

      case 'shrug':
        insertAtCursor('¯\\_(ツ)_/¯');
        return true;

      case 'gif':
        if (!canSend()) return 'blocked';
        pushMessage(baseMessage((rest || '🔥').slice(0, 12)));
        return true;

      case 'roll': {
        var spec = /^(\d{0,2})d(\d{1,3})$/i.exec(rest || '1d100');
        var n = spec ? Math.min(10, Math.max(1, Number(spec[1] || 1))) : 1;
        var faces = spec ? Math.min(1000, Math.max(2, Number(spec[2] || 100))) : 100;
        var rolls = [];
        var total = 0;
        for (var i = 0; i < n; i += 1) {
          var r = 1 + Math.floor(Math.random() * faces);
          rolls.push(r);
          total += r;
        }
        if (!canSend()) return 'blocked';
        var msg = baseMessage('🎲 tiró ' + n + 'd' + faces + ' → ' + rolls.join(', ') + (n > 1 ? ' (total ' + total + ')' : ''));
        msg.action = true;
        pushMessage(msg);
        return true;
      }

      case 'flip': {
        if (!canSend()) return 'blocked';
        var coin = Math.random() < 0.5 ? '🪙 Cara' : '🪙 Cruz';
        var fm = baseMessage('lanzó una moneda: ' + coin);
        fm.action = true;
        pushMessage(fm);
        return true;
      }

      case 'poll': {
        var seg = rest.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
        if (seg.length < 3) {
          toast('Usa: /poll pregunta | opción 1 | opción 2', 'error');
          return true;
        }
        if (!canSend()) return 'blocked';
        var pm = baseMessage('📊 ' + seg[0]);
        pm.type = 'poll';
        pm.poll = { q: seg[0].slice(0, 140), opts: seg.slice(1, 6).map(function (o) { return o.slice(0, 60); }) };
        pushMessage(pm);
        return true;
      }

      case 'lfg': {
        var lseg = rest.split('|').map(function (s) { return s.trim(); });
        if (!lseg[0]) { toast('Usa: /lfg CS2 | 4 | ranked tranquilo', 'error'); return true; }
        if (!canSend()) return 'blocked';
        var lm = baseMessage('🎮 Busca equipo en ' + lseg[0]);
        lm.type = 'lfg';
        lm.lfg = {
          game: lseg[0].slice(0, 40),
          slots: Math.max(2, Math.min(20, Number(lseg[1] || 4) || 4)),
          note: (lseg[2] || '').slice(0, 120)
        };
        pushMessage(lm);
        return true;
      }

      case 'help': {
        if (!rest) { toast('Usa: /help necesito ayuda con…', 'error'); return true; }
        if (!canSend()) return 'blocked';
        var hm = baseMessage(rest.slice(0, MAX_LEN));
        hm.type = 'help';
        hm.helpText = rest.slice(0, 300);
        pushMessage(hm);
        toast('Petición de ayuda publicada', 'success');
        return true;
      }

      case 'top':
        openChannelSidebar();
        toast('Top de la semana en la barra lateral', 'info');
        return true;

      case 'stats': {
        var st = S.chatStats || {};
        toast('Mensajes: ' + Number(st.msgs || 0) + ' · Racha: ' + Number(st.streak || 0) + ' días · XP: ' + Number(st.xp || 0), 'info');
        openChannelSidebar();
        return true;
      }

      case 'search':
        toggleSearch(true);
        if (rest) {
          D.cfSearchInput.value = rest;
          S.query = rest;
          applyFilters();
        }
        return true;

      case 'mute':
        if (!rest) { toast('Usa: /mute @nick', 'error'); return true; }
        var target = rest.replace(/^@/, '');
        var uidFound = null;
        S.order.forEach(function (id) {
          var d = S.msgs[id];
          if (d && String(authorOf(d)).toLowerCase() === target.toLowerCase()) uidFound = d.userId;
        });
        if (uidFound) muteLocal(uidFound, target);
        else toast('No veo mensajes recientes de ' + target, 'info');
        return true;

      case 'unmute':
        if (!rest) { toast('Usa: /unmute @nick', 'error'); return true; }
        unmuteLocal(rest.replace(/^@/, ''));
        return true;

      case 'theme':
        if (['ember', 'ice', 'toxic', 'gold', 'violet'].indexOf(rest) === -1) {
          toast('Temas: ember, ice, toxic, gold, violet', 'info');
          return true;
        }
        S.settings.accent = rest;
        saveSettings();
        applySettings();
        return true;

      case 'density':
        if (['compact', 'cozy', 'roomy'].indexOf(rest) === -1) {
          toast('Densidades: compact, cozy, roomy', 'info');
          return true;
        }
        S.settings.density = rest;
        saveSettings();
        applySettings();
        return true;

      case 'clear':
        D.stream.innerHTML = '';
        S.nodes = {};
        S.order = [];
        S.msgs = {};
        showEmptyState();
        toast('Vista limpiada (nada se borró del servidor)', 'info');
        return true;

      case 'shortcuts':
        openShortcuts();
        return true;

      case 'topic':
        if (!isMod()) { toast('Solo Commanders pueden fijar el tema', 'error'); return true; }
        roomRef('meta').update({ topic: rest.slice(0, 160), topicBy: myNick(), topicAt: Date.now() })
          .then(function () { toast('Tema actualizado', 'success'); })
          .catch(function () { toast('No se pudo actualizar el tema', 'error'); });
        return true;

      case 'slow':
        if (!isMod()) { toast('Solo Commanders pueden activar el modo lento', 'error'); return true; }
        var sec = Math.max(0, Math.min(120, Number(rest) || 0));
        roomRef('meta').update({ slowSec: sec, slowBy: myNick() })
          .then(function () { toast(sec ? ('Modo lento: ' + sec + 's') : 'Modo lento desactivado', 'success'); })
          .catch(function () { toast('No se pudo cambiar el modo lento', 'error'); });
        return true;

      case 'clearpins':
        if (!isMod()) { toast('Solo Commanders pueden quitar fijados', 'error'); return true; }
        roomRef('pins').remove().then(function () { toast('Fijados eliminados', 'success'); });
        return true;

      default:
        toast('Comando desconocido. Escribe / para ver la lista.', 'info');
        return true;
    }
  }

  function openChannelSidebar() {
    setPresenceMenuOpen(true);
  }

  // ============================================================
  // 19. Autocompletado (@ menciones y / comandos)
  // ============================================================
  function handleSuggest() {
    var i = D.cfInput;
    var value = i.value;
    var caret = i.selectionStart || 0;
    var before = value.slice(0, caret);

    var cmdMatch = /(^|\n)\/([a-z]*)$/i.exec(before);
    if (cmdMatch) {
      var token = cmdMatch[2].toLowerCase();
      var items = COMMANDS.filter(function (c) { return c.cmd.slice(1).indexOf(token) === 0; }).slice(0, 8);
      if (items.length) return openSuggest('cmd', items, token);
    }

    var menMatch = /@([A-Za-z0-9_.\-]{0,24})$/.exec(before);
    if (menMatch) {
      var q = menMatch[1].toLowerCase();
      var seen = {};
      var cands = [];
      var pres = presence();
      Object.keys(pres).forEach(function (uid) {
        var nick = (pres[uid] || {}).nick;
        if (!nick || seen[nick.toLowerCase()]) return;
        if (q && nick.toLowerCase().indexOf(q) !== 0) return;
        seen[nick.toLowerCase()] = 1;
        cands.push({ nick: nick, uid: uid, photo: null, online: true });
      });
      S.order.slice(-40).forEach(function (id) {
        var d = S.msgs[id];
        if (!d || !d.userId || d.userId === BOT_UID) return;
        var nick = authorOf(d);
        if (seen[nick.toLowerCase()]) return;
        if (q && nick.toLowerCase().indexOf(q) !== 0) return;
        seen[nick.toLowerCase()] = 1;
        cands.push({ nick: nick, uid: d.userId, photo: photoOf(d), online: false });
      });
      if (isMod() && ('everyone'.indexOf(q) === 0 || !q)) {
        cands.unshift({ nick: 'everyone', uid: '', photo: null, online: false, special: true });
      }
      if (cands.length) return openSuggest('mention', cands.slice(0, 8), q);
    }

    closeSuggest();
  }

  function openSuggest(kind, items, token) {
    S.suggest = { open: true, kind: kind, items: items, index: 0, token: token };
    renderSuggest();
  }

  function renderSuggest() {
    var pop = D.cfSuggest;
    if (!pop) return;
    pop.hidden = false;
    pop.innerHTML = '';
    S.suggest.items.forEach(function (it, idx) {
      var row = document.createElement('div');
      row.className = 'cf-suggest-item' + (idx === S.suggest.index ? ' active' : '');
      if (S.suggest.kind === 'cmd') {
        row.innerHTML = '<span class="cf-suggest-cmd">' + esc(it.cmd) + '</span>' +
          '<span class="cf-suggest-desc">' + esc(it.args ? it.args + ' — ' : '') + esc(it.desc) + '</span>';
      } else {
        row.innerHTML = (it.photo ? '<img src="' + esc(it.photo) + '" alt="">' : '<i class="cf-dot"></i>') +
          '<span>@' + esc(it.nick) + '</span>' +
          (it.online ? '<span class="cf-suggest-desc">en línea</span>' : '') +
          (it.special ? '<span class="cf-suggest-desc">avisa a todos</span>' : '');
      }
      row.addEventListener('mousedown', function (e) {
        e.preventDefault();
        S.suggest.index = idx;
        acceptSuggest();
      });
      pop.appendChild(row);
    });
  }

  function moveSuggest(delta) {
    var n = S.suggest.items.length;
    if (!n) return;
    S.suggest.index = (S.suggest.index + delta + n) % n;
    renderSuggest();
  }

  function acceptSuggest() {
    var it = S.suggest.items[S.suggest.index];
    if (!it) return closeSuggest();
    var i = D.cfInput;
    var caret = i.selectionStart || 0;
    var before = i.value.slice(0, caret);
    var after = i.value.slice(caret);
    if (S.suggest.kind === 'cmd') {
      before = before.replace(/\/[a-z]*$/i, it.cmd + ' ');
    } else {
      before = before.replace(/@[A-Za-z0-9_.\-]{0,24}$/, '@' + it.nick.replace(/\s+/g, '') + ' ');
    }
    i.value = before + after;
    i.selectionStart = i.selectionEnd = before.length;
    closeSuggest();
    autoGrow();
    updateCounter();
    i.focus();
  }

  function closeSuggest() {
    S.suggest.open = false;
    S.suggest.items = [];
    if (D.cfSuggest) {
      D.cfSuggest.hidden = true;
      D.cfSuggest.innerHTML = '';
    }
  }

  // ============================================================
  // 20. Emoji picker y barra rápida
  // ============================================================
  function openEmojiPicker() {
    if (!D.cfEmojiPop || !D.cfEmojiPop.hidden) return;
    D.cfEmojiPop.hidden = false;
    if (D.cfEmojiBtn) D.cfEmojiBtn.classList.add('active');
    motionFx(D.cfEmojiPop, { opacity: [0, 1], scale: [0.92, 1] }, { duration: 0.18, ease: 'easeOut' });
    var s = D.cfEmojiPop.querySelector('.cf-emoji-search');
    if (s) s.focus();
  }

  function closeEmojiPicker() {
    if (!D.cfEmojiPop || D.cfEmojiPop.hidden) return;
    if (D.cfEmojiBtn) D.cfEmojiBtn.classList.remove('active');
    var anim = motionFx(D.cfEmojiPop, { opacity: [1, 0], scale: [1, 0.92] }, { duration: 0.14, ease: 'easeIn' });
    if (anim && anim.finished) {
      anim.finished.then(function () { D.cfEmojiPop.hidden = true; }).catch(function () { D.cfEmojiPop.hidden = true; });
    } else {
      D.cfEmojiPop.hidden = true;
    }
  }

  function buildEmojiPicker() {
    var pop = D.cfEmojiPop;
    if (!pop) return;
    pop.innerHTML =
      '<div class="cf-emoji-head">' +
        '<input type="search" class="cf-emoji-search" placeholder="Buscar emoji…" aria-label="Buscar emoji">' +
        '<button type="button" class="cf-emoji-close" id="cfEmojiClose" title="Cerrar" aria-label="Cerrar emojis">&times;</button>' +
      '</div>' +
      '<div class="cf-emoji-cats"></div>' +
      '<div class="cf-emoji-grid"></div>';
    var closeBtn = pop.querySelector('#cfEmojiClose');
    if (closeBtn) closeBtn.addEventListener('click', closeEmojiPicker);
    var cats = pop.querySelector('.cf-emoji-cats');
    EMOJI_CATS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-emoji-cat' + (c.id === S.emojiCat ? ' active' : '');
      b.textContent = c.icon;
      b.title = c.id;
      b.addEventListener('click', function () {
        S.emojiCat = c.id;
        Array.prototype.forEach.call(cats.children, function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        renderEmojiGrid('');
      });
      cats.appendChild(b);
    });
    pop.querySelector('.cf-emoji-search').addEventListener('input', function (e) {
      renderEmojiGrid(e.target.value);
    });
    renderEmojiGrid('');
  }

  function renderEmojiGrid(query) {
    var grid = D.cfEmojiPop.querySelector('.cf-emoji-grid');
    if (!grid) return;
    var list;
    if (query && query.trim()) {
      var q = query.trim().toLowerCase();
      list = [];
      EMOJI_CATS.forEach(function (c) {
        if (c.id.indexOf(q) !== -1) list = list.concat(c.list);
      });
      if (!list.length) {
        EMOJI_CATS.forEach(function (c) { list = list.concat(c.list); });
        list = list.slice(0, 60);
      }
    } else {
      var cat = EMOJI_CATS.filter(function (c) { return c.id === S.emojiCat; })[0];
      list = (cat && cat.list) || [];
      if (S.emojiCat === 'recientes') list = S.recentEmojis.slice(0, 40);
    }
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = '<div class="cf-emoji-empty">Sin emojis aquí todavía</div>';
      return;
    }
    list.forEach(function (emo) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = emo;
      b.addEventListener('click', function () {
        insertAtCursor(emo);
        rememberEmoji(emo);
      });
      grid.appendChild(b);
    });
  }

  function rememberEmoji(emo) {
    S.recentEmojis = [emo].concat(S.recentEmojis.filter(function (e) { return e !== emo; })).slice(0, 30);
    lsSet('cf.recentEmojis', S.recentEmojis);
    EMOJI_CATS[0].list = S.recentEmojis.slice(0, 30);
  }

  function renderQuickbar() {
    if (!D.cfQuickbar) return;
    D.cfQuickbar.innerHTML = '';
    ['🔥', '😂', '💀', '🎯', '👏', '🤝'].forEach(function (emo) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-quick';
      b.textContent = emo;
      b.title = 'Insertar ' + emo;
      b.addEventListener('click', function () { insertAtCursor(emo); rememberEmoji(emo); });
      D.cfQuickbar.appendChild(b);
    });
  }

  // ============================================================
  // 21. Barra superior limpia: presencia + menú
  // ============================================================
  function bindTopbar() {
    if (D.cfPresenceBtn) {
      D.cfPresenceBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = D.cfPresenceMenu && D.cfPresenceMenu.hasAttribute('hidden');
        setPresenceMenuOpen(open);
      });
    }

    if (D.cfMenuToggle) {
      D.cfMenuToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        setMenuOpen(!(D.cfMenu && !D.cfMenu.hasAttribute('hidden')));
      });
    }

    if (D.cfSearchToggle) {
      D.cfSearchToggle.addEventListener('click', function () {
        setMenuOpen(false);
        toggleSearch(true);
      });
    }
    if (D.cfSearchClose) D.cfSearchClose.addEventListener('click', function () { toggleSearch(false); });
    if (D.cfSearchInput) {
      D.cfSearchInput.addEventListener('input', function () {
        S.query = D.cfSearchInput.value || '';
        applyFilters();
      });
      D.cfSearchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') toggleSearch(false);
      });
    }

    if (D.cfSettingsToggle) {
      D.cfSettingsToggle.addEventListener('click', function () {
        setMenuOpen(false);
        var willOpen = D.cfSettings.hidden;
        if (willOpen) buildSettingsPanel();
        D.cfSettings.hidden = !willOpen;
      });
    }
    if (D.cfHelpToggle) {
      D.cfHelpToggle.addEventListener('click', function () {
        setMenuOpen(false);
        openShortcuts();
      });
    }
    if (D.cfExpandToggle) {
      D.cfExpandToggle.addEventListener('click', function () {
        setMenuOpen(false);
        var on = D.shell.classList.toggle('cf-expanded');
        document.body.classList.toggle('cf-expanded-lock', on);
        scrollToBottom(true);
      });
    }

    document.addEventListener('click', function (e) {
      if (D.cfPresence && !D.cfPresence.contains(e.target)) setPresenceMenuOpen(false);
      if (D.cfMenu && D.cfMenuToggle && !D.cfMenu.contains(e.target) && !D.cfMenuToggle.contains(e.target)) {
        setMenuOpen(false);
      }
    });
  }

  function toggleSearch(force) {
    if (!D.cfSearchBar) return;
    var open = typeof force === 'boolean' ? force : D.cfSearchBar.hidden;
    D.cfSearchBar.hidden = !open;
    if (open && D.cfSearchInput) D.cfSearchInput.focus();
    else if (D.cfSearchInput) {
      D.cfSearchInput.value = '';
      S.query = '';
      applyFilters();
    }
  }

  function buildSettingsPanel() {
    var p = D.cfSettings;
    if (!p) return;
    p.className = 'cf-pop';
    p.innerHTML = '<div class="cf-tools-panel-head"><h4 style="margin:0">Ajustes del chat</h4>' +
      '<button type="button" class="cf-icon-btn" id="cfSettingsClose" title="Cerrar" aria-label="Cerrar ajustes"><i class="fas fa-times"></i></button></div>';
    var closeBtn = p.querySelector('#cfSettingsClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        p.hidden = true;
        if (D.cfSettingsToggle) D.cfSettingsToggle.classList.remove('active');
      });
    }

    var accents = document.createElement('div');
    accents.className = 'cf-pop-row';
    accents.innerHTML = '<span>Acento</span>';
    var sw = document.createElement('div');
    sw.className = 'cf-swatches';
    ['ember', 'ice', 'toxic', 'gold', 'violet'].forEach(function (a) {
      var s = document.createElement('button');
      s.type = 'button';
      s.className = 'cf-swatch' + (S.settings.accent === a ? ' active' : '');
      s.setAttribute('data-cf-swatch', a);
      s.title = a;
      s.addEventListener('click', function () {
        S.settings.accent = a;
        saveSettings();
        applySettings();
        buildSettingsPanel();
      });
      sw.appendChild(s);
    });
    accents.appendChild(sw);
    p.appendChild(accents);

    var dens = document.createElement('div');
    dens.className = 'cf-pop-row';
    dens.innerHTML = '<span>Densidad</span>';
    var sel = document.createElement('select');
    sel.className = 'cf-mini-select';
    [['compact', 'Compacta'], ['cozy', 'Normal'], ['roomy', 'Amplia']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      if (S.settings.density === o[0]) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      S.settings.density = sel.value;
      saveSettings();
      applySettings();
    });
    dens.appendChild(sel);
    p.appendChild(dens);

    [
      ['sounds', 'Sonidos'],
      ['notifs', 'Avisos de escritorio'],
      ['profanity', 'Filtro de palabrotas'],
      ['timestamps', 'Mostrar horas']
    ].forEach(function (pair) {
      var key = pair[0];
      var row = document.createElement('div');
      row.className = 'cf-pop-row';
      row.innerHTML = '<span>' + pair[1] + '</span>';
      var t = document.createElement('button');
      t.type = 'button';
      var on = !!S.settings[key];
      t.className = 'cf-switch' + (on ? ' on' : '');
      t.setAttribute('role', 'switch');
      t.setAttribute('aria-checked', on ? 'true' : 'false');
      t.setAttribute('aria-label', pair[1]);
      t.addEventListener('click', function () {
        if (key === 'notifs') {
          if (!S.settings.notifs && 'Notification' in window) {
            Notification.requestPermission().then(function (perm) {
              S.settings.notifs = perm === 'granted';
              saveSettings();
              buildSettingsPanel();
              if (perm !== 'granted') toast('El navegador bloqueó los avisos', 'info');
            });
            return;
          }
          S.settings.notifs = false;
        } else {
          S.settings[key] = !S.settings[key];
        }
        saveSettings();
        applySettings();
        if (key === 'timestamps' || key === 'profanity') {
          S.order.forEach(function (id) { rerenderMessage(id); });
        }
        buildSettingsPanel();
      });
      row.appendChild(t);
      p.appendChild(row);
    });

    var muted = Object.keys(S.mutedLocal || {});
    if (muted.length) {
      var mrow = document.createElement('div');
      mrow.className = 'cf-pop-row';
      mrow.innerHTML = '<span>Silenciados: ' + muted.length + '</span>';
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'cf-card-btn';
      clear.textContent = 'Limpiar';
      clear.addEventListener('click', function () {
        S.mutedLocal = {};
        lsSet('cf.mutedUsers', {});
        applyFilters();
        buildSettingsPanel();
      });
      mrow.appendChild(clear);
      p.appendChild(mrow);
    }
  }

  // ============================================================
  // 22. Atajos y modales
  // ============================================================
  function bindGlobalKeys() {
    document.addEventListener('keydown', function (e) {
      var key = e.key || '';
      var inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
      if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'k') {
        e.preventDefault();
        toggleSearch(true);
        return;
      }
      if (e.key === '?' && !inField) {
        e.preventDefault();
        openShortcuts();
        return;
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        var idx = CHANNELS.map(function (c) { return c.id; }).indexOf(S.channel);
        var next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + CHANNELS.length) % CHANNELS.length;
        e.preventDefault();
        openChannel(CHANNELS[next].id);
        return;
      }
      if (key === 'Escape') {
        closeModal('cfShortcutsModal');
        closeModal('cfLightboxModal');
        hideUserCard(true);
        setMenuOpen(false);
        setPresenceMenuOpen(false);
        if (D.cfEmojiPop && !D.cfEmojiPop.hidden) closeEmojiPicker();
        if (D.cfSettings && !D.cfSettings.hidden) D.cfSettings.hidden = true;
        if (D.shell.classList.contains('cf-expanded')) {
          D.shell.classList.remove('cf-expanded');
          document.body.classList.remove('cf-expanded-lock');
        }
      }
    });

    document.addEventListener('click', function (e) {
      if (D.cfEmojiPop && !D.cfEmojiPop.hidden &&
        !D.cfEmojiPop.contains(e.target) && e.target !== D.cfEmojiBtn && !(D.cfEmojiBtn && D.cfEmojiBtn.contains(e.target))) {
        closeEmojiPicker();
      }
      if (D.cfSettings && !D.cfSettings.hidden &&
        !D.cfSettings.contains(e.target) && e.target !== D.cfSettingsToggle && !(D.cfSettingsToggle && D.cfSettingsToggle.contains(e.target))) {
        D.cfSettings.hidden = true;
      }
    });
  }

  function ensureModal(id, html) {
    var m = document.getElementById(id);
    if (m) return m;
    m = document.createElement('div');
    m.id = id;
    m.className = 'cf-modal';
    m.innerHTML = '<div class="cf-modal-panel">' + html + '</div>';
    m.addEventListener('click', function (e) {
      if (e.target === m || (e.target.closest && e.target.closest('[data-cf-close]'))) closeModal(id);
    });
    document.body.appendChild(m);
    return m;
  }

  function closeModal(id) {
    var m = document.getElementById(id);
    if (m) m.classList.remove('open');
  }

  function openShortcuts() {
    var rows = [
      ['Enviar mensaje', 'Enter'],
      ['Salto de línea', 'Shift + Enter'],
      ['Editar tu último mensaje', '↑ (con el campo vacío)'],
      ['Buscar en el chat', 'Ctrl + K'],
      ['Cambiar de canal', 'Alt + ↑ / ↓'],
      ['Cancelar respuesta o edición', 'Esc'],
      ['Menciones', '@ + nombre'],
      ['Comandos', '/ para ver la lista'],
      ['Reaccionar rápido', 'Pasa el ratón sobre un mensaje'],
      ['Ver este panel', '?']
    ];
    var cmds = COMMANDS.map(function (c) {
      return '<div class="cf-kbd-row"><span>' + esc(c.desc) + '</span><kbd>' + esc(c.cmd + (c.args ? ' ' + c.args : '')) + '</kbd></div>';
    }).join('');
    var m = ensureModal('cfShortcutsModal',
      '<h3><i class="fas fa-keyboard"></i> Atajos y comandos <button type="button" class="cf-chip-close" data-cf-close style="float:right">&times;</button></h3>' +
      '<div class="cf-kbd-list">' +
      rows.map(function (r) {
        return '<div class="cf-kbd-row"><span>' + esc(r[0]) + '</span><kbd>' + esc(r[1]) + '</kbd></div>';
      }).join('') +
      '</div>' +
      '<h3 style="margin-top:1rem"><i class="fas fa-terminal"></i> Comandos</h3>' +
      '<div class="cf-kbd-list">' + cmds + '</div>');
    m.classList.add('open');
  }

  function openLightbox(url) {
    if (!url) return;
    var m = ensureModal('cfLightboxModal',
      '<h3 style="display:flex;align-items:center;justify-content:space-between">Imagen ' +
      '<button type="button" class="cf-chip-close" data-cf-close>&times;</button></h3>' +
      '<img class="cf-lightbox-img" alt="">');
    var img = m.querySelector('.cf-lightbox-img');
    img.src = url;
    m.classList.add('open');
  }

  // ============================================================
  // 23. Brasas (canvas) y reloj relativo
  // ============================================================
  function startEmbers() {
    var canvas = D.cfEmbers;
    if (!canvas || !canvas.getContext) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var parts = [];
    var raf = null;

    function resize() {
      var r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width));
      canvas.height = Math.max(1, Math.floor(r.height));
    }

    function spawn() {
      return {
        x: Math.random() * canvas.width,
        y: canvas.height + Math.random() * 30,
        r: 0.6 + Math.random() * 1.7,
        vy: 0.25 + Math.random() * 0.75,
        vx: (Math.random() - 0.5) * 0.35,
        life: 0,
        max: 180 + Math.random() * 200
      };
    }

    function frame() {
      if (document.hidden) { raf = requestAnimationFrame(frame); return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (parts.length < 34) parts.push(spawn());
      for (var i = parts.length - 1; i >= 0; i -= 1) {
        var p = parts[i];
        p.life += 1;
        p.y -= p.vy;
        p.x += p.vx + Math.sin(p.life / 28) * 0.22;
        if (p.life > p.max || p.y < -12) { parts.splice(i, 1); continue; }
        var alpha = Math.max(0, 0.55 * (1 - p.life / p.max));
        var grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        grd.addColorStop(0, 'rgba(255, 190, 120, ' + alpha + ')');
        grd.addColorStop(0.4, 'rgba(255, 120, 50, ' + (alpha * 0.7) + ')');
        grd.addColorStop(1, 'rgba(229, 57, 53, 0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener('resize', resize);
    frame();
    S.embersStop = function () { if (raf) cancelAnimationFrame(raf); };
  }

  function startClockTicker() {
    setInterval(function () {
      if (!S.settings.timestamps) return;
      S.order.forEach(function (id) {
        var node = S.nodes[id];
        var d = S.msgs[id];
        if (!node || !d) return;
        var t = node.querySelector('.cf-msg-time');
        if (t) t.textContent = clockLabel(d.timestamp);
      });
    }, 60000);
  }

  // ============================================================
  // 24. Mini-perfil al hover sobre el avatar
  // ============================================================
  function ensureUserCard() {
    if (S.hoverCard) return S.hoverCard;
    var card = document.createElement('div');
    card.id = 'cfUserHoverCard';
    card.className = 'cf-user-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Vista previa del perfil');
    card.innerHTML = '<div class="cf-user-card-loading">Cargando perfil…</div>';
    card.addEventListener('mouseenter', function () {
      if (S.hoverHideTimer) { clearTimeout(S.hoverHideTimer); S.hoverHideTimer = null; }
    });
    card.addEventListener('mouseleave', function () { hideUserCard(); });
    document.body.appendChild(card);
    S.hoverCard = card;
    return card;
  }

  function bindAvatarHover(av, uid, nick, photo) {
    if (!av || !uid) return;
    av.addEventListener('mouseenter', function () {
      if (S.hoverHideTimer) { clearTimeout(S.hoverHideTimer); S.hoverHideTimer = null; }
      if (S.hoverTimer) clearTimeout(S.hoverTimer);
      S.hoverTimer = setTimeout(function () {
        showUserCard(av, uid, nick, photo);
      }, 220);
    });
    av.addEventListener('mouseleave', function () {
      if (S.hoverTimer) { clearTimeout(S.hoverTimer); S.hoverTimer = null; }
      hideUserCard();
    });
    // Click ya navega vía community-user-link → dashboard?uid=
  }

  function hideUserCard(immediate) {
    if (S.hoverTimer) { clearTimeout(S.hoverTimer); S.hoverTimer = null; }
    var run = function () {
      if (!S.hoverCard) return;
      S.hoverCard.classList.remove('open');
      S.hoverUid = null;
    };
    if (immediate) {
      if (S.hoverHideTimer) clearTimeout(S.hoverHideTimer);
      run();
      return;
    }
    if (S.hoverHideTimer) clearTimeout(S.hoverHideTimer);
    S.hoverHideTimer = setTimeout(run, 160);
  }

  function positionUserCard(anchor) {
    var card = ensureUserCard();
    var rect = anchor.getBoundingClientRect();
    var pad = 10;
    var w = card.offsetWidth || 280;
    var h = card.offsetHeight || 180;
    var left = rect.right + 10;
    var top = rect.top;
    if (left + w > window.innerWidth - pad) left = rect.left - w - 10;
    if (left < pad) left = pad;
    if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
    if (top < pad) top = pad;
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function rankLabelOf(rango) {
    var r = normRango(rango);
    if (r === 'boss_of_the_state') return 'Boss of the State';
    if (r === 'commander') return 'Commander';
    if (r === 'divisional_commander') return 'Comandante Divisional';
    return 'Tribal Warrior';
  }

  function loadBgAssets() {
    if (S.bgAssets) return Promise.resolve(S.bgAssets);
    return db().ref('profileCustomizationAssets/background').once('value').then(function (snap) {
      S.bgAssets = snap.val() || {};
      return S.bgAssets;
    }).catch(function () {
      S.bgAssets = {};
      return S.bgAssets;
    });
  }

  function resolveBackgroundUrl(cust) {
    if (!cust) return '';
    var id = cust.equippedBackground || cust.equippedBackgroundId || cust.backgroundId || '';
    if (!id) return '';
    var asset = (S.bgAssets || {})[id];
    if (!asset) return '';
    return asset.imageUrl || asset.url || asset.downloadURL || '';
  }

  function fetchUserProfile(uid) {
    if (S.profileCache[uid] && (Date.now() - S.profileCache[uid]._at) < 60000) {
      return Promise.resolve(S.profileCache[uid]);
    }
    return Promise.all([
      db().ref('users/' + uid).once('value'),
      loadBgAssets()
    ]).then(function (res) {
      var d = (res[0] && res[0].val()) || {};
      var cust = d.profileCustomization || {};
      var frameId = cust.equippedFrame || cust.equippedFrameId || cust.frameId || null;
      if (frameId === 'default') frameId = null;
      var data = {
        uid: uid,
        nick: d.nick || d.nickname || 'Jugador',
        photo: d.photoURL || fallbackAvatar(),
        honor: Number(d.communityHonor || 0),
        rango: d.rango || '',
        level: d.level || d.nexusLevel || null,
        game: d.favoriteGame || d.juegoFavorito || d.mainGame || '',
        country: d.country || d.pais || '',
        status: (presence()[uid] && presence()[uid].status) || d.status || '',
        bgUrl: resolveBackgroundUrl(cust),
        frameId: frameId,
        _at: Date.now()
      };
      S.profileCache[uid] = data;
      return data;
    });
  }

  function showUserCard(anchor, uid, nickHint, photoHint) {
    var card = ensureUserCard();
    S.hoverUid = uid;
    card.innerHTML = '<div class="cf-user-card-loading"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';
    card.classList.add('open');
    positionUserCard(anchor);

    fetchUserProfile(uid).then(function (p) {
      if (S.hoverUid !== uid) return;
      var statusInfo = playerStatuses().find(function (s) { return s.value === (p.status || ''); });
      var statusLabel = statusInfo ? (statusInfo.emoji + ' ' + statusInfo.label) : '🟢 En línea';
      var online = !!(presence()[uid] && presence()[uid].online !== false && presence()[uid]);
      if (!presence()[uid]) statusLabel = '● Fuera';

      var bgStyle = p.bgUrl
        ? 'background-image:url(\'' + String(p.bgUrl).replace(/'/g, '%27') + '\')'
        : 'background: radial-gradient(ellipse at 30% 20%, rgba(229,57,53,0.35), transparent 55%), #141820';

      card.innerHTML =
        '<div class="cf-user-card-bg" style="' + bgStyle + '"></div>' +
        '<div class="cf-user-card-inner">' +
          '<div class="cf-user-card-top">' +
            '<div class="cf-user-card-avatar-wrap">' +
              '<img class="cf-user-card-avatar" src="' + esc(p.photo || photoHint || fallbackAvatar()) + '" alt="" onerror="this.src=\'' + fallbackAvatar() + '\'">' +
            '</div>' +
            '<div class="cf-user-card-id">' +
              '<p class="cf-user-card-nick">' + esc(p.nick || nickHint || 'Jugador') + '</p>' +
              '<p class="cf-user-card-rank">' + esc(rankLabelOf(p.rango)) + (online ? ' · ' + esc(statusLabel) : '') + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="cf-user-card-meta">' +
            '<div class="cf-user-card-stat"><span>Honor</span><strong>' + esc(String(p.honor || 0)) + '</strong></div>' +
            '<div class="cf-user-card-stat"><span>Juego</span><strong>' + esc(p.game || '—') + '</strong></div>' +
            '<div class="cf-user-card-stat"><span>País</span><strong>' + esc(p.country || '—') + '</strong></div>' +
            '<div class="cf-user-card-stat"><span>Nivel</span><strong>' + esc(p.level != null ? String(p.level) : '—') + '</strong></div>' +
          '</div>' +
          '<div class="cf-user-card-hint">Clic en la foto para abrir el perfil</div>' +
        '</div>';
      positionUserCard(anchor);

      // Marco del perfil en el popup (misma fuente que el chat en vivo).
      var cardWrap = card.querySelector('.cf-user-card-avatar-wrap');
      if (cardWrap) {
        ensureFrameListener(uid);
        applyChatFrame(cardWrap, effectiveChatFrame(uid, { equippedFrame: p.frameId }));
      }

      card.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        hideUserCard(true);
        if (typeof openCommunityUser === 'function') openCommunityUser(uid, p.nick || nickHint, 'profile');
        else window.location.href = '/dashboard?uid=' + encodeURIComponent(uid);
      };
    }).catch(function () {
      if (S.hoverUid !== uid) return;
      card.innerHTML =
        '<div class="cf-user-card-inner">' +
          '<div class="cf-user-card-top">' +
            '<img class="cf-user-card-avatar" src="' + esc(photoHint || fallbackAvatar()) + '" alt="">' +
            '<div class="cf-user-card-id">' +
              '<p class="cf-user-card-nick">' + esc(nickHint || 'Jugador') + '</p>' +
              '<p class="cf-user-card-rank">Perfil no disponible ahora</p>' +
            '</div>' +
          '</div>' +
          '<div class="cf-user-card-hint">Clic en la foto para abrir el perfil</div>' +
        '</div>';
      positionUserCard(anchor);
      card.onclick = function () {
        hideUserCard(true);
        window.location.href = '/dashboard?uid=' + encodeURIComponent(uid);
      };
    });
  }

  // ============================================================
  // 25. API pública
  // ============================================================
  window.SGCampfire = {
    boot: boot,
    isActive: function () { return !!S.booted; },
    openChannel: openChannel,
    jumpTo: jumpTo,
    refreshPresence: refreshPresence,
    setPresenceLabel: setPresenceLabel,
    reload: function () { openChannel(S.channel, true); },
    destroy: function () {
      untrackAll();
      if (S.embersStop) S.embersStop();
      S.booted = false;
    },
    state: S
  };
})();
