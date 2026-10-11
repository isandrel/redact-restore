/**
 * Rules kept in the plugin store (`$.store`): values the person adds, edits or
 * removes in the rules pane, accepts from a scan, or imports. Pure: callers
 * read and write the store. Never log, toast or return these values to the model.
 */
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  IGNORED_PREFIX,
  MIN_CUSTOM_VALUE_LENGTH,
  PREVIEW_DOTS,
  RULE_PREFIX,
} from './defaults.ts';
import { aliasOverlaps } from './matcher.ts';
import { isUsableAlias, LABEL_PATTERN, type ValueRule } from './placeholder.ts';

export { EXPORT_FORMAT, EXPORT_VERSION, IGNORED_PREFIX, RULE_PREFIX };

export const RULE_SOURCES = ['manual', 'scan', 'import'] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export interface StoredRule {
  readonly value: string;
  readonly label?: string;
  readonly alias?: string;
  readonly source: RuleSource;
  /** ISO time the rule was first added; it orders the list. */
  readonly addedAt: string;
}

export type RuleProblem =
  | 'empty'
  | 'too-short'
  | 'no-label'
  | 'invalid-label'
  | 'no-alias'
  | 'invalid-alias'
  | 'alias-in-use'
  | 'alias-overlap';

export type RuleParse = { readonly rule: StoredRule } | { readonly problem: RuleProblem };

/**
 * Rules are one per exact value: with case-sensitive matching (the default),
 * `Acme` and `ACME` are two values, each masked on its own.
 */
export function ruleKey(value: string): string {
  return value;
}

/** Checks a rule against the matcher's limits and the aliases already in use. */
export function makeRule(
  input: ValueRule,
  source: RuleSource,
  now: Date,
  existing: readonly ValueRule[] = [],
): RuleParse {
  const value = input.value.trim();
  if (value.length === 0) return { problem: 'empty' };
  if (value.length < MIN_CUSTOM_VALUE_LENGTH) return { problem: 'too-short' };
  const label = input.label?.trim().toUpperCase();
  const alias = input.alias?.trim();
  if (label !== undefined && !LABEL_PATTERN.test(label)) return { problem: 'invalid-label' };
  if (alias !== undefined && !isUsableAlias(alias, value)) return { problem: alias ? 'invalid-alias' : 'no-alias' };
  const others = existing.filter(rule => ruleKey(rule.value) !== ruleKey(value));
  if (alias && others.some(rule => rule.alias === alias)) return { problem: 'alias-in-use' };
  // An alias is restored wherever it appears: it must not overlap any other
  // value, and this value must not overlap another rule's alias.
  if (
    alias &&
    aliasOverlaps(
      alias,
      value,
      others.map(rule => rule.value),
    )
  )
    return { problem: 'alias-overlap' };
  const otherAliases = others.flatMap(rule => (rule.alias ? [rule.alias] : []));
  if (otherAliases.some(other => aliasOverlaps(other, '', [value]))) return { problem: 'alias-overlap' };
  return {
    rule: {
      value,
      ...(alias ? { alias } : label ? { label } : {}),
      source,
      addedAt: now.toISOString(),
    },
  };
}

export function describeProblem(problem: RuleProblem): string {
  switch (problem) {
    case 'empty':
      return 'Type a value first.';
    case 'too-short':
      return `Values need at least ${MIN_CUSTOM_VALUE_LENGTH} characters.`;
    case 'no-label':
      return 'Type a label, or pick one from the list.';
    case 'invalid-label':
      return 'A label is a letter, then letters, digits or _ (up to 32 characters).';
    case 'no-alias':
      return 'Type an alias, such as CLIENT_A.';
    case 'invalid-alias':
      return 'An alias needs 4 to 64 characters, no spaces, an underscore, a digit or two capitals, and must not contain the value.';
    case 'alias-in-use':
      return 'That alias already stands for another value.';
    case 'alias-overlap':
      return "That alias overlaps another rule's value, or this value overlaps another rule's alias.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueRuleOf(item: Record<string, unknown>): ValueRule | undefined {
  if (typeof item.value !== 'string') return undefined;
  return {
    value: item.value,
    ...(typeof item.label === 'string' ? { label: item.label } : {}),
    ...(typeof item.alias === 'string' ? { alias: item.alias } : {}),
  };
}

/** Reads the stored list, dropping anything malformed (the store is a local file a person may edit). */
export function parseStoredRules(raw: unknown): StoredRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: StoredRule[] = [];
  for (const item of raw) {
    const input = isRecord(item) ? valueRuleOf(item) : undefined;
    if (!input || !isRecord(item)) continue;
    const source = RULE_SOURCES.find(one => one === item.source) ?? 'manual';
    const parsed = makeRule(input, source, new Date(0), rules);
    if (!('rule' in parsed) || rules.some(rule => ruleKey(rule.value) === ruleKey(parsed.rule.value))) continue;
    rules.push({ ...parsed.rule, addedAt: typeof item.addedAt === 'string' ? item.addedAt : parsed.rule.addedAt });
  }
  return rules;
}

/** Adds a rule, or replaces the one for the same value (a new label or alias). */
export function upsertRule(
  rules: readonly StoredRule[],
  rule: StoredRule,
): { rules: StoredRule[]; change: 'added' | 'updated' | 'unchanged' } {
  const key = ruleKey(rule.value);
  const index = rules.findIndex(one => ruleKey(one.value) === key);
  if (index === -1) return { rules: [...rules, rule], change: 'added' };
  const current = rules[index] as StoredRule;
  if (current.value === rule.value && current.label === rule.label && current.alias === rule.alias)
    return { rules: [...rules], change: 'unchanged' };
  // An update keeps the rule's place: its added time stays.
  const updated = { ...rule, addedAt: current.addedAt };
  return { rules: rules.map((one, i) => (i === index ? updated : one)), change: 'updated' };
}

export function removeRule(rules: readonly StoredRule[], value: string): StoredRule[] {
  const key = ruleKey(value);
  return rules.filter(rule => ruleKey(rule.value) !== key);
}

/**
 * Rules for matching: the plugin options (keychain) first, so an option's
 * label or alias wins over a stored rule for the same value.
 */
export function mergedRules(optionRules: readonly ValueRule[], stored: readonly StoredRule[]): ValueRule[] {
  return [...optionRules, ...stored];
}

/** A short form for the pane: the first character, dots and the length. */
export function maskPreview(value: string): string {
  const first = Array.from(value)[0] ?? '';
  return `${first}${'•'.repeat(PREVIEW_DOTS)} (${Array.from(value).length})`;
}

/** The export file: originals in plain text, so the caller warns where it is written. */
export function exportRules(rules: readonly StoredRule[], now: Date): string {
  return `${JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: now.toISOString(),
      rules: rules.map(rule => ({
        value: rule.value,
        ...(rule.label ? { label: rule.label } : {}),
        ...(rule.alias ? { alias: rule.alias } : {}),
      })),
    },
    null,
    2,
  )}\n`;
}

/** An import file is an export: JSON whose rules have `value`, and optionally `label` or `alias`. */
export function parseImport(text: string): { items: ValueRule[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: `The file is not a ${EXPORT_FORMAT} export (JSON).` };
  }
  if (!isRecord(data) || data.format !== EXPORT_FORMAT || !Array.isArray(data.rules)) {
    return { error: `The file is not a ${EXPORT_FORMAT} export.` };
  }
  if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) {
    return { error: 'The file comes from a newer Redact Restore version.' };
  }
  // An entry without a string value is kept as an empty value, so it counts as invalid.
  return { items: data.rules.map(item => (isRecord(item) ? (valueRuleOf(item) ?? { value: '' }) : { value: '' })) };
}

export interface ImportSummary {
  readonly rules: StoredRule[];
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly invalid: number;
}

/** Merges imported entries into the stored rules, or replaces them all. */
export function applyImport(
  existing: readonly StoredRule[],
  items: readonly ValueRule[],
  mode: 'merge' | 'replace',
  now: Date,
  /** Rules kept elsewhere (the plugin options) that aliases must not clash with. */
  others: readonly ValueRule[] = [],
): ImportSummary {
  let rules: StoredRule[] = mode === 'replace' ? [] : [...existing];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let invalid = 0;
  for (const item of items) {
    const parsed = makeRule(item, 'import', now, [...others, ...rules]);
    if (!('rule' in parsed)) {
      invalid += 1;
      continue;
    }
    const result = upsertRule(rules, parsed.rule);
    rules = result.rules;
    if (result.change === 'added') added += 1;
    else if (result.change === 'updated') updated += 1;
    else unchanged += 1;
  }
  return { rules, added, updated, unchanged, invalid };
}

/** SHA-256 hex of a value: how dismissed scan candidates are remembered without keeping them. */
export async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ruleKey(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The store key of a rule or a dismissed candidate: a prefix and the value's fingerprint. */
export async function storeKeyFor(prefix: string, value: string): Promise<string> {
  return `${prefix}${await fingerprint(value)}`;
}

export function isRuleKey(key: string): boolean {
  return key.startsWith(RULE_PREFIX) && /^[a-f0-9]{64}$/.test(key.slice(RULE_PREFIX.length));
}

/** Oldest first, then by value, so every session lists the rules in one order. */
export function sortRules(rules: readonly StoredRule[]): StoredRule[] {
  return [...rules].sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.value.localeCompare(b.value));
}

/** Identity of a rule list, for change detection and caches. */
export function rulesKey(rules: readonly StoredRule[]): string {
  return JSON.stringify(rules.map(rule => [rule.value, rule.label ?? '', rule.alias ?? '', rule.source]));
}

/** `~/…` for a path under home, so command output never spells the home folder (any case or separator). */
export function displayPath(path: string, home: string | undefined): string {
  if (!home) return path;
  const fold = (text: string) => text.replace(/\\/g, '/').toLowerCase();
  const base = fold(home).replace(/\/+$/, '');
  const target = fold(path);
  return target === base || target.startsWith(`${base}/`) ? `~${path.slice(home.replace(/[\\/]+$/, '').length)}` : path;
}

/** Expands a leading `~` against home; leaves every other path as typed. */
export function expandHome(path: string, home: string | undefined): string {
  if (!home || !(path === '~' || path.startsWith('~/') || path.startsWith('~\\'))) return path;
  return `${home.replace(/[\\/]+$/, '')}${path.slice(1)}`;
}
