// Browser-Tests: Anmeldung der Lehrkraft mit dem Passwort ihrer Cloud-Sicherung (views/teacher-auth.js renderLogin
// und completeLogin, core/cloud-sync.js checkLoginPassword, components/cloud-ui.js cloudAfterPasswordLogin).
// Der Dienst (worker/briefkasten.js) läuft lokal über mailbox-server.mjs – nie gegen workers.dev. Jeder Test startet
// einen eigenen Dienst; „Geräte“ sind getrennte Browser (eigener Speicher).
// Abgedeckt: Passwort als Standard auf einem neuen Gerät (kein Kästchen „Passwort merken“; leeres/falsches Passwort
// am Feld, nichts gespeichert, Fehlversuch gezählt; richtiges Passwort holt den Stand ohne weiteren Dialog, nicht
// gemerkt), Geräte, die das Passwort kennen bzw. mit der Sicherung eingerichtet sind (Prüfung auf dem Gerät ohne
// Dienst – auch ohne Verbindung, kein Versuch gezählt –, „Passwort merken“ bleibt wie gewählt, falsches Passwort
// trotzdem beim Dienst abgelehnt), Konflikt-Dialog bei eigenem Stand, Passwort auf einem anderen Gerät geändert
// (Umzug bzw. „Passwort ändern“), Dienst nicht erreichbar bzw. ältere Fassung, Sperre nach zu vielen Fehlversuchen,
// Umschalten Passwort/Registrierungscode samt „Passwort vergessen?“ und gemerktem Weg, gesperrtes Formular während
// der Prüfung, ohne Dienst nur Registrierungscode, Daten einer anderen Lehrkraft mit gleichem Lehrkräftecode, die
// Anmeldung mit dem Passwort aus der Registrierung (auch ohne Verbindung registriert; weiterhin mit der
// Registrierungs-PDF), die erneute Registrierung an einem schon eingerichteten Gerät (components/cloud-ui.js
// cloudAfterRegister/registerAgain) als Matrix – (a) Einrichtung nie angelegt: anderes bzw. gleiches Passwort →
// „eingerichtet“; (b) angelegt, nicht verbunden, gleiches Passwort → „bleibt verbunden“ (auch gesperrt bzw. ohne
// Verbindung); (c) angelegt, nicht verbunden, anderes → „nicht übernommen“ ohne Dienst; (d) verbunden, gleiches →
// „bleibt verbunden“ mit „merken“ wie gewählt; (e) verbunden, anderes → „nicht übernommen“; (f) verbunden, Sicherung
// anderswo umgezogen: altes, neues bzw. drittes Passwort → „inzwischen geändert“ ohne neue Sicherung und ohne Wechsel,
// danach „Passwort eingeben“ in der Kopfzeile; (g) verbunden, Sicherung anderswo gelöscht bzw. mit „Passwort ändern“
// ersetzt → „inzwischen geändert“ ohne neue Sicherung und ohne Fehlversuch –, jeweils mit Hinweis, Einstellungen und
// Schlüsseln im Browser, Sicherungen, Geräten und gezählten Versuchen beim Dienst und dem Abgleich in beide Richtungen
// danach; dazu eine neue E-Mail-Adresse bei der erneuten Registrierung an einem veralteten bzw. leeren, verbundenen
// Gerät (kein Konflikt-Dialog, der neuere Stand bleibt, die Adresse gilt danach überall) –
// sowie das Geräte-Geheimnis (je Browser nur ein Gerät beim Dienst – auch bei verlorener Antwort, danach
// Code-Anmeldung mit „Passwort eingeben“ bzw. Einrichten, oder einer Sicherung, die der Browser nicht lesen kann).
// Dazu Texte: Hinweis unter „Passwort auf diesem Gerät merken“ in den Dialogen, Karte
// „Cloud-Sicherung“ und Dialog „Cloud-Sicherung löschen?“.
// Gemeinsame Hilfen stehen in cloud-helpers.mjs.
// Aufruf: node --test tests/e2e/cloud-login.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startServer, launch, captureDownload, pdfPayload, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { hashOf } from '../../js/core/cloud.js';
import { registrationCode, teacherCode } from '../../js/core/codes.js';
import {
  tid,
  flat,
  sleep,
  T_CODE,
  PASSWORD,
  NEW_PASSWORD,
  WRONG_PASSWORD,
  NEW_EMAIL,
  SLOW,
  TEST_TIMEOUT,
  STATUS,
  OFFLINE,
  LOADED,
  MOVED,
  NEEDS_PASSWORD,
  SETUP_INTRO,
  SETUP_DONE,
  LOGIN_CONFLICT,
  SYNC_CONFLICT,
  LOCKED,
  keysFor,
  setup,
  assertClean,
  waitUntil,
  waitHash,
  cloudRows,
  cloudRow,
  attempts,
  waitVersion,
  waitContent,
  decryptStored,
  readState,
  readCloud,
  keysOf,
  allStorage,
  classIds,
  classOf,
  indicator,
  waitIndicator,
  toastWith,
  modalTitle,
  seedWithoutSession,
  fillLogin,
  deviceWithCloud,
  deviceUnlocked,
  unlockWith,
  fillNewPassword,
  tiles,
  addClass,
  refocus,
  syncNow,
  goSettings,
  logout,
  register,
} from './cloud-helpers.mjs';

const LOGIN = '#/lehrkraft/anmelden';
const THIRD_PASSWORD = 'Dritte Kreide Pause 42';

// Texte der Anmeldeseite
const INTRO_PASSWORD =
  'Geben Sie Ihren Namen genau wie bei der Registrierung ein (auch mit Umlauten und Akzenten), dazu Ihr Geburtsdatum und Ihr Passwort. Ihr aktueller Stand wird dabei aus der Cloud-Sicherung geladen.';
const INTRO_CODE = 'Geben Sie Ihren Namen genau wie bei der Registrierung ein (auch mit Umlauten und Akzenten), dazu Ihr Geburtsdatum und Ihren Registrierungscode.';
const PASSWORD_HINT = 'Das Passwort Ihrer Cloud-Sicherung – festgelegt bei der Registrierung oder beim Einrichten der Cloud-Sicherung.';
const WRONG_LOGIN =
  'Das Passwort passt nicht zu Ihren Angaben. Bitte prüfen Sie das Passwort (auch Groß- und Kleinschreibung), Ihren Namen und Ihr Geburtsdatum. Ohne Cloud-Sicherung melden Sie sich mit Ihrem Registrierungscode an.';
const MOVED_LOGIN = 'Das Passwort Ihrer Cloud-Sicherung wurde inzwischen auf einem anderen Gerät geändert. Bitte melden Sie sich mit dem neuen Passwort an.';
const FORGOT_NOTE =
  'Ohne Passwort melden Sie sich mit Ihrem Registrierungscode an – er steht in Ihrer Registrierungs-PDF – oder Sie laden die PDF hoch. Ein neues Passwort legen Sie danach über „Passwort vergessen?“ fest: im Fenster „Passwort eingeben“ oder unter „Weitere Einstellungen“ bei der Cloud-Sicherung. Am besten an einem Gerät, das noch mit Ihrer Cloud-Sicherung verbunden ist – dann bleibt Ihr Stand erhalten.';
const UNAVAILABLE = 'Bitte melden Sie sich mit Ihrem Registrierungscode oder Ihrer Registrierungs-PDF an.';
const UNREACHABLE_LOGIN = `Die Cloud-Sicherung ist gerade nicht erreichbar – ohne sie lässt sich dieses Passwort nicht prüfen. ${UNAVAILABLE}`;
const NOT_POSSIBLE_LOGIN = `Die Anmeldung mit Passwort ist gerade nicht möglich. ${UNAVAILABLE}`;
const UNREADABLE = 'Dieser Browser kann die Cloud-Sicherung nicht lesen. Bitte aktualisieren Sie ihn.';
const CODE_MISMATCH = 'Die Angaben passen nicht zum Registrierungscode. Bitte prüfen Sie Namen, Geburtsdatum und Code.';
const CODE_COLLISION =
  'In diesem Browser sind bereits Daten einer anderen Lehrkraft mit demselben Lehrkräftecode gespeichert (gleiche Anfangsbuchstaben und gleiches Geburtsdatum). Zum Schutz dieser Daten nutzen Sie ParentsDay bitte in einem anderen Browser oder Browserprofil.';
const FAILED = 'Die Anmeldung hat nicht geklappt. ';
const CHECKING = 'Ihr Passwort wird geprüft …';
const CHOOSE_LOGIN_CLOUD = 'Geben Sie Ihren Namen, Ihr Geburtsdatum und Ihr Passwort ein – oder melden Sie sich mit Ihrer Registrierungs-PDF bzw. Ihrem Registrierungscode an.';
const CHOOSE_LOGIN_PLAIN = 'Laden Sie Ihre Registrierungs-PDF hoch – oder geben Sie Ihren Namen, Ihr Geburtsdatum und Ihren Registrierungscode ein.';
const KEPT_LOCAL = 'Die Cloud-Sicherung ist verbunden. Der Stand von diesem Gerät wird gesichert.';
const OFFLINE_TOAST = 'Die Cloud-Sicherung ist gerade nicht erreichbar. Sie arbeiten mit dem Stand dieses Geräts.';

// Hinweis unter „Passwort auf diesem Gerät merken“ (Registrierung und Dialoge „Cloud-Sicherung einrichten“ bzw. „Passwort eingeben“)
const REMEMBER_HINT = 'Dann bleibt dieses Gerät auch nach dem Abmelden mit Ihrer Cloud-Sicherung verbunden. Nicht an fremden oder gemeinsam genutzten Computern.';
// Dialog „Cloud-Sicherung löschen?“
const DELETE_INTRO = 'Ihre Cloud-Sicherung wird vom Server gelöscht. Der Stand in diesem Browser bleibt erhalten.';
const DELETE_OTHERS =
  'Auf anderen Geräten bleibt der dort gespeicherte Stand ebenfalls erhalten, wird aber nicht mehr abgeglichen – dort erscheint „Passwort nötig“ bzw. nach der Anmeldung „Passwort eingeben“; mit „Cloud-Sicherung auf diesem Gerät nicht mehr verwenden“ lösen Sie das Gerät. Zum Weiterarbeiten an einem anderen Gerät brauchen Sie dann wieder eine Zwischenspeicher-Datei; an neuen Geräten melden Sie sich mit Ihrer Registrierungs-PDF oder Ihrem Registrierungscode an.';
// Karte „Cloud-Sicherung“ unter „Weitere Einstellungen“ (verbunden)
const CARD_TEXT = 'Ihr kompletter Stand wird nach jeder Änderung verschlüsselt gesichert. An einem anderen Gerät melden Sie sich einfach mit Ihrem Passwort an – dann ist alles da.';

// Texte der Registrierung
const REG_CREATED = 'Cloud-Sicherung eingerichtet. Ihr Stand wird ab jetzt automatisch gesichert. Anmelden können Sie sich an jedem Gerät mit Namen, Geburtsdatum und Ihrem Passwort.';
const REG_PENDING =
  'Cloud-Sicherung eingerichtet. Die Cloud-Sicherung ist gerade nicht erreichbar – Ihr Stand wird hochgeladen, sobald eine Verbindung besteht. Bis dahin melden Sie sich an anderen Geräten mit Ihrem Registrierungscode an.';
const REG_FAILED =
  'Die Cloud-Sicherung konnte noch nicht angelegt werden. Der Dienst lässt es gerade nicht zu (z. B. zu viele Versuche). ParentsDay holt das Einrichten später automatisch nach – den Zustand sehen Sie oben in der Kopfzeile. Bis dahin melden Sie sich an anderen Geräten mit Ihrem Registrierungscode an.';
// Erneute Registrierung an einem Gerät, das schon mit einer angelegten Sicherung eingerichtet ist
const REG_KEPT = 'Ihre Cloud-Sicherung bleibt verbunden. Dieses Gerät war schon mit Ihrer Cloud-Sicherung eingerichtet – Ihr Stand wird weiter damit abgeglichen.';
const REG_KEPT_OTHER =
  'Das eingegebene Passwort wurde nicht übernommen. Dieses Gerät ist schon mit einer Cloud-Sicherung eingerichtet, die ein anderes Passwort hat. Ein neues Passwort legen Sie unter „Weitere Einstellungen“ fest. Wurde es inzwischen auf einem anderen Gerät geändert, geben Sie es nach „Weiter“ oben über „Passwort eingeben“ ein.';
const REG_MOVED =
  'Ihre Cloud-Sicherung wurde inzwischen geändert. Sie hat auf einem anderen Gerät ein neues Passwort bekommen oder wurde gelöscht. Geben Sie nach „Weiter“ oben über „Passwort eingeben“ das aktuelle Passwort ein.';

// ---------- Anmeldeseite ----------

const LOGIN_MODE_KEY = 'parentsday.loginMode';
/** Zuletzt erfolgreich genutzter Weg ('password' bzw. 'code') oder null. */
const loginMode = (page) => page.evaluate((k) => localStorage.getItem(k), LOGIN_MODE_KEY);
const waitLoginMode = (page, mode) => waitUntil(async () => (await loginMode(page)) === mode, `gemerkter Weg ist nicht „${mode}“`);
const session = (page) => page.evaluate(() => sessionStorage.getItem('parentsday.session'));
const hash = (page) => page.evaluate(() => location.hash);
const activeId = (page) => page.evaluate(() => document.activeElement?.id || '');
const visible = (page, id) => page.isVisible(tid(id));

/** Alles im Speicher des Browsers – zum Vergleich vorher/nachher. */
const snapshot = (page) => page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));

/** Anfragen „Sicherung auf einem Gerät öffnen“ (POST /v1/sync/<id>/open) aus dem Protokoll eines Geräts. */
const opens = (requests) => requests.filter((r) => /^POST \S+\/v1\/sync\/[^/\s]+\/open$/.test(r));
const OPEN_URL = /\/v1\/sync\/[^/]+\/open$/;

/** Beim Dienst eingetragene Geräte (Hashwerte der Geräte-Geheimnisse) der Sicherung zu `k`. */
const devicesOf = (mb, k) => JSON.parse(cloudRow(mb, k).devices);

/** Gespeichertes Geräte-Geheimnis dieses Browsers (parentsday.cloudDevice.<Code>) oder null. */
const storedDevice = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), `parentsday.cloudDevice.${T_CODE}`);

async function gotoLogin(page, web) {
  await page.goto(`${web.url}${LOGIN}`);
  await page.locator(tid('login-submit')).waitFor();
}

/** Auf „Mit Passwort anmelden“ umschalten, falls die Seite (zuletzt mit Registrierungscode) beim Code steht. */
async function usePassword(page) {
  if (await page.isVisible(tid('login-use-password'))) await page.click(tid('login-use-password'));
  await page.locator(tid('login-password')).waitFor();
}

/** „Anmelden“ ist wieder bereit (nach einer gescheiterten Anmeldung). */
const submitReady = (page) => page.locator(`${tid('login-submit')}:not([disabled])`).waitFor(SLOW);

/** Hält POST …/open eines Geräts zurück, bis release() aufgerufen wird (je Aufruf eine Anfrage). */
async function holdOpens(d) {
  let held = 0;
  let release = () => {};
  let gate = null;
  const close = () => (gate = new Promise((r) => (release = r)));
  close();
  await d.context.route(OPEN_URL, async (route) => {
    if (route.request().method() === 'POST') {
      held++;
      await gate;
    }
    await route.continue();
  });
  return {
    held: () => held,
    release() {
      release();
      close();
    },
  };
}

/**
 * Die nächste Antwort auf POST …/open geht verloren: Der Dienst bearbeitet die Anfrage (trägt das Gerät ein), der
 * Browser erhält aber keine Antwort (wie ohne Verbindung).
 */
async function loseNextOpen(d) {
  let lose = true;
  await d.context.route(OPEN_URL, async (route) => {
    if (!lose || route.request().method() !== 'POST') return route.continue();
    lose = false;
    await route.fetch();
    return route.abort('failed');
  });
}

/**
 * Registrierung über das Formular wie register() – E-Mail-Adresse und „Passwort auf diesem Gerät merken“ wie
 * angegeben.
 * @returns {Promise<{note: string, tone: string, sync: string[], pdf: object, dialogs: string[]}>} Hinweis zur
 *   Cloud-Sicherung, seine Art (alert-success/-info/-warning), die Anfragen an die Cloud-Sicherung (/v1/sync/…) dabei,
 *   die heruntergeladene Registrierungs-PDF und die Titel aller Dialoge seit dem Absenden (watchDialogs – beobachtet
 *   auch danach weiter, solange die Seite nicht neu geladen wird)
 */
async function registerWith(d, web, { password = PASSWORD, remember = true, email = SAMPLE_TEACHER.email } = {}) {
  const { page } = d;
  const before = d.requests.length;
  await page.goto(`${web.url}#/lehrkraft/registrieren`);
  await page.locator(tid('reg-submit')).waitFor();
  await watchDialogs(page);
  await page.fill(tid('reg-firstname'), SAMPLE_TEACHER.firstName);
  await page.fill(tid('reg-lastname'), SAMPLE_TEACHER.lastName);
  await page.fill(tid('reg-birthdate'), SAMPLE_TEACHER.birthDate);
  await page.fill(tid('reg-email'), email);
  await fillNewPassword(page, 'reg', password);
  assert.equal(await page.isChecked(tid('reg-remember')), true, '„Passwort merken“ ist vorausgewählt');
  if (!remember) await page.uncheck(tid('reg-remember'));
  const pdf = await captureDownload(page, () => page.click(tid('reg-submit')));
  const note = page.locator(tid('reg-cloud-note'));
  await note.waitFor(SLOW);
  return {
    note: flat(await note.textContent()),
    tone: await note.evaluate((el) => [...el.closest('.alert').classList].find((c) => c.startsWith('alert-'))),
    sync: d.requests.slice(before).filter((r) => /\/v1\/sync\//.test(r)),
    pdf,
    dialogs: await seenDialogs(page),
  };
}

/** „Weiter“ nach der Registrierung – wartet, bis die Kopfzeile die Cloud-Sicherung im Zustand `state` zeigt. */
async function continueAfterRegister(page, state) {
  await page.click(tid('reg-continue'));
  await page.waitForFunction(() => location.hash !== '#/lehrkraft/registrieren', null, SLOW);
  await waitIndicator(page, state);
}

/** Anfragen, die beim Dienst eine Sicherung anlegen, hochladen oder öffnen (POST/PUT /v1/sync/…). */
const writes = (requests) => requests.filter((r) => /^(POST|PUT) \S+\/v1\/sync\//.test(r));
/** Abrufe einer Sicherung (GET /v1/sync/…) – der Abgleich eines verbundenen Geräts. */
const fetches = (requests) => requests.filter((r) => /^GET \S+\/v1\/sync\//.test(r));

/** Neue Klasse über das Speichermodul der App (auf jeder Seite, auch ohne Elternsprechtag). */
const addClassVia = (page, id) => page.evaluate((cls) => import('/js/core/storage.js').then((m) => m.updateState((st) => st.classes.push(cls))), classOf(id));

/**
 * Gleichen `x` und `y` über die Sicherung zu `keys` in beide Richtungen ab? Eine neue Klasse auf x kommt in der
 * Sicherung und (nach dem Abgleich) auf y an, eine neue auf y ebenso auf x.
 */
async function assertSyncsBothWays(s, x, y, keys, [idX, idY], label) {
  for (const [from, to, id] of [
    [x, y, idX],
    [y, x, idY],
  ]) {
    await addClassVia(from.page, id);
    await waitContent(s.mb, keys, (c) => classIds(c.state).includes(id), `${label}: Klasse ${id} nicht in der Cloud-Sicherung`);
    await syncNow(to.page);
    await waitUntil(async () => classIds(await readState(to.page)).includes(id), `${label}: Klasse ${id} kommt auf dem anderen Gerät nicht an`);
  }
  assert.deepEqual(classIds(await readState(x.page)), classIds(await readState(y.page)), `${label}: gleicher Stand`);
  assert.deepEqual(classIds((await decryptStored(s.mb, keys)).state), classIds(await readState(x.page)), `${label}: Stand in der Cloud`);
}

/** Neues Gerät, mit Passwort angemeldet (nicht gemerkt) – sein Stand kommt aus der Cloud-Sicherung zu `password`. */
async function deviceWithPassword(s, password = PASSWORD) {
  const d = await s.open();
  await gotoLogin(d.page, s.web);
  await fillPerson(d.page);
  await submitPassword(d.page, password);
  await waitIndicator(d.page, 'ok');
  return d;
}

/** Gerät, das sich im Dialog „Passwort eingeben“ das Passwort gemerkt und dann abgemeldet hat: weiter verbunden. */
async function rememberedDevice(s) {
  const d = await deviceUnlocked(s, { remember: true });
  await logout(d.page);
  assert.equal((await readCloud(d.page)).localKey?.authToken, (await keysFor(PASSWORD)).authToken, 'Passwort gemerkt');
  return d;
}

/** Sperre nach zu vielen Versuchen für die Lehrkraft (Tagesgrenze, direkt in der Datenbank des Dienstes). */
function lockTeacher(mb, who) {
  mb.db.db.prepare('UPDATE cloud_limits SET n = 30 WHERE key = ?').run(`o|${who}`);
}

/** Name und Geburtsdatum eintragen. */
async function fillPerson(page, { firstName = SAMPLE_TEACHER.firstName, lastName = SAMPLE_TEACHER.lastName, birthDate = SAMPLE_TEACHER.birthDate } = {}) {
  await page.fill(tid('login-firstname'), firstName);
  await page.fill(tid('login-lastname'), lastName);
  await page.fill(tid('login-birthdate'), birthDate);
}

/** Passwort eintragen und „Anmelden“. */
async function submitPassword(page, password) {
  await page.fill(tid('login-password'), password);
  await page.click(tid('login-submit'));
}

/** Wartet auf die Meldung am Passwortfeld und gibt sie zurück. */
async function passwordError(page) {
  const error = page.locator('#login-password-error:not([hidden])');
  await error.waitFor(SLOW);
  return flat(await error.textContent());
}

/** Wartet auf die Fehlermeldung im Formular (nicht am Feld) und gibt sie zurück. */
async function formError(page) {
  const alert = page.locator('.tauth-form .alert-error');
  await alert.waitFor(SLOW);
  return flat(await alert.textContent());
}

/** Merkt sich die Titel aller Dialoge, die ab jetzt erscheinen (die Seite wird beim Anmelden nicht neu geladen). */
const watchDialogs = (page) =>
  page.evaluate(() => {
    window.__dialogs = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.modal-title:not([data-seen])')) {
        el.setAttribute('data-seen', '');
        window.__dialogs.push(el.textContent.trim());
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
const seenDialogs = (page) => page.evaluate(() => window.__dialogs);

/** Ältere Fassung des Dienstes: /v1/health ohne „sync“, /v1/sync/… gibt es nicht (404 wie jede unbekannte Adresse). */
async function oldService(d, s) {
  const cors = { 'Access-Control-Allow-Origin': new URL(s.web.url).origin, Vary: 'Origin' };
  await d.context.route(`${s.mb.url}/v1/health`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: cors, body: JSON.stringify({ ok: true, service: 'ParentsDay-Briefkasten', version: 2 }) }),
  );
  await d.context.route(`${s.mb.url}/v1/sync/**`, (route) => route.fulfill({ status: 404, contentType: 'application/json; charset=utf-8', headers: cors, body: JSON.stringify({ error: 'not-found' }) }));
}

/** Text aller Seiten einer PDF – über python3 + pymupdf (null, wenn nicht verfügbar). */
function pdfText(file) {
  try {
    return execFileSync('python3', ['-c', 'import sys, pymupdf\nprint("\\n".join(p.get_text() for p in pymupdf.open(sys.argv[1])))', file], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

test('Neues Gerät: Anmeldung mit Passwort ist voreingestellt (ohne Kästchen „Passwort merken“) – leeres bzw. falsches Passwort wird am Feld abgelehnt (nichts gespeichert, Fehlversuch gezählt), das richtige holt den Stand ohne weiteren Dialog und wird nicht gemerkt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a', '6b'] });
    const stateA = await readState(a.page);
    const k = await keysFor(PASSWORD);
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 1, perDay: 1 }, 'Einrichten auf A zählt als Versuch');

    const b = await s.open();
    const { page } = b;
    // Auswahlseite nennt das Passwort
    await page.goto(`${s.web.url}#/lehrkraft`);
    await page.locator(tid('auth-choose-login')).waitFor();
    assert.equal(flat(await page.textContent(`${tid('auth-choose-login')} .tauth-choice-text`)), CHOOSE_LOGIN_CLOUD);
    await page.click(tid('auth-choose-login'));
    await waitHash(page, LOGIN);
    await page.locator(tid('login-submit')).waitFor();

    // Formular: Passwort statt Registrierungscode – ohne „Passwort merken“ (das bleibt, wie auf dem Gerät gewählt)
    assert.equal(await visible(page, 'login-password'), true, 'Passwortfeld zu sehen');
    assert.equal(await visible(page, 'login-code'), false, 'Codefeld versteckt');
    assert.equal(await page.locator(tid('login-remember')).count(), 0, 'kein Kästchen „Passwort merken“');
    assert.equal(await page.locator('.tauth-form input[type="checkbox"]').count(), 0);
    assert.ok(!flat(await page.textContent('.tauth-form')).includes('merken'), flat(await page.textContent('.tauth-form')));
    assert.equal(flat(await page.textContent(tid('login-submit'))), 'Anmelden');
    assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_PASSWORD);
    assert.equal(flat(await page.textContent('label[for="login-password"]')), 'Passwort');
    assert.equal(flat(await page.textContent('#login-password-hint')), PASSWORD_HINT);
    assert.equal(await page.getAttribute(tid('login-password'), 'type'), 'password');
    assert.equal(await page.getAttribute(tid('login-password'), 'autocomplete'), 'current-password');
    assert.equal(flat(await page.textContent(tid('login-forgot'))), 'Passwort vergessen?');
    assert.equal(flat(await page.textContent(tid('login-use-code'))), 'Ohne Passwort mit Registrierungscode anmelden');
    assert.equal(await visible(page, 'login-use-password'), false);
    assert.equal(await visible(page, 'login-upload'), true, 'Registrierungs-PDF weiterhin möglich');
    const empty = await snapshot(page);
    assert.deepEqual(
      Object.keys(empty.local).filter((key) => key.startsWith('parentsday.')),
      [],
      'neues Gerät: noch nichts gespeichert',
    );

    // Ohne Passwort: Meldung am Feld, keine Anfrage an den Dienst (Namen klein geschrieben)
    await fillPerson(page, { firstName: 'anna', lastName: 'meier' });
    await page.click(tid('login-submit'));
    assert.equal(await page.textContent('#login-password-error'), 'Bitte geben Sie Ihr Passwort ein.');
    assert.equal(await activeId(page), 'login-password');
    assert.deepEqual(opens(b.requests), []);

    // Falsches Passwort: Meldung am Feld (wird angesagt), Seite bleibt, nichts gespeichert, Fehlversuch gezählt
    await page.fill(tid('login-password'), WRONG_PASSWORD);
    assert.equal(await page.isHidden('#login-password-error'), true, 'Meldung verschwindet beim Tippen');
    await page.click(tid('login-submit'));
    await page.locator('.tauth-checking', { hasText: CHECKING }).waitFor({ timeout: 10000 });
    assert.equal(await passwordError(page), WRONG_LOGIN);
    assert.equal(await page.getAttribute('#login-password-error', 'role'), 'alert', 'Meldung wird angesagt');
    assert.equal(await page.getAttribute(tid('login-password'), 'aria-invalid'), 'true');
    assert.equal(await activeId(page), 'login-password', 'Passwort zum Überschreiben markiert');
    assert.equal(await page.locator('.tauth-checking').count(), 0, 'Hinweis „wird geprüft“ wieder weg');
    assert.equal(await hash(page), LOGIN);
    assert.deepEqual(await snapshot(page), empty, 'nichts gespeichert: kein Stand, keine Sitzung, kein Geräte-Geheimnis, kein Weg');
    assert.equal(opens(b.requests).length, 1, 'beim Dienst geprüft');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 2, perDay: 2 }, 'Fehlversuch gezählt');
    assert.equal(devicesOf(s.mb, k).length, 1, 'kein Gerät eingetragen');

    // Richtiges Passwort: kein Dialog, Stand aus der Cloud, weiter zu den Klassen – auf einem neuen Gerät nicht gemerkt
    await watchDialogs(page);
    await submitPassword(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/klassen');
    await toastWith(page, LOADED).waitFor(SLOW);
    await toastWith(page, 'Willkommen, Anna Meier!').waitFor();
    await page.locator(tid('class-tile-6b')).waitFor();
    assert.deepEqual(await tiles(page), ['5a', '6b']);
    assert.deepEqual(await seenDialogs(page), [], 'kein Dialog – auch nicht „Passwort eingeben“');
    const stateB = await readState(page);
    assert.deepEqual(stateB.teacher, stateA.teacher, 'Namen (wie registriert) und E-Mail-Adresse aus der Cloud');
    assert.equal(stateB.teacher.email, SAMPLE_TEACHER.email);
    assert.deepEqual(stateB.event, stateA.event);
    assert.deepEqual(stateB.classes, stateA.classes);
    assert.equal(stateB.savedAt, stateA.savedAt, 'Zeitpunkt der letzten Änderung bleibt erhalten');
    await waitIndicator(page, 'ok');
    assert.equal(flat(await indicator(page).textContent()), 'In der Cloud gesichert');
    assert.equal(await session(page), T_CODE);
    await waitLoginMode(page, 'password');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 2, perDay: 2 }, 'erfolgreiche Anmeldung zählt nicht');
    assert.equal(opens(b.requests).length, 2);
    const cloud = await readCloud(page);
    assert.equal(cloud.config.syncId, k.syncId);
    assert.equal(cloud.config.version, 1);
    assert.equal(cloud.config.dirty, false);
    assert.equal(cloud.config.remember, false);
    assert.equal(cloud.localKey, null, 'Passwort nicht gemerkt: Schlüssel nicht im localStorage');
    assert.equal(cloud.sessionKey?.authToken, k.authToken, 'Schlüssel nur für diese Sitzung');
    assert.equal(cloud.sessionKey.device, cloud.device, 'Geräte-Geheimnis dieses Browsers');
    const devices = JSON.parse(cloudRow(s.mb, k).devices);
    assert.equal(devices.length, 2, 'Gerät B beim Dienst eingetragen');
    assert.ok(devices.includes(await hashOf(cloud.device)));
    assert.ok(!(await allStorage(page)).includes(PASSWORD), 'Passwort nirgends im Browser gespeichert');
    await sleep(2500);
    assert.equal(cloudRow(s.mb, k).version, 1, 'übernommener Stand wird nicht wieder hochgeladen');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Gerät, das das Passwort kennt (gemerkt) bzw. mit der Sicherung eingerichtet ist (nicht gemerkt, abgemeldet): Das Passwort wird auf dem Gerät geprüft – ohne Dienst, auch ohne Verbindung, kein Versuch gezählt; „Passwort merken“ bleibt, wie es war; ein falsches geht zum Dienst und wird abgelehnt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const k = await keysFor(PASSWORD);
    const service = `${s.mb.url}/**`;

    // B merkt sich das Passwort im Dialog „Passwort eingeben“, C nicht – beide melden sich ab
    const b = await deviceUnlocked(s, { remember: true });
    const c = await deviceUnlocked(s);
    await logout(b.page);
    await logout(c.page);
    const cloudB = await readCloud(b.page);
    assert.equal(cloudB.config.remember, true);
    assert.equal(cloudB.localKey?.authToken, k.authToken, 'B: Schlüssel bleiben gemerkt');
    const cloudC = await readCloud(c.page);
    assert.equal(cloudC.config.syncId, k.syncId, 'C: Einstellungen der Sicherung bleiben');
    assert.equal(cloudC.config.remember, false);
    assert.equal(cloudC.localKey, null);
    assert.equal(cloudC.sessionKey, null, 'C: Schlüssel beim Abmelden vergessen');
    assert.equal(devicesOf(s.mb, k).length, 3, 'A, B und C eingetragen');
    let counted = { perIp: 1, perDay: 1 };
    assert.deepEqual(attempts(s.mb, k.who), counted, 'nur das Einrichten auf A');

    for (const [d, label, remember] of [
      [b, 'B', true],
      [c, 'C', false],
    ]) {
      const { page } = d;
      const device = (await readCloud(page)).device;
      const expectKeys = async (msg) => {
        const cloud = await readCloud(page);
        assert.equal(cloud.config.remember, remember, `${label} ${msg}: „Passwort merken“ wie bisher`);
        if (remember) {
          assert.equal(cloud.localKey?.authToken, k.authToken, `${label} ${msg}: Schlüssel im localStorage`);
          assert.equal(cloud.sessionKey, null, `${label} ${msg}`);
        } else {
          assert.equal(cloud.localKey, null, `${label} ${msg}: nicht im localStorage`);
          assert.equal(cloud.sessionKey?.authToken, k.authToken, `${label} ${msg}: Schlüssel nur für diese Sitzung`);
        }
        assert.equal(cloud.device, device, `${label} ${msg}: dasselbe Geräte-Geheimnis`);
        assert.equal((cloud.localKey || cloud.sessionKey).device, device);
      };

      // Ohne Verbindung zum Dienst: Die Anmeldung klappt trotzdem (Passwort auf dem Gerät geprüft), kein POST …/open
      await d.context.route(service, (route) => route.abort('internetdisconnected'));
      await gotoLogin(page, s.web);
      await usePassword(page); // zuletzt mit Registrierungscode angemeldet
      await fillPerson(page, { firstName: 'ANNA', lastName: 'meier' }); // Schreibweise egal
      let before = d.requests.length;
      await watchDialogs(page);
      await submitPassword(page, PASSWORD);
      await waitHash(page, '#/lehrkraft/klassen');
      await page.locator(tid('class-tile-5a')).waitFor();
      await waitIndicator(page, 'offline');
      assert.deepEqual(await seenDialogs(page), [], `${label}: kein Dialog`);
      assert.deepEqual(opens(d.requests.slice(before)), [], `${label}: Sicherung nicht beim Dienst geöffnet`);
      assert.ok(
        d.requests.slice(before).some((r) => r.startsWith(`GET ${s.mb.url}/v1/sync/${k.syncId}`)),
        `${label}: Abgleich versucht (Anfragen werden auch ohne Verbindung protokolliert)`,
      );
      assert.deepEqual(attempts(s.mb, k.who), counted, `${label}: kein Versuch gezählt`);
      assert.equal(await session(page), T_CODE);
      assert.equal((await readState(page)).teacher.firstName, 'Anna', 'Namen wie registriert');
      await waitLoginMode(page, 'password');
      await expectKeys('ohne Verbindung');
      await d.context.unroute(service);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await waitIndicator(page, 'ok');

      // Falsches Passwort: wird beim Dienst geprüft und abgelehnt – nichts verändert, Fehlversuch gezählt
      await logout(page);
      await gotoLogin(page, s.web);
      assert.equal(await visible(page, 'login-password'), true, 'jetzt gleich mit Passwort');
      await fillPerson(page);
      const kept = await snapshot(page);
      before = d.requests.length;
      await submitPassword(page, WRONG_PASSWORD);
      assert.equal(await passwordError(page), WRONG_LOGIN);
      assert.equal(opens(d.requests.slice(before)).length, 1, `${label}: beim Dienst nachgefragt`);
      counted = { perIp: counted.perIp + 1, perDay: counted.perDay + 1 };
      assert.deepEqual(attempts(s.mb, k.who), counted, `${label}: Fehlversuch gezählt`);
      assert.equal(await hash(page), LOGIN);
      assert.deepEqual(await snapshot(page), kept, `${label}: nichts verändert (nicht angemeldet, Einstellungen und Schlüssel wie vorher)`);

      // Gleich danach das richtige (mit Verbindung): wieder auf dem Gerät geprüft
      before = d.requests.length;
      await submitPassword(page, PASSWORD);
      await waitHash(page, '#/lehrkraft/klassen');
      await waitIndicator(page, 'ok');
      assert.deepEqual(opens(d.requests.slice(before)), [], `${label}: wieder ohne POST …/open`);
      assert.deepEqual(attempts(s.mb, k.who), counted);
      await expectKeys('mit Verbindung');
      await logout(page);
      const after = await readCloud(page);
      assert.equal(after.sessionKey, null, `${label}: Schlüssel der Sitzung beim Abmelden vergessen`);
      assert.equal(after.localKey?.authToken ?? null, remember ? k.authToken : null, `${label}: gemerkt bleibt gemerkt`);
    }
    assert.equal(devicesOf(s.mb, k).length, 3, 'keine weiteren Geräte eingetragen');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', OFFLINE);
    assertClean(c, 'Gerät C', OFFLINE);
  } finally {
    await s.close();
  }
});

test('Gerät mit eigenem, anderem Stand: Die Anmeldung mit Passwort fragt, welcher Stand gelten soll (wie beim Anmelden) – der gewählte gilt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);

    // C behält den Stand dieses Geräts
    const c = await s.open();
    await seedWithoutSession(c.page, s.web, sampleState({ classes: [classOf('7c'), classOf('8d')] }));
    await gotoLogin(c.page, s.web);
    await fillPerson(c.page);
    await watchDialogs(c.page);
    await submitPassword(c.page, PASSWORD);
    const conflict = c.page.locator(tid('cloud-conflict'));
    await conflict.waitFor(SLOW);
    assert.equal(await hash(c.page), LOGIN, 'Entscheidung vor dem Weiterleiten');
    assert.equal(flat(await modalTitle(c.page).textContent()), 'Welchen Stand möchten Sie verwenden?');
    assert.ok(flat(await conflict.textContent()).includes(LOGIN_CONFLICT), 'Text für ein gerade verbundenes Gerät');
    assert.match(flat(await c.page.textContent(tid('cloud-choice-local'))), /2 Klassen \(7c, 8d\)/);
    assert.match(flat(await c.page.textContent(tid('cloud-choice-remote'))), /1 Klasse \(5a\)/);
    assert.equal(flat(await c.page.textContent(`${tid('cloud-choice-remote')} .badge`)), 'empfohlen');
    await c.page.click(tid('cloud-choose-local'));
    await waitHash(c.page, '#/lehrkraft/klassen');
    await toastWith(c.page, KEPT_LOCAL).waitFor(SLOW);
    await waitVersion(s.mb, k, 2);
    await waitIndicator(c.page, 'ok');
    await c.page.locator(tid('class-tile-8d')).waitFor();
    assert.deepEqual(await tiles(c.page), ['7c', '8d']);
    assert.deepEqual(classIds((await decryptStored(s.mb, k)).state), ['7c', '8d'], 'Stand dieses Geräts ersetzt den in der Cloud');
    assert.deepEqual(await seenDialogs(c.page), ['Welchen Stand möchten Sie verwenden?'], 'nur die Auswahl – kein „Passwort eingeben“');
    assert.equal(JSON.parse(cloudRow(s.mb, k).devices).length, 2, 'Gerät C eingetragen');
    const cloudC = await readCloud(c.page);
    assert.equal(cloudC.config.version, 2);
    assert.equal(cloudC.config.dirty, false);

    // E übernimmt den Stand aus der Cloud (Gerät ohne Cloud-Sicherung: Passwort danach nicht gemerkt)
    const e = await s.open();
    await seedWithoutSession(e.page, s.web, sampleState({ classes: [classOf('9e')] }));
    await gotoLogin(e.page, s.web);
    await fillPerson(e.page);
    await submitPassword(e.page, PASSWORD);
    await e.page.locator(tid('cloud-conflict')).waitFor(SLOW);
    assert.match(flat(await e.page.textContent(tid('cloud-choice-local'))), /1 Klasse \(9e\)/);
    assert.match(flat(await e.page.textContent(tid('cloud-choice-remote'))), /2 Klassen \(7c, 8d\)/);
    await e.page.click(tid('cloud-choose-remote'));
    await waitHash(e.page, '#/lehrkraft/klassen');
    await toastWith(e.page, LOADED).waitFor(SLOW);
    await e.page.locator(tid('class-tile-8d')).waitFor(SLOW);
    assert.deepEqual(await tiles(e.page), ['7c', '8d']);
    await waitIndicator(e.page, 'ok');
    const cloudE = await readCloud(e.page);
    assert.equal(cloudE.config.remember, false);
    assert.equal(cloudE.localKey, null);
    assert.equal(cloudE.sessionKey?.authToken, k.authToken);
    await sleep(2500);
    assert.equal(cloudRow(s.mb, k).version, 2, 'nichts überschrieben');
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C');
    assertClean(e, 'Gerät E');
  } finally {
    await s.close();
  }
});

test('Passwort auf einem anderen Gerät geändert: Das alte führt zum passenden Hinweis (bzw. „passt nicht“, wenn die alte Sicherung gelöscht ist), das neue zur Anmeldung – auch an Geräten, die sich das alte gemerkt hatten', { timeout: TEST_TIMEOUT + 120000 }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const oldKeys = await keysFor(PASSWORD);
    const newKeys = await keysFor(NEW_PASSWORD);

    // B und D melden sich an, merken sich das Passwort (im Dialog „Passwort eingeben“) und melden sich wieder ab
    const remembered = async () => {
      const d = await deviceUnlocked(s, { remember: true });
      await logout(d.page);
      assert.equal((await readCloud(d.page)).localKey?.authToken, oldKeys.authToken);
      return d;
    };
    const b = await remembered();
    const d = await remembered();
    const deviceD = (await readCloud(d.page)).device;

    // A: „Passwort vergessen?“ → neues Passwort; die alte Sicherung enthält danach nur den Hinweis „umgezogen“
    await goSettings(a.page);
    await a.page.click(tid('cloud-card-forgot'));
    await a.page.locator(tid('cloud-forgot-dialog')).waitFor();
    await a.page.click(tid('cloud-forgot-move'));
    await a.page.locator(tid('cloud-move-dialog')).waitFor();
    await fillNewPassword(a.page, 'cloud-move', NEW_PASSWORD);
    await a.page.click(tid('cloud-move-submit'));
    await toastWith(a.page, 'Das neue Passwort gilt ab sofort. Ihre anderen Geräte fragen einmal danach.').waitFor(SLOW);
    assert.deepEqual(await decryptStored(s.mb, oldKeys), { app: 'ParentsDay', type: 'cloud-moved', v: 1 });

    // Neues Gerät C: altes Passwort → Hinweis am Feld, nichts gespeichert; neues Passwort → Stand da
    const c = await s.open();
    await gotoLogin(c.page, s.web);
    const empty = await snapshot(c.page);
    await fillPerson(c.page);
    await submitPassword(c.page, PASSWORD);
    assert.equal(await passwordError(c.page), MOVED_LOGIN);
    assert.equal(await hash(c.page), LOGIN);
    assert.deepEqual(await snapshot(c.page), empty, 'nichts gespeichert');
    await submitPassword(c.page, NEW_PASSWORD);
    await waitHash(c.page, '#/lehrkraft/klassen');
    await toastWith(c.page, LOADED).waitFor(SLOW);
    await c.page.locator(tid('class-tile-5a')).waitFor();
    await waitIndicator(c.page, 'ok');
    assert.equal((await keysOf(c.page)).syncId, newKeys.syncId);

    // B kennt noch das alte Passwort: Damit klappt die Anmeldung (auf dem Gerät geprüft). Der Abgleich danach wird
    // abgelehnt; ein Versuch, das Gerät mit dem alten Passwort wieder einzutragen, findet nur den Hinweis „umgezogen“ –
    // dann fragt ParentsDay wie bisher im Dialog nach dem neuen.
    await gotoLogin(b.page, s.web);
    await usePassword(b.page);
    await fillPerson(b.page);
    const before = b.requests.length;
    await submitPassword(b.page, PASSWORD);
    const unlock = b.page.locator(tid('cloud-unlock-dialog'));
    await unlock.waitFor(SLOW);
    assert.ok(flat(await unlock.textContent()).includes(MOVED), 'Hinweis „auf einem anderen Gerät geändert“');
    assert.equal(await b.page.isChecked(tid('cloud-unlock-remember')), true, 'wie bisher gemerkt');
    assert.deepEqual(opens(b.requests.slice(before)), [`POST ${s.mb.url}/v1/sync/${oldKeys.syncId}/open`], 'altes Passwort auf dem Gerät bestätigt, danach nur der Versuch, das Gerät wieder einzutragen');
    await unlockWith(b.page, NEW_PASSWORD);
    await waitHash(b.page, '#/lehrkraft/klassen');
    await waitIndicator(b.page, 'ok');
    const cloudB = await readCloud(b.page);
    assert.equal(cloudB.config.syncId, newKeys.syncId);
    assert.equal(cloudB.localKey?.authToken, newKeys.authToken, 'neues Passwort gemerkt');

    // D kennt ebenfalls noch das alte, meldet sich aber gleich mit dem neuen an: ohne weiteren Dialog
    await gotoLogin(d.page, s.web);
    await usePassword(d.page);
    await fillPerson(d.page);
    await watchDialogs(d.page);
    await submitPassword(d.page, NEW_PASSWORD);
    await waitHash(d.page, '#/lehrkraft/klassen');
    await toastWith(d.page, LOADED).waitFor(SLOW);
    await waitIndicator(d.page, 'ok');
    assert.deepEqual(await seenDialogs(d.page), []);
    const cloudD = await readCloud(d.page);
    assert.equal(cloudD.config.syncId, newKeys.syncId);
    assert.equal(cloudD.config.remember, true);
    assert.equal(cloudD.localKey?.authToken, newKeys.authToken, 'neues Passwort gemerkt');
    assert.equal(cloudD.device, deviceD, 'dasselbe Geräte-Geheimnis');
    assert.ok(JSON.parse(cloudRow(s.mb, newKeys).devices).includes(await hashOf(deviceD)), 'D bei der neuen Sicherung eingetragen');

    // A ändert das Passwort noch einmal mit „Passwort ändern“: Die bisherige Sicherung wird dabei gelöscht
    await a.page.click(tid('cloud-change-password'));
    await a.page.locator(tid('cloud-change-dialog')).waitFor();
    await a.page.fill(tid('cloud-change-current'), NEW_PASSWORD);
    await fillNewPassword(a.page, 'cloud-newpw', THIRD_PASSWORD);
    await a.page.click(tid('cloud-change-submit'));
    await toastWith(a.page, 'Das Passwort wurde geändert.').waitFor(SLOW);
    assert.equal(cloudRow(s.mb, newKeys), null, 'Sicherung zum bisherigen Passwort gelöscht');

    // Neues Gerät E: Das bisherige Passwort passt nicht mehr (die Sicherung gibt es nicht mehr), das neue schon
    const e = await s.open();
    await gotoLogin(e.page, s.web);
    await fillPerson(e.page);
    await submitPassword(e.page, NEW_PASSWORD);
    assert.equal(await passwordError(e.page), WRONG_LOGIN);
    assert.equal(await session(e.page), null);
    await submitPassword(e.page, THIRD_PASSWORD);
    await waitHash(e.page, '#/lehrkraft/klassen');
    await toastWith(e.page, LOADED).waitFor(SLOW);
    await e.page.locator(tid('class-tile-5a')).waitFor();
    await waitIndicator(e.page, 'ok');
    assert.equal((await keysOf(e.page)).syncId, (await keysFor(THIRD_PASSWORD)).syncId);
    assertClean(a, 'Gerät A');
    // B, C und D gleichen im Hintergrund evtl. noch mit der gelöschten Sicherung ab (403).
    assertClean(b, 'Gerät B', STATUS(403));
    assertClean(c, 'Gerät C', STATUS(403));
    assertClean(d, 'Gerät D', STATUS(403));
    assertClean(e, 'Gerät E');
  } finally {
    await s.close();
  }
});

test('Dienst nicht erreichbar bzw. ältere Fassung ohne Cloud-Sicherung: statt der Prüfung ein Hinweis – der Knopf darin führt zum Registrierungscode, damit klappt die Anmeldung', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    // Ohne Verbindung
    const b = await s.open();
    const { page } = b;
    await b.context.route(`${s.mb.url}/**`, (route) => route.abort('internetdisconnected'));
    await gotoLogin(page, s.web);
    const empty = await snapshot(page);
    await fillPerson(page);
    await submitPassword(page, PASSWORD);
    const hint = page.locator(tid('login-password-unavailable'));
    await hint.waitFor(SLOW);
    assert.equal(flat(await hint.textContent()), UNREACHABLE_LOGIN);
    assert.equal(await page.locator(`.alert-warning ${tid('login-password-unavailable')}`).count(), 1, 'als Warnung');
    assert.equal(await page.isHidden('#login-password-error'), true, 'keine Meldung am Feld – das Passwort ist nicht falsch');
    assert.equal(flat(await page.textContent(tid('login-unavailable-use-code'))), 'Mit Registrierungscode anmelden');
    assert.equal(await hash(page), LOGIN);
    assert.deepEqual(await snapshot(page), empty, 'nichts gespeichert');
    assert.equal(opens(b.requests).length, 1, 'Öffnen versucht');

    await page.click(tid('login-unavailable-use-code'));
    assert.equal(await visible(page, 'login-code'), true);
    assert.equal(await visible(page, 'login-password'), false);
    assert.equal(await activeId(page), 'login-code', 'Fokus im Codefeld');
    assert.equal(await hint.count(), 0, 'Hinweis weg');
    assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_CODE);
    assert.equal(await page.inputValue(tid('login-firstname')), SAMPLE_TEACHER.firstName, 'Angaben bleiben');
    await page.fill(tid('login-code'), SAMPLE_TEACHER.registrationCode);
    await page.click(tid('login-submit'));
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await toastWith(page, OFFLINE_TOAST).waitFor(SLOW);
    assert.equal(await session(page), T_CODE);
    assert.equal(await page.locator('.modal').count(), 0);
    await waitLoginMode(page, 'code');
    assertClean(b, 'Gerät B', OFFLINE);

    // Ältere Fassung des Dienstes (404 auf /v1/sync)
    const c = await s.open();
    await oldService(c, s);
    await gotoLogin(c.page, s.web);
    const emptyC = await snapshot(c.page);
    await fillPerson(c.page);
    await submitPassword(c.page, PASSWORD);
    const hintC = c.page.locator(tid('login-password-unavailable'));
    await hintC.waitFor(SLOW);
    assert.equal(flat(await hintC.textContent()), NOT_POSSIBLE_LOGIN);
    assert.equal(await c.page.isHidden('#login-password-error'), true);
    assert.deepEqual(await snapshot(c.page), emptyC, 'nichts gespeichert');
    await c.page.click(tid('login-unavailable-use-code'));
    await c.page.fill(tid('login-code'), SAMPLE_TEACHER.registrationCode);
    await c.page.click(tid('login-submit'));
    await waitHash(c.page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(c.page, 'not-setup');
    assert.equal(await c.page.locator('.modal').count(), 0, 'kein Dialog');
    assert.equal(await session(c.page), T_CODE);
    await waitLoginMode(c.page, 'code');
    assertClean(c, 'Gerät C', STATUS(404));
  } finally {
    await s.close();
  }
});

test('Sperre nach zu vielen Fehlversuchen (10 je Stunde und Anschluss, 30 am Tag): Das Formular meldet sie, auch das richtige Passwort wird abgewiesen, nichts gespeichert; eine Registrierung währenddessen verweist auf den Registrierungscode', { timeout: TEST_TIMEOUT + 180000 }, async () => {
  // Die Versuche je Anschluss werden je Stunde gezählt – nicht kurz vor einem Stundenwechsel beginnen.
  const toNextHour = 3600000 - (Date.now() % 3600000);
  if (toNextHour < 150000) await sleep(toNextHour + 2000);
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const k = await keysFor(PASSWORD);
    const b = await s.open();
    const { page } = b;
    await gotoLogin(page, s.web);
    const empty = await snapshot(page);
    await fillPerson(page);
    // Einrichten auf A und 9 Fehlversuche hier: 10 Versuche in dieser Stunde von diesem Anschluss
    for (let i = 1; i <= 9; i++) {
      await submitPassword(page, `${WRONG_PASSWORD} ${i}`);
      assert.equal(await passwordError(page), WRONG_LOGIN, `Versuch ${i}`);
    }
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 10, perDay: 10 });

    // 11. Versuch – mit dem richtigen Passwort: gesperrt, Meldung im Formular (nicht am Feld)
    await submitPassword(page, PASSWORD);
    let message = await formError(page);
    assert.ok(message.startsWith(FAILED), message);
    assert.match(message.slice(FAILED.length), LOCKED);
    assert.match(message, /für (eine Minute|\d+ Minuten) gesperrt/, 'bis zum Ende der Stunde');
    assert.equal(await page.isHidden('#login-password-error'), true, 'keine Meldung am Feld');
    assert.equal(await page.locator(tid('login-password-unavailable')).count(), 0, 'kein Hinweis „nicht erreichbar“');
    assert.equal(await hash(page), LOGIN);
    assert.deepEqual(await snapshot(page), empty, 'nichts gespeichert');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 10, perDay: 10 }, 'abgewiesene Versuche zählen nicht weiter');
    assert.equal(JSON.parse(cloudRow(s.mb, k).devices).length, 1, 'Gerät B nicht eingetragen');

    // Ein Gerät, das das Passwort kennt (A, gemerkt), meldet sich trotz Sperre damit an – ohne den Dienst zu fragen
    await logout(a.page);
    await gotoLogin(a.page, s.web);
    await a.page.click(tid('login-use-password')); // A hatte sich zuletzt mit Registrierungscode angemeldet
    await fillPerson(a.page);
    const beforeA = a.requests.length;
    await submitPassword(a.page, PASSWORD);
    await waitHash(a.page, '#/lehrkraft/klassen');
    await waitIndicator(a.page, 'ok');
    assert.deepEqual(opens(a.requests.slice(beforeA)), [], 'kein Öffnen beim Dienst');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 10, perDay: 10 });

    // Tagesgrenze: 30 Fehlversuche (z. B. von anderen Anschlüssen) – direkt in der Datenbank
    const db = s.mb.db.db;
    db.prepare('UPDATE cloud_limits SET n = 0 WHERE key LIKE ?').run(`o|${k.who}|%`);
    db.prepare('UPDATE cloud_limits SET n = 30 WHERE key = ?').run(`o|${k.who}`);
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 0, perDay: 30 });
    await submitPassword(page, PASSWORD);
    message = await formError(page);
    assert.ok(message.startsWith(FAILED), message);
    assert.match(message.slice(FAILED.length), LOCKED);
    assert.deepEqual(await snapshot(page), empty, 'nichts gespeichert');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 0, perDay: 30 });

    // Registrierung an einem weiteren Gerät während der Sperre: Hinweis, bis dahin mit Registrierungscode anmelden
    const d = await s.open();
    await register(d.page, s.web);
    assert.equal(flat(await d.page.textContent(tid('reg-cloud-note'))), REG_FAILED);
    assert.equal(await d.page.locator(`.alert-warning ${tid('reg-cloud-note')}`).count(), 1);
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 0, perDay: 30 }, 'abgewiesenes Anlegen zählt nicht');

    // Datenschutz-Hinweise: Auch Anmeldungen mit falschem Passwort zählen als Versuch
    await page.goto(`${s.web.url}#/datenschutz`);
    await page.getByRole('heading', { level: 1, name: 'Datenschutz-Hinweise' }).waitFor();
    assert.match(flat(await page.locator('main').innerText()), /zählt der Dienst Versuche, eine Sicherung zu öffnen oder anzulegen \(auch Anmeldungen mit falschem Passwort\) – je Lehrkraft/);
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', STATUS(429));
    assertClean(d, 'Gerät D', STATUS(429));
  } finally {
    await s.close();
  }
});

test('Umschalten zwischen Passwort und Registrierungscode, „Passwort vergessen?“: Die Code-Anmeldung fragt wie bisher im Dialog nach dem Passwort; der zuletzt erfolgreich genutzte Weg gilt beim nächsten Besuch', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const b = await s.open();
    const { page } = b;
    await gotoLogin(page, s.web);
    assert.equal(await loginMode(page), null);

    // Leeres Passwort → Meldung; „Ohne Passwort mit Registrierungscode anmelden“ wechselt und setzt sie zurück
    await fillPerson(page);
    await page.click(tid('login-submit'));
    assert.equal(await page.textContent('#login-password-error'), 'Bitte geben Sie Ihr Passwort ein.');
    await page.click(tid('login-use-code'));
    assert.equal(await visible(page, 'login-code'), true);
    assert.equal(await visible(page, 'login-password'), false);
    assert.equal(await visible(page, 'login-forgot'), false);
    assert.equal(await visible(page, 'login-use-code'), false);
    assert.equal(await visible(page, 'login-use-password'), true);
    assert.equal(flat(await page.textContent(tid('login-use-password'))), 'Mit Passwort anmelden');
    assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_CODE);
    assert.equal(await activeId(page), 'login-code', 'Fokus im Codefeld');
    assert.equal(await page.inputValue(tid('login-lastname')), SAMPLE_TEACHER.lastName, 'Angaben bleiben');

    // Code-Modus: leerer bzw. falscher Code wie bisher
    await page.click(tid('login-submit'));
    assert.equal(await page.textContent('#login-code-error'), 'Bitte geben Sie Ihren Registrierungscode ein.');
    await page.fill(tid('login-code'), 'AM00000000');
    await page.click(tid('login-submit'));
    assert.equal(await formError(page), CODE_MISMATCH);

    // „Mit Passwort anmelden“: zurück, Meldungen weg, Fokus im Passwortfeld
    await page.click(tid('login-use-password'));
    assert.equal(await visible(page, 'login-password'), true);
    assert.equal(await visible(page, 'login-code'), false);
    assert.equal(await visible(page, 'login-forgot'), true);
    assert.equal(await visible(page, 'login-use-password'), false);
    assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_PASSWORD);
    assert.equal(await activeId(page), 'login-password');
    assert.equal(await page.isHidden('#login-password-error'), true, 'alte Meldung am Passwortfeld weg');
    assert.equal(await page.locator('.tauth-form .alert').count(), 0, 'Meldung im Formular weg');
    assert.deepEqual(opens(b.requests), [], 'bisher keine Anfrage an den Dienst');

    // „Passwort vergessen?“: Hinweis und Registrierungscode (Fokus im Codefeld)
    await page.click(tid('login-forgot'));
    assert.equal(flat(await page.textContent(tid('login-forgot-note'))), FORGOT_NOTE);
    assert.equal(await page.locator(`.alert-info ${tid('login-forgot-note')}`).count(), 1);
    assert.equal(await visible(page, 'login-code'), true);
    assert.equal(await visible(page, 'login-password'), false);
    assert.equal(await activeId(page), 'login-code', 'Fokus im Codefeld');
    assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_CODE);

    // Anmeldung mit Registrierungscode: danach fragt ParentsDay wie bisher im Dialog nach dem Passwort
    await page.fill(tid('login-code'), SAMPLE_TEACHER.registrationCode.toLowerCase());
    await page.click(tid('login-submit'));
    const unlock = page.locator(tid('cloud-unlock-dialog'));
    await unlock.waitFor(SLOW);
    assert.equal(flat(await modalTitle(page).textContent()), 'Passwort eingeben');
    assert.equal(await hash(page), LOGIN, 'Dialog vor dem Weiterleiten');
    await unlockWith(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/klassen');
    await toastWith(page, LOADED).waitFor(SLOW);
    await waitIndicator(page, 'ok');
    await waitLoginMode(page, 'code');

    // Nächster Besuch: gleich mit Registrierungscode
    await logout(page);
    await gotoLogin(page, s.web);
    assert.equal(await visible(page, 'login-code'), true);
    assert.equal(await visible(page, 'login-password'), false);
    assert.equal(await visible(page, 'login-use-password'), true);
    assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_CODE);

    // Ein gescheiterter Versuch mit Passwort ändert daran nichts
    await page.click(tid('login-use-password'));
    await fillPerson(page);
    await submitPassword(page, WRONG_PASSWORD);
    assert.equal(await passwordError(page), WRONG_LOGIN);
    assert.equal(await loginMode(page), 'code');
    await page.reload();
    await page.locator(tid('login-submit')).waitFor();
    assert.equal(await visible(page, 'login-code'), true, 'weiter mit Registrierungscode');

    // Erfolgreich mit Passwort (gleicher Stand wie in der Cloud: keine Rückfrage) → ab dann wieder mit Passwort
    await page.click(tid('login-use-password'));
    await fillPerson(page);
    await watchDialogs(page);
    const before = b.requests.length;
    await submitPassword(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/klassen');
    await waitIndicator(page, 'ok');
    assert.deepEqual(await seenDialogs(page), [], 'keine Rückfrage');
    assert.deepEqual(opens(b.requests.slice(before)), [], 'Gerät schon mit der Sicherung eingerichtet: auf dem Gerät geprüft');
    const cloud = await readCloud(page);
    assert.equal(cloud.config.remember, false, 'im Dialog nicht gemerkt – bleibt so');
    assert.equal(cloud.localKey, null);
    await waitLoginMode(page, 'password');
    await logout(page);
    await gotoLogin(page, s.web);
    assert.equal(await visible(page, 'login-password'), true);
    assert.equal(await visible(page, 'login-code'), false);
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Ohne Dienst: nur Registrierungscode – kein Passwortfeld, keine Umschalt-Links; die Anmeldung läuft wie bisher', { timeout: TEST_TIMEOUT }, async () => {
  const web = await startServer(); // ohne mailboxUrl: kein Dienst
  const d = await launch();
  d.requests = [];
  d.context.on('request', (req) => d.requests.push(`${req.method()} ${req.url()}`));
  try {
    const { page } = d;
    await page.goto(`${web.url}#/lehrkraft`);
    await page.locator(tid('auth-choose-login')).waitFor();
    assert.equal(flat(await page.textContent(`${tid('auth-choose-login')} .tauth-choice-text`)), CHOOSE_LOGIN_PLAIN);
    // Auch ein (mit Dienst) gemerkter Weg „Passwort“ ändert daran nichts
    await page.evaluate((key) => localStorage.setItem(key, 'password'), LOGIN_MODE_KEY);
    await gotoLogin(page, web);
    assert.equal(await visible(page, 'login-code'), true);
    for (const id of ['login-password', 'login-remember', 'login-forgot', 'login-use-code', 'login-use-password']) {
      assert.equal(await page.locator(tid(id)).count(), 0, `${id} gibt es nicht`);
    }
    assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_CODE);
    await fillPerson(page);
    await page.click(tid('login-submit'));
    assert.equal(await page.textContent('#login-code-error'), 'Bitte geben Sie Ihren Registrierungscode ein.');
    await page.fill(tid('login-code'), SAMPLE_TEACHER.registrationCode.toLowerCase());
    await page.click(tid('login-submit'));
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await toastWith(page, 'Willkommen, Anna Meier!').waitFor();
    assert.equal(await session(page), T_CODE);
    assert.equal(await page.locator('.modal').count(), 0, 'kein Dialog');
    assert.equal(await page.locator(tid('cloud-indicator')).count(), 0, 'keine Anzeige der Cloud-Sicherung');
    assert.equal(await loginMode(page), 'password', 'ohne Dienst wird kein Weg gemerkt');
    assert.deepEqual(
      d.requests.filter((r) => !r.startsWith(`GET ${web.url}`)),
      [],
      'nur Anfragen an die Seite selbst',
    );
    assert.deepEqual(d.errors, []);
  } finally {
    await d.browser.close();
    await web.close();
  }
});

test('Daten einer anderen Lehrkraft mit demselben Lehrkräftecode in diesem Browser: Die Anmeldung mit Passwort wird abgelehnt, bevor das Passwort geprüft wird – nichts verändert', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const k = await keysFor(PASSWORD);
    // Anton Müller hat wegen gleicher Anfangsbuchstaben und gleichen Geburtsdatums denselben Lehrkräftecode
    const anton = {
      ...SAMPLE_TEACHER,
      firstName: 'Anton',
      lastName: 'Müller',
      email: 'anton@andere-schule.example',
      registrationCode: registrationCode('Anton', 'Müller', SAMPLE_TEACHER.birthDate),
    };
    assert.equal(teacherCode(anton.firstName, anton.lastName, anton.birthDate), T_CODE);
    const c = await s.open();
    const { page } = c;
    await seedWithoutSession(page, s.web, sampleState({ teacher: anton, classes: [classOf('9e')] }));
    await gotoLogin(page, s.web);
    const before = await snapshot(page);
    await fillPerson(page);
    await submitPassword(page, PASSWORD);
    assert.equal(await formError(page), `${FAILED}${CODE_COLLISION}`);
    assert.equal(await page.isHidden('#login-password-error'), true, 'keine Meldung am Passwortfeld');
    assert.equal(await hash(page), LOGIN);
    assert.deepEqual(opens(c.requests), [], 'Passwort gar nicht erst beim Dienst geprüft');
    assert.deepEqual(await snapshot(page), before, 'nichts verändert (auch keine Sitzung)');
    assert.equal((await readState(page)).teacher.firstName, 'Anton');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 1, perDay: 1 }, 'kein Versuch gezählt');

    // Mit Registrierungscode ebenso
    await page.click(tid('login-use-code'));
    await page.fill(tid('login-code'), SAMPLE_TEACHER.registrationCode);
    await page.click(tid('login-submit'));
    assert.equal(await formError(page), `${FAILED}${CODE_COLLISION}`);
    assert.deepEqual(await snapshot(page), before, 'nichts verändert');
    assert.deepEqual(
      c.requests.filter((r) => r.includes('/v1/')),
      [],
      'keine Anfrage an den Dienst',
    );
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C');
  } finally {
    await s.close();
  }
});

test('Registrierung mit selbst gewähltem Passwort: Genau damit anmelden – am selben Gerät nach dem Abmelden und an einem neuen; die Registrierungs-PDF führt wie bisher über „Passwort eingeben“', { timeout: TEST_TIMEOUT }, async (t) => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const a = await s.open();
    const { page } = a;
    await page.goto(`${s.web.url}#/lehrkraft/registrieren`);
    await page.locator(tid('reg-cloud')).waitFor();
    assert.match(flat(await page.textContent(tid('reg-cloud'))), /Mit diesem Passwort melden Sie sich künftig an – an jedem Gerät, und Ihr aktueller Stand ist sofort da\./);
    // „Passwort merken“ gibt es (nur noch) bei der Registrierung – mit eigenem Hinweis
    assert.equal(await page.isChecked(tid('reg-remember')), true, 'vorausgewählt');
    assert.equal(flat(await page.textContent(`${tid('reg-cloud')} label[for="reg-remember"]`)), 'Passwort auf diesem Gerät merken');
    assert.equal(flat(await page.textContent(`${tid('reg-cloud')} .cloud-remember .field-hint`)), REMEMBER_HINT);
    const reg = await register(page, s.web);
    assert.equal(flat(await page.textContent(tid('reg-cloud-note'))), REG_CREATED);
    assert.match(flat(await page.textContent('.tauth-codes')), /Zum Anmelden ohne Passwort – zusammen mit Namen und Geburtsdatum\./);
    const text = pdfText(reg.file);
    if (text === null) t.diagnostic('python3/pymupdf nicht verfügbar – Text der PDF nicht geprüft');
    else {
      const pdf = flat(text);
      assert.match(pdf, /Anmelden können Sie sich bei ParentsDay mit Ihrem Passwort/);
      assert.match(pdf, /Geben Sie Vorname, Nachname, Geburtsdatum und Ihr Passwort ein\./);
      assert.match(pdf, /Zum Anmelden ohne Passwort/);
      assert.ok(!pdf.includes(PASSWORD), 'Passwort nicht in der PDF');
    }
    await page.click(tid('reg-continue'));
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(page, 'ok');
    assert.equal(await loginMode(page), null, 'Registrierung merkt keinen Weg');

    // Gleiches Gerät nach dem Abmelden: mit dem Passwort aus der Registrierung (dort gemerkt) – ohne Anfrage beim Dienst
    await logout(page);
    assert.equal((await readCloud(page)).localKey?.authToken, k.authToken, 'bei der Registrierung gemerkt');
    await gotoLogin(page, s.web);
    assert.equal(await visible(page, 'login-password'), true);
    await fillPerson(page);
    let before = a.requests.length;
    await submitPassword(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(page, 'ok');
    assert.deepEqual(opens(a.requests.slice(before)), []);
    await waitLoginMode(page, 'password');
    const cloudA = await readCloud(page);
    assert.equal(cloudA.config.remember, true, 'weiter gemerkt');
    assert.equal(cloudA.localKey?.authToken, k.authToken);

    // Neues Gerät B: mit demselben Passwort – Stand (samt E-Mail-Adresse) aus der Cloud, kein weiterer Dialog
    const b = await s.open();
    await gotoLogin(b.page, s.web);
    await fillPerson(b.page);
    await watchDialogs(b.page);
    before = b.requests.length;
    await submitPassword(b.page, PASSWORD);
    await waitHash(b.page, '#/lehrkraft/elternsprechtag');
    await toastWith(b.page, LOADED).waitFor(SLOW);
    await waitIndicator(b.page, 'ok');
    assert.deepEqual(await seenDialogs(b.page), []);
    assert.equal(opens(b.requests.slice(before)).length, 1);
    assert.equal((await readState(b.page)).teacher.email, SAMPLE_TEACHER.email, 'E-Mail-Adresse aus der Cloud');
    assert.equal(await b.page.locator('.evt-empty-device').count(), 0, 'kein Hinweis „noch keine Daten auf diesem Gerät“');
    const cloudB = await readCloud(b.page);
    assert.equal(cloudB.config.remember, false, 'neues Gerät: nicht gemerkt');
    assert.equal(cloudB.localKey, null);
    assert.equal(cloudB.sessionKey?.authToken, k.authToken);

    // Gerät C: mit der Registrierungs-PDF – danach wie bisher „Passwort eingeben“
    const c = await s.open();
    await gotoLogin(c.page, s.web);
    await c.page.setInputFiles(`${tid('login-upload')} input[type=file]`, reg.file);
    await c.page.locator(tid('cloud-unlock-dialog')).waitFor(SLOW);
    assert.equal(flat(await modalTitle(c.page).textContent()), 'Passwort eingeben');
    await unlockWith(c.page, PASSWORD);
    await waitHash(c.page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(c.page, 'ok');
    assert.equal(await loginMode(c.page), null, 'PDF-Anmeldung merkt keinen Weg');
    assert.equal(JSON.parse(cloudRow(s.mb, k).devices).length, 3, 'A, B und C eingetragen');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 1, perDay: 1 }, 'nur das Anlegen bei der Registrierung');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
    assertClean(c, 'Gerät C');
  } finally {
    await s.close();
  }
});

test('Nicht gesicherte Änderungen dieses Geräts (ohne Verbindung abgemeldet, Passwort nicht gemerkt): Die Anmeldung mit Passwort (auf dem Gerät geprüft) lädt sie ohne Rückfrage hoch – hat inzwischen auch ein anderes Gerät geändert, entscheidet die Lehrkraft', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);
    const b = await s.open();
    const { page } = b;
    const service = `${s.mb.url}/**`;
    const login = async () => {
      await gotoLogin(page, s.web);
      await fillPerson(page);
      await submitPassword(page, PASSWORD);
    };
    /** Ohne Verbindung eine Klasse anlegen und abmelden („Trotzdem abmelden“) – die Änderung bleibt nur hier. */
    const changeOffline = async (id) => {
      await b.context.route(service, (route) => route.abort('internetdisconnected'));
      await addClass(page, id);
      await waitIndicator(page, 'offline');
      await page.locator('.header-actions').getByRole('button', { name: 'Abmelden', exact: true }).click();
      await page.locator('.modal', { hasText: 'Abmelden?' }).getByRole('button', { name: 'Abmelden', exact: true }).click();
      const warn = page.locator('.modal', { hasText: 'Noch nicht in der Cloud gesichert' });
      await warn.waitFor(SLOW);
      await warn.getByRole('button', { name: 'Trotzdem abmelden' }).click();
      await waitHash(page, '#/');
      const cloud = await readCloud(page);
      assert.equal(cloud.config.dirty, true, 'Änderung als nicht gesichert vermerkt');
      assert.equal(cloud.sessionKey, null, 'nicht gemerktes Passwort vergessen');
      await b.context.unroute(service);
    };

    await login();
    await waitHash(page, '#/lehrkraft/klassen');
    await waitIndicator(page, 'ok');

    // Runde 1: Nur B hat geändert → Stand dieses Geräts wird ohne Rückfrage hochgeladen. B ist mit der Sicherung
    // eingerichtet: Das Passwort wird auf dem Gerät geprüft, danach wird abgeglichen wie an einem verbundenen Gerät.
    await changeOffline('6b');
    await watchDialogs(page);
    let before = b.requests.length;
    await login();
    await waitHash(page, '#/lehrkraft/klassen');
    await waitVersion(s.mb, k, 2);
    await waitIndicator(page, 'ok');
    assert.deepEqual(await seenDialogs(page), [], 'keine Rückfrage');
    assert.deepEqual(opens(b.requests.slice(before)), [], 'auf dem Gerät geprüft');
    assert.deepEqual(classIds((await decryptStored(s.mb, k)).state), ['5a', '6b'], 'Änderung von B gesichert');
    await page.locator(tid('class-tile-6b')).waitFor();
    assert.deepEqual(await tiles(page), ['5a', '6b']);

    // Runde 2: B ändert ohne Verbindung, A ebenfalls → beim Anmelden mit Passwort entscheidet die Lehrkraft
    await changeOffline('7c');
    await refocus(a.page);
    await a.page.locator(tid('class-tile-6b')).waitFor(SLOW);
    await addClass(a.page, '8d');
    await waitVersion(s.mb, k, 3);
    before = b.requests.length;
    await login();
    const conflict = page.locator(tid('cloud-conflict'));
    await conflict.waitFor(SLOW);
    assert.ok(flat(await conflict.textContent()).includes(SYNC_CONFLICT), 'beide Seiten haben seit dem letzten Abgleich geändert');
    assert.match(flat(await page.textContent(tid('cloud-choice-local'))), /3 Klassen \(5a, 6b, 7c\)/);
    assert.match(flat(await page.textContent(tid('cloud-choice-remote'))), /3 Klassen \(5a, 6b, 8d\)/);
    assert.deepEqual(opens(b.requests.slice(before)), [], 'auf dem Gerät geprüft');
    await page.click(tid('cloud-choose-remote'));
    await waitHash(page, '#/lehrkraft/klassen');
    await page.locator(tid('class-tile-8d')).waitFor(SLOW);
    assert.deepEqual(await tiles(page), ['5a', '6b', '8d']);
    await waitIndicator(page, 'ok');
    await sleep(2500);
    assert.equal(cloudRow(s.mb, k).version, 3, 'Stand aus der Cloud übernommen – nichts hochgeladen');
    assertClean(a, 'Gerät A');
    // 409: Das Hochladen der Änderung von B traf auf den neueren Stand von A (daraus die Rückfrage).
    assertClean(b, 'Gerät B', OFFLINE, STATUS(409));
  } finally {
    await s.close();
  }
});

test('Während das Passwort geprüft wird, ist „Anmelden“ gesperrt und die Umschalt-Links tun nichts: Die Meldung zum falschen Passwort steht danach sichtbar am Feld, nach dem richtigen wird „Passwort“ als Weg gemerkt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const k = await keysFor(PASSWORD);
    const b = await s.open();
    const { page } = b;
    const gate = await holdOpens(b); // POST …/open zurückhalten, bis die Seite währenddessen geprüft ist
    await gotoLogin(page, s.web);
    await fillPerson(page);
    const submit = page.locator(tid('login-submit'));

    /** Während der n-ten Prüfung: Knopf gesperrt, Klicks auf die Links und erneutes Absenden ändern nichts. */
    const whileChecking = async (n) => {
      await waitUntil(() => gate.held() === n, 'Öffnen nicht angefragt');
      assert.equal(await submit.isDisabled(), true, '„Anmelden“ gesperrt');
      assert.equal(await submit.getAttribute('aria-busy'), 'true');
      assert.equal(flat(await submit.textContent()), 'Bitte warten …');
      assert.equal(flat(await page.textContent('.tauth-checking')), CHECKING);
      await page.click(tid('login-use-code'));
      await page.click(tid('login-forgot'));
      assert.equal(await visible(page, 'login-password'), true, 'Passwortfeld bleibt');
      assert.equal(await visible(page, 'login-code'), false, 'kein Wechsel zum Registrierungscode');
      assert.equal(await visible(page, 'login-use-password'), false);
      assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_PASSWORD);
      assert.equal(await page.locator(tid('login-forgot-note')).count(), 0, 'kein Hinweis „Passwort vergessen?“');
      assert.equal(flat(await page.textContent('.tauth-checking')), CHECKING, 'Hinweis „wird geprüft“ bleibt');
      await page.press(tid('login-password'), 'Enter');
      await sleep(300);
      assert.equal(gate.held(), n, 'nicht noch einmal abgeschickt');
    };

    // Falsches Passwort
    await submitPassword(page, WRONG_PASSWORD);
    await whileChecking(1);
    gate.release();
    assert.equal(await passwordError(page), WRONG_LOGIN);
    assert.equal(await visible(page, 'login-password'), true, 'Meldung sichtbar am Passwortfeld');
    assert.equal(await page.isVisible('#login-password-error'), true);
    await submitReady(page);
    assert.equal(await submit.getAttribute('aria-busy'), null);
    assert.equal(flat(await submit.textContent()), 'Anmelden');
    assert.equal(await loginMode(page), null, 'kein Weg gemerkt');

    // Danach lassen sich die Links wieder nutzen (und zurück)
    await page.click(tid('login-use-code'));
    assert.equal(await visible(page, 'login-code'), true);
    await page.click(tid('login-use-password'));
    assert.equal(await visible(page, 'login-password'), true);

    // Richtiges Passwort
    await submitPassword(page, PASSWORD);
    await whileChecking(2);
    gate.release();
    await waitHash(page, '#/lehrkraft/klassen');
    await waitIndicator(page, 'ok');
    await waitLoginMode(page, 'password');
    assert.equal(opens(b.requests).length, 2);
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 2, perDay: 2 }, 'Einrichten und ein Fehlversuch');

    // Anmeldung mit Registrierungscode: Solange danach die Cloud-Sicherung geprüft wird, schaltet „Mit Passwort
    // anmelden“ nicht um; gemerkt wird „code“.
    await logout(page);
    await b.context.unroute(OPEN_URL);
    await gotoLogin(page, s.web);
    await page.click(tid('login-use-code'));
    let releaseHealth = () => {};
    const health = new Promise((r) => (releaseHealth = r));
    let healthHeld = 0;
    await b.context.route(`${s.mb.url}/v1/health`, async (route) => {
      healthHeld++;
      await health;
      await route.continue();
    });
    // B ist mit der Sicherung eingerichtet (Passwort nicht gemerkt): Nach der Code-Anmeldung kommt „Passwort eingeben“.
    await fillPerson(page);
    await page.fill(tid('login-code'), SAMPLE_TEACHER.registrationCode);
    await page.click(tid('login-submit'));
    await waitUntil(() => healthHeld >= 1, 'Dienst nicht geprüft');
    assert.equal(await submit.isDisabled(), true, '„Anmelden“ gesperrt');
    await page.click(tid('login-use-password'));
    assert.equal(await visible(page, 'login-code'), true, 'Codefeld bleibt');
    assert.equal(await visible(page, 'login-password'), false);
    assert.equal(flat(await page.textContent(tid('login-data-intro'))), INTRO_CODE);
    releaseHealth();
    await unlockWith(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/klassen');
    await waitLoginMode(page, 'code');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Registrierung ohne Verbindung und ohne „Passwort merken“, abgemeldet, bevor die Sicherung angelegt war: Mit dem Passwort aus der Registrierung klappt die Anmeldung an diesem Gerät trotzdem (auf dem Gerät geprüft, kein Versuch gezählt), die Sicherung wird dann angelegt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const b = await s.open();
    const { page } = b;
    const service = `${s.mb.url}/**`;
    await b.context.route(service, (route) => route.abort('internetdisconnected'));
    await page.goto(`${s.web.url}#/lehrkraft/registrieren`);
    await page.fill(tid('reg-firstname'), SAMPLE_TEACHER.firstName);
    await page.fill(tid('reg-lastname'), SAMPLE_TEACHER.lastName);
    await page.fill(tid('reg-birthdate'), SAMPLE_TEACHER.birthDate);
    await page.fill(tid('reg-email'), SAMPLE_TEACHER.email);
    await fillNewPassword(page, 'reg', PASSWORD);
    await page.uncheck(tid('reg-remember')); // z. B. an einem gemeinsam genutzten Schulrechner
    await captureDownload(page, () => page.click(tid('reg-submit')));
    await page.locator(tid('reg-cloud-note')).waitFor(SLOW);
    assert.equal(flat(await page.textContent(tid('reg-cloud-note'))), REG_PENDING);
    let cloud = await readCloud(page);
    assert.equal(cloud.config.pendingCreate, true, 'Sicherung wird später angelegt');
    assert.equal(cloud.config.syncId, k.syncId);
    assert.equal(cloud.localKey, null);
    assert.ok(cloud.sessionKey, 'Passwort nur für diese Sitzung');
    await page.click(tid('reg-continue'));
    await waitHash(page, '#/lehrkraft/elternsprechtag');
    await waitIndicator(page, 'offline');

    // Abmelden, bevor die Verbindung wieder da ist („Trotzdem abmelden“)
    await page.locator('.header-actions').getByRole('button', { name: 'Abmelden', exact: true }).click();
    await page.locator('.modal', { hasText: 'Abmelden?' }).getByRole('button', { name: 'Abmelden', exact: true }).click();
    const warn = page.locator('.modal', { hasText: 'Noch nicht in der Cloud gesichert' });
    await warn.waitFor(SLOW);
    await warn.getByRole('button', { name: 'Trotzdem abmelden' }).click();
    await waitHash(page, '#/');
    cloud = await readCloud(page);
    assert.equal(cloud.sessionKey, null, 'nicht gemerktes Passwort vergessen');
    assert.equal(cloud.config.pendingCreate, true);
    assert.deepEqual(cloudRows(s.mb), [], 'noch keine Sicherung beim Dienst');

    // Wieder mit Verbindung: Anmeldung mit dem Passwort aus der Registrierung an genau diesem Gerät
    await b.context.unroute(service);
    await gotoLogin(page, s.web);
    await fillPerson(page);
    const before = b.requests.length;
    await submitPassword(page, PASSWORD);
    const outcome = await Promise.race([
      waitHash(page, '#/lehrkraft/elternsprechtag').then(() => 'angemeldet'),
      page
        .locator('#login-password-error:not([hidden])')
        .waitFor(SLOW)
        .then(async () => `Meldung am Passwortfeld: ${flat(await page.textContent('#login-password-error'))}`),
    ]);
    assert.equal(outcome, 'angemeldet', 'das Passwort aus der Registrierung ist richtig');
    await waitVersion(s.mb, k, 1);
    await waitIndicator(page, 'ok');
    assert.deepEqual(opens(b.requests.slice(before)), [], 'auf dem Gerät geprüft – kein POST …/open');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 1, perDay: 1 }, 'nur das Anlegen zählt als Versuch');
    cloud = await readCloud(page);
    assert.equal(cloud.config.pendingCreate, false, 'Sicherung angelegt');
    assert.equal(cloud.config.version, 1);
    assert.equal(cloud.config.remember, false, 'weiter nicht gemerkt');
    assert.equal(cloud.localKey, null);
    assert.equal(cloud.sessionKey?.authToken, k.authToken);
    assert.deepEqual(devicesOf(s.mb, k), [await hashOf(cloud.device)], 'dieses Gerät eingetragen');
    assert.equal((await decryptStored(s.mb, k)).state.teacher.email, SAMPLE_TEACHER.email, 'Stand der Registrierung gesichert');
    await waitLoginMode(page, 'password');
    assertClean(b, 'Gerät B', OFFLINE);
  } finally {
    await s.close();
  }
});

test('Browser ohne DecompressionStream, Sicherung komprimiert: Das richtige Passwort führt zur Meldung „kann die Cloud-Sicherung nicht lesen“ – auch nach mehreren Versuchen (und neu geladener Seite) ist der Browser beim Dienst nur einmal eingetragen, sein Geräte-Geheimnis gespeichert', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const k = await keysFor(PASSWORD);
    assert.equal(cloudRow(s.mb, k).z, 1, 'Sicherung komprimiert');
    const b = await s.open();
    const { page } = b;
    await page.addInitScript(() => {
      delete window.DecompressionStream;
    });
    await gotoLogin(page, s.web);
    assert.equal(await page.evaluate(() => typeof window.DecompressionStream), 'undefined');
    await fillPerson(page);
    let device = null;
    const attempt = async (label) => {
      await submitPassword(page, PASSWORD);
      assert.equal(await formError(page), `${FAILED}${UNREADABLE}`, label);
      await submitReady(page);
      assert.equal(await page.isHidden('#login-password-error'), true, `${label}: keine Meldung am Feld – das Passwort ist richtig`);
      assert.equal(await hash(page), LOGIN, label);
      assert.equal(await session(page), null, `${label}: nicht angemeldet`);
      assert.equal(await readState(page), null, `${label}: kein Stand angelegt`);
      const stored = await storedDevice(page);
      assert.ok(stored, `${label}: Geräte-Geheimnis gespeichert`);
      if (device) assert.equal(stored, device, `${label}: dasselbe Geräte-Geheimnis`);
      device = stored;
      const devices = devicesOf(s.mb, k);
      assert.equal(devices.length, 2, `${label}: nur ein zusätzliches Gerät eingetragen`);
      assert.ok(devices.includes(await hashOf(device)), `${label}: mit dem gespeicherten Geheimnis`);
    };
    await attempt('Versuch 1');
    await attempt('Versuch 2');
    await attempt('Versuch 3');
    await page.reload();
    await page.locator(tid('login-submit')).waitFor();
    await fillPerson(page);
    await attempt('nach dem Neuladen');
    assert.equal(opens(b.requests).length, 4, 'jedes Mal beim Dienst geöffnet');
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 1, perDay: 1 }, 'richtiges Passwort: kein Versuch gezählt');
    assert.ok(!(await allStorage(page)).includes(PASSWORD));
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

test('Neues Gerät: zweimal ein falsches Passwort, dann das richtige – auch wenn die Antwort darauf verloren geht, ist der Browser beim Dienst danach genau einmal eingetragen (mit dem gespeicherten Geräte-Geheimnis)', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s);
    const k = await keysFor(PASSWORD);
    const b = await s.open();
    const { page } = b;
    await gotoLogin(page, s.web);
    await fillPerson(page);
    for (const i of [1, 2]) {
      await submitPassword(page, `${WRONG_PASSWORD} ${i}`);
      assert.equal(await passwordError(page), WRONG_LOGIN, `Versuch ${i}`);
      await submitReady(page);
      assert.equal(await storedDevice(page), null, `Versuch ${i}: kein Geräte-Geheimnis gespeichert`);
      assert.equal(devicesOf(s.mb, k).length, 1, `Versuch ${i}: kein Gerät eingetragen`);
    }

    // Richtiges Passwort – der Dienst trägt das Gerät ein, die Antwort erreicht den Browser aber nicht
    await loseNextOpen(b);
    await submitPassword(page, PASSWORD);
    const hint = page.locator(tid('login-password-unavailable'));
    await hint.waitFor(SLOW);
    assert.equal(flat(await hint.textContent()), UNREACHABLE_LOGIN);
    await submitReady(page);
    assert.equal(devicesOf(s.mb, k).length, 2, 'beim Dienst schon eingetragen');
    assert.equal(await storedDevice(page), null, 'ohne Antwort noch nicht gespeichert');
    assert.equal(await session(page), null);

    // Noch einmal: dasselbe Geheimnis – kein zweites Gerät
    await submitPassword(page, PASSWORD);
    await waitHash(page, '#/lehrkraft/klassen');
    await toastWith(page, LOADED).waitFor(SLOW);
    await waitIndicator(page, 'ok');
    const cloud = await readCloud(page);
    assert.ok(cloud.device, 'Geräte-Geheimnis gespeichert');
    const devices = devicesOf(s.mb, k);
    assert.equal(devices.length, 2, 'genau ein neues Gerät eingetragen');
    assert.ok(devices.includes(await hashOf(cloud.device)), 'das gespeicherte Geheimnis');
    assert.equal(cloud.sessionKey?.device, cloud.device);
    assert.equal(opens(b.requests).length, 4);
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 3, perDay: 3 }, 'Einrichten und zwei Fehlversuche');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', OFFLINE);
  } finally {
    await s.close();
  }
});

test('Neues Gerät: Die Antwort auf die Anmeldung mit Passwort geht verloren – danach mit Registrierungscode angemeldet und das Passwort im Dialog „Passwort eingeben“ bzw. beim Einrichten eingegeben: Der Browser ist beim Dienst genau einmal eingetragen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);

    /** Anmeldung mit Passwort, deren Antwort verloren geht; dann über den Knopf im Hinweis mit Registrierungscode. */
    const lostThenCode = async (d, label) => {
      const { page } = d;
      await gotoLogin(page, s.web);
      await fillPerson(page);
      const devicesBefore = devicesOf(s.mb, k).length;
      await loseNextOpen(d);
      await submitPassword(page, PASSWORD);
      const hint = page.locator(tid('login-password-unavailable'));
      await hint.waitFor(SLOW);
      assert.equal(flat(await hint.textContent()), UNREACHABLE_LOGIN, label);
      await submitReady(page);
      assert.equal(devicesOf(s.mb, k).length, devicesBefore + 1, `${label}: beim Dienst schon eingetragen`);
      assert.equal(await storedDevice(page), null, `${label}: ohne Antwort noch nicht gespeichert`);
      assert.equal(await session(page), null, `${label}: nicht angemeldet`);
      await d.context.unroute(OPEN_URL);
      await page.click(tid('login-unavailable-use-code'));
      assert.equal(await activeId(page), 'login-code', `${label}: Fokus im Codefeld`);
      await page.fill(tid('login-code'), SAMPLE_TEACHER.registrationCode);
      await page.click(tid('login-submit'));
    };
    /** Genau ein Eintrag für diesen Browser – mit dem gespeicherten Geräte-Geheimnis. */
    const onceAtService = async (d, count, label) => {
      const cloud = await readCloud(d.page);
      assert.ok(cloud.device, `${label}: Geräte-Geheimnis gespeichert`);
      assert.equal((cloud.localKey || cloud.sessionKey)?.device, cloud.device, label);
      const devices = devicesOf(s.mb, k);
      assert.equal(devices.length, count, `${label}: genau ein neues Gerät eingetragen`);
      assert.ok(devices.includes(await hashOf(cloud.device)), `${label}: mit dem gespeicherten Geheimnis`);
    };

    // B: neues, leeres Gerät → nach der Code-Anmeldung „Passwort eingeben“
    const b = await s.open();
    await lostThenCode(b, 'B');
    await b.page.locator(tid('cloud-unlock-dialog')).waitFor(SLOW);
    assert.equal(flat(await modalTitle(b.page).textContent()), 'Passwort eingeben');
    await unlockWith(b.page, PASSWORD);
    await waitHash(b.page, '#/lehrkraft/klassen');
    await toastWith(b.page, LOADED).waitFor(SLOW);
    await waitIndicator(b.page, 'ok');
    await b.page.locator(tid('class-tile-5a')).waitFor();
    assert.equal(opens(b.requests).length, 2, 'Anmeldung mit Passwort und „Passwort eingeben“');
    await onceAtService(b, 2, 'B');

    // C: Gerät mit eigenem Stand → nach der Code-Anmeldung „Cloud-Sicherung einrichten“ (mit dem Passwort der
    // vorhandenen Sicherung: Anlegen trifft auf sie, dann entscheidet die Lehrkraft, welcher Stand gilt)
    const c = await s.open();
    await seedWithoutSession(c.page, s.web, sampleState({ classes: [classOf('9e')] }));
    await lostThenCode(c, 'C');
    const setupDlg = c.page.locator(tid('cloud-setup-dialog'));
    await setupDlg.waitFor(SLOW);
    assert.ok(flat(await setupDlg.textContent()).includes(SETUP_INTRO));
    await fillNewPassword(c.page, 'cloud-setup', PASSWORD);
    await c.page.click(tid('cloud-setup-submit'));
    await c.page.locator(tid('cloud-conflict')).waitFor(SLOW);
    await c.page.click(tid('cloud-choose-remote'));
    await waitHash(c.page, '#/lehrkraft/klassen');
    await c.page.locator(tid('class-tile-5a')).waitFor(SLOW);
    assert.deepEqual(await tiles(c.page), ['5a']);
    await waitIndicator(c.page, 'ok');
    await onceAtService(c, 3, 'C');
    assert.equal(cloudRows(s.mb).length, 1, 'keine weitere Sicherung');
    assert.equal(cloudRow(s.mb, k).version, 1, 'Stand aus der Cloud übernommen – nichts überschrieben');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B', OFFLINE);
    assertClean(c, 'Gerät C', OFFLINE, STATUS(409));
  } finally {
    await s.close();
  }
});

test('Texte: Hinweis unter „Passwort auf diesem Gerät merken“ in den Dialogen „Cloud-Sicherung einrichten“ und „Passwort eingeben“, Karte „Cloud-Sicherung“ und Dialog „Cloud-Sicherung löschen?“ (Abbrechen löscht nichts)', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    // A: Gerät mit Daten, Anmeldung mit Registrierungscode → „Cloud-Sicherung einrichten“
    const a = await s.open();
    await seedWithoutSession(a.page, s.web, sampleState({ classes: [classOf('5a')] }));
    await fillLogin(a.page, s.web);
    const setupDlg = a.page.locator(tid('cloud-setup-dialog'));
    await setupDlg.waitFor(SLOW);
    assert.equal(flat(await modalTitle(a.page).textContent()), 'Cloud-Sicherung einrichten');
    assert.equal(flat(await setupDlg.locator('label[for="cloud-setup-remember"]').textContent()), 'Passwort auf diesem Gerät merken');
    assert.equal(flat(await setupDlg.locator('.cloud-remember .field-hint').textContent()), REMEMBER_HINT);
    assert.equal(await a.page.isChecked(tid('cloud-setup-remember')), true);
    await fillNewPassword(a.page, 'cloud-setup', PASSWORD);
    await a.page.click(tid('cloud-setup-submit'));
    await toastWith(a.page, SETUP_DONE).waitFor(SLOW);
    await waitHash(a.page, '#/lehrkraft/klassen');
    await waitIndicator(a.page, 'ok');

    // B: neues Gerät, Anmeldung mit Registrierungscode → „Passwort eingeben“
    const b = await s.open();
    await fillLogin(b.page, s.web);
    const unlockDlg = b.page.locator(tid('cloud-unlock-dialog'));
    await unlockDlg.waitFor(SLOW);
    assert.equal(flat(await modalTitle(b.page).textContent()), 'Passwort eingeben');
    assert.equal(flat(await unlockDlg.locator('label[for="cloud-unlock-remember"]').textContent()), 'Passwort auf diesem Gerät merken');
    assert.equal(flat(await unlockDlg.locator('.cloud-remember .field-hint').textContent()), REMEMBER_HINT);
    assert.equal(await b.page.isChecked(tid('cloud-unlock-remember')), false, 'auf einem weiteren Gerät nicht vorausgewählt');
    await unlockWith(b.page, PASSWORD);
    await waitHash(b.page, '#/lehrkraft/klassen');
    await waitIndicator(b.page, 'ok');

    // A: Karte „Cloud-Sicherung“ und Dialog „Cloud-Sicherung löschen?“
    await goSettings(a.page);
    const card = a.page.locator(tid('cloud-card'));
    await card.waitFor();
    assert.ok(flat(await card.textContent()).includes(CARD_TEXT), flat(await card.textContent()));
    await a.page.click(tid('cloud-delete'));
    const del = a.page.locator(tid('cloud-delete-dialog'));
    await del.waitFor();
    assert.equal(flat(await modalTitle(a.page).textContent()), 'Cloud-Sicherung löschen?');
    const paragraphs = (await del.locator('p').allTextContents()).map(flat);
    assert.ok(paragraphs.includes(DELETE_INTRO), paragraphs.join('\n'));
    assert.ok(paragraphs.includes(DELETE_OTHERS), paragraphs.join('\n'));
    await del.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await del.waitFor({ state: 'detached' });
    assert.ok(cloudRow(s.mb, k), 'Sicherung nicht gelöscht');
    assert.equal((await readCloud(a.page)).config.syncId, k.syncId);
    await waitIndicator(a.page, 'ok');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
  } finally {
    await s.close();
  }
});

// ---------- Erneute Registrierung an einem Gerät, das schon eingerichtet ist (components/cloud-ui.js cloudAfterRegister) ----------
// Keine bzw. nie angelegte Einrichtung (pendingCreate) → setupCloud wie neu einrichten; angelegte → registerAgain: Es
// entsteht nie eine neue Sicherung und das Gerät wechselt zu keiner anderen. Gleiches Passwort → 'kept' (ohne Dienst
// wieder verbunden, „Passwort merken“ wie im Formular, dann abgeglichen), anderes → 'kept-other' (nicht verbunden: ohne
// Dienst; verbunden: abgeglichen); meldet der Abgleich „umgezogen“ bzw. 403 (gelöscht, „Passwort ändern“) → 'moved' –
// das aktuelle Passwort gibt die Lehrkraft danach oben über „Passwort eingeben“ ein.
// Ist die Lehrkraft schon in diesem Browser gespeichert, werden geänderte Angaben (E-Mail-Adresse) erst nach diesem
// Abgleich übernommen (views/teacher-auth.js renderRegister).

/**
 * Gerät, das sich ohne Verbindung und ohne „Passwort merken“ mit `password` registriert und sich abgemeldet hat, bevor
 * die Sicherung angelegt war: eingerichtet (pendingCreate), nicht verbunden, beim Dienst nichts.
 */
async function registeredOffline(s, password) {
  const d = await s.open();
  const { page } = d;
  const service = `${s.mb.url}/**`;
  await d.context.route(service, (route) => route.abort('internetdisconnected'));
  const reg = await registerWith(d, s.web, { password, remember: false });
  assert.equal(reg.note, REG_PENDING);
  await continueAfterRegister(page, 'offline');
  await page.locator('.header-actions').getByRole('button', { name: 'Abmelden', exact: true }).click();
  await page.locator('.modal', { hasText: 'Abmelden?' }).getByRole('button', { name: 'Abmelden', exact: true }).click();
  const warn = page.locator('.modal', { hasText: 'Noch nicht in der Cloud gesichert' });
  await warn.waitFor(SLOW);
  await warn.getByRole('button', { name: 'Trotzdem abmelden' }).click();
  await waitHash(page, '#/');
  await d.context.unroute(service);
  const cloud = await readCloud(page);
  assert.equal(cloud.config.pendingCreate, true, 'Sicherung noch nicht angelegt');
  assert.equal(cloud.config.version, 0);
  assert.equal(cloud.config.syncId, (await keysFor(password)).syncId);
  assert.equal(cloud.config.remember, false);
  assert.equal(cloud.localKey, null);
  assert.equal(cloud.sessionKey, null, 'nicht verbunden');
  return d;
}

test('Erneute Registrierung (a) – Einrichtung nie angelegt (ohne Verbindung registriert, nicht gemerkt, abgemeldet): Ein anderes Passwort wird nicht übernommen (keine Sicherung dazu; „Passwort eingeben“ mit dem bisherigen legt sie an), mit demselben wird sie jetzt angelegt – danach Abgleich in beide Richtungen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const kNew = await keysFor(NEW_PASSWORD);

    // B: wieder mit Verbindung, erneut registriert mit einem anderen Passwort („merken“ wie vorausgewählt): Das Gerät
    // bleibt bei seiner Einrichtung (vielleicht hat ein anderes Gerät die Sicherung zum bisherigen Passwort schon
    // angelegt) – ohne Anfrage beim Dienst.
    const b = await registeredOffline(s, PASSWORD);
    const deviceB = (await readCloud(b.page)).device;
    assert.deepEqual(cloudRows(s.mb), [], 'beim Dienst noch nichts');
    let reg = await registerWith(b, s.web, { password: NEW_PASSWORD });
    assert.equal(reg.note, REG_KEPT_OTHER);
    assert.equal(reg.tone, 'alert-info');
    assert.deepEqual(writes(reg.sync), [], 'nichts angelegt oder geöffnet');
    let cloud = await readCloud(b.page);
    assert.equal(cloud.config.syncId, k.syncId, 'weiter mit dem Passwort der ersten Registrierung eingerichtet');
    assert.equal(cloud.config.pendingCreate, true);
    assert.equal(cloud.config.remember, false, 'Einrichtung unverändert');
    assert.equal(cloud.localKey, null);
    assert.equal(cloud.sessionKey, null, 'nicht verbunden');
    assert.equal(cloud.device, deviceB, 'dasselbe Geräte-Geheimnis');
    assert.deepEqual(cloudRows(s.mb), [], 'keine Sicherung zum eben eingegebenen Passwort');
    // „Passwort eingeben“ in der Kopfzeile mit dem bisherigen Passwort: auf dem Gerät bestätigt, die Sicherung wird angelegt
    await continueNeedsPassword(b.page);
    await unlockFromHeader(b.page, 'Haben Sie eine Cloud-Sicherung?', PASSWORD);
    cloud = await readCloud(b.page);
    assert.equal(cloud.config.syncId, k.syncId);
    assert.equal(cloud.config.pendingCreate, false, 'Sicherung angelegt');
    assert.equal(cloud.config.version, 1);
    assert.equal(cloud.sessionKey?.authToken, k.authToken, 'verbunden – nur für diese Sitzung');
    assert.deepEqual(cloudRows(s.mb).map((r) => r.id), [cloudRow(s.mb, k).id], 'genau eine Sicherung – mit dem bisherigen Passwort');
    assert.equal(cloudRow(s.mb, kNew), null);
    assert.deepEqual(devicesOf(s.mb, k), [await hashOf(deviceB)]);
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 1, perDay: 1 }, 'nur das Anlegen zählt als Versuch');
    assert.equal((await decryptStored(s.mb, k)).state.teacher.email, SAMPLE_TEACHER.email, 'Stand dieses Geräts gesichert');
    const c = await deviceWithPassword(s, PASSWORD);
    await assertSyncsBothWays(s, b, c, k, ['5a', '6b'], 'B/C');
    assert.equal(devicesOf(s.mb, k).length, 2, 'B und C eingetragen');

    // D: genauso eingerichtet (mit einem anderen Passwort als B), erneut registriert mit demselben Passwort – diesmal
    // ohne „Passwort merken“: wieder verbunden, die Sicherung wird jetzt angelegt
    const d = await registeredOffline(s, NEW_PASSWORD);
    reg = await registerWith(d, s.web, { password: NEW_PASSWORD, remember: false });
    assert.equal(reg.note, REG_CREATED);
    assert.equal(reg.tone, 'alert-success');
    assert.equal(writes(reg.sync).length, 1, 'genau ein Anlegen');
    cloud = await readCloud(d.page);
    assert.equal(cloud.config.syncId, kNew.syncId);
    assert.equal(cloud.config.pendingCreate, false, 'Sicherung jetzt angelegt');
    assert.equal(cloud.config.version, 1);
    assert.equal(cloud.config.remember, false);
    assert.equal(cloud.localKey, null);
    assert.equal(cloud.sessionKey?.authToken, kNew.authToken, 'verbunden – nur für diese Sitzung');
    assert.equal(cloudRows(s.mb).length, 2, 'dazu die Sicherung von B');
    assert.deepEqual(devicesOf(s.mb, kNew), [await hashOf(cloud.device)]);
    assert.deepEqual(attempts(s.mb, k.who), { perIp: 2, perDay: 2 });
    await continueAfterRegister(d.page, 'ok');
    const e = await deviceWithPassword(s, NEW_PASSWORD);
    await assertSyncsBothWays(s, d, e, kNew, ['7c', '8d'], 'D/E');
    assert.deepEqual(classIds((await decryptStored(s.mb, k)).state), ['5a', '6b'], 'Sicherung von B unberührt');
    assertClean(b, 'Gerät B', OFFLINE);
    assertClean(c, 'Gerät C');
    assertClean(d, 'Gerät D', OFFLINE);
    assertClean(e, 'Gerät E');
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung (b) – angelegt, nicht verbunden, gleiches Passwort: „bleibt verbunden“ ohne Dienst, das Gerät ist wieder verbunden, „Passwort merken“ wie im Formular gewählt – auch während einer Sperre (kein Versuch gezählt) und ohne Verbindung', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const a = await s.open();
    const { page } = a;
    // z. B. an einem gemeinsam genutzten Schulrechner: ohne „Passwort merken“ registriert, dann abgemeldet
    let reg = await registerWith(a, s.web, { remember: false });
    assert.equal(reg.note, REG_CREATED);
    await continueAfterRegister(page, 'ok');
    await logout(page);
    let cloud = await readCloud(page);
    const device = cloud.device;
    assert.equal(cloud.config.remember, false);
    assert.equal(cloud.localKey, null);
    assert.equal(cloud.sessionKey, null, 'nicht verbunden');
    const c = await deviceWithPassword(s);
    const devices = [await hashOf(device), await hashOf((await readCloud(c.page)).device)];
    assert.deepEqual(devicesOf(s.mb, k), devices);

    // Sperre (zu viele Versuche): Ein neues Gerät kommt mit dem richtigen Passwort nicht hinein …
    lockTeacher(s.mb, k.who);
    const counted = { perIp: 1, perDay: 30 };
    assert.deepEqual(attempts(s.mb, k.who), counted);
    const x = await s.open();
    await gotoLogin(x.page, s.web);
    await fillPerson(x.page);
    await submitPassword(x.page, PASSWORD);
    assert.match((await formError(x.page)).slice(FAILED.length), LOCKED);

    // … die erneute Registrierung mit demselben Passwort verbindet dieses Gerät trotzdem („merken“ wieder aus)
    reg = await registerWith(a, s.web, { remember: false });
    assert.equal(reg.note, REG_KEPT);
    assert.equal(reg.tone, 'alert-info');
    assert.deepEqual(writes(reg.sync), [], 'nichts angelegt oder geöffnet');
    assert.ok(fetches(reg.sync).length >= 1, 'abgeglichen');
    assert.deepEqual(attempts(s.mb, k.who), counted, 'kein Versuch gezählt');
    cloud = await readCloud(page);
    assert.equal(cloud.config.syncId, k.syncId, 'dieselbe Sicherung');
    assert.equal(cloud.config.pendingCreate, false);
    assert.equal(cloud.config.version, 1, 'Version des letzten Abgleichs bleibt');
    assert.equal(cloud.config.remember, false, 'wie im Formular gewählt');
    assert.equal(cloud.localKey, null);
    assert.equal(cloud.sessionKey?.authToken, k.authToken, 'verbunden – nur für diese Sitzung');
    assert.equal(cloud.device, device, 'dasselbe Geräte-Geheimnis');
    assert.equal(cloudRows(s.mb).length, 1, 'genau eine Sicherung');
    assert.deepEqual(devicesOf(s.mb, k), devices, 'kein Gerät dazu');
    await continueAfterRegister(page, 'ok');
    await assertSyncsBothWays(s, a, c, k, ['5a', '6b'], 'gesperrt');
    assert.deepEqual(attempts(s.mb, k.who), counted);
    await logout(page);
    assert.equal((await readCloud(page)).sessionKey, null, 'wieder nicht verbunden');

    // Ohne Verbindung: ebenfalls „bleibt verbunden“ – jetzt mit „Passwort merken“; abgeglichen wird, sobald es geht
    const service = `${s.mb.url}/**`;
    await a.context.route(service, (route) => route.abort('internetdisconnected'));
    reg = await registerWith(a, s.web);
    assert.equal(reg.note, REG_KEPT);
    cloud = await readCloud(page);
    assert.equal(cloud.config.remember, true, 'wie im Formular gewählt');
    assert.equal(cloud.localKey?.authToken, k.authToken, 'gemerkt');
    assert.equal(cloud.sessionKey, null);
    await continueAfterRegister(page, 'offline');
    await a.context.unroute(service);
    await syncNow(page);
    await waitIndicator(page, 'ok');
    await assertSyncsBothWays(s, a, c, k, ['7c', '8d'], 'wieder online');
    assert.deepEqual(writes(reg.sync), []);
    assert.equal(cloudRows(s.mb).length, 1);
    assert.deepEqual(devicesOf(s.mb, k), devices);
    assert.deepEqual(attempts(s.mb, k.who), counted);
    await logout(page);
    assert.equal((await readCloud(page)).localKey?.authToken, k.authToken, 'nach dem Abmelden weiter verbunden');
    assertClean(a, 'Gerät A', OFFLINE);
    assertClean(c, 'Gerät C');
    assertClean(x, 'Gerät X', STATUS(429));
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung (c) – angelegt, nicht verbunden, anderes Passwort: „nicht übernommen“ ohne Anfrage beim Dienst, nichts geändert, Kopfzeile „Passwort nötig“; angemeldet wird mit dem bisherigen Passwort, danach Abgleich in beide Richtungen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const kNew = await keysFor(NEW_PASSWORD);
    const a = await s.open();
    const { page } = a;
    assert.equal((await registerWith(a, s.web, { remember: false })).note, REG_CREATED);
    await continueAfterRegister(page, 'ok');
    await logout(page);
    const c = await deviceWithPassword(s);
    const before = await readCloud(page);
    assert.equal(before.sessionKey, null, 'nicht verbunden');
    const devices = devicesOf(s.mb, k);
    assert.equal(devices.length, 2);
    let counted = { perIp: 1, perDay: 1 };
    assert.deepEqual(attempts(s.mb, k.who), counted);

    // Mit einem anderen Passwort (und „Passwort merken“) erneut registriert
    const reg = await registerWith(a, s.web, { password: NEW_PASSWORD });
    assert.equal(reg.note, REG_KEPT_OTHER);
    assert.equal(reg.tone, 'alert-info');
    assert.deepEqual(reg.sync, [], 'keine Anfrage an die Cloud-Sicherung');
    assert.deepEqual(await readCloud(page), before, 'Einstellungen, Schlüssel und Geräte-Geheimnis unverändert – auch „Passwort merken“');
    assert.ok(!(await allStorage(page)).includes(NEW_PASSWORD));
    assert.equal(cloudRow(s.mb, kNew), null, 'keine Sicherung mit dem eben eingegebenen Passwort');
    assert.equal(cloudRows(s.mb).length, 1);
    assert.deepEqual(devicesOf(s.mb, k), devices);
    assert.deepEqual(attempts(s.mb, k.who), counted, 'kein Versuch gezählt');

    // Kopfzeile: „Passwort nötig“ – abgeglichen wird nicht
    await continueAfterRegister(page, 'needs-password');
    assert.equal(flat(await page.textContent(`${tid('cloud-indicator')} .cloud-indicator-text`)), 'Cloud-Sicherung: Passwort nötig');
    assert.equal(flat(await page.textContent(tid('cloud-indicator-action'))), 'Passwort eingeben');
    await addClassVia(c.page, '6b');
    await waitContent(s.mb, k, (content) => classIds(content.state).includes('6b'), 'Änderung von C nicht gesichert');
    const n = a.requests.length;
    assert.equal((await syncNow(page)).kind, 'needs-password');
    assert.deepEqual(a.requests.slice(n).filter((r) => /\/v1\/sync\//.test(r)), [], 'kein Abgleich');
    assert.deepEqual(classIds(await readState(page)), [], 'Änderung von C nicht übernommen');

    // Anmelden: Das eben eingegebene Passwort passt nicht (beim Dienst geprüft), das bisherige schon (auf dem Gerät)
    await logout(page);
    await gotoLogin(page, s.web);
    await usePassword(page);
    await fillPerson(page);
    let m = a.requests.length;
    await submitPassword(page, NEW_PASSWORD);
    assert.equal(await passwordError(page), WRONG_LOGIN);
    assert.equal(opens(a.requests.slice(m)).length, 1, 'beim Dienst nachgefragt');
    counted = { perIp: 2, perDay: 2 };
    assert.deepEqual(attempts(s.mb, k.who), counted, 'Fehlversuch gezählt');
    m = a.requests.length;
    await submitPassword(page, PASSWORD);
    await waitIndicator(page, 'ok');
    assert.deepEqual(opens(a.requests.slice(m)), [], 'bisheriges Passwort auf dem Gerät bestätigt');
    await waitUntil(async () => classIds(await readState(page)).includes('6b'), 'Änderung von C nach der Anmeldung nicht da');
    const cloud = await readCloud(page);
    assert.equal(cloud.config.syncId, k.syncId);
    assert.equal(cloud.config.remember, false);
    assert.equal(cloud.sessionKey?.authToken, k.authToken);
    assert.equal(cloud.localKey, null);
    await assertSyncsBothWays(s, a, c, k, ['7c', '8d'], 'A/C');
    assert.equal(cloudRows(s.mb).length, 1);
    assert.deepEqual(devicesOf(s.mb, k), devices);
    assert.deepEqual(attempts(s.mb, k.who), counted);
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C');
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung (d) – angelegt, verbunden (gemerkt), gleiches Passwort: „bleibt verbunden“ ohne Anlegen oder Öffnen; „Passwort merken“ im Formular abgewählt → danach nicht mehr gemerkt (Schlüssel nur im sessionStorage), Abgleich in beide Richtungen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const a = await s.open();
    const { page } = a;
    assert.equal((await registerWith(a, s.web)).note, REG_CREATED);
    await continueAfterRegister(page, 'ok');
    await logout(page);
    let cloud = await readCloud(page);
    assert.equal(cloud.config.remember, true);
    assert.equal(cloud.localKey?.authToken, k.authToken, 'gemerkt – nach dem Abmelden weiter verbunden');
    const device = cloud.device;
    const c = await deviceWithPassword(s);
    const devices = devicesOf(s.mb, k);
    assert.equal(devices.length, 2);
    const counted = { perIp: 1, perDay: 1 };

    const reg = await registerWith(a, s.web, { remember: false });
    assert.equal(reg.note, REG_KEPT);
    assert.equal(reg.tone, 'alert-info');
    assert.deepEqual(writes(reg.sync), [], 'nichts angelegt oder geöffnet');
    assert.ok(fetches(reg.sync).length >= 1, 'abgeglichen');
    cloud = await readCloud(page);
    assert.equal(cloud.config.syncId, k.syncId);
    assert.equal(cloud.config.version, 1);
    assert.equal(cloud.config.pendingCreate, false);
    assert.equal(cloud.config.remember, false, 'wie im Formular gewählt');
    assert.equal(cloud.localKey, null, 'nicht mehr im localStorage');
    assert.equal(cloud.sessionKey?.authToken, k.authToken, 'nur noch für diese Sitzung');
    assert.equal(cloud.device, device);
    assert.equal(cloudRows(s.mb).length, 1);
    assert.deepEqual(devicesOf(s.mb, k), devices);
    assert.deepEqual(attempts(s.mb, k.who), counted);
    await continueAfterRegister(page, 'ok');
    await assertSyncsBothWays(s, a, c, k, ['5a', '6b'], 'A/C');

    // Abmelden: Das Passwort ist vergessen – nicht mehr verbunden
    await logout(page);
    cloud = await readCloud(page);
    assert.equal(cloud.localKey, null);
    assert.equal(cloud.sessionKey, null);
    assert.equal(cloud.config.syncId, k.syncId, 'weiter eingerichtet');
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C');
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung (e) – angelegt, verbunden (gemerkt), anderes Passwort, die Sicherung besteht: „nicht übernommen“ – keine zweite Sicherung, Schlüssel und „Passwort merken“ unverändert, weiter Abgleich in beide Richtungen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const kNew = await keysFor(NEW_PASSWORD);
    const a = await s.open();
    const { page } = a;
    assert.equal((await registerWith(a, s.web)).note, REG_CREATED);
    await continueAfterRegister(page, 'ok');
    await logout(page);
    const before = await readCloud(page);
    assert.equal(before.localKey?.authToken, k.authToken, 'verbunden');
    const c = await deviceWithPassword(s);
    const devices = devicesOf(s.mb, k);
    const counted = { perIp: 1, perDay: 1 };

    // Anderes Passwort, „Passwort merken“ abgewählt – beides gilt nicht
    const reg = await registerWith(a, s.web, { password: NEW_PASSWORD, remember: false });
    assert.equal(reg.note, REG_KEPT_OTHER);
    assert.equal(reg.tone, 'alert-info');
    assert.deepEqual(writes(reg.sync), [], 'nichts angelegt oder geöffnet');
    assert.ok(fetches(reg.sync).length >= 1, 'abgeglichen – die Sicherung besteht');
    const cloud = await readCloud(page);
    assert.equal(cloud.config.syncId, k.syncId, 'weiter die bisherige Sicherung');
    assert.equal(cloud.config.remember, true, '„Passwort merken“ unverändert');
    assert.equal(cloud.localKey?.authToken, k.authToken, 'bisherige Schlüssel bleiben');
    assert.equal(cloud.sessionKey, null);
    assert.equal(cloud.device, before.device);
    assert.ok(!(await allStorage(page)).includes(NEW_PASSWORD));
    assert.equal(cloudRow(s.mb, kNew), null, 'keine zweite Sicherung');
    assert.equal(cloudRows(s.mb).length, 1);
    assert.deepEqual(devicesOf(s.mb, k), devices);
    assert.deepEqual(attempts(s.mb, k.who), counted);
    await continueAfterRegister(page, 'ok');
    await assertSyncsBothWays(s, a, c, k, ['5a', '6b'], 'A/C');

    // Zum Anmelden gilt weiterhin das bisherige Passwort
    const b = await s.open();
    await gotoLogin(b.page, s.web);
    await fillPerson(b.page);
    await submitPassword(b.page, NEW_PASSWORD);
    assert.equal(await passwordError(b.page), WRONG_LOGIN);
    await submitPassword(b.page, PASSWORD);
    await waitIndicator(b.page, 'ok');
    assert.deepEqual(classIds(await readState(b.page)), ['5a', '6b']);
    assert.equal(cloudRows(s.mb).length, 1, 'weiterhin genau eine Sicherung');
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
    assertClean(c, 'Gerät C');
  } finally {
    await s.close();
  }
});


/**
 * Prüft ein Gerät nach dem Hinweis „inzwischen geändert“ bei der erneuten Registrierung: abgeglichen, dabei nichts
 * angelegt, hochgeladen oder geöffnet; weiter mit der Sicherung zu `k` eingerichtet (kein Wechsel), aber nicht mehr
 * verbunden (Schlüssel vergessen). Gibt die Einstellungen im Browser zurück.
 */
async function assertMovedDevice(x, reg, k, label, { reopened = false } = {}) {
  assert.equal(reg.note, REG_MOVED, label);
  assert.equal(reg.tone, 'alert-warning', label);
  // Mit dem Passwort dieses Geräts wird einmal versucht, es wieder einzutragen (falls es nur aus der Geräteliste
  // gefallen war) – sonst nichts angelegt, hochgeladen oder geöffnet.
  assert.deepEqual(
    writes(reg.sync).map((r) => r.replace(/^\S+ \S+\/v1\/sync\//, '')),
    reopened ? [`${k.syncId}/open`] : [],
    `${label}: nichts angelegt oder hochgeladen`,
  );
  assert.ok(fetches(reg.sync).length >= 1, `${label}: abgeglichen`);
  assert.deepEqual(reg.dialogs, [], `${label}: kein Dialog`);
  const cloud = await readCloud(x.page);
  assert.equal(cloud.config.syncId, k.syncId, `${label}: weiter mit der bisherigen Sicherung eingerichtet – kein Wechsel`);
  assert.equal(cloud.config.pendingCreate, false, label);
  assert.equal(cloud.localKey, null, `${label}: nicht mehr verbunden`);
  assert.equal(cloud.sessionKey, null, `${label}: nicht mehr verbunden`);
  return cloud;
}

/** „Weiter“ nach dem Hinweis „inzwischen geändert“: Die Kopfzeile zeigt „Passwort nötig“ mit „Passwort eingeben“. */
async function continueNeedsPassword(page) {
  await continueAfterRegister(page, 'needs-password');
  assert.equal(flat(await page.textContent(`${tid('cloud-indicator')} .cloud-indicator-text`)), 'Cloud-Sicherung: Passwort nötig');
  assert.equal(flat(await page.textContent(tid('cloud-indicator-action'))), 'Passwort eingeben');
}

/** Kopfzeile „Passwort eingeben“: Der Dialog zeigt `message`; mit `password` ist das Gerät danach verbunden. */
async function unlockFromHeader(page, message, password) {
  await page.click(tid('cloud-indicator-action'));
  const dlg = page.locator(tid('cloud-unlock-dialog'));
  await dlg.waitFor(SLOW);
  assert.ok(flat(await dlg.textContent()).includes(message), flat(await dlg.textContent()));
  await unlockWith(page, password);
  await waitIndicator(page, 'ok');
}

test('Erneute Registrierung (f) – verbunden, die Sicherung ist auf einem anderen Gerät umgezogen („Passwort vergessen?“): Mit dem alten, dem neuen bzw. einem dritten Passwort jeweils „inzwischen geändert“ – keine neue Sicherung, kein Wechsel, kein Versuch gezählt; danach verbindet „Passwort eingeben“ in der Kopfzeile mit dem neuen Passwort, Abgleich in beide Richtungen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);
    const kNew = await keysFor(NEW_PASSWORD);
    const kThird = await keysFor(THIRD_PASSWORD);
    // Drei Geräte mit gemerktem Passwort (verbunden, abgemeldet)
    const [b, c, d] = [await rememberedDevice(s), await rememberedDevice(s), await rememberedDevice(s)];
    const deviceHash = async (x) => hashOf((await readCloud(x.page)).device);
    const oldDevices = devicesOf(s.mb, k);
    assert.equal(oldDevices.length, 4);

    // A: „Passwort vergessen?“ → neues Passwort; die alte Sicherung enthält danach nur den Hinweis „umgezogen“
    await goSettings(a.page);
    await a.page.click(tid('cloud-card-forgot'));
    await a.page.locator(tid('cloud-forgot-dialog')).waitFor();
    await a.page.click(tid('cloud-forgot-move'));
    await a.page.locator(tid('cloud-move-dialog')).waitFor();
    await fillNewPassword(a.page, 'cloud-move', NEW_PASSWORD);
    await a.page.click(tid('cloud-move-submit'));
    await toastWith(a.page, 'Das neue Passwort gilt ab sofort. Ihre anderen Geräte fragen einmal danach.').waitFor(SLOW);
    const movedNote = { app: 'ParentsDay', type: 'cloud-moved', v: 1 };
    assert.deepEqual(await decryptStored(s.mb, k), movedNote);
    const oldVersion = cloudRow(s.mb, k).version;
    assert.equal(cloudRows(s.mb).length, 2);
    const newDevices = [await deviceHash(a)];
    assert.deepEqual(devicesOf(s.mb, kNew), newDevices);
    const counted = attempts(s.mb, k.who);

    // Jedes Gerät erneut registriert – mit einem dritten Passwort (dazu gibt es keine Sicherung), dem alten (auf dem
    // Gerät erkannt, „Passwort merken“ abgewählt) bzw. dem neuen: Der Abgleich meldet „umgezogen“, der Hinweis ist
    // jeweils derselbe. Es entsteht keine Sicherung, und kein Gerät wechselt zu einer anderen – auch nicht zur neuen.
    const cases = [
      [b, THIRD_PASSWORD, true, 'B (drittes Passwort)'],
      [c, PASSWORD, false, 'C (altes Passwort, nicht merken)'],
      [d, NEW_PASSWORD, false, 'D (neues Passwort, nicht merken)'],
    ];
    for (const [x, password, remember, label] of cases) {
      const reg = await registerWith(x, s.web, { password, remember });
      const cloud = await assertMovedDevice(x, reg, k, label, { reopened: password === PASSWORD });
      // Zum alten Passwort gehört die Sicherung dieses Geräts: „Passwort merken“ wie im Formular gewählt. Ein anderes
      // wurde nicht übernommen – dann bleibt auch „Passwort merken“, wie es war.
      assert.equal(cloud.config.remember, password === PASSWORD ? remember : true, `${label}: „Passwort merken“`);
      assert.ok(!(await allStorage(x.page)).includes(password), `${label}: Passwort nicht gespeichert`);
      assert.equal(cloudRows(s.mb).length, 2, `${label}: keine neue Sicherung`);
      assert.equal(cloudRow(s.mb, kThird), null, `${label}: keine Sicherung mit dem dritten Passwort`);
      assert.deepEqual(devicesOf(s.mb, kNew), newDevices, `${label}: nicht bei der neuen Sicherung eingetragen`);
      assert.deepEqual([...devicesOf(s.mb, k)].sort(), [...oldDevices].sort(), label);
      assert.equal(cloudRow(s.mb, k).version, oldVersion, `${label}: alte Sicherung unverändert`);
      assert.deepEqual(attempts(s.mb, k.who), counted, `${label}: kein Versuch gezählt`);
      assert.deepEqual(classIds(await readState(x.page)), ['5a'], `${label}: Stand dieses Geräts bleibt`);
      await continueNeedsPassword(x.page);
    }
    assert.deepEqual(await decryptStored(s.mb, k), movedNote, 'alte Sicherung: weiter nur der Hinweis');

    // Wie im Hinweis: oben „Passwort eingeben“ mit dem aktuellen Passwort – dann verbunden mit der neuen Sicherung
    for (const [x, password, remember, label] of cases) {
      await unlockFromHeader(x.page, MOVED, NEW_PASSWORD);
      const cloud = await readCloud(x.page);
      assert.equal(cloud.config.syncId, kNew.syncId, `${label}: mit der neuen Sicherung verbunden`);
      const remembered = password === PASSWORD ? remember : true;
      assert.equal(cloud.config.remember, remembered, `${label}: „Passwort merken“ wie zuletzt gewählt`);
      assert.equal((remembered ? cloud.localKey : cloud.sessionKey)?.authToken, kNew.authToken, label);
      assert.equal(remembered ? cloud.sessionKey : cloud.localKey, null, label);
      newDevices.push(await deviceHash(x));
      assert.deepEqual(devicesOf(s.mb, kNew), newDevices, `${label}: bei der neuen Sicherung eingetragen`);
      assert.deepEqual(attempts(s.mb, k.who), counted, `${label}: kein Versuch gezählt`);
      assert.deepEqual(classIds(await readState(x.page)), ['5a'], label);
    }
    assert.equal(cloudRows(s.mb).length, 2, 'weiterhin genau zwei Sicherungen');
    await assertSyncsBothWays(s, a, d, kNew, ['6b', '7c'], 'A/D');
    for (const x of [b, c]) {
      await syncNow(x.page);
      await waitUntil(async () => classIds(await readState(x.page)).join() === '5a,6b,7c', 'Stand kommt nicht auf allen Geräten an');
    }
    assertClean(a, 'Gerät A');
    assertClean(b, 'Gerät B');
    assertClean(c, 'Gerät C');
    assertClean(d, 'Gerät D');
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung (g) – verbunden, die Sicherung wurde auf einem anderen Gerät gelöscht („Cloud-Sicherung löschen“): Mit demselben bzw. einem anderen Passwort „inzwischen geändert“ – keine neue Sicherung, kein Wechsel, höchstens ein Fehlversuch (Gerät wieder eintragen); erst nach „nicht mehr verwenden“ legt die erneute Registrierung eine neue an, ein anderes Gerät verbindet sich dann über „Passwort eingeben“', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);
    const kNew = await keysFor(NEW_PASSWORD);
    const b = await rememberedDevice(s);
    const c = await rememberedDevice(s);
    const deviceHash = async (x) => hashOf((await readCloud(x.page)).device);

    await goSettings(a.page);
    await a.page.click(tid('cloud-delete'));
    await a.page.locator(tid('cloud-delete-dialog')).waitFor();
    await a.page.fill(tid('cloud-delete-password'), PASSWORD);
    await a.page.click(tid('cloud-delete-submit'));
    await toastWith(a.page, 'Die Cloud-Sicherung wurde gelöscht.').waitFor(SLOW);
    assert.deepEqual(cloudRows(s.mb), [], 'gelöscht');
    let counted = attempts(s.mb, k.who);

    // B: dasselbe Passwort – auf dem Gerät erkannt, der Abgleich wird abgewiesen (403). Der Versuch, das Gerät wieder
    // einzutragen, findet keine Sicherung (ein Fehlversuch): „inzwischen geändert“
    let reg = await registerWith(b, s.web);
    let cloud = await assertMovedDevice(b, reg, k, 'B', { reopened: true });
    assert.equal(cloud.config.remember, true);
    assert.deepEqual(cloudRows(s.mb), [], 'B: keine neue Sicherung');
    counted = { perIp: counted.perIp + 1, perDay: counted.perDay + 1 };
    assert.deepEqual(attempts(s.mb, k.who), counted, 'B: nur der Versuch, das Gerät wieder einzutragen');
    await continueNeedsPassword(b.page);

    // C: ein anderes Passwort (ohne „merken“) – ebenso; das eingegebene wird nicht übernommen
    reg = await registerWith(c, s.web, { password: NEW_PASSWORD, remember: false });
    cloud = await assertMovedDevice(c, reg, k, 'C');
    assert.equal(cloud.config.remember, true, 'C: „Passwort merken“ unverändert');
    assert.ok(!(await allStorage(c.page)).includes(NEW_PASSWORD));
    assert.deepEqual(cloudRows(s.mb), [], 'C: keine neue Sicherung');
    assert.equal(cloudRow(s.mb, kNew), null);
    assert.deepEqual(attempts(s.mb, k.who), counted, 'C: kein Fehlversuch gezählt');
    await continueNeedsPassword(c.page);

    // B: oben „Passwort eingeben“ – dort „Cloud-Sicherung auf diesem Gerät nicht mehr verwenden“
    await b.page.click(tid('cloud-indicator-action'));
    const unlock = b.page.locator(tid('cloud-unlock-dialog'));
    await unlock.waitFor(SLOW);
    assert.ok(flat(await unlock.textContent()).includes(NEEDS_PASSWORD), flat(await unlock.textContent()));
    await b.page.click(tid('cloud-unlock-disconnect'));
    const confirm = b.page.locator('.modal', { hasText: 'Cloud-Sicherung nicht mehr verwenden?' });
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Nicht mehr verwenden' }).click();
    await unlock.waitFor({ state: 'detached' });
    await waitIndicator(b.page, 'not-setup');
    assert.deepEqual(await readCloud(b.page), { config: null, localKey: null, sessionKey: null, device: null });
    await logout(b.page);

    // Ohne Einrichtung legt die erneute Registrierung wie beim ersten Mal eine Sicherung an – mit dem Stand von B
    reg = await registerWith(b, s.web);
    assert.equal(reg.note, REG_CREATED);
    assert.equal(reg.tone, 'alert-success');
    assert.equal(writes(reg.sync).filter((r) => r.startsWith('PUT ')).length, 1, 'genau ein Anlegen');
    assert.deepEqual(opens(reg.sync), [], 'nichts geöffnet');
    cloud = await readCloud(b.page);
    assert.equal(cloud.config.syncId, k.syncId);
    assert.equal(cloud.config.pendingCreate, false);
    assert.equal(cloud.config.version, 1, 'neu angelegt');
    assert.equal(cloud.localKey?.authToken, k.authToken);
    assert.equal(cloudRows(s.mb).length, 1);
    assert.deepEqual(devicesOf(s.mb, k), [await deviceHash(b)], 'nur B eingetragen');
    assert.deepEqual(classIds((await decryptStored(s.mb, k)).state), ['5a'], 'Stand von B');
    counted = { perIp: counted.perIp + 1, perDay: counted.perDay + 1 };
    assert.deepEqual(attempts(s.mb, k.who), counted, 'das Anlegen zählt');
    await continueAfterRegister(b.page, 'ok');

    // C: oben „Passwort eingeben“ mit dem Passwort – verbunden mit der neu angelegten Sicherung
    await unlockFromHeader(c.page, NEEDS_PASSWORD, PASSWORD);
    cloud = await readCloud(c.page);
    assert.equal(cloud.config.syncId, k.syncId);
    assert.equal(cloud.localKey?.authToken, k.authToken, 'wie bisher gemerkt');
    assert.deepEqual(devicesOf(s.mb, k), [await deviceHash(b), await deviceHash(c)]);
    assert.deepEqual(attempts(s.mb, k.who), counted);
    await assertSyncsBothWays(s, b, c, k, ['6b', '7c'], 'B/C');
    assert.equal(cloudRows(s.mb).length, 1, 'genau eine Sicherung');
    assertClean(a, 'Gerät A');
    // 403: Abgleich mit der gelöschten Sicherung
    assertClean(b, 'Gerät B', STATUS(403));
    assertClean(c, 'Gerät C', STATUS(403));
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung (g, Variante) – verbunden, auf einem anderen Gerät mit „Passwort ändern“ geändert (die alte Sicherung ist dabei gelöscht): Mit dem neuen bzw. dem alten Passwort „inzwischen geändert“ – keine weitere Sicherung, kein Wechsel, höchstens ein Fehlversuch (Gerät wieder eintragen); „Passwort eingeben“ in der Kopfzeile mit dem neuen verbindet, Abgleich in beide Richtungen', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);
    const kNew = await keysFor(NEW_PASSWORD);
    const b = await rememberedDevice(s);
    const c = await rememberedDevice(s);
    const deviceHash = async (x) => hashOf((await readCloud(x.page)).device);

    await goSettings(a.page);
    await a.page.click(tid('cloud-change-password'));
    await a.page.locator(tid('cloud-change-dialog')).waitFor();
    await a.page.fill(tid('cloud-change-current'), PASSWORD);
    await fillNewPassword(a.page, 'cloud-newpw', NEW_PASSWORD);
    await a.page.click(tid('cloud-change-submit'));
    await toastWith(a.page, 'Das Passwort wurde geändert.').waitFor(SLOW);
    assert.equal(cloudRow(s.mb, k), null, 'alte Sicherung gelöscht');
    assert.equal(cloudRows(s.mb).length, 1);
    const newDevices = [await deviceHash(a)];
    assert.deepEqual(devicesOf(s.mb, kNew), newDevices);
    let counted = attempts(s.mb, k.who);

    for (const [x, password, label] of [
      [b, NEW_PASSWORD, 'B (neues Passwort)'],
      [c, PASSWORD, 'C (altes Passwort)'],
    ]) {
      const reg = await registerWith(x, s.web, { password });
      // Mit dem alten Passwort (dem dieses Geräts) wird einmal versucht, das Gerät wieder einzutragen – die Sicherung
      // gibt es nicht mehr: ein Fehlversuch.
      const reopened = password === PASSWORD;
      await assertMovedDevice(x, reg, k, label, { reopened });
      if (reopened) counted = { perIp: counted.perIp + 1, perDay: counted.perDay + 1 };
      assert.equal(cloudRows(s.mb).length, 1, `${label}: keine weitere Sicherung`);
      assert.equal(cloudRow(s.mb, k), null, `${label}: die alte nicht wieder angelegt`);
      assert.deepEqual(devicesOf(s.mb, kNew), newDevices, `${label}: nicht bei der neuen Sicherung eingetragen`);
      assert.deepEqual(attempts(s.mb, k.who), counted, `${label}: ${reopened ? 'nur der Versuch, das Gerät wieder einzutragen' : 'kein Fehlversuch gezählt'}`);
      await continueNeedsPassword(x.page);

      // Oben „Passwort eingeben“ mit dem neuen Passwort: verbunden mit der vorhandenen neuen Sicherung
      await unlockFromHeader(x.page, NEEDS_PASSWORD, NEW_PASSWORD);
      const cloud = await readCloud(x.page);
      assert.equal(cloud.config.syncId, kNew.syncId, `${label}: mit der neuen Sicherung verbunden`);
      assert.equal(cloud.localKey?.authToken, kNew.authToken, `${label}: wie bisher gemerkt`);
      newDevices.push(await deviceHash(x));
      assert.deepEqual(devicesOf(s.mb, kNew), newDevices, `${label}: eingetragen`);
      assert.deepEqual(attempts(s.mb, k.who), counted, label);
      assert.equal(cloudRows(s.mb).length, 1, label);
    }
    await assertSyncsBothWays(s, a, b, kNew, ['6b', '7c'], 'A/B');
    await syncNow(c.page);
    await waitUntil(async () => classIds(await readState(c.page)).join() === '5a,6b,7c', 'Stand kommt auf C nicht an');
    assertClean(a, 'Gerät A');
    // 403: Abgleich mit der gelöschten Sicherung
    assertClean(b, 'Gerät B', STATUS(403));
    assertClean(c, 'Gerät C', STATUS(403));
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung mit neuer E-Mail-Adresse an einem veralteten, verbundenen Gerät – ein anderes Gerät hat inzwischen eine Klasse angelegt: kein Konflikt-Dialog, „bleibt verbunden“; der Stand des anderen Geräts bleibt (auch in der Cloud), die neue Adresse gilt danach hier, in der Cloud und auf dem anderen Gerät – die PDF enthält sie gleich', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    // A: mit Klasse 5a eingerichtet, Passwort gemerkt, abgemeldet – weiter verbunden
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    await logout(a.page);
    const before = await readCloud(a.page);
    assert.equal(before.localKey?.authToken, k.authToken, 'A verbunden (gemerkt)');
    assert.equal(before.config.dirty, false);
    // C legt inzwischen eine Klasse an – A ist damit veraltet
    const c = await deviceWithPassword(s);
    await addClassVia(c.page, '6b');
    await waitContent(s.mb, k, (content) => classIds(content.state).includes('6b'), 'Klasse von C nicht gesichert');
    assert.deepEqual(classIds(await readState(a.page)), ['5a'], 'A ist veraltet');
    assert.equal((await readState(a.page)).teacher.email, SAMPLE_TEACHER.email);
    const counted = attempts(s.mb, k.who);

    const reg = await registerWith(a, s.web, { email: NEW_EMAIL });
    assert.equal(reg.note, REG_KEPT);
    assert.equal(reg.tone, 'alert-info');
    assert.deepEqual(reg.dialogs, [], 'kein Konflikt-Dialog');
    assert.equal(await a.page.locator(tid('cloud-conflict')).count(), 0);
    assert.deepEqual(opens(reg.sync), [], 'nichts geöffnet');
    assert.ok(fetches(reg.sync).length >= 1, 'abgeglichen');
    assert.equal(pdfPayload(reg.pdf.buffer).email, NEW_EMAIL, 'die PDF enthält gleich die neue Adresse');
    assert.ok(flat(await a.page.textContent('.tauth-summary')).includes(NEW_EMAIL), 'Angaben auf der Erfolgsseite');
    let state = await readState(a.page);
    assert.deepEqual(classIds(state), ['5a', '6b'], 'Stand von C übernommen');
    assert.equal(state.teacher.email, NEW_EMAIL, 'die neue Adresse gilt');
    assert.ok(state.event, 'Elternsprechtag bleibt');

    // Die neue Adresse wird hochgeladen – mit den Klassen von C
    const content = await waitContent(s.mb, k, (x) => x.state.teacher.email === NEW_EMAIL, 'neue Adresse nicht gesichert');
    assert.deepEqual(classIds(content.state), ['5a', '6b'], 'Klasse von C bleibt in der Cloud');
    await continueAfterRegister(a.page, 'ok');
    await a.page.locator(tid('class-tile-6b')).waitFor();
    assert.deepEqual(await tiles(a.page), ['5a', '6b']);
    state = await readState(a.page);
    assert.deepEqual(classIds(state), ['5a', '6b']);
    assert.equal(state.teacher.email, NEW_EMAIL);
    const cloud = await readCloud(a.page);
    assert.equal(cloud.config.syncId, k.syncId);
    assert.equal(cloud.config.dirty, false, 'alles gesichert');
    assert.equal(cloud.localKey?.authToken, k.authToken, 'weiter gemerkt');

    // C übernimmt die neue Adresse
    await syncNow(c.page);
    await waitUntil(async () => (await readState(c.page)).teacher.email === NEW_EMAIL, 'C hat die neue Adresse nicht übernommen');
    assert.deepEqual(classIds(await readState(c.page)), ['5a', '6b']);
    await assertSyncsBothWays(s, a, c, k, ['7c', '8d'], 'A/C');
    assert.deepEqual(await seenDialogs(a.page), [], 'auch danach kein Dialog');
    assert.equal(cloudRows(s.mb).length, 1);
    assert.deepEqual(attempts(s.mb, k.who), counted, 'kein Versuch gezählt');
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C');
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung mit neuer E-Mail-Adresse an einem leeren, verbundenen Gerät – ein anderes Gerät hat inzwischen eine Klasse angelegt: „bleibt verbunden“, die Klasse kommt an und die neue Adresse bleibt (hier, in der Cloud und auf dem anderen Gerät)', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    // A: registriert (noch leer), Passwort gemerkt, abgemeldet – weiter verbunden
    const a = await s.open();
    assert.equal((await registerWith(a, s.web)).note, REG_CREATED);
    await continueAfterRegister(a.page, 'ok');
    await logout(a.page);
    assert.equal((await readCloud(a.page)).localKey?.authToken, k.authToken, 'A verbunden (gemerkt)');
    const c = await deviceWithPassword(s);
    await addClassVia(c.page, '5a');
    await waitContent(s.mb, k, (content) => classIds(content.state).includes('5a'), 'Klasse von C nicht gesichert');
    let state = await readState(a.page);
    assert.deepEqual(classIds(state), [], 'A ist leer');
    assert.equal(state.event, null);

    const reg = await registerWith(a, s.web, { email: NEW_EMAIL });
    assert.equal(reg.note, REG_KEPT);
    assert.deepEqual(reg.dialogs, [], 'kein Dialog');
    assert.deepEqual(opens(reg.sync), []);
    assert.equal(pdfPayload(reg.pdf.buffer).email, NEW_EMAIL);
    state = await readState(a.page);
    assert.deepEqual(classIds(state), ['5a'], 'Klasse von C übernommen');
    assert.equal(state.teacher.email, NEW_EMAIL, 'die neue Adresse bleibt');
    const content = await waitContent(s.mb, k, (x) => x.state.teacher.email === NEW_EMAIL, 'neue Adresse nicht gesichert');
    assert.deepEqual(classIds(content.state), ['5a']);
    await continueAfterRegister(a.page, 'ok');
    assert.equal((await readState(a.page)).teacher.email, NEW_EMAIL);
    await syncNow(c.page);
    await waitUntil(async () => (await readState(c.page)).teacher.email === NEW_EMAIL, 'C hat die neue Adresse nicht übernommen');
    assert.deepEqual(classIds(await readState(c.page)), ['5a']);
    assert.deepEqual(await seenDialogs(a.page), [], 'auch danach kein Dialog');
    assert.equal(cloudRows(s.mb).length, 1);
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C');
  } finally {
    await s.close();
  }
});

test('Erneute Registrierung mit neuer E-Mail-Adresse, während der Abgleich länger als 8 s dauert: Die Angaben werden erst nach dem tatsächlichen Abgleich übernommen – kein Konflikt-Dialog, die Klasse des anderen Geräts bleibt, die neue Adresse gilt', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const k = await keysFor(PASSWORD);
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    await logout(a.page);
    const c = await deviceWithPassword(s);
    await addClassVia(c.page, '6b');
    await waitContent(s.mb, k, (content) => classIds(content.state).includes('6b'), 'Klasse von C nicht gesichert');
    assert.deepEqual(classIds(await readState(a.page)), ['5a'], 'A ist veraltet');

    // Der erste Abruf von A dauert 10 s (langsames Netz) – länger als die Wartezeit bei der Registrierung
    let delayed = false;
    await a.context.route(`${s.mb.url}/v1/sync/**`, async (route) => {
      if (!delayed && route.request().method() === 'GET') {
        delayed = true;
        await sleep(10000);
      }
      await route.continue();
    });
    const reg = await registerWith(a, s.web, { email: NEW_EMAIL });
    assert.ok(delayed, 'Abruf verzögert');
    assert.equal(reg.note, REG_KEPT);
    assert.deepEqual(reg.dialogs, [], 'kein Konflikt-Dialog');
    const state = await readState(a.page);
    assert.deepEqual(classIds(state), ['5a', '6b'], 'Stand von C übernommen');
    assert.equal(state.teacher.email, NEW_EMAIL, 'die neue Adresse gilt');
    const content = await waitContent(s.mb, k, (x) => x.state.teacher.email === NEW_EMAIL, 'neue Adresse nicht gesichert');
    assert.deepEqual(classIds(content.state), ['5a', '6b'], 'Klasse von C bleibt in der Cloud');
    await continueAfterRegister(a.page, 'ok');
    assert.deepEqual(await seenDialogs(a.page), [], 'auch danach kein Dialog');
    assertClean(a, 'Gerät A');
    assertClean(c, 'Gerät C');
  } finally {
    await s.close();
  }
});

test('Gerät aus der Liste der eingetragenen Geräte gefallen (der Dienst behält höchstens 20): Die Anmeldung mit Passwort und die erneute Registrierung mit demselben Passwort tragen es wieder ein – ohne Dialog „Passwort eingeben“ und ohne Fehlversuch', { timeout: TEST_TIMEOUT }, async () => {
  const s = await setup();
  try {
    const a = await deviceWithCloud(s, { classes: ['5a'] });
    const k = await keysFor(PASSWORD);
    const b = await rememberedDevice(s);
    const c = await rememberedDevice(s);
    const deviceHash = async (x) => hashOf((await readCloud(x.page)).device);
    const [hashB, hashC] = [await deviceHash(b), await deviceHash(c)];
    // B und C beim Dienst austragen (wie nach 20 anderen geöffneten Geräten)
    const row = cloudRow(s.mb, k);
    const kept = JSON.parse(row.devices).filter((d) => d !== hashB && d !== hashC);
    s.mb.db.db.prepare('UPDATE backups SET devices = ? WHERE id = ?').run(JSON.stringify(kept), row.id);
    assert.ok(!devicesOf(s.mb, k).includes(hashB) && !devicesOf(s.mb, k).includes(hashC), 'ausgetragen');
    const counted = attempts(s.mb, k.who);

    // B: Anmeldung mit Passwort – auf dem Gerät bestätigt; der Abgleich wird abgewiesen, das Gerät wieder eingetragen
    await gotoLogin(b.page, s.web);
    await usePassword(b.page);
    await fillPerson(b.page);
    await watchDialogs(b.page);
    await submitPassword(b.page, PASSWORD);
    await waitHash(b.page, '#/lehrkraft/klassen');
    await waitIndicator(b.page, 'ok');
    assert.deepEqual(await seenDialogs(b.page), [], 'kein Dialog');
    assert.ok(devicesOf(s.mb, k).includes(hashB), 'B wieder eingetragen');
    const cloudB = await readCloud(b.page);
    assert.equal(cloudB.config.remember, true);
    assert.equal(cloudB.localKey?.authToken, k.authToken, 'weiter gemerkt');
    assert.deepEqual(attempts(s.mb, k.who), counted, 'kein Fehlversuch');

    // C: erneute Registrierung mit demselben Passwort → „bleibt verbunden“, wieder eingetragen
    const reg = await registerWith(c, s.web);
    assert.equal(reg.note, REG_KEPT);
    assert.deepEqual(reg.dialogs, [], 'kein Dialog');
    assert.deepEqual(opens(reg.sync).map((r) => r.replace(/^\S+ \S+\/v1\/sync\//, '')), [`${k.syncId}/open`], 'einmal geöffnet (wieder eingetragen)');
    assert.ok(devicesOf(s.mb, k).includes(hashC), 'C wieder eingetragen');
    assert.deepEqual(attempts(s.mb, k.who), counted, 'kein Fehlversuch');
    await continueAfterRegister(c.page, 'ok');
    await assertSyncsBothWays(s, b, c, k, ['6b', '7c'], 'B/C');
    assert.equal(cloudRows(s.mb).length, 1, 'keine weitere Sicherung');
    assertClean(a, 'Gerät A');
    // 403: Abruf, bevor das Gerät wieder eingetragen war
    assertClean(b, 'Gerät B', STATUS(403));
    assertClean(c, 'Gerät C', STATUS(403));
  } finally {
    await s.close();
  }
});
