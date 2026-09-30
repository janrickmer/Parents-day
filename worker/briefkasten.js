// ParentsDay-Briefkasten (Cloudflare Worker + D1-Datenbank)
//
// Nimmt die Rückmeldungen der Eltern entgegen und gibt sie an die Lehrkraft heraus. Die Rückmeldungen
// werden schon im Browser der Eltern mit dem öffentlichen Schlüssel der Lehrkraft verschlüsselt
// (ECDH P-256 + AES-GCM). Dieser Dienst sieht nur unlesbare Daten – keine Namen, keine Zeiten.
//
// Einrichtung: siehe docs/BRIEFKASTEN.md. Benötigt wird die D1-Bindung `DB`.
// Optionale Variablen: ALLOWED_ORIGINS – erlaubte Web-Adressen, kommagetrennt
// (Standard: https://parentsday.janrickmer.de); POSTS_PER_MINUTE – Rückmeldungen je IP und Minute (Standard 30);
// IP_HASH_KEY (als Secret) – Schlüssel für die pseudonymen Hashwerte der IP-Adressen (sonst ein täglicher Zufallswert).
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
// Cloud-Sicherung (kompletter Stand der Lehrkraft, im Browser mit ihrem Passwort verschlüsselt, js/core/cloud.js).
// Adresse (syncId), Schlüssel und Tokens entstehen im Browser aus Passwort, Name und Geburtsdatum – ohne das Passwort
// lässt sich eine Sicherung weder finden noch öffnen, überschreiben oder löschen. who ist ein Hashwert aus Name und
// Geburtsdatum; gespeichert wird eine Sicherung unter SHA-256(who|syncId) – who selbst steht nicht in der Datenbank.
//   POST   /v1/sync/<syncId>/open          Sicherung auf einem Gerät öffnen: Bearer <token>, { who, device }
//                                          → { found:false } oder { found:true, version, updatedAt, iv, ct, z }
//                                          device: SHA-256 eines zufälligen Geräte-Geheimnisses – das Gerät darf
//                                          danach abgleichen
//   GET    /v1/sync/<syncId>[?since=<v>]   Stand abrufen (Bearer <token>, X-Who, X-Device: <Geräte-Geheimnis>)
//                                          mit since und unveränderter Version nur { …, unchanged:true }
//   PUT    /v1/sync/<syncId>               neu anlegen: { baseVersion:0, who, authHash, adminHash, device, iv, ct, z }
//                                          (Bearer <token>); ändern: { baseVersion, iv, ct, z } (Bearer <token>,
//                                          X-Who, X-Device) → { version, updatedAt }; 409, wenn es sie schon gibt
//                                          bzw. sie inzwischen geändert wurde
//   DELETE /v1/sync/<syncId>               löschen (Bearer <adminToken>, X-Who, X-Device)
// Versuche, eine Sicherung zu öffnen oder anzulegen, werden je Lehrkraft (who) gezählt: höchstens 10 je Stunde und
// Anschluss und 30 am Tag insgesamt – so lässt sich ein Passwort nicht durch Ausprobieren finden. Erfolgreiches
// Öffnen zählt nicht, Anlegen immer. Abgleichen von einem eingetragenen Gerät zählt nie. Abrufen, Speichern und
// Löschen antworten bei jedem Fehler gleich (403) – ohne Passwort ist nicht zu erkennen, ob es eine Sicherung gibt.
// Zum Zählen wird statt der IP-Adresse ein pseudonymer Hashwert gespeichert (HMAC mit IP_HASH_KEY bzw. täglich
// neuem Zufallswert), nach spätestens 2 Tagen gelöscht. Sicherungen, die nach dem Anlegen nie geändert oder
// abgerufen wurden, werden nach 30 Tagen gelöscht, alle anderen nach 400 Tagen ohne Nutzung.

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
const WHO_RE = /^[A-Za-z0-9_-]{22}$/;
const HOUR_MS = 60 * 60 * 1000;
const SYNC_CHUNK_CHARS = 90000; // je Datenbankzeile – bleibt unter der Grenze von 100 KB je SQL-Anweisung
const SYNC_MAX_CT_CHARS = 8 * SYNC_CHUNK_CHARS; // ≈ 540 KB verschlüsselt und komprimiert – reicht für sehr viele Klassen
const SYNC_MAX_BODY_BYTES = SYNC_MAX_CT_CHARS + 4096;
const SYNC_MAX_TOTAL_CHARS = 250 * 1000 * 1000; // alle Sicherungen zusammen (die Datenbank fasst im kostenlosen Tarif 500 MB)
const SYNC_MAX_DEVICES = 20; // eingetragene Geräte je Sicherung (die am längsten nicht geöffneten fallen heraus)
const OPEN_PER_HOUR_PER_IP = 10; // Fehlversuche je Lehrkraft, Stunde und Anschluss
const OPEN_PER_DAY = 30; // Fehlversuche je Lehrkraft und Tag insgesamt
const CREATES_PER_DAY_PER_IP = 20; // neue Sicherungen je Anschluss und Tag (Schulen teilen sich oft eine Adresse)
const CREATE_CHARS_PER_DAY_PER_IP = 5 * 1000 * 1000; // Umfang neuer Sicherungen je Anschluss und Tag
const SYNC_RETENTION_MS = 400 * DAY_MS; // ohne Änderung oder Abruf
const UNUSED_RETENTION_MS = 30 * DAY_MS; // nach dem Anlegen nie geändert oder abgerufen
const LIMIT_RETENTION_MS = 2 * DAY_MS;
const SYNC_WRITES_PER_MINUTE = 120; // je IP-Adresse und Worker-Instanz

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
          'CREATE TABLE IF NOT EXISTS cloud (id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, seen_at INTEGER NOT NULL, auth_hash TEXT NOT NULL, admin_hash TEXT NOT NULL, devices TEXT NOT NULL, iv TEXT NOT NULL, z INTEGER NOT NULL, chunks INTEGER NOT NULL, size INTEGER NOT NULL, writer TEXT NOT NULL)',
        ),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_cloud_seen ON cloud (seen_at)'),
        db.prepare('CREATE TABLE IF NOT EXISTS cloud_chunks (cloud_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (cloud_id, idx))'),
        // Tabellen einer Vorabfassung der Cloud-Sicherung (nie im Einsatz) entfernen
        db.prepare('DROP TABLE IF EXISTS sync_chunks'),
        db.prepare('DROP TABLE IF EXISTS sync'),
        db.prepare('CREATE TABLE IF NOT EXISTS cloud_limits (key TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL)'),
        db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, day INTEGER NOT NULL)'),
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device, X-Who',
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
 * Cloud-Sicherungen werden gelöscht, wenn sie 400 Tage weder geändert noch abgerufen wurden – oder schon nach
 * 30 Tagen, wenn sie nach dem Anlegen nie geändert oder abgerufen wurden (z. B. Müll von Fremden); Zähler nach 2 Tagen.
 */
async function removeExpired(db, now = Date.now()) {
  const limit = now - (RETENTION_MS - DAY_MS);
  const syncLimit = now - (SYNC_RETENTION_MS - DAY_MS);
  const [messages, directory, cloud] = await db.batch([
    db.prepare('DELETE FROM messages WHERE created_at < ?').bind(limit),
    db.prepare('DELETE FROM directory WHERE updated_at < ?').bind(limit),
    db.prepare('DELETE FROM cloud WHERE seen_at < ? OR (version = 1 AND seen_at < ?)').bind(syncLimit, now - UNUSED_RETENTION_MS),
    db.prepare('DELETE FROM cloud_chunks WHERE cloud_id NOT IN (SELECT id FROM cloud)'),
    db.prepare('DELETE FROM cloud_limits WHERE win < ?').bind(now - LIMIT_RETENTION_MS),
  ]);
  return { messages: Number(messages?.meta?.changes ?? 0), directory: Number(directory?.meta?.changes ?? 0), sync: Number(cloud?.meta?.changes ?? 0) };
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
  if (tooManyPosts(request, env)) return json(request, env, 429, { error: 'too-many-requests' });
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

function randomB64(bytes) {
  let bin = '';
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Netz der IP-Adresse: IPv4 unverändert, IPv6 die ersten `groups` Gruppen (4 = /64 – ein Anschluss hat meist ein
 * ganzes /64-Netz; 3 = /48 – so viel bekommt ein Kunde höchstens).
 */
function network(ip, groups = 4) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full
    .slice(0, groups)
    .map((part) => part.replace(/^0+(?=.)/, ''))
    .join(':');
}

let ipSalt = null; // { day, value } – je Worker-Instanz zwischengespeichert
let ipHmac = null; // { secret, key }

async function dailySalt(db, day) {
  if (ipSalt?.day === day) return ipSalt.value;
  const read = () => db.prepare("SELECT value, day FROM meta WHERE key = 'ip-salt'").first();
  let row = await read();
  if (!row || Number(row.day) !== day) {
    await db
      .prepare("INSERT INTO meta (key, value, day) VALUES ('ip-salt', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, day = excluded.day WHERE meta.day <> excluded.day")
      .bind(randomB64(24), day)
      .run();
    row = await read();
  }
  ipSalt = { day, value: row.value };
  return row.value;
}

/**
 * Pseudonymer Hashwert der IP-Adresse (bzw. ihres Netzes) zum Zählen von Versuchen – er wechselt täglich.
 * Mit dem Secret IP_HASH_KEY: HMAC-SHA256 (der Schlüssel steht nicht in der Datenbank); sonst SHA-256 mit einem
 * täglich neuen Zufallswert aus der Tabelle meta.
 */
async function ipKey(request, env, db, { groups = 4 } = {}) {
  const day = Math.floor(Date.now() / DAY_MS);
  const net = network(request.headers.get('CF-Connecting-IP') || 'unbekannt', groups);
  if (env.IP_HASH_KEY) {
    if (ipHmac?.secret !== env.IP_HASH_KEY) {
      ipHmac = { secret: env.IP_HASH_KEY, key: await crypto.subtle.importKey('raw', new TextEncoder().encode(env.IP_HASH_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
    }
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', ipHmac.key, new TextEncoder().encode(`${day}|${net}`)));
    let bin = '';
    for (const b of mac) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
  }
  return (await sha256B64(`${await dailySalt(db, day)}|${net}`)).slice(0, 22);
}

/** Erhöht einen Zähler atomar (UPSERT … RETURNING) um `amount` und liefert den neuen Stand. */
function countStatement(db, key, win, amount = 1) {
  return db
    .prepare(
      'INSERT INTO cloud_limits (key, win, n) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET n = CASE WHEN cloud_limits.win = excluded.win THEN cloud_limits.n + excluded.n ELSE excluded.n END, win = excluded.win RETURNING n',
    )
    .bind(key, win, amount);
}

function uncountStatement(db, key, win, amount = 1) {
  return db.prepare('UPDATE cloud_limits SET n = MAX(n - ?, 0) WHERE key = ? AND win = ?').bind(amount, key, win);
}

const secondsUntil = (ms) => Math.max(1, Math.ceil((ms - Date.now()) / 1000));

/**
 * Reserviert einen Versuch, eine Sicherung zu öffnen oder anzulegen (je Lehrkraft, Stunde und Anschluss sowie je
 * Lehrkraft und Tag). Der Zähler wird VOR der Prüfung erhöht – auch viele gleichzeitige Anfragen kommen so nicht
 * über die Grenze. Abgewiesene Versuche werden zurückgegeben (ein einzelner Anschluss kann so nicht das
 * Tageskontingent aufbrauchen), ebenso erfolgreiches Öffnen (release).
 */
async function reserveAttempt(request, env, db, who) {
  const now = Date.now();
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  const ip = await ipKey(request, env, db);
  const limits = [
    { key: `o|${who}|${ip}`, win: hour, max: OPEN_PER_HOUR_PER_IP, until: hour + HOUR_MS },
    { key: `o|${who}`, win: day, max: OPEN_PER_DAY, until: day + DAY_MS },
  ];
  const results = await db.batch(limits.map((l) => countStatement(db, l.key, l.win)));
  const exceeded = limits.find((l, i) => Number(results[i]?.results?.[0]?.n ?? Infinity) > l.max);
  const release = () => db.batch(limits.map((l) => uncountStatement(db, l.key, l.win)));
  if (exceeded) await release();
  return { exceeded: exceeded ? { error: 'locked', retryAfter: secondsUntil(exceeded.until) } : null, release };
}

/** Schlüssel der Zeile: Die Sicherung gehört zur Lehrkraft (who) – mit einem anderen who ist sie nicht zu erreichen. */
async function cloudRowId(who, syncId) {
  return sha256B64(`cloud|${who}|${syncId}`);
}

function getCloudRow(db, id) {
  return db.prepare('SELECT version, updated_at, seen_at, auth_hash, admin_hash, devices, chunks FROM cloud WHERE id = ?').bind(id).first();
}

function parseDevices(text) {
  try {
    const list = JSON.parse(text || '[]');
    return Array.isArray(list) ? list.filter((d) => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function validSyncData(body) {
  return Boolean(body) && isB64(body.iv, 16, 16) && isB64(body.ct, 24, SYNC_MAX_CT_CHARS) && (body.z === 0 || body.z === 1);
}

async function tokenMatchesHash(request, hash) {
  const token = bearer(request);
  return Boolean(token) && sameText(await sha256B64(token), hash);
}

/**
 * Prüft Lehrkraft (X-Who), Token (bzw. Admin-Token) und eingetragenes Gerät (X-Device). Gibt { id, row } zurück
 * oder null – dann antwortet der Dienst mit 403, gleich ob es die Sicherung gibt oder nicht.
 */
async function authorizedRow(request, db, syncId, { admin = false } = {}) {
  const who = request.headers.get('X-Who') || '';
  const device = request.headers.get('X-Device') || '';
  const token = bearer(request);
  const id = await cloudRowId(who, syncId);
  const [tokenHash, deviceHash, row] = await Promise.all([sha256B64(token), sha256B64(device), getCloudRow(db, id)]);
  if (!row || !WHO_RE.test(who) || !token || !SECRET_RE.test(device)) return null;
  if (!sameText(tokenHash, admin ? row.admin_hash : row.auth_hash)) return null;
  return parseDevices(row.devices).some((d) => sameText(d, deviceHash)) ? { id, row } : null;
}

/**
 * Anweisungen zum Speichern der verschlüsselten Daten in Stücken (je höchstens SYNC_CHUNK_CHARS Zeichen).
 * Sie wirken nur, wenn die Zeile in `cloud` noch von diesem Schreibvorgang (`writer`) stammt – kam ein anderer
 * Schreibvorgang dazwischen, bleibt dessen Stand vollständig erhalten.
 */
function chunkStatements(db, id, ct, writer) {
  const statements = [];
  let count = 0;
  for (let i = 0; i < ct.length; i += SYNC_CHUNK_CHARS, count++) {
    statements.push(
      db
        .prepare(
          'INSERT INTO cloud_chunks (cloud_id, idx, data) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM cloud WHERE id = ? AND writer = ?) ON CONFLICT(cloud_id, idx) DO UPDATE SET data = excluded.data',
        )
        .bind(id, count, ct.slice(i, i + SYNC_CHUNK_CHARS), id, writer),
    );
  }
  statements.push(db.prepare('DELETE FROM cloud_chunks WHERE cloud_id = ? AND idx >= ? AND EXISTS (SELECT 1 FROM cloud WHERE id = ? AND writer = ?)').bind(id, count, id, writer));
  return { statements, count };
}

/** Zeile und Stücke in einem Zug lesen (gehören sicher zum selben Stand). */
async function readCloudData(db, id) {
  const [head, parts] = await db.batch([
    db.prepare('SELECT version, updated_at, iv, z, chunks FROM cloud WHERE id = ?').bind(id),
    db.prepare('SELECT idx, data FROM cloud_chunks WHERE cloud_id = ? ORDER BY idx').bind(id),
  ]);
  const current = head?.results?.[0];
  if (!current) return null;
  const chunks = (parts?.results || []).filter((c) => Number(c.idx) < Number(current.chunks));
  if (chunks.length !== Number(current.chunks)) throw new Error('Cloud-Sicherung unvollständig');
  return {
    found: true,
    version: Number(current.version),
    updatedAt: Number(current.updated_at),
    iv: current.iv,
    z: Number(current.z),
    ct: chunks.map((c) => c.data).join(''),
  };
}

/** Trägt ein Gerät ein (die zuletzt geöffneten bleiben). Bedingt geschrieben – gleichzeitiges Öffnen verliert kein Gerät. */
async function addDevice(db, id, deviceHash) {
  for (let i = 0; i < 5; i++) {
    const row = await db.prepare('SELECT devices FROM cloud WHERE id = ?').bind(id).first();
    if (!row) return;
    const devices = [...parseDevices(row.devices).filter((d) => d !== deviceHash), deviceHash].slice(-SYNC_MAX_DEVICES);
    const res = await db.prepare('UPDATE cloud SET devices = ?, seen_at = ? WHERE id = ? AND devices = ?').bind(JSON.stringify(devices), Date.now(), id, row.devices).run();
    if (Number(res?.meta?.changes)) return;
  }
}

/** Neues Gerät: Passwort prüfen (gezählt), Gerät eintragen und den Stand herausgeben. */
async function openSync(request, env, db, syncId) {
  if (tooManySyncWrites(request, env)) return json(request, env, 429, { error: 'too-many-requests' });
  const body = await readJson(request, 2048);
  if (!body || !WHO_RE.test(String(body.who || '')) || !SECRET_RE.test(String(body.device || ''))) return json(request, env, 400, { error: 'invalid-request' });
  const attempt = await reserveAttempt(request, env, db, body.who);
  if (attempt.exceeded) return json(request, env, 429, attempt.exceeded);
  const id = await cloudRowId(body.who, syncId);
  const row = await getCloudRow(db, id);
  if (!row || !(await tokenMatchesHash(request, row.auth_hash))) return json(request, env, 200, { found: false });
  await attempt.release();
  await addDevice(db, id, body.device);
  return json(request, env, 200, (await readCloudData(db, id)) || { found: false });
}

async function getSync(request, env, db, syncId) {
  const auth = await authorizedRow(request, db, syncId);
  if (!auth) return json(request, env, 403, { error: 'forbidden' });
  const { id, row } = auth;
  const now = Date.now();
  // Abruf zählt als Nutzung (für das Aufräumen) – höchstens einmal am Tag geschrieben.
  if (now - Number(row.seen_at) > DAY_MS) await db.prepare('UPDATE cloud SET seen_at = ? WHERE id = ?').bind(now, id).run();
  const since = new URL(request.url).searchParams.get('since');
  if (since !== null && /^\d{1,15}$/.test(since) && Number(since) === Number(row.version)) {
    return json(request, env, 200, { found: true, version: Number(row.version), updatedAt: Number(row.updated_at), unchanged: true });
  }
  const data = await readCloudData(db, id);
  return json(request, env, data ? 200 : 403, data || { error: 'forbidden' });
}

async function createSync(request, env, db, syncId, body) {
  if (
    !WHO_RE.test(String(body.who || '')) ||
    !SECRET_RE.test(String(body.authHash || '')) ||
    !SECRET_RE.test(String(body.adminHash || '')) ||
    !SECRET_RE.test(String(body.device || '')) ||
    body.authHash === body.adminHash ||
    !(await tokenMatchesHash(request, body.authHash))
  ) {
    return json(request, env, 400, { error: 'invalid-keys' });
  }
  const now = Date.now();
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  // Zuerst die Grenzen je Anschluss (IPv6: ganzes /48) und für den Speicher – sie zählen nicht als Versuch der Lehrkraft.
  const ip = await ipKey(request, env, db, { groups: 3 });
  const [creates, chars, total] = await db.batch([
    countStatement(db, `c|${ip}`, day),
    countStatement(db, `cb|${ip}`, day, body.ct.length),
    db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM cloud'),
  ]);
  if (Number(creates?.results?.[0]?.n ?? Infinity) > CREATES_PER_DAY_PER_IP || Number(chars?.results?.[0]?.n ?? Infinity) > CREATE_CHARS_PER_DAY_PER_IP) {
    return json(request, env, 429, { error: 'too-many-creates', retryAfter: secondsUntil(day + DAY_MS) });
  }
  if (Number(total?.results?.[0]?.n) + body.ct.length > SYNC_MAX_TOTAL_CHARS) {
    await db.batch([uncountStatement(db, `c|${ip}`, day), uncountStatement(db, `cb|${ip}`, day, body.ct.length)]);
    return json(request, env, 507, { error: 'storage-full' });
  }
  // Jedes Anlegen zählt als Versuch der Lehrkraft – sonst ließe sich über „gibt es schon“ (409) ohne Grenze raten.
  const attempt = await reserveAttempt(request, env, db, body.who);
  if (attempt.exceeded) return json(request, env, 429, attempt.exceeded);
  const id = await cloudRowId(body.who, syncId);
  const writer = crypto.randomUUID();
  const { statements, count } = chunkStatements(db, id, body.ct, writer);
  const [inserted] = await db.batch([
    db
      .prepare(
        'INSERT INTO cloud (id, version, updated_at, seen_at, auth_hash, admin_hash, devices, iv, z, chunks, size, writer) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(id, now, now, body.authHash, body.adminHash, JSON.stringify([body.device]), body.iv, body.z, count, body.ct.length, writer),
    ...statements,
  ]);
  if (!Number(inserted?.meta?.changes)) return json(request, env, 409, { error: 'exists' });
  return json(request, env, 201, { version: 1, updatedAt: now });
}

async function putSync(request, env, db, syncId) {
  if (tooManySyncWrites(request, env)) return json(request, env, 429, { error: 'too-many-requests' });
  const body = await readJson(request, SYNC_MAX_BODY_BYTES);
  if (!validSyncData(body) || !Number.isInteger(body.baseVersion) || body.baseVersion < 0) return json(request, env, 400, { error: 'invalid-data' });
  if (body.baseVersion === 0) return createSync(request, env, db, syncId, body);
  const auth = await authorizedRow(request, db, syncId);
  if (!auth) return json(request, env, 403, { error: 'forbidden' });
  const { id, row } = auth;
  if (body.baseVersion !== Number(row.version)) {
    return json(request, env, 409, { error: 'conflict', version: Number(row.version), updatedAt: Number(row.updated_at) });
  }
  const now = Date.now();
  const version = Number(row.version) + 1;
  const writer = crypto.randomUUID();
  const { statements, count } = chunkStatements(db, id, body.ct, writer);
  const [updated] = await db.batch([
    db
      .prepare('UPDATE cloud SET version = ?, updated_at = ?, seen_at = ?, iv = ?, z = ?, chunks = ?, size = ?, writer = ? WHERE id = ? AND version = ?')
      .bind(version, now, now, body.iv, body.z, count, body.ct.length, writer, id, row.version),
    ...statements,
  ]);
  // Ein anderer Schreibvorgang kam dazwischen: Der Browser holt den neuen Stand und entscheidet neu.
  if (!Number(updated?.meta?.changes)) return json(request, env, 409, { error: 'conflict' });
  return json(request, env, 200, { version, updatedAt: now });
}

async function deleteSync(request, env, db, syncId) {
  const auth = await authorizedRow(request, db, syncId, { admin: true });
  if (!auth) return json(request, env, 403, { error: 'forbidden' });
  await db.batch([db.prepare('DELETE FROM cloud WHERE id = ?').bind(auth.id), db.prepare('DELETE FROM cloud_chunks WHERE cloud_id = ?').bind(auth.id)]);
  return json(request, env, 200, { deleted: true });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') return json(request, env, 404, { error: 'not-found' });
      if (parts[1] === 'health' && parts.length === 2 && request.method === 'GET') return json(request, env, 200, { ok: true, service: 'ParentsDay-Briefkasten', version: 3, sync: 2 });
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
        if (parts.length === 4 && parts[3] === 'open') {
          if (request.method === 'POST') return await openSync(request, env, env.DB, parts[2]);
          return json(request, env, 405, { error: 'method-not-allowed' });
        }
        if (parts.length === 3) {
          if (request.method === 'GET') return await getSync(request, env, env.DB, parts[2]);
          if (request.method === 'PUT') return await putSync(request, env, env.DB, parts[2]);
          if (request.method === 'DELETE') return await deleteSync(request, env, env.DB, parts[2]);
          return json(request, env, 405, { error: 'method-not-allowed' });
        }
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
