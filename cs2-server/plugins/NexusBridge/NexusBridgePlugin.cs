using System.Net.Http;
using System.Text;
using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;

namespace NexusBridge;

/// <summary>
/// Posts CS2 match events to the CS2 Nexus Bridge API.
/// Deploy to: csgo/addons/counterstrikesharp/plugins/NexusBridge/
/// </summary>
public class NexusBridgePlugin : BasePlugin
{
    public override string ModuleName => "Nexus Bridge";
    public override string ModuleVersion => "1.1.0";

    private const int TeamT = (int)CsTeam.Terrorist;
    private const int TeamCT = (int)CsTeam.CounterTerrorist;

    private static readonly HttpClient Http = new();
    private string _webhookUrl = "";
    private string _webhookSecret = "";
    private string _tournamentId = "";
    private string _matchId = "";
    private long _matchStartUnix;
    private int _roundsPlayed;
    private bool _matchEndSent;

    private sealed class PlayerStat
    {
        public string Name = "";
        public int Kills;
        public int Deaths;
        public int Assists;
        public int Damage;
        public int RoundMvps;
    }

    /// <summary>
    /// Keyed by SteamID64, which is what links a player to a Studiosgamesrs
    /// account. Steam names can be changed mid-match and can collide.
    /// </summary>
    private readonly Dictionary<string, PlayerStat> _stats = new();

    public override void Load(bool hotReload)
    {
        LoadBridgeEnv();
        RegisterEventHandler<EventRoundEnd>(OnRoundEnd);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventPlayerHurt>(OnPlayerHurt);
        RegisterEventHandler<EventRoundMvp>(OnRoundMvp);
        RegisterEventHandler<EventCsWinPanelMatch>(OnMatchEnd);
        RegisterListener<Listeners.OnMapStart>(OnMapStart);

        AddCommand("css_nexus_setcontext", "Set tournament/match context", CommandSetContext);
    }

    private void LoadBridgeEnv()
    {
        _webhookUrl = Environment.GetEnvironmentVariable("BRIDGE_WEBHOOK_URL") ?? "";
        _webhookSecret = Environment.GetEnvironmentVariable("WEBHOOK_SECRET") ?? "";
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
        }
    }

    private void CommandSetContext(CCSPlayerController? player, CommandInfo info)
    {
        if (info.ArgCount < 3) return;
        _tournamentId = info.GetArg(1);
        _matchId = info.GetArg(2);
        ResetMatchState();
        // Reported so the War Room can prove which plugin build the server loaded:
        // a snapshot boot silently keeps the old DLL if the rebuild fails.
        _ = PostEventAsync(new
        {
            @event = "match_start",
            tournamentId = _tournamentId,
            matchId = _matchId,
            pluginVersion = ModuleVersion,
        });
    }

    private void OnMapStart(string mapName)
    {
        ResetMatchState();
    }

    private void ResetMatchState()
    {
        _stats.Clear();
        _roundsPlayed = 0;
        _matchEndSent = false;
        _matchStartUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    }

    private static string? SteamKey(CCSPlayerController? player)
    {
        if (player == null || !player.IsValid || player.IsBot || player.IsHLTV) return null;
        var id = player.SteamID;
        return id > 0 ? id.ToString() : null;
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
        return stat;
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
                kills = stat.Kills,
                deaths = stat.Deaths,
                assists = stat.Assists,
                damage = stat.Damage,
                roundMvps = stat.RoundMvps,
            };
        }
        return payload;
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
        _roundsPlayed += 1;
        var (ct, t) = TeamScores();

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
        var victimKey = SteamKey(victim);
        if (victimKey != null) StatFor(victim!, victimKey).Deaths += 1;

        var attacker = ev.Attacker;
        var attackerKey = SteamKey(attacker);
        if (attackerKey != null && attackerKey != victimKey && !SameTeam(attacker, victim))
        {
            StatFor(attacker!, attackerKey).Kills += 1;
        }

        var assister = ev.Assister;
        var assisterKey = SteamKey(assister);
        if (assisterKey != null && assisterKey != victimKey && !SameTeam(assister, victim))
        {
            StatFor(assister!, assisterKey).Assists += 1;
        }

        _ = PostEventAsync(new
        {
            @event = "kill",
            tournamentId = _tournamentId,
            matchId = _matchId,
            killer = attackerKey == null ? null : attacker!.PlayerName,
            killerSteamId = attackerKey,
            kills = KillsByName(),
        });
        return HookResult.Continue;
    }

    private HookResult OnPlayerHurt(EventPlayerHurt ev, GameEventInfo info)
    {
        var attacker = ev.Attacker;
        var attackerKey = SteamKey(attacker);
        if (attackerKey == null) return HookResult.Continue;

        var victim = ev.Userid;
        if (attackerKey == SteamKey(victim) || SameTeam(attacker, victim)) return HookResult.Continue;

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
        var key = SteamKey(player);
        if (key != null) StatFor(player!, key).RoundMvps += 1;

        _ = PostEventAsync(new
        {
            @event = "mvp",
            tournamentId = _tournamentId,
            matchId = _matchId,
            mvp = player?.PlayerName,
            mvpSteamId = key,
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
