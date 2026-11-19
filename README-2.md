# Turno Urgente — backend de notificaciones

Servidor mínimo que recibe un evento ("nueva oferta", "oferta aceptada"...)
desde la app de Turno Urgente y manda el email real con [Resend](https://resend.com),
y opcionalmente un push real al móvil con Web Push.

## 1. Crear cuenta en Resend

1. Regístrate en resend.com (plan gratis: 3.000 emails/mes, 100/día).
2. Ve a **API Keys** → crea una clave → cópiala. Es tu `RESEND_API_KEY`.
3. Ve a **Domains** → añade tu dominio (ej. `hostalconnect.es`) y sigue los
   pasos de verificación DNS. Mientras no verifiques dominio propio, puedes
   probar con el remitente de pruebas `onboarding@resend.dev` (solo te deja
   mandarte emails a ti mismo, pero sirve para testear ya mismo).

## 2. Desplegar el servidor (gratis, ~10 min)

Recomendado: **Render.com** (tiene plan gratuito para este tipo de servicio).

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: **New → Web Service** → conecta el repo.
3. Build command: `npm install` — Start command: `npm start`.
4. En **Environment**, añade estas variables:
   - `RESEND_API_KEY` → la clave que copiaste en Resend.
   - `FROM_EMAIL` → `Turno Urgente <notificaciones@tudominio.com>` (o el de pruebas de Resend mientras no verifiques dominio).
   - `APP_SECRET` → invéntate una contraseña larga random, ej. `tu-secreto-largo-123`.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTACT_EMAIL` → ver paso 3.
5. Deploy. Render te da una URL tipo `https://turno-urgente-notify.onrender.com`.

(Railway o Fly.io funcionan igual de bien si los prefieres.)

## 3. Configurar avisos push en el móvil (opcional pero recomendado)

Claves de ejemplo ya generadas, listas para probar hoy mismo (guarda la
privada como secreto, no la subas a git en texto plano fuera de las
variables de entorno):

```
VAPID_PUBLIC_KEY  = BKpS1A8k1Dk0E7y_2_RnPbnaSdi97DsywSWMSm1rgmW1qTk7szdAToMAq4UQWMYTyDp3iTvO6HCGyooQUl7hkkw
VAPID_PRIVATE_KEY = wiAOSfQF6-pNA3a822w5JwbauRrUCbhfY10U1qwb6Ko
VAPID_CONTACT_EMAIL = mailto:tu-email@hostalconnect.es
```

Puedes generar las tuyas propias en cualquier momento con:

```
npx web-push generate-vapid-keys
```

## 4. Desplegar la app (frontend) en un dominio real

El push no funciona si la app vive solo en una vista previa — necesita un
dominio real y estable:

1. Sube la carpeta `turno-urgente-app/` (index.html, sw.js, manifest.webmanifest,
   los iconos) a Vercel o Netlify — arrastrar la carpeta a netlify.com/drop
   funciona en menos de un minuto.
2. Copia la URL que te den (ej. `https://turno-urgente.netlify.app`).

## 5. Conectar todo

En `index.html`, cerca del principio del `<script>`, rellena:

```js
const NOTIFY_BACKEND_URL = ''; // tu URL de Render (paso 2)
const NOTIFY_APP_SECRET  = ''; // tu APP_SECRET (paso 2)
const VAPID_PUBLIC_KEY   = ''; // tu VAPID_PUBLIC_KEY (paso 3)
```

Vuelve a subir el archivo actualizado a Netlify/Vercel.

## Nota sobre seguridad

`APP_SECRET` viaja dentro del código de la app, que corre en el navegador de
cada usuario — así que técnicamente cualquiera podría verlo si mira el código
fuente. Sirve como freno básico contra bots que encuentren la URL por
casualidad, no como autenticación real. Cuando tengas usuarios registrados
con cuenta de verdad (backend propio con base de datos), sustituye esto por
un token de sesión por usuario.
