// ParentsDay-Briefkasten (Cloudflare Worker + D1-Datenbank)
//
// Nimmt die Rückmeldungen der Eltern entgegen und gibt sie an die Lehrkraft heraus. Die Rückmeldungen
// werden schon im Browser der Eltern mit dem öffentlichen Schlüssel der Lehrkraft verschlüsselt
// (ECDH P-256 + AES-GCM). Dieser Dienst sieht nur unlesbare Daten – keine Namen, keine Zeiten.
//
// Einrichtung: siehe docs/BRIEFKASTEN.md. Benötigt wird die D1-Bindung `DB`.
// Optionale Variablen: ALLOWED_ORIGINS – erlaubte Web-Adressen, kommagetrennt
// (Standard: https://parentsday.janrickmer.de); POSTS_PER_MINUTE – Rückmeldungen je IP und Minute (Standard 30).
// Aufräumen: Ein täglicher Cron-Trigger (scheduled) löscht Rückmeldungen und Verzeichniseinträge, bevor sie
// 200 Tage alt sind. Ältere gibt der Dienst auch ohne Cron-Trigger nicht mehr heraus.
//
// Schnittstelle (alle Antworten JSON):
//   GET    /v1/health                         → { ok: true }
//   POST   /v1/boxes/<boxId>/messages          Rückmeldung einwerfen: { v:1, epk, iv, ct } → 201 { id }
//   GET    /v1/boxes/<boxId>/messages          Rückmeldungen abholen (Authorization: Bearer <secret>)
//   DELETE /v1/boxes/<boxId>/messages          Briefkasten leeren   (Authorization: Bearer <secret>)
//          ?before=<Zeitpunkt in ms>           nur Rückmeldungen, die davor eingegangen sind (→ { deleted })
//   PUT    /v1/directory/<dirId>               Eintrag für den Termin-Schlüssel ablegen (Bearer <secret>)
//   GET    /v1/directory/<dirId>               Eintrag lesen → { iv, ct }, ohne Eintrag { found: false }
// boxId = die ersten 32 Zeichen von base64url(SHA-256(secret)). Nur wer das Geheimnis kennt
// (die Lehrkraft), kann den Briefkasten lesen oder leeren.

const DEFAULT_ORIGINS = ['https://parentsday.janrickmer.de'];
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const B64_RE = /^[A-Za-z0-9_-]+$/;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_DIRECTORY_BYTES = 4 * 1024;
const MAX_MESSAGES_PER_BOX = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 200 * DAY_MS; // Rückmeldungen und Verzeichniseinträge gelten 200 Tage
const POSTS_PER_MINUTE = 30; // je IP-Adresse und Worker-Instanz

const schemaReady = new WeakMap(); // je Datenbank-Bindung nur einmal Tabellen anlegen
const postLog = new Map();

function ensureSchema(db) {
  if (!schemaReady.has(db)) {
    const ready = db
      .batch([
        db.prepare('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, box_id TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_box ON messages (box_id, created_at)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at)'),
        db.prepare('CREATE TABLE IF NOT EXISTS directory (dir_id TEXT PRIMARY KEY, box_id TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_directory_updated ON directory (updated_at)'),
      ])
      .catch((err) => {
        schemaReady.delete(db);
        throw err;
      });
    schemaReady.set(db, ready);
  }
  return schemaReady.get(db);
}

function allowedOrigins(env) {
  const list = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins(env).includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(request, env, status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(request, env) },
  });
}

async function boxIdFromSecret(secret) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  let bin = '';
  for (const b of hash) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

/** Prüft „Authorization: Bearer <secret>“ gegen die Briefkasten-ID. */
async function authorized(request, boxId) {
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('Authorization') || '');
  if (!m || !SECRET_RE.test(m[1])) return false;
  return (await boxIdFromSecret(m[1])) === boxId;
}

/** Liest den Anfragetext mit Größenbegrenzung. Gibt null zurück, wenn er zu groß oder kein JSON ist. */
async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

function isB64(value, minLen, maxLen) {
  return typeof value === 'string' && value.length >= minLen && value.length <= maxLen && B64_RE.test(value);
}

function tooManyPosts(request, env) {
  const limit = Number(env.POSTS_PER_MINUTE) || POSTS_PER_MINUTE;
  const ip = request.headers.get('CF-Connecting-IP') || 'unbekannt';
  const now = Date.now();
  const recent = (postLog.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  postLog.set(ip, recent);
  if (postLog.size > 5000) postLog.clear();
  return recent.length > limit;
}

async function postMessage(request, env, db, boxId) {
  if (tooManyPosts(request, env)) return json(request, env, 429, { error: 'too-many-requests' });
  const body = await readJson(request, MAX_MESSAGE_BYTES);
  // epk: öffentlicher P-256-Schlüssel (65 Byte → 87 Zeichen), iv: 12 Byte → 16 Zeichen
  if (!body || body.v !== 1 || !isB64(body.epk, 87, 87) || !isB64(body.iv, 16, 16) || !isB64(body.ct, 24, MAX_MESSAGE_BYTES)) {
    return json(request, env, 400, { error: 'invalid-message' });
  }
  const count = await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE box_id = ?').bind(boxId).first();
  if (Number(count?.n) >= MAX_MESSAGES_PER_BOX) return json(request, env, 507, { error: 'mailbox-full' });
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare('INSERT INTO messages (id, box_id, created_at, body) VALUES (?, ?, ?, ?)')
    .bind(id, boxId, now, JSON.stringify({ v: 1, epk: body.epk, iv: body.iv, ct: body.ct }))
    .run();
  // Gelegentlich aufräumen – für den Fall, dass kein Cron-Trigger eingerichtet ist
  if (Math.random() < 0.02) await removeExpired(db, now);
  return json(request, env, 201, { id, createdAt: now });
}

/**
 * Löscht Rückmeldungen und Verzeichniseinträge, die bald 200 Tage alt sind. Der Cron-Trigger läuft einmal
 * am Tag – mit einem Tag Vorlauf liegt so nichts länger als 200 Tage in der Datenbank.
 */
async function removeExpired(db, now = Date.now()) {
  const limit = now - (RETENTION_MS - DAY_MS);
  const [messages, directory] = await db.batch([
    db.prepare('DELETE FROM messages WHERE created_at < ?').bind(limit),
    db.prepare('DELETE FROM directory WHERE updated_at < ?').bind(limit),
  ]);
  return { messages: Number(messages?.meta?.changes ?? 0), directory: Number(directory?.meta?.changes ?? 0) };
}

async function listMessages(request, env, db, boxId) {
  if (!(await authorized(request, boxId))) return json(request, env, 403, { error: 'forbidden' });
  const { results } = await db
    .prepare('SELECT id, created_at, body FROM messages WHERE box_id = ? AND created_at >= ? ORDER BY created_at LIMIT ?')
    .bind(boxId, Date.now() - RETENTION_MS, MAX_MESSAGES_PER_BOX)
    .all();
  const messages = (results || []).map((row) => ({ id: row.id, createdAt: Number(row.created_at), ...JSON.parse(row.body) }));
  return json(request, env, 200, { messages });
}

async function clearMessages(request, env, db, boxId) {
  if (!(await authorized(request, boxId))) return json(request, env, 403, { error: 'forbidden' });
  // ?before=<ms>: nur, was die Lehrkraft schon abgeholt hat – Rückmeldungen, die inzwischen eingegangen sind, bleiben.
  const before = new URL(request.url).searchParams.get('before');
  if (before !== null && !/^\d{1,15}$/.test(before)) return json(request, env, 400, { error: 'invalid-before' });
  const result =
    before === null
      ? await db.prepare('DELETE FROM messages WHERE box_id = ?').bind(boxId).run()
      : await db.prepare('DELETE FROM messages WHERE box_id = ? AND created_at < ?').bind(boxId, Number(before)).run();
  return json(request, env, 200, { deleted: Number(result?.meta?.changes ?? 0) });
}

async function putDirectory(request, env, db, dirId) {
  const body = await readJson(request, MAX_DIRECTORY_BYTES);
  if (!body || !ID_RE.test(String(body.box || '')) || !isB64(body.iv, 16, 16) || !isB64(body.ct, 24, MAX_DIRECTORY_BYTES)) {
    return json(request, env, 400, { error: 'invalid-entry' });
  }
  if (!(await authorized(request, body.box))) return json(request, env, 403, { error: 'forbidden' });
  const existing = await db.prepare('SELECT box_id, updated_at FROM directory WHERE dir_id = ?').bind(dirId).first();
  // Ein Eintrag gehört dem Briefkasten, der ihn zuerst angelegt hat – bis er 200 Tage nicht mehr aktualisiert wurde.
  if (existing && existing.box_id !== body.box && Number(existing.updated_at) >= Date.now() - RETENTION_MS) return json(request, env, 409, { error: 'taken' });
  await db
    .prepare('INSERT INTO directory (dir_id, box_id, updated_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(dir_id) DO UPDATE SET box_id = excluded.box_id, updated_at = excluded.updated_at, body = excluded.body')
    .bind(dirId, body.box, Date.now(), JSON.stringify({ iv: body.iv, ct: body.ct }))
    .run();
  return json(request, env, existing ? 200 : 201, { ok: true });
}

async function getDirectory(request, env, db, dirId) {
  const row = await db.prepare('SELECT body FROM directory WHERE dir_id = ? AND updated_at >= ?').bind(dirId, Date.now() - RETENTION_MS).first();
  // Kein Eintrag ist bei Eltern mit Termin-Schlüssel normal (z. B. Brief ohne Briefkasten) – daher kein 404,
  // das der Browser als Fehler in der Konsole meldet.
  if (!row) return json(request, env, 200, { found: false });
  return json(request, env, 200, JSON.parse(row.body));
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') return json(request, env, 404, { error: 'not-found' });
      if (parts[1] === 'health' && parts.length === 2 && request.method === 'GET') return json(request, env, 200, { ok: true, service: 'ParentsDay-Briefkasten', version: 1 });
      if (!env.DB) return json(request, env, 500, { error: 'no-database' });
      await ensureSchema(env.DB);

      if (parts[1] === 'boxes' && parts.length === 4 && parts[3] === 'messages' && ID_RE.test(parts[2])) {
        if (request.method === 'POST') return await postMessage(request, env, env.DB, parts[2]);
        if (request.method === 'GET') return await listMessages(request, env, env.DB, parts[2]);
        if (request.method === 'DELETE') return await clearMessages(request, env, env.DB, parts[2]);
        return json(request, env, 405, { error: 'method-not-allowed' });
      }
      if (parts[1] === 'directory' && parts.length === 3 && ID_RE.test(parts[2])) {
        if (request.method === 'PUT') return await putDirectory(request, env, env.DB, parts[2]);
        if (request.method === 'GET') return await getDirectory(request, env, env.DB, parts[2]);
        return json(request, env, 405, { error: 'method-not-allowed' });
      }
      return json(request, env, 404, { error: 'not-found' });
    } catch (err) {
      console.error(err);
      return json(request, env, 500, { error: 'server-error' });
    }
  },

  // Täglicher Cron-Trigger (siehe docs/BRIEFKASTEN.md bzw. worker/wrangler.toml)
  async scheduled(event, env) {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    const removed = await removeExpired(env.DB);
    console.log(`Aufgeräumt: ${removed.messages} Rückmeldungen, ${removed.directory} Verzeichniseinträge`);
  },
};
