import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ScoreDocument, revision, validChord } from '../src/core/document.ts';
import { renderScore, layoutChords, scoreSvg, prepareRendererSource } from '../src/core/render.ts';
import { Editor } from '../src/core/editor.ts';
import { exsurge, nativeMeasure } from '../src/native.ts';

const SOURCE = 'name: Test;\r\nsheet-heading: A feast;\r\nsheet-title: Introit;\r\nmode:3;\r\n%%\r\n(c4) Dó([alt:C]ghg/hsss/hvv)mi(hi)nus.(g.) (::) % 😀 (fake)\r\n';
const create = (source = SOURCE) => { const doc = new ScoreDocument(source); const measure = nativeMeasure(); const preview = renderScore(doc, exsurge, measure); return { doc, measure, preview }; };

describe('lossless individual-note document', () => {
  test('unchanged save is byte-for-byte identical, including CRLF and Unicode', () => {
    const doc = new ScoreDocument(SOURCE);
    expect(doc.serialize()).toBe(SOURCE);
    expect(doc.dirty).toBe(false);
    expect(doc.chords[0].note).toBe('n1');
    expect(doc.notes.length).toBe(11);
    expect(doc.notes.slice(0, 3).map(n => n.group)).toEqual(['g1', 'g1', 'g1']);
    expect(doc.notes.slice(3, 6).map(n => n.repeat)).toEqual([0, 1, 2]);
    expect(doc.notes[0].pitch).toBe('G3');
    expect(doc.headers['sheet-title']).toBe('Introit');
  });
  test('every individual pitch and implicit repeated note can carry a chord', () => {
    const { doc, measure, preview } = create();
    for (const n of doc.notes) doc.setChord(n.id, n.index % 2 ? 'Dm' : 'Cmaj7');
    layoutChords(doc, preview, measure);
    const saved = doc.serialize();
    const reload = new ScoreDocument(saved);
    expect(reload.music).toBe(doc.music);
    expect(reload.notes).toEqual(doc.notes);
    expect(reload.chords).toEqual(doc.chords);
    expect(reload.serialize()).toBe(saved);
    expect(revision(reload)).toBe(revision(doc));
    expect(renderScore(reload, exsurge, measure).positions).toEqual(preview.positions);
  });
  test('clefs, accidentals, comments, choral signs and lyric tags are not notes', () => {
    const doc = new ScoreDocument('name:T;\n%%\n(cb4) <i>A</i>(ixghg[cs:a]/h!i.) (::) % (abc)\n');
    expect(doc.notes.map(n => n.staffPosition)).toEqual(['g', 'h', 'g', 'h', 'i']);
    expect(doc.notes[0].lyric).toBe('A');
  });
  test('plain lyric chords import; non-chord above-line text survives edits', () => {
    const source = 'name:T;\n%%\n(c4) <alt>C</alt>A(ghg) B([alt:rit.]h[cs:a]) (::)\n';
    const doc = new ScoreDocument(source);
    expect(doc.serialize()).toBe(source);
    doc.setChord('n2', 'F♯sus4/C♯');
    const saved = doc.serialize();
    expect(saved).toContain('<alt>C</alt>');
    expect(saved).toContain('[alt:rit.]');
    expect(saved).toContain('[cs:a]');
    expect(new ScoreDocument(saved).music).toBe(doc.music);
    expect(new ScoreDocument(saved).chords[1].note).toBe('n2');
  });
  test('manual and automatic offsets remain distinct after save/reopen', () => {
    const doc = new ScoreDocument(SOURCE);
    Object.assign(doc.chords[0], { dx: -1.25, dy: 2.5, autoRaise: 18, autoX: 12.5 });
    const reload = new ScoreDocument(doc.serialize());
    expect(reload.chords).toEqual(doc.chords);
    expect(reload.music).toBe(doc.music);
  });
  test('legacy ChantEdit format is recognized without rewriting', () => {
    const source = 'name:T;\n%%\n(c4) A(g[nv:\\hbox to0pt{\\kern-\\csname gre@dimen@lastglyphwidth\\endcsname\\GreSetTextAboveLines{\\kern -1bp\\raise 12.6bp\\hbox{\\raise 2bp\\hbox{\\fontsize{9bp}{11bp}\\selectfont\\upshape\\bfseries G}}}\\csname gre@currenttextabovelines\\endcsname\\hss}]h) (::)\n';
    const doc = new ScoreDocument(source);
    expect(doc.chords[0]).toEqual({ note: 'n1', text: 'G', dx: -1, dy: 2, autoRaise: 12.6, autoX: 0 });
    expect(doc.serialize()).toBe(source);
  });
  test('invalid note IDs and chord injection are rejected', () => {
    const doc = new ScoreDocument(SOURCE);
    expect(() => doc.setChord('n999', 'C')).toThrow('Unknown note');
    expect(() => doc.setChord('n1', 'C\\input{evil}')).toThrow('Unsupported chord');
    for (const chord of ['Am', 'G/B', 'F♯M7', 'B♭', 'C7(♯9)', 'N.C.']) expect(validChord(chord)).toBe(true);
  });
  test('unsupported or malformed notation fails explicitly', () => {
    for (const source of ['no header', 'name:T;\n%%\n(c4) A(g', 'name:T;\n%%\n(c4) A(g@h)', 'name:T;\n%%\n(c4) A(g|text)']) expect(() => new ScoreDocument(source)).toThrow();
  });
});

describe('Exsurge geometry and shared editing', () => {
  test('clear controls are hidden without changing note targets, lyrics or saved source', () => {
    const source = 'name:Clear test;\r\n%%\r\n(c4) Dó(ghg) <clear>*(,) bé<clear/>ne(hi) <clear /><clear>di(-gh/hsss/hvv) (::) % 😀 <clear>\r\n';
    const { doc, preview, measure } = create(source);
    const plain = create(source.replace(/<clear\s*\/?>/g, ''));
    expect(preview.positions).toEqual(plain.preview.positions);
    expect(preview.positions.map(p => p.note)).toEqual(doc.notes.map(n => n.id));
    const svg = scoreSvg(doc, preview, []);
    expect(svg).not.toContain('&lt;clear');
    expect(svg).not.toContain('>clear');
    expect(svg).toContain('>*</tspan>');
    expect(doc.serialize()).toBe(source);
    for (const note of doc.notes) doc.setChord(note.id, 'Am');
    layoutChords(doc, preview, measure);
    const saved = doc.serialize(), reloaded = new ScoreDocument(saved);
    expect(reloaded.music).toBe(source);
    expect(saved.match(/<clear\s*\/?>/g)).toHaveLength(5);
    expect(renderScore(reloaded, exsurge, measure).positions).toEqual(preview.positions);
  });
  test('control filtering preserves annotation and verbatim contents and UTF-16 offsets', () => {
    const source = 'Dó😀<clear><clear/>mi(gh[cs:<clear>]) <v>literal <clear></v> <clear />nus(h)';
    const prepared = prepareRendererSource(source);
    expect(prepared.source).toBe('Dó😀mi(gh[cs:<clear>]) <v>literal <clear></v> nus(h)');
    for (const note of ['g', 'h']) {
      const rendered = prepared.source.lastIndexOf(note);
      expect(prepared.originalOffset(rendered)).toBe(source.lastIndexOf(note));
    }
    expect(prepared.originalOffset(prepared.source.length)).toBe(source.length);
  });
  test('maps individual notes, including porrectus, repeated virgas and strophae', () => {
    const { doc, preview } = create('name:T;\n%%\n(c4) Dó(ihj/hsss/hvv/-gh) (::)\n');
    expect(preview.positions.length).toBe(doc.notes.length);
    expect(preview.positions.every(p => Number.isFinite(p.x) && Number.isFinite(p.noteY))).toBe(true);
    expect(preview.staves[0].svg).toContain('dropCap');
  });
  test('same-neume chords sit side by side; chant geometry is immutable', () => {
    const { doc, preview, measure } = create();
    const before = structuredClone(preview);
    doc.setChord('n1', 'Cmaj7'); doc.setChord('n2', 'Dm7'); doc.setChord('n3', 'G7');
    const placed = layoutChords(doc, preview, measure);
    expect(placed[1].x).toBeGreaterThan(placed[0].x + placed[0].width);
    expect(placed[2].x).toBeGreaterThan(placed[1].x + placed[1].width);
    expect(placed[0].baseline).toBe(placed[1].baseline);
    expect(preview).toEqual(before);
  });
  test('collisions between groups stagger vertically', () => {
    const { doc, preview, measure } = create('name:T;\n%%\n(c4) A(g) B(h) (::)\n');
    preview.positions[1].x = preview.positions[0].x + 2;
    preview.positions[1].glyphX = preview.positions[1].x;
    doc.setChord('n1', 'Cmaj7'); doc.setChord('n2', 'Dm');
    layoutChords(doc, preview, measure);
    expect(doc.chords[1].autoRaise).toBeGreaterThan(0);
  });
  test('initial collision layout is polished without dirtying an unchanged document', () => {
    const source = 'name:T;\n%%\n(c4) A([alt:Cmaj7]g) B([alt:Dm]h) (::)\n';
    const { doc, preview, measure } = create(source);
    preview.positions[1].x = preview.positions[0].x + 2;
    preview.positions[1].glyphX = preview.positions[1].x;
    const ed = new Editor(doc, preview, measure);
    expect(ed.doc.chords[1].autoRaise).toBeGreaterThan(0);
    expect(doc.dirty).toBe(false);
    expect(doc.serialize()).toBe(source);
  });
  test('typing, tabbing, movement, nudges, undo and redo match the GUI workflow', () => {
    const { doc, preview, measure } = create();
    const ed = new Editor(doc, preview, measure);
    ed.select(0); ed.type('Dm'); ed.finish();
    expect(doc.chords[0].text).toBe('Dm');
    ed.startEdit(); ed.type('7'); ed.finish(); expect(doc.chords[0].text).toBe('Dm7');
    ed.type('G'); ed.finish(); expect(doc.chords[0].text).toBe('G');
    ed.tab(1); ed.type('Am'); ed.finish(); ed.nudge(1.5, 2);
    expect(doc.chords[1].dx).toBe(1.5);
    ed.undo(); expect(doc.chords[1].dx).toBe(0);
    ed.redo(); expect(doc.chords[1].dy).toBe(2);
    ed.moveTo(2); expect(ed.selected).toBe('n3');
    ed.delete(); expect(doc.chords.length).toBe(1);
    ed.undo(); expect(doc.chords.length).toBe(2);
    expect(new ScoreDocument(doc.serialize()).music).toBe(doc.music);
  });
  test('polished SVG includes header fields, drop cap and chords', () => {
    const { doc, preview, measure } = create();
    const svg = scoreSvg(doc, preview, layoutChords(doc, preview, measure));
    expect(svg).toContain('A feast'); expect(svg).toContain('Introit'); expect(svg).toContain('dropCap');
    expect(svg).toContain('font-weight="bold">C</text>');
  });
});

const samples = process.env.NEUMES_SAMPLES || join(homedir(), 'dev/chant/scores');
describe('real local scores (read-only)', () => {
  if (!existsSync(samples)) test.skip('set NEUMES_SAMPLES to a directory of GABC files', () => {});
  else for (const file of readdirSync(samples).filter(f => f.endsWith('.gabc'))) test(file, () => {
    const source = readFileSync(`${samples}/${file}`, 'utf8');
    const { doc, preview, measure } = create(source);
    expect(doc.serialize()).toBe(source);
    expect(preview.positions.length).toBe(doc.notes.length);
    expect(preview.staves.map(s => s.svg).join('')).not.toContain('&lt;clear');
    for (const n of doc.notes) doc.setChord(n.id, ['C', 'Am', 'Dm7', 'G/B'][n.index % 4]);
    layoutChords(doc, preview, measure);
    const reload = new ScoreDocument(doc.serialize());
    expect(reload.music).toBe(doc.music);
    expect(reload.chords).toEqual([...doc.chords].sort((a, b) => doc.note(a.note).index - doc.note(b.note).index));
    expect(renderScore(reload, exsurge, measure).positions).toEqual(preview.positions);
  });
});
