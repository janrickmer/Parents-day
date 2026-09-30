import { test } from 'node:test';
import { PUBLIC_URL } from '../../js/config.js';
import assert from 'node:assert/strict';
import {
  encodeBase64Url, decodeBase64Url, eventLink, decodeEventParam, encodeEventKey, decodeEventKey, canEncodeEventKey,
  buildResponsePayload, encodeResponseText, findResponsesInText, pdfPayloadString, findPdfPayloadInText,
} from '../../js/core/transport.js';

const state = {
  teacher: { firstName: 'Anna', lastName: 'Meier', email: 'anna.meier@schule.de', teacherCode: 'A16595316960M' },
  event: { schoolAddress: 'Gesamtschule Süd\nSchulstraße 1\n12345 Musterstadt', slotMinutes: 10, days: [{ date: '2026-11-12', start: '14:00', end: '18:00' }, { date: '2026-11-13', start: '15:00', end: '19:30' }] },
  classes: [],
};

test('Base64url mit Umlauten', () => {
  const obj = { a: 'Müller ş ł „x“', n: [1, 2] };
  assert.deepEqual(decodeBase64Url(encodeBase64Url(obj)), obj);
  assert.match(encodeBase64Url(obj), /^[A-Za-z0-9_-]+$/);
});

test('Elternbrief-Link enthält alle Termindaten', () => {
  const link = eventLink(state, '5a');
  assert.ok(link.startsWith(`${PUBLIC_URL}/#/eltern?e=`));
  assert.equal(PUBLIC_URL, 'https://parentsday.janrickmer.de');
  const info = decodeEventParam(new URL(link.replace('#/eltern?', '?')).searchParams.get('e'));
  assert.equal(info.teacherName, 'Anna Meier');
  assert.equal(info.teacherEmail, 'anna.meier@schule.de');
  assert.equal(info.teacherCode, 'A16595316960M');
  assert.equal(info.classId, '5a');
  assert.equal(info.slotMinutes, 10);
  assert.deepEqual(info.days, state.event.days);
  assert.equal(info.schoolAddress, state.event.schoolAddress);
  assert.throws(() => decodeEventParam('kaputt!!'));
});

test('Termin-Schlüssel: Hin- und Rückweg, Tippfehler werden erkannt', () => {
  const key = encodeEventKey(state.event);
  assert.match(key, /^[0-9A-Z]{4}(-[0-9A-Z]{1,4})+$/);
  assert.equal(key.replace(/-/g, '').length, 17);
  const info = decodeEventKey(key.toLowerCase());
  assert.deepEqual(info.days, state.event.days);
  assert.equal(info.slotMinutes, 10);
  const chars = key.split('');
  const i = chars.findIndex((c) => c !== '-');
  chars[i] = chars[i] === '0' ? '1' : '0';
  assert.throws(() => decodeEventKey(chars.join('')));
  const one = { slotMinutes: 15, days: [{ date: '2026-11-12', start: '07:55', end: '13:05' }] };
  assert.equal(encodeEventKey(one).replace(/-/g, '').length, 11);
  assert.deepEqual(decodeEventKey(encodeEventKey(one)).days, one.days);
  assert.ok(!canEncodeEventKey({ slotMinutes: 10, days: [{ date: '2026-11-12', start: '14:03', end: '18:00' }] }));
});

test('Rückmeldung als E-Mail-Textblock (auch mit Zeilenumbrüchen)', () => {
  const payload = buildResponsePayload({ code: '5aA16595316960M11414125311', firstName: 'Anna', lastName: 'Beck', classId: '5a', teacherCode: 'A16595316960M', slotMinutes: 10, availability: { '2026-11-12': [['14:00', '15:30']] } });
  const text = encodeResponseText(payload);
  const wrapped = `Hallo,\n\n${text.slice(0, 30)}\n${text.slice(30)}\n\nViele Grüße`;
  const found = findResponsesInText(wrapped);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, payload.code);
  assert.deepEqual(found[0].availability, payload.availability);
});

test('PDF-Datenblock', () => {
  const s = pdfPayloadString({ type: 'x', name: 'Jürgen' });
  assert.deepEqual(findPdfPayloadInText(`/Subject (${s})`), { type: 'x', name: 'Jürgen' });
});

test('Termin-Schlüssel der Elternbriefe passt nur zu Lehrkraft und Klasse aus dem Code', async () => {
  const { teacherCode } = await import('../../js/core/codes.js');
  const owner = { teacherCode: 'A16595316960M', classId: '5a' };
  const key = encodeEventKey(state.event, owner);
  assert.equal(key.replace(/-/g, '').length, 17, 'nicht länger als bisher');
  assert.notEqual(key, encodeEventKey(state.event));
  assert.deepEqual(decodeEventKey(key, owner).days, state.event.days);
  // Zahlendreher im Lehrkräftecode des Kindes oder andere Klasse → verständliche Meldung
  const mismatch = (e) => e.mismatch === true && /Termin-Schlüssel und Code passen nicht zusammen/.test(e.message) && /nach „5a“/.test(e.message);
  assert.throws(() => decodeEventKey(key, { ...owner, teacherCode: 'A16595316690M' }), mismatch);
  assert.throws(() => decodeEventKey(key, { ...owner, classId: '5b' }), (e) => e.mismatch === true);
  // Ohne Code lässt sich ein solcher Schlüssel nicht prüfen
  assert.throws(() => decodeEventKey(key));
  // Tippfehler im Schlüssel selbst
  const raw = key.replace(/-/g, '');
  assert.throws(() => decodeEventKey(raw.slice(0, 9) + (raw[9] === '5' ? '6' : '5') + raw.slice(10), owner));
  // Anfangsbuchstaben tolerant: „l“ statt „I“, „L“/„Z“ statt „Ł“/„Ż“
  const ina = { teacherCode: teacherCode('Ina', 'Lorenz', '1990-03-15'), classId: '5a' };
  const inaKey = encodeEventKey(state.event, ina);
  assert.ok(decodeEventKey(inaKey, { ...ina, teacherCode: `L${ina.teacherCode.slice(1)}` }));
  const lukasz = { teacherCode: teacherCode('Łukasz', 'Żak', '1987-06-24'), classId: '7b' };
  const lukKey = encodeEventKey(state.event, lukasz);
  assert.ok(decodeEventKey(lukKey, { ...lukasz, teacherCode: lukasz.teacherCode.replace('Ł', 'L').replace('Ż', 'Z') }));
  // Ältere Schlüssel (ohne Lehrkraft) bleiben lesbar
  assert.deepEqual(decodeEventKey(encodeEventKey(state.event), owner).days, state.event.days);
});

test('Rückmeldung: Umfang ist begrenzt, ungültige Uhrzeiten werden verworfen', async () => {
  const { validateResponsePayload } = await import('../../js/core/transport.js');
  const availability = {};
  for (let d = 1; d <= 12; d++) availability[`2026-11-${String(d).padStart(2, '0')}`] = Array.from({ length: 400 }, () => ['14:00', '14:10']);
  availability['2026-11-01'].unshift(['25:00', '26:00'], ['x', 'y'], [840, 850], ['15:00', '14:00'], 'kaputt');
  const p = validateResponsePayload({ app: 'ParentsDay', type: 'parent-response', code: '5aA1M1', availability });
  assert.equal(Object.keys(p.availability).length, 8);
  for (const ranges of Object.values(p.availability)) assert.equal(ranges.length, 288);
  assert.deepEqual(p.availability['2026-11-01'][0], ['14:00', '14:10']);
  assert.equal(validateResponsePayload({ app: 'ParentsDay', type: 'parent-response', code: { x: 1 }, availability: {} }), null);
});
