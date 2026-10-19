// Bilder der Startseite (img/start/*.webp) neu aufnehmen: echte Bildschirmfotos von ParentsDay mit Beispieldaten
// und Ausschnitte aus den erzeugten PDFs (Elternbrief, Terminbestätigung). Läuft gegen den lokalen Testserver; der
// Elternbrief mit Briefkasten entsteht mit einer Briefkasten-Adresse, die nirgends hinführt – es gibt keine
// Verbindung zum echten Dienst.
//
//   node tools/startseite-bilder.mjs            → schreibt nach img/start/
//   node tools/startseite-bilder.mjs <ordner>   → schreibt in einen anderen Ordner
//
// Braucht Playwright (devDependency) und Python mit PyMuPDF (für die PDF-Ausschnitte).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer, seedTeacher, sampleState, SAMPLE_TEACHER } from '../tests/e2e/helpers.mjs';
import { studentCode } from '../js/core/codes.js';

// Deutsche Browser-Oberfläche: Zeitfelder zeigen 14:00 statt 02:00 PM
const browser = await chromium.launch({ args: ['--lang=de-DE'], env: { ...process.env, LANGUAGE: 'de_DE', LANG: 'de_DE.UTF-8' } });
const newPage = (opts) => browser.newPage({ locale: 'de-DE', timezoneId: 'Europe/Berlin', reducedMotion: 'reduce', ...opts });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'img/start'));
const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'parentsday-bilder-'));
await fs.mkdir(out, { recursive: true });

const T = SAMPLE_TEACHER.teacherCode;
const D1 = '2026-11-12'; // Donnerstag
const D2 = '2026-11-13'; // Freitag
const resp = (availability) => ({ submittedAt: '2026-10-28T17:30:00.000Z', availability });
const kid = (g, l, id, first, last, extra = {}) => ({ id, firstName: first, lastName: last, code: studentCode(g, l, T, first, last), response: null, appointment: null, ...extra });
const appt = (date, start, duration = 10) => ({ date, start, duration });

function richState() {
  return sampleState({
    event: {
      schoolAddress: 'Gesamtschule Süd\nSchulstraße 1\n12345 Musterstadt',
      slotMinutes: 10,
      days: [
        { date: D1, start: '14:00', end: '17:00' },
        { date: D2, start: '15:00', end: '17:00' },
      ],
    },
    classes: [
      {
        id: '5a',
        grade: 5,
        letter: 'a',
        codesGenerated: true,
        students: [
          kid(5, 'a', 's1', 'Anna', 'Beck', { response: resp({ [D1]: [['14:00', '15:00']] }), appointment: appt(D1, '14:00') }),
          kid(5, 'a', 's2', 'Jörg', 'Müller', { response: resp({ [D1]: [['14:20', '14:40']] }), appointment: appt(D1, '14:20') }),
          kid(5, 'a', 's3', 'Ayşe', 'Çelik', { response: resp({ [D1]: [['14:30', '15:30']], [D2]: [['15:00', '16:00']] }), appointment: appt(D1, '14:30') }),
          kid(5, 'a', 's4', 'Lina', 'Schulz', { response: resp({ [D1]: [['14:50', '15:20']] }), appointment: appt(D1, '14:50') }),
          kid(5, 'a', 's5', 'Mats', 'Krüger', { response: resp({ [D1]: [['15:10', '15:20']] }), appointment: appt(D1, '15:10', 20) }),
          kid(5, 'a', 's6', 'Paul', 'Wagner', { response: resp({ [D1]: [['16:00', '17:00']] }), appointment: appt(D1, '15:40') }),
          kid(5, 'a', 's7', 'Mia', 'Neumann', { response: resp({ [D1]: [['15:30', '16:30']] }) }),
          kid(5, 'a', 's8', 'Can', 'Yilmaz', { response: resp({ [D2]: [['15:00', '16:00']] }), appointment: appt(D2, '15:00') }),
          kid(5, 'a', 's9', 'Ela', 'Özdemir'),
          kid(5, 'a', 's10', 'Tom', 'Richter', { response: resp({ [D1]: [['16:00', '16:30']] }), appointment: appt(D1, '16:10') }),
          kid(5, 'a', 's11', 'Lea', 'Hoffmann', { response: resp({ [D2]: [['16:00', '17:00']] }) }),
          kid(5, 'a', 's12', 'Ben', 'Schäfer'),
        ],
      },
      {
        id: '7c',
        grade: 7,
        letter: 'c',
        codesGenerated: true,
        students: [
          kid(7, 'c', 'm1', 'Noah', 'Lang', { response: resp({ [D1]: [['16:30', '17:00']] }), appointment: appt(D1, '16:30') }),
          kid(7, 'c', 'm2', 'Emma', 'Vogel', { response: resp({ [D2]: [['15:30', '16:00']] }), appointment: appt(D2, '15:30') }),
          kid(7, 'c', 'm3', 'Leon', 'Busch'),
        ],
      },
      { id: '9b', grade: 9, letter: 'b', codesGenerated: false, students: [kid(9, 'b', 'n1', 'Sofia', 'Klein'), kid(9, 'b', 'n2', 'Finn', 'Wolf')] },
    ],
  });
}

const web = await startServer();
// Nur für den Elternbrief mit Briefkasten: eine Briefkasten-Adresse, die nirgends hinführt (Port 9 auf diesem
// Rechner). Beim Erzeugen der PDF wird nichts gesendet; der Beispiel-Briefkasten hat nur die richtige Form.
const webMail = await startServer({ mailboxUrl: 'http://127.0.0.1:9' });
const SAMPLE_MAILBOX = { id: 'Beispiel'.repeat(4), publicKey: 'Beispiel'.repeat(11).slice(0, 87) };
const shotPng = (name) => path.join(raw, `${name}.png`);

/** PNG → WebP in Zielgröße (über ein Canvas im Browser). fit 'cover' schneidet mittig zu, 'top' setzt das Bild
 *  oben in voller Breite ein und füllt den Rest weiß (für PDF-Ausschnitte, damit kein Text angeschnitten wird),
 *  'center' zeigt es ganz, mittig auf der Farbe seines Randes (für ganze Bausteine einer Seite). */
async function toWebp(page, pngFile, webpFile, width, height, quality = 0.86, fit = 'cover') {
  const b64 = (await fs.readFile(pngFile)).toString('base64');
  const data = await page.evaluate(
    async ([src, w, h, q, mode]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      if (mode === 'center') {
        // Ganz zeigen, mittig auf der Farbe des Bildrands (oben links)
        const probe = document.createElement('canvas');
        probe.width = probe.height = 1;
        const pctx = probe.getContext('2d');
        pctx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
        const [r, g, b] = pctx.getImageData(0, 0, 1, 1).data;
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, 0, w, h);
        const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
        ctx.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
      } else if (mode === 'top') {
        const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
        ctx.drawImage(img, (w - img.naturalWidth * s) / 2, 0, img.naturalWidth * s, img.naturalHeight * s);
      } else {
        // „cover“: mittig zuschneiden
        const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
        const dw = img.naturalWidth * s;
        const dh = img.naturalHeight * s;
        ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }
      const blob = await new Promise((r) => c.toBlob(r, 'image/webp', q));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s2 = '';
      for (let i = 0; i < buf.length; i += 0x8000) s2 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s2);
    },
    [`data:image/png;base64,${b64}`, width, height, quality, fit],
  );
  await fs.writeFile(webpFile, Buffer.from(data, 'base64'));
}

/**
 * Einen ganzen Baustein aufnehmen (Vereinigung aller Treffer der Selektoren, mit Rand); das WebP setzt ihn später
 * mittig auf die Farbe seines Randes – so zeigt jede Karte etwas Vollständiges statt eines Anschnitts.
 */
async function captureBlock(page, name, selectors, pad) {
  const r = await page.evaluate((sels) => {
    const rects = sels.flatMap((sel) => [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect()));
    return { x: Math.min(...rects.map((b) => b.left)), y: Math.min(...rects.map((b) => b.top)) + window.scrollY, right: Math.max(...rects.map((b) => b.right)), bottom: Math.max(...rects.map((b) => b.bottom)) + window.scrollY };
  }, selectors);
  await page.screenshot({ path: shotPng(name), fullPage: true, clip: { x: r.x - pad, y: r.y - pad, width: r.right - r.x + 2 * pad, height: r.bottom - r.y + 2 * pad }, animations: 'disabled' });
}

/** Ruhige Aufnahme: Animationen beendet, Schrift geladen. */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function clipShot(page, selectorOrBox, name, { pad = 0, aspect = null } = {}) {
  let box = typeof selectorOrBox === 'string' ? await page.locator(selectorOrBox).first().boundingBox() : selectorOrBox;
  box = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
  if (aspect) {
    // Höhe aus Breite (aspect = Breite/Höhe), oben bündig
    box.height = box.width / aspect;
  }
  await page.screenshot({ path: shotPng(name), clip: box, animations: 'disabled' });
  return shotPng(name);
}

const state = richState();

// ---------- Desktop: Lehrkraft ----------
{
  const page = await newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const box = async (sel) => page.locator(sel).first().boundingBox();
  // Ausschnitt im Hochformat 4:5. Ein Baustein, der im unteren Teil des Ausschnitts beginnt und von der Unterkante
  // durchschnitten würde (das nächste Feld, ein Eintrag der Tabelle, ein Zeitslot), wird für die Aufnahme ganz
  // ausgeblendet; vom Inhalt darüber nur angeschnittene Textzeilen und Bilder. So endet jedes Bild auf ganzen
  // Bausteinen statt auf halben Zeilen oder Kästen.
  const clip45 = async (name, x, y, w) => {
    const h = (w * 5) / 4;
    const sy = await page.evaluate(
      ([top, cut]) => {
        const box = (el) => el.getBoundingClientRect();
        const crosses = (r) => r.width > 0 && r.height > 0 && r.top < cut && r.bottom > cut;
        const lower = top + (cut - top) * 0.25;
        const hide = new Set();
        for (const el of document.querySelectorAll('body *')) {
          const r = box(el);
          if (!crosses(r)) continue;
          if (r.top > lower) {
            let block = el;
            while (block.parentElement && block.parentElement !== document.body && box(block.parentElement).top > lower) block = block.parentElement;
            hide.add(block);
            continue;
          }
          let hit = el.matches('img, svg, input, select, textarea, canvas');
          for (const n of el.childNodes) {
            if (hit) break;
            if (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            hit = [...range.getClientRects()].some(crosses);
          }
          if (hit) hide.add(el);
        }
        window.__clipHidden = [...hide];
        for (const el of window.__clipHidden) el.style.visibility = 'hidden';
        return window.scrollY;
      },
      [y, y + h],
    );
    await page.screenshot({ path: shotPng(name), fullPage: true, clip: { x, y: y + sy, width: w, height: h }, animations: 'disabled' });
    await page.evaluate(() => {
      for (const el of window.__clipHidden) el.style.visibility = '';
    });
  };

  const shotBlock = (name, selectors, pad) => captureBlock(page, name, selectors, pad);

  // Registrierung abschließen → Codes
  await page.goto(`${web.url}#/lehrkraft/registrieren`);
  await page.locator('[data-testid="reg-firstname"]').waitFor();
  await page.fill('[data-testid="reg-firstname"]', 'Anna');
  await page.fill('[data-testid="reg-lastname"]', 'Meier');
  await page.fill('[data-testid="reg-birthdate"]', '1984-03-14');
  await page.fill('[data-testid="reg-email"]', 'anna.meier@schule.example');
  const [download] = await Promise.all([page.waitForEvent('download').catch(() => null), page.click('[data-testid="reg-submit"]')]);
  if (download) await download.path();
  await page.locator('.tauth-success').waitFor();
  // Schmales Fenster: Überschrift und Codes brechen um, statt am Bildrand abgeschnitten zu werden
  await page.setViewportSize({ width: 436, height: 1000 });
  await settle(page);
  {
    const b = await box('.tauth-success');
    await clip45('registriert', 0, b.y - 16, 436);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Lehrkraft mit Beispieldaten
  await seedTeacher(page, web.url, state);
  await page.goto(`${web.url}#/lehrkraft/einstellungen`);
  await page.locator('.calp-grid').first().waitFor();
  await settle(page);
  await page.screenshot({ path: shotPng('einstellungen-voll'), fullPage: true, animations: 'disabled' });
  await shotBlock('kalender', ['.calp'], 12);

  // Schmales Fenster: die Klassen stehen untereinander, ein Türschild füllt die Breite
  await page.setViewportSize({ width: 452, height: 1000 });
  await page.goto(`${web.url}#/lehrkraft/klassen`);
  await page.locator('[data-testid="class-tile-5a"]').waitFor();
  await settle(page);
  await shotBlock('klassen', ['.tcl-classes-title', '[data-testid^="class-tile-"]'], 16);

  // Smartphone-Breite: jede Zeile der Tabelle als kleine Karte mit Code und freien Zeiten
  await page.setViewportSize({ width: 436, height: 1000 });
  await page.goto(`${web.url}#/lehrkraft/klasse/5a`);
  await page.locator('.tc-table').waitFor();
  await settle(page);
  // Nur die ersten beiden Einträge, die Tabelle endet danach
  await page.evaluate(() => {
    for (const tr of [...document.querySelectorAll('.tc-table tbody tr')].slice(2)) tr.style.display = 'none';
  });
  await shotBlock('tabelle', ['.tc-table-wrap'], 12);

  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto(`${web.url}#/lehrkraft/klasse/5a/terminieren`);
  await page.locator('.sched-day').first().waitFor();
  await settle(page);
  await page.screenshot({ path: shotPng('terminieren-voll'), fullPage: true, animations: 'disabled' });
  await shotBlock('terminieren', [`[aria-labelledby="sched-day-${D1}"]`], 10);

  // PDFs direkt aus den Modulen erzeugen (gleicher Code wie die Knöpfe). Den Elternbrief gibt es zweimal: mit
  // Briefkasten (wie auf parentsday.janrickmer.de: „Absenden – fertig!“) und ohne (PDF per E-Mail an die Lehrkraft).
  const pdfOn = async (pg, mod, fn, s, name) => {
    const b64 = await pg.evaluate(
      async ([m, f, st]) => {
        const lib = await import(m);
        const result = await lib[f](st, '5a');
        const doc = result.doc || result;
        const buf = new Uint8Array(doc.output('arraybuffer'));
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(bin);
      },
      [mod, fn, s],
    );
    await fs.writeFile(path.join(raw, `${name}.pdf`), Buffer.from(b64, 'base64'));
  };
  await pdfOn(page, './js/pdf/letters-pdf.js', 'createParentLettersPdf', state, 'elternbrief-email');
  await pdfOn(page, './js/pdf/appointments-pdf.js', 'createAppointmentsPdf', state, 'terminbestaetigung');
  {
    const mp = await browser.newPage();
    await mp.goto(webMail.url);
    await pdfOn(mp, './js/pdf/letters-pdf.js', 'createParentLettersPdf', { ...state, mailbox: SAMPLE_MAILBOX }, 'elternbrief');
    await mp.close();
  }
  // Ausschnitte bei 220 dpi; Koordinaten in Punkt (A4 = 595 × 842). QR-Code und Termin-Schlüssel des
  // Beispielbriefs werden vor dem Ausschnitt mit „Beispiel“ überdeckt, damit niemand den Beispiel-Elternsprechtag
  // von der Startseite aus öffnet. Modus „steps“: Hochformat ab „So geht’s“ (die Schritte brechen vor dem QR-Code
  // um, der rechte Rand schneidet nur Kästen, nie Text).
  const pdfScript = `
import sys, json, pymupdf
doc = pymupdf.open(sys.argv[1])
page = doc[int(sys.argv[3])]
x0, y0, x1, y1 = [float(v) for v in sys.argv[4:8]]
modes = sys.argv[8].split(',')
lines = []
for b in page.get_text('dict')['blocks']:
    for l in b.get('lines', []):
        lines.append((pymupdf.Rect(l['bbox']), ''.join(sp['text'] for sp in l['spans']).strip(), l['spans']))
def line_starting(prefix):
    found = [l for l in lines if l[1].startswith(prefix)]
    if not found:
        raise SystemExit(f'Zeile „{prefix}“ im Elternbrief nicht gefunden')
    return found[0]
def cover_with_label(r, size):
    page.draw_rect(r, color=(0.6, 0.65, 0.65), fill=(0.94, 0.96, 0.96), width=0.8)
    page.insert_textbox(pymupdf.Rect(r.x0, r.y0 + r.height / 2 - size * 0.72, r.x1, r.y1 + size), 'Beispiel', fontsize=size, align=1, color=(0.2, 0.25, 0.25))
qr_cover = None
key_line = None
if 'cover' in modes:
    # Der QR-Code ist aus vielen kleinen dunklen Quadraten gezeichnet: deren Umriss abdecken
    qr = None
    for d in page.get_drawings():
        f, r = d.get('fill'), d['rect']
        if f and max(f) < 0.25 and r.width < 12 and r.height < 12:
            qr = pymupdf.Rect(r) if qr is None else qr | r
    for info in page.get_image_info():
        r = pymupdf.Rect(info['bbox'])
        if r.width > 60 and abs(r.width - r.height) < 4:
            qr = r if qr is None else qr | r
    if qr is None:
        raise SystemExit('QR-Code im Elternbrief nicht gefunden')
    qr_cover = qr + (-4, -4, 4, 4)
    cover_with_label(qr_cover, 14)
    # Termin-Schlüssel: der fett gesetzte Teil der Zeile „Ohne QR-Code: …“ (bricht er um, auch die Folgezeilen)
    key_line = line_starting('Ohne QR-Code')
    key = None
    for r, t, spans in lines:
        if r.y0 >= key_line[0].y0 - 1 and r.y0 < key_line[0].y0 + 40:
            for sp in spans:
                if sp['flags'] & 16 and sp['text'].strip():
                    key = pymupdf.Rect(sp['bbox']) if key is None else key | pymupdf.Rect(sp['bbox'])
    if key is None:
        raise SystemExit('Termin-Schlüssel im Elternbrief nicht gefunden')
    cover_with_label(key + (-0.5, -1, 2, 1), 8)
if 'steps' in modes:
    # Hochformat 4:5 ab „So geht’s“, höchstens bis über die Fußzeile
    y0 = line_starting('So geht')[0].y0 - 10
    y1 = min(y0 + (x1 - x0) * 1.25, line_starting('Erstellt mit ParentsDay')[0].y0 - 6)
crop = pymupdf.Rect(x0, y0, x1, y1)
page.get_pixmap(dpi=220, clip=crop).save(sys.argv[2])
if 'cover' not in modes:
    sys.exit(0)
# Stellen im Brief als Anteil des Ausschnitts (für die Markierungen auf der Startseite)
marks = {}
def pct(r):
    r = r & crop
    return {'left': round((r.x0 - x0) / crop.width * 100, 1), 'top': round((r.y0 - y0) / crop.height * 100, 1), 'width': round(r.width / crop.width * 100, 1), 'height': round(r.height / crop.height * 100, 1)}
box_top = None
for d in page.get_drawings():
    f = d.get('fill')
    if f and d['rect'].width > 300:
        name = 'box' if f[2] < 0.8 else 'times'
        marks[name] = pct(d['rect'] + (-2, -2, 2, 2))
        if name == 'box':
            box_top = d['rect'].y0
# Schritt 4: von „4.“ bis vor den gelben Kasten, ohne die Bildunterschrift des QR-Codes rechts daneben
four = line_starting('4.')[0]
send = pymupdf.Rect(four)
right = qr_cover.x0 if qr_cover else 400
for r, t, spans in lines:
    if r.y0 >= four.y0 and (box_top is None or r.y1 <= box_top) and r.x0 < right:
        send |= r
marks['send'] = pct(send + (-3, -3, 9, 3))  # rechts etwas Luft: der Rahmen soll das letzte Wort nicht berühren
if qr_cover:
    marks['qr'] = pct(qr_cover + (-3, -3, 3, 3))
print(json.dumps(marks))
`;
  const crop = (pdf, png, pageIndex, x0, y0, x1, y1, mode = '') =>
    execFileSync('python3', ['-c', pdfScript, path.join(raw, pdf), shotPng(png), String(pageIndex), String(x0), String(y0), String(x1), String(y1), mode || '-'], { encoding: 'utf8' });
  const pt = (px) => (px * 72) / 100; // Koordinaten aus der 100-dpi-Ansicht
  const lastPage = (pdf) => Number(execFileSync('python3', ['-c', 'import sys, pymupdf; print(len(pymupdf.open(sys.argv[1])) - 1)', path.join(raw, pdf)], { encoding: 'utf8' }).trim());
  // Karussell: die Schritte, der gelbe Kasten und der Termin-Schlüssel in ganzer Textbreite; Übersicht für die
  // Lehrkraft (letzte Seite der Termin-PDF) von der Überschrift bis „Insgesamt … Termine“ in ganzer Breite
  crop('elternbrief.pdf', 'elternbrief', 0, pt(60), 0, pt(760), 0, 'cover,steps');
  crop('elternbrief-email.pdf', 'elternbrief-email', 0, pt(60), 0, pt(760), 0, 'cover,steps');
  crop('terminbestaetigung.pdf', 'terminbestaetigung', lastPage('terminbestaetigung.pdf'), 43, 100, 553, 480);
  // Abschnitt „Jede Familie hat ihren Termin“: die erste Terminbestätigung in ganzer Breite
  crop('terminbestaetigung.pdf', 'bestaetigung', 0, pt(60), pt(130), pt(760), pt(130 + 725));
  // Abschnitt „Für Eltern genügt der Brief“: ganze Textbreite bis zur Unterschrift (der längere Brief ohne
  // Briefkasten bestimmt die Höhe); Markierungen ausgeben
  for (const name of ['brief', 'brief-email']) {
    const pdf = name === 'brief' ? 'elternbrief.pdf' : 'elternbrief-email.pdf';
    const marks = crop(pdf, name, 0, pt(60), pt(180), pt(760), pt(1104), 'cover');
    console.log(`Markierungen für ${name} (LETTER_MARKS in js/views/start.js):`, marks.trim());
  }
  await page.close();
}

// ---------- Smartphone: Eltern ----------
{
  const page = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(web.url);
  const link = await page.evaluate(([s, c]) => import('./js/core/transport.js').then((m) => m.eventLink(s, c)), [state, '5a']);
  await page.goto(web.url + link.slice(link.indexOf('#')));
  await page.locator('[data-testid="parent-firstname"]').waitFor();
  await settle(page);
  await page.screenshot({ path: shotPng('eltern-anmeldung'), animations: 'disabled' });
  const anna = state.classes[0].students[0];
  await page.fill('[data-testid="parent-firstname"]', anna.firstName);
  await page.fill('[data-testid="parent-lastname"]', anna.lastName);
  await page.fill('[data-testid="parent-code"]', anna.code);
  await page.tap('[data-testid="parent-login"]');
  await page.locator(`[data-testid="slot-${D1}-14:00"]`).waitFor();
  for (const t of ['14:00', '14:10', '14:20', '14:30', '14:40', '14:50', '16:00', '16:10']) await page.tap(`[data-testid="slot-${D1}-${t}"]`);
  await settle(page);
  await captureBlock(page, 'eltern-zeiten', [`.parent-day:has([data-testid="day-summary-${D1}"])`], 12);
  await page.close();
}

// ---------- Zuschnitte als WebP ----------
const cp = await browser.newPage({ viewport: { width: 800, height: 600 } });
await cp.goto(web.url);
await toWebp(cp, shotPng('registriert'), path.join(out, 'registriert.webp'), 680, 850);
for (const name of ['kalender', 'klassen', 'tabelle', 'terminieren', 'eltern-zeiten', 'terminbestaetigung']) {
  await toWebp(cp, shotPng(name), path.join(out, `${name}.webp`), 680, 850, 0.86, 'center');
}
for (const name of ['elternbrief', 'elternbrief-email']) {
  await toWebp(cp, shotPng(name), path.join(out, `${name}.webp`), 680, 850, 0.86, 'top');
}
for (const name of ['brief', 'brief-email']) await toWebp(cp, shotPng(name), path.join(out, `${name}.webp`), 1050, 1388, 0.86);
await toWebp(cp, shotPng('bestaetigung'), path.join(out, 'bestaetigung.webp'), 1000, 1036, 0.86);

// Herkunft jedes Bildes als Begleitdatei <bild>.webp.json ({"prompt": …}: das Format, das impeccable embed-prompt
// für WebP liest und mit --scan prüft)
const SOURCE = 'aufgenommen mit tools/startseite-bilder.mjs gegen den lokalen Testserver, ohne Verbindung zum echten Briefkasten-Dienst; alle Namen, Codes, Adressen und E-Mail-Adressen sind erfundene Beispieldaten';
const ORIGIN = {
  registriert: 'Bildschirmfoto von ParentsDay: „Registrierung abgeschlossen“ (#/lehrkraft/registrieren), Fensterbreite 436 px',
  kalender: 'Bildschirmfoto von ParentsDay: Kalender in den Einstellungen des Elternsprechtags (#/lehrkraft/einstellungen), Fensterbreite 1280 px',
  klassen: 'Bildschirmfoto von ParentsDay: Klassenübersicht (#/lehrkraft/klassen), Fensterbreite 452 px',
  tabelle: 'Bildschirmfoto von ParentsDay: Tabelle der Klasse 5a (#/lehrkraft/klasse/5a), Fensterbreite 436 px',
  terminieren: 'Bildschirmfoto von ParentsDay: Tagesansicht zum Terminieren der Klasse 5a (#/lehrkraft/klasse/5a/terminieren), Fensterbreite 1280 px',
  'eltern-zeiten': 'Bildschirmfoto von ParentsDay: Eltern-Ansicht mit grün markierten Zeiten, Smartphone 390 px',
  elternbrief: 'Ausschnitt aus dem erzeugten Elternbrief mit Briefkasten (js/pdf/letters-pdf.js, Seite 1), QR-Code und Termin-Schlüssel durch „Beispiel“ ersetzt',
  'elternbrief-email': 'Ausschnitt aus dem erzeugten Elternbrief ohne Briefkasten (js/pdf/letters-pdf.js, Seite 1), QR-Code und Termin-Schlüssel durch „Beispiel“ ersetzt',
  terminbestaetigung: 'Ausschnitt aus der Terminübersicht für die Lehrkraft (js/pdf/appointments-pdf.js, letzte Seite)',
  brief: 'Erzeugter Elternbrief mit Briefkasten (js/pdf/letters-pdf.js, Seite 1) bis zur Unterschrift, QR-Code und Termin-Schlüssel durch „Beispiel“ ersetzt',
  'brief-email': 'Erzeugter Elternbrief ohne Briefkasten (js/pdf/letters-pdf.js, Seite 1) bis zur Unterschrift, QR-Code und Termin-Schlüssel durch „Beispiel“ ersetzt',
  bestaetigung: 'Erste Terminbestätigung aus der erzeugten Termin-PDF (js/pdf/appointments-pdf.js, Seite 1)',
};
for (const [name, text] of Object.entries(ORIGIN)) {
  await fs.writeFile(path.join(out, `${name}.webp.json`), `${JSON.stringify({ prompt: `${text}; ${SOURCE}.` }, null, 2)}\n`);
}
await browser.close();
await web.close();
await webMail.close();
if (!process.env.PARENTSDAY_KEEP_RAW) await fs.rm(raw, { recursive: true, force: true });
console.log(`Bilder geschrieben nach ${out}`);
