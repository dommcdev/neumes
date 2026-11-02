import { bodyStart, ScoreDocument } from './document.ts';
import { ENGRAVING, FONT, INITIAL_FONT, CHORD_FONT } from './engraving.ts';
export { FONT, CHORD_FONT } from './engraving.ts';

// Exsurge is a vendored, legacy JS API. Keep that boundary confined here.
export type Exsurge = Record<string, any>;
export interface TextMeasurer {
  font: string;
  textRendering?: 'auto' | 'optimizeSpeed' | 'optimizeLegibility' | 'geometricPrecision';
  measureText(text: string): { width: number; actualBoundingBoxLeft: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number };
}
export interface Position {
  note: string;
  index: number;
  group: string;
  staff: number;
  x: number;
  noteWidth: number;
  y: number;
  noteY: number;
  glyphX: number;
}
export interface Staff { svg: string; width: number; height: number; advance: number }
export interface Preview { staves: Staff[]; positions: Position[]; width: number }
export const SCORE_WIDTH = ENGRAVING.scoreWidth;

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

export function renderScore(doc: ScoreDocument, e: Exsurge, measure: TextMeasurer, width: number = SCORE_WIDTH): Preview {
  if (!Number.isFinite(width) || width < 200 || width > 4000) throw new Error('Score width must be between 200 and 4000.');
  const ctxt = new e.ChantContext();
  ctxt.textMeasuringStrategy = e.TextMeasuringStrategy.Canvas;
  ctxt.canvasCtxt = measure;
  // Chromium otherwise rounds CFF font advances to whole screen pixels. That
  // changes syllable spacing with scale and disagrees with TeX and native Skia.
  measure.textRendering = 'geometricPrecision';
  ctxt.setGlyphScaling(ENGRAVING.punctumWidth / 100);
  ctxt.staffInterval = ENGRAVING.staffInterval;
  ctxt.staffLineWeight = ENGRAVING.staffLineWeight;
  ctxt.setFont(FONT, ENGRAVING.lyricSize);
  ctxt.textStyles.lyric.size = ENGRAVING.lyricSize;
  ctxt.textStyles.dropCap.font = INITIAL_FONT;
  ctxt.textStyles.dropCap.size = ENGRAVING.initialSize;
  ctxt.textStyles.annotation.size = ENGRAVING.annotationSize;
  ctxt.interSyllabicMultiplier = 3.2;
  // Respect phrase starts when line breaking, even when this leaves more glue
  // to stretch than Exsurge's default half a staff interval.
  ctxt.maxExtraSpaceInStaffIntervals = Infinity;
  ctxt.rubricColor = '#000';
  ctxt.specialCharProperties.fill = '#000';
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
  const offices: Record<string, string> = { Introit: 'Intr.', Gradual: 'Grad.', Graduale: 'Grad.', Alleluia: 'All.', Tract: 'Tract.', Sequence: 'Seq.', Offertory: 'Offert.', Communion: 'Comm.', Hymn: 'Hymn.', Hymnus: 'Hymn.', Antiphona: 'Ant.', Responsorium: 'Resp.', Communio: 'Comm.', Offertorium: 'Offert.', Introitus: 'Intr.', Tractus: 'Tract.', Sequentia: 'Seq.', Varia: 'Va.' };
  const annotations = [offices[office] || office, doc.headers.mode ? `${doc.headers.mode}.` : ''].filter(Boolean);
  if (annotations.length) score.annotation = new e.Annotations(ctxt, ...annotations.map(escapeXml));
  score.performLayout(ctxt);
  // Keep the opening of a new phrase with its following syllable.
  for (let i = 0; i < score.notations.length; i++) {
    if (!(score.notations[i] instanceof e.DoubleBar)) continue;
    let syllables = 0;
    for (const next of score.notations.slice(i + 1)) {
      if (next.lyrics.some((lyric: any) => lyric.text)) syllables++;
      if (syllables >= 2 || next.isDivider) break;
      next.keepWithNext = true;
    }
  }
  // Reserve the same initial box as Gregorio, regardless of the letter width.
  if (score.dropCap) {
    score.dropCap.padding = (ENGRAVING.initialWidth + ENGRAVING.initialSideSpace - score.dropCap.bounds.width) / 2;
  }
  score.layoutChantLines(ctxt, width);
  // Rebuild the last system without justification (\gresetlastline{ragged}).
  const final = score.lines.at(-1);
  ctxt.activeClef = final.startingClef.clone();
  ctxt.maxExtraSpaceInStaffIntervals = 0;
  const ragged = new e.ChantLine(score);
  ragged.buildFromChantNotationIndex(ctxt, final.notationsStartIndex, width);
  ragged.performLayout(ctxt);
  ragged.bounds.y = final.bounds.y;
  ragged.elementIndex = final.elementIndex;
  score.lines[score.lines.length - 1] = ragged;
  const defs = Object.values(ctxt.defs).join('') + ctxt.createStyle();
  const body = bodyStart(doc.music);
  const wanted = new Map(doc.notes.map(n => [n.offset - body, n]));
  // Initio debilis includes '-' in Exsurge's sourceIndex.
  for (const n of doc.notes) if (doc.music[n.offset - 1] === '-') wanted.set(n.offset - body - 1, n);
  const staves: Staff[] = [], positions: Position[] = [], found = new Set<string>();
  for (const line of score.lines) {
    const staff = staves.length;
    // Gregorio puts the lyric baseline 24pt below the bottom staff line.
    // Exsurge normally varies it with the lowest neume on each system.
    let lyricBaseline = -ctxt.staffInterval + ENGRAVING.lyricBaseline;
    const defaultLyricBaseline = lyricBaseline;
    const notations = score.notations.slice(line.notationsStartIndex, line.notationsStartIndex + line.numNotationsOnLine);
    // Keep Gregorio's normal baseline as a minimum, with clearance for the
    // actual note and lyric bounds (especially low ledger notes like Je(a)).
    measure.font = `${ENGRAVING.lyricSize}px ${FONT}`;
    for (const notation of notations) {
      const notes = notation.notes || [];
      const lyrics = notation.lyrics.filter((lyric: any) => lyric.text);
      if (!notes.length || (!lyrics.length && !notes.some((note: any) => note.staffPosition < -1))) continue;
      const ascent = lyrics.length
        ? Math.max(...lyrics.map((lyric: any) => measure.measureText(lyric.text).actualBoundingBoxAscent))
        : ENGRAVING.lyricSize * .7;
      lyricBaseline = Math.max(lyricBaseline, ...notes.map((note: any) => note.bounds.bottom() + ascent + 1));
    }
    const extraBelow = lyricBaseline - defaultLyricBaseline;
    const lyricShift = lyricBaseline - line.lyricLineBaseline;
    for (const notation of [line.startingClef, ...notations]) {
      for (const lyric of notation.lyrics) lyric.bounds.y += lyricShift;
    }
    if (staff === 0) {
      if (score.dropCap) score.dropCap.bounds.y = lyricBaseline;
      if (score.annotation) {
        score.annotation.bounds.y = 0;
        for (let i = 0; i < score.annotation.annotations.length; i++) {
          const annotation = score.annotation.annotations[i];
          annotation.dominantBaseline = 'alphabetic';
          annotation.bounds.y = -ctxt.staffInterval * 7 + 6 + i * 15;
        }
      }
    }
    const chordY = -ctxt.staffInterval * 7 - ENGRAVING.chordGap;
    const contentTop = Math.min(line.notationBounds.y, chordY - 18);
    const top = line.bounds.y + contentTop;
    const baseline = -contentTop;
    const height = Math.max(ENGRAVING.systemStep, lyricBaseline + 6 - contentTop);
    const svg = `<svg class="Exsurge" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" text-rendering="geometricPrecision"><defs>${defs}</defs>${line.createSvgFragment(ctxt, top)}</svg>`;
    staves.push({ svg, width, height, advance: ENGRAVING.systemStep + extraBelow });
    for (let i = line.notationsStartIndex; i < line.notationsStartIndex + line.numNotationsOnLine; i++) {
      const notation = score.notations[i];
      for (const note of notation.notes || []) {
        const target = wanted.get(originalOffset(note.sourceIndex));
        if (!target || found.has(target.id)) continue;
        found.add(target.id);
        const shorthand = /^[a-mA-M][sv]{2}/.test(target.gabc);
        const hookX = shorthand ? notation.notes.at(-1).bounds.x : 0;
        positions.push({ note: target.id, index: target.index, group: target.group, staff,
          x: notation.bounds.x + note.bounds.x,
          noteWidth: note.bounds.width,
          glyphX: notation.bounds.x + hookX,
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

/** Center chords on their notes, pack within neumes, and stagger group collisions.
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
    const ascent = Math.max(metrics.actualBoundingBoxAscent || 7, 5);
    const descent = Math.max(metrics.actualBoundingBoxDescent || 2, 2);
    // Keep a human's manually positioned chords free from automatic repacking.
    if (recalculate) {
      if (packGroups) {
        const previous = previousByGroup.get(`${pos.staff}:${pos.group}`);
        const centeredX = pos.x + (pos.noteWidth - width) / 2;
        const packedX = previous ? Math.max(centeredX, previous.x + previous.width + 4 - chord.dx) : centeredX;
        chord.autoX = Math.round((packedX - pos.glyphX) * 1e6) / 1e6;
      }
      chord.autoRaise = 0;
    }
    let x = pos.glyphX + chord.autoX + chord.dx;
    if (recalculate) {
      const baseline = () => pos.y - chord.dy - chord.autoRaise;
      while (placed.some(p => p.staff === pos.staff && x < p.x + p.width + 3 && x + width + 3 > p.x && baseline() - ascent < p.bottom + 3 && baseline() + descent + 3 > p.top)) chord.autoRaise += 11;
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
  let y = 0;
  const parts: string[] = [];
  if (heading) {
    parts.push(`<text x="${width / 2}" y="${ENGRAVING.headingSize}" text-anchor="middle" font-size="${ENGRAVING.headingSize}" font-weight="bold">${escapeXml(heading)}</text>`);
    y += 17 * 72 / 72.27;
  }
  parts.push(`<text x="${width / 2}" y="${y + ENGRAVING.titleSize}" text-anchor="middle" font-size="${ENGRAVING.titleSize}" font-style="italic" font-weight="bold">${escapeXml(title)}</text>`);
  y += 29 * 72 / 72.27;
  if (subtitle) {
    parts.push(`<text x="${width / 2}" y="${y + ENGRAVING.subtitleSize}" text-anchor="middle" font-size="${ENGRAVING.subtitleSize}" font-style="italic" font-weight="bold">${escapeXml(subtitle)}</text>`);
    y += 15 * 72 / 72.27;
  }
  let bottom = y;
  for (let staff = 0; staff < preview.staves.length; staff++) {
    const spec = preview.staves[staff];
    const chords = placed.filter(p => p.staff === staff);
    const pad = Math.max(0, 8 - Math.min(8, ...chords.map(p => p.top)));
    const inner = spec.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    parts.push(`<g transform="translate(0,${y + pad})">${inner}${chords.map(p => `<text x="${p.x}" y="${p.baseline}" font-size="${ENGRAVING.chordSize}" font-weight="bold">${escapeXml(doc.chords.find(c => c.note === p.note)!.text)}</text>`).join('')}</g>`);
    bottom = y + spec.height + pad;
    y += spec.advance + pad;
  }
  return `<svg class="Exsurge" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}pt" height="${bottom + 8}pt" viewBox="0 0 ${width} ${bottom + 8}" text-rendering="geometricPrecision"><rect width="100%" height="100%" fill="white"/><g font-family="${escapeXml(FONT)}" fill="#000">${parts.join('')}</g></svg>`;
}
