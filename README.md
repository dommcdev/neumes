# Neumes

Neumes adds guitar chords to Gregorian chant scores. Use the browser editor or
the command-line interface (CLI) to edit `.gabc` files.

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

Chord commands save changes to the file. For more commands, use:

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
between sessions, and exports PDF without a print dialog. On Linux, the Open and
Save dialogs use the XDG desktop portal. Dropping files into the window works on
macOS, Windows and X11, not Wayland.

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
