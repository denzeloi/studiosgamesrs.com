/**
 * Configuración de marcos y fondos de perfil.
 *
 * Los cosméticos de nivel (10 marcos + 11 fondos) no se escriben a mano: se
 * derivan de SGLevels.rewardsForLevel(), que ya es la fuente de verdad de qué
 * suelta cada nivel. Así no hay una segunda lista que pueda discrepar con la
 * tabla de niveles ni con lo que entrega el servidor. Si sg-levels.js no está
 * cargado, la configuración se queda con los built-in históricos y el resto del
 * sistema sigue funcionando igual que antes.
 */
(function (global) {
  'use strict';

  var CONFIG = {
    defaultFrameLayout: 'wide',
    frameLayouts: {
      wide: { id: 'wide', label: 'Amplio (lados)', cssClass: 'frame-layout-wide' },
      standard: { id: 'standard', label: 'Estándar (anillo)', cssClass: 'frame-layout-standard' },
      ornate: { id: 'ornate', label: 'Ornamentado (máx. laterales)', cssClass: 'frame-layout-ornate' }
    },
    frameDesignGuide: {
      canvasPx: 1024,
      transparentCenterPx: 420,
      formats: 'PNG con transparencia (recomendado)',
      summary: 'Centro circular transparente de 420px exactos; el sistema escala el marco automáticamente para cubrir la foto y los lados.'
    },
    frameFit: {
      canvasPx: 1024,
      holePx: 420,
      avatarScale: 1.02,
      outerRatio: 1.19,
      wideRatio: 1.22,
      ornateRatio: 1.28,
      sizeScale: 0.5525
    },
    builtinFrames: {
      default: { id: 'default', name: 'Sin marco', cssClass: 'profile-frame-default', tokenCost: 0 },
      'nexus-ember': { id: 'nexus-ember', name: 'Nexus Ember', cssClass: 'profile-frame-nexus-ember', tokenCost: 0 },
      'dragon-guard': { id: 'dragon-guard', name: 'Dragon Guard', cssClass: 'profile-frame-dragon-guard', tokenCost: 25 },
      'golden-nexus': { id: 'golden-nexus', name: 'Golden Nexus', cssClass: 'profile-frame-golden-nexus', tokenCost: 50 }
    },
    builtinBackgrounds: {},
    freeUnlockIds: ['default', 'nexus-ember']
  };

  /**
   * Los tramos altos estrenan marcos más grandes: la proporción del hueco ya
   * existe en frameLayouts, solo hay que elegir cuál le toca a cada nivel.
   */
  function layoutForLevel(level) {
    if (level >= 70) return 'ornate';
    if (level >= 30) return 'wide';
    return 'standard';
  }

  var LEVELS = global.SGLevels;

  if (LEVELS && typeof LEVELS.rewardsForLevel === 'function') {
    for (var level = 1; level <= LEVELS.MAX_LEVEL; level++) {
      LEVELS.rewardsForLevel(level).forEach(registerCosmetic(level));
    }
  }

  function registerCosmetic(level) {
    var tier = LEVELS.tierForLevel(level);
    var label = 'Nivel ' + level + ' · ' + tier.name;

    return function (reward) {
      if (reward.type === 'frame') {
        CONFIG.builtinFrames[reward.id] = {
          id: reward.id,
          name: reward.name || reward.id,
          cssClass: 'profile-frame-' + reward.id,
          // El anillo se dibuja con CSS puro sobre el overlay que ya existe, y
          // la clase base es la que lleva la geometría en cada contexto.
          baseClass: 'sg-lvl-frame',
          cssRing: true,
          frameLayout: layoutForLevel(level),
          tokenCost: 0,
          source: 'level',
          unlockLevel: level,
          tierName: tier.name,
          unlockLabel: label
        };
        return;
      }
      if (reward.type === 'background') {
        CONFIG.builtinBackgrounds[reward.id] = {
          id: reward.id,
          name: reward.name || reward.id,
          cssClass: 'profile-bg-' + reward.id,
          baseClass: 'sg-lvl-bg',
          tokenCost: 0,
          source: 'level',
          unlockLevel: level,
          tierName: tier.name,
          unlockLabel: label
        };
      }
    };
  }

  global.SGProfileCustomizationConfig = CONFIG;
})(typeof window !== 'undefined' ? window : this);
