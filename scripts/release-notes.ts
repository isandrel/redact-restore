#!/usr/bin/env bun
/**
 * Prints the CHANGELOG section for a release tag, after checking that the tag
 * matches the version in .claude-plugin/plugin.json. Used by the release workflow.
 *
 *   bun scripts/release-notes.ts v0.1.0
 */
const tag = process.argv[2] ?? '';
const root = new URL('..', import.meta.url).pathname;
const manifest = (await Bun.file(`${root}.claude-plugin/plugin.json`).json()) as { version?: unknown };
const version = typeof manifest.version === 'string' ? manifest.version : '';

if (!version || tag !== `v${version}`) {
  console.error(`release-notes: tag ${tag || '(none)'} does not match plugin.json version ${version || '(missing)'}`);
  process.exit(1);
}

const changelog = await Bun.file(`${root}CHANGELOG.md`).text();
const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')}(?:\\s|$)`, 'm');
const start = changelog.search(heading);
if (start === -1) {
  console.error(`release-notes: CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
const body = changelog.slice(start).split('\n').slice(1);
const next = body.findIndex(line => line.startsWith('## '));
console.log((next === -1 ? body : body.slice(0, next)).join('\n').trim());

export {};
