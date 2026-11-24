/** The desktop app's bridge to the shared core. Bundled into one script and run
 * by QuickJS inside the Rune shell (`desktop/`), with Exsurge loaded first and
 * text measured natively. Every call takes and returns JSON-compatible values.
 */
import { ScoreDocument } from '../core/document.ts';
import { Editor } from '../core/editor.ts';
import { ENGRAVING, FONT } from '../core/engraving.ts';
import { editorKey, movesCursor, type KeyInput } from '../core/keys.ts';
import { chordMarkup, LilyDocument, lilyMusic, readGeometry, type Geometry } from '../core/lilypond.ts';
import { escapeXml, renderScore, scorePages, staffPad, SCORE_WIDTH, type Exsurge, type TextMeasurer } from '../core/render.ts';

declare const exsurge: Exsurge;
/** [width, actualBoundingBoxLeft, actualBoundingBoxAscent, actualBoundingBoxDescent] */
declare function nativeMeasure(font: string, text: string): number[];

const measure: TextMeasurer = {
  font: '10px serif',
  measureText(text: string) {
    const [width, left, ascent, descent] = nativeMeasure(this.font, text);
    return { width, actualBoundingBoxLeft: left, actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent };
  },
};

let editor: Editor | null = null;
// Exsurge's staff SVG without the outer element, by staff; for LilyPond, its pages.
let staffBodies: string[] = [];
/** The open LilyPond score's engraving, which chord edits never change. */
let lily: { geometry: Geometry; fileName: string; chordSize: number } | null = null;
let drag: { chord: boolean; active: boolean } | null = null;

function current(): Editor {
  if (!editor) throw new Error('No score is open.');
  return editor;
}

/** Margin around each rasterized staff, for ink outside Exsurge's box. */
const BLEED = 12;

function headerSvg(doc: ScoreDocument): { svg: string; height: number } {
  const h = doc.headers;
  const lines: string[] = [];
  let y = 0;
  // The same lines and leading as the printed sheet (scoreSvg).
  const line = (text: string, size: number, leading: number, italic: boolean) => {
    lines.push(`<text x="${SCORE_WIDTH / 2}" y="${y + size}" text-anchor="middle" font-size="${size}" font-weight="bold"${italic ? ' font-style="italic"' : ''}>${escapeXml(text)}</text>`);
    y += leading * 72 / 72.27;
  };
  if (h['sheet-heading']) line(h['sheet-heading'], ENGRAVING.headingSize, 17, false);
  line(h['sheet-title'] || h.name || 'Untitled chant', ENGRAVING.titleSize, 29, true);
  if (h['sheet-subtitle']) line(h['sheet-subtitle'], ENGRAVING.subtitleSize, 15, true);
  return { svg: wrap(lines.join(''), y), height: y };
}

function wrap(body: string, height: number, inner: number = SCORE_WIDTH): string {
  const width = inner + 2 * BLEED;
  return `<svg class="Exsurge" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height + 2 * BLEED}" viewBox="${-BLEED} ${-BLEED} ${width} ${height + 2 * BLEED}"><g font-family="TeX Gyre Pagella" fill="#000">${body}</g></svg>`;
}

function chordText(ed: Editor, note: string): string {
  return ed.doc.chords.find(c => c.note === note)!.text;
}

const api = {
  /** Opens a score, replacing the current one only when it renders. */
  open(source: string): { header: string; headerHeight: number } {
    if (source.length > 4 * 1024 * 1024) throw new Error('GABC files must be smaller than 4 MiB.');
    const doc = new ScoreDocument(source);
    const preview = renderScore(doc, exsurge, measure);
    const next = new Editor(doc, preview, measure);
    editor = next;
    drag = null;
    lily = null;
    staffBodies = preview.staves.map(staff => staff.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, ''));
    const header = headerSvg(doc);
    return { header: header.svg, headerHeight: header.height };
  },

  /** What LilyPond should engrave for the editor: the score without its chords. */
  lilyMusic(source: string): string { return lilyMusic(source); },

  /** Opens a LilyPond score from LilyPond's engraving of `lilyMusic(source)`:
   * `geometry` with point-and-click links into `file`, `display` to show.
   */
  openLily(source: string, fileName: string, geometry: string[], file: string, display: string[]): { header: string; headerHeight: number } {
    if (source.length > 4 * 1024 * 1024) throw new Error('LilyPond files must be smaller than 4 MiB.');
    const shape = readGeometry(geometry, file);
    const doc = new LilyDocument(source, shape, fileName);
    const chordSize = 2.2 * shape.space;
    const next = new Editor(doc, doc.preview(display), measure, `bold ${chordSize}px ${FONT}`);
    editor = next;
    drag = null;
    lily = { geometry: shape, fileName, chordSize };
    // LilyPond's SVG, without the XML declaration, nested as it is.
    staffBodies = display.map(svg => svg.replace(/^<\?xml[^>]*>\s*/, ''));
    return { header: '', headerHeight: 0 };
  },

  close(): void { editor = null; staffBodies = []; drag = null; lily = null; },

  /** Everything the shell draws except the staff images. `key` changes whenever
   * a staff's image (music plus chords) does.
   */
  view() {
    const ed = current();
    const cursor = ed.position;
    const selected = ed.selected ? ed.placed.find(p => p.note === ed.selected) : undefined;
    if (lily) return {
      kind: 'ly',
      width: ed.preview.width,
      dirty: ed.doc.dirty,
      canUndo: ed.canUndo,
      canRedo: ed.canRedo,
      editing: ed.editing,
      name: ed.doc.name,
      cursor: { staff: cursor.staff, x: cursor.x, y: cursor.y, noteY: cursor.noteY },
      selected: selected ? { staff: selected.staff, x: selected.x, top: selected.top, bottom: selected.bottom, width: selected.width } : null,
      // Pages never change; their chords are a separate image.
      staves: ed.preview.staves.map((spec, index) => ({ height: spec.height, gap: spec.advance - spec.height, pad: 0, key: 'page',
        chords: JSON.stringify(chordMarkup(ed.doc, ed.preview, ed.placed, index, lily!.chordSize)) })),
    };
    return {
      kind: 'gabc',
      width: SCORE_WIDTH,
      dirty: ed.doc.dirty,
      canUndo: ed.canUndo,
      canRedo: ed.canRedo,
      editing: ed.editing,
      name: ed.doc.name,
      cursor: { staff: cursor.staff, x: cursor.x, y: cursor.y, noteY: cursor.noteY },
      selected: selected ? { staff: selected.staff, x: selected.x, top: selected.top, bottom: selected.bottom, width: selected.width } : null,
      staves: ed.preview.staves.map((spec, index) => {
        const pad = staffPad(ed.placed, index);
        const chords = ed.placed.filter(p => p.staff === index).map(p => [p.x, p.baseline, chordText(ed, p.note)]);
        return { height: spec.height + pad, gap: spec.advance - spec.height, pad, key: JSON.stringify([pad, chords]), chords: '' };
      }),
    };
  },

  /** One staff with its chords, as SVG with `bleed` points of margin. */
  staffSvg(index: number): string {
    const ed = current();
    const spec = ed.preview.staves[index];
    if (lily) return wrap(staffBodies[index], spec.height, spec.width);
    const pad = staffPad(ed.placed, index);
    const chords = ed.placed.filter(p => p.staff === index)
      .map(p => `<text x="${p.x}" y="${p.baseline}" font-size="${ENGRAVING.chordSize}" font-weight="bold">${escapeXml(chordText(ed, p.note))}</text>`).join('');
    return wrap(`<g transform="translate(0,${pad})">${staffBodies[index]}${chords}</g>`, spec.height + pad);
  },

  /** A LilyPond page's chords, as an SVG the size of `staffSvg(index)`. */
  chordSvg(index: number): string {
    const ed = current();
    const spec = ed.preview.staves[index];
    return wrap(lily ? chordMarkup(ed.doc, ed.preview, ed.placed, index, lily.chordSize) : '', spec.height, spec.width);
  },

  /** Returns whether the key was used, and whether the cursor should be revealed. */
  key(input: KeyInput): { handled: boolean; reveal: boolean } {
    const handled = editorKey(current(), input);
    return { handled, reveal: handled && movesCursor(input.key) };
  },

  undo(): void { current().undo(); },
  redo(): void { current().redo(); },
  finish(): void { current().finish(); },

  /** A press at (x, y) in staff points, measured from the top of the staff's padding. */
  pointerDown(staff: number, x: number, y: number): void {
    const ed = current();
    y -= staffPad(ed.placed, staff);
    const hit = ed.hit(staff, x, y);
    const target = hit ? undefined : ed.preview.positions.find(p => p.staff === staff && Math.hypot(p.x + 3 - x, p.noteY - y) <= 7);
    if (target) ed.select(target.index); else ed.click(staff, x, y);
    drag = { chord: !!hit, active: false };
  },

  /** Drags the selected chord: to the closest note, or by (dx, dy) points when fine. */
  pointerMove(staff: number, x: number, dx: number, dy: number, fine: boolean, travel: number): boolean {
    const ed = current();
    if (!drag?.chord) return false;
    if (!drag.active) {
      if (travel <= 3) return false;
      ed.beginDrag();
      drag.active = true;
    }
    if (fine) ed.nudge(dx, dy, false);
    else { const next = ed.closest(staff, x); if (next !== undefined) ed.moveTo(next, false); }
    return true;
  },

  pointerUp(): void { drag = null; },

  /** Double-click: edit the chord under the pointer. */
  editAt(staff: number, x: number, y: number): void {
    const ed = current();
    ed.click(staff, x, y - staffPad(ed.placed, staff));
    ed.startEdit();
  },

  /** The text to write. Finishes any chord being typed first. */
  serialize(): string {
    const ed = current();
    ed.finish();
    return ed.doc.serialize();
  },

  /** After a successful write, that text is the new clean state. */
  saved(source: string): void {
    const ed = current();
    ed.doc = lily ? new LilyDocument(source, lily.geometry, lily.fileName) : new ScoreDocument(source);
  },

  /** Letter pages for PDF export, one SVG per page. */
  pages(): string[] {
    const ed = current();
    ed.finish();
    if (!(ed.doc instanceof ScoreDocument)) throw new Error('LilyPond scores are exported by LilyPond.');
    return scorePages(ed.doc, ed.preview, ed.placed);
  },

};

(globalThis as unknown as { neumes: typeof api }).neumes = api;
