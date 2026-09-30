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
// 200 Tage alt sind. Ältere gibt der Dienst auch ohne Cron-Trigger nicht mehr heraus. Cloud-Sicherungen, die
// 400 Tage weder geändert noch abgerufen wurden, löscht er ebenfalls.
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
//
// Cloud-Sicherung (kompletter Stand der Lehrkraft, im Browser mit ihrem Passwort verschlüsselt, js/core/cloud.js):
//   GET    /v1/sync/<syncId>/salt              → { found:false } oder { found:true, salt, iterations }
//   GET    /v1/sync/<syncId>[?since=<Version>] Stand abrufen (Bearer <token>) → { found, version, updatedAt, iv, ct, z }
//                                              (mit since und unveränderter Version nur { …, unchanged:true })
//   PUT    /v1/sync/<syncId>                   Stand speichern (Bearer <token>): { baseVersion, iv, ct, z }
//                                              neu anlegen: baseVersion 0 und { salt, iterations, authHash }
//                                              Passwort ändern: zusätzlich neue { salt, iterations, authHash }
//                                              → { version, updatedAt }; 409 { version }, wenn inzwischen geändert
//   POST   /v1/sync/<syncId>/reset             „Passwort vergessen“: ersetzt den Stand durch einen neuen
//                                              (Bearer <neues token>, Angaben wie beim Anlegen)
//   DELETE /v1/sync/<syncId>                   Cloud-Sicherung löschen (Bearer <token>)
// Das Token entsteht im Browser aus dem Passwort (PBKDF2); gespeichert wird nur sein SHA-256-Wert (authHash).
// Nach 10 falschen Tokens innerhalb einer Stunde ist der Zugang für den Rest der Stunde gesperrt.

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

// Cloud-Sicherung
const SALT_RE = /^[A-Za-z0-9_-]{22}$/; // 16 Byte
const SYNC_MIN_ITERATIONS = 100000;
const SYNC_MAX_ITERATIONS = 10000000;
const SYNC_CHUNK_CHARS = 90000; // je Datenbankzeile – bleibt unter der Grenze von 100 KB je SQL-Anweisung
const SYNC_MAX_CT_CHARS = 20 * SYNC_CHUNK_CHARS; // ≈ 1,35 MB verschlüsselt (komprimiert) – reicht für sehr viele Klassen
const SYNC_MAX_BODY_BYTES = SYNC_MAX_CT_CHARS + 4096;
const SYNC_MAX_FAILS = 10; // falsche Tokens je Stunde, danach gesperrt
const SYNC_FAIL_WINDOW_MS = 60 * 60 * 1000;
const SYNC_MAX_RESETS = 3; // „Passwort vergessen“ je Tag
const SYNC_RETENTION_MS = 400 * DAY_MS; // ohne Änderung oder Abruf
const SYNC_WRITES_PER_MINUTE = 120; // je IP-Adresse – Lehrkräfte einer Schule teilen sich oft eine Adresse

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
        db.prepare(
          'CREATE TABLE IF NOT EXISTS sync (sync_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, seen_at INTEGER NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL, auth_hash TEXT NOT NULL, iv TEXT NOT NULL, z INTEGER NOT NULL, chunks INTEGER NOT NULL, writer TEXT NOT NULL, fails INTEGER NOT NULL DEFAULT 0, fail_since INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL DEFAULT 0, reset_since INTEGER NOT NULL DEFAULT 0)',
        ),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_seen ON sync (seen_at)'),
        db.prepare('CREATE TABLE IF NOT EXISTS sync_chunks (sync_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (sync_id, idx))'),
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

async function sha256B64(text) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let bin = '';
  for (const b of hash) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function boxIdFromSecret(secret) {
  return (await sha256B64(secret)).slice(0, 32);
}

/** Geheimnis bzw. Token aus „Authorization: Bearer …“ oder ''. */
function bearer(request) {
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('Authorization') || '');
  return m && SECRET_RE.test(m[1]) ? m[1] : '';
}

/** Prüft „Authorization: Bearer <secret>“ gegen die Briefkasten-ID. */
async function authorized(request, boxId) {
  const secret = bearer(request);
  return Boolean(secret) && (await boxIdFromSecret(secret)) === boxId;
}

/** Vergleich in konstanter Zeit (verrät nicht, ab welchem Zeichen sich zwei Werte unterscheiden). */
function sameText(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
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

function tooManyRequests(request, log, limit) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unbekannt';
  const now = Date.now();
  const recent = (log.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  log.set(ip, recent);
  if (log.size > 5000) log.clear();
  return recent.length > limit;
}

function tooManyPosts(request, env) {
  return tooManyRequests(request, postLog, Number(env.POSTS_PER_MINUTE) || POSTS_PER_MINUTE);
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
 * Cloud-Sicherungen werden gelöscht, wenn sie 400 Tage weder geändert noch abgerufen wurden.
 */
async function removeExpired(db, now = Date.now()) {
  const limit = now - (RETENTION_MS - DAY_MS);
  const syncLimit = now - (SYNC_RETENTION_MS - DAY_MS);
  const [messages, directory, sync] = await db.batch([
    db.prepare('DELETE FROM messages WHERE created_at < ?').bind(limit),
    db.prepare('DELETE FROM directory WHERE updated_at < ?').bind(limit),
    db.prepare('DELETE FROM sync WHERE seen_at < ?').bind(syncLimit),
    db.prepare('DELETE FROM sync_chunks WHERE sync_id NOT IN (SELECT sync_id FROM sync)'),
  ]);
  return { messages: Number(messages?.meta?.changes ?? 0), directory: Number(directory?.meta?.changes ?? 0), sync: Number(sync?.meta?.changes ?? 0) };
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

// ---------- Cloud-Sicherung ----------

const syncWriteLog = new Map();

function tooManySyncWrites(request, env) {
  return tooManyRequests(request, syncWriteLog, Number(env.SYNC_WRITES_PER_MINUTE) || SYNC_WRITES_PER_MINUTE);
}

function getSyncRow(db, syncId) {
  return db
    .prepare('SELECT version, updated_at, seen_at, salt, iterations, auth_hash, iv, z, chunks, fails, fail_since, resets, reset_since FROM sync WHERE sync_id = ?')
    .bind(syncId)
    .first();
}

function validSyncData(body) {
  return Boolean(body) && isB64(body.iv, 16, 16) && isB64(body.ct, 24, SYNC_MAX_CT_CHARS) && (body.z === 0 || body.z === 1);
}

function validSyncKeys(body) {
  return (
    SALT_RE.test(String(body.salt || '')) &&
    Number.isInteger(body.iterations) &&
    body.iterations >= SYNC_MIN_ITERATIONS &&
    body.iterations <= SYNC_MAX_ITERATIONS &&
    SECRET_RE.test(String(body.authHash || ''))
  );
}

/** Beim Anlegen muss das mitgeschickte Token zum authHash passen – sonst könnte sich niemand mehr anmelden. */
async function tokenMatchesHash(request, authHash) {
  const token = bearer(request);
  return Boolean(token) && sameText(await sha256B64(token), authHash);
}

/**
 * Prüft das Token der Lehrkraft. Gibt null zurück, wenn es stimmt, sonst die Fehlerantwort.
 * Falsche Tokens werden gezählt: Nach SYNC_MAX_FAILS innerhalb einer Stunde ist der Zugang bis zum Ende
 * dieser Stunde gesperrt – so lässt sich das Passwort nicht durch Ausprobieren herausfinden.
 */
async function checkSyncToken(request, env, db, syncId, row, now) {
  const failSince = Number(row.fail_since);
  if (Number(row.fails) >= SYNC_MAX_FAILS && now - failSince < SYNC_FAIL_WINDOW_MS) {
    return json(request, env, 429, { error: 'locked', retryAfter: Math.ceil((failSince + SYNC_FAIL_WINDOW_MS - now) / 1000) });
  }
  if (await tokenMatchesHash(request, row.auth_hash)) return null;
  await db
    .prepare('UPDATE sync SET fails = CASE WHEN ? - fail_since >= ? THEN 1 ELSE fails + 1 END, fail_since = CASE WHEN ? - fail_since >= ? THEN ? ELSE fail_since END WHERE sync_id = ?')
    .bind(now, SYNC_FAIL_WINDOW_MS, now, SYNC_FAIL_WINDOW_MS, now, syncId)
    .run();
  return json(request, env, 403, { error: 'forbidden' });
}

/**
 * Anweisungen zum Speichern der verschlüsselten Daten in Stücken (je höchstens SYNC_CHUNK_CHARS Zeichen).
 * Sie wirken nur, wenn die Zeile in `sync` noch von diesem Schreibvorgang (`writer`) stammt – kam ein anderer
 * Schreibvorgang dazwischen, bleibt dessen Stand vollständig erhalten.
 */
function chunkStatements(db, syncId, ct, writer) {
  const statements = [];
  let count = 0;
  for (let i = 0; i < ct.length; i += SYNC_CHUNK_CHARS, count++) {
    statements.push(
      db
        .prepare(
          'INSERT INTO sync_chunks (sync_id, idx, data) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync WHERE sync_id = ? AND writer = ?) ON CONFLICT(sync_id, idx) DO UPDATE SET data = excluded.data',
        )
        .bind(syncId, count, ct.slice(i, i + SYNC_CHUNK_CHARS), syncId, writer),
    );
  }
  statements.push(
    db.prepare('DELETE FROM sync_chunks WHERE sync_id = ? AND idx >= ? AND EXISTS (SELECT 1 FROM sync WHERE sync_id = ? AND writer = ?)').bind(syncId, count, syncId, writer),
  );
  return { statements, count };
}

async function getSyncSalt(request, env, db, syncId) {
  const row = await db.prepare('SELECT salt, iterations FROM sync WHERE sync_id = ?').bind(syncId).first();
  // Keine Sicherung ist normal (Lehrkraft hat noch keine eingerichtet) – daher kein 404.
  return json(request, env, 200, row ? { found: true, salt: row.salt, iterations: Number(row.iterations) } : { found: false });
}

async function getSync(request, env, db, syncId) {
  const now = Date.now();
  const row = await getSyncRow(db, syncId);
  if (!row) return json(request, env, 200, { found: false });
  const denied = await checkSyncToken(request, env, db, syncId, row, now);
  if (denied) return denied;
  // Abruf zählt als Nutzung (für das Aufräumen nach 400 Tagen) – höchstens einmal am Tag geschrieben.
  if (Number(row.fails) > 0 || now - Number(row.seen_at) > DAY_MS) {
    await db.prepare('UPDATE sync SET fails = 0, fail_since = 0, seen_at = ? WHERE sync_id = ?').bind(now, syncId).run();
  }
  const since = new URL(request.url).searchParams.get('since');
  if (since !== null && /^\d{1,15}$/.test(since) && Number(since) === Number(row.version)) {
    return json(request, env, 200, { found: true, version: Number(row.version), updatedAt: Number(row.updated_at), unchanged: true });
  }
  // Zeile und Stücke in einem Zug lesen, damit sie sicher zum selben Stand gehören.
  const [head, parts] = await db.batch([
    db.prepare('SELECT version, updated_at, iv, z, chunks FROM sync WHERE sync_id = ?').bind(syncId),
    db.prepare('SELECT idx, data FROM sync_chunks WHERE sync_id = ? ORDER BY idx').bind(syncId),
  ]);
  const current = head?.results?.[0];
  if (!current) return json(request, env, 200, { found: false });
  const chunks = (parts?.results || []).filter((c) => Number(c.idx) < Number(current.chunks));
  if (chunks.length !== Number(current.chunks)) return json(request, env, 500, { error: 'incomplete' });
  return json(request, env, 200, {
    found: true,
    version: Number(current.version),
    updatedAt: Number(current.updated_at),
    iv: current.iv,
    z: Number(current.z),
    ct: chunks.map((c) => c.data).join(''),
  });
}

async function putSync(request, env, db, syncId) {
  if (tooManySyncWrites(request, env)) return json(request, env, 429, { error: 'too-many-requests' });
  const body = await readJson(request, SYNC_MAX_BODY_BYTES);
  if (!validSyncData(body) || !Number.isInteger(body.baseVersion) || body.baseVersion < 0) return json(request, env, 400, { error: 'invalid-data' });
  const now = Date.now();
  const row = await getSyncRow(db, syncId);
  const writer = crypto.randomUUID();
  const { statements, count } = chunkStatements(db, syncId, body.ct, writer);

  if (!row) {
    // Neu anlegen – nur, wenn der Browser auch keinen früheren Stand erwartet (sonst wurde die Sicherung gelöscht).
    if (body.baseVersion !== 0) return json(request, env, 409, { error: 'conflict', found: false, version: 0 });
    if (!validSyncKeys(body) || !(await tokenMatchesHash(request, body.authHash))) return json(request, env, 400, { error: 'invalid-keys' });
    const [created] = await db.batch([
      db
        .prepare(
          'INSERT INTO sync (sync_id, version, updated_at, seen_at, salt, iterations, auth_hash, iv, z, chunks, writer) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sync_id) DO NOTHING',
        )
        .bind(syncId, now, now, body.salt, body.iterations, body.authHash, body.iv, body.z, count, writer),
      ...statements,
    ]);
    if (!Number(created?.meta?.changes)) return json(request, env, 409, { error: 'conflict' });
    return json(request, env, 201, { version: 1, updatedAt: now });
  }

  const denied = await checkSyncToken(request, env, db, syncId, row, now);
  if (denied) return denied;
  if (body.baseVersion !== Number(row.version)) {
    return json(request, env, 409, { error: 'conflict', found: true, version: Number(row.version), updatedAt: Number(row.updated_at) });
  }
  // Neues Passwort: neue Angaben zum Schlüssel (die Daten sind bereits mit dem neuen Schlüssel verschlüsselt).
  const rekey = body.salt !== undefined || body.iterations !== undefined || body.authHash !== undefined;
  if (rekey && !validSyncKeys(body)) return json(request, env, 400, { error: 'invalid-keys' });
  const version = Number(row.version) + 1;
  const update = rekey
    ? db
        .prepare(
          'UPDATE sync SET version = ?, updated_at = ?, seen_at = ?, iv = ?, z = ?, chunks = ?, writer = ?, fails = 0, fail_since = 0, salt = ?, iterations = ?, auth_hash = ? WHERE sync_id = ? AND version = ?',
        )
        .bind(version, now, now, body.iv, body.z, count, writer, body.salt, body.iterations, body.authHash, syncId, row.version)
    : db
        .prepare('UPDATE sync SET version = ?, updated_at = ?, seen_at = ?, iv = ?, z = ?, chunks = ?, writer = ?, fails = 0, fail_since = 0 WHERE sync_id = ? AND version = ?')
        .bind(version, now, now, body.iv, body.z, count, writer, syncId, row.version);
  const [updated] = await db.batch([update, ...statements]);
  // Ein anderer Schreibvorgang kam dazwischen: Der Browser holt den neuen Stand und entscheidet neu.
  if (!Number(updated?.meta?.changes)) return json(request, env, 409, { error: 'conflict', found: true });
  return json(request, env, 200, { version, updatedAt: now });
}

/** „Passwort vergessen“: Die alte Sicherung ist ohne Passwort nicht lesbar – sie wird durch eine neue ersetzt. */
async function resetSync(request, env, db, syncId) {
  if (tooManySyncWrites(request, env)) return json(request, env, 429, { error: 'too-many-requests' });
  const body = await readJson(request, SYNC_MAX_BODY_BYTES);
  if (!validSyncData(body) || !validSyncKeys(body) || !(await tokenMatchesHash(request, body.authHash))) return json(request, env, 400, { error: 'invalid-data' });
  const now = Date.now();
  const row = await getSyncRow(db, syncId);
  const writer = crypto.randomUUID();
  const { statements, count } = chunkStatements(db, syncId, body.ct, writer);
  if (!row) {
    const [created] = await db.batch([
      db
        .prepare(
          'INSERT INTO sync (sync_id, version, updated_at, seen_at, salt, iterations, auth_hash, iv, z, chunks, writer, resets, reset_since) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(sync_id) DO NOTHING',
        )
        .bind(syncId, now, now, body.salt, body.iterations, body.authHash, body.iv, body.z, count, writer, now),
      ...statements,
    ]);
    if (!Number(created?.meta?.changes)) return json(request, env, 409, { error: 'conflict' });
    return json(request, env, 201, { version: 1, updatedAt: now });
  }
  const resetSince = Number(row.reset_since);
  const fresh = now - resetSince >= DAY_MS;
  if (!fresh && Number(row.resets) >= SYNC_MAX_RESETS) {
    return json(request, env, 429, { error: 'too-many-resets', retryAfter: Math.ceil((resetSince + DAY_MS - now) / 1000) });
  }
  const version = Number(row.version) + 1;
  const [updated] = await db.batch([
    db
      .prepare(
        'UPDATE sync SET version = ?, updated_at = ?, seen_at = ?, salt = ?, iterations = ?, auth_hash = ?, iv = ?, z = ?, chunks = ?, writer = ?, fails = 0, fail_since = 0, resets = ?, reset_since = ? WHERE sync_id = ? AND version = ?',
      )
      .bind(version, now, now, body.salt, body.iterations, body.authHash, body.iv, body.z, count, writer, fresh ? 1 : Number(row.resets) + 1, fresh ? now : resetSince, syncId, row.version),
    ...statements,
  ]);
  if (!Number(updated?.meta?.changes)) return json(request, env, 409, { error: 'conflict' });
  return json(request, env, 200, { version, updatedAt: now });
}

async function deleteSync(request, env, db, syncId) {
  const now = Date.now();
  const row = await getSyncRow(db, syncId);
  if (!row) return json(request, env, 200, { deleted: false });
  const denied = await checkSyncToken(request, env, db, syncId, row, now);
  if (denied) return denied;
  await db.batch([db.prepare('DELETE FROM sync WHERE sync_id = ?').bind(syncId), db.prepare('DELETE FROM sync_chunks WHERE sync_id = ?').bind(syncId)]);
  return json(request, env, 200, { deleted: true });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') return json(request, env, 404, { error: 'not-found' });
      if (parts[1] === 'health' && parts.length === 2 && request.method === 'GET') return json(request, env, 200, { ok: true, service: 'ParentsDay-Briefkasten', version: 2, sync: true });
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
      if (parts[1] === 'sync' && ID_RE.test(parts[2] || '')) {
        if (parts.length === 4 && parts[3] === 'salt' && request.method === 'GET') return await getSyncSalt(request, env, env.DB, parts[2]);
        if (parts.length === 4 && parts[3] === 'reset' && request.method === 'POST') return await resetSync(request, env, env.DB, parts[2]);
        if (parts.length === 3) {
          if (request.method === 'GET') return await getSync(request, env, env.DB, parts[2]);
          if (request.method === 'PUT') return await putSync(request, env, env.DB, parts[2]);
          if (request.method === 'DELETE') return await deleteSync(request, env, env.DB, parts[2]);
        }
        const known = parts.length === 3 || (parts.length === 4 && ['salt', 'reset'].includes(parts[3]));
        return json(request, env, known ? 405 : 404, { error: known ? 'method-not-allowed' : 'not-found' });
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
    console.log(`Aufgeräumt: ${removed.messages} Rückmeldungen, ${removed.directory} Verzeichniseinträge, ${removed.sync} Cloud-Sicherungen`);
  },
};
