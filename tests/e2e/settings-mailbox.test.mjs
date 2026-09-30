// Browser-Tests: digitaler Briefkasten in „Weitere Einstellungen“, auf der Datenschutz- und der Startseite.
// Läuft gegen den echten Dienst (worker/briefkasten.js, lokal über mailbox-server.mjs): Karte nur mit
// Briefkasten-Adresse, „Verbindung prüfen“, „Briefkasten leeren“ (holt vorher neue Rückmeldungen ab und fragt
// nach, wenn Rückmeldungen zu keinem Kind passen), Dienst nicht erreichbar, „Alle Daten löschen“ (holt vorher
// ab, fragt bei neuen Rückmeldungen nach und leert den Briefkasten), Texte mit/ohne Briefkasten.
// Bildschirmfotos zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/settings-mailbox.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, launch, seedTeacher, sampleState, captureDownload, SAMPLE_TEACHER } from './helpers.mjs';
import { startMailboxServer } from './mailbox-server.mjs';
import { studentCode } from '../../js/core/codes.js';
import { buildResponsePayload } from '../../js/core/transport.js';
import { createTeacherMailbox, encryptForTeacher } from '../../js/core/mailbox.js';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const T_CODE = SAMPLE_TEACHER.teacherCode;
const tid = (id) => `[data-testid="${id}"]`;

const running = [];
after(async () => {
  for (const close of running) await close().catch(() => {});
});

/** Briefkasten-Dienst und Webserver, der die Seite mit diesem Briefkasten ausliefert. */
async function startWithMailbox() {
  const mb = await startMailboxServer();
  const web = await startServer({ mailboxUrl: mb.url });
  mb.env.ALLOWED_ORIGINS = new URL(web.url).origin;
  let mbClosed = false;
  const closeMailbox = async () => {
    if (mbClosed) return;
    mbClosed = true;
    await mb.close();
  };
  running.push(closeMailbox, () => web.close());
  return { mb, web, closeMailbox };
}

/** Konsolenfehler ohne die erwarteten Meldungen des Browsers, wenn der Briefkasten nicht erreichbar ist. */
function unexpected(errors) {
  return errors.filter((e) => !/Failed to load resource|net::ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(e));
}

async function shot(page, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Nur die Karte (bzw. ein Element) – übersichtlicher als die ganze Seite. */
async function shotOf(locator, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function kid(firstName, lastName) {
  return { id: `5a-${firstName}`, firstName, lastName, code: studentCode(5, 'a', T_CODE, firstName, lastName), response: null, appointment: null };
}

function stateWith(mailbox) {
  return sampleState({
    classes: [{ id: '5a', grade: 5, letter: 'a', codesGenerated: true, students: [kid('Anna', 'Beck'), kid('Ben', 'Klein')] }],
    ...(mailbox ? { mailbox } : {}),
  });
}

function responsePayload(firstName, lastName, submittedAt = '2026-10-01T10:00:00.000Z') {
  return buildResponsePayload({
    code: studentCode(5, 'a', T_CODE, firstName, lastName),
    firstName,
    lastName,
    classId: '5a',
    teacherCode: T_CODE,
    slotMinutes: 10,
    submittedAt,
    availability: { '2026-11-12': [['14:00', '15:00']] },
  });
}

/** Wirft eine Rückmeldung so in den Briefkasten, wie es der Browser der Eltern tut (verschlüsselt). */
async function drop(mb, ref, payload) {
  const res = await fetch(`${mb.url}/v1/boxes/${ref.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await encryptForTeacher(ref.publicKey, payload)),
  });
  assert.equal(res.status, 201, 'Rückmeldung eingeworfen');
}

const messageCount = (mb) => Number(mb.db.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);

function readState(page) {
  return page.evaluate((c) => JSON.parse(localStorage.getItem(`parentsday.teacher.${c}`)), T_CODE);
}

async function openSettings(page, web, state) {
  await seedTeacher(page, web.url, state);
  await page.goto(`${web.url}#/lehrkraft/einstellungen`);
  await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();
}

async function noHorizontalScroll(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `waagerechte Scrollleiste (${overflow}px)`);
}

const squash = (text) => text.replace(/\s+/g, ' ').trim();

test('Ohne Briefkasten-Adresse: keine Karte, bisherige Texte auf Start- und Datenschutzseite', async () => {
  const web = await startServer();
  running.push(() => web.close());
  const { browser, page, errors } = await launch();
  try {
    // Auch ein gespeicherter Briefkasten bleibt unsichtbar, solange kein Dienst eingerichtet ist.
    await openSettings(page, web, stateWith(await createTeacherMailbox()));
    await page.getByRole('heading', { name: 'Ihr Profil' }).waitFor();
    assert.equal(await page.locator(tid('mailbox-card')).count(), 0);
    assert.equal(await page.getByText('Digitaler Briefkasten').count(), 0);
    assert.equal(await page.locator('#evt-email-hint').innerText(), 'Steht im Elternbrief. An diese Adresse schicken die Eltern ihre Rückmeldung.');
    await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.doesNotMatch(await dialog.textContent(), /Briefkasten/);
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();

    await page.goto(`${web.url}#/datenschutz`);
    await page.getByRole('heading', { level: 1, name: 'Datenschutz-Hinweise' }).waitFor();
    const privacy = squash(await page.locator('main').innerText());
    assert.match(privacy, /Es gibt keinen Server, der Namen, Codes oder Termine speichert oder auswertet\./);
    assert.match(privacy, /ausschließlich über die PDF-Datei/);
    assert.doesNotMatch(privacy, /Briefkasten|Cloudflare/);
    assert.equal(await page.locator(tid('privacy-mailbox')).count(), 0);

    await page.goto(`${web.url}#/`);
    await page.locator(tid('start-teacher')).waitFor();
    const start = squash(await page.locator('main').innerText());
    assert.match(start, /Absenden Die erzeugte PDF-Datei per E-Mail an die Lehrkraft schicken\./);
    assert.match(start, /Rückmeldungen der Eltern hochladen/);
    assert.match(squash(await page.innerText(tid('start-privacy'))), /^ParentsDay speichert keine Daten auf einem Server\./);
    assert.doesNotMatch(start, /Briefkasten|automatisch bei der Lehrkraft/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Briefkasten noch nicht eingerichtet: Hinweis, dass er mit den Elternbriefen entsteht', async () => {
  const { web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    await openSettings(page, web, stateWith(null));
    const card = page.locator(tid('mailbox-card'));
    await card.waitFor();
    assert.equal(squash(await card.locator(tid('mailbox-pending')).innerText()), 'Wird automatisch eingerichtet, wenn Sie Elternbriefe erstellen.');
    assert.match(await card.innerText(), /Noch nicht eingerichtet/);
    // Klasse 5a hat schon Elternbriefe – ohne Briefkasten
    assert.match(squash(await card.innerText()), /Die Elternbriefe für die Klasse 5a enthalten noch keinen Briefkasten\./);
    assert.equal(await card.locator(tid('mailbox-check')).count(), 0);
    assert.equal(await card.locator(tid('mailbox-clear')).count(), 0);
    await shotOf(card, 'karte-noch-nicht-eingerichtet');
    // Ohne Briefkasten erwähnt „Alle Daten löschen“ ihn nicht
    await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.locator(tid('delete-all-mailbox-note')).count(), 0);
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Briefkasten aktiv: Verbindung prüfen, leeren (holt vorher neue Rückmeldungen ab), Dienst gestoppt', async () => {
  const { mb, web, closeMailbox } = await startWithMailbox();
  const box = await createTeacherMailbox();
  box.createdAt = '2026-09-14T08:30:00.000Z';
  const { browser, page, errors } = await launch();
  try {
    await openSettings(page, web, stateWith(box));
    const card = page.locator(tid('mailbox-card'));
    await card.waitFor();
    const text = squash(await card.innerText());
    assert.match(text, /Aktiv/);
    assert.equal(await card.locator(tid('mailbox-since')).innerText(), '14.09.2026');
    assert.equal(await card.locator(tid('mailbox-fetched')).innerText(), 'noch nie');
    assert.match(text, /Ende-zu-Ende-verschlüsselt/);
    assert.match(text, /Der Schlüssel dazu steckt in Ihrem Browser und in Ihrem Zwischenspeicher – ohne ihn sind die Rückmeldungen nicht lesbar\./);
    // Mit Briefkasten ist die E-Mail-Adresse nur noch die Notlösung
    assert.match(await page.locator('#evt-email-hint').innerText(), /Ist der digitale Briefkasten nicht erreichbar, schicken die Eltern ihre Rückmeldung an diese Adresse\./);
    // Geheimnis und privater Schlüssel stehen nirgends auf der Seite
    const html = await page.content();
    assert.ok(!html.includes(box.secret) && !html.includes(box.privateKey.d), 'kein Geheimnis im DOM');
    // Reihenfolge: nach dem Formular, vor Profil und Gefahrenbereich
    const order = await page.evaluate(() => {
      const idx = (el) => [...document.querySelectorAll('.evt-page *')].indexOf(el);
      return [idx(document.querySelector('.evt-form')), idx(document.querySelector('[data-testid="mailbox-card"]')), idx(document.querySelector('.evt-extra'))];
    });
    assert.ok(order[0] < order[1] && order[1] < order[2], `Reihenfolge ${order}`);

    // Verbindung prüfen (Antwort künstlich verzögert: Knopf zeigt, dass geprüft wird, und nimmt keinen zweiten Klick an)
    let healthCalls = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    await page.route('**/v1/health', async (route) => {
      healthCalls++;
      await gate;
      await route.continue();
    });
    await card.locator(tid('mailbox-check')).click();
    await card.getByRole('button', { name: 'Wird geprüft …' }).waitFor();
    assert.equal(await card.locator(tid('mailbox-check')).getAttribute('aria-disabled'), 'true');
    assert.equal(await card.locator(tid('mailbox-clear')).getAttribute('aria-disabled'), 'true');
    // force: Playwright wartet sonst, bis aria-disabled verschwindet
    await card.locator(tid('mailbox-check')).click({ force: true });
    await card.locator(tid('mailbox-clear')).click({ force: true });
    assert.equal(await page.getByRole('dialog').count(), 0, 'kein Dialog während der Prüfung');
    release();
    const status = card.locator(tid('mailbox-status'));
    await status.getByText('Verbindung in Ordnung.').waitFor();
    await page.unroute('**/v1/health');
    assert.equal(healthCalls, 1);
    assert.equal(await card.locator(tid('mailbox-check')).getAttribute('aria-disabled'), null);
    assert.match(await status.innerText(), /Der digitale Briefkasten ist erreichbar \(geprüft um \d\d:\d\d Uhr\)\./);
    await shot(page, 'einstellungen-desktop');
    await shotOf(card, 'karte-verbindung-ok');

    // Zwei Rückmeldungen einwerfen: eine passt zu Anna, eine gehört zu keinem Kind der Klasse
    await drop(mb, box, responsePayload('Anna', 'Beck'));
    await drop(mb, box, responsePayload('Zoe', 'Unbekannt'));
    assert.equal(messageCount(mb), 2);

    // Abbrechen lässt alles, wie es ist
    await card.locator(tid('mailbox-clear')).click();
    let dialog = page.getByRole('dialog', { name: 'Briefkasten leeren?' });
    await dialog.waitFor();
    const dialogText = squash(await dialog.innerText());
    assert.match(dialogText, /vom Server gelöscht/);
    assert.match(dialogText, /Zeiten, die bereits in ParentsDay übernommen wurden, bleiben erhalten\./);
    assert.match(dialogText, /Empfohlen nach dem Elternsprechtag\./);
    await shotOf(dialog, 'dialog-leeren');
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    assert.equal(messageCount(mb), 2);

    // Leeren: Annas Rückmeldung wird vorher übernommen. Zoes Rückmeldung passt zu keinem Kind – sie stünde
    // nach dem Leeren nirgends mehr, deshalb fragt ParentsDay nach. Abbrechen: nichts wird gelöscht.
    await card.locator(tid('mailbox-clear')).click();
    dialog = page.getByRole('dialog', { name: 'Briefkasten leeren?' });
    await dialog.getByRole('button', { name: 'Briefkasten leeren' }).click();
    let unmatched = page.getByRole('dialog', { name: 'Nicht zugeordnete Rückmeldungen löschen?' });
    await unmatched.waitFor();
    const unmatchedText = squash(await unmatched.innerText());
    assert.match(unmatchedText, /1 Rückmeldung im Briefkasten passt zu keinem Kind in ParentsDay/);
    assert.match(unmatchedText, /Zoe Unbekannt \(Klasse 5a\) – Kein Kind mit diesem Code in Klasse 5a/);
    assert.doesNotMatch(unmatchedText, /Anna/);
    await shotOf(unmatched, 'dialog-nicht-zugeordnet');
    await unmatched.getByRole('button', { name: 'Abbrechen' }).click();
    await status.getByText('Der Briefkasten wurde nicht geleert.').waitFor();
    assert.match(squash(await status.innerText()), /1 neue Rückmeldung wurde in ParentsDay übernommen\./);
    assert.equal(messageCount(mb), 2, 'nichts gelöscht');
    assert.equal(await card.locator(tid('mailbox-clear')).getAttribute('aria-disabled'), null);

    // Trotzdem leeren: danach ist die Datenbank des Dienstes leer
    await card.locator(tid('mailbox-clear')).click();
    await page.getByRole('dialog', { name: 'Briefkasten leeren?' }).getByRole('button', { name: 'Briefkasten leeren' }).click();
    unmatched = page.getByRole('dialog', { name: 'Nicht zugeordnete Rückmeldungen löschen?' });
    await unmatched.getByRole('button', { name: 'Trotzdem leeren' }).click();
    await status.getByText('Der Briefkasten wurde geleert.').waitFor();
    const cleared = squash(await status.innerText());
    assert.match(cleared, /2 Rückmeldungen wurden vom Server gelöscht\./);
    assert.doesNotMatch(cleared, /übernommen/, 'Anna war schon übernommen');
    assert.equal(messageCount(mb), 0);
    const saved = await readState(page);
    assert.deepEqual(saved.classes[0].students.find((s) => s.firstName === 'Anna').response.availability, { '2026-11-12': [['14:00', '15:00']] });
    assert.equal(saved.classes[0].students.find((s) => s.firstName === 'Ben').response, null);
    assert.ok(saved.mailbox.lastFetchedAt, 'Zeitpunkt des Abrufs gespeichert');
    assert.match(await card.locator(tid('mailbox-fetched')).innerText(), /^\d\d\.\d\d\.\d{4}, \d\d:\d\d Uhr$/);
    // Der Fokus bleibt am Knopf (für Tastaturnutzer)
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'mailbox-clear');
    await shotOf(card, 'karte-geleert');

    // Neue Rückmeldung, die passt: wird vorher übernommen, ohne Rückfrage
    await drop(mb, box, responsePayload('Ben', 'Klein'));
    await card.locator(tid('mailbox-clear')).click();
    await page.getByRole('dialog', { name: 'Briefkasten leeren?' }).getByRole('button', { name: 'Briefkasten leeren' }).click();
    await status.getByText('Der Briefkasten wurde geleert.').waitFor();
    assert.match(squash(await status.innerText()), /1 Rückmeldung wurde vom Server gelöscht\. Vorher wurde 1 neue Rückmeldung in ParentsDay übernommen\./);
    assert.ok((await readState(page)).classes[0].students.find((s) => s.firstName === 'Ben').response, 'Ben übernommen');
    assert.equal(messageCount(mb), 0);

    // Abruf klappt, Löschen auf dem Server scheitert: Meldung nennt trotzdem die übernommene Rückmeldung
    await drop(mb, box, responsePayload('Anna', 'Beck', '2026-10-02T09:00:00.000Z'));
    await page.route('**/v1/boxes/*/messages*', (route) => (route.request().method() === 'DELETE' ? route.abort() : route.continue()));
    await card.locator(tid('mailbox-clear')).click();
    await page.getByRole('dialog', { name: 'Briefkasten leeren?' }).getByRole('button', { name: 'Briefkasten leeren' }).click();
    await status.getByText('Der Briefkasten konnte nicht geleert werden.').waitFor();
    assert.match(squash(await status.innerText()), /nicht erreichbar.*1 neue Rückmeldung wurde in ParentsDay übernommen\./);
    assert.equal(messageCount(mb), 1);
    await page.unroute('**/v1/boxes/*/messages*');

    // Noch einmal leeren: Annas Rückmeldung ist schon übernommen und wird ohne Rückfrage gelöscht
    await card.locator(tid('mailbox-clear')).click();
    await page.getByRole('dialog', { name: 'Briefkasten leeren?' }).getByRole('button', { name: 'Briefkasten leeren' }).click();
    await status.getByText('1 Rückmeldung wurde vom Server gelöscht.').waitFor();
    assert.equal(messageCount(mb), 0);
    // Und noch einmal: nichts mehr darin
    await card.locator(tid('mailbox-clear')).click();
    await page.getByRole('dialog', { name: 'Briefkasten leeren?' }).getByRole('button', { name: 'Briefkasten leeren' }).click();
    await status.getByText('Es lagen keine Rückmeldungen darin.').waitFor();

    // Dienst gestoppt: verständliche Meldung statt technischer Fehler
    await closeMailbox();
    await card.locator(tid('mailbox-check')).click();
    await status.getByText('Verbindung fehlgeschlagen.').waitFor();
    const failed = squash(await status.innerText());
    assert.match(failed, /Der digitale Briefkasten ist gerade nicht erreichbar\. Bitte prüfen Sie die Internetverbindung\./);
    assert.match(failed, /per E-Mail/);
    assert.doesNotMatch(failed, /fetch|TypeError|undefined/i);
    assert.equal(await status.locator('[role="alert"]').count(), 1);
    assert.equal(await card.locator(tid('mailbox-check')).innerText(), 'Verbindung prüfen');
    await shotOf(card, 'karte-verbindung-fehlgeschlagen');

    await card.locator(tid('mailbox-clear')).click();
    await page.getByRole('dialog', { name: 'Briefkasten leeren?' }).getByRole('button', { name: 'Briefkasten leeren' }).click();
    await status.getByText('Der Briefkasten konnte nicht geleert werden.').waitFor();
    assert.match(squash(await status.innerText()), /nicht erreichbar/);
    assert.deepEqual(unexpected(errors), []);
  } finally {
    await browser.close();
  }
});

test('Alle Daten löschen: holt neue Rückmeldungen vorher ab, leert den Briefkasten – und klappt auch ohne Dienst', async () => {
  const { mb, web, closeMailbox } = await startWithMailbox();
  const box = await createTeacherMailbox();
  const { browser, page, errors } = await launch();
  try {
    // Eine Rückmeldung ist seit dem letzten Abruf neu: Sie stünde in keinem früher gespeicherten Zwischenstand.
    await drop(mb, box, responsePayload('Anna', 'Beck'));
    await openSettings(page, web, stateWith(box));
    await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
    let dialog = page.getByRole('dialog', { name: 'Alle Daten in diesem Browser löschen?' });
    await dialog.waitFor();
    assert.match(squash(await dialog.locator(tid('delete-all-mailbox-note')).innerText()), /Auch Ihr digitaler Briefkasten wird geleert.*Sind neue darunter, fragt ParentsDay vorher noch einmal nach\./);
    await shotOf(dialog, 'dialog-alle-daten');
    await dialog.getByRole('button', { name: 'Endgültig löschen' }).click();

    // Rückfrage mit der neuen Rückmeldung; der Zwischenstand von hier enthält sie
    const again = page.getByRole('dialog', { name: 'Neue Rückmeldungen eingegangen' });
    await again.waitFor();
    const againText = squash(await again.innerText());
    assert.match(againText, /Im digitalen Briefkasten lag noch 1 neue Rückmeldung\. Beim Löschen geht sie verloren:/);
    assert.match(againText, /Anna Beck \(Klasse 5a\)/);
    await shotOf(again, 'dialog-alle-daten-neue-rueckmeldungen');
    const backup = await captureDownload(page, () => again.getByRole('button', { name: 'Zwischenstand jetzt speichern' }).click());
    const backupState = JSON.parse(backup.buffer.toString('utf8'));
    assert.ok(backupState.classes[0].students.find((s) => s.firstName === 'Anna').response, 'Zwischenstand enthält die neue Rückmeldung');
    assert.ok(backupState.mailbox?.secret, 'Zwischenstand enthält den Schlüssel');
    // Abbrechen: nichts gelöscht, die Rückmeldung ist übernommen
    await again.getByRole('button', { name: 'Abbrechen' }).click();
    await page.getByText('Es wurde nichts gelöscht. Die neuen Rückmeldungen wurden in ParentsDay übernommen.').waitFor();
    assert.ok((await readState(page)).classes[0].students.find((s) => s.firstName === 'Anna').response);
    assert.equal(messageCount(mb), 1);
    const deleteBtn = page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' });
    assert.equal(await deleteBtn.getAttribute('aria-disabled'), null, 'Knopf wieder bedienbar');
    assert.equal(await page.locator(tid('mailbox-check')).getAttribute('aria-disabled'), null);

    // Noch einmal: nichts Neues mehr → keine Rückfrage, Briefkasten geleert, Daten gelöscht
    await deleteBtn.click();
    await page.getByRole('dialog', { name: 'Alle Daten in diesem Browser löschen?' }).getByRole('button', { name: 'Endgültig löschen' }).click();
    await page.waitForURL((url) => url.hash === '' || url.hash === '#/');
    assert.equal(await readState(page), null);
    assert.equal(messageCount(mb), 0, 'Briefkasten auf dem Server geleert');

    // Abruf klappt, Leeren auf dem Server scheitert: Daten im Browser werden trotzdem gelöscht, mit Hinweis
    const box2 = await createTeacherMailbox();
    const st2 = stateWith(box2);
    st2.classes[0].students[1].response = { submittedAt: '2026-10-01T10:00:00.000Z', availability: { '2026-11-12': [['14:00', '15:00']] } };
    await drop(mb, box2, responsePayload('Ben', 'Klein'));
    await openSettings(page, web, st2);
    await page.route('**/v1/boxes/*/messages*', (route) => (route.request().method() === 'DELETE' ? route.abort() : route.continue()));
    await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Endgültig löschen' }).click();
    await page.waitForURL((url) => url.hash === '' || url.hash === '#/');
    assert.equal(await readState(page), null);
    await page.getByText('Der digitale Briefkasten war nicht erreichbar und konnte nicht geleert werden.', { exact: false }).waitFor();
    assert.equal(messageCount(mb), 1);
    await page.unroute('**/v1/boxes/*/messages*');

    // Dienst nicht erreichbar: Daten im Browser werden trotzdem gelöscht, mit Hinweis
    const box3 = await createTeacherMailbox();
    await drop(mb, box3, responsePayload('Ben', 'Klein'));
    await closeMailbox();
    await openSettings(page, web, stateWith(box3));
    await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Endgültig löschen' }).click();
    await page.waitForURL((url) => url.hash === '' || url.hash === '#/');
    assert.equal(await readState(page), null);
    const warning = page.getByText('Der digitale Briefkasten war nicht erreichbar und konnte nicht geleert werden.', { exact: false });
    await warning.waitFor();
    assert.match(squash(await warning.innerText()), /Mit Ihrem Zwischenstand können Sie den Briefkasten später noch leeren\./);
    assert.equal(messageCount(mb), 2);
    assert.deepEqual(unexpected(errors), []);
  } finally {
    await browser.close();
  }
});

test('Alle Daten löschen: Rückmeldung ohne passendes Kind – Rückfrage ohne Zwischenstand-Knopf', async () => {
  const { mb, web } = await startWithMailbox();
  const box = await createTeacherMailbox();
  const { browser, page, errors } = await launch();
  try {
    await drop(mb, box, responsePayload('Zoe', 'Unbekannt'));
    await openSettings(page, web, stateWith(box));
    await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
    await page.getByRole('dialog', { name: 'Alle Daten in diesem Browser löschen?' }).getByRole('button', { name: 'Endgültig löschen' }).click();
    const again = page.getByRole('dialog', { name: 'Neue Rückmeldungen eingegangen' });
    await again.waitFor();
    const text = squash(await again.innerText());
    assert.match(text, /Zoe Unbekannt \(Klasse 5a\) – Kein Kind mit diesem Code in Klasse 5a/);
    assert.match(text, /Diese Rückmeldung passt zu keinem Kind in diesem Browser\. Brechen Sie ab, wenn Sie sie noch brauchen\./);
    assert.equal(await again.getByRole('button', { name: 'Zwischenstand jetzt speichern' }).count(), 0);
    await again.getByRole('button', { name: 'Abbrechen' }).click();
    await page.getByText('Es wurde nichts gelöscht.', { exact: true }).waitFor();
    assert.equal(messageCount(mb), 1);
    assert.ok(await readState(page));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Mit Briefkasten: Datenschutz- und Startseite beschreiben ihn', async () => {
  const { web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    await page.goto(`${web.url}#/datenschutz`);
    await page.getByRole('heading', { level: 1, name: 'Datenschutz-Hinweise' }).waitFor();
    const section = page.locator(tid('privacy-mailbox'));
    await section.getByRole('heading', { level: 2, name: 'Digitaler Briefkasten' }).waitFor();
    const privacy = squash(await page.locator('main').innerText());
    const mailboxText = squash(await section.innerText());
    assert.match(mailboxText, /im Browser der Eltern Ende-zu-Ende verschlüsselt und über einen Dienst bei Cloudflare zur Lehrkraft übertragen/);
    assert.match(mailboxText, /Cloudflare kann den Inhalt nicht lesen/);
    assert.match(mailboxText, /IP-Adressen/);
    assert.match(mailboxText, /nach spätestens 200 Tagen gelöscht oder früher, wenn die Lehrkraft den Briefkasten leert/);
    // Die Sätze für den Weg ohne Briefkasten stimmen jetzt nicht mehr
    assert.doesNotMatch(privacy, /Es gibt keinen Server/);
    assert.doesNotMatch(privacy, /ausschließlich über die PDF-Datei/);
    assert.match(privacy, /Notlösung selbst per E-Mail/);
    await shot(page, 'datenschutz-desktop');

    await page.goto(`${web.url}#/`);
    await page.locator(tid('start-teacher')).waitFor();
    const start = squash(await page.locator('main').innerText());
    assert.match(start, /Absenden – fertig Ihre Angaben kommen automatisch bei der Lehrkraft an\./);
    assert.match(start, /Die Rückmeldungen der Eltern kommen automatisch an\./);
    assert.doesNotMatch(start, /PDF-Datei per E-Mail an die Lehrkraft schicken/);
    const line = squash(await page.innerText(tid('start-privacy')));
    assert.doesNotMatch(line, /keine Daten auf einem Server/);
    assert.match(line, /Ende-zu-Ende-verschlüsselt über den digitalen Briefkasten/);
    await shot(page, 'start-desktop');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Smartphone (390 px): Briefkasten-Karte, Datenschutz- und Startseite ohne waagerechtes Scrollen', async () => {
  const { mb, web } = await startWithMailbox();
  const box = await createTeacherMailbox();
  const { browser, page, errors } = await launch(MOBILE);
  try {
    await openSettings(page, web, stateWith(box));
    const card = page.locator(tid('mailbox-card'));
    await card.waitFor();
    await noHorizontalScroll(page);
    await card.locator(tid('mailbox-check')).tap();
    await card.locator(tid('mailbox-status')).getByText('Verbindung in Ordnung.').waitFor();
    // Knöpfe untereinander in voller Breite und groß genug zum Tippen
    const [a, b] = await Promise.all([card.locator(tid('mailbox-check')).boundingBox(), card.locator(tid('mailbox-clear')).boundingBox()]);
    assert.ok(b.y >= a.y + a.height, 'Knöpfe untereinander');
    assert.ok(a.height >= 42 && b.height >= 42, 'Knöpfe mindestens 42 px hoch');
    assert.ok(Math.abs(a.width - b.width) < 1, 'Knöpfe gleich breit');
    await noHorizontalScroll(page);
    await shot(page, 'einstellungen-mobil');
    await shotOf(card, 'karte-mobil');

    // Rückfrage vor dem Leeren (Rückmeldung ohne passendes Kind) passt auf das Smartphone
    await drop(mb, box, responsePayload('Zoe', 'Unbekannt'));
    await card.locator(tid('mailbox-clear')).tap();
    await page.getByRole('dialog', { name: 'Briefkasten leeren?' }).getByRole('button', { name: 'Briefkasten leeren' }).tap();
    const unmatched = page.getByRole('dialog', { name: 'Nicht zugeordnete Rückmeldungen löschen?' });
    await unmatched.waitFor();
    await noHorizontalScroll(page);
    const buttons = await Promise.all(['Abbrechen', 'Trotzdem leeren'].map((name) => unmatched.getByRole('button', { name }).boundingBox()));
    for (const box of buttons) assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.height >= 40, 'Knopf im Bild und groß genug');
    await shot(page, 'dialog-nicht-zugeordnet-mobil');
    await unmatched.getByRole('button', { name: 'Abbrechen' }).tap();
    await card.locator(tid('mailbox-status')).getByText('Der Briefkasten wurde nicht geleert.').waitFor();
    await noHorizontalScroll(page);

    await page.goto(`${web.url}#/datenschutz`);
    await page.locator(tid('privacy-mailbox')).waitFor();
    await noHorizontalScroll(page);
    await shot(page, 'datenschutz-mobil');

    await page.goto(`${web.url}#/`);
    await page.locator(tid('start-privacy')).waitFor();
    await noHorizontalScroll(page);
    await shot(page, 'start-mobil');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
