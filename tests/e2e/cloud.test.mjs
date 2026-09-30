// Browser-Tests: Cloud-Sicherung v2.1 (core/cloud.js, core/cloud-sync.js, components/cloud-ui.js) durch die echte
// Oberfläche. Der Dienst (worker/briefkasten.js) läuft lokal über mailbox-server.mjs – nie gegen workers.dev.
// Jeder Test startet einen eigenen Dienst; „Geräte“ sind getrennte Browser (eigener Speicher).
// Abgedeckt: Registrierung mit Passwort (auch noch nicht gespeicherte Eingaben werden gesichert), neues Gerät
// (falsches/richtiges Passwort), Abgleich in beide Richtungen, Konflikte (Dialog bzw. ohne Rückfrage bei leerem
// Stand, Zwischenstand aus dem Dialog), Lehrkraft ohne Cloud-Sicherung („Später“), Entsperren über die Kopfzeile
// und den Hinweis auf einem leeren Gerät, Passwort ändern, Passwort vergessen (neue Sicherung bzw. Umzug auf einem
// verbundenen Gerät), Sicherung löschen, Gerät lösen („nicht mehr verwenden“), Abmelden mit „Daten entfernen“,
// „Alle Daten in diesem Browser löschen“ (mit und ohne vollständigen Abgleich), erneute Registrierung, Dienst ohne
// Cloud-Sicherung, Sperre nach 10 Versuchen, Geräte-Geheimnis je Browser, „Passwort merken“ wie bisher gewählt und
// die Registrierungs-PDF (ohne Passwort).
// Am Ende Tests direkt am Dienst: Anlegen verrät nichts und zählt als Versuch, Grenzen je Anschluss, Gesamtgrenze
// nach tatsächlicher Größe, Aufräumen, Meldung zur Sperre.
// Datenbank des Dienstes: Tabelle backups mit id = base64url(SHA-256("cloud|" + who + "|" + syncId)) – weder who
// noch syncId stehen darin; backup_chunks(backup_id, idx, data); cloud_limits(key, win, n); meta.
// PBKDF2 mit 600 000 Durchläufen dauert im Browser etwa eine halbe Sekunde – daher großzügige Wartezeiten.
// Aufruf: node --test tests/e2e/cloud.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startServer, launch, captureDownload, pdfPayload, sampleState, seedTeacher, SAMPLE_TEACHER } from './helpers.mjs';
import { startMailboxServer } from './mailbox-server.mjs';
import worker from '../../worker/briefkasten.js';
import { deriveCloudKeys, decryptCloudData, hashOf, cloudErrorMessage } from '../../js/core/cloud.js';
import { MailboxError } from '../../js/core/mailbox.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

const tid = (id) => `[data-testid="${id}"]`;
const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T_CODE = SAMPLE_TEACHER.teacherCode;
// Nicht das Beispiel aus dem Hinweis unter dem Passwortfeld – sonst stünde es ohnehin auf der Seite.
const PASSWORD = 'Blaue Tafel grün 2026';
const NEW_PASSWORD = 'Mond Heft Radiergummi 9';
const WRONG_PASSWORD = 'Falsches Passwort 123';
const NEW_EMAIL = 'anna.neu@schule.example';
const SLOW = { timeout: 60000 }; // Schlüsselableitung und Abgleich
const TEST_TIMEOUT = 240000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Erwartete Konsolenmeldungen von Chromium (Antworten des Dienstes mit Fehlerstatus bzw. ohne Verbindung)
const STATUS = (...codes) => new RegExp(`^console: Failed to load resource: the server responded with a status of (${codes.join('|')}) `);
const OFFLINE = /^console: Failed to load resource: net::ERR_(INTERNET_DISCONNECTED|FAILED)$/;

// Meldungen der Oberfläche
const NOT_FOUND = 'Mit diesem Passwort gibt es keine Cloud-Sicherung. Bitte prüfen Sie das Passwort, auch Groß- und Kleinschreibung';
const NOT_FOUND_LOGIN = `${NOT_FOUND} – oder richten Sie eine neue Cloud-Sicherung ein.`;
const NOT_FOUND_PLAIN = `${NOT_FOUND}.`;
const MOVED_OLD_PASSWORD = 'Das Passwort dieser Cloud-Sicherung wurde inzwischen auf einem anderen Gerät geändert. Bitte geben Sie das neue Passwort ein.';
const LOADED = 'Ihr Stand aus der Cloud-Sicherung wurde geladen.';
const FROM_OTHER_DEVICE = 'Neuer Stand von einem anderen Gerät übernommen.';
const SETUP_DONE = 'Cloud-Sicherung eingerichtet. Ihr Stand wird ab jetzt automatisch gesichert.';
const SETUP_INTRO = 'Neu: Ihr Stand kann jetzt automatisch in der Cloud gesichert werden – dann ist er auf jedem Gerät da, an dem Sie sich anmelden. Legen Sie dafür einmal ein Passwort fest.';
const NEEDS_PASSWORD = 'Bitte geben Sie Ihr Passwort für die Cloud-Sicherung erneut ein. Vielleicht wurde es auf einem anderen Gerät geändert oder die Sicherung gelöscht.';
const MOVED = 'Das Passwort Ihrer Cloud-Sicherung wurde auf einem anderen Gerät geändert. Bitte geben Sie das neue Passwort ein – Ihre Änderungen auf diesem Gerät bleiben erhalten.';
const LOGIN_CONFLICT = 'Auf diesem Gerät ist ein anderer Stand gespeichert als in Ihrer Cloud-Sicherung.';
const SYNC_CONFLICT = 'Ihr Stand wurde auf einem anderen Gerät geändert, während hier noch nicht gesicherte Änderungen vorlagen.';
const LOCKED =
  /^Für Ihre Cloud-Sicherung gab es zu viele Versuche mit einem falschen Passwort \(nicht unbedingt von Ihnen\)\. Zum Schutz Ihrer Daten ist das Öffnen und Einrichten (für eine Minute|für \d+ Minuten|bis morgen) gesperrt\. Geräte, die schon verbunden sind, gleichen weiter ab\.$/;
const DELETE_ALL_COMPLETE =
  'Ihre Cloud-Sicherung bleibt erhalten: Melden Sie sich wieder an und geben Ihr Passwort ein, ist Ihr Stand wieder da. Möchten Sie auch sie löschen, nutzen Sie vorher oben „Cloud-Sicherung löschen“.';
const DELETE_ALL_INCOMPLETE =
  'Ihr aktueller Stand ist nicht vollständig in der Cloud-Sicherung (keine Verbindung oder Passwort nicht eingegeben). Was hier seit dem letzten Abgleich geändert wurde, geht beim Löschen verloren.';
const BACKUP_NAME = /^Zwischenspeicher vom \d{2}\.\d{2}\.\d{4} um \d{2}꞉\d{2} für ParentsDay\.json$/;

// Zwei Tage im übernächsten Monat (im Kalender zweimal „weiter“).
const now = new Date();
const target = new Date(now.getFullYear(), now.getMonth() + 2, 1);
const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
const D1 = `${ym}-12`;
const D2 = `${ym}-13`;

// Erwartete Werte aus Passwort, Name und Geburtsdatum – wie im Browser, hier in Node berechnet.
const derived = new Map();
function keysFor(password) {
  if (!derived.has(password)) derived.set(password, deriveCloudKeys(password, SAMPLE_TEACHER));
  return derived.get(password);
}

// ---------- Umgebung ----------

/** Dienst, Webserver (mit diesem Dienst als MAILBOX_URL) und Geräte (Browser) für einen Test. */
async function setup() {
  const mb = await startMailboxServer();
  const web = await startServer({ mailboxUrl: mb.url });
  mb.env.ALLOWED_ORIGINS = new URL(web.url).origin;
  const devices = [];
  return {
    mb,
    web,
    /** Neues Gerät (eigener Browser). Protokolliert alle Anfragen – keine darf an workers.dev gehen. */
    async open(opts) {
      const d = await launch(opts);
      d.requests = [];
      d.context.on('request', (req) => d.requests.push(`${req.method()} ${req.url()}`));
      devices.push(d);
      return d;
    },
    async close() {
      for (const d of devices) await d.browser.close().catch(() => {});
      await web.close();
      await mb.close();
    },
  };
}

/** Prüft ein Gerät: keine unerwarteten Konsolenfehler, keine Anfrage an den echten Dienst. */
function assertClean(d, label, ...allowed) {
  assert.deepEqual(
    d.errors.filter((e) => !allowed.some((re) => re.test(e))),
    [],
    `${label}: unerwartete Konsolenfehler`,
  );
  assert.deepEqual(
    d.requests.filter((r) => /workers\.dev/.test(r)),
    [],
    `${label}: Anfrage an den echten Briefkasten`,
  );
}

async function waitUntil(predicate, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  }
  assert.fail(message);
}

const waitHash = (page, hash) => page.waitForFunction((h) => location.hash === h, hash, SLOW);

// ---------- Dienst (Datenbank) ----------

/** Zeilen einer Tabelle als einfache Objekte ([] solange es die Tabelle noch nicht gibt). */
function rows(mb, sql, ...params) {
  try {
    return mb.db.db
      .prepare(sql)
      .all(...params)
      .map((r) => ({ ...r }));
  } catch {
    return []; // Tabellen entstehen erst mit der ersten Anfrage an den Dienst
  }
}

/** Schlüssel der Zeile einer Sicherung beim Dienst: base64url(SHA-256("cloud|who|syncId")). */
const rowId = (k) => createHash('sha256').update(`cloud|${k.who}|${k.syncId}`).digest('base64url');

const cloudRows = (mb) => rows(mb, 'SELECT id, version, updated_at, seen_at, auth_hash, admin_hash, devices, iv, z, chunks, size FROM backups ORDER BY rowid');
const chunkRows = (mb) => rows(mb, 'SELECT backup_id, idx, length(data) AS len FROM backup_chunks ORDER BY backup_id, idx');
/** Zeile der Sicherung zu den Schlüsseln `k` ({ who, syncId }) oder null. */
const cloudRow = (mb, k) => cloudRows(mb).find((r) => r.id === rowId(k)) || null;

/** Zähler der Versuche je Lehrkraft: { perIp, perDay } (Schlüssel „o|who|ip“ bzw. „o|who“). */
function attempts(mb, who) {
  const list = rows(mb, 'SELECT key, n FROM cloud_limits');
  return {
    perIp: list.filter((r) => r.key.startsWith(`o|${who}|`)).reduce((n, r) => n + r.n, 0),
    perDay: list.find((r) => r.key === `o|${who}`)?.n ?? 0,
  };
}

/** Zähler neuer Sicherungen je Anschluss (Schlüssel „c|ip“ bzw. Zeichen „cb|ip“), zusammengezählt. */
function createCounters(mb) {
  const list = rows(mb, 'SELECT key, n FROM cloud_limits');
  const sum = (prefix) => list.filter((r) => r.key.startsWith(prefix)).reduce((n, r) => n + r.n, 0);
  return { creates: sum('c|'), chars: sum('cb|') };
}

/** Wartet, bis die Sicherung zu `k` mindestens `version` erreicht hat. */
function waitVersion(mb, k, version) {
  return waitUntil(() => {
    const row = cloudRow(mb, k);
    return row && row.version >= version ? row : null;
  }, `Cloud-Sicherung erreicht Version ${version} nicht`);
}

/** Entschlüsselt die Sicherung im Dienst mit den Schlüsseln eines Geräts (wie der Browser, mit der Version). */
async function decryptStored(mb, keys) {
  const row = cloudRow(mb, keys);
  assert.ok(row, 'Cloud-Sicherung vorhanden');
  const ct = rows(mb, 'SELECT data FROM backup_chunks WHERE backup_id = ? ORDER BY idx', row.id)
    .map((r) => r.data)
    .join('');
  return decryptCloudData(keys, { iv: row.iv, ct, z: row.z, version: row.version });
}

/** Wartet, bis der entschlüsselte Inhalt der Sicherung `predicate` erfüllt, und gibt ihn zurück. */
async function waitContent(mb, keys, predicate, message) {
  let content = null;
  await waitUntil(async () => {
    if (!cloudRow(mb, keys)) return false;
    content = await decryptStored(mb, keys);
    return predicate(content);
  }, message);
  return content;
}

/** Gesamter Inhalt der Datenbank als Text (zum Prüfen, was der Dienst NICHT kennt). */
function dumpDb(mb, tables = ['backups', 'backup_chunks', 'cloud_limits', 'meta', 'messages', 'directory']) {
  return tables.map((t) => JSON.stringify(rows(mb, `SELECT * FROM ${t}`))).join('\n');
}

/** Zufällige Zugangsdaten wie aus deriveCloudKeys (ohne PBKDF2) samt Geräte-Geheimnis – für Tests am Dienst. */
function fakeKeys(who = randomBytes(16).toString('base64url')) {
  const b64 = (n) => randomBytes(n).toString('base64url');
  return { syncId: b64(24), who, authToken: b64(32), adminToken: b64(32), device: b64(32) };
}

/**
 * Anfragen direkt an den Dienst – so, wie der Browser sie schickt (Bearer-Token, X-Who, X-Device). `ip` wird wie
 * bei Cloudflare als CF-Connecting-IP übergeben.
 */
function api(mb) {
  const call = (method, path, { token, ip = '198.51.100.1', body, headers = {} }) =>
    fetch(`${mb.url}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const who = (k, o) => ({ 'X-Who': o.who ?? k.who, 'X-Device': o.device ?? k.device });
  return {
    /** Neu anlegen (baseVersion 0). */
    create: async (k, o = {}) =>
      call('PUT', `/v1/sync/${k.syncId}`, {
        token: k.authToken,
        ip: o.ip,
        body: {
          baseVersion: 0,
          who: o.who ?? k.who,
          authHash: await hashOf(k.authToken),
          adminHash: await hashOf(k.adminToken),
          device: await hashOf(k.device),
          iv: 'AAAAAAAAAAAAAAAA',
          ct: o.ct ?? 'A'.repeat(32),
          z: 0,
        },
      }),
    /** Auf einem Gerät öffnen (trägt `device` ein). */
    open: async (k, o = {}) => call('POST', `/v1/sync/${k.syncId}/open`, { token: k.authToken, ip: o.ip, body: { who: o.who ?? k.who, device: await hashOf(o.device ?? k.device) } }),
    get: (k, o = {}) => call('GET', `/v1/sync/${k.syncId}${o.since ? `?since=${o.since}` : ''}`, { token: k.authToken, ip: o.ip, headers: who(k, o) }),
    update: (k, baseVersion, o = {}) =>
      call('PUT', `/v1/sync/${k.syncId}`, { token: k.authToken, ip: o.ip, headers: who(k, o), body: { baseVersion, iv: 'BBBBBBBBBBBBBBBB', ct: 'B'.repeat(32), z: 0 } }),
    remove: (k, o = {}) => call('DELETE', `/v1/sync/${k.syncId}`, { token: o.token ?? k.adminToken, ip: o.ip, headers: who(k, o) }),
  };
}

// ---------- Gerät (Browser) ----------

const readState = (page, code = T_CODE) => page.evaluate((c) => JSON.parse(localStorage.getItem(`parentsday.teacher.${c}`) || 'null'), code);

/** Einstellungen, Schlüssel und Geräte-Geheimnis der Cloud-Sicherung im Speicher des Browsers. */
const readCloud = (page, code = T_CODE) =>
  page.evaluate(
    (c) => ({
      config: JSON.parse(localStorage.getItem(`parentsday.cloud.${c}`) || 'null'),
      localKey: JSON.parse(localStorage.getItem(`parentsday.cloudKey.${c}`) || 'null'),
      sessionKey: JSON.parse(sessionStorage.getItem(`parentsday.cloudKey.${c}`) || 'null'),
      device: JSON.parse(localStorage.getItem(`parentsday.cloudDevice.${c}`) || 'null'),
    }),
    code,
  );

/** Schlüssel eines Geräts (gemerkt oder nur für die Sitzung). */
async function keysOf(page) {
  const cloud = await readCloud(page);
  return cloud.localKey || cloud.sessionKey;
}

/** Alles, was ParentsDay im Browser gespeichert hat (Text). */
const allStorage = (page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));

/** Schlüssel im Speicher, die zur Lehrkraft gehören. */
const teacherKeys = (page) =>
  page.evaluate((code) => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.includes(code) || k === 'parentsday.session'), T_CODE);

const classIds = (state) => (state?.classes || []).map((c) => c.id);

function classOf(id) {
  return { id, grade: Number(id.slice(0, -1)), letter: id.slice(-1), codesGenerated: false, students: [] };
}

const indicator = (page) => page.locator(tid('cloud-indicator'));
const waitIndicator = (page, state) => page.locator(`${tid('cloud-indicator')}[data-state="${state}"]`).waitFor(SLOW);
// .last(): Ein gleichlautender Hinweis von vorhin kann noch zu sehen sein.
const toastWith = (page, text) => page.locator('.toast', { hasText: text }).last();
const modalTitle = (page) => page.locator('.modal-title').last();

/** Abgleich direkt anstoßen (dasselbe Modul wie in der App) – gibt den Zustand danach zurück. */
const syncNow = (page) => page.evaluate(() => import('/js/core/cloud-sync.js').then((m) => m.syncCloudNow()));

/** Legt den Stand einer Lehrkraft im Browser ab (ohne Anmeldung – wie ein früher genutztes Gerät). */
async function seedWithoutSession(page, web, state) {
  await page.goto(web.url);
  await page.evaluate((s) => localStorage.setItem(`parentsday.teacher.${s.teacher.teacherCode}`, JSON.stringify(s)), state);
}

/** Anmelden mit Namen, Geburtsdatum und Registrierungscode. */
async function fillLogin(page, web, teacher = SAMPLE_TEACHER) {
  await page.goto(`${web.url}#/lehrkraft/anmelden`);
  await page.fill(tid('login-firstname'), teacher.firstName);
  await page.fill(tid('login-lastname'), teacher.lastName);
  await page.fill(tid('login-birthdate'), teacher.birthDate);
  await page.fill(tid('login-code'), teacher.registrationCode.toLowerCase());
  await page.click(tid('login-submit'));
}

/** Passwort im Dialog „Passwort eingeben“ eingeben (Dialog schließt sich danach). */
async function unlockWith(page, password, { remember = false } = {}) {
  const dlg = page.locator(tid('cloud-unlock-dialog'));
  await dlg.waitFor(SLOW);
  await page.fill(tid('cloud-unlock-password'), password);
  if (remember) await page.check(tid('cloud-unlock-remember'));
  await page.click(tid('cloud-unlock-submit'));
  await dlg.waitFor({ state: 'detached', ...SLOW });
}

/** Falsches Passwort im Dialog: Fehlermeldung am Feld, Dialog bleibt offen. Gibt die Meldung zurück. */
async function wrongPassword(page, password = WRONG_PASSWORD) {
  await page.fill(tid('cloud-unlock-password'), password);
  await page.click(tid('cloud-unlock-submit'));
  const error = page.locator('#cloud-unlock-password-error:not([hidden])');
  await error.waitFor(SLOW);
  // Knopf wieder bereit für den nächsten Versuch
  await page.locator(`${tid('cloud-unlock-submit')}:not([disabled])`).waitFor(SLOW);
  return flat(await error.textContent());
}

/** Passwort im Dialog, das der Dienst wegen der Sperre abweist: Meldung im Dialog, der offen bleibt. */
async function lockedPassword(page, password) {
  await page.fill(tid('cloud-unlock-password'), password);
  await page.click(tid('cloud-unlock-submit'));
  const alert = page.locator(`${tid('cloud-unlock-dialog')} .alert-error`);
  await alert.waitFor(SLOW);
  await page.locator(`${tid('cloud-unlock-submit')}:not([disabled])`).waitFor(SLOW);
  return flat(await alert.textContent());
}

/** Neues Passwort in einem Dialog mit zwei Feldern (Präfix z. B. „cloud-setup“) eingeben. */
async function fillNewPassword(page, prefix, password) {
  await page.fill(tid(`${prefix}-password`), password);
  await page.fill(tid(`${prefix}-password2`), password);
}

/** Klasse auf der Klassenübersicht anlegen. */
async function addClass(page, id) {
  await page.locator(tid('class-grade')).waitFor();
  await page.selectOption(tid('class-grade'), id.slice(0, -1));
  await page.selectOption(tid('class-letter'), id.slice(-1));
  await page.click(tid('class-create'));
  await page.locator(tid(`class-tile-${id}`)).waitFor();
}

/** Kacheln der Klassenübersicht. */
const tiles = (page) => page.$$eval('[data-testid^="class-tile-"]', (els) => els.map((e) => e.dataset.testid.replace('class-tile-', '')));

const goSettings = (page) => page.click('.header-nav a[href="#/lehrkraft/einstellungen"]');
const goClasses = (page) => page.click('.header-nav a[href="#/lehrkraft/klassen"]');

/** Zurück auf die Seite (focus) – danach wird geprüft, ob es einen neueren Stand gibt. */
const refocus = (page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

/** „Alle Daten in diesem Browser löschen“ unter „Weitere Einstellungen“ – gibt den Dialog zurück. */
async function openDeleteAll(page) {
  await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
  const dlg = page.locator('.modal', { hasText: 'Alle Daten in diesem Browser löschen?' });
  await dlg.waitFor(SLOW);
  return dlg;
}

/**
 * Gerät A: Lehrkraft mit Stand (Elternsprechtag und Klassen) meldet sich an und richtet im Dialog nach der
 * Anmeldung die Cloud-Sicherung ein (Gerät mit Daten → zuerst „Cloud-Sicherung einrichten“).
 */
async function deviceWithCloud(s, { classes = ['5a'], password = PASSWORD } = {}) {
  const d = await s.open();
  await seedWithoutSession(d.page, s.web, sampleState({ classes: classes.map(classOf) }));
  await fillLogin(d.page, s.web);
  await d.page.locator(tid('cloud-setup-dialog')).waitFor(SLOW);
  await fillNewPassword(d.page, 'cloud-setup', password);
  await d.page.click(tid('cloud-setup-submit'));
  await waitHash(d.page, '#/lehrkraft/klassen');
  await waitIndicator(d.page, 'ok');
  return d;
}

/** Weiteres Gerät: meldet sich mit den Daten an und gibt das Passwort ein – der Stand kommt aus der Cloud. */
async function deviceUnlocked(s, { password = PASSWORD, remember = false } = {}) {
  const d = await s.open();
  await fillLogin(d.page, s.web);
  await unlockWith(d.page, password, { remember });
  await waitHash(d.page, '#/lehrkraft/klassen');
  await waitIndicator(d.page, 'ok');
  return d;
}

/** Abmelden über die Kopfzeile (optional mit „Meine Daten von diesem Gerät entfernen“). */
async function logout(page, { remove = false } = {}) {
  await page.locator('.header-actions').getByRole('button', { name: 'Abmelden', exact: true }).click();
  const dlg = page.locator('.modal', { hasText: 'Abmelden?' });
  await dlg.waitFor();
  if (remove) await page.check(tid('logout-remove'));
  await dlg.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await waitHash(page, '#/');
}

/** Registrierung über das Formular (mit Passwort); wartet auf den Hinweis zur Cloud-Sicherung. */
async function register(page, web, { password = PASSWORD, email = SAMPLE_TEACHER.email } = {}) {
  await page.goto(`${web.url}#/lehrkraft/registrieren`);
  await page.fill(tid('reg-firstname'), SAMPLE_TEACHER.firstName);
  await page.fill(tid('reg-lastname'), SAMPLE_TEACHER.lastName);
  await page.fill(tid('reg-birthdate'), SAMPLE_TEACHER.birthDate);
  await page.fill(tid('reg-email'), email);
  await fillNewPassword(page, 'reg', password);
  const reg = await captureDownload(page, () => page.click(tid('reg-submit')));
  await page.locator(tid('reg-cloud-note')).waitFor(SLOW);
  return reg;
}

// ---------- PDF ----------

/** Text aller Seiten einer PDF – über python3 + pymupdf (null, wenn nicht verfügbar). */
function pdfText(file) {
  try {
    return execFileSync('python3', ['-c', 'import sys, pymupdf\nprint("\\n".join(p.get_text() for p in pymupdf.open(sys.argv[1])))', file], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

/** Entpackte Inhalte aller komprimierten Streams einer PDF (jsPDF mit compress: true). */
function inflatedStreams(buffer) {
  const text = buffer.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    try {
      out.push(zlib.inflateSync(buffer.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1'));
    } catch {
      // nicht komprimiert
    }
    re.lastIndex = end;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------

test('Registrierung mit Passwort legt die Cloud-Sicherung an (nur verschlüsselt, Passwort nicht in der PDF); Änderungen und Entwürfe werden hochgeladen', { timeout: TEST_TIMEOUT }, async (t) => {
  const s = await setup();
  try {
    const a = await s.open();
    const { page } = a;
    await page.goto(`${s.web.url}#/lehrkraft/registrieren`);
    await page.locator(tid('reg-cloud')).waitFor();
    assert.match(flat(await page.textContent(tid('reg-cloud'))), /Mindestens 10 Zeichen/);
    assert.equal(await page.isChecked(tid('reg-remember')), true, '„Passwort merken“ ist bei der Registrierung vorausgewählt');
    await page.fill(tid('reg-firstname'), SAMPLE_TEACHER.firstName);
    await page.fill(tid('reg-lastname'), SAMPLE_TEACHER.lastName);
    await page.fill(tid('reg-birthdate'), SAMPLE_TEACHER.birthDate);
    await page.fill(tid('reg-email'), SAMPLE_TEACHER.email);

    // Zu kurzes bzw. nicht wiederholtes Passwort: Fehler am Feld, nichts gespeichert
    await page.fill(tid('reg-password'), 'kurz');
    await page.click(tid('reg-submit'));
    assert.equal(await page.textContent('#reg-password-error'), 'Das Passwort muss mindestens 10 Zeichen lang sein.');
    await page.fill(tid('reg-password'), PASSWORD);
    await page.fill(tid('reg-password2'), `${PASSWORD}!`);
    await page.click(tid('reg-submit'));
    assert.equal(await page.textContent('#reg-password2-error'), 'Die beiden Passwörter stimmen nicht überein.');
    assert.equal(await readState(page), null, 'noch nichts gespeichert');
    assert.deepEqual(cloudRows(s.mb), []);

    await page.fill(tid('reg-password2'), PASSWORD);
    const reg = await captureDownload(page, () => page.click(tid('reg-submit')));
    assert.equal(reg.filename, 'ParentsDay Registrierung Anna Meier.pdf');
    const payload = pdfPayload(reg.buffer);
    assert.equal(payload.teacherCode, T_CODE);

    // Registrierungs-PDF: Passwort weder in den eingebetteten Daten noch im Text oder in den Rohdaten
    assert.ok(!JSON.stringify(payload).includes(PASSWORD), 'Passwort nicht in den eingebetteten Daten');
    assert.ok(!reg.buffer.toString('latin1').includes(PASSWORD), 'Passwort nicht in der PDF (roh)');
    assert.ok(!inflatedStreams(reg.buffer).includes(PASSWORD), 'Passwort nicht in der PDF (entpackt)');
    const text = pdfText(reg.file);
    if (text === null) t.diagnostic('python3/pymupdf nicht verfügbar – Text der PDF nicht geprüft');
    else {
      assert.match(flat(text), /Ihr Passwort steht aus Sicherheitsgründen nicht in diesem Dokument\./, 'Hinweis zum Passwort in der PDF');
      assert.ok(!flat(text).includes(PASSWORD), 'Passwort nicht im Text der PDF');
    }

    const note = page.locator(tid('reg-cloud-note'));
    await note.waitFor(SLOW);
    assert.match(flat(await note.textContent()), /^Cloud-Sicherung eingerichtet\. Ihr Stand wird ab jetzt automatisch gesichert\./);

    // Dienst: eine Sicherung unter SHA-256(who|syncId) – nur Hashwerte der Tokens und verschlüsselte Daten
    const expected = await keysFor(PASSWORD);
    const [row] = cloudRows(s.mb);
    assert.equal(cloudRows(s.mb).length, 1, 'genau eine Cloud-Sicherung');
    assert.equal(row.id, rowId(expected), 'Zeile unter base64url(SHA-256("cloud|who|syncId"))');
    assert.equal(row.version, 1);
    assert.equal(row.z, 1, 'komprimiert');
    assert.equal(row.auth_hash, await hashOf(expected.authToken));
    assert.equal(row.admin_hash, await hashOf(expected.adminToken));
    const chunks = chunkRows(s.mb);
    assert.equal(chunks.length, row.chunks);
    assert.ok(chunks.every((c) => c.backup_id === row.id));
    assert.equal(
      row.size,
      chunks.reduce((n, c) => n + c.len, 0),
      'Spalte size = tatsächliche Größe der verschlüsselten Daten',
    );
    const dump = dumpDb(s.mb);
    for (const secret of ['Meier', 'Anna', SAMPLE_TEACHER.email, PASSWORD, T_CODE, SAMPLE_TEACHER.registrationCode, expected.syncId, expected.authToken, expected.adminToken, expected.encKey]) {
      assert.ok(!dump.includes(secret), `Dienst kennt „${secret.slice(0, 12)}…“ nicht`);
    }
    // who steht nur in den Zählern der Versuche (werden nach spätestens 2 Tagen gelöscht), nicht bei der Sicherung
    assert.ok(!dumpDb(s.mb, ['backups', 'backup_chunks']).includes(expected.who), 'who nicht bei der Sicherung gespeichert');
    // Auch erfolgreiches Anlegen zählt als Versuch der Lehrkraft (sonst ließe sich über „gibt es schon“ raten)
    assert.deepEqual(attempts(s.mb, expected.who), { perIp: 1, perDay: 1 });
    assert.deepEqual(createCounters(s.mb), { creates: 1, chars: row.size }, 'Anlegen je Anschluss gezählt');

    // Gerät: Schlüssel gemerkt (localStorage), Admin-Token und Passwort nirgends gespeichert
    const cloud = await readCloud(page);
    assert.equal(cloud.config.v, 2);
    assert.equal(cloud.config.syncId, expected.syncId);
    assert.equal(cloud.config.version, 1);
    assert.equal(cloud.config.dirty, false);
    assert.equal(cloud.config.pendingCreate, false);
    assert.equal(cloud.config.remember, true);
    assert.equal(cloud.config.pendingAdminHash, undefined, 'Hash des Admin-Tokens nach dem Anlegen entfernt');
    assert.deepEqual(Object.keys(cloud.localKey).sort(), ['authToken', 'device', 'encKey', 'syncId', 'who']);
    assert.equal(cloud.localKey.authToken, expected.authToken);
    assert.equal(cloud.localKey.encKey, expected.encKey);
    assert.equal(cloud.localKey.who, expected.who);
    assert.equal(cloud.sessionKey, null);
    assert.equal(cloud.device, cloud.localKey.device, 'Geräte-Geheimnis dieses Browsers (parentsday.cloudDevice.<Code>)');
    assert.deepEqual(JSON.parse(row.devices), [await hashOf(cloud.localKey.device)], 'Gerät eingetragen (nur Hashwert)');
    const storage = await allStorage(page);
    assert.ok(!storage.includes(PASSWORD), 'Passwort nirgends im Browser gespeichert');
    assert.ok(!storage.includes(expected.adminToken), 'Admin-Token nirgends im Browser gespeichert');
    let content = await decryptStored(s.mb, cloud.localKey);
    assert.equal(content.app, 'ParentsDay');
    assert.equal(content.type, 'cloud-state');
    assert.equal(content.state.teacher.teacherCode, T_CODE);
    assert.equal(content.state.teacher.email, SAMPLE_TEACHER.email);
    assert.equal(content.state.event, null);
    assert.equal(content.eventDraft, null);
    // Die Daten sind an ihre Version gebunden (AAD „ParentsDay-Cloud-v2|syncId|version“)
    const storedCt = rows(s.mb, 'SELECT data FROM backup_chunks WHERE backup_id = ? ORDER BY idx', row.id)
      .map((r) => r.data)
      .join('');
    await assert.rejects(decryptCloudData(expected, { iv: row.iv, ct: storedCt, z: row.z, version: 2 }), 'mit anderer Version nicht zu entschlüsseln');

    // Elternsprechtag eingeben: Schon die noch nicht gespeicherten Eingaben (Entwurf) werden gesichert
    await page.click(tid('reg-continue'));
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(page, 'ok');
    assert.equal(flat(await indicator(page).textContent()), 'In der Cloud gesichert');
    await page.click(tid('event-calendar-next'));
    await page.click(tid('event-calendar-next'));
    await page.click(`${tid('event-calendar')} [data-date="${D1}"]`);
    await page.click(`${tid('event-calendar')} [data-date="${D2}"]`);
    await page.fill(tid('event-address'), 'Gesamtschule Süd\nSchulstraße 1\n12345 Musterstadt');
    await page.fill(tid('event-slot'), '10');
    content = await waitContent(
      s.mb,
      expected,
      (c) => String(c.eventDraft?.slot) === '10' && String(c.eventDraft?.address).startsWith('Gesamtschule Süd') && c.eventDraft.days?.length === 2,
      'Entwurf nicht hochgeladen',
    );
    assert.equal(content.state.event, null, 'noch nicht gespeichert');
    assert.deepEqual(
      content.eventDraft.days.map((d) => d.date),
      [D1, D2],
    );
    await page.click(tid('event-submit'));
    await waitHash(page, '#/lehrkraft/klassen');
    content = await waitContent(s.mb, expected, (c) => c.state.event?.days.length === 2, 'Elternsprechtag nicht hochgeladen');
    assert.deepEqual(
      content.state.event.days.map((d) => d.date),
      [D1, D2],
    );
    assert.equal(content.eventDraft, null, 'Entwurf nach dem Speichern verworfen');
    await waitIndicator(page, 'ok');

    // Klasse anlegen → wird hochgeladen
    await addClass(page, '5a');
    content = await waitContent(s.mb, expected, (c) => classIds(c.state).join() === '5a', 'Klasse nicht hochgeladen');
    await waitIndicator(page, 'ok');
    const after = await readCloud(page);
    const version = cloudRow(s.mb, expected).version;
    assert.ok(version >= 3, `mehrere Stände hochgeladen (Version ${version})`);
    assert.equal(after.config.version, version);
    assert.equal(after.config.dirty, false);
    assert.equal(cloudRow(s.mb, expected).size, chunkRows(s.mb).reduce((n, c) => n + c.len, 0), 'size nach dem Ändern aktualisiert');
    // Nur Speichern ohne inhaltliche Änderung (z. B. Neuladen der Seite) lädt nichts hoch
    await page.reload();
    await page.locator(tid('class-tile-5a')).waitFor();
    await sleep(2500);
    assert.equal(cloudRow(s.mb, expected).version, version);
    assertClean(a, 'Gerät A');
  } finally {
    await s.close();
  }
});

test('Neues Gerät: nach der Anmeldung zuerst „Passwort eingeben“ – falsches Passwort wird abgelehnt, das richtige holt den Stand', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a', '6b'] });
    const stateA = await readState(a.page);
    const expected = await keysFor(PASSWORD);
    assert.deepEqual(attempts(s.mb, expected.who), { perIp: 1, perDay: 1 }, 'Einrichten auf A zählt als Versuch');

    const b = await s.open();
    await fillLogin(b.page, s.web);
    const dlg = b.page.locator(tid('cloud-unlock-dialog'));
    await dlg.waitFor(SLOW);
    assert.equal(await b.page.evaluate(() => location.hash), '#/lehrkraft/anmelden', 'Dialog vor dem Weiterleiten');
    assert.equal(flat(await modalTitle(b.page).textContent()), 'Passwort eingeben');
    assert.match(flat(await dlg.textContent()), /Haben Sie eine Cloud-Sicherung\? Dann geben Sie Ihr Passwort ein – Ihr aktueller Stand wird auf dieses Gerät geholt\./);
    assert.equal(await b.page.isChecked(tid('cloud-unlock-remember')), false, '„Passwort merken“ auf einem weiteren Gerät nicht vorausgewählt');
    assert.equal(flat(await b.page.textContent(tid('cloud-unlock-skip'))), 'Ohne Cloud-Sicherung weiter');
    assert.equal(await b.page.locator(tid('cloud-forgot')).count(), 1);
    assert.equal(await b.page.locator(tid('cloud-unlock-setup')).count(), 1);
    assert.equal(await b.page.locator(tid('cloud-unlock-disconnect')).count(), 0, 'ohne Cloud-Sicherung auf diesem Gerät nichts zu lösen');

    // Ohne Eingabe und mit falschem Passwort: Meldung am Feld, der Dialog bleibt offen
    await b.page.click(tid('cloud-unlock-submit'));
    assert.equal(await b.page.textContent('#cloud-unlock-password-error'), 'Bitte geben Sie Ihr Passwort ein.');
    assert.equal(await wrongPassword(b.page), NOT_FOUND_LOGIN);
    assert.equal(await b.page.getAttribute('#cloud-unlock-password-error', 'role'), 'alert', 'Meldung wird angesagt');
    assert.deepEqual(attempts(s.mb, expected.who), { perIp: 2, perDay: 2 }, 'Fehlversuch gezählt');
    assert.equal(await b.page.evaluate(() => location.hash), '#/lehrkraft/anmelden');

    // Richtiges Passwort (nicht merken) → Stand aus der Cloud, weiter zu den Klassen
    await unlockWith(b.page, PASSWORD);
    await waitHash(b.page, '#/lehrkraft/klassen');
    await toastWith(b.page, LOADED).waitFor();
    await b.page.locator(tid('class-tile-6b')).waitFor();
    assert.deepEqual(await tiles(b.page), ['5a', '6b']);
    const stateB = await readState(b.page);
    assert.deepEqual(stateB.teacher, stateA.teacher, 'auch die E-Mail-Adresse aus der Cloud');
    assert.deepEqual(stateB.event, stateA.event);
    assert.deepEqual(stateB.classes, stateA.classes);
    assert.equal(stateB.savedAt, stateA.savedAt, 'Zeitpunkt der letzten Änderung bleibt erhalten');
    await waitIndicator(b.page, 'ok');
    assert.deepEqual(attempts(s.mb, expected.who), { perIp: 2, perDay: 2 }, 'erfolgreiches Öffnen zählt nicht');
    const row = cloudRow(s.mb, expected);
    assert.equal(JSON.parse(row.devices).length, 2, 'Gerät B eingetragen');
    const cloud = await readCloud(b.page);
    assert.equal(cloud.config.syncId, expected.syncId);
    assert.equal(cloud.config.version, 1);
    assert.equal(cloud.config.dirty, false);
    assert.equal(cloud.config.remember, false);
    assert.equal(cloud.localKey, null, 'Passwort nicht gemerkt: Schlüssel nicht im localStorage');
    assert.equal(cloud.sessionKey?.authToken, expected.authToken, 'Schlüssel nur für diese Sitzung');
    assert.equal(cloud.sessionKey.device, cloud.device, 'Geräte-Geheimnis dieses Browsers (bleibt im localStorage)');
    assert.ok(JSON.parse(row.devices).includes(await hashOf(cloud.device)));
    await sleep(2500);
    assert.equal(cloudRow(s.mb, expected).version, 1, 'übernommener Stand wird nicht wieder hochgeladen');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Abgleich in beide Richtungen: Rückkehr auf die Seite (focus/visibilitychange) und „Jetzt abgleichen“ holen neue Stände und zeichnen die Seite neu', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const b = await deviceUnlocked(s);
    const k = await keysFor(PASSWORD);
    const { syncId } = k;

    // B legt 7c an → wird nach kurzer Pause hochgeladen
    await addClass(b.page, '7c');
    await waitVersion(s.mb, k, 2);
    await waitIndicator(b.page, 'ok');

    // A kehrt auf die Seite zurück → holt den neuen Stand, Hinweis, Seite neu gezeichnet
    let before = a.requests.length;
    await refocus(a.page);
    await toastWith(a.page, FROM_OTHER_DEVICE).waitFor(SLOW);
    await a.page.locator(tid('class-tile-7c')).waitFor(SLOW);
    assert.deepEqual(await tiles(a.page), ['5a', '7c']);
    assert.ok(a.requests.slice(before).includes(`GET ${s.mb.url}/v1/sync/${syncId}?since=1`), 'Abruf mit bekannter Version');
    let cloudA = await readCloud(a.page);
    assert.equal(cloudA.config.version, 2);
    assert.equal(cloudA.config.dirty, false);
    await sleep(2500);
    assert.equal(cloudRow(s.mb, k).version, 2, 'übernommener Stand wird nicht wieder hochgeladen');

    // A legt 8d an; B wird wieder sichtbar (visibilitychange) → holt ihn
    await addClass(a.page, '8d');
    await waitVersion(s.mb, k, 3);
    await b.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await toastWith(b.page, FROM_OTHER_DEVICE).waitFor(SLOW);
    await b.page.locator(tid('class-tile-8d')).waitFor(SLOW);
    assert.deepEqual(await tiles(b.page), ['5a', '7c', '8d']);

    // A legt 9e an; B holt ihn unter „Weitere Einstellungen“ mit „Jetzt abgleichen“
    await goSettings(b.page);
    await b.page.locator(tid('cloud-card')).waitFor();
    assert.equal(flat(await b.page.textContent(tid('cloud-card-state'))), 'In der Cloud gesichert');
    await goClasses(a.page);
    await addClass(a.page, '9e');
    await waitVersion(s.mb, k, 4);
    await b.page.click(tid('cloud-sync-now'));
    await toastWith(b.page, FROM_OTHER_DEVICE).waitFor(SLOW);
    await waitUntil(async () => classIds(await readState(b.page)).join() === '5a,7c,8d,9e', 'B hat den Stand von A nicht übernommen');
    await b.page.locator(tid('cloud-card-state'), { hasText: 'In der Cloud gesichert' }).waitFor(SLOW);

    // Nichts Neues: nur „unverändert“ vom Dienst
    before = b.requests.length;
    await b.page.click(tid('cloud-sync-now'));
    await toastWith(b.page, 'Ihr Stand ist in der Cloud gesichert.').waitFor(SLOW);
    await waitUntil(() => b.requests.slice(before).includes(`GET ${s.mb.url}/v1/sync/${syncId}?since=4`), 'kein Abruf mit Version 4');
    await goClasses(b.page);
    await b.page.locator(tid('class-tile-9e')).waitFor();
    assert.deepEqual(await tiles(b.page), ['5a', '7c', '8d', '9e']);
    cloudA = await readCloud(a.page);
    assert.equal(cloudA.config.version, 4);
    assert.equal((await readCloud(b.page)).config.version, 4);
    assert.equal(cloudRow(s.mb, k).version, 4);
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Konflikt: Gerät A ändert ohne Verbindung, B ändert auch – die Lehrkraft entscheidet, der gewählte Stand gilt auf beiden', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const b = await deviceUnlocked(s);
    const k = await keysFor(PASSWORD);
    const origin = `${s.mb.url}/**`;
    const offline = () => a.page.route(origin, (route) => route.abort('internetdisconnected'));
    const online = () => a.page.unroute(origin);
    const conflict = a.page.locator(tid('cloud-conflict'));

    // Runde 1: A (offline) legt 6b an, B legt 7c an → A behält seinen Stand
    await offline();
    await addClass(a.page, '6b');
    await waitIndicator(a.page, 'offline');
    assert.equal(flat(await a.page.textContent('.cloud-indicator-text')), 'Cloud nicht erreichbar – wird nachgeholt');
    assert.equal(flat(await a.page.textContent(tid('cloud-indicator-action'))), 'Erneut versuchen');
    await addClass(b.page, '7c');
    await waitVersion(s.mb, k, 2);
    await waitIndicator(b.page, 'ok');
    await online();
    await a.page.click(tid('cloud-indicator-action')); // „Erneut versuchen“
    await conflict.waitFor(SLOW);
    assert.equal(flat(await modalTitle(a.page).textContent()), 'Welchen Stand möchten Sie verwenden?');
    assert.ok(flat(await conflict.textContent()).includes(SYNC_CONFLICT));
    assert.match(flat(await a.page.textContent(tid('cloud-choice-local'))), /2 Klassen \(5a, 6b\)/);
    assert.match(flat(await a.page.textContent(tid('cloud-choice-remote'))), /2 Klassen \(5a, 7c\)/);
    assert.equal(flat(await a.page.textContent(`${tid('cloud-choice-remote')} .badge`)), 'empfohlen', 'Stand aus der Cloud ist neuer');
    assert.equal(await a.page.locator(`${tid('cloud-choice-local')} .badge`).count(), 0);
    assert.equal(await a.page.locator(tid('cloud-conflict-backup')).count(), 1, 'Zwischenstand speichern angeboten');
    await waitIndicator(a.page, 'conflict');
    assert.equal(flat(await a.page.textContent('.cloud-indicator-text')), 'Cloud-Sicherung: Entscheidung nötig');
    await a.page.click(tid('cloud-choose-local'));
    await waitVersion(s.mb, k, 3);
    await waitIndicator(a.page, 'ok');
    assert.deepEqual(classIds(await readState(a.page)), ['5a', '6b']);
    let content = await decryptStored(s.mb, await keysOf(a.page));
    assert.deepEqual(classIds(content.state), ['5a', '6b'], 'Stand von A ersetzt den in der Cloud');
    // B holt den Stand von A (7c ist damit verworfen)
    await refocus(b.page);
    await toastWith(b.page, FROM_OTHER_DEVICE).waitFor(SLOW);
    await b.page.locator(tid('class-tile-6b')).waitFor(SLOW);
    assert.deepEqual(await tiles(b.page), ['5a', '6b']);

    // Runde 2: A (offline) legt 8d an, B legt 9e an → A übernimmt den Stand aus der Cloud
    await offline();
    await addClass(a.page, '8d');
    await waitIndicator(a.page, 'offline');
    await addClass(b.page, '9e');
    await waitVersion(s.mb, k, 4);
    await waitIndicator(b.page, 'ok');
    await online();
    await a.page.evaluate(() => window.dispatchEvent(new Event('online'))); // Verbindung wieder da
    await conflict.waitFor(SLOW);
    assert.match(flat(await a.page.textContent(tid('cloud-choice-local'))), /3 Klassen \(5a, 6b, 8d\)/);
    assert.match(flat(await a.page.textContent(tid('cloud-choice-remote'))), /3 Klassen \(5a, 6b, 9e\)/);
    await a.page.click(tid('cloud-choose-remote'));
    await toastWith(a.page, FROM_OTHER_DEVICE).waitFor(SLOW);
    await a.page.locator(tid('class-tile-9e')).waitFor(SLOW);
    assert.deepEqual(await tiles(a.page), ['5a', '6b', '9e'], 'Seite neu gezeichnet');
    await waitIndicator(a.page, 'ok');
    const cloudA = await readCloud(a.page);
    assert.equal(cloudA.config.version, 4);
    assert.equal(cloudA.config.dirty, false);
    await sleep(2500);
    assert.equal(cloudRow(s.mb, k).version, 4, 'A lädt nach der Übernahme nichts hoch');
    content = await decryptStored(s.mb, await keysOf(b.page));
    assert.deepEqual(classIds(content.state), ['5a', '6b', '9e']);
    assert.deepEqual(classIds(await readState(b.page)), ['5a', '6b', '9e']);
    assertClean(a, 'Gerät A', OFFLINE, STATUS(409));
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Leerer Stand verliert ohne Rückfrage; zwei gefüllte Stände beim Öffnen → Konflikt-Dialog, der die Cloud-Sicherung empfiehlt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);

    // A registriert sich: Cloud-Sicherung mit leerem Stand
    const a = await s.open();
    await register(a.page, s.web);
    await a.page.click(tid('reg-continue'));
    await waitHash(a.page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(a.page, 'ok');

    // C (Stand mit 5a) richtet die Cloud-Sicherung mit demselben Passwort ein: Die leere Sicherung wird ohne
    // Rückfrage durch den Stand von C ersetzt.
    const c = await s.open();
    await seedWithoutSession(c.page, s.web, sampleState({ classes: [classOf('5a')] }));
    await fillLogin(c.page, s.web);
    await c.page.locator(tid('cloud-setup-dialog')).waitFor(SLOW);
    await fillNewPassword(c.page, 'cloud-setup', PASSWORD);
    await c.page.click(tid('cloud-setup-submit'));
    await toastWith(c.page, SETUP_DONE).waitFor(SLOW);
    await waitHash(c.page, '#/lehrkraft/klassen');
    await waitVersion(s.mb, k, 2);
    await waitIndicator(c.page, 'ok');
    assert.equal(await c.page.locator(tid('cloud-conflict')).count(), 0, 'keine Rückfrage');
    assert.equal(cloudRows(s.mb).length, 1, 'keine zweite Sicherung');
    assert.deepEqual(classIds((await decryptStored(s.mb, await keysOf(c.page))).state), ['5a']);
    assert.equal(JSON.parse(cloudRow(s.mb, k).devices).length, 2);

    // A (leer) holt den Stand beim Zurückkehren – die Seite „Elternsprechtag erstellen“ wird zu den Einstellungen
    await refocus(a.page);
    await toastWith(a.page, FROM_OTHER_DEVICE).waitFor(SLOW);
    await a.page.locator('.header-nav a[href="#/lehrkraft/klassen"]').waitFor(SLOW);
    await a.page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor(SLOW);
    assert.deepEqual(classIds(await readState(a.page)), ['5a']);

    // E (Stand mit 7c, zuletzt geändert NACH dem in der Cloud) öffnet die vorhandene Sicherung: Beide Stände haben
    // Inhalt → Konflikt-Dialog beim Anmelden; ohne gemeinsamen Stand wird die Cloud-Sicherung empfohlen.
    const e = await s.open();
    await seedWithoutSession(e.page, s.web, sampleState({ classes: [classOf('7c')] }));
    await fillLogin(e.page, s.web);
    await e.page.locator(tid('cloud-setup-dialog')).waitFor(SLOW);
    await e.page.click(tid('cloud-setup-have'));
    await e.page.fill(tid('cloud-unlock-password'), PASSWORD);
    await e.page.click(tid('cloud-unlock-submit'));
    const conflict = e.page.locator(tid('cloud-conflict'));
    await conflict.waitFor(SLOW);
    assert.ok(flat(await conflict.textContent()).includes(LOGIN_CONFLICT));
    assert.match(flat(await e.page.textContent(tid('cloud-choice-local'))), /1 Klasse \(7c\)/);
    assert.match(flat(await e.page.textContent(tid('cloud-choice-remote'))), /1 Klasse \(5a\)/);
    assert.ok(Date.parse((await readState(e.page)).savedAt) > Date.parse((await decryptStored(s.mb, k)).state.savedAt), 'Stand dieses Geräts ist neuer');
    assert.equal(flat(await e.page.textContent(`${tid('cloud-choice-remote')} .badge`)), 'empfohlen', 'beim Anmelden: Cloud-Sicherung empfohlen');
    assert.equal(await e.page.locator(`${tid('cloud-choice-local')} .badge`).count(), 0);
    await e.page.click(tid('cloud-choose-remote'));
    await toastWith(e.page, LOADED).waitFor(SLOW);
    await waitHash(e.page, '#/lehrkraft/klassen');
    await e.page.locator(tid('class-tile-5a')).waitFor(SLOW);
    assert.deepEqual(await tiles(e.page), ['5a']);
    await waitIndicator(e.page, 'ok');
    await sleep(2500);
    assert.equal(cloudRow(s.mb, k).version, 2, 'nichts überschrieben');
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C', STATUS(409));
    assertClean(e, 'Gerät E');
  } finally {
    await s.close();
  }
});

test('Lehrkraft ohne Cloud-Sicherung: nach der Anmeldung zuerst „Einrichten“ (mit „Ich habe schon eine“ und „Später“), beim nächsten Anmelden wieder gefragt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const c = await s.open();
    const { page } = c;
    await seedTeacher(page, s.web.url, sampleState({ classes: [classOf('5a')] }));
    await fillLogin(page, s.web);
    const setupDlg = page.locator(tid('cloud-setup-dialog'));
    await setupDlg.waitFor(SLOW);
    assert.equal(await page.evaluate(() => location.hash), '#/lehrkraft/anmelden', 'Dialog vor dem Weiterleiten');
    assert.equal(flat(await modalTitle(page).textContent()), 'Cloud-Sicherung einrichten');
    assert.ok(flat(await setupDlg.textContent()).includes(SETUP_INTRO));
    assert.equal(flat(await page.textContent(tid('cloud-setup-later'))), 'Später');
    assert.equal(await page.isChecked(tid('cloud-setup-remember')), true);

    // „Ich habe schon eine Cloud-Sicherung“ → „Passwort eingeben“ → „Noch keine? Jetzt einrichten“ → zurück
    await page.click(tid('cloud-setup-have'));
    await page.locator(tid('cloud-unlock-dialog')).waitFor();
    assert.equal(await setupDlg.count(), 0);
    await page.click(tid('cloud-unlock-setup'));
    await setupDlg.waitFor();
    assert.equal(await page.locator(tid('cloud-unlock-dialog')).count(), 0);

    // „Später“: weiter wie bisher, nur in diesem Browser
    await page.click(tid('cloud-setup-later'));
    await waitHash(page, '#/lehrkraft/klassen');
    await waitIndicator(page, 'not-setup');
    assert.equal(flat(await page.textContent('.cloud-indicator-text')), 'Nur in diesem Browser gespeichert');
    assert.equal(flat(await page.textContent(tid('cloud-indicator-action'))), 'Cloud-Sicherung einrichten');
    assert.equal((await readCloud(page)).config, null);
    await addClass(page, '6b');
    await sleep(2500);
    assert.deepEqual(cloudRows(s.mb), [], 'nichts hochgeladen');
    assert.deepEqual(
      c.requests.filter((r) => r.includes('/v1/sync')),
      [],
      'keine Anfrage an die Cloud-Sicherung',
    );
    await goSettings(page);
    await page.locator(tid('cloud-setup')).waitFor();
    assert.equal(flat(await page.textContent(`${tid('cloud-card')} .badge`)), 'Nicht eingerichtet');

    // Abmelden (ohne Cloud-Sicherung: kein „Daten entfernen“)
    await page.locator('.header-actions').getByRole('button', { name: 'Abmelden', exact: true }).click();
    await page.locator('.modal', { hasText: 'Abmelden?' }).waitFor();
    assert.equal(await page.locator(tid('logout-remove')).count(), 0);
    await page.locator('.modal').getByRole('button', { name: 'Abmelden', exact: true }).click();
    await waitHash(page, '#/');

    // Nächste Anmeldung: wieder gefragt – Passwortregeln, dann einrichten
    await fillLogin(page, s.web);
    await setupDlg.waitFor(SLOW);
    await page.fill(tid('cloud-setup-password'), 'zu kurz');
    await page.click(tid('cloud-setup-submit'));
    assert.equal(await page.textContent('#cloud-setup-password-error'), 'Das Passwort muss mindestens 10 Zeichen lang sein.');
    await page.fill(tid('cloud-setup-password'), ' '.repeat(12));
    await page.click(tid('cloud-setup-submit'));
    assert.equal(await page.textContent('#cloud-setup-password-error'), 'Das Passwort darf nicht nur aus Leerzeichen bestehen.');
    await page.fill(tid('cloud-setup-password'), PASSWORD);
    await page.fill(tid('cloud-setup-password2'), PASSWORD.toLowerCase());
    await page.click(tid('cloud-setup-submit'));
    assert.equal(await page.textContent('#cloud-setup-password2-error'), 'Die beiden Passwörter stimmen nicht überein.');
    assert.deepEqual(cloudRows(s.mb), []);
    await page.fill(tid('cloud-setup-password2'), PASSWORD);
    await page.click(tid('cloud-setup-submit'));
    await toastWith(page, SETUP_DONE).waitFor(SLOW);
    await waitHash(page, '#/lehrkraft/klassen');
    await waitIndicator(page, 'ok');
    const k = await keysFor(PASSWORD);
    assert.equal(cloudRow(s.mb, k)?.version, 1);
    assert.deepEqual(classIds((await decryptStored(s.mb, await keysOf(page))).state), ['5a', '6b'], 'Stand dieses Geräts ist gesichert');

    // Passwort gemerkt: Beim nächsten Anmelden kein Dialog
    await logout(page);
    await fillLogin(page, s.web);
    await waitHash(page, '#/lehrkraft/klassen');
    await waitIndicator(page, 'ok');
    await page.locator(tid('class-tile-6b')).waitFor();
    assert.equal(await page.locator('.modal').count(), 0, 'kein Dialog');
    assert.deepEqual(await tiles(page), ['5a', '6b']);
    assertClean(c, 'Gerät');
  } finally {
    await s.close();
  }
});

test('„Ohne Cloud-Sicherung weiter“, später über den Hinweis auf dem leeren Gerät bzw. die Kopfzeile entsperren: Die Seite zeigt danach den geladenen Stand', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    await deviceWithCloud(s, { classes: ['5a'] });
    const b = await s.open();
    const { page } = b;
    await fillLogin(page, s.web);
    await page.locator(tid('cloud-unlock-dialog')).waitFor(SLOW);
    await page.click(tid('cloud-unlock-skip'));
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await page.getByRole('heading', { level: 1, name: 'Elternsprechtag erstellen' }).waitFor();
    await waitIndicator(page, 'not-setup');
    assert.equal(flat(await page.textContent(tid('cloud-indicator-action'))), 'Cloud-Sicherung einrichten');

    // Hinweis „Auf diesem Gerät sind noch keine Daten gespeichert“: Passwort der Cloud-Sicherung oder Zwischenstand
    const hint = page.locator('.evt-empty-device');
    await hint.waitFor();
    assert.match(flat(await hint.textContent()), /holen Sie Ihren Stand mit dem Passwort Ihrer Cloud-Sicherung – oder laden Sie einen Zwischenstand\./);
    assert.equal(flat(await page.textContent(tid('empty-device-unlock'))), 'Passwort der Cloud-Sicherung eingeben');
    assert.equal(await page.locator(tid('empty-device-load')).count(), 1);
    await page.click(tid('empty-device-unlock'));
    const unlock = page.locator(tid('cloud-unlock-dialog'));
    await unlock.waitFor();
    assert.match(flat(await unlock.textContent()), /Geben Sie das Passwort Ihrer Cloud-Sicherung ein – Ihr Stand wird auf dieses Gerät geholt\./);
    assert.equal(await wrongPassword(page), NOT_FOUND_PLAIN);
    await page.click(tid('cloud-unlock-skip')); // „Abbrechen“
    await unlock.waitFor({ state: 'detached' });

    // Kopfzeile: „Cloud-Sicherung einrichten“ → „Ich habe schon eine Cloud-Sicherung“ → Passwort
    await page.click(tid('cloud-indicator-action'));
    await page.locator(tid('cloud-setup-dialog')).waitFor();
    assert.equal(flat(await page.textContent(tid('cloud-setup-later'))), 'Abbrechen');
    await page.click(tid('cloud-setup-have'));
    await unlock.waitFor();
    assert.equal(flat(await page.textContent(tid('cloud-unlock-skip'))), 'Abbrechen');
    assert.equal(await wrongPassword(page), NOT_FOUND_PLAIN);
    await unlockWith(page, PASSWORD);
    await toastWith(page, LOADED).waitFor(SLOW);
    await waitIndicator(page, 'ok');
    const restored = await readState(page);
    assert.equal(restored.event.days.length, 2, 'Stand geladen');
    // Die Seite passt zum geladenen Stand: Kopfzeile mit „Klassen“, statt „Elternsprechtag erstellen“ die Einstellungen
    await page.locator('.header-nav a[href="#/lehrkraft/klassen"]').waitFor(SLOW);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor(SLOW);
    await page.locator(tid('cloud-card')).waitFor();
    assert.equal(await page.locator('.evt-empty-device').count(), 0, 'kein Hinweis mehr');
    await goClasses(page);
    await page.locator(tid('class-tile-5a')).waitFor();
    await sleep(2500);
    assert.equal(cloudRow(s.mb, await keysFor(PASSWORD)).version, 1, 'leerer Stand dieses Geräts überschreibt nichts');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Passwort ändern: nur mit dem bisherigen Passwort; alte Sicherung gelöscht, anderes Gerät fragt nach dem neuen Passwort', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const b = await deviceUnlocked(s, { remember: true });
    const oldKeys = await keysFor(PASSWORD);
    const newKeys = await keysFor(NEW_PASSWORD);
    const oldDeviceA = (await keysOf(a.page)).device;

    await goSettings(a.page);
    await a.page.click(tid('cloud-change-password'));
    const dlg = a.page.locator(tid('cloud-change-dialog'));
    await dlg.waitFor();
    assert.equal(flat(await a.page.textContent(tid('cloud-change-forgot'))), 'Bisheriges Passwort vergessen?');
    // Ohne bisheriges Passwort
    await fillNewPassword(a.page, 'cloud-newpw', NEW_PASSWORD);
    await a.page.click(tid('cloud-change-submit'));
    assert.equal(await a.page.textContent('#cloud-change-current-error'), 'Bitte geben Sie Ihr bisheriges Passwort ein.');
    // Neues Passwort zu kurz
    await a.page.fill(tid('cloud-change-current'), PASSWORD);
    await a.page.fill(tid('cloud-newpw-password'), 'kurz');
    await a.page.click(tid('cloud-change-submit'));
    assert.equal(await a.page.textContent('#cloud-newpw-password-error'), 'Das Passwort muss mindestens 10 Zeichen lang sein.');
    // Falsches bisheriges Passwort
    await a.page.fill(tid('cloud-change-current'), WRONG_PASSWORD);
    await fillNewPassword(a.page, 'cloud-newpw', NEW_PASSWORD);
    await a.page.click(tid('cloud-change-submit'));
    await a.page.locator('#cloud-change-current-error:not([hidden])').waitFor(SLOW);
    assert.equal(await a.page.textContent('#cloud-change-current-error'), 'Das bisherige Passwort ist falsch.');
    await a.page.locator(`${tid('cloud-change-submit')}:not([disabled])`).waitFor(SLOW);
    // Dasselbe Passwort noch einmal
    await a.page.fill(tid('cloud-change-current'), PASSWORD);
    await fillNewPassword(a.page, 'cloud-newpw', PASSWORD);
    await a.page.click(tid('cloud-change-submit'));
    await dlg.locator('.alert-error', { hasText: 'Das neue Passwort ist dasselbe wie das bisherige.' }).waitFor(SLOW);
    await a.page.locator(`${tid('cloud-change-submit')}:not([disabled])`).waitFor(SLOW);
    assert.deepEqual(
      cloudRows(s.mb).map((r) => r.id),
      [rowId(oldKeys)],
      'bisher nichts geändert',
    );

    // Richtig: neue Sicherung unter dem neuen Passwort, die alte ist gelöscht (mit dem Admin-Token)
    await fillNewPassword(a.page, 'cloud-newpw', NEW_PASSWORD);
    await a.page.click(tid('cloud-change-submit'));
    await toastWith(a.page, 'Das Passwort wurde geändert.').waitFor(SLOW);
    await dlg.waitFor({ state: 'detached' });
    assert.equal(await toastWith(a.page, 'Die alte Sicherung wird nach 400 Tagen').count(), 0, 'alte Sicherung gelöscht, nicht nur ersetzt');
    const list = cloudRows(s.mb);
    assert.deepEqual(
      list.map((r) => r.id),
      [rowId(newKeys)],
      'nur noch die neue Sicherung',
    );
    assert.equal(list[0].version, 1);
    assert.equal(list[0].auth_hash, await hashOf(newKeys.authToken));
    assert.equal(list[0].admin_hash, await hashOf(newKeys.adminToken));
    assert.deepEqual(
      [...new Set(chunkRows(s.mb).map((r) => r.backup_id))],
      [rowId(newKeys)],
      'Daten der alten Sicherung gelöscht',
    );
    const keysA = await keysOf(a.page);
    assert.equal(keysA.syncId, newKeys.syncId);
    assert.equal(keysA.authToken, newKeys.authToken);
    assert.equal(keysA.device, oldDeviceA, 'dasselbe Geräte-Geheimnis (dieser Browser)');
    assert.deepEqual(JSON.parse(list[0].devices), [await hashOf(keysA.device)], 'nur Gerät A eingetragen');
    assert.deepEqual(classIds((await decryptStored(s.mb, keysA)).state), ['5a'], 'neu verschlüsselt');
    const cfgA = (await readCloud(a.page)).config;
    assert.equal(cfgA.syncId, newKeys.syncId);
    assert.equal(cfgA.version, 1);
    assert.equal(cfgA.dirty, false);
    assert.equal(cfgA.remember, true);
    await waitIndicator(a.page, 'ok');

    // B kehrt auf die Seite zurück: alte Sicherung abgelehnt (403) → „Passwort nötig“, Schlüssel vergessen
    await refocus(b.page);
    await waitIndicator(b.page, 'needs-password');
    assert.equal(flat(await b.page.textContent('.cloud-indicator-text')), 'Cloud-Sicherung: Passwort nötig');
    assert.equal(await b.page.getAttribute(tid('cloud-indicator'), 'title'), NEEDS_PASSWORD);
    let cloudB = await readCloud(b.page);
    assert.equal(cloudB.localKey, null, 'altes Token vergessen');
    assert.equal(cloudB.sessionKey, null);
    assert.equal(cloudB.config.syncId, oldKeys.syncId, 'Einstellungen bleiben');
    const deviceB = cloudB.device;
    assert.ok(deviceB, 'Geräte-Geheimnis bleibt');
    const requestsB = b.requests.length;
    // Abgleich direkt anstoßen: ohne Schlüssel keine Anfrage
    assert.equal((await syncNow(b.page)).kind, 'needs-password');
    await sleep(500);
    assert.deepEqual(
      b.requests.slice(requestsB).filter((r) => r.includes('/v1/sync')),
      [],
      'kein weiterer Versuch mit dem alten Token',
    );
    // „Passwort eingeben“ in der Kopfzeile
    assert.equal(flat(await b.page.textContent(tid('cloud-indicator-action'))), 'Passwort eingeben');
    await b.page.click(tid('cloud-indicator-action'));
    const unlock = b.page.locator(tid('cloud-unlock-dialog'));
    await unlock.waitFor();
    assert.ok(flat(await unlock.textContent()).includes(NEEDS_PASSWORD));
    assert.equal(flat(await b.page.textContent(tid('cloud-unlock-skip'))), 'Abbrechen');
    assert.equal(await b.page.locator(tid('cloud-unlock-setup')).count(), 0);
    assert.equal(await b.page.isChecked(tid('cloud-unlock-remember')), true, 'wie bisher auf diesem Gerät gemerkt');
    assert.equal(flat(await b.page.textContent(tid('cloud-unlock-disconnect'))), 'Cloud-Sicherung auf diesem Gerät nicht mehr verwenden');
    // Altes Passwort: gibt es nicht mehr; neues Passwort: Stand wird übernommen
    assert.equal(await wrongPassword(b.page, PASSWORD), NOT_FOUND_PLAIN);
    await unlockWith(b.page, NEW_PASSWORD);
    await toastWith(b.page, LOADED).waitFor(SLOW);
    await waitIndicator(b.page, 'ok');
    cloudB = await readCloud(b.page);
    assert.equal(cloudB.config.syncId, newKeys.syncId);
    assert.equal(cloudB.config.remember, true);
    assert.equal(cloudB.localKey.authToken, newKeys.authToken);
    assert.equal(cloudB.localKey.device, deviceB, 'Gerät B behält sein Geräte-Geheimnis');
    assert.deepEqual(
      JSON.parse(cloudRow(s.mb, newKeys).devices).sort(),
      [await hashOf(keysA.device), await hashOf(deviceB)].sort(),
      'Gerät B neu eingetragen',
    );

    // Danach gleichen beide wieder ab: A legt 9e an, B holt es mit „Jetzt abgleichen“
    await goClasses(a.page);
    await addClass(a.page, '9e');
    await waitVersion(s.mb, newKeys, 2);
    await goSettings(b.page);
    await b.page.click(tid('cloud-sync-now'));
    await waitUntil(async () => classIds(await readState(b.page)).join() === '5a,9e', 'B hat den Stand von A nicht übernommen');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', STATUS(403));
  } finally {
    await s.close();
  }
});

test('Passwort vergessen an einem nicht verbundenen Gerät: neue Cloud-Sicherung mit neuem Passwort aus dem Stand dieses Geräts', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const oldKeys = await keysFor(PASSWORD);
    const newKeys = await keysFor(NEW_PASSWORD);

    // Gerät C mit eigenem Stand; das Passwort ist vergessen
    const c = await s.open();
    await seedWithoutSession(c.page, s.web, sampleState({ classes: [classOf('6b'), classOf('7c')] }));
    await fillLogin(c.page, s.web);
    await c.page.locator(tid('cloud-setup-dialog')).waitFor(SLOW);
    await c.page.click(tid('cloud-setup-have'));
    await c.page.locator(tid('cloud-unlock-dialog')).waitFor();
    await c.page.click(tid('cloud-forgot'));
    const dlg = c.page.locator(tid('cloud-forgot-dialog'));
    await dlg.waitFor();
    assert.equal(flat(await modalTitle(c.page).textContent()), 'Passwort vergessen?');
    const text = flat(await dlg.textContent());
    assert.match(text, /Ohne Ihr Passwort lässt sich Ihre Cloud-Sicherung nicht öffnen – auch nicht von ParentsDay\./);
    assert.match(text, /Ist Ihr Passwort noch auf einem anderen Gerät gemerkt, wählen Sie am besten dort „Passwort vergessen\?“ \(unter „Weitere Einstellungen“\)/);
    assert.match(text, /Die alte wird nach 400 Tagen ohne Nutzung automatisch gelöscht\. Geräte, die noch mit ihr verbunden sind, verbinden Sie dort unter „Weitere Einstellungen“ mit „Mit neuem Passwort verbinden“\./);
    assert.match(text, /Stand dieses Geräts: 2 Tage Elternsprechtag, 2 Klassen \(6b, 7c\)\./);
    assert.equal(await c.page.locator(tid('cloud-forgot-move')).count(), 0, 'nicht verbunden: kein Umzug möglich');
    await c.page.click(tid('cloud-forgot-setup'));
    await c.page.locator(tid('cloud-setup-dialog')).waitFor();
    assert.equal(await c.page.locator(tid('cloud-setup-have')).count(), 0);
    await fillNewPassword(c.page, 'cloud-setup', NEW_PASSWORD);
    await c.page.click(tid('cloud-setup-submit'));
    await toastWith(c.page, SETUP_DONE).waitFor(SLOW);
    await waitHash(c.page, '#/lehrkraft/klassen');
    assert.equal(await c.page.locator('.modal').count(), 0, 'alle Dialoge geschlossen');
    await waitIndicator(c.page, 'ok');
    await c.page.locator(tid('class-tile-7c')).waitFor();
    assert.deepEqual(await tiles(c.page), ['6b', '7c'], 'Stand dieses Geräts bleibt');

    // Dienst: die neue Sicherung mit dem Stand von C; die alte bleibt unverändert (bis sie nach 400 Tagen verfällt)
    assert.deepEqual(cloudRows(s.mb).map((r) => r.id).sort(), [rowId(oldKeys), rowId(newKeys)].sort());
    assert.equal(cloudRow(s.mb, newKeys).version, 1);
    assert.equal(cloudRow(s.mb, oldKeys).version, 1);
    assert.deepEqual(classIds((await decryptStored(s.mb, await keysOf(c.page))).state), ['6b', '7c']);
    assert.deepEqual(classIds((await decryptStored(s.mb, await keysOf(a.page))).state), ['5a']);

    // A gleicht weiter mit der alten Sicherung ab
    await refocus(a.page);
    await sleep(1000);
    await waitIndicator(a.page, 'ok');

    // … bis A mit „Mit neuem Passwort verbinden“ zur neuen Sicherung wechselt (zwei verschiedene Stände → Auswahl)
    await goSettings(a.page);
    await a.page.click(tid('cloud-card-relink'));
    const relink = a.page.locator(tid('cloud-unlock-dialog'));
    await relink.waitFor();
    assert.match(flat(await relink.textContent()), /Haben Sie auf einem anderen Gerät eine neue Cloud-Sicherung mit einem neuen Passwort eingerichtet\?/);
    await a.page.fill(tid('cloud-unlock-password'), NEW_PASSWORD);
    await a.page.click(tid('cloud-unlock-submit'));
    await a.page.locator(tid('cloud-conflict')).waitFor(SLOW);
    assert.match(flat(await a.page.textContent(tid('cloud-conflict'))), /Auf diesem Gerät ist ein anderer Stand gespeichert als in Ihrer Cloud-Sicherung\./);
    await a.page.click(tid('cloud-choose-remote'));
    await waitIndicator(a.page, 'ok');
    assert.equal((await keysOf(a.page)).syncId, newKeys.syncId, 'A gleicht jetzt mit der neuen Sicherung ab');
    assert.deepEqual(classIds(await readState(a.page)), ['6b', '7c']);

    // Neues Gerät D: mit dem neuen Passwort ist der Stand von C da
    const d = await deviceUnlocked(s, { password: NEW_PASSWORD });
    await d.page.locator(tid('class-tile-7c')).waitFor();
    assert.deepEqual(await tiles(d.page), ['6b', '7c']);
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C');
    assertClean(d, 'Gerät D');
  } finally {
    await s.close();
  }
});

test('Passwort vergessen an einem verbundenen Gerät: Die Sicherung zieht unter ein neues Passwort um, das andere Gerät fragt mit Hinweis danach', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const b = await deviceUnlocked(s, { remember: true });
    const oldKeys = await keysFor(PASSWORD);
    const newKeys = await keysFor(NEW_PASSWORD);
    const deviceA = (await readCloud(a.page)).device;

    // Auch aus „Passwort ändern“ erreichbar: „Bisheriges Passwort vergessen?“ → „Passwort vergessen?“
    await goSettings(a.page);
    await a.page.click(tid('cloud-change-password'));
    await a.page.locator(tid('cloud-change-dialog')).waitFor();
    await a.page.click(tid('cloud-change-forgot'));
    const forgot = a.page.locator(tid('cloud-forgot-dialog'));
    await forgot.waitFor();
    assert.equal(await a.page.locator(tid('cloud-change-dialog')).count(), 0, '„Passwort ändern“ geschlossen');
    assert.equal(flat(await modalTitle(a.page).textContent()), 'Passwort vergessen?');
    assert.match(flat(await forgot.textContent()), /Dieses Gerät ist aber noch mit Ihrer Cloud-Sicherung verbunden\. Sie können hier ein neues Passwort festlegen: Ihr Stand zieht dann in eine neue Sicherung um\./);
    assert.equal(flat(await a.page.textContent(tid('cloud-forgot-move'))), 'Neues Passwort festlegen');
    assert.equal(await a.page.locator(tid('cloud-forgot-setup')).count(), 0, 'verbunden: keine zweite, getrennte Sicherung');
    await a.page.click(tid('cloud-forgot-cancel'));
    await forgot.waitFor({ state: 'detached' });

    // Inzwischen ändert B etwas – der Umzug gleicht vorher ab, damit nichts verloren geht
    await addClass(b.page, '7c');
    await waitVersion(s.mb, oldKeys, 2);
    await waitIndicator(b.page, 'ok');

    // Karte „Cloud-Sicherung“: „Passwort vergessen?“ → „Neues Passwort festlegen“
    await a.page.click(tid('cloud-card-forgot'));
    await forgot.waitFor();
    await a.page.click(tid('cloud-forgot-move'));
    const move = a.page.locator(tid('cloud-move-dialog'));
    await move.waitFor();
    assert.equal(flat(await modalTitle(a.page).textContent()), 'Neues Passwort festlegen');
    await fillNewPassword(a.page, 'cloud-move', 'kurz');
    await a.page.click(tid('cloud-move-submit'));
    assert.equal(await a.page.textContent('#cloud-move-password-error'), 'Das Passwort muss mindestens 10 Zeichen lang sein.');
    await fillNewPassword(a.page, 'cloud-move', PASSWORD);
    await a.page.click(tid('cloud-move-submit'));
    await move.locator('.alert-error', { hasText: 'Das neue Passwort ist dasselbe wie das bisherige.' }).waitFor(SLOW);
    await a.page.locator(`${tid('cloud-move-submit')}:not([disabled])`).waitFor(SLOW);
    assert.equal(cloudRows(s.mb).length, 1, 'bisher nichts geändert');
    await fillNewPassword(a.page, 'cloud-move', NEW_PASSWORD);
    await a.page.click(tid('cloud-move-submit'));
    await toastWith(a.page, 'Das neue Passwort gilt ab sofort. Ihre anderen Geräte fragen einmal danach.').waitFor(SLOW);
    await move.waitFor({ state: 'detached' });
    assert.equal(await a.page.locator('.modal').count(), 0, 'alle Dialoge geschlossen');

    // Dienst: neue Sicherung mit dem abgeglichenen Stand (auch 7c von B); die alte enthält nur noch den Hinweis „umgezogen“
    assert.deepEqual(cloudRows(s.mb).map((r) => r.id).sort(), [rowId(oldKeys), rowId(newKeys)].sort());
    assert.equal(cloudRow(s.mb, newKeys).version, 1);
    assert.equal(cloudRow(s.mb, newKeys).admin_hash, await hashOf(newKeys.adminToken));
    assert.deepEqual(JSON.parse(cloudRow(s.mb, newKeys).devices), [await hashOf(deviceA)], 'nur Gerät A eingetragen');
    assert.deepEqual(classIds((await decryptStored(s.mb, newKeys)).state), ['5a', '7c'], 'vor dem Umzug abgeglichen');
    assert.equal(cloudRow(s.mb, oldKeys).version, 3);
    assert.deepEqual(await decryptStored(s.mb, oldKeys), { app: 'ParentsDay', type: 'cloud-moved', v: 1 }, 'alte Sicherung: nur der Hinweis');
    const cloudA = await readCloud(a.page);
    assert.equal(cloudA.config.syncId, newKeys.syncId);
    assert.equal(cloudA.config.version, 1);
    assert.equal(cloudA.config.dirty, false);
    assert.equal(cloudA.config.remember, true);
    assert.equal(cloudA.localKey.authToken, newKeys.authToken);
    assert.equal(cloudA.localKey.device, deviceA);
    assert.deepEqual(classIds(await readState(a.page)), ['5a', '7c']);
    await waitIndicator(a.page, 'ok');

    // B: Der Hinweis in der alten Sicherung → „Passwort nötig“ mit Erklärung; Stand und Einstellungen bleiben
    await refocus(b.page);
    await waitIndicator(b.page, 'needs-password');
    assert.equal(await b.page.getAttribute(tid('cloud-indicator'), 'title'), MOVED);
    let cloudB = await readCloud(b.page);
    assert.equal(cloudB.localKey, null, 'alte Schlüssel vergessen');
    assert.equal(cloudB.config.syncId, oldKeys.syncId);
    assert.deepEqual(classIds(await readState(b.page)), ['5a', '7c']);
    await b.page.click(tid('cloud-indicator-action'));
    const unlock = b.page.locator(tid('cloud-unlock-dialog'));
    await unlock.waitFor();
    assert.ok(flat(await unlock.textContent()).includes(MOVED));
    assert.equal(await b.page.isChecked(tid('cloud-unlock-remember')), true, 'wie bisher gemerkt');
    // Altes Passwort: passende Meldung (die Sicherung gibt es noch, aber sie ist umgezogen)
    assert.equal(await wrongPassword(b.page, PASSWORD), MOVED_OLD_PASSWORD);
    await unlockWith(b.page, NEW_PASSWORD);
    await toastWith(b.page, LOADED).waitFor(SLOW);
    await waitIndicator(b.page, 'ok');
    cloudB = await readCloud(b.page);
    assert.equal(cloudB.config.syncId, newKeys.syncId);
    assert.equal(cloudB.localKey.authToken, newKeys.authToken);
    assert.deepEqual(classIds(await readState(b.page)), ['5a', '7c']);
    assert.equal(JSON.parse(cloudRow(s.mb, newKeys).devices).length, 2, 'Gerät B eingetragen');
    assert.equal(cloudRow(s.mb, oldKeys).version, 3, 'alte Sicherung unverändert');

    // Beide gleichen mit der neuen Sicherung ab
    await goClasses(a.page);
    await addClass(a.page, '8d');
    await waitVersion(s.mb, newKeys, 2);
    await goSettings(b.page);
    await b.page.click(tid('cloud-sync-now'));
    await waitUntil(async () => classIds(await readState(b.page)).join() === '5a,7c,8d', 'B hat den Stand von A nicht übernommen');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Cloud-Sicherung löschen (Karte unter „Weitere Einstellungen“) nur mit Passwort; das andere Gerät fragt danach nach dem Passwort', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const b = await deviceUnlocked(s);
    const k = await keysFor(PASSWORD);

    await goSettings(a.page);
    await a.page.click(tid('cloud-delete'));
    const dlg = a.page.locator(tid('cloud-delete-dialog'));
    await dlg.waitFor();
    assert.equal(flat(await modalTitle(a.page).textContent()), 'Cloud-Sicherung löschen?');
    await a.page.click(tid('cloud-delete-submit'));
    assert.equal(await a.page.textContent('#cloud-delete-password-error'), 'Bitte geben Sie Ihr Passwort ein.');
    await a.page.fill(tid('cloud-delete-password'), WRONG_PASSWORD);
    await a.page.click(tid('cloud-delete-submit'));
    await a.page.locator('#cloud-delete-password-error:not([hidden])').waitFor(SLOW);
    assert.equal(await a.page.textContent('#cloud-delete-password-error'), 'Das Passwort ist falsch.');
    await a.page.locator(`${tid('cloud-delete-submit')}:not([disabled])`).waitFor(SLOW);
    assert.ok(cloudRow(s.mb, k), 'noch vorhanden');

    await a.page.fill(tid('cloud-delete-password'), PASSWORD);
    await a.page.click(tid('cloud-delete-submit'));
    await toastWith(a.page, 'Die Cloud-Sicherung wurde gelöscht.').waitFor(SLOW);
    await dlg.waitFor({ state: 'detached' });
    assert.deepEqual(cloudRows(s.mb), [], 'Cloud-Sicherung gelöscht');
    assert.deepEqual(chunkRows(s.mb), [], 'auch die Daten');
    await waitIndicator(a.page, 'not-setup');
    assert.equal(flat(await a.page.textContent(`${tid('cloud-card')} .badge`)), 'Nicht eingerichtet');
    await a.page.locator(tid('cloud-setup')).waitFor();
    const cloudA = await readCloud(a.page);
    assert.deepEqual(cloudA, { config: null, localKey: null, sessionKey: null, device: null });
    assert.deepEqual(classIds(await readState(a.page)), ['5a'], 'Stand in diesem Browser bleibt');

    // B merkt es beim nächsten Abgleich: Stand bleibt, „Passwort nötig“
    await refocus(b.page);
    await waitIndicator(b.page, 'needs-password');
    assert.deepEqual(classIds(await readState(b.page)), ['5a']);
    await goSettings(b.page);
    const card = b.page.locator(tid('cloud-card'));
    await card.getByText(NEEDS_PASSWORD).waitFor();
    assert.equal(flat(await card.locator('.badge').textContent()), 'Passwort nötig');
    assert.equal(await card.locator(tid('cloud-card-forgot')).count(), 1);
    assert.equal(flat(await card.locator(tid('cloud-card-disconnect')).textContent()), 'Nicht mehr verwenden');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', STATUS(403));
  } finally {
    await s.close();
  }
});

test('Sicherung auf einem anderen Gerät gelöscht: „Cloud-Sicherung auf diesem Gerät nicht mehr verwenden“ im Dialog „Passwort eingeben“ löst das Gerät', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const b = await deviceUnlocked(s, { remember: true });
    const { page } = b;

    // A löscht die Sicherung
    await goSettings(a.page);
    await a.page.click(tid('cloud-delete'));
    await a.page.fill(tid('cloud-delete-password'), PASSWORD);
    await a.page.click(tid('cloud-delete-submit'));
    await toastWith(a.page, 'Die Cloud-Sicherung wurde gelöscht.').waitFor(SLOW);
    assert.deepEqual(cloudRows(s.mb), []);

    // B: „Passwort nötig“ → Dialog; das bisherige Passwort passt nicht mehr
    await refocus(page);
    await waitIndicator(page, 'needs-password');
    await page.click(tid('cloud-indicator-action'));
    const unlock = page.locator(tid('cloud-unlock-dialog'));
    await unlock.waitFor();
    assert.equal(await wrongPassword(page, PASSWORD), NOT_FOUND_PLAIN);
    const link = page.locator(tid('cloud-unlock-disconnect'));
    assert.equal(flat(await link.textContent()), 'Cloud-Sicherung auf diesem Gerät nicht mehr verwenden');

    // Rückfrage – zuerst abbrechen: nichts geändert, der Dialog „Passwort eingeben“ ist noch da
    await link.click();
    const confirm = page.locator('.modal', { hasText: 'Cloud-Sicherung nicht mehr verwenden?' });
    await confirm.waitFor();
    assert.match(flat(await confirm.textContent()), /Ihr Stand in diesem Browser bleibt erhalten\. Die Cloud-Sicherung selbst wird dadurch nicht gelöscht\./);
    await confirm.getByRole('button', { name: 'Abbrechen' }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal(await unlock.count(), 1);
    assert.ok((await readCloud(page)).config, 'noch eingerichtet');

    // Bestätigen: Gerät gelöst, Stand bleibt, keine Anfragen mehr an die Cloud-Sicherung
    await link.click();
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Nicht mehr verwenden' }).click();
    await unlock.waitFor({ state: 'detached' });
    await toastWith(page, 'Dieses Gerät verwendet die Cloud-Sicherung nicht mehr.').waitFor();
    await waitIndicator(page, 'not-setup');
    assert.equal(flat(await page.textContent(tid('cloud-indicator-action'))), 'Cloud-Sicherung einrichten');
    assert.deepEqual(await readCloud(page), { config: null, localKey: null, sessionKey: null, device: null });
    assert.deepEqual(classIds(await readState(page)), ['5a'], 'Stand bleibt');
    const before = b.requests.length;
    await refocus(page);
    await syncNow(page);
    await sleep(500);
    assert.deepEqual(
      b.requests.slice(before).filter((r) => r.includes('/v1/sync')),
      [],
      'keine Anfrage an die Cloud-Sicherung',
    );
    await goSettings(page);
    await page.locator(tid('cloud-setup')).waitFor();
    assert.equal(flat(await page.textContent(`${tid('cloud-card')} .badge`)), 'Nicht eingerichtet');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', STATUS(403));
  } finally {
    await s.close();
  }
});

test('Abmelden mit „Meine Daten von diesem Gerät entfernen“: letzte Änderung wird noch gesichert, beim nächsten Anmelden ist alles wieder da', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const b = await deviceUnlocked(s);
    const { page } = b;
    const k = await keysFor(PASSWORD);

    // Änderung direkt vor dem Abmelden (vor dem verzögerten Hochladen)
    await addClass(page, '6b');
    await page.locator('.header-actions').getByRole('button', { name: 'Abmelden', exact: true }).click();
    const dlg = page.locator('.modal', { hasText: 'Abmelden?' });
    await dlg.waitFor();
    assert.match(flat(await dlg.textContent()), /Ihr Stand ist in Ihrer Cloud-Sicherung\./);
    assert.equal(await page.isChecked(tid('logout-remove')), false, 'nicht vorausgewählt');
    await page.check(tid('logout-remove'));
    await dlg.getByRole('button', { name: 'Abmelden', exact: true }).click();
    await waitHash(page, '#/');
    await toastWith(page, 'Ihre Daten wurden von diesem Gerät entfernt. Ihre Cloud-Sicherung bleibt erhalten.').waitFor();
    assert.equal(cloudRow(s.mb, k).version, 2, 'Änderung vor dem Abmelden gesichert');
    assert.deepEqual(await teacherKeys(page), [], 'nichts mehr von der Lehrkraft auf dem Gerät (auch kein Geräte-Geheimnis)');

    // Lehrkraft-Seite führt zur Anmeldung; mit Passwort ist alles wieder da
    await page.goto(`${s.web.url}#/lehrkraft/klassen`);
    await waitHash(page, '#/lehrkraft/anmelden');
    await fillLogin(page, s.web);
    await unlockWith(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/klassen');
    await page.locator(tid('class-tile-6b')).waitFor();
    assert.deepEqual(await tiles(page), ['5a', '6b']);
    await waitIndicator(page, 'ok');

    // Abmelden ohne „entfernen“: Stand und Geräte-Geheimnis bleiben, das nicht gemerkte Passwort nicht
    const device = (await readCloud(page)).device;
    await logout(page);
    let cloud = await readCloud(page);
    assert.deepEqual(classIds(await readState(page)), ['5a', '6b']);
    assert.ok(cloud.config, 'Einstellungen bleiben');
    assert.equal(cloud.localKey, null);
    assert.equal(cloud.sessionKey, null, 'Schlüssel vergessen');
    assert.equal(cloud.device, device, 'Geräte-Geheimnis bleibt');
    await fillLogin(page, s.web);
    await page.locator(tid('cloud-unlock-dialog')).waitFor(SLOW);
    assert.equal(await page.isChecked(tid('cloud-unlock-remember')), false, 'bisher nicht gemerkt');
    await unlockWith(page, PASSWORD, { remember: true });
    await waitHash(page, '#/lehrkraft/klassen');
    await waitIndicator(page, 'ok');
    cloud = await readCloud(page);
    assert.ok(cloud.localKey, 'jetzt gemerkt');
    assert.equal(cloud.localKey.device, device);
    assert.equal(cloud.config.remember, true);
    assert.equal(cloudRow(s.mb, k).version, 2);
    assert.equal(JSON.parse(cloudRow(s.mb, k).devices).length, 3, 'A, B vor und B nach „Daten entfernen“');

    // A (Passwort gemerkt) meldet sich ab; B ändert; A meldet sich wieder an → ohne Dialog gleich der neue Stand
    await logout(a.page);
    await addClass(page, '7c');
    await waitVersion(s.mb, k, 3);
    await fillLogin(a.page, s.web);
    await waitHash(a.page, '#/lehrkraft/klassen');
    await a.page.locator(tid('class-tile-7c')).waitFor(SLOW);
    assert.deepEqual(await tiles(a.page), ['5a', '6b', '7c']);
    assert.equal(await a.page.locator('.modal').count(), 0, 'kein Dialog');
    await waitIndicator(a.page, 'ok');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Ohne Verbindung: Abmelden trotz „Daten entfernen“ behält den Stand; Registrierung legt die Sicherung später an', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const mailbox = `${s.mb.url}/**`;

    // Registrierung ohne Verbindung: eingerichtet, hochgeladen wird später
    const a = await s.open();
    await a.page.route(mailbox, (route) => route.abort('internetdisconnected'));
    await register(a.page, s.web);
    assert.match(flat(await a.page.textContent(tid('reg-cloud-note'))), /^Cloud-Sicherung eingerichtet\. Die Cloud-Sicherung ist gerade nicht erreichbar – Ihr Stand wird hochgeladen, sobald eine Verbindung besteht\./);
    let cloud = await readCloud(a.page);
    assert.equal(cloud.config.pendingCreate, true);
    assert.ok(cloud.localKey, 'Schlüssel gemerkt');
    assert.deepEqual(cloudRows(s.mb), []);
    await a.page.click(tid('reg-continue'));
    await waitHash(a.page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(a.page, 'offline');
    await a.page.unroute(mailbox);
    await a.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitVersion(s.mb, k, 1);
    await waitIndicator(a.page, 'ok');
    cloud = await readCloud(a.page);
    assert.equal(cloud.config.pendingCreate, false);
    assert.equal(cloud.config.pendingAdminHash, undefined);
    assert.equal(cloudRow(s.mb, k).admin_hash, await hashOf(k.adminToken), 'Admin-Hash aus der Registrierung');

    // Gerät B ohne Verbindung: Änderung, Abmelden mit „Daten entfernen“ → Rückfrage, Stand bleibt
    // (Die Sicherung enthält noch keinen Elternsprechtag – B landet bei „Elternsprechtag erstellen“.)
    const b = await s.open();
    const { page } = b;
    await fillLogin(page, s.web);
    await unlockWith(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(page, 'ok');
    await page.route(mailbox, (route) => route.abort('internetdisconnected'));
    await page.click(tid('event-calendar-next'));
    await page.click(tid('event-calendar-next'));
    await page.click(`${tid('event-calendar')} [data-date="${D1}"]`);
    await page.fill(tid('event-address'), 'Gesamtschule Süd');
    await page.click(tid('event-submit'));
    await waitHash(page, '#/lehrkraft/klassen');
    await page.locator('.header-actions').getByRole('button', { name: 'Abmelden', exact: true }).click();
    const dlg = page.locator('.modal', { hasText: 'Abmelden?' });
    await dlg.waitFor();
    await page.check(tid('logout-remove'));
    await dlg.getByRole('button', { name: 'Abmelden', exact: true }).click();
    const warn = page.locator('.modal', { hasText: 'Noch nicht in der Cloud gesichert' });
    await warn.waitFor(SLOW);
    assert.match(flat(await warn.textContent()), /Deshalb bleiben Ihre Daten auf diesem Gerät\. Beim nächsten Anmelden hier werden sie gesichert\./);
    await warn.getByRole('button', { name: 'Trotzdem abmelden' }).click();
    await waitHash(page, '#/');
    assert.equal(await toastWith(page, 'Ihre Daten wurden von diesem Gerät entfernt').count(), 0);
    assert.deepEqual(
      (await readState(page)).event.days.map((d) => d.date),
      [D1],
      'Stand bleibt auf dem Gerät',
    );
    cloud = await readCloud(page);
    assert.equal(cloud.config?.dirty, true, 'Änderung als nicht gesichert vermerkt');
    assert.equal(cloud.sessionKey, null, 'nicht gemerktes Passwort trotzdem vergessen');
    assert.equal(cloudRow(s.mb, k).version, 1);

    // Wieder mit Verbindung: Anmelden, Passwort → der Stand dieses Geräts ist weiter und wird ohne Rückfrage hochgeladen
    await page.unroute(mailbox);
    await fillLogin(page, s.web);
    await unlockWith(page, PASSWORD);
    await toastWith(page, 'Die Cloud-Sicherung ist verbunden. Der Stand von diesem Gerät wird gesichert.').waitFor(SLOW);
    await waitHash(page, '#/lehrkraft/klassen');
    await waitVersion(s.mb, k, 2);
    await waitIndicator(page, 'ok');
    assert.deepEqual(
      (await decryptStored(s.mb, await keysOf(page))).state.event.days.map((d) => d.date),
      [D1],
    );
    assertClean(a, 'Gerät A', OFFLINE);
    assertClean(b, 'Gerät B', OFFLINE);
  } finally {
    await s.close();
  }
});

test('„Alle Daten in diesem Browser löschen“ sichert vorher noch offene Änderungen; die Cloud-Sicherung bleibt, beim nächsten Anmelden ist der Stand wieder da', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a', '6b'] });
    const { page } = a;
    const k = await keysFor(PASSWORD);
    // Änderung direkt vor dem Löschen (vor dem verzögerten Hochladen)
    await addClass(page, '7c');
    await goSettings(page);
    assert.doesNotMatch(flat(await page.textContent('.evt-danger')), /Cloud-Sicherung/);
    const dlg = await openDeleteAll(page);
    assert.equal(flat(await dlg.locator(tid('delete-all-cloud-note')).textContent()), DELETE_ALL_COMPLETE);
    assert.equal(await dlg.locator(`.alert ${tid('delete-all-cloud-note')}`).count(), 0, 'keine Warnung');
    assert.equal(cloudRow(s.mb, k).version, 2, 'Änderung vorher gesichert');
    assert.deepEqual(classIds((await decryptStored(s.mb, k)).state), ['5a', '6b', '7c']);
    await dlg.getByRole('button', { name: 'Endgültig löschen' }).click();
    await waitHash(page, '#/');
    await toastWith(page, 'Ihre Daten wurden aus diesem Browser gelöscht.').waitFor();
    assert.deepEqual(await teacherKeys(page), [], 'nichts mehr von der Lehrkraft im Browser');
    const row = cloudRow(s.mb, k);
    assert.ok(row, 'Cloud-Sicherung bleibt');
    assert.equal(row.version, 2);

    // Wieder anmelden: leeres Gerät → Passwort → Stand aus der Cloud
    await fillLogin(page, s.web);
    await unlockWith(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/klassen');
    await page.locator(tid('class-tile-7c')).waitFor();
    assert.deepEqual(await tiles(page), ['5a', '6b', '7c']);
    await waitIndicator(page, 'ok');
    await sleep(2500);
    assert.equal(cloudRow(s.mb, k).version, 2);
    assertClean(a, 'Gerät A');
  } finally {
    await s.close();
  }
});

test('„Alle Daten in diesem Browser löschen“ ohne Verbindung: Warnung, dass nicht gesicherte Änderungen verloren gehen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const { page } = a;
    const k = await keysFor(PASSWORD);
    const mailbox = `${s.mb.url}/**`;

    // Ohne Verbindung: 6b ist nur auf diesem Gerät
    await page.route(mailbox, (route) => route.abort('internetdisconnected'));
    await addClass(page, '6b');
    await waitIndicator(page, 'offline');
    await goSettings(page);
    let dlg = await openDeleteAll(page);
    const note = dlg.locator(tid('delete-all-cloud-note'));
    assert.equal(flat(await note.textContent()), DELETE_ALL_INCOMPLETE);
    assert.equal(await dlg.locator(`.alert-warning ${tid('delete-all-cloud-note')}`).count(), 1, 'als Warnung');
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await dlg.waitFor({ state: 'detached' });
    assert.deepEqual(classIds(await readState(page)), ['5a', '6b'], 'nichts gelöscht');
    assert.equal(cloudRow(s.mb, k).version, 1, '6b nicht in der Cloud');
    assert.equal((await readCloud(page)).config.dirty, true);

    // Wieder mit Verbindung: Beim Öffnen des Dialogs wird zuerst gesichert – dann bleibt die Cloud-Sicherung vollständig
    await page.unroute(mailbox);
    dlg = await openDeleteAll(page);
    assert.equal(flat(await dlg.locator(tid('delete-all-cloud-note')).textContent()), DELETE_ALL_COMPLETE);
    assert.equal(cloudRow(s.mb, k).version, 2);
    assert.deepEqual(classIds((await decryptStored(s.mb, k)).state), ['5a', '6b']);
    await dlg.getByRole('button', { name: 'Abbrechen' }).click();
    await waitIndicator(page, 'ok');
    assertClean(a, 'Gerät A', OFFLINE);
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung an einem neuen Gerät mit gleichem Passwort: Stand wird geladen, die neu eingegebene E-Mail-Adresse bleibt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);

    const b = await s.open();
    const reg = await register(b.page, s.web, { email: NEW_EMAIL });
    assert.equal(pdfPayload(reg.buffer).email, NEW_EMAIL);
    assert.match(flat(await b.page.textContent(tid('reg-cloud-note'))), /^Ihre Cloud-Sicherung wurde geladen\. Mit diesem Passwort gab es schon eine Cloud-Sicherung/);
    assert.equal(flat(await b.page.textContent(tid('reg-continue'))), 'Weiter zu Ihren Klassen');
    assert.match(flat(await b.page.textContent('.tauth-summary')), /anna\.neu@schule\.example/);
    const stateB = await readState(b.page);
    assert.deepEqual(classIds(stateB), ['5a']);
    assert.equal(stateB.teacher.email, NEW_EMAIL, 'neu eingegebene E-Mail-Adresse');
    assert.equal(cloudRows(s.mb).length, 1, 'keine zweite Sicherung');

    // Die neue Adresse wird hochgeladen; A übernimmt sie
    await waitVersion(s.mb, k, 2);
    assert.equal((await decryptStored(s.mb, await keysOf(b.page))).state.teacher.email, NEW_EMAIL);
    await b.page.click(tid('reg-continue'));
    await waitHash(b.page, '#/lehrkraft/klassen');
    await b.page.locator(tid('class-tile-5a')).waitFor();
    await waitIndicator(b.page, 'ok');
    await refocus(a.page);
    await toastWith(a.page, FROM_OTHER_DEVICE).waitFor(SLOW);
    await waitUntil(async () => (await readState(a.page)).teacher.email === NEW_EMAIL, 'A hat die neue E-Mail-Adresse nicht übernommen');
    await a.page.locator(tid('class-tile-5a')).waitFor();
    assert.deepEqual(await tiles(a.page), ['5a']);
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', STATUS(409));
  } finally {
    await s.close();
  }
});

test('Dienst ohne Cloud-Sicherung (ältere Fassung): Registrierung und Anmeldung laufen ohne blockierende Dialoge', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const origin = new URL(s.web.url).origin;
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    // Ältere Fassung des Dienstes: /v1/health ohne „sync“, /v1/sync/… gibt es nicht (404 wie jede unbekannte Adresse)
    const oldService = async (d) => {
      await d.context.route(`${s.mb.url}/v1/health`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: cors, body: JSON.stringify({ ok: true, service: 'ParentsDay-Briefkasten', version: 2 }) }),
      );
      await d.context.route(`${s.mb.url}/v1/sync/**`, (route) =>
        route.fulfill({ status: 404, contentType: 'application/json; charset=utf-8', headers: cors, body: JSON.stringify({ error: 'not-found' }) }),
      );
    };

    // Registrierung mit Passwort
    const a = await s.open();
    await oldService(a);
    const { page } = a;
    const reg = await register(page, s.web);
    assert.equal(pdfPayload(reg.buffer).teacherCode, T_CODE, 'Registrierungs-PDF wie immer');
    assert.match(flat(await page.textContent(tid('reg-cloud-note'))), /Ihr Stand wird hochgeladen, sobald eine Verbindung besteht\./);
    assert.equal(await page.locator('.modal').count(), 0);
    const { syncId } = await keysFor(PASSWORD);
    assert.ok(a.requests.includes(`PUT ${s.mb.url}/v1/sync/${syncId}`), 'Anlegen versucht');
    await page.click(tid('reg-continue'));
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(page, 'unsupported');
    assert.equal(flat(await page.textContent('.cloud-indicator-text')), 'Cloud-Sicherung noch nicht verfügbar');
    assert.equal(await page.locator('.modal').count(), 0);
    assert.equal((await readCloud(page)).config.pendingCreate, true, 'wird später angelegt');
    assert.deepEqual(cloudRows(s.mb), []);

    // Neues Gerät: Anmeldung ohne Dialog und ohne Warnung
    const b = await s.open();
    await oldService(b);
    await fillLogin(b.page, s.web);
    await waitHash(b.page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(b.page, 'not-setup');
    assert.equal(await b.page.locator('.modal').count(), 0);
    assert.equal(await toastWith(b.page, 'nicht erreichbar').count(), 0);
    assert.ok(b.requests.includes(`GET ${s.mb.url}/v1/health`), 'Dienst wurde gefragt');

    // Lehrkraft mit Stand (ohne Cloud-Sicherung): kein Angebot zum Einrichten
    const c = await s.open();
    await oldService(c);
    await seedWithoutSession(c.page, s.web, sampleState({ classes: [classOf('5a')] }));
    await fillLogin(c.page, s.web);
    await waitHash(c.page, '#/lehrkraft/klassen');
    await waitIndicator(c.page, 'not-setup');
    await c.page.locator(tid('class-tile-5a')).waitFor();
    assert.equal(await c.page.locator('.modal').count(), 0);
    assert.deepEqual(await tiles(c.page), ['5a']);
    assert.deepEqual(
      c.requests.filter((r) => r.includes('/v1/sync')),
      [],
    );
    for (const [label, d] of [
      ['Gerät A', a],
      ['Gerät B', b],
      ['Gerät C', c],
    ]) {
      assertClean(d, label, STATUS(404));
    }
  } finally {
    await s.close();
  }
});

test('Sperre nach 10 Versuchen je Stunde und Anschluss (das Einrichten zählt mit): deutliche Meldung, auch das richtige Passwort wird dann abgewiesen; verbundene Geräte gleichen weiter ab', { timeout: TEST_TIMEOUT + 180000 }, async () => {
  // Die Versuche werden je Stunde gezählt – nicht kurz vor einem Stundenwechsel beginnen.
  const toNextHour = 3600000 - (Date.now() % 3600000);
  if (toNextHour < 150000) await sleep(toNextHour + 2000);
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const k = await keysFor(PASSWORD);
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 1, perDay: 1 }, 'Einrichten auf A');
    const b = await s.open();
    const { page } = b;
    await fillLogin(page, s.web);
    await page.locator(tid('cloud-unlock-dialog')).waitFor(SLOW);
    for (let i = 1; i <= 9; i++) {
      assert.equal(await wrongPassword(page, `${WRONG_PASSWORD} ${i}`), NOT_FOUND_LOGIN, `Versuch ${i}`);
    }
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 10, perDay: 10 });

    // 11. Versuch – mit dem richtigen Passwort: gesperrt
    const message = await lockedPassword(page, PASSWORD);
    assert.match(message, LOCKED);
    assert.match(message, /für (eine Minute|\d+ Minuten) gesperrt/, 'bis zum Ende der Stunde');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 10, perDay: 10 }, 'abgewiesene Versuche zählen nicht weiter');
    assert.equal(JSON.parse(cloudRow(s.mb, k).devices).length, 1, 'Gerät B nicht eingetragen');

    // Ohne Cloud-Sicherung weiter: leeres Gerät – auch über den Hinweis dort bleibt es gesperrt
    await page.click(tid('cloud-unlock-skip'));
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(page, 'not-setup');
    assert.equal((await readCloud(page)).config, null);
    await page.click(tid('empty-device-unlock'));
    await page.locator(tid('cloud-unlock-dialog')).waitFor();
    assert.match(await lockedPassword(page, PASSWORD), LOCKED);
    await page.click(tid('cloud-unlock-skip'));
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 10, perDay: 10 });

    // Gerät A ist schon verbunden: gleicht trotz Sperre weiter ab
    await addClass(a.page, '6b');
    await waitVersion(s.mb, k, 2);
    await waitIndicator(a.page, 'ok');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', STATUS(429));
  } finally {
    await s.close();
  }
});

test('Gerät, das das Passwort gemerkt hatte: „Passwort merken“ bleibt nach erneuter Eingabe (z. B. nach Passwortänderung) ausgewählt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s); // Passwort gemerkt (Standard beim Einrichten)
    assert.equal((await readCloud(a.page)).config.remember, true);
    const b = await deviceUnlocked(s);
    await goSettings(b.page);
    await b.page.click(tid('cloud-change-password'));
    await b.page.fill(tid('cloud-change-current'), PASSWORD);
    await fillNewPassword(b.page, 'cloud-newpw', NEW_PASSWORD);
    await b.page.click(tid('cloud-change-submit'));
    await toastWith(b.page, 'Das Passwort wurde geändert.').waitFor(SLOW);
    await refocus(a.page);
    await waitIndicator(a.page, 'needs-password');
    assert.equal((await readCloud(a.page)).config.remember, true, 'Einstellung „gemerkt“ ist noch da');
    await a.page.click(tid('cloud-indicator-action'));
    await a.page.locator(tid('cloud-unlock-dialog')).waitFor();
    assert.equal(await a.page.isChecked(tid('cloud-unlock-remember')), true, '„Passwort merken“ wie bisher ausgewählt');
    // Ohne das Kästchen anzufassen: wieder gemerkt
    await unlockWith(a.page, NEW_PASSWORD);
    await waitIndicator(a.page, 'ok');
    const cloudA = await readCloud(a.page);
    assert.equal(cloudA.config.remember, true);
    assert.equal(cloudA.localKey?.authToken, (await keysFor(NEW_PASSWORD)).authToken, 'Schlüssel wieder im localStorage');
    assert.equal(cloudA.sessionKey, null);
    // Gerät B (nicht gemerkt) behält seine Wahl ebenfalls
    assert.equal((await readCloud(b.page)).config.remember, false);
    assertClean(a, 'Gerät A', STATUS(403));
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Einrichten mit dem Passwort einer vorhandenen Sicherung (anderer Stand): Konflikt-Dialog wie beim Anmelden, die Cloud-Sicherung wird empfohlen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);
    const c = await s.open();
    await seedWithoutSession(c.page, s.web, sampleState({ classes: [classOf('7c')] }));
    await fillLogin(c.page, s.web);
    await c.page.locator(tid('cloud-setup-dialog')).waitFor(SLOW);
    await fillNewPassword(c.page, 'cloud-setup', PASSWORD);
    await c.page.click(tid('cloud-setup-submit'));
    const conflict = c.page.locator(tid('cloud-conflict'));
    await conflict.waitFor(SLOW);
    const text = flat(await conflict.textContent());
    assert.ok(text.includes(LOGIN_CONFLICT), 'Text für ein gerade verbundenes Gerät');
    assert.ok(!text.includes(SYNC_CONFLICT));
    assert.match(flat(await c.page.textContent(tid('cloud-choice-local'))), /1 Klasse \(7c\)/);
    assert.match(flat(await c.page.textContent(tid('cloud-choice-remote'))), /1 Klasse \(5a\)/);
    assert.equal(flat(await c.page.textContent(`${tid('cloud-choice-remote')} .badge`)), 'empfohlen', 'kein gemeinsamer Stand: Cloud-Sicherung empfohlen, obwohl dieser Stand neuer ist');
    assert.equal(await c.page.locator(`${tid('cloud-choice-local')} .badge`).count(), 0);
    assert.equal(cloudRows(s.mb).length, 1, 'keine zweite Sicherung');
    // Die Wahl selbst funktioniert: Stand dieses Geräts ersetzt den in der Cloud
    await c.page.click(tid('cloud-choose-local'));
    await waitHash(c.page, '#/lehrkraft/klassen');
    await waitVersion(s.mb, k, 2);
    await waitIndicator(c.page, 'ok');
    assert.deepEqual(classIds((await decryptStored(s.mb, k)).state), ['7c']);
    assert.equal(JSON.parse(cloudRow(s.mb, k).devices).length, 2, 'Gerät C eingetragen');
    const cloudC = await readCloud(c.page);
    assert.equal(cloudC.config.version, 2);
    assert.equal(cloudC.config.dirty, false);
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C', STATUS(409));
  } finally {
    await s.close();
  }
});

test('Konflikt-Dialog: „Stand dieses Geräts als Zwischenstand speichern“ lädt den Stand dieses Geräts herunter, der Dialog bleibt offen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const e = await s.open();
    await seedWithoutSession(e.page, s.web, sampleState({ classes: [classOf('7c'), classOf('8d')] }));
    await fillLogin(e.page, s.web);
    await e.page.locator(tid('cloud-setup-dialog')).waitFor(SLOW);
    await e.page.click(tid('cloud-setup-have'));
    await e.page.fill(tid('cloud-unlock-password'), PASSWORD);
    await e.page.click(tid('cloud-unlock-submit'));
    const conflict = e.page.locator(tid('cloud-conflict'));
    await conflict.waitFor(SLOW);
    const local = await readState(e.page);
    assert.match(flat(await conflict.textContent()), /speichern Sie vorher den Stand dieses Geräts als Datei – mit „Zwischenstand laden“ lässt er sich später wiederherstellen\./);
    const button = e.page.locator(tid('cloud-conflict-backup'));
    assert.equal(flat(await button.textContent()), 'Stand dieses Geräts als Zwischenstand speichern');
    const backup = await captureDownload(e.page, () => button.click());
    assert.match(backup.filename, BACKUP_NAME);
    const data = JSON.parse(backup.buffer.toString('utf8'));
    assert.equal(data.type, 'teacher-state');
    assert.equal(data.teacher.teacherCode, T_CODE);
    assert.deepEqual(classIds(data), ['7c', '8d'], 'Stand dieses Geräts, nicht der aus der Cloud');
    assert.deepEqual(
      data.event.days.map((d) => d.date),
      local.event.days.map((d) => d.date),
    );
    assert.equal(data.savedAt, local.savedAt);
    assert.ok(Date.parse(data.exportedAt) > 0);
    await toastWith(e.page, `Stand dieses Geräts gespeichert: „${backup.filename}“`).waitFor();
    assert.equal(await conflict.count(), 1, 'Dialog bleibt offen');
    await e.page.click(tid('cloud-choose-remote'));
    await toastWith(e.page, LOADED).waitFor(SLOW);
    await waitHash(e.page, '#/lehrkraft/klassen');
    await e.page.locator(tid('class-tile-5a')).waitFor(SLOW);
    assert.deepEqual(await tiles(e.page), ['5a']);
    assertClean(a, 'Gerät A');
    assertClean(e, 'Gerät E');
  } finally {
    await s.close();
  }
});

test('Häufiges Anmelden ohne „Passwort merken“ an einem Gerät verdrängt nicht das Gerät, an dem täglich gearbeitet wird', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s); // Hauptgerät, gleicht laufend ab
    const k = await keysFor(PASSWORD);
    const devices = () => JSON.parse(cloudRow(s.mb, k).devices);
    const b = await deviceUnlocked(s); // Schulrechner, Passwort nicht gemerkt
    const deviceB = (await readCloud(b.page)).device;
    assert.equal(devices().length, 2);
    // Jede Anmeldung dort verwendet dasselbe Geräte-Geheimnis dieses Browsers
    for (let i = 0; i < 2; i++) {
      await logout(b.page);
      const cloud = await readCloud(b.page);
      assert.equal(cloud.sessionKey, null, 'Schlüssel beim Abmelden vergessen');
      assert.equal(cloud.device, deviceB, 'Geräte-Geheimnis bleibt');
      await fillLogin(b.page, s.web);
      await unlockWith(b.page, PASSWORD);
      await waitHash(b.page, '#/lehrkraft/klassen');
      await waitIndicator(b.page, 'ok');
      assert.equal((await keysOf(b.page)).device, deviceB);
    }
    assert.equal(devices().length, 2, 'erneute Anmeldung ohne „Passwort merken“ = dasselbe Gerät');
    // Weitere 25 Anmeldungen genau so, wie der Browser sie schickt (POST …/open mit dem Geräte-Geheimnis dieses Browsers)
    const service = api(s.mb);
    for (let i = 0; i < 25; i++) {
      const res = await service.open({ ...k, device: deviceB });
      assert.equal((await res.json()).found, true);
    }
    assert.deepEqual(devices().sort(), [await hashOf((await keysOf(a.page)).device), await hashOf(deviceB)].sort(), 'weiterhin genau zwei Geräte');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 1, perDay: 1 }, 'erfolgreiches Öffnen zählt nicht (nur das Einrichten)');
    // Das Hauptgerät gleicht weiter ab
    await addClass(a.page, '6b');
    const status = await syncNow(a.page);
    assert.equal(status.kind, 'ok', 'Hauptgerät bleibt verbunden');
    await waitVersion(s.mb, k, 2);
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

// ---------- Dienst (direkt, ohne Browser) ----------

test('Dienst: Anlegen verrät nicht, ob es zu einem Passwort eine Sicherung gibt, und zählt als Versuch der Lehrkraft; falsches who → einheitlich 403', async () => {
  const mb = await startMailboxServer();
  try {
    const service = api(mb);
    // Der Dienst kennt die Durchläufe nicht – für diesen Test genügen wenige
    const fast = async (password) => ({ ...(await deriveCloudKeys(password, SAMPLE_TEACHER, 1000)), device: randomBytes(32).toString('base64url') });
    const k = await fast(PASSWORD);
    const invented = 'x'.repeat(22);

    // Anlegen zählt als Versuch der Lehrkraft – auch wenn es klappt
    let res = await service.create(k, { ip: '198.51.100.1' });
    assert.equal(res.status, 201);
    assert.deepEqual(attempts(mb, k.who), { perIp: 1, perDay: 1 });
    // Noch einmal dasselbe (gleiche Lehrkraft, gleiches Passwort): 409 – und wieder gezählt
    res = await service.create(k, { ip: '198.51.100.2' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'exists');
    assert.deepEqual(attempts(mb, k.who), { perIp: 2, perDay: 2 });
    // Richtiges Passwort, erfundenes who: KEIN 409 – eine eigene Sicherung, die vorhandene bleibt unberührt
    res = await service.create(k, { ip: '198.51.100.3', who: invented });
    assert.equal(res.status, 201, 'mit erfundenem who kein Hinweis auf die vorhandene Sicherung');
    assert.equal(cloudRows(mb).length, 2);
    assert.equal(cloudRow(mb, k).version, 1);
    assert.ok(cloudRow(mb, { ...k, who: invented }), 'eigene Zeile unter dem erfundenen who');
    assert.deepEqual(attempts(mb, k.who), { perIp: 2, perDay: 2 }, 'zählt nicht für die echte Lehrkraft');
    assert.deepEqual(attempts(mb, invented), { perIp: 1, perDay: 1 });

    // Abrufen, Ändern und Löschen brauchen das richtige who (X-Who) – sonst 403 wie ohne Sicherung
    res = await service.get(k);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, 1);
    const forbidden = async (response, label) => {
      assert.equal(response.status, 403, label);
      assert.deepEqual(await response.json(), { error: 'forbidden' }, label);
    };
    await forbidden(await service.get(k, { who: 'y'.repeat(22) }), 'GET mit falschem who');
    await forbidden(await service.get(k, { who: '' }), 'GET ohne who');
    await forbidden(await service.get(fakeKeys()), 'GET ohne Sicherung');
    await forbidden(await service.update(k, 1, { who: 'y'.repeat(22) }), 'PUT mit falschem who');
    await forbidden(await service.remove(k, { who: 'y'.repeat(22) }), 'DELETE mit falschem who');
    await forbidden(await service.remove(k, { token: k.authToken }), 'DELETE mit dem Token statt dem Admin-Token');
    res = await service.update(k, 1);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, 2);

    // 28 falsche Passwörter von vier Anschlüssen: 30 Versuche heute – Öffnen gesperrt, auch mit dem richtigen Passwort
    for (let i = 0; i < 28; i++) {
      const g = await fast(`Rateversuch Nummer ${i}`);
      res = await service.open(g, { ip: `198.51.100.${10 + Math.floor(i / 8)}` });
      assert.equal((await res.json()).found, false);
    }
    assert.equal(attempts(mb, k.who).perDay, 30);
    res = await service.open(k, { ip: '198.51.100.50' });
    assert.equal(res.status, 429, 'Öffnen gesperrt');
    assert.equal((await res.json()).error, 'locked');

    // Anlegen mit dem echten who ist dann ebenso gesperrt – gleich, ob das Passwort stimmt (keine 409)
    for (const [label, keys] of [
      ['richtiges Passwort', k],
      ['falsches Passwort', await fast('Noch ein Rateversuch')],
    ]) {
      res = await service.create(keys, { ip: '198.51.100.60' });
      assert.equal(res.status, 429, label);
      assert.equal((await res.json()).error, 'locked', label);
    }
    assert.equal(attempts(mb, k.who).perDay, 30, 'abgewiesene Versuche zählen nicht weiter');
    // … und mit erfundenem who entsteht nur eine eigene, neue Sicherung – ohne Hinweis auf die vorhandene
    res = await service.create(k, { ip: '198.51.100.61', who: 'z'.repeat(22) });
    assert.equal(res.status, 201);
    // Ein schon verbundenes Gerät gleicht trotz Sperre weiter ab
    res = await service.get(k, { since: 2 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).unchanged, true);
    assert.equal((await service.update(k, 2)).status, 200);
    // Löschen mit dem Admin-Token, richtigem who und eingetragenem Gerät
    res = await service.remove(k);
    assert.deepEqual(await res.json(), { deleted: true });
    assert.equal(cloudRow(mb, k), null);
    assert.equal(
      chunkRows(mb).filter((c) => c.backup_id === rowId(k)).length,
      0,
    );
  } finally {
    await mb.close();
  }
});

test('Dienst: Neue Sicherungen sind je Anschluss begrenzt (20 am Tag, 5 Mio. Zeichen; IPv6: ganzes /48) – das zählt nicht als Versuch der Lehrkraft; IP-Adressen nur als Hashwert', async () => {
  const mb = await startMailboxServer();
  try {
    const service = api(mb);
    // 20 neue Sicherungen (verschiedene Lehrkräfte) aus einem /48-Netz
    for (let i = 0; i < 20; i++) {
      const res = await service.create(fakeKeys(), { ip: `2001:db8:1:${i.toString(16)}::${i + 1}` });
      assert.equal(res.status, 201, `Sicherung ${i + 1}`);
    }
    const k = fakeKeys();
    let res = await service.create(k, { ip: '2001:db8:1:ffff::1' });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, 'too-many-creates');
    assert.ok(body.retryAfter > 0 && body.retryAfter <= DAY_MS / 1000);
    assert.deepEqual(attempts(mb, k.who), { perIp: 0, perDay: 0 }, 'kein Versuch der Lehrkraft gezählt');
    assert.equal(cloudRow(mb, k), null);
    // Aus einem anderen /48-Netz geht es
    assert.equal((await service.create(k, { ip: '2001:db8:2::1' })).status, 201);

    // Umfang: höchstens 5 Mio. Zeichen je Anschluss und Tag (hier 6 × 720 000 erlaubt, das 7. Mal nicht)
    const big = 'A'.repeat(720000);
    for (let i = 0; i < 6; i++) assert.equal((await service.create(fakeKeys(), { ip: '203.0.113.9', ct: big })).status, 201, `große Sicherung ${i + 1}`);
    const k2 = fakeKeys();
    res = await service.create(k2, { ip: '203.0.113.9', ct: big });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, 'too-many-creates');
    assert.deepEqual(attempts(mb, k2.who), { perIp: 0, perDay: 0 });
    assert.equal((await service.create(k2, { ip: '203.0.113.10', ct: big })).status, 201, 'anderer Anschluss');
    const created = cloudRows(mb);
    assert.equal(created.length, 20 + 1 + 6 + 1);
    assert.equal(created.find((r) => r.id === rowId(k2)).size, 720000);
    assert.equal(created.find((r) => r.id === rowId(k2)).chunks, 8, 'in Stücken zu je 90 000 Zeichen');

    // Gespeichert werden nur pseudonyme Hashwerte (mit täglich neuem Zufallswert), keine Adressen
    const dump = dumpDb(mb);
    for (const ip of ['2001:db8:1', '2001:db8:2', '203.0.113.9', '203.0.113.10']) assert.ok(!dump.includes(ip), `Adresse ${ip} nicht gespeichert`);
    const keys = rows(mb, 'SELECT key FROM cloud_limits').map((r) => r.key);
    assert.ok(keys.length > 0);
    for (const key of keys) assert.match(key, /^(c|cb|o\|[A-Za-z0-9_-]{22})\|[A-Za-z0-9_-]{22}$|^o\|[A-Za-z0-9_-]{22}$/, `Zähler ${key}`);
  } finally {
    await mb.close();
  }
});

test('Dienst: Gesamtgrenze für Cloud-Sicherungen richtet sich nach der tatsächlichen Größe', async () => {
  const mb = await startMailboxServer();
  try {
    const service = api(mb);
    // Tabellen anlegen lassen (irgendeine Anfrage an die Datenbank)
    await service.get(fakeKeys());
    // 3000 kleine Sicherungen (je 32 Zeichen) – zusammen weniger als 0,1 MB
    const db = mb.db.db;
    const at = Date.now();
    const insert = db.prepare(
      "INSERT INTO backups (id, version, updated_at, seen_at, auth_hash, admin_hash, devices, iv, z, chunks, size, writer) VALUES (?, 1, ?, ?, ?, ?, '[]', 'AAAAAAAAAAAAAAAA', 0, 1, ?, 'w')",
    );
    const chunk = db.prepare('INSERT INTO backup_chunks (backup_id, idx, data) VALUES (?, 0, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 3000; i++) {
      const id = `t${String(i).padStart(42, '0')}`;
      insert.run(id, at, at, 'h'.repeat(43), 'a'.repeat(43), 32);
      chunk.run(id, 'A'.repeat(32));
    }
    db.exec('COMMIT');
    const k = fakeKeys();
    let res = await service.create(k);
    assert.equal(res.status, 201, `neue Sicherung angelegt (Antwort: ${res.status} ${JSON.stringify(await res.clone().json())})`);

    // Fast voll (250 Mio. Zeichen): Es zählt die Spalte size
    const total = () => rows(mb, 'SELECT SUM(size) AS n FROM backups')[0].n;
    insert.run(`big${'0'.repeat(40)}`, at, at, 'h'.repeat(43), 'a'.repeat(43), 250 * 1000 * 1000 - total() - 40);
    assert.equal(total(), 250 * 1000 * 1000 - 40);
    const before = createCounters(mb);
    const tooBig = fakeKeys();
    res = await service.create(tooBig, { ct: 'A'.repeat(44) });
    assert.equal(res.status, 507);
    assert.equal((await res.json()).error, 'storage-full');
    assert.deepEqual(attempts(mb, tooBig.who), { perIp: 0, perDay: 0 }, 'nicht als Versuch der Lehrkraft gezählt');
    assert.deepEqual(createCounters(mb), before, 'auch nicht als neue Sicherung des Anschlusses');
    // Genau bis zur Grenze passt es noch
    res = await service.create(fakeKeys(), { ct: 'A'.repeat(40) });
    assert.equal(res.status, 201);
    assert.equal(total(), 250 * 1000 * 1000);
  } finally {
    await mb.close();
  }
});

test('Dienst: Aufräumen – Sicherungen nach 400 Tagen ohne Nutzung, nie genutzte (Version 1) nach 30 Tagen, Zähler nach 2 Tagen', async () => {
  const mb = await startMailboxServer();
  try {
    await api(mb).get(fakeKeys()); // Tabellen anlegen lassen
    const db = mb.db.db;
    const at = Date.now();
    const insert = db.prepare(
      "INSERT INTO backups (id, version, updated_at, seen_at, auth_hash, admin_hash, devices, iv, z, chunks, size, writer) VALUES (?, ?, ?, ?, 'h', 'a', '[]', 'AAAAAAAAAAAAAAAA', 0, 1, 32, 'w')",
    );
    const chunk = db.prepare("INSERT INTO backup_chunks (backup_id, idx, data) VALUES (?, 0, 'AAAA')");
    const add = (id, version, daysAgo) => {
      insert.run(id, version, at - daysAgo * DAY_MS, at - daysAgo * DAY_MS);
      chunk.run(id);
    };
    add('genutzt-398', 5, 398);
    add('genutzt-401', 5, 401);
    add('neu-29', 1, 29);
    add('neu-31', 1, 31);
    add('geaendert-31', 2, 31);
    const limit = db.prepare('INSERT INTO cloud_limits (key, win, n) VALUES (?, ?, 1)');
    limit.run('o|heute', at - 3600000);
    limit.run('o|vorgestern', at - 3 * DAY_MS);
    const log = console.log;
    console.log = () => {};
    try {
      await worker.scheduled({}, mb.env);
    } finally {
      console.log = log;
    }
    assert.deepEqual(
      cloudRows(mb)
        .map((r) => r.id)
        .sort(),
      ['geaendert-31', 'genutzt-398', 'neu-29'],
    );
    assert.deepEqual(
      chunkRows(mb)
        .map((r) => r.backup_id)
        .sort(),
      ['geaendert-31', 'genutzt-398', 'neu-29'],
      'Daten gelöschter Sicherungen entfernt',
    );
    assert.deepEqual(
      rows(mb, 'SELECT key FROM cloud_limits').map((r) => r.key),
      ['o|heute'],
    );
  } finally {
    await mb.close();
  }
});

test('Meldung zur Sperre: „für eine Minute“, „für N Minuten“ bzw. „bis morgen“', () => {
  const message = (retryAfter, error = 'locked') => cloudErrorMessage(new MailboxError('Zu viele Versuche.', { status: 429, data: { error, retryAfter } }));
  for (const seconds of [1, 30, 60, 61, 1800, 5400, 5401, 80000]) assert.match(message(seconds), LOCKED, `${seconds} s`);
  assert.match(message(30), /Öffnen und Einrichten für eine Minute gesperrt\./);
  assert.match(message(60), /für eine Minute gesperrt/);
  assert.match(message(61), /für 2 Minuten gesperrt/);
  assert.match(message(5400), /für 90 Minuten gesperrt/);
  assert.match(message(5401), /bis morgen gesperrt/);
  assert.doesNotMatch(message(30), /1 Minuten/);
  assert.equal(message(3600, 'too-many-creates'), 'Von Ihrem Internetanschluss wurden heute schon sehr viele Cloud-Sicherungen eingerichtet. Bitte versuchen Sie es morgen noch einmal.');
});
