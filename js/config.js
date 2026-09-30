// Zentrale Einstellungen für ParentsDay.

/** Öffentliche Adresse der Seite. Wird in Elternbriefe und QR-Codes gedruckt. */
export const PUBLIC_URL = 'https://parentsday.janrickmer.de';

/**
 * Adresse des digitalen Briefkastens (Cloudflare Worker, siehe docs/BRIEFKASTEN.md), z. B.
 * 'https://parentsday-briefkasten.<name>.workers.dev'. Leer = kein Briefkasten: Eltern schicken ihre
 * Rückmeldung dann als PDF bzw. E-Mail-Text. Die Adresse muss auch in index.html bei connect-src stehen
 * (`npm test` prüft das).
 */
export const MAILBOX_URL = '';

/** Anzeigename – immer mit großem „D“. */
export const APP_NAME = 'ParentsDay';

/** Version des gespeicherten Datenformats (Zwischenspeicher, localStorage). */
export const DATA_VERSION = 1;

// --- Grenzen des Elternsprechtags (gelten für die Lehrkraft-Formulare und für Link/Termin-Schlüssel) ---

/** Höchstens so viele Tage (Grenze des Termin-Schlüssels, siehe core/transport.js). */
export const MAX_EVENT_DAYS = 8;
/** Terminlänge in Minuten, die die Lehrkraft einstellen kann (in 5-Minuten-Schritten). */
export const SLOT_MIN = 5;
export const SLOT_MAX = 120;
/** Größte Terminlänge, die der Termin-Schlüssel darstellen kann (5 Bit × 5 Minuten). */
export const KEY_SLOT_MAX = 155;
/** Adresse der Schule: steht im Link/QR-Code des Elternbriefs, daher begrenzt. */
export const ADDRESS_MAX_CHARS = 200;
export const ADDRESS_MAX_LINES = 6;
/** Längste Eingabe für Vor- bzw. Nachnamen. */
export const NAME_MAX_LENGTH = 80;

// --- Größengrenzen für hochgeladene Dateien ---

/** Registrierungs-PDFs sind etwa 70 KB groß. */
export const MAX_REGISTRATION_BYTES = 20 * 1024 * 1024;
/** Rückmelde-PDFs sind etwa 70 KB groß; 25 MB deckt auch gespeicherte E-Mails mit Anhang ab. */
export const MAX_RESPONSE_FILE_BYTES = 25 * 1024 * 1024;
/** Zwischenspeicher: der Browser speichert ohnehin nur wenige MB. */
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
