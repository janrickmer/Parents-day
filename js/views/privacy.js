// Datenschutz-Hinweise: beschreibt, wie ParentsDay mit Daten umgeht.
// Ist ein Dienst eingerichtet (MAILBOX_URL), kommen Abschnitte zur Cloud-Sicherung und zum digitalen Briefkasten
// dazu, und die Sätze „kein Server“ bzw. „nur per PDF-Datei“ werden entsprechend angepasst.

import { h, mount } from '../core/ui.js';
import { mailboxEnabled } from '../core/mailbox.js';

export default function render({ root, setTitle }) {
  setTitle('Datenschutz-Hinweise');
  const withMailbox = mailboxEnabled();
  mount(
    root,
    h(
      'article',
      { class: 'card card-narrow stack' },
      h('h1', {}, 'Datenschutz-Hinweise'),
      withMailbox
        ? h(
            'p',
            {},
            'ParentsDay ist eine Browser-Anwendung. Namen, Codes und Termine werden im Browser gespeichert. Dazu gibt es einen kleinen Dienst, der die Rückmeldungen der Eltern und die Cloud-Sicherung der Lehrkräfte nur verschlüsselt aufbewahrt. Die Schlüssel dazu hat er nicht (siehe unten).',
          )
        : h('p', {}, 'ParentsDay ist eine reine Browser-Anwendung. Es gibt keinen Server, der Namen, Codes oder Termine speichert oder auswertet.'),
      h('h2', {}, 'Lehrkräfte'),
      h(
        'ul',
        {},
        withMailbox
          ? h('li', {}, 'Registrierungsdaten, Klassen, Namen der Lernenden, Rückmeldungen und Termine werden im Speicher dieses Browsers (localStorage) abgelegt – und, mit Ihrem Passwort verschlüsselt, in Ihrer Cloud-Sicherung (siehe unten). Beim digitalen Briefkasten liegen Rückmeldungen und Angaben aus dem Elternbrief nur verschlüsselt.')
          : h('li', {}, 'Registrierungsdaten, Klassen, Namen der Lernenden, Rückmeldungen und Termine werden nur im Speicher dieses Browsers (localStorage) abgelegt.'),
        h('li', {}, 'Mit „Zwischenstand speichern“ erhalten Sie eine Datei mit allen Daten. Bewahren Sie sie sicher auf – sie enthält personenbezogene Daten.'),
        withMailbox
          ? h('li', {}, 'Der Schlüssel zu Ihrem digitalen Briefkasten liegt in diesem Browser, in Ihrer Cloud-Sicherung und in Ihrem Zwischenspeicher. Ohne ihn lassen sich die Rückmeldungen im Briefkasten nicht lesen.')
          : null,
        withMailbox
          ? h('li', {}, 'Auf gemeinsam genutzten Geräten wählen Sie beim Abmelden „Meine Daten von diesem Gerät entfernen“ und lassen das Passwort nicht merken.')
          : h('li', {}, 'Auf gemeinsam genutzten Geräten sollten Sie sich nach der Arbeit abmelden und die Browserdaten löschen.'),
      ),
      h('h2', {}, 'Eltern'),
      h(
        'ul',
        {},
        h('li', {}, 'Die Termindaten des Elternsprechtags stehen im Link bzw. QR-Code des Elternbriefs. Dieser Teil des Links wird nicht an den Webserver übertragen.'),
        h('li', {}, withMailbox ? 'Ihre Anmeldung und Ihre ausgewählten Zeiten werden in Ihrem Browser gespeichert.' : 'Ihre Anmeldung und Ihre ausgewählten Zeiten werden nur in Ihrem Browser gespeichert.'),
        withMailbox
          ? [
              h('li', {}, 'Mit „Absenden“ geht Ihre Rückmeldung (Name und Code des Kindes und Ihre freien Zeiten) verschlüsselt über den digitalen Briefkasten an die Lehrkraft.'),
              h('li', {}, 'Ist der Briefkasten nicht erreichbar oder wurde Ihr Elternbrief ohne Briefkasten erstellt, schicken Sie die Rückmeldung als Notlösung selbst per E-Mail – als PDF-Datei oder als E-Mail-Text.'),
            ]
          : h('li', {}, 'Die Rückmeldung an die Lehrkraft erfolgt ausschließlich über die PDF-Datei, die Sie selbst per E-Mail versenden.'),
      ),
      withMailbox ? cloudSection() : null,
      withMailbox ? mailboxSection() : null,
      h('h2', {}, 'Technik'),
      h(
        'p',
        {},
        'Alle Programmbibliotheken und Schriften werden direkt von dieser Seite geladen, nicht von fremden Servern. ',
        withMailbox ? 'Verbindungen zu einem anderen Dienst gibt es nur zum Dienst für den digitalen Briefkasten und die Cloud-Sicherung. ' : null,
        'Es werden keine Cookies und keine Analyse-Werkzeuge verwendet.',
      ),
      h('p', {}, h('a', { href: '#/' }, 'Zur Startseite')),
    ),
  );
}

/** Abschnitt „Cloud-Sicherung der Lehrkräfte“ (nur mit Dienst). */
function cloudSection() {
  return h(
    'section',
    { class: 'stack-small', 'aria-labelledby': 'privacy-cloud-title', 'data-testid': 'privacy-cloud' },
    h('h2', { id: 'privacy-cloud-title' }, 'Cloud-Sicherung der Lehrkräfte'),
    h(
      'ul',
      {},
      h('li', {}, 'Der komplette Stand der Lehrkraft (Elternsprechtag, Klassen, Namen der Lernenden, Rückmeldungen, Termine, Schlüssel des Briefkastens) wird im Browser mit ihrem Passwort verschlüsselt (AES-256-GCM; Schlüssel aus dem Passwort mit PBKDF2 und HKDF) und so beim Dienst bei Cloudflare abgelegt.'),
      h('li', {}, 'Das Passwort verlässt den Browser nie. Auch die Adresse der Sicherung beim Dienst wird aus dem Passwort berechnet: Ohne das Passwort lässt sich die Sicherung weder finden noch lesen oder löschen. Wer die Datenbank des Dienstes verwaltet, kann sie zwar nicht lesen, aber technisch löschen.'),
      h(
        'li',
        {},
        'Um das Ausprobieren von Passwörtern zu verhindern, zählt der Dienst Versuche, eine Sicherung zu öffnen oder anzulegen (auch Anmeldungen mit falschem Passwort) – je Lehrkraft (anhand eines Hashwerts aus Name und Geburtsdatum, der nicht mit der Sicherung gespeichert wird) und Internetanschluss. Statt der IP-Adresse speichert er dafür einen pseudonymen Hashwert, der täglich wechselt; diese Zähler werden nach spätestens zwei Tagen gelöscht.',
      ),
      h('li', {}, 'Die Lehrkraft kann die Cloud-Sicherung jederzeit unter „Weitere Einstellungen“ löschen. Wird sie 400 Tage weder geändert noch abgerufen, wird sie automatisch gelöscht – eine Sicherung, die nach dem Einrichten nie genutzt wurde, schon nach 30 Tagen.'),
      h('li', {}, 'Ist das Passwort auf einem Gerät gemerkt, liegen die daraus berechneten Schlüssel im Speicher dieses Browsers – wie der Stand selbst auch. Zum Ändern des Passworts und zum Löschen der Sicherung ist immer das Passwort nötig.'),
    ),
  );
}

/** Abschnitt „Digitaler Briefkasten“ (nur wenn er eingerichtet ist). */
function mailboxSection() {
  return h(
    'section',
    { class: 'stack-small', 'aria-labelledby': 'privacy-mailbox-title', 'data-testid': 'privacy-mailbox' },
    h('h2', { id: 'privacy-mailbox-title' }, 'Digitaler Briefkasten'),
    h(
      'ul',
      {},
      h('li', {}, 'Rückmeldungen werden im Browser der Eltern Ende-zu-Ende verschlüsselt und über einen Dienst bei Cloudflare zur Lehrkraft übertragen. Entschlüsseln kann sie nur die Lehrkraft mit ihrem Schlüssel.'),
      h('li', {}, 'Cloudflare kann den Inhalt nicht lesen – weder Namen noch Codes noch Zeiten.'),
      h('li', {}, 'Technisch bedingt verarbeitet Cloudflare dabei IP-Adressen und den Zeitpunkt der Verbindung. Der Briefkasten legt keine IP-Adressen in seiner Datenbank ab.'),
      h('li', {}, 'Gespeicherte Rückmeldungen werden nach spätestens 200 Tagen gelöscht oder früher, wenn die Lehrkraft den Briefkasten leert.'),
      h(
        'li',
        {},
        'Damit Eltern ohne QR-Code (mit dem Termin-Schlüssel aus dem Elternbrief) den Briefkasten finden, legt ParentsDay beim Erstellen der Elternbriefe die Angaben aus dem Brief verschlüsselt beim Dienst ab: Name, E-Mail-Adresse und Lehrkräftecode der Lehrkraft, Adresse der Schule, Klasse, Tage und Uhrzeiten. Öffnen lässt sich dieser Eintrag nur mit Lehrkräftecode, Klasse und Termin-Schlüssel; Eltern, die sich mit dem Termin-Schlüssel anmelden, rufen ihn ab. Namen von Kindern oder Eltern enthält er nicht. Wird er 200 Tage lang nicht mehr erneuert, wird er gelöscht.',
      ),
    ),
  );
}
