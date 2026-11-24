/** Lossless chord edits for LilyPond (.ly) scores.
 *
 * Neumes never parses LilyPond's language: LilyPond engraves the score and its
 * point-and-click links say where every notehead is in the source. Chords are
 * text scripts on the note, `^\markup \bold "Am"`, which LilyPond places
 * itself. Like GABC, only chord annotations are added or removed; every other
 * byte of the file is kept.
 *
 * The flow: engrave `lilyMusic(source)` (the score without its chords) once
 * with LilyPond's SVG backend and point-and-click links, read it with
 * `readGeometry`, then `new LilyDocument(source, geometry)`. Chord edits never
 * change the music, so they never need LilyPond again; the editor draws them
 * over the engraving.
 */
import { validChord, type Chord, type ChordDocument } from './document.ts';
import { escapeXml, type Echo, type Position, type Preview, type Staff } from './render.ts';

export interface LilyNote {
  id: string;
  index: number;
  /** Where the note (or `<…>` chord) starts in `music`. */
  offset: number;
  /** Where a new chord annotation goes: after the note's pitch and duration. */
  insertion: number;
  group: string;
  lyric: string;
  /** The note as written, such as `fis'8.` or `<a c>4`. */
  notation: string;
  /** 1-based source line and column, for people. */
  line: number;
  column: number;
  page: number;
}

/** A notehead or lyric syllable from LilyPond's SVG, in PDF points. */
interface Link { line: number; char: number; page: number; x: number; y: number; text?: string }
interface StaffLines { page: number; left: number; right: number; top: number; bottom: number }
export interface Geometry {
  /** Page sizes in PDF points. */
  pages: { width: number; height: number }[];
  /** Points per staff space. */
  space: number;
  heads: Link[];
  lyrics: Link[];
  staves: StaffLines[];
}

interface Candidate { start: number; end: number; text: string }
interface Annotation { offset: number; chord: Chord; tag: string }

const TAG = /\^\s*(?:\\markup\s*\\bold\s*)?"((?:[^"\\]|\\.)*)"/y;
const unescape = (text: string) => text.replace(/\\(.)/g, '$1');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Chord annotations: `^"Am"` or `^\markup \bold "Am"` with a chord inside.
 * Comments, strings and Scheme are skipped, never interpreted.
 */
function candidates(source: string): Candidate[] {
  const found: Candidate[] = [];
  const skipString = (i: number) => {
    for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === '\\') i++;
    return i + 1;
  };
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (c === '%') {
      if (source[i + 1] === '{') { const end = source.indexOf('%}', i + 2); i = end < 0 ? source.length : end + 2; }
      else { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; }
    } else if (c === '"') i = skipString(i);
    else if (c === '#' && source[i + 1] === '(') {
      // Scheme: skip the balanced expression, its strings and its ; comments.
      let depth = 0;
      for (i++; i < source.length; i++) {
        const s = source[i];
        if (s === '"') { i = skipString(i) - 1; continue; }
        if (s === ';') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
        if (s === '(') depth++;
        else if (s === ')' && --depth === 0) { i++; break; }
      }
    } else if (c === '^') {
      TAG.lastIndex = i;
      const match = TAG.exec(source);
      if (match && validChord(unescape(match[1]))) {
        found.push({ start: i, end: TAG.lastIndex, text: unescape(match[1]) });
        i = TAG.lastIndex;
      } else i++;
    } else i++;
  }
  return found;
}

/** The score without its chord annotations: what LilyPond engraves for the editor. */
export function lilyMusic(source: string): string {
  let music = '', previous = 0;
  for (const c of candidates(source)) { music += source.slice(previous, c.start); previous = c.end; }
  return music + source.slice(previous);
}

/** What a chord looks like in the file. */
export function encodeLilyChord(text: string): string {
  if (!validChord(text)) throw new Error(`Unsupported chord: ${text}`);
  return `^\\markup \\bold "${text.replace(/[\\"]/g, '\\$&')}"`;
}

const number = (text: string) => Number(text);

/** Reads LilyPond SVG pages (`-dbackend=svg -dpoint-and-click`), keeping the
 * links into `file`, the path LilyPond was given.
 */
export function readGeometry(pages: string[], file: string): Geometry {
  if (!pages.length) throw new Error('LilyPond produced no pages.');
  const geometry: Geometry = { pages: [], space: 0, heads: [], lyrics: [], staves: [] };
  const sameFile = (path: string) => path === file || safeDecode(path) === file;
  pages.forEach((svg, page) => {
    const root = /<svg[^>]*\bwidth="([\d.]+)mm"[^>]*\bheight="([\d.]+)mm"[^>]*\bviewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
    if (!root) throw new Error('Unexpected LilyPond SVG output.');
    const width = number(root[1]) * 72 / 25.4, height = number(root[2]) * 72 / 25.4;
    // LilyPond's SVG unit is the staff space.
    const scale = width / number(root[3]);
    geometry.space ||= scale;
    geometry.pages.push({ width, height });
    const links = /<a [^>]*xlink:href="textedit:\/\/(.*?):(\d+):(\d+):\d+">\s*<g transform="translate\(([-\d.]+), ?([-\d.]+)\)">\s*(?:<path|<text[^>]*font-size="([\d.]+)"[^>]*>\s*<tspan>([^<]*))/g;
    for (const m of svg.matchAll(links)) {
      if (!sameFile(m[1])) continue;
      const link: Link = { line: number(m[2]), char: number(m[3]), page, x: number(m[4]) * scale, y: number(m[5]) * scale };
      if (m[7] === undefined) { geometry.heads.push(link); continue; }
      const text = m[7].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      // Syllables are centred under their notes: estimate the centre from the text's length.
      geometry.lyrics.push({ ...link, x: link.x + [...text].length * .25 * number(m[6]) * scale, text });
    }
    // Staff lines are long horizontal <line>s; ledger lines are short rects.
    const lines = [...svg.matchAll(/<g transform="translate\(([-\d.]+), ?([-\d.]+)\)">\s*<line [^>]*x1="([-\d.]+)" y1="0" x2="([-\d.]+)" y2="0"/g)]
      .map(m => ({ left: number(m[1]) + number(m[3]), right: number(m[1]) + number(m[4]), y: number(m[2]) }))
      .filter(l => l.right - l.left > 5)
      .sort((a, b) => a.left - b.left || a.y - b.y);
    const staves: { left: number; right: number; top: number; bottom: number }[] = [];
    for (const l of lines) {
      const staff = staves.find(s => Math.abs(s.left - l.left) < .01 && Math.abs(s.right - l.right) < .01 && l.y - s.bottom <= 1.5 && l.y >= s.bottom);
      if (staff) staff.bottom = l.y;
      else staves.push({ left: l.left, right: l.right, top: l.y, bottom: l.y });
    }
    for (const s of staves) geometry.staves.push({ page, left: s.left * scale, right: s.right * scale, top: s.top * scale, bottom: s.bottom * scale });
  });
  return geometry;
}

function safeDecode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** UTF-16 offsets of each line, and of each code point within it (LilyPond counts code points). */
function locator(source: string): (line: number, char: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return (line, char) => {
    let offset = starts[line - 1];
    if (offset === undefined) return -1;
    for (let n = 0; n < char && offset < source.length && source[offset] !== '\n'; n++) offset += source.codePointAt(offset)! > 0xffff ? 2 : 1;
    return offset;
  };
}

const DURATION = /(?:\d+|\\breve|\\longa|\\maxima)?\.*(?:\s*\*\s*\d+(?:\/\d+)?)*/y;
const PITCH = /[a-zA-Z]+(?:-[a-z]+)*[',]*[!?]?(?:=[',]*)?/y;

/** The `<` of the chord a notehead at `offset` belongs to, if any. */
function chordStart(music: string, offset: number): number | undefined {
  // Walk back over pitches, octave marks and in-chord articulations.
  let i = offset - 1;
  while (i >= 0 && /[\sa-zA-Z0-9',!?=\-._^\\]/.test(music[i])) i--;
  if (music[i] !== '<' || music[i - 1] === '<' || music[i + 1] === '<' || music[i - 1] === '\\') return;
  return i;
}

/** Where a chord annotation goes after the note or `<…>` chord starting at `offset`. */
function insertionAfter(music: string, offset: number, chord: boolean): number | undefined {
  let i: number;
  if (chord) {
    i = offset + 1;
    while (i < music.length) {
      if (music[i] === '"') { i++; while (i < music.length && music[i] !== '"') i += music[i] === '\\' ? 2 : 1; i++; continue; }
      if (music[i] === '>' && music[i - 1] !== '-' && music[i - 1] !== '\\' && music[i + 1] !== '>') break;
      if (music[i] === '<' || music[i] === '{' || music[i] === '}') return;
      i++;
    }
    if (i >= music.length) return;
    i++;
  } else {
    PITCH.lastIndex = offset;
    if (!PITCH.exec(music)) return;
    i = PITCH.lastIndex;
  }
  DURATION.lastIndex = i;
  DURATION.exec(music);
  return DURATION.lastIndex;
}

/** Text between a note and an annotation that still attaches to that note:
 * spaces, ties, slurs, beams, articulations, dynamics and other \commands.
 */
const POSTFIX = /^(?:\s+|~|\\?[()]|[[\]]|[-_^](?:[.>^+!_\-|]|\d+)|[-_^]?\\[a-zA-Z]+|\\[!<>])*$/;

export class LilyDocument implements ChordDocument {
  readonly offsets = false;
  readonly original: string;
  readonly music: string;
  readonly notes: LilyNote[] = [];
  readonly headers: Record<string, string>;
  chords: Chord[] = [];
  /** Annotations on rests, spacers or other text: kept exactly where they were. */
  private fixed: { offset: number; tag: string }[] = [];
  private annotations: Annotation[] = [];
  private initial: Chord[] = [];
  readonly positions: Position[] = [];
  readonly echoes: Echo[] = [];

  constructor(source: string, readonly geometry: Geometry, readonly fileName = 'score.ly') {
    this.original = source;
    const found = candidates(source);
    let music = '', previous = 0;
    const removed: { offset: number; tag: string; text: string }[] = [];
    for (const c of found) {
      music += source.slice(previous, c.start);
      removed.push({ offset: music.length, tag: source.slice(c.start, c.end), text: c.text });
      previous = c.end;
    }
    this.music = music + source.slice(previous);
    this.headers = {};
    for (const m of this.music.matchAll(/(?<![\w-])(title|subtitle|composer|poet|dedication|piece|opus)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) this.headers[m[1]] ??= unescape(m[2]);
    this.readNotes();
    const byInsertion = new Map<number, LilyNote[]>();
    for (const n of this.notes) byInsertion.set(n.insertion, [...byInsertion.get(n.insertion) ?? [], n]);
    const insertions = [...byInsertion.keys()].sort((a, b) => a - b);
    for (const r of removed) {
      // The closest note before the annotation, with only postfix marks between.
      let lo = 0, hi = insertions.length - 1, best = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (insertions[mid] <= r.offset) { best = mid; lo = mid + 1; } else hi = mid - 1; }
      const at = best < 0 ? undefined : insertions[best];
      const note = at === undefined || !POSTFIX.test(this.music.slice(at, r.offset)) ? undefined : byInsertion.get(at)![0];
      if (!note || this.chords.some(c => c.note === note.id)) { this.fixed.push({ offset: r.offset, tag: r.tag }); continue; }
      const chord = { note: note.id, text: r.text, dx: 0, dy: 0, autoX: 0, autoRaise: 0 };
      this.chords.push(chord);
      this.annotations.push({ offset: r.offset, chord: { ...chord }, tag: r.tag });
    }
    this.initial = this.chords.map(c => ({ ...c }));
  }

  private readNotes(): void {
    const { geometry, music } = this;
    const at = locator(music);
    const staffOf = (link: Link) => {
      const staves = geometry.staves.filter(s => s.page === link.page && link.x >= s.left - 2 * geometry.space && link.x <= s.right);
      return staves.sort((a, b) => distance(a, link.y) - distance(b, link.y))[0];
    };
    const heads = geometry.heads.map(link => ({ link, staff: staffOf(link) }))
      .sort((a, b) => a.link.page - b.link.page || (a.staff?.top ?? a.link.y) - (b.staff?.top ?? b.link.y) || a.link.x - b.link.x);
    const byOffset = new Map<number, LilyNote>();
    const firstHeads = new Map<string, { x: number; y: number; staff: StaffLines | undefined }>();
    for (const { link, staff } of heads) {
      const head = at(link.line, link.char);
      if (head < 0) continue;
      const chord = chordStart(music, head);
      const offset = chord ?? head;
      const existing = byOffset.get(offset);
      if (existing) {
        const first = firstHeads.get(existing.id)!;
        // Another head of the same <…> chord on the same system, or a repeat of the note.
        if (chord !== undefined && existing.page === link.page && Math.abs(first.x - link.x) < 3 * geometry.space && first.staff === staff) {
          first.y = Math.min(first.y, link.y);
        } else if (!this.echoes.some(e => e.note === existing.id && Math.abs(e.x - link.x) < geometry.space && e.staff === link.page && Math.abs(e.y - this.chordY(staff, link.y)) < 3 * geometry.space)) {
          this.echoes.push({ note: existing.id, staff: link.page, x: link.x, y: this.chordY(staff, link.y) });
        }
        continue;
      }
      const insertion = insertionAfter(music, offset, chord !== undefined);
      if (insertion === undefined) continue;
      const index = this.notes.length;
      const lineStart = music.lastIndexOf('\n', offset - 1) + 1;
      const note: LilyNote = { id: `n${index + 1}`, index, offset, insertion, group: `g${index + 1}`, lyric: '',
        notation: music.slice(offset, insertion).trim(), line: link.line, column: offset - lineStart + 1, page: link.page };
      this.notes.push(note);
      byOffset.set(offset, note);
      firstHeads.set(note.id, { x: link.x, y: link.y, staff });
    }
    if (!this.notes.length) throw new Error('LilyPond engraved no notes from this file.');
    const width = 1.3 * geometry.space;
    for (const note of this.notes) {
      const head = firstHeads.get(note.id)!;
      this.positions.push({ note: note.id, index: note.index, group: note.group, staff: note.page,
        x: head.x, noteWidth: width, glyphX: head.x, y: this.chordY(head.staff, head.y), noteY: head.y });
    }
    // Each syllable names the closest note above it.
    for (const lyric of geometry.lyrics) {
      const above = this.positions.filter(p => p.staff === lyric.page && p.noteY < lyric.y && lyric.y - p.noteY < 15 * geometry.space);
      const near = above.sort((a, b) => Math.abs(a.x + width / 2 - lyric.x) - Math.abs(b.x + width / 2 - lyric.x) || b.noteY - a.noteY)[0];
      if (near && !this.notes[near.index].lyric) this.notes[near.index].lyric = lyric.text!;
    }
  }

  /** A chord's baseline: clear of the staff and of high notes. */
  private chordY(staff: StaffLines | undefined, noteY: number): number {
    const space = this.geometry.space;
    return Math.min(staff?.top ?? noteY, noteY - space) - 1.6 * space;
  }

  get name(): string { return this.headers.title || this.fileName.replace(/\.ly$/i, '') || 'Untitled score'; }
  get dirty(): boolean {
    const ordered = (chords: Chord[]) => [...chords].sort((a, b) => this.note(a.note).index - this.note(b.note).index).map(c => [c.note, c.text]);
    return !same(ordered(this.chords), ordered(this.initial));
  }
  note(id: string): LilyNote {
    const note = this.notes.find(n => n.id === id);
    if (!note) throw new Error(`Unknown note: ${id}`);
    return note;
  }
  setChord(id: string, text: string): void {
    this.note(id);
    if (!validChord(text)) throw new Error(`Unsupported chord: ${text}`);
    const existing = this.chords.find(c => c.note === id);
    if (existing) existing.text = text;
    else this.chords.push({ note: id, text, dx: 0, dy: 0, autoX: 0, autoRaise: 0 });
  }
  removeChord(id: string): void { this.note(id); this.chords = this.chords.filter(c => c.note !== id); }
  serialize(): string {
    if (!this.dirty) return this.original;
    const insertions = [
      ...this.fixed.map(f => ({ offset: f.offset, text: f.tag, index: -1 })),
      ...this.chords.filter(c => c.text).map(chord => {
        const note = this.note(chord.note);
        // A chord already in the file stays where it was written, and as written while unchanged.
        const original = this.annotations.find(a => a.chord.note === chord.note);
        const tag = original?.chord.text === chord.text ? original.tag : encodeLilyChord(chord.text);
        return { offset: original?.offset ?? note.insertion, text: tag, index: note.index };
      }),
    ].sort((a, b) => a.offset - b.offset || a.index - b.index);
    let result = '', previous = 0;
    for (const insertion of insertions) { result += this.music.slice(previous, insertion.offset) + insertion.text; previous = insertion.offset; }
    return result + this.music.slice(previous);
  }

  /** The editor's preview: LilyPond's own pages (`display`, any SVG per page). */
  preview(display: string[]): Preview {
    const staves: Staff[] = this.geometry.pages.map((page, i) => ({ svg: display[i] ?? '', width: page.width, height: page.height, advance: page.height + 24 }));
    return { staves, positions: this.positions, width: Math.max(...this.geometry.pages.map(p => p.width)), echoes: this.echoes };
  }
}

function distance(staff: StaffLines, y: number): number {
  return y < staff.top ? staff.top - y : y > staff.bottom ? y - staff.bottom : 0;
}

/** Chord text for an overlay: placed chords, and the same chords at each echo. */
export function chordMarkup(doc: ChordDocument, preview: Preview, placed: { note: string; staff: number; x: number; baseline: number }[], staff: number, size: number): string {
  const positions = new Map(preview.positions.map(p => [p.note, p]));
  const text = (x: number, y: number, chord: string) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="bold">${escapeXml(chord)}</text>`;
  const out: string[] = [];
  for (const p of placed) {
    const chord = doc.chords.find(c => c.note === p.note)!.text;
    if (p.staff === staff) out.push(text(p.x, p.baseline, chord));
    const pos = positions.get(p.note)!;
    for (const echo of preview.echoes ?? []) {
      if (echo.note === p.note && echo.staff === staff) out.push(text(echo.x + p.x - pos.x, echo.y + p.baseline - pos.y, chord));
    }
  }
  return out.join('');
}
