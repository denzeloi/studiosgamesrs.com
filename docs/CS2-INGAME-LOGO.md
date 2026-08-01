# Logo de Studiosgamesrs dentro del juego (mp_teamlogo)

Cómo se ve el logo en la barra de puntaje y el scoreboard de CS2, qué parte
ya está automatizada, y el único paso manual que queda (publicar el logo en
el Steam Workshop) porque necesita una cuenta de Steam real.

**CS2 no tiene FastDL.** Se probó en vivo contra un servidor real:
`sv_downloadurl` responde `Unknown command` y `find download` no lista nada.
Todo lo que sigue existe porque Valve quitó ese mecanismo y la única forma
de hacerle llegar contenido personalizado a *cualquier* jugador que se
conecta es un addon de Steam Workshop montado con el plugin
`MultiAddonManager`.

---

## Qué ya funciona sin que hagas nada

- `mp_teamlogo_1` / `mp_teamlogo_2` quedan en `sgrs` en todo servidor nuevo
  (instalación completa o snapshot) y se reenvían por RCON en cada chequeo.
- Los 3 archivos del logo (`cs2-fastdl/materials/...sgrs.svg`,
  `...sgrs.png`, `cs2-fastdl/resource/flash/econ/...sgrs.png`) se descargan
  al disco del propio servidor en el arranque.
- El plugin `MultiAddonManager` se instala junto con Metamod/CSSharp/MatchZy.
- `cfg/multiaddonmanager/multiaddonmanager.cfg` se escribe siempre, con
  `mm_extra_addons` vacío hasta que exista un ID de Workshop.

Con esto, el logo ya se ve:

- Para ti, como operador del servidor.
- Para cualquiera que copie esos mismos 3 archivos en su propia instalación
  de CS2, en las mismas rutas relativas dentro de `csgo/` (Panorama busca el
  material por nombre local, sin red de por medio).

**No** se ve todavía para un jugador cualquiera que se conecta sin haber
hecho ese paso a mano. Para eso sigue el Workshop.

---

## El paso manual: publicar el logo en el Steam Workshop

Esto **tiene que hacerlo una persona con una cuenta de Steam real**, desde
una PC con CS2 instalado. No es automatizable: "CS2 Workshop Tools" es una
herramienta gráfica dentro del propio juego, no una API ni un script.

Toma unos 15-20 minutos, una sola vez.

1. En Steam, clic derecho sobre **Counter-Strike 2** → **Propiedades** →
   pestaña **DLC** → activa **Counter-Strike 2 - Herramientas de Workshop**.
   Steam descarga unos GB adicionales.
2. Abre CS2 y en el launcher elige la opción de **Workshop Tools** (no el
   juego normal).
3. En Workshop Tools, **Create New Addon**, ponle un nombre (por ejemplo
   `studiosgamesrs-logo`). Esto crea una carpeta en:
   `.../Counter-Strike Global Offensive/content/csgo_addons/studiosgamesrs-logo/`
4. Copia los 3 archivos de `cs2-fastdl/` de este repo dentro de esa carpeta,
   **respetando las mismas rutas relativas**:
   - `cs2-fastdl/materials/panorama/images/tournaments/teams/sgrs.svg`
     → `.../studiosgamesrs-logo/materials/panorama/images/tournaments/teams/sgrs.svg`
   - `cs2-fastdl/materials/panorama/images/tournaments/teams/sgrs.png`
     → misma ruta, dentro del addon
   - `cs2-fastdl/resource/flash/econ/tournaments/teams/sgrs.png`
     → misma ruta, dentro del addon
5. En Workshop Tools: **Tools → Workshop Manager** → **New**. Completa
   título, descripción e imagen de vista previa (puede ser el mismo logo).
   Visibilidad: **Público** (o "Solo amigos" si prefieres probarlo antes).
6. **Submit**. Steam sube el addon y, tras aprobarlo (normalmente minutos,
   a veces unas horas), te da una URL como:
   `steamcommunity.com/sharedfiles/filedetails/?id=3157463861`
   Ese número al final, **`3157463861`**, es el ID que necesitas.

---

## Conectar el ID de Workshop

Con el ID en mano, hay dos formas de aplicarlo, y conviene hacer ambas:

### 1. Para que todo servidor nuevo lo traiga de fábrica

Define la variable de entorno antes de desplegar las Cloud Functions (mismo
lugar que `RCON_PASSWORD`, `WEBHOOK_SECRET`, etc. — ver `.env.example`):

```
CS2_LOGO_WORKSHOP_ID=3157463861
```

`lib/rcon.js` la lee como `CS2_LOGO_WORKSHOP_ID` (Cloud Functions);
`install-plugins.sh` y `fix-metamod-on-server.sh` la leen como
`NEXUS_LOGO_WORKSHOP_ID` (arranque de la VM) — asegúrate de definirla con
ambos nombres donde corresponda, o de pasarla como argumento al script de
cloud-init si lo automatizas.

### 2. Para que un servidor que ya está en vivo lo aplique ahora mismo

```bash
RCON_PASSWORD=... NEXUS_LOGO_WORKSHOP_ID=3157463861 \
  node -e "require('./functions/cs2-nexus/lib/rcon.js').brandServer('IP', 27015, process.env.RCON_PASSWORD).then(r => console.log(r))"
```

El plugin necesita un cambio de mapa para montar el addon nuevo
(`mm_extra_addons` "solo se ejecuta una vez al cargar el plugin" según su
propia documentación) — si no se ve de inmediato, un `changelevel` al mismo
mapa o esperar al siguiente mapa de la rotación lo aplica.

---

## Sobre la experiencia del jugador (qué se puede y qué no)

`MultiAddonManager` es la única vía que da CS2 hoy para este caso, y **no
es invisible**: al primer jugador que se conecta y no tiene el addon, el
cliente le muestra un aviso de "este servidor usa contenido de Workshop,
¿descargar?" — el mismo tipo de aviso que ya ven al entrar a un servidor con
un mapa de Workshop personalizado. No hay forma de suprimir ese primer
aviso; es una limitación de la plataforma, no de esta implementación.

Lo que sí se puede — y ya está configurado — es hacerlo lo menos molesto
posible:

- El logo pesa menos de 45 KB en total, así que la descarga es casi
  instantánea una vez que el jugador acepta.
- `mm_cache_clients_with_addons 1` hace que, una vez que un jugador ya lo
  descargó, no le vuelva a aparecer el aviso al reconectarse o cambiar de
  mapa.

Esto es, en la práctica, lo mismo que usan los servidores competitivos de
CS2 que muestran contenido personalizado en el HUD — no existe hoy una
opción de CS2 que reparta un archivo a un jugador sin que él lo sepa.

---

## Documentos relacionados

- [TOURNAMENT-PLUGINS.md](./TOURNAMENT-PLUGINS.md) — cómo llega cualquier
  configuración al servidor
- [ARCHITECTURE.md](./ARCHITECTURE.md) — cómo encaja todo
