/* td-live-board.js — tablero en vivo de la sala del torneo.
 *
 * Lee lo que NexusBridge publica en partida_en_vivo/{torneo}/{cruce} y lo pinta
 * como el marcador del juego: las dos plantillas por bando, el feed de bajas en
 * medio y, antes de que empiece a contar nada, quién va entrando al servidor.
 *
 * No habla con Firebase: tournament-details.js ya escucha el nodo y le pasa el
 * último parte. Así el tablero se puede probar con un objeto a mano.
 */
(function (global) {
  'use strict';

  var FEED_MAX = 8;
  var VIEWS = ['board', 'feed'];

  var wired = false;
  var view = 'board';
  var seenKills = {};

  function $(id) { return document.getElementById(id); }

  function escHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function toNum(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function sideOf(value) {
    var side = String(value || '').toUpperCase();
    return side === 'CT' || side === 'T' ? side : null;
  }

  function normName(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  /** Identidad de un conectado, para no contarlo dos veces. */
  function lobbyKey(entry) {
    return entry.uid ? 'u:' + entry.uid : 'n:' + normName(entry.name);
  }

  /**
   * El parte de sala dice quién está dentro; la plantilla del cruce dice quién
   * tendría que estar. Cruzarlos es lo único que contesta la pregunta que se
   * hace el jugador mientras espera: si falta alguien, y quién.
   *
   * El emparejamiento va por uid, que es lo que resuelve el servidor con la
   * cuenta de Steam. Se cae al nombre porque el que no tiene Steam vinculado
   * entra igual y sin ese respaldo saldría como ausente estando dentro.
   */
  function buildLobbyCheck(live, teams) {
    var list = Array.isArray(teams) ? teams : [];
    if (!list.length) return null;

    var lobby = (live && live.lobby && Array.isArray(live.lobby.players))
      ? live.lobby.players : [];
    var byUid = {};
    var byName = {};
    lobby.forEach(function (entry) {
      if (!entry) return;
      if (entry.uid && !byUid[entry.uid]) byUid[entry.uid] = entry;
      var n = normName(entry.name);
      if (n && !byName[n]) byName[n] = entry;
    });

    var claimed = {};
    function take(player) {
      var hit = player.uid ? byUid[player.uid] : null;
      if (!hit) hit = byName[normName(player.nick)] || null;
      if (!hit || claimed[lobbyKey(hit)]) return null;
      claimed[lobbyKey(hit)] = true;
      return hit;
    }

    var out = list.map(function (team) {
      var players = (team.players || []).map(function (player) {
        var hit = take(player);
        return {
          uid: player.uid || null,
          nick: player.nick || '—',
          connected: !!hit,
          side: hit ? sideOf(hit.side) : null,
        };
      });
      return {
        teamId: team.teamId || null,
        name: team.name || '—',
        total: players.length,
        inCount: players.filter(function (p) { return p.connected; }).length,
        players: players,
      };
    });

    // Quien está dentro sin salir en ninguna plantilla: un suplente que aún no
    // figura, o alguien que no pinta nada ahí. Se nombra, no se acusa.
    var guests = lobby
      .filter(function (entry) {
        return entry && entry.bot !== true && !claimed[lobbyKey(entry)];
      })
      .map(function (entry) { return entry.name || '—'; });

    return { teams: out, guests: guests };
  }

  /**
   * Nombre del arma tal y como lo manda el motor: 'weapon_ak47', 'ak47',
   * 'knife_t'. La sala enseña la parte que se reconoce de un vistazo.
   */
  function weaponLabel(weapon) {
    var raw = String(weapon || '').replace(/^weapon_/, '').replace(/_/g, ' ').trim();
    if (!raw || raw === 'world') return 'MUNDO';
    return raw.toUpperCase();
  }

  function killKey(kill) {
    return [kill.at, kill.killer, kill.victim, kill.weapon].join('|');
  }

  /* —— Filas de las dos tablas —— */

  /**
   * La tabla sale de las estadísticas del servidor. Mientras no haya ninguna
   * (calentamiento, o partida recién lanzada) se pinta con quién está dentro:
   * el jugador que ya entró necesita ver si falta alguien de su equipo, y una
   * tabla vacía no dice ni que el servidor esté vivo.
   */
  function buildRows(live) {
    var scoreboard = live && Array.isArray(live.scoreboard) ? live.scoreboard : [];
    var rows;
    var pending = false;

    if (scoreboard.length) {
      rows = scoreboard.map(function (row) {
        return {
          uid: row.uid || null,
          name: row.name || '—',
          side: sideOf(row.side),
          bot: row.bot === true,
          kills: toNum(row.kills),
          deaths: toNum(row.deaths),
          assists: toNum(row.assists),
          kd: row.kd != null ? toNum(row.kd) : null,
          score: toNum(row.score),
        };
      });
    } else {
      var lobby = (live && live.lobby && Array.isArray(live.lobby.players)) ? live.lobby.players : [];
      pending = true;
      rows = lobby.map(function (entry) {
        return {
          uid: entry.uid || null,
          name: entry.name || '—',
          side: sideOf(entry.side),
          bot: entry.bot === true,
          kills: 0,
          deaths: 0,
          assists: 0,
          kd: null,
          score: 0,
          pending: true,
        };
      });
    }

    var ct = rows.filter(function (r) { return r.side === 'CT'; });
    var t = rows.filter(function (r) { return r.side === 'T'; });
    var unsided = rows.filter(function (r) { return !r.side; });

    // Un build viejo del plugin no reporta el bando. Repartir a ojo etiquetaría
    // a media plantilla en el equipo contrario, así que se enseñan juntos.
    if (!ct.length && !t.length && unsided.length) {
      return {
        ct: unsided, t: [], bench: [], unsided: true,
        pending: pending, total: rows.length,
      };
    }

    // El que acaba de entrar está en espectadores hasta que elige o hasta que
    // MatchZy lo coloca. Sin esta lista desaparecía del tablero justo en el rato
    // en el que más quiere comprobar que el servidor lo ve.
    return {
      ct: ct, t: t, bench: unsided, unsided: false,
      pending: pending, total: ct.length + t.length + unsided.length,
    };
  }

  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  function diffCell(row) {
    var diff = row.kills - row.deaths;
    var cls = diff > 0 ? 'td-board-diff-up' : diff < 0 ? 'td-board-diff-down' : '';
    return '<td class="' + cls + '">' + (diff > 0 ? '+' + diff : diff) + '</td>';
  }

  function kdCell(row) {
    if (row.kd != null) return '<td>' + row.kd.toFixed(2) + '</td>';
    var kd = row.deaths > 0 ? row.kills / row.deaths : row.kills;
    return '<td>' + kd.toFixed(2) + '</td>';
  }

  function renderTable(bodyId, rows, currentUid, emptyText) {
    var body = $(bodyId);
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td class="td-board-empty" colspan="7">' + escHtml(emptyText) + '</td></tr>';
      return;
    }
    body.innerHTML = sortRows(rows).map(function (row) {
      var mine = currentUid && row.uid && row.uid === currentUid;
      var classes = [];
      if (mine) classes.push('is-you');
      if (row.pending) classes.push('is-pending');
      return '<tr' + (classes.length ? ' class="' + classes.join(' ') + '"' : '') + '>' +
        '<td class="td-board-player">' + escHtml(row.name) +
          (mine ? ' <b>· tú</b>' : '') +
          (row.bot ? ' <span class="td-board-tag">bot</span>' : '') + '</td>' +
        '<td>' + row.kills + '</td>' +
        '<td>' + row.deaths + '</td>' +
        '<td>' + row.assists + '</td>' +
        diffCell(row) +
        kdCell(row) +
        '<td class="td-board-pts">' + row.score + '</td>' +
      '</tr>';
    }).join('');
  }

  /** Conectados que todavía no tienen bando: espectadores y recién llegados. */
  function renderBench(rows, currentUid) {
    var box = $('tdBoardBench');
    if (!box) return;
    if (!rows.bench || !rows.bench.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '<span class="td-board-bench-label">En el servidor, sin bando</span>' +
      rows.bench.map(function (row) {
        var mine = currentUid && row.uid && row.uid === currentUid;
        return '<span class="td-board-bench-name' + (mine ? ' is-you' : '') + '">' +
          escHtml(row.name) + (mine ? ' · tú' : '') +
          (row.bot ? ' <span class="td-board-tag">bot</span>' : '') +
        '</span>';
      }).join('');
  }

  /**
   * La lista de asistencia del cruce. Solo mientras no haya estadísticas: en
   * cuanto el servidor reporta la primera ronda, quién falta ya se ve en la
   * propia tabla y esto sobra.
   */
  function renderLobbyCheck(ctx, live, rows) {
    var box = $('tdLobbyCheck');
    if (!box) return;
    var server = ctx.server || {};
    var finished = live && String(live.status) === 'finished';
    // Solo mientras haya algo que esperar: con el cruce cerrado, o antes de que
    // exista siquiera su máquina, una lista de ausentes no informa de nada.
    var waiting = !!(live && live.lobby) ||
      server.status === 'provisioning' || server.status === 'starting' ||
      server.status === 'live';
    var check = (rows.pending && !finished && waiting)
      ? buildLobbyCheck(live, ctx.teams)
      : null;
    if (!check) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }

    var currentUid = ctx.currentUid || null;
    var cards = check.teams.map(function (team) {
      var full = team.total > 0 && team.inCount === team.total;
      return '<div class="td-lobby-team' + (full ? ' is-full' : '') + '">' +
        '<div class="td-lobby-team-head">' +
          '<span class="td-lobby-team-name">' + escHtml(team.name) + '</span>' +
          '<span class="td-lobby-team-count">' + team.inCount + '/' + team.total + '</span>' +
        '</div>' +
        '<div class="td-lobby-players">' + team.players.map(function (p) {
          var mine = currentUid && p.uid && p.uid === currentUid;
          return '<span class="td-lobby-player' + (p.connected ? ' is-in' : ' is-out') +
            (mine ? ' is-you' : '') + '">' +
            '<i class="fas ' + (p.connected ? 'fa-circle-check' : 'fa-hourglass-half') +
              '" aria-hidden="true"></i>' +
            escHtml(p.nick) + (mine ? ' · tú' : '') +
          '</span>';
        }).join('') + '</div>' +
      '</div>';
    }).join('');

    var guests = check.guests.length
      ? '<p class="td-lobby-guests"><i class="fas fa-user-secret" aria-hidden="true"></i> ' +
        'En el servidor sin salir en ninguna plantilla: ' +
        escHtml(check.guests.join(', ')) + '</p>'
      : '';

    box.hidden = false;
    box.innerHTML = '<span class="td-lobby-title">Quién ha entrado</span>' +
      '<div class="td-lobby-teams">' + cards + '</div>' + guests;
  }

  /**
   * Qué decir con la tabla vacía. "Esperando la plantilla" no distingue entre
   * una máquina que todavía se está creando y una que lleva un rato en pie con
   * la sala vacía, y son dos esperas muy distintas para el que mira.
   */
  function emptyBoardText(ctx, live) {
    var server = ctx.server || {};
    if (server.status === 'provisioning') {
      return 'Levantando el servidor de este cruce. Tarda unos minutos.';
    }
    if (server.ip) {
      // La IP solo la ve quien puede conectarse: el tablero es público y el
      // panel de conexión ya está cerrado a los espectadores.
      var where = server.canConnect
        ? ' en ' + server.ip + ':' + (server.port || 27015)
        : '';
      return 'El servidor está en pie' + where + '. Todavía no ha entrado nadie.';
    }
    if (live) return 'Esperando a que el servidor reporte la plantilla.';
    return 'El tablero se llena cuando arranca la partida.';
  }

  /* —— Kill feed —— */

  function feedName(name, side, extraClass) {
    var cls = side === 'CT' ? 'td-kf-ct' : side === 'T' ? 'td-kf-t' : 'td-kf-none';
    return '<span class="td-kf-name ' + cls + (extraClass ? ' ' + extraClass : '') + '">' +
      escHtml(name) + '</span>';
  }

  function renderFeed(live) {
    var list = $('tdKillFeed');
    var empty = $('tdKillFeedEmpty');
    if (!list) return;

    var kills = (live && Array.isArray(live.recentKills) ? live.recentKills : [])
      .filter(function (k) { return k && k.victim; })
      .slice(0, FEED_MAX);

    if (!kills.length) {
      list.innerHTML = '';
      seenKills = {};
      if (empty) {
        empty.style.display = 'block';
        empty.textContent = live && String(live.status) === 'finished'
          ? 'La partida terminó.'
          : 'Sin bajas todavía.';
      }
      return;
    }

    if (empty) empty.style.display = 'none';
    var next = {};
    list.innerHTML = kills.map(function (kill) {
      var key = killKey(kill);
      var fresh = !seenKills[key];
      next[key] = true;
      var killer = kill.killer
        ? feedName(kill.killer, sideOf(kill.killerSide))
        : '<span class="td-kf-name td-kf-none">Mundo</span>';
      return '<li class="td-kf-row' + (fresh ? ' is-new' : '') + (kill.friendlyFire ? ' is-ff' : '') + '">' +
        killer +
        '<i class="fas fa-skull td-kf-icon" aria-hidden="true"></i>' +
        (kill.headshot ? '<i class="fas fa-crosshairs td-kf-hs" title="Headshot"></i>' : '') +
        feedName(kill.victim, sideOf(kill.victimSide), 'td-kf-victim') +
        '<span class="td-kf-weapon">[' + escHtml(weaponLabel(kill.weapon)) + ']</span>' +
      '</li>';
    }).join('');
    seenKills = next;
  }

  /* —— Pie —— */

  function renderFoot(ctx, live, rows) {
    var phase = $('tdBoardPhase');
    var round = $('tdRound');
    var finished = live && String(live.status) === 'finished';
    var warmup = !!live && !finished && (rows.pending || live.phase === 'warmup');

    if (phase) {
      phase.classList.toggle('is-warmup', warmup);
      phase.classList.toggle('is-live', !!live && !finished && !warmup);
      var label;
      if (finished) label = 'Partida finalizada';
      else if (warmup) {
        var count = (live.lobby && live.lobby.count != null) ? live.lobby.count : rows.total;
        label = 'Calentamiento · ' + count + (count === 1 ? ' conectado' : ' conectados');
      } else if (live) label = 'En juego';
      else label = ctx.statusLabel || 'Esperando partida';
      phase.innerHTML = '<i class="fas fa-circle" aria-hidden="true"></i> ' + escHtml(label);
    }

    if (round) {
      var n = live && live.currentRound != null ? toNum(live.currentRound) : null;
      round.textContent = n ? 'Ronda ' + n : 'Ronda —';
    }
  }

  function renderScores(live) {
    var ct = $('tdScoreCt');
    var t = $('tdScoreT');
    if (ct) ct.textContent = live && live.scoreCT != null ? toNum(live.scoreCT) : '0';
    if (t) t.textContent = live && live.scoreT != null ? toNum(live.scoreT) : '0';
  }

  function renderMvp(mvp) {
    var box = $('tdMvp');
    if (!box) return;
    if (!mvp || !mvp.name) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML =
      '<i class="fas fa-star td-mvp-icon"></i>' +
      '<div class="td-mvp-body">' +
        '<span class="td-mvp-label">MVP de la partida</span>' +
        '<span class="td-mvp-name">' + escHtml(mvp.name) + '</span>' +
      '</div>' +
      '<div class="td-mvp-stats">' +
        '<span>' + toNum(mvp.kills) + ' bajas</span>' +
        '<span>' + toNum(mvp.adr) + ' ADR</span>' +
      '</div>';
  }

  /* —— Conmutador de vista —— */

  function setView(next) {
    view = VIEWS.indexOf(next) === -1 ? 'board' : next;
    var board = $('tdBoard');
    if (board) board.setAttribute('data-view', view);
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-board-view]'),
      function (btn) {
        var on = btn.getAttribute('data-board-view') === view;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    );
  }

  function ensureWired() {
    if (wired) return;
    var board = $('tdBoard');
    if (!board) return;
    wired = true;
    Array.prototype.forEach.call(
      board.querySelectorAll('[data-board-view]'),
      function (btn) {
        btn.addEventListener('click', function () {
          setView(btn.getAttribute('data-board-view'));
        });
      }
    );
    setView(view);
  }

  /* —— API —— */

  function render(ctx) {
    ensureWired();
    var context = ctx || {};
    var live = context.live || null;
    var board = $('tdBoard');
    var rows = buildRows(live);

    if (board) board.classList.toggle('is-unsided', rows.unsided);

    var emptyText = emptyBoardText(context, live);
    renderTable('tdBoardCtBody', rows.ct, context.currentUid, emptyText);
    renderTable('tdBoardTBody', rows.t, context.currentUid, emptyText);
    renderBench(rows, context.currentUid);
    renderLobbyCheck(context, live, rows);

    renderScores(live);
    renderFeed(live);
    renderFoot(context, live, rows);
    renderMvp(live && live.mvp);
  }

  /** El reloj lo lleva la sala, que es quien sabe cuándo arrancó la partida. */
  function setClock(text) {
    var el = $('tdDuration');
    if (el) el.textContent = text;
  }

  function clear() {
    seenKills = {};
    render({ live: null });
  }

  global.TDLiveBoard = {
    render: render,
    setClock: setClock,
    clear: clear,
    // Expuesto para que la asistencia se pueda comprobar sin navegador.
    buildLobbyCheck: buildLobbyCheck,
  };
})(typeof window !== 'undefined' ? window : this);
