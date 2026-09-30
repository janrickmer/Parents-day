// Berechnung aller Codes von ParentsDay.
//
// Registrierungscode: Anfangsbuchstabe Vorname + Anfangsbuchstabe Nachname
//                     + (Anzahl Buchstaben des Vornamens × Geburtsdatum als TTMMJJJJ)
//                     Beispiel: Anna Meier, 15.03.1990 → "AM" + 4 × 15031990 = "AM60127960"
// Lehrkräftecode:     Anfangsbuchstabe Vorname + (TTMMJJJJ × 1104) + Anfangsbuchstabe Nachname
//                     Beispiel: "A" + 15031990 × 1104 + "M" = "A16595316960M"
// Schülercode:        Jahrgangsstufe + Klassenbuchstabe + Lehrkräftecode + Zahlencode(Vorname) + Zahlencode(Nachname)
//                     Zahlencode: A=1 … Z=26, Ziffern direkt hintereinander (Anna → 114141).
//                     Umlaute werden umgeschrieben (ä→ae, ö→oe, ü→ue, ß→ss), Akzente entfernt,
//                     alle anderen Zeichen (Bindestrich, Leerzeichen, Apostroph …) ignoriert.

const SPECIAL_LETTERS = {
  'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss',
  'æ': 'ae', 'œ': 'oe', 'ø': 'oe',
  'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i',
};
const SPECIAL_RE = new RegExp(`[${Object.keys(SPECIAL_LETTERS).join('')}]`, 'g');

/** Entfernt überflüssige Leerzeichen und vereinheitlicht die Unicode-Darstellung. */
export function cleanName(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Anfangsbuchstabe (erster Buchstabe) eines Namens, großgeschrieben. Leerer String, wenn keiner existiert. */
export function initialOf(name) {
  const match = cleanName(name).match(/\p{L}/u);
  if (!match) return '';
  // „ß“ würde zu „SS“ – daher nur das erste Zeichen verwenden.
  return [...match[0].toLocaleUpperCase('de-DE')][0];
}

/** Anzahl der Buchstaben eines Namens (Umlaute zählen als ein Buchstabe, Bindestriche/Leerzeichen nicht). */
export function countLetters(name) {
  return (cleanName(name).match(/\p{L}/gu) || []).length;
}

/**
 * Wandelt ein ISO-Datum (JJJJ-MM-TT) in die Zahl TTMMJJJJ um.
 * 1990-03-15 → 15031990, 1990-03-05 → 5031990 (führende Null entfällt als Zahl).
 */
export function birthNumber(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ''));
  if (!m) throw new Error('Ungültiges Geburtsdatum.');
  return Number(`${m[3]}${m[2]}${m[1]}`);
}

/** Prüft, ob ein ISO-Datum ein real existierendes Kalenderdatum ist. */
export function isValidIsoDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate ?? ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function registrationCode(firstName, lastName, birthDate) {
  return `${initialOf(firstName)}${initialOf(lastName)}${countLetters(firstName) * birthNumber(birthDate)}`;
}

export function teacherCode(firstName, lastName, birthDate) {
  return `${initialOf(firstName)}${birthNumber(birthDate) * 1104}${initialOf(lastName)}`;
}

/** Name → nur Buchstaben a–z (kleingeschrieben), Umlaute umgeschrieben, Akzente entfernt. */
export function transliterate(name) {
  let s = cleanName(name).toLocaleLowerCase('de-DE');
  s = s.replace(SPECIAL_RE, (ch) => SPECIAL_LETTERS[ch]);
  s = s.normalize('NFD').replace(/\p{M}/gu, '');
  return s.replace(/[^a-z]/g, '');
}

/** Zahlencode eines Namens: jeder Buchstabe → Position im Alphabet (Anna → "114141"). */
export function nameNumber(name) {
  return [...transliterate(name)].map((ch) => String(ch.charCodeAt(0) - 96)).join('');
}

/** Zahlencode des Kindes: erst Vorname, dann Nachname. */
export function studentNameCode(firstName, lastName) {
  return `${nameNumber(firstName)}${nameNumber(lastName)}`;
}

export function classId(grade, letter) {
  return `${Number(grade)}${String(letter).toLowerCase()}`;
}

export function studentCode(grade, letter, tCode, firstName, lastName) {
  return `${classId(grade, letter)}${tCode}${studentNameCode(firstName, lastName)}`;
}

/** Entfernt Leerzeichen/Bindestriche aus einer Code-Eingabe. */
export function normalizeCodeInput(value) {
  return String(value ?? '').normalize('NFC').replace(/[\s\-–]+/g, '');
}

/** Vergleicht zwei Codes ohne Beachtung von Groß-/Kleinschreibung und Leerzeichen. */
export function codesEqual(a, b) {
  const norm = (v) => normalizeCodeInput(v).toLocaleUpperCase('de-DE');
  return norm(a) !== '' && norm(a) === norm(b);
}

const STUDENT_CODE_RE = /^(1[0-3]|[1-9])([a-h])(\p{L})(\d+)(\p{L})(\d+)$/iu;

/**
 * Zerlegt einen Schülercode in seine Bestandteile.
 * @returns {{grade:number, letter:string, classId:string, teacherCode:string, nameCode:string} | null}
 */
export function parseStudentCode(code) {
  const m = STUDENT_CODE_RE.exec(normalizeCodeInput(code));
  if (!m) return null;
  const up = (ch) => ch.toLocaleUpperCase('de-DE');
  const grade = Number(m[1]);
  const letter = m[2].toLowerCase();
  return {
    grade,
    letter,
    classId: `${grade}${letter}`,
    teacherCode: `${up(m[3])}${m[4]}${up(m[5])}`,
    nameCode: m[6],
  };
}

/**
 * Prüft die Eltern-Anmeldung (Vorname, Nachname, Code des Kindes).
 * @param {{firstName:string, lastName:string, code:string}} input
 * @param {{teacherCode?:string, classId?:string}} [expected] – bekannte Daten aus dem Elternbrief-Link
 * @returns {{ok:true, parsed:object, code:string} | {ok:false, error:string}}
 */
export function checkStudentLogin({ firstName, lastName, code }, expected = {}) {
  if (!cleanName(firstName) || !cleanName(lastName)) {
    return { ok: false, error: 'Bitte Vor- und Nachnamen des Kindes eingeben.' };
  }
  if (!normalizeCodeInput(code)) {
    return { ok: false, error: 'Bitte den Code aus dem Elternbrief eingeben.' };
  }
  const parsed = parseStudentCode(code);
  if (!parsed) {
    return { ok: false, error: 'Der Code hat nicht das erwartete Format. Bitte genau so eingeben, wie er im gelben Kasten des Elternbriefs steht.' };
  }
  if (parsed.nameCode !== studentNameCode(firstName, lastName)) {
    return { ok: false, error: 'Name und Code passen nicht zusammen. Bitte Vor- und Nachnamen genau wie im Elternbrief eingeben.' };
  }
  if (expected.teacherCode && !codesEqual(parsed.teacherCode, expected.teacherCode)) {
    return { ok: false, error: 'Dieser Code gehört zu einer anderen Lehrkraft als der geöffnete Link. Bitte den QR-Code des passenden Elternbriefs verwenden.' };
  }
  if (expected.classId && parsed.classId !== String(expected.classId).toLowerCase()) {
    return { ok: false, error: `Dieser Code gehört nicht zur Klasse ${expected.classId}.` };
  }
  return { ok: true, parsed, code: canonicalStudentCode(parsed) };
}

/** Schreibweise eines Codes wie von der Lehrkraft erzeugt (Klassenbuchstabe klein, Initialen groß). */
export function canonicalStudentCode(parsed) {
  return `${parsed.classId}${parsed.teacherCode}${parsed.nameCode}`;
}

/** Prüft, ob ein Name für den Zahlencode verwendbar ist (mindestens ein Buchstabe A–Z nach Umschreibung). */
export function hasCodeLetters(name) {
  return transliterate(name).length > 0;
}
