// Gesamtablauf durch die echte Oberfläche: Registrierung → Elternsprechtag → Klasse → Codes →
// Elternbriefe → drei Eltern (QR-Link, Termin-Schlüssel, E-Mail-Text) → Rückmeldungen hochladen →
// Terminieren per Drag & Drop → Termin-PDF → Zwischenspeicher → Anmeldung auf „neuem Gerät“ und Wiederherstellen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, captureDownload, pdfPayload, pdfPageCount } from './helpers.mjs';
import { toMinutes } from '../../js/core/time.js';

const tid = (id) => `[data-testid="${id}"]`;
const PX = 3; // Pixel pro Minute in der Terminansicht
const T_CODE = 'A16595316960M';

// Zwei Tage im übernächsten Monat (im Kalender zweimal „weiter“).
const now = new Date();
const target = new Date(now.getFullYear(), now.getMonth() + 2, 1);
const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
const D1 = `${ym}-12`;
const D2 = `${ym}-13`;
const DAYS = { [D1]: { start: '14:00', end: '17:00' }, [D2]: { start: '15:00', end: '17:00' } };

function readState(page) {
  return page.evaluate((code) => JSON.parse(localStorage.getItem(`parentsday.teacher.${code}`)), T_CODE);
}

async function dragChipTo(page, studentId, date, time) {
  const chip = await page.locator(tid(`schedule-student-${studentId}`)).boundingBox();
  const col = await page.locator(tid(`schedule-day-${date}`)).boundingBox();
  const y = col.y + (toMinutes(time) - toMinutes(DAYS[date].start)) * PX + 1;
  await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await page.mouse.down();
  await page.mouse.move(col.x + col.width / 2, y, { steps: 14 });
  await page.mouse.up();
}

async function respond(browserCtx, url, { firstName, lastName, code, key, slots, mobile }) {
  const { page } = browserCtx;
  await page.goto(url);
  await page.fill(tid('parent-firstname'), firstName);
  await page.fill(tid('parent-lastname'), lastName);
  await page.fill(tid('parent-code'), code);
  if (key) await page.fill(tid('parent-key'), key);
  await page.click(tid('parent-login'));
  await page.waitForURL(/#\/eltern\/zeiten$/);
  for (const slot of slots) {
    const btn = page.locator(tid(`slot-${slot}`));
    if (mobile) await btn.tap();
    else await btn.click();
    assert.equal(await btn.getAttribute('aria-pressed'), 'true', `Slot ${slot} nicht markiert`);
  }
  const dl = await captureDownload(page, () => page.click(tid('parent-submit')));
  await page.waitForURL(/#\/eltern\/fertig$/);
  const href = await page.locator(tid('parent-mailto')).getAttribute('href');
  return { dl, payload: pdfPayload(dl.buffer), href };
}

test('Gesamtablauf von der Registrierung bis zum Zwischenspeicher', { timeout: 180000 }, async () => {
  const srv = await startServer();
  const teacher = await launch();
  const parents = [];
  const { page, errors } = teacher;
  try {
    // ---------- Registrierung ----------
    await page.goto(srv.url);
    await page.click(tid('start-teacher'));
    await page.click(tid('auth-choose-register'));
    await page.fill(tid('reg-firstname'), 'Anna');
    await page.fill(tid('reg-lastname'), 'Meier');
    await page.fill(tid('reg-birthdate'), '1990-03-15');
    await page.fill(tid('reg-email'), 'anna.meier@schule.example');
    const reg = await captureDownload(page, () => page.click(tid('reg-submit')));
    assert.equal(reg.filename, 'ParentsDay Registrierung Anna Meier.pdf');
    assert.equal(pdfPayload(reg.buffer).registrationCode, 'AM60127960');
    assert.equal(pdfPayload(reg.buffer).teacherCode, T_CODE);
    assert.equal((await page.textContent(tid('reg-registration-code'))).trim(), 'AM60127960');
    assert.equal((await page.textContent(tid('reg-teacher-code'))).trim(), T_CODE);
    await page.click(tid('reg-continue'));
    await page.waitForURL(/#\/lehrkraft\/elternsprechtag$/);

    // ---------- Elternsprechtag ----------
    await page.click(tid('event-calendar-next'));
    await page.click(tid('event-calendar-next'));
    await page.click(`${tid('event-calendar')} [data-date="${D1}"]`);
    await page.click(`${tid('event-calendar')} [data-date="${D2}"]`);
    for (const [date, { start, end }] of Object.entries(DAYS)) {
      await page.fill(tid(`event-day-start-${date}`), start);
      await page.fill(tid(`event-day-end-${date}`), end);
    }
    await page.fill(tid('event-address'), 'Gesamtschule Süd\nSchulstraße 1\n12345 Musterstadt');
    await page.fill(tid('event-slot'), '10');
    assert.equal(await page.inputValue(tid('event-email')), 'anna.meier@schule.example');
    await page.click(tid('event-submit'));
    await page.waitForURL(/#\/lehrkraft\/klassen$/);
    let state = await readState(page);
    assert.deepEqual(
      state.event.days,
      Object.entries(DAYS).map(([date, d]) => ({ date, ...d })),
    );

    // ---------- Klasse und Lernende ----------
    await page.selectOption(tid('class-grade'), '5');
    await page.selectOption(tid('class-letter'), 'a');
    await page.click(tid('class-create'));
    await page.click(tid('class-tile-5a'));
    await page.waitForURL(/#\/lehrkraft\/klasse\/5a$/);
    const kids = [
      ['Beck', 'Anna'],
      ['Müller', 'Jörg'],
      ['Çelik', 'Ayşe'],
    ];
    const rows = page.locator(tid('student-row'));
    for (let i = 0; i < kids.length; i++) {
      if (i > 0) await page.click(tid('add-student'));
      await rows.nth(i).locator(tid('student-lastname')).fill(kids[i][0]);
      await rows.nth(i).locator(tid('student-firstname')).fill(kids[i][1]);
    }
    assert.equal(await rows.count(), 3);
    assert.equal((await page.textContent(tid('primary-action'))).trim(), 'Alle Lernenden erfolgreich eingetragen');
    await page.click(tid('primary-action'));
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes('Elternschreiben'), tid('primary-action'));
    assert.equal((await rows.nth(0).locator(tid('student-code')).textContent()).trim(), `5a${T_CODE}11414125311`);
    for (let i = 0; i < 3; i++) {
      assert.match(await rows.nth(i).locator(tid('student-availability')).textContent(), /Rückmeldung der Eltern ausstehend/);
    }
    await page.waitForTimeout(800); // Doppelklick-Schutz nach dem Erzeugen der Codes
    const letters = await captureDownload(page, () => page.click(tid('primary-action')));
    assert.equal(letters.filename, 'ParentsDay Elternbriefe Klasse 5a.pdf');
    assert.equal(pdfPageCount(letters.buffer), 3);

    state = await readState(page);
    const cls = state.classes.find((c) => c.id === '5a');
    const byName = Object.fromEntries(cls.students.map((s) => [s.firstName, s]));
    const { link, key } = await page.evaluate(async () => {
      const t = await import('./js/core/transport.js');
      const s = await import('./js/core/storage.js');
      const st = s.getCurrentState();
      return { link: t.eventLink(st, '5a'), key: t.encodeEventKey(st.event) };
    });
    const localLink = link.replace('https://parents-day.janrickmer.de/', srv.url);

    // ---------- Eltern 1: QR-Link, Smartphone ----------
    const p1 = await launch({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    parents.push(p1);
    const r1 = await respond(p1, localLink, {
      firstName: 'Anna',
      lastName: 'Beck',
      code: byName.Anna.code.toLowerCase(),
      slots: [`${D1}-14:00`, `${D1}-14:10`, `${D1}-14:20`, `${D1}-16:00`],
      mobile: true,
    });
    assert.deepEqual(r1.payload.availability, { [D1]: [['14:00', '14:30'], ['16:00', '16:10']], [D2]: [] });
    assert.ok(r1.href.startsWith('mailto:anna.meier@schule.example?'));
    assert.match(r1.href, /PARENTSDAY%5B/);

    // ---------- Eltern 2: ohne Link, mit Termin-Schlüssel ----------
    const p2 = await launch();
    parents.push(p2);
    const r2 = await respond(p2, `${srv.url}#/eltern`, {
      firstName: 'Jörg',
      lastName: 'Mueller', // Umschreibung ü → ue ergibt denselben Code
      code: byName.Jörg.code,
      key,
      slots: ['15:00', '15:10', '15:20', '15:30', '15:40', '15:50'].map((t) => `${D2}-${t}`),
    });
    assert.deepEqual(r2.payload.availability[D2], [['15:00', '16:00']]);

    // ---------- Eltern 3: nur der E-Mail-Text kommt an (PDF vergessen) ----------
    const p3 = await launch();
    parents.push(p3);
    const r3 = await respond(p3, localLink, {
      firstName: 'Ayşe',
      lastName: 'Çelik',
      code: byName.Ayşe.code,
      slots: [`${D2}-16:00`, `${D2}-16:10`],
    });
    const mailBody = new URL(r3.href).searchParams.get('body');
    assert.match(mailBody, /PARENTSDAY\[/);

    // ---------- Rückmeldungen bei der Lehrkraft ----------
    await page.setInputFiles(`${tid('response-upload')} input[type=file]`, [r1.dl.file, r2.dl.file]);
    await page.waitForFunction((sel) => /2 Rückmeldungen übernommen/.test(document.querySelector(sel)?.textContent || ''), tid('response-report'));
    await page.click(tid('response-paste'));
    await page.fill(tid('response-paste-text'), `Von: Eltern\n\n${mailBody}`);
    await page.click(tid('response-paste-submit'));
    await page.waitForFunction((sel) => /1 Rückmeldung übernommen/.test(document.querySelector(sel)?.textContent || ''), tid('response-report'));
    const avail = async (i) => (await rows.nth(i).locator(tid('student-availability')).textContent()).replace(/\s+/g, ' ');
    assert.match(await avail(0), /14:00–14:30, 16:00–16:10 Uhr/);
    assert.match(await avail(1), /15:00–16:00 Uhr/);
    assert.match(await avail(2), /16:00–16:20 Uhr/);

    // ---------- Terminieren ----------
    await page.click(tid('schedule-link'));
    await page.waitForURL(/#\/lehrkraft\/klasse\/5a\/terminieren$/);
    await dragChipTo(page, byName.Anna.id, D1, '14:00');
    await page.waitForSelector(`${tid(`appointment-${byName.Anna.id}`)}[data-status="ok"]`);
    await dragChipTo(page, byName.Jörg.id, D1, '16:00');
    await page.waitForSelector(`${tid(`appointment-${byName.Jörg.id}`)}[data-status="unavailable"]`);
    await dragChipTo(page, byName.Ayşe.id, D2, '16:10');
    await page.waitForSelector(`${tid(`appointment-${byName.Ayşe.id}`)}[data-status="ok"]`);
    assert.match(await page.textContent(tid(`appointment-${byName.Anna.id}`)), /Anna Beck \(10 Min\.\)/);
    // Dauer auf 20 Minuten: ragt über 16:20 hinaus → orange
    await page.click(tid(`appointment-${byName.Ayşe.id}`));
    await page.fill(tid(`appointment-duration-${byName.Ayşe.id}`), '20');
    await page.press(tid(`appointment-duration-${byName.Ayşe.id}`), 'Tab');
    await page.waitForSelector(`${tid(`appointment-${byName.Ayşe.id}`)}[data-status="partial"]`);
    state = await readState(page);
    const appts = Object.fromEntries(state.classes[0].students.map((s) => [s.firstName, s.appointment]));
    assert.deepEqual(appts.Anna, { date: D1, start: '14:00', duration: 10 });
    assert.deepEqual(appts.Jörg, { date: D1, start: '16:00', duration: 10 });
    assert.deepEqual(appts.Ayşe, { date: D2, start: '16:10', duration: 20 });

    const final = await captureDownload(page, () => page.click(tid('schedule-finalize')));
    assert.equal(final.filename, 'ParentsDay Termine Klasse 5a.pdf');
    assert.equal(pdfPageCount(final.buffer), 4); // 3 Terminbestätigungen + Übersicht

    // ---------- Zwischenspeicher ----------
    const backup = await captureDownload(page, () => page.click('[data-action="backup-save"]'));
    assert.match(backup.filename, /^Zwischenspeicher vom \d{2}\.\d{2}\.\d{4} um \d{2}꞉\d{2} für ParentsDay\.json$/);
    const saved = JSON.parse(backup.buffer.toString('utf8'));
    assert.equal(saved.classes[0].students.filter((s) => s.appointment && s.response).length, 3);

    // ---------- „Neues Gerät“: Anmeldung per Hand und Zwischenstand laden ----------
    const device = await launch();
    parents.push(device);
    const dp = device.page;
    await dp.goto(`${srv.url}#/lehrkraft/anmelden`);
    await dp.fill(tid('login-firstname'), 'Anna');
    await dp.fill(tid('login-lastname'), 'Meier');
    await dp.fill(tid('login-birthdate'), '1990-03-15');
    await dp.fill(tid('login-code'), 'am60127960');
    await dp.click(tid('login-submit'));
    await dp.waitForURL(/#\/lehrkraft\/elternsprechtag$/);
    await dp.click('[data-action="backup-load"]');
    await dp.setInputFiles('.modal input[type=file]', backup.file);
    await dp.getByRole('button', { name: 'Ja, laden' }).click();
    await dp.goto(`${srv.url}#/lehrkraft/klasse/5a`);
    await dp.waitForSelector(tid('student-row'));
    assert.equal(await dp.locator(tid('student-row')).count(), 3);
    assert.match((await dp.locator(tid('student-availability')).first().textContent()).replace(/\s+/g, ' '), /14:00–14:30/);
    await dp.click(tid('schedule-link'));
    await dp.waitForSelector(`${tid(`appointment-${byName.Ayşe.id}`)}[data-status="partial"]`);

    for (const ctx of [teacher, ...parents]) assert.deepEqual(ctx.errors, []);
  } finally {
    for (const ctx of parents) await ctx.browser.close();
    await teacher.browser.close();
    await srv.close();
  }
});
