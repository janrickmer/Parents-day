// Browser-Test: Gespräche terminieren (Kalender mit Drag & Drop) und Termin-PDF.
// Optional Bildschirmfotos zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/teacher-schedule.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, launch, captureDownload, pdfPayload, pdfPageCount, seedTeacher, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { studentCode } from '../../js/core/codes.js';
import { toMinutes } from '../../js/core/time.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const T_CODE = SAMPLE_TEACHER.teacherCode;
const PX = 3; // Pixel pro Minute im Kalender
const DAY1 = '2026-11-12'; // 14:00–18:00
const DAY2 = '2026-11-13'; // 15:00–17:00
const DAY_START = { [DAY1]: '14:00', [DAY2]: '15:00' };

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.close();
});

const tid = (id) => `[data-testid="${id}"]`;

async function shot(page, name, { fullPage = true } = {}) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

function kid(grade, letter, id, firstName, lastName, extra = {}) {
  return { id, firstName, lastName, code: studentCode(grade, letter, T_CODE, firstName, lastName), response: null, appointment: null, ...extra };
}

function response(availability) {
  return { submittedAt: '2026-10-05T12:30:00.000Z', availability };
}

function scheduleState() {
  return sampleState({
    classes: [
      {
        id: '5a',
        grade: 5,
        letter: 'a',
        codesGenerated: true,
        students: [
          kid(5, 'a', 's1', 'Anna', 'Beck', { response: response({ [DAY1]: [['14:00', '15:00']] }) }),
          kid(5, 'a', 's2', 'Can', 'Yilmaz', { response: response({ [DAY1]: [['14:30', '14:40']], [DAY2]: [['15:00', '16:00']] }) }),
          kid(5, 'a', 's3', 'Ela', 'Özdemir'),
        ],
      },
      {
        id: '7b',
        grade: 7,
        letter: 'b',
        codesGenerated: true,
        students: [kid(7, 'b', 'm1', 'Max', 'Muster', { response: response({ [DAY1]: [['15:00', '16:00']] }), appointment: { date: DAY1, start: '15:00', duration: 10 } })],
      },
    ],
  });
}

function readState(page) {
  return page.evaluate((code) => JSON.parse(localStorage.getItem(`parentsday.teacher.${code}`)), T_CODE);
}

async function appointmentOf(page, studentId, classId = '5a') {
  const s = await readState(page);
  return s.classes.find((c) => c.id === classId).students.find((st) => st.id === studentId).appointment;
}

/** y-Koordinate einer Uhrzeit in einer Tagesspalte (Oberkante = Tagesbeginn). */
async function yOf(page, date, time) {
  const box = await page.locator(tid(`schedule-day-${date}`)).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + (toMinutes(time) - toMinutes(DAY_START[date])) * PX };
}

/** Zieht einen Namen aus der Seitenleiste: die Zeigerspitze markiert den Beginn. */
async function dragChip(page, studentId, date, time) {
  const chip = await page.locator(tid(`schedule-student-${studentId}`)).boundingBox();
  const target = await yOf(page, date, time);
  await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y + 1, { steps: 14 });
  await page.mouse.up();
}

/** Verschiebt einen Terminblock: der Griffpunkt behält seinen Abstand zur Oberkante. */
async function dragBlock(page, studentId, date, time) {
  const block = await page.locator(tid(`appointment-${studentId}`)).boundingBox();
  const grab = { x: block.x + 30, y: block.y + Math.min(10, block.height / 2) };
  const target = await yOf(page, date, time);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y + (grab.y - block.y) + 1, { steps: 14 });
  await page.mouse.up();
}

async function status(page, studentId) {
  return page.getAttribute(tid(`appointment-${studentId}`), 'data-status');
}

/** Text jeder PDF-Seite und Titel – über python3 + pymupdf (null, wenn nicht verfügbar). */
function pdfText(file) {
  const script = `
import json, sys, pymupdf
doc = pymupdf.open(sys.argv[1])
print(json.dumps({'pages': [p.get_text() for p in doc], 'title': doc.metadata.get('title')}))
`;
  try {
    return JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

async function renderPdfPages(file, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  const script = 'import sys, pymupdf\nd = pymupdf.open(sys.argv[1])\nfor i in (0, len(d) - 1):\n    d[i].get_pixmap(dpi=70).save(f"{sys.argv[2]}-{i + 1}.png")';
  try {
    execFileSync('python3', ['-c', script, file, path.join(SHOTS, name)]);
  } catch {
    /* ohne pymupdf keine Vorschau */
  }
}

test('Terminieren: Ziehen, Farben, Dauer, Verschieben, Entfernen, Überschneidung und Termin-PDF', async (t) => {
  const { browser, context, page, errors } = await launch({ viewport: { width: 1280, height: 1000 } });
  try {
    await seedTeacher(page, server.url, scheduleState());
    await page.goto(`${server.url}#/lehrkraft/klasse/5a/terminieren`);
    await page.getByRole('heading', { level: 1, name: 'Gespräche terminieren – Klasse 5a' }).waitFor();

    // Kopf, Legende, Seitenleiste, Tagesspalten
    assert.equal(await page.getAttribute('.sched-page .back-link', 'href'), '#/lehrkraft/klasse/5a');
    assert.equal((await page.textContent('.sched-page .back-link')).trim(), 'Klasse 5a');
    assert.equal((await page.textContent(tid('schedule-finalize'))).trim(), 'Termine festlegen, speichern und drucken');
    assert.equal((await page.textContent('.sched-counter')).trim(), '0 von 3 terminiert');
    const legend = await page.textContent('.sched-legend');
    for (const word of ['Blau', 'Orange', 'Rot', 'Keine Rückmeldung', 'andere Klasse']) assert.ok(legend.includes(word), word);
    const chips = await page.$$eval('.sched-chip', (els) => els.map((e) => e.dataset.testid));
    assert.deepEqual(chips, ['schedule-student-s1', 'schedule-student-s2', 'schedule-student-s3']);
    assert.match(await page.textContent(tid('schedule-student-s1')), /Anna Beck.*Do, 12\.11\.: 14:00–15:00 Uhr/);
    assert.match(await page.textContent(tid('schedule-student-s3')), /Rückmeldung ausstehend/);
    assert.match(await page.textContent(`#sched-day-${DAY1}`), /Do, 12\.11\.2026 · 14:00–18:00 Uhr/);
    assert.match(await page.textContent(`#sched-day-${DAY2}`), /Fr, 13\.11\.2026 · 15:00–17:00 Uhr/);
    const day1 = await page.locator(tid(`schedule-day-${DAY1}`)).boundingBox();
    assert.equal(Math.round(day1.height), 4 * 60 * PX); // 4 Stunden à 180 px
    // Termin der anderen Klasse grau, nicht ziehbar
    assert.equal((await page.textContent(`${tid(`schedule-day-${DAY1}`)} .sched-other`)).includes('7b · Max Muster'), true);
    await shot(page, 'schedule-desktop-leer');

    // 1. Anna auf 14:00 ziehen → blau (ok)
    await dragChip(page, 's1', DAY1, '14:00');
    await page.locator(tid('appointment-s1')).waitFor();
    assert.equal(await status(page, 's1'), 'ok');
    assert.deepEqual(await appointmentOf(page, 's1'), { date: DAY1, start: '14:00', duration: 10 });
    assert.equal(await page.locator(tid('schedule-student-s1')).count(), 0);
    assert.equal((await page.textContent(tid('appointment-s1'))).includes('Anna Beck (10 Min.)'), true);
    const b1 = await page.locator(tid('appointment-s1')).boundingBox();
    assert.equal(Math.round(b1.y - day1.y), 0); // Oberkante = Tagesbeginn
    assert.equal(Math.round(b1.height), 30);
    assert.equal((await page.textContent('.sched-counter')).trim(), '1 von 3 terminiert');

    // 2. Can auf 16:00 ziehen → rot (Eltern zu Beginn nicht verfügbar)
    await dragChip(page, 's2', DAY1, '16:00');
    await page.locator(tid('appointment-s2')).waitFor();
    assert.equal(await status(page, 's2'), 'unavailable');
    assert.deepEqual(await appointmentOf(page, 's2'), { date: DAY1, start: '16:00', duration: 10 });

    // 3. Block verschieben auf 14:30 → blau
    await dragBlock(page, 's2', DAY1, '14:30');
    await page.waitForFunction(() => document.querySelector('[data-testid="appointment-s2"]')?.dataset.status === 'ok');
    assert.equal((await appointmentOf(page, 's2')).start, '14:30');

    // 4. Block anklicken → Detailfeld, Dauer 20 → orange (ragt in nicht verfügbare Zeit)
    await page.click(`${tid('appointment-s2')} .sched-appt-main`);
    await page.locator(tid('appointment-duration-s2')).waitFor();
    assert.match(await page.textContent('.sched-detail'), /Can Yilmaz/);
    assert.match(await page.textContent('.sched-detail-when'), /14:30–14:40 Uhr/);
    await page.fill(tid('appointment-duration-s2'), '20');
    await page.waitForFunction(() => document.querySelector('[data-testid="appointment-s2"]')?.dataset.status === 'partial');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'appointment-duration-s2'); // Fokus bleibt
    assert.equal((await appointmentOf(page, 's2')).duration, 20);
    assert.equal(Math.round((await page.locator(tid('appointment-s2')).boundingBox()).height), 60);
    assert.match(await page.textContent(tid('appointment-s2')), /Can Yilmaz \(20 Min\.\)/);
    assert.match(await page.textContent('.sched-detail-when'), /14:30–14:50 Uhr/);
    assert.match(await page.textContent('.sched-detail-status'), /ragt in nicht verfügbare Zeit/);
    // Plus-Knopf: 25 Minuten; Dauer wird auf das Tagesende begrenzt
    await page.click('.sched-detail [aria-label="5 Minuten länger"]');
    assert.equal((await appointmentOf(page, 's2')).duration, 25);
    await page.click('.sched-detail [aria-label="5 Minuten kürzer"]');
    assert.equal((await appointmentOf(page, 's2')).duration, 20);
    await page.fill(tid('appointment-duration-s2'), '400');
    await page.press(tid('appointment-duration-s2'), 'Tab');
    assert.equal((await appointmentOf(page, 's2')).duration, 210); // 14:30 bis 18:00
    assert.equal(await page.inputValue(tid('appointment-duration-s2')), '210');
    assert.match(await page.textContent('.sched-limit-hint'), /höchstens bis 18:00 Uhr/);
    await page.fill(tid('appointment-duration-s2'), '20');
    await page.press(tid('appointment-duration-s2'), 'Tab');
    assert.equal((await appointmentOf(page, 's2')).duration, 20);
    await shot(page, 'schedule-desktop-detail');

    // 5. Dauer über die Unterkante ändern (Griff) → 30 Minuten
    const b2 = await page.locator(tid('appointment-s2')).boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height - 3);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + 30 * PX - 2, { steps: 8 });
    await page.mouse.up();
    assert.equal((await appointmentOf(page, 's2')).duration, 30);
    assert.equal(await status(page, 's2'), 'partial');

    // 6. Ohne Ziehen: Ela antippen (auswählen) und in die Spalte vom 13.11. um 15:30 klicken → unbekannt
    await page.click(tid('schedule-student-s3'));
    assert.equal(await page.getAttribute(tid('schedule-student-s3'), 'aria-pressed'), 'true');
    assert.match(await page.textContent('.sched-detail'), /noch ohne Termin/);
    const p3 = await yOf(page, DAY2, '15:30');
    await page.mouse.click(p3.x, p3.y + 1);
    await page.locator(tid('appointment-s3')).waitFor();
    assert.equal(await status(page, 's3'), 'unknown');
    assert.equal(await page.locator(`${tid('appointment-s3')} .sched-q`).count(), 1);
    assert.deepEqual(await appointmentOf(page, 's3'), { date: DAY2, start: '15:30', duration: 10 });
    assert.equal((await page.textContent('.sched-counter')).trim(), '3 von 3 terminiert');
    assert.match(await page.textContent('.sched-pool'), /Alle Lernenden sind terminiert\./);

    // 7. Überschneidung mit der anderen Klasse: Anna auf 15:00 → nebeneinander, markiert, Warnhinweis
    await page.keyboard.press('Escape');
    await dragBlock(page, 's1', DAY1, '15:00');
    await page.waitForFunction(() => document.querySelector('[data-testid="appointment-s1"]')?.classList.contains('sched-overlap'));
    assert.equal(await status(page, 's1'), 'unavailable'); // Eltern nur bis 15:00 verfügbar → zu Beginn nicht verfügbar
    const warning = await page.textContent('.sched-warnings');
    assert.match(warning, /überschneiden sich/);
    assert.match(warning, /Anna Beck/);
    assert.match(warning, /Max Muster \(Klasse 7b\)/);
    const [own, other] = [await page.locator(tid('appointment-s1')).boundingBox(), await page.locator('.sched-other').boundingBox()];
    assert.ok(own.x + own.width <= other.x + 1 || other.x + other.width <= own.x + 1, 'Blöcke liegen nebeneinander');
    assert.ok(own.width < day1.width / 2);
    await shot(page, 'schedule-desktop-ueberschneidung');

    // 8. Esc bricht das Ziehen ab
    const before1 = await appointmentOf(page, 's1');
    const b1b = await page.locator(tid('appointment-s1')).boundingBox();
    const target = await yOf(page, DAY1, '17:00');
    await page.mouse.move(b1b.x + 10, b1b.y + 10);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    assert.equal(await page.locator('.sched-ghost').count(), 1);
    assert.equal(await page.locator('.sched-preview').count(), 1);
    await shot(page, 'schedule-desktop-ziehen', { fullPage: false });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(await page.locator('.sched-ghost').count(), 0);
    assert.deepEqual(await appointmentOf(page, 's1'), before1);

    // 9. Entfernen: × am Block und Ziehen in die Seitenleiste
    await page.click(`${tid('appointment-s1')} .sched-appt-remove`);
    await page.locator(tid('schedule-student-s1')).waitFor();
    assert.equal(await appointmentOf(page, 's1'), null);
    assert.equal(await page.locator('.sched-warnings .alert').count(), 0);
    const b3 = await page.locator(tid('appointment-s3')).boundingBox();
    const poolBox = await page.locator('.sched-pool').boundingBox();
    await page.mouse.move(b3.x + 20, b3.y + 10);
    await page.mouse.down();
    await page.mouse.move(poolBox.x + poolBox.width / 2, poolBox.y + poolBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.locator(tid('schedule-student-s3')).waitFor();
    assert.equal(await appointmentOf(page, 's3'), null);

    // 10. Tastatur-Alternative: Ela auswählen, Tag + Uhrzeit im Detailfeld, „Eintragen“
    await page.focus(tid('schedule-student-s3'));
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute(tid('schedule-student-s3'), 'aria-pressed'), 'true');
    // Fokus springt ins Formular „Termin eintragen“, Esc führt zurück zum Namen und hebt die Auswahl auf
    assert.equal(await page.evaluate(() => document.activeElement?.matches('.sched-detail select')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'schedule-student-s3');
    assert.equal(await page.getAttribute(tid('schedule-student-s3'), 'aria-pressed'), 'false');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('.sched-detail select')), true);
    await page.selectOption('.sched-detail select', DAY2);
    await page.fill('.sched-detail input[type="time"]', '16:00');
    await page.click('.sched-detail button[type="submit"]');
    await page.locator(tid('appointment-s3')).waitFor();
    assert.deepEqual(await appointmentOf(page, 's3'), { date: DAY2, start: '16:00', duration: 10 });

    // Pfeiltaste verschiebt den ausgewählten Block um 5 Minuten
    await page.focus(`${tid('appointment-s3')} .sched-appt-main`);
    await page.keyboard.press('ArrowDown');
    assert.equal((await appointmentOf(page, 's3')).start, '16:05');
    await page.keyboard.press('ArrowUp');
    assert.equal((await appointmentOf(page, 's3')).start, '16:00');
    // Enter auf dem Block: Fokus in die Dauer-Eingabe, Esc zurück zum Block
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'appointment-duration-s3');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-testid]')?.dataset.testid), 'appointment-s3');

    // Nichts gehört zu anderen Klassen außer dem Termin in 7b
    assert.deepEqual(await appointmentOf(page, 'm1', '7b'), { date: DAY1, start: '15:00', duration: 10 });
    await page.keyboard.press('Escape');
    await shot(page, 'schedule-desktop-fertig');

    // 11. Termine festlegen, speichern und drucken → PDF mit 2 Terminseiten + Übersicht
    const popups = [];
    context.on('page', (p) => popups.push(p));
    const download = await captureDownload(page, () => page.click(tid('schedule-finalize')));
    assert.equal(download.filename, 'ParentsDay Termine Klasse 5a.pdf');
    assert.equal(pdfPageCount(download.buffer), 2 + 1);
    const payload = pdfPayload(download.buffer);
    assert.equal(payload.type, 'appointments');
    assert.equal(payload.classId, '5a');
    assert.equal(payload.count, 2);
    // Die Meldung steht auf der Seite (kein doppelter Hinweis als Toast)
    await page.locator('.sched-messages .alert-success', { hasText: 'Termine gespeichert.' }).waitFor();
    assert.equal(await page.locator('.toast', { hasText: 'Termine gespeichert' }).count(), 0);
    assert.equal(popups.length, 1, 'Drucken öffnet einen neuen Tab');
    await page.locator(`${tid('schedule-finalize')}:not([disabled])`).waitFor();

    await renderPdfPages(download.file, 'schedule-pdf');
    const parsed = pdfText(download.file);
    if (!parsed) t.diagnostic('python3/pymupdf nicht verfügbar – Seiteninhalt nicht geprüft');
    else {
      assert.equal(parsed.title, 'ParentsDay – Termine Klasse 5a');
      const [first, second, last] = parsed.pages;
      // Seite 1: Can Yilmaz (12.11., 14:30) vor Ela Özdemir (13.11., 16:00)
      assert.match(first, /Ihr Gesprächstermin zum Elternsprechtag/);
      // Dieselbe Anrede wie im Elternbrief
      assert.match(first, /Liebe Eltern und Erziehungsberechtigte von Can Yilmaz,/);
      assert.match(first, /Can Yilmaz \(Klasse 5a\)/);
      assert.match(first, /Donnerstag, 12\.11\.2026/);
      assert.match(first, /14:30–15:00 Uhr \(30 Minuten\)/);
      assert.match(first, /Gesamtschule Süd, Schulstraße 1, 12345 Musterstadt/);
      assert.match(first, /Anna Meier/);
      assert.match(first, /Bei spontanen Absagen oder Anfragen melden Sie sich gerne per E-Mail bei mir:/);
      assert.match(first, /anna\.meier@schule\.example/);
      assert.match(second, /Liebe Eltern und Erziehungsberechtigte von Ela Özdemir,/);
      assert.match(second, /Freitag, 13\.11\.2026/);
      assert.match(second, /16:00–16:10 Uhr \(10 Minuten\)/);
      // Letzte Seite: Übersicht aller Klassen, sortiert nach Zeit
      assert.match(last, /Übersicht der Gesprächstermine/);
      for (const head of ['Beginn', 'Ende', 'Dauer', 'Klasse', 'Kind (Eltern von …)', 'Eltern verfügbar']) assert.ok(last.includes(head), head);
      assert.match(last, /aller Ihrer Klassen/);
      assert.match(last, /Can Yilmaz/);
      assert.match(last, /Max Muster/);
      assert.match(last, /Ela Özdemir/);
      assert.match(last, /nur teilweise/);
      assert.match(last, /keine Rückmeldung/);
      assert.ok(last.indexOf('Can Yilmaz') < last.indexOf('Max Muster'), '14:30 vor 15:00');
      assert.ok(last.indexOf('Max Muster') < last.indexOf('Ela Özdemir'), '12.11. vor 13.11.');
      assert.match(last, /Noch ohne Termin in Klasse 5a: Anna Beck/);
    }

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Terminieren: Hinweise ohne Codes, ohne Termine und ohne Elternsprechtag', async () => {
  const { browser, page, errors } = await launch();
  try {
    const state = scheduleState();
    state.classes.push({ id: '6c', grade: 6, letter: 'c', codesGenerated: false, students: [kid(6, 'c', 'x1', 'Olga', 'Neu', { code: '' })] });
    // 6d: Codes erzeugt, danach kam ein Kind ohne Code hinzu (codesGenerated wird dadurch false)
    state.classes.push({
      id: '6d',
      grade: 6,
      letter: 'd',
      codesGenerated: false,
      students: [kid(6, 'd', 'y1', 'Paul', 'Alt', { appointment: { date: DAY1, start: '14:00', duration: 10 } }), kid(6, 'd', 'y2', 'Rita', 'Neu', { code: '' })],
    });
    await seedTeacher(page, server.url, state);

    // Codes noch nicht erzeugt
    await page.goto(`${server.url}#/lehrkraft/klasse/6c/terminieren`);
    await page.getByText('Bitte erzeugen Sie zuerst in der Klasse die Codes').waitFor();
    assert.equal(await page.getAttribute('.sched-page .btn-primary', 'href'), '#/lehrkraft/klasse/6c');
    assert.match(await page.textContent('.sched-page .alert'), /Tragen Sie dazu alle Lernenden ein/);
    await page.goto(`${server.url}#/lehrkraft/klasse/6d/terminieren`);
    await page.getByText('Für neu eingetragene Lernende fehlen noch Codes.', { exact: false }).waitFor();
    assert.match(await page.textContent('.sched-page .alert'), /bereits eingetragene Termine bleiben erhalten/);

    // Klasse fehlt
    await page.goto(`${server.url}#/lehrkraft/klasse/9d/terminieren`);
    await page.getByRole('heading', { level: 1, name: 'Klasse 9d nicht gefunden' }).waitFor();

    // Keine Termine → Hinweis statt PDF
    await page.goto(`${server.url}#/lehrkraft/klasse/5a/terminieren`);
    await page.locator(tid('schedule-finalize')).waitFor();
    await page.click(tid('schedule-finalize'));
    await page.locator('.sched-messages .alert-warning').waitFor();
    assert.match(await page.textContent('.sched-messages'), /Noch keine Termine eingetragen/);

    // Termin außerhalb der Sprechzeiten → Hinweis mit „Neu einplanen“
    await page.evaluate((code) => {
      const key = `parentsday.teacher.${code}`;
      const s = JSON.parse(localStorage.getItem(key));
      s.classes.find((c) => c.id === '5a').students[0].appointment = { date: '2026-11-12', start: '13:30', duration: 10 };
      localStorage.setItem(key, JSON.stringify(s));
    }, T_CODE);
    await page.reload();
    await page.locator('.sched-outside-item').waitFor();
    assert.match(await page.textContent('.sched-warnings'), /außerhalb der Sprechzeiten/);
    assert.match(await page.textContent('.sched-outside-item'), /Anna Beck – Donnerstag, 12\.11\.2026, 13:30–13:40 Uhr/);
    assert.equal(await page.locator(tid('appointment-s1')).count(), 0);
    await page.click('.sched-outside-item button');
    await page.locator(tid('schedule-student-s1')).waitFor();
    assert.equal(await page.getAttribute(tid('schedule-student-s1'), 'aria-pressed'), 'true');
    assert.equal(await page.locator('.sched-outside-item').count(), 0);

    // Elternsprechtag ohne Tage: Hinweis statt Kalender, kein leeres Formular, kein „Neu einplanen“ (würde nur löschen)
    await page.evaluate((code) => {
      const key = `parentsday.teacher.${code}`;
      const s = JSON.parse(localStorage.getItem(key));
      s.event.days = [];
      s.classes.find((c) => c.id === '5a').students[1].appointment = { date: '2026-11-12', start: '14:30', duration: 10 };
      localStorage.setItem(key, JSON.stringify(s));
    }, T_CODE);
    await page.reload();
    await page.locator('.sched-outside-item').waitFor();
    assert.match(await page.textContent('.sched-main'), /noch keine Tage mit Uhrzeiten eingetragen/);
    assert.equal(await page.locator('.sched-outside-item button').count(), 0);
    await page.click(tid('schedule-student-s1'));
    assert.match(await page.textContent('.sched-detail'), /noch keine Tage mit Uhrzeiten eingetragen/);
    assert.equal(await page.locator('.sched-detail form').count(), 0);

    // Ohne Elternsprechtag → Weiterleitung
    await page.evaluate((code) => {
      const key = `parentsday.teacher.${code}`;
      const s = JSON.parse(localStorage.getItem(key));
      s.event = null;
      localStorage.setItem(key, JSON.stringify(s));
    }, T_CODE);
    await page.reload();
    await page.waitForFunction(() => location.hash === '#/lehrkraft/elternsprechtag');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Terminieren auf Tablet (Touch) und Smartphone', async () => {
  // Tablet quer: Antippen + Tippen in den Kalender, Ziehen mit dem Finger
  {
    const { browser, page, errors } = await launch({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    try {
      await seedTeacher(page, server.url, scheduleState());
      await page.goto(`${server.url}#/lehrkraft/klasse/5a/terminieren`);
      await page.locator(tid('schedule-student-s1')).waitFor();
      await page.tap(tid('schedule-student-s3'));
      assert.equal(await page.getAttribute(tid('schedule-student-s3'), 'aria-pressed'), 'true');
      const p = await yOf(page, DAY1, '14:20');
      await page.touchscreen.tap(p.x, p.y + 1);
      await page.locator(tid('appointment-s3')).waitFor();
      assert.deepEqual(await appointmentOf(page, 's3'), { date: DAY1, start: '14:20', duration: 10 });

      // Ziehen mit dem Finger (Touch-Ereignisse über CDP): Anna auf 14:40
      const cdp = await page.context().newCDPSession(page);
      const chip = await page.locator(tid('schedule-student-s1')).boundingBox();
      const target = await yOf(page, DAY1, '14:40');
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      const sx = chip.x + chip.width / 2;
      const sy = chip.y + chip.height / 2;
      await touch('touchStart', sx, sy);
      for (let i = 1; i <= 16; i++) await touch('touchMove', sx + ((target.x - sx) * i) / 16, sy + ((target.y + 1 - sy) * i) / 16);
      await touch('touchEnd');
      await page.locator(tid('appointment-s1')).waitFor();
      assert.deepEqual(await appointmentOf(page, 's1'), { date: DAY1, start: '14:40', duration: 10 });
      assert.equal(await status(page, 's1'), 'ok');

      // Chromium unterdrückt ein Tippen, das sehr kurz nach einer Wischgeste folgt – kurz warten wie ein Mensch.
      await page.waitForTimeout(400);
      await page.tap(`${tid('appointment-s1')} .sched-appt-main`);
      await page.locator(tid('appointment-duration-s1')).waitFor();
      assert.equal(await page.locator(`${tid('appointment-s1')} .sched-appt-resize`).isVisible(), true); // Griff erst nach Auswahl
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, 'schedule-tablet', { fullPage: false });

      // Senkrechtes Wischen über einen NICHT ausgewählten Block blättert nur – der Termin bleibt, wo er ist
      const swipe = async (from, toY) => {
        await touch('touchStart', from.x, from.y);
        for (let i = 1; i <= 12; i++) await touch('touchMove', from.x, from.y + ((toY - from.y) * i) / 12);
        await touch('touchEnd');
      };
      const b3 = await page.locator(tid('appointment-s3')).boundingBox();
      const y0 = await page.evaluate(() => window.scrollY);
      // Ende des Wischens liegt noch in der Tagesspalte (14:00) – früher wurde der Termin dabei verschoben
      await swipe({ x: b3.x + b3.width / 2, y: b3.y + b3.height / 2 }, b3.y + b3.height / 2 - 55);
      await page.waitForTimeout(300);
      assert.deepEqual(await appointmentOf(page, 's3'), { date: DAY1, start: '14:20', duration: 10 });
      assert.equal(await page.locator('.sched-ghost').count(), 0);
      assert.ok((await page.evaluate(() => window.scrollY)) > y0, 'Seite wurde geblättert');

      // Der ausgewählte Block (Anna) lässt sich mit dem Finger senkrecht verschieben: 14:40 → 15:30
      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(400); // Chromium: Tippen/Ziehen nicht direkt nach einer Wischgeste
      const b1 = await page.locator(tid('appointment-s1')).boundingBox();
      const to = await yOf(page, DAY1, '15:30');
      const grabY = b1.y + 8;
      await swipe({ x: b1.x + b1.width / 2, y: grabY }, to.y + (grabY - b1.y) + 1);
      await page.waitForFunction(() => document.querySelector('[data-testid="appointment-s1"]')?.style.top === `${90 * 3}px`);
      assert.deepEqual(await appointmentOf(page, 's1'), { date: DAY1, start: '15:30', duration: 10 });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
  // Smartphone: alles erreichbar, keine waagerechte Seiten-Scrollleiste
  {
    const { browser, page, errors } = await launch({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const state = scheduleState();
      state.classes[0].students[1].appointment = { date: DAY1, start: '14:30', duration: 20 };
      // Termin am 2. Tag (Spalte liegt rechts außerhalb) und ein sehr langer Name ohne Trennstelle
      state.classes[0].students[2].appointment = { date: DAY2, start: '15:30', duration: 10 };
      state.classes[0].students.push(kid(5, 'a', 's4', 'Łukasz', 'Kowalczykowskiwiczowskiewiczowskiwiczowskiewicz'));
      await seedTeacher(page, server.url, state);
      await page.goto(`${server.url}#/lehrkraft/klasse/5a/terminieren`);
      await page.locator(tid('appointment-s2')).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `waagerechter Überlauf: ${overflow}px`);
      assert.equal(await page.evaluate(() => window.innerWidth), 390);
      await shot(page, 'schedule-phone');
      await page.tap(`${tid('appointment-s2')} .sched-appt-main`);
      const sheet = await page.locator('.sched-detail').boundingBox();
      assert.ok(Math.round(sheet.y + sheet.height) <= 844 && sheet.y > 200, 'Detailfeld als Blatt am unteren Rand');
      await shot(page, 'schedule-phone-detail', { fullPage: false });

      // Blatt schließen, Kind ohne Termin antippen: kompaktes Blatt, Kalender bleibt sichtbar; Formular aufklappbar
      await page.tap('.sched-detail-close');
      assert.equal(await page.locator('.sched-detail').isVisible(), false);
      await page.tap(tid('schedule-student-s4'));
      await page.evaluate(() => document.querySelector('.sched-main').scrollIntoView());
      const compact = await page.locator('.sched-detail').boundingBox();
      assert.ok(compact.height < 400, `Blatt zu hoch: ${compact.height}px`);
      assert.equal(await page.locator('.sched-detail select').isVisible(), false);
      await shot(page, 'schedule-phone-auswahl', { fullPage: false });
      await page.tap('.sched-detail summary');
      await page.locator('.sched-detail select').waitFor();
      await page.selectOption('.sched-detail select', DAY2);
      await page.fill('.sched-detail input[type="time"]', '16:00');
      await page.tap('.sched-detail button[type="submit"]');
      await page.locator(tid('appointment-s4')).waitFor();
      assert.deepEqual(await appointmentOf(page, 's4'), { date: DAY2, start: '16:00', duration: 10 });
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
});

test('Terminieren: Popup-Blocker, Doppelklick und lange Übersicht im PDF', async (t) => {
  const { browser, context, page, errors } = await launch();
  try {
    // 30 Termine in 5a und 20 in 7b: die Übersicht geht über mehrere Seiten
    const pad = (n) => String(n).padStart(2, '0');
    const at = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    const a = Array.from({ length: 30 }, (_, i) =>
      kid(5, 'a', `a${i}`, `Kind${i}`, `Nachname${i}`, { appointment: { date: i < 20 ? DAY1 : DAY2, start: at((i < 20 ? 840 : 900) + (i % 20) * 10), duration: 10 } }),
    );
    const b = Array.from({ length: 20 }, (_, i) => kid(7, 'b', `b${i}`, `Anderes${i}`, `Kind${i}`, { appointment: { date: DAY1, start: at(1020 + i * 5), duration: 5 } }));
    const state = sampleState({
      classes: [
        { id: '5a', grade: 5, letter: 'a', codesGenerated: true, students: a },
        { id: '7b', grade: 7, letter: 'b', codesGenerated: true, students: b },
      ],
    });
    state.event.days[0].end = '19:00';
    await seedTeacher(page, server.url, state);
    await page.goto(`${server.url}#/lehrkraft/klasse/5a/terminieren`);
    await page.locator(tid('appointment-a0')).waitFor();
    assert.match(await page.textContent('.sched-pool'), /Alle Lernenden sind terminiert\./);

    // Doppelklick: nur ein Download und ein Tab
    // Gezählt werden nur Downloads mit dem Dateinamen der App. Der Drucken-Tab lädt im Test-Browser
    // (ohne PDF-Betrachter) die Blob-Datei unter einem zufälligen Namen herunter – je nach Zeitpunkt
    // wird dieser Download der Hauptseite oder dem Tab zugerechnet.
    const popups = [];
    const tabPdfs = []; // PDF, die der neue Tab anzeigt (im Test-Browser als Download mit zufälligem Namen)
    let downloads = 0;
    const count = (d) => {
      if (d.suggestedFilename() === 'ParentsDay Termine Klasse 5a.pdf') downloads++;
      else tabPdfs.push(d);
    };
    page.on('download', count);
    context.on('page', (p) => {
      popups.push(p);
      p.on('download', count);
    });
    const dl = await captureDownload(page, () => page.dblclick(tid('schedule-finalize')));
    await page.locator('.sched-messages .alert-success').waitFor();
    assert.match(await page.textContent('.sched-messages'), /in einem neuen Tab geöffnet\. Zum Drucken nutzen Sie dort den Druckbefehl Ihres Browsers\./);
    // Auf schnellen Rechnern ist die PDF fertig, bevor der zweite Klick des Doppelklicks ankommt:
    // diesen zweiten Klick (detail 2) gezielt nach dem Erstellen auslösen.
    await page.$eval(tid('schedule-finalize'), (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })));
    await page.waitForTimeout(800);
    assert.equal(downloads, 1);
    assert.equal(popups.length, 1);
    // Kein automatischer Druckdialog: weder die heruntergeladene PDF noch die im neuen Tab enthält einen
    // Druckauftrag beim Öffnen (jsPDF autoPrint schreibt die Aktion /N /Print bzw. JavaScript print(…);
    // das übliche /OpenAction [… /FitH null] für die Anfangsansicht ist harmlos).
    const noAutoPrint = (buffer, label) => assert.doesNotMatch(buffer.toString('latin1'), /\/N\s*\/Print|\/S\s*\/JavaScript|print\s*\(/, `${label}: automatischer Druckauftrag`);
    noAutoPrint(dl.buffer, 'Download');
    if (tabPdfs.length) noAutoPrint(await fs.readFile(await tabPdfs[0].path()), 'Neuer Tab');
    else t.diagnostic('Der Test-Browser hat die PDF im neuen Tab nicht als Datei bereitgestellt – nur der Download wurde geprüft.');
    assert.equal(pdfPayload(dl.buffer).count, 30);
    const pages = pdfPageCount(dl.buffer);
    assert.ok(pages >= 30 + 2, `Übersicht über mehrere Seiten erwartet, Seiten: ${pages}`);
    const parsed = pdfText(dl.file);
    if (!parsed) t.diagnostic('python3/pymupdf nicht verfügbar – Seiteninhalt nicht geprüft');
    else {
      assert.match(parsed.pages[30], /Übersicht der Gesprächstermine/);
      // Folgeseite nennt den Tag, zu dem die Zeilen oben gehören
      assert.match(parsed.pages[31], /Übersicht der Gesprächstermine \(Fortsetzung\) – Donnerstag, 12\.11\.2026/);
      assert.match(parsed.pages.at(-1), /Insgesamt 50 Termine\./);
    }
    await renderPdfPages(dl.file, 'schedule-pdf-lang');

    // Popup-Blocker: window.open liefert null → trotzdem Download und verständlicher Hinweis
    await page.evaluate(() => {
      window.open = () => null;
    });
    // Nach dem Erstellen ignoriert der Knopf eine Sekunde lang weitere Klicks (Doppelklick-Schutz).
    await page.waitForTimeout(1200);
    await captureDownload(page, () => page.click(tid('schedule-finalize')));
    await page.getByText('Öffnen Sie die Datei zum Drucken aus Ihrem Download-Ordner.', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

/** Für jeden Terminblock: sichtbare Dauer (lang oder kurz) und ob sie ganz im Block steht. */
function durationVisibility(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.sched-appt[data-student]')].map((block) => {
      const label = block.querySelector('.sched-appt-label').getBoundingClientRect();
      const dur = [...block.querySelectorAll('.sched-dur-long, .sched-dur-short')].find((el) => el.getClientRects().length > 0);
      const r = dur?.getBoundingClientRect();
      const name = block.querySelector('.sched-appt-name');
      return {
        id: block.dataset.student,
        text: dur?.textContent || '',
        inside: Boolean(r && r.width > 8 && r.left >= label.left - 0.5 && r.right <= label.right + 0.5),
        nameCut: name.scrollWidth > name.clientWidth + 1,
      };
    }),
  );
}

test('Terminblöcke: die Dauer in Klammern bleibt auch bei langen Namen sichtbar', async () => {
  const longNames = [
    ['Anna-Katharina', 'Schmidt-Müller'],
    ['Maximilian', 'Hohenzollern-Sigmaringen'],
    ['Charlotte', 'Oppenheimer'],
    ['Ben', 'Fischer-Hoffmann'],
    ['Alexander', 'Wagner'],
  ];
  const state = sampleState({
    classes: [
      {
        id: '5a',
        grade: 5,
        letter: 'a',
        codesGenerated: true,
        students: longNames.map(([f, l], i) => kid(5, 'a', `k${i}`, f, l, { response: response({ [DAY1]: [['14:00', '18:00']] }), appointment: { date: i % 2 ? DAY2 : DAY1, start: i % 2 ? `15:${i}0` : `14:${i}0`, duration: 10 } })),
      },
    ],
  });
  state.event.days.push({ date: '2026-11-16', start: '14:00', end: '16:00' });
  for (const [viewport, opts] of [
    [{ width: 1440, height: 900 }, {}],
    [{ width: 1280, height: 800 }, {}],
    [{ width: 1024, height: 768 }, { hasTouch: true }],
    [{ width: 768, height: 1024 }, { hasTouch: true }],
    [{ width: 390, height: 844 }, { hasTouch: true, isMobile: true }],
  ]) {
    const { browser, page, errors } = await launch({ viewport, ...opts });
    try {
      await seedTeacher(page, server.url, state);
      await page.goto(`${server.url}#/lehrkraft/klasse/5a/terminieren`);
      await page.locator(tid('appointment-k1')).waitFor();
      const blocks = await durationVisibility(page);
      assert.equal(blocks.length, longNames.length);
      for (const b of blocks) {
        assert.ok(b.inside, `${viewport.width}px: Dauer von ${b.id} abgeschnitten`);
        assert.match(b.text, /^\(10( Min\.|′)\)$/, `${viewport.width}px: ${b.id}`);
      }
      // Am großen Bildschirm steht die ausführliche Form, gekürzt wird höchstens der Name
      if (viewport.width >= 1280) assert.ok(blocks.every((b) => b.text === '(10 Min.)'));
      if (viewport.width === 390) assert.ok(blocks.some((b) => b.nameCut), 'auf dem Smartphone wird der Name gekürzt, nicht die Dauer');
      await shot(page, `schedule-dauer-${viewport.width}`, { fullPage: false });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
});

test('Termin-PDF: Die letzte Seite ist die Übersichtstabelle – nie nur die Summenzeile', async (t) => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState());
    const pad = (n) => String(n).padStart(2, '0');
    const at = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    const cases = [
      { count: 20, days: 2, open: 0 },
      { count: 22, days: 1, open: 0 },
      { count: 28, days: 2, open: 2 },
      { count: 30, days: 1, open: 0 },
      { count: 40, days: 1, open: 4 },
    ];
    for (const { count, days, open } of cases) {
      const students = Array.from({ length: count + open }, (_, i) =>
        kid(5, 'a', `x${i}`, `Kind${i}`, `Nachname${i}`, {
          appointment: i < count ? { date: days === 2 && i % 2 ? DAY2 : DAY1, start: at(840 + Math.floor(days === 2 ? i / 2 : i) * 10), duration: 10 } : null,
        }),
      );
      const state = sampleState({ classes: [{ id: '5a', grade: 5, letter: 'a', codesGenerated: true, students }] });
      state.event.days = [
        { date: DAY1, start: '14:00', end: '22:00' },
        { date: DAY2, start: '14:00', end: '22:00' },
      ];
      const data = await page.evaluate(async (s) => {
        const { createAppointmentsPdf } = await import('./js/pdf/appointments-pdf.js');
        const { doc } = await createAppointmentsPdf(s, '5a');
        return doc.output('datauristring').split(',')[1];
      }, state);
      const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pd-termine-')), `termine-${count}.pdf`);
      await fs.writeFile(file, Buffer.from(data, 'base64'));
      const parsed = pdfText(file);
      if (!parsed) {
        t.diagnostic('python3/pymupdf nicht verfügbar – Seiteninhalt nicht geprüft');
        return;
      }
      const last = parsed.pages.at(-1);
      const rowsOnLast = (last.match(/10 Min\./g) || []).length;
      assert.ok(rowsOnLast >= 2, `${count} Termine: letzte Seite enthält nur ${rowsOnLast} Tabellenzeilen`);
      assert.match(last, new RegExp(`Insgesamt ${count} Termine\\.`));
      if (open) assert.match(last, /Noch ohne Termin in Klasse 5a:/);
      // Eine übliche Klasse (bis 30 Termine an einem Tag) passt auf eine Übersichtsseite
      if (count <= 30 && days === 1) assert.equal(parsed.pages.length, count + 1, `${count} Termine: Übersicht auf einer Seite`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Seite lässt sich wegen fehlender Verbindung nicht laden: verständliche Meldung und „Seite neu laden“', async () => {
  const { browser, page } = await launch();
  try {
    await page.route('**/js/views/teacher-schedule.js', (route) => route.abort('internetdisconnected'));
    await seedTeacher(page, server.url, scheduleState());
    await page.goto(`${server.url}#/lehrkraft/klasse/5a/terminieren`);
    const alert = page.locator('main .alert-error');
    await alert.waitFor();
    const text = await alert.textContent();
    assert.match(text, /Die Seite konnte nicht geladen werden\. Bitte prüfen Sie Ihre Internetverbindung/);
    assert.doesNotMatch(text, /Failed|fetch|module|http/i);
    // Wieder online: „Seite neu laden“ hilft
    await page.unroute('**/js/views/teacher-schedule.js');
    await page.click('[data-action="reload"]');
    await page.locator(tid('schedule-finalize')).waitFor();
  } finally {
    await browser.close();
  }
});
