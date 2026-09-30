// Unit-Tests: Speicherung (core/storage.js) und Zwischenspeicher-Datei (core/backup.js)
// mit nachgebildetem localStorage/sessionStorage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveTeacherState, loadTeacherState, onStateChange, normalizeTeacherState, deleteTeacherState, STORAGE_FULL,
  loadParentState, saveParentState, clearParentState, storeEventDraft, loadEventDraft, setSession, getCurrentState, replaceState,
} from '../../js/core/storage.js';
import { readBackupFile } from '../../js/core/backup.js';
import { teacherCode } from '../../js/core/codes.js';

/** Einfacher Web-Storage mit Größengrenze (Zeichen). `blocked`: schon das Lesen wirft (z. B. gesperrte Cookies). */
class FakeStorage {
  constructor({ quota = Infinity, blocked = false } = {}) {
    this.map = new Map();
    this.quota = quota;
    this.blocked = blocked;
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(key) {
    if (this.blocked) throw new Error('SecurityError');
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    if (this.blocked) throw new Error('SecurityError');
    let size = String(value).length;
    for (const [k, v] of this.map) if (k !== key) size += v.length;
    if (size > this.quota) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

function install({ quota, blocked } = {}) {
  const local = new FakeStorage({ quota, blocked });
  const session = new FakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true, writable: true });
  return { local, session };
}

const ANNA = { firstName: 'Anna', lastName: 'Meier', birthDate: '1990-03-15', email: 'anna.meier@schule.de', registrationCode: 'AM60127960', teacherCode: 'A16595316960M' };

function teacherState(overrides = {}) {
  return {
    app: 'ParentsDay',
    type: 'teacher-state',
    version: 1,
    savedAt: '2026-09-30T08:00:00.000Z',
    teacher: { ...ANNA },
    event: { schoolAddress: 'Schule', slotMinutes: 10, days: [{ date: '2026-11-12', start: '14:00', end: '18:00' }] },
    classes: [{ id: '5a', grade: 5, letter: 'a', codesGenerated: false, students: [{ id: 's1', firstName: 'Anna', lastName: 'Beck', code: '', response: null, appointment: null }] }],
    ...overrides,
  };
}

function file(obj, name = 'Zwischenspeicher.json') {
  return new File([typeof obj === 'string' ? obj : JSON.stringify(obj)], name, { type: 'application/json' });
}

beforeEach(() => install());

test('Voller Speicher: Fehler mit verständlicher Meldung, keine Meldung „gespeichert“, alter Stand bleibt', () => {
  const { local } = install({ quota: 2000 });
  saveTeacherState(teacherState());
  const before = local.getItem('parentsday.teacher.A16595316960M');
  let notified = 0;
  const off = onStateChange(() => notified++);
  const big = teacherState();
  big.classes[0].students[0].firstName = 'x'.repeat(5000);
  assert.throws(() => saveTeacherState(big), { message: STORAGE_FULL });
  off();
  assert.equal(notified, 0);
  assert.equal(local.getItem('parentsday.teacher.A16595316960M'), before);
});

test('Gesperrter Speicher: Arbeitsspeicher als Ausweichweg, kein Fehler', () => {
  install({ blocked: true });
  saveTeacherState(teacherState());
  assert.equal(loadTeacherState('A16595316960M').classes[0].id, '5a');
});

test('Kaputte oder von Hand veränderte Daten werden bereinigt statt Seiten lahmzulegen', () => {
  const raw = teacherState({
    event: {
      schoolAddress: 'Schule',
      slotMinutes: 0.0001,
      days: [null, { start: '14:00', end: '15:00' }, { date: '2026-11-12', start: '14:00', end: '18:00' }, { date: '2026-11-12', start: '15:00', end: '16:00' }, { date: '2026-11-13', start: '18:00', end: '14:00' }],
    },
    classes: [
      null,
      { id: '99z', grade: 99, letter: 'z', students: [] },
      {
        id: '5a',
        grade: 5,
        letter: 'a',
        students: [
          null,
          { id: 's1', firstName: 'Anna', lastName: 'Beck', code: 7, response: { availability: { '2026-11-12': { length: 1 } } }, appointment: { date: '2026-11-12', start: 'kaputt' } },
          { id: 's1', firstName: 'Ben', lastName: 'Cem', response: { submittedAt: 'x', availability: { '2026-11-12': [['14:00', '15:00'], ['x', 'y']] } }, appointment: { date: '2026-11-12', start: '14:00', duration: 1e9 } },
        ],
      },
      { id: '5a', grade: 5, letter: 'a', students: [] },
    ],
  });
  const state = normalizeTeacherState(raw);
  assert.equal(state.event.slotMinutes, 10);
  assert.deepEqual(state.event.days, [{ date: '2026-11-12', start: '14:00', end: '18:00' }]);
  assert.deepEqual(state.classes.map((c) => c.id), ['5a']);
  const [anna, ben] = state.classes[0].students;
  assert.equal(state.classes[0].students.length, 2);
  assert.equal(anna.code, '7');
  assert.deepEqual(anna.response.availability, {});
  assert.equal(anna.appointment, null);
  assert.notEqual(ben.id, anna.id, 'doppelte IDs werden ersetzt');
  assert.deepEqual(ben.response.availability, { '2026-11-12': [['14:00', '15:00']] });
  assert.equal(ben.appointment.duration, 10);
});

test('„Alle Daten löschen“ entfernt auch anders geschriebene Stände desselben Codes', () => {
  const { local } = install();
  local.setItem('parentsday.teacher.A16595316960M', JSON.stringify(teacherState()));
  local.setItem('parentsday.teacher.a16595316960m', JSON.stringify(teacherState()));
  local.setItem('parentsday.teacher.B1M', JSON.stringify(teacherState()));
  deleteTeacherState('A16595316960M');
  assert.deepEqual([...local.map.keys()], ['parentsday.teacher.B1M']);
});

test('Elternseite: jeder Tab hat seinen eigenen Stand, ein neuer Tab beginnt mit dem zuletzt gespeicherten', () => {
  const { local, session } = install();
  const lena = { event: null, login: { code: 'LENA' }, selection: { '2026-11-12': [840] } };
  saveParentState(lena);
  assert.equal(JSON.parse(local.getItem('parentsday.parent')).login.code, 'LENA');
  // Zweiter Tab (neuer sessionStorage): startet mit Lena, speichert Tom
  const tab1 = session.map;
  globalThis.sessionStorage.map = new Map();
  assert.equal(loadParentState().login.code, 'LENA');
  saveParentState({ event: null, login: { code: 'TOM' }, selection: {} });
  // Zurück im ersten Tab: dort bleibt Lena
  const tab2 = globalThis.sessionStorage.map;
  globalThis.sessionStorage.map = tab1;
  assert.equal(loadParentState().login.code, 'LENA');
  assert.deepEqual(loadParentState().selection, { '2026-11-12': [840] });
  // „Fertig – abmelden“ in Tab 1 löscht nicht den Stand von Tom
  clearParentState();
  assert.equal(JSON.parse(local.getItem('parentsday.parent')).login.code, 'TOM');
  globalThis.sessionStorage.map = tab2;
  assert.equal(loadParentState().login.code, 'TOM');
});

test('Zwischenspeicher: zu groß, beschädigt oder keine Datei von ParentsDay', async () => {
  await assert.rejects(readBackupFile({ size: 50 * 1024 * 1024, text: async () => '{}' }, ANNA), { message: 'Diese Datei ist zu groß für einen ParentsDay-Zwischenspeicher.' });
  await assert.rejects(readBackupFile(file('{"app":'), ANNA), { message: 'Diese Datei ist kein ParentsDay-Zwischenspeicher.' });
  await assert.rejects(readBackupFile(file({ app: 'ParentsDay', type: 'teacher-state', teacher: null }), ANNA), { message: /beschädigt/ });
  // null-Einträge führen nicht zu englischen Meldungen, sondern werden bereinigt
  const { state } = await readBackupFile(file(teacherState({ classes: [null, { id: '5a', grade: 5, letter: 'a', students: [null] }] })), ANNA);
  assert.deepEqual(state.classes.map((c) => c.students.length), [0]);
});

test('Zwischenspeicher einer anderen Lehrkraft mit gleichem Lehrkräftecode wird abgelehnt', async () => {
  const anton = { ...ANNA, firstName: 'Anton', lastName: 'Müller', email: 'anton@andere-schule.example', registrationCode: 'AM75159950' };
  assert.equal(teacherCode(anton.firstName, anton.lastName, anton.birthDate), ANNA.teacherCode);
  await assert.rejects(readBackupFile(file(teacherState({ teacher: anton })), ANNA), { message: 'Dieser Zwischenspeicher gehört zu Anton Müller und kann hier nicht geladen werden.' });
  await assert.rejects(readBackupFile(file(teacherState({ teacher: { ...ANNA, teacherCode: 'B1M' } })), ANNA), { message: /anderen Lehrkraft/ });
});

test('Zwischenspeicher mit anders geschriebenem Code wird unter dem Code der Sitzung gespeichert', async () => {
  const { local } = install();
  setSession(ANNA.teacherCode);
  saveTeacherState(teacherState({ classes: [] }));
  const { state } = await readBackupFile(file(teacherState({ teacher: { ...ANNA, teacherCode: 'a16595316960m' } })), ANNA);
  assert.equal(state.teacher.teacherCode, ANNA.teacherCode);
  replaceState(state);
  assert.deepEqual(getCurrentState().classes.map((c) => c.id), ['5a']);
  assert.deepEqual([...local.map.keys()], ['parentsday.teacher.A16595316960M']);
});

test('Zwischenspeicher enthält ungespeicherte Eingaben zum Elternsprechtag', async () => {
  install();
  const saved = replaceState(teacherState({ event: null }));
  const draft = { days: [{ date: '2026-10-15', start: '14:00', end: '18:00' }], address: 'Neue Adresse', slot: '15', email: ANNA.email };
  storeEventDraft(saved, draft);
  assert.deepEqual(loadEventDraft(saved), draft);
  // Aus der Datei gelesen: nur einfache Werte, begrenzte Länge
  const { eventDraft } = await readBackupFile(file({ ...teacherState({ event: null }), eventDraft: { ...draft, days: [...draft.days, null], extra: 'x' } }), ANNA);
  assert.deepEqual(eventDraft, draft);
  // Passt der Entwurf nicht mehr zum gespeicherten Stand, gilt er nicht
  assert.equal(loadEventDraft(replaceState(teacherState())), null);
});
