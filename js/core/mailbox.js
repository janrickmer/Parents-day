// Digitaler Briefkasten: Eltern werfen ihre Rückmeldung verschlüsselt ein, die Lehrkraft holt sie ab.
//
// Ablauf:
//  1. Die Lehrkraft erhält beim ersten Erstellen von Elternbriefen einen Briefkasten:
//     ein zufälliges Geheimnis (nur in ihrem Browser/Zwischenspeicher), daraus die Briefkasten-ID,
//     und ein Schlüsselpaar (ECDH P-256). Briefkasten-ID und öffentlicher Schlüssel stehen im QR-Code.
//  2. Der Browser der Eltern verschlüsselt die Rückmeldung (ECDH mit Einmal-Schlüssel → HKDF → AES-GCM)
//     und sendet sie an den Briefkasten-Dienst (worker/briefkasten.js). Der Dienst kann nichts lesen.
//  3. Die Lehrkraft holt alle Rückmeldungen mit ihrem Geheimnis ab und entschlüsselt sie im Browser.
// Für Eltern ohne QR-Code (Termin-Schlüssel) legt die Lehrkraft zusätzlich einen Verzeichniseintrag ab,
// der mit Lehrkräftecode, Klasse und Termin-Schlüssel gefunden und entschlüsselt werden kann.

import { MAILBOX_URL } from '../config.js';
import { teacherCodeKey } from './codes.js';

const HKDF_INFO = 'ParentsDay-Briefkasten-v1';
const AAD = new TextEncoder().encode('ParentsDay-Rueckmeldung-v1');
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const PUBKEY_RE = /^[A-Za-z0-9_-]{87}$/;
const TIMEOUT_MS = 15000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Ist ein Briefkasten-Dienst eingerichtet? */
export function mailboxEnabled() {
  return Boolean(MAILBOX_URL);
}

// ---------- Hilfen ----------

export function bytesToB64(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64ToBytes(text) {
  const clean = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sha256(textOrBytes) {
  const data = typeof textOrBytes === 'string' ? enc.encode(textOrBytes) : textOrBytes;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** Briefkasten-ID aus dem Geheimnis (muss mit worker/briefkasten.js übereinstimmen). */
export async function boxIdFromSecret(secret) {
  return bytesToB64(await sha256(secret)).slice(0, 32);
}

/** Prüft die Briefkasten-Angaben aus einem Elternbrief-Link. */
export function isValidMailboxRef(ref) {
  return Boolean(ref && ID_RE.test(String(ref.id || '')) && PUBKEY_RE.test(String(ref.publicKey || '')));
}

/** Prüft den (privaten) Briefkasten der Lehrkraft, wie er im Zustand gespeichert ist. */
export function isValidTeacherMailbox(mb) {
  return Boolean(
    mb &&
      typeof mb === 'object' &&
      /^[A-Za-z0-9_-]{43}$/.test(String(mb.secret || '')) &&
      isValidMailboxRef(mb) &&
      mb.privateKey &&
      typeof mb.privateKey === 'object' &&
      mb.privateKey.kty === 'EC' &&
      mb.privateKey.crv === 'P-256' &&
      typeof mb.privateKey.d === 'string',
  );
}

/** Nur die öffentlichen Angaben (für Link/QR-Code). */
export function publicMailboxRef(mb) {
  return isValidMailboxRef(mb) ? { id: mb.id, publicKey: mb.publicKey } : null;
}

// ---------- Schlüssel der Lehrkraft ----------

/**
 * Legt einen neuen Briefkasten an (nur im Browser, nichts wird gesendet).
 * @returns {Promise<{v:1, id:string, secret:string, publicKey:string, privateKey:JsonWebKey, createdAt:string}>}
 */
export async function createTeacherMailbox() {
  const secret = bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = bytesToB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { v: 1, id: await boxIdFromSecret(secret), secret, publicKey, privateKey, createdAt: new Date().toISOString() };
}

async function aesKeyFromShared(sharedBits, salt) {
  const base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(HKDF_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Verschlüsselt eine Rückmeldung für den öffentlichen Schlüssel der Lehrkraft. */
export async function encryptForTeacher(publicKeyB64, payload) {
  const teacherKey = await crypto.subtle.importKey('raw', b64ToBytes(publicKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: teacherKey }, eph.privateKey, 256);
  const key = await aesKeyFromShared(shared, epk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(JSON.stringify(payload))));
  return { v: 1, epk: bytesToB64(epk), iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

/** Entschlüsselt eine Nachricht mit dem privaten Schlüssel (JWK) der Lehrkraft. Wirft bei Fehlern. */
export async function decryptForTeacher(privateJwk, msg) {
  const priv = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epkBytes = b64ToBytes(msg.epk);
  const epk = await crypto.subtle.importKey('raw', epkBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
  const key = await aesKeyFromShared(shared, epkBytes);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(msg.iv), additionalData: AAD }, key, b64ToBytes(msg.ct));
  return JSON.parse(dec.decode(plain));
}

// ---------- Verbindung zum Briefkasten-Dienst ----------

/** Fehler mit verständlicher Meldung; `offline` = Dienst nicht erreichbar. */
export class MailboxError extends Error {
  constructor(message, { status = 0, offline = false, data = null } = {}) {
    super(message);
    this.name = 'MailboxError';
    this.status = status;
    this.offline = offline;
    /** Antwort des Dienstes (z. B. { version } bei 409), sonst null */
    this.data = data;
  }
}

const UNREACHABLE = 'Der digitale Briefkasten ist gerade nicht erreichbar. Bitte prüfen Sie die Internetverbindung.';

const MAILBOX_MESSAGES = {
  403: 'Der Zugang zum Briefkasten wurde abgelehnt.',
  404: 'Nicht gefunden.',
  409: 'Dieser Eintrag gehört zu einem anderen Briefkasten.',
  429: 'Gerade kommen sehr viele Rückmeldungen an. Bitte versuchen Sie es in einer Minute noch einmal.',
  507: 'Der Briefkasten der Lehrkraft ist voll.',
};

/**
 * Anfrage an den Dienst (Briefkasten und Cloud-Sicherung). Wirft MailboxError mit verständlicher Meldung.
 * @param {{body?: object, secret?: string, messages?: object, unreachable?: string, timeout?: number, keepalive?: boolean}} [opts]
 *   messages: Meldungen je HTTP-Status, unreachable: Meldung ohne Verbindung,
 *   keepalive: Anfrage darf das Schließen der Seite überdauern (nur für kleine Anfragen bis 64 KB)
 */
export async function serviceRequest(method, path, { body, secret, messages = MAILBOX_MESSAGES, unreachable = UNREACHABLE, timeout = TIMEOUT_MS, keepalive = false } = {}) {
  if (!MAILBOX_URL) throw new MailboxError('Der digitale Briefkasten ist nicht eingerichtet.', { offline: true });
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  let res;
  try {
    res = await fetch(`${MAILBOX_URL.replace(/\/+$/, '')}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl?.signal,
      cache: 'no-store',
      credentials: 'omit',
      ...(keepalive ? { keepalive: true } : {}),
    });
  } catch {
    throw new MailboxError(unreachable, { offline: true });
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new MailboxError(messages[res.status] || messages.default || 'Der digitale Briefkasten hat einen Fehler gemeldet. Bitte versuchen Sie es später noch einmal.', {
      status: res.status,
      offline: res.status >= 500 && res.status !== 507,
      data,
    });
  }
  return data;
}

function request(method, path, opts) {
  return serviceRequest(method, path, opts);
}

/** Prüft, ob der Dienst erreichbar ist. */
export async function checkMailboxService() {
  const data = await request('GET', '/v1/health');
  return Boolean(data?.ok);
}

/**
 * Eltern: verschlüsselt die Rückmeldung und wirft sie in den Briefkasten der Lehrkraft.
 * @param {{id:string, publicKey:string}} ref – aus dem Elternbrief-Link
 * @returns {Promise<{id:string, createdAt:number}>}
 */
export async function sendToMailbox(ref, payload) {
  if (!isValidMailboxRef(ref)) throw new MailboxError('Für diesen Elternbrief gibt es keinen digitalen Briefkasten.');
  const msg = await encryptForTeacher(ref.publicKey, payload);
  return request('POST', `/v1/boxes/${ref.id}/messages`, { body: msg });
}

/**
 * Lehrkraft: holt alle Rückmeldungen ab und entschlüsselt sie.
 * `newest`: Eingangszeitpunkt (ms) der neuesten abgeholten Nachricht, 0 ohne Nachrichten (für clearMailbox).
 * @returns {Promise<{payloads: object[], unreadable: number, total: number, newest: number}>}
 */
export async function fetchFromMailbox(teacherMailbox) {
  if (!isValidTeacherMailbox(teacherMailbox)) throw new MailboxError('Es ist noch kein digitaler Briefkasten eingerichtet.');
  const data = await request('GET', `/v1/boxes/${teacherMailbox.id}/messages`, { secret: teacherMailbox.secret });
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const payloads = [];
  let unreadable = 0;
  let newest = 0;
  for (const msg of messages) {
    const at = Number(msg?.createdAt);
    if (Number.isFinite(at) && at > newest) newest = at;
    try {
      payloads.push(await decryptForTeacher(teacherMailbox.privateKey, msg));
    } catch {
      unreadable++;
    }
  }
  return { payloads, unreadable, total: messages.length, newest };
}

/**
 * Lehrkraft: löscht die Rückmeldungen im Briefkasten.
 * @param {{upTo?: number}} [options] – nur Nachrichten bis zu diesem Eingangszeitpunkt (ms, `newest` aus
 *   fetchFromMailbox); was danach eingegangen ist, bleibt liegen. Ohne Angabe wird alles gelöscht.
 */
export async function clearMailbox(teacherMailbox, { upTo } = {}) {
  if (!isValidTeacherMailbox(teacherMailbox)) throw new MailboxError('Es ist noch kein digitaler Briefkasten eingerichtet.');
  const limit = Number.isInteger(upTo) && upTo >= 0 ? `?before=${upTo + 1}` : '';
  const data = await request('DELETE', `/v1/boxes/${teacherMailbox.id}/messages${limit}`, { secret: teacherMailbox.secret });
  return Number(data?.deleted) || 0;
}

// ---------- Verzeichnis für den Termin-Schlüssel ----------
// Eltern, die die Seite ohne QR-Code öffnen, kennen Lehrkräftecode und Klasse (aus dem Code des Kindes)
// und den Termin-Schlüssel. Daraus ergeben sich ID und Schlüssel des Verzeichniseintrags.

function directoryMaterial({ teacherCode, classId, eventKey }) {
  const key = String(eventKey || '')
    .toUpperCase()
    .replace(/[\s\-–]+/g, '');
  return `${teacherCodeKey(teacherCode)}|${String(classId || '').toLowerCase()}|${key}`;
}

async function directoryIdAndKey(ref) {
  const material = directoryMaterial(ref);
  const id = bytesToB64(await sha256(`ParentsDay-Verzeichnis-ID|${material}`)).slice(0, 32);
  const raw = await sha256(`ParentsDay-Verzeichnis-Schluessel|${material}`);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { id, key };
}

/**
 * Lehrkraft: legt die Elternbrief-Daten (kompaktes Event wie im Link) für den Termin-Schlüssel-Weg ab.
 * @param {object} teacherMailbox
 * @param {{teacherCode:string, classId:string, eventKey:string}} ref
 * @param {object} compactEvent – Inhalt des Link-Parameters e=
 */
export async function publishDirectoryEntry(teacherMailbox, ref, compactEvent) {
  if (!isValidTeacherMailbox(teacherMailbox) || !ref.eventKey) return false;
  const { id, key } = await directoryIdAndKey(ref);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(compactEvent))));
  await request('PUT', `/v1/directory/${id}`, { body: { box: teacherMailbox.id, iv: bytesToB64(iv), ct: bytesToB64(ct) }, secret: teacherMailbox.secret });
  return true;
}

/**
 * Eltern: sucht die Elternbrief-Daten zum Termin-Schlüssel. Gibt das kompakte Event oder null zurück.
 * @param {{teacherCode:string, classId:string, eventKey:string}} ref
 */
export async function lookupDirectoryEntry(ref) {
  const { id, key } = await directoryIdAndKey(ref);
  let data;
  try {
    data = await request('GET', `/v1/directory/${id}`);
  } catch (err) {
    // 404: ältere Fassung des Dienstes ohne Eintrag
    if (err instanceof MailboxError && err.status === 404) return null;
    throw err;
  }
  if (!data || data.found === false) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(data.iv) }, key, b64ToBytes(data.ct));
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}
