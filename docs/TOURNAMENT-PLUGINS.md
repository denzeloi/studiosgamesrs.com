# Configuración de los plugins de torneo (CS2)

Guía operativa para cambiar el comportamiento de los servidores de torneo:
MatchZy, CounterStrikeSharp, Metamod, Fake RCON y NexusBridge.

**Regla clave:** los servidores de CS2 son desechables. Se crean con
**Provision Server** y se destruyen con **Shutdown**. Por eso *nunca* se
configura un servidor a mano: se edita el repo, se despliegan las Cloud
Functions, y el próximo servidor nace ya configurado.

**cPanel no participa en esto.** cPanel solo sirve el sitio antiguo y
`steam_login.php`. La configuración de plugins viaja por Firebase → Vultr.

---

## Cómo llega la configuración al servidor

```
repo (tu PC)
  └── cs2-server/cfg/MatchZy/*.cfg
  └── cs2-server/plugins/NexusBridge/
  └── functions/cs2-nexus/install-plugins.sh
  └── scripts/cs2-ensure-metamod.sh
        │
        │  npm run deploy:functions
        ▼
Cloud Functions "cs2-nexus"   ← lib/cloud-init-pack.js empaqueta todo en un YAML
        │
        │  Provision Server (desde la web)
        ▼
VM nueva en Vultr Miami       ← cloud-init escribe los archivos y ejecuta install-plugins.sh
```

`lib/cloud-init-pack.js` es el empaquetador. Lee los archivos del repo y los
incrusta como `write_files` en el `user-data` de la VM.

---

## Qué archivo editar según lo que quieras cambiar

| Quiero cambiar | Edita | Se aplica en |
|---|---|---|
| Reglas de partida: knife, jugadores listos, demos, nombre del server | `cs2-server/cfg/MatchZy/config.cfg` | Próximo Provision |
| Calentamiento: duración, freezetime | `cs2-server/cfg/MatchZy/warmup.cfg` | Próximo Provision |
| Ronda de cuchillo | `cs2-server/cfg/MatchZy/knife.cfg` | Próximo Provision |
| Partida en vivo: rondas, overtime, halftime | `cs2-server/cfg/MatchZy/live.cfg` | Próximo Provision |
| Versión de MatchZy / CSSharp / Metamod | URLs al inicio de `functions/cs2-nexus/install-plugins.sh` | Próximo Provision |
| Cómo se instalan los plugins | `functions/cs2-nexus/install-plugins.sh` | Próximo Provision |
| Eventos que el server manda a la web | `cs2-server/plugins/NexusBridge/NexusBridgePlugin.cs` | Próximo Provision |
| `hostname`, `tv_delay`, `sv_password`, GSLT | heredoc `server.cfg` dentro de `cloud-init.sh` **y** `cloud-init-snapshot.sh` | Próximo Provision |
| Tokens y contraseñas (Vultr, RCON, GSLT, webhook) | `functions/.env` (nunca se sube a Git) | Próximo deploy |

> **Trampa importante:** el archivo `cs2-server/cfg/server.cfg` del repo es solo
> una copia de referencia; **nadie lo lee**. El `server.cfg` real está escrito
> como heredoc dentro de `cloud-init.sh` (línea ~136) y `cloud-init-snapshot.sh`
> (línea ~91). Si cambias uno, cambia el otro, o el arranque por snapshot y el
> arranque completo quedarán distintos.

Solo los `.cfg` de la carpeta `MatchZy/` se copian desde el repo
(`/root/matchzy-cfg/` → `csgo/cfg/MatchZy/`).

---

## Procedimiento para cambiar la configuración

1. Edita el archivo correspondiente de la tabla.
2. Verifica que el paquete sigue siendo válido:

```bash
npm run verify:cloudinit
```

3. Despliega:

```bash
npm run deploy:functions
```

4. En la web: **Shutdown Server** (si hay uno activo) y luego **Provision Server**.
   La configuración nueva solo entra en servidores creados *después* del deploy.
5. Comprueba en el servidor nuevo que los plugins cargaron:

```bash
mcrcon -H IP -P 27015 -p 'TU_RCON' "meta list"
mcrcon -H IP -P 27015 -p 'TU_RCON' "css_plugins list"
```

Debes ver Metamod con Fake RCON y CounterStrikeSharp, y en la lista de plugins
`MatchZy` y `NexusBridge`.

---

## Reglas al editar los archivos

- **Finales de línea LF, nunca CRLF.** Estos archivos se ejecutan tal cual en
  Linux. Un `\r` de Windows rompe bash (`$'\r': command not found`) y convierte
  un valor de cvar en `2\r`. `.gitattributes` ya fuerza `* -text`, pero si tu
  editor guarda CRLF el daño ocurre igual. `npm run verify:cloudinit` lo detecta.
  Excepción: `.cs` y `.csproj` los compila dotnet y toleran CRLF.
- **El `user-data` tiene un techo de ~64 KB.** El verificador avisa a los 60 KB.
  Si te acercas al límite, mueve trabajo a un script descargado en vez de
  incrustarlo.
- **Nunca pongas secretos en estos archivos.** Van en `functions/.env` y entran
  por los marcadores `__RCON_PASSWORD__`, `__GSLT_TOKEN__`, `__WEBHOOK_SECRET__`
  y `__BRIDGE_WEBHOOK_URL__`, que `cloud-init-pack.js` sustituye al desplegar.

---

## Los dos modos de arranque

`cloud-init-pack.js` elige según `VULTR_SNAPSHOT_ID` en `functions/.env`:

| Modo | Cuándo | Script | Tiempo |
|---|---|---|---|
| Snapshot | `VULTR_SNAPSHOT_ID` tiene valor | `cloud-init-snapshot.sh` | ~1–3 min |
| Instalación completa | `VULTR_SNAPSHOT_ID` vacío | `cloud-init.sh` | ~30–45 min |

En modo snapshot los plugins ya vienen en la imagen, pero `install-plugins.sh`
se vuelve a ejecutar para refrescar CounterStrikeSharp y los `.cfg` de MatchZy.
Por eso un cambio de configuración **no** obliga a recrear el snapshot.

Sí conviene recrear el snapshot (`npm run snapshot:create`) cuando cambies la
versión de CS2 o de Metamod, para no pagar la reinstalación en cada arranque.

---

## Por qué existen Metamod y Fake RCON

El RCON nativo de CS2 no funciona. Fake RCON, que es un plugin de Metamod,
restaura el RCON estándar por TCP 27015, y es así como las Cloud Functions
mandan los comandos de `launch` y leen el marcador. **Si Metamod no carga, el
torneo no se puede controlar desde la web.**

La cadena es frágil porque una actualización de CS2 sobreescribe `libserver.so`
y borra el enlace de Metamod. Hay tres defensas:

1. `install-plugins.sh` → `patch_gameinfo_metamod()` deja `csgo/addons/metamod`
   de primero en `SearchPaths` de `gameinfo.gi`.
2. `scripts/cs2-ensure-metamod.sh` → corre como `ExecStartPre` de
   `cs2-server.service` en **cada** arranque y rehace el symlink y el parche.
3. `scripts/fix-metamod-on-server.sh` → reparación manual por SSH cuando un
   servidor ya está roto.

---

## Diagnóstico

Todo por SSH como `root` en la VM.

| Síntoma | Revisa |
|---|---|
| Plugins no cargan | `grep -n -E 'LowViolence\|metamod' /home/cs2/cs2-server/game/csgo/gameinfo.gi` — la línea de metamod va **después** de `Game_LowViolence` |
| RCON no responde | `mcrcon -H 127.0.0.1 -P 27015 -p 'TU_RCON' status` desde la propia VM |
| MatchZy ignora la config | `cat /home/cs2/cs2-server/game/csgo/cfg/MatchZy/config.cfg` y `ls /root/matchzy-cfg/` |
| Falló la instalación | `cat /var/log/cs2-nexus-plugins.log` |
| Falló el arranque | `cat /var/log/cs2-nexus-install.log`, `journalctl -u cs2-server -n 80 --no-pager` |
| Jugador no puede entrar | `bash /usr/local/bin/open-cs2-ports.sh` (CS2 necesita **UDP** 27015) |

Reparación rápida de Metamod sin recrear el servidor:

```bash
bash /root/fix-metamod-on-server.sh
systemctl restart cs2-server
sleep 90
mcrcon -H 127.0.0.1 -P 27015 -p 'TU_RCON' "meta list"
```

---

## Documentos relacionados

- [ARCHITECTURE.md](./ARCHITECTURE.md) — cómo encaja todo
- [DEPLOYMENT.md](./DEPLOYMENT.md) — checklist de despliegue
- [MANUAL-SNAPSHOT.md](./MANUAL-SNAPSHOT.md) — crear la imagen dorada
- [SNAPSHOT.md](./SNAPSHOT.md) — flujo automatizado de snapshot
