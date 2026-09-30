// Unit-Test: Farbkontraste nach WCAG 2.2 (Fokusrahmen, Feldränder, kleine Texte).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = (file) => fs.readFileSync(new URL(`../../css/${file}`, import.meta.url), 'utf8');
const base = css('base.css');

function variable(name) {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(base);
  assert.ok(m, `CSS-Variable ${name} fehlt`);
  return m[1];
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('Fokusrahmen: kräftiger Doppelring statt halbtransparentem Schatten', () => {
  const focus = /--focus:\s*([^;]+);/.exec(base)[1];
  assert.match(focus, /var\(--c-surface\).*var\(--c-primary\)/);
  assert.ok(contrast(variable('--c-primary'), variable('--c-bg')) >= 3);
  assert.ok(contrast(variable('--c-primary'), '#ffffff') >= 3);
});

test('Ränder von Eingabefeldern mindestens 3:1', () => {
  assert.ok(contrast(variable('--c-border-strong'), '#ffffff') >= 3);
});

test('Grüne und graue Kleintexte mindestens 4,5:1', () => {
  const green = variable('--c-success-text');
  assert.ok(contrast(green, '#ffffff') >= 4.5);
  assert.ok(contrast(green, variable('--c-success-soft')) >= 4.5);
  assert.match(base, /\.badge-success\s*{[^}]*color:\s*var\(--c-success-text\)/);
  assert.match(css('views/teacher-classes.css'), /\.tcl-status-ready\s*{[^}]*color:\s*var\(--c-success-text\)/);
  const weekend = /\.calp-grid th\.calp-weekend\s*{\s*color:\s*(#[0-9a-fA-F]{6})/.exec(css('views/teacher-event.css'))[1];
  assert.ok(contrast(weekend, '#ffffff') >= 4.5, `Wochenend-Spaltenkopf ${weekend}`);
});
