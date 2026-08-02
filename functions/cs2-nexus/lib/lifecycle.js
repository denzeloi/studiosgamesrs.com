'use strict';

/**
 * Fin de vida de los servidores de partida.
 * ==========================================================================
 * Hasta ahora una máquina solo se apagaba si el Commander pulsaba Shutdown.
 * Al acabar la partida el registro pasaba a `match_complete` y ahí se quedaba:
 * la máquina seguía encendida en Vultr y facturando toda la noche.
 *
 * Aquí vive solo la decisión, sin tocar red ni base de datos, para poder
 * comprobarla entera en un script:
 *
 *   - al terminar una partida se marca `shutdownAfter` con un margen, que da
 *     tiempo a mirar el marcador final y a que el Commander encadene el
 *     siguiente cruce en la misma máquina si quiere;
 *   - lanzar una partida en esa máquina cancela el apagado pendiente;
 *   - el barrido de cada minuto apaga lo que ya cumplió el plazo, y también
 *     recoge máquinas encendidas que nunca llegaron a jugar;
 *   - por último se comparan las instancias etiquetadas `cs2-nexus` con lo que
 *     hay en la base: lo que sobra en Vultr y no conoce nadie es una máquina
 *     huérfana que solo genera factura.
 *
 * Todo se puede desactivar con CS2_AUTOSHUTDOWN=0 si hace falta dejar un
 * servidor encendido a mano.
 */

const DEFAULT_GRACE_MIN = 15;
const DEFAULT_IDLE_MAX_MIN = 180;
// Margen antes de tocar una instancia que no está en la base: una recién
// creada tarda unos segundos en registrarse, y no se puede confundir con basura.
const DEFAULT_ORPHAN_MIN_AGE_MIN = 30;

/** Estados en los que la máquina ya no está jugando nada. */
const FINISHED_STATUSES = ['match_complete', 'stopped', 'error', 'rcon_timeout'];

/** Estados de una máquina viva que aún no ha jugado. */
const IDLE_STATUSES = ['online', 'booting', 'provisioning'];

function envNumber(env, name, fallback, min, max) {
  const raw = Number((env || {})[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function autoShutdownEnabled(env) {
  return String((env || {}).CS2_AUTOSHUTDOWN || '1') !== '0';
}

/** Margen entre el fin de partida y el apagado. */
function shutdownGraceMs(env) {
  return envNumber(env, 'CS2_AUTOSHUTDOWN_GRACE_MIN', DEFAULT_GRACE_MIN, 1, 240) * 60000;
}

/** Cuánto aguanta encendida una máquina que nunca llegó a jugar. */
function idleMaxMs(env) {
  return envNumber(env, 'CS2_IDLE_MAX_MIN', DEFAULT_IDLE_MAX_MIN, 15, 1440) * 60000;
}

function orphanMinAgeMs(env) {
  return envNumber(env, 'CS2_ORPHAN_MIN_AGE_MIN', DEFAULT_ORPHAN_MIN_AGE_MIN, 5, 1440) * 60000;
}

/**
 * Lo que hay que escribir en el servidor cuando termina su partida. Se llama
 * desde el webhook, que es quien se entera del final.
 */
function scheduleShutdownPatch(now, env) {
  if (!autoShutdownEnabled(env)) return {};
  return {
    shutdownAfter: Number(now) + shutdownGraceMs(env),
    shutdownReason: 'match_complete',
  };
}

/** Lo que hay que escribir al lanzar: cancela cualquier apagado pendiente. */
function cancelShutdownPatch() {
  return { shutdownAfter: null, shutdownReason: null };
}

function lastActivityAt(gs) {
  const values = [gs && gs.updatedAt, gs && gs.createdAt]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return values.length ? Math.max.apply(null, values) : 0;
}

/**
 * ¿Toca apagar esta máquina? Devuelve el motivo, o null si se queda encendida.
 *
 * `busyMatchIds` son los cruces que siguen en marcha en esa máquina: mientras
 * haya uno, no se toca aunque el plazo haya vencido (el Commander puede haber
 * relanzado justo en el hueco).
 */
function shutdownReasonFor(gs, now, env, busyOnServer) {
  if (!gs) return null;
  if (busyOnServer) return null;

  const status = String(gs.status || '');
  const grace = shutdownGraceMs(env);
  const idle = lastActivityAt(gs);

  const due = Number(gs.shutdownAfter);
  if (Number.isFinite(due) && due > 0) {
    return now >= due ? 'grace_elapsed' : null;
  }

  // Registros anteriores a esto, o partidas cerradas a mano: el plazo se cuenta
  // desde la última señal de vida en vez de desde un campo que no existe.
  if (FINISHED_STATUSES.indexOf(status) !== -1) {
    return idle > 0 && now - idle >= grace ? 'finished_idle' : null;
  }

  // Encendida, sin partida y sin que nadie la use: se provisionó y se olvidó.
  if (IDLE_STATUSES.indexOf(status) !== -1) {
    return idle > 0 && now - idle >= idleMaxMs(env) ? 'never_used' : null;
  }

  return null;
}

/**
 * Recorre el registro de servidores y decide a cuáles les toca apagarse.
 * `busyByServer` es un mapa serverId → true de los que tienen partida en pie.
 */
function planAutoShutdown(gameServers, now, env, busyByServer) {
  if (!autoShutdownEnabled(env)) return [];
  const all = gameServers || {};
  const busy = busyByServer || {};

  return Object.keys(all)
    .map((serverId) => {
      const gs = all[serverId] || {};
      const reason = shutdownReasonFor(gs, now, env, !!busy[String(serverId)]);
      if (!reason) return null;
      return {
        serverId: String(serverId),
        tournamentId: gs.tournamentId || null,
        matchId: gs.matchId || gs.lastMatchId || null,
        reason,
        idleMs: Math.max(0, Number(now) - lastActivityAt(gs)),
      };
    })
    .filter(Boolean);
}

/**
 * Instancias que existen en el proveedor pero no en la base. Solo se miran las
 * etiquetadas `cs2-nexus`, que son las que crea este backend: si una máquina
 * nuestra no tiene registro, nadie la va a apagar nunca.
 */
function planOrphanCleanup(cloudInstances, gameServers, now, env) {
  const known = gameServers || {};
  const minAge = orphanMinAgeMs(env);

  return (cloudInstances || [])
    .map((inst) => {
      const id = String((inst && inst.id) || '');
      if (!id || known[id]) return null;
      const created = Date.parse((inst && inst.createdAt) || '') || 0;
      // Sin fecha fiable se deja estar: mejor pagar de más que borrar algo vivo.
      if (!created || now - created < minAge) return null;
      return { serverId: id, name: (inst && inst.name) || null, ageMs: now - created };
    })
    .filter(Boolean);
}

module.exports = {
  FINISHED_STATUSES,
  IDLE_STATUSES,
  autoShutdownEnabled,
  shutdownGraceMs,
  idleMaxMs,
  orphanMinAgeMs,
  scheduleShutdownPatch,
  cancelShutdownPatch,
  shutdownReasonFor,
  planAutoShutdown,
  planOrphanCleanup,
};
