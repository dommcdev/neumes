/** The local Gregorio sheet style. All engraving coordinates are PDF points
 * (bp, 1/72 inch), including the offsets written into GABC chord hooks.
 * TeX's pt is 1/72.27 inch; browser zoom must never change this geometry.
 */
const pt = (value: number) => value * 72 / 72.27;
export const ENGRAVING = {
  pageWidth: 612,
  pageHeight: 792,
  marginX: 45,
  marginTop: 28.8,
  marginBottom: 46.8,
  scoreWidth: 522,
  lyricSize: pt(20),
  initialSize: pt(54),
  initialWidth: pt(46),
  // Gregorio adds scaled beforeinitialshift and afterinitialshift (0.2cm each).
  initialSideSpace: 2 * .2 * 72 / 2.54 * 26 / 17,
  annotationSize: pt(18),
  headingSize: pt(14),
  titleSize: pt(24),
  subtitleSize: pt(12),
  staffInterval: 6.225,
  punctumWidth: 6.561089,
  staffLineWeight: 0.75,
  lyricBaseline: pt(24),
  // Measured baseline advance with the 83pt setting and this font/staff size.
  systemStep: 87.964,
  chordSize: 9,
  chordGap: 14,
} as const;
export const FONT = '"TeX Gyre Pagella", serif';
export const INITIAL_FONT = '"EB Garamond", serif';
export const CHORD_FONT = `bold ${ENGRAVING.chordSize}px ${FONT}`;
