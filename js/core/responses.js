// Rückmeldungen der Eltern einlesen und in den Zustand der Lehrkraft übernehmen.
// Quellen: Rückmelde-PDFs (Daten in den PDF-Metadaten), Textdateien/gespeicherte E-Mails (.txt, .eml)
// und eingefügter E-Mail-Text mit dem Block PARENTSDAY[…].

import { MAX_RESPONSE_FILE_BYTES } from '../config.js';
import { extractPayloadFromFile } from './pdf.js';
import { validateResponsePayload, findResponsesInText, findPdfPayloadInText } from './transport.js';
import { parseStudentCode, teacherCodesMatch, studentCodesMatch } from './codes.js';

const NOT_FOUND = 'Keine ParentsDay-Rückmeldung gefunden.';
const TOO_BIG = 'Die Datei ist zu groß – das ist keine Rückmelde-PDF.';

/** Meldungen, wenn eine andere ParentsDay-Datei statt einer Rückmeldung hochgeladen wurde. */
const OTHER_TYPES = {
  'teacher-registration': 'Das ist Ihre Registrierungs-PDF, keine Rückmeldung der Eltern.',
  'parent-letters': 'Das ist ein Elternbrief, keine Rückmeldung der Eltern.',
  appointments: 'Das ist die PDF mit den Terminbestätigungen, keine Rückmeldung der Eltern.',
};

/** Gründe, bei denen eine Rückmeldung schon aktuell im Zustand steht (kein Fehler). */
export const UP_TO_DATE_REASONS = ['Bereits übernommen', 'Neuere Rückmeldung bereits vorhanden'];

function isPdfFile(file, bytes) {
  if (/\.pdf$/i.test(file.name || '') || file.type === 'application/pdf') return true;
  // Dateien ohne passende Endung am Dateianfang „%PDF“ erkennen.
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function binaryToBytes(bin) {
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Macht E-Mail-Text durchsuchbar: Quoted-Printable-Umbrüche („=“ am Zeilenende), Zitatzeichen („> “)
 * und HTML-Tags werden entfernt. Im Block PARENTSDAY[…] kommen diese Zeichen nie vor.
 */
function cleanMailText(text) {
  return String(text ?? '')
    .replace(/=\r?\n/g, '')
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
    .replace(/<\/?[a-zA-Z][^<>]{0,500}>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
}

/** Base64-kodierte MIME-Teile einer gespeicherten E-Mail (.eml), z. B. PDF-Anhänge. */
function base64MimeParts(text) {
  const parts = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^content-transfer-encoding:\s*base64\s*$/i.test(lines[i].trim())) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '') j++;
    const body = [];
    for (j += 1; j < lines.length && /^[A-Za-z0-9+/=]+$/.test(lines[j].trim()); j++) body.push(lines[j].trim());
    if (body.length) parts.push(body.join(''));
    i = j - 1;
  }
  return parts;
}

function payloadKey(p) {
  return `${p.code.toUpperCase()}|${p.submittedAt}`;
}

/** Entfernt doppelte Rückmeldungen (gleicher Code und gleicher Absendezeitpunkt). */
function uniquePayloads(list) {
  const seen = new Set();
  return list.filter((p) => {
    const key = payloadKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Findet alle Rückmeldungen in einem E-Mail-Text (auch zitiert, als Quoted-Printable oder HTML).
 * @param {string} text
 * @returns {object[]} gültige ResponsePayloads
 */
export function findResponsesInMailText(text) {
  const raw = String(text ?? '');
  return uniquePayloads([...findResponsesInText(raw), ...findResponsesInText(cleanMailText(raw))]);
}

/** Liest Rückmeldungen aus dem Inhalt einer gespeicherten E-Mail inkl. Anhängen. */
async function payloadsFromMail(text) {
  const found = findResponsesInMailText(text);
  for (const part of base64MimeParts(text)) {
    let bytes;
    try {
      bytes = binaryToBytes(atob(part));
    } catch {
      continue;
    }
    const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    if (isPdf) {
      const payload = validateResponsePayload(await extractPayloadFromFile(bytes.buffer));
      if (payload) found.push(payload);
    } else {
      found.push(...findResponsesInMailText(new TextDecoder('utf-8').decode(bytes)));
    }
  }
  return uniquePayloads(found);
}

/**
 * Letzter Versuch für andere Dateiformate, z. B. aus Outlook gezogene E-Mails (.msg): Dort stecken
 * angehängte PDFs unverändert in der Datei und der E-Mail-Text ist UTF-16-kodiert.
 */
function payloadsFromContainer(bytes) {
  const found = [];
  const latin1 = new TextDecoder('latin1').decode(bytes);
  for (const m of latin1.matchAll(/PARENTSDAY1\.[A-Za-z0-9_-]+/g)) {
    const payload = validateResponsePayload(findPdfPayloadInText(m[0]));
    if (payload) found.push(payload);
  }
  found.push(...findResponsesInMailText(new TextDecoder('utf-16le').decode(bytes)));
  return uniquePayloads(found);
}

/** Liest eine einzelne Datei. Gibt gefundene Rückmeldungen oder eine Fehlermeldung zurück. */
async function readOneFile(file) {
  // Große Dateien (z. B. ein versehentlich hineingezogenes Video) gar nicht erst einlesen – das legte die Seite lahm.
  if (Number(file?.size) > MAX_RESPONSE_FILE_BYTES) return { message: TOO_BIG };
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (isPdfFile(file, bytes)) {
    const raw = await extractPayloadFromFile(buffer);
    const payload = validateResponsePayload(raw);
    if (payload) return { payloads: [payload] };
    return { message: (raw && OTHER_TYPES[raw.type]) || NOT_FOUND };
  }
  let payloads = await payloadsFromMail(new TextDecoder('utf-8').decode(bytes));
  if (!payloads.length) payloads = payloadsFromContainer(bytes);
  return payloads.length ? { payloads } : { message: NOT_FOUND };
}

/**
 * Liest Rückmelde-PDFs der Eltern (und .txt/.eml-Dateien mit dem Block PARENTSDAY[…]). Wirft nie.
 * @param {File[]} files
 * @returns {Promise<{payloads: object[], errors: Array<{fileName: string, message: string}>}>}
 */
export async function readResponsesFromFiles(files) {
  const payloads = [];
  const errors = [];
  let list = [];
  try {
    list = [...(files || [])];
  } catch {
    list = [];
  }
  for (const file of list) {
    const fileName = String(file?.name || 'Unbenannte Datei');
    try {
      const result = await readOneFile(file);
      if (result.payloads) payloads.push(...result.payloads);
      else errors.push({ fileName, message: result.message });
    } catch {
      errors.push({ fileName, message: 'Die Datei konnte nicht gelesen werden.' });
    }
  }
  return { payloads: uniquePayloads(payloads), errors };
}

/** Zeitstempel als Zahl zum Vergleichen (ungültig → 0). */
function timeValue(timestamp) {
  const t = Date.parse(timestamp || '');
  return Number.isNaN(t) ? 0 : t;
}

function payloadName(p) {
  return `${p.firstName} ${p.lastName}`.trim() || p.code;
}

/**
 * Überträgt Rückmeldungen in den Zustand (verändert `state`). Pro Kind gilt die neueste Rückmeldung.
 * Rückmeldungen anderer Klassen werden ebenfalls übernommen und mit `otherClass: true` markiert.
 * Intern wird die neueste Rückmeldung zuerst verarbeitet; ältere derselben Datei-Sammlung erscheinen
 * dadurch als „Neuere Rückmeldung bereits vorhanden“ statt doppelt als übernommen.
 * @param {object} state – TeacherState
 * @param {object[]} payloads – ResponsePayloads
 * @param {{classId?: string}} [options] – Klasse, in der gerade hochgeladen wird
 * @returns {{applied: Array<{classId, studentId, name, replaced:boolean, otherClass:boolean}>, skipped: Array<{name, classId, reason}>}}
 */
export function applyResponses(state, payloads, options = {}) {
  const applied = [];
  const skipped = [];
  const classes = Array.isArray(state?.classes) ? state.classes : [];
  const list = (Array.isArray(payloads) ? payloads : [])
    .map((raw, index) => ({ payload: validateResponsePayload(raw), raw, index }))
    .sort((a, b) => timeValue(b.payload?.submittedAt) - timeValue(a.payload?.submittedAt) || a.index - b.index);

  for (const { payload, raw, index } of list) {
    const skip = (name, classId, reason) => skipped.push({ name, classId: classId || '', reason, index });
    if (!payload) {
      skip(`${raw?.firstName || ''} ${raw?.lastName || ''}`.trim() || 'Unbekannt', raw?.classId, 'Keine gültige Rückmeldung');
      continue;
    }
    const name = payloadName(payload);
    const parsed = parseStudentCode(payload.code);
    if (!parsed) {
      skip(name, payload.classId, 'Ungültiger Code');
      continue;
    }
    // Anfangsbuchstaben tolerant: abgetipptes „L“ statt „Ł“ oder „l“ statt „I“ gehört trotzdem zu dieser Lehrkraft.
    if (!teacherCodesMatch(parsed.teacherCode, state?.teacher?.teacherCode)) {
      skip(name, parsed.classId, 'Gehört zu einer anderen Lehrkraft');
      continue;
    }
    const classIndex = classes.findIndex((c) => c.id === parsed.classId);
    const cls = classes[classIndex];
    if (!cls) {
      skip(name, parsed.classId, `Klasse ${parsed.classId} ist nicht angelegt`);
      continue;
    }
    const students = Array.isArray(cls.students) ? cls.students : [];
    const studentIndex = students.findIndex((s) => s.code && studentCodesMatch(s.code, payload.code));
    const student = students[studentIndex];
    if (!student) {
      skip(name, cls.id, `Kein Kind mit diesem Code in Klasse ${cls.id}`);
      continue;
    }
    const studentName = `${student.firstName} ${student.lastName}`.trim() || name;
    const existing = student.response;
    if (existing) {
      const diff = timeValue(existing.submittedAt) - timeValue(payload.submittedAt);
      if (diff > 0) {
        skip(studentName, cls.id, 'Neuere Rückmeldung bereits vorhanden');
        continue;
      }
      if (diff === 0) {
        skip(studentName, cls.id, 'Bereits übernommen');
        continue;
      }
    }
    student.response = { submittedAt: payload.submittedAt, availability: payload.availability };
    applied.push({
      classId: cls.id,
      studentId: student.id,
      name: studentName,
      replaced: Boolean(existing),
      otherClass: Boolean(options?.classId && parsed.classId !== options.classId),
      order: classIndex * 100000 + studentIndex,
    });
  }
  // Bericht: übernommene in Tabellen-Reihenfolge, übersprungene in Reihenfolge der Dateien.
  applied.sort((a, b) => a.order - b.order);
  skipped.sort((a, b) => a.index - b.index);
  return {
    applied: applied.map(({ order, ...rest }) => rest),
    skipped: skipped.map(({ index, ...rest }) => rest),
  };
}
