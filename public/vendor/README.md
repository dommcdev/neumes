# Exsurge

`exsurge.js` is the unmodified offline bundle previously used by ChantEdit.
It comes from https://github.com/bbloomf/jgabc at commit
`16a254bb3c1bccdf653943692902c0478177a96b`.

Upstream: https://github.com/bbloomf/exsurge.
License: MIT, in `exsurge.LICENSE`.

The bundle includes the chant glyph outlines; no musical font download is
required. The browser loads it as a classic script. The Bun CLI loads the
same file as CommonJS (see the adjacent `package.json`).

EB Garamond text fonts are bundled separately in `public/fonts/` under the
SIL Open Font License. Source: https://github.com/google/fonts/tree/main/ofl/ebgaramond.

TeX Gyre Pagella (regular, bold, italic, and bold italic) is bundled in
`public/fonts/` under the GUST Font License, included there. These unmodified
OpenType files come from TeX Live's `tex-gyre` package (the GUST e-foundry:
https://www.gust.org.pl/projects/e-foundry/tex-gyre). Lyrics, headings, and
9bp chords use Pagella to match the local Gregorio sheet; the initial uses
EB Garamond. Engraving coordinates and saved offsets are PDF points (bp).
