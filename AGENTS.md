# Neumes development

- Use **Bun**, not npm, pnpm, or yarn, for dependency management and scripts.
- `bun install`, `bun run dev`, `bun run build`, `bun run test`.
- The static Chromium SPA and Bun CLI share `src/core/`. Keep musical parsing,
  chord edits, serialization, and collision rules there, not in UI handlers.
- Individual notes are targets, including implicit repeated strophae/virgae.
  Neume groups are only grouping/context, not the smallest editing target.
- Never reserialize the musical source or insert note spacing to fit chords.
  Unchanged open/save must be byte-for-byte identical.
- Test fixtures in `~/dev/chant/scores` are read-only reference material. Never
  edit those originals as part of development or tests.
- Browser tests: `bun run test:browser` after installing Playwright Chromium,
  or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chrome binary.
- Optional authoritative Gregorio check: `bun run test:gregorio` with an
  already-installed TeX Live Docker image. This is not an app dependency.
- The browser is static/local-first. Do not add score uploads, analytics,
  remote fonts, an MCP service, or server infrastructure without a request.
