import { describe, test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeLilyChord, LilyDocument, lilyMusic, readGeometry } from '../src/core/lilypond.ts';
import { Editor } from '../src/core/editor.ts';
import { editorKey } from '../src/core/keys.ts';
import { nativeMeasure } from '../src/native.ts';
import { engrave } from '../src/lily.ts';

const hasLilyPond = !!Bun.which(process.env.LILYPOND || 'lilypond');
const SOURCE = `\\version "2.24.0"
\\header { title = "Kýrie" }
% a comment with ^"Am" in it
melody = \\relative c' {
\td4 e^"Am" <f a>2 g4\\fermata ^\\markup \\bold "C" r4^"D" a4( b) % ^"E"
  c4 ^"not a chord" d4 \\repeat unfold 2 { e4 }
}
words = \\lyricmode { Ký -- ri -- é e -- lé -- i -- son }
\\score { << \\new Voice = "v" \\melody \\new Lyrics \\lyricsto "v" \\words >> }
`;

describe('LilyPond chord annotations, without LilyPond', () => {
  test('only chord text scripts outside comments and strings are removed', () => {
    const music = lilyMusic(SOURCE);
    expect(music).toContain('% a comment with ^"Am" in it');
    expect(music).toContain('r4 a4( b) % ^"E"');
    expect(music).toContain('c4 ^"not a chord"');
    expect(music).toContain('d4 e <f a>2 g4\\fermata  r4 a4');
    expect(encodeLilyChord('F♯m7')).toBe('^\\markup \\bold "F♯m7"');
    expect(() => encodeLilyChord('"oops"')).toThrow();
  });
});

describe.skipIf(!hasLilyPond)('LilyPond scores', () => {
  const open = async (source = SOURCE) => {
    const engraved = await engrave(lilyMusic(source), undefined, true);
    return { doc: new LilyDocument(source, readGeometry(engraved.geometry, engraved.file), 'kyrie.ly'), engraved };
  };

  test('notes come from LilyPond; chords attach to them; unchanged save is identical', async () => {
    const { doc, engraved } = await open();
    expect(doc.serialize()).toBe(SOURCE);
    expect(doc.dirty).toBe(false);
    expect(doc.name).toBe('Kýrie');
    // d e <f a> g a b c d e (the repeat is one source note, engraved twice).
    expect(doc.notes.map(n => n.notation)).toEqual(['d4', 'e', '<f a>2', 'g4', 'a4', 'b', 'c4', 'd4', 'e4']);
    expect(doc.echoes.length).toBe(1);
    expect(doc.notes.slice(0, 3).map(n => n.lyric)).toEqual(['Ký', 'ri', 'é']);
    expect(doc.notes[0]).toMatchObject({ line: 5, column: 2, page: 0 });
    expect(doc.chords.map(c => [doc.note(c.note).notation, c.text])).toEqual([['e', 'Am'], ['g4', 'C']]);
    const preview = doc.preview(engraved.display);
    expect(preview.staves.length).toBe(1);
    expect(preview.staves[0].svg).toContain('<svg');
    expect(preview.positions.every((p, i) => i === 0 || p.x > preview.positions[i - 1].x)).toBe(true);
  });

  test('edits insert and remove only chord annotations', async () => {
    const { doc } = await open();
    doc.setChord('n1', 'Dm');
    doc.setChord('n3', 'B♭');
    doc.removeChord('n2');
    doc.setChord('n4', 'C7');
    const saved = doc.serialize();
    expect(saved).toContain('d4^\\markup \\bold "Dm" e <f a>2^\\markup \\bold "B♭" g4\\fermata ^\\markup \\bold "C7" r4^"D"');
    expect(lilyMusic(saved)).toBe(doc.music);
    const { doc: reloaded } = await open(saved);
    expect(reloaded.chords.map(c => [c.note, c.text])).toEqual([['n1', 'Dm'], ['n3', 'B♭'], ['n4', 'C7']]);
    expect(reloaded.serialize()).toBe(saved);
  });

  test('typing in the shared editor, without manual offsets', async () => {
    const { doc, engraved } = await open();
    const editor = new Editor(doc, doc.preview(engraved.display), nativeMeasure());
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'A', '7']) editorKey(editor, { key, ctrl: false, shift: false, alt: false });
    editorKey(editor, { key: 'ArrowUp', ctrl: false, shift: true, alt: false });
    expect(doc.chords.find(c => c.note === 'n5')).toMatchObject({ text: 'A7', dx: 0, dy: 0 });
    expect(editor.placed.find(p => p.note === 'n5')!.baseline).toBeLessThan(editor.preview.positions[4].noteY);
    expect(doc.serialize()).toContain('a4^\\markup \\bold "A7"( b)');
  });

  test('CLI inspect, set-chord and render', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neumes-ly-cli-'));
    const cli = async (...args: string[]) => {
      const run = Bun.spawn(['bun', 'src/cli.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = [await new Response(run.stdout).text(), await new Response(run.stderr).text(), await run.exited];
      return { code, data: JSON.parse(code ? err : out) };
    };
    try {
      const path = join(dir, 'kyrie.ly');
      await writeFile(path, SOURCE);
      const inspection = await cli('inspect', path);
      expect(inspection.code).toBe(0);
      expect(inspection.data.notes[1]).toMatchObject({ id: 'n2', notation: 'e', chord: 'Am', lyric: 'ri' });
      expect((await cli('set-chord', path, '--note', 'n1', '--chord', 'G', '--expect', inspection.data.version)).data.saved).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(SOURCE.replace('\td4 ', '\td4^\\markup \\bold "G" '));
      const pdf = join(dir, 'kyrie.pdf');
      expect((await cli('render', path, '--output', pdf)).code).toBe(0);
      expect((await readFile(pdf)).subarray(0, 4).toString()).toBe('%PDF');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
