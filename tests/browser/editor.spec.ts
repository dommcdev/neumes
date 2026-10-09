import { test, expect, type Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ScoreDocument } from '../../src/core/document.ts';

const SOURCE = 'name: O quam glorifica;\nsheet-heading: Hymn;\nsheet-title: O quam glorifica;\nsheet-subtitle: For the choir;\noffice-part:Hymn;\nmode:2;\n%%\n(f3) O(f) quam(e) glo(fh)rí(hg)fi(fg)ca(f.) (::)\n';

async function drop(page: Page, source = SOURCE, name = 'hymn.gabc') {
  await page.evaluate(({ source, name }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([source], name, { type: 'text/plain' }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, { source, name });
}
async function nativeFile(page: Page, source = SOURCE) {
  // Real native FileSystemFileHandles and createWritable, using origin-private
  // storage. Only the OS picker is mocked; no actual user file is touched.
  await page.evaluate(async source => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('native-test.gabc', { create: true });
    const writable = await handle.createWritable(); await writable.write(source); await writable.close();
    window.showOpenFilePicker = async () => [handle];
    window.showSaveFilePicker = async () => handle;
  }, source);
}
async function onDisk(page: Page) {
  return page.evaluate(async () => { const root = await navigator.storage.getDirectory(); return (await (await root.getFileHandle('native-test.gabc')).getFile()).text(); });
}

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('minimal menu-only interface, polished headers and individual note editing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await expect(page.getByRole('button', { name: 'Main menu', exact: true })).toBeVisible();
  await expect(page.locator('button:visible')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Open a .gabc file' })).toBeVisible();
  await drop(page);
  await expect(page.locator('.sheet-title')).toHaveText('O quam glorifica');
  await expect(page.locator('.sheet-heading')).toHaveText('Hymn');
  await expect(page.locator('.sheet-subtitle')).toHaveText('For the choir');
  await expect(page.locator('.dropCap')).toHaveCount(1);
  expect(await page.locator('.dropCap').evaluate(el => getComputedStyle(el).fontSize)).toBe('78px');
  expect(await page.locator('.lyric').first().evaluate(el => getComputedStyle(el).fontFamily)).toContain('EB Garamond');
  await expect(page.locator('[data-note]')).toHaveCount(9);
  await page.locator('[data-note="n3"]').click();
  await page.keyboard.type('Cmaj7');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Am');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-chord="n3"]')).toHaveText('Cmaj7');
  await expect(page.locator('[data-chord="n4"]')).toHaveText('Am');
  const left = await page.locator('[data-chord="n3"]').boundingBox();
  const right = await page.locator('[data-chord="n4"]').boundingBox();
  expect(right!.x).toBeGreaterThan(left!.x + left!.width);
  expect(Math.abs(right!.y - left!.y)).toBeLessThan(1);
  await page.keyboard.press('Control+ArrowRight');
  await page.keyboard.press('Control+ArrowUp');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+r');
  await page.keyboard.press('F2');
  await page.keyboard.type('7');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-chord="n4"]')).toHaveText('Am7');
  await page.keyboard.type('G');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-chord="n4"]')).toHaveText('G');
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-chord="n4"]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-chord="n4"]')).toHaveText('G');
  expect(errors).toEqual([]);
});

test('native open/save, offset persistence, lossless music and reopen', async ({ page }) => {
  await nativeFile(page);
  await page.keyboard.press('Control+o');
  await expect(page.locator('.paper')).toBeVisible();
  await page.keyboard.type('Dm');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+ArrowRight');
  await page.keyboard.press('Control+ArrowUp');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.dirty')).toHaveCount(0);
  const saved = new ScoreDocument(await onDisk(page));
  expect(saved.music).toBe(SOURCE);
  expect(saved.chords[0].dx).toBe(.5); expect(saved.chords[0].dy).toBe(.5);
  await page.keyboard.press('Control+o');
  await expect(page.locator('[data-chord="n1"]')).toHaveText('Dm');
  expect(await onDisk(page)).toBe(saved.serialize());
});

test('drop warns before replacing unsaved changes, cancel preserves the score', async ({ page }) => {
  await drop(page); await expect(page.locator('.paper')).toBeVisible();
  await page.keyboard.type('C'); await page.keyboard.press('Enter');
  await drop(page, 'name:Replacement;\n%%\n(c4) A(ghg) (::)\n', 'replacement.gabc');
  await expect(page.getByRole('heading', { name: 'Replace this score?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.sheet-title')).toHaveText('O quam glorifica');
  await expect(page.locator('[data-chord="n1"]')).toHaveText('C');
  await drop(page, 'name:Replacement;\n%%\n(c4) A(ghg) (::)\n', 'replacement.gabc');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('.sheet-title')).toHaveText('Replacement');
});

test('external edits are not overwritten silently', async ({ page }) => {
  await nativeFile(page); await page.keyboard.press('Control+o'); await expect(page.locator('.paper')).toBeVisible();
  await page.keyboard.type('C'); await page.keyboard.press('Enter');
  const external = SOURCE.replace('O quam glorifica;', 'External edit;');
  await nativeFile(page, external);
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('heading', { name: 'The file changed on disk' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await onDisk(page)).toBe(external);
  await expect(page.locator('.dirty')).toHaveCount(1);
});

test('landing page opens a file from its button', async ({ page }) => {
  await expect(page.locator('.empty-hint')).toHaveText('or drag and drop one anywhere on this page');
  await nativeFile(page);
  await page.getByRole('button', { name: 'Open a .gabc file' }).click();
  await expect(page.locator('.paper')).toBeVisible();
  await expect(page.locator('.empty')).toHaveCount(0);
});

test('minimal UI has no footer, guides, folder browsing, or extra copy', async ({ page }) => {
  await expect(page.locator('.empty')).toHaveText('Open a .gabc file or drag and drop one anywhere on this page');
  await expect(page.locator('.status,.privacy')).toHaveCount(0);
  await drop(page); await expect(page.locator('.paper')).toBeVisible();
  await expect(page.locator('.file-label')).toHaveText('hymn.gabc');
  await page.getByRole('button', { name: 'Main menu', exact: true }).click();
  await expect(page.locator('[data-action="folder"],[data-action="guides"],[data-action="about"],[data-action="fit"],.menu small')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+g');
  await expect(page.locator('.guide')).toHaveCount(0);
  await page.keyboard.press('Alt+PageDown');
  await expect(page.locator('.sheet-title')).toHaveText('O quam glorifica');
  await expect(page.locator('.toast')).toHaveText('');
});

test('keyboard shortcuts use grouped tables and key badges, with no prose', async ({ page }) => {
  await page.keyboard.press('F1');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help.getByRole('heading', { name: 'Chords', exact: true })).toBeVisible();
  await expect(help.getByRole('heading', { name: 'Editor', exact: true })).toBeVisible();
  await expect(help.getByRole('table')).toHaveCount(2);
  await expect(help.locator('kbd').first()).toBeVisible();
  await expect(help.locator('p')).toHaveCount(0);
  await expect(help).not.toContainText('guides');
  await expect(help).not.toContainText('folder');
  await expect(help).not.toContainText('Fit width');
  await page.getByRole('button', { name: 'Close keyboard shortcuts' }).click();
  await expect(help).not.toBeVisible();
  await page.setViewportSize({ width: 600, height: 800 });
  await page.keyboard.press('F1');
  const tableBoxes = await help.getByRole('table').all();
  const first = await tableBoxes[0].boundingBox(), second = await tableBoxes[1].boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height);
  expect(await help.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(help).not.toBeVisible();
  // Confirmation dialogs must not inherit the wide shortcuts-dialog styling.
  await drop(page); await expect(page.locator('.paper')).toBeVisible();
  await page.keyboard.type('C'); await page.keyboard.press('Enter');
  await drop(page);
  await expect(page.getByRole('heading', { name: 'Replace this score?' })).toBeVisible();
  await expect(page.locator('dialog')).not.toHaveClass('shortcuts-dialog');
});

test('zoom controls change scale, not the score layout or document', async ({ page }) => {
  await drop(page); await expect(page.locator('.paper')).toBeVisible();
  const original = await page.locator('.engraving').first().innerHTML();
  const initial = await page.locator('.paper-slot').boundingBox();
  await page.keyboard.press('Control++');
  const enlarged = await page.locator('.paper-slot').boundingBox();
  expect(enlarged!.width).toBeGreaterThan(initial!.width);
  await page.keyboard.press('Control+-');
  const reduced = await page.locator('.paper-slot').boundingBox();
  expect(reduced!.width).toBeLessThan(enlarged!.width);
  expect(reduced!.width).toBeCloseTo(initial!.width, 0);
  expect(await page.locator('.engraving').first().innerHTML()).toBe(original);
  await expect(page.locator('.dirty')).toHaveCount(0);
});

test('PDF export uses print layout without chrome, selections, or musical changes', async ({ page }) => {
  await drop(page); await expect(page.locator('.paper')).toBeVisible();
  await page.keyboard.type('Dm'); await page.keyboard.press('Enter');
  const original = await page.locator('.engraving').first().innerHTML();
  await page.evaluate(() => {
    window.print = () => document.documentElement.setAttribute('data-print-title', document.title);
  });
  await page.getByRole('button', { name: 'Main menu', exact: true }).click();
  await page.locator('[data-action="export-pdf"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-print-title', 'hymn');
  await expect(page).toHaveTitle('• hymn.gabc — Neumes');
  await expect(page.locator('.dirty')).toHaveCount(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.menu-trigger')).not.toBeVisible();
  await expect(page.locator('.file-label')).not.toBeVisible();
  await expect(page.locator('.cursor').first()).not.toBeVisible();
  await expect(page.locator('.selected').first()).not.toBeVisible();
  await expect(page.locator('[data-chord="n1"]')).toBeVisible();
  expect(await page.locator('.engraving').first().innerHTML()).toBe(original);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  expect(pdf.length).toBeGreaterThan(10000);
});

test('a failed native write leaves the score dirty and the file unchanged', async ({ page }) => {
  await nativeFile(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('native-test.gabc');
    handle.createWritable = async () => { throw new Error('Write permission denied'); };
    window.showOpenFilePicker = async () => [handle];
  });
  await page.keyboard.press('Control+o'); await expect(page.locator('.paper')).toBeVisible();
  await page.keyboard.type('C'); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.toast')).toContainText('Could not save');
  await expect(page.locator('.dirty')).toHaveCount(1);
  expect(await onDisk(page)).toBe(SOURCE);
});

test('Ctrl-drag manually moves chord text, drag snaps it to another note', async ({ page }) => {
  await drop(page); await expect(page.locator('.paper')).toBeVisible();
  await page.keyboard.type('C'); await page.keyboard.press('Enter');
  const box = await page.locator('[data-chord="n1"]').boundingBox();
  await page.keyboard.down('Control');
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 30, box!.y + box!.height / 2 - 20, { steps: 4 }); await page.mouse.up();
  await page.keyboard.up('Control');
  const moved = await page.locator('[data-chord="n1"]').boundingBox();
  expect(moved!.x).toBeGreaterThan(box!.x + 25);
  await page.keyboard.press('Control+r');
  const reset = await page.locator('[data-chord="n1"]').boundingBox();
  const target = await page.locator('[data-note="n2"]').boundingBox();
  await page.mouse.move(reset!.x + reset!.width / 2, reset!.y + reset!.height / 2); await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('[data-chord="n2"]')).toHaveText('C');
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-chord="n1"]')).toHaveText('C');
});

test('local draft recovery remains unsaved until written to a file', async ({ page }) => {
  const doc = new ScoreDocument(SOURCE); doc.setChord('n1', 'Am');
  await page.evaluate(draft => localStorage.setItem('neumes-draft', JSON.stringify(draft)), { name: 'recovery.gabc', source: doc.serialize() });
  await page.reload();
  await page.getByRole('button', { name: 'Recover', exact: true }).click();
  await expect(page.locator('[data-chord="n1"]')).toHaveText('Am');
  await expect(page.locator('.dirty')).toHaveCount(1);
  await drop(page);
  await expect(page.getByRole('heading', { name: 'Replace this score?' })).toBeVisible();
});

test('score content never causes network uploads or unsafe SVG execution', async ({ page }) => {
  const remote: string[] = [];
  page.on('request', req => { if (!req.url().startsWith('http://127.0.0.1:5173') && !req.url().startsWith('data:')) remote.push(req.url()); });
  await drop(page, 'name:<script>alert(1)</script>;\n%%\n(c4) <b>Dó</b>(ghg/hsss/hvv) (::)\n');
  await expect(page.locator('.paper')).toBeVisible();
  await expect(page.locator('.sheet-title')).toHaveText('<script>alert(1)</script>');
  await expect(page.locator('[data-note]')).toHaveCount(8);
  expect(await page.locator('.paper script,.paper foreignObject,.paper [onload]').count()).toBe(0);
  expect(remote).toEqual([]);
});

test('clear controls do not appear in the score and survive native save', async ({ page }) => {
  const source = 'name:Clear test;\n%%\n(c4) Dó(ghg) <clear>*(,) bé<clear/>ne(hi) <clear />di(-gh) (::)\n';
  await nativeFile(page, source);
  await page.keyboard.press('Control+o');
  await expect(page.locator('.paper')).toBeVisible();
  await expect(page.locator('.engraving')).not.toContainText('<clear');
  await expect(page.locator('.engraving')).toContainText('*');
  await expect(page.locator('[data-note]')).toHaveCount(7);
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  await page.keyboard.type('Am'); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.dirty')).toHaveCount(0);
  const saved = await onDisk(page);
  const doc = new ScoreDocument(saved);
  expect(doc.music).toBe(source);
  expect(doc.chords[0].note).toBe('n6');
  expect(saved.match(/<clear\s*\/?>/g)).toHaveLength(3);
});

const sample = join(process.env.NEUMES_SAMPLES || join(homedir(), 'dev/chant/scores'), 'in--omnia_quae_fecisti.gabc');
test('real score renders with existing chords and polished metadata', async ({ page }) => {
  test.skip(!existsSync(sample), 'Local reference score is not installed.');
  await drop(page, readFileSync(sample, 'utf8'), 'in--omnia_quae_fecisti.gabc');
  await expect(page.locator('.sheet-heading')).toHaveText('20th Sunday after Pentecost');
  await expect(page.locator('.sheet-title')).toHaveText('Introit');
  await expect(page.locator('[data-note]')).toHaveCount(223);
  await expect(page.locator('[data-chord]')).toHaveCount(67);
});
