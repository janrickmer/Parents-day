// Hilfen für Browser-Tests (Playwright + Chromium).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findPdfPayloadInText } from '../../js/core/transport.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OUTPUT = path.join(ROOT, 'tests/e2e/output');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Startet einen statischen Webserver für das Projekt. Unbekannte Pfade liefern wie GitHub Pages die 404.html. */
export async function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(ROOT, urlPath);
      if (!file.startsWith(ROOT)) throw new Error('forbidden');
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isDirectory()) file = path.join(file, 'index.html');
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      const page = await fs.readFile(path.join(ROOT, '404.html')).catch(() => null);
      res.writeHead(404, page ? { 'content-type': TYPES['.html'] } : {});
      res.end(page || 'not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) };
}

/** Startet Chromium mit deutscher Sprache/Zeitzone. Sammelt Konsolenfehler in `errors`. */
export async function launch({ viewport = { width: 1280, height: 900 }, hasTouch = false, isMobile = false } = {}) {
  // UTF-8-Locale: sonst ersetzt Chromium Download-Namen mit Umlauten durch „download“.
  // --lang=de-DE: Uhrzeitfelder im 24-Stunden-Format wie bei deutschen Nutzern.
  const browser = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8' }, args: ['--lang=de-DE'] });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport, hasTouch, isMobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  return { browser, context, page, errors };
}

/**
 * Führt `action` aus und wartet auf den dadurch ausgelösten Download.
 * @returns {Promise<{filename:string, file:string, buffer:Buffer}>}
 */
export async function captureDownload(page, action, { timeout = 30000, dir } = {}) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout }), action()]);
  // Eigener Unterordner je Download, damit parallel laufende Tests gleichnamige Dateien nicht überschreiben.
  await fs.mkdir(OUTPUT, { recursive: true });
  const target = dir || (await fs.mkdtemp(path.join(OUTPUT, 'dl-')));
  await fs.mkdir(target, { recursive: true });
  const filename = download.suggestedFilename();
  const file = path.join(target, filename);
  await download.saveAs(file);
  return { filename, file, buffer: await fs.readFile(file) };
}

/** Liest die eingebetteten ParentsDay-Daten aus einem PDF-Buffer. */
export function pdfPayload(buffer) {
  return findPdfPayloadInText(buffer.toString('latin1'));
}

/** Anzahl der Seiten eines (von jsPDF erzeugten) PDFs. */
export function pdfPageCount(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

/** Legt eine angemeldete Lehrkraft direkt im localStorage an (für Tests einzelner Seiten). */
export async function seedTeacher(page, baseUrl, state) {
  await page.goto(baseUrl);
  await page.evaluate((s) => {
    localStorage.setItem(`parentsday.teacher.${s.teacher.teacherCode}`, JSON.stringify(s));
    sessionStorage.setItem('parentsday.session', s.teacher.teacherCode);
  }, state);
}

/** Beispiel-Lehrkraft: Anna Meier, 15.03.1990 */
export const SAMPLE_TEACHER = {
  firstName: 'Anna',
  lastName: 'Meier',
  birthDate: '1990-03-15',
  email: 'anna.meier@schule.example',
  registrationCode: 'AM60127960',
  teacherCode: 'A16595316960M',
};

export function sampleState(overrides = {}) {
  return {
    app: 'ParentsDay',
    type: 'teacher-state',
    version: 1,
    savedAt: new Date().toISOString(),
    teacher: { ...SAMPLE_TEACHER },
    event: {
      schoolAddress: 'Gesamtschule Süd\nSchulstraße 1\n12345 Musterstadt',
      slotMinutes: 10,
      days: [
        { date: '2026-11-12', start: '14:00', end: '18:00' },
        { date: '2026-11-13', start: '15:00', end: '17:00' },
      ],
    },
    classes: [],
    ...overrides,
  };
}
