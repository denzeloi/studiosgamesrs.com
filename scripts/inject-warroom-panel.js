#!/usr/bin/env node
/**
 * Inserta la pestaña "Control Universal" (War Room) en commander-panel.html.
 *
 * Es idempotente: si el bloque ya está, no hace nada. Vuelve a ejecutarlo si
 * otro proceso reescribe commander-panel.html y se lleva por delante la pestaña:
 *
 *   node scripts/inject-warroom-panel.js
 *
 * El archivo se lee y escribe como latin1 (byte a byte) porque commander-panel.html
 * ha ido cambiando de codificación; así se conservan los bytes existentes tal cual.
 * Por eso todo el HTML que insertamos es ASCII puro y usa entidades (&aacute;, ...).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'commander-panel.html');
const VERSION = '20260729warroom1';

const CSS_LINK = `  <link rel="stylesheet" href="commander-warroom.css?v=${VERSION}">`;
const SCRIPT_TAG = `  <script src="/commander-warroom.js?v=${VERSION}"></script>`;

const TAB_BUTTON = `        <button class="commander-tab" data-tab="warroom">
          <i class="fas fa-chess-board"></i><span>Control Universal</span>
        </button>`;

const SECTION = `
      <!-- PANEL: CONTROL UNIVERSAL DEL TORNEO (War Room) -->
      <section class="commander-panel-section" id="tab-warroom" style="display:none;">
        <h2 class="commander-page-title">Control Universal del Torneo</h2>
        <p class="commander-comms-intro" id="cwrRoleIntro">
          Centro de mando en vivo: servidor de juego, equipos, calendario inteligente, premios, sentinelas y espectadores.
        </p>

        <div class="cwr-command-bar">
          <div class="cwr-command-field">
            <label class="cwr-label" for="cwrTournamentSelect">Torneo bajo mando</label>
            <select id="cwrTournamentSelect" class="cwr-select">
              <option value="">Cargando torneos&hellip;</option>
            </select>
          </div>
          <div class="cwr-command-field" style="flex:0 0 auto;min-width:auto;">
            <span class="cwr-label">Puesto</span>
            <span class="cwr-role-badge" id="cwrRoleBadge">Modo Commander</span>
          </div>
          <button type="button" class="cwr-btn" id="cwrRefreshBtn">
            <i class="fas fa-sync-alt"></i> Recargar
          </button>
          <a class="cwr-btn" id="cwrPublicLink" href="tournament-details.html" target="_blank" rel="noopener">
            <i class="fas fa-external-link-alt"></i> Vista p&uacute;blica
          </a>
          <label class="cwr-toggle" data-cwr-role="commander" title="Si el servidor reporta el ganador, el cuadro avanza solo">
            <input type="checkbox" id="cwrAutopilotToggle" checked> Piloto autom&aacute;tico
          </label>
        </div>

        <div class="cwr-status-strip" id="cwrStatusStrip"></div>
        <p class="cwr-msg" id="cwrMsg"></p>

        <!-- Servidor de juego: toda la informacion disponible -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-server"></i></div>
            <div class="nexus-widget-title">
              <h3>Servidor de juego &mdash; informaci&oacute;n total</h3>
              <p>IP en vivo, tuber&iacute;a de arranque, RCON, UDP, mapa y todo lo que publica el backend.</p>
            </div>
            <span class="nexus-widget-badge">Live</span>
          </div>

          <div id="cwrConnectPanel"></div>
          <div class="cwr-pipeline" id="cwrServerPipeline"></div>
          <div id="cwrLiveHealth"></div>

          <div class="cwr-btn-row" data-cwr-role="commander">
            <select id="cwrLaunchMap" class="cwr-select" style="width:auto;">
              <option value="de_mirage">de_mirage</option>
              <option value="de_inferno">de_inferno</option>
              <option value="de_nuke">de_nuke</option>
              <option value="de_ancient">de_ancient</option>
              <option value="de_anubis">de_anubis</option>
              <option value="de_dust2">de_dust2</option>
              <option value="de_overpass">de_overpass</option>
            </select>
            <button type="button" class="cwr-btn cwr-btn-primary" id="cwrBtnProvision">
              <i class="fas fa-cloud-upload-alt"></i> Crear servidor
            </button>
            <button type="button" class="cwr-btn cwr-btn-primary" id="cwrBtnLaunch">
              <i class="fas fa-play"></i> Lanzar partida en curso
            </button>
            <button type="button" class="cwr-btn" id="cwrBtnCheck">
              <i class="fas fa-stethoscope"></i> Comprobar
            </button>
            <button type="button" class="cwr-btn cwr-btn-danger" id="cwrBtnShutdown">
              <i class="fas fa-power-off"></i> Apagar
            </button>
          </div>

          <h4 class="cwr-subtitle">Ficha completa del servidor</h4>
          <div class="cwr-info-grid" id="cwrServerGrid"></div>

          <div class="cwr-btn-row" data-cwr-role="commander">
            <button type="button" class="cwr-btn" id="cwrRawToggle">
              <i class="fas fa-code"></i> Ver JSON crudo del servidor
            </button>
          </div>
          <pre class="cwr-raw-dump" id="cwrRawDump" style="display:none;"></pre>
        </div>

        <!-- Partida en vivo -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-broadcast-tower"></i></div>
            <div class="nexus-widget-title">
              <h3>Partida en vivo</h3>
              <p>Marcador, ronda, MVP y bajas que env&iacute;a el plugin NexusBridge desde el servidor.</p>
            </div>
          </div>
          <div id="cwrLiveBlock"></div>
        </div>

        <!-- Flota de servidores -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced" data-cwr-role="commander">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-network-wired"></i></div>
            <div class="nexus-widget-title">
              <h3>Flota de servidores</h3>
              <p>Todas las VM levantadas. Apaga las que no uses: cada una factura por hora.</p>
            </div>
          </div>
          <div id="cwrFleetList"></div>
        </div>

        <!-- Equipos -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-users"></i></div>
            <div class="nexus-widget-title">
              <h3>Equipos del torneo</h3>
              <p>Inscritos, invitados y su fuerza calculada. Puedes pausar, eliminar o transferir equipos.</p>
            </div>
          </div>

          <div class="cwr-status-strip" id="cwrTeamsSummary" style="margin:0.9rem 0 0;"></div>

          <div class="cwr-table-wrap">
            <table class="cwr-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Equipo</th>
                  <th>Roster</th>
                  <th>Victorias</th>
                  <th>Verificaci&oacute;n</th>
                  <th>Fuerza</th>
                  <th>Estado</th>
                  <th data-cwr-role="commander">Acciones</th>
                </tr>
              </thead>
              <tbody id="cwrTeamsBody"></tbody>
            </table>
          </div>
          <p class="cwr-empty" id="cwrTeamsEmpty" style="display:none;"></p>

          <div data-cwr-role="commander">
            <h4 class="cwr-subtitle">Invitaciones sin responder</h4>
            <div id="cwrInvitesList"></div>
          </div>
        </div>

        <!-- Calendario inteligente + cuadro -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-calendar-alt"></i></div>
            <div class="nexus-widget-title">
              <h3>Calendario inteligente y cuadro</h3>
              <p>Siembra los equipos por fuerza, reparte horarios por ronda y avanza a los ganadores hasta la final.</p>
            </div>
            <span class="nexus-widget-badge">Auto</span>
          </div>

          <div class="cwr-prize-grid" data-cwr-role="commander">
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrSchedStartAt">Arranque del torneo</label>
              <input type="datetime-local" id="cwrSchedStartAt" class="cwr-input">
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrSeedMode">Siembra</label>
              <select id="cwrSeedMode" class="cwr-select">
                <option value="power">Por fuerza (ranking)</option>
                <option value="random">Aleatoria</option>
                <option value="manual">Manual (teamSeeds)</option>
              </select>
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrSchedMatchMin">Minutos por partida</label>
              <input type="number" id="cwrSchedMatchMin" class="cwr-input" min="5" max="240" value="45">
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrSchedGapMin">Descanso entre partidas</label>
              <input type="number" id="cwrSchedGapMin" class="cwr-input" min="0" max="120" value="10">
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrSchedRoundGapMin">Descanso entre rondas</label>
              <input type="number" id="cwrSchedRoundGapMin" class="cwr-input" min="0" max="240" value="20">
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrSchedSlots">Servidores en paralelo</label>
              <input type="number" id="cwrSchedSlots" class="cwr-input" min="1" max="8" value="1">
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrSchedBestOf">Formato (Bo)</label>
              <select id="cwrSchedBestOf" class="cwr-select">
                <option value="1">Bo1</option>
                <option value="3">Bo3</option>
                <option value="5">Bo5</option>
              </select>
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrSchedMap">Mapa por defecto</label>
              <input type="text" id="cwrSchedMap" class="cwr-input" value="de_mirage">
            </div>
          </div>

          <div class="cwr-btn-row" data-cwr-role="commander">
            <button type="button" class="cwr-btn cwr-btn-primary" id="cwrBtnGenerate">
              <i class="fas fa-sitemap"></i> Generar cuadro inteligente
            </button>
            <button type="button" class="cwr-btn" id="cwrBtnReschedule">
              <i class="fas fa-clock"></i> Recalcular horarios
            </button>
            <button type="button" class="cwr-btn cwr-btn-danger" id="cwrBtnResetBracket">
              <i class="fas fa-trash"></i> Borrar cuadro
            </button>
          </div>
          <p class="cwr-hint" data-cwr-role="commander">
            <i class="fas fa-info-circle"></i> La siembra por fuerza cruza al 1&ordm; con el &uacute;ltimo para que los favoritos
            no se eliminen entre ellos en la primera ronda. Los equipos pausados quedan fuera y, si el n&uacute;mero de equipos
            no es potencia de 2, los mejores reciben pase directo.
          </p>

          <h4 class="cwr-subtitle">Mini calendario</h4>
          <div id="cwrScheduleTimeline"></div>

          <h4 class="cwr-subtitle">Cuadro de eliminaci&oacute;n</h4>
          <div class="cwr-bracket-scroll" id="cwrBracketCanvas"></div>
        </div>

        <!-- Premios -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-coins"></i></div>
            <div class="nexus-widget-title">
              <h3>Premios y reparto</h3>
              <p>Cu&aacute;nto se compite, cu&aacute;nto se entrega y qu&eacute; se llevan 1&ordm;, 2&ordm; y 3&ordm;. Se publica en vivo para todos.</p>
            </div>
            <span class="nexus-widget-badge">P&uacute;blico</span>
          </div>

          <h4 class="cwr-subtitle">Podio</h4>
          <div class="cwr-podium" id="cwrPodiumBox"></div>

          <div data-cwr-role="commander">
            <h4 class="cwr-subtitle">Bolsa del torneo</h4>
            <div class="cwr-prize-grid">
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrizeTokenPool">Pozo en tokens</label>
                <input type="number" id="cwrPrizeTokenPool" class="cwr-input" min="0" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrizeCashPool">Dinero en juego</label>
                <input type="number" id="cwrPrizeCashPool" class="cwr-input" min="0" step="0.01" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrizeCashCurrency">Moneda</label>
                <input type="text" id="cwrPrizeCashCurrency" class="cwr-input" maxlength="6" value="USD">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrizeEntryFee">Inscripci&oacute;n por equipo</label>
                <input type="number" id="cwrPrizeEntryFee" class="cwr-input" min="0" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrizeHouseCut">Comisi&oacute;n de la casa (%)</label>
                <input type="number" id="cwrPrizeHouseCut" class="cwr-input" min="0" max="100" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrizeMvpTokens">Premio MVP (tokens)</label>
                <input type="number" id="cwrPrizeMvpTokens" class="cwr-input" min="0" value="0">
              </div>
            </div>

            <h4 class="cwr-subtitle">Reparto por puesto</h4>
            <div class="cwr-prize-grid">
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrize1Tokens">1&ordm; &mdash; tokens</label>
                <input type="number" id="cwrPrize1Tokens" class="cwr-input" min="0" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrize1Cash">1&ordm; &mdash; dinero</label>
                <input type="number" id="cwrPrize1Cash" class="cwr-input" min="0" step="0.01" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrize2Tokens">2&ordm; &mdash; tokens</label>
                <input type="number" id="cwrPrize2Tokens" class="cwr-input" min="0" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrize2Cash">2&ordm; &mdash; dinero</label>
                <input type="number" id="cwrPrize2Cash" class="cwr-input" min="0" step="0.01" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrize3Tokens">3&ordm; &mdash; tokens</label>
                <input type="number" id="cwrPrize3Tokens" class="cwr-input" min="0" value="0">
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrPrize3Cash">3&ordm; &mdash; dinero</label>
                <input type="number" id="cwrPrize3Cash" class="cwr-input" min="0" step="0.01" value="0">
              </div>
            </div>

            <div class="cwr-prize-field" style="margin-top:0.9rem;">
              <label class="cwr-label" for="cwrPrizeNotes">Notas p&uacute;blicas sobre los premios</label>
              <textarea id="cwrPrizeNotes" class="cwr-textarea" maxlength="400"
                placeholder="Condiciones, patrocinadores, forma de pago&hellip;"></textarea>
            </div>

            <div class="cwr-btn-row">
              <button type="button" class="cwr-btn" id="cwrPrizeAutoSplitBtn">
                <i class="fas fa-calculator"></i> Reparto 50/30/20
              </button>
              <button type="button" class="cwr-btn cwr-btn-primary" id="cwrPrizeSaveBtn">
                <i class="fas fa-bullhorn"></i> Publicar premios en vivo
              </button>
            </div>
          </div>

          <h4 class="cwr-subtitle">Resumen econ&oacute;mico</h4>
          <div id="cwrPrizeSummary"></div>

          <h4 class="cwr-subtitle">Entregas registradas</h4>
          <div id="cwrPrizePayouts"></div>
          <p class="cwr-hint" data-cwr-role="commander">
            <i class="fas fa-info-circle"></i> &laquo;Entregar&raquo; deja constancia p&uacute;blica del premio.
            El abono de tokens a cada jugador se hace en la pesta&ntilde;a <b>Tokens</b>.
          </p>
        </div>

        <!-- Aviso publico -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced" data-cwr-role="commander">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-bullhorn"></i></div>
            <div class="nexus-widget-title">
              <h3>Aviso del Commander</h3>
              <p>Mensaje que ver&aacute; todo el que est&eacute; siguiendo el torneo.</p>
            </div>
          </div>
          <div class="cwr-prize-field">
            <label class="cwr-label" for="cwrNoteInput">Texto del aviso (m&aacute;x. 300)</label>
            <textarea id="cwrNoteInput" class="cwr-textarea" maxlength="300"
              placeholder="Retraso de 15 minutos por revisi&oacute;n del servidor&hellip;"></textarea>
          </div>
          <div class="cwr-btn-row">
            <button type="button" class="cwr-btn cwr-btn-primary" id="cwrNoteSaveBtn">
              <i class="fas fa-paper-plane"></i> Publicar aviso
            </button>
          </div>
        </div>

        <!-- Sentinelas -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-user-secret"></i></div>
            <div class="nexus-widget-title">
              <h3>Sentinelas</h3>
              <p>Vigilantes con permiso limitado: entran solo a esta p&aacute;gina, en lectura, y reportan tramposos.</p>
            </div>
          </div>

          <div id="cwrSentinelDefault"></div>

          <div data-cwr-role="commander">
            <h4 class="cwr-subtitle">Sentinelas nombrados</h4>
            <div id="cwrSentinelList"></div>

            <h4 class="cwr-subtitle">Nombrar un sentinela</h4>
            <div class="cwr-prize-grid">
              <div class="cwr-prize-field cwr-search-wrap" style="grid-column:span 2;">
                <label class="cwr-label" for="cwrSentinelSearchInput">Buscar usuario por nick</label>
                <input type="text" id="cwrSentinelSearchInput" class="cwr-input" autocomplete="off"
                  placeholder="Escribe al menos 2 letras&hellip;">
                <div class="cwr-search-results" id="cwrSentinelSearchResults" style="display:none;"></div>
              </div>
              <div class="cwr-prize-field">
                <label class="cwr-label" for="cwrSentinelScopeSelect">Alcance</label>
                <select id="cwrSentinelScopeSelect" class="cwr-select">
                  <option value="all">Todos los torneos</option>
                  <option value="current">Solo el torneo seleccionado</option>
                </select>
              </div>
            </div>
            <p class="cwr-hint">
              <i class="fas fa-shield-alt"></i> Un sentinela <b>no</b> puede tocar equipos, cuadro, premios ni servidores.
              Solo mira y reporta. Sus permisos viven en <code>security/sentinels</code>.
            </p>
          </div>
        </div>

        <!-- Formulario de reporte (sentinela) -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced" data-cwr-role="sentinel">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-flag"></i></div>
            <div class="nexus-widget-title">
              <h3>Reportar sospecha de trampa</h3>
              <p>Lo que env&iacute;es llega al instante a la bit&aacute;cora del Commander.</p>
            </div>
          </div>
          <div class="cwr-report-form">
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrReportCategory">Tipo</label>
              <select id="cwrReportCategory" class="cwr-select">
                <option value="aimbot">Aimbot</option>
                <option value="wallhack">Wallhack</option>
                <option value="trigger">Triggerbot</option>
                <option value="smurf">Cuenta suplantada / smurf</option>
                <option value="griefing">Sabotaje al equipo</option>
                <option value="toxicidad">Toxicidad</option>
                <option value="otro">Otro</option>
              </select>
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrReportSeverity">Gravedad</label>
              <select id="cwrReportSeverity" class="cwr-select">
                <option value="baja">Baja</option>
                <option value="media" selected>Media</option>
                <option value="alta">Alta</option>
                <option value="critica">Cr&iacute;tica</option>
              </select>
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrReportTeam">Equipo implicado</label>
              <select id="cwrReportTeam" class="cwr-select"></select>
            </div>
            <div class="cwr-prize-field">
              <label class="cwr-label" for="cwrReportSuspect">Jugador sospechoso</label>
              <input type="text" id="cwrReportSuspect" class="cwr-input" maxlength="80" placeholder="Nick en la partida">
            </div>
            <div class="cwr-prize-field cwr-report-form-wide">
              <label class="cwr-label" for="cwrReportNotes">Qu&eacute; viste (obligatorio)</label>
              <textarea id="cwrReportNotes" class="cwr-textarea" maxlength="1000"
                placeholder="Ronda 12: prefire imposible a trav&eacute;s del humo, dos veces seguidas&hellip;"></textarea>
            </div>
            <div class="cwr-prize-field cwr-report-form-wide">
              <label class="cwr-label" for="cwrReportEvidence">Enlace a la prueba (clip, demo, captura)</label>
              <input type="url" id="cwrReportEvidence" class="cwr-input" placeholder="https://&hellip;">
            </div>
          </div>
          <div class="cwr-btn-row">
            <button type="button" class="cwr-btn cwr-btn-primary" id="cwrReportSubmit">
              <i class="fas fa-paper-plane"></i> Enviar reporte
            </button>
          </div>
        </div>

        <!-- Reportes -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-flag-checkered"></i></div>
            <div class="nexus-widget-title">
              <h3>Reportes de los sentinelas</h3>
              <p>Sospechas de trampa recibidas, con la resoluci&oacute;n que tom&oacute; el mando.</p>
            </div>
          </div>
          <div class="cwr-prize-field" style="max-width:280px;">
            <label class="cwr-label" for="cwrReportsFilter">Filtro</label>
            <select id="cwrReportsFilter" class="cwr-select">
              <option value="open">Solo abiertos</option>
              <option value="tournament">De este torneo</option>
              <option value="mine">M&iacute;os</option>
              <option value="all">Todos</option>
            </select>
          </div>
          <div id="cwrReportsList" style="margin-top:0.9rem;"></div>
        </div>

        <!-- Espectadores -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-eye"></i></div>
            <div class="nexus-widget-title">
              <h3>Qui&eacute;n est&aacute; viendo</h3>
              <p>Presencia en vivo del torneo: commanders, sentinelas y espectadores.</p>
            </div>
            <span class="nexus-widget-badge">Live</span>
          </div>
          <div class="cwr-status-strip" id="cwrSpectatorCount" style="margin:0.9rem 0 0;"></div>
          <div id="cwrSpectatorList" style="margin-top:0.9rem;"></div>
        </div>

        <!-- Bitacora -->
        <div class="commander-block nexus-dashboard-widget commander-block-spaced" data-cwr-role="commander">
          <div class="nexus-widget-header">
            <div class="nexus-widget-icon"><i class="fas fa-clipboard-list"></i></div>
            <div class="nexus-widget-title">
              <h3>Bit&aacute;cora del Control Universal</h3>
              <p>&Uacute;ltimos movimientos de mando registrados en <code>security/auditLog</code>.</p>
            </div>
          </div>
          <div id="cwrAuditList"></div>
        </div>
      </section>
`;

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function insertBefore(html, anchor, block, what) {
  const idx = html.indexOf(anchor);
  if (idx === -1) fail('No encuentro el anclaje para ' + what + ': ' + anchor);
  return html.slice(0, idx) + block + html.slice(idx);
}

function insertAfterLine(html, anchor, block, what) {
  const idx = html.indexOf(anchor);
  if (idx === -1) fail('No encuentro el anclaje para ' + what + ': ' + anchor);
  const eol = html.indexOf('\n', idx);
  if (eol === -1) fail('Anclaje sin fin de linea: ' + anchor);
  return html.slice(0, eol + 1) + block + '\n' + html.slice(eol + 1);
}

function main() {
  let html = fs.readFileSync(FILE, 'latin1');
  const done = [];

  if (html.indexOf('commander-warroom.css') === -1) {
    html = insertAfterLine(html, '<link rel="stylesheet" href="commander-panel.css', CSS_LINK, 'hoja de estilos');
    done.push('link CSS');
  }

  if (html.indexOf('data-tab="warroom"') === -1) {
    // La pestana va justo despues de Telemetria, que es la primera del Control Center.
    const telemetryBtn = html.indexOf('data-tab="telemetry"');
    if (telemetryBtn === -1) fail('No encuentro el boton de pestana de Telemetria.');
    const closeTag = html.indexOf('</button>', telemetryBtn);
    if (closeTag === -1) fail('No encuentro el cierre del boton de Telemetria.');
    const cut = closeTag + '</button>'.length;
    html = html.slice(0, cut) + '\n' + TAB_BUTTON + html.slice(cut);
    done.push('boton de pestana');
  }

  if (html.indexOf('id="tab-warroom"') === -1) {
    html = insertBefore(html, '      <!-- PANEL: USUARIOS -->', SECTION, 'seccion del panel');
    done.push('seccion HTML');
  }

  if (html.indexOf('commander-warroom.js') === -1) {
    html = insertBefore(html, '  <script src="/commander-panel.js', SCRIPT_TAG + '\n', 'script');
    done.push('script');
  }

  if (!done.length) {
    console.log('Nada que hacer: la pestana Control Universal ya esta instalada.');
    return;
  }

  fs.writeFileSync(FILE, html, 'latin1');
  console.log('Instalado en commander-panel.html: ' + done.join(', ') + '.');
}

main();
