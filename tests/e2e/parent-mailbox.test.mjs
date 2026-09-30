// Browser-Test: Elternseite mit digitalem Briefkasten – Absenden über den Briefkasten (QR-Link und
// Termin-Schlüssel mit Verzeichnis), Notlösung per E-Mail, wenn der Briefkasten nicht erreichbar ist,
// Darstellung am Smartphone und unverändertes Verhalten ohne Briefkasten.
// Der Briefkasten-Dienst (worker/briefkasten.js) läuft dafür lokal (tests/e2e/mailbox-server.mjs).
// Optional Bildschirmfotos zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/parent-mailbox.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, launch, captureDownload, pdfPayload, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { startMailboxServer } from './mailbox-server.mjs';
import { createTeacherMailbox, decryptForTeacher } from '../../js/core/mailbox.js';
import { eventLink, encodeEventKey, compactEvent, eventInfoFromState, findResponsesInText } from '../../js/core/transport.js';
import { studentCode, teacherCode, registrationCode } from '../../js/core/codes.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const ANNA_BECK = { firstName: 'Anna', lastName: 'Beck', code: '5aA16595316960M11414125311' };
const PDF_NAME = 'ParentsDay Rückmeldung 5a Beck Anna.pdf';

const tid = (id) => `[data-testid="${id}"]`;
const slot = (date, time) => tid(`slot-${date}-${time}`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Briefkasten-Dienst und Webserver starten (die Seite wird ausgeliefert, als wäre MAILBOX_URL gesetzt). */
async function setup() {
  const mb = await startMailboxServer();
  const web = await startServer({ mailboxUrl: mb.url });
  mb.env.ALLOWED_ORIGINS = new URL(web.url).origin;
  return {
    mb,
    web,
    close: async () => {
      await web.close();
      await mb.close();
    },
  };
}

async function shot(page, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' });
}

async function keepFile(file, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.copyFile(file, path.join(SHOTS, name));
}

async function waitForHash(page, hash) {
  await page.waitForFunction((expected) => location.hash === expected, hash);
}

async function assertNoHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${label}: Seite ist ${overflow}px breiter als der Bildschirm`);
}

/** Elternbrief-Link wie im QR-Code (mit Briefkasten, falls die Lehrkraft einen hat), auf den Testserver umgeschrieben. */
function letterUrl(web, state, classId) {
  const link = eventLink(state, classId);
  assert.match(link, /#\/eltern\?e=/);
  return web.url + link.slice(link.indexOf('#'));
}

async function fillLogin(page, { firstName, lastName, code }) {
  await page.fill(tid('parent-firstname'), firstName);
  await page.fill(tid('parent-lastname'), lastName);
  await page.fill(tid('parent-code'), code);
}

async function parentState(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('parentsday.parentTab') || localStorage.getItem('parentsday.parent') || 'null'));
}

/** Holt die Nachrichten direkt beim Dienst ab – so wie die Lehrkraft (nur mit dem Geheimnis). */
async function boxMessages(mb, mailbox) {
  const res = await fetch(`${mb.url}/v1/boxes/${mailbox.id}/messages`, { headers: { Authorization: `Bearer ${mailbox.secret}` } });
  assert.equal(res.status, 200);
  return (await res.json()).messages;
}

function decodedMailto(href) {
  const [recipient, query] = href.replace(/^mailto:/, '').split('?');
  const params = Object.fromEntries(query.split('&').map((p) => p.split('=')).map(([k, v]) => [k, decodeURIComponent(v)]));
  return { recipient, ...params };
}

/** Konsolenfehler ohne die erwarteten Meldungen des Browsers zu abgebrochenen Verbindungen. */
function realErrors(errors) {
  return errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(e));
}

test('Eltern (Smartphone): QR-Link mit Briefkasten → Absenden → Rückmeldung kommt verschlüsselt an, ohne Download', async () => {
  const env = await setup();
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const mailbox = await createTeacherMailbox();
    const state = sampleState({ mailbox });
    await page.goto(letterUrl(env.web, state, '5a'));
    await page.waitForSelector(tid('parent-firstname'));
    await waitForHash(page, '#/eltern');
    // Briefkasten aus dem Link wird übernommen – ohne Geheimnis oder privaten Schlüssel
    const stored = await parentState(page);
    assert.deepEqual(stored.event.mailbox, { id: mailbox.id, publicKey: mailbox.publicKey });
    assert.ok(!JSON.stringify(stored).includes(mailbox.secret));
    await assertNoHorizontalScroll(page, 'Anmeldung');
    await shot(page, 'mobil-1-anmeldung');

    await fillLogin(page, ANNA_BECK);
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    for (const t of ['14:00', '14:10', '14:20']) await page.tap(slot('2026-11-12', t));
    await page.tap(slot('2026-11-13', '16:00'));
    assert.match(await page.textContent('#parent-submit-hint'), /Nach dem Absenden werden Ihre Zeiten verschlüsselt an Anna Meier übermittelt\./);
    await assertNoHorizontalScroll(page, 'Zeiten');
    await shot(page, 'mobil-2-zeiten');

    let downloads = 0;
    page.on('download', () => downloads++);
    // Anfrage kurz aufhalten: Der Knopf zeigt „Wird gesendet …“ und ist gesperrt
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await page.route(`${env.mb.url}/v1/boxes/**`, async (route) => {
      await gate;
      await route.continue();
    });
    await page.tap(tid('parent-submit'));
    const busy = page.locator(tid('parent-submit'), { hasText: 'Wird gesendet' });
    await busy.waitFor();
    assert.equal(await page.isDisabled(tid('parent-submit')), true);
    if (SHOTS) await page.locator('.parent-submit-card').screenshot({ path: path.join(SHOTS, 'mobil-3-wird-gesendet.png'), animations: 'disabled' });
    release();
    await waitForHash(page, '#/eltern/fertig');
    await page.unroute(`${env.mb.url}/v1/boxes/**`);

    // Große Erfolgsmeldung, keine E-Mail-Anleitung
    const ok = page.locator(tid('parent-sent-ok'));
    await ok.waitFor();
    const okText = await ok.textContent();
    assert.match(okText, /Vielen Dank!/);
    assert.match(okText, /Ihre Rückmeldung ist bei Anna Meier angekommen\. Sie müssen nichts weiter tun\./);
    assert.equal(await page.locator(tid('parent-mailto')).count(), 0);
    assert.equal(await page.locator(tid('parent-share')).count(), 0);
    assert.doesNotMatch(await page.textContent('main'), /E-Mail an die Lehrkraft|Büroklammer|Fast geschafft/);
    const summary = await page.textContent('.parent-done-summary');
    assert.match(summary, /Donnerstag, 12\.11\.2026: 14:00–14:30 Uhr/);
    assert.match(summary, /Freitag, 13\.11\.2026: 16:00–16:10 Uhr/);
    assert.match(summary, /Anna Beck, Klasse 5a · gesendet am/);
    await page.waitForTimeout(400);
    assert.equal(downloads, 0, 'kein automatischer Download');
    await assertNoHorizontalScroll(page, 'Angekommen');
    const okBox = await ok.boundingBox();
    assert.ok(okBox.y + okBox.height <= 844, `Erfolgsmeldung endet bei ${Math.round(okBox.y + okBox.height)}px (Bildschirm 844px)`);
    await shot(page, 'mobil-4-angekommen');

    // Im Briefkasten liegt genau eine Nachricht; nur die Lehrkraft kann sie lesen
    const messages = await boxMessages(env.mb, mailbox);
    assert.equal(messages.length, 1);
    assert.ok(!JSON.stringify(messages).includes('Beck'), 'Der Dienst sieht keine Namen');
    const payload = await decryptForTeacher(mailbox.privateKey, messages[0]);
    assert.equal(payload.app, 'ParentsDay');
    assert.equal(payload.type, 'parent-response');
    assert.equal(payload.code, ANNA_BECK.code);
    assert.equal(payload.firstName, 'Anna');
    assert.equal(payload.lastName, 'Beck');
    assert.equal(payload.classId, '5a');
    assert.equal(payload.teacherCode, SAMPLE_TEACHER.teacherCode);
    assert.equal(payload.slotMinutes, 10);
    assert.deepEqual(payload.availability, { '2026-11-12': [['14:00', '14:30']], '2026-11-13': [['16:00', '16:10']] });
    const sent = await parentState(page);
    assert.equal(sent.sentVia, 'mailbox');
    assert.ok(!Number.isNaN(Date.parse(sent.sentAt)));
    assert.equal(sent.submittedAt, payload.submittedAt);
    assert.deepEqual(sent.lastPayload, payload);

    // Beleg als PDF: die bisherige Rückmelde-PDF mit denselben Daten
    const receipt = await captureDownload(page, () => page.tap(tid('parent-download')));
    assert.equal(receipt.filename, PDF_NAME);
    assert.deepEqual(pdfPayload(receipt.buffer), payload);
    await keepFile(receipt.file, 'beleg.pdf');

    // Zeiten ändern → Hinweis → erneut absenden: zweite Nachricht, die neueste gilt
    await page.tap('a.btn[href="#/eltern/zeiten"]');
    await page.waitForSelector(slot('2026-11-12', '14:30'));
    assert.match(await page.textContent('main .alert-success'), /bei Anna Meier angekommen/);
    assert.doesNotMatch(await page.textContent('main .alert-success'), /PDF-Datei/);
    await page.tap(slot('2026-11-12', '14:30'));
    await page.locator('main .alert-success a[href="#/eltern/fertig"]').tap();
    await page.locator('.alert-warning', { hasText: 'nach dem Absenden geändert' }).waitFor();
    assert.doesNotMatch(await page.textContent(tid('parent-sent-ok')), /nichts weiter tun/);
    await shot(page, 'mobil-5-geaendert');
    await page.tap('a.btn[href="#/eltern/zeiten"]');
    await page.waitForSelector(slot('2026-11-12', '14:30'));
    await page.tap(tid('parent-submit'));
    await waitForHash(page, '#/eltern/fertig');
    await page.locator(tid('parent-sent-ok')).waitFor();
    assert.equal(await page.locator('.alert-warning').count(), 0);
    const both = await boxMessages(env.mb, mailbox);
    assert.equal(both.length, 2);
    const latest = await decryptForTeacher(mailbox.privateKey, both[1]);
    assert.deepEqual(latest.availability['2026-11-12'], [['14:00', '14:40']]);
    assert.ok(Date.parse(latest.submittedAt) > Date.parse(payload.submittedAt), 'neuere Rückmeldung');

    // Beleg-Hinweis und deutlich hervorgehobener Knopf „Beenden und ausloggen“
    await page.goto(`${env.web.url}#/eltern/fertig`);
    await page.locator(tid('parent-sent-ok')).waitFor();
    const note = await page.textContent(tid('parent-receipt-note'));
    assert.match(note, /nur als Ihr eigener Nachweis und muss nirgendwo eingereicht werden/);
    const logout = page.locator(tid('parent-logout'));
    assert.equal((await logout.textContent()).trim(), 'Beenden und ausloggen');
    assert.match(await logout.getAttribute('class'), /\bbtn-primary\b/);
    await page.tap(tid('parent-logout'));
    const dialog = page.locator('.modal');
    assert.match(await dialog.textContent(), /angekommen/);
    await dialog.getByRole('button', { name: 'Ja, ausloggen' }).tap();
    await waitForHash(page, '#/');
    assert.equal(await parentState(page), null);
    assert.equal(downloads, 1, 'nur der Beleg wurde heruntergeladen');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await env.close();
  }
});

test('Eltern (Desktop): Termin-Schlüssel ohne QR-Code → Lehrkraft und Briefkasten aus dem Verzeichnis', async () => {
  const env = await setup();
  const { browser, page, errors } = await launch(DESKTOP);
  try {
    const mailbox = await createTeacherMailbox();
    const state = sampleState({ mailbox });
    // Die Lehrkraft legt den Verzeichniseintrag ab (wie beim Erstellen der Elternbriefe)
    await page.goto(env.web.url);
    const published = await page.evaluate((s) => import('./js/core/teacher-mailbox.js').then((m) => m.publishClassDirectory(s, '5a')), state);
    assert.equal(published, true);

    const key = encodeEventKey(state.event, { teacherCode: SAMPLE_TEACHER.teacherCode, classId: '5a' });
    await page.goto(`${env.web.url}#/eltern`);
    await page.waitForSelector(tid('parent-key'));
    await fillLogin(page, ANNA_BECK);
    // Schlüssel klein, ohne Bindestriche und mit „O“ statt „0“ abgetippt: gefunden wird er trotzdem
    await page.fill(tid('parent-key'), key.replace(/-/g, '').replace(/0/g, 'O').toLowerCase());
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await page.route(`${env.mb.url}/v1/directory/**`, async (route) => {
      await gate;
      await route.continue();
    });
    await page.click(tid('parent-login'));
    await page.locator(tid('parent-login'), { hasText: 'Termindaten werden geladen' }).waitFor();
    assert.equal(await page.isDisabled(tid('parent-login')), true);
    await shot(page, 'desktop-1-termindaten-laden');
    release();
    await waitForHash(page, '#/eltern/zeiten');
    await page.unroute(`${env.mb.url}/v1/directory/**`);
    await page.waitForSelector(slot('2026-11-12', '14:00'));

    // Name, Schule und Briefkasten der Lehrkraft sind jetzt bekannt
    const overview = await page.textContent('.parent-overview');
    assert.ok(overview.includes('Anna Meier'), 'Lehrkraft wird angezeigt');
    assert.ok(overview.includes('Gesamtschule Süd'), 'Schule wird angezeigt');
    const stored = await parentState(page);
    assert.deepEqual(stored.event.mailbox, { id: mailbox.id, publicKey: mailbox.publicKey });
    assert.equal(stored.event.teacherEmail, SAMPLE_TEACHER.email);
    assert.equal(stored.event.classId, '5a');
    assert.equal(stored.login.code, ANNA_BECK.code);
    assert.match(await page.textContent('#parent-submit-hint'), /Bitte markieren Sie zuerst/);
    await page.click(slot('2026-11-13', '15:00'));
    await page.click(slot('2026-11-13', '15:10'));
    assert.match(await page.textContent('#parent-submit-hint'), /verschlüsselt an Anna Meier übermittelt/);
    await shot(page, 'desktop-2-zeiten');

    let downloads = 0;
    page.on('download', () => downloads++);
    await page.click(tid('parent-submit'));
    await waitForHash(page, '#/eltern/fertig');
    await page.locator(tid('parent-sent-ok'), { hasText: 'bei Anna Meier angekommen' }).waitFor();
    await assertNoHorizontalScroll(page, 'Angekommen (Desktop)');
    await shot(page, 'desktop-3-angekommen');
    const messages = await boxMessages(env.mb, mailbox);
    assert.equal(messages.length, 1);
    const payload = await decryptForTeacher(mailbox.privateKey, messages[0]);
    assert.equal(payload.code, ANNA_BECK.code);
    assert.equal(payload.classId, '5a');
    assert.deepEqual(payload.availability, { '2026-11-12': [], '2026-11-13': [['15:00', '15:20']] });
    assert.equal(downloads, 0);

    // Zurück zur Anmeldung: Elternbrief-Daten und Bestätigung
    await page.goto(`${env.web.url}#/eltern`);
    await page.locator('.parent-loggedin', { hasText: 'bei Anna Meier angekommen' }).waitFor();
    assert.match(await page.textContent('.parent-event'), /Elternsprechtag bei Anna Meier/);
    await shot(page, 'desktop-4-angemeldet');

    // Lehrkraft mit „Ł“ und „Ż“; die Eltern tippen „L“ und „Z“ ab – der Eintrag wird trotzdem gefunden
    const zak = { firstName: 'Łukasz', lastName: 'Żak', birthDate: '1987-06-24', email: 'lukasz.zak@schule.example' };
    const zakCode = teacherCode(zak.firstName, zak.lastName, zak.birthDate);
    const zakBox = await createTeacherMailbox();
    const zakState = sampleState({
      teacher: { ...zak, registrationCode: registrationCode(zak.firstName, zak.lastName, zak.birthDate), teacherCode: zakCode },
      event: { schoolAddress: 'Realschule Nord', slotMinutes: 15, days: [{ date: '2026-11-19', start: '15:00', end: '17:00' }] },
      mailbox: zakBox,
    });
    assert.equal(await page.evaluate((s) => import('./js/core/teacher-mailbox.js').then((m) => m.publishClassDirectory(s, '7b')), zakState), true);
    await page.click(tid('parent-switch'));
    await page.locator('.modal', { hasText: 'bereits bei der Lehrkraft angekommen' }).getByRole('button', { name: 'Ja, abmelden' }).click();
    await page.click(tid('parent-other-key'));
    await page.waitForSelector(tid('parent-key'));
    const mia = studentCode(7, 'b', zakCode, 'Mia', 'Beck');
    await fillLogin(page, { firstName: 'Mia', lastName: 'Beck', code: mia.replace('Ł', 'L').replace('Ż', 'Z') });
    await page.fill(tid('parent-key'), encodeEventKey(zakState.event, { teacherCode: zakCode, classId: '7b' }));
    await page.click(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-19', '15:00'));
    assert.ok((await page.textContent('.parent-overview')).includes('Łukasz Żak'));
    assert.equal((await parentState(page)).login.code, mia, 'Schreibweise der Lehrkraft');
    await page.click(slot('2026-11-19', '15:15'));
    await page.click(tid('parent-submit'));
    await page.locator(tid('parent-sent-ok'), { hasText: 'bei Łukasz Żak angekommen' }).waitFor();
    const zakMessages = await boxMessages(env.mb, zakBox);
    assert.equal(zakMessages.length, 1);
    const zakPayload = await decryptForTeacher(zakBox.privateKey, zakMessages[0]);
    assert.equal(zakPayload.code, mia);
    assert.deepEqual(zakPayload.availability, { '2026-11-19': [['15:15', '15:30']] });
    assert.equal((await boxMessages(env.mb, mailbox)).length, 1, 'nichts im Briefkasten von Frau Meier');
    assert.equal(downloads, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await env.close();
  }
});

test('Eltern: Termin-Schlüssel ohne passenden Verzeichniseintrag → wie bisher weiter, Rückmeldung per E-Mail', async () => {
  const env = await setup();
  const { browser, page, errors } = await launch(DESKTOP);
  try {
    const mailbox = await createTeacherMailbox();
    const state = sampleState({ mailbox });
    const tCode = SAMPLE_TEACHER.teacherCode;
    // Klasse 6a: Eintrag mit anderen Tagen, als der Schlüssel nennt → darf nicht übernommen werden
    const key6a = encodeEventKey(state.event, { teacherCode: tCode, classId: '6a' });
    const otherDays = { ...state, event: { ...state.event, days: [{ date: '2026-12-01', start: '08:00', end: '09:00' }] } };
    await page.goto(env.web.url);
    const put = await page.evaluate(
      ([mb, ref, compact]) => import('./js/core/mailbox.js').then((m) => m.publishDirectoryEntry(mb, ref, compact)),
      [mailbox, { teacherCode: tCode, classId: '6a', eventKey: key6a }, compactEvent(eventInfoFromState(otherDays, '6a'))],
    );
    assert.equal(put, true);

    const cases = [
      { label: 'kein Eintrag', classId: '5b', grade: 5, letter: 'b' },
      { label: 'unpassender Eintrag', classId: '6a', grade: 6, letter: 'a' },
    ];
    for (const c of cases) {
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      const child = { firstName: 'Lena', lastName: 'Beck', code: studentCode(c.grade, c.letter, tCode, 'Lena', 'Beck') };
      const key = encodeEventKey(state.event, { teacherCode: tCode, classId: c.classId });
      await page.goto(`${env.web.url}#/`);
      await page.goto(`${env.web.url}#/eltern`);
      await page.waitForSelector(tid('parent-key'));
      await fillLogin(page, child);
      await page.fill(tid('parent-key'), key);
      await page.click(tid('parent-login'));
      await waitForHash(page, '#/eltern/zeiten');
      await page.waitForSelector(slot('2026-11-12', '14:00'));
      assert.ok(!(await page.textContent('.parent-overview')).includes('Lehrkraft'), `${c.label}: Lehrkraft unbekannt`);
      const stored = await parentState(page);
      assert.equal(stored.event.source, 'key', c.label);
      assert.equal(stored.event.mailbox, undefined, c.label);
      assert.equal(stored.event.classId, c.classId);
      assert.match(await page.textContent('#parent-submit-hint'), /Bitte markieren/);
      await page.click(slot('2026-11-12', '14:00'));
      assert.match(await page.textContent('#parent-submit-hint'), /PDF-Datei mit Ihren Zeiten heruntergeladen/, c.label);
      const dl = await captureDownload(page, () => page.click(tid('parent-submit')));
      assert.equal(pdfPayload(dl.buffer).code, child.code);
      await waitForHash(page, '#/eltern/fertig');
      await page.waitForSelector(tid('parent-mailto'));
      assert.match(await page.textContent('h1'), /Fast geschafft/);
      assert.equal((await parentState(page)).sentVia, 'email');
    }
    assert.equal((await boxMessages(env.mb, mailbox)).length, 0, 'nichts im Briefkasten');
    // Kein Eintrag im Verzeichnis ist normal: keine Fehlermeldung (404) in der Konsole
    assert.deepEqual(errors, []);

    // Briefkasten-Dienst ausgefallen: Anmeldung mit Schlüssel klappt trotzdem, ohne Fehlermeldung
    await env.mb.close();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto(`${env.web.url}#/`);
    await page.goto(`${env.web.url}#/eltern`);
    await fillLogin(page, ANNA_BECK);
    await page.fill(tid('parent-key'), encodeEventKey(state.event, { teacherCode: tCode, classId: '5a' }));
    await page.click(tid('parent-login'));
    await waitForHash(page, '#/eltern/zeiten');
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    assert.equal(await page.locator('main .alert-error').count(), 0);
    assert.equal((await parentState(page)).event.source, 'key');
    assert.deepEqual(realErrors(errors), []);
  } finally {
    await browser.close();
    await env.close();
  }
});

test('Eltern (Smartphone): Briefkasten nicht erreichbar → Meldung, erneut versuchen, Notlösung per E-Mail mit PDF', async () => {
  const env = await setup();
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const mailbox = await createTeacherMailbox();
    const state = sampleState({ mailbox });
    await page.goto(letterUrl(env.web, state, '5a'));
    await fillLogin(page, ANNA_BECK);
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    await page.tap(slot('2026-11-12', '14:00'));
    await page.tap(slot('2026-11-12', '14:10'));

    // Der Briefkasten fällt aus
    await env.mb.close();
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.tap(tid('parent-submit'));
    const alert = page.locator('.parent-submit-card .alert-error');
    await alert.waitFor();
    let text = await alert.textContent();
    assert.match(text, /Ihre Rückmeldung konnte gerade nicht übermittelt werden\./);
    assert.match(text, /Der digitale Briefkasten ist gerade nicht erreichbar/);
    assert.doesNotMatch(text, /fetch|TypeError|undefined/i);
    assert.equal(await page.locator(tid('parent-submit')).isHidden(), true, 'statt „Absenden“ zwei Knöpfe');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'parent-retry', 'Fokus auf „Erneut versuchen“');
    assert.equal(await page.evaluate(() => location.hash), '#/eltern/zeiten');
    await assertNoHorizontalScroll(page, 'Fehler');
    await shot(page, 'mobil-6-fehler');

    // Eine Änderung an den Zeiten führt zurück zu „Absenden“
    await page.tap(slot('2026-11-12', '14:20'));
    assert.equal(await alert.count(), 0);
    assert.equal(await page.locator(tid('parent-submit')).isVisible(), true);
    await page.tap(tid('parent-submit'));
    await alert.waitFor();

    // „Erneut versuchen“ scheitert wieder
    await page.tap(tid('parent-retry'));
    await page.locator('.parent-submit-card .alert-error', { hasText: 'Leider hat es wieder nicht geklappt' }).waitFor();
    text = await alert.textContent();
    assert.match(text, /Ihre Rückmeldung konnte gerade nicht übermittelt werden\./);
    await shot(page, 'mobil-7-fehler-erneut');
    assert.equal(downloads, 0);
    const pending = await parentState(page);
    assert.equal(pending.submittedAt, undefined, 'nichts als abgesendet vermerkt');

    // „Stattdessen per E-Mail senden“: PDF und E-Mail wie bisher
    const dl = await captureDownload(page, () => page.tap(tid('parent-fallback')));
    assert.equal(dl.filename, PDF_NAME);
    const payload = pdfPayload(dl.buffer);
    assert.equal(payload.code, ANNA_BECK.code);
    assert.deepEqual(payload.availability, { '2026-11-12': [['14:00', '14:30']], '2026-11-13': [] });
    await waitForHash(page, '#/eltern/fertig');
    await page.waitForSelector(tid('parent-mailto'));
    assert.match(await page.textContent('h1'), /Fast geschafft/);
    assert.ok((await page.textContent('.parent-steps')).includes(`„${PDF_NAME}“ wurde heruntergeladen`));
    assert.equal(await page.locator(tid('parent-sent-ok')).count(), 0);
    const mail = decodedMailto(await page.getAttribute(tid('parent-mailto'), 'href'));
    assert.equal(mail.recipient, SAMPLE_TEACHER.email);
    assert.match(mail.body, /Donnerstag, 12\.11\.2026: 14:00–14:30 Uhr/);
    assert.deepEqual(findResponsesInText(mail.body)[0].availability, payload.availability);
    const stored = await parentState(page);
    assert.equal(stored.sentVia, 'email');
    assert.equal(stored.lastFilename, PDF_NAME);
    await assertNoHorizontalScroll(page, 'Fertig per E-Mail');
    await shot(page, 'mobil-8-notloesung-email');
    await keepFile(dl.file, 'notloesung.pdf');
    assert.equal(downloads, 1);
    assert.deepEqual(realErrors(errors), []);
  } finally {
    await browser.close();
    await env.close();
  }
});

test('Eltern: Smartphone (390 × 844) und Desktop – lange Namen ohne seitliches Scrollen', async () => {
  const env = await setup();
  const child = {
    firstName: 'Çağla-Sophie Maximiliane',
    lastName: 'Łukasiewicz-Øster von Hohenzollern-Sigmaringen',
    code: '10cA16595316960M3171211915168951312491391291145122111119952393261551920518221514815851426151212518141997131189147514',
  };
  const mailbox = await createTeacherMailbox();
  const state = sampleState({
    mailbox,
    teacher: {
      ...SAMPLE_TEACHER,
      firstName: 'Maximiliane-Theresia',
      lastName: 'von Hohenzollern-Sigmaringen-Wittgenstein',
      email: 'maximiliane-theresia.von-hohenzollern@gesamtschule-musterstadt-sued.example',
    },
    event: {
      schoolAddress: 'Städtische Gesamtschule Süd – Europaschule\nSchulstraße 1–3\n12345 Musterstadt-Oberdorf',
      slotMinutes: 5,
      days: [
        { date: '2026-11-12', start: '14:00', end: '18:00' },
        { date: '2026-11-13', start: '15:00', end: '17:00' },
      ],
    },
  });
  try {
    for (const [name, opts] of [
      ['mobil', MOBILE],
      ['desktop', DESKTOP],
    ]) {
      const { browser, page, errors } = await launch(opts);
      try {
        const click = (sel) => (opts.hasTouch ? page.tap(sel) : page.click(sel));
        await page.goto(letterUrl(env.web, state, '10c'));
        await fillLogin(page, child);
        await click(tid('parent-login'));
        await page.waitForSelector(slot('2026-11-12', '14:00'));
        for (const t of ['14:00', '14:10', '14:20', '15:00', '16:30']) await click(slot('2026-11-12', t));
        await page.locator('.parent-day', { has: page.locator(tid('day-summary-2026-11-13')) }).getByRole('button', { name: 'Ganzen Tag markieren' }).click();

        // Fehlerzustand (Verbindung bricht ab)
        await page.route(`${env.mb.url}/v1/boxes/**`, (route) => route.abort('internetdisconnected'));
        await click(tid('parent-submit'));
        await page.locator('.parent-submit-card .alert-error').waitFor();
        await assertNoHorizontalScroll(page, `${name}: Fehler`);
        for (const id of ['parent-retry', 'parent-fallback']) {
          const box = await page.locator(tid(id)).boundingBox();
          const width = opts.viewport.width;
          assert.ok(box.x >= 0 && box.x + box.width <= width, `${name}: ${id} passt auf den Bildschirm`);
        }
        await shot(page, `${name}-9-fehler-lang`);

        // Wieder erreichbar: „Erneut versuchen“ klappt
        await page.unroute(`${env.mb.url}/v1/boxes/**`);
        await click(tid('parent-retry'));
        await waitForHash(page, '#/eltern/fertig');
        const ok = page.locator(tid('parent-sent-ok'));
        await ok.waitFor();
        assert.match(await ok.textContent(), /bei Maximiliane-Theresia von Hohenzollern-Sigmaringen-Wittgenstein angekommen/);
        await assertNoHorizontalScroll(page, `${name}: Angekommen`);
        await shot(page, `${name}-10-angekommen-lang`);
        assert.deepEqual(realErrors(errors), []);
      } finally {
        await browser.close();
      }
    }
    const messages = await boxMessages(env.mb, mailbox);
    assert.equal(messages.length, 2);
    const payload = await decryptForTeacher(mailbox.privateKey, messages[0]);
    assert.equal(payload.lastName, child.lastName);
    assert.equal(payload.slotMinutes, 5);
  } finally {
    await env.close();
  }
});

test('Eltern: ohne eingerichteten Briefkasten oder mit älterem Elternbrief bleibt alles wie bisher', async () => {
  // 1. MAILBOX_URL leer (wie im Repository), Elternbrief aber mit Briefkasten
  const plain = await startServer();
  const env = await setup();
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const requests = [];
    page.on('request', (req) => {
      if (req.url().startsWith(env.mb.url)) requests.push(req.url());
    });
    const mailbox = await createTeacherMailbox();
    await page.goto(letterUrl(plain, sampleState({ mailbox }), '5a'));
    await fillLogin(page, ANNA_BECK);
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    await page.tap(slot('2026-11-12', '14:00'));
    assert.match(await page.textContent('#parent-submit-hint'), /PDF-Datei mit Ihren Zeiten heruntergeladen/);
    let dl = await captureDownload(page, () => page.tap(tid('parent-submit')));
    assert.equal(dl.filename, PDF_NAME);
    await waitForHash(page, '#/eltern/fertig');
    await page.waitForSelector(tid('parent-mailto'));
    assert.match(await page.textContent('h1'), /Fast geschafft/);

    // Termin-Schlüssel ohne Briefkasten: kein Nachschlagen im Verzeichnis
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto(`${plain.url}#/`);
    await page.goto(`${plain.url}#/eltern`);
    await fillLogin(page, ANNA_BECK);
    await page.fill(tid('parent-key'), encodeEventKey(sampleState().event, { teacherCode: SAMPLE_TEACHER.teacherCode, classId: '5a' }));
    await page.tap(tid('parent-login'));
    await waitForHash(page, '#/eltern/zeiten');

    // 2. Briefkasten eingerichtet, aber älterer Elternbrief ohne Briefkasten bzw. mit kaputten Angaben
    for (const bad of [null, { id: 'zu-kurz', publicKey: mailbox.publicKey }, { id: mailbox.id, publicKey: 'x' }]) {
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.goto(`${env.web.url}#/`);
      const link = letterUrl(env.web, sampleState(), '5a');
      const raw = JSON.parse(Buffer.from(new URL(link.replace('#/eltern?', '?')).searchParams.get('e'), 'base64url').toString('utf8'));
      if (bad) Object.assign(raw, { b: bad.id, p: bad.publicKey });
      await page.goto(`${env.web.url}#/eltern?e=${Buffer.from(JSON.stringify(raw)).toString('base64url')}`);
      await fillLogin(page, ANNA_BECK);
      await page.tap(tid('parent-login'));
      await page.waitForSelector(slot('2026-11-12', '14:00'));
      assert.equal((await parentState(page)).event.mailbox, undefined);
      await page.tap(slot('2026-11-12', '14:00'));
      dl = await captureDownload(page, () => page.tap(tid('parent-submit')));
      assert.equal(pdfPayload(dl.buffer).code, ANNA_BECK.code);
      await waitForHash(page, '#/eltern/fertig');
      await page.waitForSelector(tid('parent-mailto'));
    }
    // Ein gespeicherter Stand mit verändertem Briefkasten wird beim Laden bereinigt
    await page.evaluate((mb) => {
      const s = JSON.parse(sessionStorage.getItem('parentsday.parentTab'));
      s.event.mailbox = { id: mb.id, publicKey: 'kaputt' };
      sessionStorage.setItem('parentsday.parentTab', JSON.stringify(s));
    }, mailbox);
    await page.goto(`${env.web.url}#/`);
    await page.goto(`${env.web.url}#/eltern/zeiten`);
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    assert.match(await page.textContent('main .alert-success'), /Zur E-Mail an die Lehrkraft/);
    await page.tap(slot('2026-11-12', '14:10'));
    assert.match(await page.textContent('#parent-submit-hint'), /PDF-Datei/);

    assert.deepEqual(requests, [], 'keine Anfrage an einen Briefkasten');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await plain.close();
    await env.close();
  }
});

test('Eltern: während des Sendens kein zweites Absenden, Hinweis bei langsamer Verbindung, Kindwechsel vermischt nichts', async () => {
  const env = await setup();
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const mailbox = await createTeacherMailbox();
    const state = sampleState({ mailbox });
    await page.goto(letterUrl(env.web, state, '5a'));
    await fillLogin(page, ANNA_BECK);
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    await page.tap(slot('2026-11-12', '14:00'));
    assert.match(await page.textContent('#parent-submit-hint'), /werden Ihre Zeiten verschlüsselt an Anna Meier übermittelt/);

    // Die Verbindung hängt: Eine Änderung an den Zeiten gibt „Absenden“ nicht wieder frei
    let release;
    let gate = new Promise((resolve) => (release = resolve));
    await page.route(`${env.mb.url}/v1/boxes/**`, async (route) => {
      await gate;
      await route.continue();
    });
    await page.tap(tid('parent-submit'));
    await page.locator(tid('parent-submit'), { hasText: 'Wird gesendet' }).waitFor();
    await page.tap(slot('2026-11-12', '14:10'));
    assert.equal(await page.isDisabled(tid('parent-submit')), true, 'während des Sendens gesperrt');
    // Nach einigen Sekunden beruhigt ein Hinweis am Knopf
    await page.locator(tid('parent-submit'), { hasText: 'Wird noch gesendet – bitte warten' }).waitFor({ timeout: 8000 });
    await assertNoHorizontalScroll(page, 'Langsam');
    if (SHOTS) await page.locator('.parent-submit-card').screenshot({ path: path.join(SHOTS, 'pruef-mobil-langsam.png'), animations: 'disabled' });
    release();
    await waitForHash(page, '#/eltern/fertig');
    await page.unroute(`${env.mb.url}/v1/boxes/**`);
    // Gesendet wurde der Stand beim Tippen auf „Absenden“ – genau einmal; die spätere Änderung fällt auf
    const messages = await boxMessages(env.mb, mailbox);
    assert.equal(messages.length, 1, 'nur eine Nachricht');
    const first = await decryptForTeacher(mailbox.privateKey, messages[0]);
    assert.deepEqual(first.availability['2026-11-12'], [['14:00', '14:10']]);
    await page.locator('.alert-warning', { hasText: 'nach dem Absenden geändert' }).waitFor();
    assert.deepEqual((await parentState(page)).selection['2026-11-12'], [840, 850], 'Änderung bleibt erhalten');

    // Abmelden mit Änderungen, die noch nicht angekommen sind: Die Rückfrage sagt das
    await page.tap('a.btn[href="#/eltern/zeiten"]');
    await page.tap('a.back-link');
    await page.tap(tid('parent-switch'));
    assert.match(await page.locator('.modal').textContent(), /Ihre Änderungen nach dem Absenden sind noch nicht bei der Lehrkraft/);
    await page.locator('.modal').getByRole('button', { name: 'Zurück' }).tap();

    // Senden dauert, währenddessen melden sich die Eltern ab und ein Geschwisterkind an
    gate = new Promise((resolve) => (release = resolve));
    await page.route(`${env.mb.url}/v1/boxes/**`, async (route) => {
      await gate;
      await route.continue();
    });
    await page.tap(tid('parent-continue'));
    await page.tap(tid('parent-submit'));
    await page.locator(tid('parent-submit'), { hasText: 'Wird gesendet' }).waitFor();
    await page.tap('a.back-link');
    await page.tap(tid('parent-switch'));
    await page.locator('.modal').getByRole('button', { name: 'Ja, abmelden' }).tap();
    const lena = { firstName: 'Lena', lastName: 'Beck', code: studentCode(5, 'a', SAMPLE_TEACHER.teacherCode, 'Lena', 'Beck') };
    await fillLogin(page, lena);
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    release();
    await page.locator('.toast', { hasText: 'Die Rückmeldung für Anna Beck ist bei Anna Meier angekommen.' }).waitFor();
    await page.unroute(`${env.mb.url}/v1/boxes/**`);
    assert.equal(await page.evaluate(() => location.hash), '#/eltern/zeiten');
    const lenaState = await parentState(page);
    assert.equal(lenaState.login.code, lena.code);
    assert.equal(lenaState.submittedAt, undefined, 'Lena hat nichts abgesendet');
    assert.equal(lenaState.lastPayload, undefined);
    assert.deepEqual(Object.values(lenaState.selection || {}).flat(), [], 'Annas Zeiten landen nicht bei Lena');
    assert.equal(await page.locator('main .alert-success').count(), 0);
    assert.equal(await page.isDisabled(tid('parent-submit')), true);
    const all = await boxMessages(env.mb, mailbox);
    assert.equal(all.length, 2);
    assert.equal((await decryptForTeacher(mailbox.privateKey, all[1])).code, ANNA_BECK.code);
    assert.deepEqual(realErrors(errors), []);
  } finally {
    await browser.close();
    await env.close();
  }
});

test('Eltern: Fehlermeldungen passen zur Ursache – ohne technische Begriffe, bei vollem Briefkasten zuerst per E-Mail', async () => {
  const env = await setup();
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const mailbox = await createTeacherMailbox();
    const state = sampleState({ mailbox });
    const origin = new URL(env.web.url).origin;
    const requests = [];
    page.on('request', (req) => {
      if (req.url().startsWith(`${env.mb.url}/v1/boxes/`) && req.method() === 'POST') requests.push(req.url());
    });
    const open = async (url) => {
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.goto(`${env.web.url}#/`);
      await page.goto(url);
      await fillLogin(page, ANNA_BECK);
      await page.tap(tid('parent-login'));
      await page.waitForSelector(slot('2026-11-12', '14:00'));
      await page.tap(slot('2026-11-12', '14:00'));
      await page.tap(tid('parent-submit'));
      const alert = page.locator('.parent-submit-card .alert-error');
      await alert.waitFor();
      const text = await alert.textContent();
      assert.doesNotMatch(text, /Error|fetch|undefined|wie bisher/, text);
      // Über dem Fehlerkasten verspricht kein Hinweis mehr die Übermittlung
      assert.equal(await page.textContent('#parent-submit-hint'), 'Sie haben 1 Zeitraum markiert.');
      const order = await page.locator('.parent-send-actions .btn').evaluateAll((els) => els.map((el) => el.dataset.testid));
      const focused = await page.evaluate(() => document.activeElement?.dataset.testid);
      return { text, order, focused };
    };
    await page.goto(env.web.url);

    // Briefkasten voll: Ein erneuter Versuch hilft nicht – „Stattdessen per E-Mail senden“ steht vorn
    await page.route(`${env.mb.url}/v1/boxes/**`, (route) =>
      route.fulfill({ status: 507, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: '{"error":"mailbox-full"}' }),
    );
    let r = await open(letterUrl(env.web, state, '5a'));
    assert.match(r.text, /Der Briefkasten der Lehrkraft ist voll\./);
    assert.match(r.text, /Bitte schicken Sie Ihre Zeiten stattdessen als PDF-Datei per E-Mail an die Lehrkraft\./);
    assert.doesNotMatch(r.text, /gleich noch einmal/);
    assert.deepEqual(r.order, ['parent-fallback', 'parent-retry']);
    assert.equal(r.focused, 'parent-fallback');
    await assertNoHorizontalScroll(page, 'Voll');
    await shot(page, 'pruef-mobil-briefkasten-voll');
    const dl = await captureDownload(page, () => page.tap(tid('parent-fallback')));
    assert.equal(pdfPayload(dl.buffer).code, ANNA_BECK.code);
    await waitForHash(page, '#/eltern/fertig');
    await page.waitForSelector(tid('parent-mailto'));
    // Rückfrage beim Abmelden nach der Notlösung: Es geht um die PDF-Datei
    await page.goto(`${env.web.url}#/eltern`);
    await page.tap(tid('parent-switch'));
    assert.match(await page.locator('.modal').textContent(), /Haben Sie die PDF-Datei schon an die Lehrkraft geschickt\?/);
    await page.locator('.modal').getByRole('button', { name: 'Zurück' }).tap();

    // Zu viele Anfragen: in einer Minute noch einmal
    await page.unroute(`${env.mb.url}/v1/boxes/**`);
    await page.route(`${env.mb.url}/v1/boxes/**`, (route) =>
      route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: '{"error":"too-many-requests"}' }),
    );
    r = await open(letterUrl(env.web, state, '5a'));
    assert.match(r.text, /Gerade kommen sehr viele Rückmeldungen an\.\s*Bitte warten Sie eine Minute/);
    assert.equal((r.text.match(/noch einmal/g) || []).length, 1, 'Rat nur einmal');
    assert.deepEqual(r.order, ['parent-retry', 'parent-fallback']);
    assert.equal(r.focused, 'parent-retry');

    // Störung beim Dienst
    await page.unroute(`${env.mb.url}/v1/boxes/**`);
    await page.route(`${env.mb.url}/v1/boxes/**`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin }, body: '{"error":"server-error"}' }),
    );
    r = await open(letterUrl(env.web, state, '5a'));
    assert.match(r.text, /Der digitale Briefkasten ist gerade gestört\.\s*Bitte versuchen Sie es gleich noch einmal\./);
    assert.equal((r.text.match(/noch einmal/g) || []).length, 1, 'Rat nur einmal');
    await page.unroute(`${env.mb.url}/v1/boxes/**`);

    // Beschädigter öffentlicher Schlüssel im Link (richtige Länge, aber kein gültiger Schlüssel):
    // verständliche Meldung statt „DataError“, nichts wird gesendet, Weg per E-Mail vorn
    const raw = compactEvent(eventInfoFromState(state, '5a'));
    raw.p = 'A'.repeat(87);
    const before = requests.length;
    r = await open(`${env.web.url}#/eltern?e=${Buffer.from(JSON.stringify(raw)).toString('base64url')}`);
    assert.match(r.text, /Ihre Rückmeldung konnte in diesem Browser nicht verschlüsselt werden\./);
    assert.equal(r.focused, 'parent-fallback');
    assert.equal(requests.length, before, 'keine Anfrage an den Briefkasten');
    // (kurz warten: ein Tipp an derselben Stelle direkt nach „Absenden“ zählt als Doppelklick und wird ignoriert)
    await delay(600);
    await page.tap(tid('parent-retry'));
    await page.locator('.parent-submit-card .alert-error', { hasText: 'Leider hat es wieder nicht geklappt' }).waitFor();
    assert.equal((await boxMessages(env.mb, mailbox)).length, 0);
    assert.deepEqual(realErrors(errors), []);
  } finally {
    await browser.close();
    await env.close();
  }
});

test('Eltern: Geschwisterkind mit Termin-Schlüssel neben einem QR-Link und neuer Briefkasten im Link', async () => {
  const env = await setup();
  const { browser, page, errors } = await launch(DESKTOP);
  try {
    // Frau Meier (QR-Link, Klasse 5a) und Herr Żak (nur Termin-Schlüssel, Klasse 7b), beide mit Briefkasten
    const meierBox = await createTeacherMailbox();
    const meier = sampleState({ mailbox: meierBox });
    const zak = { firstName: 'Łukasz', lastName: 'Żak', birthDate: '1987-06-24', email: 'lukasz.zak@schule.example' };
    const zakCode = teacherCode(zak.firstName, zak.lastName, zak.birthDate);
    const zakBox = await createTeacherMailbox();
    const zakState = sampleState({
      teacher: { ...zak, registrationCode: registrationCode(zak.firstName, zak.lastName, zak.birthDate), teacherCode: zakCode },
      event: { schoolAddress: 'Realschule Nord', slotMinutes: 15, days: [{ date: '2026-11-19', start: '15:00', end: '17:00' }] },
      mailbox: zakBox,
    });
    await page.goto(env.web.url);
    assert.equal(await page.evaluate((s) => import('./js/core/teacher-mailbox.js').then((m) => m.publishClassDirectory(s, '7b')), zakState), true);

    await page.goto(letterUrl(env.web, meier, '5a'));
    const mia = { firstName: 'Mia', lastName: 'Beck', code: studentCode(7, 'b', zakCode, 'Mia', 'Beck') };
    await fillLogin(page, mia);
    await page.click(tid('parent-login'));
    // Code gehört zu einem anderen Elternbrief: Das Feld für den Termin-Schlüssel erscheint
    await page.waitForSelector(tid('parent-key'));
    await page.fill(tid('parent-key'), encodeEventKey(zakState.event, { teacherCode: zakCode, classId: '7b' }));
    await page.click(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-19', '15:00'));
    assert.ok((await page.textContent('.parent-overview')).includes('Łukasz Żak'));
    assert.deepEqual((await parentState(page)).event.mailbox, { id: zakBox.id, publicKey: zakBox.publicKey });
    await page.click(slot('2026-11-19', '15:00'));
    await page.click(tid('parent-submit'));
    await page.locator(tid('parent-sent-ok'), { hasText: 'bei Łukasz Żak angekommen' }).waitFor();
    assert.equal((await boxMessages(env.mb, zakBox)).length, 1);
    assert.equal((await boxMessages(env.mb, meierBox)).length, 0);

    // Anna über den QR-Link senden, danach öffnen die Eltern einen neuen Elternbrief mit anderem Briefkasten
    // (gleiche Termine): Die Zeiten bleiben markiert, gelten aber als noch nicht abgesendet.
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto(`${env.web.url}#/`);
    await page.goto(letterUrl(env.web, meier, '5a'));
    await fillLogin(page, ANNA_BECK);
    await page.click(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    await page.click(slot('2026-11-12', '14:00'));
    await page.click(tid('parent-submit'));
    await page.locator(tid('parent-sent-ok')).waitFor();
    const newBox = await createTeacherMailbox();
    await page.goto(`${env.web.url}#/`);
    await page.goto(letterUrl(env.web, sampleState({ mailbox: newBox }), '5a'));
    await page.locator('.parent-loggedin').waitFor();
    assert.equal(await page.locator('.parent-loggedin .alert-success').count(), 0, 'nicht mehr als angekommen gemeldet');
    const s = await parentState(page);
    assert.equal(s.submittedAt, undefined);
    assert.deepEqual(s.selection['2026-11-12'], [840], 'Auswahl bleibt');
    await page.click(tid('parent-continue'));
    await page.click(tid('parent-submit'));
    await page.locator(tid('parent-sent-ok')).waitFor();
    assert.equal((await boxMessages(env.mb, newBox)).length, 1, 'neue Rückmeldung im neuen Briefkasten');
    assert.equal((await boxMessages(env.mb, meierBox)).length, 1);
    // Weder Geheimnis noch privater Schlüssel landen im Browser der Eltern
    const everything = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.documentElement.outerHTML);
    for (const box of [meierBox, zakBox, newBox]) {
      assert.ok(!everything.includes(box.secret), 'kein Geheimnis');
      assert.ok(!everything.includes(box.privateKey.d), 'kein privater Schlüssel');
    }
    assert.deepEqual(realErrors(errors), []);
  } finally {
    await browser.close();
    await env.close();
  }
});
