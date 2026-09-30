// Browser-Tests: digitaler Briefkasten aus Sicht der Lehrkraft. Läuft gegen den echten Dienst
// (worker/briefkasten.js, lokal über mailbox-server.mjs): Briefkasten beim Erstellen der Elternbriefe
// anlegen (QR-Code mit b/p, Verzeichniseintrag für den Termin-Schlüssel), Rückmeldungen automatisch und
// per Knopf abrufen, neuere ersetzt ältere, unlesbare Nachrichten, Briefkasten nicht erreichbar,
// Elternbrief-Text und Seitenumfang (PDF).
// Bildschirmfotos zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/teacher-mailbox.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, launch, captureDownload, pdfPageCount, seedTeacher, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { startMailboxServer } from './mailbox-server.mjs';
import { studentCode, teacherCode, registrationCode } from '../../js/core/codes.js';
import { buildResponsePayload, decodeBase64Url, encodeEventKey } from '../../js/core/transport.js';
import { createTeacherMailbox, encryptForTeacher } from '../../js/core/mailbox.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const T_CODE = SAMPLE_TEACHER.teacherCode;
const tid = (id) => `[data-testid="${id}"]`;

let tmp;
const running = [];
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'parentsday-mailbox-'));
});
after(async () => {
  for (const close of running) await close().catch(() => {});
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
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

async function shot(page, name, { fullPage = true } = {}) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  // Ganze Seite: von oben, sonst steht die feste Kopfzeile mitten im Bild
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

function kid(grade, letter, firstName, lastName, extra = {}) {
  return { id: `${grade}${letter}-${firstName}`, firstName, lastName, code: studentCode(grade, letter, T_CODE, firstName, lastName), response: null, appointment: null, ...extra };
}

function classOf(grade, letter, students) {
  return { id: `${grade}${letter}`, grade, letter, codesGenerated: students.length > 0 && students.every((s) => s.code), students };
}

function responsePayload(firstName, lastName, classId, { submittedAt = '2026-10-01T10:00:00.000Z', availability } = {}) {
  const grade = Number(classId.slice(0, -1));
  return buildResponsePayload({
    code: studentCode(grade, classId.slice(-1), T_CODE, firstName, lastName),
    firstName,
    lastName,
    classId,
    teacherCode: T_CODE,
    slotMinutes: 10,
    submittedAt,
    availability: availability ?? { '2026-11-12': [['14:00', '15:00']] },
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

function readState(page) {
  return page.evaluate((c) => JSON.parse(localStorage.getItem(`parentsday.teacher.${c}`)), T_CODE);
}

const responseOf = (state, classId, firstName) => state.classes.find((c) => c.id === classId).students.find((s) => s.firstName === firstName).response;

async function reportText(page, contains) {
  const locator = page.locator(tid('response-report'), { hasText: contains });
  await locator.waitFor();
  return (await locator.innerText()).replace(/\s+/g, ' ');
}

/** Verfügbarkeits-Zelle eines Kindes der Klasse 5a (Reihenfolge wie in der Tabelle). */
function availabilityOf(page, firstName) {
  return page.locator(tid('student-availability')).nth(['Anna', 'Ben', 'Clara'].indexOf(firstName));
}

async function waitFor(predicate, { timeout = 5000, message = 'Bedingung nicht erreicht' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(message);
}

function directoryRows(mb) {
  return mb.db.db.prepare('SELECT dir_id, box_id FROM directory ORDER BY updated_at').all();
}

/** Text jeder PDF-Seite, Unterkante des Inhalts (mm) und Links (URI + Kantenlänge in mm) – über python3 + pymupdf. */
function pdfPages(file) {
  const script = `
import json, re, sys, pymupdf
doc = pymupdf.open(sys.argv[1])
pages = []
for p in doc:
    bottom = 0
    for b in p.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            t = ''.join(s['text'] for s in l['spans']).strip()
            if t == 'Erstellt mit ParentsDay' or re.fullmatch(r'Seite \\d+ von \\d+', t):
                continue
            bottom = max(bottom, l['bbox'][3])
    links = [{'uri': k.get('uri', ''), 'width': (k['from'].x1 - k['from'].x0) / 72 * 25.4} for k in p.get_links()]
    pages.append({'text': p.get_text(), 'bottom': bottom / 72 * 25.4, 'links': links})
print(json.dumps({'pages': pages}))
`;
  try {
    return JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

async function renderPdfPage(file, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  try {
    execFileSync('python3', ['-c', 'import sys, pymupdf; pymupdf.open(sys.argv[1])[0].get_pixmap(dpi=110).save(sys.argv[2])', file, path.join(SHOTS, `${name}.png`)]);
  } catch {
    /* ohne pymupdf keine Vorschau */
  }
}

/** Link des QR-Codes (Parameter e= als Objekt). */
function linkData(link) {
  return decodeBase64Url(new URL(link.replace('#/eltern?', '?')).searchParams.get('e'));
}

/** Länge des QR-Links und Zellen des QR-Codes (inkl. Ruhezone, wie in letters-pdf.js) im Browser berechnen. */
function qrInfo(page, classId) {
  return page.evaluate(async (id) => {
    const { eventLink } = await import('./js/core/transport.js');
    const { getCurrentState } = await import('./js/core/storage.js');
    const { default: qrcode } = await import('./vendor/qrcode.mjs');
    const link = eventLink(getCurrentState(), id);
    const code = qrcode(0, 'M');
    code.addData(link, 'Byte');
    code.make();
    return { length: link.length, cells: code.getModuleCount() + 4 };
  }, classId);
}

/**
 * QR-Größenlogik aus letters-pdf.js: Module mindestens 0,43 mm, solange der Code höchstens 50 mm groß
 * wird; darüber 50 mm Kante und nie unter 0,3 mm je Modul.
 */
function assertQrReadable(width, cells, label) {
  const module = width / cells;
  const expected = Math.min(0.43, 50 / cells);
  assert.ok(module >= expected - 0.003 && module >= 0.3, `${label}: QR-Modul nur ${module.toFixed(3)} mm (${width.toFixed(1)} mm / ${cells} Zellen)`);
  assert.ok(width <= 50.1, `${label}: QR-Code ${width.toFixed(1)} mm breit`);
}

/** Elternbriefe im Browser erzeugen und herunterladen (eigener Temp-Ordner, siehe responses.test.mjs). */
async function downloadLetters(page, classId) {
  const [download, result] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.evaluate(async (id) => {
      const { createParentLettersPdf } = await import('./js/pdf/letters-pdf.js');
      const { savePdf } = await import('./js/core/pdf.js');
      const { getCurrentState } = await import('./js/core/storage.js');
      const { doc, filename, pageCount } = await createParentLettersPdf(getCurrentState(), id);
      savePdf(doc, filename);
      return { filename, pageCount };
    }, classId),
  ]);
  const file = path.join(await fs.mkdtemp(path.join(tmp, 'dl-')), download.suggestedFilename());
  await download.saveAs(file);
  return { ...result, file, buffer: await fs.readFile(file) };
}

const STEP4 = 'Klicken Sie auf „Absenden“ – fertig! Ihre Angaben werden verschlüsselt an mich übermittelt.';
const flat = (text) => text.replace(/\s+/g, ' ');

function assertMailboxLetter(p, email, label) {
  const text = flat(p.text);
  assert.ok(text.includes(STEP4), `${label}: Schritt 4 mit Briefkasten`);
  assert.ok(text.includes(`Sollte das nicht klappen, zeigt Ihnen die Seite, wie Sie die Rückmeldung per E-Mail an ${email} senden.`) || p.text.replace(/\s+/g, '').includes(`perE-Mailan${email}senden.`), `${label}: Hinweis auf den Weg per E-Mail`);
  assert.doesNotMatch(text, /schicken Sie die erzeugte PDF-Datei/, `${label}: alter Schritt 4`);
  assert.ok(p.bottom > 200 && p.bottom <= 280, `${label}: Inhalt reicht bis ${p.bottom.toFixed(1)} mm und stößt an die Fußzeile`);
}

// ---------------------------------------------------------------------------------------------

test('Elternschreiben legt den Briefkasten an; Rückmeldungen kommen automatisch und per Knopf an', async (t) => {
  const { mb, web, closeMailbox } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    const students = [kid(5, 'a', 'Anna', 'Beck'), kid(5, 'a', 'Ben', 'Cem'), kid(5, 'a', 'Clara', 'Dorn')];
    await seedTeacher(page, web.url, sampleState({ classes: [classOf(5, 'a', students)] }));
    await page.goto(`${web.url}#/lehrkraft/klasse/5a`);

    // Vor den Elternbriefen: Hinweis, dass der Briefkasten mit den Briefen entsteht; E-Mail-Weg darunter
    await page.locator(tid('mailbox-setup-hint')).waitFor();
    assert.equal(await page.textContent(tid('mailbox-setup-hint')), 'Der digitale Briefkasten wird eingerichtet, sobald Sie Elternbriefe erstellen.');
    assert.equal(await page.locator(tid('mailbox-fetch')).count(), 0);
    assert.match(await page.textContent('.tc-responses'), /Rückmeldungen kommen automatisch über den digitalen Briefkasten; Rückmeldungen per E-Mail können Sie weiterhin hier hochladen\./);
    assert.match(await page.textContent('.tc-responses'), /Rückmeldungen per E-Mail \(PDF oder Text\)/);
    // Erklärung in kleiner Schrift: normalerweise automatisch, Beleg-PDF nur bei technischen Problemen
    const emailNote = await page.textContent(tid('response-email-note'));
    assert.match(emailNote, /Normalerweise werden die Rückmeldungen der Eltern automatisch in die Übersicht eingepflegt/);
    assert.match(emailNote, /„Beleg“ mit ihren verfügbaren Uhrzeiten als PDF-Datei per E-Mail/);
    assert.ok(await page.locator(`${tid('response-email-note')}.small`).count(), 'kleine Schrift');
    assert.ok(!(await readState(page)).mailbox, 'noch kein Briefkasten');
    await shot(page, 'desktop-1-klasse-vor-briefen');

    // Elternschreiben erstellen → Briefkasten im Zustand, QR-Code mit b/p
    const letters = await captureDownload(page, () => page.click(tid('primary-action')), { dir: path.join(tmp, 'letters-1') });
    assert.equal(letters.filename, 'ParentsDay Elternbriefe Klasse 5a.pdf');
    assert.equal(pdfPageCount(letters.buffer), 3);
    await page.locator('.alert-success', { hasText: 'Die Elternbriefe wurden erstellt' }).waitFor();
    assert.match(await page.textContent(tid('letters-mailbox-note')), /über den digitalen Briefkasten\. ParentsDay übernimmt sie automatisch, wenn Sie Ihre Klassen öffnen.*Tipp: Speichern Sie jetzt einen Zwischenstand\./);
    const state = await readState(page);
    assert.ok(state.mailbox, 'Briefkasten angelegt');
    assert.match(state.mailbox.id, /^[A-Za-z0-9_-]{32}$/);
    assert.match(state.mailbox.publicKey, /^[A-Za-z0-9_-]{87}$/);
    const ref = { id: state.mailbox.id, publicKey: state.mailbox.publicKey };

    const link = await page.evaluate(async () => {
      const { eventLink } = await import('./js/core/transport.js');
      const { getCurrentState } = await import('./js/core/storage.js');
      return eventLink(getCurrentState(), '5a');
    });
    const data = linkData(link);
    assert.equal(data.b, ref.id, 'QR-Link enthält die Briefkasten-ID');
    assert.equal(data.p, ref.publicKey, 'QR-Link enthält den öffentlichen Schlüssel');
    assert.ok(!link.includes(state.mailbox.secret), 'Geheimnis steht nicht im Link');

    // Verzeichniseintrag für den Termin-Schlüssel liegt im Briefkasten-Dienst
    const rows = await waitFor(() => (directoryRows(mb).length === 1 ? directoryRows(mb) : null), { message: 'Kein Verzeichniseintrag abgelegt' });
    assert.equal(rows[0].box_id, ref.id);
    const eventKey = encodeEventKey(state.event, { teacherCode: T_CODE, classId: '5a' });
    const found = await page.evaluate(async (key) => {
      const { lookupDirectoryEntry } = await import('./js/core/mailbox.js');
      return lookupDirectoryEntry({ teacherCode: 'A16595316960M', classId: '5a', eventKey: key });
    }, eventKey);
    assert.equal(found?.b, ref.id, 'Eltern mit Termin-Schlüssel finden den Briefkasten');
    assert.equal(found?.k, '5a');

    // Elternbrief: Schritt 4 mit Briefkasten, QR-Code verlinkt mit b/p und weiterhin gut scanbar
    const qr = await qrInfo(page, '5a');
    t.diagnostic(`Typischer Brief: Link ${qr.length} Zeichen, QR-Code ${qr.cells} Zellen`);
    const parsed = pdfPages(letters.file);
    if (!parsed) t.diagnostic('python3/pymupdf nicht verfügbar – Seiteninhalt nicht geprüft');
    else {
      assert.equal(parsed.pages.length, 3);
      parsed.pages.forEach((p, i) => {
        assertMailboxLetter(p, SAMPLE_TEACHER.email, `Seite ${i + 1}`);
        const qrLink = p.links.find((l) => l.uri.includes('#/eltern?e='));
        assert.ok(qrLink, `Seite ${i + 1}: QR-Code verlinkt`);
        assert.equal(linkData(qrLink.uri).b, ref.id);
        assert.ok(qrLink.width / qr.cells >= 0.43 - 0.003, `Seite ${i + 1}: QR-Modul nur ${(qrLink.width / qr.cells).toFixed(3)} mm`);
        assert.ok(qrLink.width >= 38, `Seite ${i + 1}: QR-Code nur ${qrLink.width.toFixed(1)} mm groß`);
      });
    }
    await renderPdfPage(letters.file, 'pdf-1-elternbrief-briefkasten');

    // Der Upload-Bereich zeigt jetzt den Briefkasten
    await page.locator(tid('mailbox-fetch')).waitFor();
    await page.locator(tid('mailbox-last'), { hasText: /Zuletzt abgerufen: \d{2}\.\d{2}\.\d{4}/ }).waitFor();
    assert.equal(await page.locator(tid('mailbox-setup-hint')).count(), 0);
    await shot(page, 'desktop-2-klasse-nach-briefen');

    // Zwei Rückmeldungen einwerfen, Klassenseite neu öffnen → automatischer Abruf füllt die Spalte
    const annaOld = responsePayload('Anna', 'Beck', '5a', { availability: { '2026-11-12': [['14:00', '15:00']] } });
    const ben = responsePayload('Ben', 'Cem', '5a', { submittedAt: '2026-10-02T08:00:00.000Z', availability: { '2026-11-13': [['15:00', '16:00']] } });
    await drop(mb, ref, annaOld);
    await drop(mb, ref, ben);
    await page.reload();
    await availabilityOf(page, 'Anna').filter({ hasText: '14:00–15:00' }).waitFor();
    await availabilityOf(page, 'Ben').filter({ hasText: '15:00–16:00' }).waitFor();
    assert.match(await availabilityOf(page, 'Clara').textContent(), /Rückmeldung der Eltern ausstehend/);
    let text = await reportText(page, 'übernommen');
    assert.match(text, /2 Rückmeldungen aus dem digitalen Briefkasten übernommen: Anna Beck \(5a\), Ben Cem \(5a\)/);
    assert.match(await page.textContent('.tc-subtitle'), /2 Rückmeldungen/);
    assert.match(await page.textContent('.tc-resp-count'), /2 von 3 Rückmeldungen eingegangen/);
    let saved = await readState(page);
    assert.deepEqual(responseOf(saved, '5a', 'Anna'), { submittedAt: annaOld.submittedAt, availability: annaOld.availability });
    assert.ok(saved.mailbox.lastFetchedAt, 'Zeitpunkt des Abrufs gespeichert');
    await shot(page, 'desktop-3-automatisch-abgerufen');

    // Weitere Nachrichten: neue (Clara), neuere (Anna), ältere (Ben), fremde Klasse, unlesbar
    const annaNew = responsePayload('Anna', 'Beck', '5a', { submittedAt: '2026-10-03T09:00:00.000Z', availability: { '2026-11-13': [['16:00', '17:00']] } });
    const benOld = responsePayload('Ben', 'Cem', '5a', { submittedAt: '2026-09-30T08:00:00.000Z', availability: { '2026-11-12': [['17:00', '18:00']] } });
    await drop(mb, ref, responsePayload('Clara', 'Dorn', '5a', { availability: { '2026-11-12': [['16:00', '16:30']] } }));
    await drop(mb, ref, annaNew);
    await drop(mb, ref, benOld);
    await drop(mb, ref, responsePayload('Max', 'Muster', '7b'));
    const stranger = await createTeacherMailbox();
    await drop(mb, { id: ref.id, publicKey: stranger.publicKey }, responsePayload('Clara', 'Dorn', '5a'));

    await page.click(tid('mailbox-fetch'));
    text = await reportText(page, 'Clara Dorn');
    assert.match(text, /2 Rückmeldungen aus dem digitalen Briefkasten übernommen: Anna Beck \(5a\) – aktualisiert, Clara Dorn \(5a\)/);
    assert.match(text, /1 Rückmeldung nicht übernommen: Max Muster \(7b\): Klasse 7b ist nicht angelegt/);
    assert.doesNotMatch(text, /Ben Cem/, 'ältere Rückmeldung wird nicht gemeldet');
    assert.match(await page.textContent(tid('mailbox-note')), /1 Nachricht im Briefkasten ließ sich nicht lesen und wurde übersprungen/);
    await availabilityOf(page, 'Anna').filter({ hasText: '16:00–17:00' }).waitFor();
    assert.doesNotMatch(await availabilityOf(page, 'Anna').textContent(), /14:00–15:00/, 'neuere Rückmeldung ersetzt die ältere');
    assert.match(await availabilityOf(page, 'Ben').textContent(), /15:00–16:00/, 'ältere Rückmeldung ersetzt die neuere nicht');
    await availabilityOf(page, 'Clara').filter({ hasText: '16:00–16:30' }).waitFor();
    saved = await readState(page);
    assert.deepEqual(responseOf(saved, '5a', 'Anna').availability, annaNew.availability);
    assert.deepEqual(responseOf(saved, '5a', 'Ben').availability, ben.availability);
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="response-report"]').previousElementSibling?.dataset.testid), 'mailbox-section', 'Bericht steht beim Briefkasten');
    await shot(page, 'desktop-4-abgerufen-per-knopf');

    // Nichts Neues → kurze Meldung statt langer Liste
    await page.click(tid('mailbox-fetch'));
    text = await reportText(page, 'Keine neuen');
    // je Kind gezählt (ältere Rückmeldungen von Anna und Ben nicht doppelt) – passt zu „3 von 3 Rückmeldungen eingegangen“
    assert.match(text, /Keine neuen Rückmeldungen im digitalen Briefkasten\. 3 Rückmeldungen sind bereits übernommen\./);
    assert.match(text, /Max Muster \(7b\)/);

    // Briefkasten fällt aus → dezenter Hinweis mit „Erneut versuchen“, Seite bleibt bedienbar
    await closeMailbox();
    await page.click(tid('mailbox-fetch'));
    await page.locator(tid('mailbox-retry')).waitFor();
    assert.match(await page.textContent(tid('mailbox-note')), /Der digitale Briefkasten ist gerade nicht erreichbar/);
    assert.equal((await page.textContent(tid('response-report'))).trim(), '', 'alter Bericht eines Abrufs verschwindet');
    await page.click(tid('mailbox-retry'));
    await page.locator(tid('mailbox-retry')).waitFor();
    assert.equal(await page.locator(tid('response-upload')).count(), 1, 'Upload per E-Mail bleibt möglich');
    assert.match(await availabilityOf(page, 'Anna').textContent(), /16:00–17:00/);
    await shot(page, 'desktop-5-offline');
    assert.deepEqual(unexpected(errors), []);
  } finally {
    await browser.close();
  }
});

test('Klassenübersicht: automatischer Abruf füllt die Kacheln, Verzeichnis für alle Klassen, höchstens alle 30 s', async () => {
  const { mb, web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    const mailbox = await createTeacherMailbox();
    const ref = { id: mailbox.id, publicKey: mailbox.publicKey };
    const state = sampleState({
      mailbox,
      classes: [
        classOf(5, 'a', [kid(5, 'a', 'Anna', 'Beck'), kid(5, 'a', 'Ben', 'Cem'), kid(5, 'a', 'Clara', 'Dorn')]),
        classOf(6, 'b', [kid(6, 'b', 'Emil', 'Faber')]),
        classOf(7, 'c', [{ ...kid(7, 'c', 'Frida', 'Gold'), code: '' }]),
      ],
    });
    await drop(mb, ref, responsePayload('Anna', 'Beck', '5a'));
    await drop(mb, ref, responsePayload('Emil', 'Faber', '6b', { availability: { '2026-11-13': [['15:00', '16:00']] } }));
    const gets = [];
    page.on('request', (req) => {
      if (req.url().startsWith(mb.url) && req.method() === 'GET' && req.url().endsWith('/messages')) gets.push(req.url());
    });
    await seedTeacher(page, web.url, state);
    await page.goto(`${web.url}#/lehrkraft/klassen`);

    await page.locator(tid('class-tile-5a'), { hasText: '1 von 3 Rückmeldungen' }).waitFor();
    await page.locator(tid('class-tile-6b'), { hasText: '1 von 1 Rückmeldung' }).waitFor();
    const text = await reportText(page, 'übernommen');
    assert.match(text, /2 Rückmeldungen aus dem digitalen Briefkasten übernommen: Anna Beck \(5a\), Emil Faber \(6b\)/);
    assert.equal(await page.textContent('#tcl-import-title'), 'Rückmeldungen der Eltern');
    assert.match(await page.textContent('.tcl-import'), /Rückmeldungen kommen automatisch über den digitalen Briefkasten/);
    assert.equal(gets.length, 1);

    // Verzeichniseinträge für alle Klassen mit Codes (5a, 6b – nicht 7c) werden still nachgeholt
    const rows = await waitFor(() => (directoryRows(mb).length === 2 ? directoryRows(mb) : null), { message: 'Verzeichniseinträge fehlen' });
    assert.ok(rows.every((r) => r.box_id === ref.id));
    await shot(page, 'desktop-6-klassenuebersicht');

    // Seitenwechsel innerhalb von 30 s: kein erneuter Abruf, die Klasse zeigt die Zeiten trotzdem
    await page.click(tid('class-tile-5a'));
    await availabilityOf(page, 'Anna').filter({ hasText: '14:00–15:00' }).waitFor();
    await page.locator(tid('mailbox-fetch')).waitFor();
    await page.waitForTimeout(300);
    assert.equal(gets.length, 1, 'höchstens ein automatischer Abruf je 30 s');
    assert.equal((await page.textContent(tid('response-report'))).trim(), '', 'kein erneuter Bericht');
    await page.click(tid('mailbox-fetch'));
    await reportText(page, 'Keine neuen');
    assert.equal(gets.length, 2, 'Knopf ruft immer ab');
    assert.equal(directoryRows(mb).length, 2, 'Verzeichniseinträge werden nicht doppelt angelegt');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Smartphone: Briefkasten nicht erreichbar beim Erstellen der Elternbriefe – Briefe trotzdem, Hinweis zum Termin-Schlüssel', async () => {
  const { web, closeMailbox } = await startWithMailbox();
  await closeMailbox();
  const { browser, page, errors } = await launch(MOBILE);
  try {
    await seedTeacher(page, web.url, sampleState({ classes: [classOf(5, 'a', [kid(5, 'a', 'Anna', 'Beck'), kid(5, 'a', 'Ben', 'Cem')])] }));
    await page.goto(`${web.url}#/lehrkraft/klasse/5a`);
    await page.locator(tid('mailbox-setup-hint')).waitFor();
    await shot(page, 'mobil-1-klasse-vor-briefen');

    const letters = await captureDownload(page, () => page.click(tid('primary-action')), { dir: path.join(tmp, 'letters-mobil') });
    assert.equal(pdfPageCount(letters.buffer), 2);
    await page.locator(tid('letters-directory-note')).waitFor();
    assert.match(await page.textContent(tid('letters-directory-note')), /Eltern ohne QR-Code \(mit Termin-Schlüssel\) schicken ihre Rückmeldung deshalb vorerst per E-Mail\. Beim nächsten Abrufen der Rückmeldungen wird es erneut versucht\./);
    assert.ok((await readState(page)).mailbox, 'Briefkasten trotzdem angelegt (nur im Browser)');

    // Der neue Upload-Bereich versucht abzurufen und meldet sich dezent
    await page.locator(tid('mailbox-retry')).waitFor();
    assert.match(await page.textContent(tid('mailbox-note')), /Der digitale Briefkasten ist gerade nicht erreichbar\. Bitte prüfen Sie die Internetverbindung\./);
    assert.match(await page.textContent(tid('mailbox-last')), /Zuletzt abgerufen: noch nie/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `Seite ist ${overflow}px breiter als der Bildschirm`);
    for (const id of ['mailbox-fetch', 'mailbox-retry', 'response-paste']) {
      const box = await page.locator(tid(id)).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 390, `${id} passt auf den Bildschirm`);
    }
    await page.locator(tid('mailbox-section')).scrollIntoViewIfNeeded();
    await shot(page, 'mobil-2-offline', { fullPage: false });
    await shot(page, 'mobil-3-offline-ganz');
    assert.deepEqual(unexpected(errors), []);
  } finally {
    await browser.close();
  }
});

test('Smartphone: Klassenübersicht mit Briefkasten und neuen Rückmeldungen', async () => {
  const { mb, web } = await startWithMailbox();
  const { browser, page, errors } = await launch(MOBILE);
  try {
    const mailbox = await createTeacherMailbox();
    await drop(mb, mailbox, responsePayload('Anna', 'Beck', '5a'));
    await drop(mb, mailbox, responsePayload('Ben', 'Cem', '5a', { submittedAt: '2026-10-02T10:00:00.000Z' }));
    await seedTeacher(page, web.url, sampleState({ mailbox, classes: [classOf(5, 'a', [kid(5, 'a', 'Anna', 'Beck'), kid(5, 'a', 'Ben', 'Cem'), kid(5, 'a', 'Clara', 'Dorn')])] }));
    await page.goto(`${web.url}#/lehrkraft/klassen`);
    await reportText(page, 'übernommen');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `Seite ist ${overflow}px breiter als der Bildschirm`);
    await shot(page, 'mobil-4-klassenuebersicht');
    await page.goto(`${web.url}#/lehrkraft/klasse/5a`);
    await availabilityOf(page, 'Ben').filter({ hasText: '14:00–15:00' }).waitFor();
    await page.locator('.tc-responses').scrollIntoViewIfNeeded();
    await shot(page, 'mobil-5-klasse-rueckmeldungen');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Elternbriefe mit Briefkasten: auch im Grenzfall eine Seite je Kind, QR-Code gut scanbar; ohne Dienst wie bisher', async (t) => {
  const { web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    const mailbox = await createTeacherMailbox();
    // Grenzfall wie in responses.test.mjs: 80 Zeichen lange Namen, 8 Tage, sehr lange Adresse und E-Mail
    const first = 'Maximiliane-Theresia Anna-Sophie Friederike Wilhelmine Josephine Charlotte Luise';
    const last = 'von und zu Hohenzollern-Sigmaringen-Wittgenstein-Berleburg-Schaumburg-Lippe Nord';
    const students = [kid(5, 'a', first, last), kid(5, 'a', 'Anna', 'Beck')];
    const email = 'maximiliane.theresia.anna-sophie.schneider-wiesengrund@gesamtschule-sued-mit-gymnasialer-oberstufe.musterstadt-nord.example';
    const state = sampleState({ mailbox, classes: [classOf(5, 'a', students)] });
    state.teacher.firstName = 'Maximiliane-Theresia Anna-Sophie Friederike Wilhelmine Josephine Charlotte';
    state.teacher.lastName = 'von und zu Hohenzollern-Sigmaringen-Wittgenstein-Berleburg-Schaumburg-Lippe';
    state.teacher.email = email;
    state.event.schoolAddress =
      'Städtische Gesamtschule Süd mit gymnasialer Oberstufe und bilingualem Zweig\nSchulzentrum am Stadtpark, Haus B, Eingang Nord, zweites Obergeschoss\nHauptstraße 123–125\n12345 Musterstadt-Nord\nTelefon 01234 567890\nTelefax 01234 567891\nSekretariat: Frau Müller';
    state.event.days = Array.from({ length: 8 }, (_, i) => ({ date: `2026-11-${10 + i}`, start: '14:00', end: '18:30' }));
    await seedTeacher(page, web.url, state);

    const qr = await qrInfo(page, '5a');
    t.diagnostic(`Grenzfall: Link ${qr.length} Zeichen, QR-Code ${qr.cells} Zellen`);

    const letters = await downloadLetters(page, '5a');
    assert.equal(letters.pageCount, 2);
    assert.equal(pdfPageCount(letters.buffer), 2);
    const parsed = pdfPages(letters.file);
    if (!parsed) t.diagnostic('python3/pymupdf nicht verfügbar – Seiteninhalt nicht geprüft');
    else {
      assert.equal(parsed.pages.length, 2);
      parsed.pages.forEach((p, i) => {
        assertMailboxLetter(p, email, `Grenzfall Seite ${i + 1}`);
        const link = p.links.find((l) => l.uri.includes('#/eltern?e='));
        assert.equal(linkData(link.uri).p, mailbox.publicKey);
        assertQrReadable(link.width, qr.cells, `Grenzfall Seite ${i + 1}`);
      });
    }
    await renderPdfPage(letters.file, 'pdf-2-elternbrief-grenzfall-briefkasten');

    // Ohne E-Mail-Adresse der Lehrkraft: „an mich“
    await page.evaluate(async () => {
      const { updateState } = await import('./js/core/storage.js');
      updateState((s) => {
        s.teacher.email = '';
        s.teacher.firstName = 'Anna';
        s.teacher.lastName = 'Meier';
      });
    });
    const noMail = await downloadLetters(page, '5a');
    const parsedNoMail = pdfPages(noMail.file);
    if (parsedNoMail) assert.match(flat(parsedNoMail.pages[1].text), /zeigt Ihnen die Seite, wie Sie die Rückmeldung per E-Mail an mich senden\./);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }

  // Ohne MAILBOX_URL (z. B. Zwischenstand mit Briefkasten geladen): Brief und Upload-Bereich wie bisher
  const plain = await startServer();
  running.push(() => plain.close());
  const second = await launch();
  try {
    const mailbox = await createTeacherMailbox();
    await seedTeacher(second.page, plain.url, sampleState({ mailbox, classes: [classOf(5, 'a', [kid(5, 'a', 'Anna', 'Beck')])] }));
    const letters = await downloadLetters(second.page, '5a');
    const parsed = pdfPages(letters.file);
    if (parsed) {
      const text = flat(parsed.pages[0].text);
      assert.match(text, /Klicken Sie auf „Absenden“ und schicken Sie die erzeugte PDF-Datei per E-Mail an anna\.meier@schule\.example\./);
      assert.doesNotMatch(text, /verschlüsselt/);
      const link = parsed.pages[0].links.find((l) => l.uri.includes('#/eltern?e='));
      assert.equal(linkData(link.uri).b, undefined, 'ohne Dienst kein Briefkasten im QR-Code');
    }
    await second.page.goto(`${plain.url}#/lehrkraft/klasse/5a`);
    await second.page.locator(tid('response-upload')).waitFor();
    assert.equal(await second.page.locator(tid('mailbox-section')).count(), 0);
    assert.match(await second.page.textContent('.tc-responses'), /Die Eltern schicken Ihnen ihre Rückmeldung als PDF-Datei per E-Mail/);
    assert.doesNotMatch(await second.page.textContent('.tc-responses'), /Briefkasten|PDF oder Text/);
    await second.page.goto(`${plain.url}#/lehrkraft/klassen`);
    await second.page.locator('#tcl-import-title').waitFor();
    assert.equal(await second.page.textContent('#tcl-import-title'), 'Rückmeldungen der Eltern hochladen');
    assert.equal(await second.page.locator(tid('mailbox-section')).count(), 0);
    assert.deepEqual(second.errors, []);
  } finally {
    await second.browser.close();
  }
});

/** Hält Anfragen an den Briefkasten zurück, bis release() aufgerufen wird (langsame Verbindung). */
async function holdMailbox(page, mb, pattern = '/v1/boxes/**') {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const requests = [];
  await page.route(`${mb.url}${pattern}`, async (route) => {
    requests.push(route.request().method());
    await gate;
    await route.continue().catch(() => {});
  });
  return { release, requests, done: () => page.unroute(`${mb.url}${pattern}`) };
}

const activeTestId = (page) => page.evaluate(() => document.activeElement?.dataset?.testid || document.activeElement?.tagName);

test('Abruf während der Eingabe: Fokus, Eingaben und neue Zeile bleiben; Klick während des Abrufs meldet das Ergebnis; Tastatur bei „Erneut versuchen“', async () => {
  const { mb, web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    const mailbox = await createTeacherMailbox();
    await drop(mb, mailbox, responsePayload('Anna', 'Beck', '5a'));
    await seedTeacher(page, web.url, sampleState({ mailbox, classes: [classOf(5, 'a', [kid(5, 'a', 'Anna', 'Beck'), kid(5, 'a', 'Ben', 'Cem')])] }));

    // Langsamer Briefkasten: Die Lehrkraft beginnt schon eine neue Zeile, bevor die Rückmeldung ankommt
    let hold = await holdMailbox(page, mb);
    await page.goto(`${web.url}#/lehrkraft/klasse/5a`);
    await page.locator(tid('mailbox-fetch'), { hasText: 'Wird abgerufen' }).waitFor();
    await page.click(tid('add-student'));
    await page.keyboard.type('Neu');
    hold.release();
    await availabilityOf(page, 'Anna').filter({ hasText: '14:00–15:00' }).waitFor();
    await reportText(page, 'Anna Beck');
    assert.equal(await activeTestId(page), 'student-lastname', 'Fokus bleibt im Namensfeld');
    await page.keyboard.type('mann');
    assert.deepEqual(await page.$$eval(tid('student-lastname'), (els) => els.map((e) => e.value)), ['Beck', 'Cem', 'Neumann']);
    // Eine gerade hinzugefügte, noch leere Zeile verschwindet nicht
    await page.click(tid('add-student'));
    await hold.done();

    // Klick auf „Neue Rückmeldungen abrufen“, während der automatische Abruf noch läuft:
    // kein zweiter Abruf, aber eine Meldung (auch wenn nichts Neues da ist)
    hold = await holdMailbox(page, mb);
    await page.reload();
    await page.locator(tid('mailbox-fetch'), { hasText: 'Wird abgerufen' }).waitFor();
    assert.equal(await page.locator(tid('student-row')).count(), 3, 'neue Zeile (Neumann) gespeichert');
    // Playwright wartet bei aria-disabled – Eltern/Lehrkräfte können trotzdem klicken
    await page.$eval(tid('mailbox-fetch'), (el) => el.click());
    hold.release();
    await reportText(page, 'Keine neuen Rückmeldungen');
    assert.deepEqual(hold.requests, ['GET'], 'nur ein Abruf');
    await hold.done();

    // Briefkasten nicht erreichbar: Nach „Erneut versuchen“ per Tastatur bleibt der Fokus beim Abruf-Knopf
    await page.route(`${mb.url}/v1/boxes/**`, (route) => route.abort('internetdisconnected'));
    await page.click(tid('mailbox-fetch'));
    await page.locator(tid('mailbox-retry')).waitFor();
    await page.focus(tid('mailbox-retry'));
    await page.keyboard.press('Enter');
    await page.locator(tid('mailbox-retry')).waitFor();
    assert.equal(await activeTestId(page), 'mailbox-fetch', 'Fokus nicht verloren');
    assert.deepEqual(unexpected(errors), []);
  } finally {
    await browser.close();
  }
});

test('Klassenübersicht: Kachel behält beim Abruf den Fokus; Lehrkraft-Wechsel im selben Tab beginnt neu', async () => {
  const { mb, web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    const mailboxA = await createTeacherMailbox();
    await drop(mb, mailboxA, responsePayload('Anna', 'Beck', '5a'));
    await seedTeacher(page, web.url, sampleState({ mailbox: mailboxA, classes: [classOf(5, 'a', [kid(5, 'a', 'Anna', 'Beck')])] }));
    const hold = await holdMailbox(page, mb);
    await page.goto(`${web.url}#/lehrkraft/klassen`);
    await page.locator(tid('mailbox-fetch'), { hasText: 'Wird abgerufen' }).waitFor();
    await page.focus(tid('class-tile-5a'));
    hold.release();
    await page.locator(tid('class-tile-5a'), { hasText: '1 von 1 Rückmeldung' }).waitFor();
    assert.equal(await activeTestId(page), 'class-tile-5a');
    await hold.done();

    // Briefkasten von A nicht erreichbar → Hinweis
    await page.route(`${mb.url}/v1/boxes/${mailboxA.id}/**`, (route) => route.abort('internetdisconnected'));
    await page.click(tid('mailbox-fetch'));
    await page.locator(tid('mailbox-retry')).waitFor();

    // Andere Lehrkraft meldet sich im selben Tab an (ohne Neuladen): eigener Abruf sofort, kein fremder Hinweis
    const teacherB = { firstName: 'Bernd', lastName: 'Kurz', birthDate: '1980-01-02', email: 'b.kurz@schule.example' };
    teacherB.registrationCode = registrationCode(teacherB.firstName, teacherB.lastName, teacherB.birthDate);
    teacherB.teacherCode = teacherCode(teacherB.firstName, teacherB.lastName, teacherB.birthDate);
    const mailboxB = await createTeacherMailbox();
    const carla = { id: 'carla', firstName: 'Carla', lastName: 'Ost', code: studentCode(5, 'a', teacherB.teacherCode, 'Carla', 'Ost'), response: null, appointment: null };
    await drop(
      mb,
      mailboxB,
      buildResponsePayload({ code: carla.code, firstName: 'Carla', lastName: 'Ost', classId: '5a', teacherCode: teacherB.teacherCode, slotMinutes: 10, submittedAt: '2026-10-01T10:00:00.000Z', availability: { '2026-11-12': [['15:00', '15:30']] } }),
    );
    await page.evaluate((s) => {
      localStorage.setItem(`parentsday.teacher.${s.teacher.teacherCode}`, JSON.stringify(s));
      sessionStorage.setItem('parentsday.session', s.teacher.teacherCode);
      location.hash = '#/lehrkraft/klasse/5a';
    }, sampleState({ teacher: teacherB, mailbox: mailboxB, classes: [classOf(5, 'a', [carla])] }));
    await page.locator(tid('student-availability')).filter({ hasText: '15:00–15:30' }).waitFor();
    assert.match(await reportText(page, 'übernommen'), /1 Rückmeldung aus dem digitalen Briefkasten übernommen: Carla Ost \(5a\)/);
    assert.equal(await page.locator(tid('mailbox-retry')).count(), 0, 'kein Hinweis aus dem Briefkasten der anderen Lehrkraft');
    assert.deepEqual(unexpected(errors), []);
  } finally {
    await browser.close();
  }
});

test('Termin-Schlüssel gehört einem früheren Briefkasten: klare Warnung; Doppelklick erzeugt einen Briefkasten und eine PDF; Geheimnis bleibt verborgen', async () => {
  const { mb, web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  const logs = [];
  page.on('console', (msg) => logs.push(msg.text()));
  try {
    const students = [kid(5, 'a', 'Anna', 'Beck')];
    // Früherer Briefkasten (z. B. vor dem Löschen der Browserdaten) hat den Verzeichniseintrag angelegt
    const old = await createTeacherMailbox();
    await seedTeacher(page, web.url, sampleState({ mailbox: old, classes: [classOf(5, 'a', students)] }));
    await page.evaluate(async () => {
      const { publishClassDirectory } = await import('./js/core/teacher-mailbox.js');
      const { getCurrentState } = await import('./js/core/storage.js');
      await publishClassDirectory(getCurrentState(), '5a');
    });
    assert.equal(directoryRows(mb).length, 1);

    // Derselbe Stand ohne Briefkasten; Doppelklick auf „Elternschreiben …“
    await seedTeacher(page, web.url, sampleState({ classes: [classOf(5, 'a', students)] }));
    await page.goto(`${web.url}#/lehrkraft/klasse/5a`);
    let downloads = 0;
    page.on('download', () => downloads++);
    const letters = await captureDownload(page, () => page.dblclick(tid('primary-action')), { dir: path.join(tmp, 'letters-409') });
    await page.locator(tid('letters-directory-note')).waitFor();
    await page.waitForTimeout(1000);
    assert.equal(downloads, 1, 'nur eine PDF');
    const state = await readState(page);
    assert.ok(state.mailbox && state.mailbox.id !== old.id, 'neuer Briefkasten');
    assert.equal(directoryRows(mb)[0].box_id, old.id, 'Eintrag gehört weiter dem früheren Briefkasten');
    const warning = page.locator('.tc-feedback .alert-warning');
    assert.match(await warning.textContent(), /Achtung: Für den Termin-Schlüssel dieser Klasse ist schon ein anderer digitaler Briefkasten eingetragen/);
    assert.doesNotMatch(await page.textContent('.tc-feedback'), /nicht erreichbar/, 'keine falsche Begründung');
    await page.locator('.tc-feedback').scrollIntoViewIfNeeded();
    await shot(page, 'desktop-7-termin-schluessel-konflikt', { fullPage: false });

    // Geheimnis und privater Schlüssel stehen nirgends: Seite, Konsole, PDF, QR-Link
    const hidden = [state.mailbox.secret, state.mailbox.privateKey.d];
    const html = await page.content();
    const pdfText = letters.buffer.toString('latin1');
    for (const value of hidden) {
      assert.ok(!html.includes(value), 'nicht im DOM');
      assert.ok(!logs.some((l) => l.includes(value)), 'nicht in der Konsole');
      assert.ok(!pdfText.includes(value), 'nicht in der PDF');
    }
    const parsed = pdfPages(letters.file);
    if (parsed) {
      const data = linkData(parsed.pages[0].links.find((l) => l.uri.includes('#/eltern?e=')).uri);
      assert.deepEqual(Object.keys(data).sort(), ['a', 'b', 'd', 'k', 'm', 'n', 'p', 's', 't', 'v']);
      assert.ok(hidden.every((value) => !JSON.stringify(data).includes(value)), 'nicht im QR-Link');
    }
    assert.deepEqual(unexpected(errors).filter((e) => !/status of 409/.test(e)), []);
  } finally {
    await browser.close();
  }
});
