// Registrierungs-PDF der Lehrkraft: Angaben, Registrierungscode, Lehrkräftecode und Anleitung zum Anmelden.
// Die Daten stehen zusätzlich maschinenlesbar in den PDF-Metadaten, damit die Anmeldung per Datei-Upload klappt.

import { PUBLIC_URL, APP_NAME } from '../config.js';
import { createPdf, drawBrandHeader, writeParagraph, drawInfoBox, drawFooters, embedPayload, setText, lineHeight, PAGE, CONTENT_WIDTH, COLORS } from '../core/pdf.js';
import { registrationCode, teacherCode } from '../core/codes.js';
import { formatDate, nowParts } from '../core/time.js';
import { mailboxEnabled } from '../core/mailbox.js';

/** Dateiname der Registrierungs-PDF, z. B. „ParentsDay Registrierung Anna Meier.pdf“. */
export function registrationFilename(teacher) {
  return `${APP_NAME} Registrierung ${teacher.firstName} ${teacher.lastName}.pdf`;
}

/** Größte Schriftgröße (höchstens `size`), bei der `text` in `maxWidth` passt. */
function fitFontSize(doc, text, size, maxWidth, minSize = 10) {
  let s = size;
  for (; s > minSize; s -= 0.5) {
    setText(doc, { size: s, bold: true });
    if (doc.getTextWidth(text) <= maxWidth) break;
  }
  return s;
}

/** Eine Spalte im gelben Code-Kasten: Beschriftung, Code, kurze Erklärung. Gibt die Unterkante zurück. */
function drawCodeColumn(doc, { x, y, width, label, code, size, hint }) {
  let cy = y;
  setText(doc, { size: 10, bold: true, color: COLORS.muted });
  doc.text(label, x, cy + lineHeight(doc, 10) * 0.75);
  cy += lineHeight(doc, 10) + 1;
  const codeSize = fitFontSize(doc, code, size, width);
  setText(doc, { size: codeSize, bold: true, color: COLORS.text });
  doc.text(code, x, cy + lineHeight(doc, codeSize) * 0.75);
  cy += lineHeight(doc, codeSize) + 1;
  setText(doc, { size: 9, color: COLORS.muted });
  const lines = doc.splitTextToSize(hint, width);
  doc.text(lines, x, cy + lineHeight(doc, 9) * 0.75);
  cy += lines.length * lineHeight(doc, 9);
  return cy;
}

/** Hervorgehobener gelber Kasten mit Registrierungscode (groß) und Lehrkräftecode. */
function drawCodeBox(doc, y, teacher) {
  const pad = 6;
  const x = PAGE.margin;
  const leftWidth = CONTENT_WIDTH * 0.54 - pad * 2;
  const rightX = x + CONTENT_WIDTH * 0.54 + pad;
  const rightWidth = CONTENT_WIDTH * 0.46 - pad * 2;
  const columns = [
    {
      x: x + pad,
      width: leftWidth,
      label: 'Registrierungscode',
      code: teacher.registrationCode,
      size: 26,
      hint: 'Zum Anmelden – zusammen mit Vorname, Nachname und Geburtsdatum.',
    },
    {
      x: rightX,
      width: rightWidth,
      label: 'Lehrkräftecode',
      code: teacher.teacherCode,
      size: 17,
      hint: 'Ihre persönliche Kennung. Sie ist Teil der Codes Ihrer Schülerinnen und Schüler.',
    },
  ];
  // Erst die Höhe messen, dann Kasten und Inhalt zeichnen.
  const bottoms = columns.map((col) => measureCodeColumn(doc, col));
  const height = Math.max(...bottoms) + pad * 2;
  doc.setFillColor(COLORS.yellowFill);
  doc.setDrawColor(COLORS.yellowBorder);
  doc.setLineWidth(0.8);
  doc.roundedRect(x, y, CONTENT_WIDTH, height, 2.5, 2.5, 'FD');
  doc.setLineWidth(0.3);
  doc.line(x + CONTENT_WIDTH * 0.54, y + pad, x + CONTENT_WIDTH * 0.54, y + height - pad);
  for (const col of columns) drawCodeColumn(doc, { ...col, y: y + pad });
  setText(doc);
  return y + height + 7;
}

/** Höhe einer Code-Spalte (ohne zu zeichnen). */
function measureCodeColumn(doc, { width, code, size, hint }) {
  const codeSize = fitFontSize(doc, code, size, width);
  setText(doc, { size: 9 });
  const hintLines = doc.splitTextToSize(hint, width).length;
  return lineHeight(doc, 10) + 1 + lineHeight(doc, codeSize) + 1 + hintLines * lineHeight(doc, 9);
}

const STEP_INDENT = 8;

/** Nummerierter Schritt mit hängendem Einzug. Eine Adresse in der ersten Zeile wird anklickbar. */
function writeStep(doc, number, text, y, { url = '' } = {}) {
  setText(doc, { size: 11, bold: true, color: COLORS.primary });
  doc.text(`${number}.`, PAGE.margin + 1, y + lineHeight(doc, 11) * 0.75);
  if (url) {
    setText(doc, { size: 11 });
    const [first] = doc.splitTextToSize(text, CONTENT_WIDTH - STEP_INDENT);
    const at = first.indexOf(url);
    if (at >= 0) doc.link(PAGE.margin + STEP_INDENT + doc.getTextWidth(first.slice(0, at)), y, doc.getTextWidth(url), lineHeight(doc, 11), { url });
  }
  return writeParagraph(doc, text, y, { x: PAGE.margin + STEP_INDENT, maxWidth: CONTENT_WIDTH - STEP_INDENT, spacingAfter: 2.5 });
}

/**
 * Registrierungs-PDF der Lehrkraft.
 * @param {{firstName,lastName,birthDate,email,registrationCode,teacherCode}} teacher
 * @returns {Promise<{doc: object, filename: string, payload: object}>}
 */
export async function createRegistrationPdf(teacher) {
  const t = {
    firstName: String(teacher.firstName || ''),
    lastName: String(teacher.lastName || ''),
    birthDate: String(teacher.birthDate || ''),
    email: String(teacher.email || ''),
    registrationCode: teacher.registrationCode || registrationCode(teacher.firstName, teacher.lastName, teacher.birthDate),
    teacherCode: teacher.teacherCode || teacherCode(teacher.firstName, teacher.lastName, teacher.birthDate),
  };
  const name = `${t.firstName} ${t.lastName}`.trim();
  const payload = {
    app: APP_NAME,
    type: 'teacher-registration',
    v: 1,
    firstName: t.firstName,
    lastName: t.lastName,
    birthDate: t.birthDate,
    email: t.email,
    registrationCode: t.registrationCode,
    teacherCode: t.teacherCode,
    createdAt: new Date().toISOString(),
  };

  const doc = await createPdf();
  let y = drawBrandHeader(doc, { subtitle: 'Registrierung für Lehrkräfte', rightText: `Erstellt am ${nowParts().date}` });

  y = writeParagraph(doc, `Ihre Registrierung bei ${APP_NAME}`, y, { size: 20, bold: true, spacingAfter: 4 });
  y = writeParagraph(doc, `Guten Tag ${name},`, y, { spacingAfter: 1.5 });
  y = writeParagraph(
    doc,
    `vielen Dank für Ihre Registrierung. In diesem Dokument finden Sie Ihre Angaben und Ihre persönlichen Codes. Mit dieser PDF-Datei – oder mit Ihrem Registrierungscode – können Sie sich jederzeit wieder bei ${APP_NAME} anmelden.`,
    y,
    { spacingAfter: 6 },
  );

  y = drawInfoBox(
    doc,
    y,
    [
      ['Vorname', t.firstName],
      ['Nachname', t.lastName],
      ['Geburtsdatum', formatDate(t.birthDate)],
      ['E-Mail-Adresse', t.email || '–'],
    ],
    { title: 'Ihre Angaben', fill: COLORS.primaryLight, border: COLORS.primary, labelWidth: 45, valueSize: 12 },
  );

  y = drawCodeBox(doc, y + 1, t);

  y = writeParagraph(doc, 'So melden Sie sich an', y, { size: 14, bold: true, color: COLORS.primary, spacingAfter: 2.5 });
  y = writeStep(doc, 1, `Öffnen Sie ${PUBLIC_URL} und klicken Sie auf „Zugang für Lehrkräfte“ und danach auf „Anmelden“.`, y, { url: PUBLIC_URL });
  y = writeStep(doc, 2, 'Laden Sie diese PDF-Datei hoch – oder geben Sie Vorname, Nachname, Geburtsdatum und Registrierungscode ein.', y);
  y += 4;

  y = writeParagraph(doc, 'Gut zu wissen', y, { size: 14, bold: true, color: COLORS.primary, spacingAfter: 2.5 });
  y = writeParagraph(
    doc,
    mailboxEnabled()
      ? `${APP_NAME} speichert Ihre Daten in Ihrem Browser und – mit Ihrem Passwort verschlüsselt – in der Cloud-Sicherung. An einem neuen Gerät melden Sie sich an und geben das Passwort ein; dann ist Ihr aktueller Stand da. Ihr Passwort steht aus Sicherheitsgründen nicht in diesem Dokument. Ohne es lässt sich die Cloud-Sicherung nicht öffnen – auch nicht von ${APP_NAME}.`
      : `${APP_NAME} speichert Ihre Daten nur in dem Browser, mit dem Sie arbeiten – nicht auf einem Server. Möchten Sie an einem anderen Gerät weiterarbeiten, speichern Sie über „Zwischenstand speichern“ eine Datei und laden Sie diese dort nach der Anmeldung über „Zwischenstand laden“.`,
    y,
    { spacingAfter: 4 },
  );
  writeParagraph(doc, 'Bitte bewahren Sie dieses Dokument vertraulich auf.', y, { bold: true, spacingAfter: 0 });

  drawFooters(doc);
  embedPayload(doc, payload, { title: `${APP_NAME} – Registrierung ${name}`, author: name });
  return { doc, filename: registrationFilename(t), payload };
}
