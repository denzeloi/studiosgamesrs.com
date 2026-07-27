window.SGProfileCustomizationConfig = {
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
  freeUnlockIds: ['default', 'nexus-ember']
};
