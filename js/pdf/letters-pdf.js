// Elternbriefe einer Klasse: eine DIN-A4-Seite pro Kind mit Code. Jeder Brief enthält den gelben
// Kasten mit den Zugangsdaten, einen QR-Code mit den Termindaten (eventLink) und den abtippbaren
// Termin-Schlüssel. Passt ein Brief nicht auf eine Seite, wird er automatisch kompakter gesetzt.

import { PUBLIC_URL, APP_NAME } from '../config.js';
import { createPdf, drawBrandHeader, writeParagraph, drawInfoBox, drawQrCode, drawFooters, embedPayload, setText, lineHeight, PAGE, CONTENT_WIDTH, COLORS } from '../core/pdf.js';
import { eventLink, encodeEventKey } from '../core/transport.js';
import { formatDate, formatDateLong, formatDateWithWeekday, formatRange, nowParts, parseIsoDate, WEEKDAYS_SHORT } from '../core/time.js';
import { findClass } from '../core/storage.js';

/** Unterkante für den Briefinhalt (darunter steht die Fußzeile). */
const BOTTOM = PAGE.height - 19;

/**
 * Satzvarianten von großzügig bis kompakt; die erste, mit der der Brief auf eine Seite passt, wird verwendet.
 * lean: die beiden ergänzenden Sätze („Ich freue mich …“, „Je mehr Zeiten …“) entfallen – nur bei
 * extrem langen Namen/E-Mail-Adressen nötig.
 */
const MODES = [
  { size: 11, small: 8.5, subject: 14, heading: 12.5, gap: 1, qr: 40, valueSize: 13 },
  { size: 11, small: 8.5, subject: 14, heading: 12.5, gap: 0.5, qr: 38, valueSize: 13 },
  { size: 10.5, small: 8.5, subject: 13.5, heading: 12, gap: 0.5, qr: 38, valueSize: 13 },
  { size: 10, small: 8, subject: 13, heading: 11.5, gap: 0.4, qr: 36, valueSize: 12.5 },
  { size: 9.5, small: 8, subject: 12.5, heading: 11, gap: 0.3, qr: 36, valueSize: 12 },
  { size: 9, small: 7.5, subject: 12, heading: 10.5, gap: 0.1, qr: 36, valueSize: 11.5 },
  { size: 9, small: 7.5, subject: 12, heading: 10.5, gap: 0, qr: 36, valueSize: 11, lean: true },
  { size: 8.5, small: 7, subject: 11.5, heading: 10, gap: 0, qr: 34, valueSize: 10, lean: true },
  { size: 8, small: 7, subject: 11, heading: 9.5, gap: 0, qr: 32, valueSize: 9, lean: true },
];

/** Mindestgröße eines QR-Moduls in mm (gut scanbar nach dem Drucken) und größte QR-Code-Kante. */
const QR_MODULE = 0.43;
const QR_MAX = 50;
/** Kleinere Module lassen sich gedruckt kaum noch scannen – dann lieber eine klare Fehlermeldung. */
const QR_MODULE_LIMIT = 0.3;
const QR_TOO_LONG =
  'Die Angaben für den QR-Code sind zu umfangreich – meist ist die Adresse der Schule sehr lang. Bitte kürzen Sie die Adresse unter „Weitere Einstellungen“ und erstellen Sie die Elternbriefe dann erneut.';

/** Überlange Wörter (Namen, E-Mail-Adressen) werden bevorzugt nach diesen Zeichen umbrochen. */
const WORD_PIECES = /[^-@./]+[-@./]*|[-@./]+/g;

const BOX_LABELS = ['Vorname des Kindes', 'Nachname des Kindes', 'Code'];
const STEP_INDENT = 7;

/** Dateiname, z. B. „ParentsDay Elternbriefe Klasse 5a.pdf“. */
export function lettersFilename(classId) {
  return `${APP_NAME} Elternbriefe Klasse ${classId}.pdf`;
}

/**
 * Bricht Text in Zeilen um (Schrift muss gesetzt sein). Anders als splitTextToSize() werden überlange
 * Wörter nach „-“, „@“, „.“ oder „/“ getrennt und nur notfalls mitten im Wort.
 * @returns {string[]}
 */
function wrapLines(doc, text, maxWidth) {
  // Kleine Reserve, damit splitTextToSize() in writeParagraph()/drawInfoBox() nicht erneut trennt.
  const fits = (s) => doc.getTextWidth(s) <= maxWidth - 0.5;
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = '';
      if (fits(word)) {
        line = word;
        continue;
      }
      for (const piece of word.match(WORD_PIECES) || []) {
        if (fits(line + piece)) {
          line += piece;
          continue;
        }
        if (line) out.push(line);
        line = '';
        if (fits(piece)) {
          line = piece;
          continue;
        }
        for (const ch of piece) {
          if (line && !fits(line + ch)) {
            out.push(line);
            line = '';
          }
          line += ch;
        }
      }
    }
    out.push(line);
  }
  return out;
}

/** Absatz schreiben (draw) oder nur seine Höhe messen. Gibt die neue y-Position zurück. */
function paragraph(doc, draw, text, y, opts = {}) {
  const { size = 11, bold = false, maxWidth = CONTENT_WIDTH, spacingAfter = 3 } = opts;
  setText(doc, { size, bold });
  const lines = wrapLines(doc, text, maxWidth);
  if (draw) return writeParagraph(doc, lines.join('\n'), y, opts);
  return y + lines.length * lineHeight(doc, size) + spacingAfter;
}

/** Eine Zeile aus Teilen mit unterschiedlichem Schriftschnitt: [{text, bold, color}]. */
function richLine(doc, parts, x, baseline, size) {
  let cx = x;
  for (const part of parts) {
    setText(doc, { size, bold: part.bold, color: part.color || COLORS.text });
    doc.text(part.text, cx, baseline);
    cx += doc.getTextWidth(part.text);
  }
  setText(doc);
}

/** Schulanschrift für die Kopfzeile: umbrochen, höchstens sechs Zeilen. */
function addressText(doc, address) {
  setText(doc, { size: 9 });
  const lines = String(address || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => doc.splitTextToSize(l, 95));
  setText(doc);
  if (lines.length > 6) return [...lines.slice(0, 5), `${lines[5]} …`].join('\n');
  return lines.join('\n');
}

/** Größte Schriftgröße (höchstens `size`), bei der `text` fett in `maxWidth` passt. */
function fitSize(doc, text, size, maxWidth, minSize = 9) {
  let s = size;
  for (; s > minSize; s -= 0.5) {
    setText(doc, { size: s, bold: true });
    if (doc.getTextWidth(text) <= maxWidth) break;
  }
  setText(doc);
  return s;
}

/** Bricht einen langen Termin-Schlüssel nur an den Bindestrichen um (setzt die Schrift fett voraus). */
function wrapAtDashes(doc, key, maxWidth) {
  const lines = [];
  let current = '';
  for (const group of key.split('-')) {
    const candidate = current ? `${current}-${group}` : group;
    if (!current || doc.getTextWidth(`${candidate}-`) <= maxWidth) current = candidate;
    else {
      lines.push(`${current}-`);
      current = group;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Anzahl der Zellen des QR-Codes inkl. Ruhezone (wie drawQrCode() in core/pdf.js).
 * Infinity, wenn der Text für einen QR-Code zu lang ist.
 */
async function qrCellCount(text) {
  const { default: qrcode } = await import('../../vendor/qrcode.mjs');
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    return qr.getModuleCount() + 4;
  } catch {
    // qrcode-generator wirft bei zu langen Daten einen Text („code length overflow …“)
    return Infinity;
  }
}

/** Wert für den gelben Kasten: Namen nach Leerzeichen/Bindestrichen umbrechen statt mitten im Wort. */
function boxValue(doc, value, maxWidth, size) {
  setText(doc, { size, bold: true });
  const text = wrapLines(doc, value, maxWidth).join('\n');
  setText(doc);
  return text;
}

/** Höhe des gelben Kastens – gleiche Rechnung wie drawInfoBox() in core/pdf.js. */
function infoBoxHeight(doc, rows, { width, title, labelWidth, valueSize }) {
  const pad = 5;
  let height = pad * 2 + (title ? lineHeight(doc, 11) + 2 : 0);
  for (const [, value] of rows) {
    setText(doc, { size: valueSize, bold: true });
    const lines = doc.splitTextToSize(String(value), width - 2 * pad - labelWidth);
    height += Math.max(lines.length * lineHeight(doc, valueSize), lineHeight(doc, 10)) + 2;
  }
  setText(doc);
  return height;
}

/** Einleitungssatz mit dem Datum bzw. den Daten des Elternsprechtags. */
function introText(days, lean = false) {
  const dates = days.map((d) => formatDateLong(d.date));
  let when;
  if (dates.length === 1) when = `am ${dates[0]}, findet der Elternsprechtag statt.`;
  else if (dates.length === 2) when = `am ${dates[0]}, und am ${dates[1]}, findet der Elternsprechtag statt.`;
  else when = 'an den unten genannten Tagen findet der Elternsprechtag statt.';
  return lean ? when : `${when} Ich freue mich darauf, mit Ihnen über Ihr Kind ins Gespräch zu kommen.`;
}

/** Hellblauer Kasten mit Tagen, Uhrzeiten und Gesprächsraster. */
function daysPanel(doc, draw, y, ctx, mode) {
  const pad = 4;
  const lh = lineHeight(doc, mode.size);
  const twoColumns = ctx.days.length > 4;
  const rows = twoColumns ? Math.ceil(ctx.days.length / 2) : ctx.days.length;
  const height = pad * 2 + lh + 1 + rows * lh;
  const after = y + height + 3 + 3 * mode.gap;
  if (!draw) return after;

  doc.setFillColor(COLORS.primaryLight);
  doc.setDrawColor(COLORS.primary);
  doc.setLineWidth(0.3);
  doc.roundedRect(PAGE.margin, y, CONTENT_WIDTH, height, 2, 2, 'FD');
  let cy = y + pad;
  setText(doc, { size: mode.size, bold: true, color: COLORS.primary });
  doc.text(ctx.days.length === 1 ? 'Zeit des Elternsprechtags' : 'Zeiten des Elternsprechtags', PAGE.margin + pad, cy + lh * 0.75);
  // Gesprächsraster rechtsbündig in derselben Zeile
  const raster = `${ctx.slotMinutes} Minuten`;
  setText(doc, { size: mode.size });
  const rasterWidth = doc.getTextWidth(raster);
  setText(doc, { size: mode.size, bold: true });
  const rasterX = PAGE.margin + CONTENT_WIDTH - pad - rasterWidth - doc.getTextWidth('Gesprächsraster: ');
  richLine(doc, [{ text: 'Gesprächsraster: ', bold: true }, { text: raster }], rasterX, cy + lh * 0.75, mode.size);
  cy += lh + 1;
  const colWidth = (CONTENT_WIDTH - 2 * pad) / 2;
  ctx.days.forEach((d, i) => {
    const col = twoColumns ? Math.floor(i / rows) : 0;
    const row = twoColumns ? i % rows : i;
    const x = PAGE.margin + pad + col * colWidth;
    const baseline = cy + row * lh + lh * 0.75;
    const label = twoColumns ? `${WEEKDAYS_SHORT[parseIsoDate(d.date).getDay()]}, ${formatDate(d.date)}` : formatDateWithWeekday(d.date);
    setText(doc, { size: mode.size, color: COLORS.primary });
    doc.text('•', x + 1, baseline);
    richLine(doc, [{ text: `${label}: `, bold: true }, { text: formatRange(d.start, d.end) }], x + 5, baseline, mode.size);
  });
  setText(doc);
  return after;
}

/** Nummerierter Schritt mit hängendem Einzug; eine Adresse im Text wird anklickbar. */
function step(doc, draw, number, text, y, mode, { width = CONTENT_WIDTH, url = '' } = {}) {
  const maxWidth = width - STEP_INDENT;
  const opts = { x: PAGE.margin + STEP_INDENT, maxWidth, size: mode.size, spacingAfter: 1 + 1.5 * mode.gap };
  if (draw) {
    setText(doc, { size: mode.size, bold: true, color: COLORS.primary });
    doc.text(`${number}.`, PAGE.margin + 1, y + lineHeight(doc, mode.size) * 0.75);
    if (url) {
      setText(doc, { size: mode.size });
      const lines = wrapLines(doc, text, maxWidth);
      const lineIndex = lines.findIndex((l) => l.includes(url));
      if (lineIndex >= 0) {
        const line = lines[lineIndex];
        const lh = lineHeight(doc, mode.size);
        doc.link(opts.x + doc.getTextWidth(line.slice(0, line.indexOf(url))), y + lineIndex * lh, doc.getTextWidth(url), lh, { url });
      }
    }
  }
  return paragraph(doc, draw, text, y, opts);
}

/**
 * „So geht’s“ mit nummerierten Schritten (links) und QR-Code mit Beschriftung (rechts).
 * @returns {Promise<number>} y-Position unter der Gruppe
 */
async function stepsGroup(doc, draw, y, ctx, mode) {
  const qrSize = Math.min(QR_MAX, Math.max(mode.qr, ctx.qrCells * QR_MODULE));
  const gap = 6;
  const width = CONTENT_WIDTH - qrSize - gap;

  let left = paragraph(doc, draw, 'So geht’s', y, { size: mode.heading, bold: true, color: COLORS.primary, maxWidth: width, spacingAfter: 1 + mode.gap });
  const step1 = ctx.eventKey
    ? `Scannen Sie den QR-Code rechts mit Ihrem Smartphone – oder öffnen Sie ${PUBLIC_URL}, klicken Sie auf „Zugang für Eltern“ und geben Sie den Termin-Schlüssel ein.`
    : `Scannen Sie den QR-Code rechts mit Ihrem Smartphone – oder öffnen Sie ${PUBLIC_URL} und klicken Sie auf „Zugang für Eltern“.`;
  left = step(doc, draw, 1, step1, left, mode, { width, url: PUBLIC_URL });
  left = step(doc, draw, 2, 'Melden Sie sich mit Vorname, Nachname und Code Ihres Kindes aus dem gelben Kasten an.', left, mode, { width });
  left = step(doc, draw, 3, 'Markieren Sie alle Zeitslots grün, zu denen Sie Zeit hätten – auch mehrere getrennte Zeiträume sind möglich.', left, mode, { width });
  const mailTo = ctx.teacherEmail ? `an ${ctx.teacherEmail}` : 'an mich';
  left = step(doc, draw, 4, `Klicken Sie auf „Absenden“ und schicken Sie die erzeugte PDF-Datei per E-Mail ${mailTo}.`, left, mode, { width });

  const qrX = PAGE.margin + CONTENT_WIDTH - qrSize;
  const qrY = y + 1;
  setText(doc, { size: mode.small });
  const captionLines = doc.splitTextToSize('QR-Code scannen – die Termine werden automatisch geladen.', qrSize + 4);
  const right = qrY + qrSize + 1.5 + captionLines.length * lineHeight(doc, mode.small);
  if (draw) {
    await drawQrCode(doc, ctx.link, qrX, qrY, qrSize);
    doc.setDrawColor(COLORS.line);
    doc.setLineWidth(0.3);
    doc.rect(qrX, qrY, qrSize, qrSize, 'S');
    doc.link(qrX, qrY, qrSize, qrSize, { url: ctx.link });
    setText(doc, { size: mode.small, color: COLORS.muted });
    doc.text(captionLines, qrX + qrSize / 2, qrY + qrSize + 1.5 + lineHeight(doc, mode.small) * 0.75, { align: 'center' });
  }
  setText(doc);
  return Math.max(left, right) + 2 + 3 * mode.gap;
}

/**
 * Gelber Kasten mit den Zugangsdaten (volle Breite, damit der Code in einer Zeile bleibt) und
 * darunter der Termin-Schlüssel für Eltern, die die Adresse von Hand eintippen.
 * @returns {number} y-Position unter der Gruppe
 */
function accessGroup(doc, draw, y, ctx, student, mode) {
  const width = CONTENT_WIDTH;
  setText(doc, { size: 10 });
  const labelWidth = Math.max(...BOX_LABELS.map((l) => doc.getTextWidth(l))) + 8;
  const code = student.code;
  const valueWidth = width - 10 - labelWidth;
  let valueSize = fitSize(doc, code, mode.valueSize, valueWidth, 10);
  // Passt ein sehr langer Code gar nicht in eine Zeile, lieber gut lesbar umbrechen als winzig setzen.
  setText(doc, { size: valueSize, bold: true });
  if (doc.getTextWidth(code) > valueWidth) valueSize = Math.min(mode.valueSize, 12);
  const rows = [
    [BOX_LABELS[0], boxValue(doc, student.firstName || '–', valueWidth, valueSize)],
    [BOX_LABELS[1], boxValue(doc, student.lastName || '–', valueWidth, valueSize)],
    [BOX_LABELS[2], code],
  ];
  const boxOpts = { width, title: 'Ihre Zugangsdaten', labelWidth, valueSize };
  if (draw) drawInfoBox(doc, y, rows, { x: PAGE.margin, ...boxOpts });
  let bottom = y + infoBoxHeight(doc, rows, boxOpts) + 2.5;

  if (ctx.eventKey) {
    const lh = lineHeight(doc, mode.size);
    const label = 'Ohne QR-Code: Termin-Schlüssel ';
    setText(doc, { size: mode.size });
    const labelW = doc.getTextWidth(label);
    setText(doc, { size: mode.size, bold: true });
    const keyW = doc.getTextWidth(ctx.eventKey);
    const keyLines =
      labelW + keyW <= width
        ? [[{ text: label }, { text: ctx.eventKey, bold: true }]]
        : [[{ text: label.trim() }], ...wrapAtDashes(doc, ctx.eventKey, width).map((t) => [{ text: t, bold: true }])];
    if (draw) keyLines.forEach((parts, i) => richLine(doc, parts, PAGE.margin, bottom + i * lh + lh * 0.75, mode.size));
    bottom += keyLines.length * lh;
  }
  setText(doc);
  return bottom + 3 + 4 * mode.gap;
}

/**
 * Setzt einen Brief (draw = true) oder misst nur, wo er endet (draw = false).
 * @returns {Promise<number>} y-Position am Ende des Briefs
 */
async function layoutLetter(doc, draw, top, ctx, student, mode) {
  const g = mode.gap;
  const lh = lineHeight(doc, mode.size);
  let y = top;

  if (draw) {
    setText(doc, { size: mode.size, color: COLORS.muted });
    doc.text(`Klasse ${ctx.classId}`, PAGE.margin, y + lh * 0.75);
    doc.text(`Datum: ${ctx.date}`, PAGE.margin + CONTENT_WIDTH, y + lh * 0.75, { align: 'right' });
  }
  y += lh + 2 + 3 * g;

  y = paragraph(doc, draw, 'Elternsprechtag – bitte geben Sie Ihre freien Zeiten an', y, { size: mode.subject, bold: true, spacingAfter: 2 + 3 * g });
  const childName = `${student.firstName} ${student.lastName}`.trim();
  y = paragraph(doc, draw, `Liebe Eltern und Erziehungsberechtigte von ${childName},`, y, { size: mode.size, spacingAfter: 1.5 + g });
  y = paragraph(doc, draw, introText(ctx.days, mode.lean), y, { size: mode.size, spacingAfter: 1.5 + g });
  const required = 'Für die Terminkoordination ist es erforderlich, dass Sie für den Elternsprechtag alle Terminslots angeben, zu denen Sie Zeit für ein Gespräch hätten.';
  if (mode.lean) y = paragraph(doc, draw, required, y, { size: mode.size, bold: true, spacingAfter: 2 });
  else {
    y = paragraph(doc, draw, required, y, { size: mode.size, bold: true, spacingAfter: 0.5 });
    y = paragraph(doc, draw, 'Je mehr Zeiten Sie angeben, desto leichter lässt sich ein passender Termin finden. Ihren festen Termin teile ich Ihnen anschließend mit.', y, { size: mode.size, spacingAfter: 2 + 2 * g });
  }

  y = daysPanel(doc, draw, y, ctx, mode);

  y = await stepsGroup(doc, draw, y, ctx, mode);
  y = accessGroup(doc, draw, y, ctx, student, mode);

  y = paragraph(doc, draw, 'Vielen Dank für Ihre Rückmeldung!', y, { size: mode.size, spacingAfter: 1.5 + 2 * g });
  y = paragraph(doc, draw, 'Mit freundlichen Grüßen', y, { size: mode.size, spacingAfter: 1 + 3 * g });
  y = paragraph(doc, draw, ctx.teacherName, y, { size: mode.size, bold: true, spacingAfter: 0 });
  if (ctx.teacherEmail) y = paragraph(doc, draw, ctx.teacherEmail, y, { size: mode.size, color: COLORS.muted, spacingAfter: 0 });
  return y;
}

/**
 * Elternbriefe einer Klasse: eine DIN-A4-Seite pro Lernender/Lernendem mit Code.
 * @param {object} state – TeacherState
 * @param {string} classId – z. B. '5a'
 * @returns {Promise<{doc: object, filename: string, pageCount: number}>}
 */
export async function createParentLettersPdf(state, classId) {
  const cls = findClass(state, classId);
  if (!cls) throw new Error(`Die Klasse ${classId} wurde nicht gefunden.`);
  const students = (cls.students || []).filter((s) => s.code);
  if (students.length === 0) throw new Error('Für diese Klasse wurden noch keine Codes erzeugt.');
  const days = state.event?.days || [];
  if (days.length === 0) throw new Error('Bitte legen Sie zuerst den Elternsprechtag mit Tagen und Uhrzeiten an.');

  const t = state.teacher || {};
  const link = eventLink(state, cls.id);
  const ctx = {
    classId: cls.id,
    days,
    slotMinutes: state.event.slotMinutes || 10,
    teacherName: `${t.firstName || ''} ${t.lastName || ''}`.trim(),
    teacherEmail: t.email || '',
    link,
    eventKey: encodeEventKey(state.event),
    date: nowParts().date,
    qrCells: await qrCellCount(link),
  };
  if (ctx.qrCells * QR_MODULE_LIMIT > QR_MAX) throw new Error(QR_TOO_LONG);

  const doc = await createPdf();
  const address = addressText(doc, state.event.schoolAddress);
  for (let i = 0; i < students.length; i++) {
    if (i > 0) doc.addPage();
    const top = drawBrandHeader(doc, { subtitle: 'Elternsprechtag', rightText: address });
    let mode = MODES[MODES.length - 1];
    for (const candidate of MODES) {
      if ((await layoutLetter(doc, false, top, ctx, students[i], candidate)) <= BOTTOM) {
        mode = candidate;
        break;
      }
    }
    await layoutLetter(doc, true, top, ctx, students[i], mode);
  }
  drawFooters(doc, `Erstellt mit ${APP_NAME}`);
  embedPayload(
    doc,
    { app: APP_NAME, type: 'parent-letters', v: 1, classId: cls.id, count: students.length, createdAt: new Date().toISOString() },
    { title: `${APP_NAME} – Elternbriefe Klasse ${cls.id}`, author: ctx.teacherName },
  );
  return { doc, filename: lettersFilename(cls.id), pageCount: students.length };
}
