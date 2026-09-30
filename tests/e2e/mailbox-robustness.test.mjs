// Browser-Tests: digitaler Briefkasten in Grenzfällen, gegen den echten Dienst (worker/briefkasten.js lokal):
// Zwischenstand laden behält den Schlüssel des Briefkastens, „Briefkasten leeren“ löscht nur Abgeholtes,
// ein Abruf, der bei einem Lehrkraft-Wechsel noch läuft, schreibt nichts in den fremden Stand, und der
// zweite Klick eines Doppelklicks schließt oder bestätigt keinen Dialog.
// Bildschirmfotos zur Sichtprüfung: PD_SCREENSHOTS=/pfad/zum/ordner node --test tests/e2e/mailbox-robustness.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, launch, seedTeacher, sampleState, captureDownload, SAMPLE_TEACHER } from './helpers.mjs';
import { startMailboxServer } from './mailbox-server.mjs';
import { studentCode, teacherCode, registrationCode } from '../../js/core/codes.js';
import { buildResponsePayload } from '../../js/core/transport.js';
import { createTeacherMailbox, encryptForTeacher } from '../../js/core/mailbox.js';

const SHOTS = process.env.PD_SCREENSHOTS || '';
const T_CODE = SAMPLE_TEACHER.teacherCode;
const tid = (id) => `[data-testid="${id}"]`;
const squash = (text) => text.replace(/\s+/g, ' ').trim();

const running = [];
after(async () => {
  for (const close of running) await close().catch(() => {});
});

async function startWithMailbox() {
  const mb = await startMailboxServer();
  const web = await startServer({ mailboxUrl: mb.url });
  mb.env.ALLOWED_ORIGINS = new URL(web.url).origin;
  running.push(() => web.close(), () => mb.close());
  return { mb, web };
}

function kid(firstName, lastName) {
  return { id: `5a-${firstName}`, firstName, lastName, code: studentCode(5, 'a', T_CODE, firstName, lastName), response: null, appointment: null };
}

function stateWith(mailbox, students = [kid('Anna', 'Beck'), kid('Ben', 'Klein')]) {
  return sampleState({ classes: [{ id: '5a', grade: 5, letter: 'a', codesGenerated: true, students }], mailbox });
}

function responsePayload(firstName, lastName) {
  return buildResponsePayload({
    code: studentCode(5, 'a', T_CODE, firstName, lastName),
    firstName,
    lastName,
    classId: '5a',
    teacherCode: T_CODE,
    slotMinutes: 10,
    submittedAt: '2026-10-01T10:00:00.000Z',
    availability: { '2026-11-12': [['14:00', '15:00']] },
  });
}

async function drop(mb, ref, payload) {
  const res = await fetch(`${mb.url}/v1/boxes/${ref.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await encryptForTeacher(ref.publicKey, payload)),
  });
  assert.equal(res.status, 201);
}

const messageCount = (mb) => Number(mb.db.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);

function readState(page, code = T_CODE) {
  return page.evaluate((c) => JSON.parse(localStorage.getItem(`parentsday.teacher.${c}`)), code);
}

async function shotOf(locator, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  await locator.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function backupFile(dir, name, state) {
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify({ ...state, exportedAt: new Date().toISOString() }));
  return file;
}

/** „Zwischenstand laden“ bis zur Rückfrage „Stand ersetzen?“; gibt den Dialog zurück. */
async function openLoad(page, file) {
  await page.click('[data-action="backup-load"]');
  await page.setInputFiles('.modal input[type=file]', file);
  const dialog = page.getByRole('dialog', { name: 'Stand ersetzen?' });
  await dialog.waitFor();
  return dialog;
}

test('Zwischenstand laden: ohne Briefkasten in der Datei bleibt der Briefkasten erhalten, bei einem anderen warnt ParentsDay', async () => {
  const { web } = await startWithMailbox();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parentsday-backup-'));
  running.push(() => fs.rm(dir, { recursive: true, force: true }));
  const { browser, page, errors } = await launch();
  try {
    const own = await createTeacherMailbox();
    await seedTeacher(page, web.url, stateWith(own));
    await page.goto(`${web.url}#/lehrkraft/klassen`);
    await page.locator(tid('class-tile-5a')).waitFor();

    // Älterer Zwischenstand (vor den ersten Elternbriefen): ohne Briefkasten, mit einer Klasse mehr
    const older = stateWith(null);
    older.classes.push({ id: '6b', grade: 6, letter: 'b', codesGenerated: false, students: [] });
    let dialog = await openLoad(page, await backupFile(dir, 'alt.json', older));
    assert.match(squash(await dialog.innerText()), /Ihr digitaler Briefkasten aus diesem Browser bleibt erhalten – der Zwischenstand enthält noch keinen\./);
    await shotOf(dialog, 'dialog-laden-briefkasten-bleibt');
    await dialog.getByRole('button', { name: 'Ja, laden' }).click();
    await page.locator(tid('class-tile-6b')).waitFor();
    let saved = await readState(page);
    assert.equal(saved.mailbox?.id, own.id, 'Briefkasten bleibt');
    assert.equal(saved.mailbox.secret, own.secret);
    assert.deepEqual(saved.mailbox.privateKey.d, own.privateKey.d);

    // Zwischenstand mit einem anderen Briefkasten: Warnung mit „Aktuellen Stand speichern“
    const other = await createTeacherMailbox();
    dialog = await openLoad(page, await backupFile(dir, 'anderer.json', stateWith(other)));
    const text = squash(await dialog.innerText());
    assert.match(text, /Achtung: Dieser Zwischenstand enthält einen anderen digitalen Briefkasten als dieser Browser\./);
    await shotOf(dialog, 'dialog-laden-anderer-briefkasten');
    await page.setViewportSize({ width: 390, height: 844 });
    const fits = await dialog.evaluate((el) => {
      const box = el.querySelector('.alert-warning').getBoundingClientRect();
      const btn = el.querySelector('.alert-warning button').getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && btn.right <= box.right && btn.left >= box.left;
    });
    assert.ok(fits, 'Dialog und Knopf passen auf 390 px');
    await shotOf(dialog, 'dialog-laden-anderer-briefkasten-mobil');
    await page.setViewportSize({ width: 1280, height: 900 });
    const before = await captureDownload(page, () => dialog.getByRole('button', { name: 'Aktuellen Stand speichern' }).click());
    assert.equal(JSON.parse(before.buffer.toString('utf8')).mailbox.id, own.id, 'gesicherter Stand enthält den bisherigen Briefkasten');
    await dialog.getByRole('button', { name: 'Ja, laden' }).click();
    await page.locator('.toast', { hasText: 'Zwischenstand geladen.' }).waitFor();
    saved = await readState(page);
    assert.equal(saved.mailbox.id, other.id, 'Briefkasten aus der Datei gilt');
    assert.equal(saved.classes.length, 1);

    // Gleicher Briefkasten: kein Hinweis
    dialog = await openLoad(page, await backupFile(dir, 'gleich.json', stateWith(other)));
    assert.doesNotMatch(squash(await dialog.innerText()), /Briefkasten/);
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    // Der Verzeichniseintrag für den Termin-Schlüssel gehört dem bisherigen Briefkasten (409) – genau davor warnt der Dialog.
    assert.deepEqual(errors.filter((e) => !/status of 409/.test(e)), []);
  } finally {
    await browser.close();
  }

  // Ohne MAILBOX_URL: kein Wort zum Briefkasten, der Schlüssel geht trotzdem nicht verloren
  const plain = await startServer();
  running.push(() => plain.close());
  const second = await launch();
  try {
    const own = await createTeacherMailbox();
    await seedTeacher(second.page, plain.url, stateWith(own));
    await second.page.goto(`${plain.url}#/lehrkraft/klassen`);
    await second.page.locator(tid('class-tile-5a')).waitFor();
    const dialog = await openLoad(second.page, await backupFile(dir, 'ohne.json', stateWith(null)));
    assert.doesNotMatch(squash(await dialog.innerText()), /Briefkasten/);
    await dialog.getByRole('button', { name: 'Ja, laden' }).click();
    await second.page.locator('.toast', { hasText: 'Zwischenstand geladen.' }).waitFor();
    assert.equal((await readState(second.page)).mailbox?.id, own.id);
    assert.deepEqual(second.errors, []);
  } finally {
    await second.browser.close();
  }
});

test('Briefkasten leeren: Eine Rückmeldung, die während der Rückfrage eingeht, bleibt im Briefkasten', async () => {
  const { mb, web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    const box = await createTeacherMailbox();
    await drop(mb, box, responsePayload('Anna', 'Beck'));
    await drop(mb, box, responsePayload('Zoe', 'Unbekannt'));
    await seedTeacher(page, web.url, stateWith(box));
    await page.goto(`${web.url}#/lehrkraft/einstellungen`);
    const card = page.locator(tid('mailbox-card'));
    await card.locator(tid('mailbox-clear')).click();
    await page.getByRole('dialog', { name: 'Briefkasten leeren?' }).getByRole('button', { name: 'Briefkasten leeren' }).click();
    // Zoes Rückmeldung passt zu keinem Kind: Rückfrage. Währenddessen schickt Bens Familie ihre Rückmeldung.
    const unmatched = page.getByRole('dialog', { name: 'Nicht zugeordnete Rückmeldungen löschen?' });
    await unmatched.waitFor();
    await drop(mb, box, responsePayload('Ben', 'Klein'));
    await unmatched.getByRole('button', { name: 'Trotzdem leeren' }).click();
    await card.locator(tid('mailbox-status')).getByText('2 Rückmeldungen wurden vom Server gelöscht.').waitFor();
    assert.equal(messageCount(mb), 1, 'Bens Rückmeldung ist noch da');

    // Beim nächsten Abruf kommt sie an
    await page.goto(`${web.url}#/lehrkraft/klasse/5a`);
    await page.locator(tid('student-availability')).nth(1).filter({ hasText: '14:00–15:00' }).waitFor();
    assert.ok((await readState(page)).classes[0].students.find((s) => s.firstName === 'Ben').response);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Abruf läuft noch, während eine andere Lehrkraft sich anmeldet: nichts landet in ihrem Stand', async () => {
  const { mb, web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    const boxA = await createTeacherMailbox();
    await drop(mb, boxA, responsePayload('Anna', 'Beck'));
    await seedTeacher(page, web.url, stateWith(boxA));

    // Der Abruf von Frau Meier hängt …
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let requested;
    const hit = new Promise((resolve) => (requested = resolve));
    await page.route(`${mb.url}/v1/boxes/**`, async (route) => {
      requested();
      await gate;
      await route.continue();
    });
    const pending = page.evaluate(async () => {
      const { fetchMailboxResponses } = await import('./js/core/teacher-mailbox.js');
      const r = await fetchMailboxResponses();
      return { applied: r.applied.length, total: r.total, owner: r.state?.teacher.teacherCode };
    });
    await hit;

    // … während sich im selben Tab Herr Kurz anmeldet (Abmelden lädt die Seite nicht neu)
    const b = { firstName: 'Bernd', lastName: 'Kurz', birthDate: '1980-01-02', email: 'b.kurz@schule.example' };
    b.registrationCode = registrationCode(b.firstName, b.lastName, b.birthDate);
    b.teacherCode = teacherCode(b.firstName, b.lastName, b.birthDate);
    const boxB = await createTeacherMailbox();
    const annaB = { ...kid('Anna', 'Beck'), code: studentCode(5, 'a', b.teacherCode, 'Anna', 'Beck') };
    await page.evaluate((s) => {
      localStorage.setItem(`parentsday.teacher.${s.teacher.teacherCode}`, JSON.stringify(s));
      sessionStorage.setItem('parentsday.session', s.teacher.teacherCode);
    }, sampleState({ teacher: b, mailbox: boxB, classes: [{ id: '5a', grade: 5, letter: 'a', codesGenerated: true, students: [annaB] }] }));
    release();
    const result = await pending;
    assert.deepEqual(result, { applied: 0, total: 0, owner: b.teacherCode });
    const stateB = await readState(page, b.teacherCode);
    assert.equal(stateB.classes[0].students[0].response, null, 'Rückmeldung von Frau Meier nicht bei Herrn Kurz');
    assert.equal(stateB.mailbox.lastFetchedAt, undefined, 'kein Abruf bei Herrn Kurz vermerkt');
    const stateA = await readState(page);
    assert.equal(stateA.mailbox.lastFetchedAt, undefined);
    assert.equal(messageCount(mb), 1, 'Rückmeldung wartet weiter auf Frau Meier');
    await page.unroute(`${mb.url}/v1/boxes/**`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Doppelklick öffnet einen Dialog, ohne ihn gleich zu schließen oder zu bestätigen', async () => {
  const { web } = await startWithMailbox();
  const { browser, page, errors } = await launch();
  try {
    const box = await createTeacherMailbox();
    await seedTeacher(page, web.url, stateWith(box));
    await page.goto(`${web.url}#/lehrkraft/einstellungen`);
    const deleteAll = page.getByRole('button', { name: 'Alle Daten in diesem Browser löschen' });
    // Doppelklick auf den Knopf: Der zweite Klick trifft den Hintergrund des Dialogs
    await deleteAll.dblclick();
    const dialog = page.getByRole('dialog', { name: 'Alle Daten in diesem Browser löschen?' });
    await page.waitForTimeout(300);
    assert.equal(await dialog.isVisible(), true, 'Dialog bleibt offen');
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await dialog.waitFor({ state: 'detached' });

    // Trifft der zweite Klick (detail 2) den Knopf „Endgültig löschen“, passiert nichts
    await deleteAll.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Endgültig löschen' }).evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })));
    await page.waitForTimeout(300);
    assert.equal(await dialog.isVisible(), true);
    assert.ok(await readState(page), 'nichts gelöscht');
    // Ein normaler Klick hinter den Dialog schließt ihn weiterhin
    await page.mouse.click(5, 5);
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await readState(page));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
