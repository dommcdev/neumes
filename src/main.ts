import './styles.css';
import { ScoreDocument } from './core/document.ts';
import { Editor } from './core/editor.ts';
import { renderScore, escapeXml, SCORE_WIDTH, type Exsurge, type TextMeasurer } from './core/render.ts';

declare global { interface Window { exsurge: Exsurge } }
const PAPER_WIDTH = SCORE_WIDTH + 80;
const icon = (name: string) => {
  const paths: Record<string, string> = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    open: '<path d="M3 7V5h6l2 3h10l-3 12H3V7Z"/>',
    save: '<path d="M4 3h13l3 3v15H4V3Zm3 0v6h9V3M7 21v-8h10v8"/>',
    pdf: '<path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6"/>',
    undo: '<path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14"/>',
    redo: '<path d="m16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14"/>',
    plus: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6M10 7v6"/>',
    minus: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M7 10h6"/>',
    help: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.save}</svg>`;
};
const menuItem = (action: string, label: string, glyph: string, shortcut = '') => `<button data-action="${action}">${icon(glyph)}<span>${label}</span><kbd>${shortcut}</kbd></button>`;
document.querySelector('#app')!.innerHTML = `
  <button class="menu-trigger" aria-label="Main menu" aria-expanded="false" aria-controls="main-menu">${icon('menu')}</button>
  <nav class="menu" id="main-menu" aria-label="Main menu" hidden>
    <div class="menu-brand"><img src="/logo.svg" alt="Neumes"></div>
    ${menuItem('open', 'Open…', 'open', 'Ctrl O')}
    ${menuItem('save', 'Save to file', 'save', 'Ctrl S')}
    ${menuItem('save-as', 'Save as…', 'save', 'Ctrl Shift S')}
    ${menuItem('export-pdf', 'Export to PDF…', 'pdf')}
    <hr>
    ${menuItem('undo', 'Undo', 'undo', 'Ctrl Z')}
    ${menuItem('redo', 'Redo', 'redo', 'Ctrl Shift Z')}
    <hr>
    ${menuItem('zoom-in', 'Zoom in', 'plus', 'Ctrl +')}
    ${menuItem('zoom-out', 'Zoom out', 'minus', 'Ctrl −')}
    <hr>
    ${menuItem('shortcuts', 'Keyboard shortcuts', 'help', 'F1')}
  </nav>
  <div class="file-label"></div>
  <main class="workspace" tabindex="-1" aria-label="Chant score editor">
    <section class="empty"><div class="empty-content">
      <img src="/logo.svg" alt="Neumes">
      <button class="empty-open">${icon('open')}<span>Open a .gabc file</span></button>
      <p class="empty-hint">or drag and drop one anywhere on this page</p>
    </div></section>
  </main>
  <div class="toast" role="alert"></div>
  <div class="drop-cover" hidden></div>
  <dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;

const workspace = document.querySelector<HTMLElement>('.workspace')!;
const menu = document.querySelector<HTMLElement>('.menu')!;
const trigger = document.querySelector<HTMLButtonElement>('.menu-trigger')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
const measure = document.createElement('canvas').getContext('2d')! as TextMeasurer;
let editor: Editor | null = null;
let handle: FileSystemFileHandle | null = null;
let filename = '', diskSource = '', zoom = 1, busy = false;
let toastTimer: ReturnType<typeof setTimeout>;
let drag: { pointer: number; startX: number; startY: number; lastX: number; lastY: number; fine: boolean; active: boolean; chord: boolean } | null = null;
let persistTimer: ReturnType<typeof setTimeout>;
let recovered = false;
const unsaved = () => !!editor && (editor.doc.dirty || recovered);

function toast(message: string): void {
  document.querySelector('.toast')!.textContent = message;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { document.querySelector('.toast')!.textContent = ''; }, 6000);
}
function toggleMenu(open = menu.hidden): void {
  menu.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    for (const button of menu.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
      const name = button.dataset.action!;
      button.disabled = ['save', 'save-as', 'export-pdf', 'zoom-in', 'zoom-out', 'undo', 'redo'].includes(name) && !editor;
      if (name === 'undo') button.disabled = !editor?.canUndo;
      if (name === 'redo') button.disabled = !editor?.canRedo;
    }
  }
}
trigger.addEventListener('click', () => toggleMenu());
document.addEventListener('pointerdown', event => { if (!(event.target as Element).closest('.menu,.menu-trigger')) toggleMenu(false); });

function question(title: string, text: string, choices: { id: string; label: string; style?: string }[]): Promise<string> {
  dialog.className = '';
  dialog.innerHTML = `<h2 id="dialog-title">${escapeXml(title)}</h2><p>${escapeXml(text)}</p><div class="dialog-actions">${choices.map(c => `<button value="${c.id}" class="${c.style || ''}">${escapeXml(c.label)}</button>`).join('')}</div>`;
  return new Promise(resolve => {
    let done = false;
    const finish = (value: string) => { if (done) return; done = true; dialog.close(); dialog.removeEventListener('cancel', cancel); resolve(value); };
    const cancel = (e: Event) => { e.preventDefault(); finish('cancel'); };
    dialog.addEventListener('cancel', cancel);
    dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.onclick = () => finish(button.value));
    dialog.showModal();
  });
}
async function discard(): Promise<boolean> {
  if (!unsaved()) return true;
  const answer = await question('Replace this score?', 'Opening another file will overwrite your unsaved changes. Save your chords first, or discard them to continue.', [
    { id: 'cancel', label: 'Cancel' }, { id: 'discard', label: 'Discard changes', style: 'danger' }, { id: 'save', label: 'Save first', style: 'primary' },
  ]);
  return answer === 'discard' || (answer === 'save' && await save());
}

// Treat generated SVG as untrusted: GABC lyric markup must not execute scripts
// or cause remote requests. Exsurge only needs text, paths, and local glyph uses.
function safeSvg(source: string): string {
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (xml.querySelector('parsererror')) throw new Error('Exsurge produced invalid SVG.');
  const allowed = new Set(['svg', 'g', 'defs', 'path', 'line', 'rect', 'circle', 'ellipse', 'text', 'tspan', 'use', 'style', 'title', 'desc', 'clipPath']);
  for (const element of [...xml.querySelectorAll('*')]) {
    if (!allowed.has(element.localName)) { element.remove(); continue; }
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name) || ((attr.localName === 'href') && !attr.value.startsWith('#')) || /(?:javascript:|https?:|@import|url\(\s*[^#])/i.test(attr.value)) element.removeAttribute(attr.name);
    }
    if (element.localName === 'style' && /(?:@import|https?:|url\(\s*[^#])/i.test(element.textContent || '')) element.remove();
  }
  return new XMLSerializer().serializeToString(xml.documentElement);
}

async function load(source: string, name: string, fileHandle: FileSystemFileHandle | null, checkDiscard = true): Promise<boolean> {
  if (busy || (checkDiscard && !await discard())) return false;
  if (!name.toLowerCase().endsWith('.gabc')) { toast('Please open a .gabc chant file.'); return false; }
  if (source.length > 4 * 1024 * 1024) { toast('GABC files must be smaller than 4 MiB.'); return false; }
  busy = true;
  try {
    await fontsReady;
    const doc = new ScoreDocument(source);
    const preview = renderScore(doc, window.exsurge, measure);
    // Validate every SVG before replacing the current editor.
    preview.staves.forEach(staff => { staff.svg = safeSvg(staff.svg); });
    editor = new Editor(doc, preview, measure);
    filename = name; handle = fileHandle; diskSource = source; recovered = false;
    buildPaper();
    setZoom(Math.min(1.6, (workspace.clientWidth - (innerWidth < 650 ? 24 : 80)) / PAPER_WIDTH));
    workspace.scrollTop = 0; workspace.focus(); refresh();
    return true;
  } catch (error) { toast(`Could not open score: ${errorMessage(error)}`); return false; }
  finally { busy = false; }
}

async function openScore(): Promise<void> {
  if (busy || !await discard()) return;
  if (!window.showOpenFilePicker) { toast('Open and save require desktop Chromium on HTTPS or localhost.'); return; }
  try {
    const [picked] = await window.showOpenFilePicker({ types: [{ description: 'Gregorian chant', accept: { 'text/plain': ['.gabc'] } }], multiple: false });
    const file = await picked.getFile();
    await load(await file.text(), file.name, picked, false);
  } catch (error) { if (!isAbort(error)) toast(errorMessage(error)); }
}

async function save(saveAs = false): Promise<boolean> {
  if (busy || !editor) return false;
  const current = editor;
  current.finish();
  let target = handle;
  try {
    const source = current.doc.serialize(); // Validate before asking for file access.
    if (!window.showSaveFilePicker) throw new Error('Saving requires desktop Chromium on HTTPS or localhost.');
    if (!target || saveAs) target = await window.showSaveFilePicker({ suggestedName: filename || 'chant.gabc', types: [{ description: 'Gregorian chant', accept: { 'text/plain': ['.gabc'] } }] });
    else {
      const onDisk = await (await target.getFile()).text();
      if (onDisk !== diskSource) {
        const answer = await question('The file changed on disk', 'Another program may have edited this score. Reload it to keep those edits, or save your work to a different file.', [
          { id: 'cancel', label: 'Cancel' }, { id: 'reload', label: 'Reload' }, { id: 'copy', label: 'Save a copy', style: 'primary' },
        ]);
        if (answer === 'reload') { await load(onDisk, filename, handle, false); return false; }
        if (answer === 'copy') return save(true);
        return false;
      }
    }
    // Editing is locked while the write is in progress. createWritable commits
    // its temporary file on close; a failed write never marks the editor saved.
    busy = true;
    const writable = await target.createWritable();
    try { await writable.write(source); await writable.close(); } catch (error) { await writable.abort().catch(() => {}); throw error; }
    current.doc = new ScoreDocument(source);
    handle = target; filename = target.name; diskSource = source; recovered = false;
    refresh();
    try { localStorage.removeItem('neumes-draft'); } catch {}
    return true;
  } catch (error) { if (!isAbort(error)) toast(`Could not save: ${errorMessage(error)}`); return false; }
  finally { busy = false; workspace.focus(); }
}

function buildPaper(): void {
  if (!editor) return;
  const h = editor.doc.headers;
  workspace.innerHTML = `<div class="paper-slot"><article class="paper" aria-label="${escapeXml(editor.doc.name)}">
    <header class="sheet-header">${h['sheet-heading'] ? `<p class="sheet-heading">${escapeXml(h['sheet-heading'])}</p>` : ''}<h1 class="sheet-title">${escapeXml(h['sheet-title'] || h.name || 'Untitled chant')}</h1>${h['sheet-subtitle'] ? `<p class="sheet-subtitle">${escapeXml(h['sheet-subtitle'])}</p>` : ''}</header>
    ${editor.preview.staves.map((staff, index) => `<div class="staff" data-staff="${index}"><div class="engraving">${staff.svg}</div><svg class="overlay" xmlns="http://www.w3.org/2000/svg" aria-label="Staff ${index + 1} chord editor"></svg></div>`).join('')}
    </article></div>`;
}

function refresh(): void {
  if (!editor) return;
  const ed = editor;
  document.title = `${unsaved() ? '• ' : ''}${filename} — Neumes`;
  document.querySelector('.file-label')!.innerHTML = `${unsaved() ? '<span class="dirty">●</span> ' : ''}${escapeXml(filename)}`;
  for (const staffEl of workspace.querySelectorAll<HTMLElement>('.staff')) {
    const index = Number(staffEl.dataset.staff);
    const spec = ed.preview.staves[index];
    const placed = ed.placed.filter(p => p.staff === index);
    const pad = Math.max(0, 8 - Math.min(8, ...placed.map(p => p.top)));
    const height = spec.height + pad;
    staffEl.style.height = `${height}px`;
    staffEl.dataset.pad = String(pad);
    staffEl.querySelector<HTMLElement>('.engraving')!.style.top = `${pad}px`;
    const overlay = staffEl.querySelector<SVGSVGElement>('.overlay')!;
    overlay.setAttribute('width', String(SCORE_WIDTH)); overlay.setAttribute('height', String(height)); overlay.setAttribute('viewBox', `0 0 ${SCORE_WIDTH} ${height}`);
    const positions = ed.preview.positions.filter(p => p.staff === index);
    const cursor = ed.position;
    overlay.innerHTML = `<g transform="translate(0,${pad})">
      ${positions.map(p => `<circle class="note-target" data-note="${p.note}" cx="${p.x + 3}" cy="${p.noteY}" r="7"><title>${escapeXml(`${p.note}: ${ed.doc.note(p.note).pitch}`)}</title></circle>`).join('')}
      ${placed.map(p => `${ed.selected === p.note ? `<rect class="selected" x="${p.x - 3}" y="${p.top - 3}" width="${p.width + 6}" height="${p.bottom - p.top + 6}" rx="3"/>` : ''}<text data-chord="${p.note}" x="${p.x}" y="${p.baseline}">${escapeXml(ed.doc.chords.find(c => c.note === p.note)!.text)}</text>`).join('')}
      ${cursor.staff === index ? `<rect class="cursor" x="${cursor.x - 2}" y="${cursor.noteY - 6}" width="11" height="12" rx="2"/>${ed.selected ? '' : `<path class="cursor" d="M${cursor.x} ${cursor.y - 12}V${cursor.y + 3}"/>`}` : ''}</g>`;
  }
  updateZoom();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { if (editor && unsaved()) localStorage.setItem('neumes-draft', JSON.stringify({ name: filename, source: editor.doc.serialize() })); else localStorage.removeItem('neumes-draft'); } catch {}
  }, 300);
}
function updateZoom(): void {
  const paper = workspace.querySelector<HTMLElement>('.paper');
  const slot = workspace.querySelector<HTMLElement>('.paper-slot');
  if (paper && slot) { paper.style.transform = `scale(${zoom})`; slot.style.width = `${PAPER_WIDTH * zoom}px`; slot.style.height = `${paper.offsetHeight * zoom}px`; }
}
function setZoom(value: number): void { zoom = Math.max(.3, Math.min(5, value)); refresh(); }
function reveal(): void {
  const staff = workspace.querySelector<HTMLElement>(`.staff[data-staff="${editor?.position.staff}"]`);
  if (!staff) return;
  const rect = staff.getBoundingClientRect();
  if (rect.top < 80 || rect.bottom > innerHeight - 60) staff.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function help(): void {
  const modifier = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const row = (label: string, ...alternatives: string[][]) => `<tr><th scope="row">${escapeXml(label)}</th><td>${alternatives.map(keys => `<span class="key-combination">${keys.map(key => `<kbd>${escapeXml(key === 'Ctrl' ? modifier : key)}</kbd>`).join('')}</span>`).join('<span class="key-alternative">or</span>')}</td></tr>`;
  dialog.className = 'shortcuts-dialog';
  dialog.innerHTML = `<header class="shortcuts-header"><h2 id="dialog-title">Keyboard shortcuts</h2><button class="shortcuts-close" aria-label="Close keyboard shortcuts"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <div class="shortcuts-grid">
      <section aria-labelledby="chord-shortcuts"><h3 id="chord-shortcuts">Chords</h3><div class="shortcuts-table"><table><tbody>
        ${row('Add or replace a chord', ['Click', 'Type'])}
        ${row('Edit existing text', ['F2'], ['Double-click'])}
        ${row('Finish typing', ['Enter'], ['Esc'])}
        ${row('Next note', ['Tab'])}
        ${row('Previous note', ['Shift', 'Tab'])}
        ${row('Move to adjacent note', ['←', '→'])}
        ${row('Move to adjacent staff', ['↑', '↓'])}
        ${row('Nudge position (0.5)', ['Ctrl', 'Arrow key'])}
        ${row('Nudge position (5)', ['Ctrl', 'Shift', 'Arrow key'])}
        ${row('Snap to another note', ['Drag'])}
        ${row('Move text freely', ['Ctrl', 'Drag'])}
        ${row('Reset manual offsets', ['Ctrl', 'R'])}
        ${row('Erase text / delete chord', ['Backspace'])}
        ${row('Delete chord', ['Delete'])}
      </tbody></table></div></section>
      <section aria-labelledby="editor-shortcuts"><h3 id="editor-shortcuts">Editor</h3><div class="shortcuts-table"><table><tbody>
        ${row('Open file', ['Ctrl', 'O'])}
        ${row('Save file', ['Ctrl', 'S'])}
        ${row('Save as', ['Ctrl', 'Shift', 'S'])}
        ${row('Undo', ['Ctrl', 'Z'])}
        ${row('Redo', ['Ctrl', 'Shift', 'Z'], ['Ctrl', 'Y'])}
        ${row('First note', ['Home'])}
        ${row('Last note', ['End'])}
        ${row('Scroll up', ['Page Up'])}
        ${row('Scroll down', ['Page Down'])}
        ${row('Zoom in', ['Ctrl', '+'])}
        ${row('Zoom out', ['Ctrl', '−'])}
        ${row('Keyboard shortcuts', ['F1'])}
      </tbody></table></div></section>
    </div>`;
  dialog.querySelector('button')!.onclick = () => { dialog.close(); workspace.focus(); };
  dialog.showModal();
}
async function exportPdf(): Promise<void> {
  if (!editor) return;
  editor.finish(); refresh();
  await fontsReady;
  const title = document.title;
  document.title = filename.replace(/\.gabc$/i, '');
  try { window.print(); } finally { document.title = title; }
}
async function action(name: string): Promise<void> {
  toggleMenu(false);
  if (busy) return;
  if (name === 'open') await openScore();
  else if (name === 'save' || name === 'save-as') await save(name === 'save-as');
  else if (name === 'export-pdf') await exportPdf();
  else if (name === 'shortcuts') help();
  else if (name === 'zoom-in') setZoom(zoom * 1.15);
  else if (name === 'zoom-out') setZoom(zoom / 1.15);
  else if (name === 'undo') { editor?.undo(); refresh(); }
  else if (name === 'redo') { editor?.redo(); refresh(); }
  workspace.focus();
}
menu.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
  if (button) void action(button.dataset.action!);
});
document.querySelector('.empty-open')!.addEventListener('click', () => void action('open'));

document.addEventListener('keydown', event => {
  if (dialog.open || busy || (event.target as Element).matches('input,textarea,[contenteditable=true]')) return;
  const ctrl = event.ctrlKey || event.metaKey, shift = event.shiftKey, alt = event.altKey;
  const key = event.key, lower = key.toLowerCase();
  if (key === 'Escape' && !menu.hidden) { toggleMenu(false); workspace.focus(); event.preventDefault(); return; }
  if (ctrl && ['o', 's', '+', '=', '-'].includes(lower)) {
    event.preventDefault();
    const names: Record<string, string> = { o: 'open', s: shift ? 'save-as' : 'save', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out' };
    void action(names[lower]); return;
  }
  if (key === 'F1') { event.preventDefault(); help(); return; }
  if (!editor || !menu.hidden) return;
  let handled = true;
  if (ctrl && lower === 'z') shift ? editor.redo() : editor.undo();
  else if (ctrl && lower === 'y') editor.redo();
  else if (ctrl && lower === 'r') editor.resetOffsets();
  else if (key.startsWith('Arrow') && !alt) {
    const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    if (ctrl) { const step = direction * (shift ? 5 : .5); editor.nudge(horizontal ? step : 0, horizontal ? 0 : -step); }
    else if (horizontal) editor.moveTo(editor.cursor + direction);
    else editor.moveStaff(direction);
  } else if (key === 'Tab' && !ctrl && !alt) editor.tab(shift ? -1 : 1);
  else if (key === 'F2') editor.startEdit();
  else if (key === 'Enter' || key === 'Escape') { if (key === 'Escape' && !editor.editing) editor.selected = null; editor.finish(); }
  else if (key === 'Backspace' && !ctrl) editor.backspace();
  else if (key === 'Delete' && !ctrl) editor.delete();
  else if (key === 'Home') editor.select(0);
  else if (key === 'End') editor.select(editor.doc.notes.length - 1);
  else if (!alt && (key === 'PageUp' || key === 'PageDown')) workspace.scrollBy(0, workspace.clientHeight * .85 * (key === 'PageUp' ? -1 : 1));
  else if (!ctrl && !alt && key.length === 1) editor.type(key);
  else handled = false;
  if (handled) { event.preventDefault(); refresh(); if (key === 'Tab' || key.startsWith('Arrow') || key === 'Home' || key === 'End') reveal(); }
});

function pointerPosition(event: PointerEvent): { staff: number; x: number; y: number } | null {
  for (const el of workspace.querySelectorAll<HTMLElement>('.staff')) {
    const rect = el.getBoundingClientRect();
    if (event.clientY >= rect.top && event.clientY <= rect.bottom) return { staff: Number(el.dataset.staff), x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom - Number(el.dataset.pad) };
  }
  return null;
}
workspace.addEventListener('pointerdown', event => {
  if (!editor || busy || event.button !== 0) return;
  const pos = pointerPosition(event); if (!pos) return;
  const hit = editor.hit(pos.staff, pos.x, pos.y);
  const note = (event.target as Element).closest<SVGElement>('[data-note]')?.dataset.note;
  if (note && !hit) editor.select(editor.doc.note(note).index); else editor.click(pos.staff, pos.x, pos.y);
  workspace.focus();
  drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, fine: event.ctrlKey || event.metaKey, active: false, chord: !!hit };
  workspace.setPointerCapture(event.pointerId); refresh();
});
workspace.addEventListener('pointermove', event => {
  if (!editor || !drag || !drag.chord || event.pointerId !== drag.pointer || busy) return;
  if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) { editor.beginDrag(); drag.active = true; }
  if (!drag.active) return;
  if (drag.fine) editor.nudge((event.clientX - drag.lastX) / zoom, (drag.lastY - event.clientY) / zoom, false);
  else { const pos = pointerPosition(event); if (pos) { const next = editor.closest(pos.staff, pos.x); if (next !== undefined) editor.moveTo(next, false); } }
  drag.lastX = event.clientX; drag.lastY = event.clientY; refresh();
});
workspace.addEventListener('pointerup', () => { drag = null; });
workspace.addEventListener('pointercancel', () => { drag = null; });
workspace.addEventListener('dblclick', event => {
  if (!editor || busy) return;
  const pos = pointerPosition(event as PointerEvent); if (!pos) return;
  editor.click(pos.staff, pos.x, pos.y); editor.startEdit(); refresh();
});
workspace.addEventListener('wheel', event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom(zoom * Math.exp(-event.deltaY * .005)); } }, { passive: false });

const dropCover = document.querySelector<HTMLElement>('.drop-cover')!;
let dragDepth = 0;
document.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; dropCover.hidden = false; } });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('dragleave', event => { if (event.dataTransfer?.types.includes('Files')) { dragDepth--; if (dragDepth <= 0) dropCover.hidden = true; } });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; dropCover.hidden = true;
  // Request the handle synchronously, while the drop's DataTransfer is valid.
  const item = event.dataTransfer?.items[0];
  const file = event.dataTransfer?.files[0];
  const handlePromise = item?.getAsFileSystemHandle?.();
  if (!file) return;
  void (async () => {
    try {
      const picked = await handlePromise?.catch(() => null);
      await load(await file.text(), file.name, picked?.kind === 'file' ? picked as FileSystemFileHandle : null);
    } catch (error) { toast(errorMessage(error)); }
  })();
});
window.addEventListener('beforeunload', event => { if (unsaved()) { event.preventDefault(); event.returnValue = ''; } });
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const fontsReady = Promise.all([
  document.fonts.load('21px "EB Garamond"'), document.fonts.load('bold 15px "EB Garamond"'), document.fonts.load('italic 42px "EB Garamond"'),
]).then(() => document.fonts.ready);

async function restoreDraft(): Promise<void> {
  try {
    const raw = localStorage.getItem('neumes-draft');
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (typeof draft.source !== 'string' || typeof draft.name !== 'string') return;
    const answer = await question('Recover unsaved chords?', 'A local draft from your previous session is available. Recover it, then use Save as to write it to a file.', [{ id: 'discard', label: 'Discard draft' }, { id: 'restore', label: 'Recover', style: 'primary' }]);
    if (answer === 'restore') {
      if (await load(draft.source, draft.name, null, false)) {
        // Recovered contents have not yet been written to a file. Preserve the
        // draft until a successful save, and warn on replacement/closing.
        diskSource = '';
        recovered = true;
        refresh();
      }
    } else if (answer === 'discard') localStorage.removeItem('neumes-draft');
  } catch {}
}
// A recovered draft is a document with no granted file handle; treat it as
// unsaved even though its serialized annotations are internally unchanged.
void restoreDraft();
