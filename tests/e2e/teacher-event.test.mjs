// Browser-Tests: Elternsprechtag erstellen und „Weitere Einstellungen“.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, seedTeacher, sampleState, SAMPLE_TEACHER } from './helpers.mjs';
import { MONTHS, toIsoDate } from '../../js/core/time.js';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.close();
});

const tid = (id) => `[data-testid="${id}"]`;
const day = (date) => `${tid('event-calendar')} button[data-date="${date}"]`;

function readState(page) {
  return page.evaluate((code) => JSON.parse(localStorage.getItem(`parentsday.teacher.${code}`)), SAMPLE_TEACHER.teacherCode);
}

/** Monat in `offset` Monaten (aus Sicht des Browsers): { ym: 'JJJJ-MM', title: 'November 2026' } */
async function futureMonth(page, offset) {
  const { y, m } = await page.evaluate((n) => {
    const d = new Date();
    const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
    return { y: t.getFullYear(), m: t.getMonth() };
  }, offset);
  return { ym: `${y}-${String(m + 1).padStart(2, '0')}`, title: `${MONTHS[m]} ${y}` };
}

function sampleClass(overrides = {}) {
  return {
    id: '5a',
    grade: 5,
    letter: 'a',
    codesGenerated: true,
    students: [
      { id: 's1', lastName: 'Beck', firstName: 'Anna', code: '5aA16595316960M11414125311', response: null, appointment: { date: '2026-11-13', start: '15:00', duration: 10 } },
      { id: 's2', lastName: 'Yilmaz', firstName: 'Can', code: '5aA16595316960M3114251291326', response: null, appointment: { date: '2026-11-12', start: '14:00', duration: 10 } },
      { id: 's3', lastName: 'Özdemir', firstName: 'Ela', code: '5aA16595316960M51211', response: null, appointment: null },
    ],
    ...overrides,
  };
}

test('Elternsprechtag erstellen: Kalender, Uhrzeiten, Adresse, Slotlänge → Klassen', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ event: null }));
    await page.goto(`${server.url}#/lehrkraft/elternsprechtag`);
    await page.getByRole('heading', { level: 1, name: 'Elternsprechtag erstellen' }).waitFor();

    // Leerer Zustand und Voreinstellungen
    await page.getByText('Bitte wählen Sie im Kalender mindestens einen Tag aus.').waitFor();
    assert.equal(await page.inputValue(tid('event-slot')), '10');
    assert.equal(await page.inputValue(tid('event-email')), SAMPLE_TEACHER.email);

    // Zwei Monate weiterblättern
    const target = await futureMonth(page, 2);
    await page.click(tid('event-calendar-next'));
    await page.click(tid('event-calendar-next'));
    assert.equal((await page.textContent(`${tid('event-calendar')} .calp-title`)).trim(), target.title);
    // Woche beginnt am Montag
    const heads = await page.$$eval(`${tid('event-calendar')} thead th span[aria-hidden]`, (els) => els.map((e) => e.textContent));
    assert.deepEqual(heads, ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);

    const d1 = `${target.ym}-10`;
    const d2 = `${target.ym}-12`;
    await page.click(day(d1));
    assert.equal(await page.getAttribute(day(d1), 'aria-pressed'), 'true');
    assert.equal(await page.inputValue(tid(`event-day-start-${d1}`)), '14:00');
    assert.equal(await page.inputValue(tid(`event-day-end-${d1}`)), '18:00');
    await page.fill(tid(`event-day-start-${d1}`), '15:00');
    await page.fill(tid(`event-day-end-${d1}`), '18:30');

    // Neuer Tag übernimmt die Zeiten des vorhandenen Tages
    await page.click(day(d2));
    assert.equal(await page.inputValue(tid(`event-day-start-${d2}`)), '15:00');
    assert.equal(await page.inputValue(tid(`event-day-end-${d2}`)), '18:30');
    await page.fill(tid(`event-day-end-${d2}`), '17:00');

    // Tastatur: Pfeil nach rechts wechselt den Tag, Leertaste wählt ihn aus und wieder ab
    await page.focus(day(d2));
    await page.keyboard.press('ArrowRight');
    const d3 = `${target.ym}-13`;
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.date), d3);
    await page.keyboard.press('Space');
    assert.equal(await page.getAttribute(day(d3), 'aria-pressed'), 'true');
    assert.equal(await page.locator('.evt-day').count(), 3);
    await page.keyboard.press('Space');
    assert.equal(await page.getAttribute(day(d3), 'aria-pressed'), 'false');
    assert.equal(await page.locator('.evt-day').count(), 2);

    // Zeiten des ersten Tages übernehmen
    await page.getByRole('button', { name: 'Zeiten des ersten Tages für alle Tage übernehmen' }).click();
    assert.equal(await page.inputValue(tid(`event-day-end-${d2}`)), '18:30');
    await page.fill(tid(`event-day-end-${d2}`), '17:00');

    await page.fill(tid('event-address'), 'Gesamtschule Süd\nSchulstraße 1\n12345 Musterstadt');
    await page.fill(tid('event-slot'), '15');
    // Hinweis zur Anzahl der Termine (15:00–17:00 bei 15 Minuten → 8 Termine)
    await page.locator('.evt-day', { hasText: '8 Termine zu je 15 Minuten' }).waitFor();

    await page.click(tid('event-submit'));
    await page.waitForURL(/#\/lehrkraft\/klassen$/);

    const state = await readState(page);
    assert.deepEqual(state.event, {
      schoolAddress: 'Gesamtschule Süd\nSchulstraße 1\n12345 Musterstadt',
      slotMinutes: 15,
      days: [
        { date: d1, start: '15:00', end: '18:30' },
        { date: d2, start: '15:00', end: '17:00' },
      ],
    });
    assert.equal(state.teacher.email, SAMPLE_TEACHER.email);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Elternsprechtag erstellen: Prüfung der Eingaben', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ event: null, teacher: { ...SAMPLE_TEACHER, email: '' } }));
    await page.goto(`${server.url}#/lehrkraft/elternsprechtag`);
    await page.getByRole('heading', { level: 1, name: 'Elternsprechtag erstellen' }).waitFor();
    const summary = page.locator('.evt-summary');

    // Keine Tage, keine Adresse, keine E-Mail
    await page.click(tid('event-submit'));
    await summary.waitFor({ state: 'visible' });
    const text1 = await summary.textContent();
    assert.match(text1, /mindestens einen Tag/);
    assert.match(text1, /Adresse der Schule/);
    assert.match(text1, /E-Mail-Adresse/);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('evt-summary')), true);
    assert.match(page.url(), /#\/lehrkraft\/elternsprechtag$/);
    assert.equal(await page.getAttribute(tid('event-address'), 'aria-invalid'), 'true');

    // Ende vor Anfang
    const target = await futureMonth(page, 1);
    await page.click(tid('event-calendar-next'));
    const d = `${target.ym}-15`;
    await page.click(day(d));
    await page.fill(tid(`event-day-start-${d}`), '16:00');
    await page.fill(tid(`event-day-end-${d}`), '15:00');
    await page.fill(tid('event-address'), 'Grundschule Nord\nWeg 2\n12345 Musterstadt');
    await page.fill(tid('event-email'), 'keine-adresse');
    await page.click(tid('event-submit'));
    const text2 = await summary.textContent();
    assert.match(text2, /Die Endzeit muss nach der Anfangszeit liegen/);
    assert.match(text2, /gültige E-Mail-Adresse/);
    assert.doesNotMatch(text2, /mindestens einen Tag/);
    assert.equal(await page.getAttribute(tid(`event-day-end-${d}`), 'aria-invalid'), 'true');

    // 14:03 ist kein 5-Minuten-Schritt (Meldung erscheint nach dem ersten Speicherversuch sofort)
    await page.fill(tid(`event-day-start-${d}`), '14:03');
    await page.fill(tid(`event-day-end-${d}`), '18:00');
    await page.fill(tid('event-email'), 'lehrkraft@schule.example');
    await page.locator('.evt-day-error', { hasText: 'Bitte Uhrzeiten in 5-Minuten-Schritten angeben' }).waitFor();
    assert.equal(await page.getAttribute(tid(`event-day-start-${d}`), 'aria-invalid'), 'true');

    // Slotlänge: kein Vielfaches von 5 / zu groß; kein Slot passt in den Tag
    await page.fill(tid(`event-day-start-${d}`), '14:00');
    await page.fill(tid(`event-day-end-${d}`), '14:20');
    await page.fill(tid('event-slot'), '7');
    await page.click(tid('event-submit'));
    assert.match(await summary.textContent(), /Terminlänge in 5-Minuten-Schritten/);
    await page.fill(tid('event-slot'), '30');
    await page.click(tid('event-submit'));
    assert.match(await summary.textContent(), /passt kein Termin von 30 Minuten/);
    await page.fill(tid('event-slot'), '200');
    await page.click(tid('event-submit'));
    assert.match(await summary.textContent(), /zwischen 5 und 120 Minuten/);

    // Klick auf einen Eintrag im Sammelhinweis setzt den Fokus auf das Feld
    await summary.getByRole('button', { name: /Terminlänge/ }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'event-slot');

    assert.equal((await readState(page)).event, null);

    // Alles korrigieren → Speichern klappt
    await page.fill(tid('event-slot'), '10');
    assert.equal(await summary.isVisible(), false);
    await page.click(tid('event-submit'));
    await page.waitForURL(/#\/lehrkraft\/klassen$/);
    const state = await readState(page);
    assert.deepEqual(state.event.days, [{ date: d, start: '14:00', end: '14:20' }]);
    assert.equal(state.event.slotMinutes, 10);
    assert.equal(state.teacher.email, 'lehrkraft@schule.example');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Höchstens 8 Tage', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ event: null }));
    await page.goto(`${server.url}#/lehrkraft/elternsprechtag`);
    const target = await futureMonth(page, 1);
    await page.click(tid('event-calendar-next'));
    for (let i = 1; i <= 9; i++) await page.click(day(`${target.ym}-${String(i).padStart(2, '0')}`));
    await page.locator('.evt-days-error', { hasText: 'höchstens 8 Tage' }).waitFor();
    await page.click(tid('event-submit'));
    assert.match(await page.locator('.evt-summary').textContent(), /höchstens 8 Tage/);
    await page.click(day(`${target.ym}-09`));
    assert.equal(await page.locator('.evt-days-error').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Weitere Einstellungen: Slotlänge ändern, Tag mit Termin entfernen', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass()] }));
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();

    // Hinweis auf bereits erstellte Elternbriefe, Profil
    await page.locator('.alert-warning', { hasText: 'Elternbriefe wurden bereits erstellt' }).waitFor();
    const profile = await page.locator('.evt-profile').textContent();
    for (const part of ['Anna Meier', '15.03.1990', SAMPLE_TEACHER.registrationCode, SAMPLE_TEACHER.teacherCode]) assert.ok(profile.includes(part), part);

    // Vorhandene Werte
    assert.equal(await page.inputValue(tid('event-slot')), '10');
    assert.equal(await page.inputValue(tid('event-day-start-2026-11-13')), '15:00');
    assert.equal(await page.getAttribute(tid('event-submit'), 'type'), 'submit');
    assert.equal((await page.textContent(tid('event-submit'))).trim(), 'Änderungen speichern');

    await page.fill(tid('event-slot'), '15');
    await page.getByText('Sie haben ungespeicherte Änderungen.').waitFor();
    await page.getByRole('button', { name: 'Freitag, 13.11.2026 entfernen' }).click();
    assert.equal(await page.getAttribute(day('2026-11-13'), 'aria-pressed'), 'false');
    assert.equal(await page.locator(tid('event-day-start-2026-11-13')).count(), 0);

    // Abbrechen → nichts gespeichert
    await page.click(tid('event-submit'));
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /1 geplanter Termin/);
    assert.match(await dialog.textContent(), /Anna Beck/);
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    assert.equal((await readState(page)).event.slotMinutes, 10);

    // Bestätigen → gespeichert, Termin gelöscht, auf der Seite bleiben
    await page.click(tid('event-submit'));
    await dialog.getByRole('button', { name: 'Speichern und Termin löschen' }).click();
    await page.locator('.toast', { hasText: 'Einstellungen gespeichert' }).waitFor();
    assert.match(page.url(), /#\/lehrkraft\/einstellungen$/);
    const state = await readState(page);
    assert.equal(state.event.slotMinutes, 15);
    assert.deepEqual(state.event.days, [{ date: '2026-11-12', start: '14:00', end: '18:00' }]);
    const students = state.classes[0].students;
    assert.equal(students.find((s) => s.id === 's1').appointment, null);
    assert.deepEqual(students.find((s) => s.id === 's2').appointment, { date: '2026-11-12', start: '14:00', duration: 10 });
    assert.equal(await page.getByText('Sie haben ungespeicherte Änderungen.').count(), 0);

    // Link zurück zu den Klassen
    assert.equal(await page.getByRole('link', { name: 'Zurück zu den Klassen' }).first().getAttribute('href'), '#/lehrkraft/klassen');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('„Elternsprechtag erstellen“ mit vorhandenem Elternsprechtag verhält sich wie die Einstellungen', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState());
    await page.goto(`${server.url}#/lehrkraft/elternsprechtag`);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();
    assert.equal(await page.getAttribute(day('2026-11-12'), 'aria-pressed'), 'true');
    assert.equal((await page.textContent(`${tid('event-calendar')} .calp-title`)).trim(), 'November 2026');
    // Adresse ändern (ohne Termine) → speichern ohne Rückfrage
    await page.fill(tid('event-address'), 'Neue Schule\nHauptstraße 5\n54321 Neustadt');
    await page.click(tid('event-submit'));
    await page.locator('.toast', { hasText: 'Einstellungen gespeichert' }).waitFor();
    assert.equal((await readState(page)).event.schoolAddress, 'Neue Schule\nHauptstraße 5\n54321 Neustadt');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Weitere Einstellungen: Alle Daten in diesem Browser löschen', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass()] }));
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /Zwischenstand/);
    // Erst abbrechen: Daten bleiben
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    assert.notEqual(await readState(page), null);
    await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).click();
    await dialog.getByRole('button', { name: 'Endgültig löschen' }).click();
    await page.waitForURL((url) => url.hash === '' || url.hash === '#/');
    assert.equal(await readState(page), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('parentsday.session')), null);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Smartphone (390 px): keine waagerechte Scrollleiste, Kalender bedienbar', async () => {
  const { browser, page, errors } = await launch({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  // Tage im nächsten Monat, damit der Test unabhängig vom heutigen Datum ist
  const now = new Date();
  const iso = (d) => toIsoDate(new Date(now.getFullYear(), now.getMonth() + 1, d));
  const event = { schoolAddress: 'Gesamtschule Süd\nSchulstraße 1\n12345 Musterstadt', slotMinutes: 10, days: [{ date: iso(12), start: '14:00', end: '18:00' }, { date: iso(13), start: '15:00', end: '17:00' }] };
  try {
    await seedTeacher(page, server.url, sampleState({ event, classes: [sampleClass()] }));
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `waagerechte Scrollleiste (${overflow}px)`);
    await page.tap(day(iso(19)));
    assert.equal(await page.getAttribute(day(iso(19)), 'aria-pressed'), 'true');
    assert.equal(await page.inputValue(tid(`event-day-start-${iso(19)}`)), '15:00');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

// ---------- Ergänzungen aus der Prüfung ----------

const DRAFT_KEY = `parentsday.eventDraft.${SAMPLE_TEACHER.teacherCode}`;
const readDraft = (page) => page.evaluate((k) => sessionStorage.getItem(k), DRAFT_KEY);

test('Kalender: vergangene Tage gesperrt, heute markiert, Tastatur wechselt den Monat', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState());
    // „Heute“ ist der 18.11.2026 – die gespeicherten Tage 12./13.11. liegen damit in der Vergangenheit.
    await page.clock.setFixedTime(new Date('2026-11-18T10:00:00+01:00'));
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();

    assert.equal(await page.getAttribute(day('2026-11-18'), 'aria-current'), 'date');
    assert.equal(await page.getAttribute(day('2026-11-17'), 'aria-disabled'), 'true');
    assert.equal(await page.getAttribute(day('2026-11-19'), 'aria-disabled'), null);
    // Ausgewählte vergangene Tage bleiben abwählbar
    assert.equal(await page.getAttribute(day('2026-11-12'), 'aria-disabled'), null);
    assert.equal(await page.isDisabled(tid('event-calendar-prev')), true);

    // Gesperrten Tag anklicken → keine Auswahl (force: Playwright wartet sonst wegen aria-disabled)
    await page.click(day('2026-11-17'), { force: true });
    assert.equal(await page.getAttribute(day('2026-11-17'), 'aria-pressed'), 'false');
    assert.equal(await page.locator('.evt-day').count(), 2);

    // Vergangenen ausgewählten Tag abwählen → danach gesperrt
    await page.click(day('2026-11-12'));
    assert.equal(await page.getAttribute(day('2026-11-12'), 'aria-pressed'), 'false');
    assert.equal(await page.getAttribute(day('2026-11-12'), 'aria-disabled'), 'true');
    assert.equal(await page.locator('.evt-day').count(), 1);

    // Tastatur: Bild ab → gleicher Tag im nächsten Monat, Pos1/Ende → Wochenanfang/-ende
    await page.focus(day('2026-11-19'));
    await page.keyboard.press('PageDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.date), '2026-12-19');
    assert.equal((await page.textContent(`${tid('event-calendar')} .calp-title`)).trim(), 'Dezember 2026');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.date), '2026-12-14');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.date), '2026-12-20');
    // Wochenende ist wählbar
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute(day('2026-12-20'), 'aria-pressed'), 'true');
    // Nur ein Tag ist per Tab erreichbar
    assert.equal(await page.locator(`${tid('event-calendar')} button[data-date][tabindex="0"]`).count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('„Weitere Einstellungen“ ohne Elternsprechtag leitet zum Erstellen um', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ event: null }));
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.waitForURL(/#\/lehrkraft\/elternsprechtag$/);
    await page.getByRole('heading', { level: 1, name: 'Elternsprechtag erstellen' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Neuladen mitten im Erstellen: Eingaben bleiben erhalten', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ event: null }));
    await page.goto(`${server.url}#/lehrkraft/elternsprechtag`);
    await page.getByRole('heading', { level: 1, name: 'Elternsprechtag erstellen' }).waitFor();
    const target = await futureMonth(page, 1);
    await page.click(tid('event-calendar-next'));
    const d1 = `${target.ym}-08`;
    const d2 = `${target.ym}-09`;
    await page.click(day(d1));
    await page.click(day(d2));
    await page.fill(tid(`event-day-end-${d2}`), '16:30');
    await page.fill(tid('event-address'), 'Schule am Ümlautweg\nÄußere Straße 3\n12345 Öhringen');
    await page.fill(tid('event-slot'), '15');

    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Elternsprechtag erstellen' }).waitFor();
    await page.locator('.toast', { hasText: 'Ihre bisherigen Eingaben wurden wiederhergestellt.' }).waitFor();
    assert.equal((await page.textContent(`${tid('event-calendar')} .calp-title`)).trim(), target.title);
    assert.equal(await page.getAttribute(day(d1), 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute(day(d2), 'aria-pressed'), 'true');
    assert.equal(await page.inputValue(tid(`event-day-end-${d2}`)), '16:30');
    assert.equal(await page.inputValue(tid('event-address')), 'Schule am Ümlautweg\nÄußere Straße 3\n12345 Öhringen');
    assert.equal(await page.inputValue(tid('event-slot')), '15');
    // Im Speicher der Lehrkraft steht noch nichts
    assert.equal((await readState(page)).event, null);

    await page.click(tid('event-submit'));
    await page.waitForURL(/#\/lehrkraft\/klassen$/);
    assert.deepEqual((await readState(page)).event.days, [
      { date: d1, start: '14:00', end: '18:00' },
      { date: d2, start: '14:00', end: '16:30' },
    ]);
    assert.equal(await readDraft(page), null);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Weitere Einstellungen: ungespeicherte Änderungen bleiben erhalten und lassen sich verwerfen', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState());
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();
    const note = page.getByText('Sie haben ungespeicherte Änderungen.');
    const discard = page.getByRole('button', { name: 'Änderungen verwerfen' });
    assert.equal(await discard.isVisible(), false);

    // „010“ ist dasselbe wie „10“ → keine Änderung
    await page.fill(tid('event-slot'), '010');
    assert.equal(await note.count(), 0);

    await page.fill(tid('event-slot'), '20');
    await page.fill(tid('event-day-end-2026-11-13'), '17:30');
    await note.waitFor();
    assert.equal(await discard.isVisible(), true);

    // Seite verlassen und zurückkehren → Änderungen sind noch da (aber nicht gespeichert)
    await page.getByRole('link', { name: 'Zurück zu den Klassen' }).first().click();
    await page.waitForURL(/#\/lehrkraft\/klassen$/);
    assert.equal((await readState(page)).event.slotMinutes, 10);
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();
    await page.locator('.toast', { hasText: 'noch nicht gespeicherten Änderungen wurden wiederhergestellt' }).waitFor();
    assert.equal(await page.inputValue(tid('event-slot')), '20');
    assert.equal(await page.inputValue(tid('event-day-end-2026-11-13')), '17:30');
    await note.waitFor();

    // Verwerfen → gespeicherter Stand
    await discard.click();
    assert.equal(await page.inputValue(tid('event-slot')), '10');
    assert.equal(await page.inputValue(tid('event-day-end-2026-11-13')), '17:00');
    assert.equal(await note.count(), 0);
    assert.equal(await discard.isVisible(), false);
    assert.equal(await readDraft(page), null);

    // Speichern mit „010“ → danach kein Hinweis auf ungespeicherte Änderungen
    await page.fill(tid('event-slot'), '015');
    await page.click(tid('event-submit'));
    await page.locator('.toast', { hasText: 'Einstellungen gespeichert' }).waitFor();
    assert.equal((await readState(page)).event.slotMinutes, 15);
    assert.equal(await note.count(), 0);
    assert.equal(await readDraft(page), null);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Adresse (Länge), E-Mail (Sonderzeichen) und Hinweis auf neue Elternbriefe', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ classes: [sampleClass()] }));
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();
    const summary = page.locator('.evt-summary');

    await page.fill(tid('event-address'), `Gesamtschule ${'Süd '.repeat(60)}`);
    await page.fill(tid('event-email'), 'lehrkraft?cc=x@schule.example');
    await page.click(tid('event-submit'));
    const text = await summary.textContent();
    assert.match(text, /Die Adresse ist zu lang/);
    assert.match(text, /gültige E-Mail-Adresse/);
    await page.fill(tid('event-address'), 'Zeile 1\nZeile 2\nZeile 3\nZeile 4\nZeile 5\nZeile 6\nZeile 7');
    assert.match(await summary.textContent(), /höchstens 6 Zeilen/);

    await page.fill(tid('event-address'), 'Neue Schule\nHauptstraße 5\n54321 Neustadt');
    await page.fill(tid('event-email'), 'm.mueller-oezdemir+elternsprechtag@schule.example');
    await page.click(tid('event-submit'));
    await page.locator('.toast', { hasText: 'Einstellungen gespeichert' }).waitFor();
    // Klasse 5a hat bereits Elternbriefe → Hinweis, sie neu zu erstellen
    await page.locator('.toast', { hasText: 'Elternbriefe neu' }).waitFor();
    const state = await readState(page);
    assert.equal(state.event.schoolAddress, 'Neue Schule\nHauptstraße 5\n54321 Neustadt');
    assert.equal(state.teacher.email, 'm.mueller-oezdemir+elternsprechtag@schule.example');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Tablet und kleiner Laptop: Datum in einer Zeile, keine waagerechte Scrollleiste', async () => {
  for (const width of [768, 1024, 1280]) {
    const { browser, page, errors } = await launch({ viewport: { width, height: 900 } });
    try {
      await seedTeacher(page, server.url, sampleState());
      await page.goto(`${server.url}#/lehrkraft/einstellungen`);
      await page.getByRole('heading', { level: 1 }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${width}px: waagerechte Scrollleiste (${overflow}px)`);
      const heights = await page.$$eval('.evt-day-title', (els) => els.map((e) => e.getBoundingClientRect().height));
      for (const hgt of heights) assert.ok(hgt < 30, `${width}px: Datum bricht um (${hgt}px)`);
      // Ab Tablet-Breite steht „Entfernen“ als Text am Knopf
      assert.equal(await page.locator('.evt-day-remove-text').first().isVisible(), true, `${width}px`);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
});

test('Namen mit HTML werden als Text angezeigt', async () => {
  const { browser, page, errors } = await launch();
  try {
    const evil = '<img src=x onerror="window.__xss=1">';
    await seedTeacher(page, server.url, sampleState({ teacher: { ...SAMPLE_TEACHER, firstName: evil }, event: { ...sampleState().event, schoolAddress: evil } }));
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();
    assert.ok((await page.locator('.evt-profile').textContent()).includes(evil));
    assert.equal(await page.inputValue(tid('event-address')), evil);
    assert.equal(await page.locator('main img').count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Doppelklick: Tag bleibt ausgewählt, „Entfernen“ entfernt nur einen Tag, Erstellen nur einmal', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState({ event: null }));
    await page.goto(`${server.url}#/lehrkraft/elternsprechtag`);
    await page.getByRole('heading', { level: 1, name: 'Elternsprechtag erstellen' }).waitFor();
    const target = await futureMonth(page, 1);
    await page.click(tid('event-calendar-next'));
    for (const d of ['03', '04', '05']) await page.dblclick(day(`${target.ym}-${d}`));
    for (const d of ['03', '04', '05']) assert.equal(await page.getAttribute(day(`${target.ym}-${d}`), 'aria-pressed'), 'true', d);
    assert.equal(await page.locator('.evt-day').count(), 3);

    // Nach dem Entfernen rückt der nächste Tag nach oben – der zweite Klick darf ihn nicht treffen.
    await page.locator('.evt-day-remove').first().dblclick();
    assert.equal(await page.locator('.evt-day').count(), 2);
    assert.equal(await page.getAttribute(day(`${target.ym}-03`), 'aria-pressed'), 'false');

    await page.fill(tid('event-address'), 'Schule\nWeg 1\n12345 Ort');
    await page.dblclick(tid('event-submit'));
    await page.waitForURL(/#\/lehrkraft\/klassen$/);
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.locator('.toast', { hasText: 'Ihr Elternsprechtag wurde erstellt' }).count(), 1);
    assert.equal((await readState(page)).event.days.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('„Zeiten übernehmen“ mit ungültigen Zeiten am ersten Tag ändert nichts', async () => {
  const { browser, page, errors } = await launch();
  try {
    await seedTeacher(page, server.url, sampleState());
    await page.goto(`${server.url}#/lehrkraft/einstellungen`);
    await page.getByRole('heading', { level: 1, name: 'Weitere Einstellungen' }).waitFor();
    await page.fill(tid('event-day-end-2026-11-12'), '13:00');
    await page.getByRole('button', { name: 'Zeiten des ersten Tages für alle Tage übernehmen' }).click();
    await page.locator('.toast', { hasText: 'Bitte legen Sie zuerst gültige Uhrzeiten' }).waitFor();
    assert.equal(await page.inputValue(tid('event-day-start-2026-11-13')), '15:00');
    assert.equal(await page.inputValue(tid('event-day-end-2026-11-13')), '17:00');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'event-day-start-2026-11-12');
    // Sammelhinweis hat einen zugänglichen Namen
    await page.click(tid('event-submit'));
    await page.getByRole('group', { name: 'Bitte prüfen Sie diese Angabe:' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
