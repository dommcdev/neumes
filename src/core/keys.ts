import type { Editor } from './editor.ts';

/** A key press as the browser names it (`KeyboardEvent.key`). */
export interface KeyInput { key: string; ctrl: boolean; shift: boolean; alt: boolean }

/** Chord-editing keys shared by the browser and desktop shells.
 * Returns whether the editor used the key.
 */
export function editorKey(editor: Editor, { key, ctrl, shift, alt }: KeyInput): boolean {
  const lower = key.toLowerCase();
  if (ctrl && lower === 'z') shift ? editor.redo() : editor.undo();
  else if (ctrl && lower === 'y') editor.redo();
  else if (ctrl && lower === 'r') editor.resetOffsets();
  else if (key.startsWith('Arrow') && !alt) {
    const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    if (shift) { const step = direction * (ctrl ? 5 : .5); editor.nudge(horizontal ? step : 0, horizontal ? 0 : -step); }
    else if (!ctrl) editor.tab(direction);
    else if (horizontal) editor.moveTo(editor.cursor + direction);
    else editor.moveStaff(direction);
  } else if (key === 'Tab' && !ctrl && !alt) editor.tab(shift ? -1 : 1);
  else if (key === 'F2') editor.startEdit();
  else if (key === 'Enter' || key === 'Escape') { if (key === 'Escape' && !editor.editing) editor.selected = null; editor.finish(); }
  else if (key === 'Backspace' && !ctrl) editor.backspace();
  else if (key === 'Delete' && !ctrl) editor.delete();
  else if (key === 'Home') editor.select(0);
  else if (key === 'End') editor.select(editor.doc.notes.length - 1);
  else if (!ctrl && !alt && key.length === 1) editor.type(key);
  else return false;
  return true;
}

/** Keys that move the cursor, so the shell should scroll it into view. */
export function movesCursor(key: string): boolean {
  return key === 'Tab' || key.startsWith('Arrow') || key === 'Home' || key === 'End';
}
