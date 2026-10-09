import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScoreDocument } from '../src/core/document.ts';

async function cli(...args: string[]) {
  const result = Bun.spawn(['bun', 'src/cli.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(result.stdout).text();
  const stderr = await new Response(result.stderr).text();
  const code = await result.exited;
  return { code, data: JSON.parse(code ? stderr : stdout) };
}

test('CLI inspect, version guard, batch editing, dry run, atomic save and render', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neumes-cli-'));
  const path = join(dir, 'test.gabc');
  const original = 'name:CLI test;\n%%\n(c4) Do(ghg)mi(h)nus(g.) (::)\n';
  try {
    await writeFile(path, original);
    const inspection = await cli('inspect', path);
    expect(inspection.code).toBe(0); expect(inspection.data.notes.length).toBe(5);
    const edits = join(dir, 'edits.json');
    await writeFile(edits, JSON.stringify({ version: inspection.data.version, edits: [{ note: 'n1', chord: 'C' }, { note: 'n2', chord: 'Am' }, { note: 'n3', chord: 'G7' }] }));
    expect((await cli('apply', path, '--edits', edits, '--dry-run')).data.saved).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await cli('apply', path, '--edits', edits)).data.saved).toBe(true);
    const saved = await readFile(path, 'utf8');
    expect(new ScoreDocument(saved).chords.length).toBe(3);
    expect(new ScoreDocument(saved).music).toBe(original);
    expect((await cli('apply', path, '--edits', edits)).code).toBe(1);
    expect(await readFile(path, 'utf8')).toBe(saved);
    expect((await cli('set-chord', path, '--note', 'n99', '--chord', 'C')).code).toBe(1);
    expect((await cli('set-chord', path, '--note', 'n4', '--chord', 'Dm')).data.saved).toBe(true);
    expect((await cli('remove-chord', path, '--note', 'n4')).data.chords).toBe(3);
    expect((await cli('validate', path)).data.ok).toBe(true);
    const svg = join(dir, 'score.svg');
    expect((await cli('render', path, '--output', svg)).data.ok).toBe(true);
    expect(await readFile(svg, 'utf8')).toContain('CLI test');
  } finally { await rm(dir, { recursive: true }); }
});

test('invalid batch applies nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neumes-cli-'));
  try {
    const path = join(dir, 'test.gabc'), edits = join(dir, 'edits.json');
    const source = 'name:T;\n%%\n(c4) A(gh) (::)\n';
    await writeFile(path, source);
    await writeFile(edits, JSON.stringify([{ note: 'n1', chord: 'C' }, { note: 'n900', chord: 'Am' }]));
    expect((await cli('apply', path, '--edits', edits)).code).toBe(1);
    expect(await readFile(path, 'utf8')).toBe(source);
  } finally { await rm(dir, { recursive: true }); }
});
