// Turno Urgente — backend de notificaciones
// Recibe eventos (oferta enviada / aceptada / rechazada) desde la app y:
//   1. Manda un email real via Resend.
//   2. Si el destinatario activo notificaciones push en su movil, le manda
//      tambien un push real via Web Push (VAPID).
//
// Variables de entorno necesarias (se configuran en el panel de tu hosting,
// nunca se escriben aqui ni se suben a git):
//   RESEND_API_KEY   -> tu clave de Resend (resend.com)
//   FROM_EMAIL       -> remitente verificado, ej: "Turno Urgente <notificaciones@tudominio.com>"
//   APP_SECRET       -> contraseña simple compartida con la app para frenar abuso
//   ALLOWED_ORIGIN   -> (opcional) origen desde el que se permite llamar a este backend
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY -> claves para Web Push (ver README)
//   VAPID_CONTACT_EMAIL -> un email de contacto tuyo, lo exige el estandar Web Push

import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import fs from 'fs';

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Turno Urgente <onboarding@resend.dev>';
const APP_SECRET = process.env.APP_SECRET || '';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL || 'mailto:hola@hostalconnect.es';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// --- almacen de suscripciones push -----------------------------------------
// MVP: un archivo JSON en disco. Suficiente para validar con tus primeros
// usuarios. Cuando tengas base de datos real (Postgres, ver tu roadmap),
// sustituye estas dos funciones por lecturas/escrituras a esa base de datos.
const SUBS_FILE = './subscriptions.json';

function loadSubs() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); }
  catch (e) { return {}; } // { "email@x.com": [subscription, ...] }
}
function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

function checkSecret(req, res) {
  if (!APP_SECRET) return true;
  if (req.headers['x-app-secret'] !== APP_SECRET) {
    res.status(401).json({ ok: false, error: 'No autorizado' });
    return false;
  }
  return true;
}

app.get('/', (req, res) => {
  res.send('Turno Urgente notify service — OK');
});

// El navegador del trabajador llama aqui tras pedir permiso de notificaciones.
app.post('/subscribe', (req, res) => {
  if (!checkSecret(req, res)) return;
  const { email, subscription } = req.body || {};
  if (!email || !subscription) {
    return res.status(400).json({ ok: false, error: 'Faltan campos: email, subscription' });
  }
  const subs = loadSubs();
  subs[email] = subs[email] || [];
  const already = subs[email].some(s => s.endpoint === subscription.endpoint);
  if (!already) subs[email].push(subscription);
  saveSubs(subs);
  res.json({ ok: true });
});

app.post('/unsubscribe', (req, res) => {
  if (!checkSecret(req, res)) return;
  const { email, endpoint } = req.body || {};
  const subs = loadSubs();
  if (subs[email]) {
    subs[email] = subs[email].filter(s => s.endpoint !== endpoint);
    saveSubs(subs);
  }
  res.json({ ok: true });
});

app.post('/notify', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(400).json({ ok: false, error: 'Faltan campos: to, subject, body' });
  }

  const result = { ok: true, email: null, push: null };

  // 1. Email via Resend
  if (RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [to],
          subject,
          html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#1B1D23;">
                   <p>${body}</p>
                   <p style="color:#9296A3;font-size:12px;margin-top:24px;">Turno Urgente · HostalConnect</p>
                 </div>`,
        }),
      });
      const data = await r.json();
      result.email = r.ok ? { sent: true, id: data.id } : { sent: false, error: data };
    } catch (err) {
      result.email = { sent: false, error: String(err) };
    }
  }

  // 2. Push al movil, si el destinatario tiene suscripcion activa
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    const subs = loadSubs();
    const list = subs[to] || [];
    const payload = JSON.stringify({ title: subject, body });
    const outcomes = await Promise.all(list.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        return { endpoint: sub.endpoint, sent: true };
      } catch (err) {
        // 410/404 = la suscripcion ya no es valida (usuario desinstalo, etc.)
        if (err.statusCode === 410 || err.statusCode === 404) {
          subs[to] = subs[to].filter(s => s.endpoint !== sub.endpoint);
          saveSubs(subs);
        }
        return { endpoint: sub.endpoint, sent: false, error: err.message };
      }
    }));
    result.push = outcomes;
  }

  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Turno Urgente notify service escuchando en puerto ${PORT}`));
