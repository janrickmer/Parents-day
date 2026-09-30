// Cloud-Sicherung: der komplette Stand der Lehrkraft, im Browser mit ihrem Passwort verschlüsselt und beim
// Briefkasten-Dienst (worker/briefkasten.js) abgelegt. So kann sie sich an jedem Gerät anmelden und hat dort
// ihren aktuellen Stand – ohne Zwischenspeicher-Datei. Der Dienst sieht nur unlesbare Daten.
//
// Schlüssel: PBKDF2-SHA256 mit 600 000 Durchläufen (Empfehlung von OWASP) aus Passwort und zufälligem
// Salt ergibt 512 Bit. Die ersten 256 Bit sind der AES-GCM-Schlüssel, die zweiten das Zugangs-Token für den
// Dienst. Der Dienst speichert nur SHA-256(Token) – daraus lässt sich weder das Token noch der Schlüssel
// berechnen. Das Passwort selbst verlässt den Browser nie.
// ID der Sicherung: aus Vorname, Nachname und Geburtsdatum (wie beim Vergleich zweier Lehrkräfte).
// Der Ablauf (wann hoch- und heruntergeladen wird) steckt in core/cloud-sync.js.

import { transliterate } from './codes.js';
import { bytesToB64, b64ToBytes, mailboxEnabled, serviceRequest, MailboxError } from './mailbox.js';
import { normalizeTeacherState } from './storage.js';
import { cleanDraft } from './backup.js';

/** Durchläufe für neue Passwörter (OWASP-Empfehlung für PBKDF2-HMAC-SHA256). */
export const PBKDF2_ITERATIONS = 600000;
export const MIN_PASSWORD_LENGTH = 10;
/** Größte verschlüsselte Sicherung (Zeichen), die der Dienst annimmt – wie SYNC_MAX_CT_CHARS im Worker. */
export const MAX_CLOUD_CT_CHARS = 1800000;

const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 10000000;
const SALT_RE = /^[A-Za-z0-9_-]{22}$/;
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const AAD_PREFIX = 'ParentsDay-Cloud-v1|';
const UPLOAD_TIMEOUT_MS = 30000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Ist ein Dienst für die Cloud-Sicherung eingerichtet? (derselbe wie für den digitalen Briefkasten) */
export function cloudEnabled() {
  return mailboxEnabled();
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** ID der Cloud-Sicherung einer Lehrkraft (Schreibweise von Namen, Umlauten und Akzenten spielt keine Rolle). */
export async function syncIdFor(teacher) {
  const material = `ParentsDay-Cloud-ID-v1|${transliterate(teacher.firstName)}|${transliterate(teacher.lastName)}|${teacher.birthDate}`;
  return bytesToB64(await sha256(material)).slice(0, 32);
}

/** Prüft ein neues Passwort. Gibt eine Fehlermeldung oder '' zurück. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (!value) return 'Bitte geben Sie ein Passwort ein.';
  if ([...value].length < MIN_PASSWORD_LENGTH) return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
  if (!value.trim()) return 'Das Passwort darf nicht nur aus Leerzeichen bestehen.';
  return '';
}

export function newSalt() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Leitet Schlüssel und Zugangs-Token aus dem Passwort ab (dauert je nach Gerät etwa eine halbe Sekunde).
 * @returns {Promise<{encKey:string, authToken:string}>} beide base64url, je 32 Byte
 */
export async function deriveCloudKeys(password, salt, iterations = PBKDF2_ITERATIONS) {
  if (!SALT_RE.test(String(salt)) || !Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('Die Angaben der Cloud-Sicherung sind ungültig.');
  }
  const base = await crypto.subtle.importKey('raw', enc.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(salt), iterations }, base, 512));
  return { encKey: bytesToB64(bits.slice(0, 32)), authToken: bytesToB64(bits.slice(32)) };
}

/** Wert, den der Dienst zum Prüfen des Tokens speichert. */
export async function authHashOf(authToken) {
  return bytesToB64(await sha256(authToken));
}

/** Gültige Schlüssel (z. B. aus dem Speicher des Browsers)? */
export function isValidCloudKeys(keys) {
  return Boolean(keys && /^[A-Za-z0-9_-]{43}$/.test(String(keys.encKey || '')) && /^[A-Za-z0-9_-]{43}$/.test(String(keys.authToken || '')));
}

// ---------- Ver- und Entschlüsseln ----------

async function transform(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

function aesKey(encKey) {
  return crypto.subtle.importKey('raw', b64ToBytes(encKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Verschlüsselt beliebige Daten für die Cloud-Sicherung (vorher mit gzip verkleinert, wenn der Browser das kann).
 * Die ID der Sicherung ist mit verschlüsselt (AAD): Daten lassen sich nicht unbemerkt einer anderen Sicherung unterschieben.
 * @returns {Promise<{iv:string, ct:string, z:0|1}>}
 */
export async function encryptCloudData(keys, syncId, data) {
  let bytes = enc.encode(JSON.stringify(data));
  let z = 0;
  if (typeof CompressionStream === 'function') {
    try {
      bytes = await transform(bytes, new CompressionStream('gzip'));
      z = 1;
    } catch {
      bytes = enc.encode(JSON.stringify(data));
    }
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(AAD_PREFIX + syncId) }, await aesKey(keys.encKey), bytes));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct), z };
}

/** Entschlüsselt Daten der Cloud-Sicherung. Wirft, wenn Schlüssel oder Daten nicht passen. */
export async function decryptCloudData(keys, syncId, { iv, ct, z }) {
  let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv), additionalData: enc.encode(AAD_PREFIX + syncId) }, await aesKey(keys.encKey), b64ToBytes(ct)));
  if (Number(z) === 1) {
    if (typeof DecompressionStream !== 'function') throw new Error('Dieser Browser kann die Cloud-Sicherung nicht lesen. Bitte aktualisieren Sie ihn.');
    bytes = await transform(bytes, new DecompressionStream('gzip'));
  }
  return JSON.parse(dec.decode(bytes));
}

/** Inhalt der Cloud-Sicherung: der Stand und (falls vorhanden) noch nicht gespeicherte Eingaben zum Elternsprechtag. */
export function packCloudData(state, eventDraft = null) {
  return { app: 'ParentsDay', type: 'cloud-state', v: 1, state, eventDraft: eventDraft || null };
}

/**
 * Prüft den entschlüsselten Inhalt. Wirft bei unbrauchbaren Daten.
 * @returns {{state: object, eventDraft: object|null}}
 */
export function unpackCloudData(raw) {
  if (!raw || raw.app !== 'ParentsDay' || raw.type !== 'cloud-state') throw new Error('Die Cloud-Sicherung enthält keinen gültigen ParentsDay-Stand.');
  return { state: normalizeTeacherState(raw.state), eventDraft: cleanDraft(raw.eventDraft) };
}

// ---------- Verbindung zum Dienst ----------

const MESSAGES = {
  403: 'Das Passwort ist falsch.',
  404: 'Die Cloud-Sicherung ist auf dem Server noch nicht eingerichtet.',
  409: 'Die Cloud-Sicherung wurde inzwischen auf einem anderen Gerät geändert.',
  429: 'Zu viele Versuche. Bitte warten Sie etwas und versuchen Sie es dann noch einmal.',
  default: 'Die Cloud-Sicherung hat einen Fehler gemeldet. Bitte versuchen Sie es später noch einmal.',
};
const UNREACHABLE = 'Die Cloud-Sicherung ist gerade nicht erreichbar. Bitte prüfen Sie die Internetverbindung.';

function call(method, path, opts = {}) {
  return serviceRequest(method, path, { messages: MESSAGES, unreachable: UNREACHABLE, ...opts });
}

/** Verständliche Meldung zu einem Fehler der Cloud-Sicherung. */
export function cloudErrorMessage(err) {
  if (err instanceof MailboxError && err.status === 429) {
    const minutes = Math.max(1, Math.ceil(Number(err.data?.retryAfter || 0) / 60));
    if (err.data?.error === 'locked') return `Zu viele falsche Passwörter. Zum Schutz Ihrer Daten ist die Cloud-Sicherung für ${minutes === 1 ? 'eine Minute' : `${minutes} Minuten`} gesperrt.`;
    if (err.data?.error === 'too-many-resets') return 'Die Cloud-Sicherung wurde heute schon mehrmals neu eingerichtet. Bitte versuchen Sie es morgen noch einmal.';
  }
  return err?.message || MESSAGES.default;
}

function checkId(syncId) {
  if (!ID_RE.test(String(syncId))) throw new Error('Ungültige ID der Cloud-Sicherung.');
}

/**
 * Gibt es eine Cloud-Sicherung? Liefert dann Salt und Durchläufe für das Passwort.
 * @returns {Promise<{found:false} | {found:true, salt:string, iterations:number}>}
 */
export async function fetchCloudInfo(syncId) {
  checkId(syncId);
  const data = await call('GET', `/v1/sync/${syncId}/salt`);
  if (!data?.found) return { found: false };
  const iterations = Number(data.iterations);
  if (!SALT_RE.test(String(data.salt)) || !Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new MailboxError(MESSAGES.default, { status: 502 });
  }
  return { found: true, salt: data.salt, iterations };
}

/**
 * Holt die verschlüsselte Sicherung. Mit `since` (bekannte Version) antwortet der Dienst bei unverändertem
 * Stand nur mit { unchanged: true }.
 * @returns {Promise<{found:false} | {found:true, version:number, updatedAt:number, unchanged?:true, iv?:string, ct?:string, z?:number}>}
 */
export async function fetchCloudRecord(syncId, authToken, { since } = {}) {
  checkId(syncId);
  const query = Number.isInteger(since) && since > 0 ? `?since=${since}` : '';
  const data = await call('GET', `/v1/sync/${syncId}${query}`, { secret: authToken, timeout: UPLOAD_TIMEOUT_MS });
  if (!data?.found) return { found: false };
  return { ...data, version: Number(data.version), updatedAt: Number(data.updatedAt) };
}

/**
 * Speichert die verschlüsselte Sicherung. `baseVersion`: Version, auf der der Stand beruht (0 = neu anlegen,
 * dann auch salt, iterations und authHash). Wirft bei einem inzwischen geänderten Stand einen Fehler mit status 409.
 * @returns {Promise<{version:number, updatedAt:number}>}
 */
export async function saveCloudRecord(syncId, authToken, body, { keepalive = false } = {}) {
  checkId(syncId);
  if (String(body.ct || '').length > MAX_CLOUD_CT_CHARS) throw new Error('Ihr Stand ist zu groß für die Cloud-Sicherung. Bitte nutzen Sie „Zwischenstand speichern“.');
  const data = await call('PUT', `/v1/sync/${syncId}`, { body, secret: authToken, timeout: UPLOAD_TIMEOUT_MS, keepalive });
  return { version: Number(data.version), updatedAt: Number(data.updatedAt) };
}

/** „Passwort vergessen“: ersetzt die Sicherung durch eine neue (mit neuem Passwort und dem Stand dieses Geräts). */
export async function resetCloudRecord(syncId, authToken, body) {
  checkId(syncId);
  if (String(body.ct || '').length > MAX_CLOUD_CT_CHARS) throw new Error('Ihr Stand ist zu groß für die Cloud-Sicherung. Bitte nutzen Sie „Zwischenstand speichern“.');
  const data = await call('POST', `/v1/sync/${syncId}/reset`, { body, secret: authToken, timeout: UPLOAD_TIMEOUT_MS });
  return { version: Number(data.version), updatedAt: Number(data.updatedAt) };
}

/** Löscht die Cloud-Sicherung. */
export async function deleteCloudRecord(syncId, authToken) {
  checkId(syncId);
  const data = await call('DELETE', `/v1/sync/${syncId}`, { secret: authToken });
  return Boolean(data?.deleted);
}
