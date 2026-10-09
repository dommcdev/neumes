# Neumes

Neumes adds guitar chords to Gregorian chant scores. Use the browser editor or
the command-line interface (CLI) to edit `.gabc` files.

## Install and use the CLI

Install [Bun](https://bun.sh). In the project directory, install the dependencies:

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
