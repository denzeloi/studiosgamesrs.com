/**
 * Mini mapa Creator Market — resalta países con datos agregados de Meta (no GPS individual).
 */
(function (global) {
  'use strict';

  var COUNTRY_COORDS = {
    US: { x: 22, y: 38 }, CA: { x: 20, y: 28 }, MX: { x: 18, y: 48 },
    BR: { x: 34, y: 68 }, AR: { x: 32, y: 82 }, CO: { x: 28, y: 58 },
    ES: { x: 46, y: 42 }, FR: { x: 48, y: 36 }, DE: { x: 50, y: 34 },
    GB: { x: 46, y: 32 }, IT: { x: 50, y: 40 }, PT: { x: 44, y: 42 },
    RU: { x: 62, y: 28 }, IN: { x: 68, y: 48 }, CN: { x: 74, y: 40 },
    JP: { x: 82, y: 42 }, KR: { x: 80, y: 44 }, AU: { x: 82, y: 72 },
    PH: { x: 78, y: 52 }, ID: { x: 76, y: 58 }, VE: { x: 30, y: 54 },
    CL: { x: 30, y: 78 }, PE: { x: 28, y: 64 }, DO: { x: 29, y: 50 },
    PR: { x: 30, y: 48 }, EC: { x: 26, y: 58 }, GT: { x: 20, y: 52 }
  };

  function normalizeGeo(geoByCountry) {
    if (!geoByCountry || typeof geoByCountry !== 'object') return [];
    return Object.keys(geoByCountry).map(function (code) {
      return { code: code.toUpperCase(), views: Number(geoByCountry[code]) || 0 };
    }).filter(function (c) { return c.views > 0; })
      .sort(function (a, b) { return b.views - a.views; });
  }

  function renderGeoMap(container, geoByCountry) {
    if (!container) return;
    var countries = normalizeGeo(geoByCountry);
    if (!countries.length) {
      container.innerHTML =
        '<div class="cm-geo-map-empty"><i class="fas fa-globe-americas"></i>' +
        '<span>Sin datos de país aún. Meta los entrega cuando hay suficientes vistas.</span></div>';
      return;
    }
    var max = countries[0].views || 1;
    var dots = countries.slice(0, 12).map(function (c) {
      var pos = COUNTRY_COORDS[c.code] || { x: 50, y: 50 };
      var intensity = Math.max(0.35, c.views / max);
      var size = 6 + Math.round(intensity * 10);
      return '<span class="cm-geo-dot" style="left:' + pos.x + '%;top:' + pos.y + '%;width:' + size + 'px;height:' + size + 'px;opacity:' + intensity + '" title="' + c.code + ': ' + c.views.toLocaleString() + '"></span>';
    }).join('');
    var list = countries.slice(0, 6).map(function (c) {
      return '<li><strong>' + c.code + '</strong> ' + c.views.toLocaleString() + ' vistas</li>';
    }).join('');
    container.innerHTML =
      '<div class="cm-geo-map-wrap">' +
        '<div class="cm-geo-map-bg"><div class="cm-geo-dots">' + dots + '</div></div>' +
        '<ul class="cm-geo-list">' + list + '</ul>' +
      '</div>' +
      '<p class="cm-geo-note">Datos agregados por país desde Facebook Insights (no ubicación exacta de cada persona).</p>';
  }

  global.CreatorMarketMap = { renderGeoMap: renderGeoMap, normalizeGeo: normalizeGeo };
})(window);
