#!/usr/bin/env bun
/**
 * Regenerates hooks/vendor/gitleaks-rules.ts from a pinned gitleaks release.
 *
 *   bun scripts/sync-gitleaks.ts [tag]      (default: the tag below)
 *
 * gitleaks writes Go RE2 regexes, which always run in linear time. The
 * ECMAScript RegExp engine that TypeScript runs on backtracks, so every converted rule is compiled and timed against
 * adversarial input; rules that fail either check are dropped and listed in
 * the generated header. The license is copied beside the table.
 */
const DEFAULT_TAG = 'v8.30.1';
const SLOW_MS = 40;
/** Rules too noisy for prompts and tool output; users can enable them by name. */
const OFF_BY_DEFAULT = new Set(['generic-api-key']);

interface TomlAllowlist {
  regexes?: string[];
  stopwords?: string[];
  regexTarget?: string;
  condition?: string;
}
interface TomlRule {
  id: string;
  regex?: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  allowlists?: TomlAllowlist[];
}
interface TomlConfig {
  allowlist?: { regexes?: string[]; stopwords?: string[] };
  rules: TomlRule[];
}

export interface ConvertedRegex {
  source: string;
  flags: string;
}

/** Go RE2 syntax to ECMAScript RegExp syntax: inline flags become regex flags, POSIX classes expand. */
export function convert(re2: string): ConvertedRegex {
  let source = re2;
  const flags = new Set<string>();
  if (/\(\?i\)/.test(source)) {
    flags.add('i');
    source = source.replace(/\(\?i\)/g, '');
  }
  if (source.includes('(?i:')) {
    flags.add('i');
    source = source.replace(/\(\?i:/g, '(?:');
  }
  // A case-sensitive island inside a case-insensitive rule: RegExp engines
  // without regex modifiers reject it, so it is widened to the rule's flags.
  source = source.replace(/\(\?-i:/g, '(?:');
  if (source.includes('(?s:')) {
    flags.add('s');
    source = source.replace(/\(\?s:/g, '(?:');
  }
  source = source
    .replace(/\(\?P</g, '(?<')
    .replace(/\\z/g, '$')
    .replace(/\\A/g, '^')
    .replace(/\[\[:alnum:\]\]/g, '[A-Za-z0-9]')
    .replace(/\[:alnum:\]/g, 'A-Za-z0-9')
    .replace(/\[:alpha:\]/g, 'A-Za-z')
    .replace(/\[:digit:\]/g, '0-9');
  return { source, flags: [...flags].sort().join('') };
}

/**
 * Allowlists hold known example keys as literals; secret scanners (GitHub's
 * among them) flag those in a repository. Every 4th character of a long
 * key-shaped run is written as a `\xHH` escape: the regex matches the same
 * text, and no key literal appears in the generated file.
 */
export function defang(source: string): string {
  return source.replace(/[A-Za-z0-9_-]{16,}/g, run =>
    [...run]
      .map((char, index) => (index % 4 === 3 ? `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}` : char))
      .join(''),
  );
}

function label(id: string): string {
  const name = id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (/^[A-Z]/.test(name) ? name : `K_${name}`).slice(0, 32);
}

/** Inputs that make backtracking regexes slow: keyword-led runs of key characters. */
function adversarial(keywords: readonly string[]): string[] {
  const run = (chars: string, n: number) => chars.repeat(Math.ceil(n / chars.length)).slice(0, n);
  const keyword = keywords[0] ?? 'key';
  return [
    `${keyword}=${run('aA0', 20_000)}`,
    `${keyword} ${run('a-_', 20_000)}!`,
    run(`${keyword}"${run('x', 40)}" `, 40_000),
    `${keyword}:${' '.repeat(5_000)}${run('0', 10_000)}`,
    run(`${keyword}.`, 30_000),
  ];
}

/** Fastest of three runs, so a busy machine does not drop a rule by accident. */
function timeOn(pattern: RegExp, input: string): number {
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) {
    pattern.lastIndex = 0;
    const started = performance.now();
    let guard = 0;
    while (pattern.exec(input) && guard < 10_000) guard += 1;
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

function slow(pattern: RegExp, keywords: readonly string[]): boolean {
  return adversarial(keywords).some(input => timeOn(pattern, input) > SLOW_MS);
}

async function main(): Promise<void> {
  const tag = process.argv[2] ?? DEFAULT_TAG;
  const base = `https://raw.githubusercontent.com/gitleaks/gitleaks/${tag}`;
  const [tomlText, license] = await Promise.all([
    fetch(`${base}/config/gitleaks.toml`).then(r => {
      if (!r.ok) throw new Error(`config: ${r.status}`);
      return r.text();
    }),
    fetch(`${base}/LICENSE`).then(r => {
      if (!r.ok) throw new Error(`license: ${r.status}`);
      return r.text();
    }),
  ]);
  const config = Bun.TOML.parse(tomlText) as unknown as TomlConfig;

  const kept: unknown[] = [];
  const dropped: string[] = [];
  for (const rule of config.rules) {
    if (!rule.regex) {
      dropped.push(`${rule.id} (no regex)`);
      continue;
    }
    const regex = convert(rule.regex);
    let compiled: RegExp;
    try {
      compiled = new RegExp(regex.source, `${regex.flags}g`);
    } catch {
      dropped.push(`${rule.id} (does not compile as an ECMAScript RegExp)`);
      continue;
    }
    const keywords = (rule.keywords ?? []).map(k => k.toLowerCase());
    if (slow(compiled, keywords)) {
      dropped.push(`${rule.id} (slow on adversarial input)`);
      continue;
    }
    const allow = (rule.allowlists ?? []).filter(
      list => (list.regexTarget ?? 'secret') === 'secret' && (list.condition ?? 'OR') === 'OR',
    );
    kept.push({
      id: rule.id,
      label: label(rule.id),
      source: regex.source,
      flags: regex.flags,
      secretGroup: rule.secretGroup ?? 0,
      keywords,
      entropy: rule.entropy ?? 0,
      allow: allow.flatMap(list => (list.regexes ?? []).map(convert)).map(r => ({ ...r, source: defang(r.source) })),
      stopwords: allow.flatMap(list => list.stopwords ?? []).map(s => s.toLowerCase()),
      defaultOn: !OFF_BY_DEFAULT.has(rule.id),
    });
  }
  const globalAllow = (config.allowlist?.regexes ?? [])
    .map(convert)
    .map(r => ({ ...r, source: defang(r.source) }))
    .filter(r => {
      try {
        new RegExp(r.source, r.flags);
        return true;
      } catch {
        return false;
      }
    });
  const stopwords = (config.allowlist?.stopwords ?? []).map(s => s.toLowerCase());

  const out = `// Generated by scripts/sync-gitleaks.ts from gitleaks ${tag} (config/gitleaks.toml). Do not edit.
// Source: https://github.com/gitleaks/gitleaks/blob/${tag}/config/gitleaks.toml
// License: MIT, see LICENSE-gitleaks.txt beside this file.
// Converted ${kept.length} of ${config.rules.length} rules. Dropped:
${dropped.map(d => `//   ${d}`).join('\n') || '//   none'}

export interface GitleaksRule {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly flags: string;
  readonly secretGroup: number;
  readonly keywords: readonly string[];
  readonly entropy: number;
  readonly allow: readonly { readonly source: string; readonly flags: string }[];
  readonly stopwords: readonly string[];
  readonly defaultOn: boolean;
}

export const GITLEAKS_VERSION = ${JSON.stringify(tag)};

export const GITLEAKS_RULES: readonly GitleaksRule[] = ${JSON.stringify(kept, null, 1)};

export const GITLEAKS_ALLOW: readonly { readonly source: string; readonly flags: string }[] = ${JSON.stringify(globalAllow)};

export const GITLEAKS_STOPWORDS: readonly string[] = ${JSON.stringify(stopwords)};
`;
  const root = new URL('..', import.meta.url).pathname;
  await Bun.write(`${root}hooks/vendor/gitleaks-rules.ts`, out);
  await Bun.write(`${root}hooks/vendor/LICENSE-gitleaks.txt`, license);
  console.log(`gitleaks ${tag}: kept ${kept.length}, dropped ${dropped.length}`);
  for (const d of dropped) console.log(`  dropped ${d}`);
}

if (import.meta.main) await main();
