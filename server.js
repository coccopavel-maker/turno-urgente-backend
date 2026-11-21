import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import webpush from 'web-push';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 10000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Turno Urgente <onboarding@resend.dev>';
const APP_SECRET = process.env.APP_SECRET || '';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL || 'mailto:hola@hostalconnect.es';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/* ---------------- almacenamiento en disco (archivo JSON) ---------------- */

const DB_PATH = path.join(__dirname, 'db.json');
const SUBS_PATH = path.join(__dirname, 'subscriptions.json');

function loadJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error('Error leyendo', filePath, e);
    return fallback;
  }
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error guardando', filePath, e);
  }
}

function loadDB() {
  return loadJSON(DB_PATH, { profiles: {}, availability: {}, offers: {}, notifications: [] });
}
function saveDB(db) {
  saveJSON(DB_PATH, db);
}

function loadSubs() {
  return loadJSON(SUBS_PATH, {});
}
function saveSubs(subs) {
  saveJSON(SUBS_PATH, subs);
}

function checkSecret(req, res) {
  if (!APP_SECRET) return true;
  const got = req.header('x-app-secret');
  if (got !== APP_SECRET) {
    res.status(401).json({ error: 'secreto invalido' });
    return false;
  }
  return true;
}

/* ---------------- salud ---------------- */

app.get('/', (req, res) => {
  res.send('ok - turno urgente backend vivo');
});

/* ---------------- cuentas: registro e inicio de sesion (email + contrasena) ---------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function publicProfile(p) {
  const { passwordHash, passwordSalt, ...rest } = p;
  return rest;
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

/* limite sencillo de intentos de login: 10 cada 15 minutos por email */
const loginAttempts = new Map();
function tooManyAttempts(email) {
  const now = Date.now();
  const list = (loginAttempts.get(email) || []).filter(t => now - t < 15 * 60 * 1000);
  loginAttempts.set(email, list);
  return list.length >= 10;
}
function noteFailedAttempt(email) {
  const list = loginAttempts.get(email) || [];
  list.push(Date.now());
  loginAttempts.set(email, list);
}

app.post('/auth/register', (req, res) => {
  if (!checkSecret(req, res)) return;
  const { password, ...fields } = req.body || {};
  const email = normEmail(fields.email);
  if (!email || !fields.id || !fields.role) return res.status(400).json({ error: 'faltan datos' });
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'La contraseÃ±a debe tener al menos 6 caracteres.' });
  }
  const db = loadDB();
  const exists = Object.values(db.profiles).some(p => normEmail(p.email) === email);
  if (exists) return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Inicia sesiÃ³n.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const profile = Object.assign({}, fields, {
    email,
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
  });
  db.profiles[profile.id] = profile;
  saveDB(db);
  res.json(publicProfile(profile));
});

app.post('/auth/login', (req, res) => {
  if (!checkSecret(req, res)) return;
  const email = normEmail((req.body || {}).email);
  const password = (req.body || {}).password;
  if (!email || !password) return res.status(400).json({ error: 'Escribe tu email y tu contraseÃ±a.' });
  if (tooManyAttempts(email)) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' });
  }
  const db = loadDB();
  const p = Object.values(db.profiles).find(x => normEmail(x.email) === email);
  let ok = false;
  if (p && p.passwordHash && p.passwordSalt) {
    const a = Buffer.from(hashPassword(password, p.passwordSalt), 'hex');
    const b = Buffer.from(p.passwordHash, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ok) {
    noteFailedAttempt(email);
    return res.status(401).json({ error: 'Email o contraseÃ±a incorrectos.' });
  }
  res.json(publicProfile(p));
});

/* ---------------- perfiles ---------------- */

app.get('/profiles/:id', (req, res) => {
  if (!checkSecret(req, res)) return;
  const db = loadDB();
  const p = db.profiles[req.params.id];
  if (!p) return res.status(404).json({ error: 'no encontrado' });
  res.json(publicProfile(p));
});

/* ---------------- disponibilidad ---------------- */

app.post('/availability/:workerId', (req, res) => {
  if (!checkSecret(req, res)) return;
  const db = loadDB();
  db.availability[req.params.workerId] = req.body;
  saveDB(db);
  res.json(req.body);
});

app.get('/availability/:workerId', (req, res) => {
  if (!checkSecret(req, res)) return;
  const db = loadDB();
  res.json(db.availability[req.params.workerId] || null);
});

app.get('/availability', (req, res) => {
  if (!checkSecret(req, res)) return;
  const db = loadDB();
  res.json(Object.values(db.availability));
});

/* ---------------- ofertas ---------------- */

app.post('/offers', (req, res) => {
  if (!checkSecret(req, res)) return;
  const offer = req.body;
  if (!offer || !offer.id) return res.status(400).json({ error: 'falta id' });
  const db = loadDB();
  db.offers[offer.id] = offer;
  saveDB(db);
  res.json(offer);
});

app.get('/offers', (req, res) => {
  if (!checkSecret(req, res)) return;
  const db = loadDB();
  let list = Object.values(db.offers);
  if (req.query.workerId) list = list.filter(o => o.workerId === req.query.workerId);
  if (req.query.hosteleroId) list = list.filter(o => o.hosteleroId === req.query.hosteleroId);
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.patch('/offers/:id', (req, res) => {
  if (!checkSecret(req, res)) return;
  const db = loadDB();
  const existing = db.offers[req.params.id];
  if (!existing) return res.status(404).json({ error: 'no encontrada' });
  const updated = Object.assign({}, existing, req.body);
  db.offers[req.params.id] = updated;
  saveDB(db);
  res.json(updated);
});

/* ---------------- notificaciones internas (campana en la app) ---------------- */

app.post('/notifications', (req, res) => {
  if (!checkSecret(req, res)) return;
  const n = req.body;
  if (!n || !n.id) return res.status(400).json({ error: 'falta id' });
  const db = loadDB();
  db.notifications.push(n);
  if (db.notifications.length > 500) db.notifications = db.notifications.slice(-500);
  saveDB(db);
  res.json(n);
});

app.get('/notifications', (req, res) => {
  if (!checkSecret(req, res)) return;
  const db = loadDB();
  let list = db.notifications;
  if (req.query.para) list = list.filter(n => n.para === req.query.para);
  list = list.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  res.json(list);
});

/* ---------------- push subscriptions ---------------- */

app.post('/subscribe', (req, res) => {
  if (!checkSecret(req, res)) return;
  const { email, subscription } = req.body || {};
  if (!email || !subscription) return res.status(400).json({ error: 'faltan datos' });
  const subs = loadSubs();
  if (!subs[email]) subs[email] = [];
  const exists = subs[email].some(s => s.endpoint === subscription.endpoint);
  if (!exists) subs[email].push(subscription);
  saveSubs(subs);
  res.json({ ok: true });
});

app.post('/unsubscribe', (req, res) => {
  if (!checkSecret(req, res)) return;
  const { email, endpoint } = req.body || {};
  if (!email) return res.status(400).json({ error: 'falta email' });
  const subs = loadSubs();
  if (subs[email]) {
    subs[email] = subs[email].filter(s => s.endpoint !== endpoint);
    saveSubs(subs);
  }
  res.json({ ok: true });
});

/* ---------------- envio real: email (Resend) + push ---------------- */

async function sendEmail(to, subject, body) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY no configurada, no se envia email');
    return;
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject,
        text: body,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.error('Resend error', resp.status, t);
    }
  } catch (e) {
    console.error('Error enviando email', e);
  }
}

async function sendPush(email, subject, body) {
  const subs = loadSubs();
  const list = subs[email] || [];
  if (!list.length) return;
  const payload = JSON.stringify({ title: subject, body, url: '/' });
  const stillValid = [];
  for (const sub of list) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        // suscripcion caducada, se descarta
      } else {
        console.error('Error enviando push', e.statusCode, e.message);
        stillValid.push(sub);
      }
    }
  }
  subs[email] = stillValid;
  saveSubs(subs);
}

app.post('/notify', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { to, subject, body } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'faltan datos' });
  await Promise.all([sendEmail(to, subject, body || ''), sendPush(to, subject, body || '')]);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Turno Urgente backend escuchando en puerto ${PORT}`);
});
