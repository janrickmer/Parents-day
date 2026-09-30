// Datenschutz-Hinweise: beschreibt, wie ParentsDay mit Daten umgeht.
// Ist ein digitaler Briefkasten eingerichtet (MAILBOX_URL), kommt ein eigener Abschnitt dazu, und die
// Sätze „kein Server“ bzw. „nur per PDF-Datei“ werden entsprechend angepasst.

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
            'ParentsDay ist eine Browser-Anwendung. Namen, Codes und Termine werden im Browser gespeichert. Für den digitalen Briefkasten gibt es einen kleinen Dienst, der die Rückmeldungen der Eltern nur verschlüsselt entgegennimmt und an die Lehrkraft weitergibt. Den Schlüssel dazu hat er nicht (siehe unten).',
          )
        : h('p', {}, 'ParentsDay ist eine reine Browser-Anwendung. Es gibt keinen Server, der Namen, Codes oder Termine speichert oder auswertet.'),
      h('h2', {}, 'Lehrkräfte'),
      h(
        'ul',
        {},
        withMailbox
          ? h('li', {}, 'Registrierungsdaten, Klassen, Namen der Lernenden, Rückmeldungen und Termine werden im Speicher dieses Browsers (localStorage) abgelegt. Beim digitalen Briefkasten liegen Rückmeldungen und Angaben aus dem Elternbrief nur verschlüsselt (siehe unten).')
          : h('li', {}, 'Registrierungsdaten, Klassen, Namen der Lernenden, Rückmeldungen und Termine werden nur im Speicher dieses Browsers (localStorage) abgelegt.'),
        h('li', {}, 'Mit „Zwischenstand speichern“ erhalten Sie eine Datei mit allen Daten. Bewahren Sie sie sicher auf – sie enthält personenbezogene Daten.'),
        withMailbox
          ? h('li', {}, 'Der Schlüssel zu Ihrem digitalen Briefkasten liegt nur in diesem Browser und in Ihrem Zwischenspeicher. Ohne ihn lassen sich die Rückmeldungen im Briefkasten nicht lesen.')
          : null,
        h('li', {}, 'Auf gemeinsam genutzten Geräten sollten Sie sich nach der Arbeit abmelden und die Browserdaten löschen.'),
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
      withMailbox ? mailboxSection() : null,
      h('h2', {}, 'Technik'),
      h(
        'p',
        {},
        'Alle Programmbibliotheken und Schriften werden direkt von dieser Seite geladen, nicht von fremden Servern. ',
        withMailbox ? 'Verbindungen zu einem anderen Dienst gibt es nur zum digitalen Briefkasten. ' : null,
        'Es werden keine Cookies und keine Analyse-Werkzeuge verwendet.',
      ),
      h('p', {}, h('a', { href: '#/' }, 'Zur Startseite')),
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
