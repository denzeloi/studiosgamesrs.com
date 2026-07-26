<?php
/**
 * steam_login.php — Login / registro con Steam (OpenID) + Firebase
 *
 * intent=login  → busca cuenta YA vinculada (Google/Email) y entra con custom token
 * intent=register → crea cuenta nueva steam_{steamid} si no existe vínculo
 */
// La clave vive en steam-config.php (fuera del repositorio) o en el entorno del servidor.
if (file_exists(__DIR__ . '/steam-config.php')) {
    require_once __DIR__ . '/steam-config.php';
}
if (!defined('STEAM_API_KEY')) {
    define('STEAM_API_KEY', getenv('STEAM_API_KEY') ?: '');
}
define('STEAM_LOGIN_RESOLVE_URL', 'https://us-central1-studiosgamesrs.cloudfunctions.net/steamLoginResolve');
define('FIREBASE_DATABASE_URI', 'https://studiosgamesrs-default-rtdb.firebaseio.com');
$serviceAccountPath = __DIR__ . '/serviceAccountKey.json';

$intent = 'login';
if (isset($_GET['intent'])) {
    if ($_GET['intent'] === 'register') $intent = 'register';
    elseif ($_GET['intent'] === 'link') $intent = 'link';
}

function steamOpenIdLogin($intent) {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'];
    $script = $_SERVER['PHP_SELF'] ?? $_SERVER['SCRIPT_NAME'];
    $returnUrl = $scheme . '://' . $host . $script . '?intent=' . urlencode($intent);

    $params = [
        'openid.ns'         => 'http://specs.openid.net/auth/2.0',
        'openid.mode'       => 'checkid_setup',
        'openid.return_to'  => $returnUrl,
        'openid.realm'      => $scheme . '://' . $host,
        'openid.identity'   => 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id' => 'http://specs.openid.net/auth/2.0/identifier_select',
    ];
    header('Location: https://steamcommunity.com/openid/login?' . http_build_query($params));
    exit;
}

function isSteamOpenIdCallback() {
    $mode = $_GET['openid_mode'] ?? $_GET['openid.mode'] ?? null;
    return $mode === 'id_res';
}

function getOpenIdClaimedId() {
    $claimed = $_GET['openid_claimed_id'] ?? $_GET['openid.claimed_id'] ?? null;
    if (!$claimed) return null;
    $steamId = basename($claimed);
    // SteamID64 válido: 17 dígitos, empieza por 7656119
    if (!preg_match('/^7656119\d{10}$/', $steamId)) return null;
    return $steamId;
}

// Valida la respuesta de Steam OpenID (check_authentication).
// IMPORTANTE: PHP convierte openid.mode → openid_mode en $_GET, pero al
// reenviar a Steam hay que usar openid.mode con puntos.
function validateSteamOpenId() {
    if (!isSteamOpenIdCallback()) return null;

    $claimedId = getOpenIdClaimedId();
    if (!$claimedId) return null;

    $signed = $_GET['openid_signed'] ?? $_GET['openid.signed'] ?? '';
    $assocHandle = $_GET['openid_assoc_handle'] ?? $_GET['openid.assoc_handle'] ?? '';
    $sig = $_GET['openid_sig'] ?? $_GET['openid.sig'] ?? '';

    if (!$signed || !$assocHandle || !$sig) {
        error_log('Steam OpenID: faltan parámetros signed/assoc_handle/sig');
        return null;
    }

    $params = [
        'openid.assoc_handle' => $assocHandle,
        'openid.signed'       => $signed,
        'openid.sig'          => $sig,
        'openid.ns'           => 'http://specs.openid.net/auth/2.0',
        'openid.mode'         => 'check_authentication',
    ];

    foreach (explode(',', $signed) as $item) {
        $item = trim($item);
        if ($item === '') continue;
        $phpKey = 'openid_' . str_replace('.', '_', $item);
        $dotKey = 'openid.' . $item;
        if (isset($_GET[$phpKey])) {
            $params[$dotKey] = $_GET[$phpKey];
        } elseif (isset($_GET[$dotKey])) {
            $params[$dotKey] = $_GET[$dotKey];
        }
    }

    $postBody = http_build_query($params);

    $result = null;
    if (function_exists('curl_init')) {
        $ch = curl_init('https://steamcommunity.com/openid/login');
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $postBody);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 20);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/x-www-form-urlencoded']);
        $result = curl_exec($ch);
        if ($result === false) {
            error_log('Steam OpenID curl error: ' . curl_error($ch));
        }
        curl_close($ch);
    }

    // Fallback si curl no está disponible o falló
    if ($result === null || $result === false) {
        $ctx = stream_context_create([
            'http' => [
                'method'  => 'POST',
                'header'  => "Content-Type: application/x-www-form-urlencoded\r\n",
                'content' => $postBody,
                'timeout' => 20,
            ],
        ]);
        $result = @file_get_contents('https://steamcommunity.com/openid/login', false, $ctx);
    }

    if ($result && preg_match('/is_valid\s*:\s*true/i', $result)) {
        return $claimedId;
    }

    error_log('Steam OpenID validation failed. Response: ' . substr((string)$result, 0, 300));
    return null;
}

function fetchSteamPlayer($steamID64) {
    $api_url = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=' . STEAM_API_KEY . '&steamids=' . urlencode($steamID64);
    $json = @file_get_contents($api_url);
    if (!$json) return null;
    $data = json_decode($json, true);
    if (empty($data['response']['players'][0])) return null;
    $p = $data['response']['players'][0];
    return [
        'steamid'        => $p['steamid'] ?? $steamID64,
        'personaname'    => $p['personaname'] ?? '',
        'avatarfull'     => $p['avatarfull'] ?? '',
        'avatar'         => $p['avatar'] ?? '',
        'avatarmedium'   => $p['avatarmedium'] ?? '',
        'loccountrycode' => $p['loccountrycode'] ?? '',
    ];
}

function getFirebaseFactory() {
    global $serviceAccountPath;
    static $factory = null;
    if ($factory !== null) return $factory;
    if (!file_exists($serviceAccountPath) || !file_exists(__DIR__ . '/vendor/autoload.php')) {
        return null;
    }
    require_once __DIR__ . '/vendor/autoload.php';
    $factory = (new \Kreait\Firebase\Factory)
        ->withServiceAccount($serviceAccountPath)
        ->withDatabaseUri(FIREBASE_DATABASE_URI);
    return $factory;
}

function extractSteamIdFromUserData($data) {
    if (!is_array($data)) return '';
    if (isset($data['steamID']) && $data['steamID'] !== '') return trim((string)$data['steamID']);
    if (isset($data['steam']['steamid']) && $data['steam']['steamid'] !== '') return trim((string)$data['steam']['steamid']);
    if (isset($data['steamid']) && $data['steamid'] !== '') return trim((string)$data['steamid']);
    return '';
}

// Busca el UID de Google/Email vinculado a este SteamID64 en Firebase RTDB.
function findLinkedAccountUid($steamID64) {
    $factory = getFirebaseFactory();
    if (!$factory) return null;

    $steamId = trim((string)$steamID64);
    if ($steamId === '') return null;

    try {
        $db = $factory->createDatabase();

        // Índice inverso (si existe)
        $idx = $db->getReference('steamIndex/' . $steamId)->getValue();
        if ($idx) return (string)$idx;

        // Campo indexado users/*/steamID
        $matches = $db->getReference('users')
            ->orderByChild('steamID')
            ->equalTo($steamId)
            ->limitToFirst(1)
            ->getValue();
        if (is_array($matches)) {
            foreach (array_keys($matches) as $uid) {
                return (string)$uid;
            }
        }

        // Escaneo completo (steam/steamid, steamID como string o número)
        $all = $db->getReference('users')->getValue();
        if (is_array($all)) {
            foreach ($all as $uid => $row) {
                if (extractSteamIdFromUserData($row) === $steamId) {
                    return (string)$uid;
                }
            }
        }
    } catch (Exception $e) {
        error_log('findLinkedAccountUid: ' . $e->getMessage());
    }

    return null;
}

function createCustomTokenForUid($uid) {
    $factory = getFirebaseFactory();
    if (!$factory) return null;
    try {
        return $factory->createAuth()->createCustomToken($uid)->toString();
    } catch (Exception $e) {
        error_log('createCustomTokenForUid: ' . $e->getMessage());
        return null;
    }
}

function backfillSteamIndexes($uid, $steamID64) {
    $factory = getFirebaseFactory();
    if (!$factory) return;
    try {
        $db = $factory->createDatabase();
        $steamId = trim((string)$steamID64);
        $db->getReference('users/' . $uid)->update(['steamID' => $steamId]);
        $db->getReference('steamIndex/' . $steamId)->set($uid);
    } catch (Exception $e) {
        error_log('backfillSteamIndexes: ' . $e->getMessage());
    }
}

function resolveLinkedAccountToken($steamID64) {
    // 1) Búsqueda directa en Firebase (misma lógica que el dashboard, sin depender de curl externo)
    $uid = findLinkedAccountUid($steamID64);
    if ($uid) {
        $token = createCustomTokenForUid($uid);
        if ($token) {
            backfillSteamIndexes($uid, $steamID64);
            return $token;
        }
    }

    // 2) Fallback: Cloud Function
    $payload = json_encode(['steamId' => $steamID64]);
    $ch = curl_init(STEAM_LOGIN_RESOLVE_URL);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 20);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);
    if ($body) {
        $data = json_decode($body, true);
        if ($code === 200 && !empty($data['success']) && !empty($data['token'])) {
            return $data['token'];
        }
        if (is_array($data)) return $data;
    }
    if ($curlErr) {
        error_log('resolveLinkedAccountToken curl: ' . $curlErr);
    }
    return null;
}

function createSteamOnlyToken($steamID64) {
    $uid = 'steam_' . preg_replace('/[^0-9]/', '', $steamID64);
    return createCustomTokenForUid($uid);
}

function redirectHandler($token, $steamData, $errorMsg, $mode = '') {
    $steamB64 = base64_encode(json_encode($steamData));
    $base = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');
    $handler = ($base ? $base : '') . '/steam-login-handler.html';

    if ($token) {
        $url = $handler . '?token=' . urlencode($token) . '&steam=' . urlencode($steamB64);
        if ($mode) $url .= '&mode=' . urlencode($mode);
        header('Location: ' . $url);
        exit;
    }
    if ($errorMsg) {
        header('Location: /login?steam_error=' . urlencode($errorMsg));
        exit;
    }
    $url = $handler . '?steam=' . urlencode($steamB64);
    if ($mode) $url .= '&mode=' . urlencode($mode);
    header('Location: ' . $url);
    exit;
}

// --- Flujo principal ---
if (!isSteamOpenIdCallback()) {
    steamOpenIdLogin($intent);
}

$steamID64 = validateSteamOpenId();
if (!$steamID64) {
    header('Location: /login?steam_error=' . urlencode('No se pudo validar tu sesión de Steam. Intenta de nuevo.'));
    exit;
}

$player = fetchSteamPlayer($steamID64);
if (!$player) {
    header('Location: /login?steam_error=' . urlencode('No se pudo obtener tu perfil de Steam.'));
    exit;
}

if ($intent === 'link') {
    // Vincular Steam estando logueado con Google/Email → dashboard guarda steam + steamID
    header('Location: /dashboard?steam=' . urlencode(base64_encode(json_encode($player))));
    exit;
}

if ($intent === 'login') {
    $resolved = resolveLinkedAccountToken($steamID64);
    if (is_string($resolved)) {
        redirectHandler($resolved, $player, null, 'login');
    }
    // PHP no encontró cuenta: el handler resolverá vía Cloud Function en el navegador
    redirectHandler(null, $player, null, 'login');
}

// intent=register: si ya está vinculada, entrar; si no, cuenta steam_* nueva
$resolved = resolveLinkedAccountToken($steamID64);
if (is_string($resolved)) {
    redirectHandler($resolved, $player, null);
}

$token = createSteamOnlyToken($steamID64);
if ($token) {
    redirectHandler($token, $player, null);
}

redirectHandler(null, $player, 'No se pudo crear la sesión. Contacta soporte.');
