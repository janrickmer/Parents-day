// Browser-Test: Elternbriefe (PDF) und Hochladen/Einfügen der Rückmeldungen der Eltern.
// Optional Bildschirmfotos zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/responses.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, launch, pdfPayload, pdfPageCount, seedTeacher, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { studentCode } from '../../js/core/codes.js';
import { encodeEventKey, buildResponsePayload, encodeResponseText } from '../../js/core/transport.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const T_CODE = SAMPLE_TEACHER.teacherCode;

let server;
let tmp;
before(async () => {
  server = await startServer();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'parentsday-responses-'));
});
after(async () => {
  await server?.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

const tid = (id) => `[data-testid="${id}"]`;

async function shot(page, name, { fullPage = true } = {}) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

function kid(grade, letter, firstName, lastName, extra = {}) {
  return { id: `${grade}${letter}-${firstName}`, firstName, lastName, code: studentCode(grade, letter, T_CODE, firstName, lastName), response: null, appointment: null, ...extra };
}

function classOf(grade, letter, students) {
  return { id: `${grade}${letter}`, grade, letter, codesGenerated: true, students };
}

function stateWithClasses() {
  return sampleState({
    classes: [
      classOf(5, 'a', [kid(5, 'a', 'Anna', 'Beck'), kid(5, 'a', 'Ben', 'Cem'), kid(5, 'a', 'Clara', 'Dorn')]),
      classOf(6, 'b', [kid(6, 'b', 'Emil', 'Faber')]),
    ],
  });
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
    availability: availability ?? { '2026-11-12': [['14:00', '15:00'], ['16:30', '17:00']] },
  });
}

/** Text jeder PDF-Seite und Unterkante des Inhalts (ohne Fußzeile) in mm – über python3 + pymupdf. */
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
    pages.append({'text': p.get_text(), 'bottom': bottom / 72 * 25.4})
print(json.dumps({'pages': pages, 'title': doc.metadata.get('title')}))
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
    execFileSync('python3', ['-c', 'import sys, pymupdf; pymupdf.open(sys.argv[1])[0].get_pixmap(dpi=70).save(sys.argv[2])', file, path.join(SHOTS, `${name}.png`)]);
  } catch {
    /* ohne pymupdf keine Vorschau */
  }
}

/**
 * Erzeugt die Elternbriefe im Browser und lädt sie über savePdf() herunter. Gespeichert wird in einen
 * eigenen Temp-Ordner statt tests/e2e/output: Andere Browser-Tests (z. B. teacher-class) schreiben dort
 * gleichzeitig eine Datei mit demselben Namen.
 */
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
  return { ...result, downloadName: download.suggestedFilename(), file, buffer: await fs.readFile(file) };
}

/** Termin-Schlüssel wie im Elternbrief: passt nur zu Codes dieser Klasse und Lehrkraft. */
function letterKey(state, classId) {
  return encodeEventKey(state.event, { teacherCode: state.teacher.teacherCode, classId });
}

function assertLetterPages(parsed, students, { teacherEmail, eventKey, codeOnOneLine = false }) {
  assert.equal(parsed.pages.length, students.length);
  parsed.pages.forEach((p, i) => {
    const s = students[i];
    const flat = p.text.replace(/\s+/g, ' ');
    const compact = p.text.replace(/\s+/g, '');
    assert.ok(flat.includes(`Liebe Eltern und Erziehungsberechtigte von ${s.firstName} ${s.lastName},`) || compact.includes(`von${s.firstName}${s.lastName}`.replace(/\s+/g, '')), `Seite ${i + 1}: Anrede`);
    assert.ok(flat.includes(s.firstName) && flat.includes(s.lastName), `Seite ${i + 1}: Name des Kindes`);
    assert.ok(compact.includes(s.code), `Seite ${i + 1}: Code ${s.code}`);
    if (codeOnOneLine) assert.ok(p.text.split('\n').some((line) => line.trim() === s.code), `Seite ${i + 1}: Code steht nicht in einer Zeile`);
    for (const other of students) if (other !== s) assert.ok(!compact.includes(other.code), `Seite ${i + 1} enthält fremden Code`);
    assert.match(flat, /Termin-Schl/);
    assert.ok(compact.includes(eventKey.replace(/-/g, '')) || compact.includes(eventKey), `Seite ${i + 1}: Termin-Schlüssel`);
    assert.match(flat, /Ihre Zugangsdaten/);
    assert.match(flat, /Vorname des Kindes/);
    assert.match(flat, /Nachname des Kindes/);
    assert.match(flat, /https:\/\/parentsday\.janrickmer\.de/);
    assert.match(flat, /Zugang für Eltern/);
    assert.match(flat, /Datum: \d{2}\.\d{2}\.\d{4}/);
    assert.match(flat, /Terminlänge: 10 Minuten/);
    assert.match(flat, /alle Zeitslots/);
    assert.ok(compact.includes(teacherEmail.replace(/\s+/g, '')), `Seite ${i + 1}: E-Mail der Lehrkraft`);
    assert.match(flat, new RegExp(`Seite ${i + 1} von ${students.length}`));
    assert.ok(p.bottom > 200 && p.bottom <= 280, `Seite ${i + 1}: Inhalt reicht bis ${p.bottom.toFixed(1)} mm und stößt an die Fußzeile`);
  });
}

test('Elternbriefe: eine A4-Seite je Kind mit Code, gelber Kasten, QR-Code und Termin-Schlüssel', async (t) => {
  const { browser, page, errors } = await launch();
  try {
    const state = sampleState({
      classes: [classOf(5, 'a', [kid(5, 'a', 'Anna', 'Beck'), kid(5, 'a', 'Johannes', 'Schmidt'), kid(5, 'a', 'Clara', 'Dorn'), { ...kid(5, 'a', 'Dora', 'Ebel'), code: '' }]), classOf(7, 'c', [{ ...kid(7, 'c', 'Emil', 'Faber'), code: '' }])],
    });
    await seedTeacher(page, server.url, state);

    const letters = await downloadLetters(page, '5a');
    assert.equal(letters.filename, 'ParentsDay Elternbriefe Klasse 5a.pdf');
    assert.equal(letters.downloadName, 'ParentsDay Elternbriefe Klasse 5a.pdf', 'Dateiname des Downloads');
    assert.equal(letters.pageCount, 3, 'nur Kinder mit Code bekommen einen Brief');
    assert.equal(pdfPageCount(letters.buffer), 3);
    assert.equal(pdfPayload(letters.buffer)?.type, 'parent-letters');
    const withCode = state.classes[0].students.filter((s) => s.code);
    const parsed = pdfPages(letters.file);
    if (!parsed) t.diagnostic('python3/pymupdf nicht verfügbar – Seiteninhalt nicht geprüft');
    else {
      assert.equal(parsed.title, 'ParentsDay – Elternbriefe Klasse 5a');
      assertLetterPages(parsed, withCode, { teacherEmail: SAMPLE_TEACHER.email, eventKey: letterKey(state, '5a'), codeOnOneLine: true });
    }
    await renderPdfPage(letters.file, 'elternbrief-normal');

    // Klasse ohne Codes → verständliche Meldung
    const message = await page.evaluate(async () => {
      const { createParentLettersPdf } = await import('./js/pdf/letters-pdf.js');
      const { getCurrentState } = await import('./js/core/storage.js');
      try {
        await createParentLettersPdf(getCurrentState(), '7c');
        return 'kein Fehler';
      } catch (err) {
        return err.message;
      }
    });
    assert.equal(message, 'Für diese Klasse wurden noch keine Codes erzeugt.');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Elternbriefe: auch mit 3 Tagen, langer Adresse, langen Namen und langer E-Mail genau eine Seite je Kind', async (t) => {
  const { browser, page, errors } = await launch();
  try {
    const students = [
      kid(5, 'a', 'Maximilian-Alexander Johannes', 'Schneider-Wiesengrund von Hohenstein'),
      kid(5, 'a', 'Łukasz', 'Çelik'),
      kid(5, 'a', 'Zoë Marie-Louise', 'Müller-Lüdenscheidt'),
    ];
    const email = 'maximiliane.schneider-wiesengrund@gesamtschule-sued-musterstadt.example';
    const state = sampleState({ classes: [classOf(5, 'a', students)] });
    state.teacher.email = email;
    state.event.schoolAddress = 'Städtische Gesamtschule Süd mit gymnasialer Oberstufe und bilingualem Zweig\nSchulzentrum am Stadtpark, Haus B\nHauptstraße 123–125\n12345 Musterstadt-Nord\nTelefon 01234 567890';
    state.event.days = [
      { date: '2026-11-12', start: '14:00', end: '18:00' },
      { date: '2026-11-13', start: '15:00', end: '19:30' },
      { date: '2026-11-16', start: '08:00', end: '12:00' },
    ];
    await seedTeacher(page, server.url, state);
    const letters = await downloadLetters(page, '5a');
    assert.equal(letters.pageCount, 3);
    assert.equal(pdfPageCount(letters.buffer), 3);
    const parsed = pdfPages(letters.file);
    if (!parsed) t.diagnostic('python3/pymupdf nicht verfügbar – Seiteninhalt nicht geprüft');
    else {
      assertLetterPages(parsed, students, { teacherEmail: email, eventKey: letterKey(state, '5a') });
      for (const p of parsed.pages) {
        for (const day of ['Donnerstag, 12.11.2026', 'Freitag, 13.11.2026', 'Montag, 16.11.2026']) assert.ok(p.text.includes(day), `Tag ${day} fehlt`);
      }
    }
    await renderPdfPage(letters.file, 'elternbrief-lang');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Elternbriefe: Grenzfall mit 80 Zeichen langen Namen, 8 Tagen und sehr langer E-Mail bleibt einseitig; zu lange Adresse gibt klare Meldung', async (t) => {
  const { browser, page, errors } = await launch();
  try {
    // 80 Zeichen je Name (Höchstlänge der Klassen-Seite)
    const first = 'Maximiliane-Theresia Anna-Sophie Friederike Wilhelmine Josephine Charlotte Luise';
    const last = 'von und zu Hohenzollern-Sigmaringen-Wittgenstein-Berleburg-Schaumburg-Lippe Nord';
    const students = [kid(5, 'a', first, last), kid(5, 'a', 'Anna', 'Beck')];
    const email = `${'maximiliane.theresia.anna-sophie.schneider-wiesengrund'}@${'gesamtschule-sued-mit-gymnasialer-oberstufe.musterstadt-nord'}.example`;
    const state = sampleState({ classes: [classOf(5, 'a', students)] });
    state.teacher.firstName = 'Maximiliane-Theresia Anna-Sophie Friederike Wilhelmine Josephine Charlotte';
    state.teacher.lastName = 'von und zu Hohenzollern-Sigmaringen-Wittgenstein-Berleburg-Schaumburg-Lippe';
    state.teacher.email = email;
    state.event.schoolAddress = 'Städtische Gesamtschule Süd mit gymnasialer Oberstufe und bilingualem Zweig\nSchulzentrum am Stadtpark, Haus B, Eingang Nord, zweites Obergeschoss\nHauptstraße 123–125\n12345 Musterstadt-Nord\nTelefon 01234 567890\nTelefax 01234 567891\nSekretariat: Frau Müller';
    state.event.days = Array.from({ length: 8 }, (_, i) => ({ date: `2026-11-${10 + i}`, start: '14:00', end: '18:30' }));
    await seedTeacher(page, server.url, state);
    const letters = await downloadLetters(page, '5a');
    assert.equal(letters.pageCount, 2);
    assert.equal(pdfPageCount(letters.buffer), 2);
    const parsed = pdfPages(letters.file);
    if (!parsed) t.diagnostic('python3/pymupdf nicht verfügbar – Seiteninhalt nicht geprüft');
    else {
      assertLetterPages(parsed, students, { teacherEmail: email, eventKey: letterKey(state, '5a') });
      const lines = parsed.pages[0].text.split('\n').map((l) => l.trim());
      // Lange Namen werden an Leerzeichen/Bindestrichen umbrochen, nicht mitten im Wort
      for (const part of `${first} ${last}`.split(/[\s-]+/)) assert.ok(lines.some((l) => l.includes(part)), `„${part}“ wurde mitten im Wort getrennt`);
      for (const part of ['sued', 'gymnasialer', 'oberstufe', 'musterstadt']) assert.ok(lines.some((l) => l.includes(part)), `E-Mail-Teil „${part}“ wurde mitten im Wort getrennt`);
    }
    await renderPdfPage(letters.file, 'elternbrief-grenzfall');

    // Adresse so lang, dass der QR-Code nicht mehr lesbar wäre → verständliche Meldung statt „code length overflow“
    const message = await page.evaluate(async () => {
      const { createParentLettersPdf } = await import('./js/pdf/letters-pdf.js');
      const { getCurrentState } = await import('./js/core/storage.js');
      const s = getCurrentState();
      s.event.schoolAddress = Array.from({ length: 30 }, (_, i) => `Zeile ${i + 1} der Adresse mit sehr viel Text und Umlauten äöü`).join('\n');
      try {
        await createParentLettersPdf(s, '5a');
        return 'kein Fehler';
      } catch (err) {
        return String(err?.message || err);
      }
    });
    assert.match(message, /^Die Angaben für den QR-Code sind zu umfangreich/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

/** Erzeugt im Browser eine Rückmelde-PDF (wie die Elternseite: Daten in den Metadaten). */
async function makeResponsePdf(page, payload) {
  const b64 = await page.evaluate(async (p) => {
    const { createPdf, writeParagraph, embedPayload } = await import('./js/core/pdf.js');
    const doc = await createPdf();
    writeParagraph(doc, `Rückmeldung für ${p.firstName} ${p.lastName}`, 20);
    embedPayload(doc, p, { title: 'ParentsDay – Rückmeldung' });
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, payload);
  return Buffer.from(b64, 'base64');
}

async function writeTmp(name, content) {
  const file = path.join(tmp, name);
  await fs.writeFile(file, content);
  return file;
}

/** Hängt den Upload-Bereich in die Seite ein. Mit rerender: onImported ersetzt ihn (wie ein Neuzeichnen der Seite). */
async function mountImporter(page, { classId = '5a', rerender = false } = {}) {
  await page.evaluate(
    async ({ id, rerender: again }) => {
      const { createResponseImporter } = await import('./js/components/response-import.js');
      const main = document.querySelector('main');
      window.__reports = [];
      const create = () =>
        createResponseImporter({
          classId: id,
          onImported: (report) => {
            window.__reports.push(report);
            if (again) show();
          },
        });
      const show = () => {
        const card = document.createElement('section');
        card.className = 'card';
        const title = document.createElement('h2');
        title.textContent = 'Rückmeldungen der Eltern';
        card.append(title, create());
        main.replaceChildren(card);
      };
      show();
    },
    { id: classId, rerender },
  );
  await page.waitForSelector(tid('response-upload'));
}

async function uploadFiles(page, files) {
  await page.setInputFiles(`${tid('response-upload')} input[type=file]`, files);
}

async function reportText(page, contains) {
  const locator = page.locator(tid('response-report'), { hasText: contains });
  await locator.waitFor();
  return (await locator.innerText()).replace(/\s+/g, ' ');
}

async function storedClasses(page) {
  return page.evaluate((code) => JSON.parse(localStorage.getItem(`parentsday.teacher.${code}`)).classes, T_CODE);
}

const responseOf = (classes, classId, firstName) => classes.find((c) => c.id === classId).students.find((s) => s.firstName === firstName).response;

test('Rückmeldungen: mehrere PDFs, Textdatei und Fehler hochladen – Klasse wird am Code erkannt', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, stateWithClasses());
    await page.waitForSelector('main');

    const anna = responsePayload('Anna', 'Beck', '5a');
    const emil = responsePayload('Emil', 'Faber', '6b', { availability: { '2026-11-13': [['15:00', '16:00']] } });
    const max = responsePayload('Max', 'Muster', '7b');
    const ben = responsePayload('Ben', 'Cem', '5a', { availability: { '2026-11-12': [['17:00', '18:00']] } });
    const files = [
      await writeTmp('Rückmeldung Anna Beck.pdf', await makeResponsePdf(page, anna)),
      await writeTmp('Rückmeldung Emil Faber.pdf', await makeResponsePdf(page, emil)),
      await writeTmp('Rückmeldung Max Muster.pdf', await makeResponsePdf(page, max)),
      await writeTmp('E-Mail Ben.txt', `Sehr geehrte Frau Meier,\nanbei unsere Zeiten.\n\n${encodeResponseText(ben)}\n\nViele Grüße`),
      await writeTmp('Notiz.txt', 'Hier steht nichts Passendes.'),
    ];
    // Ein Elternbrief ist keine Rückmeldung
    const letters = await downloadLetters(page, '5a');
    files.push(await writeTmp('Elternbriefe.pdf', letters.buffer));

    await mountImporter(page);
    assert.equal(await page.getAttribute(tid('response-report'), 'aria-live'), 'polite');
    assert.equal(await page.getAttribute(`${tid('response-upload')} input[type=file]`, 'accept'), '.pdf,application/pdf,.txt,.eml,text/plain,message/rfc822');
    assert.equal(await page.getAttribute(`${tid('response-upload')} input[type=file]`, 'multiple'), '');
    await shot(page, 'desktop-1-upload-leer');

    await uploadFiles(page, files);
    const text = await reportText(page, 'übernommen');
    assert.match(text, /3 Rückmeldungen übernommen: Anna Beck \(5a\), Ben Cem \(5a\), Emil Faber \(6b\)/);
    assert.match(text, /1 Rückmeldung gehört zu einer anderen Klasse/);
    assert.match(text, /1 Rückmeldung nicht übernommen: Max Muster \(7b\): Klasse 7b ist nicht angelegt/);
    assert.match(text, /2 Dateien ohne Rückmeldung/);
    assert.match(text, /Notiz\.txt: Keine ParentsDay-Rückmeldung gefunden\./);
    assert.match(text, /Elternbriefe\.pdf: Das ist ein Elternbrief, keine Rückmeldung der Eltern\./);
    await shot(page, 'desktop-2-upload-bericht');

    const classes = await storedClasses(page);
    assert.deepEqual(responseOf(classes, '5a', 'Anna'), { submittedAt: anna.submittedAt, availability: anna.availability });
    assert.deepEqual(responseOf(classes, '5a', 'Ben'), { submittedAt: ben.submittedAt, availability: ben.availability });
    assert.deepEqual(responseOf(classes, '6b', 'Emil'), { submittedAt: emil.submittedAt, availability: emil.availability });
    assert.equal(responseOf(classes, '5a', 'Clara'), null);

    const reports = await page.evaluate(() => window.__reports);
    assert.equal(reports.length, 1, 'onImported wird einmal aufgerufen');
    assert.equal(reports[0].applied.length, 3);
    assert.deepEqual(reports[0].applied.find((a) => a.name === 'Emil Faber'), { classId: '6b', studentId: '6b-Emil', name: 'Emil Faber', replaced: false, otherClass: true });
    assert.equal(reports[0].skipped.length, 1);
    assert.equal(reports[0].errors.length, 2);

    // Dieselbe Datei noch einmal und eine neuere Rückmeldung für Anna
    const annaNew = responsePayload('Anna', 'Beck', '5a', { submittedAt: '2026-10-03T09:00:00.000Z', availability: { '2026-11-13': [['16:00', '17:00']] } });
    await uploadFiles(page, [files[1], await writeTmp('Anna neu.pdf', await makeResponsePdf(page, annaNew))]);
    const text2 = await reportText(page, 'aktualisiert');
    assert.match(text2, /1 Rückmeldung übernommen: Anna Beck \(5a\) – aktualisiert/);
    assert.match(text2, /Schon auf dem neuesten Stand.*Emil Faber \(6b\): Bereits übernommen/);
    assert.deepEqual(responseOf(await storedClasses(page), '5a', 'Anna').availability, annaNew.availability);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Zweiter Upload während des Einlesens geht nicht verloren, Ablagefläche bleibt ablegbar', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, stateWithClasses());
    await page.waitForSelector('main');
    await mountImporter(page);
    const anna = (await makeResponsePdf(page, responsePayload('Anna', 'Beck', '5a'))).toString('base64');
    const ben = (await makeResponsePdf(page, responsePayload('Ben', 'Cem', '5a'))).toString('base64');
    const state = await page.evaluate(
      ({ a, b }) => {
        const zone = document.querySelector('[data-testid="response-upload"]');
        const drop = (name, b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
          zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        };
        drop('Anna.pdf', a);
        // Während des Einlesens: Fläche nimmt weiter Dateien an (sonst öffnet der Browser die PDF selbst)
        const busy = zone.closest('.resp-import').getAttribute('aria-busy');
        const pointer = getComputedStyle(zone).pointerEvents;
        const dragover = new DragEvent('dragover', { bubbles: true, cancelable: true });
        zone.dispatchEvent(dragover);
        drop('Ben.pdf', b);
        return { busy, pointer, prevented: dragover.defaultPrevented };
      },
      { a: anna, b: ben },
    );
    assert.equal(state.busy, 'true');
    assert.notEqual(state.pointer, 'none');
    assert.equal(state.prevented, true);
    await page.waitForFunction(() => window.__reports.length === 2);
    await page.waitForFunction(() => !document.querySelector('.resp-import').hasAttribute('aria-busy'));
    const text = await reportText(page, 'Ben Cem');
    assert.match(text, /2 Rückmeldungen übernommen: Anna Beck \(5a\), Ben Cem \(5a\)/);
    const classes = await storedClasses(page);
    assert.ok(responseOf(classes, '5a', 'Anna'));
    assert.ok(responseOf(classes, '5a', 'Ben'));
    // Ein neuer Upload danach beginnt einen neuen Bericht
    await uploadFiles(page, [await writeTmp('Anna erneut.pdf', Buffer.from(anna, 'base64'))]);
    const text2 = await reportText(page, 'Bereits übernommen');
    assert.doesNotMatch(text2, /Ben Cem/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Rückmeldung aus E-Mail-Text einfügen (auch zitiert) und Bericht nach Neuzeichnen', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, stateWithClasses());
    await page.waitForSelector('main');
    await mountImporter(page, { rerender: true });

    await page.click(tid('response-paste'));
    await page.waitForSelector('.modal');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'response-paste-text');
    // Leer absenden → Hinweis, Dialog bleibt offen
    await page.click(tid('response-paste-submit'));
    await page.locator('.modal .alert-error', { hasText: 'Bitte fügen Sie zuerst den Text der E-Mail ein.' }).waitFor();
    assert.equal(await page.getAttribute(tid('response-paste-text'), 'aria-invalid'), 'true');
    await page.fill(tid('response-paste-text'), 'Hallo, das ist nur ein Gruß.');
    await page.click(tid('response-paste-submit'));
    await page.locator('.modal .alert-error', { hasText: 'keine ParentsDay-Rückmeldung' }).waitFor();

    const clara = responsePayload('Clara', 'Dorn', '5a', { availability: { '2026-11-12': [['14:30', '15:30']] } });
    const quoted = encodeResponseText(clara).match(/.{1,50}/g).join('\n> ');
    const mail = `Am 01.10.2026 schrieb Familie Dorn:\n> Guten Tag,\n> hier unsere Zeiten:\n> ${quoted}\n> Viele Grüße`;
    await page.fill(tid('response-paste-text'), mail);
    await shot(page, 'desktop-3-einfuegen', { fullPage: false });
    await page.click(tid('response-paste-submit'));
    await page.waitForSelector('.modal', { state: 'detached' });

    // onImported zeichnet den Bereich neu – der Bericht bleibt sichtbar
    const text = await reportText(page, 'übernommen');
    assert.match(text, /1 Rückmeldung übernommen: Clara Dorn \(5a\)/);
    assert.equal(await page.locator(tid('response-report')).count(), 1);
    assert.deepEqual(responseOf(await storedClasses(page), '5a', 'Clara'), { submittedAt: clara.submittedAt, availability: clara.availability });
    assert.equal((await page.evaluate(() => window.__reports)).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Upload-Bereich auf dem Smartphone: kein seitliches Scrollen, Dialog passt', async () => {
  const { browser, page, errors } = await launch(MOBILE);
  try {
    await seedTeacher(page, server.url, stateWithClasses());
    await page.waitForSelector('main');
    await mountImporter(page);
    const files = [
      await writeTmp('Anna.pdf', await makeResponsePdf(page, responsePayload('Anna', 'Beck', '5a'))),
      await writeTmp('Max.pdf', await makeResponsePdf(page, responsePayload('Max', 'Muster', '7b'))),
      await writeTmp('Ein sehr langer Dateiname ohne Rückmeldung von Familie Mustermann.txt', 'nichts'),
    ];
    await uploadFiles(page, files);
    await reportText(page, 'übernommen');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `Seite ist ${overflow}px breiter als der Bildschirm`);
    const button = await page.locator(tid('response-paste')).boundingBox();
    assert.ok(button.x >= 0 && button.x + button.width <= 390, 'Knopf passt auf den Bildschirm');
    await shot(page, 'mobil-1-upload-bericht');

    await page.click(tid('response-paste'));
    await page.waitForSelector('.modal');
    const modal = await page.locator('.modal').boundingBox();
    assert.ok(modal.x >= 0 && modal.x + modal.width <= 390, 'Dialog passt auf den Bildschirm');
    await shot(page, 'mobil-2-einfuegen', { fullPage: false });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal', { state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'response-paste', 'Fokus kehrt zum Knopf zurück');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Voller Speicher im Browser: Rückmeldungen werden nicht als „übernommen“ gemeldet', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, stateWithClasses());
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.waitForSelector(tid('response-upload'));
    // Speicher bis zum Rand füllen (wie nach vielen anderen Daten oder einer übergroßen Rückmeldung)
    await page.evaluate(() => {
      let chunk = 'x'.repeat(1024 * 1024);
      let i = 0;
      while (chunk.length > 0) {
        try {
          localStorage.setItem(`fuellung-${i++}`, chunk);
        } catch {
          chunk = chunk.slice(0, Math.floor(chunk.length / 2));
        }
      }
    });
    const file = path.join(tmp, 'Ben.txt');
    await fs.writeFile(file, `Hallo\n${encodeResponseText(responsePayload('Ben', 'Cem', '5a'))}\n`);
    await page.setInputFiles(`${tid('response-upload')} input[type=file]`, [file]);
    const report = page.locator(tid('response-report'));
    await report.locator('.alert-error', { hasText: 'Speichern im Browser nicht möglich' }).waitFor();
    assert.doesNotMatch(await report.textContent(), /übernommen:/);
    assert.match(await page.locator(tid('student-availability')).nth(1).textContent(), /Rückmeldung der Eltern ausstehend/);
    // Die Kopfzeile meldet keinen neuen Speicherstand
    const saved = await page.textContent(tid('save-indicator'));
    await page.waitForTimeout(300);
    assert.equal(await page.textContent(tid('save-indicator')), saved);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
