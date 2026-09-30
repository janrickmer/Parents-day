// Zwischenspeicher: kompletter Stand der Lehrkraft als Datei
// „Zwischenspeicher vom TT.MM.JJJJ um hh:mm für ParentsDay.json“.
// Enthält auch noch nicht gespeicherte Eingaben zum Elternsprechtag (Feld `eventDraft`), damit die
// Datei alles enthält, was die Lehrkraft in dem Moment sieht.

import { MAX_BACKUP_BYTES } from '../config.js';
import { nowParts } from './time.js';
import { downloadBlob, safeFilename } from './ui.js';
import { normalizeTeacherState } from './storage.js';
import { codesEqual, isSameTeacher } from './codes.js';

const NOT_A_BACKUP = 'Diese Datei ist kein ParentsDay-Zwischenspeicher.';
const DAMAGED = 'Die Datei ist beschädigt oder kein gültiger ParentsDay-Zwischenspeicher.';

export function backupFilename(date = new Date()) {
  const { date: d, time } = nowParts(date);
  return `Zwischenspeicher vom ${d} um ${time} für ParentsDay.json`;
}

/**
 * Lädt den aktuellen Stand als Datei herunter. Gibt den verwendeten Dateinamen zurück.
 * @param {object} state – TeacherState
 * @param {{eventDraft?: object|null}} [extra] – noch nicht gespeicherte Eingaben zum Elternsprechtag
 */
export function downloadBackup(state, { eventDraft = null } = {}) {
  const data = { ...state, type: 'teacher-state', exportedAt: new Date().toISOString() };
  if (eventDraft) data.eventDraft = eventDraft;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const name = safeFilename(backupFilename());
  downloadBlob(blob, name);
  return name;
}

/** Entwurf aus der Datei prüfen: nur einfache Werte, begrenzte Länge. */
function cleanDraft(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.days)) return null;
  const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : '');
  return {
    days: raw.days
      .filter((d) => d && typeof d === 'object')
      .slice(0, 62)
      .map((d) => ({ date: str(d.date, 10), start: str(d.start, 5), end: str(d.end, 5) })),
    address: str(raw.address, 2000),
    slot: str(raw.slot, 10),
    email: str(raw.email, 254),
  };
}

/**
 * Liest eine Zwischenspeicher-Datei und prüft, ob sie zur angemeldeten Lehrkraft gehört.
 * Der Lehrkräftecode allein genügt dafür nicht (gleiche Anfangsbuchstaben und gleiches Geburtsdatum
 * ergeben denselben Code) – verglichen werden auch Namen und Geburtsdatum.
 * @param {File} file
 * @param {object} [currentTeacher] – teacher-Objekt der angemeldeten Lehrkraft
 * @returns {Promise<{state: object, eventDraft: object|null}>} normalisierter Zustand; Namen, Geburtsdatum
 *   und Codes sind die der angemeldeten Lehrkraft
 */
export async function readBackupFile(file, currentTeacher = null) {
  if (Number(file?.size) > MAX_BACKUP_BYTES) throw new Error('Diese Datei ist zu groß für einen ParentsDay-Zwischenspeicher.');
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error(NOT_A_BACKUP);
  }
  if (!raw || raw.app !== 'ParentsDay' || raw.type !== 'teacher-state') throw new Error(NOT_A_BACKUP);
  let state;
  try {
    state = normalizeTeacherState(raw);
  } catch {
    throw new Error(DAMAGED);
  }
  if (currentTeacher) {
    const t = state.teacher;
    const owner = `${t.firstName} ${t.lastName}`.trim();
    if (!codesEqual(t.teacherCode, currentTeacher.teacherCode) || !isSameTeacher(t, currentTeacher.firstName, currentTeacher.lastName, currentTeacher.birthDate)) {
      throw new Error(
        owner && codesEqual(t.teacherCode, currentTeacher.teacherCode)
          ? `Dieser Zwischenspeicher gehört zu ${owner} und kann hier nicht geladen werden.`
          : 'Dieser Zwischenspeicher gehört zu einer anderen Lehrkraft und kann hier nicht geladen werden.',
      );
    }
    // Angaben der angemeldeten Lehrkraft behalten – so wird auch unter demselben Schlüssel gespeichert.
    const keep = ['firstName', 'lastName', 'birthDate', 'registrationCode', 'teacherCode'];
    for (const key of keep) if (currentTeacher[key]) state.teacher[key] = currentTeacher[key];
    if (!state.teacher.email) state.teacher.email = currentTeacher.email || '';
  }
  return { state, eventDraft: cleanDraft(raw.eventDraft) };
}
