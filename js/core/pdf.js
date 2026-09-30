// Gemeinsame PDF-Werkzeuge (jsPDF). Alle PDFs verwenden die eingebettete Schrift Liberation Sans,
// damit auch Namen wie „Çelik“, „Łukasz“ oder „Şahin“ korrekt dargestellt werden.
// Maschinenlesbare Daten werden im Metadatenfeld „Betreff“ (Subject) abgelegt und können mit
// extractPayloadFromFile() wieder gelesen werden.

import { pdfPayloadString, findPdfPayloadInText } from './transport.js';
import { downloadBlob, safeFilename } from './ui.js';

export const PAGE = { width: 210, height: 297, margin: 20 };
export const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;
export const FONT = 'LiberationSans';

export const COLORS = {
  text: '#1d2433',
  muted: '#5b6475',
  primary: '#1f5fae',
  primaryLight: '#e8f0fb',
  line: '#c9d1de',
  yellowFill: '#fff4b3',
  yellowBorder: '#e2b400',
  tableHeader: '#1f5fae',
  zebra: '#f3f6fa',
};

const VENDOR_URL = new URL('../../vendor/jspdf.umd.min.js', import.meta.url).href;
const FONT_URLS = {
  normal: new URL('../../fonts/LiberationSans-Regular.ttf', import.meta.url).href,
  bold: new URL('../../fonts/LiberationSans-Bold.ttf', import.meta.url).href,
};

let jsPdfPromise = null;
let fontPromise = null;

const LIBRARY_ERROR = 'Die PDF-Bibliothek konnte nicht geladen werden. Bitte prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.';
const FONT_ERROR = 'Die Schrift für PDFs konnte nicht geladen werden. Bitte prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      el.remove();
      reject(new Error(LIBRARY_ERROR));
    };
    document.head.appendChild(el);
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Lädt jsPDF und die Schriften (einmalig). Kann vorab aufgerufen werden, um Wartezeit zu sparen. */
export function preloadPdf() {
  if (!jsPdfPromise) {
    jsPdfPromise = (window.jspdf ? Promise.resolve() : loadScript(VENDOR_URL)).then(() => window.jspdf.jsPDF);
    jsPdfPromise.catch(() => (jsPdfPromise = null));
  }
  if (!fontPromise) {
    fontPromise = Promise.all(
      Object.entries(FONT_URLS).map(async ([style, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(FONT_ERROR);
          return [style, arrayBufferToBase64(await res.arrayBuffer())];
        } catch {
          // Netzwerkfehler („Failed to fetch“) nicht auf Englisch anzeigen
          throw new Error(FONT_ERROR);
        }
      }),
    ).then(Object.fromEntries);
    fontPromise.catch(() => (fontPromise = null));
  }
  return Promise.all([jsPdfPromise, fontPromise]);
}

/** Erzeugt ein neues A4-Dokument (Einheit mm) mit eingebetteter Schrift. */
export async function createPdf() {
  const [JsPDF, fonts] = await preloadPdf();
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  doc.addFileToVFS('LiberationSans-Regular.ttf', fonts.normal);
  doc.addFont('LiberationSans-Regular.ttf', FONT, 'normal');
  doc.addFileToVFS('LiberationSans-Bold.ttf', fonts.bold);
  doc.addFont('LiberationSans-Bold.ttf', FONT, 'bold');
  doc.setFont(FONT, 'normal');
  doc.setFontSize(11);
  doc.setTextColor(COLORS.text);
  doc.setLineHeightFactor(1.35);
  return doc;
}

/** Setzt Schriftstil, -größe und -farbe in einem Aufruf. */
export function setText(doc, { size = 11, bold = false, color = COLORS.text } = {}) {
  doc.setFont(FONT, bold ? 'bold' : 'normal');
  doc.setFontSize(size);
  doc.setTextColor(color);
}

/** Zeilenhöhe in mm für eine Schriftgröße (pt). */
export function lineHeight(doc, size = doc.getFontSize()) {
  return (size * doc.getLineHeightFactor() * 25.4) / 72;
}

/**
 * Kopfzeile mit „ParentsDay“-Schriftzug und optionalem Untertitel/rechtem Text.
 * @returns {number} y-Position unter der Kopfzeile
 */
export function drawBrandHeader(doc, { subtitle = '', rightText = '' } = {}) {
  const top = PAGE.margin - 4;
  setText(doc, { size: 18, bold: true, color: COLORS.primary });
  doc.text('Parents', PAGE.margin, top + 6);
  const w = doc.getTextWidth('Parents');
  setText(doc, { size: 18, bold: true, color: COLORS.yellowBorder });
  doc.text('Day', PAGE.margin + w, top + 6);
  if (subtitle) {
    setText(doc, { size: 9, color: COLORS.muted });
    doc.text(subtitle, PAGE.margin, top + 11);
  }
  if (rightText) {
    setText(doc, { size: 9, color: COLORS.muted });
    const lines = String(rightText).split('\n');
    doc.text(lines, PAGE.width - PAGE.margin, top + 2, { align: 'right' });
  }
  const rightLines = rightText ? String(rightText).split('\n').length : 0;
  const bottom = Math.max(top + 14, top + 2 + rightLines * lineHeight(doc, 9));
  doc.setDrawColor(COLORS.line);
  doc.setLineWidth(0.3);
  doc.line(PAGE.margin, bottom, PAGE.width - PAGE.margin, bottom);
  setText(doc);
  return bottom + 8;
}

/** Fußzeile mit Seitenzahlen auf allen Seiten. Am Ende aufrufen. */
export function drawFooters(doc, leftText = 'Erstellt mit ParentsDay') {
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    setText(doc, { size: 8, color: COLORS.muted });
    doc.text(leftText, PAGE.margin, PAGE.height - 10);
    doc.text(`Seite ${i} von ${total}`, PAGE.width - PAGE.margin, PAGE.height - 10, { align: 'right' });
  }
  setText(doc);
}

/**
 * Schreibt einen Absatz mit automatischem Zeilenumbruch.
 * @returns {number} neue y-Position
 */
export function writeParagraph(doc, text, y, { x = PAGE.margin, maxWidth = CONTENT_WIDTH, size = 11, bold = false, color = COLORS.text, spacingAfter = 3 } = {}) {
  setText(doc, { size, bold, color });
  const lines = doc.splitTextToSize(String(text), maxWidth);
  const lh = lineHeight(doc, size);
  doc.text(lines, x, y + lh * 0.75);
  return y + lines.length * lh + spacingAfter;
}

/** Fügt eine neue Seite ein, wenn weniger als `needed` mm Platz sind. */
export function ensureSpace(doc, y, needed) {
  if (y + needed > PAGE.height - 18) {
    doc.addPage();
    return PAGE.margin;
  }
  return y;
}

/**
 * Hervorgehobener Kasten mit Beschriftung/Wert-Zeilen (z. B. gelber Kasten im Elternbrief).
 * @param {Array<[string,string]>} rows
 * @returns {number} y-Position unter dem Kasten
 */
export function drawInfoBox(doc, y, rows, { x = PAGE.margin, width = CONTENT_WIDTH, title = '', fill = COLORS.yellowFill, border = COLORS.yellowBorder, labelWidth = 55, valueSize = 13 } = {}) {
  const pad = 5;
  const lhTitle = lineHeight(doc, 11);
  const rowHeights = rows.map(([, value]) => {
    setText(doc, { size: valueSize, bold: true });
    const lines = doc.splitTextToSize(String(value), width - 2 * pad - labelWidth);
    return Math.max(lines.length * lineHeight(doc, valueSize), lineHeight(doc, 10)) + 2;
  });
  const height = pad * 2 + (title ? lhTitle + 2 : 0) + rowHeights.reduce((a, b) => a + b, 0);
  doc.setFillColor(fill);
  doc.setDrawColor(border);
  doc.setLineWidth(0.6);
  doc.roundedRect(x, y, width, height, 2.5, 2.5, 'FD');
  let cy = y + pad;
  if (title) {
    setText(doc, { size: 11, bold: true });
    doc.text(title, x + pad, cy + lhTitle * 0.75);
    cy += lhTitle + 2;
  }
  rows.forEach(([label, value], i) => {
    setText(doc, { size: 10, color: COLORS.muted });
    doc.text(String(label), x + pad, cy + lineHeight(doc, valueSize) * 0.75);
    setText(doc, { size: valueSize, bold: true });
    const lines = doc.splitTextToSize(String(value), width - 2 * pad - labelWidth);
    doc.text(lines, x + pad + labelWidth, cy + lineHeight(doc, valueSize) * 0.75);
    cy += rowHeights[i];
  });
  setText(doc);
  return y + height + 6;
}

/**
 * Tabelle mit Kopfzeile, Zebra-Streifen und automatischem Seitenumbruch (Kopfzeile wird wiederholt).
 * `reserveAfterLast` (mm): Platz, der unter der letzten Zeile auf derselben Seite frei bleiben muss
 * (z. B. für eine Summenzeile). Reicht er nicht, kommen die letzten Zeilen mit auf die neue Seite –
 * so steht nie eine Zeile allein unter der Tabelle auf einer eigenen Seite.
 * @param {{x?:number, columns: Array<{header:string, width:number, align?:'left'|'right'|'center'}>, rows: string[][], size?:number, pad?:number, reserveAfterLast?:number}} opts
 * @returns {number} y-Position unter der Tabelle
 */
export function drawTable(doc, y, { x = PAGE.margin, columns, rows, size = 10, pad = 2, reserveAfterLast = 0 }) {
  const lh = lineHeight(doc, size);
  const bottom = PAGE.height - 18;
  const totalWidth = columns.reduce((a, c) => a + c.width, 0);
  const drawHeader = (yy) => {
    doc.setFillColor(COLORS.tableHeader);
    doc.rect(x, yy, totalWidth, lh + 2 * pad, 'F');
    setText(doc, { size, bold: true, color: '#ffffff' });
    let cx = x;
    for (const col of columns) {
      const tx = col.align === 'right' ? cx + col.width - pad : col.align === 'center' ? cx + col.width / 2 : cx + pad;
      doc.text(col.header, tx, yy + pad + lh * 0.75, { align: col.align || 'left' });
      cx += col.width;
    }
    return yy + lh + 2 * pad;
  };
  setText(doc, { size });
  const cells = rows.map((row) => row.map((cell, ci) => doc.splitTextToSize(String(cell ?? ''), columns[ci].width - 2 * pad)));
  const heights = cells.map((cellLines) => Math.max(...cellLines.map((l) => l.length)) * lh + 2 * pad);
  const rest = (from) => heights.slice(from).reduce((a, b) => a + b, 0);
  // Die letzten beiden Zeilen bleiben zusammen und mit der Reserve auf einer Seite.
  const tailStart = Math.max(0, rows.length - 2);
  const needFor = (ri) => (reserveAfterLast && ri >= tailStart ? rest(ri) + reserveAfterLast : heights[ri]);
  // Kopfzeile nie allein am Seitenende
  if (rows.length && y + lh + 2 * pad + needFor(0) > bottom) {
    doc.addPage();
    y = PAGE.margin;
  }
  y = drawHeader(y);
  cells.forEach((cellLines, ri) => {
    const h = heights[ri];
    if (ri > 0 && y + needFor(ri) > bottom) {
      doc.addPage();
      y = drawHeader(PAGE.margin);
    }
    if (ri % 2 === 1) {
      doc.setFillColor(COLORS.zebra);
      doc.rect(x, y, totalWidth, h, 'F');
    }
    setText(doc, { size });
    let cx = x;
    cellLines.forEach((lines, ci) => {
      const col = columns[ci];
      const tx = col.align === 'right' ? cx + col.width - pad : col.align === 'center' ? cx + col.width / 2 : cx + pad;
      doc.text(lines, tx, y + pad + lh * 0.75, { align: col.align || 'left' });
      cx += col.width;
    });
    doc.setDrawColor(COLORS.line);
    doc.setLineWidth(0.2);
    doc.line(x, y + h, x + totalWidth, y + h);
    y += h;
  });
  setText(doc);
  return y + 4;
}

/** Zeichnet einen QR-Code als Vektorgrafik (scharf beim Drucken). */
export async function drawQrCode(doc, text, x, y, size) {
  const { default: qrcode } = await import('../../vendor/qrcode.mjs');
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2;
  const cell = size / (count + 2 * quiet);
  doc.setFillColor('#ffffff');
  doc.rect(x, y, size, size, 'F');
  doc.setFillColor('#000000');
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) doc.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.01, cell + 0.01, 'F');
    }
  }
}

/** Legt maschinenlesbare Daten und Titel in den PDF-Metadaten ab. */
export function embedPayload(doc, payload, { title = 'ParentsDay', author = '' } = {}) {
  doc.setDocumentProperties({
    title,
    subject: pdfPayloadString(payload),
    author,
    keywords: 'ParentsDay',
    creator: 'ParentsDay',
  });
}

function decodeUtf16Hex(hex) {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  const start = clean.toUpperCase().startsWith('FEFF') ? 4 : 0;
  for (let i = start; i + 4 <= clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  return out;
}

/**
 * Liest die eingebetteten ParentsDay-Daten aus einer PDF-Datei (File/Blob/ArrayBuffer).
 * @returns {Promise<object|null>}
 */
export async function extractPayloadFromFile(fileOrBuffer) {
  const buffer = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const text = new TextDecoder('latin1').decode(new Uint8Array(buffer));
  const direct = findPdfPayloadInText(text);
  if (direct) return direct;
  // Fallback: von anderen Programmen neu gespeicherte PDFs schreiben Metadaten oft als UTF-16-Hex-String.
  const hexRe = /\/Subject\s*<([0-9A-Fa-f\s]+)>/g;
  let m;
  while ((m = hexRe.exec(text))) {
    const found = findPdfPayloadInText(decodeUtf16Hex(m[1]));
    if (found) return found;
  }
  return null;
}

/** Speichert das PDF als Download. */
export function savePdf(doc, filename) {
  const name = safeFilename(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
  downloadBlob(doc.output('blob'), name);
  return name;
}

/**
 * Öffnet das PDF zum Drucken in einem neuen Tab. `targetWindow` sollte direkt im Klick-Handler
 * mit window.open('', '_blank') geöffnet werden, damit Popup-Blocker nicht eingreifen.
 * @returns {boolean} ob das Öffnen geklappt hat
 */
export function openPdfForPrint(doc, targetWindow = null) {
  try {
    doc.autoPrint();
    const url = URL.createObjectURL(doc.output('blob'));
    if (targetWindow && !targetWindow.closed) {
      targetWindow.location.href = url;
      return true;
    }
    const w = window.open(url, '_blank');
    return Boolean(w);
  } catch {
    return false;
  }
}
