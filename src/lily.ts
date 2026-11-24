/** Runs the local LilyPond for the CLI and tests (the desktop app does the same
 * in desktop/src/lily.rs). The browser never needs LilyPond.
 */
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LILYPOND = process.env.LILYPOND || 'lilypond';
/** Point-and-click links for noteheads and syllables, for `readGeometry`. */
export const GEOMETRY_ARGS = ['-dbackend=svg', '-dpoint-and-click=(note-event lyric-event)'];
/** Text as outlines, so pages look the same without LilyPond's fonts. */
export const DISPLAY_ARGS = ['-dbackend=cairo', '--svg', '-dno-point-and-click'];

async function run(args: string[], cwd: string): Promise<void> {
  let process;
  try { process = Bun.spawn([LILYPOND, '-l', 'ERROR', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' }); }
  catch { throw new Error('LilyPond is not installed (or set LILYPOND to its path).'); }
  const stderr = await new Response(process.stderr).text();
  if (await process.exited) throw new Error(`LilyPond failed: ${stderr.trim().split('\n').slice(-6).join('\n') || 'unknown error'}`);
}

/** SVG pages LilyPond wrote as `<stem>.svg` or `<stem>-1.svg`, `<stem>-2.svg`, … */
async function pages(dir: string, stem: string): Promise<string[]> {
  const names = (await readdir(dir)).filter(n => n.startsWith(stem) && n.endsWith('.svg'));
  const page = (n: string) => Number(/-(\d+)\.svg$/.exec(n)?.[1] ?? 0);
  return Promise.all(names.sort((a, b) => page(a) - page(b)).map(n => readFile(join(dir, n), 'utf8')));
}

async function scratch<T>(source: string, work: (dir: string, file: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'neumes-ly-')));
  try {
    const file = join(dir, 'score.ly');
    await writeFile(file, source);
    return await work(dir, file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Engraves `music`; `includeDir` is the score's folder, for its \include files. */
export async function engrave(music: string, includeDir?: string, display = false): Promise<{ geometry: string[]; display: string[]; file: string }> {
  const include = includeDir ? ['-I', includeDir] : [];
  return scratch(music, async (dir, file) => {
    await Promise.all([
      run([...GEOMETRY_ARGS, ...include, '-o', 'geometry', file], dir),
      display ? run([...DISPLAY_ARGS, ...include, '-o', 'display', file], dir) : undefined,
    ]);
    return { geometry: await pages(dir, 'geometry'), display: display ? await pages(dir, 'display') : [], file };
  });
}

/** The finished score as LilyPond prints it: PDF, or SVG pages. */
export async function print(source: string, format: 'pdf' | 'svg', includeDir?: string): Promise<Uint8Array[]> {
  const include = includeDir ? ['-I', includeDir] : [];
  return scratch(source, async (dir, file) => {
    await run([...(format === 'svg' ? DISPLAY_ARGS : ['-dno-point-and-click']), ...include, '-o', 'out', file], dir);
    const names = (await readdir(dir)).filter(n => n.startsWith('out') && n.endsWith(`.${format}`)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!names.length) throw new Error('LilyPond produced no output.');
    return Promise.all(names.map(async n => new Uint8Array(await readFile(join(dir, n)))));
  });
}
