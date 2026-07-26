# Configuración de Login con Steam (integración completada)

## Pasos necesarios en tu servidor

### 1. Instalar dependencias PHP

En la carpeta del proyecto, ejecuta:

```bash
composer install
```

Esto instala `kreait/firebase-php` para generar el token de Firebase.

### 2. Obtener la clave de cuenta de servicio de Firebase

1. Entra a [Firebase Console](https://console.firebase.google.com/)
2. Selecciona tu proyecto **studiosgamesrs**
3. Menú ⚙️ → **Project settings** → pestaña **Service accounts**
4. Haz clic en **Generate new private key**
5. Guarda el archivo JSON en la raíz del proyecto como **`serviceAccountKey.json`**

⚠️ **Importante:** No subas este archivo a Git. Añade `serviceAccountKey.json` a `.gitignore`.

### 3. Estructura esperada

```
nexus imporatnte/
├── steam_login.php          ← ya integrado
├── steam-login-handler.html
├── composer.json
├── vendor/                  ← se crea con composer install
└── serviceAccountKey.json   ← debes añadirlo tú
```

### 4. Comprobar que funciona

1. Ejecuta `composer install`
2. Coloca `serviceAccountKey.json` en la carpeta del proyecto
3. Haz login con Steam desde la página de login
4. Deberías ser redirigido al dashboard correctamente

### Fallback

Si no existe `serviceAccountKey.json`, el script redirige igual a `steam-login-handler.html` con los datos de Steam, pero sin token. En ese caso el usuario verá el mensaje de vincular cuenta con Google/Email.
