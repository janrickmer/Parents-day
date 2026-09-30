// Browser-Tests: Klassenübersicht (Klassen anlegen, Kacheln) und Klassenansicht
// (Tabelle der Lernenden, Codes, Elternschreiben, Verfügbarkeit der Eltern).
// Mit PARENTSDAY_SHOTS=<Ordner> werden zusätzlich Screenshots gespeichert.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, launch, captureDownload, pdfPageCount, seedTeacher, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { studentCode } from '../../js/core/codes.js';
import { buildResponsePayload, encodeResponseText } from '../../js/core/transport.js';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.close();
});

const tid = (id) => `[data-testid="${id}"]`;
const TC = SAMPLE_TEACHER.teacherCode;
const code5a = (first, last) => studentCode(5, 'a', TC, first, last);
const SHOTS = process.env.PARENTSDAY_SHOTS || '';

function readState(page) {
  return page.evaluate((c) => JSON.parse(localStorage.getItem(`parentsday.teacher.${c}`)), TC);
}

/** Wartet, bis der gespeicherte Zustand die Bedingung erfüllt (Speichern ist verzögert). */
async function waitForState(page, predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  let state;
  while (Date.now() < end) {
    state = await readState(page);
    if (predicate(state)) return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`Zustand hat die Bedingung nicht erreicht: ${JSON.stringify(state?.classes)}`);
}

/** testid des fokussierten Elements und Index seiner Tabellenzeile, z. B. "student-lastname:1" */
function focusInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const rows = [...document.querySelectorAll('[data-testid="student-row"]')];
    return `${el?.dataset?.testid}:${rows.indexOf(el?.closest('tr'))}`;
  });
}

/** Simuliert das Einfügen aus der Zwischenablage (z. B. aus Excel kopiert). */
async function paste(locator, text) {
  await locator.focus();
  await locator.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

async function tableValues(page) {
  return page.$$eval('[data-testid="student-row"]', (rows) =>
    rows.map((r) => [r.querySelector('[data-testid="student-lastname"]').value, r.querySelector('[data-testid="student-firstname"]').value]),
  );
}

async function codeTexts(page) {
  return page.$$eval('[data-testid="student-code"]', (els) => els.map((e) => e.textContent.trim()));
}

async function shot(page, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

function sampleClass(overrides = {}) {
  return {
    id: '5a',
    grade: 5,
    letter: 'a',
    codesGenerated: true,
    students: [
      {
        id: 's1',
        lastName: 'Beck',
        firstName: 'Anna',
        code: code5a('Anna', 'Beck'),
        response: { submittedAt: '2026-10-05T12:30:00.000Z', availability: { '2026-11-12': [['16:00', '17:00'], ['14:00', '15:30']], '2026-11-13': [] } },
        appointment: { date: '2026-11-12', start: '14:00', duration: 15 },
      },
      { id: 's2', lastName: 'Müller', firstName: 'Jörg', code: code5a('Jörg', 'Müller'), response: null, appointment: null },
      { id: 's3', lastName: 'Özdemir', firstName: 'Ela', code: code5a('Ela', 'Özdemir'), response: null, appointment: null },
    ],
    ...overrides,
  };
}

test('Klassen anlegen, Lernende eintragen, Codes erzeugen, Elternschreiben erstellen', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState());
    await page.goto(`${server.url}#/lehrkraft/klassen`);
    await page.getByRole('heading', { level: 1, name: 'Klassen' }).waitFor();

    // Zusammenfassung des Elternsprechtags
    const facts = await page.textContent('.tcl-event');
    assert.match(facts, /Do, 12\.11\.2026, 14:00–18:00 Uhr/);
    assert.match(facts, /Fr, 13\.11\.2026, 15:00–17:00 Uhr/);
    assert.match(facts, /10 Minuten/);
    assert.match(facts, /Gesamtschule Süd, Schulstraße 1, 12345 Musterstadt/);
    assert.equal(await page.getAttribute('.tcl-event a', 'href'), '#/lehrkraft/einstellungen');
    await page.locator('.tcl-empty').waitFor();

    // Auswahllisten
    const grades = await page.$$eval(`${tid('class-grade')} option`, (els) => els.map((e) => e.textContent));
    assert.deepEqual(grades, ['Jahrgangsstufe wählen', ...Array.from({ length: 13 }, (_, i) => String(i + 1))]);
    const letters = await page.$$eval(`${tid('class-letter')} option`, (els) => els.map((e) => e.textContent));
    assert.deepEqual(letters, ['Buchstabe wählen', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    // Fehlende Auswahl
    await page.click(tid('class-create'));
    await page.getByText('Bitte wählen Sie eine Jahrgangsstufe und einen Buchstaben aus.').waitFor();
    await page.selectOption(tid('class-grade'), '5');
    await page.click(tid('class-create'));
    await page.getByText('Bitte wählen Sie einen Buchstaben aus.').waitFor();
    assert.equal(await page.getAttribute(tid('class-letter'), 'aria-invalid'), 'true');

    // Klasse 5a anlegen – Kachel erscheint, Klasse wird nicht automatisch geöffnet
    await page.selectOption(tid('class-letter'), 'a');
    await page.click(tid('class-create'));
    await page.locator(tid('class-tile-5a')).waitFor();
    assert.match(page.url(), /#\/lehrkraft\/klassen$/);
    let state = await readState(page);
    assert.deepEqual(state.classes, [{ id: '5a', grade: 5, letter: 'a', codesGenerated: false, students: [] }]);

    // Duplikat
    await page.selectOption(tid('class-grade'), '5');
    await page.selectOption(tid('class-letter'), 'a');
    await page.click(tid('class-create'));
    await page.getByText('Die Klasse 5a gibt es bereits.').waitFor();
    assert.equal((await readState(page)).classes.length, 1);

    // Zweite Klasse, Kacheln sortiert
    await page.selectOption(tid('class-grade'), '10');
    await page.selectOption(tid('class-letter'), 'b');
    await page.click(tid('class-create'));
    await page.locator(tid('class-tile-10b')).waitFor();
    assert.deepEqual(await page.$$eval('.tiles > .tile', (els) => els.map((e) => e.dataset.testid)), ['class-tile-5a', 'class-tile-10b']);
    assert.equal(await page.getAttribute(tid('class-tile-5a'), 'href'), '#/lehrkraft/klasse/5a');
    assert.match(await page.textContent(tid('class-tile-5a')), /Lernende eintragen/);

    // Kachel öffnen
    await page.click(tid('class-tile-5a'));
    await page.waitForURL(/#\/lehrkraft\/klasse\/5a$/);
    await page.getByRole('heading', { level: 1, name: 'Klasse 5a' }).waitFor();
    const rows = page.locator(tid('student-row'));
    const row = (i) => rows.nth(i);
    assert.equal(await rows.count(), 1, 'neue Klasse zeigt eine leere Zeile');
    assert.equal(await focusInfo(page), 'student-lastname:0');
    assert.equal(await page.isDisabled(tid('schedule-link')), true);
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Alle Lernenden erfolgreich eingetragen');

    // Zeile 1 tippen, „Weitere Lernende hinzufügen“ → Fokus im neuen Nachnamen
    await row(0).locator(tid('student-lastname')).fill('Müller');
    await row(0).locator(tid('student-firstname')).fill('Jörg');
    await page.click(tid('add-student'));
    assert.equal(await rows.count(), 2);
    assert.equal(await focusInfo(page), 'student-lastname:1');
    await page.keyboard.type('Beck');
    // Tippen baut die Tabelle nicht neu auf: Fokus bleibt im Feld
    assert.equal(await focusInfo(page), 'student-lastname:1');
    await page.keyboard.press('Enter');
    assert.equal(await focusInfo(page), 'student-firstname:1');
    await page.keyboard.type('Anna');
    // Enter im Vornamen der letzten Zeile → neue Zeile
    await page.keyboard.press('Enter');
    assert.equal(await rows.count(), 3);
    assert.equal(await focusInfo(page), 'student-lastname:2');

    // Einfügen aus einer Tabellenkalkulation ab Zeile 3 (Tabulator und Semikolon)
    await paste(row(2).locator(tid('student-lastname')), 'Yılmaz\tCan\r\nSchmidt; Lea\r\n');
    assert.equal(await rows.count(), 4);
    assert.deepEqual(await tableValues(page), [
      ['Müller', 'Jörg'],
      ['Beck', 'Anna'],
      ['Yılmaz', 'Can'],
      ['Schmidt', 'Lea'],
    ]);
    // Zeile ohne Rückmeldung wird ohne Rückfrage gelöscht
    await row(3).getByRole('button', { name: 'Zeile löschen' }).click();
    assert.equal(await rows.count(), 3);

    // Nummerierung und Code-Spalte (leer, nicht ausfüllbar)
    assert.deepEqual(await page.$$eval(`${tid('student-row')} .tc-num`, (els) => els.map((e) => e.textContent.replace(/\D/g, ''))), ['1', '2', '3']);
    assert.deepEqual(await codeTexts(page), ['–', '–', '–']);
    assert.equal(await page.locator(`${tid('student-code')} input, ${tid('student-code')} textarea, ${tid('student-code')} [contenteditable]`).count(), 0);
    assert.equal(await page.locator(tid('student-availability')).count(), 0);
    state = await waitForState(page, (s) => s.classes[0].students.length === 3);
    assert.deepEqual(
      state.classes[0].students.map((s) => [s.lastName, s.firstName, s.code]),
      [
        ['Müller', 'Jörg', ''],
        ['Beck', 'Anna', ''],
        ['Yılmaz', 'Can', ''],
      ],
    );
    await shot(page, 'class-desktop-eingetragen');

    // Codes erzeugen – doppelt ausgelöst (Enter, Enter): der zweite Druck startet noch kein PDF
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.focus(tid('primary-action'));
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.getByText('Codes für 3 Lernende erzeugt.').waitFor();
    const codes = [code5a('Jörg', 'Müller'), '5aA16595316960M11414125311', code5a('Can', 'Yılmaz')];
    assert.deepEqual(await codeTexts(page), codes);
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Elternschreiben für diese Klasse erstellen');
    assert.equal(await page.isDisabled(tid('schedule-link')), false);
    assert.deepEqual(await page.$$eval(tid('student-availability'), (els) => els.map((e) => e.textContent.trim())), Array(3).fill('Rückmeldung der Eltern ausstehend'));
    assert.equal((await page.textContent('.tc-subtitle')).trim(), '3 Lernende · 0 Rückmeldungen · 0 Termine');
    await page.getByText('0 von 3 Rückmeldungen eingegangen').waitFor();
    state = await readState(page);
    assert.equal(state.classes[0].codesGenerated, true);
    assert.deepEqual(state.classes[0].students.map((s) => s.code), codes);
    await shot(page, 'class-desktop-codes');
    await page.waitForTimeout(800);
    assert.equal(downloads, 0, 'Doppelklick auf „Alle Lernenden erfolgreich eingetragen“ darf kein PDF starten');
    assert.equal(await page.locator('.tc-feedback .alert-success').count(), 1);

    // Elternschreiben: eine Seite pro Kind
    const dl = await captureDownload(page, () => page.click(tid('primary-action')));
    assert.match(dl.filename, /\.pdf$/);
    assert.equal(pdfPageCount(dl.buffer), 3);
    if (SHOTS) await fs.copyFile(dl.file, path.join(SHOTS, 'elternschreiben.pdf'));
    await page.locator('.tc-feedback .alert-success').waitFor();
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Elternschreiben für diese Klasse erstellen');

    // Namen ändern → Code dieser Zeile leer, Knopf springt zurück
    await row(0).locator(tid('student-firstname')).fill('Jörg-Peter');
    assert.deepEqual(await codeTexts(page), ['–', codes[1], codes[2]]);
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Alle Lernenden erfolgreich eingetragen');
    assert.equal(await page.isDisabled(tid('schedule-link')), true);
    state = await waitForState(page, (s) => s.classes[0].codesGenerated === false && s.classes[0].students[0].code === '');
    assert.equal(state.classes[0].students[0].firstName, 'Jörg-Peter');
    assert.equal(state.classes[0].students[1].code, codes[1]);

    // Erneut erzeugen: unveränderte Namen behalten ihren Code
    await page.click(tid('primary-action'));
    const codes2 = [code5a('Jörg-Peter', 'Müller'), codes[1], codes[2]];
    assert.deepEqual(await codeTexts(page), codes2);
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Elternschreiben für diese Klasse erstellen');

    // Neue Zeile mit Namen und sofortiges Neuladen: Eingaben bleiben erhalten
    await page.click(tid('add-student'));
    await page.keyboard.type('Zander');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Mia');
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Alle Lernenden erfolgreich eingetragen');
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Klasse 5a' }).waitFor();
    assert.deepEqual(await tableValues(page), [
      ['Müller', 'Jörg-Peter'],
      ['Beck', 'Anna'],
      ['Yılmaz', 'Can'],
      ['Zander', 'Mia'],
    ]);
    assert.deepEqual(await codeTexts(page), [...codes2, '–']);
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Alle Lernenden erfolgreich eingetragen');
    // Zeile ohne Code löschen → alle übrigen haben passende Codes → wieder „Elternschreiben“
    await row(3).getByRole('button', { name: 'Zeile löschen' }).click();
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Elternschreiben für diese Klasse erstellen');
    state = await waitForState(page, (s) => s.classes[0].students.length === 3);
    assert.equal(state.classes[0].codesGenerated, true);

    // Klassenübersicht zeigt den Stand
    await page.click('.back-link');
    await page.waitForURL(/#\/lehrkraft\/klassen$/);
    const tile = await page.textContent(tid('class-tile-5a'));
    assert.match(tile, /3 Lernende/);
    assert.match(tile, /0 von 3 Rückmeldungen/);
    assert.match(tile, /Codes erzeugt/);
    await shot(page, 'classes-desktop');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Prüfung beim Erzeugen der Codes: fehlende Namen, keine Buchstaben, doppelte Namen', async () => {
  const { browser, page, errors } = await launch();
  try {
    const empty = (id, grade, letter) => ({ id, grade, letter, codesGenerated: false, students: [] });
    await seedTeacher(page, server.url, sampleState({ classes: [empty('5a', 5, 'a'), empty('6b', 6, 'b')] }));

    // Ohne Lernende
    await page.goto(`${server.url}#/lehrkraft/klasse/6b`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 6b' }).waitFor();
    // Enter in der leeren letzten Zeile legt keine weitere leere Zeile an
    await page.locator(tid('student-firstname')).press('Enter');
    assert.equal(await page.locator(tid('student-row')).count(), 1);
    await page.click(tid('primary-action'));
    await page.getByText('Bitte tragen Sie mindestens eine Lernende oder einen Lernenden ein.').waitFor();
    assert.equal((await readState(page)).classes.find((c) => c.id === '6b').codesGenerated, false);

    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 5a' }).waitFor();
    const rows = page.locator(tid('student-row'));
    const row = (i) => rows.nth(i);
    await row(0).locator(tid('student-lastname')).fill('Beck');
    await page.click(tid('add-student'));
    await page.click(tid('add-student'));
    await row(2).locator(tid('student-lastname')).fill('Öz');
    await row(2).locator(tid('student-firstname')).fill('123');
    await page.click(tid('add-student'));
    await row(3).locator(tid('student-lastname')).fill('  Beck ');
    await row(3).locator(tid('student-firstname')).fill('anna');

    await page.click(tid('primary-action'));
    const feedback = page.locator('.tc-feedback');
    await feedback.getByText('Zeile 1: Bitte tragen Sie den Vornamen ein.').waitFor();
    assert.match(await feedback.textContent(), /Zeile 2: Der Vorname „123“ enthält keine Buchstaben\./);
    // Komplett leere Zeile entfernt, Namen bereinigt
    assert.deepEqual(await page.$$eval(`${tid('student-row')} .tc-num`, (els) => els.map((e) => e.textContent.replace(/\D/g, ''))), ['1', '2', '3']);
    assert.deepEqual(await tableValues(page), [
      ['Beck', ''],
      ['Öz', '123'],
      ['Beck', 'anna'],
    ]);
    assert.equal(await row(0).locator(tid('student-firstname')).getAttribute('aria-invalid'), 'true');
    assert.equal(await row(1).locator(tid('student-firstname')).getAttribute('aria-invalid'), 'true');
    assert.equal(await row(2).locator(tid('student-firstname')).getAttribute('aria-invalid'), null);
    assert.equal(await focusInfo(page), 'student-firstname:0');
    assert.deepEqual(await codeTexts(page), ['–', '–', '–']);
    await shot(page, 'class-desktop-fehler');

    // Doppelte Namen (gleicher Zahlencode)
    await row(0).locator(tid('student-firstname')).fill('Anna');
    assert.equal(await row(0).locator(tid('student-firstname')).getAttribute('aria-invalid'), null);
    await row(1).locator(tid('student-firstname')).fill('Ela');
    await page.click(tid('primary-action'));
    await feedback.getByText('Zwei Lernende haben denselben Namen – bitte unterscheiden (z. B. mit zweitem Vornamen).').waitFor();
    assert.match(await feedback.textContent(), /Zeilen 1 und 3: Anna Beck/);
    assert.equal(await row(2).getAttribute('class'), 'tc-row-error');
    assert.deepEqual(await codeTexts(page), ['–', '–', '–']);

    await row(2).locator(tid('student-firstname')).fill('Anna Lena');
    await page.click(tid('primary-action'));
    await page.getByText('Codes für 3 Lernende erzeugt.').waitFor();
    assert.deepEqual(await codeTexts(page), [code5a('Anna', 'Beck'), code5a('Ela', 'Öz'), code5a('Anna Lena', 'Beck')]);
    assert.equal(await page.locator('.tc-row-error').count(), 0);
    const state = await readState(page);
    assert.equal(state.classes.find((c) => c.id === '5a').codesGenerated, true);

    // Einfügen mit Kopfzeile und Nummern-Spalte; einspaltiges Einfügen füllt nur die Vornamen
    await page.goto(`${server.url}#/lehrkraft/klasse/6b`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 6b' }).waitFor();
    await paste(page.locator(tid('student-lastname')), 'Nachname\tVorname\n1\tBeck\tAnna\n2\tKaya\tEmre\n');
    assert.deepEqual(await tableValues(page), [
      ['Beck', 'Anna'],
      ['Kaya', 'Emre'],
    ]);
    await paste(rows.nth(0).locator(tid('student-firstname')), 'Lea\nTom\nIda\n');
    assert.deepEqual(await tableValues(page), [
      ['Beck', 'Lea'],
      ['Kaya', 'Tom'],
      ['', 'Ida'],
    ]);
    assert.equal(await focusInfo(page), 'student-firstname:2');
    const saved = await waitForState(page, (s) => s.classes.find((c) => c.id === '6b').students.length === 3);
    assert.deepEqual(saved.classes.find((c) => c.id === '6b').students.map((st) => st.firstName), ['Lea', 'Tom', 'Ida']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Verfügbarkeit der Eltern, Rückfrage beim Löschen, Terminieren, Klasse löschen, Umleitungen', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass()] }));
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 5a' }).waitFor();

    const avail = page.locator(tid('student-availability'));
    const first = await avail.nth(0).textContent();
    assert.match(first, /Do, 12\.11\.: 14:00–15:30, 16:00–17:00 Uhr/);
    assert.match(first, /Fr, 13\.11\.: –/);
    assert.match(first, /eingegangen am 05\.10\.2026, 14:30 Uhr/);
    assert.match(first, /Termin: Do, 12\.11\., 14:00–14:15 Uhr/);
    assert.equal((await avail.nth(1).textContent()).trim(), 'Rückmeldung der Eltern ausstehend');
    assert.equal((await page.textContent('.tc-subtitle')).trim(), '3 Lernende · 1 Rückmeldung · 1 Termin');
    await page.getByText('1 von 3 Rückmeldungen eingegangen').waitFor();
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Elternschreiben für diese Klasse erstellen');

    // Rückmeldung aus dem E-Mail-Text übernehmen → Spalte füllt sich ohne Neuladen der Seite
    const payload = buildResponsePayload({
      code: code5a('Jörg', 'Müller'),
      firstName: 'Jörg',
      lastName: 'Müller',
      classId: '5a',
      teacherCode: TC,
      slotMinutes: 10,
      availability: { '2026-11-13': [['15:00', '15:40']] },
      submittedAt: '2026-10-06T08:00:00.000Z',
    });
    await page.click(tid('response-paste'));
    await page.getByRole('dialog').locator('textarea').fill(`Guten Tag,\nhier unsere Zeiten.\n\n${encodeResponseText(payload)}\n\nViele Grüße`);
    await page.getByRole('dialog').locator('.modal-actions .btn-primary').click();
    await page.getByText('2 von 3 Rückmeldungen eingegangen').waitFor();
    const second = await avail.nth(1).textContent();
    assert.match(second, /Do, 12\.11\.: –/);
    assert.match(second, /Fr, 13\.11\.: 15:00–15:40 Uhr/);
    assert.match(second, /eingegangen am 06\.10\.2026, 10:00 Uhr/);
    assert.equal((await page.textContent('.tc-subtitle')).trim(), '3 Lernende · 2 Rückmeldungen · 1 Termin');
    await shot(page, 'class-desktop-rueckmeldungen');

    // Löschen einer Zeile mit Rückmeldung/Termin fragt nach
    const rows = page.locator(tid('student-row'));
    await rows.nth(0).getByRole('button', { name: 'Zeile löschen' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Für Anna Beck liegt bereits eine Rückmeldung der Eltern und ein Termin vor.', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    assert.equal(await rows.count(), 3);
    assert.equal((await readState(page)).classes[0].students.length, 3);

    // Gespräche terminieren
    await page.click(tid('schedule-link'));
    await page.waitForURL(/#\/lehrkraft\/klasse\/5a\/terminieren$/);

    // Kachel in der Übersicht
    await page.goto(`${server.url}#/lehrkraft/klassen`);
    const tile = await page.locator(tid('class-tile-5a')).textContent();
    assert.match(tile, /3 Lernende/);
    assert.match(tile, /2 von 3 Rückmeldungen/);
    assert.match(tile, /1 Termin/);

    // Klasse löschen
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.click(tid('delete-class'));
    await page.getByRole('dialog').getByRole('button', { name: 'Klasse löschen' }).click();
    await page.waitForURL(/#\/lehrkraft\/klassen$/);
    await page.locator('.tcl-empty').waitFor();
    assert.deepEqual((await readState(page)).classes, []);

    // Unbekannte Klasse
    await page.goto(`${server.url}#/lehrkraft/klasse/9h`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 9h nicht gefunden' }).waitFor();

    // Ohne Elternsprechtag → erst den Elternsprechtag erstellen
    await seedTeacher(page, server.url, sampleState({ event: null }));
    await page.goto(`${server.url}#/lehrkraft/klassen`);
    await page.waitForURL(/#\/lehrkraft\/elternsprechtag$/);
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.waitForURL(/#\/lehrkraft\/elternsprechtag$/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Smartphone (390 × 844): Klassen und Klasse ohne waagerechtes Scrollen bedienbar', async () => {
  const { browser, page, errors } = await launch({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass(), { id: '7c', grade: 7, letter: 'c', codesGenerated: false, students: [] }] }));
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    await page.goto(`${server.url}#/lehrkraft/klassen`);
    await page.locator(tid('class-tile-7c')).waitFor();
    assert.equal(await noOverflow(), true);
    await shot(page, 'classes-mobile');

    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 5a' }).waitFor();
    assert.equal(await noOverflow(), true);
    await shot(page, 'class-mobile');

    await page.goto(`${server.url}#/lehrkraft/klasse/7c`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 7c' }).waitFor();
    await page.locator(tid('student-lastname')).fill('Beck');
    await page.locator(tid('student-firstname')).fill('Anna');
    await page.click(tid('add-student'));
    assert.equal(await page.locator(tid('student-row')).count(), 2);
    assert.equal(await noOverflow(), true);
    await shot(page, 'class-mobile-eingabe');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Schutz vor Doppelklicks, Rückgängig, Kopfzeile „Vorname | Nachname“, zurückgeänderte Namen, Status-Abgleich', async () => {
  const { browser, page, errors } = await launch();
  try {
    // Doppelklick auf „Klasse anlegen“: Erfolgsmeldung bleibt stehen, kein Fehler zum leeren Buchstaben
    await seedTeacher(page, server.url, sampleState());
    await page.goto(`${server.url}#/lehrkraft/klassen`);
    await page.selectOption(tid('class-grade'), '5');
    await page.selectOption(tid('class-letter'), 'a');
    await page.dblclick(tid('class-create'));
    await page.locator(tid('class-tile-5a')).waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.tcl-create-msg .alert-success').count(), 1);
    assert.equal(await page.locator('.tcl-create-msg .alert-error').count(), 0);
    assert.equal(await page.getAttribute(tid('class-letter'), 'aria-invalid'), null);

    // Doppelklick auf × löscht nur eine Zeile; „Rückgängig machen“ stellt sie samt Code wieder her
    const st = (id, last, first, extra = {}) => ({ id, lastName: last, firstName: first, code: code5a(first, last), response: null, appointment: null, ...extra });
    const response = { submittedAt: '2026-10-05T12:30:00.000Z', availability: { '2026-11-12': [['14:00', '15:00']] } };
    const students = [st('a', 'Beck', 'Anna'), st('b', 'Kaya', 'Emre', { response }), st('c', 'Li', 'Bo'), st('d', 'Ott', 'Ida')];
    await seedTeacher(page, server.url, sampleState({ classes: [{ id: '5a', grade: 5, letter: 'a', codesGenerated: true, students }] }));
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    const rows = page.locator(tid('student-row'));
    const row = (i) => rows.nth(i);
    await rows.first().waitFor();
    await row(0).getByRole('button', { name: 'Zeile löschen' }).dblclick();
    await page.waitForTimeout(200);
    assert.deepEqual(await tableValues(page), [
      ['Kaya', 'Emre'],
      ['Li', 'Bo'],
      ['Ott', 'Ida'],
    ]);
    await page.locator('.tc-feedback').getByText('„Anna Beck“ wurde gelöscht.').waitFor();
    await waitForState(page, (s) => s.classes[0].students.length === 3);
    await shot(page, 'class-desktop-rueckgaengig');
    await page.click('[data-action="undo-delete"]');
    assert.deepEqual(await tableValues(page), [
      ['Beck', 'Anna'],
      ['Kaya', 'Emre'],
      ['Li', 'Bo'],
      ['Ott', 'Ida'],
    ]);
    let state = await waitForState(page, (s) => s.classes[0].students.length === 4);
    assert.deepEqual(state.classes[0].students.map((s) => s.code), students.map((s) => s.code));
    assert.equal(state.classes[0].codesGenerated, true);
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Elternschreiben für diese Klasse erstellen');

    // Zeile mit Rückmeldung: Rückfrage, dann löschen und wiederherstellen – die Rückmeldung bleibt erhalten
    await page.waitForTimeout(800);
    await row(1).getByRole('button', { name: 'Zeile löschen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Zeile löschen' }).click();
    await waitForState(page, (s) => s.classes[0].students.length === 3);
    await page.click('[data-action="undo-delete"]');
    state = await waitForState(page, (s) => s.classes[0].students.length === 4);
    assert.deepEqual(state.classes[0].students[1].response, response);
    assert.match(await page.locator(tid('student-availability')).nth(1).textContent(), /14:00–15:00 Uhr/);

    // Name ändern und wieder zurück: der alte Code gilt wieder, kein erneutes Erzeugen nötig
    const firstName = row(0).locator(tid('student-firstname'));
    await firstName.fill('Annika');
    assert.deepEqual((await codeTexts(page))[0], '–');
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Alle Lernenden erfolgreich eingetragen');
    assert.match(await page.textContent('.tc-primary-hint'), /neuen Brief mit/);
    await waitForState(page, (s) => s.classes[0].codesGenerated === false);
    await firstName.fill('Anna');
    assert.deepEqual((await codeTexts(page))[0], code5a('Anna', 'Beck'));
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Elternschreiben für diese Klasse erstellen');
    assert.equal(await page.isDisabled(tid('schedule-link')), false);
    await waitForState(page, (s) => s.classes[0].codesGenerated === true && s.classes[0].students[0].code === code5a('Anna', 'Beck'));

    // Gespeicherter Status passt nicht zu den Codes (älterer Zwischenstand) → wird beim Öffnen angeglichen,
    // „Gespräche terminieren“ führt dann wirklich zur Terminierung
    const c7 = (first, last) => studentCode(7, 'c', TC, first, last);
    await seedTeacher(page, server.url, sampleState({ classes: [{ id: '7c', grade: 7, letter: 'c', codesGenerated: false, students: [{ id: 'x', lastName: 'Beck', firstName: 'Anna', code: c7('Anna', 'Beck'), response: null, appointment: null }] }] }));
    await page.goto(`${server.url}#/lehrkraft/klasse/7c`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 7c' }).waitFor();
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Elternschreiben für diese Klasse erstellen');
    await waitForState(page, (s) => s.classes[0].codesGenerated === true);
    await page.click(tid('schedule-link'));
    await page.waitForURL(/#\/lehrkraft\/klasse\/7c\/terminieren$/);
    await page.locator(tid('schedule-finalize')).waitFor();

    // Einfügen mit Kopfzeile „Vorname | Nachname“ (umgekehrte Reihenfolge) und mit Nummern-Spalte
    await seedTeacher(page, server.url, sampleState({ classes: [{ id: '6b', grade: 6, letter: 'b', codesGenerated: false, students: [] }] }));
    await page.goto(`${server.url}#/lehrkraft/klasse/6b`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 6b' }).waitFor();
    await paste(row(0).locator(tid('student-lastname')), 'Vorname\tNachname\nAnna\tBeck\nEmre\tKaya\n');
    assert.deepEqual(await tableValues(page), [
      ['Beck', 'Anna'],
      ['Kaya', 'Emre'],
    ]);
    await paste(row(0).locator(tid('student-firstname')), 'Nr.;Vorname;Nachname\n1;Lea;Ott\n');
    assert.deepEqual(await tableValues(page), [
      ['Ott', 'Lea'],
      ['Kaya', 'Emre'],
    ]);
    // Zu lange Namen werden wie beim Tippen auf 80 Zeichen gekürzt
    await paste(row(1).locator(tid('student-lastname')), `${'X'.repeat(120)}\t${'Y'.repeat(95)}\n`);
    assert.deepEqual((await tableValues(page))[1].map((v) => v.length), [80, 80]);

    // Doppelte Namen: eine Änderung in der Zeile hebt die Markierung beider Felder auf
    await paste(row(0).locator(tid('student-lastname')), 'Beck\tAnna\nBeck\tAnna\n');
    await page.click(tid('primary-action'));
    await page.locator('.tc-feedback').getByText('Zwei Lernende haben denselben Namen', { exact: false }).waitFor();
    assert.equal(await row(1).locator(tid('student-lastname')).getAttribute('aria-invalid'), 'true');
    await row(1).locator(tid('student-firstname')).fill('Anna Lena');
    assert.equal(await row(1).locator(tid('student-lastname')).getAttribute('aria-invalid'), null);
    assert.equal(await row(1).getAttribute('class'), '');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

function namesOf(state, classId = '5a') {
  return state.classes.find((c) => c.id === classId).students.map((s) => `${s.firstName} ${s.lastName}${s.response ? ' [Rückmeldung]' : ''}`);
}

test('Dieselbe Klasse in zwei Tabs: ergänzte Lernende und Rückmeldungen gehen nicht verloren', async () => {
  const { browser, context, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass()] }));
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.waitForSelector(tid('student-row'));
    // Zweiter Tab (dieselbe Anmeldung)
    const tabB = await context.newPage();
    tabB.on('pageerror', (err) => errors.push(`B: ${err.message}`));
    await tabB.goto(server.url);
    await tabB.evaluate((c) => sessionStorage.setItem('parentsday.session', c), TC);
    await tabB.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await tabB.waitForSelector(tid('student-row'));
    await tabB.click(tid('add-student'));
    const rowB = tabB.locator(tid('student-row')).nth(3);
    await rowB.locator(tid('student-lastname')).fill('Dorn');
    await rowB.locator(tid('student-firstname')).fill('Clara');
    await rowB.locator(tid('student-firstname')).press('Tab');
    await waitForState(page, (s) => namesOf(s).includes('Clara Dorn'));

    // Tab A (älterer Stand) ändert einen Namen: Clara bleibt erhalten und erscheint auch hier
    await page.locator(tid('student-firstname')).nth(1).fill('Jörgen');
    await page.locator(tid('student-firstname')).nth(1).press('Tab');
    const state = await waitForState(page, (s) => namesOf(s).includes('Jörgen Müller'));
    assert.deepEqual(namesOf(state), ['Anna Beck [Rückmeldung]', 'Jörgen Müller', 'Ela Özdemir', 'Clara Dorn']);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="student-lastname"]')].some((el) => el.value === 'Dorn'));

    // Löschen in Tab B wird in Tab A nicht wieder rückgängig gemacht
    await tabB.reload();
    await tabB.waitForSelector(tid('student-row'));
    await tabB.locator(tid('student-row')).nth(2).locator('.tc-del').click();
    await waitForState(page, (s) => !namesOf(s).includes('Ela Özdemir'));
    await page.locator(tid('student-lastname')).first().fill('Becker');
    await page.locator(tid('student-lastname')).first().press('Tab');
    const after = await waitForState(page, (s) => namesOf(s).includes('Anna Becker [Rückmeldung]'));
    assert.deepEqual(namesOf(after), ['Anna Becker [Rückmeldung]', 'Jörgen Müller', 'Clara Dorn']);

    // Klasse in Tab B gelöscht → Tab A meldet das, statt still „gespeichert“ zu zeigen
    await tabB.click(tid('delete-class'));
    await tabB.locator('.modal').getByRole('button', { name: 'Klasse löschen' }).click();
    await tabB.waitForURL(/#\/lehrkraft\/klassen$/);
    await page.locator('.tc-feedback .alert-error', { hasText: 'wurde inzwischen gelöscht' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Smartphone: Nach dem Erzeugen der Codes sind Meldung und nächster Knopf zu sehen', async () => {
  const { browser, page, errors } = await launch({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const students = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, lastName: `Nachname${String.fromCharCode(65 + i)}`, firstName: `Kind${String.fromCharCode(65 + i)}`, code: '', response: null, appointment: null }));
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass({ codesGenerated: false, students })] }));
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.waitForSelector(tid('student-row'));
    await page.locator(tid('primary-action')).scrollIntoViewIfNeeded();
    await page.tap(tid('primary-action'));
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes('Elternschreiben'), tid('primary-action'));
    await page.waitForTimeout(900); // sanftes Scrollen
    const inView = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      };
      return { feedback: visible(document.querySelector('.tc-feedback')), button: visible(document.querySelector('[data-testid="primary-action"]')), focused: document.activeElement?.dataset.testid };
    });
    assert.deepEqual(inView, { feedback: true, button: true, focused: 'primary-action' });
    // Keine doppelte Meldung als Toast
    assert.equal(await page.locator('.toast', { hasText: 'Codes für' }).count(), 0);
    assert.match(await page.textContent('.tc-feedback'), /Codes für 25 Lernende erzeugt\./);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Tablet hochkant: fokussierte Felder verschwinden nicht unter der Kopfzeile; lange Namen bleiben lesbar', async () => {
  const { browser, page, errors } = await launch({ viewport: { width: 768, height: 1024 }, hasTouch: true });
  try {
    const students = Array.from({ length: 28 }, (_, i) => ({ id: `s${i}`, lastName: i === 3 ? 'Hohenzollern-Sigmaringen' : `Nachname${i}`, firstName: i === 3 ? 'Maximiliane-Theresia' : `Kind${i}`, code: '', response: null, appointment: null }));
    for (const s of students) s.code = code5a(s.firstName, s.lastName);
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass({ students })] }));
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.waitForSelector(tid('student-row'));
    await page.focus(tid('primary-action'));
    const covered = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Tab');
      const info = await page.evaluate(() => {
        const header = document.querySelector('.site-header').getBoundingClientRect();
        const el = document.activeElement.getBoundingClientRect();
        return { top: el.top, headerBottom: header.bottom, label: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.trim().slice(0, 30) };
      });
      if (info.top < info.headerBottom - 0.5) covered.push(`${info.label}: ${info.top.toFixed(0)} < ${info.headerBottom.toFixed(0)}`);
    }
    assert.deepEqual(covered, [], 'Fokus unter der Kopfzeile');
    // Tablet quer: Namensfelder bleiben auch mit Code- und Verfügbarkeitsspalte breit genug für lange Namen
    await page.setViewportSize({ width: 1024, height: 768 });
    const field = await page.locator(tid('student-lastname')).nth(3).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    assert.ok(field.scroll <= field.client + 1, `„Hohenzollern-Sigmaringen“ abgeschnitten: ${JSON.stringify(field)}`);
    const wrap = await page.locator('.tc-table-wrap').evaluate((el) => el.scrollWidth - el.clientWidth);
    assert.ok(wrap <= 0, 'Tabelle passt ohne seitliches Scrollen');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Hinweise (Toasts) lassen sich schließen und blockieren keine Klicks daneben', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass()] }));
    await page.goto(`${server.url}#/lehrkraft/klasse/5a`);
    await page.waitForSelector(tid('student-row'));
    await paste(page.locator(tid('student-lastname')).first(), 'Beck\tAnna\nMüller\tJörg\n');
    const toast = page.locator('.toast', { hasText: 'eingefügt' });
    await toast.waitFor();
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.toast-host')).pointerEvents), 'none');
    await toast.getByRole('button', { name: 'Hinweis schließen' }).click();
    await toast.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
