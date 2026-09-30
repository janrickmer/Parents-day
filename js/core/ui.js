// Kleine DOM-Hilfen, Dialoge, Hinweise (Toasts), Datei-Uploads und Downloads.

/**
 * Erzeugt ein DOM-Element.
 *   h('button', { class: 'btn btn-primary', onclick: fn, disabled: true }, 'Text', otherNode)
 * Attribute: class, style (String oder Objekt), dataset (Objekt), on<event> (Funktion),
 * boolesche Attribute (true/false), alle anderen als Attribut. Kinder: Strings, Nodes, Arrays, null/false.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' && 'value' in el) el.value = value;
    else if (key === 'checked' || key === 'selected') el[key] = Boolean(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Leert ein Element und fügt neue Kinder ein. */
export function mount(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
  return el;
}

// ---------- Toasts ----------

let toastHost = null;

/**
 * Kurzer Hinweis unten rechts.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 */
export function toast(message, type = 'info', timeout = 4500) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: `toast toast-${type}` }, message);
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-hide');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// ---------- Dialoge ----------

/**
 * Modaler Dialog.
 * @param {{title:string, content: Node|string|Array, actions?: Array<{label:string, variant?:string, onClick?:(close:Function)=>void, value?:any}>, onClose?:Function, wide?:boolean}} opts
 * @returns {{close: (value?:any)=>void, result: Promise<any>, element: HTMLElement}}
 */
export function modal({ title, content, actions = [], onClose, wide = false }) {
  let resolve;
  const result = new Promise((r) => (resolve = r));
  const previouslyFocused = document.activeElement;
  const close = (value) => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    onClose?.(value);
    resolve(value);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close(undefined);
  };
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = h(
    'div',
    { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('h2', { class: 'modal-title', id: titleId }, title),
    h('div', { class: 'modal-body' }, content),
    actions.length
      ? h(
          'div',
          { class: 'modal-actions' },
          actions.map((a) =>
            h('button', { type: 'button', class: `btn btn-${a.variant || 'secondary'}`, onclick: () => (a.onClick ? a.onClick(close) : close(a.value)) }, a.label),
          ),
        )
      : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => e.target === backdrop && close(undefined) }, dialog);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  const focusTarget = dialog.querySelector('input, select, textarea, .btn-primary, .btn-danger, button');
  focusTarget?.focus();
  return { close, result, element: dialog };
}

/** Sicherheitsabfrage. Gibt true zurück, wenn bestätigt. */
export function confirmDialog({ title = 'Bitte bestätigen', message, confirmText = 'OK', cancelText = 'Abbrechen', danger = false }) {
  return modal({
    title,
    content: typeof message === 'string' ? h('p', {}, message) : message,
    actions: [
      { label: cancelText, variant: 'secondary', value: false },
      { label: confirmText, variant: danger ? 'danger' : 'primary', value: true },
    ],
  }).result.then(Boolean);
}

/** Einfache Meldung mit OK-Knopf. */
export function alertDialog({ title, message }) {
  return modal({ title, content: typeof message === 'string' ? h('p', {}, message) : message, actions: [{ label: 'OK', variant: 'primary', value: true }] }).result;
}

// ---------- Dateien ----------

/**
 * Upload-Feld mit Drag & Drop.
 * @param {{accept?:string, multiple?:boolean, label:string, hint?:string, onFiles:(files: File[])=>void, compact?:boolean, testId?:string}} opts
 */
export function fileDropZone({ accept = '', multiple = false, label, hint = '', onFiles, compact = false, testId }) {
  const input = h('input', { type: 'file', accept, multiple, class: 'visually-hidden', tabindex: '-1' });
  const zone = h(
    'div',
    { class: `dropzone${compact ? ' dropzone-compact' : ''}`, role: 'button', tabindex: '0', 'aria-label': label, 'data-testid': testId },
    h('div', { class: 'dropzone-icon', 'aria-hidden': 'true' }, '⬆'),
    h('div', { class: 'dropzone-label' }, label),
    hint ? h('div', { class: 'dropzone-hint' }, hint) : null,
    input,
  );
  const emit = (fileList) => {
    const files = [...(fileList || [])];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  zone.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    emit(input.files);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dropzone-active');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dropzone-active'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dropzone-active');
    emit(e.dataTransfer?.files);
  });
  return zone;
}

/** Entfernt Zeichen, die in Dateinamen nicht erlaubt sind. */
export function safeFilename(name) {
  return String(name)
    .replace(/[\\/*?"<>|\u0000-\u001f]/g, '-')
    .replace(/:/g, '꞉') // „꞉“ sieht wie ein Doppelpunkt aus, ist aber in Dateinamen erlaubt
    .replace(/\s+/g, ' ')
    .trim();
}

/** Startet den Download eines Blobs. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

export function readFileAsText(file) {
  return file.text();
}

/** Kopiert Text in die Zwischenablage. */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;left:-9999px' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Deutsche Mehrzahl: plural(1, 'Lernende', 'Lernende'), plural(2, 'Rückmeldung', 'Rückmeldungen') */
export function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Hinweisbox (info/success/warning/error). */
export function alertBox(type, ...children) {
  return h('div', { class: `alert alert-${type}`, role: type === 'error' ? 'alert' : null }, ...children);
}

/** Formularfeld mit Beschriftung. */
export function field(label, control, { hint = '', id } = {}) {
  const controlId = id || control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = controlId;
  return h('div', { class: 'field' }, h('label', { for: controlId }, label), control, hint ? h('div', { class: 'field-hint' }, hint) : null);
}
