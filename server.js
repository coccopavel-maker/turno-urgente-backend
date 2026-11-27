import express from 'express';
import cors from 'cors';
import pg from 'pg';
import webpush from 'web-push';
import crypto from 'crypto';

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Turno Urgente <onboarding@resend.dev>';
const APP_SECRET = process.env.APP_SECRET || '';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const APP_URL = (process.env.APP_URL || 'https://mellow-marshmallow-47a8ae.netlify.app').replace(/\/$/, '');
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL || 'mailto:hola@hostalconnect.es';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/* ---------------- almacenamiento: base de datos PostgreSQL (Neon) ---------------- */

if (!DATABASE_URL) {
  console.error('FALTA la variable DATABASE_URL (la direccion de conexion de Neon). El servidor no puede arrancar sin ella.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 5,
});
pool.on('error', e => console.error('Error en la conexion a la base de datos', e.message));

/* una sola tabla: cada fila es un documento JSON dentro de una coleccion */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (
      collection text NOT NULL,
      id text NOT NULL,
      data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS kv_email_idx ON kv (collection, lower(data->>'email'))`);
}

async function dbGet(collection, id) {
  const r = await pool.query('SELECT data FROM kv WHERE collection=$1 AND id=$2', [collection, id]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function dbPut(collection, id, data) {
  await pool.query(
    `INSERT INTO kv (collection, id, data) VALUES ($1,$2,$3)
     ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data`,
    [collection, id, JSON.stringify(data)]
  );
  return data;
}
async function dbAll(collection) {
  const r = await pool.query('SELECT data FROM kv WHERE collection=$1', [collection]);
  return r.rows.map(x => x.data);
}
async function dbFindByEmail(collection, email) {
  const r = await pool.query(
    `SELECT data FROM kv WHERE collection=$1 AND lower(data->>'email')=$2 LIMIT 1`, [collection, email]);
  return r.rows[0] ? r.rows[0].data : null;
}

/* envuelve las rutas async para que un error devuelva 500 en vez de tumbar el servidor */
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('Error en', req.method, req.path, e);
  if (!res.headersSent) res.status(500).json({ error: 'error interno' });
});

function checkSecret(req, res) {
  if (!APP_SECRET) return true;
  const got = req.header('x-app-secret');
  if (got !== APP_SECRET) {
    res.status(401).json({ error: 'secreto invalido' });
    return false;
  }
  return true;
}

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

/* ---------------- salud ---------------- */

app.get('/', h(async (req, res) => {
  await pool.query('SELECT 1');
  res.send('ok - turno urgente backend vivo (base de datos conectada)');
}));

app.post('/auth/register', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { password, ...fields } = req.body || {};
  const email = normEmail(fields.email);
  if (!email || !fields.id || !fields.role) return res.status(400).json({ error: 'faltan datos' });
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  const exists = await dbFindByEmail('profiles', email);
  if (exists) return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Inicia sesión.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const profile = Object.assign({}, fields, {
    email,
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
  });
  await dbPut('profiles', String(profile.id), profile);
  res.json(publicProfile(profile));
}));

app.post('/auth/login', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const email = normEmail((req.body || {}).email);
  const password = (req.body || {}).password;
  if (!email || !password) return res.status(400).json({ error: 'Escribe tu email y tu contraseña.' });
  if (tooManyAttempts(email)) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' });
  }
  const p = await dbFindByEmail('profiles', email);
  let ok = false;
  if (p && p.passwordHash && p.passwordSalt) {
    const a = Buffer.from(hashPassword(password, p.passwordSalt), 'hex');
    const b = Buffer.from(p.passwordHash, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ok) {
    noteFailedAttempt(email);
    return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
  }
  res.json(publicProfile(p));
}));

/* ---------------- perfiles ---------------- */

app.get('/profiles/:id', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const p = await dbGet('profiles', req.params.id);
  if (!p) return res.status(404).json({ error: 'no encontrado' });
  res.json(publicProfile(p));
}));

/* ---------------- disponibilidad ---------------- */

app.post('/availability/:workerId', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  await dbPut('availability', req.params.workerId, req.body);
  res.json(req.body);
}));

app.get('/availability/:workerId', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json(await dbGet('availability', req.params.workerId));
}));

app.get('/availability', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json(await dbAll('availability'));
}));

/* ---------------- ofertas ---------------- */

app.post('/offers', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const offer = req.body;
  if (!offer || !offer.id) return res.status(400).json({ error: 'falta id' });
  await dbPut('offers', String(offer.id), offer);
  res.json(offer);
}));

app.get('/offers', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  let list = await dbAll('offers');
  if (req.query.workerId) list = list.filter(o => o.workerId === req.query.workerId);
  if (req.query.hosteleroId) list = list.filter(o => o.hosteleroId === req.query.hosteleroId);
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
}));

app.patch('/offers/:id', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const existing = await dbGet('offers', req.params.id);
  if (!existing) return res.status(404).json({ error: 'no encontrada' });
  const updated = Object.assign({}, existing, req.body);
  await dbPut('offers', req.params.id, updated);
  res.json(updated);
}));

/* ---------------- valoraciones (despues del turno, en las dos direcciones) ---------------- */

/* 5 preguntas, cada una de 1 a 5 estrellas. Distintas segun quien valora. */
const CRITERIOS = {
  hostelero: ['puntualidad', 'profesionalidad', 'trato', 'rapidez', 'actitud'],   /* el hostelero valora al trabajador */
  trabajador: ['pago', 'turno', 'trato', 'organizacion', 'ambiente'],            /* el trabajador valora al local */
};

app.post('/ratings', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { offerId, fromId, scores, comment } = req.body || {};
  const offer = offerId ? await dbGet('offers', String(offerId)) : null;
  if (!offer) return res.status(404).json({ error: 'turno no encontrado' });
  if (offer.status !== 'aceptada') return res.status(400).json({ error: 'Solo se pueden valorar turnos aceptados.' });
  if (offer.endsAt && Date.now() < offer.endsAt) return res.status(400).json({ error: 'El turno aún no ha terminado.' });
  let toId, fromRole, fromNombre;
  if (fromId === offer.workerId) { toId = offer.hosteleroId; fromRole = 'trabajador'; fromNombre = offer.workerNombre; }
  else if (fromId === offer.hosteleroId) { toId = offer.workerId; fromRole = 'hostelero'; fromNombre = offer.local || offer.hosteleroNombre; }
  else return res.status(403).json({ error: 'No participaste en este turno.' });
  const clean = {};
  for (const k of CRITERIOS[fromRole]) {
    const n = Number((scores || {})[k]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return res.status(400).json({ error: 'Puntúa las 5 preguntas de 1 a 5 estrellas.' });
    clean[k] = n;
  }
  const id = offer.id + ':' + fromId;
  if (await dbGet('ratings', id)) return res.status(409).json({ error: 'Ya valoraste este turno.' });
  const vals = Object.values(clean);
  const rating = {
    id, offerId: offer.id, fromId, toId, fromRole, fromNombre,
    scores: clean, stars: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
    comment: String(comment || '').trim().slice(0, 200), createdAt: Date.now(),
  };
  await dbPut('ratings', id, rating);
  res.json(rating);
}));

app.get('/ratings', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  let list = await dbAll('ratings');
  if (req.query.fromId) list = list.filter(r => r.fromId === req.query.fromId);
  if (req.query.toId) list = list.filter(r => r.toId === req.query.toId);
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
}));

app.get('/ratings/summary', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const list = await dbAll('ratings');
  list.sort((a, b) => b.createdAt - a.createdAt);
  const acc = {};
  for (const r of list) {
    const o = acc[r.toId] || (acc[r.toId] = { sum: 0, count: 0, crit: {}, last: null });
    o.sum += r.stars; o.count += 1;
    for (const [k, v] of Object.entries(r.scores || {})) {
      const c = o.crit[k] || (o.crit[k] = { sum: 0, n: 0 });
      c.sum += v; c.n += 1;
    }
    if (!o.last && r.comment) o.last = { comment: r.comment, from: r.fromNombre };
  }
  const out = {};
  for (const [id, o] of Object.entries(acc)) {
    const crit = {};
    for (const [k, c] of Object.entries(o.crit)) crit[k] = Math.round((c.sum / c.n) * 10) / 10;
    out[id] = { avg: Math.round((o.sum / o.count) * 10) / 10, count: o.count, crit, last: o.last };
  }
  res.json(out);
}));

/* ---------------- notificaciones internas (campana en la app) ---------------- */

app.post('/notifications', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const n = req.body;
  if (!n || !n.id) return res.status(400).json({ error: 'falta id' });
  await dbPut('notifications', String(n.id), n);
  res.json(n);
}));

app.get('/notifications', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const para = req.query.para ? String(req.query.para) : null;
  const r = await pool.query(
    `SELECT data FROM kv WHERE collection='notifications' AND ($1::text IS NULL OR data->>'para' = $1)
     ORDER BY (data->>'createdAt')::bigint DESC LIMIT 5`, [para]);
  res.json(r.rows.map(x => x.data));
}));

/* ---------------- push subscriptions ---------------- */

app.post('/subscribe', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { email, subscription } = req.body || {};
  if (!email || !subscription) return res.status(400).json({ error: 'faltan datos' });
  const key = normEmail(email);
  const list = (await dbGet('subs', key)) || [];
  if (!list.some(s => s.endpoint === subscription.endpoint)) list.push(subscription);
  await dbPut('subs', key, list);
  res.json({ ok: true });
}));

app.post('/unsubscribe', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { email, endpoint } = req.body || {};
  if (!email) return res.status(400).json({ error: 'falta email' });
  const key = normEmail(email);
  const list = (await dbGet('subs', key)) || [];
  await dbPut('subs', key, list.filter(s => s.endpoint !== endpoint));
  res.json({ ok: true });
}));

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

async function sendPush(email, subject, body, url) {
  const key = normEmail(email);
  const list = (await dbGet('subs', key)) || [];
  if (!list.length) return;
  const payload = JSON.stringify({ title: subject, body, url: url || '/' });
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
  await dbPut('subs', key, stillValid);
}

app.post('/notify', h(async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { to, subject, body } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'faltan datos' });
  await Promise.all([sendEmail(to, subject, body || ''), sendPush(to, subject, body || '')]);
  res.json({ ok: true });
}));

/* ---------------- aviso automatico al terminar el turno (para valorarlo) ---------------- */

let checkingEnds = false;
async function checkShiftEnds() {
  if (checkingEnds) return;
  checkingEnds = true;
  try {
    const now = Date.now();
    const offers = await dbAll('offers');
    for (const o of offers) {
      if (o.status !== 'aceptada' || !o.endsAt || o.endsAt > now || o.endNotified) continue;
      /* se marca antes de avisar para no mandar el aviso dos veces */
      await dbPut('offers', String(o.id), Object.assign({}, o, { endNotified: true }));
      const people = [
        { id: o.workerId, otro: o.local || 'el local' },
        { id: o.hosteleroId, otro: o.workerNombre || 'tu trabajador' },
      ];
      for (const who of people) {
        if (!who.id) continue;
        if (await dbGet('ratings', o.id + ':' + who.id)) continue; /* ya lo valoro */
        const prof = await dbGet('profiles', String(who.id));
        if (!prof || !prof.email) continue;
        const asunto = 'Ha terminado el turno: valóralo';
        const cuerpo = `El turno con ${who.otro} (${o.desde}–${o.hasta}) ha terminado. Entra en Turno Urgente y deja tu valoración: son 10 segundos y ayuda a toda la comunidad.`;
        const enlace = `${APP_URL}/?valorar=${encodeURIComponent(o.id)}`;
        await dbPut('notifications', 'fin-' + o.id + '-' + who.id, {
          id: 'fin-' + o.id + '-' + who.id, para: prof.email, asunto, cuerpo, createdAt: Date.now(), leida: false,
        });
        await Promise.all([
          sendEmail(prof.email, asunto, cuerpo + '\n\nValorar ahora: ' + enlace),
          sendPush(prof.email, asunto, cuerpo, enlace),
        ]);
      }
    }
  } catch (e) {
    console.error('Error comprobando fin de turnos', e);
  } finally {
    checkingEnds = false;
  }
}

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Turno Urgente backend escuchando en puerto ${PORT} (base de datos conectada)`);
      checkShiftEnds();
      setInterval(checkShiftEnds, 60 * 1000);
    });
  })
  .catch(e => {
    console.error('No se pudo conectar con la base de datos:', e.message);
    process.exit(1);
  });
