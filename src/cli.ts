#!/usr/bin/env bun
import { readFile, writeFile, rename, unlink, stat, realpath, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ScoreDocument, revision } from './core/document.ts';
import { renderScore, layoutChords, scoreSvg, SCORE_WIDTH } from './core/render.ts';
import { exsurge, nativeMeasure } from './native.ts';

const help = `Neumes — individual-note chord editing for GABC

  bun run cli inspect SCORE.gabc [--json]
  bun run cli set-chord SCORE.gabc --note n12 --chord Am [--expect VERSION]
  bun run cli remove-chord SCORE.gabc --note n12 [--expect VERSION]
  bun run cli apply SCORE.gabc --edits edits.json [--expect VERSION]
  bun run cli validate SCORE.gabc
  bun run cli render SCORE.gabc --output score.svg

Edits JSON: {"version":"<version from inspect>","edits":[
  {"note":"n1","chord":"C"}, {"note":"n2","chord":"Am"},
  {"note":"n3","chord":null}
]}
An edits array is also accepted. --edits - reads stdin.

inspect returns every individual note, its pitch, syllable, group, and chord.
All commands return JSON (except help). Edits are atomic and preserve the music.
--dry-run validates and reports a proposed edit without writing.
--width N chooses the rendering width (default ${SCORE_WIDTH}).
No manual placement commands: chords in a neume are packed side by side;
collisions between neumes are staggered upward. Use the website for fine tuning.
`;

const version = (source: string) => createHash('sha256').update(source).digest('hex');
function parseArgs(args: string[]): { command: string; path: string; options: Record<string, string | boolean> } {
  const [command = 'help', path = '', ...rest] = args;
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!['--note', '--chord', '--edits', '--expect', '--output', '--width', '--json', '--dry-run'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    if (key === '--json' || key === '--dry-run') options[key.slice(2)] = true;
    else { const value = rest[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`); options[key.slice(2)] = value; }
  }
  return { command, path, options };
}

async function atomicSave(path: string, source: string, expected: string): Promise<void> {
  if (version(await readFile(path, 'utf8')) !== expected) throw new Error('File changed during editing. Inspect again before retrying.');
  const mode = (await stat(path)).mode;
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', mode);
    try { await file.chmod(mode); await file.writeFile(source); await file.sync(); } finally { await file.close(); }
    if (version(await readFile(path, 'utf8')) !== expected) throw new Error('File changed during editing. Nothing saved.');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function main(): Promise<void> {
  const { command, path, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') { console.log(help); return; }
  if (!['inspect', 'set-chord', 'remove-chord', 'apply', 'validate', 'render'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (!path.toLowerCase().endsWith('.gabc')) throw new Error('Provide a .gabc file.');
  const target = await realpath(path);
  if ((await stat(target)).size > 4 * 1024 * 1024) throw new Error('GABC files must be smaller than 4 MiB.');
  const source = await readFile(target, 'utf8');
  const originalVersion = version(source);
  const doc = new ScoreDocument(source);
  const width = options.width === undefined ? SCORE_WIDTH : Number(options.width);
  const measure = nativeMeasure();
  const preview = renderScore(doc, exsurge, measure, width);
  if (options.expect && options.expect !== originalVersion) throw new Error('Stale score version. Inspect the current file before editing.');
  let changed = false;
  if (command === 'set-chord' || command === 'remove-chord') {
    if (typeof options.note !== 'string') throw new Error('--note is required.');
    if (command === 'set-chord') {
      if (typeof options.chord !== 'string') throw new Error('--chord is required.');
      doc.setChord(options.note, options.chord);
    } else doc.removeChord(options.note);
    changed = true;
  }
  if (command === 'apply') {
    if (typeof options.edits !== 'string') throw new Error('--edits is required.');
    const input = JSON.parse(options.edits === '-' ? await Bun.stdin.text() : await readFile(options.edits, 'utf8'));
    if (!Array.isArray(input) && input.version && input.version !== originalVersion) throw new Error('Stale edits version. Inspect again.');
    const edits = Array.isArray(input) ? input : input.edits;
    if (!Array.isArray(edits)) throw new Error('Expected an edits array.');
    for (const edit of edits) {
      if (!edit || typeof edit.note !== 'string' || !(typeof edit.chord === 'string' || edit.chord === null)) throw new Error('Each edit needs a note ID and a chord string (or null).');
      if (edit.chord === null) doc.removeChord(edit.note); else doc.setChord(edit.note, edit.chord);
    }
    changed = true;
  }
  const placed = layoutChords(doc, preview, measure, changed || command === 'render');
  if (command === 'inspect') {
    console.log(JSON.stringify({ name: doc.name, headers: doc.headers, version: originalVersion, musicalRevision: revision(doc), width, notes: doc.notes.map(n => ({ id: n.id, index: n.index, lyric: n.lyric, pitch: n.pitch, staffPosition: n.staffPosition, group: n.group, repeat: n.repeat, notation: n.gabc, chord: doc.chords.find(c => c.note === n.id)?.text ?? null, staff: preview.positions[n.index].staff + 1 })) }, null, 2));
    return;
  }
  if (command === 'render') {
    if (typeof options.output !== 'string' || !options.output.endsWith('.svg')) throw new Error('--output must name an SVG file.');
    const regular = (await readFile(new URL('../public/fonts/EBGaramond.ttf', import.meta.url))).toString('base64');
    const italic = (await readFile(new URL('../public/fonts/EBGaramond-Italic.ttf', import.meta.url))).toString('base64');
    const fonts = `<defs><style>@font-face{font-family:'EB Garamond';src:url(data:font/ttf;base64,${regular});font-weight:400 800;font-style:normal}@font-face{font-family:'EB Garamond';src:url(data:font/ttf;base64,${italic});font-weight:400 800;font-style:italic}</style></defs>`;
    await writeFile(options.output, scoreSvg(doc, preview, placed).replace(/(<svg[^>]*>)/, `$1${fonts}`));
    console.log(JSON.stringify({ ok: true, output: options.output, staves: preview.staves.length })); return;
  }
  const serialized = doc.serialize();
  const reloaded = new ScoreDocument(serialized);
  if (reloaded.music !== doc.music) throw new Error('Internal validation failed: music changed. Nothing saved.');
  if (!changed && serialized !== source) throw new Error('Lossless round-trip check failed.');
  if (changed && !options['dry-run']) await atomicSave(target, serialized, originalVersion);
  console.log(JSON.stringify({ ok: true, notes: doc.notes.length, chords: doc.chords.filter(c => c.text).length, staves: preview.staves.length, version: version(serialized), saved: changed && !options['dry-run'], dryRun: !!options['dry-run'] }));
}

main().catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
