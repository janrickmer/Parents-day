// Abgleich mit der Cloud-Sicherung (Verschlüsselung und Dienst: core/cloud.js). Läuft im Hintergrund,
// solange eine Lehrkraft angemeldet ist:
//  • Nach jeder Änderung wird der Stand nach kurzer Pause hochgeladen (spätestens nach 10 Sekunden).
//  • Beim Anmelden, beim Zurückkehren auf die Seite und alle 3 Minuten wird geprüft, ob ein anderes Gerät
//    einen neueren Stand gesichert hat – der wird dann übernommen.
//  • Haben beide Seiten geändert (z. B. war ein Gerät offline), entscheidet die Lehrkraft (Konflikt-Dialog).
//    Ist eine Seite leer, gilt ohne Rückfrage die andere.
//  • Ohne Verbindung wird das Hochladen automatisch nachgeholt.
//
// Auf dem Gerät gespeichert, je Lehrkraft (Lehrkräftecode):
//   localStorage  parentsday.cloud.<Code>     { v:2, syncId, version, dirty, syncedHash, pendingCreate,
//                                               pendingAdminHash?, syncedAt, remember }
//                 version: Stand der Cloud, auf dem der Stand dieses Geräts beruht; syncedHash: Prüfsumme dieses
//                 Stands – weicht der Stand davon ab, ist er „dirty“ und wird hochgeladen; pendingCreate:
//                 Sicherung noch nicht angelegt (z. B. bei der Registrierung ohne Verbindung)
//   parentsday.cloudKey.<Code>  { syncId, who, encKey, authToken, device } – im localStorage, wenn das Passwort
//                 auf diesem Gerät gemerkt werden soll, sonst nur im sessionStorage (bis zum Abmelden bzw.
//                 Schließen des Tabs). Das Admin-Token zum Löschen wird nie gespeichert.

import { getSession, loadTeacherState, replaceState, onStateChange, loadEventDraft, storeEventDraft, isEmptyTeacherState } from './storage.js';
import {
  cloudEnabled,
  deriveCloudKeys,
  newDeviceSecret,
  hashOf,
  isValidCloudKeys,
  encryptCloudData,
  decryptCloudData,
  packCloudData,
  unpackCloudData,
  openCloudRecord,
  fetchCloudRecord,
  createCloudRecord,
  saveCloudRecord,
  deleteCloudRecord,
  cloudErrorMessage,
} from './cloud.js';
import { MailboxError, isValidTeacherMailbox } from './mailbox.js';

const CONFIG_PREFIX = 'parentsday.cloud.';
const KEY_PREFIX = 'parentsday.cloudKey.';
const PUSH_DELAY_MS = 2000;
const PUSH_MAX_WAIT_MS = 10000;
const PULL_INTERVAL_MS = 3 * 60 * 1000;
const PULL_ON_FOCUS_MS = 30 * 1000;
const RETRY_MS = [15000, 30000, 60000, 120000, 300000];
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;
const KEEPALIVE_MAX_CHARS = 60000; // Browser erlauben mit keepalive höchstens 64 KB

const NEEDS_PASSWORD =
  'Bitte geben Sie Ihr Passwort für die Cloud-Sicherung erneut ein. Vielleicht wurde es auf einem anderen Gerät geändert oder die Sicherung gelöscht.';

// ---------- Speicher auf dem Gerät ----------

function readJson(store, key) {
  try {
    return JSON.parse(store.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(store, key) {
  try {
    store.removeItem(key);
  } catch {
    // Speicher nicht zugänglich
  }
}

/** Einstellungen der Cloud-Sicherung auf diesem Gerät oder null (nicht eingerichtet). */
export function loadCloudConfig(code) {
  if (!code) return null;
  const cfg = readJson(localStorage, CONFIG_PREFIX + code);
  // v:1 stammt von einer Vorabfassung (nie mit dem Dienst verbunden) – wird nicht übernommen.
  if (!cfg || cfg.v !== 2 || !/^[A-Za-z0-9_-]{32}$/.test(String(cfg.syncId || ''))) return null;
  return {
    ...cfg,
    version: Number.isInteger(cfg.version) && cfg.version >= 0 ? cfg.version : 0,
    dirty: Boolean(cfg.dirty),
    syncedHash: typeof cfg.syncedHash === 'string' ? cfg.syncedHash : '',
    pendingCreate: Boolean(cfg.pendingCreate),
    syncedAt: typeof cfg.syncedAt === 'string' ? cfg.syncedAt : '',
    remember: cfg.remember !== false,
  };
}

function saveCloudConfig(code, cfg) {
  writeJson(localStorage, CONFIG_PREFIX + code, { ...cfg, v: 2 });
}

function updateConfig(code, fn) {
  const cfg = loadCloudConfig(code);
  if (!cfg) return null;
  fn(cfg);
  saveCloudConfig(code, cfg);
  return cfg;
}

function loadKeys(code) {
  const keys = readJson(sessionStorage, KEY_PREFIX + code) || readJson(localStorage, KEY_PREFIX + code);
  const cfg = loadCloudConfig(code);
  return isValidCloudKeys(keys) && cfg && keys.syncId === cfg.syncId ? keys : null;
}

function saveKeys(code, keys, remember) {
  forgetKeys(code);
  const data = { syncId: keys.syncId, who: keys.who, encKey: keys.encKey, authToken: keys.authToken, device: keys.device };
  if (!(remember && writeJson(localStorage, KEY_PREFIX + code, data))) writeJson(sessionStorage, KEY_PREFIX + code, data);
}

function forgetKeys(code) {
  removeKey(localStorage, KEY_PREFIX + code);
  removeKey(sessionStorage, KEY_PREFIX + code);
}

/** Kennt dieses Gerät (bzw. dieser Tab) das Passwort der Cloud-Sicherung? */
export function hasCloudKeys(code) {
  return Boolean(loadKeys(code));
}

/** Ist die Cloud-Sicherung auf diesem Gerät verbunden (eingerichtet und Passwort bekannt)? */
export function isCloudConnected(code) {
  return Boolean(loadCloudConfig(code) && loadKeys(code));
}

/** Entfernt alles zur Cloud-Sicherung von diesem Gerät. Die Sicherung selbst bleibt beim Dienst erhalten. */
export function forgetCloudOnDevice(code) {
  removeKey(localStorage, CONFIG_PREFIX + code);
  forgetKeys(code);
  if (code === active) {
    problem = null;
    emitStatus();
  }
}

/** Beim Abmelden: ein nicht gemerktes Passwort (Schlüssel nur für diese Sitzung) vergessen. */
export function endCloudSession(code) {
  const cfg = loadCloudConfig(code);
  if (!cfg || !cfg.remember) removeKey(sessionStorage, KEY_PREFIX + code);
}

// ---------- Zustand für die Anzeige ----------

let active = null; // Lehrkräftecode, dessen Stand dieser Tab abgleicht
let syncing = false;
let problem = null; // { kind, message } – letzter Fehler, bis zum nächsten erfolgreichen Abgleich
let conflictResolver = null;
const statusListeners = new Set();
const remoteListeners = new Set();

/**
 * Zustand der Cloud-Sicherung für die Anzeige.
 * kind: 'disabled' (kein Dienst), 'off' (niemand angemeldet), 'not-setup', 'needs-password', 'syncing',
 *       'pending' (Änderungen noch nicht hochgeladen), 'ok', 'offline', 'unsupported' (Dienst ohne Cloud-Sicherung),
 *       'locked' (zu viele Versuche), 'conflict', 'error'
 * @returns {{kind:string, message?:string, syncedAt?:string, remember?:boolean}}
 */
export function getCloudStatus(code = active || getSession()) {
  if (!cloudEnabled()) return { kind: 'disabled' };
  if (!code) return { kind: 'off' };
  const cfg = loadCloudConfig(code);
  const own = code === active ? problem : null;
  if (!cfg) return { kind: 'not-setup', message: '' };
  const base = { syncedAt: cfg.syncedAt, remember: cfg.remember };
  if (!loadKeys(code)) return { ...base, kind: 'needs-password', message: own?.kind === 'needs-password' ? own.message : '' };
  if (code === active && syncing) return { ...base, kind: 'syncing' };
  if (own && own.kind !== 'needs-password') return { ...base, ...own };
  if (cfg.dirty || cfg.pendingCreate) return { ...base, kind: 'pending' };
  return { ...base, kind: 'ok' };
}

/** Beobachter für Änderungen des Zustands. Gibt eine Abmelde-Funktion zurück. */
export function onCloudStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function emitStatus() {
  const status = getCloudStatus();
  for (const fn of statusListeners) {
    try {
      fn(status);
    } catch (err) {
      console.error(err);
    }
  }
}

/**
 * Wird aufgerufen, nachdem ein Stand aus der Cloud übernommen wurde: { state, updatedAt, source }.
 * source: 'sync' (im Hintergrund, von einem anderen Gerät) oder 'unlock' (nach Eingabe des Passworts).
 */
export function onRemoteApplied(fn) {
  remoteListeners.add(fn);
  return () => remoteListeners.delete(fn);
}

/**
 * Entscheidung bei einem Konflikt (beide Seiten geändert). Die Funktion erhält
 * { local: {state}, remote: {state, eventDraft}, remoteUpdatedAt } und gibt 'local' oder 'remote' zurück.
 */
export function setConflictResolver(fn) {
  conflictResolver = fn;
}

// ---------- Vergleiche ----------

/** Inhalt eines Stands ohne Speicherzeitpunkte (für „gleicher Stand?“ und die Prüfsumme). */
function contentKey(state) {
  if (!state) return '';
  const mailbox = state.mailbox ? { ...state.mailbox, lastFetchedAt: undefined } : null;
  return JSON.stringify({ ...state, savedAt: undefined, mailbox });
}

export function sameContent(a, b) {
  return contentKey(a) === contentKey(b);
}

/** Prüfsumme des Inhalts (zwei 32-Bit-FNV-Varianten) – zum Erkennen, ob sich seit dem Abgleich etwas geändert hat. */
function contentHash(state) {
  const text = contentKey(state);
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${text.length}`;
}

// ---------- Abgleich ----------

let lock = Promise.resolve();
/** Führt Aufgaben nacheinander aus – nie zwei Anfragen an die Sicherung gleichzeitig. */
function exclusive(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

let queued = null;
let again = false;
let pushTimer = 0;
let firstPendingAt = 0;
let pullTimer = 0;
let retryTimer = 0;
let retryIndex = 0;
let lastPullAt = 0;
let applyingRemote = false;

// Jede Änderung am Stand einer Lehrkraft mit Cloud-Sicherung wird vermerkt und (verzögert) hochgeladen.
// Speichern ohne inhaltliche Änderung (z. B. nur „Zuletzt abgerufen“) zählt nicht.
onStateChange((state) => {
  if (applyingRemote) return;
  const code = state?.teacher?.teacherCode;
  const cfg = loadCloudConfig(code);
  if (!cfg) return;
  const dirty = contentHash(state) !== cfg.syncedHash;
  if (dirty === cfg.dirty) {
    if (dirty && code === active) schedulePush();
    return;
  }
  updateConfig(code, (c) => (c.dirty = dirty));
  if (code === active) {
    if (dirty) schedulePush();
    emitStatus();
  }
});

function schedulePush() {
  const now = Date.now();
  if (!firstPendingAt) firstPendingAt = now;
  clearTimeout(pushTimer);
  const wait = Math.max(0, Math.min(PUSH_DELAY_MS, firstPendingAt + PUSH_MAX_WAIT_MS - now));
  pushTimer = setTimeout(() => {
    firstPendingAt = 0;
    syncCloudNow({ pull: false });
  }, wait);
}

function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  const delay = ms ?? RETRY_MS[Math.min(retryIndex++, RETRY_MS.length - 1)];
  retryTimer = setTimeout(() => syncCloudNow(), delay);
}

/** Einige Runden syncOnce – z. B. nach einem Konflikt, der mit „Stand dieses Geräts“ entschieden wurde. */
async function syncRounds(code, job) {
  let rounds = 0;
  do {
    again = false;
    await syncOnce(code, job);
  } while (again && active === code && ++rounds < 4);
}

/**
 * Gleicht jetzt ab: lädt Änderungen hoch bzw. holt einen neueren Stand (pull: false – nur hochladen).
 * Mehrere Aufrufe kurz hintereinander werden zusammengefasst.
 * @returns {Promise<object>} Zustand danach (wie getCloudStatus)
 */
export function syncCloudNow({ pull = true, keepalive = false } = {}) {
  if (!active || !cloudEnabled()) return Promise.resolve(getCloudStatus());
  if (queued) {
    queued.pull = queued.pull || pull;
    return queued.promise;
  }
  const job = { pull, keepalive };
  queued = job;
  job.promise = exclusive(async () => {
    if (queued === job) queued = null;
    const code = active;
    if (code) await syncRounds(code, job);
    return getCloudStatus();
  });
  return job.promise;
}

async function syncOnce(code, { pull, keepalive }) {
  const cfg = loadCloudConfig(code);
  const keys = loadKeys(code);
  if (!cfg || !keys) {
    emitStatus();
    return;
  }
  syncing = true;
  emitStatus();
  try {
    if (cfg.pendingCreate) await create(code, cfg, keys);
    // Noch kein gemeinsamer Stand (z. B. Anlegen traf auf eine vorhandene Sicherung): erst abgleichen
    else if (cfg.version === 0) await resolveConflict(code, keys);
    else if (cfg.dirty) await push(code, cfg, keys, keepalive);
    else if (pull) await pullRemote(code, cfg, keys);
    if (!problem || !['needs-password', 'conflict'].includes(problem.kind)) {
      problem = null;
      retryIndex = 0;
      clearTimeout(retryTimer);
    }
  } catch (err) {
    await handleError(code, keys, err);
  } finally {
    syncing = false;
    emitStatus();
  }
}

/** Nach dem Hoch- oder Herunterladen: Version und Prüfsumme merken; weicht der Stand inzwischen ab, gleich noch einmal. */
function markSynced(code, version, hash) {
  const local = loadTeacherState(code);
  const cfg = updateConfig(code, (c) => {
    c.version = version;
    c.pendingCreate = false;
    delete c.pendingAdminHash;
    c.syncedHash = hash;
    c.dirty = Boolean(local) && contentHash(local) !== hash;
    c.syncedAt = new Date().toISOString();
  });
  if (cfg?.dirty && code === active) schedulePush();
}

/** Aktueller Stand, verschlüsselt, samt Prüfsumme. */
async function sealCurrent(code, keys) {
  const state = loadTeacherState(code);
  if (!state) return null;
  const data = await encryptCloudData(keys, packCloudData(state, loadEventDraft(state)));
  return { data, hash: contentHash(state) };
}

async function create(code, cfg, keys) {
  const sealed = await sealCurrent(code, keys);
  if (!sealed) return;
  try {
    const res = await createCloudRecord(keys, sealed.data, cfg.pendingAdminHash);
    markSynced(code, res.version, sealed.hash);
  } catch (err) {
    if (!(err instanceof MailboxError) || err.status !== 409) throw err;
    // Mit diesem Passwort gibt es schon eine Sicherung (z. B. auf einem anderen Gerät eingerichtet):
    // öffnen, das Gerät eintragen und die beiden Stände abgleichen.
    const rec = await openCloudRecord(keys, keys.device);
    if (!rec.found) throw err;
    updateConfig(code, (c) => {
      c.pendingCreate = false;
      delete c.pendingAdminHash;
      c.version = 0;
    });
    await resolveConflict(code, keys, { rec, remote: unpackCloudData(await decryptCloudData(keys, rec)) });
  }
}

async function push(code, cfg, keys, keepalive) {
  const sealed = await sealCurrent(code, keys);
  if (!sealed) return;
  try {
    const res = await saveCloudRecord(keys, cfg.version, sealed.data, { keepalive: keepalive && sealed.data.ct.length < KEEPALIVE_MAX_CHARS });
    markSynced(code, res.version, sealed.hash);
  } catch (err) {
    if (err instanceof MailboxError && err.status === 409) return resolveConflict(code, keys);
    throw err;
  }
}

async function fetchRemote(keys, since) {
  const rec = await fetchCloudRecord(keys, { since });
  if (!rec.found || rec.unchanged) return { rec, remote: null };
  return { rec, remote: unpackCloudData(await decryptCloudData(keys, rec)) };
}

async function pullRemote(code, cfg, keys) {
  lastPullAt = Date.now();
  const { rec, remote } = await fetchRemote(keys, cfg.version);
  const latest = loadCloudConfig(code);
  // Inzwischen abgemeldet oder Cloud-Sicherung entfernt? Dann nichts mehr in den Speicher schreiben.
  if (code !== active || !latest || latest.syncId !== cfg.syncId) return;
  if (!rec.found) return;
  if (rec.unchanged) {
    updateConfig(code, (c) => (c.syncedAt = new Date().toISOString()));
    return;
  }
  // Während des Abrufs hier geändert? Dann haben beide Seiten Neues.
  if (latest.dirty) return resolveConflict(code, keys, { rec, remote });
  applyRemote(code, remote, rec);
}

async function resolveConflict(code, keys, fetched = null) {
  const { rec, remote } = fetched || (await fetchRemote(keys));
  if (code !== active || !loadCloudConfig(code) || !rec.found || !remote) return;
  const local = loadTeacherState(code);
  if (!local || isEmptyTeacherState(local)) return applyRemote(code, remote, rec);
  if (sameContent(local, remote.state)) return markSynced(code, rec.version, contentHash(remote.state));
  let choice = 'local';
  // Ist die Cloud leer (z. B. auf einem neuen Gerät eingerichtet), gilt ohne Rückfrage der Stand dieses Geräts.
  if (!isEmptyTeacherState(remote.state)) {
    if (!conflictResolver) {
      problem = { kind: 'conflict', message: 'Ihr Stand wurde auf einem anderen Gerät geändert, während hier noch nicht gesicherte Änderungen vorlagen.' };
      return;
    }
    problem = { kind: 'conflict', message: '' };
    syncing = false;
    emitStatus();
    choice = await conflictResolver({ local: { state: local }, remote, remoteUpdatedAt: rec.updatedAt });
    problem = null;
    if (active !== code || !loadCloudConfig(code)) return;
  }
  if (choice === 'remote') {
    applyRemote(code, remote, rec);
    return;
  }
  // Stand dieses Geräts behalten: er ersetzt den in der Cloud (nächste Runde lädt hoch).
  updateConfig(code, (c) => {
    c.version = rec.version;
    c.syncedHash = contentHash(remote.state);
    c.dirty = true;
  });
  again = true;
  schedulePush();
}

function applyRemote(code, remote, rec, source = 'sync') {
  const current = loadTeacherState(code);
  const next = remote.state;
  // Gespeichert wird unter dem Lehrkräftecode der angemeldeten Lehrkraft (bei gleichem Namen und Geburtsdatum derselbe).
  next.teacher.teacherCode = code;
  // Kein Briefkasten in der Cloud, aber auf diesem Gerät: behalten – sonst wären die Rückmeldungen darin nicht mehr lesbar.
  if (!next.mailbox && isValidTeacherMailbox(current?.mailbox)) next.mailbox = current.mailbox;
  const hash = contentHash(remote.state);
  let saved;
  applyingRemote = true;
  try {
    saved = replaceState(next, { keepSavedAt: true });
    if (remote.eventDraft) storeEventDraft(saved, remote.eventDraft);
  } finally {
    applyingRemote = false;
  }
  markSynced(code, rec.version, hash);
  for (const fn of remoteListeners) {
    try {
      fn({ state: saved, updatedAt: rec.updatedAt, source });
    } catch (err) {
      console.error(err);
    }
  }
}

/** 403: Dieses Gerät hat keinen Zugang mehr (Passwort geändert, Sicherung gelöscht oder Gerät ausgetragen). */
function handleForbidden(code, rejected) {
  const current = loadKeys(code);
  // Inzwischen neue Schlüssel (z. B. Passwort in einem anderen Tab geändert): mit denen weiter.
  if (current && rejected && current.authToken !== rejected.authToken) {
    again = true;
    return;
  }
  // Das abgelehnte Token nicht weiter verwenden.
  forgetKeys(code);
  updateConfig(code, (c) => {
    c.pendingCreate = false;
    delete c.pendingAdminHash;
  });
  problem = { kind: 'needs-password', message: NEEDS_PASSWORD };
}

async function handleError(code, keys, err) {
  if (err instanceof MailboxError) {
    if (err.status === 403) return handleForbidden(code, keys);
    if (err.status === 404) {
      problem = { kind: 'unsupported', message: 'Die Cloud-Sicherung ist auf dem Server noch nicht eingerichtet. Ihre Daten bleiben in diesem Browser gespeichert.' };
      scheduleRetry(UNSUPPORTED_RETRY_MS);
      return;
    }
    if (err.status === 429) {
      problem = { kind: 'locked', message: cloudErrorMessage(err) };
      scheduleRetry(Math.max(60, Number(err.data?.retryAfter) || 60) * 1000);
      return;
    }
    if (err.offline) {
      problem = { kind: 'offline', message: 'Keine Verbindung zur Cloud-Sicherung – wird automatisch nachgeholt.' };
      scheduleRetry();
      return;
    }
  }
  console.error(err);
  problem = { kind: 'error', message: err?.message && /[äöüß]|Cloud|Stand|Passwort/.test(err.message) ? err.message : 'Die Cloud-Sicherung hat nicht geklappt. ParentsDay versucht es später noch einmal.' };
  scheduleRetry();
}

// ---------- Starten und Beenden ----------

function onVisibility() {
  if (!active) return;
  if (document.visibilityState === 'hidden') {
    if (loadCloudConfig(active)?.dirty) syncCloudNow({ pull: false, keepalive: true });
  } else if (Date.now() - lastPullAt > PULL_ON_FOCUS_MS) {
    syncCloudNow();
  }
}

function onFocus() {
  if (active && Date.now() - lastPullAt > PULL_ON_FOCUS_MS) syncCloudNow();
}

function onOnline() {
  if (active) syncCloudNow();
}

function onPageHide() {
  if (active && loadCloudConfig(active)?.dirty) syncCloudNow({ pull: false, keepalive: true });
}

/**
 * Startet den Abgleich für die angemeldete Lehrkraft (mehrfacher Aufruf schadet nicht).
 * @param {{sync?: boolean}} [opts] – sync: gleich abgleichen (Standard)
 */
export function startCloudSync(code, { sync = true } = {}) {
  if (!cloudEnabled() || !code) return;
  if (active === code) return;
  stopCloudSync();
  active = code;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onPageHide);
  pullTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') syncCloudNow();
  }, PULL_INTERVAL_MS);
  emitStatus();
  if (sync) syncCloudNow();
  else if (loadCloudConfig(code)?.dirty) schedulePush();
}

export function stopCloudSync() {
  clearTimeout(pushTimer);
  clearTimeout(retryTimer);
  clearInterval(pullTimer);
  firstPendingAt = 0;
  retryIndex = 0;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('focus', onFocus);
  window.removeEventListener('online', onOnline);
  window.removeEventListener('pagehide', onPageHide);
  active = null;
  problem = null;
  emitStatus();
}

/** Lehrkraft, deren Stand gerade abgeglichen wird, oder null. */
export function activeCloudTeacher() {
  return active;
}

/**
 * Vor dem Abmelden: noch nicht hochgeladene Änderungen sofort sichern und einen laufenden Abgleich abwarten
 * (höchstens `timeout` ms).
 * @returns {Promise<boolean>} true, wenn nichts mehr offen ist (oder keine Cloud-Sicherung eingerichtet ist)
 */
export async function flushCloudSync({ timeout = 8000 } = {}) {
  const code = active;
  if (!code) return true;
  clearTimeout(pushTimer);
  firstPendingAt = 0;
  const cfg = loadCloudConfig(code);
  const pending = cfg && (cfg.dirty || cfg.pendingCreate) && loadKeys(code);
  let timer = 0;
  await Promise.race([pending ? syncCloudNow({ pull: false }) : exclusive(() => {}), new Promise((r) => (timer = setTimeout(r, timeout)))]);
  clearTimeout(timer);
  const after = loadCloudConfig(code);
  return !after || (!after.dirty && !after.pendingCreate);
}

// ---------- Einrichten, Entsperren, Passwort ändern, Löschen ----------

/** Fehler „mit diesem Passwort keine Cloud-Sicherung“ beim Entsperren. */
export class CloudNotFoundError extends Error {
  constructor() {
    super('Mit diesem Passwort gibt es keine Cloud-Sicherung.');
    this.name = 'CloudNotFoundError';
  }
}

/** Fehler „bisheriges Passwort falsch“ (Passwort ändern, Sicherung löschen). */
export class WrongPasswordError extends Error {
  constructor() {
    super('Das Passwort ist falsch.');
    this.name = 'WrongPasswordError';
  }
}

/**
 * Richtet eine neue Cloud-Sicherung mit dem Passwort ein und lädt den Stand dieses Geräts hoch (ohne Verbindung
 * später). Gibt es mit diesem Passwort schon eine, werden die beiden Stände abgeglichen.
 * @returns {Promise<object>} Zustand danach (wie getCloudStatus)
 */
export async function setupCloud(teacher, password, { remember = true } = {}) {
  const code = teacher.teacherCode;
  const keys = { ...(await deriveCloudKeys(password, teacher)), device: newDeviceSecret() };
  const pendingAdminHash = await hashOf(keys.adminToken);
  return exclusive(async () => {
    saveCloudConfig(code, { syncId: keys.syncId, version: 0, dirty: true, syncedHash: '', pendingCreate: true, pendingAdminHash, syncedAt: '', remember });
    saveKeys(code, keys, remember);
    if (code === active) problem = null;
    await syncRounds(code, { pull: false, keepalive: false });
    return getCloudStatus(code);
  });
}

/**
 * Prüft das Passwort, trägt dieses Gerät ein und holt den Stand aus der Cloud – ohne ihn schon zu übernehmen
 * (siehe adoptCloud). Wirft CloudNotFoundError (kein Treffer: falsches Passwort oder keine Sicherung),
 * MailboxError 429 (zu viele Versuche) oder ohne Verbindung.
 */
export async function unlockCloud(teacher, password) {
  const keys = { ...(await deriveCloudKeys(password, teacher)), device: newDeviceSecret() };
  const rec = await openCloudRecord(keys, keys.device);
  if (!rec.found) throw new CloudNotFoundError();
  const remote = unpackCloudData(await decryptCloudData(keys, rec));
  return { keys, version: rec.version, updatedAt: rec.updatedAt, remote };
}

/**
 * Welcher Stand gilt nach dem Entsperren?
 * 'remote': der aus der Cloud, 'local': der dieses Geräts, 'ask': beide verschieden – die Lehrkraft entscheidet.
 */
export function unlockDecision(code, unlocked) {
  const local = loadTeacherState(code);
  const remote = unlocked.remote.state;
  if (isEmptyTeacherState(local) || sameContent(local, remote)) return 'remote';
  if (isEmptyTeacherState(remote)) return 'local';
  const cfg = loadCloudConfig(code);
  if (cfg && cfg.syncId === unlocked.keys.syncId && cfg.version > 0 && !cfg.pendingCreate) {
    if (unlocked.version === cfg.version) return cfg.dirty ? 'local' : 'remote';
    if (unlocked.version > cfg.version) return cfg.dirty ? 'ask' : 'remote';
  }
  return 'ask';
}

/**
 * Verbindet dieses Gerät mit der entsperrten Cloud-Sicherung.
 * @param {'remote'|'local'} choice – remote: Stand aus der Cloud übernehmen; local: Stand dieses Geräts behalten
 *   (er wird hochgeladen und ersetzt den in der Cloud)
 */
export function adoptCloud(teacher, unlocked, choice, { remember = true } = {}) {
  const code = teacher.teacherCode;
  return exclusive(async () => {
    const remoteHash = contentHash(unlocked.remote.state);
    saveCloudConfig(code, { syncId: unlocked.keys.syncId, version: unlocked.version, dirty: choice === 'local', syncedHash: remoteHash, pendingCreate: false, syncedAt: new Date().toISOString(), remember });
    saveKeys(code, unlocked.keys, remember);
    if (code === active) problem = null;
    if (choice === 'remote') applyRemote(code, unlocked.remote, { version: unlocked.version, updatedAt: unlocked.updatedAt }, 'unlock');
    else await syncRounds(code, { pull: false, keepalive: false });
    emitStatus();
    return getCloudStatus(code);
  });
}

/** Leitet die Werte aus dem Passwort ab und prüft sie gegen die Zugangsdaten dieses Geräts. */
async function verifyPassword(code, teacher, password) {
  const keys = loadKeys(code);
  if (!keys) throw new Error('Die Cloud-Sicherung ist auf diesem Gerät nicht verbunden.');
  const derived = await deriveCloudKeys(password, teacher);
  if (derived.syncId !== keys.syncId || derived.authToken !== keys.authToken) throw new WrongPasswordError();
  return { keys, derived };
}

/**
 * Neues Passwort: Der Stand wird unter dem neuen Passwort als neue Sicherung abgelegt, die bisherige gelöscht.
 * Andere Geräte fragen danach einmal nach dem neuen Passwort.
 * @returns {Promise<{oldLeft: boolean}>} oldLeft: die bisherige Sicherung konnte nicht gelöscht werden
 */
export async function changeCloudPassword(teacher, currentPassword, newPassword) {
  const code = teacher.teacherCode;
  const { keys, derived: old } = await verifyPassword(code, teacher, currentPassword);
  const fresh = { ...(await deriveCloudKeys(newPassword, teacher)), device: newDeviceSecret() };
  if (fresh.syncId === old.syncId) throw new Error('Das neue Passwort ist dasselbe wie das bisherige.');
  const adminHash = await hashOf(fresh.adminToken);
  return exclusive(async () => {
    const cfg = loadCloudConfig(code);
    if (!cfg || cfg.pendingCreate) throw new Error('Ihr Stand ist noch nicht in der Cloud gesichert. Bitte versuchen Sie es gleich noch einmal.');
    const sealed = await sealCurrent(code, fresh);
    if (!sealed) throw new Error('In diesem Browser ist kein Stand gespeichert.');
    let res;
    try {
      res = await createCloudRecord(fresh, sealed.data, adminHash);
    } catch (err) {
      if (err instanceof MailboxError && err.status === 409) throw new Error('Mit diesem Passwort gibt es bereits eine andere Cloud-Sicherung. Bitte wählen Sie ein anderes Passwort.');
      throw err;
    }
    saveCloudConfig(code, { syncId: fresh.syncId, version: res.version, dirty: false, syncedHash: sealed.hash, pendingCreate: false, syncedAt: new Date().toISOString(), remember: cfg.remember });
    saveKeys(code, fresh, cfg.remember);
    markSynced(code, res.version, sealed.hash);
    let oldLeft = false;
    try {
      await deleteCloudRecord(keys, old.adminToken);
    } catch (err) {
      // Die alte Sicherung wird nach 400 Tagen ohne Nutzung ohnehin gelöscht.
      console.warn(err);
      oldLeft = true;
    }
    if (code === active) problem = null;
    emitStatus();
    return { oldLeft };
  });
}

/** Löscht die Cloud-Sicherung beim Dienst (Passwort nötig) und auf diesem Gerät. Der Stand in diesem Browser bleibt. */
export async function deleteCloud(teacher, password) {
  const code = teacher.teacherCode;
  const { keys, derived } = await verifyPassword(code, teacher, password);
  return exclusive(async () => {
    await deleteCloudRecord(keys, derived.adminToken);
    forgetCloudOnDevice(code);
    emitStatus();
    return true;
  });
}
