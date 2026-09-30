import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTeacherMailbox, encryptForTeacher, decryptForTeacher, boxIdFromSecret, isValidTeacherMailbox, isValidMailboxRef, bytesToB64 } from '../../js/core/mailbox.js';
import { startMailboxServer } from '../e2e/mailbox-server.mjs';
import worker from '../../worker/briefkasten.js';
import { eventLink, decodeEventParam } from '../../js/core/transport.js';
import { normalizeTeacherState } from '../../js/core/storage.js';

const ORIGIN = 'https://parentsday.janrickmer.de';
let srv;
before(async () => {
  srv = await startMailboxServer({ allowedOrigins: [ORIGIN] });
});
after(async () => srv?.close());

const payload = { app: 'ParentsDay', type: 'parent-response', v: 1, code: '5aA16595316960M11414125311', firstName: 'Anna', lastName: 'Beck', classId: '5a', teacherCode: 'A16595316960M', submittedAt: '2026-10-01T10:00:00.000Z', slotMinutes: 10, availability: { '2026-11-12': [['14:00', '15:30']] } };

const call = (method, path, { body, secret, origin } = {}) =>
  fetch(`${srv.url}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(origin ? { Origin: origin } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

test('Briefkasten der Lehrkraft: Schlüssel, ID und Prüfung', async () => {
  const mb = await createTeacherMailbox();
  assert.ok(isValidTeacherMailbox(mb));
  assert.ok(isValidMailboxRef(mb));
  assert.equal(mb.id, await boxIdFromSecret(mb.secret));
  assert.equal(mb.publicKey.length, 87);
  assert.ok(!isValidTeacherMailbox({ ...mb, secret: 'x' }));
});

test('Ende-zu-Ende-Verschlüsselung: nur der richtige Schlüssel entschlüsselt, Veränderungen fallen auf', async () => {
  const mb = await createTeacherMailbox();
  const other = await createTeacherMailbox();
  const msg = await encryptForTeacher(mb.publicKey, payload);
  assert.deepEqual(await decryptForTeacher(mb.privateKey, msg), payload);
  assert.ok(!JSON.stringify(msg).includes('Anna'));
  await assert.rejects(() => decryptForTeacher(other.privateKey, msg));
  const bytes = Uint8Array.from(atob(msg.ct.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (msg.ct.length % 4)) % 4)), (c) => c.charCodeAt(0));
  bytes[0] ^= 1;
  await assert.rejects(() => decryptForTeacher(mb.privateKey, { ...msg, ct: bytesToB64(bytes) }));
});

test('Dienst: einwerfen, nur mit Geheimnis abholen, leeren', async () => {
  const mb = await createTeacherMailbox();
  const health = await call('GET', '/v1/health');
  assert.equal(health.status, 200);
  const msg = await encryptForTeacher(mb.publicKey, payload);
  const posted = await call('POST', `/v1/boxes/${mb.id}/messages`, { body: msg, origin: ORIGIN });
  assert.equal(posted.status, 201);
  assert.equal(posted.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await call('POST', `/v1/boxes/${mb.id}/messages`, { body: msg, origin: 'https://boese.example' })).headers.get('access-control-allow-origin'), null);
  assert.equal((await call('GET', `/v1/boxes/${mb.id}/messages`)).status, 403);
  const other = await createTeacherMailbox();
  assert.equal((await call('GET', `/v1/boxes/${mb.id}/messages`, { secret: other.secret })).status, 403);
  const list = await (await call('GET', `/v1/boxes/${mb.id}/messages`, { secret: mb.secret })).json();
  assert.equal(list.messages.length, 2);
  assert.deepEqual(await decryptForTeacher(mb.privateKey, list.messages[0]), payload);
  const del = await (await call('DELETE', `/v1/boxes/${mb.id}/messages`, { secret: mb.secret })).json();
  assert.equal(del.deleted, 2);
  assert.equal((await (await call('GET', `/v1/boxes/${mb.id}/messages`, { secret: mb.secret })).json()).messages.length, 0);
});

test('Dienst lehnt kaputte oder zu große Nachrichten ab', async () => {
  const mb = await createTeacherMailbox();
  assert.equal((await call('POST', `/v1/boxes/${mb.id}/messages`, { body: '{kaputt' })).status, 400);
  assert.equal((await call('POST', `/v1/boxes/${mb.id}/messages`, { body: { v: 1, epk: 'x', iv: 'y', ct: 'z' } })).status, 400);
  const big = await encryptForTeacher(mb.publicKey, { ...payload, pad: 'x'.repeat(20000) });
  assert.equal((await call('POST', `/v1/boxes/${mb.id}/messages`, { body: big })).status, 400);
  assert.equal((await call('POST', '/v1/boxes/zu-kurz/messages', { body: {} })).status, 404);
});

test('Verzeichnis: gehört dem ersten Briefkasten', async () => {
  const mb = await createTeacherMailbox();
  const other = await createTeacherMailbox();
  const dirId = mb.id; // beliebige gültige ID
  const entry = { box: mb.id, iv: 'AAAAAAAAAAAAAAAA', ct: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
  assert.equal((await call('PUT', `/v1/directory/${dirId}`, { body: entry })).status, 403);
  assert.equal((await call('PUT', `/v1/directory/${dirId}`, { body: entry, secret: mb.secret })).status, 201);
  assert.equal((await call('PUT', `/v1/directory/${dirId}`, { body: entry, secret: mb.secret })).status, 200);
  assert.equal((await call('PUT', `/v1/directory/${dirId}`, { body: { ...entry, box: other.id }, secret: other.secret })).status, 409);
  assert.deepEqual(await (await call('GET', `/v1/directory/${dirId}`)).json(), { iv: entry.iv, ct: entry.ct });
  // Kein Eintrag: 200 statt 404, damit der Browser der Eltern keinen Fehler in der Konsole meldet
  const missing = await call('GET', `/v1/directory/${other.id}`);
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { found: false });
});

test('Elternbrief-Link enthält Briefkasten-ID und öffentlichen Schlüssel, nie das Geheimnis', async () => {
  const mb = await createTeacherMailbox();
  const state = normalizeTeacherState({
    teacher: { firstName: 'Anna', lastName: 'Meier', birthDate: '1990-03-15', email: 'a@b.de', registrationCode: 'AM60127960', teacherCode: 'A16595316960M' },
    event: { schoolAddress: 'Schule', slotMinutes: 10, days: [{ date: '2026-11-12', start: '14:00', end: '18:00' }] },
    classes: [],
    mailbox: mb,
  });
  assert.ok(state.mailbox && state.mailbox.secret === mb.secret);
  const link = eventLink(state, '5a');
  assert.ok(!link.includes(mb.secret));
  assert.ok(!link.includes(mb.privateKey.d));
  const info = decodeEventParam(new URL(link.replace('#/eltern?', '?')).searchParams.get('e'));
  assert.deepEqual(info.mailbox, { id: mb.id, publicKey: mb.publicKey });
  // Ohne Briefkasten bleibt der Link wie bisher
  const plain = decodeEventParam(new URL(eventLink({ ...state, mailbox: null }, '5a').replace('#/eltern?', '?')).searchParams.get('e'));
  assert.equal(plain.mailbox, undefined);
  // Kaputter Briefkasten im gespeicherten Stand wird verworfen
  assert.equal(normalizeTeacherState({ ...state, mailbox: { ...mb, privateKey: 'x' } }).mailbox, null);
});

const DAY = 24 * 60 * 60 * 1000;

test('Dienst: Briefkasten leeren mit ?before löscht nur, was schon abgeholt wurde', async () => {
  const mb = await createTeacherMailbox();
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', `/v1/boxes/${mb.id}/messages`, { body: await encryptForTeacher(mb.publicKey, payload) })).status, 201);
  // Beide sind vor einer Minute eingegangen; die Lehrkraft holt sie ab
  srv.db.db.prepare('UPDATE messages SET created_at = ? WHERE box_id = ?').run(Date.now() - 60000, mb.id);
  const fetched = (await (await call('GET', `/v1/boxes/${mb.id}/messages`, { secret: mb.secret })).json()).messages;
  assert.equal(fetched.length, 2);
  const newest = Math.max(...fetched.map((m) => m.createdAt));
  // Während der Rückfrage „Briefkasten leeren?“ kommt eine weitere Rückmeldung an
  await call('POST', `/v1/boxes/${mb.id}/messages`, { body: await encryptForTeacher(mb.publicKey, payload) });
  assert.equal((await call('DELETE', `/v1/boxes/${mb.id}/messages?before=abc`, { secret: mb.secret })).status, 400);
  const del = await (await call('DELETE', `/v1/boxes/${mb.id}/messages?before=${newest + 1}`, { secret: mb.secret })).json();
  assert.equal(del.deleted, 2);
  const left = (await (await call('GET', `/v1/boxes/${mb.id}/messages`, { secret: mb.secret })).json()).messages;
  assert.equal(left.length, 1, 'die später eingegangene Rückmeldung bleibt');
  assert.deepEqual(await decryptForTeacher(mb.privateKey, left[0]), payload);
  // Ohne ?before wird alles gelöscht (wie bisher)
  assert.equal((await (await call('DELETE', `/v1/boxes/${mb.id}/messages`, { secret: mb.secret })).json()).deleted, 1);
});

test('Dienst: nach 200 Tagen gelöscht – nicht mehr abrufbar, Cron-Aufräumen, Verzeichnis wird frei', async () => {
  const mb = await createTeacherMailbox();
  const other = await createTeacherMailbox();
  for (let i = 0; i < 2; i++) await call('POST', `/v1/boxes/${mb.id}/messages`, { body: await encryptForTeacher(mb.publicKey, payload) });
  const entry = { box: mb.id, iv: 'AAAAAAAAAAAAAAAA', ct: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
  const dirId = other.id;
  assert.equal((await call('PUT', `/v1/directory/${dirId}`, { body: entry, secret: mb.secret })).status, 201);
  // Eine Nachricht und der Verzeichniseintrag sind 201 Tage alt
  const old = Date.now() - 201 * DAY;
  srv.db.db.prepare('UPDATE messages SET created_at = ? WHERE id = (SELECT id FROM messages WHERE box_id = ? ORDER BY created_at LIMIT 1)').run(old, mb.id);
  srv.db.db.prepare('UPDATE directory SET updated_at = ? WHERE dir_id = ?').run(old, dirId);
  const listed = (await (await call('GET', `/v1/boxes/${mb.id}/messages`, { secret: mb.secret })).json()).messages;
  assert.equal(listed.length, 1, 'alte Rückmeldung wird nicht mehr herausgegeben');
  assert.deepEqual(await (await call('GET', `/v1/directory/${dirId}`)).json(), { found: false }, 'alter Eintrag gilt nicht mehr');

  // Täglicher Cron-Trigger löscht beides aus der Datenbank
  await worker.scheduled({ cron: '17 3 * * *', scheduledTime: Date.now() }, srv.env, { waitUntil() {} });
  const count = (sql, ...args) => Number(srv.db.db.prepare(sql).get(...args).n);
  assert.equal(count('SELECT COUNT(*) AS n FROM messages WHERE box_id = ?', mb.id), 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM directory WHERE dir_id = ?', dirId), 0);

  // Ein veralteter Eintrag blockiert einen neuen Briefkasten nicht mehr (sonst 409)
  assert.equal((await call('PUT', `/v1/directory/${dirId}`, { body: entry, secret: mb.secret })).status, 201);
  srv.db.db.prepare('UPDATE directory SET updated_at = ? WHERE dir_id = ?').run(old, dirId);
  assert.equal((await call('PUT', `/v1/directory/${dirId}`, { body: { ...entry, box: other.id }, secret: other.secret })).status, 200);
  assert.equal(srv.db.db.prepare('SELECT box_id FROM directory WHERE dir_id = ?').get(dirId).box_id, other.id);
  // Ein aktueller Eintrag gehört weiter seinem Briefkasten
  assert.equal((await call('PUT', `/v1/directory/${dirId}`, { body: entry, secret: mb.secret })).status, 409);
});
