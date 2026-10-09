import { bodyStart, ScoreDocument } from './document.ts';

// Exsurge is a vendored, legacy JS API. Keep that boundary confined here.
export type Exsurge = Record<string, any>;
export interface TextMeasurer {
  font: string;
  measureText(text: string): { width: number; actualBoundingBoxLeft: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number };
}
export interface Position {
  note: string;
  index: number;
  group: string;
  staff: number;
  x: number;
  y: number;
  noteY: number;
  glyphX: number;
}
export interface Staff { svg: string; width: number; height: number }
export interface Preview { staves: Staff[]; positions: Position[]; width: number }
export const SCORE_WIDTH = 860;
export const FONT = '"EB Garamond", serif';
export const CHORD_FONT = `bold 15px ${FONT}`;

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
}

/** Hide Gregorio-only controls without adding spaces to the lyrics. Translate
 * Exsurge's shortened UTF-16 offsets back to the untouched musical source.
 */
export function prepareRendererSource(body: string): { source: string; originalOffset: (index: number) => number } {
  const removed: { offset: number; length: number }[] = [];
  let skipped = 0;
  // Do not interpret control-like text inside annotations or verbatim blocks.
  const source = body.replace(/(\[[^\]]*\]|<v>[\s\S]*?<\/v>)|<clear\s*\/?>/g, (text: string, literal: string | undefined, offset: number) => {
    if (literal !== undefined) return text;
    removed.push({ offset: offset - skipped, length: text.length });
    skipped += text.length;
    return '';
  });
  return {
    source,
    originalOffset(index) {
      let original = index;
      for (const removal of removed) {
        if (removal.offset > index) break;
        original += removal.length;
      }
      return original;
    },
  };
}

export function renderScore(doc: ScoreDocument, e: Exsurge, measure: TextMeasurer, width = SCORE_WIDTH): Preview {
  if (!Number.isFinite(width) || width < 200 || width > 4000) throw new Error('Score width must be between 200 and 4000.');
  const ctxt = new e.ChantContext();
  ctxt.textMeasuringStrategy = e.TextMeasuringStrategy.Canvas;
  ctxt.canvasCtxt = measure;
  ctxt.setGlyphScaling(0.078125);
  ctxt.setFont(FONT, 21);
  ctxt.textStyles.lyric.size = 21;
  ctxt.textStyles.dropCap.size = 78;
  ctxt.textStyles.annotation.size = 16;
  ctxt.textStyles.annotation.prefix = '<b>';
  ctxt.activeClef = e.Clef.default();
  const { source, originalOffset } = prepareRendererSource(doc.previewBody());
  const mappings = [], translations: unknown[] = [];
  let offset = 0;
  // The convenience parser drops leading whitespace without correcting offsets.
  for (const raw of e.Gabc.splitWords(source)) {
    const word = raw.trim();
    if (word) mappings.push(e.Gabc.createMappingFromWord(ctxt, word, offset + raw.length - raw.trimStart().length, translations));
    offset += raw.length + 1;
  }
  const last = mappings.at(-1);
  if (last?.notations.length) last.notations.at(-1).trailingSpace = 0;
  const score = new e.ChantScore(ctxt, mappings, doc.headers['initial-style'] !== '0');
  const office = doc.headers['office-part'] || '';
  const offices: Record<string, string> = { Introit: 'Intr.', Gradual: 'Grad.', Graduale: 'Grad.', Alleluia: 'All.', Tract: 'Tract.', Sequence: 'Seq.', Offertory: 'Offert.', Communion: 'Comm.', Hymn: 'Hymn.' };
  const annotations = [offices[office] || office, doc.headers.mode ? `${doc.headers.mode}.` : ''].filter(Boolean);
  if (annotations.length) score.annotation = new e.Annotations(ctxt, ...annotations.map(escapeXml));
  score.performLayout(ctxt);
  score.layoutChantLines(ctxt, width - 40);
  const defs = Object.values(ctxt.defs).join('') + ctxt.createStyle();
  const body = bodyStart(doc.music);
  const wanted = new Map(doc.notes.map(n => [n.offset - body, n]));
  // Initio debilis includes '-' in Exsurge's sourceIndex.
  for (const n of doc.notes) if (doc.music[n.offset - 1] === '-') wanted.set(n.offset - body - 1, n);
  const staves: Staff[] = [], positions: Position[] = [], found = new Set<string>();
  for (const line of score.lines) {
    const staff = staves.length;
    const chordY = Math.min(-ctxt.staffInterval * 3 - 27, line.notationBounds.y - 20);
    const contentTop = Math.min(line.notationBounds.y, chordY - 18) - 8;
    const top = line.bounds.y + contentTop;
    const baseline = -contentTop;
    const height = line.notationBounds.y + line.notationBounds.height + 14 - contentTop;
    const svg = `<svg class="Exsurge" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs}</defs><g transform="translate(20,0)">${line.createSvgFragment(ctxt, top)}</g></svg>`;
    staves.push({ svg, width, height });
    for (let i = line.notationsStartIndex; i < line.notationsStartIndex + line.numNotationsOnLine; i++) {
      const notation = score.notations[i];
      for (const note of notation.notes || []) {
        const target = wanted.get(originalOffset(note.sourceIndex));
        if (!target || found.has(target.id)) continue;
        found.add(target.id);
        const shorthand = /^[a-mA-M][sv]{2}/.test(target.gabc);
        const hookX = shorthand ? notation.notes.at(-1).bounds.x : 0;
        positions.push({ note: target.id, index: target.index, group: target.group, staff,
          x: 20 + notation.bounds.x + note.bounds.x,
          glyphX: 20 + notation.bounds.x + hookX,
          y: baseline + chordY, noteY: baseline + note.bounds.y + note.bounds.height / 2 });
      }
    }
  }
  const missing = doc.notes.filter(n => !found.has(n.id));
  if (missing.length) throw new Error(`Exsurge cannot map these individual notes: ${missing.map(n => n.id).join(', ')}. This notation is not yet supported.`);
  positions.sort((a, b) => a.index - b.index);
  return { staves, positions, width };
}

export interface PlacedChord {
  note: string;
  staff: number;
  x: number;
  baseline: number;
  width: number;
  top: number;
  bottom: number;
}

/** Pack chords within each neume horizontally; stagger collisions between groups.
 * Only chord overlays move. Exsurge's chant geometry is never changed by edits.
 */
export function layoutChords(doc: ScoreDocument, preview: Preview, measure: TextMeasurer, recalculate = true, packGroups = true): PlacedChord[] {
  measure.font = CHORD_FONT;
  const placed: PlacedChord[] = [];
  const previousByGroup = new Map<string, PlacedChord>();
  const positions = new Map(preview.positions.map(p => [p.note, p]));
  const chords = [...doc.chords].filter(c => c.text).sort((a, b) => doc.note(a.note).index - doc.note(b.note).index);
  for (const chord of chords) {
    const pos = positions.get(chord.note);
    if (!pos) throw new Error(`No rendered position for ${chord.note}.`);
    const metrics = measure.measureText(chord.text);
    const width = Math.max(metrics.width, 2);
    const ascent = Math.max(metrics.actualBoundingBoxAscent || 11, 8);
    const descent = Math.max(metrics.actualBoundingBoxDescent || 2, 2);
    // Keep a human's manually positioned chords free from automatic repacking.
    if (recalculate) {
      if (packGroups) {
        const previous = previousByGroup.get(`${pos.staff}:${pos.group}`);
        const packedX = previous ? Math.max(pos.x, previous.x + previous.width + 5) : pos.x;
        chord.autoX = Math.round((packedX - pos.glyphX) * 1e6) / 1e6;
      }
      chord.autoRaise = 0;
    }
    let x = pos.glyphX + chord.autoX + chord.dx;
    if (recalculate) {
      const baseline = () => pos.y - chord.dy - chord.autoRaise;
      while (placed.some(p => p.staff === pos.staff && x < p.x + p.width + 3 && x + width + 3 > p.x && baseline() - ascent < p.bottom + 3 && baseline() + descent + 3 > p.top)) chord.autoRaise += 18;
    }
    const baseline = pos.y - chord.dy - chord.autoRaise;
    const item = { note: chord.note, staff: pos.staff, x, baseline, width, top: baseline - ascent, bottom: baseline + descent };
    placed.push(item); previousByGroup.set(`${pos.staff}:${pos.group}`, item);
  }
  return placed;
}

export function scoreSvg(doc: ScoreDocument, preview: Preview, placed: PlacedChord[]): string {
  const width = preview.width;
  const heading = doc.headers['sheet-heading'] || '';
  const title = doc.headers['sheet-title'] || doc.headers.name || 'Untitled chant';
  const subtitle = doc.headers['sheet-subtitle'] || '';
  let y = 42;
  const parts = [`<text x="${width / 2}" y="${y}" text-anchor="middle" font-size="19" font-weight="600">${escapeXml(heading)}</text>`];
  y += heading ? 38 : 12;
  parts.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-size="34" font-style="italic" font-weight="600">${escapeXml(title)}</text>`);
  y += 30;
  if (subtitle) { parts.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-size="18" font-style="italic">${escapeXml(subtitle)}</text>`); y += 25; }
  for (let staff = 0; staff < preview.staves.length; staff++) {
    const spec = preview.staves[staff];
    const chords = placed.filter(p => p.staff === staff);
    const pad = Math.max(0, 8 - Math.min(8, ...chords.map(p => p.top)));
    const inner = spec.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    parts.push(`<g transform="translate(0,${y + pad})">${inner}${chords.map(p => `<text x="${p.x}" y="${p.baseline}" font-size="15" font-weight="bold">${escapeXml(doc.chords.find(c => c.note === p.note)!.text)}</text>`).join('')}</g>`);
    y += spec.height + pad + 20;
  }
  return `<svg class="Exsurge" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${y + 24}" viewBox="0 0 ${width} ${y + 24}"><rect width="100%" height="100%" fill="white"/><g font-family="'EB Garamond', serif" fill="#171713">${parts.join('')}</g></svg>`;
}
