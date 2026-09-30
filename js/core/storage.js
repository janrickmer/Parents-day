// Speicherung im Browser (localStorage). ParentsDay hat keinen Server: alle Daten der Lehrkraft
// liegen nur in diesem Browser und in heruntergeladenen Zwischenspeicher-Dateien.
//
// Datenmodell der Lehrkraft (TeacherState, Version 1):
// {
//   app: 'ParentsDay', type: 'teacher-state', version: 1, savedAt: ISO-Zeitstempel,
//   teacher: { firstName, lastName, birthDate: 'JJJJ-MM-TT', email, registrationCode, teacherCode },
//   event: null | {
//     schoolAddress: string,                    // mehrzeilig möglich
//     slotMinutes: number,                      // Standardlänge eines Terminslots
//     days: [{ date: 'JJJJ-MM-TT', start: 'HH:MM', end: 'HH:MM' }]   // nach Datum sortiert
//   },
//   classes: [{                                  // nach Jahrgang und Buchstabe sortiert
//     id: '5a', grade: 5, letter: 'a',
//     codesGenerated: boolean,                   // true, sobald „Alle Lernenden erfolgreich eingetragen“ geklickt wurde
//     students: [{
//       id: string,                              // interne ID
//       lastName: string, firstName: string,
//       code: string,                            // '' solange nicht erzeugt
//       response: null | {                       // Rückmeldung der Eltern
//         submittedAt: ISO-Zeitstempel,
//         availability: { 'JJJJ-MM-TT': [['HH:MM','HH:MM'], …] }   // verfügbare Zeitspannen je Tag
//       },
//       appointment: null | { date: 'JJJJ-MM-TT', start: 'HH:MM', duration: number }  // Dauer in Minuten
//     }]
//   }]
// }

import { APP_NAME, DATA_VERSION } from '../config.js';

const TEACHER_PREFIX = 'parentsday.teacher.';
const SESSION_KEY = 'parentsday.session';
const PARENT_KEY = 'parentsday.parent';

const listeners = new Set();
let memoryFallback = new Map();

function storageGet(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

function storageSet(store, key, value) {
  try {
    store.setItem(key, value);
  } catch {
    memoryFallback.set(key, value);
  }
}

function storageRemove(store, key) {
  try {
    store.removeItem(key);
  } catch {
    memoryFallback.delete(key);
  }
}

/** Kurze zufällige ID. */
export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function createTeacherState(teacher) {
  return {
    app: APP_NAME,
    type: 'teacher-state',
    version: DATA_VERSION,
    savedAt: new Date().toISOString(),
    teacher: { ...teacher },
    event: null,
    classes: [],
  };
}

export function loadTeacherState(teacherCode) {
  const raw = storageGet(localStorage, TEACHER_PREFIX + teacherCode);
  if (!raw) return null;
  try {
    return normalizeTeacherState(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Speichert den Zustand, aktualisiert savedAt und informiert alle Beobachter. */
export function saveTeacherState(state) {
  state.savedAt = new Date().toISOString();
  sortClasses(state);
  storageSet(localStorage, TEACHER_PREFIX + state.teacher.teacherCode, JSON.stringify(state));
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
  return state;
}

/** Löscht alle Daten einer Lehrkraft aus diesem Browser. */
export function deleteTeacherState(teacherCode) {
  storageRemove(localStorage, TEACHER_PREFIX + teacherCode);
}

/** Beobachter für Änderungen am Zustand. Gibt eine Abmelde-Funktion zurück. */
export function onStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- Sitzung (Anmeldung gilt, bis der Tab geschlossen oder abgemeldet wird) ---

export function getSession() {
  return storageGet(sessionStorage, SESSION_KEY);
}

export function setSession(teacherCode) {
  storageSet(sessionStorage, SESSION_KEY, teacherCode);
}

export function clearSession() {
  storageRemove(sessionStorage, SESSION_KEY);
}

/** Zustand der angemeldeten Lehrkraft oder null. */
export function getCurrentState() {
  const code = getSession();
  return code ? loadTeacherState(code) : null;
}

/**
 * Ändert den Zustand der angemeldeten Lehrkraft und speichert ihn.
 * @param {(state: object) => void} mutator
 */
export function updateState(mutator) {
  const state = getCurrentState();
  if (!state) throw new Error('Keine Lehrkraft angemeldet.');
  mutator(state);
  return saveTeacherState(state);
}

/** Ersetzt den gesamten Zustand (z. B. nach dem Laden eines Zwischenspeichers). */
export function replaceState(state) {
  return saveTeacherState(normalizeTeacherState(state));
}

/** Findet eine Klasse im Zustand. */
export function findClass(state, classId) {
  return state?.classes?.find((c) => c.id === classId) ?? null;
}

function sortClasses(state) {
  if (!Array.isArray(state.classes)) return;
  state.classes.sort((a, b) => a.grade - b.grade || a.letter.localeCompare(b.letter));
}

/** Ergänzt fehlende Felder, damit auch ältere/unvollständige Daten sicher verwendbar sind. */
export function normalizeTeacherState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.teacher || !raw.teacher.teacherCode) {
    throw new Error('Die Daten sind kein gültiger ParentsDay-Stand.');
  }
  const state = {
    app: APP_NAME,
    type: 'teacher-state',
    version: DATA_VERSION,
    savedAt: raw.savedAt || new Date().toISOString(),
    teacher: { email: '', ...raw.teacher },
    event: raw.event
      ? {
          schoolAddress: raw.event.schoolAddress || '',
          slotMinutes: Number(raw.event.slotMinutes) || 10,
          days: Array.isArray(raw.event.days)
            ? raw.event.days.map((d) => ({ date: d.date, start: d.start, end: d.end })).sort((a, b) => a.date.localeCompare(b.date))
            : [],
        }
      : null,
    classes: Array.isArray(raw.classes)
      ? raw.classes.map((c) => ({
          id: c.id || `${c.grade}${c.letter}`,
          grade: Number(c.grade),
          letter: String(c.letter).toLowerCase(),
          codesGenerated: Boolean(c.codesGenerated),
          students: Array.isArray(c.students)
            ? c.students.map((s) => ({
                id: s.id || newId(),
                lastName: s.lastName || '',
                firstName: s.firstName || '',
                code: s.code || '',
                response: s.response && s.response.availability ? { submittedAt: s.response.submittedAt || '', availability: s.response.availability } : null,
                appointment: s.appointment && s.appointment.date ? { date: s.appointment.date, start: s.appointment.start, duration: Number(s.appointment.duration) || 10 } : null,
              }))
            : [],
        }))
      : [],
  };
  sortClasses(state);
  return state;
}

// --- Elternseite ---
// ParentState: { event: EventInfo|null, login: {firstName,lastName,code}|null, selection: {'JJJJ-MM-TT': [slotStartMinuten…]},
//                submittedAt?: string, lastPayload?: ResponsePayload, lastFilename?: string, teacherEmailInput?: string }

export function loadParentState() {
  const raw = storageGet(localStorage, PARENT_KEY);
  if (!raw) return { event: null, login: null, selection: {} };
  try {
    const parsed = JSON.parse(raw);
    return { event: null, login: null, selection: {}, ...parsed };
  } catch {
    return { event: null, login: null, selection: {} };
  }
}

export function saveParentState(parentState) {
  storageSet(localStorage, PARENT_KEY, JSON.stringify(parentState));
}

export function clearParentState() {
  storageRemove(localStorage, PARENT_KEY);
}
