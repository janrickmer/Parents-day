// Cloud-Sicherung: der komplette Stand der Lehrkraft, im Browser mit ihrem Passwort verschlüsselt und beim
// Briefkasten-Dienst (worker/briefkasten.js) abgelegt. So kann sie sich an jedem Gerät anmelden und hat dort
// ihren aktuellen Stand – ohne Zwischenspeicher-Datei. Der Dienst sieht nur unlesbare Daten.
//
// Schlüssel: PBKDF2-SHA256 mit 600 000 Durchläufen (Empfehlung von OWASP) aus dem Passwort; Salt ist ein
// Hashwert aus Name und Geburtsdatum. Aus diesen 256 Bit entstehen mit HKDF-SHA256 getrennte Werte:
//   syncId      – Adresse der Sicherung beim Dienst (ohne Passwort nicht zu berechnen – niemand sonst kann die
//                 Sicherung finden, überschreiben, sperren oder löschen)
//   encKey      – AES-GCM-Schlüssel für die Daten
//   authToken   – Zugang zum Abrufen und Speichern (wird mit „Passwort merken“ im Browser gespeichert)
//   adminToken  – Zugang zum Löschen (wird nie gespeichert; dafür ist das Passwort nötig)
// Der Dienst speichert von den Tokens nur SHA-256-Werte. Das Passwort selbst verlässt den Browser nie.
// Jedes Gerät erhält beim Öffnen der Sicherung zusätzlich ein zufälliges Geräte-Geheimnis: Nur eingetragene
// Geräte dürfen abgleichen. Versuche, eine Sicherung zu öffnen, zählt der Dienst je Lehrkraft (who).
// Der Ablauf (wann hoch- und heruntergeladen wird) steckt in core/cloud-sync.js.

import { transliterate } from './codes.js';
import { bytesToB64, b64ToBytes, mailboxEnabled, serviceRequest, MailboxError } from './mailbox.js';
import { normalizeTeacherState } from './storage.js';
import { cleanDraft } from './backup.js';

/** Durchläufe (OWASP-Empfehlung für PBKDF2-HMAC-SHA256). Teil des Verfahrens „v2“ – nicht einzeln änderbar. */
export const PBKDF2_ITERATIONS = 600000;
export const MIN_PASSWORD_LENGTH = 10;
/** Größte verschlüsselte Sicherung (Zeichen), die der Dienst annimmt – wie SYNC_MAX_CT_CHARS im Worker. */
export const MAX_CLOUD_CT_CHARS = 720000;

const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const WHO_RE = /^[A-Za-z0-9_-]{22}$/;
const VERSION = 'ParentsDay-Cloud-v2';
const UPLOAD_TIMEOUT_MS = 30000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Ist ein Dienst für die Cloud-Sicherung eingerichtet? (derselbe wie für den digitalen Briefkasten) */
export function cloudEnabled() {
  return mailboxEnabled();
}

async function sha256(textOrBytes) {
  const data = typeof textOrBytes === 'string' ? enc.encode(textOrBytes) : textOrBytes;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** Name und Geburtsdatum einheitlich (Schreibweise, Umlaute und Akzente spielen keine Rolle). */
function identity(teacher) {
  return `${transliterate(teacher.firstName)}|${transliterate(teacher.lastName)}|${teacher.birthDate}`;
}

/** Kennung der Lehrkraft für den Dienst: nur zum Zählen der Versuche, eine Sicherung zu öffnen. */
export async function cloudWho(teacher) {
  return bytesToB64(await sha256(`${VERSION}-who|${identity(teacher)}`)).slice(0, 22);
}

/** Prüft ein neues Passwort. Gibt eine Fehlermeldung oder '' zurück. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (!value) return 'Bitte geben Sie ein Passwort ein.';
  if ([...value].length < MIN_PASSWORD_LENGTH) return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
  if (!value.trim()) return 'Das Passwort darf nicht nur aus Leerzeichen bestehen.';
  return '';
}

async function hkdf(base, label, bytes) {
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`${VERSION}|${label}`) }, base, bytes * 8);
  return bytesToB64(new Uint8Array(bits));
}

/**
 * Leitet alle Werte aus Passwort, Name und Geburtsdatum ab (dauert je nach Gerät etwa eine halbe Sekunde).
 * @param {number} [iterations] – nur für Tests kleiner
 * @returns {Promise<{syncId:string, who:string, encKey:string, authToken:string, adminToken:string}>}
 */
export async function deriveCloudKeys(password, teacher, iterations = PBKDF2_ITERATIONS) {
  const salt = await sha256(`${VERSION}-salt|${identity(teacher)}`);
  const pw = await crypto.subtle.importKey('raw', enc.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pw, 256);
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const [syncId, encKey, authToken, adminToken, who] = await Promise.all([
    hkdf(base, 'id', 24),
    hkdf(base, 'enc', 32),
    hkdf(base, 'sync', 32),
    hkdf(base, 'admin', 32),
    cloudWho(teacher),
  ]);
  return { syncId, who, encKey, authToken, adminToken };
}

/** Neues zufälliges Geräte-Geheimnis (43 Zeichen). */
export function newDeviceSecret() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256-Wert (base64url, 43 Zeichen) – so speichert der Dienst Tokens und Geräte-Geheimnisse. */
export async function hashOf(secret) {
  return bytesToB64(await sha256(secret));
}

/** Gültige gespeicherte Zugangsdaten eines Geräts? { syncId, who, encKey, authToken, device } */
export function isValidCloudKeys(keys) {
  return Boolean(
    keys &&
      ID_RE.test(String(keys.syncId || '')) &&
      WHO_RE.test(String(keys.who || '')) &&
      KEY_RE.test(String(keys.encKey || '')) &&
      KEY_RE.test(String(keys.authToken || '')) &&
      KEY_RE.test(String(keys.device || '')),
  );
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
export async function encryptCloudData(keys, data) {
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
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${VERSION}|${keys.syncId}`) }, await aesKey(keys.encKey), bytes));
  return { iv: bytesToB64(iv), ct: bytesToB64(ct), z };
}

/** Entschlüsselt Daten der Cloud-Sicherung. Wirft, wenn Schlüssel oder Daten nicht passen. */
export async function decryptCloudData(keys, { iv, ct, z }) {
  let bytes = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv), additionalData: enc.encode(`${VERSION}|${keys.syncId}`) }, await aesKey(keys.encKey), b64ToBytes(ct)),
  );
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
  403: 'Dieses Gerät hat keinen Zugang (mehr) zur Cloud-Sicherung.',
  404: 'Die Cloud-Sicherung ist auf dem Server noch nicht eingerichtet.',
  409: 'Die Cloud-Sicherung wurde inzwischen auf einem anderen Gerät geändert.',
  429: 'Zu viele Versuche. Bitte warten Sie etwas und versuchen Sie es dann noch einmal.',
  507: 'Der Speicher der Cloud-Sicherung ist voll. Bitte wenden Sie sich an den Betreiber von ParentsDay.',
  default: 'Die Cloud-Sicherung hat einen Fehler gemeldet. Bitte versuchen Sie es später noch einmal.',
};
const UNREACHABLE = 'Die Cloud-Sicherung ist gerade nicht erreichbar. Bitte prüfen Sie die Internetverbindung.';

function call(method, path, opts = {}) {
  return serviceRequest(method, path, { messages: MESSAGES, unreachable: UNREACHABLE, ...opts });
}

/** Verständliche Meldung zu einem Fehler der Cloud-Sicherung. */
export function cloudErrorMessage(err) {
  if (err instanceof MailboxError && err.status === 429) {
    const seconds = Number(err.data?.retryAfter || 0);
    const wait = seconds > 5400 ? 'bis morgen' : `${Math.max(1, Math.ceil(seconds / 60))} Minuten`;
    if (err.data?.error === 'locked') return `Zu viele Versuche mit einem falschen Passwort. Zum Schutz Ihrer Daten ist das Öffnen der Cloud-Sicherung ${seconds > 5400 ? 'bis morgen' : `für ${wait}`} gesperrt. Auf Geräten, die schon verbunden sind, läuft sie weiter.`;
    if (err.data?.error === 'too-many-creates') return 'Von Ihrem Internetanschluss wurden heute schon sehr viele Cloud-Sicherungen eingerichtet. Bitte versuchen Sie es morgen noch einmal.';
  }
  return err?.message || MESSAGES.default;
}

/**
 * Unterstützt der Dienst die Cloud-Sicherung (Verfahren v2)? Ältere Fassungen des Workers kennen sie nicht.
 * Wirft ohne Verbindung (MailboxError, offline).
 */
export async function cloudServiceReady() {
  const data = await call('GET', '/v1/health', { timeout: 8000 });
  return Number(data?.sync) >= 2;
}

/**
 * Öffnet die Sicherung auf einem neuen Gerät (Versuch wird gezählt) und trägt das Gerät ein.
 * @returns {Promise<{found:false} | {found:true, version:number, updatedAt:number, iv:string, ct:string, z:number}>}
 */
export async function openCloudRecord(keys, device) {
  const data = await call('POST', `/v1/sync/${keys.syncId}/open`, { body: { who: keys.who, device: await hashOf(device) }, secret: keys.authToken, timeout: UPLOAD_TIMEOUT_MS });
  if (!data?.found) return { found: false };
  return { ...data, version: Number(data.version), updatedAt: Number(data.updatedAt) };
}

function deviceHeaders(device) {
  return { 'X-Device': device };
}

/**
 * Holt die verschlüsselte Sicherung (eingetragenes Gerät). Mit `since` (bekannte Version) antwortet der Dienst
 * bei unverändertem Stand nur mit { unchanged: true }. Wirft 403, wenn das Gerät keinen Zugang (mehr) hat.
 */
export async function fetchCloudRecord(keys, { since } = {}) {
  const query = Number.isInteger(since) && since > 0 ? `?since=${since}` : '';
  const data = await call('GET', `/v1/sync/${keys.syncId}${query}`, { secret: keys.authToken, headers: deviceHeaders(keys.device), timeout: UPLOAD_TIMEOUT_MS });
  return { ...data, version: Number(data.version), updatedAt: Number(data.updatedAt) };
}

function checkSize(data) {
  if (String(data.ct || '').length > MAX_CLOUD_CT_CHARS) throw new Error('Ihr Stand ist zu groß für die Cloud-Sicherung. Bitte nutzen Sie „Zwischenstand speichern“.');
}

/**
 * Legt eine neue Sicherung an und trägt das Gerät (keys.device) ein; der Versuch wird gezählt. Gibt es mit
 * diesem Passwort schon eine, wirft der Dienst 409 (error: 'exists').
 * @param {string} adminHash – hashOf(adminToken); so muss das Admin-Token selbst nicht gespeichert werden
 * @returns {Promise<{version:number, updatedAt:number}>}
 */
export async function createCloudRecord(keys, data, adminHash) {
  checkSize(data);
  const body = { baseVersion: 0, who: keys.who, authHash: await hashOf(keys.authToken), adminHash, device: await hashOf(keys.device), ...data };
  const res = await call('PUT', `/v1/sync/${keys.syncId}`, { body, secret: keys.authToken, timeout: UPLOAD_TIMEOUT_MS });
  return { version: Number(res.version), updatedAt: Number(res.updatedAt) };
}

/**
 * Speichert einen neuen Stand. `baseVersion`: Version, auf der er beruht. Wirft 409, wenn die Sicherung
 * inzwischen geändert wurde, und 403 ohne Zugang.
 * @returns {Promise<{version:number, updatedAt:number}>}
 */
export async function saveCloudRecord(keys, baseVersion, data, { keepalive = false } = {}) {
  checkSize(data);
  const res = await call('PUT', `/v1/sync/${keys.syncId}`, { body: { baseVersion, ...data }, secret: keys.authToken, headers: deviceHeaders(keys.device), timeout: UPLOAD_TIMEOUT_MS, keepalive });
  return { version: Number(res.version), updatedAt: Number(res.updatedAt) };
}

/** Löscht die Sicherung (Admin-Token aus dem Passwort und eingetragenes Gerät nötig). */
export async function deleteCloudRecord(keys, adminToken) {
  const data = await call('DELETE', `/v1/sync/${keys.syncId}`, { secret: adminToken, headers: deviceHeaders(keys.device) });
  return Boolean(data?.deleted);
}
