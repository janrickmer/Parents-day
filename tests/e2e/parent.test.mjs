// Browser-Test: Elternzugang – Anmeldung per Elternbrief-Link bzw. Termin-Schlüssel, freie Zeiten
// markieren (Tippen und Ziehen), Absenden mit Rückmelde-PDF und vorbereiteter E-Mail.
// Optional Bildschirmfotos zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/parent.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, launch, captureDownload, pdfPayload, pdfPageCount, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { encodeEventKey, decodeEventKey, findResponsesInText } from '../../js/core/transport.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const ANNA_BECK = { firstName: 'Anna', lastName: 'Beck', code: '5aA16595316960M11414125311' };
const PDF_NAME = 'ParentsDay Rückmeldung 5a Beck Anna.pdf';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.close();
});

const tid = (id) => `[data-testid="${id}"]`;
const slot = (date, time) => tid(`slot-${date}-${time}`);

async function shot(page, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' });
}

async function waitForHash(page, hash) {
  await page.waitForFunction((expected) => location.hash === expected, hash);
}

async function assertNoHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `${label}: Seite ist ${overflow}px breiter als der Bildschirm`);
}

async function pressed(page, selector) {
  return (await page.getAttribute(selector, 'aria-pressed')) === 'true';
}

/** Elternbrief-Link wie im QR-Code, aber auf den lokalen Testserver umgeschrieben. */
async function letterUrl(page, state, classId) {
  await page.goto(server.url);
  const link = await page.evaluate(([s, c]) => import('./js/core/transport.js').then((m) => m.eventLink(s, c)), [state, classId]);
  assert.match(link, /#\/eltern\?e=/);
  return server.url + link.slice(link.indexOf('#'));
}

async function fillLogin(page, { firstName, lastName, code }) {
  await page.fill(tid('parent-firstname'), firstName);
  await page.fill(tid('parent-lastname'), lastName);
  await page.fill(tid('parent-code'), code);
}

async function parentState(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('parentsday.parent') || 'null'));
}

function decodedMailto(href) {
  const [recipient, query] = href.replace(/^mailto:/, '').split('?');
  const params = Object.fromEntries(query.split('&').map((p) => p.split('=')).map(([k, v]) => [k, decodeURIComponent(v)]));
  return { recipient, ...params };
}

test('Eltern (Smartphone): Link aus dem Elternbrief → Anmeldung → Zeiten markieren → Absenden → E-Mail', async () => {
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const url = await letterUrl(page, sampleState(), '5a');
    await page.goto(url);
    await page.waitForSelector(tid('parent-firstname'));
    // Adresse wird bereinigt, Termindaten stehen im Infokasten
    await waitForHash(page, '#/eltern');
    const eventText = await page.textContent('.parent-event');
    assert.match(eventText, /Elternsprechtag bei Anna Meier/);
    assert.match(eventText, /Klasse 5a/);
    assert.match(eventText, /Gesamtschule Süd/);
    assert.equal(await page.locator(tid('parent-key')).count(), 0, 'Mit Link wird kein Termin-Schlüssel benötigt');
    for (const [id, attr, value] of [
      ['parent-code', 'autocapitalize', 'off'],
      ['parent-code', 'spellcheck', 'false'],
      ['parent-code', 'autocomplete', 'off'],
    ]) {
      assert.equal(await page.getAttribute(tid(id), attr), value, `${id} ${attr}`);
    }
    // Beschriftungen sind mit den Feldern verknüpft
    assert.equal(await page.locator('label[for="parent-firstname"]').textContent(), 'Vorname des Kindes');
    assert.equal(await page.locator('label[for="parent-lastname"]').textContent(), 'Nachname des Kindes');
    assert.equal(await page.locator('label[for="parent-code"]').textContent(), 'Code');
    await assertNoHorizontalScroll(page, 'Anmeldung');
    await shot(page, 'mobil-1-anmeldung');

    // Leeres Formular und falscher Code → verständliche Fehler
    await page.tap(tid('parent-login'));
    await page.locator('.parent-login-error .alert-error').waitFor();
    assert.match(await page.textContent('.parent-login-error'), /Vor- und Nachnamen/);
    await fillLogin(page, { ...ANNA_BECK, code: '5aA16595316960M11414125312' });
    await page.tap(tid('parent-login'));
    await page.locator('.parent-login-error', { hasText: 'Name und Code passen nicht' }).waitFor();
    assert.equal(await page.getAttribute(tid('parent-code'), 'aria-invalid'), 'true');
    await fillLogin(page, { ...ANNA_BECK, code: '5aB16595316960M11414125311' });
    await page.tap(tid('parent-login'));
    await page.locator('.parent-login-error', { hasText: 'anderen Elternbrief' }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#/eltern');
    // Code aus einem anderen Elternbrief: der Termin-Schlüssel kann jetzt eingegeben werden
    assert.equal(await page.locator(tid('parent-key')).count(), 1);
    await shot(page, 'mobil-2-anmeldung-fehler');

    // Richtiger Code (mit Leerzeichen und in Kleinbuchstaben getippt) → Zeiten
    await fillLogin(page, { firstName: ' Anna ', lastName: 'Beck', code: '5aa16595316960m 11414125311' });
    await page.tap(tid('parent-login'));
    await waitForHash(page, '#/eltern/zeiten');
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    const stored = await parentState(page);
    assert.deepEqual(stored.login, { firstName: 'Anna', lastName: 'Beck', code: ANNA_BECK.code });

    // Übersicht ist bereits ausgefüllt
    assert.match(await page.textContent('h1'), /Ihre freien Zeiten/);
    const overview = await page.textContent('.parent-overview');
    for (const text of ['Anna Beck', '5a', 'Anna Meier', 'Gesamtschule Süd', 'Donnerstag, 12. November 2026 – von 14:00 bis 18:00 Uhr', 'Freitag, 13. November 2026 – von 15:00 bis 17:00 Uhr', '10 Minuten']) {
      assert.ok(overview.includes(text), `Übersicht enthält „${text}“`);
    }
    assert.match(await page.textContent('.alert-info'), /alle Zeitslots grün/);
    assert.equal(await page.locator(`[data-testid^="slot-2026-11-12-"]`).count(), 24);
    assert.equal(await page.locator(`[data-testid^="slot-2026-11-13-"]`).count(), 12);
    assert.equal((await page.textContent(slot('2026-11-12', '14:00'))).trim(), '14:00–14:10');
    assert.equal(await page.isDisabled(tid('parent-submit')), true, 'Absenden ist ohne Auswahl gesperrt');
    assert.match(await page.textContent('#parent-submit-hint'), /mindestens einen Zeitslot/);
    await assertNoHorizontalScroll(page, 'Zeiten');
    await shot(page, 'mobil-3-zeiten-leer');

    // Zwei getrennte Zeiträume antippen: 14:00–14:30 und 15:00–15:20
    for (const t of ['14:00', '14:10', '14:20', '15:00', '15:10']) await page.tap(slot('2026-11-12', t));
    assert.equal(await pressed(page, slot('2026-11-12', '14:10')), true);
    assert.equal(await pressed(page, slot('2026-11-12', '14:30')), false);
    const summary = tid('day-summary-2026-11-12');
    assert.equal(await page.textContent(summary), 'Ihre Zeiträume: 14:00–14:30, 15:00–15:20 Uhr');
    assert.equal(await page.textContent(tid('day-summary-2026-11-13')), 'Noch keine Zeiten markiert');
    // Nochmal tippen hebt die Markierung auf
    await page.tap(slot('2026-11-12', '14:10'));
    assert.equal(await pressed(page, slot('2026-11-12', '14:10')), false);
    assert.equal(await page.textContent(summary), 'Ihre Zeiträume: 14:00–14:10, 14:20–14:30, 15:00–15:20 Uhr');
    await page.tap(slot('2026-11-12', '14:10'));
    assert.equal(await page.isDisabled(tid('parent-submit')), false);
    await shot(page, 'mobil-4-zeiten-markiert');

    // Neu laden behält die Auswahl
    await page.reload();
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    for (const t of ['14:00', '14:10', '14:20', '15:00', '15:10']) assert.equal(await pressed(page, slot('2026-11-12', t)), true, `${t} nach dem Neuladen markiert`);
    assert.equal(await pressed(page, slot('2026-11-12', '14:30')), false);
    assert.equal(await page.textContent(summary), 'Ihre Zeiträume: 14:00–14:30, 15:00–15:20 Uhr');

    // Absenden → PDF mit eingebetteten Daten
    const download = await captureDownload(page, () => page.tap(tid('parent-submit')));
    assert.equal(download.filename, PDF_NAME);
    assert.equal(download.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(pdfPageCount(download.buffer), 1);
    const payload = pdfPayload(download.buffer);
    assert.equal(payload.type, 'parent-response');
    assert.equal(payload.code, ANNA_BECK.code);
    assert.equal(payload.classId, '5a');
    assert.equal(payload.teacherCode, SAMPLE_TEACHER.teacherCode);
    assert.equal(payload.slotMinutes, 10);
    assert.deepEqual(payload.availability, {
      '2026-11-12': [
        ['14:00', '14:30'],
        ['15:00', '15:20'],
      ],
      '2026-11-13': [],
    });

    // Fertig-Seite mit vorbereiteter E-Mail
    await waitForHash(page, '#/eltern/fertig');
    await page.waitForSelector(tid('parent-mailto'));
    assert.match(await page.textContent('h1'), /Fast geschafft/);
    assert.ok((await page.textContent('.parent-steps')).includes(`„${PDF_NAME}“ wurde heruntergeladen`));
    assert.ok((await page.textContent('.parent-steps')).includes(SAMPLE_TEACHER.email));
    const href = await page.getAttribute(tid('parent-mailto'), 'href');
    assert.ok(href.startsWith(`mailto:${SAMPLE_TEACHER.email}?subject=`), href.slice(0, 80));
    assert.ok(href.includes('%0D%0A'), 'Zeilenumbrüche als %0D%0A');
    const mail = decodedMailto(href);
    assert.equal(mail.subject, 'ParentsDay – Rückmeldung für Anna Beck (Klasse 5a)');
    assert.match(mail.body, /Guten Tag Anna Meier,/);
    assert.match(mail.body, /Donnerstag, 12\.11\.2026: 14:00–14:30, 15:00–15:20 Uhr/);
    assert.match(mail.body, /Freitag, 13\.11\.2026: keine Zeit/);
    assert.ok(mail.body.includes('PARENTSDAY['));
    const fromMail = findResponsesInText(mail.body);
    assert.equal(fromMail.length, 1);
    assert.deepEqual(fromMail[0].availability, payload.availability);
    assert.equal(fromMail[0].submittedAt, payload.submittedAt);
    assert.equal(await page.locator(tid('parent-teacher-email')).count(), 0, 'E-Mail-Adresse ist aus dem Link bekannt');
    await assertNoHorizontalScroll(page, 'Fertig');
    await shot(page, 'mobil-5-fertig');
    // Der wichtigste Knopf ist am Smartphone ohne Scrollen zu sehen
    const mailBox = await page.locator(tid('parent-mailto')).boundingBox();
    assert.ok(mailBox.y + mailBox.height <= 844, `E-Mail-Knopf endet bei ${Math.round(mailBox.y + mailBox.height)}px (Bildschirm 844px)`);
    assert.ok(href.length <= 2000, `mailto-Link ist ${href.length} Zeichen lang`);

    // PDF erneut herunterladen: gleiche Daten
    const again = await captureDownload(page, () => page.tap(tid('parent-download')));
    assert.equal(again.filename, PDF_NAME);
    assert.deepEqual(pdfPayload(again.buffer), payload);

    // Zurück zur Anmeldung: angemeldet bleiben; Link einer anderen Klasse meldet ab
    await page.goto(`${server.url}#/eltern`);
    await page.locator('.parent-loggedin', { hasText: 'Angemeldet für Anna Beck' }).waitFor();
    await shot(page, 'mobil-6-angemeldet');
    // „Anderes Kind / abmelden“ fragt nach, solange Zeiten gespeichert sind
    await page.tap(tid('parent-switch'));
    await page.locator('.modal', { hasText: 'Anna Beck' }).getByRole('button', { name: 'Zurück' }).tap();
    assert.equal((await parentState(page)).login.code, ANNA_BECK.code, 'Abbrechen lässt die Anmeldung bestehen');
    await page.goto(await letterUrl(page, sampleState(), '5b'));
    await page.waitForSelector(tid('parent-firstname'));
    assert.match(await page.textContent('.parent-event'), /Klasse 5b/);
    const afterSwitch = await parentState(page);
    assert.equal(afterSwitch.login, null);
    assert.deepEqual(afterSwitch.selection, {});
    assert.equal(afterSwitch.lastPayload, undefined);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Eltern (Desktop): ohne Link mit Termin-Schlüssel anmelden, Ziehen mit der Maus, Teilen, E-Mail-Adresse eintippen', async () => {
  const { browser, context, page, errors } = await launch();
  // Web Share API nachbilden (headless Chromium kann keine Dateien teilen)
  await context.addInitScript(() => {
    navigator.canShare = (data) => Array.isArray(data?.files);
    navigator.share = async (data) => {
      window.__shared = data.files.map((f) => ({ name: f.name, type: f.type, size: f.size }));
    };
  });
  try {
    const owner = { teacherCode: SAMPLE_TEACHER.teacherCode, classId: '5a' };
    const key = encodeEventKey(sampleState().event, owner);
    assert.ok(key.length > 0);
    await page.goto(`${server.url}#/eltern`);
    await page.waitForSelector(tid('parent-key'));
    assert.equal(await page.locator('.parent-event').count(), 0);
    assert.match(await page.textContent('.parent-login'), /QR-Code/);
    assert.match(await page.textContent('#parent-key-hint'), /Ohne QR-Code: Termin-Schlüssel/);
    await shot(page, 'desktop-1-anmeldung-schluessel');

    // Tippfehler im Schlüssel
    await fillLogin(page, ANNA_BECK);
    const raw = key.replace(/-/g, '');
    const wrongKey = raw.slice(0, 6) + (raw[6] === '7' ? '8' : '7') + raw.slice(7);
    assert.throws(() => decodeEventKey(wrongKey, owner));
    await page.fill(tid('parent-key'), wrongKey);
    await page.click(tid('parent-login'));
    await page.locator('.parent-login-error', { hasText: 'Termin-Schlüssel und Code passen nicht zusammen' }).waitFor();
    assert.equal(await page.getAttribute(tid('parent-key'), 'aria-invalid'), 'true');
    // Zu kurzer Schlüssel
    await page.fill(tid('parent-key'), raw.slice(0, 8));
    await page.click(tid('parent-login'));
    await page.locator('.parent-login-error', { hasText: 'Termin-Schlüssel ist ungültig' }).waitFor();

    // Richtiger Schlüssel (klein geschrieben, ohne Bindestriche)
    await page.fill(tid('parent-key'), key.replace(/-/g, '').toLowerCase());
    await page.click(tid('parent-login'));
    await waitForHash(page, '#/eltern/zeiten');
    await page.waitForSelector(slot('2026-11-13', '15:00'));
    const overview = await page.textContent('.parent-overview');
    assert.ok(overview.includes('Donnerstag, 12. November 2026 – von 14:00 bis 18:00 Uhr'));
    assert.ok(overview.includes('Freitag, 13. November 2026 – von 15:00 bis 17:00 Uhr'));
    assert.ok(!overview.includes('Lehrkraft'), 'Mit Schlüssel ist die Lehrkraft unbekannt');
    const stored = await parentState(page);
    assert.equal(stored.event.source, 'key');
    assert.equal(stored.event.classId, '5a');
    assert.equal(stored.event.teacherCode, SAMPLE_TEACHER.teacherCode);

    // Ziehen mit gedrückter Maustaste markiert fortlaufend (15:00–15:30) …
    const box = async (sel) => {
      const b = await page.locator(sel).boundingBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    await page.locator(tid('day-summary-2026-11-13')).scrollIntoViewIfNeeded();
    const a = await box(slot('2026-11-13', '15:00'));
    const c = await box(slot('2026-11-13', '15:20'));
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + c.x) / 2, a.y, { steps: 4 });
    await page.mouse.move(c.x, c.y, { steps: 4 });
    await page.mouse.up();
    for (const t of ['15:00', '15:10', '15:20']) assert.equal(await pressed(page, slot('2026-11-13', t)), true, `${t} per Ziehen markiert`);
    assert.equal(await pressed(page, slot('2026-11-13', '15:30')), false);
    assert.equal(await page.textContent(tid('day-summary-2026-11-13')), 'Ihre Zeiträume: 15:00–15:30 Uhr');
    // … und entfernt fortlaufend, wenn der erste Slot schon markiert war
    const b10 = await box(slot('2026-11-13', '15:10'));
    await page.mouse.move(b10.x, b10.y);
    await page.mouse.down();
    await page.mouse.move(c.x, c.y, { steps: 4 });
    await page.mouse.up();
    assert.equal(await page.textContent(tid('day-summary-2026-11-13')), 'Ihre Zeiträume: 15:00–15:10 Uhr');
    // Einfacher Klick schaltet genau einmal um
    await page.click(slot('2026-11-13', '16:50'));
    assert.equal(await pressed(page, slot('2026-11-13', '16:50')), true);
    // Tastatur: Leertaste schaltet um
    await page.focus(slot('2026-11-13', '16:40'));
    await page.keyboard.press('Space');
    assert.equal(await pressed(page, slot('2026-11-13', '16:40')), true);
    assert.equal(await page.textContent(tid('day-summary-2026-11-13')), 'Ihre Zeiträume: 15:00–15:10, 16:40–17:00 Uhr');

    // Schnelles Ziehen über zwei Rasterzeilen füllt den ganzen Bereich ohne Lücken (14:00 bis 15:10)
    await page.locator(slot('2026-11-12', '14:00')).scrollIntoViewIfNeeded();
    const f1 = await box(slot('2026-11-12', '14:00'));
    const f2 = await box(slot('2026-11-12', '15:10'));
    await page.mouse.move(f1.x, f1.y);
    await page.mouse.down();
    await page.mouse.move(f2.x, f2.y);
    await page.mouse.up();
    assert.equal(await page.textContent(tid('day-summary-2026-11-12')), 'Ihre Zeiträume: 14:00–15:20 Uhr');
    assert.equal(await page.locator('[data-testid^="slot-2026-11-12-"][aria-pressed="true"]').count(), 8);

    // Ganzen Tag markieren / Auswahl löschen
    const day1 =page.locator('.parent-day', { has: page.locator(slot('2026-11-12', '14:00')) });
    await day1.getByRole('button', { name: 'Ganzen Tag markieren' }).click();
    assert.equal(await page.locator('[data-testid^="slot-2026-11-12-"][aria-pressed="true"]').count(), 24);
    assert.equal(await page.textContent(tid('day-summary-2026-11-12')), 'Ihre Zeiträume: 14:00–18:00 Uhr');
    await shot(page, 'desktop-2-zeiten');
    await day1.getByRole('button', { name: 'Auswahl löschen' }).click();
    assert.equal(await page.locator('[data-testid^="slot-2026-11-12-"][aria-pressed="true"]').count(), 0);
    assert.equal(await page.textContent(tid('day-summary-2026-11-12')), 'Noch keine Zeiten markiert');

    const download = await captureDownload(page, () => page.click(tid('parent-submit')));
    assert.equal(download.filename, PDF_NAME);
    const payload = pdfPayload(download.buffer);
    assert.equal(payload.classId, '5a');
    assert.equal(payload.teacherCode, SAMPLE_TEACHER.teacherCode);
    assert.deepEqual(payload.availability, {
      '2026-11-12': [],
      '2026-11-13': [
        ['15:00', '15:10'],
        ['16:40', '17:00'],
      ],
    });

    // Fertig-Seite: E-Mail-Adresse ist unbekannt und wird eingetippt
    await waitForHash(page, '#/eltern/fertig');
    await page.waitForSelector(tid('parent-teacher-email'));
    assert.ok((await page.getAttribute(tid('parent-mailto'), 'href')).startsWith('mailto:?subject='));
    await page.locator(tid('parent-teacher-email')).pressSequentially('lehrer@example.org');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'parent-teacher-email', 'Fokus bleibt beim Tippen im Feld');
    const href = await page.getAttribute(tid('parent-mailto'), 'href');
    assert.ok(href.startsWith('mailto:lehrer@example.org?subject='));
    const mail = decodedMailto(href);
    assert.match(mail.body, /^\(Bitte hängen Sie/);
    assert.match(mail.body, /Guten Tag,/);
    assert.equal(findResponsesInText(mail.body)[0].code, ANNA_BECK.code);

    // Teilen übergibt die PDF-Datei
    await page.waitForSelector(tid('parent-share'));
    await page.click(tid('parent-share'));
    await page.waitForFunction(() => window.__shared);
    const shared = await page.evaluate(() => window.__shared);
    assert.equal(shared.length, 1);
    assert.equal(shared[0].name, PDF_NAME);
    assert.equal(shared[0].type, 'application/pdf');
    assert.ok(shared[0].size > 1000);
    await assertNoHorizontalScroll(page, 'Fertig');
    await shot(page, 'desktop-3-fertig');

    // Neu laden: eingetippte Adresse bleibt erhalten
    await page.reload();
    await page.waitForSelector(tid('parent-teacher-email'));
    assert.equal(await page.inputValue(tid('parent-teacher-email')), 'lehrer@example.org');

    // „Beenden und ausloggen“ löscht alles
    assert.equal((await page.textContent(tid('parent-logout'))).trim(), 'Beenden und ausloggen');
    await page.click(tid('parent-logout'));
    await page.locator('.modal').getByRole('button', { name: 'Ja, ausloggen' }).click();
    await waitForHash(page, '#/');
    assert.equal(await parentState(page), null);

    // Ohne Anmeldung führen Zeiten und Fertig-Seite zur Anmeldung
    await page.goto(`${server.url}#/eltern/zeiten`);
    await waitForHash(page, '#/eltern');
    await page.waitForSelector(tid('parent-key'));
    await page.goto(`${server.url}#/eltern/fertig`);
    await waitForHash(page, '#/eltern');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Eltern: beschädigter Link zeigt eine verständliche Meldung und den Termin-Schlüssel', async () => {
  const { browser, page, errors } = await launch(MOBILE);
  try {
    await page.goto(`${server.url}#/eltern?e=kaputt`);
    await page.locator('.alert-error', { hasText: 'Link aus dem Elternbrief' }).waitFor();
    await page.waitForSelector(tid('parent-key'));
    await waitForHash(page, '#/eltern');
    await assertNoHorizontalScroll(page, 'Fehler');

    // Veränderte Links: gültiges Base64, aber unbrauchbare Termindaten → dieselbe verständliche Meldung
    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    for (const bad of [
      { v: 1, d: [5, 'x'] },
      { v: 1, s: 10, d: [['kaputt', 'aa', 'bb']] },
      { v: 1, s: 10, d: [['2026-02-30', '14:00', '18:00']] },
      { v: 1, s: 10, d: [['2026-11-12', '18:00', '14:00']] },
      { v: 1, s: -5, d: [['2026-11-12', '14:00', '18:00']] },
      { v: 1, s: 7.5, d: [['2026-11-12', '14:00', '18:00']] },
    ]) {
      await page.goto(`${server.url}#/`);
      await page.goto(`${server.url}#/eltern?e=${encode(bad)}`);
      const alert = page.locator('.alert-error');
      await alert.waitFor();
      assert.match(await alert.textContent(), /Der Link aus dem Elternbrief ist unvollständig oder beschädigt\./, JSON.stringify(bad));
      assert.doesNotMatch(await page.textContent('main'), /undefined|NaN|iterable/, JSON.stringify(bad));
      assert.equal(await page.locator(tid('parent-key')).count(), 1, 'Ohne gültige Termindaten wird der Termin-Schlüssel abgefragt');
      assert.equal((await parentState(page))?.event ?? null, null);
    }

    // Von Hand verdorbener Speicher: Zeiten-Seite führt zur Anmeldung statt „NaN“ anzuzeigen
    await page.evaluate(() =>
      localStorage.setItem(
        'parentsday.parent',
        JSON.stringify({ event: { slotMinutes: 10, days: [{ date: 'x', start: 'y', end: 'z' }] }, login: { firstName: 'Anna', lastName: 'Beck', code: '5aA16595316960M11414125311' }, selection: null }),
      ),
    );
    await page.goto(`${server.url}#/eltern/zeiten`);
    await waitForHash(page, '#/eltern');
    await page.waitForSelector(tid('parent-key'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Eltern (Smartphone): lange Namen mit Umlauten, 5-Minuten-Raster, sechs Tage, Doppeltippen, Änderung nach dem Absenden', async () => {
  const { browser, page, errors } = await launch(MOBILE);
  const child = {
    firstName: 'Çağla-Sophie Maximiliane',
    lastName: 'Łukasiewicz-Øster von Hohenzollern-Sigmaringen',
    code: '10cA16595316960M3171211915168951312491391291145122111119952393261551920518221514815851426151212518141997131189147514',
  };
  const state = sampleState({
    teacher: {
      ...SAMPLE_TEACHER,
      firstName: 'Maximiliane-Theresia',
      lastName: 'von Hohenzollern-Sigmaringen-Wittgenstein',
      email: 'maximiliane-theresia.von-hohenzollern@gesamtschule-musterstadt-sued.example',
    },
    event: {
      schoolAddress: 'Städtische Gesamtschule Süd – Europaschule\nSchulstraße 1–3\nGebäude B, 2. OG\n12345 Musterstadt-Oberdorf',
      slotMinutes: 5,
      days: [
        { date: '2026-11-12', start: '08:00', end: '20:00' },
        { date: '2026-11-13', start: '14:00', end: '18:00' },
        { date: '2026-11-16', start: '15:00', end: '17:00' },
        { date: '2026-11-17', start: '15:00', end: '17:00' },
        { date: '2026-11-18', start: '15:00', end: '17:00' },
        { date: '2026-11-19', start: '15:00', end: '17:00' },
      ],
    },
  });
  try {
    await page.goto(await letterUrl(page, state, '10c'));
    await page.waitForSelector(tid('parent-firstname'));
    await fillLogin(page, child);
    await assertNoHorizontalScroll(page, 'Anmeldung (lange Namen)');
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '08:00'));
    assert.equal(await page.locator('[data-testid^="slot-2026-11-12-"]').count(), 144);
    assert.equal((await page.textContent(slot('2026-11-12', '19:55'))).trim(), '19:55–20:00');

    // Jeden zweiten Slot des ersten Tages antippen (viele getrennte Zeiträume), andere Tage ganz
    const expected = [];
    for (let m = 8 * 60; m < 20 * 60; m += 10) {
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      await page.tap(slot('2026-11-12', t));
      const e = m + 5;
      expected.push([t, `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`]);
    }
    for (const d of ['2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']) {
      await page.locator('.parent-day', { has: page.locator(tid(`day-summary-${d}`)) }).getByRole('button', { name: 'Ganzen Tag markieren' }).tap();
    }
    await assertNoHorizontalScroll(page, 'Zeiten (lange Namen)');
    await shot(page, 'mobil-7-zeiten-lang');

    // Doppeltippen auf „Absenden“ erzeugt genau einen Download
    let downloads = 0;
    page.on('download', () => downloads++);
    const download = await captureDownload(page, () => page.dblclick(tid('parent-submit')));
    await waitForHash(page, '#/eltern/fertig');
    await page.waitForSelector(tid('parent-mailto'));
    await page.waitForTimeout(300);
    assert.equal(downloads, 1, 'nur ein Download');
    assert.equal(download.filename, `ParentsDay Rückmeldung 10c ${child.lastName} ${child.firstName}.pdf`);
    assert.equal(pdfPageCount(download.buffer), 2);
    const payload = pdfPayload(download.buffer);
    assert.equal(payload.code, child.code);
    assert.equal(payload.firstName, child.firstName);
    assert.equal(payload.lastName, child.lastName);
    assert.equal(payload.slotMinutes, 5);
    assert.deepEqual(payload.availability['2026-11-12'], expected);
    assert.deepEqual(payload.availability['2026-11-19'], [['15:00', '17:00']]);

    // Sehr viele Zeiträume: der E-Mail-Text lässt die Liste je Tag weg (steht in PDF und Datenblock),
    // der Datenblock ist aber vollständig
    const href = await page.getAttribute(tid('parent-mailto'), 'href');
    const mail = decodedMailto(href);
    assert.equal(mail.recipient, state.teacher.email);
    assert.equal(mail.subject, `ParentsDay – Rückmeldung für ${child.firstName} ${child.lastName} (Klasse 10c)`);
    assert.match(mail.body, /Alle Angaben finden Sie in der angehängten PDF-Datei/);
    assert.doesNotMatch(mail.body, /Donnerstag, 12\.11\.2026:/);
    assert.deepEqual(findResponsesInText(mail.body)[0].availability, payload.availability);
    await assertNoHorizontalScroll(page, 'Fertig (lange Namen)');
    await shot(page, 'mobil-8-fertig-lang');

    // Zeiten nach dem Absenden ändern → Hinweis auf der Fertig-Seite
    await page.tap('a.btn[href="#/eltern/zeiten"]');
    await page.waitForSelector(slot('2026-11-12', '08:00'));
    assert.match(await page.textContent('.alert-success'), /abgesendet/);
    await page.tap(slot('2026-11-12', '08:05'));
    await page.locator('.alert-success a[href="#/eltern/fertig"]').tap();
    await page.locator('.alert-warning', { hasText: 'nach dem Absenden geändert' }).waitFor();

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

// Zweite Lehrkraft für Geschwisterkinder: Bernd Schulz, 19.11. mit 15-Minuten-Raster
const SCHULZ = { firstName: 'Bernd', lastName: 'Schulz', birthDate: '1982-02-02', email: 'bernd.schulz@schule.example' };
async function schulzState(page) {
  if (!page.url().startsWith(server.url)) await page.goto(server.url);
  const codes = await page.evaluate((t) => import('./js/core/codes.js').then((m) => ({ registrationCode: m.registrationCode(t.firstName, t.lastName, t.birthDate), teacherCode: m.teacherCode(t.firstName, t.lastName, t.birthDate) })), SCHULZ);
  return sampleState({ teacher: { ...SCHULZ, ...codes }, event: { schoolAddress: 'Realschule Nord', slotMinutes: 15, days: [{ date: '2026-11-19', start: '15:00', end: '17:00' }] } });
}
function childCode(page, grade, letter, tCode, firstName, lastName) {
  return page.evaluate((a) => import('./js/core/codes.js').then((m) => m.studentCode(...a)), [grade, letter, tCode, firstName, lastName]);
}

test('Eltern: Geschwister in zwei Tabs – jede Rückmeldung geht an die richtige Lehrkraft', async () => {
  const { browser, context, page, errors } = await launch(MOBILE);
  try {
    const meier = sampleState();
    const schulz = await schulzState(page);
    const lena = { firstName: 'Lena', lastName: 'Beck', code: await childCode(page, 5, 'a', SAMPLE_TEACHER.teacherCode, 'Lena', 'Beck') };
    const tom = { firstName: 'Tom', lastName: 'Beck', code: await childCode(page, 7, 'b', schulz.teacher.teacherCode, 'Tom', 'Beck') };
    const meierUrl = await letterUrl(page, meier, '5a');
    const schulzUrl = await letterUrl(page, schulz, '7b');

    // Tab 1: Lena (Frau Meier)
    await page.goto(meierUrl);
    await fillLogin(page, lena);
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    await page.tap(slot('2026-11-12', '14:00'));

    // Tab 2: Tom (Herr Schulz), eigener QR-Code
    const tab2 = await context.newPage();
    tab2.on('pageerror', (err) => errors.push(`Tab 2: ${err.message}`));
    await tab2.goto(schulzUrl);
    await fillLogin(tab2, tom);
    await tab2.tap(tid('parent-login'));
    await tab2.waitForSelector(slot('2026-11-19', '15:00'));

    // Weiter in Tab 1: Lena absenden
    await page.tap(slot('2026-11-12', '14:10'));
    const dl = await captureDownload(page, () => page.tap(tid('parent-submit')));
    assert.equal(pdfPayload(dl.buffer).code, lena.code);
    await waitForHash(page, '#/eltern/fertig');
    const mail = decodedMailto(await page.getAttribute(tid('parent-mailto'), 'href'));
    assert.equal(mail.recipient, SAMPLE_TEACHER.email);
    assert.match(mail.subject, /Lena Beck \(Klasse 5a\)/);
    assert.match(mail.body, /Guten Tag Anna Meier,/);
    assert.match(mail.body, /Donnerstag, 12\.11\.2026: 14:00–14:20 Uhr/);
    assert.match(await page.textContent('main'), /Es fehlt nur noch die E-Mail an Anna Meier/);

    // Tab 2 nach dem Neuladen: Tom ist unverändert (nichts abgesendet, nichts markiert)
    await tab2.reload();
    await tab2.waitForSelector(slot('2026-11-19', '15:00'));
    assert.match(await tab2.textContent('.page-header'), /Tom Beck, Klasse 7b/);
    assert.equal(await tab2.locator('[aria-pressed="true"]').count(), 0);
    assert.equal(await tab2.locator('main .alert-success').count(), 0, 'Für Tom wurde nichts abgesendet');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Eltern mit Termin-Schlüssel: anderes Kind, andere Lehrkraft, Tippfehler im Lehrkräftecode, Ł statt L', async () => {
  const { browser, page, errors } = await launch();
  try {
    const meier = sampleState();
    const schulz = await schulzState(page);
    const meierKey = encodeEventKey(meier.event, { teacherCode: SAMPLE_TEACHER.teacherCode, classId: '5a' });
    const schulzKey = encodeEventKey(schulz.event, { teacherCode: schulz.teacher.teacherCode, classId: '7b' });
    const lena = { firstName: 'Lena', lastName: 'Beck', code: await childCode(page, 5, 'a', SAMPLE_TEACHER.teacherCode, 'Lena', 'Beck') };
    const tom = { firstName: 'Tom', lastName: 'Beck', code: await childCode(page, 7, 'b', schulz.teacher.teacherCode, 'Tom', 'Beck') };

    // Zahlendreher im Lehrkräftecode des Kindes: der Schlüssel passt nicht → verständliche Meldung
    await page.goto(`${server.url}#/eltern`);
    await page.waitForSelector(tid('parent-key'));
    await fillLogin(page, { ...lena, code: lena.code.replace('A16595316960M', 'A16595316690M') });
    await page.fill(tid('parent-key'), meierKey);
    await page.click(tid('parent-login'));
    await page.locator('.parent-login-error', { hasText: 'Termin-Schlüssel und Code passen nicht zusammen' }).waitFor();
    assert.match(await page.textContent('.parent-login-error'), /direkt nach „5a“/);
    assert.equal(await page.getAttribute(tid('parent-code'), 'aria-invalid'), 'true');

    // Richtig: Lena meldet sich an, sendet ab und trägt die Adresse von Frau Meier ein
    await fillLogin(page, lena);
    await page.click(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    await page.click(slot('2026-11-12', '14:00'));
    await captureDownload(page, () => page.click(tid('parent-submit')));
    await waitForHash(page, '#/eltern/fertig');
    await page.fill(tid('parent-teacher-email'), SAMPLE_TEACHER.email);

    // „Anderes Kind“: Tom gehört zu Herrn Schulz → Termin-Schlüssel wird wieder abgefragt
    await page.goto(`${server.url}#/eltern`);
    await page.click(tid('parent-switch'));
    await page.locator('.modal').getByRole('button', { name: 'Ja, abmelden' }).click();
    await page.waitForSelector(tid('parent-firstname'));
    assert.equal(await page.locator(tid('parent-key')).count(), 0, 'für ein Kind aus demselben Brief nicht nötig');
    await fillLogin(page, tom);
    await page.click(tid('parent-login'));
    await page.locator('.parent-login-error', { hasText: 'anderen Elternbrief' }).waitFor();
    assert.equal(await page.locator(tid('parent-key')).count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'parent-key');
    // Frau Meiers Schlüssel passt nicht zu Toms Code
    await page.fill(tid('parent-key'), meierKey);
    await page.click(tid('parent-login'));
    await page.locator('.parent-login-error', { hasText: 'passen nicht zusammen' }).waitFor();
    await page.fill(tid('parent-key'), schulzKey);
    await page.click(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-19', '15:00'));
    assert.equal(await page.locator('[data-testid^="slot-2026-11-12-"]').count(), 0, 'nicht die Tage von Frau Meier');
    await page.click(slot('2026-11-19', '15:15'));
    const dl = await captureDownload(page, () => page.click(tid('parent-submit')));
    const payload = pdfPayload(dl.buffer);
    assert.equal(payload.slotMinutes, 15);
    assert.deepEqual(Object.keys(payload.availability), ['2026-11-19']);
    await waitForHash(page, '#/eltern/fertig');
    // Die Adresse von Frau Meier wird nicht für Toms Lehrkraft vorgeschlagen
    assert.equal(await page.inputValue(tid('parent-teacher-email')), '');
    assert.ok((await page.getAttribute(tid('parent-mailto'), 'href')).startsWith('mailto:?subject='));

    // Lehrkraft mit „Ł“ und „Ż“: im Brief abgetippt als „L“ und „Z“
    const zak = { firstName: 'Łukasz', lastName: 'Żak', birthDate: '1987-06-24' };
    const zakCode = await page.evaluate((t) => import('./js/core/codes.js').then((m) => m.teacherCode(t.firstName, t.lastName, t.birthDate)), zak);
    const zakEvent = { slotMinutes: 10, days: [{ date: '2026-11-20', start: '14:00', end: '15:00' }] };
    const zakKey = encodeEventKey(zakEvent, { teacherCode: zakCode, classId: '7b' });
    const mia = await childCode(page, 7, 'b', zakCode, 'Mia', 'Beck');
    await page.goto(`${server.url}#/eltern`);
    await page.click(tid('parent-switch'));
    await page.locator('.modal').getByRole('button', { name: 'Ja, abmelden' }).click();
    await page.click(tid('parent-other-key'));
    await page.waitForSelector(tid('parent-key'));
    await fillLogin(page, { firstName: 'Mia', lastName: 'Beck', code: mia.replace('Ł', 'L').replace('Ż', 'Z') });
    await page.fill(tid('parent-key'), zakKey);
    await page.click(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-20', '14:00'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Eltern: Nach einem QR-Link lässt sich ein Geschwisterkind mit dem Termin-Schlüssel anmelden', async () => {
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const meier = sampleState();
    const schulz = await schulzState(page);
    const schulzKey = encodeEventKey(schulz.event, { teacherCode: schulz.teacher.teacherCode, classId: '7b' });
    const tom = { firstName: 'Tom', lastName: 'Beck', code: await childCode(page, 7, 'b', schulz.teacher.teacherCode, 'Tom', 'Beck') };
    await page.goto(await letterUrl(page, meier, '5a'));
    await fillLogin(page, ANNA_BECK);
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-12', '14:00'));
    // Wie im Brief beschrieben: Startseite → Zugang für Eltern → Anderes Kind
    await page.goto(`${server.url}#/`);
    await page.tap(tid('start-parent'));
    await page.tap(tid('parent-switch'));
    await page.waitForSelector(tid('parent-other-key'));
    await fillLogin(page, tom);
    await page.tap(tid('parent-login'));
    await page.locator('.parent-login-error', { hasText: 'anderen Elternbrief' }).waitFor();
    await page.fill(tid('parent-key'), schulzKey);
    await page.tap(tid('parent-login'));
    await page.waitForSelector(slot('2026-11-19', '15:00'));
    const stored = await parentState(page);
    assert.equal(stored.event.source, 'key');
    assert.equal(stored.event.classId, '7b');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Eltern: veränderter Link – keine zusätzlichen Empfänger, keine riesigen Termindaten', async () => {
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const base = { v: 1, n: 'Anna Meier', t: SAMPLE_TEACHER.teacherCode, a: 'Schule', s: 10, d: [['2026-11-12', '14:00', '15:00']], k: '5a' };
    // Zu viele Tage, 1-Minuten-Raster, doppelte Tage, Uhrzeiten außerhalb des 5-Minuten-Rasters
    for (const bad of [
      { ...base, d: Array.from({ length: 9 }, (_, i) => [`2026-11-${10 + i}`, '14:00', '15:00']) },
      { ...base, s: 1 },
      { ...base, s: 7 },
      { ...base, d: [['2026-11-12', '14:00', '15:00'], ['2026-11-12', '16:00', '17:00']] },
      { ...base, d: [['2026-11-12', '14:03', '15:00']] },
    ]) {
      await page.goto(`${server.url}#/`);
      await page.goto(`${server.url}#/eltern?e=${encode(bad)}`);
      await page.locator('.alert-error', { hasText: 'Der Link aus dem Elternbrief ist unvollständig oder beschädigt.' }).waitFor();
      assert.equal((await parentState(page))?.event ?? null, null);
    }

    // Zusätzlicher Empfänger im Link: Adresse wird verworfen, die Eltern tippen sie selbst ein
    for (const m of ['lehrer@schule.de,spion@evil.example', 'lehrer@schule.de%2Cspion@evil.example', 'lehrer@schule.de\r\nBcc:spion@evil.example']) {
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.goto(`${server.url}#/`);
      await page.goto(`${server.url}#/eltern?e=${encode({ ...base, m, n: 'x'.repeat(5000), a: 'Zeile\n'.repeat(50) })}`);
      await page.waitForSelector(tid('parent-firstname'));
      assert.ok((await page.textContent('.parent-event-title')).length < 250, 'Name gekürzt');
      await fillLogin(page, ANNA_BECK);
      await page.tap(tid('parent-login'));
      await page.tap(slot('2026-11-12', '14:00'));
      await captureDownload(page, () => page.tap(tid('parent-submit')));
      await waitForHash(page, '#/eltern/fertig');
      await page.waitForSelector(tid('parent-teacher-email'));
      assert.ok((await page.getAttribute(tid('parent-mailto'), 'href')).startsWith('mailto:?subject='), m);
      assert.doesNotMatch(await page.textContent('main'), /spion/);
    }
    // Auch eine formal gültige, aber kodierte Adresse ergibt nur einen Empfänger
    await page.fill(tid('parent-teacher-email'), 'spion%40evil.example%2Clehrer@schule.de');
    const href = await page.getAttribute(tid('parent-mailto'), 'href');
    const recipients = decodeURIComponent(href.slice(7, href.indexOf('?'))).split(/[,;]/);
    assert.deepEqual(recipients, ['spion%40evil.example%2Clehrer@schule.de']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Eltern: Schrift für das PDF nicht erreichbar → deutsche Meldung mit Hinweis auf die Internetverbindung', async () => {
  const { browser, page } = await launch(MOBILE);
  try {
    await page.route('**/fonts/**', (route) => route.abort('internetdisconnected'));
    await page.goto(await letterUrl(page, sampleState(), '5a'));
    await fillLogin(page, ANNA_BECK);
    await page.tap(tid('parent-login'));
    await page.tap(slot('2026-11-12', '14:00'));
    await page.tap(tid('parent-submit'));
    const alert = page.locator('.parent-submit-card .alert-error');
    await alert.waitFor();
    const text = await alert.textContent();
    assert.match(text, /Die PDF-Datei konnte nicht erstellt werden\. Die Schrift für PDFs konnte nicht geladen werden\. Bitte prüfen Sie Ihre Internetverbindung/);
    assert.doesNotMatch(text, /Failed to fetch/);
  } finally {
    await browser.close();
  }
});
