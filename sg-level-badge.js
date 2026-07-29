/**
 * Insignia de nivel Nexus (1–100), estilo Steam.
 *
 * Componente compartido: se carga en nexus, dashboard y comunidad después de
 * sg-levels.js y expone window.SGLevelBadge. Toda la curva, los tramos y los
 * beneficios salen de window.SGLevels; aquí solo se pinta.
 *
 * Si SGLevels no estuviera disponible (script caído, orden de carga roto), la
 * insignia degrada a un escudo neutro con el número de nivel y sin barra, en
 * vez de tumbar la página que la usa.
 */
(function (root) {
    'use strict';

    if (!root) return;

    var PREFIX = 'sg-lvl';
    var SIZES = ['sm', 'md', 'lg'];

    /** Tramo de repuesto cuando SGLevels no está cargado. */
    var FALLBACK_TIER = {
        index: 0,
        name: 'NEXUS',
        accessName: 'Nexus',
        from: 1,
        to: 100,
        color: '#58a6ff',
        glow: 'rgba(88, 166, 255, 0.55)',
        icon: 'fa-shield-halved',
        tagline: 'Progreso del Nexo'
    };

    function levels() {
        var api = root.SGLevels;
        return (api && typeof api.progress === 'function') ? api : null;
    }

    function toInt(value) {
        var n = Math.floor(Number(value));
        return isFinite(n) ? n : 0;
    }

    function fmt(value) {
        var n = Math.max(0, toInt(value));
        try {
            return n.toLocaleString('es-ES');
        } catch (e) {
            return String(n);
        }
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 'EMBAJADOR' → 'Embajador'; los tramos vienen en mayúsculas desde SGLevels. */
    function titleCase(name) {
        var text = String(name || '');
        if (!text) return '';
        var lower;
        try {
            lower = text.toLocaleLowerCase('es');
        } catch (e) {
            lower = text.toLowerCase();
        }
        return lower.charAt(0).toUpperCase() + lower.slice(1);
    }

    function normalizeSize(size) {
        var value = String(size || 'md').toLowerCase();
        return SIZES.indexOf(value) === -1 ? 'md' : value;
    }

    function round(value, decimals) {
        var factor = Math.pow(10, decimals || 0);
        return Math.round(value * factor) / factor;
    }

    /**
     * Traduce las opciones a todo lo que necesitan el marcado y las variables
     * CSS. Acepta solo `xp` (deriva el nivel), solo `level`, o los dos.
     */
    function resolve(options) {
        var opts = options || {};
        var api = levels();
        var hasXp = opts.xp !== undefined && opts.xp !== null && opts.xp !== '';
        var hasLevel = opts.level !== undefined && opts.level !== null && opts.level !== '';
        var maxLevel = api ? api.MAX_LEVEL : 100;

        var data = {
            available: !!api,
            maxLevel: maxLevel,
            xp: hasXp ? Math.max(0, toInt(opts.xp)) : null,
            level: 1,
            tier: FALLBACK_TIER,
            tierIndex: 0,
            pct: 0,
            intoLevel: 0,
            levelSpan: 0,
            remaining: 0,
            nextLevel: null,
            nextLevelXp: null,
            maxed: false,
            bonusPct: 0,
            stepsInTier: 10,
            litSteps: 1
        };

        if (!api) {
            var raw = hasLevel ? toInt(opts.level) : 1;
            data.level = Math.min(100, Math.max(1, raw || 1));
            data.maxed = data.level >= 100;
            data.litSteps = Math.max(1, ((data.level - 1) % 10) + 1);
            return data;
        }

        if (hasXp) {
            var p = api.progress(data.xp);
            data.level = p.level;
            data.tier = p.tier;
            data.tierIndex = p.tierIndex;
            data.pct = p.pct;
            data.intoLevel = p.intoLevel;
            data.levelSpan = p.levelSpan;
            data.remaining = p.remaining;
            data.nextLevel = p.nextLevel;
            data.nextLevelXp = p.nextLevelXp;
            data.maxed = p.maxed;
        } else {
            data.level = Math.min(maxLevel, Math.max(1, hasLevel ? (toInt(opts.level) || 1) : 1));
            data.tier = api.tierForLevel(data.level);
            data.tierIndex = data.tier.index;
            data.maxed = data.level >= maxLevel;
            data.xp = api.xpForLevel(data.level);
            if (!data.maxed) {
                var floorXp = api.xpForLevel(data.level);
                var nextXp = api.xpForLevel(data.level + 1);
                data.levelSpan = nextXp - floorXp;
                data.remaining = data.levelSpan;
                data.nextLevel = data.level + 1;
                data.nextLevelXp = nextXp;
            }
        }

        // Si nos dieron nivel y XP a la vez, manda la XP salvo que el nivel del
        // servidor vaya por delante (puede pasar con premios manuales).
        if (hasXp && hasLevel) {
            var forced = Math.min(maxLevel, Math.max(1, toInt(opts.level) || 1));
            if (forced > data.level) {
                data.level = forced;
                data.tier = api.tierForLevel(forced);
                data.tierIndex = data.tier.index;
            }
        }

        data.bonusPct = api.xpBonusPct(data.level, data.xp == null ? api.xpForLevel(data.level) : data.xp);
        data.stepsInTier = Math.max(1, data.tier.to - data.tier.from + 1);
        data.litSteps = Math.min(data.stepsInTier, Math.max(1, data.level - data.tier.from + 1));
        return data;
    }

    function ariaLabel(data, showBar) {
        var label = 'Nivel ' + data.level + ', tramo ' + titleCase(data.tier.name);
        if (showBar && !data.maxed && data.levelSpan > 0 && data.xp != null) {
            label += ', ' + fmt(data.intoLevel) + ' de ' + fmt(data.levelSpan) + ' EXP hacia el nivel ' + data.nextLevel;
        } else if (data.maxed) {
            label += ', nivel máximo';
        }
        return label;
    }

    function ratioText(data) {
        if (data.maxed) return fmt(data.xp) + ' EXP · MÁX';
        if (data.xp == null || data.levelSpan <= 0) return 'Nivel ' + data.level;
        return fmt(data.intoLevel) + ' / ' + fmt(data.levelSpan) + ' EXP';
    }

    function remainingText(data) {
        if (data.maxed) return 'Has tocado el techo del Nexo';
        if (data.xp == null || !data.nextLevel) return 'Sigue sumando EXP';
        return 'faltan ' + fmt(data.remaining) + ' EXP para el nivel ' + data.nextLevel;
    }

    function tooltipText(data) {
        var parts = [titleCase(data.tier.name)];
        if (data.tier.tagline) parts.push(data.tier.tagline);
        parts.push(data.bonusPct > 0 ? '+' + data.bonusPct + '% EXP en todo' : 'Sin bono de EXP todavía');
        return parts;
    }

    function rootClasses(data, cfg) {
        var list = [
            PREFIX,
            PREFIX + '--' + cfg.size,
            PREFIX + '--t' + data.tierIndex
        ];
        if (data.maxed) list.push(PREFIX + '--maxed');
        if (cfg.showBar) list.push(PREFIX + '--has-bar');
        if (!data.available) list.push(PREFIX + '--fallback');
        if (cfg.className) list.push(cfg.className);
        return list.join(' ');
    }

    /** Variables CSS: el ornamento del anillo se dibuja a partir de estos ángulos. */
    function applyVars(el, data) {
        var segDeg = 360 / data.stepsInTier;
        el.style.setProperty('--sg-lvl-color', data.tier.color);
        el.style.setProperty('--sg-lvl-glow', data.tier.glow);
        el.style.setProperty('--sg-lvl-pct', round(data.pct, 2) + '%');
        el.style.setProperty('--sg-lvl-deg', round((data.pct / 100) * 360, 2) + 'deg');
        el.style.setProperty('--sg-lvl-seg-deg', round(segDeg, 4) + 'deg');
        el.style.setProperty('--sg-lvl-gap-deg', round(Math.min(6, segDeg * 0.18), 4) + 'deg');
        el.style.setProperty('--sg-lvl-lit-deg', round(segDeg * data.litSteps, 4) + 'deg');
    }

    function normalizeConfig(options) {
        var opts = options || {};
        return {
            size: normalizeSize(opts.size),
            showBar: opts.showBar === true,
            showTier: opts.showTier === true,
            showTooltip: opts.showTooltip !== false,
            className: opts.className || ''
        };
    }

    function markup(data, cfg) {
        var tip = '';
        if (cfg.showTooltip) {
            var lines = tooltipText(data);
            tip = '<span class="' + PREFIX + '__tip" aria-hidden="true">' +
                '<strong>' + escapeHtml(lines[0]) + '</strong>' +
                (lines.length > 2 ? '<em>' + escapeHtml(lines[1]) + '</em>' : '') +
                '<b>' + escapeHtml(lines[lines.length - 1]) + '</b>' +
                '</span>';
        }

        var shield =
            '<span class="' + PREFIX + '__shield" aria-hidden="true">' +
                '<span class="' + PREFIX + '__halo"></span>' +
                '<span class="' + PREFIX + '__ring"></span>' +
                '<span class="' + PREFIX + '__ornament"></span>' +
                '<span class="' + PREFIX + '__segments"></span>' +
                '<span class="' + PREFIX + '__core">' +
                    '<i class="fas ' + escapeHtml(data.tier.icon) + ' ' + PREFIX + '__icon"></i>' +
                    '<span class="' + PREFIX + '__num">' + data.level + '</span>' +
                '</span>' +
            '</span>';

        var tierLabel = cfg.showTier
            ? '<span class="' + PREFIX + '__tier">' + escapeHtml(titleCase(data.tier.name)) + '</span>'
            : '';

        var bar = '';
        if (cfg.showBar) {
            bar =
                '<span class="' + PREFIX + '__bar">' +
                    tierLabel +
                    '<span class="' + PREFIX + '__track"><span class="' + PREFIX + '__fill"></span></span>' +
                    '<span class="' + PREFIX + '__meta">' +
                        '<span class="' + PREFIX + '__ratio">' + escapeHtml(ratioText(data)) + '</span>' +
                        '<span class="' + PREFIX + '__remaining">' + escapeHtml(remainingText(data)) + '</span>' +
                    '</span>' +
                '</span>';
        } else if (cfg.showTier) {
            bar = '<span class="' + PREFIX + '__bar ' + PREFIX + '__bar--tier-only">' + tierLabel + '</span>';
        }

        return shield + bar + tip;
    }

    function cacheRefs(el) {
        var refs = {
            num: el.querySelector('.' + PREFIX + '__num'),
            icon: el.querySelector('.' + PREFIX + '__icon'),
            tier: el.querySelector('.' + PREFIX + '__tier'),
            ratio: el.querySelector('.' + PREFIX + '__ratio'),
            remaining: el.querySelector('.' + PREFIX + '__remaining'),
            tip: el.querySelector('.' + PREFIX + '__tip')
        };
        el._sgLvlRefs = refs;
        return refs;
    }

    function paint(el, data, cfg) {
        el.className = rootClasses(data, cfg);
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', ariaLabel(data, cfg.showBar));
        el.dataset.sgLvl = String(data.level);
        el.dataset.sgTier = String(data.tierIndex);
        el.dataset.sgSize = cfg.size;
        el.dataset.sgBar = cfg.showBar ? '1' : '0';
        el.dataset.sgTierLabel = cfg.showTier ? '1' : '0';
        el.dataset.sgTip = cfg.showTooltip ? '1' : '0';
        applyVars(el, data);
        el.innerHTML = markup(data, cfg);
        cacheRefs(el);
    }

    /**
     * Pinta la insignia dentro de `element`. Devuelve el nodo raíz de la
     * insignia (el propio `element` si ya lo era) o null si no hay dónde pintar.
     *
     * options: { xp, level, size: 'sm'|'md'|'lg', showBar, showTier, showTooltip, className }
     */
    function render(element, options) {
        var host = resolveHost(element);
        if (!host) return null;
        var cfg = normalizeConfig(options);
        var data = resolve(options);

        var target;
        if (host.classList && host.classList.contains(PREFIX)) {
            target = host;
        } else {
            target = host.querySelector ? host.querySelector('.' + PREFIX) : null;
            if (!target) {
                var doc = host.ownerDocument || root.document;
                target = doc.createElement('span');
                host.innerHTML = '';
                host.appendChild(target);
            }
        }

        paint(target, data, cfg);
        return target;
    }

    /**
     * Refresca una insignia ya pintada sin recrear nodos: solo texto y
     * variables CSS, para que la barra pueda animarse.
     */
    function update(element, options) {
        var host = resolveHost(element);
        if (!host) return null;
        var target = (host.classList && host.classList.contains(PREFIX))
            ? host
            : (host.querySelector ? host.querySelector('.' + PREFIX) : null);
        if (!target) return render(element, options);

        var cfg = {
            size: target.dataset.sgSize || 'md',
            showBar: target.dataset.sgBar === '1',
            showTier: target.dataset.sgTierLabel === '1',
            showTooltip: target.dataset.sgTip !== '0',
            className: ''
        };
        if (options && options.size) cfg.size = normalizeSize(options.size);
        if (options && options.showBar !== undefined) cfg.showBar = options.showBar !== false;
        if (options && options.showTier !== undefined) cfg.showTier = options.showTier === true;

        var data = resolve(options);
        var refs = target._sgLvlRefs || cacheRefs(target);

        // Si cambia lo estructural (barra, tramo visible o tamaño) hay que
        // repintar; en el caso normal solo se tocan textos y variables.
        var structuralChange = (cfg.showBar && !refs.ratio) ||
            (cfg.showTier && !refs.tier) ||
            target.dataset.sgSize !== cfg.size;
        if (structuralChange) {
            paint(target, data, cfg);
            return target;
        }

        target.className = rootClasses(data, cfg);
        target.setAttribute('aria-label', ariaLabel(data, cfg.showBar));
        target.dataset.sgLvl = String(data.level);
        target.dataset.sgTier = String(data.tierIndex);
        applyVars(target, data);

        if (refs.num) refs.num.textContent = String(data.level);
        if (refs.icon) refs.icon.className = 'fas ' + data.tier.icon + ' ' + PREFIX + '__icon';
        if (refs.tier) refs.tier.textContent = titleCase(data.tier.name);
        if (refs.ratio) refs.ratio.textContent = ratioText(data);
        if (refs.remaining) refs.remaining.textContent = remainingText(data);
        if (refs.tip) {
            var lines = tooltipText(data);
            var strong = refs.tip.querySelector('strong');
            var em = refs.tip.querySelector('em');
            var bold = refs.tip.querySelector('b');
            if (strong) strong.textContent = lines[0];
            if (em) em.textContent = lines[1] || '';
            if (bold) bold.textContent = lines[lines.length - 1];
        }
        return target;
    }

    /** Marcado listo para listas grandes: un solo innerHTML en el consumidor. */
    function html(options) {
        var cfg = normalizeConfig(options);
        var data = resolve(options);
        var segDeg = 360 / data.stepsInTier;
        var style = '--sg-lvl-color:' + data.tier.color +
            ';--sg-lvl-glow:' + data.tier.glow +
            ';--sg-lvl-pct:' + round(data.pct, 2) + '%' +
            ';--sg-lvl-deg:' + round((data.pct / 100) * 360, 2) + 'deg' +
            ';--sg-lvl-seg-deg:' + round(segDeg, 4) + 'deg' +
            ';--sg-lvl-gap-deg:' + round(Math.min(6, segDeg * 0.18), 4) + 'deg' +
            ';--sg-lvl-lit-deg:' + round(segDeg * data.litSteps, 4) + 'deg';
        return '<span class="' + rootClasses(data, cfg) + '" role="img" aria-label="' +
            escapeHtml(ariaLabel(data, cfg.showBar)) + '" style="' + style + '" data-sg-lvl="' + data.level +
            '" data-sg-tier="' + data.tierIndex + '" data-sg-size="' + cfg.size +
            '" data-sg-bar="' + (cfg.showBar ? '1' : '0') +
            '" data-sg-tier-label="' + (cfg.showTier ? '1' : '0') +
            '" data-sg-tip="' + (cfg.showTooltip ? '1' : '0') + '">' +
            markup(data, cfg) + '</span>';
    }

    /** Destello de subida de nivel; se limpia solo. */
    function celebrate(element, duration) {
        var host = resolveHost(element);
        if (!host) return null;
        var target = (host.classList && host.classList.contains(PREFIX))
            ? host
            : (host.querySelector ? host.querySelector('.' + PREFIX) : null);
        if (!target) return null;
        var ms = Math.max(200, toInt(duration) || 1600);
        target.classList.remove(PREFIX + '--levelup');
        // Fuerza el reinicio de la animación si ya estaba puesta.
        if (target.offsetWidth !== undefined) void target.offsetWidth;
        target.classList.add(PREFIX + '--levelup');
        if (typeof root.setTimeout === 'function') {
            root.setTimeout(function () {
                target.classList.remove(PREFIX + '--levelup');
            }, ms);
        }
        return target;
    }

    function destroy(element) {
        var host = resolveHost(element);
        if (!host) return;
        var target = (host.classList && host.classList.contains(PREFIX))
            ? host
            : (host.querySelector ? host.querySelector('.' + PREFIX) : null);
        if (!target) return;
        target._sgLvlRefs = null;
        if (target === host) {
            host.innerHTML = '';
            host.removeAttribute('role');
            host.removeAttribute('aria-label');
        } else if (target.parentNode) {
            target.parentNode.removeChild(target);
        }
    }

    function resolveHost(element) {
        if (!element) return null;
        if (typeof element === 'string') {
            var doc = root.document;
            if (!doc) return null;
            return doc.getElementById(element) || doc.querySelector(element);
        }
        return element.nodeType === 1 ? element : null;
    }

    root.SGLevelBadge = {
        PREFIX: PREFIX,
        SIZES: SIZES.slice(),
        render: render,
        update: update,
        html: html,
        celebrate: celebrate,
        destroy: destroy,
        resolve: resolve,
        titleCase: titleCase
    };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
