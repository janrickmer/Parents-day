import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTeacherMailbox, encryptForTeacher, decryptForTeacher, boxIdFromSecret, isValidTeacherMailbox, isValidMailboxRef, bytesToB64 } from '../../js/core/mailbox.js';
import { startMailboxServer } from '../e2e/mailbox-server.mjs';
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
  assert.equal((await call('GET', `/v1/directory/${other.id}`)).status, 404);
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
