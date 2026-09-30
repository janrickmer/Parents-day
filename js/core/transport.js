// Datenübertragung ohne Server:
//  1. Lehrkraft → Eltern: Elternsprechtag-Daten stecken im Link/QR-Code des Elternbriefs
//     (…/#/eltern?e=<base64url-JSON>) und zusätzlich in einem kurzen, abtippbaren „Termin-Schlüssel“.
//  2. Eltern → Lehrkraft: Rückmeldung als PDF mit eingebetteten Daten (siehe pdf.js) und
//     zusätzlich als Textblock „PARENTSDAY[…]“ im E-Mail-Text.

import { PUBLIC_URL } from '../config.js';
import { toMinutes, fromMinutes } from './time.js';

// ---------- Base64url (UTF-8) ----------

export function encodeBase64Url(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64Url(text) {
  const clean = String(text).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---------- Elternsprechtag-Daten (Lehrkraft → Eltern) ----------

/**
 * EventInfo – alles, was die Elternseite über den Elternsprechtag wissen muss:
 * { teacherName, teacherEmail, teacherCode, schoolAddress, slotMinutes,
 *   days: [{date,start,end}], classId, source: 'link'|'key' }
 * Bei source 'key' (Termin-Schlüssel) sind nur slotMinutes und days bekannt, die übrigen Felder sind ''.
 */
export function eventInfoFromState(state, classId) {
  const t = state.teacher;
  return {
    teacherName: `${t.firstName} ${t.lastName}`.trim(),
    teacherEmail: t.email || '',
    teacherCode: t.teacherCode,
    schoolAddress: state.event?.schoolAddress || '',
    slotMinutes: state.event?.slotMinutes || 10,
    days: (state.event?.days || []).map((d) => ({ ...d })),
    classId: classId || '',
    source: 'link',
  };
}

function compactEvent(info) {
  return {
    v: 1,
    n: info.teacherName,
    m: info.teacherEmail,
    t: info.teacherCode,
    a: info.schoolAddress,
    s: info.slotMinutes,
    d: info.days.map((d) => [d.date, d.start, d.end]),
    k: info.classId,
  };
}

/** Link für den Elternbrief/QR-Code. */
export function eventLink(state, classId) {
  return `${PUBLIC_URL}/#/eltern?e=${encodeBase64Url(compactEvent(eventInfoFromState(state, classId)))}`;
}

/** Liest den Parameter e= aus dem Elternbrief-Link. Wirft einen Fehler bei ungültigen Daten. */
export function decodeEventParam(param) {
  let raw;
  try {
    raw = decodeBase64Url(param);
  } catch {
    throw new Error('Der Link aus dem Elternbrief ist unvollständig oder beschädigt.');
  }
  if (!raw || raw.v !== 1 || !Array.isArray(raw.d) || raw.d.length === 0) {
    throw new Error('Der Link aus dem Elternbrief ist unvollständig oder beschädigt.');
  }
  return {
    teacherName: String(raw.n || ''),
    teacherEmail: String(raw.m || ''),
    teacherCode: String(raw.t || ''),
    schoolAddress: String(raw.a || ''),
    slotMinutes: Number(raw.s) || 10,
    days: raw.d.map(([date, start, end]) => ({ date, start, end })),
    classId: String(raw.k || ''),
    source: 'link',
  };
}

// ---------- Termin-Schlüssel (abtippbar, Crockford-Base32) ----------
// Bit-Layout: Version(2) | Slotlänge/5 (5) | Anzahl Tage−1 (3) | je Tag: Tage seit 01.01.2024 (14),
// Beginn/5 (9), Ende/5 (9) | Prüfsumme (10). Uhrzeiten müssen daher auf 5 Minuten enden.

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const EPOCH_UTC = Date.UTC(2024, 0, 1);
const DAY_MS = 86400000;

function dayOffset(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_UTC) / DAY_MS);
}

function isoFromOffset(offset) {
  const dt = new Date(EPOCH_UTC + offset * DAY_MS);
  return dt.toISOString().slice(0, 10);
}

/** Prüft, ob sich ein Elternsprechtag als Termin-Schlüssel darstellen lässt. */
export function canEncodeEventKey(event) {
  if (!event || !Array.isArray(event.days) || event.days.length < 1 || event.days.length > 8) return false;
  const slot = Number(event.slotMinutes);
  if (!(slot >= 5 && slot <= 155 && slot % 5 === 0)) return false;
  return event.days.every((d) => {
    const off = dayOffset(d.date);
    const s = toMinutes(d.start);
    const e = toMinutes(d.end);
    return off >= 0 && off < 16384 && s % 5 === 0 && e % 5 === 0 && s >= 0 && e <= 1440 && e > s;
  });
}

/** Erzeugt den Termin-Schlüssel, z. B. "1A2B-3C4D-5E6". Gibt '' zurück, wenn nicht darstellbar. */
export function encodeEventKey(event) {
  if (!canEncodeEventKey(event)) return '';
  let value = 0n;
  const push = (num, bits) => {
    value = (value << BigInt(bits)) | BigInt(num);
  };
  push(1, 2);
  push(event.slotMinutes / 5, 5);
  push(event.days.length - 1, 3);
  for (const d of event.days) {
    push(dayOffset(d.date), 14);
    push(toMinutes(d.start) / 5, 9);
    push(toMinutes(d.end) / 5, 9);
  }
  const check = Number(value % 1021n);
  push(check, 10);
  const totalBits = 2 + 5 + 3 + event.days.length * 32 + 10;
  const chars = Math.ceil(totalBits / 5);
  value <<= BigInt(chars * 5 - totalBits);
  let out = '';
  for (let i = chars - 1; i >= 0; i--) out += B32[Number((value >> BigInt(i * 5)) & 31n)];
  return out.match(/.{1,4}/g).join('-');
}

/** Liest einen Termin-Schlüssel. Wirft einen Fehler bei Tippfehlern. */
export function decodeEventKey(text) {
  const clean = String(text ?? '')
    .toUpperCase()
    .replace(/[\s\-–]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  const error = new Error('Der Termin-Schlüssel ist ungültig. Bitte genau wie im Elternbrief abtippen.');
  if (!clean || /[^0-9A-Z]/.test(clean) || /U/.test(clean)) throw error;
  let value = 0n;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw error;
    value = (value << 5n) | BigInt(idx);
  }
  const totalChars = clean.length;
  // Anzahl der Tage aus der Länge bestimmen: bits = 20 + 32·n, chars = ceil(bits/5)
  let days = 0;
  for (let n = 1; n <= 8; n++) if (Math.ceil((20 + 32 * n) / 5) === totalChars) days = n;
  if (!days) throw error;
  const totalBits = 20 + 32 * days;
  value >>= BigInt(totalChars * 5 - totalBits);
  const take = (bits, offsetFromTop) => Number((value >> BigInt(totalBits - offsetFromTop - bits)) & ((1n << BigInt(bits)) - 1n));
  const check = take(10, totalBits - 10);
  const data = value >> 10n;
  if (Number(data % 1021n) !== check) throw error;
  let pos = 0;
  const read = (bits) => {
    const v = take(bits, pos);
    pos += bits;
    return v;
  };
  if (read(2) !== 1) throw error;
  const slotMinutes = read(5) * 5;
  const count = read(3) + 1;
  if (count !== days || slotMinutes < 5) throw error;
  const result = [];
  for (let i = 0; i < count; i++) {
    const date = isoFromOffset(read(14));
    const start = fromMinutes(read(9) * 5);
    const endMin = read(9) * 5;
    const end = endMin >= 1440 ? '24:00' : fromMinutes(endMin);
    if (toMinutes(end) <= toMinutes(start)) throw error;
    result.push({ date, start, end });
  }
  return {
    teacherName: '',
    teacherEmail: '',
    teacherCode: '',
    schoolAddress: '',
    slotMinutes,
    days: result,
    classId: '',
    source: 'key',
  };
}

// ---------- Rückmeldung der Eltern (Eltern → Lehrkraft) ----------

/**
 * ResponsePayload:
 * { app:'ParentsDay', type:'parent-response', v:1, code, firstName, lastName, classId, teacherCode,
 *   submittedAt: ISO, slotMinutes, availability: { 'JJJJ-MM-TT': [['HH:MM','HH:MM'], …] } }
 */
export function buildResponsePayload({ code, firstName, lastName, classId, teacherCode, slotMinutes, availability, submittedAt }) {
  return {
    app: 'ParentsDay',
    type: 'parent-response',
    v: 1,
    code,
    firstName,
    lastName,
    classId,
    teacherCode,
    submittedAt: submittedAt || new Date().toISOString(),
    slotMinutes,
    availability,
  };
}

/** Prüft und vereinheitlicht eine Rückmeldung. Gibt null zurück, wenn es keine gültige Rückmeldung ist. */
export function validateResponsePayload(obj) {
  if (!obj || obj.app !== 'ParentsDay' || obj.type !== 'parent-response' || !obj.code || typeof obj.availability !== 'object') return null;
  const availability = {};
  for (const [date, ranges] of Object.entries(obj.availability || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(ranges)) continue;
    availability[date] = ranges
      .filter((r) => Array.isArray(r) && r.length === 2 && toMinutes(r[1]) > toMinutes(r[0]))
      .map(([s, e]) => [String(s), String(e)]);
  }
  return {
    app: 'ParentsDay',
    type: 'parent-response',
    v: 1,
    code: String(obj.code),
    firstName: String(obj.firstName || ''),
    lastName: String(obj.lastName || ''),
    classId: String(obj.classId || ''),
    teacherCode: String(obj.teacherCode || ''),
    submittedAt: String(obj.submittedAt || ''),
    slotMinutes: Number(obj.slotMinutes) || 0,
    availability,
  };
}

const TEXT_START = 'PARENTSDAY[';
const TEXT_END = ']';

/** Rückmeldung als Textblock für den E-Mail-Text: PARENTSDAY[…] */
export function encodeResponseText(payload) {
  return `${TEXT_START}${encodeBase64Url(payload)}${TEXT_END}`;
}

/** Findet alle Rückmeldungs-Textblöcke in einem (z. B. aus E-Mails kopierten) Text. */
export function findResponsesInText(text) {
  const results = [];
  const re = /PARENTSDAY\[([A-Za-z0-9_\-\s]+)\]/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    try {
      const payload = validateResponsePayload(decodeBase64Url(m[1].replace(/\s+/g, '')));
      if (payload) results.push(payload);
    } catch {
      /* beschädigter Block – überspringen */
    }
  }
  return results;
}

// ---------- Daten in PDF-Metadaten ----------

export const PDF_MARKER = 'PARENTSDAY1.';

/** Text, der in das Metadatenfeld „Betreff“ eines PDFs geschrieben wird. */
export function pdfPayloadString(obj) {
  return PDF_MARKER + encodeBase64Url(obj);
}

/** Sucht den Datenblock in einem Text (z. B. dem als Latin-1 gelesenen PDF-Inhalt). */
export function findPdfPayloadInText(text) {
  const m = /PARENTSDAY1\.([A-Za-z0-9_-]+)/.exec(text);
  if (!m) return null;
  try {
    return decodeBase64Url(m[1]);
  } catch {
    return null;
  }
}
