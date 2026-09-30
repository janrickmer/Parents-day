// Gesamtablauf mit digitalem Briefkasten durch die echte Oberfläche – der Briefkasten-Dienst
// (worker/briefkasten.js) läuft dafür lokal (mailbox-server.mjs), die Seite wird mit gesetzter MAILBOX_URL
// und passender Content-Security-Policy ausgeliefert:
// Registrierung → Elternsprechtag → Klasse 5a mit 3 Kindern → Codes → Elternbriefe (Briefkasten entsteht,
// QR-Link mit b/p, Verzeichniseintrag) → Eltern 1 per QR-Link am Smartphone und Eltern 2 per Termin-Schlüssel
// senden über den Briefkasten → automatischer Abruf auf der Klassenseite → Briefkasten fällt aus → Eltern 3
// bekommt eine Fehlermeldung und nutzt „Stattdessen per E-Mail senden“ → Lehrkraft lädt die PDF hoch →
// Terminieren → Termin-PDF → Zwischenspeicher mit Briefkasten → neues Gerät: Anmeldung und Zwischenstand laden.
// Bildschirmfotos und gerenderte PDFs zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/full-flow-mailbox.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, launch, captureDownload, pdfPayload, pdfPageCount } from './helpers.mjs';
import { startMailboxServer } from './mailbox-server.mjs';
import { toMinutes } from '../../js/core/time.js';
import { decodeBase64Url, encodeEventKey } from '../../js/core/transport.js';
import { PUBLIC_URL } from '../../js/config.js';

// Ohne UTF-8-Locale ersetzt Chromium unter Linux Dateinamen mit Umlauten durch „download“.
if (!process.env.LC_ALL && !/utf-?8/i.test(process.env.LANG || '')) process.env.LANG = 'C.UTF-8';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const tid = (id) => `[data-testid="${id}"]`;
const flat = (text) => String(text || '').replace(/\s+/g, ' ');
const PX = 3; // Pixel pro Minute in der Terminansicht
const T_CODE = 'A16595316960M';
const TEACHER_EMAIL = 'anna.meier@schule.example';

// Zwei Tage im übernächsten Monat (im Kalender zweimal „weiter“).
const now = new Date();
const target = new Date(now.getFullYear(), now.getMonth() + 2, 1);
const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
const D1 = `${ym}-12`;
const D2 = `${ym}-13`;
const DAYS = { [D1]: { start: '14:00', end: '17:00' }, [D2]: { start: '15:00', end: '17:00' } };

// Einzig erwartete Konsolenmeldung: Chromium meldet Verbindungen zum gestoppten Briefkasten.
const REFUSED = /^console: Failed to load resource: net::ERR_CONNECTION_REFUSED$/;

function readState(page) {
  return page.evaluate((code) => JSON.parse(localStorage.getItem(`parentsday.teacher.${code}`)), T_CODE);
}

function parentState(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('parentsday.parentTab') || 'null'));
}

async function waitForHash(page, hash) {
  await page.waitForFunction((expected) => location.hash === expected, hash);
}

async function waitUntil(predicate, message, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(message);
}

async function shot(page, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: 'disabled' });
}

async function assertNoHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: Seite ist ${overflow}px breiter als der Bildschirm`);
}

/** Text und Link-Ziele jeder PDF-Seite (python3 + pymupdf). */
function pdfPages(file) {
  const script = `
import json, sys, pymupdf
doc = pymupdf.open(sys.argv[1])
print(json.dumps([{'text': p.get_text(), 'links': [k.get('uri', '') for k in p.get_links()]} for p in doc]))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
}

/** Rendert PDF-Seiten als PNG zur Sichtprüfung (nur mit PD_SCREENSHOTS). */
async function renderPdf(file, name, pages) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  const script = `
import sys, pymupdf
doc = pymupdf.open(sys.argv[1])
for i in [int(x) for x in sys.argv[3].split(',')]:
    doc[i if i >= 0 else len(doc) + i].get_pixmap(dpi=100).save(f'{sys.argv[2]}-s{i + 1 if i >= 0 else len(doc) + i + 1}.png')
`;
  execFileSync('python3', ['-c', script, file, path.join(SHOTS, name), pages.join(',')]);
}

/** Link-Daten (Parameter e=) aus einem Elternbrief-Link. */
function linkData(link) {
  return decodeBase64Url(new URL(link.replace('#/eltern?', '?')).searchParams.get('e'));
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

/** Eltern: anmelden und Zeitslots markieren (Smartphone: antippen). */
async function loginAndMark(page, { url, firstName, lastName, code, key, slots, mobile }) {
  const press = (sel) => (mobile ? page.tap(sel) : page.click(sel));
  await page.goto(url);
  await page.fill(tid('parent-firstname'), firstName);
  await page.fill(tid('parent-lastname'), lastName);
  await page.fill(tid('parent-code'), code);
  if (key) await page.fill(tid('parent-key'), key);
  await press(tid('parent-login'));
  await waitForHash(page, '#/eltern/zeiten');
  for (const slot of slots) {
    const btn = tid(`slot-${slot}`);
    await press(btn);
    assert.equal(await page.getAttribute(btn, 'aria-pressed'), 'true', `Slot ${slot} nicht markiert`);
  }
  return press;
}

test('Gesamtablauf mit digitalem Briefkasten: Absenden per Briefkasten, Notlösung per E-Mail, Zwischenstand auf neuem Gerät', { timeout: 240000 }, async () => {
  const mb = await startMailboxServer();
  const web = await startServer({ mailboxUrl: mb.url });
  const mailboxOrigin = new URL(mb.url).origin;
  mb.env.ALLOWED_ORIGINS = new URL(web.url).origin;
  let mailboxRunning = true;
  const stopMailbox = async () => {
    if (!mailboxRunning) return;
    mailboxRunning = false;
    await mb.close();
  };
  const contexts = [];
  const violations = [];
  /** Browser starten; Verstöße gegen die Content-Security-Policy werden gesammelt (am Ende: keine). */
  const open = async (opts) => {
    const ctx = await launch(opts);
    contexts.push(ctx);
    await ctx.context.exposeBinding('reportCspViolation', (_source, v) => violations.push(v));
    await ctx.context.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.reportCspViolation(`${e.violatedDirective} ${e.blockedURI}`)));
    return ctx;
  };
  const messageRows = () => mb.db.db.prepare('SELECT box_id, body FROM messages ORDER BY created_at').all();

  try {
    const teacher = await open();
    const { page } = teacher;

    // ---------- Registrierung (Seite mit Briefkasten und strenger Content-Security-Policy) ----------
    await page.goto(web.url);
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
    const connectSrc = /connect-src ([^;]*)/.exec(csp)?.[1].trim().split(/\s+/);
    assert.deepEqual(connectSrc, ["'self'", mailboxOrigin], 'Verbindungen nur zur eigenen Seite und zum Briefkasten');
    await page.click(tid('start-teacher'));
    // Mit Briefkasten stimmt „ParentsDay hat keinen Server“ nicht mehr
    const note = flat(await page.textContent('.tauth-page .alert-info'));
    assert.match(note, /Beim digitalen Briefkasten liegen nur die Rückmeldungen der Eltern und die Angaben aus Ihren Elternbriefen – verschlüsselt\./);
    assert.doesNotMatch(note, /keinen Server/);
    await page.click(tid('auth-choose-register'));
    assert.match(await page.textContent('.tauth-form'), /als Notlösung, falls der digitale Briefkasten nicht erreichbar ist/);
    await page.fill(tid('reg-firstname'), 'Anna');
    await page.fill(tid('reg-lastname'), 'Meier');
    await page.fill(tid('reg-birthdate'), '1990-03-15');
    await page.fill(tid('reg-email'), TEACHER_EMAIL);
    const reg = await captureDownload(page, () => page.click(tid('reg-submit')));
    assert.equal(reg.filename, 'ParentsDay Registrierung Anna Meier.pdf');
    assert.equal(pdfPayload(reg.buffer).teacherCode, T_CODE);
    assert.equal(pdfPageCount(reg.buffer), 1);
    const regText = flat(pdfPages(reg.file)[0].text);
    assert.match(regText, /Speichern Sie einen Zwischenstand auch gleich nach Ihren ersten Elternbriefen/);
    assert.doesNotMatch(regText, /nicht auf einem Server/);
    await renderPdf(reg.file, 'pdf-registrierung', [0]);
    await page.click(tid('reg-continue'));
    await waitForHash(page, '#/lehrkraft/elternsprechtag');

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
    await page.click(tid('event-submit'));
    await waitForHash(page, '#/lehrkraft/klassen');

    // ---------- Klasse 5a mit drei Kindern und Codes ----------
    await page.selectOption(tid('class-grade'), '5');
    await page.selectOption(tid('class-letter'), 'a');
    await page.click(tid('class-create'));
    await page.click(tid('class-tile-5a'));
    await waitForHash(page, '#/lehrkraft/klasse/5a');
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
    await page.click(tid('primary-action'));
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes('Elternschreiben'), tid('primary-action'));
    // Vor den Elternbriefen gibt es noch keinen Briefkasten
    assert.equal(await page.textContent(tid('mailbox-setup-hint')), 'Der digitale Briefkasten wird eingerichtet, sobald Sie Elternbriefe erstellen.');
    assert.equal((await readState(page)).mailbox, null);

    // ---------- Elternbriefe: Briefkasten entsteht, QR-Link mit b/p, Verzeichniseintrag ----------
    await page.waitForTimeout(800); // Doppelklick-Schutz nach dem Erzeugen der Codes
    const letters = await captureDownload(page, () => page.click(tid('primary-action')));
    assert.equal(letters.filename, 'ParentsDay Elternbriefe Klasse 5a.pdf');
    assert.equal(pdfPageCount(letters.buffer), 3);
    await page.locator(tid('letters-mailbox-note'), { hasText: 'Tipp: Speichern Sie jetzt einen Zwischenstand.' }).waitFor();
    let state = await readState(page);
    const mailbox = state.mailbox;
    assert.match(mailbox?.id || '', /^[A-Za-z0-9_-]{32}$/, 'Briefkasten angelegt');
    assert.match(mailbox.publicKey, /^[A-Za-z0-9_-]{87}$/);
    const dirRows = await waitUntil(() => {
      const list = mb.db.db.prepare('SELECT box_id FROM directory').all();
      return list.length ? list : null;
    }, 'Kein Verzeichniseintrag für den Termin-Schlüssel');
    assert.deepEqual(dirRows.map((r) => r.box_id), [mailbox.id]);
    // Der erste (automatische) Abruf nach dem Einrichten ist durch
    await page.locator(tid('mailbox-last'), { hasText: /Zuletzt abgerufen: \d{2}\.\d{2}\.\d{4}/ }).waitFor();
    assert.equal(await page.locator(tid('letters-directory-note')).count(), 0, 'Verzeichniseintrag ohne Fehler abgelegt');
    await shot(page, 'desktop-1-klasse-nach-elternbriefen');

    const byName = Object.fromEntries(state.classes[0].students.map((s) => [s.firstName, s]));
    const eventKey = encodeEventKey(state.event, { teacherCode: T_CODE, classId: '5a' });
    const letterPages = pdfPages(letters.file);
    assert.equal(letterPages.length, 3);
    const letterOf = {};
    for (const [, firstName] of kids) {
      const kid = byName[firstName];
      const p = letterPages.find((lp) => lp.text.replace(/\s+/g, '').includes(kid.code));
      assert.ok(p, `Elternbrief für ${firstName} mit Code`);
      assert.ok(p.text.replace(/\s+/g, '').includes(eventKey), `Elternbrief für ${firstName}: Termin-Schlüssel`);
      assert.match(flat(p.text), /Klicken Sie auf „Absenden“ – fertig! Ihre Angaben werden verschlüsselt an mich übermittelt\./);
      const qr = p.links.find((l) => l.includes('#/eltern?e='));
      assert.ok(qr, `Elternbrief für ${firstName}: QR-Code verlinkt`);
      const data = linkData(qr);
      assert.equal(data.b, mailbox.id, 'QR-Link enthält die Briefkasten-ID');
      assert.equal(data.p, mailbox.publicKey, 'QR-Link enthält den öffentlichen Schlüssel');
      assert.ok(!qr.includes(mailbox.secret) && !qr.includes(mailbox.privateKey.d), 'weder Geheimnis noch privater Schlüssel im QR-Code');
      assert.ok(qr.startsWith(`${PUBLIC_URL}/#/eltern?e=`));
      letterOf[firstName] = { url: qr.replace(`${PUBLIC_URL}/`, web.url), code: kid.code };
    }
    await renderPdf(letters.file, 'pdf-elternbrief', [0]);

    // ---------- Eltern 1: QR-Link am Smartphone, Absenden über den Briefkasten ----------
    const p1 = await open(MOBILE);
    let p1Downloads = 0;
    p1.page.on('download', () => p1Downloads++);
    await loginAndMark(p1.page, {
      url: letterOf.Anna.url,
      firstName: 'Anna',
      lastName: 'Beck',
      code: letterOf.Anna.code.toLowerCase(),
      slots: [`${D1}-14:00`, `${D1}-14:10`, `${D1}-14:20`, `${D1}-16:00`],
      mobile: true,
    });
    assert.match(await p1.page.textContent('#parent-submit-hint'), /werden Ihre Zeiten verschlüsselt an Anna Meier übermittelt/);
    await assertNoHorizontalScroll(p1.page, 'Eltern 1: Zeiten');
    await p1.page.tap(tid('parent-submit'));
    await waitForHash(p1.page, '#/eltern/fertig');
    const ok1 = p1.page.locator(tid('parent-sent-ok'));
    await ok1.waitFor();
    assert.match(await ok1.textContent(), /Ihre Rückmeldung ist bei Anna Meier angekommen\. Sie müssen nichts weiter tun\./);
    assert.equal(await p1.page.locator(tid('parent-mailto')).count(), 0, 'keine E-Mail nötig');
    assert.equal((await parentState(p1.page)).sentVia, 'mailbox');
    await assertNoHorizontalScroll(p1.page, 'Eltern 1: angekommen');
    await shot(p1.page, 'mobil-1-eltern1-angekommen');

    // ---------- Eltern 2: ohne QR-Code, mit Termin-Schlüssel aus dem Brief (Verzeichnis) ----------
    const p2 = await open();
    let p2Downloads = 0;
    p2.page.on('download', () => p2Downloads++);
    await loginAndMark(p2.page, {
      url: `${web.url}#/eltern`,
      firstName: 'Jörg',
      lastName: 'Mueller', // Umschreibung ü → ue ergibt denselben Code
      code: letterOf.Jörg.code,
      key: eventKey.toLowerCase(),
      slots: ['15:00', '15:10', '15:20', '15:30', '15:40', '15:50'].map((t) => `${D2}-${t}`),
    });
    // Lehrkraft, Schule und Briefkasten kommen aus dem Verzeichniseintrag
    const overview = await p2.page.textContent('.parent-overview');
    assert.ok(overview.includes('Anna Meier') && overview.includes('Gesamtschule Süd'), 'Lehrkraft und Schule aus dem Verzeichnis');
    assert.deepEqual((await parentState(p2.page)).event.mailbox, { id: mailbox.id, publicKey: mailbox.publicKey });
    await p2.page.click(tid('parent-submit'));
    await waitForHash(p2.page, '#/eltern/fertig');
    await p2.page.locator(tid('parent-sent-ok'), { hasText: 'bei Anna Meier angekommen' }).waitFor();
    await shot(p2.page, 'desktop-2-eltern2-angekommen');

    // Im Briefkasten liegen zwei Nachrichten – für den Dienst unlesbar
    const stored = messageRows();
    assert.equal(stored.length, 2);
    assert.ok(stored.every((r) => r.box_id === mailbox.id));
    assert.ok(!JSON.stringify(stored).includes('Beck') && !JSON.stringify(stored).includes(letterOf.Anna.code), 'Dienst sieht keine Namen oder Codes');

    // ---------- Lehrkraft: automatischer Abruf beim Öffnen der Klasse ----------
    await page.reload();
    const avail = async (i) => flat(await rows.nth(i).locator(tid('student-availability')).textContent());
    await rows.nth(1).locator(tid('student-availability')).filter({ hasText: '15:00–16:00' }).waitFor();
    assert.match(await avail(0), /14:00–14:30, 16:00–16:10 Uhr/);
    assert.match(await avail(2), /Rückmeldung der Eltern ausstehend/);
    const report = flat(await page.locator(tid('response-report'), { hasText: 'übernommen' }).innerText());
    assert.match(report, /2 Rückmeldungen aus dem digitalen Briefkasten übernommen: Anna Beck \(5a\), Jörg Müller \(5a\)/);
    state = await readState(page);
    assert.ok(state.mailbox.lastFetchedAt, 'Zeitpunkt des Abrufs gespeichert');
    assert.deepEqual(teacher.errors, [], 'keine Konsolenfehler, solange der Briefkasten läuft');
    assert.equal(p1Downloads + p2Downloads, 0, 'Eltern 1 und 2 mussten nichts herunterladen');

    // ---------- Briefkasten fällt aus: Eltern 3 nutzt die Notlösung per E-Mail ----------
    await stopMailbox();
    const p3 = await open(MOBILE);
    const press3 = await loginAndMark(p3.page, {
      url: letterOf.Ayşe.url,
      firstName: 'Ayşe',
      lastName: 'Çelik',
      code: letterOf.Ayşe.code,
      slots: [`${D2}-16:00`, `${D2}-16:10`],
      mobile: true,
    });
    await press3(tid('parent-submit'));
    const alert = p3.page.locator('.parent-submit-card .alert-error');
    await alert.waitFor();
    const alertText = flat(await alert.textContent());
    assert.match(alertText, /Ihre Rückmeldung konnte gerade nicht übermittelt werden\./);
    assert.match(alertText, /Der digitale Briefkasten ist gerade nicht erreichbar/);
    assert.doesNotMatch(alertText, /fetch|TypeError|undefined|Error/);
    assert.equal(await p3.page.evaluate(() => document.activeElement?.dataset.testid), 'parent-retry');
    await assertNoHorizontalScroll(p3.page, 'Eltern 3: Fehler');
    await shot(p3.page, 'mobil-2-eltern3-fehler');
    const r3 = await captureDownload(p3.page, () => press3(tid('parent-fallback')));
    assert.equal(r3.filename, 'ParentsDay Rückmeldung 5a Çelik Ayşe.pdf');
    const payload3 = pdfPayload(r3.buffer);
    assert.equal(payload3.code, letterOf.Ayşe.code);
    assert.deepEqual(payload3.availability, { [D1]: [], [D2]: [['16:00', '16:20']] });
    await waitForHash(p3.page, '#/eltern/fertig');
    assert.match(await p3.page.textContent('h1'), /Fast geschafft/);
    const mailto = await p3.page.getAttribute(tid('parent-mailto'), 'href');
    assert.ok(mailto.startsWith(`mailto:${TEACHER_EMAIL}?`));
    assert.match(mailto, /PARENTSDAY%5B/);
    assert.equal((await parentState(p3.page)).sentVia, 'email');
    await assertNoHorizontalScroll(p3.page, 'Eltern 3: Fertig per E-Mail');
    await shot(p3.page, 'mobil-3-eltern3-notloesung');
    await renderPdf(r3.file, 'pdf-rueckmeldung-eltern3', [0]);

    // ---------- Lehrkraft lädt die PDF von Eltern 3 hoch ----------
    const teacherErrorsBefore = teacher.errors.length;
    await page.setInputFiles(`${tid('response-upload')} input[type=file]`, r3.file);
    await page.locator(tid('response-report'), { hasText: '1 Rückmeldung übernommen' }).waitFor();
    assert.match(await avail(0), /14:00–14:30, 16:00–16:10 Uhr/);
    assert.match(await avail(1), /15:00–16:00 Uhr/);
    assert.match(await avail(2), /16:00–16:20 Uhr/);
    assert.match(await page.textContent('.tc-resp-count'), /3 von 3 Rückmeldungen eingegangen/);
    await shot(page, 'desktop-3-klasse-alle-rueckmeldungen');
    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalScroll(page, 'Klasse (390 px)');
    await shot(page, 'mobil-4-klasse-alle-rueckmeldungen');
    await page.setViewportSize({ width: 1280, height: 900 });

    // ---------- Terminieren und Termin-PDF ----------
    await page.click(tid('schedule-link'));
    await waitForHash(page, '#/lehrkraft/klasse/5a/terminieren');
    await dragChipTo(page, byName.Anna.id, D1, '14:00');
    await page.waitForSelector(`${tid(`appointment-${byName.Anna.id}`)}[data-status="ok"]`);
    await dragChipTo(page, byName.Jörg.id, D2, '15:00');
    await page.waitForSelector(`${tid(`appointment-${byName.Jörg.id}`)}[data-status="ok"]`);
    await dragChipTo(page, byName.Ayşe.id, D2, '16:10');
    await page.waitForSelector(`${tid(`appointment-${byName.Ayşe.id}`)}[data-status="ok"]`);
    state = await readState(page);
    const appts = Object.fromEntries(state.classes[0].students.map((s) => [s.firstName, s.appointment]));
    assert.deepEqual(appts, {
      Anna: { date: D1, start: '14:00', duration: 10 },
      Jörg: { date: D2, start: '15:00', duration: 10 },
      Ayşe: { date: D2, start: '16:10', duration: 10 },
    });
    await shot(page, 'desktop-4-terminieren');
    const final = await captureDownload(page, () => page.click(tid('schedule-finalize')));
    assert.equal(final.filename, 'ParentsDay Termine Klasse 5a.pdf');
    assert.equal(pdfPageCount(final.buffer), 4); // 3 Terminbestätigungen + Übersicht
    const finalPages = pdfPages(final.file);
    assert.match(flat(finalPages[3].text), /Anna Beck/);
    assert.match(flat(finalPages[3].text), /Ayşe Çelik/);
    await renderPdf(final.file, 'pdf-termine', [0, -1]);

    // ---------- Zwischenspeicher enthält den Briefkasten ----------
    const backup = await captureDownload(page, () => page.click('[data-action="backup-save"]'));
    assert.match(backup.filename, /^Zwischenspeicher vom \d{2}\.\d{2}\.\d{4} um \d{2}꞉\d{2} für ParentsDay\.json$/);
    const saved = JSON.parse(backup.buffer.toString('utf8'));
    for (const key of ['id', 'secret', 'publicKey', 'privateKey', 'createdAt', 'lastFetchedAt']) assert.deepEqual(saved.mailbox[key], state.mailbox[key], `Zwischenspeicher: mailbox.${key}`);
    assert.equal(saved.classes[0].students.filter((s) => s.appointment && s.response).length, 3);

    // ---------- Neues Gerät: Anmeldung per Hand und Zwischenstand laden ----------
    const device = await open();
    const dp = device.page;
    await dp.goto(`${web.url}#/lehrkraft/anmelden`);
    await dp.fill(tid('login-firstname'), 'Anna');
    await dp.fill(tid('login-lastname'), 'Meier');
    await dp.fill(tid('login-birthdate'), '1990-03-15');
    await dp.fill(tid('login-code'), 'am60127960');
    await dp.click(tid('login-submit'));
    await waitForHash(dp, '#/lehrkraft/elternsprechtag');
    await dp.click('[data-action="backup-load"]');
    await dp.setInputFiles('.modal input[type=file]', backup.file);
    await dp.getByRole('button', { name: 'Ja, laden' }).click();
    await waitForHash(dp, '#/lehrkraft/klassen');
    const restored = await readState(dp);
    assert.deepEqual(restored.mailbox, state.mailbox, 'Briefkasten mit Schlüssel wiederhergestellt');
    // Der Briefkasten ist noch gestört: dezenter Hinweis, die Seite bleibt bedienbar
    await dp.locator(tid('mailbox-retry')).waitFor();
    await dp.goto(`${web.url}#/lehrkraft/klasse/5a`);
    await dp.waitForSelector(tid('student-row'));
    assert.equal(await dp.locator(tid('student-row')).count(), 3);
    assert.match(flat(await dp.locator(tid('student-availability')).nth(2).textContent()), /16:00–16:20/);
    assert.match(await dp.textContent(tid('mailbox-last')), /Zuletzt abgerufen: \d{2}\.\d{2}\.\d{4}/);
    await shot(dp, 'desktop-5-neues-geraet');
    // Mit dem geladenen Schlüssel lassen sich die Nachrichten aus dem Briefkasten lesen
    const codes = await dp.evaluate(async (bodies) => {
      const { decryptForTeacher } = await import('./js/core/mailbox.js');
      const { getCurrentState } = await import('./js/core/storage.js');
      const { privateKey } = getCurrentState().mailbox;
      return Promise.all(bodies.map(async (b) => (await decryptForTeacher(privateKey, JSON.parse(b))).code));
    }, stored.map((r) => r.body));
    assert.deepEqual(codes, [letterOf.Anna.code, letterOf.Jörg.code]);
    await dp.click(tid('schedule-link'));
    await dp.waitForSelector(`${tid(`appointment-${byName.Ayşe.id}`)}[data-status="ok"]`);

    // ---------- Keine Konsolenfehler, keine CSP-Verstöße ----------
    assert.deepEqual(p1.errors, []);
    assert.deepEqual(p2.errors, []);
    for (const [label, errors] of [
      ['Lehrkraft', teacher.errors.slice(teacherErrorsBefore)],
      ['Eltern 3', p3.errors],
      ['neues Gerät', device.errors],
    ]) {
      assert.deepEqual(errors.filter((e) => !REFUSED.test(e)), [], `${label}: nur Verbindungsfehler zum gestoppten Briefkasten`);
    }
    assert.ok(p3.errors.some((e) => REFUSED.test(e)), 'Eltern 3 hat den gestoppten Briefkasten versucht');
    assert.deepEqual(violations, []);
  } finally {
    for (const ctx of contexts) await ctx.browser.close();
    await web.close();
    await stopMailbox();
  }
});
