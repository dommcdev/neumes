#!/usr/bin/env bun
/** `bun run release 0.2.0`: bump the version, commit, tag, push and publish a
 * GitHub release. Publishing starts .github/workflows/release.yml, which builds
 * the Linux desktop app and attaches it to the release.
 */
import { $ } from 'bun';
import { readFile, writeFile } from 'node:fs/promises';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('Usage: bun run release <version>   (for example 0.2.0)');
  process.exit(1);
}
const tag = `v${version}`;
if ((await $`git status --porcelain`.text()).trim()) throw new Error('Commit or stash your changes first.');
if ((await $`git branch --show-current`.text()).trim() !== 'main') throw new Error('Release from main.');
if ((await $`git tag --list ${tag}`.text()).trim()) throw new Error(`${tag} already exists.`);

async function replace(path: string, pattern: RegExp, value: string) {
  const text = await readFile(path, 'utf8');
  if (!pattern.test(text)) throw new Error(`No version found in ${path}.`);
  await writeFile(path, text.replace(pattern, value));
}
await replace('package.json', /"version": "[^"]*"/, `"version": "${version}"`);
await replace('desktop/Cargo.toml', /^version = "[^"]*"/m, `version = "${version}"`);
await replace('desktop/Cargo.lock', /(name = "neumes-desktop"\nversion = )"[^"]*"/, `$1"${version}"`);

await $`git commit -am ${`Release ${tag}`}`;
await $`git tag ${tag}`;
await $`git push origin main ${tag}`;
await $`gh release create ${tag} --title ${tag} --generate-notes`;
console.log(`Published ${tag}. The Linux build is attached once the Release workflow finishes:`);
console.log((await $`gh repo view --json url -q .url`.text()).trim() + '/actions/workflows/release.yml');
