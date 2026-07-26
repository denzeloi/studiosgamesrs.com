/**
 * Creator Market — medidor de potencial + tendencias gaming (referencia)
 */
(function (global) {
  'use strict';

  var POWER_WORDS = [
    'clutch', 'épico', 'epico', 'insane', 'pro', 'ranked', 'competitivo', 'coop', 'cooperativo',
    'nuevo', 'update', 'parche', 'patch', 'meta', 'tips', 'guía', 'guia', 'truco', 'secret',
    'viral', 'highlight', 'momento', 'team', 'equipo', 'torneo', 'free', 'gratis', 'drop'
  ];

  var MARKETING_CTA = ['comenta', 'comparte', 'síguenos', 'siguenos', 'opina', 'qué opinas', 'que opinas', 'dime', 'vota'];

  var BASE_GAMING_TOPICS = [
    'Counter-Strike 2', 'CS2', 'Valorant', 'League of Legends', 'GTA', 'Minecraft',
    'indie games', 'co-op', 'speedrun', 'esports', 'PlayZone', 'StudiosGamesRS'
  ];

  var state = {
    trends: null,
    loading: false
  };

  function normalizeText(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function extractKeywords(text) {
    var words = normalizeText(text).split(/[^a-z0-9áéíóúüñ]+/i).filter(function (w) {
      return w.length >= 4;
    });
    return words;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function scorePublication(title, caption, trends) {
    var t = String(title || '').trim();
    var c = String(caption || '').trim();
    var nt = normalizeText(t);
    var nc = normalizeText(c);
    var score = 42;
    var tips = [];
    var breakdown = [];

    var trendKeywords = [];
    var trendTopics = [];
    if (trends) {
      trendKeywords = trends.keywords || [];
      trendTopics = trends.topics || [];
    }

    var len = t.length;
    if (len >= 35 && len <= 75) {
      score += 14;
      breakdown.push({ label: 'Título — longitud ideal', pts: 14 });
    } else if (len >= 20 && len < 35) {
      score += 6;
      tips.push('Prueba un título un poco más descriptivo (35–75 caracteres suele rendir mejor).');
    } else if (len > 75) {
      score -= 8;
      tips.push('Acorta el título: en redes lo largo pierde clics.');
    } else if (len > 0 && len < 20) {
      score -= 10;
      tips.push('El título es muy corto; añade contexto (juego, momento, emoción).');
    }

    if (/\d/.test(t)) {
      score += 8;
      breakdown.push({ label: 'Título con número/dato', pts: 8 });
    }
    if (/\?/.test(t) || nt.indexOf('como ') === 0 || nt.indexOf('por que') >= 0) {
      score += 7;
      breakdown.push({ label: 'Gancho tipo pregunta', pts: 7 });
    }

    var powerHits = 0;
    POWER_WORDS.forEach(function (w) {
      if (nt.indexOf(normalizeText(w)) >= 0) powerHits++;
    });
    if (powerHits) {
      var pw = Math.min(18, powerHits * 6);
      score += pw;
      breakdown.push({ label: 'Palabras clave gaming/marketing', pts: pw });
    }

    var trendHits = 0;
    var matchedTrends = [];
    trendKeywords.concat(BASE_GAMING_TOPICS.map(normalizeText)).forEach(function (kw) {
      var k = normalizeText(kw);
      if (k.length < 3) return;
      if (nt.indexOf(k) >= 0 || nc.indexOf(k) >= 0) {
        trendHits++;
        if (matchedTrends.length < 4) matchedTrends.push(kw);
      }
    });
    if (trendHits) {
      var th = Math.min(22, trendHits * 7);
      score += th;
      breakdown.push({ label: 'Alineado con tendencias actuales', pts: th });
    } else if (trendKeywords.length) {
      tips.push('Menciona un tema caliente hoy: ' + trendKeywords.slice(0, 3).join(', ') + '.');
    }

    if (t === t.toUpperCase() && t.length > 12) {
      score -= 12;
      tips.push('Evita MAYÚSCULAS completas; parece spam.');
    }

    if (c.length >= 80 && c.length <= 400) {
      score += 10;
      breakdown.push({ label: 'Descripción equilibrada', pts: 10 });
    } else if (c.length > 0 && c.length < 50) {
      tips.push('Amplía la descripción: contexto + llamada a la acción.');
    }

    var hasCta = MARKETING_CTA.some(function (w) { return nc.indexOf(w) >= 0; });
    if (hasCta) {
      score += 9;
      breakdown.push({ label: 'Invita a interactuar', pts: 9 });
    } else {
      tips.push('Cierra con una CTA: “¿Qué opinas?”, “Comenta”, “Comparte”.');
    }

    if (trendTopics.length && t.length > 5) {
      var overlap = 0;
      var titleWords = extractKeywords(t);
      trendTopics.slice(0, 8).forEach(function (topic) {
        var tw = extractKeywords(topic);
        tw.forEach(function (w) {
          if (titleWords.indexOf(w) >= 0) overlap++;
        });
      });
      if (overlap >= 2) {
        score += 10;
        breakdown.push({ label: 'Similar a titulares trending', pts: 10 });
      }
    }

    score = clamp(Math.round(score), 5, 98);

    var label = 'Potencial bajo';
    var level = 'low';
    if (score >= 75) { label = 'Potencial alto'; level = 'high'; }
    else if (score >= 55) { label = 'Potencial medio'; level = 'mid'; }

    if (!tips.length) {
      tips.push('Buen equilibrio. Revisa ortografía y sube un clip o imagen clara del momento.');
    }

    return {
      score: score,
      label: label,
      level: level,
      tips: tips.slice(0, 4),
      breakdown: breakdown,
      matchedTrends: matchedTrends
    };
  }

  function renderMeter(container, result) {
    if (!container || !result) return;
    var pct = result.score;
    container.innerHTML =
      '<div class="cm-insight-meter cm-insight-' + result.level + '">' +
        '<div class="cm-insight-meter-body">' +
          '<div class="cm-insight-meter-head">' +
            '<span class="cm-insight-meter-label"><i class="fas fa-brain"></i> Potencial estimado</span>' +
            '<strong class="cm-insight-meter-score">' + pct + '<small>/100</small></strong>' +
          '</div>' +
          '<div class="cm-insight-meter-bar"><div class="cm-insight-meter-fill" style="width:' + pct + '%"></div></div>' +
          '<p class="cm-insight-meter-status">' + result.label + ' · solo referencia, no garantiza resultados</p>' +
          (result.matchedTrends && result.matchedTrends.length
            ? '<div class="cm-insight-trends-hit"><span>Tendencias detectadas en tu texto:</span> ' +
              result.matchedTrends.map(function (x) { return '<em>' + x + '</em>'; }).join(' · ') + '</div>'
            : '') +
          '<ul class="cm-insight-tips">' + result.tips.map(function (tip) {
            return '<li><i class="fas fa-lightbulb"></i> ' + tip + '</li>';
          }).join('') + '</ul>' +
        '</div>' +
        '<div class="cm-insight-meter-footer" id="cm-trends-panel"></div>' +
      '</div>';
  }

  function renderTrendsChips(container, trends) {
    if (!container) return;
    if (!trends || !trends.topics || !trends.topics.length) {
      container.innerHTML = '<p class="cm-insight-trends-empty">Cargando de qué se habla hoy…</p>';
      return;
    }
    var chips = trends.topics.slice(0, 6).map(function (topic) {
      var short = topic.length > 48 ? topic.slice(0, 48) + '…' : topic;
      return '<span class="cm-trend-chip" title="' + short.replace(/"/g, '&quot;') + '">' + short + '</span>';
    }).join('');
    container.innerHTML =
      '<h5 class="cm-insight-trends-title"><i class="fas fa-fire"></i> De qué se habla hoy en gaming</h5>' +
      '<div class="cm-trend-chips">' + chips + '</div>' +
      '<p class="cm-insight-trends-note">Referencia basada en titulares trending · ' +
      (trends.source || 'gaming') + '</p>';
  }

  function bindForm(opts) {
    var titleEl = opts.titleEl;
    var captionEl = opts.captionEl;
    var meterEl = opts.meterEl;
    if (!titleEl || !captionEl || !meterEl) return;
    if (meterEl.dataset.cmBound === '1') return;
    meterEl.dataset.cmBound = '1';

    var timer = null;
    function refresh() {
      var result = scorePublication(titleEl.value, captionEl.value, state.trends);
      renderMeter(meterEl, result);
      var trendsSlot = meterEl.querySelector('#cm-trends-panel');
      renderTrendsChips(trendsSlot, state.trends);
      meterEl.dataset.score = String(result.score);
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 220);
    }

    titleEl.addEventListener('input', schedule);
    captionEl.addEventListener('input', schedule);
    refresh();
  }

  function loadTrends(db, functionsApi) {
    if (state.loading) return Promise.resolve(state.trends);
    state.loading = true;
    return Promise.resolve()
      .then(function () {
        if (db) {
          return db.ref('creatorMarket/trendsCache/payload').once('value').then(function (snap) {
            var val = snap.val();
            if (val && val.topics && val.topics.length) return val;
            return null;
          });
        }
        return null;
      })
      .then(function (cached) {
        if (cached) {
          state.trends = cached;
          return cached;
        }
        if (functionsApi && functionsApi.httpsCallable) {
          return functionsApi.httpsCallable('getCreatorMarketTrends')({}).then(function (res) {
            state.trends = res.data || null;
            return state.trends;
          }).catch(function () {
            state.trends = {
              topics: BASE_GAMING_TOPICS,
              keywords: ['cs2', 'valorant', 'coop', 'ranked', 'update', 'clip', 'gaming'],
              source: 'local_fallback'
            };
            return state.trends;
          });
        }
        state.trends = {
          topics: BASE_GAMING_TOPICS,
          keywords: ['cs2', 'valorant', 'coop', 'ranked', 'update', 'clip', 'gaming'],
          source: 'local_fallback'
        };
        return state.trends;
      })
      .finally(function () {
        state.loading = false;
      });
  }

  function init(opts) {
    opts = opts || {};
    loadTrends(opts.db, opts.functions).then(function () {
      bindForm({
        titleEl: document.getElementById('mercado-title'),
        captionEl: document.getElementById('mercado-caption'),
        meterEl: document.getElementById('cm-insight-meter')
      });
    });
  }

  function getLastScore() {
    var el = document.getElementById('cm-insight-meter');
    return el ? Number(el.dataset.score) || null : null;
  }

  global.CreatorMarketInsights = {
    init: init,
    loadTrends: loadTrends,
    scorePublication: scorePublication,
    getLastScore: getLastScore
  };
})(window);
