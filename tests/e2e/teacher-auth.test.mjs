// Browser-Test: Zugang für Lehrkräfte – Registrieren, Registrierungs-PDF, Anmelden per PDF und per Eingabe.
// Optional Bildschirmfotos zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/teacher-auth.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, launch, captureDownload, pdfPayload, pdfPageCount, seedTeacher, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { registrationCode, teacherCode } from '../../js/core/codes.js';
import { pdfPayloadString } from '../../js/core/transport.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.close();
});

const tid = (id) => `[data-testid="${id}"]`;

async function shot(page, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function waitForHash(page, hash) {
  await page.waitForFunction((expected) => location.hash === expected, hash);
}

async function gotoRoute(page, route) {
  await page.goto(`${server.url}#${route}`);
}

async function fillRegistration(page, { firstName, lastName, birthDate, email }) {
  await page.fill(tid('reg-firstname'), firstName);
  await page.fill(tid('reg-lastname'), lastName);
  await page.fill(tid('reg-birthdate'), birthDate);
  await page.fill(tid('reg-email'), email);
}

async function fillLogin(page, { firstName, lastName, birthDate, code }) {
  await page.fill(tid('login-firstname'), firstName);
  await page.fill(tid('login-lastname'), lastName);
  await page.fill(tid('login-birthdate'), birthDate);
  await page.fill(tid('login-code'), code);
}

/** Registriert eine Lehrkraft über die Oberfläche und gibt den PDF-Download zurück. */
async function registerViaUi(page, teacher) {
  await gotoRoute(page, '/lehrkraft/registrieren');
  await page.waitForSelector(tid('reg-firstname'));
  await fillRegistration(page, teacher);
  const download = await captureDownload(page, () => page.click(tid('reg-submit')));
  await page.waitForSelector(tid('reg-registration-code'));
  return download;
}

async function storedState(page, code) {
  return page.evaluate((c) => JSON.parse(localStorage.getItem(`parentsday.teacher.${c}`) || 'null'), code);
}

async function sessionCode(page) {
  return page.evaluate(() => sessionStorage.getItem('parentsday.session'));
}

async function logoutSilently(page) {
  await page.evaluate(() => sessionStorage.removeItem('parentsday.session'));
}

async function uploadLoginFile(page, file) {
  await page.setInputFiles(`${tid('login-upload')} input[type=file]`, file);
}

async function waitForToast(page, text) {
  await page.locator('.toast', { hasText: text }).first().waitFor();
}

async function assertNoHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${label}: Seite ist ${overflow}px breiter als der Bildschirm`);
}

const ANNA = { ...SAMPLE_TEACHER };
const MIN_PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

test('Registrierung: Startseite → Registrieren → PDF → Codes → Weiter', async () => {
  const { browser, page, errors } = await launch();
  try {
    await page.goto(server.url);
    await page.click(tid('start-teacher'));
    await waitForHash(page, '#/lehrkraft');
    await page.waitForSelector(tid('auth-choose-register'));
    assert.match(await page.textContent('h1'), /Zugang für Lehrkräfte/);
    assert.ok(await page.isVisible(tid('auth-choose-login')));
    await shot(page, 'desktop-1-auswahl');

    await page.click(tid('auth-choose-register'));
    await waitForHash(page, '#/lehrkraft/registrieren');
    await page.waitForSelector(tid('reg-firstname'));
    assert.equal(await page.getAttribute(tid('reg-birthdate'), 'type'), 'date');
    assert.equal(await page.getAttribute(tid('reg-email'), 'type'), 'email');
    assert.equal(await page.getAttribute(tid('reg-birthdate'), 'max'), await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }));
    // Umschalter zwischen Registrieren und Anmelden
    assert.equal(await page.getAttribute('.tauth-switch a[aria-current="page"]', 'href'), '#/lehrkraft/registrieren');

    // Leeres Formular: Meldungen an allen Feldern, Fokus auf dem ersten Feld
    await page.click(tid('reg-submit'));
    for (const id of ['reg-firstname', 'reg-lastname', 'reg-birthdate', 'reg-email']) {
      assert.equal(await page.getAttribute(tid(id), 'aria-invalid'), 'true', `${id} sollte als fehlerhaft markiert sein`);
    }
    assert.equal(await page.textContent('#reg-firstname-error'), 'Bitte geben Sie Ihren Vornamen ein.');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'reg-firstname');
    // Tippen entfernt den Fehler, ohne dass der Fokus verloren geht
    await page.keyboard.type('Ann');
    assert.equal(await page.getAttribute(tid('reg-firstname'), 'aria-invalid'), null);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'reg-firstname');
    assert.equal(await page.inputValue(tid('reg-firstname')), 'Ann');

    // Ungültige Eingaben
    await fillRegistration(page, { firstName: '---', lastName: 'Meier', birthDate: '2999-01-01', email: 'anna@schule' });
    await page.click(tid('reg-submit'));
    assert.match(await page.textContent('#reg-firstname-error'), /mindestens einen Buchstaben/);
    assert.match(await page.textContent('#reg-birthdate-error'), /nicht in der Zukunft/);
    assert.match(await page.textContent('#reg-email-error'), /gültige E-Mail-Adresse/);
    await page.fill(tid('reg-birthdate'), '1850-05-01');
    await page.click(tid('reg-submit'));
    assert.match(await page.textContent('#reg-birthdate-error'), /1900/);
    await shot(page, 'desktop-2-registrieren-fehler');

    // Gültige Registrierung → PDF wird sofort heruntergeladen
    await fillRegistration(page, ANNA);
    const download = await captureDownload(page, () => page.click(tid('reg-submit')));
    assert.equal(download.filename, 'ParentsDay Registrierung Anna Meier.pdf');
    const payload = pdfPayload(download.buffer);
    assert.equal(payload.app, 'ParentsDay');
    assert.equal(payload.type, 'teacher-registration');
    assert.equal(payload.v, 1);
    assert.equal(payload.firstName, 'Anna');
    assert.equal(payload.lastName, 'Meier');
    assert.equal(payload.birthDate, '1990-03-15');
    assert.equal(payload.email, 'anna.meier@schule.example');
    assert.equal(payload.registrationCode, 'AM60127960');
    assert.equal(payload.teacherCode, 'A16595316960M');
    assert.ok(!Number.isNaN(Date.parse(payload.createdAt)));
    assert.equal(pdfPageCount(download.buffer), 1);
    if (SHOTS) await fs.copyFile(download.file, path.join(SHOTS, 'registrierung-anna.pdf'));

    // Erfolgsansicht
    await page.waitForSelector(tid('reg-registration-code'));
    assert.match(await page.textContent('h1'), /Registrierung abgeschlossen/);
    assert.equal((await page.textContent(tid('reg-registration-code'))).trim(), 'AM60127960');
    assert.equal((await page.textContent(tid('reg-teacher-code'))).trim(), 'A16595316960M');
    assert.match(await page.textContent('main'), /Die PDF-Datei wurde heruntergeladen\. Bewahren Sie sie gut auf – mit ihr können Sie sich jederzeit anmelden\./);
    const state = await storedState(page, 'A16595316960M');
    assert.deepEqual(state.teacher, { ...ANNA });
    assert.equal(state.event, null);
    assert.equal(await sessionCode(page), null, 'Sitzung erst mit „Weiter“');
    await shot(page, 'desktop-3-registrierung-abgeschlossen');

    // PDF erneut herunterladen
    const again = await captureDownload(page, () => page.click(tid('reg-download')));
    assert.equal(again.filename, 'ParentsDay Registrierung Anna Meier.pdf');
    assert.equal(pdfPayload(again.buffer).registrationCode, 'AM60127960');

    // Weiter → Einrichtung des Elternsprechtags
    await page.click(tid('reg-continue'));
    await waitForHash(page, '#/lehrkraft/elternsprechtag');
    assert.equal(await sessionCode(page), 'A16595316960M');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Anmeldung per Registrierungs-PDF und per Eingabe, Fehlerfälle', async () => {
  const { browser, page, errors } = await launch();
  try {
    const { file: pdfFile } = await registerViaUi(page, ANNA);

    // 1. PDF-Upload bei vorhandenem Zustand
    await logoutSilently(page);
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-upload'));
    assert.equal(await page.getAttribute('.tauth-switch a[aria-current="page"]', 'href'), '#/lehrkraft/anmelden');
    assert.match(await page.textContent('main'), /Ihre Daten werden nur in diesem Browser gespeichert\./);
    await shot(page, 'desktop-4-anmelden');
    await uploadLoginFile(page, pdfFile);
    await waitForHash(page, '#/lehrkraft/elternsprechtag');
    await waitForToast(page, 'Willkommen, Anna Meier!');
    assert.equal(await sessionCode(page), 'A16595316960M');
    assert.equal(await page.locator('.toast', { hasText: 'noch keine Daten gespeichert' }).count(), 0);

    // 2. PDF-Upload auf einem „leeren“ Gerät → Zustand wird angelegt, E-Mail aus der PDF übernommen
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-upload'));
    await uploadLoginFile(page, pdfFile);
    await waitForHash(page, '#/lehrkraft/elternsprechtag');
    await waitForToast(page, 'Auf diesem Gerät sind noch keine Daten gespeichert. Falls Sie einen Zwischenstand haben, laden Sie ihn oben über „Zwischenstand laden“.');
    let state = await storedState(page, 'A16595316960M');
    assert.deepEqual(state.teacher, { ...ANNA });

    // 3. Vorhandener Zustand ohne E-Mail → E-Mail aus der PDF wird ergänzt; mit Elternsprechtag → Klassen
    await seedTeacher(page, server.url, sampleState({ teacher: { ...ANNA, email: '' } }));
    await logoutSilently(page);
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-upload'));
    await uploadLoginFile(page, pdfFile);
    await waitForHash(page, '#/lehrkraft/klassen');
    state = await storedState(page, 'A16595316960M');
    assert.equal(state.teacher.email, 'anna.meier@schule.example');
    assert.equal(state.event.days.length, 2, 'Elternsprechtag bleibt erhalten');

    // 4. Handeingabe mit Code in Kleinbuchstaben
    await logoutSilently(page);
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-firstname'));
    await fillLogin(page, { firstName: 'Anna', lastName: 'Meier', birthDate: '1990-03-15', code: ' am60127960 ' });
    await page.click(tid('login-submit'));
    await waitForHash(page, '#/lehrkraft/klassen');
    await waitForToast(page, 'Willkommen, Anna Meier!');
    assert.equal(await sessionCode(page), 'A16595316960M');

    // 5. Handeingabe ohne Angaben → Meldungen an den Feldern
    await logoutSilently(page);
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-submit'));
    await page.click(tid('login-submit'));
    assert.equal(await page.getAttribute(tid('login-code'), 'aria-invalid'), 'true');
    assert.equal(await page.textContent('#login-code-error'), 'Bitte geben Sie Ihren Registrierungscode ein.');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'login-firstname');

    // 6. Falscher Code
    await fillLogin(page, { firstName: 'Anna', lastName: 'Meier', birthDate: '1990-03-15', code: 'AM60127961' });
    await page.click(tid('login-submit'));
    await page.locator('.alert-error', { hasText: 'Die Angaben passen nicht zum Registrierungscode. Bitte prüfen Sie Namen, Geburtsdatum und Code.' }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#/lehrkraft/anmelden');
    assert.equal(await sessionCode(page), null);
    await shot(page, 'desktop-5-anmelden-fehler');

    // 7. Fremde PDF
    await uploadLoginFile(page, { name: 'Brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from(MIN_PDF, 'latin1') });
    await page.locator(`${tid('login-upload')} ~ .tauth-status .alert-error`, { hasText: 'Diese Datei ist keine ParentsDay-Registrierung.' }).waitFor();
    assert.equal(await sessionCode(page), null);

    // 8. Rückmelde-PDF der Eltern ist ebenfalls keine Registrierung
    const response = pdfPayloadString({ app: 'ParentsDay', type: 'parent-response', v: 1, code: '5aA16595316960M11414125311', availability: {} });
    await uploadLoginFile(page, { name: 'Rückmeldung.pdf', mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n1 0 obj << /Subject (${response}) >> endobj\n%%EOF\n`, 'latin1') });
    await page.locator('.alert-error', { hasText: 'Diese Datei ist keine ParentsDay-Registrierung.' }).waitFor();

    // 9. Manipulierte Registrierung (Code passt nicht zu den Daten)
    const forged = pdfPayloadString({ app: 'ParentsDay', type: 'teacher-registration', v: 1, firstName: 'Anna', lastName: 'Meier', birthDate: '1990-03-15', email: '', registrationCode: 'AM11111111', teacherCode: 'A16595316960M' });
    await uploadLoginFile(page, { name: 'ParentsDay Registrierung Anna Meier.pdf', mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n1 0 obj << /Subject (${forged}) >> endobj\n%%EOF\n`, 'latin1') });
    await page.locator('.alert-error', { hasText: 'Die Daten in der Datei sind ungültig.' }).waitFor();
    assert.equal(await sessionCode(page), null);
    assert.equal(await page.evaluate(() => location.hash), '#/lehrkraft/anmelden');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Namen mit Umlauten: Jürgen Özdemir', async () => {
  const { browser, page, errors } = await launch();
  const juergen = { firstName: 'Jürgen', lastName: 'Özdemir', birthDate: '1975-07-04', email: 'j.oezdemir@schule.example' };
  const regCode = registrationCode(juergen.firstName, juergen.lastName, juergen.birthDate);
  const tCode = teacherCode(juergen.firstName, juergen.lastName, juergen.birthDate);
  assert.equal(regCode, `JÖ${6 * 4071975}`);
  try {
    const download = await registerViaUi(page, { ...juergen, firstName: '  Jürgen ' });
    assert.equal(download.filename, 'ParentsDay Registrierung Jürgen Özdemir.pdf');
    const payload = pdfPayload(download.buffer);
    assert.equal(payload.firstName, 'Jürgen');
    assert.equal(payload.lastName, 'Özdemir');
    assert.equal(payload.registrationCode, regCode);
    assert.equal(payload.teacherCode, tCode);
    assert.equal(pdfPageCount(download.buffer), 1);
    assert.equal((await page.textContent(tid('reg-registration-code'))).trim(), regCode);
    assert.equal((await page.textContent(tid('reg-teacher-code'))).trim(), tCode);
    if (SHOTS) await fs.copyFile(download.file, path.join(SHOTS, 'registrierung-juergen.pdf'));

    // Anmeldung per Hand, Code und Namen in Kleinbuchstaben
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-firstname'));
    await fillLogin(page, { firstName: 'jürgen', lastName: 'özdemir', birthDate: juergen.birthDate, code: regCode.toLocaleLowerCase('de-DE') });
    await page.click(tid('login-submit'));
    await waitForHash(page, '#/lehrkraft/elternsprechtag');
    await waitForToast(page, 'Willkommen, Jürgen Özdemir!');
    assert.equal(await sessionCode(page), tCode);

    // Anmeldung per PDF
    await logoutSilently(page);
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-upload'));
    await uploadLoginFile(page, download.file);
    await waitForHash(page, '#/lehrkraft/elternsprechtag');
    assert.equal(await sessionCode(page), tCode);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Erneute Registrierung behält vorhandene Daten; Auswahlseite mit aktiver Sitzung', async () => {
  const { browser, page, errors } = await launch();
  try {
    const seeded = sampleState({ classes: [{ id: '5a', grade: 5, letter: 'a', codesGenerated: false, students: [] }] });
    await seedTeacher(page, server.url, seeded);

    // Auswahlseite zeigt die aktive Sitzung
    await gotoRoute(page, '/lehrkraft');
    await page.locator('.tauth-session', { hasText: 'Sie sind angemeldet als Anna Meier' }).waitFor();
    await shot(page, 'desktop-6-auswahl-angemeldet');
    await page.click('[data-action="session-continue"]');
    await waitForHash(page, '#/lehrkraft/klassen');

    // Registrierung mit neuer E-Mail-Adresse: Klassen und Elternsprechtag bleiben erhalten
    await logoutSilently(page);
    await registerViaUi(page, { ...ANNA, email: 'a.meier@neu.example' });
    assert.match(await page.textContent('main'), /bleiben erhalten/);
    const state = await storedState(page, 'A16595316960M');
    assert.equal(state.teacher.email, 'a.meier@neu.example');
    assert.equal(state.classes.length, 1);
    assert.equal(state.event.days.length, 2);
    await page.click(tid('reg-continue'));
    await waitForHash(page, '#/lehrkraft/klassen');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Smartphone (390 × 844): alle Ansichten ohne seitliches Scrollen', async () => {
  const { browser, page, errors } = await launch(MOBILE);
  try {
    await gotoRoute(page, '/lehrkraft');
    await page.waitForSelector(tid('auth-choose-register'));
    await assertNoHorizontalScroll(page, 'Auswahl');
    await shot(page, 'mobil-1-auswahl');

    await page.click(tid('auth-choose-register'));
    await page.waitForSelector(tid('reg-firstname'));
    await page.click(tid('reg-submit'));
    await assertNoHorizontalScroll(page, 'Registrieren');
    await shot(page, 'mobil-2-registrieren-fehler');

    await fillRegistration(page, ANNA);
    await captureDownload(page, () => page.click(tid('reg-submit')));
    await page.waitForSelector(tid('reg-registration-code'));
    await assertNoHorizontalScroll(page, 'Registrierung abgeschlossen');
    await shot(page, 'mobil-3-registrierung-abgeschlossen');

    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-firstname'));
    await fillLogin(page, { firstName: 'Anna', lastName: 'Meier', birthDate: '1990-03-15', code: 'AM1' });
    await page.click(tid('login-submit'));
    await page.locator('.alert-error', { hasText: 'Die Angaben passen nicht' }).waitFor();
    await assertNoHorizontalScroll(page, 'Anmelden');
    await shot(page, 'mobil-4-anmelden-fehler');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Randfälle Registrierung: Datum als Text, Enter-Taste, Doppelklick, sehr lange Namen', async () => {
  const { browser, page, errors } = await launch();
  try {
    // Browser ohne Datumsauswahl: Feld ist ein Textfeld, „TT.MM.JJJJ“ wird verstanden; Absenden mit Enter
    await gotoRoute(page, '/lehrkraft/registrieren');
    await page.waitForSelector(tid('reg-firstname'));
    await page.evaluate(() => (document.querySelector('[data-testid="reg-birthdate"]').type = 'text'));
    await page.fill(tid('reg-birthdate'), '31.02.1990');
    await page.click(tid('reg-submit'));
    assert.match(await page.textContent('#reg-birthdate-error'), /gültiges Datum/);
    await fillRegistration(page, { ...ANNA, birthDate: '15. 3.1990' });
    const viaEnter = await captureDownload(page, () => page.press(tid('reg-email'), 'Enter'));
    assert.equal(pdfPayload(viaEnter.buffer).birthDate, '1990-03-15');
    assert.equal(pdfPayload(viaEnter.buffer).registrationCode, 'AM60127960');
    await page.waitForSelector(tid('reg-registration-code'));

    // Doppelklick erzeugt nur eine Registrierung/einen Download; sehr lange Namen passen auf eine Seite
    const long = {
      firstName: 'Maximiliane-Theresia Anna-Sophie Friederike',
      lastName: 'von und zu Hohenzollern-Sigmaringen-Wittgenstein-Berleburg',
      birthDate: '1999-12-31',
      email: 'maximiliane-theresia.von-und-zu-hohenzollern@sehr-lange-schuladresse-gymnasium.example',
    };
    // Die Erfolgsansicht steht unter derselben Adresse – über die Auswahlseite neu öffnen.
    await gotoRoute(page, '/lehrkraft');
    await page.waitForSelector(tid('auth-choose-register'));
    await gotoRoute(page, '/lehrkraft/registrieren');
    await page.waitForSelector(tid('reg-firstname'));
    await fillRegistration(page, long);
    let downloads = 0;
    page.on('download', () => downloads++);
    const dl = await captureDownload(page, () => page.dblclick(tid('reg-submit')));
    await page.waitForSelector(tid('reg-registration-code'));
    await page.waitForTimeout(500);
    assert.equal(downloads, 1, 'nur ein Download trotz Doppelklick');
    assert.equal(pdfPageCount(dl.buffer), 1);
    assert.equal(pdfPayload(dl.buffer).registrationCode, registrationCode(long.firstName, long.lastName, long.birthDate));
    assert.equal(dl.filename, `ParentsDay Registrierung ${long.firstName} ${long.lastName}.pdf`);
    if (SHOTS) await fs.copyFile(dl.file, path.join(SHOTS, 'registrierung-lange-namen.pdf'));
    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalScroll(page, 'Erfolgsansicht mit langen Namen');
    await shot(page, 'mobil-5-lange-namen');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('PDF-Bibliothek nicht erreichbar: Daten bleiben gespeichert, erneuter Versuch klappt', async () => {
  const { browser, page, errors } = await launch();
  try {
    await page.route('**/vendor/jspdf.umd.min.js', (route) => route.abort());
    await gotoRoute(page, '/lehrkraft/registrieren');
    await page.waitForSelector(tid('reg-firstname'));
    await fillRegistration(page, ANNA);
    await page.click(tid('reg-submit'));
    await page.locator('.tauth-download.alert-error', { hasText: 'Die PDF-Datei konnte nicht erstellt werden.' }).waitFor();
    assert.equal((await page.textContent(tid('reg-download'))).trim(), 'PDF herunterladen');
    assert.equal((await page.textContent(tid('reg-registration-code'))).trim(), 'AM60127960');
    assert.deepEqual((await storedState(page, 'A16595316960M')).teacher, { ...ANNA });
    await shot(page, 'desktop-7-pdf-fehler');

    await page.unroute('**/vendor/jspdf.umd.min.js');
    const dl = await captureDownload(page, () => page.click(tid('reg-download')));
    assert.equal(dl.filename, 'ParentsDay Registrierung Anna Meier.pdf');
    await page.locator('.tauth-download.alert-success').waitFor();
    assert.equal((await page.textContent(tid('reg-download'))).trim(), 'PDF erneut herunterladen');
    // Einzige erwartete Konsolenfehler: die absichtlich blockierte Bibliothek
    assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  } finally {
    await browser.close();
  }
});

test('Anmeldung: Zwischenstand statt PDF, Kleinschreibung auf leerem Gerät, Abmelden im Hinweis', async () => {
  const { browser, page, errors } = await launch();
  try {
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-upload'));

    // Zwischenspeicher-Datei statt Registrierungs-PDF → verständlicher Hinweis
    const backup = JSON.stringify(sampleState());
    await uploadLoginFile(page, { name: 'Zwischenspeicher vom 30.09.2026 um 10꞉00 für ParentsDay.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await page.locator('.alert-error', { hasText: 'Diese Datei ist ein Zwischenstand, keine Registrierungs-PDF.' }).waitFor();
    assert.equal(await sessionCode(page), null);

    // Handeingabe in Kleinbuchstaben auf leerem Gerät → Namen mit großen Anfangsbuchstaben gespeichert
    await fillLogin(page, { firstName: 'anna-lena', lastName: 'meier', birthDate: '1990-03-15', code: registrationCode('Anna-Lena', 'Meier', '1990-03-15') });
    await page.click(tid('login-submit'));
    await waitForHash(page, '#/lehrkraft/elternsprechtag');
    await waitForToast(page, 'Willkommen, Anna-Lena Meier!');
    await waitForToast(page, 'Auf diesem Gerät sind noch keine Daten gespeichert.');
    const code = teacherCode('Anna-Lena', 'Meier', '1990-03-15');
    const state = await storedState(page, code);
    assert.equal(state.teacher.firstName, 'Anna-Lena');
    assert.equal(state.teacher.lastName, 'Meier');
    assert.equal(state.teacher.email, '');
    assert.equal(state.teacher.registrationCode, registrationCode('Anna-Lena', 'Meier', '1990-03-15'));

    // Auswahlseite: „Abmelden“ im Hinweis beendet die Sitzung
    await gotoRoute(page, '/lehrkraft');
    await page.locator('.tauth-session', { hasText: 'Sie sind angemeldet als Anna-Lena Meier' }).waitFor();
    await page.click('.tauth-session >> text=Abmelden');
    await page.waitForSelector(tid('auth-choose-register'));
    await page.waitForFunction(() => !document.querySelector('.tauth-session'));
    assert.equal(await sessionCode(page), null);
    assert.ok(await storedState(page, code), 'Daten bleiben nach dem Abmelden gespeichert');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Tablet (800 px): Felder der Anmeldung passen in ihre Karte', async () => {
  const { browser, page, errors } = await launch({ viewport: { width: 800, height: 1000 }, hasTouch: true });
  try {
    await gotoRoute(page, '/lehrkraft/anmelden');
    await page.waitForSelector(tid('login-code'));
    const overflow = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="login-code"]').closest('.card').getBoundingClientRect();
      return [...document.querySelectorAll('.tauth-way .field > label, .tauth-way .field > input')].filter((el) => el.getBoundingClientRect().right > card.right - 8).map((el) => el.textContent || el.id);
    });
    assert.deepEqual(overflow, []);
    const inputWidth = (await page.locator(tid('login-birthdate')).boundingBox()).width;
    assert.ok(inputWidth >= 250, `Datumsfeld zu schmal: ${inputWidth}px`);
    await assertNoHorizontalScroll(page, 'Anmelden (Tablet)');
    await shot(page, 'tablet-1-anmelden');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
