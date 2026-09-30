import { test } from 'node:test';
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
  assert.ok(link.startsWith('https://parents-day.janrickmer.de/#/eltern?e='));
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
