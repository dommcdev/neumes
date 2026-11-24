# Neumes

Neumes adds guitar chords to Gregorian chant scores. Use the browser editor or
the command-line interface (CLI) to edit `.gabc` files. The desktop app and the
CLI also edit LilyPond (`.ly`) scores.

## Install and use the CLI

In the project directory, install the dependencies:

```sh
bun install
```

List the notes. Use a note ID to add or remove a chord:

```sh
bun run cli inspect score.gabc --json
bun run cli set-chord score.gabc --note n12 --chord Am
bun run cli remove-chord score.gabc --note n12
```

Chord commands save changes to the file. The same commands work on `.ly`
files when LilyPond is installed. For more commands, use:

```sh
bun run cli --help
```

## Desktop app

`desktop/` is a native version of the editor, drawn with
[Rune](https://github.com/anomalyco/rune). It runs the same `src/core` code as
the website (bundled by Bun and run in QuickJS), so scores open, edit and save
identically. It needs Rust and Bun to build:

```sh
bun run desktop                 # build and open the app
bun run desktop -- score.gabc   # open a score directly
bun run desktop:build           # desktop/target/release/neumes
bun run test:desktop
```

Unlike the website, it saves straight to the file, keeps an unsaved draft
between sessions, and exports PDF without a print dialog. It also opens
LilyPond scores (see below). On Linux, the Open and
Save dialogs use the XDG desktop portal. Dropping files into the window works on
macOS, Windows and X11, not Wayland.

## LilyPond scores

The desktop app and the CLI edit `.ly` files with the LilyPond you have
installed (or the one named by `LILYPOND`). LilyPond engraves the score once
when it opens, and its point-and-click links say where each note is in the
file. After that, chords you type appear immediately: they are drawn over
LilyPond's pages and never wait for LilyPond.

A chord is saved as a text script on its note, `a4^\markup \bold "Am"`, and
LilyPond places it when it prints. Existing `^"Am"` chords are picked up too.
As with GABC, Neumes only adds or removes chord annotations; unchanged files
save byte-for-byte identical. Export to PDF runs LilyPond on the saved text.

Limits: a `<…>` chord takes one chord symbol, manual offsets (Shift+arrows)
apply to GABC only, and a note used twice (through a variable or
`\repeat unfold`) carries the same chord everywhere it appears.

## Releases

`bun run release 0.2.0` bumps the version, commits, tags, pushes and publishes
a GitHub release (it needs a clean `main` and the `gh` CLI). Publishing starts
the Release workflow, which builds the Linux desktop app and attaches
`neumes-v0.2.0-linux-x86_64.tar.gz` to the release.

## Develop locally

Start the development server:

```sh
bun run dev
```

Open `http://localhost:5173` in Chrome, Chromium, or Edge.

Run the tests and make a production build:

```sh
bun run test
bun run build
```

## License
Neumes is [MIT-licensed](LICENSE).
