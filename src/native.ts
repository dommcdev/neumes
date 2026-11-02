import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { Exsurge, TextMeasurer } from './core/render.ts';

GlobalFonts.registerFromPath(fileURLToPath(new URL('../public/fonts/EBGaramond.ttf', import.meta.url)), 'EB Garamond');
GlobalFonts.registerFromPath(fileURLToPath(new URL('../public/fonts/EBGaramond-Italic.ttf', import.meta.url)), 'EB Garamond');
for (const style of ['regular', 'bold', 'italic', 'bolditalic']) {
  GlobalFonts.registerFromPath(fileURLToPath(new URL(`../public/fonts/texgyrepagella-${style}.otf`, import.meta.url)), 'TeX Gyre Pagella');
}
export const exsurge: Exsurge = createRequire(import.meta.url)('../public/vendor/exsurge.js');
export function nativeMeasure(): TextMeasurer { return createCanvas(1, 1).getContext('2d'); }
