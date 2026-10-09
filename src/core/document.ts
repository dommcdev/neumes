/** Lossless GABC edits: never reserialize lyrics, headers, or musical notation. */
export interface Note {
  id: string;
  index: number;
  offset: number;
  rootOffset: number;
  insertion: number;
  repeat: number;
  group: string;
  lyric: string;
  gabc: string;
  pitch: string;
  staffPosition: string;
}

export interface Chord {
  note: string;
  text: string;
  dx: number;
  dy: number;
  autoX: number;
  autoRaise: number;
}

const PREFIX = '[nv:\\hbox to0pt{\\kern-\\csname gre@dimen@lastglyphwidth\\endcsname\\GreSetTextAboveLines{';
const GLYPH_PREFIX = PREFIX.replace('[nv:', '[gv:');
const SUFFIX = '}\\csname gre@currenttextabovelines\\endcsname\\hss}]';
interface Annotation { offset: number; chord: Chord; tag: string }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function bodyStart(source: string): number {
  const match = /^(?:\uFEFF)?[^\S\r\n]*%%[^\S\r\n]*(?:\r?\n|$)/m.exec(source);
  if (!match) throw new Error('Missing GABC header separator (%% on its own line).');
  return match.index + match[0].length;
}

export function bracketEnd(source: string, start: number): number {
  const end = source.indexOf(']', start);
  if (end < 0) throw new Error('Unclosed GABC annotation.');
  return end + 1;
}

export function validChord(text: string): boolean {
  const normalized = text.replaceAll('♯', '#').replaceAll('♭', 'b').replaceAll('−', '-').replace(/[()]/g, '');
  return normalized.trim().length > 0 && normalized.trim().split(/\s+/).every(word =>
    /^(N\.C\.|NC)$/.test(word) || (word.split('/').length <= 2 && word.split('/').every(part =>
      /^[A-G][#b]?(?:(?:maj|min|dim|aug|sus|add|omit|no|m|M|Δ|°|ø|[+\-#b.])|\d)*$/.test(part))));
}

function decode(content: string): Omit<Chord, 'note'> | undefined {
  if (validChord(content)) return { text: content, dx: 0, dy: 0, autoX: 0, autoRaise: 0 };
  const match = /^\\kern (-?[\d.]+)bp\\raise (-?[\d.]+)bp\\hbox\{\\raise (-?[\d.]+)bp\\hbox\{\\fontsize\{9bp\}\{11bp\}\\selectfont\\upshape\\bfseries ([\s\S]*)\}\}$/.exec(content);
  if (!match) return;
  const text = match[4].replaceAll('\\ensuremath{\\sharp}', '♯').replaceAll('\\ensuremath{\\flat}', '♭');
  const numbers = match.slice(1, 4).map(Number);
  if (!validChord(text) || !numbers.every(Number.isFinite)) return;
  return { text, dx: numbers[0], autoRaise: numbers[1], dy: numbers[2], autoX: 0 };
}

function encode(chord: Chord, note: Note): string {
  if (!validChord(chord.text)) throw new Error(`Unsupported chord: ${chord.text}`);
  if (![chord.dx, chord.dy, chord.autoX, chord.autoRaise].every(Number.isFinite)) throw new Error('Offsets must be finite.');
  const text = chord.text.replace(/[♯#]/g, '\\ensuremath{\\sharp}').replaceAll('♭', '\\ensuremath{\\flat}');
  // An undefined csname is TeX's harmless \relax. It carries repeat-target and
  // automatic-horizontal metadata without adding glyphs, spacing, or a preamble.
  const marker = `\\csname neumes@${note.repeat}@${chord.autoX}\\endcsname`;
  // Gregorio discards nv hooks while expanding hsss / hvv. A zero-width
  // glyph-level hook survives that expansion without changing the glyphs.
  const prefix = /^[a-mA-M][sv]{2}/.test(note.gabc) ? GLYPH_PREFIX : PREFIX;
  return `${prefix}${marker}\\kern ${chord.dx + chord.autoX}bp\\raise ${chord.autoRaise}bp\\hbox{\\raise ${chord.dy}bp\\hbox{\\fontsize{9bp}{11bp}\\selectfont\\upshape\\bfseries ${text}}}${SUFFIX}`;
}

function plainLyric(raw: string): string {
  return raw.replace(/%[^\r\n]*/g, '').replace(/<v>[\s\S]*?<\/v>/g, '').replace(/<[^>]*>/g, '').replace(/\[[^\]]*\]/g, '').replace(/[{}*_]/g, '').trim();
}

function extractNotes(source: string): Note[] {
  const notes: Note[] = [];
  let i = bodyStart(source), inside = false, boundary = true, group = 0;
  let lyricStart = i, lyric = '', refPosition = 9, refDiatonic = 28, flatClef = false;
  const accidentals = new Map<number, string>();
  while (i < source.length) {
    const ch = source[i];
    if (ch === '%') { i = source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i) + 1; continue; }
    if (ch === '[') { i = bracketEnd(source, i); continue; }
    if (!inside && ch === '<') {
      const close = source.startsWith('<v>', i) ? source.indexOf('</v>', i) : source.indexOf('>', i);
      if (close < 0) throw new Error('Unclosed lyric markup.');
      i = close + (source.startsWith('<v>', i) ? 4 : 1); continue;
    }
    if (ch === '(') {
      if (inside) throw new Error('Nested music parentheses are unsupported.');
      lyric = plainLyric(source.slice(lyricStart, i));
      if (/\s/.test(source.slice(lyricStart, i))) accidentals.clear();
      inside = true; boundary = true; i++; continue;
    }
    if (ch === ')') { inside = false; boundary = true; lyricStart = ++i; continue; }
    if (!inside) { i++; continue; }
    if (ch === '@' || ch === '|') throw new Error('Fused-neume and NABC notation are not yet supported.');
    const clef = /^(c|f)(b?)([1-4])/.exec(source.slice(i));
    if (clef) {
      refPosition = 3 + (Number(clef[3]) - 1) * 2;
      refDiatonic = clef[1] === 'c' ? 28 : 24;
      flatClef = !!clef[2]; accidentals.clear(); i += clef[0].length; boundary = true; continue;
    }
    if (/[a-mA-M]/.test(ch)) {
      const pos = ch.toLowerCase().charCodeAt(0) - 97;
      if (/[xy#+]/.test(source[i + 1] ?? ' ')) {
        accidentals.set(pos, source[i + 1] === 'x' ? '♭' : source[i + 1] === '#' ? '♯' : '');
        i += 2; continue;
      }
      if (boundary) group++;
      boundary = false;
      const root = i;
      let end = i + 1;
      while (end < source.length) {
        if (source[end] === '[') { end = bracketEnd(source, end); continue; }
        if (/[a-mA-M/!()%,;:`zZ\s@|]/.test(source[end])) break;
        end++;
      }
      const token = source.slice(root, end);
      const diatonic = refDiatonic + pos - refPosition;
      const letter = 'CDEFGAB'[((diatonic % 7) + 7) % 7];
      const accidental = accidentals.get(pos) ?? (flatClef && letter === 'B' ? '♭' : '');
      const repeats = /^[a-mA-M]([sv]+)/.exec(token)?.[1].length ?? 1;
      for (let repeat = 0; repeat < repeats; repeat++) {
        notes.push({ id: `n${notes.length + 1}`, index: notes.length,
          offset: repeat === 0 ? root : root + 1 + repeat, rootOffset: root, insertion: end, repeat,
          group: `g${group}`, lyric, gabc: token.replace(/\[[^\]]*\]/g, ''),
          pitch: `${letter}${accidental}${Math.floor(diatonic / 7)}`, staffPosition: ch.toLowerCase() });
      }
      i = end; continue;
    }
    if (/[/!\s,;:`zZ]/.test(ch)) boundary = true;
    if (ch === ':' || ch === ';') accidentals.clear();
    i++;
  }
  if (inside) throw new Error('Unclosed music parentheses.');
  if (!notes.length) throw new Error('No supported notes found in this GABC file.');
  return notes;
}

export class ScoreDocument {
  readonly original: string;
  readonly music: string;
  readonly notes: Note[];
  readonly headers: Record<string, string>;
  chords: Chord[] = [];
  private initial: Chord[] = [];
  private annotations: Annotation[] = [];

  constructor(source: string) {
    this.original = source;
    const start = bodyStart(source);
    this.headers = Object.fromEntries([...source.slice(0, start).matchAll(/^([\w-]+):([^;]*);/gm)].map(m => [m[1], m[2].trim()]));
    const removals: { start: number; end: number; chord: Omit<Chord, 'note'>; repeat: number; tag: string; before: boolean }[] = [];
    let i = start;
    while (i < source.length) {
      if (source[i] === '%') { const n = source.indexOf('\n', i); i = n < 0 ? source.length : n + 1; continue; }
      if (source.startsWith('<v>', i)) { const n = source.indexOf('</v>', i); if (n < 0) throw new Error('Unclosed <v> tag.'); i = n + 4; continue; }
      let end: number, content: string | undefined, before = true, repeat = 0, autoX = 0;
      if (source.startsWith('<alt>', i)) {
        const n = source.indexOf('</alt>', i); if (n < 0) throw new Error('Unclosed <alt> tag.');
        end = n + 6; content = source.slice(i + 5, n);
      } else if (source[i] === '[') {
        end = bracketEnd(source, i);
        const tag = source.slice(i, end);
        if (tag.startsWith('[alt:')) content = tag.slice(5, -1);
        else if (tag.startsWith('[gv:\\GreSetTextAboveLines{')) content = tag.slice('[gv:\\GreSetTextAboveLines{'.length, -2);
        else if ((tag.startsWith(PREFIX) || tag.startsWith(GLYPH_PREFIX)) && tag.endsWith(SUFFIX)) {
          before = false; content = tag.slice(PREFIX.length, -SUFFIX.length);
          const marker = /^\\csname neumes@(\d+)@(-?[\d.]+)\\endcsname/.exec(content);
          if (marker) { repeat = Number(marker[1]); autoX = Number(marker[2]); content = content.slice(marker[0].length); }
        }
      } else { i++; continue; }
      const chord = content === undefined ? undefined : decode(content);
      if (chord) {
        chord.autoX = autoX; chord.dx -= autoX;
        removals.push({ start: i, end, chord, repeat, tag: source.slice(i, end), before });
      }
      i = end;
    }
    let music = '', previous = 0;
    const pending: { offset: number; removal: typeof removals[number] }[] = [];
    for (const removal of removals) {
      music += source.slice(previous, removal.start);
      pending.push({ offset: music.length, removal }); previous = removal.end;
    }
    this.music = music + source.slice(previous);
    this.notes = extractNotes(this.music);
    for (const { offset, removal } of pending) {
      const base = removal.before ? this.notes.find(n => n.offset >= offset) : this.notes.filter(n => n.rootOffset < offset && n.repeat === 0).at(-1);
      const target = base && this.notes.find(n => n.rootOffset === base.rootOffset && n.repeat === removal.repeat);
      if (!target) throw new Error('A chord annotation has no valid note target.');
      if (this.chords.some(c => c.note === target.id)) throw new Error(`Multiple annotations on ${target.id}.`);
      const chord = { note: target.id, ...removal.chord };
      this.chords.push(chord); this.annotations.push({ offset, chord: { ...chord }, tag: removal.tag });
    }
    this.initial = this.chords.map(c => ({ ...c }));
  }

  get name(): string { return this.headers['sheet-title'] || this.headers.name || 'Untitled chant'; }
  get dirty(): boolean {
    // Layout adapts to the preview's font and width without turning an unchanged
    // open/save into a rewrite. Automatic placement is committed with user edits.
    const ordered = (chords: Chord[]) => [...chords].sort((a, b) => this.note(a.note).index - this.note(b.note).index).map(c => ({ note: c.note, text: c.text, dx: c.dx, dy: c.dy }));
    return !same(ordered(this.chords), ordered(this.initial));
  }
  note(id: string): Note {
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
    const insertions = this.chords.filter(c => c.text).map(chord => {
      const note = this.note(chord.note);
      const unchanged = this.annotations.find(a => same(a.chord, chord));
      return { offset: unchanged?.offset ?? note.insertion, text: unchanged?.tag ?? encode(chord, note), index: note.index };
    }).sort((a, b) => a.offset - b.offset || a.index - b.index);
    let result = '', previous = 0;
    for (const insertion of insertions) { result += this.music.slice(previous, insertion.offset) + insertion.text; previous = insertion.offset; }
    return result + this.music.slice(previous);
  }
  previewBody(): string {
    // UTF-16-length-preserving removal is essential for renderer sourceIndex.
    return this.music.slice(bodyStart(this.music)).replace(/%[^\r\n]*/g, text => ' '.repeat(text.length));
  }
}

/** Stable across chord edits; agents can reject a changed musical source. */
export function revision(doc: ScoreDocument): string {
  let hash = 2166136261;
  for (let i = 0; i < doc.music.length; i++) hash = Math.imul(hash ^ doc.music.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
