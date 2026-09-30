// Verständliche Fehlermeldungen: technische (englische) Meldungen und Fehlernamen sehen die Nutzer nicht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../../js/core/ui.js';

const FALLBACK = 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es noch einmal.';

test('friendlyError: technische Meldungen und DOMException-Namen werden ersetzt, eigene bleiben', () => {
  for (const name of ['DataError', 'OperationError', 'NotSupportedError', 'InvalidAccessError']) {
    assert.equal(friendlyError(new DOMException('', name)), FALLBACK, `${name} ohne Meldung`);
  }
  assert.equal(friendlyError(new Error('OperationError: The operation failed for an operation-specific reason')), FALLBACK);
  assert.equal(friendlyError(new TypeError("Cannot read properties of undefined (reading 'x')")), FALLBACK);
  assert.equal(friendlyError(new Error('')), FALLBACK);
  assert.match(friendlyError(new TypeError('Failed to fetch')), /^Keine Verbindung zum Internet\./);
  for (const own of ['Die Datei ist zu groß für einen ParentsDay-Zwischenspeicher.', 'Der digitale Briefkasten ist gerade nicht erreichbar. Bitte prüfen Sie die Internetverbindung.', 'Keine Lehrkraft angemeldet.']) {
    assert.equal(friendlyError(new Error(own)), own);
  }
  assert.equal(friendlyError(new DOMException('', 'DataError'), 'Eigene Ersatzmeldung.'), 'Eigene Ersatzmeldung.');
});
