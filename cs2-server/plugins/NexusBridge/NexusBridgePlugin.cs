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
    public override string ModuleVersion => "1.0.0";

    private static readonly HttpClient Http = new();
    private string _webhookUrl = "";
    private string _webhookSecret = "";
    private string _tournamentId = "";
    private string _matchId = "";
    private long _matchStartUnix;
    private readonly Dictionary<string, int> _kills = new();

    public override void Load(bool hotReload)
    {
        LoadBridgeEnv();
        RegisterEventHandler<EventRoundEnd>(OnRoundEnd);
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventRoundMvp>(OnRoundMvp);
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
        _ = PostEventAsync(new { @event = "match_start", tournamentId = _tournamentId, matchId = _matchId });
    }

    private void OnMapStart(string mapName)
    {
        _matchStartUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        _kills.Clear();
    }

    private HookResult OnRoundEnd(EventRoundEnd ev, GameEventInfo info)
    {
        var ct = Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager")
            .FirstOrDefault(t => t.TeamNum == (int)CsTeam.CounterTerrorist)?.Score ?? 0;
        var t = Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager")
            .FirstOrDefault(tm => tm.TeamNum == (int)CsTeam.Terrorist)?.Score ?? 0;

        _ = PostEventAsync(new
        {
            @event = "round_end",
            tournamentId = _tournamentId,
            matchId = _matchId,
            round = ev.Winner,
            scoreCT = ct,
            scoreT = t,
            kills = _kills,
        });
        return HookResult.Continue;
    }

    private HookResult OnPlayerDeath(EventPlayerDeath ev, GameEventInfo info)
    {
        var attacker = ev.Attacker;
        if (attacker == null || !attacker.IsValid) return HookResult.Continue;
        var name = attacker.PlayerName ?? "unknown";
        _kills[name] = _kills.GetValueOrDefault(name) + 1;
        _ = PostEventAsync(new
        {
            @event = "kill",
            tournamentId = _tournamentId,
            matchId = _matchId,
            killer = name,
            kills = _kills,
        });
        return HookResult.Continue;
    }

    private HookResult OnRoundMvp(EventRoundMvp ev, GameEventInfo info)
    {
        _ = PostEventAsync(new
        {
            @event = "mvp",
            tournamentId = _tournamentId,
            matchId = _matchId,
            mvp = ev.Userid?.PlayerName,
        });
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
