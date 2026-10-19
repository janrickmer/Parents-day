// Fotos der Startseite (img/start/flur*.webp) aus zwei Aufnahmen von Wikimedia Commons (Lukas Beck, CC BY 4.0).
// Die Originale liegen nicht im Repository. Laden Sie sie von den Seiten unten (Original mit 4032 px oder die
// Vorschau mit 3840 px Breite; die Koordinaten sind Anteile und passen zu beiden) und rufen Sie das Werkzeug auf:
//
//   node tools/startseite-fotos.mjs <img08.jpg> <img06.jpg>            → schreibt nach img/start/
//   node tools/startseite-fotos.mjs <img08.jpg> <img06.jpg> <ordner>   → schreibt in einen anderen Ordner
//
// Bearbeitung: Ausschnitt, Retusche, Graustufen mit angehobenen Tiefen. Die Petrol-Farbe kommt erst auf der Seite
// dazu (background-blend-mode: multiply in css/views/start.css). Die Herkunft steht in <bild>.webp.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [img08, img06, outArg] = process.argv.slice(2);
if (!img08 || !img06) {
  console.error('Aufruf: node tools/startseite-fotos.mjs <img08.jpg> <img06.jpg> [ordner]');
  process.exit(1);
}
const out = path.resolve(outArg || path.join(ROOT, 'img/start'));
await fs.mkdir(out, { recursive: true });

const LICENCE = 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)';
// Koordinaten als Anteile von Breite und Höhe, gemessen an der Vorschau mit 3840 × 2880 px
const W = 3840;
const H = 2880;
const PHOTOS = [
  {
    file: img08,
    name: 'flur',
    title: 'Berlin Louise-Schroeder-Schule lub 2024-01-20 img08 Interieur',
    page: 'https://commons.wikimedia.org/wiki/File:Berlin_Louise-Schroeder-Schule_lub_2024-01-20_img08_Interieur.jpg',
    crop: [0, 0, 1, 1],
    // Im Türspalt rechts ist der Hinterkopf einer Person im Raum zu sehen: senkrecht überblenden
    retouch: [{ rect: [2851 / W, 1395 / H, 2886 / W, 1600 / H], dir: 'vertical', what: 'Hinterkopf einer Person im Türspalt' }],
    width: 1920,
  },
  {
    file: img06,
    name: 'flur-tuer',
    title: 'Berlin Louise-Schroeder-Schule lub 2024-01-20 img06 Interieur',
    page: 'https://commons.wikimedia.org/wiki/File:Berlin_Louise-Schroeder-Schule_lub_2024-01-20_img06_Interieur.jpg',
    // Nur die rechte Hälfte: links hängen Bilder von Schülerinnen und Schülern und lesbare Schilder
    crop: [1843 / W, 864 / H, 1, 2304 / H],
    // Ein Bild an der Wand hinter dem Pfeiler: waagerecht mit der Wand links und rechts davon überblenden
    retouch: [{ rect: [2283 / W, 1268 / H, 2327 / W, 1436 / H], dir: 'horizontal', what: 'Bild an der Wand' }],
    width: 1600,
  },
];
// Graustufen: Schwarz wird zu 40 % Grau, damit die Petrol-Wand beim Multiplizieren erkennbar bleibt
const LIFT = 0.4;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const photo of PHOTOS) {
  const src = `data:image/jpeg;base64,${(await fs.readFile(photo.file)).toString('base64')}`;
  const { name, width } = photo;
  const b64 = await page.evaluate(
    async ([s, p, w, lift]) => {
      const img = new Image();
      img.src = s;
      await img.decode();
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      // Retusche auf voller Auflösung
      const full = document.createElement('canvas');
      full.width = iw;
      full.height = ih;
      const fctx = full.getContext('2d');
      fctx.drawImage(img, 0, 0);
      for (const r of p.retouch) {
        const x0 = Math.floor(r.rect[0] * iw);
        const y0 = Math.floor(r.rect[1] * ih);
        const x1 = Math.ceil(r.rect[2] * iw);
        const y1 = Math.ceil(r.rect[3] * ih);
        const area = fctx.getImageData(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
        const aw = area.width;
        const ah = area.height;
        const px = (x, y) => (y * aw + x) * 4;
        for (let y = 1; y < ah - 1; y++) {
          for (let x = 1; x < aw - 1; x++) {
            const [a, b, t] = r.dir === 'vertical' ? [px(x, 0), px(x, ah - 1), y / (ah - 1)] : [px(0, y), px(aw - 1, y), x / (aw - 1)];
            for (let c = 0; c < 3; c++) area.data[px(x, y) + c] = area.data[a + c] * (1 - t) + area.data[b + c] * t;
          }
        }
        fctx.putImageData(area, x0 - 1, y0 - 1);
      }
      // Ausschnitt, Größe, Graustufen
      const sx = p.crop[0] * iw;
      const sy = p.crop[1] * ih;
      const sw = (p.crop[2] - p.crop[0]) * iw;
      const sh = (p.crop[3] - p.crop[1]) * ih;
      const h = Math.round((w * sh) / sw);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(full, sx, sy, sw, sh, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      for (let i = 0; i < data.data.length; i += 4) {
        const y = 0.2126 * data.data[i] + 0.7152 * data.data[i + 1] + 0.0722 * data.data[i + 2];
        const v = 255 * lift + (1 - lift) * y;
        data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
      }
      ctx.putImageData(data, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, 'image/webp', 0.72));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return [btoa(bin), h];
    },
    [src, photo, width, LIFT],
  );
  await fs.writeFile(path.join(out, `${name}.webp`), Buffer.from(b64[0], 'base64'));
  const edits = [...(photo.crop.join() === '0,0,1,1' ? ['verkleinert'] : ['Ausschnitt']), ...photo.retouch.map((r) => `Retusche (${r.what})`), 'Graustufen mit angehobenen Tiefen', 'auf der Seite mit der Petrol-Wand multipliziert'];
  const origin = `Foto „${photo.title}“ von Lukas Beck, Wikimedia Commons (${photo.page}), Lizenz ${LICENCE}; bearbeitet: ${edits.join(', ')}; erzeugt mit tools/startseite-fotos.mjs, ${width} × ${b64[1]} px.`;
  await fs.writeFile(path.join(out, `${name}.webp.json`), `${JSON.stringify({ prompt: origin }, null, 2)}\n`);
  console.log(`${name}.webp  ${width} × ${b64[1]}`);
}
await browser.close();
