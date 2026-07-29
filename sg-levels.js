/**
 * Tabla única de niveles Nexus (1–100).
 *
 * Este archivo es la fuente de verdad de la curva, los tramos, las recompensas
 * y los beneficios. Se carga en el navegador (window.SGLevels) y también se
 * require() desde las Cloud Functions, así que existe una copia idéntica en
 * functions/sg-levels.js: tools/verify-site-assets.js aborta el despliegue si
 * las dos copias dejan de coincidir. Antes había dos tablas separadas
 * (NEXUS_RANK_XP en functions y CONFIG.xp.ranks en nexus-logic.js) más una
 * tercera inventada en el widget del dashboard, y ya discrepaban entre sí.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SGLevels = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  var MAX_LEVEL = 100;

  /**
   * Niveles 1–5: los umbrales históricos, intactos. Cambiarlos haría que un
   * jugador bajara de nivel, así que se respetan tal cual estaban.
   */
  var LEGACY_XP = [0, 500, 1500, 3000, 6000];

  /**
   * Del 6 al 100 el coste por nivel sube una tanda cada decena, igual que la
   * curva de Steam. Índice = decena (0 → niveles 6–10, 1 → 11–20 … 9 → 91–100).
   */
  var STEP_BY_DECADE = [500, 800, 1200, 1600, 2000, 2600, 3200, 3800, 4400, 5000];

  /** XP acumulada necesaria para cada nivel. Índice = nivel - 1. */
  var THRESHOLDS = (function buildThresholds() {
    var list = LEGACY_XP.slice();
    for (var level = LEGACY_XP.length + 1; level <= MAX_LEVEL; level++) {
      var decade = Math.floor((level - 1) / 10);
      var step = STEP_BY_DECADE[Math.min(decade, STEP_BY_DECADE.length - 1)];
      list.push(list[level - 2] + step);
    }
    return list;
  })();

  /**
   * Diez tramos de diez niveles. Los cinco primeros nombres son los que ya
   * existían, para que nadie sienta que le degradaron el título.
   */
  var TIERS = [
    {
      index: 0, name: 'NOVATO', accessName: 'Acceso Básico', from: 1, to: 9,
      color: '#58a6ff', glow: 'rgba(88, 166, 255, 0.55)', icon: 'fa-seedling',
      tagline: 'Explora el Nexus y gana EXP con todo lo que haces en la web'
    },
    {
      index: 1, name: 'CREADOR', accessName: 'Creador Activo', from: 10, to: 19,
      color: '#a371f7', glow: 'rgba(163, 113, 247, 0.55)', icon: 'fa-palette',
      tagline: 'Diseña contenido y desbloquea tu primera personalización'
    },
    {
      index: 2, name: 'PROMOTOR', accessName: 'Promotor SGRS', from: 20, to: 29,
      color: '#f778ba', glow: 'rgba(247, 120, 186, 0.55)', icon: 'fa-bullhorn',
      tagline: 'Tu voz mueve la comunidad y el Nexus te lo paga'
    },
    {
      index: 3, name: 'INFLUENCER', accessName: 'Influencer Nexus', from: 30, to: 39,
      color: '#e3b341', glow: 'rgba(227, 179, 65, 0.55)', icon: 'fa-shield-halved',
      tagline: 'Mercado Técnico, soporte prioritario y marco propio'
    },
    {
      index: 4, name: 'EMBAJADOR', accessName: 'Embajador Élite', from: 40, to: 49,
      color: '#3fb950', glow: 'rgba(63, 185, 80, 0.55)', icon: 'fa-crown',
      tagline: 'Representas a StudiosGamesRS dentro y fuera de la web'
    },
    {
      index: 5, name: 'VETERANO', accessName: 'Veterano del Nexo', from: 50, to: 59,
      color: '#2dd4bf', glow: 'rgba(45, 212, 191, 0.55)', icon: 'fa-medal',
      tagline: 'Mitad del camino: el Nexo ya te reconoce por tu nombre'
    },
    {
      index: 6, name: 'ÉLITE', accessName: 'Élite Operativa', from: 60, to: 69,
      color: '#ff7b3d', glow: 'rgba(255, 123, 61, 0.55)', icon: 'fa-fire-flame-curved',
      tagline: 'Acceso a la sala VIP y prioridad en los eventos'
    },
    {
      index: 7, name: 'LEYENDA', accessName: 'Leyenda Viva', from: 70, to: 79,
      color: '#ff4d6d', glow: 'rgba(255, 77, 109, 0.6)', icon: 'fa-dragon',
      tagline: 'Prioridad en torneos y presencia destacada en la comunidad'
    },
    {
      index: 8, name: 'MÍTICO', accessName: 'Rango Mítico', from: 80, to: 89,
      color: '#b48cff', glow: 'rgba(180, 140, 255, 0.65)', icon: 'fa-hat-wizard',
      tagline: 'Título propio y cosméticos que casi nadie verá de cerca'
    },
    {
      index: 9, name: 'ETERNO', accessName: 'Eterno del Nexo', from: 90, to: 100,
      color: '#f2f4ff', glow: 'rgba(210, 220, 255, 0.75)', icon: 'fa-infinity',
      tagline: 'El techo del Nexo: todo desbloqueado y sitio en el salón de la fama'
    }
  ];

  /**
   * Beneficios por tramo. Los porcentajes que afectan a la economía se aplican
   * en el servidor; los de acceso se comprueban donde toque.
   *
   * El bono de EXP del tramo 1 arranca en +22% porque el suelo histórico ya
   * daba +20% con 6.000 XP: si empezara más abajo, subir al nivel 10 se
   * sentiría como un castigo para quien venía del sistema viejo.
   */
  var TIER_PERKS = [
    { xpBonusPct: 0, missionTokenBonusPct: 0, extraMissionSlots: 0, access: [] },
    { xpBonusPct: 22, missionTokenBonusPct: 0, extraMissionSlots: 0, access: ['profileCustomization'] },
    { xpBonusPct: 25, missionTokenBonusPct: 5, extraMissionSlots: 0, access: ['profileCustomization'] },
    { xpBonusPct: 28, missionTokenBonusPct: 5, extraMissionSlots: 1, access: ['profileCustomization', 'mercadoTecnico', 'prioritySupport'] },
    { xpBonusPct: 32, missionTokenBonusPct: 10, extraMissionSlots: 1, access: ['profileCustomization', 'mercadoTecnico', 'prioritySupport', 'betaAccess'] },
    { xpBonusPct: 36, missionTokenBonusPct: 10, extraMissionSlots: 1, access: ['profileCustomization', 'mercadoTecnico', 'prioritySupport', 'betaAccess'] },
    { xpBonusPct: 40, missionTokenBonusPct: 15, extraMissionSlots: 2, access: ['profileCustomization', 'mercadoTecnico', 'prioritySupport', 'betaAccess', 'vipLounge'] },
    { xpBonusPct: 44, missionTokenBonusPct: 20, extraMissionSlots: 2, access: ['profileCustomization', 'mercadoTecnico', 'prioritySupport', 'betaAccess', 'vipLounge', 'tournamentPriority'] },
    { xpBonusPct: 48, missionTokenBonusPct: 25, extraMissionSlots: 3, access: ['profileCustomization', 'mercadoTecnico', 'prioritySupport', 'betaAccess', 'vipLounge', 'tournamentPriority', 'customTitle'] },
    { xpBonusPct: 55, missionTokenBonusPct: 30, extraMissionSlots: 3, access: ['profileCustomization', 'mercadoTecnico', 'prioritySupport', 'betaAccess', 'vipLounge', 'tournamentPriority', 'customTitle', 'hallOfFame'] }
  ];

  /**
   * Marco y fondo que estrena cada tramo. Son cosméticos de CSS puro (no PNG),
   * así que aparecen al instante y no dependen de Storage.
   */
  var TIER_COSMETICS = [
    { frame: null, frameName: null, background: 'nexus-bg-novato', backgroundName: 'Amanecer Novato' },
    { frame: 'nexus-tier-creador', frameName: 'Marco Creador', background: 'nexus-bg-creador', backgroundName: 'Taller Violeta' },
    { frame: 'nexus-tier-promotor', frameName: 'Marco Promotor', background: 'nexus-bg-promotor', backgroundName: 'Señal Magenta' },
    { frame: 'nexus-tier-influencer', frameName: 'Marco Influencer', background: 'nexus-bg-influencer', backgroundName: 'Cúpula Dorada' },
    { frame: 'nexus-tier-embajador', frameName: 'Marco Embajador', background: 'nexus-bg-embajador', backgroundName: 'Jardín Esmeralda' },
    { frame: 'nexus-tier-veterano', frameName: 'Marco Veterano', background: 'nexus-bg-veterano', backgroundName: 'Acero del Nexo' },
    { frame: 'nexus-tier-elite', frameName: 'Marco Élite', background: 'nexus-bg-elite', backgroundName: 'Forja Ardiente' },
    { frame: 'nexus-tier-leyenda', frameName: 'Marco Leyenda', background: 'nexus-bg-leyenda', backgroundName: 'Cielo Carmesí' },
    { frame: 'nexus-tier-mitico', frameName: 'Marco Mítico', background: 'nexus-bg-mitico', backgroundName: 'Nebulosa Mítica' },
    { frame: 'nexus-tier-eterno', frameName: 'Marco Eterno', background: 'nexus-bg-eterno', backgroundName: 'Vacío Prismático' }
  ];

  /**
   * El nivel 100 no repite el cosmético del tramo ETERNO (que ya se entrega al
   * 90): estrena pieza propia, porque es el único premio irrepetible del juego.
   */
  var LEVEL_100_COSMETICS = {
    frame: 'nexus-lv100-soberano', frameName: 'Marco Soberano del Nexo',
    background: 'nexus-bg-soberano', backgroundName: 'Trono del Nexo',
    badge: 'lv100_soberano', badgeName: 'Soberano del Nexo'
  };

  /** Tokens que entrega cada nivel que acaba en 5, y el gran premio del 100. */
  var TOKEN_MILESTONES = {
    5: 5, 15: 10, 25: 15, 35: 20, 45: 25,
    55: 30, 65: 40, 75: 50, 85: 60, 95: 75, 100: 150
  };

  function clampLevel(level) {
    var n = Math.floor(Number(level) || 1);
    if (n < 1) return 1;
    if (n > MAX_LEVEL) return MAX_LEVEL;
    return n;
  }

  /** XP acumulada que hace falta para alcanzar un nivel. */
  function xpForLevel(level) {
    return THRESHOLDS[clampLevel(level) - 1];
  }

  /** Nivel que corresponde a una cantidad de XP. */
  function levelFromXp(xp) {
    var total = Math.max(0, Math.floor(Number(xp) || 0));
    // Búsqueda desde arriba: el caso común es un jugador de nivel bajo, pero la
    // tabla tiene 100 entradas y recorrerla entera no cuesta nada.
    for (var level = MAX_LEVEL; level >= 1; level--) {
      if (total >= THRESHOLDS[level - 1]) return level;
    }
    return 1;
  }

  /** Índice de tramo (0–9) de un nivel. El tramo 0 abarca los niveles 1–9. */
  function tierIndexForLevel(level) {
    return Math.min(TIERS.length - 1, Math.floor(clampLevel(level) / 10));
  }

  function tierForLevel(level) {
    return TIERS[tierIndexForLevel(level)];
  }

  /**
   * Multiplicador histórico: la tabla vieja daba +5% por cada uno de los cinco
   * escalones, hasta +20% con 6.000 XP. Se conserva como suelo para que nadie
   * gane menos XP que antes del cambio de curva.
   */
  function legacyXpBonusPct(xp) {
    var total = Math.max(0, Math.floor(Number(xp) || 0));
    var steps = 0;
    for (var i = LEGACY_XP.length - 1; i >= 0; i--) {
      if (total >= LEGACY_XP[i]) { steps = i; break; }
    }
    return steps * 5;
  }

  /** Porcentaje extra de XP que le toca a un jugador. */
  function xpBonusPct(level, xp) {
    var tierPct = TIER_PERKS[tierIndexForLevel(level)].xpBonusPct;
    return Math.max(tierPct, legacyXpBonusPct(xp));
  }

  function xpMultiplier(level, xp) {
    return 1 + (xpBonusPct(level, xp) / 100);
  }

  function perksForLevel(level) {
    return TIER_PERKS[tierIndexForLevel(level)];
  }

  function hasAccess(level, accessKey) {
    return perksForLevel(level).access.indexOf(accessKey) !== -1;
  }

  /** Progreso dentro del nivel actual, listo para pintar la barra. */
  function progress(xp) {
    var total = Math.max(0, Math.floor(Number(xp) || 0));
    var level = levelFromXp(total);
    var tier = tierForLevel(level);
    var currentFloor = xpForLevel(level);
    if (level >= MAX_LEVEL) {
      return {
        xp: total, level: MAX_LEVEL, tier: tier, tierIndex: tier.index,
        maxed: true, intoLevel: 0, levelSpan: 0, remaining: 0, pct: 100,
        nextLevel: null, nextLevelXp: null
      };
    }
    var nextFloor = xpForLevel(level + 1);
    var span = nextFloor - currentFloor;
    var into = total - currentFloor;
    return {
      xp: total, level: level, tier: tier, tierIndex: tier.index,
      maxed: false, intoLevel: into, levelSpan: span,
      remaining: nextFloor - total,
      pct: span > 0 ? Math.min(100, Math.max(0, (into / span) * 100)) : 0,
      nextLevel: level + 1, nextLevelXp: nextFloor
    };
  }

  /**
   * Recompensas exactas de un nivel. Los tramos (10, 20, 30…) estrenan marco,
   * fondo e insignia; los niveles que acaban en 5 pagan tokens.
   */
  function rewardsForLevel(level) {
    var n = clampLevel(level);
    var list = [];
    var isTierStart = n % 10 === 0 || n === 1;
    var tierIdx = n === 1 ? 0 : tierIndexForLevel(n);

    if (n === MAX_LEVEL) {
      list.push({
        type: 'frame', id: LEVEL_100_COSMETICS.frame, name: LEVEL_100_COSMETICS.frameName,
        description: 'Marco irrepetible del nivel ' + MAX_LEVEL
      });
      list.push({
        type: 'background', id: LEVEL_100_COSMETICS.background, name: LEVEL_100_COSMETICS.backgroundName,
        description: 'Fondo irrepetible del nivel ' + MAX_LEVEL
      });
      list.push({
        type: 'badge', id: LEVEL_100_COSMETICS.badge, name: 'Insignia ' + LEVEL_100_COSMETICS.badgeName,
        description: 'Solo la lleva quien tocó el techo del Nexo'
      });
      list.push({
        type: 'tokens', id: 'tokens_lv' + MAX_LEVEL, amount: TOKEN_MILESTONES[MAX_LEVEL],
        name: TOKEN_MILESTONES[MAX_LEVEL] + ' tokens',
        description: 'Recompensa final del nivel ' + MAX_LEVEL
      });
      return list;
    }

    if (isTierStart) {
      var tier = TIERS[tierIdx];
      var cosmetics = TIER_COSMETICS[tierIdx];
      if (cosmetics.frame) {
        list.push({
          type: 'frame', id: cosmetics.frame, name: cosmetics.frameName,
          description: 'Marco de avatar del tramo ' + tier.name
        });
      }
      if (cosmetics.background) {
        list.push({
          type: 'background', id: cosmetics.background, name: cosmetics.backgroundName,
          description: 'Fondo de perfil del tramo ' + tier.name
        });
      }
      list.push({
        type: 'badge', id: 'tier_' + tier.name.toLowerCase().replace(/[^a-z]/g, ''),
        name: 'Insignia ' + tier.name,
        description: 'Acreditación de ' + tier.accessName
      });
      var perks = TIER_PERKS[tierIdx];
      list.push({
        type: 'perk', id: 'perks_tier_' + tierIdx,
        name: '+' + perks.xpBonusPct + '% EXP',
        description: perks.missionTokenBonusPct
          ? '+' + perks.xpBonusPct + '% EXP y +' + perks.missionTokenBonusPct + '% tokens en misiones'
          : '+' + perks.xpBonusPct + '% EXP en todo lo que hagas'
      });
    }

    if (TOKEN_MILESTONES[n]) {
      list.push({
        type: 'tokens', id: 'tokens_lv' + n, amount: TOKEN_MILESTONES[n],
        name: TOKEN_MILESTONES[n] + ' tokens',
        description: 'Recompensa en tokens del nivel ' + n
      });
    }

    return list;
  }

  /** Siguiente nivel (desde el actual) que trae algo que enseñar. */
  function nextRewardLevel(level) {
    for (var n = clampLevel(level) + 1; n <= MAX_LEVEL; n++) {
      if (rewardsForLevel(n).length) return n;
    }
    return null;
  }

  /** Todo lo desbloqueado hasta un nivel, para sembrar inventarios. */
  function unlocksUpTo(level) {
    var frames = [];
    var backgrounds = [];
    var badges = [];
    for (var n = 1; n <= clampLevel(level); n++) {
      rewardsForLevel(n).forEach(function (reward) {
        if (reward.type === 'frame') frames.push(reward.id);
        else if (reward.type === 'background') backgrounds.push(reward.id);
        else if (reward.type === 'badge') badges.push(reward.id);
      });
    }
    return { frames: frames, backgrounds: backgrounds, badges: badges };
  }

  return {
    MAX_LEVEL: MAX_LEVEL,
    THRESHOLDS: THRESHOLDS,
    TIERS: TIERS,
    TIER_PERKS: TIER_PERKS,
    TIER_COSMETICS: TIER_COSMETICS,
    TOKEN_MILESTONES: TOKEN_MILESTONES,
    xpForLevel: xpForLevel,
    levelFromXp: levelFromXp,
    tierIndexForLevel: tierIndexForLevel,
    tierForLevel: tierForLevel,
    xpBonusPct: xpBonusPct,
    xpMultiplier: xpMultiplier,
    legacyXpBonusPct: legacyXpBonusPct,
    perksForLevel: perksForLevel,
    hasAccess: hasAccess,
    progress: progress,
    rewardsForLevel: rewardsForLevel,
    nextRewardLevel: nextRewardLevel,
    unlocksUpTo: unlocksUpTo
  };
});
