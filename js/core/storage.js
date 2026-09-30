// Speicherung im Browser (localStorage). ParentsDay hat keinen Server: alle Daten der Lehrkraft
// liegen nur in diesem Browser und in heruntergeladenen Zwischenspeicher-Dateien.
//
// Datenmodell der Lehrkraft (TeacherState, Version 1):
// {
//   app: 'ParentsDay', type: 'teacher-state', version: 1, savedAt: ISO-Zeitstempel,
//   teacher: { firstName, lastName, birthDate: 'JJJJ-MM-TT', email, registrationCode, teacherCode },
//   event: null | {
//     schoolAddress: string,                    // mehrzeilig möglich
//     slotMinutes: number,                      // Terminlänge (Standard für neue Termine)
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

import { APP_NAME, DATA_VERSION, MAX_EVENT_DAYS, SLOT_MIN, SLOT_MAX } from '../config.js';
import { isValidIsoDate, codesEqual } from './codes.js';
import { isValidTime, toMinutes, cleanAvailability } from './time.js';

const TEACHER_PREFIX = 'parentsday.teacher.';
const SESSION_KEY = 'parentsday.session';
const PARENT_KEY = 'parentsday.parent';
const PARENT_TAB_KEY = 'parentsday.parentTab';
const DRAFT_PREFIX = 'parentsday.eventDraft.';

/** Meldung, wenn der Browser nichts mehr speichern kann. */
export const STORAGE_FULL = 'Speichern im Browser nicht möglich (Speicher voll oder gesperrt). Ihre letzte Änderung ist nicht gespeichert. Bitte laden Sie über „Zwischenstand speichern“ einen Zwischenstand herunter.';

const listeners = new Set();
let memoryFallback = new Map();

/** Ist der Speicher überhaupt zugänglich? (In manchen Browsern wirft schon das Lesen.) */
function storageUsable(store) {
  try {
    store.getItem(SESSION_KEY);
    return true;
  } catch {
    return false;
  }
}

function storageGet(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

/**
 * Schreibt in den Speicher. Ist der Speicher gar nicht zugänglich, wird nur im Arbeitsspeicher gemerkt.
 * Ist er voll (oder das Schreiben gesperrt), wird ein Fehler mit verständlicher Meldung geworfen –
 * sonst meldete die Seite „gespeichert“, obwohl nach dem Neuladen alles fehlt.
 */
function storageSet(store, key, value) {
  try {
    store.setItem(key, value);
  } catch (err) {
    if (!storageUsable(store)) {
      memoryFallback.set(key, value);
      return;
    }
    const error = new Error(STORAGE_FULL);
    error.cause = err;
    throw error;
  }
}

function storageRemove(store, key) {
  try {
    store.removeItem(key);
  } catch {
    memoryFallback.delete(key);
  }
}

let persistent = null;

/** Werden Daten in diesem Browser dauerhaft gespeichert (localStorage nutzbar)? Einmal je Seitenaufruf geprüft. */
export function isPersistentStorage() {
  if (persistent !== null) return persistent;
  try {
    const probe = 'parentsday.probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    persistent = true;
  } catch {
    persistent = false;
  }
  return persistent;
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

/**
 * Speichert den Zustand, aktualisiert savedAt und informiert alle Beobachter.
 * Wirft einen Fehler (STORAGE_FULL), wenn der Browser nicht speichern kann – die Beobachter
 * („Automatisch gespeichert“) werden dann nicht benachrichtigt.
 */
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

/** Schlüssel im localStorage, unter dem der Zustand einer Lehrkraft liegt. */
export function teacherStorageKey(teacherCode) {
  return TEACHER_PREFIX + teacherCode;
}

/**
 * Löscht alle Daten einer Lehrkraft aus diesem Browser – auch Stände, die (z. B. aus einer von Hand
 * veränderten Datei) unter einer anderen Schreibweise desselben Codes liegen.
 */
export function deleteTeacherState(teacherCode) {
  storageRemove(localStorage, TEACHER_PREFIX + teacherCode);
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    for (const key of keys) {
      if (key?.startsWith(TEACHER_PREFIX) && codesEqual(key.slice(TEACHER_PREFIX.length), teacherCode)) localStorage.removeItem(key);
    }
  } catch {
    // Speicher nicht zugänglich – nichts weiter zu löschen
  }
  for (const key of [...memoryFallback.keys()]) {
    if (key.startsWith(TEACHER_PREFIX) && codesEqual(key.slice(TEACHER_PREFIX.length), teacherCode)) memoryFallback.delete(key);
  }
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
  try {
    storageSet(sessionStorage, SESSION_KEY, teacherCode);
  } catch {
    // sessionStorage voll: Anmeldung gilt dann nur bis zum Neuladen
    memoryFallback.set(SESSION_KEY, teacherCode);
  }
}

export function clearSession() {
  storageRemove(sessionStorage, SESSION_KEY);
  memoryFallback.delete(SESSION_KEY);
}

// --- Ziel nach der Anmeldung (z. B. direkt aufgerufene Klasse) ---

const RETURN_KEY = 'parentsday.returnTo';
const RETURN_MAX_AGE = 30 * 60 * 1000;

/** Merkt sich eine Lehrkraft-Seite, die ohne Anmeldung aufgerufen wurde. */
export function setReturnTo(path) {
  try {
    storageSet(sessionStorage, RETURN_KEY, JSON.stringify({ path, time: Date.now() }));
  } catch {
    // ohne Speicher geht es nach der Anmeldung zur Startseite der Lehrkraft
  }
}

/** Gemerkte Seite (höchstens 30 Minuten alt) oder ''. Wird dabei gelöscht. */
export function takeReturnTo() {
  const raw = storageGet(sessionStorage, RETURN_KEY);
  storageRemove(sessionStorage, RETURN_KEY);
  try {
    const data = JSON.parse(raw || 'null');
    if (!data || typeof data.path !== 'string' || !data.path.startsWith('/lehrkraft/') || Date.now() - Number(data.time) > RETURN_MAX_AGE) return '';
    return data.path;
  } catch {
    return '';
  }
}

/** Zustand der angemeldeten Lehrkraft oder null. */
export function getCurrentState() {
  const code = getSession();
  return code ? loadTeacherState(code) : null;
}

/**
 * Ändert den Zustand der angemeldeten Lehrkraft und speichert ihn.
 * Wirft einen Fehler, wenn nicht gespeichert werden konnte (dann bleibt der alte Stand erhalten).
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

// --- Prüfen und Vereinheitlichen gespeicherter Daten ---
// Der Zustand stammt aus dem localStorage oder aus einer (evtl. von Hand veränderten) Datei.
// Ungültige Einträge werden verworfen, damit keine Seite an kaputten Daten scheitert.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 500) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').slice(0, max);

function normalizeEvent(ev) {
  if (!isObject(ev)) return null;
  const slot = Number(ev.slotMinutes);
  const seen = new Set();
  const days = (Array.isArray(ev.days) ? ev.days : [])
    .filter((d) => isObject(d) && isValidIsoDate(d.date) && isValidTime(d.start) && isValidTime(d.end) && toMinutes(d.end) > toMinutes(d.start))
    .filter((d) => !seen.has(d.date) && seen.add(d.date))
    .map((d) => ({ date: d.date, start: d.start, end: d.end }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, MAX_EVENT_DAYS);
  return {
    schoolAddress: text(ev.schoolAddress, 2000),
    slotMinutes: Number.isInteger(slot) && slot >= SLOT_MIN && slot <= SLOT_MAX && slot % 5 === 0 ? slot : 10,
    days,
  };
}

function normalizeResponse(r) {
  if (!isObject(r) || !isObject(r.availability)) return null;
  return { submittedAt: text(r.submittedAt, 40), availability: cleanAvailability(r.availability) };
}

function normalizeAppointment(a) {
  if (!isObject(a) || !isValidIsoDate(a.date) || !isValidTime(a.start)) return null;
  const duration = Number(a.duration);
  return { date: a.date, start: a.start, duration: Number.isInteger(duration) && duration >= 1 && duration <= 1440 ? duration : 10 };
}

function normalizeClasses(list) {
  const classes = [];
  const ids = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!isObject(c)) continue;
    const grade = Number(c.grade);
    const letter = text(c.letter, 1).toLowerCase();
    if (!Number.isInteger(grade) || grade < 1 || grade > 13 || !/^[a-h]$/.test(letter)) continue;
    const id = `${grade}${letter}`;
    if (ids.has(id)) continue;
    ids.add(id);
    const studentIds = new Set();
    const students = (Array.isArray(c.students) ? c.students : []).filter(isObject).map((st) => {
      let sid = text(st.id, 60);
      if (!sid || studentIds.has(sid)) sid = newId();
      studentIds.add(sid);
      return {
        id: sid,
        lastName: text(st.lastName, 200),
        firstName: text(st.firstName, 200),
        code: text(st.code, 400), // 2 × 80 Buchstaben ergeben bis zu 320 Ziffern
        response: normalizeResponse(st.response),
        appointment: normalizeAppointment(st.appointment),
      };
    });
    classes.push({ id, grade, letter, codesGenerated: Boolean(c.codesGenerated), students });
  }
  return classes;
}

/** Prüft einen gespeicherten Stand und ergänzt fehlende Felder. Wirft bei unbrauchbaren Daten. */
export function normalizeTeacherState(raw) {
  if (!isObject(raw) || !isObject(raw.teacher) || !text(raw.teacher.teacherCode, 60)) {
    throw new Error('Die Daten sind kein gültiger ParentsDay-Stand.');
  }
  const t = raw.teacher;
  const savedAt = text(raw.savedAt, 40);
  const state = {
    app: APP_NAME,
    type: 'teacher-state',
    version: DATA_VERSION,
    savedAt: savedAt && !Number.isNaN(Date.parse(savedAt)) ? savedAt : new Date().toISOString(),
    teacher: {
      firstName: text(t.firstName, 200),
      lastName: text(t.lastName, 200),
      birthDate: text(t.birthDate, 10),
      email: text(t.email, 254),
      registrationCode: text(t.registrationCode, 60),
      teacherCode: text(t.teacherCode, 60),
    },
    event: normalizeEvent(raw.event),
    classes: normalizeClasses(raw.classes),
  };
  sortClasses(state);
  return state;
}

// --- Noch nicht gespeicherte Eingaben auf „Elternsprechtag erstellen“ / „Weitere Einstellungen“ ---
// Sie liegen bis zum Absenden nur in diesem Tab (sessionStorage) und kommen mit in den Zwischenspeicher.
// `base` ist der gespeicherte Stand, auf dem der Entwurf beruht – passt er nicht mehr, gilt der Entwurf nicht.

const draftListeners = new Set();
let draftPending = false;

/** Gespeicherter Stand, auf dem ein Entwurf beruht. */
export function eventDraftBase(state) {
  return JSON.stringify({ event: state.event || null, email: state.teacher.email || '' });
}

/** Rohdaten des Entwurfs der angemeldeten Lehrkraft, wenn er zum Stand `state` passt (sonst null). */
export function loadEventDraft(state) {
  try {
    const data = JSON.parse(storageGet(sessionStorage, DRAFT_PREFIX + state.teacher.teacherCode) || 'null');
    if (!data || data.base !== eventDraftBase(state) || !isObject(data.draft) || !Array.isArray(data.draft.days)) return null;
    return data.draft;
  } catch {
    return null;
  }
}

export function storeEventDraft(state, draft) {
  try {
    storageSet(sessionStorage, DRAFT_PREFIX + state.teacher.teacherCode, JSON.stringify({ base: eventDraftBase(state), draft }));
  } catch {
    // Speicher nicht verfügbar – dann gehen ungespeicherte Eingaben beim Neuladen verloren.
  }
}

export function clearEventDraft(state) {
  storageRemove(sessionStorage, DRAFT_PREFIX + state.teacher.teacherCode);
}

/** Meldet, ob auf der aktuellen Seite ungespeicherte Eingaben stehen (für die Anzeige in der Kopfzeile). */
export function setDraftPending(pending) {
  if (draftPending === Boolean(pending)) return;
  draftPending = Boolean(pending);
  for (const fn of draftListeners) fn(draftPending);
}

export function isDraftPending() {
  return draftPending;
}

export function onDraftPendingChange(fn) {
  draftListeners.add(fn);
  return () => draftListeners.delete(fn);
}

// --- Elternseite ---
// ParentState: { event: EventInfo|null, login: {firstName,lastName,code}|null, selection: {'JJJJ-MM-TT': [slotStartMinuten…]},
//                submittedAt?: string, lastPayload?: ResponsePayload, lastFilename?: string,
//                teacherEmailInput?: string, teacherEmailFor?: string }
// Jeder Tab arbeitet mit seinem eigenen Stand (sessionStorage) – Eltern mit mehreren Kindern öffnen
// die QR-Codes oft in mehreren Tabs; so vermischen sich die Angaben nicht. Zusätzlich wird der zuletzt
// gespeicherte Stand im localStorage abgelegt: ein neuer Tab (oder ein späterer Besuch) beginnt damit.

function parseParentState(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadParentState() {
  const own = parseParentState(storageGet(sessionStorage, PARENT_TAB_KEY));
  const parsed = own || parseParentState(storageGet(localStorage, PARENT_KEY));
  return { event: null, login: null, selection: {}, ...(parsed || {}) };
}

export function saveParentState(parentState) {
  const json = JSON.stringify(parentState);
  // Die Elternseite speichert bei jedem Tippen – ein voller Speicher darf sie nicht stören.
  for (const [store, key] of [[sessionStorage, PARENT_TAB_KEY], [localStorage, PARENT_KEY]]) {
    try {
      storageSet(store, key, json);
    } catch (err) {
      console.warn(err);
    }
  }
}

/** Löscht den Stand dieses Tabs – den eines anderen Kindes (aus einem anderen Tab) aber nicht. */
export function clearParentState() {
  const own = parseParentState(storageGet(sessionStorage, PARENT_TAB_KEY));
  storageRemove(sessionStorage, PARENT_TAB_KEY);
  const shared = parseParentState(storageGet(localStorage, PARENT_KEY));
  if (!shared?.login || !own?.login || shared.login.code === own.login.code) storageRemove(localStorage, PARENT_KEY);
}
