import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncIdFor,
  deriveCloudKeys,
  authHashOf,
  newSalt,
  encryptCloudData,
  decryptCloudData,
  packCloudData,
  unpackCloudData,
  passwordProblem,
  PBKDF2_ITERATIONS,
} from '../../js/core/cloud.js';
import { createTeacherState } from '../../js/core/storage.js';
import { bytesToB64 } from '../../js/core/mailbox.js';
import { startMailboxServer } from '../e2e/mailbox-server.mjs';
import worker from '../../worker/briefkasten.js';

const ORIGIN = 'https://parentsday.janrickmer.de';
const FAST = 100000; // kleinste erlaubte Zahl an Durchläufen – hält die Tests schnell
let srv;
before(async () => {
  srv = await startMailboxServer({ allowedOrigins: [ORIGIN] });
});
after(async () => srv?.close());

const teacher = { firstName: 'Jörg', lastName: 'Müller-Lüdenscheidt', birthDate: '1980-02-29', email: 'j@schule.de', registrationCode: 'x', teacherCode: 'J29021980M' };

const call = (method, path, { body, token } = {}) =>
  fetch(`${srv.url}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Neue Sicherung mit zufälliger ID: { id, salt, keys, authHash, data } */
async function fresh(password = 'Sonne Tafel Kreide 7', content = { hallo: 'Welt' }) {
  const id = bytesToB64(crypto.getRandomValues(new Uint8Array(24)));
  const salt = newSalt();
  const keys = await deriveCloudKeys(password, salt, FAST);
  const data = await encryptCloudData(keys, id, content);
  return { id, salt, keys, authHash: await authHashOf(keys.authToken), data };
}

async function create(s) {
  return call('PUT', `/v1/sync/${s.id}`, { token: s.keys.authToken, body: { baseVersion: 0, ...s.data, salt: s.salt, iterations: FAST, authHash: s.authHash } });
}

test('ID der Cloud-Sicherung: unabhängig von Schreibweise, abhängig vom Geburtsdatum', async () => {
  const id = await syncIdFor(teacher);
  assert.match(id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(await syncIdFor({ ...teacher, firstName: 'joerg', lastName: 'MUELLER LUEDENSCHEIDT' }), id);
  assert.notEqual(await syncIdFor({ ...teacher, birthDate: '1980-03-01' }), id);
  assert.notEqual(await syncIdFor({ ...teacher, firstName: 'Jörn' }), id);
});

test('Passwort: Mindestlänge und Schlüsselableitung', async () => {
  assert.ok(passwordProblem(''));
  assert.ok(passwordProblem('kurz'));
  assert.ok(passwordProblem('          '));
  assert.equal(passwordProblem('Sonne Tafel Kreide 7'), '');
  assert.equal(PBKDF2_ITERATIONS, 600000);
  const salt = newSalt();
  assert.match(salt, /^[A-Za-z0-9_-]{22}$/);
  const a = await deriveCloudKeys('Sonne Tafel Kreide 7', salt, FAST);
  const b = await deriveCloudKeys('Sonne Tafel Kreide 7', salt, FAST);
  const c = await deriveCloudKeys('Sonne Tafel Kreide 8', salt, FAST);
  assert.deepEqual(a, b);
  assert.notEqual(a.encKey, c.encKey);
  assert.notEqual(a.encKey, a.authToken);
  assert.match(a.authToken, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(() => deriveCloudKeys('x', 'kaputt', FAST));
  await assert.rejects(() => deriveCloudKeys('x', salt, 1000));
});

test('Verschlüsselung: nur mit richtigem Schlüssel und zur richtigen Sicherung lesbar', async () => {
  const salt = newSalt();
  const keys = await deriveCloudKeys('Sonne Tafel Kreide 7', salt, FAST);
  const other = await deriveCloudKeys('Falsches Passwort 1', salt, FAST);
  const state = createTeacherState(teacher);
  state.classes = [{ id: '5a', grade: 5, letter: 'a', codesGenerated: false, students: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, firstName: 'Anna', lastName: `Beck${i}`, code: '', response: null, appointment: null })) }];
  const packed = packCloudData(state, { days: [], address: 'Schulweg 1', slot: '10', email: '' });
  const enc = await encryptCloudData(keys, 'A'.repeat(32), packed);
  assert.equal(enc.z, 1);
  assert.ok(!enc.ct.includes('Anna'));
  // komprimiert deutlich kleiner als der Klartext
  assert.ok(enc.ct.length < JSON.stringify(packed).length / 2, `${enc.ct.length} vs ${JSON.stringify(packed).length}`);
  const back = unpackCloudData(await decryptCloudData(keys, 'A'.repeat(32), enc));
  assert.equal(back.state.teacher.firstName, 'Jörg');
  assert.equal(back.state.classes[0].students.length, 30);
  assert.equal(back.eventDraft.address, 'Schulweg 1');
  await assert.rejects(() => decryptCloudData(other, 'A'.repeat(32), enc));
  await assert.rejects(() => decryptCloudData(keys, 'B'.repeat(32), enc));
  assert.throws(() => unpackCloudData({ app: 'ParentsDay', type: 'teacher-state' }));
});

test('Dienst: anlegen nur mit passendem Token, Salt ist öffentlich', async () => {
  const s = await fresh();
  assert.deepEqual(await (await call('GET', `/v1/sync/${s.id}/salt`)).json(), { found: false });
  assert.deepEqual(await (await call('GET', `/v1/sync/${s.id}`, { token: s.keys.authToken })).json(), { found: false });
  // Token passt nicht zum authHash → abgelehnt
  const other = await fresh();
  const bad = await call('PUT', `/v1/sync/${s.id}`, { token: other.keys.authToken, body: { baseVersion: 0, ...s.data, salt: s.salt, iterations: FAST, authHash: s.authHash } });
  assert.equal(bad.status, 400);
  // zu wenige Durchläufe → abgelehnt
  assert.equal((await call('PUT', `/v1/sync/${s.id}`, { token: s.keys.authToken, body: { baseVersion: 0, ...s.data, salt: s.salt, iterations: 1000, authHash: s.authHash } })).status, 400);
  const created = await create(s);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await created.json()).version, 1);
  assert.equal((await create(s)).status, 409); // gibt es schon
  assert.equal((await create(await fresh())).status, 201);
  const info = await (await call('GET', `/v1/sync/${s.id}/salt`)).json();
  assert.deepEqual(info, { found: true, salt: s.salt, iterations: FAST });
});

test('Dienst: abrufen, unverändert, aktualisieren, Konflikt', async () => {
  const s = await fresh('Sonne Tafel Kreide 7', { n: 1 });
  await create(s);
  const got = await (await call('GET', `/v1/sync/${s.id}`, { token: s.keys.authToken })).json();
  assert.equal(got.version, 1);
  assert.deepEqual(await decryptCloudData(s.keys, s.id, got), { n: 1 });
  assert.deepEqual(await (await call('GET', `/v1/sync/${s.id}?since=1`, { token: s.keys.authToken })).json(), { found: true, version: 1, updatedAt: got.updatedAt, unchanged: true });
  const next = await encryptCloudData(s.keys, s.id, { n: 2 });
  const put = await call('PUT', `/v1/sync/${s.id}`, { token: s.keys.authToken, body: { baseVersion: 1, ...next } });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).version, 2);
  // Veralteter Stand → 409 mit aktueller Version
  const stale = await call('PUT', `/v1/sync/${s.id}`, { token: s.keys.authToken, body: { baseVersion: 1, ...next } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).version, 2);
  const latest = await (await call('GET', `/v1/sync/${s.id}?since=1`, { token: s.keys.authToken })).json();
  assert.deepEqual(await decryptCloudData(s.keys, s.id, latest), { n: 2 });
});

test('Dienst: große Stände werden in Stücken gespeichert, zu große abgelehnt', async () => {
  const s = await fresh();
  await create(s);
  const bytes = new Uint8Array(300000); // zufällig → nicht komprimierbar
  for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
  const big = await encryptCloudData(s.keys, s.id, { blob: bytesToB64(bytes) });
  assert.ok(big.ct.length > 3 * 90000);
  assert.equal((await call('PUT', `/v1/sync/${s.id}`, { token: s.keys.authToken, body: { baseVersion: 1, ...big } })).status, 200);
  const got = await (await call('GET', `/v1/sync/${s.id}`, { token: s.keys.authToken })).json();
  assert.equal(got.ct, big.ct);
  // wieder klein: überzählige Stücke verschwinden
  const small = await encryptCloudData(s.keys, s.id, { klein: true });
  assert.equal((await call('PUT', `/v1/sync/${s.id}`, { token: s.keys.authToken, body: { baseVersion: 2, ...small } })).status, 200);
  const chunks = srv.db.db.prepare('SELECT COUNT(*) AS n FROM sync_chunks WHERE sync_id = ?').get(s.id);
  assert.equal(Number(chunks.n), 1);
  assert.deepEqual(await decryptCloudData(s.keys, s.id, await (await call('GET', `/v1/sync/${s.id}`, { token: s.keys.authToken })).json()), { klein: true });
  const huge = { iv: small.iv, z: 0, ct: 'A'.repeat(20 * 90000 + 10) };
  assert.equal((await call('PUT', `/v1/sync/${s.id}`, { token: s.keys.authToken, body: { baseVersion: 3, ...huge } })).status, 400);
});

test('Dienst: nach 10 falschen Passwörtern gesperrt – auch für das richtige', async () => {
  const s = await fresh();
  await create(s);
  const wrong = await deriveCloudKeys('Falsches Passwort 1', s.salt, FAST);
  for (let i = 0; i < 10; i++) assert.equal((await call('GET', `/v1/sync/${s.id}`, { token: wrong.authToken })).status, 403);
  const locked = await call('GET', `/v1/sync/${s.id}`, { token: s.keys.authToken });
  assert.equal(locked.status, 429);
  const body = await locked.json();
  assert.equal(body.error, 'locked');
  assert.ok(body.retryAfter > 3000 && body.retryAfter <= 3600);
  // nach Ablauf der Stunde wieder möglich
  srv.db.db.prepare('UPDATE sync SET fail_since = fail_since - 3600001 WHERE sync_id = ?').run(s.id);
  assert.equal((await call('GET', `/v1/sync/${s.id}`, { token: s.keys.authToken })).status, 200);
  assert.equal(Number(srv.db.db.prepare('SELECT fails FROM sync WHERE sync_id = ?').get(s.id).fails), 0);
});

test('Dienst: Passwort ändern – altes Token gilt danach nicht mehr', async () => {
  const s = await fresh('Sonne Tafel Kreide 7', { n: 1 });
  await create(s);
  const salt = newSalt();
  const keys = await deriveCloudKeys('Neues Passwort 2026', salt, FAST);
  const data = await encryptCloudData(keys, s.id, { n: 1 });
  const res = await call('PUT', `/v1/sync/${s.id}`, { token: s.keys.authToken, body: { baseVersion: 1, ...data, salt, iterations: FAST, authHash: await authHashOf(keys.authToken) } });
  assert.equal(res.status, 200);
  assert.equal((await call('GET', `/v1/sync/${s.id}`, { token: s.keys.authToken })).status, 403);
  const got = await (await call('GET', `/v1/sync/${s.id}`, { token: keys.authToken })).json();
  assert.deepEqual(await decryptCloudData(keys, s.id, got), { n: 1 });
  assert.equal((await (await call('GET', `/v1/sync/${s.id}/salt`)).json()).salt, salt);
});

test('Dienst: „Passwort vergessen“ ersetzt die Sicherung, höchstens dreimal am Tag', async () => {
  const s = await fresh('Sonne Tafel Kreide 7', { alt: true });
  await create(s);
  for (let i = 0; i < 3; i++) {
    const n = await fresh(`Neues Passwort ${i}!!`, { neu: i });
    const res = await call('POST', `/v1/sync/${s.id}/reset`, { token: n.keys.authToken, body: { ...(await encryptCloudData(n.keys, s.id, { neu: i })), salt: n.salt, iterations: FAST, authHash: n.authHash } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, i + 2);
    const got = await (await call('GET', `/v1/sync/${s.id}`, { token: n.keys.authToken })).json();
    assert.deepEqual(await decryptCloudData(n.keys, s.id, got), { neu: i });
  }
  assert.equal((await call('GET', `/v1/sync/${s.id}`, { token: s.keys.authToken })).status, 403);
  const n = await fresh('Noch ein Passwort', {});
  const blocked = await call('POST', `/v1/sync/${s.id}/reset`, { token: n.keys.authToken, body: { ...(await encryptCloudData(n.keys, s.id, {})), salt: n.salt, iterations: FAST, authHash: n.authHash } });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, 'too-many-resets');
  // Token muss zum authHash passen
  const mismatch = await call('POST', `/v1/sync/${s.id}/reset`, { token: s.keys.authToken, body: { ...(await encryptCloudData(n.keys, s.id, {})), salt: n.salt, iterations: FAST, authHash: n.authHash } });
  assert.equal(mismatch.status, 400);
});

test('Dienst: löschen nur mit Token; Aufräumen nach 400 Tagen ohne Nutzung', async () => {
  const s = await fresh();
  await create(s);
  const other = await fresh();
  assert.equal((await call('DELETE', `/v1/sync/${s.id}`, { token: other.keys.authToken })).status, 403);
  assert.deepEqual(await (await call('DELETE', `/v1/sync/${s.id}`, { token: s.keys.authToken })).json(), { deleted: true });
  assert.deepEqual(await (await call('GET', `/v1/sync/${s.id}/salt`)).json(), { found: false });
  assert.equal(Number(srv.db.db.prepare('SELECT COUNT(*) AS n FROM sync_chunks WHERE sync_id = ?').get(s.id).n), 0);

  const old = await fresh();
  await create(old);
  const recent = await fresh();
  await create(recent);
  srv.db.db.prepare('UPDATE sync SET seen_at = seen_at - ? WHERE sync_id = ?').run(400 * 24 * 3600 * 1000, old.id);
  await worker.scheduled({}, srv.env);
  assert.deepEqual(await (await call('GET', `/v1/sync/${old.id}/salt`)).json(), { found: false });
  assert.equal((await (await call('GET', `/v1/sync/${recent.id}/salt`)).json()).found, true);
  assert.equal(Number(srv.db.db.prepare('SELECT COUNT(*) AS n FROM sync_chunks WHERE sync_id = ?').get(old.id).n), 0);
});

test('Dienst: unbekannte Pfade und Methoden', async () => {
  const s = await fresh();
  assert.equal((await call('GET', `/v1/sync/${s.id}/anders`)).status, 404);
  assert.equal((await call('POST', `/v1/sync/${s.id}`)).status, 405);
  assert.equal((await call('GET', '/v1/sync/zu-kurz/salt')).status, 404);
  const health = await (await call('GET', '/v1/health')).json();
  assert.equal(health.sync, true);
});
