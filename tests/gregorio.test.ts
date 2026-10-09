/** Optional authoritative export check. Docker/TeX are never app dependencies. */
import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScoreDocument } from '../src/core/document.ts';
import { renderScore, layoutChords } from '../src/core/render.ts';
import { exsurge, nativeMeasure } from '../src/native.ts';

test.skipIf(!process.env.NEUMES_GREGORIO)('all individual chords survive Gregorio; glyphs and horizontal geometry stay identical', async () => {
  const dir = await mkdtemp(join(process.env.NEUMES_TMP || tmpdir(), 'neumes-gregorio-'));
  try {
    const source = 'name:Spacing test;\n%%\n(c4) Dó(ghg/hsss/hvv)mi(hi)nus(g.) (::)\n';
    const doc = new ScoreDocument(source), measure = nativeMeasure();
    const preview = renderScore(doc, exsurge, measure);
    for (const n of doc.notes) doc.setChord(n.id, ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'B', 'C7', 'Dm7', 'Em7', 'F7'][n.index]);
    layoutChords(doc, preview, measure);
    await writeFile(join(dir, 'base.gabc'), source);
    await writeFile(join(dir, 'chords.gabc'), doc.serialize());
    const tex = String.raw`\documentclass{article}
\usepackage{fontspec}
\usepackage{gregoriotex}
\newwrite\positions
\immediate\openout\positions=\jobname.positions
\let\OriginalGreGlyph\GreGlyph
\def\GreGlyph#1#2#3#4#5#6#7{\savepos\write\positions{\the\lastxpos}\OriginalGreGlyph{#1}{#2}{#3}{#4}{#5}{#6}{#7}}
\begin{document}
\input{SCORE.gtex}
\end{document}
`;
    for (const name of ['base', 'chords']) await writeFile(join(dir, `${name}.tex`), tex.replace('SCORE', name));
    const image = process.env.NEUMES_TEX_IMAGE || 'texlive/texlive:latest';
    const command = 'export PATH=/usr/local/texlive/2026/bin/x86_64-linux:$PATH; gregorio base.gabc && gregorio chords.gabc && lualatex -interaction=nonstopmode -halt-on-error base.tex && lualatex -interaction=nonstopmode -halt-on-error base.tex && lualatex -interaction=nonstopmode -halt-on-error chords.tex && lualatex -interaction=nonstopmode -halt-on-error chords.tex';
    const child = Bun.spawn(['docker', 'run', '--rm', '--network', 'none', '-v', `${dir}:/work`, '-w', '/work', image, 'sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
    expect(await child.exited, output).toBe(0);
    const base = await readFile(join(dir, 'base.gtex'), 'utf8'), chords = await readFile(join(dir, 'chords.gtex'), 'utf8');
    const glyphs = (s: string) => s.split('\n').filter(l => l.startsWith('\\GreGlyph{'));
    expect(glyphs(chords)).toEqual(glyphs(base));
    expect([...chords.matchAll(/\\bfseries /g)]).toHaveLength(doc.notes.length);
    const positions = await readFile(join(dir, 'base.positions'), 'utf8');
    expect(positions.trim()).not.toBe('');
    expect(await readFile(join(dir, 'chords.positions'), 'utf8')).toBe(positions);
  } finally { await rm(dir, { recursive: true }); }
}, 120000);
