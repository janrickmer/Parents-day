// Abgleich mit der Cloud-Sicherung (Verschlüsselung und Dienst: core/cloud.js). Läuft im Hintergrund,
// solange eine Lehrkraft angemeldet ist:
//  • Nach jeder Änderung (auch an noch nicht gespeicherten Eingaben zum Elternsprechtag) wird der Stand nach
//    kurzer Pause hochgeladen (spätestens nach 10 Sekunden).
//  • Beim Anmelden, beim Zurückkehren auf die Seite und alle 3 Minuten wird geprüft, ob ein anderes Gerät
//    einen neueren Stand gesichert hat – der wird dann übernommen.
//  • Haben beide Seiten geändert (z. B. war ein Gerät offline), entscheidet die Lehrkraft (Konflikt-Dialog).
//    Ist eine Seite leer, gilt ohne Rückfrage die andere.
//  • Ohne Verbindung wird das Hochladen automatisch nachgeholt.
//
// Auf dem Gerät gespeichert, je Lehrkraft (Lehrkräftecode):
//   localStorage  parentsday.cloud.<Code>     { v:2, syncId, version, dirty, syncedHash, pendingCreate,
//                                               pendingAdminHash?, blockedUntil?, syncedAt, remember }
//                 version: Stand der Cloud, auf dem der Stand dieses Geräts beruht; syncedHash: Prüfsumme dieses
//                 Stands – weicht der Stand davon ab, ist er „dirty“ und wird hochgeladen; pendingCreate:
//                 Sicherung noch nicht angelegt (z. B. bei der Registrierung ohne Verbindung)
//   parentsday.cloudKey.<Code>  { syncId, who, encKey, authToken, device } – im localStorage, wenn das Passwort
//                 auf diesem Gerät gemerkt werden soll, sonst nur im sessionStorage (bis zum Abmelden bzw.
//                 Schließen des Tabs). Das Admin-Token zum Löschen wird nie gespeichert.
//   localStorage  parentsday.cloudDevice.<Code>  Geräte-Geheimnis dieses Browsers (allein ohne Wert; so bleibt
//                 der Browser beim Dienst dasselbe eingetragene Gerät, auch wenn das Passwort nicht gemerkt wird)

import {
  getSession,
  loadTeacherState,
  replaceState,
  onStateChange,
  onEventDraftStored,
  loadEventDraft,
  storeEventDraft,
  clearEventDraft,
  isEmptyTeacherState,
} from './storage.js';
import {
  cloudEnabled,
  deriveCloudKeys,
  newDeviceSecret,
  hashOf,
  isValidCloudKeys,
  encryptCloudData,
  decryptCloudData,
  packCloudData,
  packMovedNotice,
  unpackCloudData,
  openCloudRecord,
  fetchCloudRecord,
  createCloudRecord,
  saveCloudRecord,
  deleteCloudRecord,
  cloudErrorMessage,
  CloudMovedError,
} from './cloud.js';
import { MailboxError, isValidTeacherMailbox } from './mailbox.js';

const CONFIG_PREFIX = 'parentsday.cloud.';
const KEY_PREFIX = 'parentsday.cloudKey.';
const DEVICE_PREFIX = 'parentsday.cloudDevice.';
const PUSH_DELAY_MS = 2000;
const PUSH_MAX_WAIT_MS = 10000;
const PULL_INTERVAL_MS = 3 * 60 * 1000;
const PULL_ON_FOCUS_MS = 30 * 1000;
const RETRY_MS = [15000, 30000, 60000, 120000, 300000];
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;
const STORAGE_FULL_RETRY_MS = 60 * 60 * 1000;
const KEEPALIVE_MAX_CHARS = 60000; // Browser erlauben mit keepalive höchstens 64 KB

const NEEDS_PASSWORD =
  'Bitte geben Sie Ihr Passwort für die Cloud-Sicherung erneut ein. Vielleicht wurde es auf einem anderen Gerät geändert oder die Sicherung gelöscht.';
const MOVED =
  'Das Passwort Ihrer Cloud-Sicherung wurde auf einem anderen Gerät geändert. Bitte geben Sie das neue Passwort ein – Ihre Änderungen auf diesem Gerät bleiben erhalten.';

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
    blockedUntil: Number(cfg.blockedUntil) || 0,
    syncedAt: typeof cfg.syncedAt === 'string' ? cfg.syncedAt : '',
    remember: cfg.remember !== false,
  };
}

function saveCloudConfig(code, cfg) {
  writeJson(localStorage, CONFIG_PREFIX + code, { ...cfg, v: 2 });
}

/** Ändert die Einstellungen – nur, wenn sie noch zur Sicherung `syncId` gehören (sonst null). */
function updateConfig(code, fn, syncId = null) {
  const cfg = loadCloudConfig(code);
  if (!cfg || (syncId && cfg.syncId !== syncId)) return null;
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

/** Geräte-Geheimnis dieses Browsers für die Lehrkraft (wird bei Bedarf angelegt). */
function deviceSecret(code) {
  const stored = readJson(localStorage, DEVICE_PREFIX + code);
  if (typeof stored === 'string' && /^[A-Za-z0-9_-]{43}$/.test(stored)) return stored;
  const secret = newDeviceSecret();
  writeJson(localStorage, DEVICE_PREFIX + code, secret);
  return secret;
}

/** Kennt dieses Gerät (bzw. dieser Tab) das Passwort der Cloud-Sicherung? */
export function hasCloudKeys(code) {
  return Boolean(loadKeys(code));
}

/** Ist die Cloud-Sicherung auf diesem Gerät verbunden (eingerichtet und Passwort bekannt)? */
export function isCloudConnected(code) {
  return Boolean(loadCloudConfig(code) && loadKeys(code));
}

/**
 * Ist der Stand dieses Geräts vollständig in der Cloud? (verbunden, angelegt, keine offenen Änderungen)
 * Ohne Cloud-Sicherung false.
 */
export function isCloudUpToDate(code) {
  const cfg = loadCloudConfig(code);
  return Boolean(cfg && loadKeys(code) && !cfg.pendingCreate && !cfg.dirty && cfg.version > 0);
}

/** Entfernt alles zur Cloud-Sicherung von diesem Gerät. Die Sicherung selbst bleibt beim Dienst erhalten. */
export function forgetCloudOnDevice(code) {
  removeKey(localStorage, CONFIG_PREFIX + code);
  removeKey(localStorage, DEVICE_PREFIX + code);
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
 * Entscheidung bei einem Konflikt (beide Seiten verschieden). Die Funktion erhält
 * { local: {state}, remote: {state, eventDraft}, remoteUpdatedAt, noBase } und gibt 'local' oder 'remote' zurück.
 * noBase: Dieses Gerät hatte noch nie einen gemeinsamen Stand mit der Sicherung (z. B. gerade eingerichtet).
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

/**
 * Prüfsumme von Stand und Entwurf (zwei 32-Bit-FNV-Varianten) – zum Erkennen, ob sich seit dem Abgleich etwas
 * geändert hat. Ohne Angabe gilt der Entwurf, der zu diesem Stand gespeichert ist.
 */
function contentHash(state, draft = state ? loadEventDraft(state) : null) {
  const text = `${contentKey(state)}|${JSON.stringify(draft || null)}`;
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

/** Änderung am Stand oder am Entwurf: vermerken und (verzögert) hochladen. Ohne inhaltliche Änderung nichts. */
function noteLocalChange(code) {
  if (applyingRemote || !code) return;
  const cfg = loadCloudConfig(code);
  if (!cfg) return;
  const dirty = contentHash(loadTeacherState(code)) !== cfg.syncedHash;
  if (dirty === cfg.dirty) {
    if (dirty && code === active) schedulePush();
    return;
  }
  updateConfig(code, (c) => (c.dirty = dirty));
  if (code === active) {
    if (dirty) schedulePush();
    emitStatus();
  }
}

onStateChange((state) => noteLocalChange(state?.teacher?.teacherCode));
onEventDraftStored((state) => noteLocalChange(state?.teacher?.teacherCode));

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
  // Anlegen wurde abgewiesen (zu viele Versuche, Speicher voll): bis dahin nicht erneut versuchen.
  if (cfg.pendingCreate && cfg.blockedUntil > Date.now()) return;
  syncing = true;
  emitStatus();
  try {
    if (cfg.pendingCreate) await create(code, cfg, keys);
    // Noch kein gemeinsamer Stand (Anlegen traf auf eine vorhandene Sicherung): erst abgleichen
    else if (cfg.version === 0) await resolveConflict(code, keys, null, { noBase: true });
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
function markSynced(code, syncId, version, hash) {
  const local = loadTeacherState(code);
  const cfg = updateConfig(
    code,
    (c) => {
      c.version = version;
      c.pendingCreate = false;
      delete c.pendingAdminHash;
      delete c.blockedUntil;
      c.syncedHash = hash;
      c.dirty = Boolean(local) && contentHash(local) !== hash;
      c.syncedAt = new Date().toISOString();
    },
    syncId,
  );
  if (cfg?.dirty && code === active) schedulePush();
}

/** Aktueller Stand (samt Entwurf), verschlüsselt für die Version `version`, samt Prüfsumme. */
async function sealCurrent(code, keys, version) {
  const state = loadTeacherState(code);
  if (!state) return null;
  const draft = loadEventDraft(state);
  const data = await encryptCloudData(keys, packCloudData(state, draft), version);
  return { data, hash: contentHash(state, draft) };
}

async function create(code, cfg, keys) {
  const sealed = await sealCurrent(code, keys, 1);
  if (!sealed) return;
  try {
    const res = await createCloudRecord(keys, sealed.data, cfg.pendingAdminHash);
    markSynced(code, keys.syncId, res.version, sealed.hash);
    await touch(keys);
  } catch (err) {
    if (!(err instanceof MailboxError)) throw err;
    if (err.status === 429 || err.status === 507) {
      const wait = err.status === 507 ? STORAGE_FULL_RETRY_MS : Math.max(60, Number(err.data?.retryAfter) || 60) * 1000;
      updateConfig(code, (c) => (c.blockedUntil = Date.now() + wait), keys.syncId);
      throw err;
    }
    if (err.status !== 409) throw err;
    // Mit diesem Passwort gibt es schon eine Sicherung (z. B. auf einem anderen Gerät eingerichtet):
    // öffnen, das Gerät eintragen und die beiden Stände abgleichen.
    const rec = await openCloudRecord(keys, keys.device);
    if (!rec.found) throw err;
    updateConfig(
      code,
      (c) => {
        c.pendingCreate = false;
        delete c.pendingAdminHash;
        c.version = 0;
      },
      keys.syncId,
    );
    await resolveConflict(code, keys, { rec, remote: unpackCloudData(await decryptCloudData(keys, rec)) }, { noBase: true });
  }
}

/** Erster Abruf nach dem Anlegen: Die Sicherung gilt damit als genutzt (sonst würde sie nach 30 Tagen gelöscht). */
async function touch(keys) {
  try {
    await fetchCloudRecord(keys, { since: 1 });
  } catch {
    // holt der nächste Abgleich nach
  }
}

async function push(code, cfg, keys, keepalive) {
  const sealed = await sealCurrent(code, keys, cfg.version + 1);
  if (!sealed) return;
  try {
    const res = await saveCloudRecord(keys, cfg.version, sealed.data, { keepalive: keepalive && sealed.data.ct.length < KEEPALIVE_MAX_CHARS });
    markSynced(code, keys.syncId, res.version, sealed.hash);
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
  // Inzwischen abgemeldet, Cloud-Sicherung entfernt oder ein anderer Tab schon weiter? Dann nichts übernehmen.
  if (code !== active || !latest || latest.syncId !== cfg.syncId || latest.version !== cfg.version) return;
  if (!rec.found) return;
  if (rec.unchanged) {
    updateConfig(code, (c) => (c.syncedAt = new Date().toISOString()), cfg.syncId);
    return;
  }
  if (rec.version < cfg.version) {
    // Der Dienst hat eine ältere Version als dieses Gerät (z. B. Datenbank wiederhergestellt oder die Sicherung
    // gelöscht und mit demselben Passwort neu eingerichtet): kein gemeinsamer Stand – gleich ist gut, sonst
    // entscheidet die Lehrkraft.
    return resolveConflict(code, keys, { rec, remote }, { noBase: true });
  }
  // Während des Abrufs hier geändert? Dann haben beide Seiten Neues.
  if (latest.dirty) return resolveConflict(code, keys, { rec, remote });
  applyRemote(code, keys.syncId, remote, rec);
}

async function resolveConflict(code, keys, fetched = null, { noBase = false } = {}) {
  const { rec, remote } = fetched || (await fetchRemote(keys));
  if (code !== active || loadCloudConfig(code)?.syncId !== keys.syncId || !rec.found || !remote) return;
  const local = loadTeacherState(code);
  if (!local || isEmptyTeacherState(local)) return applyRemote(code, keys.syncId, remote, rec);
  if (sameContent(local, remote.state)) return markSynced(code, keys.syncId, rec.version, contentHash(remote.state, remote.eventDraft));
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
    choice = await conflictResolver({ local: { state: local }, remote, remoteUpdatedAt: rec.updatedAt, noBase });
    problem = null;
    if (active !== code || loadCloudConfig(code)?.syncId !== keys.syncId) return;
  }
  if (choice === 'remote') {
    applyRemote(code, keys.syncId, remote, rec);
    return;
  }
  // Stand dieses Geräts behalten: er ersetzt den in der Cloud (nächste Runde lädt hoch).
  updateConfig(
    code,
    (c) => {
      c.version = rec.version;
      c.syncedHash = contentHash(remote.state, remote.eventDraft);
      c.dirty = true;
    },
    keys.syncId,
  );
  again = true;
  schedulePush();
}

function applyRemote(code, syncId, remote, rec, source = 'sync') {
  const current = loadTeacherState(code);
  const next = remote.state;
  // Gespeichert wird unter dem Lehrkräftecode der angemeldeten Lehrkraft (bei gleichem Namen und Geburtsdatum derselbe).
  next.teacher.teacherCode = code;
  // Prüfsumme des Stands aus der Cloud – vor Ergänzungen, die es nur auf diesem Gerät gibt (die werden dann hochgeladen).
  const hash = contentHash(next, remote.eventDraft);
  // Kein Briefkasten in der Cloud, aber auf diesem Gerät: behalten – sonst wären die Rückmeldungen darin nicht mehr lesbar.
  if (!next.mailbox && isValidTeacherMailbox(current?.mailbox)) next.mailbox = current.mailbox;
  let saved;
  applyingRemote = true;
  try {
    saved = replaceState(next, { keepSavedAt: true });
    // Entwurf wie in der Cloud – auch keiner (sonst käme ein anderswo verworfener Entwurf zurück).
    if (remote.eventDraft) storeEventDraft(saved, remote.eventDraft);
    else clearEventDraft(saved);
  } finally {
    applyingRemote = false;
  }
  markSynced(code, syncId, rec.version, hash);
  for (const fn of remoteListeners) {
    try {
      fn({ state: saved, updatedAt: rec.updatedAt, source });
    } catch (err) {
      console.error(err);
    }
  }
}

/**
 * Dieses Gerät hat keinen Zugang mehr (403: Passwort geändert, Sicherung gelöscht oder Gerät ausgetragen; bzw.
 * Hinweis „umgezogen“). Die Schlüssel werden vergessen – die Einstellungen bleiben (Anzeige „Passwort nötig“).
 */
function handleForbidden(code, rejected, message = NEEDS_PASSWORD) {
  const current = loadKeys(code);
  // Inzwischen neue Schlüssel (z. B. Passwort in einem anderen Tab geändert): mit denen weiter.
  if (current && rejected && current.authToken !== rejected.authToken) {
    again = true;
    return;
  }
  forgetKeys(code);
  updateConfig(code, (c) => {
    c.pendingCreate = false;
    delete c.pendingAdminHash;
  });
  problem = { kind: 'needs-password', message };
}

async function handleError(code, keys, err) {
  if (err instanceof CloudMovedError) return handleForbidden(code, keys, MOVED);
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
    if (err.status === 507) {
      problem = { kind: 'error', message: cloudErrorMessage(err) };
      scheduleRetry(STORAGE_FULL_RETRY_MS);
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
 * Noch nicht hochgeladene Änderungen sofort sichern und einen laufenden Abgleich abwarten (höchstens `timeout` ms),
 * z. B. vor dem Abmelden.
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
  constructor(moved = false) {
    super(moved ? 'Das Passwort dieser Cloud-Sicherung wurde geändert.' : 'Mit diesem Passwort gibt es keine Cloud-Sicherung.');
    this.name = 'CloudNotFoundError';
    /** true: Mit diesem (alten) Passwort gibt es nur noch den Hinweis „umgezogen“. */
    this.moved = moved;
  }
}

/** Fehler „bisheriges Passwort falsch“ (Passwort ändern, Sicherung löschen). */
export class WrongPasswordError extends Error {
  constructor() {
    super('Das Passwort ist falsch.');
    this.name = 'WrongPasswordError';
  }
}

async function keysFor(code, teacher, password) {
  return { ...(await deriveCloudKeys(password, teacher)), device: deviceSecret(code) };
}

/**
 * Richtet die Cloud-Sicherung mit dem Passwort ein und lädt den Stand dieses Geräts hoch (ohne Verbindung
 * später). Gibt es mit diesem Passwort schon eine, werden die beiden Stände abgeglichen.
 * @returns {Promise<object>} Zustand danach (wie getCloudStatus)
 */
export async function setupCloud(teacher, password, { remember = true } = {}) {
  const code = teacher.teacherCode;
  const keys = await keysFor(code, teacher, password);
  const pendingAdminHash = await hashOf(keys.adminToken);
  return exclusive(async () => {
    const existing = loadCloudConfig(code);
    // Dieses Gerät war schon mit genau dieser Sicherung verbunden (z. B. erneute Registrierung): nur wieder
    // eintragen und Version sowie Stand des letzten Abgleichs behalten.
    if (existing && existing.syncId === keys.syncId && existing.version > 0 && !existing.pendingCreate) {
      try {
        const rec = await openCloudRecord(keys, keys.device);
        if (rec.found) {
          // Ältere Version als zuletzt gesehen: neu eingerichtet – dann ohne gemeinsamen Stand abgleichen.
          saveCloudConfig(code, rec.version >= existing.version ? { ...existing, remember } : { ...existing, version: 0, remember });
          saveKeys(code, keys, remember);
          if (code === active) problem = null;
          await syncRounds(code, { pull: true, keepalive: false });
          return getCloudStatus(code);
        }
      } catch (err) {
        if (!(err instanceof MailboxError) || !err.offline) throw err;
        saveCloudConfig(code, { ...existing, remember });
        saveKeys(code, keys, remember);
        return getCloudStatus(code);
      }
    }
    saveCloudConfig(code, { syncId: keys.syncId, version: 0, dirty: true, syncedHash: '', pendingCreate: true, pendingAdminHash, syncedAt: '', remember });
    saveKeys(code, keys, remember);
    if (code === active) problem = null;
    await syncRounds(code, { pull: false, keepalive: false });
    return getCloudStatus(code);
  });
}

/**
 * Prüft das Passwort, trägt dieses Gerät ein und holt den Stand aus der Cloud – ohne ihn schon zu übernehmen
 * (siehe adoptCloud). Wirft CloudNotFoundError (kein Treffer: falsches Passwort, keine Sicherung oder Passwort
 * inzwischen geändert), MailboxError 429 (zu viele Versuche) oder ohne Verbindung.
 */
export async function unlockCloud(teacher, password) {
  const keys = await keysFor(teacher.teacherCode, teacher, password);
  const rec = await openCloudRecord(keys, keys.device);
  if (!rec.found) throw new CloudNotFoundError();
  let remote;
  try {
    remote = unpackCloudData(await decryptCloudData(keys, rec));
  } catch (err) {
    if (err instanceof CloudMovedError) throw new CloudNotFoundError(true);
    throw err;
  }
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
    const remoteHash = contentHash(unlocked.remote.state, unlocked.remote.eventDraft);
    saveCloudConfig(code, { syncId: unlocked.keys.syncId, version: unlocked.version, dirty: choice === 'local', syncedHash: remoteHash, pendingCreate: false, syncedAt: new Date().toISOString(), remember });
    saveKeys(code, unlocked.keys, remember);
    if (code === active) problem = null;
    if (choice === 'remote') applyRemote(code, unlocked.keys.syncId, unlocked.remote, { version: unlocked.version, updatedAt: unlocked.updatedAt }, 'unlock');
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
 * Zieht die Sicherung unter ein neues Passwort um:
 *  1. abgleichen (sonst ginge verloren, was ein anderes Gerät eben gesichert hat),
 *  2. neue Sicherung mit dem aktuellen Stand anlegen,
 *  3. die alte – nur wenn sie noch unverändert ist (Versionsprüfung beim Dienst) – mit dem Hinweis „umgezogen“
 *     überschreiben: andere Geräte fragen dann nach dem neuen Passwort,
 *  4. die alte löschen, wenn das bisherige Passwort bekannt ist (Admin-Token).
 * Scheitert Schritt 3 nachweislich, wird die neue wieder gelöscht und nichts geändert. Ist unklar, ob Schritt 3
 * geklappt hat (Antwort verloren), bleiben beide Sicherungen – so geht nichts verloren.
 * @returns {Promise<{oldLeft: boolean}>} oldLeft: die alte Sicherung ist noch da (mit dem Hinweis „umgezogen“)
 */
async function moveCloud(code, teacher, newPassword, { oldAdminToken = null } = {}) {
  const fresh = await keysFor(code, teacher, newPassword);
  const adminHash = await hashOf(fresh.adminToken);
  return exclusive(async () => {
    const keys = loadKeys(code);
    if (!keys) throw new Error('Die Cloud-Sicherung ist auf diesem Gerät nicht verbunden.');
    if (fresh.syncId === keys.syncId) throw new Error('Das neue Passwort ist dasselbe wie das bisherige.');
    await syncRounds(code, { pull: true, keepalive: false });
    const cfg = loadCloudConfig(code);
    if (!cfg || !loadKeys(code) || cfg.pendingCreate || cfg.dirty || cfg.version === 0 || problem) {
      throw new Error('Ihr Stand ist gerade nicht vollständig mit der Cloud abgeglichen (z. B. keine Verbindung). Bitte versuchen Sie es gleich noch einmal.');
    }
    const sealed = await sealCurrent(code, fresh, 1);
    if (!sealed) throw new Error('In diesem Browser ist kein Stand gespeichert.');
    let freshVersion = 1;
    try {
      await createCloudRecord(fresh, sealed.data, adminHash);
    } catch (err) {
      if (!(err instanceof MailboxError) || err.status !== 409) throw err;
      // Schon vorhanden: Ist es die eigene aus einem abgebrochenen Versuch (gleicher Stand), weiter mit ihr.
      const rec = await openCloudRecord(fresh, fresh.device);
      const own = rec.found && (await decryptCloudData(fresh, rec).then(unpackCloudData).catch(() => null));
      if (!own || !sameContent(own.state, loadTeacherState(code))) {
        throw new Error('Mit diesem Passwort gibt es bereits eine andere Cloud-Sicherung. Bitte wählen Sie ein anderes Passwort.');
      }
      freshVersion = rec.version;
    }
    // Schritt 3: Hinweis „umgezogen“ – nur, wenn die alte Sicherung noch auf dem abgeglichenen Stand ist.
    let moved = false;
    try {
      await saveCloudRecord(keys, cfg.version, await encryptCloudData(keys, packMovedNotice(), cfg.version + 1));
      moved = true;
    } catch (err) {
      const verdict = await oldRecordState(keys, cfg.version);
      if (verdict === 'moved' || verdict === 'gone') moved = true;
      else if (verdict === 'unchanged' || verdict === 'changed' || (err instanceof MailboxError && err.status === 409)) {
        // Die bisherige Sicherung ist nachweislich noch in Gebrauch: die neue wieder löschen.
        await deleteCloudRecord(fresh, fresh.adminToken).catch(() => {});
        throw new Error(
          verdict === 'changed' || (err instanceof MailboxError && err.status === 409)
            ? 'Ihr Stand wurde gerade auf einem anderen Gerät geändert. Bitte versuchen Sie es gleich noch einmal.'
            : `Die bisherige Cloud-Sicherung ließ sich nicht umstellen. ${err instanceof MailboxError ? cloudErrorMessage(err) : ''}`.trim(),
        );
      } else {
        // Unklar (keine Verbindung): nichts löschen. Dieses Gerät bleibt bei der bisherigen Sicherung; hat der
        // Hinweis doch geklappt, fragt es beim nächsten Abgleich nach dem neuen Passwort – die neue Sicherung steht.
        throw new Error('Die Verbindung zur Cloud-Sicherung ist abgebrochen. Bitte prüfen Sie die Verbindung und versuchen Sie es noch einmal.');
      }
    }
    let oldLeft = moved;
    if (oldAdminToken) {
      try {
        if (await deleteCloudRecord(keys, oldAdminToken)) oldLeft = false;
      } catch (err) {
        // Die alte Sicherung trägt ja den Hinweis „umgezogen“ und wird ohne Nutzung automatisch gelöscht.
        console.warn(err);
      }
    }
    saveCloudConfig(code, { syncId: fresh.syncId, version: freshVersion, dirty: false, syncedHash: sealed.hash, pendingCreate: false, syncedAt: new Date().toISOString(), remember: cfg.remember });
    saveKeys(code, fresh, cfg.remember);
    markSynced(code, fresh.syncId, freshVersion, sealed.hash);
    await touch(fresh);
    if (code === active) problem = null;
    emitStatus();
    return { oldLeft };
  });
}

/**
 * Zustand der bisherigen Sicherung nach einem unklaren Schreibversuch: 'moved' (Hinweis steht), 'gone' (kein
 * Zugang mehr – gelöscht), 'unchanged' (noch die abgeglichene Version), 'changed' oder 'unknown' (keine Verbindung).
 */
async function oldRecordState(keys, version) {
  try {
    const rec = await fetchCloudRecord(keys);
    if (!rec.found) return 'gone';
    if (rec.version === version) return 'unchanged';
    try {
      unpackCloudData(await decryptCloudData(keys, rec));
      return 'changed';
    } catch (err) {
      return err instanceof CloudMovedError ? 'moved' : 'changed';
    }
  } catch (err) {
    return err instanceof MailboxError && err.status === 403 ? 'gone' : 'unknown';
  }
}

/**
 * Neues Passwort (das bisherige ist nötig). Andere Geräte fragen danach einmal nach dem neuen Passwort.
 * @returns {Promise<{oldLeft: boolean}>}
 */
export async function changeCloudPassword(teacher, currentPassword, newPassword) {
  const code = teacher.teacherCode;
  const { derived: old } = await verifyPassword(code, teacher, currentPassword);
  return moveCloud(code, teacher, newPassword, { oldAdminToken: old.adminToken });
}

/**
 * „Passwort vergessen“ auf einem verbundenen Gerät: Die Sicherung zieht mit dem Stand dieses Geräts unter ein
 * neues Passwort um; die alte bekommt den Hinweis „umgezogen“ (löschen lässt sie sich ohne Passwort nicht).
 */
export async function moveCloudToNewPassword(teacher, newPassword) {
  return moveCloud(teacher.teacherCode, teacher, newPassword);
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
