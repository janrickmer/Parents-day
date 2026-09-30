// Abgleich mit der Cloud-Sicherung (Verschlüsselung und Dienst: core/cloud.js). Läuft im Hintergrund,
// solange eine Lehrkraft angemeldet ist:
//  • Nach jeder Änderung wird der Stand nach kurzer Pause hochgeladen (spätestens nach 10 Sekunden).
//  • Beim Anmelden, beim Zurückkehren auf die Seite und alle 3 Minuten wird geprüft, ob ein anderes Gerät
//    einen neueren Stand gesichert hat – der wird dann übernommen.
//  • Haben beide Seiten geändert (z. B. war ein Gerät offline), entscheidet die Lehrkraft (Konflikt-Dialog).
//  • Ohne Verbindung wird das Hochladen automatisch nachgeholt.
//
// Auf dem Gerät gespeichert, je Lehrkraft (Lehrkräftecode):
//   localStorage  parentsday.cloud.<Code>     { v:1, syncId, salt, iterations, version, dirty, changeSeq,
//                                               pendingCreate, syncedAt, remember }
//                 version: Stand der Cloud, auf dem der Stand dieses Geräts beruht; dirty: seither geändert;
//                 pendingCreate: Sicherung noch nicht angelegt (z. B. bei der Registrierung ohne Verbindung)
//   parentsday.cloudKey.<Code>  { encKey, authToken } – im localStorage, wenn das Passwort auf diesem Gerät
//                 gemerkt werden soll, sonst nur im sessionStorage (bis zum Abmelden bzw. Schließen des Tabs)

import { getSession, loadTeacherState, replaceState, onStateChange, loadEventDraft, storeEventDraft, isEmptyTeacherState } from './storage.js';
import {
  cloudEnabled,
  syncIdFor,
  newSalt,
  deriveCloudKeys,
  authHashOf,
  isValidCloudKeys,
  encryptCloudData,
  decryptCloudData,
  packCloudData,
  unpackCloudData,
  fetchCloudInfo,
  fetchCloudRecord,
  saveCloudRecord,
  resetCloudRecord,
  deleteCloudRecord,
  cloudErrorMessage,
  PBKDF2_ITERATIONS,
} from './cloud.js';
import { MailboxError } from './mailbox.js';

const CONFIG_PREFIX = 'parentsday.cloud.';
const KEY_PREFIX = 'parentsday.cloudKey.';
const PUSH_DELAY_MS = 2000;
const PUSH_MAX_WAIT_MS = 10000;
const PULL_INTERVAL_MS = 3 * 60 * 1000;
const PULL_ON_FOCUS_MS = 30 * 1000;
const RETRY_MS = [15000, 30000, 60000, 120000, 300000];
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;
const KEEPALIVE_MAX_CHARS = 60000; // Browser erlauben mit keepalive höchstens 64 KB

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
  if (!cfg || cfg.v !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(String(cfg.syncId || ''))) return null;
  return {
    ...cfg,
    version: Number.isInteger(cfg.version) && cfg.version >= 0 ? cfg.version : 0,
    dirty: Boolean(cfg.dirty),
    changeSeq: Number.isInteger(cfg.changeSeq) ? cfg.changeSeq : 0,
    pendingCreate: Boolean(cfg.pendingCreate),
    syncedAt: typeof cfg.syncedAt === 'string' ? cfg.syncedAt : '',
    remember: cfg.remember !== false,
  };
}

function saveCloudConfig(code, cfg) {
  writeJson(localStorage, CONFIG_PREFIX + code, { ...cfg, v: 1 });
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
  return isValidCloudKeys(keys) ? { encKey: keys.encKey, authToken: keys.authToken } : null;
}

function saveKeys(code, keys, remember) {
  forgetKeys(code);
  const data = { encKey: keys.encKey, authToken: keys.authToken };
  if (!(remember && writeJson(localStorage, KEY_PREFIX + code, data))) writeJson(sessionStorage, KEY_PREFIX + code, data);
}

function forgetKeys(code) {
  removeKey(localStorage, KEY_PREFIX + code);
  removeKey(sessionStorage, KEY_PREFIX + code);
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

/** Kennt dieses Gerät (bzw. dieser Tab) das Passwort der Cloud-Sicherung? */
export function hasCloudKeys(code) {
  return Boolean(loadKeys(code));
}

/**
 * Es gibt eine Cloud-Sicherung, die Lehrkraft hat das Passwort aber (noch) nicht eingegeben: Änderungen werden
 * vermerkt, die Kopfzeile bietet „Passwort eingeben“ an.
 */
export function rememberLockedCloud(code, info) {
  if (loadCloudConfig(code)?.syncId === info.syncId) return;
  saveCloudConfig(code, { syncId: info.syncId, salt: info.salt, iterations: info.iterations, version: 0, dirty: false, changeSeq: 0, pendingCreate: false, syncedAt: '', remember: true });
  forgetKeys(code);
  emitStatus();
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
 *       'locked' (zu viele Fehlversuche), 'conflict', 'error'
 * @returns {{kind:string, message?:string, syncedAt?:string, remember?:boolean}}
 */
export function getCloudStatus(code = active || getSession()) {
  if (!cloudEnabled()) return { kind: 'disabled' };
  if (!code) return { kind: 'off' };
  const cfg = loadCloudConfig(code);
  const own = code === active ? problem : null;
  if (!cfg) return { kind: 'not-setup', message: own?.kind === 'deleted' ? own.message : '' };
  const base = { syncedAt: cfg.syncedAt, remember: cfg.remember };
  if (!loadKeys(code)) return { ...base, kind: 'needs-password', message: own?.kind === 'needs-password' ? own.message : '' };
  if (code === active && syncing) return { ...base, kind: 'syncing' };
  if (own && own.kind !== 'deleted' && own.kind !== 'needs-password') return { ...base, ...own };
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

/** Inhalt eines Stands ohne Speicherzeitpunkte (für „gleicher Stand?“). */
function contentKey(state) {
  if (!state) return '';
  const mailbox = state.mailbox ? { ...state.mailbox, lastFetchedAt: undefined } : null;
  return JSON.stringify({ ...state, savedAt: undefined, mailbox });
}

export function sameContent(a, b) {
  return contentKey(a) === contentKey(b);
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
onStateChange((state) => {
  if (applyingRemote) return;
  const code = state?.teacher?.teacherCode;
  if (!code) return;
  const cfg = updateConfig(code, (c) => {
    c.dirty = true;
    c.changeSeq += 1;
  });
  if (cfg && code === active) {
    schedulePush();
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
    if (!code) return getCloudStatus();
    let rounds = 0;
    do {
      again = false;
      await syncOnce(code, job);
    } while (again && active === code && ++rounds < 4);
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
    else if (cfg.dirty) await push(code, cfg, keys, keepalive);
    else if (pull) await pullRemote(code, cfg, keys);
    if (!problem || !['deleted', 'needs-password', 'conflict'].includes(problem.kind)) {
      problem = null;
      retryIndex = 0;
      clearTimeout(retryTimer);
    }
  } catch (err) {
    await handleError(code, err);
  } finally {
    syncing = false;
    emitStatus();
  }
}

function markSynced(code, version, seq) {
  const cfg = updateConfig(code, (c) => {
    c.version = version;
    c.pendingCreate = false;
    c.dirty = c.changeSeq !== seq;
    c.syncedAt = new Date().toISOString();
  });
  // Während des Hochladens geändert: gleich noch einmal
  if (cfg?.dirty && code === active) schedulePush();
}

async function encryptCurrent(code, cfg, keys) {
  const state = loadTeacherState(code);
  if (!state) return null;
  return encryptCloudData(keys, cfg.syncId, packCloudData(state, loadEventDraft(state)));
}

async function create(code, cfg, keys) {
  const seq = cfg.changeSeq;
  const data = await encryptCurrent(code, cfg, keys);
  if (!data) return;
  try {
    const res = await saveCloudRecord(cfg.syncId, keys.authToken, { baseVersion: 0, ...data, salt: cfg.salt, iterations: cfg.iterations, authHash: await authHashOf(keys.authToken) });
    markSynced(code, res.version, seq);
  } catch (err) {
    if (!(err instanceof MailboxError) || err.status !== 409) throw err;
    // Inzwischen gibt es schon eine Sicherung (z. B. auf einem anderen Gerät eingerichtet): Mit demselben
    // Passwort passt das Token nicht (anderes Salt) – dann fragt ParentsDay nach dem Passwort.
    const latest = updateConfig(code, (c) => {
      c.pendingCreate = false;
      c.version = 0;
    });
    await pullRemote(code, latest, keys);
  }
}

async function push(code, cfg, keys, keepalive) {
  const seq = cfg.changeSeq;
  const data = await encryptCurrent(code, cfg, keys);
  if (!data) return;
  try {
    const res = await saveCloudRecord(cfg.syncId, keys.authToken, { baseVersion: cfg.version, ...data }, { keepalive: keepalive && data.ct.length < KEEPALIVE_MAX_CHARS });
    markSynced(code, res.version, seq);
  } catch (err) {
    if (err instanceof MailboxError && err.status === 409) {
      if (err.data?.found === false) return handleDeleted(code);
      return resolveConflict(code, keys);
    }
    throw err;
  }
}

async function fetchRemote(cfg, keys, since) {
  const rec = await fetchCloudRecord(cfg.syncId, keys.authToken, { since });
  if (!rec.found || rec.unchanged) return { rec, remote: null };
  return { rec, remote: unpackCloudData(await decryptCloudData(keys, cfg.syncId, rec)) };
}

async function pullRemote(code, cfg, keys) {
  lastPullAt = Date.now();
  const { rec, remote } = await fetchRemote(cfg, keys, cfg.version);
  if (!rec.found) return handleDeleted(code);
  if (rec.unchanged) {
    updateConfig(code, (c) => (c.syncedAt = new Date().toISOString()));
    return;
  }
  // Während des Abrufs hier geändert? Dann haben beide Seiten Neues.
  const latest = loadCloudConfig(code);
  if (latest?.dirty) return resolveConflict(code, keys, { rec, remote });
  applyRemote(code, remote, rec);
}

async function resolveConflict(code, keys, fetched = null) {
  const cfg = loadCloudConfig(code);
  if (!cfg) return;
  const { rec, remote } = fetched || (await fetchRemote(cfg, keys));
  if (!rec.found) return handleDeleted(code);
  const local = loadTeacherState(code);
  if (!local || sameContent(local, remote.state)) {
    if (local) markSynced(code, rec.version, cfg.changeSeq);
    else applyRemote(code, remote, rec);
    return;
  }
  if (!conflictResolver) {
    problem = { kind: 'conflict', message: 'Ihr Stand wurde auf einem anderen Gerät geändert, während hier noch nicht gesicherte Änderungen vorlagen.' };
    return;
  }
  problem = { kind: 'conflict', message: '' };
  syncing = false;
  emitStatus();
  const choice = await conflictResolver({ local: { state: local }, remote, remoteUpdatedAt: rec.updatedAt });
  problem = null;
  if (active !== code) return;
  if (choice === 'remote') {
    applyRemote(code, remote, rec);
  } else {
    // Stand dieses Geräts behalten: er ersetzt den in der Cloud (nächste Runde lädt hoch).
    updateConfig(code, (c) => {
      c.version = rec.version;
      c.dirty = true;
    });
    again = true;
  }
}

function applyRemote(code, remote, rec, source = 'sync') {
  const current = loadTeacherState(code);
  const next = remote.state;
  // Namen und Codes der angemeldeten Lehrkraft behalten – so bleibt der Stand unter ihrem Lehrkräftecode.
  if (current) for (const key of ['firstName', 'lastName', 'birthDate', 'registrationCode', 'teacherCode']) next.teacher[key] = current.teacher[key];
  next.teacher.teacherCode = code;
  let saved;
  applyingRemote = true;
  try {
    saved = replaceState(next, { keepSavedAt: true });
    if (remote.eventDraft) storeEventDraft(saved, remote.eventDraft);
  } finally {
    applyingRemote = false;
  }
  const cfg = loadCloudConfig(code);
  markSynced(code, rec.version, cfg ? cfg.changeSeq : 0);
  for (const fn of remoteListeners) {
    try {
      fn({ state: saved, updatedAt: rec.updatedAt, source });
    } catch (err) {
      console.error(err);
    }
  }
}

function handleDeleted(code) {
  forgetCloudOnDevice(code);
  if (code === active) problem = { kind: 'deleted', message: 'Ihre Cloud-Sicherung wurde gelöscht (z. B. auf einem anderen Gerät). Sie können sie unter „Weitere Einstellungen“ neu einrichten.' };
}

/** Token abgelehnt: Wurde das Passwort auf einem anderen Gerät geändert oder die Sicherung gelöscht? */
async function handleForbidden(code) {
  const cfg = loadCloudConfig(code);
  if (!cfg) return;
  let info;
  try {
    info = await fetchCloudInfo(cfg.syncId);
  } catch {
    problem = { kind: 'offline', message: 'Keine Verbindung zur Cloud-Sicherung – wird automatisch nachgeholt.' };
    scheduleRetry();
    return;
  }
  if (!info.found) return handleDeleted(code);
  // Das alte Token nicht weiter verwenden: jeder Versuch zählte sonst als falsches Passwort.
  forgetKeys(code);
  updateConfig(code, (c) => (c.pendingCreate = false));
  problem = {
    kind: 'needs-password',
    message:
      info.salt !== cfg.salt
        ? 'Das Passwort Ihrer Cloud-Sicherung wurde auf einem anderen Gerät geändert oder neu festgelegt. Bitte geben Sie das aktuelle Passwort ein.'
        : 'Bitte geben Sie Ihr Passwort für die Cloud-Sicherung erneut ein.',
  };
}

async function handleError(code, err) {
  if (err instanceof MailboxError) {
    if (err.status === 403) return handleForbidden(code);
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
 * Vor dem Abmelden: noch nicht hochgeladene Änderungen sofort sichern (höchstens `timeout` ms warten).
 * @returns {Promise<boolean>} true, wenn nichts mehr offen ist (oder keine Cloud-Sicherung eingerichtet ist)
 */
export async function flushCloudSync({ timeout = 8000 } = {}) {
  const code = active;
  if (!code) return true;
  const cfg = loadCloudConfig(code);
  if (!cfg) return true;
  if (!cfg.dirty && !cfg.pendingCreate) return true;
  if (!loadKeys(code)) return false;
  clearTimeout(pushTimer);
  firstPendingAt = 0;
  let timer = 0;
  await Promise.race([syncCloudNow({ pull: false }), new Promise((r) => (timer = setTimeout(r, timeout)))]);
  clearTimeout(timer);
  const after = loadCloudConfig(code);
  return !after || (!after.dirty && !after.pendingCreate);
}

// ---------- Einrichten, Entsperren, Passwort ändern, Löschen ----------

/**
 * Gibt es für die Lehrkraft eine Cloud-Sicherung? Wirft ohne Verbindung (MailboxError, offline)
 * bzw. mit status 404, wenn der Dienst noch keine Cloud-Sicherung kennt.
 * @returns {Promise<{syncId:string, found:boolean, salt?:string, iterations?:number}>}
 */
export async function lookupCloud(teacher) {
  const syncId = await syncIdFor(teacher);
  return { syncId, ...(await fetchCloudInfo(syncId)) };
}

/**
 * Richtet die Cloud-Sicherung mit einem neuen Passwort ein. Der Stand der Lehrkraft muss in diesem Browser
 * gespeichert sein. Hochgeladen wird sofort – ohne Verbindung holt der Abgleich das später nach.
 * @returns {Promise<object>} Zustand danach (wie getCloudStatus)
 */
export async function setupCloud(teacher, password, { remember = true } = {}) {
  const code = teacher.teacherCode;
  const syncId = await syncIdFor(teacher);
  const salt = newSalt();
  const keys = await deriveCloudKeys(password, salt, PBKDF2_ITERATIONS);
  return exclusive(async () => {
    saveCloudConfig(code, { syncId, salt, iterations: PBKDF2_ITERATIONS, version: 0, dirty: true, changeSeq: 1, pendingCreate: true, syncedAt: '', remember });
    saveKeys(code, keys, remember);
    if (code === active) problem = null;
    await syncOnce(code, { pull: false, keepalive: false });
    return getCloudStatus(code);
  });
}

/** Fehler „keine Cloud-Sicherung vorhanden“ beim Entsperren. */
export class CloudNotFoundError extends Error {
  constructor() {
    super('Für Sie gibt es keine Cloud-Sicherung (mehr).');
    this.name = 'CloudNotFoundError';
  }
}

/**
 * Prüft das Passwort und holt den Stand aus der Cloud – ohne ihn schon zu übernehmen (siehe adoptCloud).
 * Wirft bei falschem Passwort (MailboxError, status 403), zu vielen Versuchen (429) oder ohne Verbindung.
 */
export async function unlockCloud(teacher, password) {
  const syncId = await syncIdFor(teacher);
  const info = await fetchCloudInfo(syncId);
  if (!info.found) throw new CloudNotFoundError();
  const keys = await deriveCloudKeys(password, info.salt, info.iterations);
  const rec = await fetchCloudRecord(syncId, keys.authToken);
  if (!rec.found) throw new CloudNotFoundError();
  const remote = unpackCloudData(await decryptCloudData(keys, syncId, rec));
  return { syncId, salt: info.salt, iterations: info.iterations, keys, version: rec.version, updatedAt: rec.updatedAt, remote };
}

/**
 * Welcher Stand gilt nach dem Entsperren?
 * 'remote': der aus der Cloud, 'local': der dieses Geräts (er ist nur weiter), 'ask': beide geändert – die Lehrkraft entscheidet.
 */
export function unlockDecision(code, unlocked) {
  const local = loadTeacherState(code);
  if (isEmptyTeacherState(local) || sameContent(local, unlocked.remote.state)) return 'remote';
  const cfg = loadCloudConfig(code);
  if (cfg && cfg.syncId === unlocked.syncId && cfg.version > 0 && !cfg.pendingCreate) {
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
    saveCloudConfig(code, {
      syncId: unlocked.syncId,
      salt: unlocked.salt,
      iterations: unlocked.iterations,
      version: unlocked.version,
      dirty: choice === 'local',
      changeSeq: 0,
      pendingCreate: false,
      syncedAt: new Date().toISOString(),
      remember,
    });
    saveKeys(code, unlocked.keys, remember);
    if (code === active) problem = null;
    if (choice === 'remote') {
      if (!loadTeacherState(code)) unlocked.remote.state.teacher.teacherCode = code;
      applyRemote(code, unlocked.remote, { version: unlocked.version, updatedAt: unlocked.updatedAt }, 'unlock');
    } else {
      await syncOnce(code, { pull: false, keepalive: false });
    }
    emitStatus();
    return getCloudStatus(code);
  });
}

/**
 * „Passwort vergessen“: Die alte Sicherung ist ohne Passwort nicht lesbar. Sie wird durch eine neue mit dem
 * neuen Passwort und dem Stand dieses Geräts ersetzt. Braucht eine Verbindung.
 */
export async function resetCloud(teacher, password, { remember = true } = {}) {
  const code = teacher.teacherCode;
  const syncId = await syncIdFor(teacher);
  const salt = newSalt();
  const keys = await deriveCloudKeys(password, salt, PBKDF2_ITERATIONS);
  return exclusive(async () => {
    const state = loadTeacherState(code);
    if (!state) throw new Error('In diesem Browser ist noch kein Stand gespeichert.');
    const data = await encryptCloudData(keys, syncId, packCloudData(state, loadEventDraft(state)));
    const res = await resetCloudRecord(syncId, keys.authToken, { ...data, salt, iterations: PBKDF2_ITERATIONS, authHash: await authHashOf(keys.authToken) });
    saveCloudConfig(code, { syncId, salt, iterations: PBKDF2_ITERATIONS, version: res.version, dirty: false, changeSeq: 0, pendingCreate: false, syncedAt: new Date().toISOString(), remember });
    saveKeys(code, keys, remember);
    if (code === active) problem = null;
    emitStatus();
    return getCloudStatus(code);
  });
}

/**
 * Neues Passwort für die Cloud-Sicherung der angemeldeten Lehrkraft (dieses Gerät kennt das bisherige).
 * Andere Geräte fragen danach einmal nach dem neuen Passwort.
 */
export async function changeCloudPassword(password) {
  const code = active || getSession();
  const cfg = loadCloudConfig(code);
  const keys = loadKeys(code);
  if (!cfg || !keys) throw new Error('Die Cloud-Sicherung ist auf diesem Gerät nicht eingerichtet.');
  const salt = newSalt();
  const newKeys = await deriveCloudKeys(password, salt, PBKDF2_ITERATIONS);
  return exclusive(async () => {
    const latest = loadCloudConfig(code);
    if (!latest || latest.pendingCreate) throw new Error('Ihr Stand ist noch nicht in der Cloud gesichert. Bitte versuchen Sie es gleich noch einmal.');
    const seq = latest.changeSeq;
    const data = await encryptCurrent(code, latest, newKeys);
    let res;
    try {
      res = await saveCloudRecord(latest.syncId, keys.authToken, {
        baseVersion: latest.version,
        ...data,
        salt,
        iterations: PBKDF2_ITERATIONS,
        authHash: await authHashOf(newKeys.authToken),
      });
    } catch (err) {
      if (err instanceof MailboxError && err.status === 409) {
        setTimeout(() => syncCloudNow(), 0);
        throw new Error('Ihr Stand wurde gerade auf einem anderen Gerät geändert. Bitte versuchen Sie es gleich noch einmal.');
      }
      if (err instanceof MailboxError && err.status === 403) {
        await handleForbidden(code);
        emitStatus();
      }
      throw err;
    }
    updateConfig(code, (c) => {
      c.salt = salt;
      c.iterations = PBKDF2_ITERATIONS;
    });
    saveKeys(code, newKeys, latest.remember);
    markSynced(code, res.version, seq);
    if (code === active) problem = null;
    emitStatus();
    return getCloudStatus(code);
  });
}

/** Löscht die Cloud-Sicherung beim Dienst und auf diesem Gerät. Der Stand in diesem Browser bleibt. */
/**
 * @returns {Promise<boolean>} ob die Sicherung beim Dienst gelöscht wurde (ohne Passwort auf diesem Gerät geht
 *   das nicht – dann wird sie nur auf diesem Gerät vergessen)
 */
export async function deleteCloud(code = active || getSession()) {
  return exclusive(async () => {
    const cfg = loadCloudConfig(code);
    const keys = loadKeys(code);
    let deleted = false;
    if (cfg && keys && !cfg.pendingCreate) deleted = (await deleteCloudRecord(cfg.syncId, keys.authToken)) || true;
    else if (cfg?.pendingCreate) deleted = true; // noch nicht angelegt
    forgetCloudOnDevice(code);
    emitStatus();
    return deleted;
  });
}
