import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registrationCode, teacherCode, nameNumber, studentNameCode, studentCode, parseStudentCode,
  checkStudentLogin, transliterate, initialOf, countLetters, birthNumber, codesEqual, isValidIsoDate,
} from '../../js/core/codes.js';

test('Beispiel aus der Rückfrage: Anna Meier, 15.03.1990', () => {
  assert.equal(registrationCode('Anna', 'Meier', '1990-03-15'), 'AM60127960');
  assert.equal(teacherCode('Anna', 'Meier', '1990-03-15'), 'A16595316960M');
});

test('Geburtstag mit führender Null wird als Zahl behandelt', () => {
  assert.equal(birthNumber('1990-03-05'), 5031990);
  assert.equal(registrationCode('Tom', 'Berg', '1990-03-05'), `TB${3 * 5031990}`);
  assert.equal(teacherCode('Tom', 'Berg', '1990-03-05'), `T${5031990 * 1104}B`);
});

test('Buchstaben des Vornamens: Umlaute zählen einfach, Bindestriche nicht', () => {
  assert.equal(countLetters('Jürgen'), 6);
  assert.equal(countLetters('Anna-Lena'), 8);
  assert.equal(countLetters('  Anna  Lena '), 8);
});

test('Anfangsbuchstaben werden großgeschrieben', () => {
  assert.equal(initialOf('anna'), 'A');
  assert.equal(initialOf('Özil'), 'Ö');
  assert.equal(initialOf(' -Lena'), 'L');
  assert.equal(initialOf(''), '');
});

test('Zahlencode des Namens: Anna = 114141', () => {
  assert.equal(nameNumber('Anna'), '114141');
  assert.equal(nameNumber('Beck'), '25311');
  assert.equal(studentNameCode('Anna', 'Beck'), '11414125311');
});

test('Umlaute werden umgeschrieben (ä→ae, ö→oe, ü→ue, ß→ss)', () => {
  assert.equal(transliterate('Müller'), 'mueller');
  assert.equal(transliterate('Jörg Weiß'), 'joergweiss');
  assert.equal(transliterate('Ärger'), 'aerger');
  assert.equal(nameNumber('Müller'), nameNumber('Mueller'));
  assert.equal(transliterate('Çelik'), 'celik');
  assert.equal(transliterate('Łukasz'), 'lukasz');
  assert.equal(transliterate('Şahin-Yıldız'), 'sahinyildiz');
  assert.equal(transliterate("O'Neill"), 'oneill');
  assert.equal(transliterate('Zoë'), 'zoe');
  // NFD-Eingabe (a + kombinierendes Trema) wird genauso behandelt
  assert.equal(transliterate('Müller'), 'mueller');
});

test('Schülercode setzt Klasse, Lehrkräftecode und Zahlencode zusammen', () => {
  const tc = teacherCode('Anna', 'Meier', '1990-03-15');
  assert.equal(studentCode(5, 'a', tc, 'Anna', 'Beck'), '5aA16595316960M11414125311');
  assert.equal(studentCode(13, 'h', tc, 'Anna', 'Beck'), '13hA16595316960M11414125311');
});

test('Schülercode lässt sich zerlegen', () => {
  const p = parseStudentCode('5aA16595316960M11414125311');
  assert.deepEqual(p, { grade: 5, letter: 'a', classId: '5a', teacherCode: 'A16595316960M', nameCode: '11414125311' });
  const p13 = parseStudentCode('13h a16595316960m 11414125311');
  assert.equal(p13.classId, '13h');
  assert.equal(p13.teacherCode, 'A16595316960M');
  assert.equal(parseStudentCode('14aA1M1'), null);
  assert.equal(parseStudentCode('5iA1M1'), null);
  assert.equal(parseStudentCode(''), null);
});

test('Eltern-Anmeldung prüft Name, Lehrkraft und Klasse', () => {
  const code = '5aA16595316960M11414125311';
  assert.equal(checkStudentLogin({ firstName: 'Anna', lastName: 'Beck', code }).ok, true);
  assert.equal(checkStudentLogin({ firstName: 'anna', lastName: 'beck', code: code.toLowerCase() }).ok, true);
  assert.equal(checkStudentLogin({ firstName: 'Anna', lastName: 'Beck', code }, { teacherCode: 'A16595316960M', classId: '5a' }).ok, true);
  assert.equal(checkStudentLogin({ firstName: 'Anne', lastName: 'Beck', code }).ok, false);
  assert.equal(checkStudentLogin({ firstName: 'Anna', lastName: 'Beck', code }, { teacherCode: 'B1M' }).ok, false);
  assert.equal(checkStudentLogin({ firstName: 'Anna', lastName: 'Beck', code }, { classId: '6a' }).ok, false);
  assert.equal(checkStudentLogin({ firstName: 'Anna', lastName: 'Beck', code }).code, code);
});

test('Codes vergleichen ohne Groß-/Kleinschreibung', () => {
  assert.ok(codesEqual('am60127960', 'AM60127960'));
  assert.ok(codesEqual(' AM 6012 7960 ', 'AM60127960'));
  assert.ok(!codesEqual('', ''));
});

test('Datumsprüfung', () => {
  assert.ok(isValidIsoDate('2024-02-29'));
  assert.ok(!isValidIsoDate('2023-02-29'));
  assert.ok(!isValidIsoDate('15.03.1990'));
});
