/**
 * Emblema de equipo: uno solo para todo el sitio.
 *
 * Hasta ahora cada zona ponía lo suyo cuando un equipo no había subido foto: el
 * Competition Hub tiraba de placehold.co (un servicio de fuera, que si se cae
 * deja cuadros rotos), el Dashboard ponía el dragón del perfil, el War Room un
 * escudo gris y en el cuadro de partidos no salía nada. Ahora todos enseñan la
 * misma imagen de la casa.
 *
 * Uso:
 *   img.src = SGTeamEmblem.urlFor(team);      // equipo entero o la url suelta
 *   SGTeamEmblem.bind(img, team);             // además cubre el fallo de carga
 *   html += SGTeamEmblem.imgTag(team, 'clase');
 */
(function (global) {
  'use strict';

  var DEFAULT_EMBLEM = '/team-default-emblem.jpg';
  var DEFAULT_EMBLEM_SMALL = '/team-default-emblem-small.jpg';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * La url guardada, si la hay y es utilizable.
   *
   * Se aceptan el equipo entero o la url suelta, porque cada zona tiene el dato
   * de una forma: unos leen teams/{id} completo y otros solo se guardaron el
   * enlace en la invitación. También se descartan los placeholders viejos, que
   * están escritos en la base de datos de algunos equipos.
   */
  function storedUrl(source) {
    var raw = '';
    if (typeof source === 'string') raw = source;
    else if (source && typeof source === 'object') {
      raw = source.emblemUrl || source.teamEmblem || source.emblem || '';
    }
    raw = String(raw || '').trim();
    if (!raw) return '';
    if (raw.indexOf('placehold.co') !== -1) return '';
    if (raw.indexOf('dragon_profile_studiosgamesrs') !== -1) return '';
    return raw;
  }

  function urlFor(source, opts) {
    var stored = storedUrl(source);
    if (stored) return stored;
    return (opts && opts.small) ? DEFAULT_EMBLEM_SMALL : DEFAULT_EMBLEM;
  }

  /** Si la url guardada da error (archivo borrado del bucket), cae al de casa. */
  function bind(img, source, opts) {
    if (!img) return img;
    var fallback = (opts && opts.small) ? DEFAULT_EMBLEM_SMALL : DEFAULT_EMBLEM;
    img.onerror = function () {
      if (img.src.indexOf(fallback) !== -1) return;
      img.onerror = null;
      img.src = fallback;
    };
    img.src = urlFor(source, opts);
    return img;
  }

  function imgTag(source, className, opts) {
    var fallback = (opts && opts.small) ? DEFAULT_EMBLEM_SMALL : DEFAULT_EMBLEM;
    var alt = (opts && opts.alt) || 'Emblema del equipo';
    return '<img src="' + esc(urlFor(source, opts)) + '"' +
      (className ? ' class="' + esc(className) + '"' : '') +
      ' alt="' + esc(alt) + '" loading="lazy"' +
      ' onerror="this.onerror=null;this.src=\'' + fallback + '\';">';
  }

  global.SGTeamEmblem = {
    DEFAULT: DEFAULT_EMBLEM,
    DEFAULT_SMALL: DEFAULT_EMBLEM_SMALL,
    urlFor: urlFor,
    bind: bind,
    imgTag: imgTag,
    hasOwn: function (source) { return !!storedUrl(source); },
  };
})(typeof window !== 'undefined' ? window : this);
