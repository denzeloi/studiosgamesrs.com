/**
 * Sensor de Nexus — el "oído" de Nexus en las seis páginas del sitio
 * =========================================================================
 * No escucha audio: escucha EVENTOS. Se engancha a los nodos que el servidor
 * escribe cuando el jugador gana algo y lo anuncia en el momento:
 *
 *   nexus/users/{uid}/xpLedger      → aviso "+X EXP · Misión completada"
 *   nexus/users/{uid}/levelUps/{n}  → celebración de subida de nivel
 *   nexus/users/{uid}/stats         → espejo autoritativo (chip de cabecera)
 *   nexus/users/{uid}/xpBoost       → bono temporal, para el panel del chip
 *
 * El patrón de escucha es el mismo que resolvió shared-notifications.js para
 * los mensajes privados, y por los mismos motivos: limitToLast + child_added
 * (nunca el nodo entero), ventana de frescura en el primer montaje para no
 * soltar una avalancha de avisos retroactivos al abrir una página, y memoria
 * en localStorage para que cambiar de página no repita el mismo aviso.
 *
 * Los niveles NO se calculan aquí: todo sale de window.SGLevels (sg-levels.js).
 * La insignia la pinta window.SGLevelBadge si está cargado; si no, se degrada a
 * texto. La animación 3D reutiliza window.SGCreatureViewer (welcome-overlay.js);
 * si el visor no está disponible en la página, la celebración se muestra igual
 * sin escenario 3D.
 */
(function () {
  'use strict';

  // Guardia de doble carga: el cableado de los HTML es de otra mano y un
  // <script> duplicado no debe duplicar avisos ni listeners.
  if (window.SGNexusSensor && window.SGNexusSensor.version) return;

  var VERSION = '20260728a';

  // Cola de concesiones que se lee: nunca se descarga el historial entero.
  var LEDGER_TAIL = 8;
  var LEVELUP_TAIL = 4;
  // Al montar los listeners solo se avisa de lo llegado en esta ventana.
  var XP_FRESH_MS = 2 * 60 * 1000;
  // Las subidas de nivel llegan un instante después del grant que las provoca,
  // pero el servidor reescribe `at` con la hora del servidor: se deja más aire
  // que en la EXP para no perder una celebración legítima por desfase de reloj.
  var LEVELUP_FRESH_MS = 10 * 60 * 1000;
  // Memoria de avisos ya dados, para no repetirlos al cambiar de página.
  var TOAST_MEMORY_MS = 45 * 60 * 1000;
  var XP_TOAST_MS = 6500;
  // Techo de vida del aviso agrupado: si la EXP entra en cadena, el aviso se
  // refresca pero no se queda pegado en pantalla indefinidamente.
  var XP_GROUP_MAX_MS = 16000;
  var LEVEL_TOAST_MS = 11000;
  // Espera antes de dar por buena la reserva de una celebración: si otra
  // pestaña también la reservó, gana la última escritura y esta cede.
  var CLAIM_SETTLE_MS = 150;
  // Paciencia máxima esperando a que se cierre el overlay de bienvenida/torneo
  // antes de anunciar la subida en pequeño: 60 × 1,5 s = un minuto y medio.
  var OVERLAY_WAIT_MS = 1500;
  var OVERLAY_WAIT_TRIES = 60;
  var NEXUS_URL = '/nexus';

  // Oro del torneo: el escenario lo pone la wyvern (fuego), así que el acento de
  // marco, títulos y botón va en dorado para no fundirse con las brasas.
  var RULES_ACCENT = '#e8b84a';

  /**
   * Código de conducta del torneo. Las tres primeras salen en grande porque son
   * las que descalifican; el resto va en letra pequeña al pie.
   */
  var TOURNAMENT_RULES = {
    major: [
      {
        icon: 'fa-comment-slash',
        title: 'Respeto y cero toxicidad',
        text: 'Prohibidos insultos, discriminación, acoso o lenguaje ofensivo por voz o texto.',
        sanction: 'Primera falta: partida cancelada y equipo completo descalificado.'
      },
      {
        icon: 'fa-video',
        title: 'Grabación obligatoria (anti-cheat)',
        text: 'Todos graban su pantalla con el software de la organización antes de empezar. Al denunciar hay que indicar la ronda exacta al Centinela.',
        sanction: 'Sin grabación o con ella desactivada: culpable automático y fuera del torneo.'
      },
      {
        icon: 'fa-stopwatch',
        title: 'Puntualidad: 10 minutos',
        text: 'Diez minutos de tolerancia desde la hora fijada para estar completos en el servidor.',
        sanction: 'Equipo incompleto: derrota por default (16 - 0).'
      }
    ],
    fine: [
      {
        icon: 'fa-pause-circle',
        title: 'Pausas técnicas',
        text: '1 pausa por equipo y mapa (máx. 3 min), avisando por el chat del servidor. El jugador caído vuelve dentro de la pausa o se sigue con el equipo incompleto.'
      },
      {
        icon: 'fa-gavel',
        title: 'Autoridad del Centinela',
        text: 'Las decisiones del Centinela o Coordinador durante la partida son definitivas e inapelables.'
      }
    ]
  };

  // Igual que en welcome-overlay.js: el sitio se sirve desde cPanel y desde
  // Firebase, pero los .glb y las fotos de fondo viven solo en Firebase.
  var SG_CDN = /studiosgamesrs\.web\.app$/i.test(window.location.hostname)
    ? '' : 'https://studiosgamesrs.web.app';
  var LOGO_SRC = '/logo-studiosgamesrs.png';
  var LOGO_CDN = (SG_CDN || 'https://studiosgamesrs.web.app') + LOGO_SRC;
  var DEFAULT_BACKDROP = '/overlay-volcano.jpg';

  // Personaje/animación por tramo, editable desde el Commander Panel (pestaña
  // "Notificaciones" del bloque de difusión). Público de lectura para que le
  // llegue a todo jugador; solo un commander o superior puede escribirlo (ver
  // database.rules.json). Sin override aquí cargado se cae al mapa fijo de
  // más abajo, así que el Nexo nunca se queda sin animación por falta de red.
  var TIER_ANIM_PATH = 'nexusTierAnimations';

  // Ángulo de cámara y tamaño en pantalla por personaje, calibrados a mano
  // desde el editor del Commander Panel (ver welcome-overlay.js#CAMERA_OVERRIDES).
  // Sin nada guardado aquí, cada personaje usa el ángulo/tamaño de fábrica
  // que ya trae SGCreatureViewer.CHARACTERS.
  var CHARACTER_CAM_PATH = 'nexusCharacterCamera';

  // Identificador de pestaña: solo sirve para resolver quién celebra cuando hay
  // dos pestañas abiertas mirando el mismo evento.
  var TAB_ID = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  var state = {
    uid: null,
    attached: false,
    authBound: false,
    mountAt: 0,
    stats: null,
    boost: null,
    refs: [],
    xpToasted: {},
    celebrated: {},
    // Aviso de EXP vivo: las concesiones seguidas se suman aquí en vez de
    // encadenar diez avisos.
    group: null,
    overlayQueue: [],
    overlayOpen: false,
    overlayWaits: 0,
    rulesWaits: 0,
    rulesAck: null,
    viewer: null,
    chipEl: null,
    panelEl: null,
    panelTimer: 0,
    chipInjected: false,
    chipTries: 0,
    panelOpen: false,
    embers: null,
    // null = todavía no llegó la primera lectura; {} u objeto = ya cargado.
    tierAnimOverrides: null,
    tierAnimWatching: false,
    charCamWatching: false
  };

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------

  /**
   * Todo lo que sale de la base de datos acaba dentro de HTML, a veces como
   * valor de atributo: se escapan también las comillas simples y dobles (ya
   * hubo un problema de comillas en atributos en este proyecto).
   */
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parseTime(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      var n = Date.parse(v);
      return isFinite(n) ? n : 0;
    }
    return 0;
  }

  function num(v) {
    var n = Math.floor(Number(v) || 0);
    return isFinite(n) ? n : 0;
  }

  function fmt(n) {
    try { return num(n).toLocaleString('es-ES'); } catch (e) { return String(num(n)); }
  }

  function getDb() {
    return (typeof firebase !== 'undefined' && firebase.database) ? firebase.database() : null;
  }

  /** La tabla de niveles es opcional en tiempo de ejecución, pero nunca se suple. */
  function levels() {
    return window.SGLevels || null;
  }

  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function pageKey() {
    var p = String((window.location && window.location.pathname) || '').toLowerCase().replace(/\.html$/, '');
    if (p.indexOf('commander') !== -1) return 'commander-panel';
    if (p.indexOf('competition') !== -1) return 'competition-hub';
    if (p.indexOf('community') !== -1) return 'community';
    if (p.indexOf('nexus') !== -1) return 'nexus';
    if (p.indexOf('playzone') !== -1) return 'playzone';
    return 'dashboard';
  }

  /**
   * En nexus.html la propia página ya narra la EXP (nexus-logic.js), así que
   * ahí el aviso flotante de EXP sería redundante. La celebración de nivel sí
   * sale: eso no lo hace ninguna página.
   */
  function isNexusPage() {
    return pageKey() === 'nexus';
  }

  function loadJson(key) {
    try {
      var raw = localStorage.getItem(key);
      var parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value || {})); } catch (e) {}
  }

  function xpToastedKey() { return 'sgNexusXpToasted_' + (state.uid || 'anon'); }
  function celebratedKey() { return 'sgNexusLevelUps_' + (state.uid || 'anon'); }

  // ---------------------------------------------------------------------------
  // Traducción de actionKey/source a español
  // ---------------------------------------------------------------------------

  /** Espejo de XP_ACTIONS (functions/nexusXp.js) en texto humano. */
  var ACTION_LABELS = {
    'quest:daily_login': 'Inicio diario',
    'quest:join_discord': 'Te uniste a Discord',
    'quest:invite_friend': 'Amigo invitado',
    'quest:create_overlay': 'Overlay creado',
    'quest:complete_profile': 'Perfil completado',
    'quest:share_facebook': 'Compartido en Facebook',
    'quest:share_twitter': 'Compartido en Twitter/X',
    'quest:share_whatsapp': 'Compartido en WhatsApp',
    download_overlay: 'Overlay descargado',
    share_overlay: 'Overlay compartido',
    generate_ai: 'Overlay generado con IA',
    use_ai: 'Sugerencia de IA aplicada',
    analyze_design: 'Análisis de diseño',
    streak_bonus: 'Racha diaria',
    reward_claim: 'Recompensa reclamada',
    achievement: 'Logro desbloqueado',
    referral_bonus: 'Referido verificado',
    mission_complete: 'Misión completada',
    tournament_win: 'Victoria en torneo',
    tournament_loss: 'Partida de torneo',
    general: 'Actividad en la web'
  };

  /**
   * Etiqueta del aviso. Sale siempre de un conjunto cerrado (nunca de la base
   * de datos), así que es seguro por construcción; el `source` se muestra
   * aparte y escapado.
   */
  function labelForAction(actionKey) {
    var key = String(actionKey == null ? '' : actionKey);
    if (ACTION_LABELS[key]) return ACTION_LABELS[key];
    if (key.indexOf('achievement:') === 0) return ACTION_LABELS.achievement;
    if (key.indexOf('reward:') === 0) return ACTION_LABELS.reward_claim;
    if (key.indexOf('quest:') === 0) return 'Misión de Nexus';
    return 'EXP de Nexus';
  }

  /**
   * Detalle secundario: lo que el servidor apuntó en `source` (el nombre del
   * logro, los días de racha, el título de la misión…). Viene de la base de
   * datos, así que se recorta y se escapa al pintarlo.
   *
   * El `source` de un referido es "Referido: {uid}", que no aporta nada al
   * jugador; se descarta para no enseñar un uid en pantalla.
   */
  function detailForGrant(grant) {
    var source = String((grant && grant.source) || '').trim();
    if (!source) return '';
    if (source === String((grant && grant.actionKey) || '')) return '';
    if (/^referido:/i.test(source)) return '';
    return source.slice(0, 70);
  }

  // ---------------------------------------------------------------------------
  // Progreso (siempre vía SGLevels)
  // ---------------------------------------------------------------------------

  /**
   * Foto del progreso para pintar barras y textos. Sin sg-levels.js cargado
   * devuelve null y los avisos salen sin barra: aquí no se calcula un nivel a
   * mano ni como último recurso.
   *
   * `minLevel` cubre el desfase de la celebración: el nodo levelUps llega antes
   * de que el espejo de stats haya viajado, así que si el XP conocido se queda
   * corto se usa el suelo del nivel que trae el evento (siempre vía SGLevels).
   */
  function progressFor(xp, minLevel) {
    var SG = levels();
    if (!SG || typeof SG.progress !== 'function') return null;
    var total = num(xp);
    var floorLevel = num(minLevel);
    if (floorLevel > 1 && typeof SG.xpForLevel === 'function' &&
        (!total || SG.levelFromXp(total) < floorLevel)) {
      total = num(SG.xpForLevel(floorLevel));
    }
    var prog = SG.progress(total);
    var tier = prog.tier || (typeof SG.tierForLevel === 'function' ? SG.tierForLevel(prog.level) : null);
    return {
      xp: prog.xp,
      level: prog.level,
      pct: prog.pct,
      remaining: prog.remaining,
      maxed: !!prog.maxed,
      nextLevel: prog.nextLevel,
      tierName: tier ? tier.name : '',
      accessName: tier ? tier.accessName : '',
      tagline: tier ? tier.tagline : '',
      color: (tier && tier.color) || '#58a6ff',
      glow: (tier && tier.glow) || 'rgba(88, 166, 255, 0.55)',
      icon: (tier && tier.icon) || 'fa-bolt'
    };
  }

  function currentXp() {
    return num(state.stats && state.stats.xp);
  }

  function currentLevel() {
    var SG = levels();
    if (SG && typeof SG.levelFromXp === 'function') return SG.levelFromXp(currentXp());
    return num(state.stats && state.stats.level) || 1;
  }

  // ---------------------------------------------------------------------------
  // Contenedor de avisos: se apila con los que ya existen
  // ---------------------------------------------------------------------------

  /**
   * Misma precedencia que shared-notifications.js: en Play Zone se reutiliza su
   * columna de avisos, y si no existe se usa (o se crea) #sgMissionInviteHost,
   * el contenedor que ese script también reutiliza. Así el aviso de EXP se
   * apila con la invitación a misión y el mensaje privado en vez de taparlos.
   */
  function ensureStackHost() {
    var pzHost = document.getElementById('privateChatNotificationContainer');
    if (pzHost) return pzHost;
    var host = document.getElementById('sgMissionInviteHost');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'sgMissionInviteHost';
    // La clase propia repite la posición por si shared-notifications.css no
    // llegó a cargar en esta página.
    host.className = 'sg-nexus-stack-host';
    host.setAttribute('aria-live', 'polite');
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  function dismissEl(el, ms) {
    if (!el) return;
    if (el.classList) el.classList.add('is-out');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, ms || 320);
  }

  // ---------------------------------------------------------------------------
  // Aviso de EXP
  // ---------------------------------------------------------------------------

  function barHtml(pct, color) {
    var width = Math.max(0, Math.min(100, Number(pct) || 0));
    return '<div class="sg-nexus-bar"><span class="sg-nexus-bar-fill" style="width:' +
      width.toFixed(1) + '%;background:' + esc(color) + ';"></span></div>';
  }

  /**
   * HTML del aviso de EXP. Función pura: se prueba sin navegador.
   * view = { amount, count, label, detail, prog }
   */
  function buildXpToastHtml(view) {
    view = view || {};
    var prog = view.prog || null;
    var count = num(view.count) || 1;
    var label = count > 1
      ? count + ' recompensas de Nexus'
      : (view.label || labelForAction(''));
    var detail = count > 1 ? '' : (view.detail || '');
    var color = prog ? prog.color : '#58a6ff';

    var footer = '';
    if (prog) {
      footer = prog.maxed
        ? 'Nivel ' + prog.level + ' · ' + esc(prog.tierName) + ' · tope del Nexo alcanzado'
        : 'Nivel ' + prog.level + ' · ' + esc(prog.tierName) + ' · faltan ' + fmt(prog.remaining) +
          ' EXP para el nivel ' + prog.nextLevel;
    }

    return '' +
      '<div class="sg-nexus-xp-main">' +
        '<span class="sg-nexus-xp-amount">+' + fmt(view.amount) + ' EXP</span>' +
        '<span class="sg-nexus-xp-label">' + esc(label) + '</span>' +
      '</div>' +
      (detail ? '<p class="sg-nexus-xp-detail">' + esc(detail) + '</p>' : '') +
      (prog ? barHtml(prog.pct, color) : '') +
      (footer ? '<p class="sg-nexus-xp-foot">' + footer + '</p>' : '') +
      '<button type="button" class="sg-nexus-close" aria-label="Cerrar">&times;</button>';
  }

  function closeGroup() {
    if (!state.group) return;
    if (state.group.timer) clearTimeout(state.group.timer);
    dismissEl(state.group.el);
    state.group = null;
  }

  function armGroupTimer() {
    var group = state.group;
    if (!group) return;
    if (group.timer) clearTimeout(group.timer);
    var left = XP_GROUP_MAX_MS - (Date.now() - group.startedAt);
    group.timer = setTimeout(function () {
      // Solo cierra su propio aviso: si entretanto empezó otro grupo, se
      // respeta el nuevo.
      if (state.group === group) closeGroup();
    }, Math.max(1200, Math.min(XP_TOAST_MS, left)));
  }

  /**
   * Muestra (o refresca) el aviso de EXP. Mientras hay uno vivo, las
   * concesiones siguientes se suman a él: diez avisos encadenados serían un
   * castigo, un aviso que crece se siente como una racha.
   */
  function showXpToast(view) {
    var host = ensureStackHost();
    if (!host) return null;

    if (state.group && state.group.el && state.group.el.parentNode) {
      state.group.amount += num(view.amount);
      state.group.count += 1;
      state.group.el.innerHTML = buildXpToastHtml({
        amount: state.group.amount,
        count: state.group.count,
        label: view.label,
        detail: view.detail,
        prog: view.prog
      });
      bindXpToast(state.group.el);
      if (view.prog) state.group.el.style.setProperty('--sg-nexus-tier', view.prog.color);
      armGroupTimer();
      return state.group.el;
    }

    var el = document.createElement('div');
    el.className = 'sg-nexus-xp-toast';
    if (view.prog && el.style && el.style.setProperty) {
      el.style.setProperty('--sg-nexus-tier', view.prog.color);
    }
    el.innerHTML = buildXpToastHtml({
      amount: view.amount, count: 1, label: view.label, detail: view.detail, prog: view.prog
    });
    host.appendChild(el);
    bindXpToast(el);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { if (el.classList) el.classList.add('is-in'); });
    } else if (el.classList) {
      el.classList.add('is-in');
    }

    state.group = { el: el, amount: num(view.amount), count: 1, startedAt: Date.now(), timer: null };
    armGroupTimer();
    return el;
  }

  function bindXpToast(el) {
    if (!el || typeof el.querySelector !== 'function') return;
    var close = el.querySelector('.sg-nexus-close');
    if (close && close.addEventListener) {
      close.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        closeGroup();
      });
    }
    if (el.addEventListener) {
      el.addEventListener('click', function () {
        closeGroup();
        openPanel();
      });
    }
  }

  /**
   * Una entrada de xpLedger. Decide si merece aviso (frescura + memoria) y lo
   * lanza. `opts.force` la usan las pruebas y el modo manual.
   */
  function handleXpGrant(id, grant, opts) {
    opts = opts || {};
    if (!id || !grant) return false;
    var granted = num(grant.granted);
    if (granted < 1) return false;

    var at = parseTime(grant.at);
    var fresh = opts.force || (at >= (state.mountAt - XP_FRESH_MS));
    if (!fresh) return false;
    if (!opts.force && state.xpToasted[id]) return false;

    state.xpToasted[id] = Date.now();
    saveJson(xpToastedKey(), state.xpToasted);

    // La EXP también mueve el chip antes de que llegue el eco de stats.
    var xpAfter = num(grant.xpAfter) || (currentXp() + granted);
    if (xpAfter > currentXp()) {
      state.stats = state.stats || {};
      state.stats.xp = xpAfter;
      if (grant.levelAfter) state.stats.level = num(grant.levelAfter);
      renderChip();
    }

    // En Nexus la página ya cuenta la EXP con su propia UI.
    if (isNexusPage() && !opts.force) return false;

    showXpToast({
      amount: granted,
      label: labelForAction(grant.actionKey),
      detail: detailForGrant(grant),
      prog: progressFor(xpAfter, grant.levelAfter)
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Celebración de subida de nivel
  // ---------------------------------------------------------------------------

  var REWARD_ICONS = {
    frame: 'fa-vector-square',
    background: 'fa-image',
    badge: 'fa-certificate',
    tokens: 'fa-coins',
    perk: 'fa-bolt'
  };

  var REWARD_KINDS = {
    frame: 'Marco',
    background: 'Fondo',
    badge: 'Insignia',
    tokens: 'Tokens',
    perk: 'Beneficio'
  };

  function rewardList(ev) {
    var raw = ev && ev.rewards;
    if (!raw) return [];
    var list = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) { return raw[k]; });
    return list.filter(function (r) { return r && typeof r === 'object'; }).slice(0, 6);
  }

  /** Tarjetas de recompensa. Nombre y descripción vienen de la base: se escapan. */
  function buildRewardsHtml(ev) {
    var list = rewardList(ev);
    if (!list.length) return '';
    return '<div class="sg-nexus-rewards">' + list.map(function (r, i) {
      var type = String(r.type || '');
      var icon = REWARD_ICONS[type] || 'fa-gift';
      var kind = REWARD_KINDS[type] || 'Recompensa';
      var name = String(r.name || kind).slice(0, 60);
      var desc = String(r.description || '').slice(0, 140);
      var amount = num(r.amount);
      // Entran en cascada: el retardo lo consume la animación del CSS.
      return '<div class="sg-nexus-reward" style="--sg-nexus-reward-delay:' + (i * 90) + 'ms">' +
          '<span class="sg-nexus-reward-icon"><i class="fas ' + esc(icon) + '"></i></span>' +
          '<span class="sg-nexus-reward-kind">' + esc(kind) + '</span>' +
          '<span class="sg-nexus-reward-name">' + esc(name) + (amount ? ' ×' + fmt(amount) : '') + '</span>' +
          (desc ? '<span class="sg-nexus-reward-desc">' + esc(desc) + '</span>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  /** Nombre del tramo: el de SGLevels manda; el del evento es el respaldo. */
  function tierNameFor(ev, prog) {
    if (prog && prog.tierName) return prog.tierName;
    return String((ev && ev.tierName) || '').slice(0, 32);
  }

  function nextRewardText(level) {
    var SG = levels();
    if (!SG || typeof SG.nextRewardLevel !== 'function') return '';
    var next = SG.nextRewardLevel(level);
    if (!next) return 'Ya no queda nada por desbloquear: has tocado el techo del Nexo.';
    var rewards = typeof SG.rewardsForLevel === 'function' ? SG.rewardsForLevel(next) : [];
    var names = rewards.map(function (r) { return String(r && r.name || ''); }).filter(Boolean).slice(0, 2);
    return 'Siguiente premio en el nivel ' + next + (names.length ? ': ' + names.join(' y ') : '');
  }

  /** HTML del aviso flotante de nivel intermedio. Función pura. */
  function buildLevelToastHtml(ev, prog) {
    var level = num(ev && ev.level);
    var tier = tierNameFor(ev, prog);
    var color = prog ? prog.color : '#58a6ff';
    var next = nextRewardText(level);
    return '' +
      '<div class="sg-nexus-level-badge" data-sg-nexus-badge="1">' +
        '<span class="sg-nexus-level-badge-fallback">Nv ' + level + '</span>' +
      '</div>' +
      '<div class="sg-nexus-level-body">' +
        '<p class="sg-nexus-level-kicker">¡Has subido de nivel!</p>' +
        '<strong class="sg-nexus-level-number">Nivel ' + level + '</strong>' +
        (tier ? '<span class="sg-nexus-level-tier">' + esc(tier) + '</span>' : '') +
        (prog ? barHtml(prog.pct, color) : '') +
        (next ? '<p class="sg-nexus-level-next">' + esc(next) + '</p>' : '') +
      '</div>' +
      '<button type="button" class="sg-nexus-close" aria-label="Cerrar">&times;</button>';
  }

  /** Pinta la insignia con SGLevelBadge si existe; si no, se queda el texto. */
  function paintBadge(holder, opts) {
    if (!holder) return;
    var badge = window.SGLevelBadge;
    if (!badge || typeof badge.render !== 'function') return;
    try {
      badge.render(holder, opts);
    } catch (e) {
      // La insignia es adorno: si su módulo falla, el número de nivel ya está.
    }
  }

  function showLevelToast(ev, prog) {
    var host = ensureStackHost();
    if (!host) return null;
    var el = document.createElement('div');
    el.className = 'sg-nexus-level-toast';
    if (prog && el.style && el.style.setProperty) el.style.setProperty('--sg-nexus-tier', prog.color);
    el.innerHTML = buildLevelToastHtml(ev, prog);
    host.appendChild(el);

    if (typeof el.querySelector === 'function') {
      var holder = el.querySelector('[data-sg-nexus-badge]');
      paintBadge(holder, {
        xp: prog ? prog.xp : null,
        level: num(ev && ev.level),
        size: 'md',
        showBar: false,
        showTier: true
      });
      // El propio módulo de la insignia sabe animar una subida de nivel.
      var badge = window.SGLevelBadge;
      if (holder && badge && typeof badge.celebrate === 'function' && !reducedMotion()) {
        try { badge.celebrate(holder); } catch (e) {}
      }
      var close = el.querySelector('.sg-nexus-close');
      if (close && close.addEventListener) {
        close.addEventListener('click', function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          dismissEl(el);
        });
      }
    }
    if (el.addEventListener) {
      el.addEventListener('click', function () {
        dismissEl(el);
        window.location.href = NEXUS_URL;
      });
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { if (el.classList) el.classList.add('is-in'); });
    }
    setTimeout(function () { dismissEl(el); }, LEVEL_TOAST_MS);
    return el;
  }

  /**
   * HTML del overlay a pantalla completa de subida de tramo. Función pura.
   *
   * Comparte estructura con el overlay de bienvenida/torneo del dashboard
   * (welcome-overlay.js): fondo con foto y brasas, logo, escenario 3D y las
   * tarjetas de premio. Antes esto era una tarjeta plana y la subida de tramo
   * (que pasa una vez cada diez niveles) se sentía menos que una invitación a
   * un torneo.
   */
  function buildLevelOverlayHtml(ev, prog) {
    var SG = levels();
    var level = num(ev && ev.level);
    var maxed = !!(SG && level >= SG.MAX_LEVEL);
    var tier = tierNameFor(ev, prog);
    var access = prog ? prog.accessName : '';
    var tagline = prog ? prog.tagline : '';
    var progressLine = '';
    if (prog) {
      progressLine = prog.maxed
        ? fmt(prog.xp) + ' EXP · tope del Nexo alcanzado'
        : fmt(prog.xp) + ' EXP · faltan ' + fmt(prog.remaining) + ' para el nivel ' + prog.nextLevel;
    }
    return '' +
      '<div class="sg-nexus-overlay-backdrop">' +
        '<div class="sg-nexus-overlay-photo"></div>' +
        '<div class="sg-nexus-overlay-ember"></div>' +
        '<canvas class="sg-nexus-overlay-embers"></canvas>' +
      '</div>' +
      '<div class="sg-nexus-overlay-box" role="dialog" aria-label="Subida de nivel">' +
        '<button type="button" class="sg-nexus-overlay-close" aria-label="Cerrar">&times;</button>' +
        '<img class="sg-nexus-overlay-logo" src="' + LOGO_SRC + '" alt="StudiosGamesRS" ' +
          'onerror="this.onerror=null;this.src=\'' + LOGO_CDN + '\';" />' +
        '<div class="sg-nexus-overlay-stage">' +
          '<div class="sg-nexus-overlay-glow"></div>' +
          '<canvas class="sg-nexus-overlay-canvas"></canvas>' +
          '<div class="sg-nexus-overlay-loading">Invocando…</div>' +
        '</div>' +
        '<p class="sg-nexus-overlay-kicker">' +
          (maxed ? 'Techo del Nexo' : 'Nuevo tramo desbloqueado') +
        '</p>' +
        '<div class="sg-nexus-overlay-head">' +
          '<span class="sg-nexus-overlay-badge" data-sg-nexus-badge="1">' +
            '<span class="sg-nexus-overlay-badge-fallback">' + level + '</span>' +
          '</span>' +
          '<h2 class="sg-nexus-overlay-level">Nivel ' + level + '</h2>' +
        '</div>' +
        (tier ? '<p class="sg-nexus-overlay-tier">' + esc(tier) +
          (access ? ' · ' + esc(access) : '') + '</p>' : '') +
        (tagline ? '<p class="sg-nexus-overlay-tagline">' + esc(tagline) + '</p>' : '') +
        (prog ? '<div class="sg-nexus-overlay-progress">' + barHtml(prog.pct, prog.color) +
          '<p class="sg-nexus-overlay-xp">' + progressLine + '</p></div>' : '') +
        buildRewardsHtml(ev) +
        '<button type="button" class="sg-nexus-overlay-btn">Ver mi Nexus</button>' +
      '</div>';
  }

  /**
   * HTML del overlay de reglas del torneo. Función pura.
   *
   * Es el mismo escenario que la subida de tramo (foto, brasas, logo y el 3D
   * arriba): lo que cambia es el cuerpo, con las tres reglas que descalifican en
   * grande y el resto como letra pequeña.
   */
  function buildTournamentRulesHtml(payload) {
    var data = payload || {};
    var major = (data.major && data.major.length ? data.major : TOURNAMENT_RULES.major).slice(0, 3);
    var fine = (data.fine && data.fine.length ? data.fine : TOURNAMENT_RULES.fine);
    var meta = (data.meta || []).filter(function (m) { return m && m.value; });

    var majorHtml = major.map(function (rule, i) {
      return '' +
        '<article class="sg-nexus-rule" style="--sg-nexus-rule-delay:' + (120 + i * 110) + 'ms;">' +
          '<span class="sg-nexus-rule-index">' + (i + 1) + '</span>' +
          '<span class="sg-nexus-rule-icon"><i class="fas ' + esc(rule.icon || 'fa-shield-alt') + '"></i></span>' +
          '<div class="sg-nexus-rule-body">' +
            '<h3 class="sg-nexus-rule-title">' + esc(rule.title) + '</h3>' +
            '<p class="sg-nexus-rule-text">' + esc(rule.text) + '</p>' +
            (rule.sanction
              ? '<p class="sg-nexus-rule-sanction"><i class="fas fa-exclamation-triangle"></i>' +
                '<span>' + esc(rule.sanction) + '</span></p>'
              : '') +
          '</div>' +
        '</article>';
    }).join('');

    var fineHtml = fine.length
      ? '<ul class="sg-nexus-rules-fine">' + fine.map(function (rule) {
          return '<li><i class="fas ' + esc(rule.icon || 'fa-circle') + '"></i>' +
            '<span><strong>' + esc(rule.title) + ':</strong> ' + esc(rule.text) + '</span></li>';
        }).join('') + '</ul>'
      : '';

    var metaHtml = meta.length
      ? '<div class="sg-nexus-rules-meta">' + meta.map(function (m) {
          return '<span class="sg-nexus-rules-chip">' +
            (m.icon ? '<i class="fas ' + esc(m.icon) + '"></i>' : '') +
            '<span class="sg-nexus-rules-chip-label">' + esc(m.label || '') + '</span>' +
            '<strong>' + esc(m.value) + '</strong></span>';
        }).join('') + '</div>'
      : '';

    return '' +
      '<div class="sg-nexus-overlay-backdrop">' +
        '<div class="sg-nexus-overlay-photo"></div>' +
        '<div class="sg-nexus-overlay-ember"></div>' +
        '<canvas class="sg-nexus-overlay-embers"></canvas>' +
      '</div>' +
      '<div class="sg-nexus-overlay-box" role="dialog" aria-label="Reglas del torneo">' +
        '<button type="button" class="sg-nexus-overlay-close" aria-label="Cerrar">&times;</button>' +
        '<img class="sg-nexus-overlay-logo" src="' + LOGO_SRC + '" alt="StudiosGamesRS" ' +
          'onerror="this.onerror=null;this.src=\'' + LOGO_CDN + '\';" />' +
        '<div class="sg-nexus-overlay-stage">' +
          '<div class="sg-nexus-overlay-glow"></div>' +
          '<canvas class="sg-nexus-overlay-canvas"></canvas>' +
          '<div class="sg-nexus-overlay-loading">Invocando…</div>' +
        '</div>' +
        '<p class="sg-nexus-overlay-kicker">' + esc(data.kicker || 'Reglas del torneo') + '</p>' +
        '<h2 class="sg-nexus-overlay-level sg-nexus-rules-title">' +
          esc(data.title || 'Código de conducta') + '</h2>' +
        (data.tournamentName
          ? '<p class="sg-nexus-overlay-tier">' + esc(data.tournamentName) + '</p>' : '') +
        '<p class="sg-nexus-overlay-tagline">' +
          esc(data.subtitle || 'Léelo una vez antes de conectar. Aplica a todo el roster inscrito.') +
        '</p>' +
        metaHtml +
        '<div class="sg-nexus-rules">' + majorHtml + '</div>' +
        fineHtml +
        '<button type="button" class="sg-nexus-overlay-btn">' +
          esc(data.buttonText || 'Entendido, entrar al torneo') + '</button>' +
      '</div>';
  }

  /**
   * La wyvern es la que recibe a los jugadores del torneo. Si el visor no la
   * tiene cargada se cae al personaje del tramo más alto, que es el que más se
   * le parece en presencia.
   */
  function rulesCharacter() {
    var chars = (window.SGCreatureViewer && window.SGCreatureViewer.CHARACTERS) || null;
    if (chars && chars['wyvern-dragon'] && chars['wyvern-dragon'].clips &&
      chars['wyvern-dragon'].clips.roar) {
      return { characterId: 'wyvern-dragon', clip: 'roar' };
    }
    return pickCharacter(7);
  }

  /**
   * Overlay de reglas, una sola vez por torneo y jugador. Quien decide si ya se
   * vio es la página que lo llama (localStorage + `rulesAck` en RTDB): aquí solo
   * se garantiza que no se pise con una celebración de nivel ni con el overlay
   * de bienvenida, y que el "visto" se confirme al cerrar de cualquier forma.
   */
  function showTournamentRules(payload, onAck) {
    if (!document || !document.createElement) return null;
    if (state.overlayOpen || welcomeOverlayVisible()) {
      if (state.rulesWaits >= OVERLAY_WAIT_TRIES) return null;
      state.rulesWaits += 1;
      setTimeout(function () { showTournamentRules(payload, onAck); }, OVERLAY_WAIT_MS);
      return null;
    }

    state.rulesWaits = 0;
    state.overlayOpen = true;
    state.rulesAck = (typeof onAck === 'function') ? onAck : null;

    var pick = rulesCharacter();
    var el = document.createElement('div');
    el.id = 'sgNexusLevelOverlay';
    el.className = 'sg-nexus-overlay sg-nexus-overlay-rules';
    if (el.style && el.style.setProperty) {
      el.style.setProperty('--sg-nexus-tier', (payload && payload.accent) || RULES_ACCENT);
    }
    el.innerHTML = buildTournamentRulesHtml(payload);
    (document.body || document.documentElement).appendChild(el);

    var theme = applyAmbience(el, pick);
    state.embers = startEmbers(el, theme);

    function ackAndClose() {
      var ack = state.rulesAck;
      state.rulesAck = null;
      if (ack) {
        try { ack(); } catch (e) { /* el "visto" es best effort */ }
      }
      closeLevelOverlay();
    }

    if (typeof el.querySelector === 'function') {
      ['.sg-nexus-overlay-close', '.sg-nexus-overlay-backdrop', '.sg-nexus-overlay-btn']
        .forEach(function (sel) {
          var node = el.querySelector(sel);
          if (node && node.addEventListener) node.addEventListener('click', ackAndClose);
        });
    }

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { if (el.classList) el.classList.add('is-open'); });
    } else if (el.classList) {
      el.classList.add('is-open');
    }

    mountViewer(el, pick);
    return el;
  }

  /**
   * Personaje y clip de la celebración, en escalada: el gólem recibe a los
   * primeros tramos, el soldado toma la posta a media tabla y la wyvern queda
   * para los tres últimos, que empiezan justo en LEYENDA (nivel 70, el tramo
   * que ya lleva un dragón por icono en sg-levels.js). Si el visor no publica
   * el personaje que toca, se cae al que exista.
   */
  /**
   * Mapa fijo de fábrica: qué personaje/animación le toca a cada tramo si
   * nadie lo ha personalizado desde el Commander Panel. Es puro y síncrono a
   * propósito, para que el admin panel pueda mostrar "cuál sería el valor por
   * defecto" sin esperar a ninguna lectura de red.
   */
  function defaultTierAnimation(tierIndex) {
    var idx = num(tierIndex);
    if (idx >= 7) return { characterId: 'wyvern-dragon', clip: 'roar' };
    if (idx >= 4) return { characterId: 'soldier-specops', clip: 'rifle_pose' };
    return { characterId: 'golem-tortoise', clip: 'roar' };
  }

  function validPick(chars, wanted) {
    return !!(wanted && chars[wanted.characterId] && chars[wanted.characterId].clips &&
      chars[wanted.characterId].clips[wanted.clip]);
  }

  /**
   * Personaje/animación EFECTIVOS de un tramo: primero mira si hay una
   * personalización guardada en `nexusTierAnimations/{tramo}` (la escribe el
   * Commander Panel) y, si no hay o quedó inválida (p.ej. se borró el
   * personaje), cae al mapa fijo de arriba.
   */
  function pickCharacter(tierIndex) {
    var chars = (window.SGCreatureViewer && window.SGCreatureViewer.CHARACTERS) || null;
    if (!chars) return null;
    var idx = num(tierIndex);
    var override = state.tierAnimOverrides && state.tierAnimOverrides[idx];
    var wanted = (override && { characterId: override.characterId, clip: override.clip }) ||
      defaultTierAnimation(idx);
    if (!validPick(chars, wanted)) wanted = defaultTierAnimation(idx);
    if (validPick(chars, wanted)) return wanted;
    var ids = Object.keys(chars);
    if (!ids.length) return null;
    var fallback = chars[ids[0]];
    var clip = (fallback && fallback.loopClip) || 'idle';
    return { characterId: ids[0], clip: clip };
  }

  /** Arranca (una sola vez) la escucha en vivo de las personalizaciones por tramo. */
  function watchTierAnimations() {
    if (state.tierAnimWatching) return;
    var db = getDb();
    if (!db) return;
    state.tierAnimWatching = true;
    db.ref(TIER_ANIM_PATH).on('value', function (snap) {
      state.tierAnimOverrides = snap.val() || {};
    }, function (err) {
      console.warn('[SGNexusSensor] no se pudo leer nexusTierAnimations', (err && err.message) || err);
    });
  }

  /**
   * Arranca (una sola vez) la escucha en vivo de la calibración de cámara por
   * personaje. En cuanto llega algo de Firebase se lo pasa tal cual a
   * SGCreatureViewer.setCameraOverride(), que reencuadra al instante cualquier
   * visor que esté abierto en esa pestaña (overlay de nivel, broadcast, o la
   * vista previa del propio Commander Panel).
   */
  function watchCharacterCamera() {
    if (state.charCamWatching) return;
    var db = getDb();
    var viewerApi = window.SGCreatureViewer;
    if (!db || !viewerApi || typeof viewerApi.setCameraOverride !== 'function') return;
    state.charCamWatching = true;
    db.ref(CHARACTER_CAM_PATH).on('value', function (snap) {
      var all = snap.val() || {};
      var chars = viewerApi.CHARACTERS || {};
      Object.keys(chars).forEach(function (id) {
        var cfg = all[id];
        if (cfg && (typeof cfg.yawDeg === 'number' || typeof cfg.sizeMult === 'number')) {
          viewerApi.setCameraOverride(id, cfg);
        } else {
          viewerApi.clearCameraOverride(id);
        }
      });
    }, function (err) {
      console.warn('[SGNexusSensor] no se pudo leer nexusCharacterCamera', (err && err.message) || err);
    });
  }

  /** Índice de tramo del evento; si el servidor no lo mandó, lo saca de SGLevels. */
  function tierIndexFor(ev) {
    if (ev && ev.tierIndex !== undefined && ev.tierIndex !== null) return num(ev.tierIndex);
    var SG = levels();
    var level = num(ev && ev.level);
    if (SG && typeof SG.tierForLevel === 'function' && level) {
      var tier = SG.tierForLevel(level);
      if (tier && typeof tier.index === 'number') return tier.index;
    }
    return 0;
  }

  /**
   * Ambientación del overlay: foto de fondo y paleta de brasas del personaje
   * que sale en el escenario, igual que hace el overlay del dashboard. Sin
   * SGCreatureViewer cargado se queda el tema por defecto y no pasa nada.
   */
  function applyAmbience(overlayEl, pick) {
    var chars = (window.SGCreatureViewer && window.SGCreatureViewer.CHARACTERS) || {};
    var character = chars[pick && pick.characterId] || null;
    var theme = (character && character.theme) || 'ember';
    var backdrop = (character && character.backdrop) || DEFAULT_BACKDROP;
    overlayEl.setAttribute('data-sg-theme', theme);
    var photo = typeof overlayEl.querySelector === 'function'
      ? overlayEl.querySelector('.sg-nexus-overlay-photo') : null;
    // La ruta se pone desde JS porque la imagen vive en Firebase y un url()
    // relativo del CSS se resolvería contra el dominio de la página.
    if (photo && photo.style) {
      photo.style.backgroundImage = "url('" + SG_CDN + backdrop + "')";
    }
    return theme;
  }

  /** Arranca las brasas del fondo. Se apagan al cerrar (no gastan CPU de más). */
  function startEmbers(overlayEl, theme) {
    var api = window.SGCreatureViewer;
    if (!api || typeof api.createEmbers !== 'function' || reducedMotion()) return null;
    var canvas = typeof overlayEl.querySelector === 'function'
      ? overlayEl.querySelector('.sg-nexus-overlay-embers') : null;
    if (!canvas) return null;
    var embers = api.createEmbers(canvas);
    if (!embers) return null;
    embers.setPalette(theme);
    embers.start();
    return embers;
  }

  /** ¿Está abierto el overlay de welcome-overlay.js? Entonces no se le pisa. */
  function welcomeOverlayVisible() {
    if (typeof document.querySelector !== 'function') return false;
    return !!document.querySelector('.sg-welcome-overlay.sg-welcome-overlay-visible');
  }

  function closeLevelOverlay() {
    var el = document.getElementById('sgNexusLevelOverlay');
    if (el && el.classList) el.classList.remove('is-open');
    state.rulesAck = null;
    if (state.viewer && typeof state.viewer.pause === 'function') {
      try { state.viewer.pause(); } catch (e) {}
    }
    if (state.embers) {
      try { state.embers.stop(); } catch (e) {}
      state.embers = null;
    }
    state.overlayOpen = false;
    setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      if (state.viewer && typeof state.viewer.dispose === 'function') {
        try { state.viewer.dispose(); } catch (e) {}
      }
      state.viewer = null;
      drainOverlayQueue();
    }, 380);
  }

  /**
   * Saca la siguiente celebración en cuanto haya sitio. Mientras el overlay de
   * welcome-overlay.js siga abierto se vuelve a intentar, con un techo de
   * paciencia: un premio no puede perderse porque coincidiera con la
   * bienvenida, pero tampoco puede quedarse reintentando toda la sesión.
   */
  function drainOverlayQueue() {
    if (!state.overlayQueue.length || state.overlayOpen) return;
    if (welcomeOverlayVisible()) {
      if (state.overlayWaits >= OVERLAY_WAIT_TRIES) {
        // Se renuncia al escenario a pantalla completa y se anuncia en pequeño.
        state.overlayQueue.splice(0).forEach(function (item) {
          showLevelToast(item.ev, item.prog);
        });
        return;
      }
      state.overlayWaits += 1;
      setTimeout(drainOverlayQueue, OVERLAY_WAIT_MS);
      return;
    }
    state.overlayWaits = 0;
    var next = state.overlayQueue.shift();
    if (next) openLevelOverlay(next.ev, next.prog);
  }

  function openLevelOverlay(ev, prog) {
    // Una celebración a la vez, y nunca encima del overlay de bienvenida /
    // torneo: se espera a que cierre.
    if (state.overlayOpen || welcomeOverlayVisible()) {
      state.overlayQueue.push({ ev: ev, prog: prog });
      if (!state.overlayOpen) setTimeout(drainOverlayQueue, OVERLAY_WAIT_MS);
      return null;
    }

    state.overlayOpen = true;
    var pick = pickCharacter(tierIndexFor(ev));
    var el = document.createElement('div');
    el.id = 'sgNexusLevelOverlay';
    el.className = 'sg-nexus-overlay';
    if (prog && el.style && el.style.setProperty) el.style.setProperty('--sg-nexus-tier', prog.color);
    el.innerHTML = buildLevelOverlayHtml(ev, prog);
    (document.body || document.documentElement).appendChild(el);

    var theme = applyAmbience(el, pick);
    state.embers = startEmbers(el, theme);

    if (typeof el.querySelector === 'function') {
      // La insignia del nivel, con la misma pieza que usa el chip y el aviso
      // pequeño; si su módulo no está, se queda el número que ya viene puesto.
      var badgeHolder = el.querySelector('.sg-nexus-overlay-badge');
      paintBadge(badgeHolder, {
        xp: prog ? prog.xp : null,
        level: num(ev && ev.level),
        size: 'lg',
        showBar: false,
        showTier: false
      });
      var badgeApi = window.SGLevelBadge;
      if (badgeHolder && badgeApi && typeof badgeApi.celebrate === 'function' && !reducedMotion()) {
        try { badgeApi.celebrate(badgeHolder); } catch (e) {}
      }
    }

    if (typeof el.querySelector === 'function') {
      var closeBtn = el.querySelector('.sg-nexus-overlay-close');
      if (closeBtn && closeBtn.addEventListener) {
        closeBtn.addEventListener('click', closeLevelOverlay);
      }
      var backdrop = el.querySelector('.sg-nexus-overlay-backdrop');
      if (backdrop && backdrop.addEventListener) {
        backdrop.addEventListener('click', closeLevelOverlay);
      }
      var goBtn = el.querySelector('.sg-nexus-overlay-btn');
      if (goBtn && goBtn.addEventListener) {
        goBtn.addEventListener('click', function () {
          closeLevelOverlay();
          setTimeout(function () { window.location.href = NEXUS_URL; }, 180);
        });
      }
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { if (el.classList) el.classList.add('is-open'); });
    } else if (el.classList) {
      el.classList.add('is-open');
    }

    mountViewer(el, pick);
    return el;
  }

  /**
   * Vista previa administrativa (Commander Panel, editor de notificaciones):
   * abre el overlay REAL de subida de tramo con cualquier combinación de
   * nivel, personaje, animación, textos y recompensas que el admin quiera
   * probar. No reserva nada en `levelUps` ni depende del XP real de nadie:
   * se fabrica su propio `ev`/`prog` desde `SGLevels` y, si hace falta, se
   * pisa por un instante `state.tierAnimOverrides` para forzar el personaje
   * elegido aunque no sea el que le tocaría por defecto a ese tramo. Como
   * reutiliza openLevelOverlay/pickCharacter tal cual, lo que se ve aquí es
   * pixel a pixel lo que vería un jugador real con esos mismos datos.
   */
  function previewLevelOverlay(opts) {
    opts = opts || {};
    var SG = levels();
    var level = Math.max(1, num(opts.level) || 10);
    var tier = (SG && typeof SG.tierForLevel === 'function') ? SG.tierForLevel(level) : null;
    var tierIndex = (opts.tierIndex !== undefined && opts.tierIndex !== null) ?
      num(opts.tierIndex) : (tier ? tier.index : 0);

    function pick(field, fallback) {
      var v = opts[field];
      return (v !== undefined && v !== null && v !== '') ? v : fallback;
    }

    var prog = {
      xp: (SG && typeof SG.xpForLevel === 'function') ? SG.xpForLevel(level) : level * 400,
      level: level,
      pct: num(pick('pct', 30)),
      remaining: num(pick('remaining', 0)),
      maxed: !!opts.maxed,
      nextLevel: level + 1,
      tierName: String(pick('tierName', tier ? tier.name : '')),
      accessName: String(pick('accessName', tier ? tier.accessName : '')),
      tagline: String(pick('tagline', tier ? tier.tagline : '')),
      color: pick('color', (tier && tier.color) || '#58a6ff'),
      glow: (tier && tier.glow) || 'rgba(88, 166, 255, 0.55)',
      icon: (tier && tier.icon) || 'fa-bolt'
    };
    var ev = {
      level: level,
      tierIndex: tierIndex,
      tierName: prog.tierName,
      rewards: Array.isArray(opts.rewards) ? opts.rewards : []
    };

    function launch() {
      var prevOverrides = state.tierAnimOverrides;
      var restore = null;
      if (opts.characterId && opts.clip) {
        var next = {};
        if (prevOverrides) {
          Object.keys(prevOverrides).forEach(function (k) { next[k] = prevOverrides[k]; });
        }
        next[tierIndex] = { characterId: opts.characterId, clip: opts.clip };
        state.tierAnimOverrides = next;
        restore = function () { state.tierAnimOverrides = prevOverrides; };
      }
      // pickCharacter() se consulta de forma síncrona al principio de
      // openLevelOverlay, así que para cuando esta línea vuelve ya se usó el
      // personaje forzado: es seguro deshacer el pisado enseguida.
      var el = openLevelOverlay(ev, prog);
      if (restore) restore();
      return el;
    }

    if (state.overlayOpen) {
      closeLevelOverlay();
      setTimeout(launch, 420);
      return null;
    }
    return launch();
  }

  /**
   * Escenario 3D. Se reutiliza tal cual el visor de welcome-overlay.js; si esa
   * pieza no está en la página, si el navegador no la puede crear o si el
   * modelo no llega, el overlay se queda en su versión plana (marco, nivel,
   * tramo y premios) en vez de fallar.
   */
  function mountViewer(overlayEl, pick) {
    function flat(reason) {
      if (overlayEl.classList) overlayEl.classList.add('is-flat');
      if (typeof overlayEl.querySelector === 'function') {
        var loading = overlayEl.querySelector('.sg-nexus-overlay-loading');
        if (loading) loading.textContent = reason || '';
      }
    }

    if (reducedMotion()) { flat(''); return; }
    var viewerApi = window.SGCreatureViewer;
    if (!viewerApi || typeof viewerApi.create !== 'function') { flat(''); return; }
    if (!pick) { flat(''); return; }
    var canvas = typeof overlayEl.querySelector === 'function'
      ? overlayEl.querySelector('.sg-nexus-overlay-canvas') : null;
    if (!canvas) { flat(''); return; }

    var viewer = null;
    try {
      viewer = viewerApi.create(canvas);
    } catch (e) {
      viewer = null;
    }
    if (!viewer || typeof viewer.playEntrance !== 'function') { flat(''); return; }
    state.viewer = viewer;

    try {
      viewer.playEntrance(pick.characterId, pick.clip, function (err) {
        if (err) { flat(''); return; }
        if (typeof overlayEl.querySelector === 'function') {
          var loading = overlayEl.querySelector('.sg-nexus-overlay-loading');
          if (loading && loading.style) loading.style.display = 'none';
        }
        if (overlayEl.classList) overlayEl.classList.add('has-3d');
      }, function (ratio) {
        if (typeof overlayEl.querySelector !== 'function') return;
        var loading = overlayEl.querySelector('.sg-nexus-overlay-loading');
        if (loading) {
          loading.textContent = 'Invocando… ' + Math.min(100, Math.round((Number(ratio) || 0) * 100)) + '%';
        }
      });
    } catch (e) {
      flat('');
    }
  }

  /**
   * Reserva de la celebración. El jugador no puede escribir en levelUps (nodo
   * de solo lectura), así que la idempotencia vive en localStorage:
   *
   *  - si el nivel ya está apuntado, no se celebra otra vez (recarga, F5,
   *    volver a la página);
   *  - con dos pestañas, las dos apuntan el nivel y las dos vuelven a leer un
   *    instante después: gana la última escritura y la otra cede, así que la
   *    animación sale una sola vez.
   */
  function claimLevelUp(level, done) {
    var key = celebratedKey();
    var map = loadJson(key);
    var mine = map[String(level)];
    if (mine) { done(false); return; }
    map[String(level)] = { at: Date.now(), tab: TAB_ID };
    saveJson(key, map);
    state.celebrated = map;
    setTimeout(function () {
      var after = loadJson(key);
      var owner = after[String(level)];
      done(!!(owner && owner.tab === TAB_ID));
    }, CLAIM_SETTLE_MS);
  }

  /**
   * Un nodo levelUps/{level}. Decide frescura, reserva la celebración y elige
   * formato: overlay 3D en los niveles de tramo (10, 20 … 100), aviso flotante
   * grande en los intermedios.
   */
  function handleLevelUp(level, ev, opts) {
    opts = opts || {};
    var n = num(level || (ev && ev.level));
    if (n < 2) return false;
    var at = parseTime(ev && ev.at);
    var fresh = opts.force || (at > 0 && at >= (state.mountAt - LEVELUP_FRESH_MS));
    if (!fresh) return false;

    // Comprobación síncrona antes de reservar: si ya se celebró (recarga, otra
    // página, otra pestaña), se descarta sin más trámite.
    if (!opts.force) {
      state.celebrated = loadJson(celebratedKey());
      if (state.celebrated[String(n)]) return false;
    }

    var SG = levels();
    var isTier = (n % 10 === 0) || !!(SG && n >= SG.MAX_LEVEL);
    var payload = ev || { level: n };

    function celebrate() {
      var prog = progressFor(currentXp(), n);
      if (isTier) openLevelOverlay(payload, prog);
      else showLevelToast(payload, prog);
      renderChip();
    }

    if (opts.force) { celebrate(); return true; }
    claimLevelUp(n, function (won) { if (won) celebrate(); });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Chip de nivel en la cabecera
  // ---------------------------------------------------------------------------

  function boostInfo() {
    var boost = state.boost;
    if (!boost) return null;
    var expiresAt = parseTime(boost.expiresAt);
    if (!expiresAt || expiresAt <= Date.now()) return null;
    var mult = Number(boost.multiplier) || 2;
    var mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
    return { mult: mult, mins: mins };
  }

  /** Nombres legibles de las llaves de acceso que reparte cada tramo. */
  var ACCESS_LABELS = {
    profileCustomization: 'Personalizar perfil',
    mercadoTecnico: 'Mercado Técnico',
    prioritySupport: 'Soporte prioritario',
    betaAccess: 'Acceso beta',
    vipLounge: 'Sala VIP',
    tournamentPriority: 'Prioridad en torneos',
    customTitle: 'Título propio',
    hallOfFame: 'Salón de la Fama'
  };

  /**
   * Beneficios que el jugador ya tiene por su nivel. Los que llevan número van
   * en filas (`rows`) y las llaves de acceso en pastillas (`access`), que a
   * nivel alto son ocho y en filas harían un panel larguísimo.
   */
  function benefitsFor(prog) {
    var SG = levels();
    var out = { rows: [], access: [] };
    if (!prog || !SG) return out;

    var bonusPct = typeof SG.xpBonusPct === 'function' ? num(SG.xpBonusPct(prog.level, prog.xp)) : 0;
    if (bonusPct > 0) out.rows.push({ icon: 'fa-bolt', text: '+' + bonusPct + '% de EXP en todo' });

    var perks = typeof SG.perksForLevel === 'function' ? SG.perksForLevel(prog.level) : null;
    if (perks) {
      if (perks.missionTokenBonusPct > 0) {
        out.rows.push({ icon: 'fa-coins', text: '+' + perks.missionTokenBonusPct + '% de tokens en misiones' });
      }
      if (perks.extraMissionSlots > 0) {
        out.rows.push({
          icon: 'fa-users',
          text: '+' + perks.extraMissionSlots + ' hueco' +
            (perks.extraMissionSlots > 1 ? 's' : '') + ' al crear misiones'
        });
      }
      (perks.access || []).forEach(function (key) {
        if (ACCESS_LABELS[key]) out.access.push(ACCESS_LABELS[key]);
      });
    }

    var boost = boostInfo();
    if (boost) {
      out.rows.push({ icon: 'fa-rocket', text: 'Boost ×' + boost.mult + ' activo (' + boost.mins + ' min)' });
    }
    if (!out.rows.length && !out.access.length) {
      out.rows.push({ icon: 'fa-seedling', text: 'Sube al nivel 10 para estrenar beneficios' });
    }
    return out;
  }

  /** HTML del panel del chip. Función pura. */
  function buildPanelHtml(prog) {
    if (!prog) {
      return '<p class="sg-nexus-panel-empty">Todavía no hay datos de tu nivel.</p>';
    }
    var next = nextRewardText(prog.level);
    var benefits = benefitsFor(prog);
    var rowsHtml = benefits.rows.map(function (b) {
      return '<li><i class="fas ' + esc(b.icon) + '"></i><span>' + esc(b.text) + '</span></li>';
    }).join('');
    var accessHtml = benefits.access.length
      ? '<p class="sg-nexus-panel-title">Accesos desbloqueados</p>' +
        '<div class="sg-nexus-panel-keys">' +
          benefits.access.map(function (label) {
            return '<span class="sg-nexus-panel-key"><i class="fas fa-key"></i>' + esc(label) + '</span>';
          }).join('') +
        '</div>'
      : '';

    return '' +
      '<div class="sg-nexus-panel-head">' +
        '<span class="sg-nexus-panel-num">' + prog.level + '</span>' +
        '<span class="sg-nexus-panel-heading">' +
          '<span class="sg-nexus-panel-level">Nivel ' + prog.level + '</span>' +
          '<span class="sg-nexus-panel-tier">' + esc(prog.tierName) + '</span>' +
        '</span>' +
      '</div>' +
      (prog.accessName ? '<p class="sg-nexus-panel-access">' + esc(prog.accessName) + '</p>' : '') +
      barHtml(prog.pct, prog.color) +
      '<p class="sg-nexus-panel-line">' +
        (prog.maxed
          ? fmt(prog.xp) + ' EXP · tope del Nexo'
          : fmt(prog.xp) + ' EXP · faltan ' + fmt(prog.remaining) + ' para el nivel ' + prog.nextLevel) +
      '</p>' +
      '<p class="sg-nexus-panel-title">Tus beneficios</p>' +
      '<ul class="sg-nexus-panel-perks">' + rowsHtml + '</ul>' +
      accessHtml +
      (next ? '<p class="sg-nexus-panel-line sg-nexus-panel-next">' + esc(next) + '</p>' : '') +
      '<a class="sg-nexus-panel-link" href="' + NEXUS_URL + '">Ir a Nexus</a>';
  }

  function closePanel() {
    var panel = state.panelEl;
    if (panel && panel.classList) panel.classList.remove('is-open');
    state.panelOpen = false;
    if (state.chipEl && state.chipEl.setAttribute) state.chipEl.setAttribute('aria-expanded', 'false');
  }

  function openPanel() {
    if (!state.chipEl) return;
    var panel = state.panelEl;
    if (!panel) return;
    panel.innerHTML = buildPanelHtml(progressFor(currentXp()));
    if (panel.classList) panel.classList.add('is-open');
    state.panelOpen = true;
    if (state.chipEl.setAttribute) state.chipEl.setAttribute('aria-expanded', 'true');
  }

  function togglePanel() {
    if (state.panelOpen) closePanel();
    else openPanel();
  }

  /**
   * Punto de anclaje: la cabecera unificada de las seis páginas cuelga sus
   * botones de .header-actions y mete la campana en .header-notifications-wrap
   * (lo montan shared-unified-header.js y el propio HTML). El chip se cuela
   * justo antes de la campana. Si esa cabecera no existe en alguna página, no
   * se inyecta nada y el resto del sensor sigue funcionando.
   */
  function chipAnchor() {
    if (typeof document.querySelector !== 'function') return null;
    var actions = document.querySelector('.unified-header .header-actions') ||
      document.querySelector('.header-actions');
    if (actions) {
      var wrap = typeof actions.querySelector === 'function'
        ? actions.querySelector('.header-notifications-wrap') : null;
      return { parent: actions, before: wrap };
    }
    var bell = document.getElementById('notificationsToggleBtn');
    if (bell) {
      var host = (bell.closest && bell.closest('.header-notifications-wrap')) || bell;
      if (host && host.parentNode) return { parent: host.parentNode, before: host };
    }
    return null;
  }

  function ensureChip() {
    if (state.chipEl) return state.chipEl;
    if (state.chipInjected) return null;
    var anchor = chipAnchor();
    if (!anchor) return null;

    var wrap = document.createElement('div');
    wrap.className = 'sg-nexus-chip-wrap';
    // El botón enseña solo el nivel: el detalle vive en el panel de debajo.
    wrap.innerHTML = '' +
      '<button type="button" class="sg-nexus-chip" id="sgNexusChip" aria-haspopup="true" aria-expanded="false" ' +
        'aria-label="Tu nivel de Nexus">' +
        '<span class="sg-nexus-chip-badge" data-sg-nexus-badge="1">' +
          '<span class="sg-nexus-chip-fallback">1</span>' +
        '</span>' +
      '</button>' +
      '<div class="sg-nexus-panel" id="sgNexusChipPanel" role="dialog" aria-label="Tu nivel de Nexus"></div>';

    if (anchor.before && anchor.parent.insertBefore) anchor.parent.insertBefore(wrap, anchor.before);
    else anchor.parent.appendChild(wrap);
    state.chipInjected = true;

    state.chipEl = typeof wrap.querySelector === 'function' ? wrap.querySelector('.sg-nexus-chip') : null;
    state.panelEl = typeof wrap.querySelector === 'function' ? wrap.querySelector('.sg-nexus-panel') : null;
    bindChipEvents(wrap);
    renderChip();
    return state.chipEl;
  }

  /**
   * El panel se abre al pasar el cursor por encima (con un margen para que no
   * se cierre al viajar del botón al panel) y también con clic y con el teclado,
   * que es lo que queda en pantallas táctiles.
   */
  function bindChipEvents(wrap) {
    if (!wrap || !wrap.addEventListener || !state.chipEl) return;

    wrap.addEventListener('mouseenter', function () {
      clearTimeout(state.panelTimer);
      openPanel();
    });
    wrap.addEventListener('mouseleave', function () {
      clearTimeout(state.panelTimer);
      state.panelTimer = setTimeout(closePanel, 220);
    });

    state.chipEl.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      clearTimeout(state.panelTimer);
      togglePanel();
    });
    state.chipEl.addEventListener('focus', openPanel);
    wrap.addEventListener('keydown', function (e) {
      if (e && (e.key === 'Escape' || e.keyCode === 27)) closePanel();
    });

    if (document.addEventListener) {
      document.addEventListener('click', function (e) {
        if (!state.panelOpen) return;
        var t = e && e.target;
        if (t && t.closest && (t.closest('#sgNexusChipPanel') || t.closest('#sgNexusChip'))) return;
        closePanel();
      });
    }
  }

  function renderChip() {
    if (!state.chipEl) return;
    var prog = progressFor(currentXp());
    var level = prog ? prog.level : currentLevel();
    if (typeof state.chipEl.querySelector === 'function') {
      var fallback = state.chipEl.querySelector('.sg-nexus-chip-fallback');
      if (fallback) fallback.textContent = String(level);
      var holder = state.chipEl.querySelector('[data-sg-nexus-badge]');
      // SGLevelBadge puede cargar después que este script: se intenta en cada
      // refresco y, mientras no esté, se ve el número en texto.
      // El aviso propio de la insignia va apagado porque aquí manda el panel.
      if (holder) {
        var badge = window.SGLevelBadge;
        if (badge && typeof badge.update === 'function' && holder.getAttribute &&
            holder.getAttribute('data-sg-nexus-painted') === '1') {
          try { badge.update(holder, { xp: prog ? prog.xp : null, level: level }); } catch (e) {}
        } else if (badge && typeof badge.render === 'function') {
          paintBadge(holder, {
            xp: prog ? prog.xp : null, level: level,
            size: 'sm', showBar: false, showTier: false, showTooltip: false
          });
          if (holder.setAttribute) holder.setAttribute('data-sg-nexus-painted', '1');
        }
      }
      if (state.chipEl.setAttribute) {
        state.chipEl.setAttribute('aria-label',
          'Nivel ' + level + (prog && prog.tierName ? ' · ' + prog.tierName : ''));
      }
    }
    // El color va en el envoltorio para que lo hereden el botón y el panel.
    var wrap = state.chipEl.parentNode;
    if (prog && wrap && wrap.style && wrap.style.setProperty) {
      wrap.style.setProperty('--sg-nexus-tier', prog.color);
    }
    if (state.panelOpen && state.panelEl) {
      state.panelEl.innerHTML = buildPanelHtml(prog);
    }
  }

  /** La cabecera la montan otros scripts: se reintenta un rato antes de rendirse. */
  function scheduleChip() {
    if (ensureChip()) return;
    var timer = setInterval(function () {
      state.chipTries += 1;
      if (ensureChip() || state.chipTries >= 40) clearInterval(timer);
    }, 250);
    if (timer && timer.unref) timer.unref();
  }

  // ---------------------------------------------------------------------------
  // Escucha en Firebase
  // ---------------------------------------------------------------------------

  function track(ref, event, handler) {
    state.refs.push({ ref: ref, event: event, handler: handler });
  }

  function detach() {
    state.refs.forEach(function (entry) {
      try { entry.ref.off(entry.event, entry.handler); } catch (e) {}
    });
    state.refs = [];
    state.attached = false;
    state.uid = null;
    state.stats = null;
    state.boost = null;
    closeGroup();
  }

  function attach(uid) {
    var db = getDb();
    if (!db || !uid) return;
    if (state.attached && state.uid === uid) return;
    detach();
    state.attached = true;
    state.uid = uid;
    state.mountAt = Date.now();

    // Memoria de avisos: se poda al cargar para que no crezca sin límite.
    state.xpToasted = loadJson(xpToastedKey());
    var cut = Date.now() - TOAST_MEMORY_MS;
    Object.keys(state.xpToasted).forEach(function (k) {
      if (!(parseTime(state.xpToasted[k]) > cut)) delete state.xpToasted[k];
    });
    saveJson(xpToastedKey(), state.xpToasted);
    state.celebrated = loadJson(celebratedKey());

    var base = 'nexus/users/' + uid + '/';

    var statsRef = db.ref(base + 'stats');
    var statsHandler = statsRef.on('value', function (snap) {
      state.stats = snap.val() || {};
      renderChip();
    }, function () {});
    track(statsRef, 'value', statsHandler);

    var boostRef = db.ref(base + 'xpBoost');
    var boostHandler = boostRef.on('value', function (snap) {
      state.boost = snap.val() || null;
      if (state.panelOpen) openPanel();
    }, function () {});
    track(boostRef, 'value', boostHandler);

    var ledgerRef = db.ref(base + 'xpLedger').limitToLast(LEDGER_TAIL);
    var ledgerHandler = ledgerRef.on('child_added', function (snap) {
      handleXpGrant(snap.key, snap.val());
    }, function () {});
    track(ledgerRef, 'child_added', ledgerHandler);

    var levelUpsRef = db.ref(base + 'levelUps').limitToLast(LEVELUP_TAIL);
    var levelUpsHandler = levelUpsRef.on('child_added', function (snap) {
      handleLevelUp(snap.key, snap.val());
    }, function () {});
    track(levelUpsRef, 'child_added', levelUpsHandler);
  }

  function bindAuthWhenReady() {
    try {
      if (typeof firebase === 'undefined' || !firebase.auth) return false;
      if (!firebase.apps || !firebase.apps.length) return false;
      if (state.authBound) return true;
      state.authBound = true;
      firebase.auth().onAuthStateChanged(function (user) {
        if (!user) { detach(); return; }
        attach(user.uid);
      });
      return true;
    } catch (e) {
      state.authBound = false;
      return false;
    }
  }

  function scheduleAuthBind() {
    if (bindAuthWhenReady()) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (bindAuthWhenReady() || tries >= 60) clearInterval(timer);
    }, 100);
    // unref no existe en el navegador; en Node evita que el proceso quede vivo
    // cuando el módulo se prueba fuera del sitio.
    if (timer && timer.unref) timer.unref();
  }

  var booted = false;

  /** Arranque idempotente: llamarlo dos veces no duplica nada. */
  function init() {
    if (booted) return;
    if (!document || !document.createElement) return;
    booted = true;
    window.SGNexusSensor.booted = true;
    scheduleChip();
    scheduleAuthBind();
    watchTierAnimations();
    watchCharacterCamera();
  }

  window.SGNexusSensor = {
    version: VERSION,
    booted: false,
    init: init,
    // Estado y utilidades públicas (las usa el panel y las pruebas).
    getState: function () {
      return { uid: state.uid, stats: state.stats, boost: state.boost, page: pageKey() };
    },
    isNexusPage: isNexusPage,
    labelForAction: labelForAction,
    openPanel: openPanel,
    closePanel: closePanel,
    refreshChip: renderChip,
    ensureChip: ensureChip,
    // Inyección manual de eventos: así se prueba la lógica sin Firebase y así
    // podría cualquier página anunciar EXP que ya conozca.
    handleXpGrant: handleXpGrant,
    handleLevelUp: handleLevelUp,
    showXpToast: showXpToast,
    closeXpToast: closeGroup,
    closeLevelOverlay: closeLevelOverlay,
    // Editor avanzado del Commander Panel: lanza el overlay real con
    // cualquier nivel/personaje/animación/texto/recompensas de prueba.
    previewLevelOverlay: previewLevelOverlay,
    // Bienvenida al torneo: mismo escenario que la subida de tramo, con la
    // wyvern y el código de conducta. La página que lo llama decide si ya se vio.
    showTournamentRules: showTournamentRules,
    buildTournamentRulesHtml: buildTournamentRulesHtml,
    tournamentRules: TOURNAMENT_RULES,
    // Constructores de HTML: puros, sin tocar el DOM.
    buildXpToastHtml: buildXpToastHtml,
    buildLevelToastHtml: buildLevelToastHtml,
    buildLevelOverlayHtml: buildLevelOverlayHtml,
    buildPanelHtml: buildPanelHtml,
    escapeText: esc,
    // Ganchos de prueba: mueven el reloj de montaje y la memoria local.
    setMountAt: function (ts) { state.mountAt = parseTime(ts) || Date.now(); },
    setUid: function (uid) {
      state.uid = uid || null;
      state.xpToasted = loadJson(xpToastedKey());
      state.celebrated = loadJson(celebratedKey());
    },
    setStats: function (stats) { state.stats = stats || null; renderChip(); },
    // Usados por la pestaña "Notificaciones" del Commander Panel para saber
    // qué animación le toca a cada tramo (por defecto y la personalizada) sin
    // duplicar el mapa fijo ni la ruta de la base de datos en dos archivos.
    tierAnimationPath: TIER_ANIM_PATH,
    defaultTierAnimation: defaultTierAnimation,
    tierAnimationFor: pickCharacter,
    // Ruta de la calibración de cámara por personaje (ángulo/tamaño), para
    // que el editor del Commander Panel guarde/borre en el mismo sitio que
    // lee watchCharacterCamera() sin repetir el nombre del nodo en dos archivos.
    characterCameraPath: CHARACTER_CAM_PATH,
    // Tipos de recompensa que sabe dibujar buildRewardsHtml (editor avanzado
    // del Commander Panel), para no repetir la lista a mano en otro archivo.
    rewardKinds: REWARD_KINDS
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
