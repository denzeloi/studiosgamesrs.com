using System.Net.Http;
using System.Text;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace NexusBridge;

/// <summary>
/// Posts CS2 match events to the CS2 Nexus Bridge API.
/// Deploy to: csgo/addons/counterstrikesharp/plugins/NexusBridge/
/// </summary>
public class NexusBridgePlugin : BasePlugin
{
    public override string ModuleName => "Nexus Bridge";
    public override string ModuleVersion => "1.4.0";

    private const int TeamT = (int)CsTeam.Terrorist;
    private const int TeamCT = (int)CsTeam.CounterTerrorist;

    /// <summary>
    /// El feed de bajas de la sala solo enseña las últimas: mandar el historial
    /// entero en cada muerte multiplicaría el peso del evento por el número de
    /// rondas sin que nadie llegue a leer lo de hace diez minutos.
    /// </summary>
    private const int RecentKillsMax = 8;

    /// <summary>
    /// Cada cuánto se repasa quién está dentro sin que nadie haya entrado ni
    /// salido. Los eventos de conexión bastan cuando llegan, pero un webhook
    /// perdido o un arranque a medias dejaba la sala en blanco hasta la
    /// siguiente conexión. El parte solo se manda si la lista cambió.
    /// </summary>
    private const float LobbyHeartbeatSeconds = 5.0f;

    private static readonly HttpClient Http = new();
    private string _webhookUrl = "";
    private string _webhookSecret = "";
    private string _tournamentId = "";
    private string _matchId = "";
    private long _matchStartUnix;
    private int _roundsPlayed;
    private bool _matchEndSent;
    private bool _lobbyQueued;
    private bool _inWarmup = true;
    private string _lobbySignature = "";

    private sealed class PlayerStat
    {
        public string Name = "";
        public string Side = "SPEC";
        public bool IsBot;
        public int Kills;
        public int Deaths;
        public int Assists;
        public int Damage;
        public int RoundMvps;
    }

    private readonly List<object> _recentKills = new();

    /// <summary>
    /// Keyed by SteamID64, which is what links a player to a Studiosgamesrs
    /// account. Steam names can be changed mid-match and can collide.
    /// </summary>
    private readonly Dictionary<string, PlayerStat> _stats = new();

    public override void Load(bool hotReload)
    {
        LoadBridgeEnv();
        RegisterEventHandler<EventRoundStart>(OnRoundStart);
        RegisterEventHandler<EventRoundEnd>(OnRoundEnd);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventPlayerHurt>(OnPlayerHurt);
        RegisterEventHandler<EventRoundMvp>(OnRoundMvp);
        RegisterEventHandler<EventCsWinPanelMatch>(OnMatchEnd);
        // La sala enseña quién va entrando al servidor durante el calentamiento,
        // que es justo cuando nadie ha matado a nadie todavía y el marcador no
        // tiene nada que contar.
        RegisterEventHandler<EventPlayerConnectFull>(OnPlayerConnectFull);
        RegisterEventHandler<EventPlayerDisconnect>(OnPlayerDisconnect);
        RegisterEventHandler<EventPlayerTeam>(OnPlayerTeam);
        RegisterListener<Listeners.OnMapStart>(OnMapStart);

        AddCommand("css_nexus_setcontext", "Set tournament/match context", CommandSetContext);

        // El repaso periódico es lo que hace que la sala se llene sola: sin él,
        // quien ya estaba dentro cuando arrancó el plugin no aparecía hasta que
        // otro jugador entrara y disparara un evento.
        AddTimer(LobbyHeartbeatSeconds, SendLobbyReport, TimerFlags.REPEAT);
    }

    private void LoadBridgeEnv()
    {
        _webhookUrl = Environment.GetEnvironmentVariable("BRIDGE_WEBHOOK_URL") ?? "";
        _webhookSecret = Environment.GetEnvironmentVariable("WEBHOOK_SECRET") ?? "";
        _tournamentId = Environment.GetEnvironmentVariable("NEXUS_TOURNAMENT_ID") ?? "";
        _matchId = Environment.GetEnvironmentVariable("NEXUS_MATCH_ID") ?? "";
        var envPath = "/etc/cs2-nexus/bridge.env";
        if (!File.Exists(envPath)) return;
        foreach (var line in File.ReadAllLines(envPath))
        {
            if (string.IsNullOrWhiteSpace(line) || line.StartsWith('#')) continue;
            var idx = line.IndexOf('=');
            if (idx < 1) continue;
            var key = line[..idx].Trim();
            var val = line[(idx + 1)..].Trim();
            if (key == "BRIDGE_WEBHOOK_URL" && string.IsNullOrEmpty(_webhookUrl)) _webhookUrl = val;
            if (key == "WEBHOOK_SECRET" && string.IsNullOrEmpty(_webhookSecret)) _webhookSecret = val;
            // El cruce al que pertenece la máquina se fija al aprovisionarla.
            // Antes solo llegaba por RCON al lanzar la partida, así que un
            // servidor recién levantado descartaba todo lo que pasara dentro:
            // el jugador que entraba a calentar no existía para la sala.
            if (key == "NEXUS_TOURNAMENT_ID" && string.IsNullOrEmpty(_tournamentId)) _tournamentId = val;
            if (key == "NEXUS_MATCH_ID" && string.IsNullOrEmpty(_matchId)) _matchId = val;
        }
    }

    private void CommandSetContext(CCSPlayerController? player, CommandInfo info)
    {
        if (info.ArgCount < 3) return;
        _tournamentId = info.GetArg(1);
        _matchId = info.GetArg(2);
        ResetMatchState();
        // La consola tiene que contestar algo reconocible: si el servidor
        // arrancó con el DLL viejo, el comando no existe y RCON devuelve
        // "Unknown command". Sin esta respuesta las dos situaciones se veían
        // exactamente igual desde fuera.
        info.ReplyToCommand("NexusBridge " + ModuleVersion + " context " + _tournamentId + " " + _matchId);
        // Reported so the War Room can prove which plugin build the server loaded:
        // a snapshot boot silently keeps the old DLL if the rebuild fails.
        _ = PostEventAsync(new
        {
            @event = "match_start",
            tournamentId = _tournamentId,
            matchId = _matchId,
            pluginVersion = ModuleVersion,
        });
        // Al fijar el contexto puede haber gente dentro desde antes: sin este
        // primer parte la sala no vería a nadie hasta la siguiente conexión.
        QueueLobbyReport();
    }

    private void OnMapStart(string mapName)
    {
        ResetMatchState();
    }

    private void ResetMatchState()
    {
        _stats.Clear();
        _recentKills.Clear();
        _roundsPlayed = 0;
        _matchEndSent = false;
        _inWarmup = true;
        // Forzar el siguiente parte: el mapa cambia pero puede seguir dentro la
        // misma gente, y sin esto la firma coincidiría y la sala se quedaría con
        // la plantilla del mapa anterior.
        _lobbySignature = "";
        _matchStartUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    }

    private static string? SteamKey(CCSPlayerController? player)
    {
        if (player == null || !player.IsValid || player.IsBot || player.IsHLTV) return null;
        var id = player.SteamID;
        return id > 0 ? id.ToString() : null;
    }

    /// <summary>
    /// Clave de la tabla de estadísticas. Los bots no tienen cuenta de Steam y
    /// aun así ocupan un hueco del equipo durante las pruebas, así que entran
    /// con una clave propia: el puente los publica marcados y nunca les asigna
    /// un usuario de Studiosgamesrs, que es lo que hay que proteger.
    /// </summary>
    private static string? StatKey(CCSPlayerController? player)
    {
        if (player == null || !player.IsValid || player.IsHLTV) return null;
        if (player.IsBot)
        {
            var botName = player.PlayerName;
            return string.IsNullOrEmpty(botName) ? null : "bot:" + botName;
        }
        var id = player.SteamID;
        return id > 0 ? id.ToString() : null;
    }

    private static string SideName(int teamNum)
    {
        if (teamNum == TeamCT) return "CT";
        if (teamNum == TeamT) return "T";
        return "SPEC";
    }

    private PlayerStat StatFor(CCSPlayerController player, string steamKey)
    {
        if (!_stats.TryGetValue(steamKey, out var stat))
        {
            stat = new PlayerStat();
            _stats[steamKey] = stat;
        }
        var name = player.PlayerName;
        if (!string.IsNullOrEmpty(name)) stat.Name = name;
        stat.Side = SideName(player.TeamNum);
        stat.IsBot = player.IsBot;
        return stat;
    }

    /// <summary>
    /// Da de alta a todo el que está dentro antes de armar un parte.
    ///
    /// Sin esto la tabla solo tenía a quien hubiera matado o muerto: los cinco
    /// de un equipo aparecían de uno en uno según iban entrando en la acción, y
    /// el bando de cada uno se quedaba con el que tenía al hacer su primera
    /// baja, que después del cambio de mitad es el contrario.
    /// </summary>
    private void RefreshLivePlayers()
    {
        try
        {
            foreach (var player in Utilities.GetPlayers())
            {
                var key = StatKey(player);
                if (key == null) continue;
                StatFor(player, key);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[NexusBridge] roster refresh failed: " + ex.Message);
        }
    }

    /// <summary>Kills keyed by display name, kept for the War Room kill board.</summary>
    private Dictionary<string, int> KillsByName()
    {
        var byName = new Dictionary<string, int>();
        foreach (var stat in _stats.Values)
        {
            if (stat.Kills <= 0) continue;
            var name = string.IsNullOrEmpty(stat.Name) ? "unknown" : stat.Name;
            byName[name] = byName.GetValueOrDefault(name) + stat.Kills;
        }
        return byName;
    }

    private Dictionary<string, object> PlayersPayload()
    {
        var payload = new Dictionary<string, object>();
        foreach (var entry in _stats)
        {
            var stat = entry.Value;
            payload[entry.Key] = new
            {
                name = stat.Name,
                side = stat.Side,
                bot = stat.IsBot,
                kills = stat.Kills,
                deaths = stat.Deaths,
                assists = stat.Assists,
                damage = stat.Damage,
                roundMvps = stat.RoundMvps,
            };
        }
        return payload;
    }

    /// <summary>
    /// Parte de quién está dentro del servidor, agrupado por bando.
    ///
    /// Es lo único que la sala puede enseñar durante el calentamiento: hasta la
    /// primera ronda no hay marcador, y el jugador que espera necesita ver si
    /// sus cuatro compañeros ya entraron o sigue faltando alguien.
    /// </summary>
    private void SendLobbyReport()
    {
        if (string.IsNullOrEmpty(_matchId)) return;

        var connected = new List<object>();
        var signature = new StringBuilder();
        try
        {
            foreach (var player in Utilities.GetPlayers())
            {
                if (player == null || !player.IsValid || player.IsHLTV) continue;
                var steamId = SteamKey(player);
                var name = player.PlayerName ?? "";
                var side = SideName(player.TeamNum);
                connected.Add(new
                {
                    steamId,
                    name,
                    side,
                    bot = player.IsBot,
                });
                signature.Append(steamId ?? name).Append(':').Append(side).Append('|');
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[NexusBridge] lobby read failed: " + ex.Message);
            return;
        }

        // El latido pasa cada pocos segundos y casi siempre encuentra lo mismo.
        // Publicar igualmente sería un webhook por servidor cada cinco segundos
        // durante toda la partida para reescribir un nodo idéntico.
        var stamp = signature.ToString();
        if (stamp == _lobbySignature) return;
        _lobbySignature = stamp;

        _ = PostEventAsync(new
        {
            @event = "lobby",
            tournamentId = _tournamentId,
            matchId = _matchId,
            phase = _roundsPlayed > 0 ? "live" : "warmup",
            pluginVersion = ModuleVersion,
            connected,
        });
    }

    /// <summary>
    /// Un cambio de equipo mueve a diez jugadores de golpe y cada conexión
    /// dispara varios eventos seguidos. Se agrupan en un solo parte para no
    /// mandar veinte webhooks por lo mismo.
    /// </summary>
    private void QueueLobbyReport()
    {
        if (_lobbyQueued) return;
        _lobbyQueued = true;
        AddTimer(1.0f, () =>
        {
            _lobbyQueued = false;
            SendLobbyReport();
        });
    }

    private HookResult OnPlayerConnectFull(EventPlayerConnectFull ev, GameEventInfo info)
    {
        QueueLobbyReport();
        return HookResult.Continue;
    }

    private HookResult OnPlayerDisconnect(EventPlayerDisconnect ev, GameEventInfo info)
    {
        QueueLobbyReport();
        return HookResult.Continue;
    }

    private HookResult OnPlayerTeam(EventPlayerTeam ev, GameEventInfo info)
    {
        QueueLobbyReport();
        return HookResult.Continue;
    }

    private static bool IsWarmup()
    {
        try
        {
            var proxy = Utilities
                .FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules")
                .FirstOrDefault();
            return proxy?.GameRules?.WarmupPeriod ?? false;
        }
        catch (Exception ex)
        {
            Console.WriteLine("[NexusBridge] warmup read failed: " + ex.Message);
            return false;
        }
    }

    /// <summary>
    /// El calentamiento se juega y se mata, y la sala lo enseña porque es lo
    /// que está pasando en el servidor. Pero eso no son las estadísticas de la
    /// partida: al levantarse el calentamiento la cuenta vuelve a cero, o el
    /// primer round arrancaría con quince bajas de nadie.
    /// </summary>
    private HookResult OnRoundStart(EventRoundStart ev, GameEventInfo info)
    {
        var warm = IsWarmup();
        if (_inWarmup && !warm)
        {
            _stats.Clear();
            _recentKills.Clear();
            _roundsPlayed = 0;
            _matchStartUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        }
        _inWarmup = warm;
        return HookResult.Continue;
    }

    private static (int Ct, int T) TeamScores()
    {
        var teams = Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager").ToList();
        var ct = teams.FirstOrDefault(team => team.TeamNum == TeamCT)?.Score ?? 0;
        var t = teams.FirstOrDefault(team => team.TeamNum == TeamT)?.Score ?? 0;
        return (ct, t);
    }

    private static List<string> SteamIdsOnTeam(int teamNum)
    {
        var ids = new List<string>();
        try
        {
            foreach (var player in Utilities.GetPlayers())
            {
                if (player.TeamNum != teamNum) continue;
                var key = SteamKey(player);
                if (key != null) ids.Add(key);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[NexusBridge] roster read failed: " + ex.Message);
        }
        return ids;
    }

    private HookResult OnRoundEnd(EventRoundEnd ev, GameEventInfo info)
    {
        // Una ronda de calentamiento no es una ronda: publicarla movía el
        // marcador y el número de ronda de una partida que no ha empezado.
        if (IsWarmup())
        {
            QueueLobbyReport();
            return HookResult.Continue;
        }

        _roundsPlayed += 1;
        var (ct, t) = TeamScores();
        RefreshLivePlayers();

        _ = PostEventAsync(new
        {
            @event = "round_end",
            tournamentId = _tournamentId,
            matchId = _matchId,
            round = _roundsPlayed,
            winnerTeamNum = ev.Winner,
            scoreCT = ct,
            scoreT = t,
            // Live CT/T Steam rosters so the public board can remap team labels
            // after knife rounds and the halftime swap.
            ctSteamIds = SteamIdsOnTeam(TeamCT),
            tSteamIds = SteamIdsOnTeam(TeamT),
            durationSeconds = _matchStartUnix > 0
                ? DateTimeOffset.UtcNow.ToUnixTimeSeconds() - _matchStartUnix
                : 0,
            kills = KillsByName(),
            players = PlayersPayload(),
        });
        return HookResult.Continue;
    }

    private HookResult OnPlayerDeath(EventPlayerDeath ev, GameEventInfo info)
    {
        var victim = ev.Userid;
        var victimKey = StatKey(victim);
        if (victimKey != null) StatFor(victim!, victimKey).Deaths += 1;

        var attacker = ev.Attacker;
        var attackerKey = StatKey(attacker);
        var traded = attackerKey != null && attackerKey != victimKey && !SameTeam(attacker, victim);
        if (traded) StatFor(attacker!, attackerKey!).Kills += 1;

        var assister = ev.Assister;
        var assisterKey = StatKey(assister);
        if (assisterKey != null && assisterKey != victimKey && !SameTeam(assister, victim))
        {
            StatFor(assister!, assisterKey).Assists += 1;
        }

        PushRecentKill(attacker, victim, assister, ev.Weapon, ev.Headshot, traded);
        RefreshLivePlayers();
        var (ct, t) = TeamScores();

        _ = PostEventAsync(new
        {
            @event = "kill",
            tournamentId = _tournamentId,
            matchId = _matchId,
            phase = IsWarmup() ? "warmup" : "live",
            killer = attackerKey == null ? null : attacker!.PlayerName,
            killerSteamId = SteamKey(attacker),
            kills = KillsByName(),
            // Con esto la tabla se mueve en cada baja. Antes solo cambiaba al
            // cerrar la ronda: dos minutos de tiroteos con el marcador quieto.
            players = PlayersPayload(),
            recentKills = _recentKills.ToArray(),
            scoreCT = ct,
            scoreT = t,
            roundsPlayed = Math.Max(1, _roundsPlayed),
        });
        return HookResult.Continue;
    }

    /// <summary>
    /// Una línea del kill feed: quién, con qué y a quién. El fuego amigo se
    /// publica igual (pasa y se ve en el servidor), pero marcado, porque no
    /// suma baja a nadie y si no la tabla y el feed no cuadrarían.
    /// </summary>
    private void PushRecentKill(
        CCSPlayerController? attacker,
        CCSPlayerController? victim,
        CCSPlayerController? assister,
        string? weapon,
        bool headshot,
        bool counted)
    {
        if (victim == null || !victim.IsValid) return;
        var hasAttacker = attacker != null && attacker.IsValid;
        _recentKills.Insert(0, new
        {
            at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            killer = hasAttacker ? attacker!.PlayerName : null,
            killerSide = hasAttacker ? SideName(attacker!.TeamNum) : null,
            victim = victim.PlayerName,
            victimSide = SideName(victim.TeamNum),
            assist = assister != null && assister.IsValid ? assister.PlayerName : null,
            weapon = string.IsNullOrEmpty(weapon) ? "world" : weapon,
            headshot,
            friendlyFire = hasAttacker && !counted,
        });
        if (_recentKills.Count > RecentKillsMax)
        {
            _recentKills.RemoveRange(RecentKillsMax, _recentKills.Count - RecentKillsMax);
        }
    }

    private HookResult OnPlayerHurt(EventPlayerHurt ev, GameEventInfo info)
    {
        var attacker = ev.Attacker;
        var attackerKey = StatKey(attacker);
        if (attackerKey == null) return HookResult.Continue;

        var victim = ev.Userid;
        if (attackerKey == StatKey(victim) || SameTeam(attacker, victim)) return HookResult.Continue;

        // DmgHealth is the health actually removed, so overkill can't inflate ADR.
        StatFor(attacker!, attackerKey).Damage += ev.DmgHealth;
        return HookResult.Continue;
    }

    /// <summary>Friendly fire must not pad kills, assists or damage.</summary>
    private static bool SameTeam(CCSPlayerController? a, CCSPlayerController? b)
    {
        if (a == null || b == null || !a.IsValid || !b.IsValid) return false;
        return a.TeamNum == b.TeamNum;
    }

    private HookResult OnRoundMvp(EventRoundMvp ev, GameEventInfo info)
    {
        var player = ev.Userid;
        var key = StatKey(player);
        if (key != null) StatFor(player!, key).RoundMvps += 1;

        _ = PostEventAsync(new
        {
            @event = "mvp",
            tournamentId = _tournamentId,
            matchId = _matchId,
            mvp = player?.PlayerName,
            mvpSteamId = SteamKey(player),
        });
        return HookResult.Continue;
    }

    private HookResult OnMatchEnd(EventCsWinPanelMatch ev, GameEventInfo info)
    {
        if (_matchEndSent) return HookResult.Continue;
        _matchEndSent = true;

        try
        {
            var (ct, t) = TeamScores();
            var winnerSide = ct > t ? "CT" : (t > ct ? "T" : "tie");
            RefreshLivePlayers();

            _ = PostEventAsync(new
            {
                @event = "match_end",
                tournamentId = _tournamentId,
                matchId = _matchId,
                scoreCT = ct,
                scoreT = t,
                winnerSide,
                // Sides swap at halftime, so only the live roster identifies the
                // winners. The bridge maps these SteamIDs back to Nexus teams.
                ctSteamIds = SteamIdsOnTeam(TeamCT),
                tSteamIds = SteamIdsOnTeam(TeamT),
                roundsPlayed = _roundsPlayed,
                durationSeconds = _matchStartUnix > 0
                    ? DateTimeOffset.UtcNow.ToUnixTimeSeconds() - _matchStartUnix
                    : 0,
                players = PlayersPayload(),
                kills = KillsByName(),
            });
        }
        catch (Exception ex)
        {
            Console.WriteLine("[NexusBridge] match_end build failed: " + ex.Message);
        }
        return HookResult.Continue;
    }

    private async Task PostEventAsync(object payload)
    {
        if (string.IsNullOrEmpty(_webhookUrl) || _webhookUrl.StartsWith("/")) return;
        try
        {
            var json = JsonSerializer.Serialize(payload);
            var req = new HttpRequestMessage(HttpMethod.Post, _webhookUrl)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            req.Headers.Add("X-Webhook-Secret", _webhookSecret);
            await Http.SendAsync(req);
        }
        catch (Exception ex)
        {
            Console.WriteLine("[NexusBridge] webhook error: " + ex.Message);
        }
    }
}
