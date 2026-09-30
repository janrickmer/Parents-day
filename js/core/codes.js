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

/** Anfangsbuchstabe eines Lehrkräftecodes zum Vergleichen: ohne Akzente (Ł→L, Ç→C), großgeschrieben;
 * „I“ und „l“ sehen in vielen Schriften gleich aus und gelten deshalb als gleich. */
function initialKey(ch) {
  const plain = transliterate(ch).charAt(0).toUpperCase() || String(ch).toLocaleUpperCase('de-DE');
  return plain === 'I' ? 'L' : plain;
}

/** Vergleichbare Form eines Lehrkräftecodes (siehe initialKey). */
export function teacherCodeKey(code) {
  const clean = normalizeCodeInput(code);
  const m = /^(\p{L})(\d+)(\p{L})$/u.exec(clean);
  if (!m) return clean.toLocaleUpperCase('de-DE');
  return `${initialKey(m[1])}${m[2]}${initialKey(m[3])}`;
}

/**
 * Gehören zwei Lehrkräftecodes zusammen? Wie codesEqual, aber tolerant bei den Anfangsbuchstaben:
 * „L“ statt „Ł“, „Z“ statt „Ż“ oder „l“ statt „I“ (abgetippt aus dem Elternbrief) gelten als gleich.
 */
export function teacherCodesMatch(a, b) {
  const key = teacherCodeKey(a);
  return key !== '' && key === teacherCodeKey(b);
}

/** Gehören zwei Schülercodes zum selben Kind (Klasse, Lehrkräftecode tolerant, Zahlencode)? */
export function studentCodesMatch(a, b) {
  const pa = parseStudentCode(a);
  const pb = parseStudentCode(b);
  if (!pa || !pb) return codesEqual(a, b);
  return pa.classId === pb.classId && pa.nameCode === pb.nameCode && teacherCodesMatch(pa.teacherCode, pb.teacherCode);
}

/** Hinweis, wenn ein Code zu einem anderen Elternbrief gehört als der geöffnete Link. */
const OTHER_LETTER_HINT = 'Bitte scannen Sie den QR-Code aus dem Elternbrief dieses Kindes – oder geben Sie den Termin-Schlüssel aus diesem Brief ein.';

/**
 * Prüft die Eltern-Anmeldung (Vorname, Nachname, Code des Kindes).
 * @param {{firstName:string, lastName:string, code:string}} input
 * @param {{teacherCode?:string, classId?:string}} [expected] – bekannte Daten aus dem Elternbrief-Link
 * @returns {{ok:true, parsed:object, code:string} | {ok:false, error:string, reason:string}}
 *   reason: 'names' | 'code' | 'format' | 'name-code' | 'teacher' | 'class'
 */
export function checkStudentLogin({ firstName, lastName, code }, expected = {}) {
  if (!cleanName(firstName) || !cleanName(lastName)) {
    return { ok: false, reason: 'names', error: 'Bitte geben Sie Vor- und Nachnamen des Kindes ein.' };
  }
  if (!normalizeCodeInput(code)) {
    return { ok: false, reason: 'code', error: 'Bitte geben Sie den Code aus dem Elternbrief ein.' };
  }
  const parsed = parseStudentCode(code);
  if (!parsed) {
    return { ok: false, reason: 'format', error: 'Der Code hat nicht das erwartete Format. Bitte geben Sie ihn genau so ein, wie er im gelben Kasten des Elternbriefs steht.' };
  }
  if (parsed.nameCode !== studentNameCode(firstName, lastName)) {
    return { ok: false, reason: 'name-code', error: 'Name und Code passen nicht zusammen. Bitte geben Sie Vor- und Nachnamen genau wie im Elternbrief ein.' };
  }
  if (expected.teacherCode && !teacherCodesMatch(parsed.teacherCode, expected.teacherCode)) {
    return { ok: false, reason: 'teacher', error: `Dieser Code gehört zu einem anderen Elternbrief (andere Lehrkraft) als der geöffnete Link. ${OTHER_LETTER_HINT}` };
  }
  if (expected.classId && parsed.classId !== String(expected.classId).toLowerCase()) {
    return { ok: false, reason: 'class', error: `Dieser Code gehört nicht zur Klasse ${expected.classId}. ${OTHER_LETTER_HINT}` };
  }
  // Mit bekanntem Lehrkräftecode gilt dessen Schreibweise (z. B. „Ł“ statt abgetipptem „L“).
  const canonical = expected.teacherCode ? { ...parsed, teacherCode: String(expected.teacherCode) } : parsed;
  return { ok: true, parsed: canonical, code: canonicalStudentCode(canonical) };
}

/** Schreibweise eines Codes wie von der Lehrkraft erzeugt (Klassenbuchstabe klein, Initialen groß). */
export function canonicalStudentCode(parsed) {
  return `${parsed.classId}${parsed.teacherCode}${parsed.nameCode}`;
}

// Keine Zeichen, die einen mailto:-Link zerteilen würden (? # & , ; …).
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"?#&/]+@[^\s@,;:<>()[\]\\"?#&/]+\.[^\s@,;:<>()[\]\\"?#&/.]{2,}$/;

/** Prüft eine E-Mail-Adresse (auch auf Tauglichkeit für mailto:-Links). */
export function isValidEmail(value) {
  const email = String(value ?? '').trim();
  return email.length <= 254 && !email.includes('..') && EMAIL_RE.test(email);
}

/**
 * Prüft, ob gespeicherte Lehrkraft-Daten zur selben Person gehören. Der Lehrkräftecode allein ist nicht
 * eindeutig (gleiche Anfangsbuchstaben und gleiches Geburtsdatum ergeben denselben Code).
 */
export function isSameTeacher(stored, firstName, lastName, birthDate) {
  if (!stored) return false;
  return (
    transliterate(stored.firstName) === transliterate(firstName) &&
    transliterate(stored.lastName) === transliterate(lastName) &&
    String(stored.birthDate) === String(birthDate)
  );
}

/** Prüft, ob ein Name für den Zahlencode verwendbar ist (mindestens ein Buchstabe A–Z nach Umschreibung). */
export function hasCodeLetters(name) {
  return transliterate(name).length > 0;
}
