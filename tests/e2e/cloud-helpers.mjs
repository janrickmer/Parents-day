// Gemeinsame Hilfen für die Browser-Tests der Cloud-Sicherung (cloud.test.mjs, cloud-login.test.mjs).
// Der Dienst (worker/briefkasten.js) läuft lokal über mailbox-server.mjs – nie gegen workers.dev.
// „Geräte“ sind getrennte Browser (eigener Speicher).
// Datenbank des Dienstes: Tabelle backups mit id = base64url(SHA-256("cloud|" + who + "|" + syncId)) – weder who
// noch syncId stehen darin; backup_chunks(backup_id, idx, data); cloud_limits(key, win, n); meta.
// PBKDF2 mit 600 000 Durchläufen dauert im Browser etwa eine halbe Sekunde – daher großzügige Wartezeiten.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startServer, launch, captureDownload, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { startMailboxServer } from './mailbox-server.mjs';
import { deriveCloudKeys, decryptCloudData } from '../../js/core/cloud.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

export const tid = (id) => `[data-testid="${id}"]`;
export const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const T_CODE = SAMPLE_TEACHER.teacherCode;
// Nicht das Beispiel aus dem Hinweis unter dem Passwortfeld – sonst stünde es ohnehin auf der Seite.
export const PASSWORD = 'Blaue Tafel grün 2026';
export const NEW_PASSWORD = 'Mond Heft Radiergummi 9';
export const WRONG_PASSWORD = 'Falsches Passwort 123';
export const NEW_EMAIL = 'anna.neu@schule.example';
export const SLOW = { timeout: 60000 }; // Schlüsselableitung und Abgleich
export const TEST_TIMEOUT = 240000;
export const DAY_MS = 24 * 60 * 60 * 1000;

// Erwartete Konsolenmeldungen von Chromium (Antworten des Dienstes mit Fehlerstatus bzw. ohne Verbindung)
export const STATUS = (...codes) => new RegExp(`^console: Failed to load resource: the server responded with a status of (${codes.join('|')}) `);
export const OFFLINE = /^console: Failed to load resource: net::ERR_(INTERNET_DISCONNECTED|FAILED)$/;

// Meldungen der Oberfläche
export const NOT_FOUND = 'Mit diesem Passwort gibt es keine Cloud-Sicherung. Bitte prüfen Sie das Passwort, auch Groß- und Kleinschreibung';
export const NOT_FOUND_LOGIN = `${NOT_FOUND} – oder richten Sie eine neue Cloud-Sicherung ein.`;
export const NOT_FOUND_PLAIN = `${NOT_FOUND}.`;
export const MOVED_OLD_PASSWORD = 'Das Passwort dieser Cloud-Sicherung wurde inzwischen auf einem anderen Gerät geändert. Bitte geben Sie das neue Passwort ein.';
export const LOADED = 'Ihr Stand aus der Cloud-Sicherung wurde geladen.';
export const FROM_OTHER_DEVICE = 'Neuer Stand von einem anderen Gerät übernommen.';
export const SETUP_DONE = 'Cloud-Sicherung eingerichtet. Ihr Stand wird ab jetzt automatisch gesichert.';
export const SETUP_INTRO = 'Neu: Ihr Stand kann jetzt automatisch in der Cloud gesichert werden – dann ist er auf jedem Gerät da, an dem Sie sich anmelden. Legen Sie dafür einmal ein Passwort fest.';
export const NEEDS_PASSWORD = 'Bitte geben Sie Ihr Passwort für die Cloud-Sicherung erneut ein. Vielleicht wurde es auf einem anderen Gerät geändert oder die Sicherung gelöscht.';
export const MOVED = 'Das Passwort Ihrer Cloud-Sicherung wurde auf einem anderen Gerät geändert. Bitte geben Sie das neue Passwort ein – Ihre Änderungen auf diesem Gerät bleiben erhalten.';
export const LOGIN_CONFLICT = 'Auf diesem Gerät ist ein anderer Stand gespeichert als in Ihrer Cloud-Sicherung.';
export const SYNC_CONFLICT = 'Ihr Stand wurde auf einem anderen Gerät geändert, während hier noch nicht gesicherte Änderungen vorlagen.';
export const LOCKED =
  /^Für Ihre Cloud-Sicherung gab es zu viele Versuche mit einem falschen Passwort \(nicht unbedingt von Ihnen\)\. Zum Schutz Ihrer Daten ist das Öffnen und Einrichten (für eine Minute|für \d+ Minuten|bis morgen) gesperrt\. Geräte, die schon verbunden sind, gleichen weiter ab\.$/;

// Erwartete Werte aus Passwort, Name und Geburtsdatum – wie im Browser, hier in Node berechnet.
const derived = new Map();
export function keysFor(password) {
  if (!derived.has(password)) derived.set(password, deriveCloudKeys(password, SAMPLE_TEACHER));
  return derived.get(password);
}

// ---------- Umgebung ----------

/** Dienst, Webserver (mit diesem Dienst als MAILBOX_URL) und Geräte (Browser) für einen Test. */
export async function setup() {
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
export function assertClean(d, label, ...allowed) {
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

export async function waitUntil(predicate, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  }
  assert.fail(message);
}

export const waitHash = (page, hash) => page.waitForFunction((h) => location.hash === h, hash, SLOW);

// ---------- Dienst (Datenbank) ----------

/** Zeilen einer Tabelle als einfache Objekte ([] solange es die Tabelle noch nicht gibt). */
export function rows(mb, sql, ...params) {
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
export const rowId = (k) => createHash('sha256').update(`cloud|${k.who}|${k.syncId}`).digest('base64url');

export const cloudRows = (mb) => rows(mb, 'SELECT id, version, updated_at, seen_at, auth_hash, admin_hash, devices, iv, z, chunks, size FROM backups ORDER BY rowid');
export const chunkRows = (mb) => rows(mb, 'SELECT backup_id, idx, length(data) AS len FROM backup_chunks ORDER BY backup_id, idx');
/** Zeile der Sicherung zu den Schlüsseln `k` ({ who, syncId }) oder null. */
export const cloudRow = (mb, k) => cloudRows(mb).find((r) => r.id === rowId(k)) || null;

/** Zähler der Versuche je Lehrkraft: { perIp, perDay } (Schlüssel „o|who|ip“ bzw. „o|who“). */
export function attempts(mb, who) {
  const list = rows(mb, 'SELECT key, n FROM cloud_limits');
  return {
    perIp: list.filter((r) => r.key.startsWith(`o|${who}|`)).reduce((n, r) => n + r.n, 0),
    perDay: list.find((r) => r.key === `o|${who}`)?.n ?? 0,
  };
}

/** Wartet, bis die Sicherung zu `k` mindestens `version` erreicht hat. */
export function waitVersion(mb, k, version) {
  return waitUntil(() => {
    const row = cloudRow(mb, k);
    return row && row.version >= version ? row : null;
  }, `Cloud-Sicherung erreicht Version ${version} nicht`);
}

/** Entschlüsselt die Sicherung im Dienst mit den Schlüsseln eines Geräts (wie der Browser, mit der Version). */
export async function decryptStored(mb, keys) {
  const row = cloudRow(mb, keys);
  assert.ok(row, 'Cloud-Sicherung vorhanden');
  const ct = rows(mb, 'SELECT data FROM backup_chunks WHERE backup_id = ? ORDER BY idx', row.id)
    .map((r) => r.data)
    .join('');
  return decryptCloudData(keys, { iv: row.iv, ct, z: row.z, version: row.version });
}

/** Wartet, bis der entschlüsselte Inhalt der Sicherung `predicate` erfüllt, und gibt ihn zurück. */
export async function waitContent(mb, keys, predicate, message) {
  let content = null;
  await waitUntil(async () => {
    if (!cloudRow(mb, keys)) return false;
    content = await decryptStored(mb, keys);
    return predicate(content);
  }, message);
  return content;
}

// ---------- Gerät (Browser) ----------

export const readState = (page, code = T_CODE) => page.evaluate((c) => JSON.parse(localStorage.getItem(`parentsday.teacher.${c}`) || 'null'), code);

/** Einstellungen, Schlüssel und Geräte-Geheimnis der Cloud-Sicherung im Speicher des Browsers. */
export const readCloud = (page, code = T_CODE) =>
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
export async function keysOf(page) {
  const cloud = await readCloud(page);
  return cloud.localKey || cloud.sessionKey;
}

/** Alles, was ParentsDay im Browser gespeichert hat (Text). */
export const allStorage = (page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));

/** Schlüssel im Speicher, die zur Lehrkraft gehören. */
export const teacherKeys = (page) =>
  page.evaluate((code) => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.includes(code) || k === 'parentsday.session'), T_CODE);

export const classIds = (state) => (state?.classes || []).map((c) => c.id);

export function classOf(id) {
  return { id, grade: Number(id.slice(0, -1)), letter: id.slice(-1), codesGenerated: false, students: [] };
}

export const indicator = (page) => page.locator(tid('cloud-indicator'));
export const waitIndicator = (page, state) => page.locator(`${tid('cloud-indicator')}[data-state="${state}"]`).waitFor(SLOW);
// .last(): Ein gleichlautender Hinweis von vorhin kann noch zu sehen sein.
export const toastWith = (page, text) => page.locator('.toast', { hasText: text }).last();
export const modalTitle = (page) => page.locator('.modal-title').last();

/** Abgleich direkt anstoßen (dasselbe Modul wie in der App) – gibt den Zustand danach zurück. */
export const syncNow = (page) => page.evaluate(() => import('/js/core/cloud-sync.js').then((m) => m.syncCloudNow()));

/** Legt den Stand einer Lehrkraft im Browser ab (ohne Anmeldung – wie ein früher genutztes Gerät). */
export async function seedWithoutSession(page, web, state) {
  await page.goto(web.url);
  await page.evaluate((s) => localStorage.setItem(`parentsday.teacher.${s.teacher.teacherCode}`, JSON.stringify(s)), state);
}

/** Anmelden mit Namen, Geburtsdatum und Registrierungscode (mit Dienst steht das Formular zuerst auf „Passwort“). */
export async function fillLogin(page, web, teacher = SAMPLE_TEACHER) {
  await page.goto(`${web.url}#/lehrkraft/anmelden`);
  // Erst das gezeichnete Formular abwarten: Nach einem Wechsel nur des #-Teils kehrt goto sofort zurück.
  await page.locator(tid('login-submit')).waitFor();
  if (await page.isVisible(tid('login-use-code'))) await page.click(tid('login-use-code'));
  await page.fill(tid('login-firstname'), teacher.firstName);
  await page.fill(tid('login-lastname'), teacher.lastName);
  await page.fill(tid('login-birthdate'), teacher.birthDate);
  await page.fill(tid('login-code'), teacher.registrationCode.toLowerCase());
  await page.click(tid('login-submit'));
}

/** Passwort im Dialog „Passwort eingeben“ eingeben (Dialog schließt sich danach). */
export async function unlockWith(page, password, { remember = false } = {}) {
  const dlg = page.locator(tid('cloud-unlock-dialog'));
  await dlg.waitFor(SLOW);
  await page.fill(tid('cloud-unlock-password'), password);
  if (remember) await page.check(tid('cloud-unlock-remember'));
  await page.click(tid('cloud-unlock-submit'));
  await dlg.waitFor({ state: 'detached', ...SLOW });
}

/** Falsches Passwort im Dialog: Fehlermeldung am Feld, Dialog bleibt offen. Gibt die Meldung zurück. */
export async function wrongPassword(page, password = WRONG_PASSWORD) {
  await page.fill(tid('cloud-unlock-password'), password);
  await page.click(tid('cloud-unlock-submit'));
  const error = page.locator('#cloud-unlock-password-error:not([hidden])');
  await error.waitFor(SLOW);
  // Knopf wieder bereit für den nächsten Versuch
  await page.locator(`${tid('cloud-unlock-submit')}:not([disabled])`).waitFor(SLOW);
  return flat(await error.textContent());
}

/** Passwort im Dialog, das der Dienst wegen der Sperre abweist: Meldung im Dialog, der offen bleibt. */
export async function lockedPassword(page, password) {
  await page.fill(tid('cloud-unlock-password'), password);
  await page.click(tid('cloud-unlock-submit'));
  const alert = page.locator(`${tid('cloud-unlock-dialog')} .alert-error`);
  await alert.waitFor(SLOW);
  await page.locator(`${tid('cloud-unlock-submit')}:not([disabled])`).waitFor(SLOW);
  return flat(await alert.textContent());
}

/** Neues Passwort in einem Dialog mit zwei Feldern (Präfix z. B. „cloud-setup“) eingeben. */
export async function fillNewPassword(page, prefix, password) {
  await page.fill(tid(`${prefix}-password`), password);
  await page.fill(tid(`${prefix}-password2`), password);
}

/** Klasse auf der Klassenübersicht anlegen. */
export async function addClass(page, id) {
  await page.locator(tid('class-grade')).waitFor();
  await page.selectOption(tid('class-grade'), id.slice(0, -1));
  await page.selectOption(tid('class-letter'), id.slice(-1));
  await page.click(tid('class-create'));
  await page.locator(tid(`class-tile-${id}`)).waitFor();
}

/** Kacheln der Klassenübersicht. */
export const tiles = (page) => page.$$eval('[data-testid^="class-tile-"]', (els) => els.map((e) => e.dataset.testid.replace('class-tile-', '')));

export const goSettings = (page) => page.click('.header-nav a[href="#/lehrkraft/einstellungen"]');
export const goClasses = (page) => page.click('.header-nav a[href="#/lehrkraft/klassen"]');

/** Zurück auf die Seite (focus) – danach wird geprüft, ob es einen neueren Stand gibt. */
export const refocus = (page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

/**
 * Gerät A: Lehrkraft mit Stand (Elternsprechtag und Klassen) meldet sich an und richtet im Dialog nach der
 * Anmeldung die Cloud-Sicherung ein (Gerät mit Daten → zuerst „Cloud-Sicherung einrichten“).
 */
export async function deviceWithCloud(s, { classes = ['5a'], password = PASSWORD } = {}) {
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
export async function deviceUnlocked(s, { password = PASSWORD, remember = false } = {}) {
  const d = await s.open();
  await fillLogin(d.page, s.web);
  await unlockWith(d.page, password, { remember });
  await waitHash(d.page, '#/lehrkraft/klassen');
  await waitIndicator(d.page, 'ok');
  return d;
}

/** Abmelden über die Kopfzeile (optional mit „Meine Daten von diesem Gerät entfernen“). */
export async function logout(page, { remove = false } = {}) {
  await page.locator('.header-actions').getByRole('button', { name: 'Abmelden', exact: true }).click();
  const dlg = page.locator('.modal', { hasText: 'Abmelden?' });
  await dlg.waitFor();
  if (remove) await page.check(tid('logout-remove'));
  await dlg.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await waitHash(page, '#/');
}

/** Registrierung über das Formular (mit Passwort); wartet auf den Hinweis zur Cloud-Sicherung. */
export async function register(page, web, { password = PASSWORD, email = SAMPLE_TEACHER.email } = {}) {
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
