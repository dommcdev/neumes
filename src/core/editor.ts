import { type Chord, ScoreDocument } from './document.ts';
import { layoutChords, type PlacedChord, type Preview, type TextMeasurer } from './render.ts';

interface Snapshot { chords: Chord[]; cursor: number; selected: string | null }
export class Editor {
  cursor = 0;
  selected: string | null = null;
  editing = false;
  placed: PlacedChord[] = [];
  private pending = '';
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  constructor(public doc: ScoreDocument, public preview: Preview, private measure: TextMeasurer) {
    this.layout(true);
  }
  private snapshot(): Snapshot { return { chords: structuredClone(this.doc.chords), cursor: this.cursor, selected: this.selected }; }
  private record(): void { this.undoStack.push(this.snapshot()); if (this.undoStack.length > 500) this.undoStack.shift(); this.redoStack = []; }
  private restore(s: Snapshot): void { this.doc.chords = s.chords; this.cursor = s.cursor; this.selected = s.selected; this.finish(); this.layout(false); }
  undo(): void { const s = this.undoStack.pop(); if (s) { this.redoStack.push(this.snapshot()); this.restore(s); } }
  redo(): void { const s = this.redoStack.pop(); if (s) { this.undoStack.push(this.snapshot()); this.restore(s); } }
  layout(recalculate = true): void { this.placed = layoutChords(this.doc, this.preview, this.measure, recalculate); }
  get position() { return this.preview.positions[this.cursor]; }
  select(index: number): void {
    this.finish(); this.cursor = Math.max(0, Math.min(index, this.doc.notes.length - 1));
    const id = this.doc.notes[this.cursor].id;
    this.selected = this.doc.chords.some(c => c.note === id) ? id : null;
  }
  finish(): void { this.editing = false; this.pending = ''; }
  startEdit(): void { const c = this.doc.chords.find(c => c.note === this.selected); if (c) { this.record(); this.pending = c.text; this.editing = true; } }
  type(text: string): void {
    if (!this.editing) {
      this.record();
      if (!this.selected) { this.selected = this.doc.notes[this.cursor].id; this.doc.chords.push({ note: this.selected, text: '', dx: 0, dy: 0, autoX: 0, autoRaise: 0 }); }
      this.pending = ''; this.editing = true;
    }
    this.pending += text.replaceAll('#', '♯').replaceAll('b', '♭');
    this.doc.chords.find(c => c.note === this.selected)!.text = this.pending;
    this.layout();
  }
  backspace(): void {
    if (!this.editing) { this.delete(); return; }
    this.pending = [...this.pending].slice(0, -1).join('');
    this.doc.chords.find(c => c.note === this.selected)!.text = this.pending;
    if (!this.pending) { this.doc.chords = this.doc.chords.filter(c => c.note !== this.selected); this.selected = null; this.finish(); }
    this.layout();
  }
  delete(): void { if (this.selected) { this.record(); this.doc.removeChord(this.selected); this.selected = null; this.finish(); this.layout(); } }
  tab(direction: number): void { this.select(this.cursor + direction); }
  moveTo(index: number, record = true): void {
    index = Math.max(0, Math.min(index, this.doc.notes.length - 1)); this.finish();
    if (!this.selected) { this.select(index); return; }
    const id = this.doc.notes[index].id;
    if (index === this.cursor || this.doc.chords.some(c => c.note === id && c.note !== this.selected)) return;
    if (record) this.record();
    this.doc.chords.find(c => c.note === this.selected)!.note = id;
    this.selected = id; this.cursor = index; this.layout();
  }
  moveStaff(direction: number): void {
    const pos = this.position;
    const next = this.preview.positions.filter(p => p.staff === pos.staff + direction).sort((a, b) => Math.abs(a.x - pos.x) - Math.abs(b.x - pos.x))[0];
    if (next) this.moveTo(next.index);
  }
  nudge(dx: number, dy: number, record = true): void {
    this.finish(); const c = this.doc.chords.find(c => c.note === this.selected);
    if (c) {
      if (record) this.record();
      c.dx = Math.round((c.dx + dx) * 1e6) / 1e6;
      c.dy = Math.round((c.dy + dy) * 1e6) / 1e6;
      this.placed = layoutChords(this.doc, this.preview, this.measure, true, false);
    }
  }
  resetOffsets(): void {
    const c = this.doc.chords.find(c => c.note === this.selected);
    if (c) { this.record(); c.dx = c.dy = 0; this.layout(); }
  }
  beginDrag(): void { if (this.selected) this.record(); }
  hit(staff: number, x: number, y: number): string | null {
    return [...this.placed].reverse().find(p => p.staff === staff && x >= p.x - 4 && x <= p.x + p.width + 4 && y >= p.top - 4 && y <= p.bottom + 4)?.note ?? null;
  }
  closest(staff: number, x: number, y?: number): number | undefined {
    return this.preview.positions.filter(p => p.staff === staff).sort((a, b) =>
      Math.abs(a.x - x) + (y === undefined ? 0 : Math.abs(a.noteY - y) * .3) - Math.abs(b.x - x) - (y === undefined ? 0 : Math.abs(b.noteY - y) * .3))[0]?.index;
  }
  click(staff: number, x: number, y: number): void {
    const hit = this.hit(staff, x, y);
    if (hit) this.select(this.doc.note(hit).index);
    else { const next = this.closest(staff, x, y); if (next !== undefined) this.select(next); }
  }
}
