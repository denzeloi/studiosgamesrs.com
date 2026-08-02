'use strict';

/**
 * El secreto que separa al servidor de juego de cualquier desconocido.
 * ==========================================================================
 * El webhook comparaba la cabecera recibida con la variable de entorno tal cual.
 * Si la variable se quedaba sin poner, la comparación era ''===undefined... o
 * peor, ''==='' cuando alguien mandaba la cabecera vacía: cualquiera desde fuera
 * podía inventar el resultado de una partida, avanzar el cuadro y repartir
 * premios.
 *
 * Así que el secreto tiene que existir y tener cuerpo. Si falta, la función no
 * atiende a nadie y lo dice en el log, que es mucho mejor que atender a todos.
 */

const crypto = require('crypto');

// Un secreto de tres letras es lo mismo que no tener secreto.
const MIN_LENGTH = 16;

function pick(env, names) {
  const source = env || {};
  for (const name of names) {
    const value = String(source[name] == null ? '' : source[name]).trim();
    if (value.length >= MIN_LENGTH) return value;
  }
  return null;
}

/** Secreto del webhook de partida. Null si falta o es demasiado corto. */
function webhookSecret(env) {
  return pick(env, ['WEBHOOK_SECRET']);
}

/** Token con el que MatchZy descarga la configuración del cruce. */
function matchConfigSecret(env) {
  return pick(env, ['WEBHOOK_SECRET', 'MATCH_CONFIG_TOKEN']);
}

/**
 * Comparación en tiempo constante. Con === se puede adivinar el secreto letra a
 * letra midiendo lo que tarda en responder.
 */
function matches(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided == null ? '' : provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  MIN_LENGTH,
  webhookSecret,
  matchConfigSecret,
  matches,
};
