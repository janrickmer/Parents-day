// Einstellungen und Content-Security-Policy passen zusammen: Ist der digitale Briefkasten eingerichtet
// (MAILBOX_URL in js/config.js), muss seine Adresse in index.html bei connect-src stehen – sonst blockiert
// der Browser jede Verbindung, und alle Eltern landen bei der Notlösung per E-Mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { MAILBOX_URL, PUBLIC_URL } from '../../js/config.js';

const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');

function cspDirectives() {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);
  assert.ok(meta, 'index.html enthält eine Content-Security-Policy');
  return Object.fromEntries(
    meta[1]
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name, values]),
  );
}

test('connect-src passt zu MAILBOX_URL', () => {
  const csp = cspDirectives();
  if (!MAILBOX_URL) {
    // Ohne Briefkasten: Verbindungen nur zur eigenen Seite (wie vor dem Briefkasten)
    assert.deepEqual(csp['connect-src'], ["'self'"]);
    return;
  }
  const url = new URL(MAILBOX_URL);
  assert.ok(url.protocol === 'https:' || url.hostname === 'localhost', 'MAILBOX_URL beginnt mit https://');
  assert.doesNotMatch(MAILBOX_URL, /\/v1\/?$|\/$/, 'MAILBOX_URL ohne „/v1“ und ohne Schrägstrich am Ende');
  assert.ok(csp['connect-src'].includes(url.origin), `index.html: ${url.origin} fehlt bei connect-src`);
  assert.ok(csp['connect-src'].includes("'self'"));
});

test('Content-Security-Policy bleibt streng', () => {
  const csp = cspDirectives();
  assert.deepEqual(csp['default-src'], ["'none'"]);
  assert.deepEqual(csp['script-src'], ["'self'"]);
  assert.ok(!Object.values(csp).flat().some((v) => v === '*' || /unsafe/.test(v)), 'keine Platzhalter oder unsafe-*');
  assert.match(PUBLIC_URL, /^https:\/\/[^/]+$/);
});
