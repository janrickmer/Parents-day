import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCloudKeys,
  cloudWho,
  newDeviceSecret,
  hashOf,
  encryptCloudData,
  decryptCloudData,
  packCloudData,
  unpackCloudData,
  passwordProblem,
  isValidCloudKeys,
  PBKDF2_ITERATIONS,
} from '../../js/core/cloud.js';
import { createTeacherState } from '../../js/core/storage.js';
import { bytesToB64 } from '../../js/core/mailbox.js';
import { startMailboxServer } from '../e2e/mailbox-server.mjs';
import worker from '../../worker/briefkasten.js';

const ORIGIN = 'https://parentsday.janrickmer.de';
const FAST = 1000; // die Durchläufe gehören nicht zum Dienst – für Tests genügen wenige
let srv;
before(async () => {
  srv = await startMailboxServer({ allowedOrigins: [ORIGIN] });
});
after(async () => srv?.close());

const teacher = { firstName: 'Jörg', lastName: 'Müller-Lüdenscheidt', birthDate: '1980-02-29', email: 'j@schule.de', registrationCode: 'x', teacherCode: 'J29021980M' };
let counter = 0;
/** Jede Testlehrkraft ist eine andere (eigene Zähler beim Dienst). */
const someTeacher = () => ({ ...teacher, lastName: `Test${++counter}${Math.random().toString(36).slice(2, 6)}` });

const call = (method, path, { body, token, device, ip = '198.51.100.7' } = {}) =>
  fetch(`${srv.url}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(device ? { 'X-Device': device } : {}),
      'CF-Connecting-IP': ip,
      Origin: ORIGIN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function keysFor(password, who = someTeacher()) {
  return { ...(await deriveCloudKeys(password, who, FAST)), device: newDeviceSecret(), teacher: who };
}

async function create(k, content = { n: 1 }, opts = {}) {
  const data = await encryptCloudData(k, content);
  return call('PUT', `/v1/sync/${k.syncId}`, {
    token: k.authToken,
    body: { baseVersion: 0, who: k.who, authHash: await hashOf(k.authToken), adminHash: await hashOf(k.adminToken), device: await hashOf(k.device), ...data },
    ...opts,
  });
}

async function open(k, device = newDeviceSecret(), opts = {}) {
  return call('POST', `/v1/sync/${k.syncId}/open`, { token: k.authToken, body: { who: k.who, device: await hashOf(device) }, ...opts });
}

test('Schlüssel: aus Passwort und Person, unabhängig von der Schreibweise, alle Werte verschieden', async () => {
  const a = await deriveCloudKeys('Sonne Tafel Kreide 7', teacher, FAST);
  assert.deepEqual(await deriveCloudKeys('Sonne Tafel Kreide 7', { ...teacher, firstName: 'joerg', lastName: 'MUELLER LUEDENSCHEIDT' }, FAST), a);
  assert.match(a.syncId, /^[A-Za-z0-9_-]{32}$/);
  assert.match(a.who, /^[A-Za-z0-9_-]{22}$/);
  for (const key of ['encKey', 'authToken', 'adminToken']) assert.match(a[key], /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set([a.syncId, a.encKey, a.authToken, a.adminToken]).size, 4);
  const other = await deriveCloudKeys('Sonne Tafel Kreide 8', teacher, FAST);
  assert.notEqual(other.syncId, a.syncId, 'anderes Passwort → andere Adresse');
  assert.equal(other.who, a.who, 'who hängt nur von der Person ab');
  const otherPerson = await deriveCloudKeys('Sonne Tafel Kreide 7', { ...teacher, birthDate: '1980-03-01' }, FAST);
  assert.notEqual(otherPerson.syncId, a.syncId, 'gleiches Passwort, andere Person → andere Adresse');
  assert.equal(await cloudWho(teacher), a.who);
  assert.equal(PBKDF2_ITERATIONS, 600000);
  assert.ok(isValidCloudKeys({ ...a, device: newDeviceSecret() }));
  assert.ok(!isValidCloudKeys(a), 'ohne Geräte-Geheimnis unvollständig');
});

test('Passwort: Mindestlänge', () => {
  assert.ok(passwordProblem(''));
  assert.ok(passwordProblem('kurz'));
  assert.ok(passwordProblem('          '));
  assert.equal(passwordProblem('Sonne Tafel Kreide 7'), '');
});

test('Verschlüsselung: nur mit richtigem Schlüssel und zur richtigen Adresse lesbar, komprimiert', async () => {
  const k = await deriveCloudKeys('Sonne Tafel Kreide 7', teacher, FAST);
  const wrong = await deriveCloudKeys('Falsches Passwort 1', teacher, FAST);
  const state = createTeacherState(teacher);
  state.classes = [{ id: '5a', grade: 5, letter: 'a', codesGenerated: false, students: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, firstName: 'Anna', lastName: `Beck${i}`, code: '', response: null, appointment: null })) }];
  const packed = packCloudData(state, { days: [], address: 'Schulweg 1', slot: '10', email: '' });
  const enc = await encryptCloudData(k, packed);
  assert.equal(enc.z, 1);
  assert.ok(!enc.ct.includes('Anna'));
  assert.ok(enc.ct.length < JSON.stringify(packed).length / 2, `${enc.ct.length} vs ${JSON.stringify(packed).length}`);
  const back = unpackCloudData(await decryptCloudData(k, enc));
  assert.equal(back.state.teacher.firstName, 'Jörg');
  assert.equal(back.state.classes[0].students.length, 30);
  assert.equal(back.eventDraft.address, 'Schulweg 1');
  await assert.rejects(() => decryptCloudData(wrong, enc));
  await assert.rejects(() => decryptCloudData({ ...k, syncId: 'B'.repeat(32) }, enc), 'an die Adresse gebunden');
  assert.throws(() => unpackCloudData({ app: 'ParentsDay', type: 'teacher-state' }));
});

test('Dienst: anlegen nur mit passendem Token; mit demselben Passwort gibt es sie nur einmal', async () => {
  const k = await keysFor('Sonne Tafel Kreide 7');
  const other = await keysFor('Anderes Passwort 1');
  const data = await encryptCloudData(k, { n: 1 });
  const mismatch = await call('PUT', `/v1/sync/${k.syncId}`, {
    token: other.authToken,
    body: { baseVersion: 0, who: k.who, authHash: await hashOf(k.authToken), adminHash: await hashOf(k.adminToken), device: await hashOf(k.device), ...data },
  });
  assert.equal(mismatch.status, 400);
  const created = await create(k);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await created.json()).version, 1);
  const again = await create(k);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, 'exists');
  // keine öffentliche Abfrage, ob es eine Sicherung gibt
  assert.equal((await call('GET', `/v1/sync/${k.syncId}/salt`)).status, 404);
});

test('Dienst: öffnen trägt das Gerät ein; abrufen nur mit Token und eingetragenem Gerät', async () => {
  const k = await keysFor('Sonne Tafel Kreide 7');
  await create(k, { n: 1 });
  // Das anlegende Gerät ist eingetragen
  const got = await (await call('GET', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device })).json();
  assert.equal(got.version, 1);
  assert.deepEqual(await decryptCloudData(k, got), { n: 1 });
  assert.deepEqual(await (await call('GET', `/v1/sync/${k.syncId}?since=1`, { token: k.authToken, device: k.device })).json(), { found: true, version: 1, updatedAt: got.updatedAt, unchanged: true });
  // Neues Gerät: erst nach dem Öffnen
  const device2 = newDeviceSecret();
  assert.equal((await call('GET', `/v1/sync/${k.syncId}`, { token: k.authToken, device: device2 })).status, 403);
  const opened = await (await open(k, device2)).json();
  assert.equal(opened.found, true);
  assert.deepEqual(await decryptCloudData(k, opened), { n: 1 });
  assert.equal((await call('GET', `/v1/sync/${k.syncId}`, { token: k.authToken, device: device2 })).status, 200);
  // Falsches Passwort → andere Adresse → nichts gefunden
  const wrong = { ...(await deriveCloudKeys('Falsches Passwort 1', k.teacher, FAST)), device: newDeviceSecret() };
  assert.deepEqual(await (await open(wrong)).json(), { found: false });
  // Ohne Gerät, mit fremdem Token oder unbekannter Adresse: immer dasselbe 403
  for (const res of [
    await call('GET', `/v1/sync/${k.syncId}`, { token: k.authToken }),
    await call('GET', `/v1/sync/${k.syncId}`, { token: wrong.authToken, device: k.device }),
    await call('GET', `/v1/sync/${wrong.syncId}`, { token: wrong.authToken, device: wrong.device }),
  ]) {
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
  }
});

test('Dienst: speichern mit Versionsprüfung', async () => {
  const k = await keysFor('Sonne Tafel Kreide 7');
  await create(k, { n: 1 });
  const next = await encryptCloudData(k, { n: 2 });
  const put = await call('PUT', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device, body: { baseVersion: 1, ...next } });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).version, 2);
  const stale = await call('PUT', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device, body: { baseVersion: 1, ...next } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).version, 2);
  // Ohne eingetragenes Gerät kein Speichern
  assert.equal((await call('PUT', `/v1/sync/${k.syncId}`, { token: k.authToken, device: newDeviceSecret(), body: { baseVersion: 2, ...next } })).status, 403);
  const latest = await (await call('GET', `/v1/sync/${k.syncId}?since=1`, { token: k.authToken, device: k.device })).json();
  assert.deepEqual(await decryptCloudData(k, latest), { n: 2 });
});

test('Dienst: Fehlversuche je Lehrkraft begrenzt – auch bei vielen gleichzeitigen Anfragen', async () => {
  const k = await keysFor('Sonne Tafel Kreide 7');
  await create(k);
  const guesses = await Promise.all(Array.from({ length: 30 }, (_, i) => deriveCloudKeys(`Rateversuch ${i}!!`, k.teacher, FAST)));
  const results = await Promise.all(guesses.map(async (g) => (await open({ ...g }, newDeviceSecret())).status));
  assert.equal(results.filter((s) => s === 200).length, 10, 'höchstens 10 Versuche je Stunde und Anschluss');
  assert.equal(results.filter((s) => s === 429).length, 20);
  // Auch das richtige Passwort wartet jetzt von diesem Anschluss …
  const locked = await open(k);
  assert.equal(locked.status, 429);
  const body = await locked.json();
  assert.equal(body.error, 'locked');
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 3600);
  // … aber ein anderer Anschluss und schon eingetragene Geräte sind nicht betroffen
  assert.equal((await (await open(k, newDeviceSecret(), { ip: '203.0.113.9' })).json()).found, true);
  assert.equal((await call('GET', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device })).status, 200);
  // Gespeichert wird kein Klartext der IP-Adresse
  const rows = srv.db.db.prepare('SELECT key FROM cloud_limits').all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => !r.key.includes('198.51.100.7') && !r.key.includes('203.0.113.9')));
});

test('Dienst: erfolgreiche Versuche zählen nicht, insgesamt höchstens 30 Fehlversuche am Tag', async () => {
  const k = await keysFor('Sonne Tafel Kreide 7');
  await create(k);
  for (let i = 0; i < 12; i++) assert.equal((await (await open(k)).json()).found, true, 'richtiges Passwort beliebig oft');
  let ip = 0;
  const statuses = [];
  for (let i = 0; i < 32; i++) {
    const g = await deriveCloudKeys(`Rateversuch ${i}!!`, k.teacher, FAST);
    statuses.push((await open(g, newDeviceSecret(), { ip: `192.0.2.${++ip}` })).status);
  }
  assert.equal(statuses.filter((s) => s === 200).length, 30);
  assert.equal(statuses.filter((s) => s === 429).length, 2);
});

test('Dienst: löschen nur mit Admin-Token aus dem Passwort und eingetragenem Gerät', async () => {
  const k = await keysFor('Sonne Tafel Kreide 7');
  await create(k);
  assert.equal((await call('DELETE', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device })).status, 403, 'das gespeicherte Token genügt nicht');
  assert.equal((await call('DELETE', `/v1/sync/${k.syncId}`, { token: k.adminToken, device: newDeviceSecret() })).status, 403);
  assert.deepEqual(await (await call('DELETE', `/v1/sync/${k.syncId}`, { token: k.adminToken, device: k.device })).json(), { deleted: true });
  assert.equal((await call('GET', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device })).status, 403);
  assert.equal(Number(srv.db.db.prepare('SELECT COUNT(*) AS n FROM cloud_chunks WHERE sync_id = ?').get(k.syncId).n), 0);
});

test('Dienst: große Stände in Stücken, zu große abgelehnt', async () => {
  const k = await keysFor('Sonne Tafel Kreide 7');
  await create(k);
  const bytes = new Uint8Array(300000); // zufällig → nicht komprimierbar
  for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
  const big = await encryptCloudData(k, { blob: bytesToB64(bytes) });
  assert.ok(big.ct.length > 3 * 90000 && big.ct.length < 720000);
  assert.equal((await call('PUT', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device, body: { baseVersion: 1, ...big } })).status, 200);
  const got = await (await call('GET', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device })).json();
  assert.equal(got.ct, big.ct);
  const small = await encryptCloudData(k, { klein: true });
  assert.equal((await call('PUT', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device, body: { baseVersion: 2, ...small } })).status, 200);
  assert.equal(Number(srv.db.db.prepare('SELECT COUNT(*) AS n FROM cloud_chunks WHERE sync_id = ?').get(k.syncId).n), 1);
  const huge = { iv: small.iv, z: 0, ct: 'A'.repeat(720001) };
  assert.equal((await call('PUT', `/v1/sync/${k.syncId}`, { token: k.authToken, device: k.device, body: { baseVersion: 3, ...huge } })).status, 400);
});

test('Dienst: höchstens 20 neue Sicherungen je Anschluss und Tag', async () => {
  const ip = '198.51.100.99';
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await create(await keysFor(`Passwort Nummer ${i}`), { i }, { ip })).status);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(201));
  assert.equal(statuses[20], 429);
});

test('Dienst: Aufräumen nach 400 Tagen ohne Nutzung, Zähler nach 2 Tagen', async () => {
  const old = await keysFor('Sonne Tafel Kreide 7');
  const recent = await keysFor('Sonne Tafel Kreide 7');
  await create(old);
  await create(recent);
  srv.db.db.prepare('UPDATE cloud SET seen_at = seen_at - ? WHERE sync_id = ?').run(400 * 24 * 3600 * 1000, old.syncId);
  srv.db.db.prepare('UPDATE cloud_limits SET win = win - ?').run(3 * 24 * 3600 * 1000);
  await worker.scheduled({}, srv.env);
  assert.equal((await call('GET', `/v1/sync/${old.syncId}`, { token: old.authToken, device: old.device })).status, 403);
  assert.equal((await call('GET', `/v1/sync/${recent.syncId}`, { token: recent.authToken, device: recent.device })).status, 200);
  assert.equal(Number(srv.db.db.prepare('SELECT COUNT(*) AS n FROM cloud_chunks WHERE sync_id = ?').get(old.syncId).n), 0);
  assert.equal(Number(srv.db.db.prepare('SELECT COUNT(*) AS n FROM cloud_limits').get().n), 0);
});

test('Dienst: unbekannte Pfade, Methoden und CORS', async () => {
  const k = await keysFor('Sonne Tafel Kreide 7');
  assert.equal((await call('GET', `/v1/sync/${k.syncId}/anders`)).status, 404);
  assert.equal((await call('POST', `/v1/sync/${k.syncId}`)).status, 405);
  assert.equal((await call('GET', `/v1/sync/${k.syncId}/open`)).status, 405);
  assert.equal((await call('GET', '/v1/sync/zu-kurz')).status, 404);
  const pre = await fetch(`${srv.url}/v1/sync/${k.syncId}`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Device/);
  const health = await (await call('GET', '/v1/health')).json();
  assert.equal(health.sync, 2);
});
