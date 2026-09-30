import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinutes, fromMinutes, slotStarts, slotsToRanges, normalizeRanges, availabilityStatus, formatDate, weekday, formatRanges } from '../../js/core/time.js';

test('Minuten-Umrechnung', () => {
  assert.equal(toMinutes('14:05'), 845);
  assert.equal(fromMinutes(845), '14:05');
  assert.ok(Number.isNaN(toMinutes('abc')));
});

test('Slots eines Tages', () => {
  assert.deepEqual(slotStarts('14:00', '15:00', 20), [840, 860, 880]);
  assert.deepEqual(slotStarts('14:00', '14:25', 10), [840, 850]);
});

test('Ausgewählte Slots → Zeitspannen', () => {
  assert.deepEqual(slotsToRanges([840, 850, 870], 10), [['14:00', '14:20'], ['14:30', '14:40']]);
  assert.deepEqual(slotsToRanges([], 10), []);
});

test('Zeitspannen zusammenführen', () => {
  assert.deepEqual(normalizeRanges([['15:00', '16:00'], ['14:00', '15:00'], ['17:00', '17:30']]), [[840, 960], [1020, 1050]]);
});

test('Terminfarbe: blau/orange/rot', () => {
  const ranges = [['14:00', '15:00'], ['16:00', '17:00']];
  assert.equal(availabilityStatus(ranges, toMinutes('14:00'), 10), 'ok');
  assert.equal(availabilityStatus(ranges, toMinutes('14:50'), 10), 'ok');
  assert.equal(availabilityStatus(ranges, toMinutes('14:55'), 10), 'partial');
  assert.equal(availabilityStatus(ranges, toMinutes('15:00'), 10), 'unavailable');
  assert.equal(availabilityStatus([], toMinutes('14:00'), 10), 'unavailable');
});

test('Datumsformat', () => {
  assert.equal(formatDate('2026-11-12'), '12.11.2026');
  assert.equal(weekday('2026-11-12'), 'Donnerstag');
  assert.equal(formatRanges([['14:00', '15:30'], ['16:00', '17:00']]), '14:00–15:30, 16:00–17:00 Uhr');
});
