/** Pure matching code: never logs, stores, or transmits matched values. */
import { DEFAULT_SCHEME, isUsableAlias, type PlaceholderScheme, type ValueRule } from './placeholder.ts';
import { selectDetectors, type Detector } from './detectors.ts';
import { MIN_CUSTOM_VALUE_LENGTH } from './defaults.ts';

/** A placeholder label: `CUSTOM`, `EMAIL`, a detector's label, or a user's label. */
export type PrivacyCategory = string;

export interface PrivateMatch {
  start: number;
  end: number;
  value: string;
  category: PrivacyCategory;
  /** 0 for configured or already-known values, 1 for detectors; lower wins a tie. */
  priority: number;
}

export interface MatchingOptions {
  readonly customValues: readonly string[];
  readonly customCaseInsensitive: boolean;
  readonly redactEmails: boolean;
  /** How placeholders look; the default `{{PRIVATE:{label}#{id}}}` when absent. */
  readonly placeholders?: PlaceholderScheme;
  /** Per-value label or alias, keyed by the value in lower case. */
  readonly rules?: ReadonlyMap<string, ValueRule>;
  /** Detectors besides email; the default-on set when absent. */
  readonly detectors?: readonly Detector[];
}

const DEFAULT_DETECTORS = selectDetectors([], []).detectors;

/** A value the session vault already holds; matched literally and case-sensitively. */
export interface KnownValue {
  readonly value: string;
  readonly category: PrivacyCategory;
}

export { MIN_CUSTOM_VALUE_LENGTH };

const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]/;
const ASCII_LETTER = /[A-Za-z]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NormalizedValues {
  values: string[];
  rules: Map<string, ValueRule>;
  /** Entries dropped as too short; never the entries themselves. */
  tooShort: number;
  /** Entries whose label or alias is unusable or reused. */
  invalid: number;
}

/**
 * `custom_values` entries from the plugin options: each entry is one value,
 * matched exactly as typed (trimmed). Labels and aliases come only from the
 * rules pane's fields; nothing here is parsed.
 */
export function normalizeCustomValues(raw: readonly string[]): NormalizedValues {
  return normalizeRules(
    raw
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(value => ({ value })),
  );
}

/** Whether an alias overlaps another rule's value: restoring it would rewrite that value too. */
export function aliasOverlaps(alias: string, ownValue: string, values: Iterable<string>): boolean {
  const name = alias.toLowerCase();
  const own = ownValue.toLowerCase();
  for (const value of values) {
    const other = value.toLowerCase();
    if (other !== own && (other.includes(name) || name.includes(other))) return true;
  }
  return false;
}

/**
 * Rules as structured fields: value, and optionally label or alias. Every spelling
 * is matched; the first rule for a value (any case) gives its label or alias.
 * A reused, unusable or overlapping alias is dropped and its value still
 * masked with the default label: a bad alias never unmasks a value.
 */
export function normalizeRules(input: readonly ValueRule[]): NormalizedValues {
  const rules = new Map<string, ValueRule>();
  const values: string[] = [];
  const spellings = new Set<string>();
  const aliases = new Set<string>();
  let tooShort = 0;
  let invalid = 0;
  const usable = input.filter(rule => {
    if (rule.value.length >= MIN_CUSTOM_VALUE_LENGTH) return true;
    tooShort += 1;
    return false;
  });
  const allValues = usable.map(rule => rule.value);
  for (const rule of usable) {
    let kept = rule;
    if (
      rule.alias &&
      (aliases.has(rule.alias) ||
        !isUsableAlias(rule.alias, rule.value) ||
        aliasOverlaps(rule.alias, rule.value, allValues))
    ) {
      invalid += 1;
      kept = { value: rule.value };
    }
    if (!spellings.has(kept.value)) {
      spellings.add(kept.value);
      values.push(kept.value);
    }
    const key = kept.value.toLowerCase();
    if (rules.has(key)) continue;
    if (kept.alias) aliases.add(kept.alias);
    rules.set(key, kept);
  }
  // Any spelling that ignores case makes every spelling of that value ignore case (the safe side).
  for (const rule of usable) {
    const key = rule.value.toLowerCase();
    const kept = rules.get(key);
    if (rule.ignoreCase && kept && !kept.ignoreCase) rules.set(key, { ...kept, ignoreCase: true });
  }
  return { values, rules, tooShort, invalid };
}

/**
 * Linear-time email scan. A backtracking regex such as
 * /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ is quadratic on long runs without
 * an `@` (base64, minified files), which large tool results routinely contain.
 * Matches what that regex would match: the leftmost local part and the longest
 * domain that ends in a dot followed by two or more letters.
 */
export function findEmails(text: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let consumed = 0;
  let at = text.indexOf('@');
  while (at !== -1) {
    let start = at;
    while (start > consumed && EMAIL_LOCAL.test(text.charAt(start - 1))) start -= 1;
    let runEnd = at + 1;
    while (runEnd < text.length && EMAIL_DOMAIN.test(text.charAt(runEnd))) runEnd += 1;

    let end = -1;
    if (start < at) {
      let dot = text.lastIndexOf('.', runEnd - 1);
      while (dot > at + 1) {
        let letters = dot + 1;
        while (letters < runEnd && ASCII_LETTER.test(text.charAt(letters))) letters += 1;
        if (letters - (dot + 1) >= 2) {
          end = letters;
          break;
        }
        dot = text.lastIndexOf('.', dot - 1);
      }
    }
    if (end !== -1) {
      found.push({ start, end });
      consumed = end;
      at = text.indexOf('@', end);
    } else {
      at = text.indexOf('@', at + 1);
    }
  }
  return found;
}

/** Ranges of existing placeholders and known tokens (aliases too), never masked again. */
/**
 * Compiled matchers for the session's known values and tokens. The vault only
 * grows within a session (a /clear starts a new one), so its size and its first
 * and last entries identify a version: a large vault is compiled once per
 * change, not once per message.
 */
interface KnownIndex {
  readonly values?: RegExp;
  readonly category: ReadonlyMap<string, PrivacyCategory>;
  readonly tokens?: RegExp;
}
// A few versions at once: the audit alternates between the whole vault and the part added since.
const knownIndexCache = new Map<string, KnownIndex>();
const KNOWN_INDEX_SLOTS = 4;

function knownIndex(known: readonly KnownValue[], tokens: readonly string[]): KnownIndex {
  const key = [
    known.length,
    tokens.length,
    known[0]?.value,
    known[known.length - 1]?.value,
    tokens[0],
    tokens[tokens.length - 1],
  ].join('\u0000');
  const cached = knownIndexCache.get(key);
  if (cached) return cached;
  const category = new Map(known.map(entry => [entry.value, entry.category]));
  const index: KnownIndex = {
    category,
    ...(category.size ? { values: compileLiterals([...category.keys()], false) } : {}),
    ...(tokens.length ? { tokens: compileLiterals(tokens, false) } : {}),
  };
  if (knownIndexCache.size >= KNOWN_INDEX_SLOTS) {
    const oldest = knownIndexCache.keys().next().value;
    if (oldest !== undefined) knownIndexCache.delete(oldest);
  }
  knownIndexCache.set(key, index);
  return index;
}

/** The custom values split by case handling, compiled once per options object. */
const customCache = new WeakMap<MatchingOptions, { exact?: RegExp; ignoreCase?: RegExp }>();

function customPatterns(options: MatchingOptions): { exact?: RegExp; ignoreCase?: RegExp } {
  let cached = customCache.get(options);
  if (!cached) {
    const insensitive = (value: string) =>
      options.rules?.get(value.toLowerCase())?.ignoreCase ?? options.customCaseInsensitive;
    const exact = options.customValues.filter(value => !insensitive(value));
    const ignoreCase = options.customValues.filter(insensitive);
    cached = {
      ...(exact.length ? { exact: compileLiterals(exact, false) } : {}),
      ...(ignoreCase.length ? { ignoreCase: compileLiterals(ignoreCase, true) } : {}),
    };
    customCache.set(options, cached);
  }
  return cached;
}

/** One alternation of literals, longest first, so the leftmost match is also the longest. */
function compileLiterals(values: readonly string[], caseInsensitive: boolean): RegExp {
  const sorted = [...new Set(values)].sort((a, b) => b.length - a.length);
  return new RegExp(sorted.map(escapeRegExp).join('|'), caseInsensitive ? 'giu' : 'gu');
}

function protectedRanges(text: string, scheme: PlaceholderScheme, literal: RegExp | undefined) {
  const ranges = [...text.matchAll(scheme.pattern)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (literal) {
    for (const match of text.matchAll(literal)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

export function findPrivateMatches(
  text: string,
  options: MatchingOptions,
  known: readonly KnownValue[] = [],
  knownTokens: readonly string[] = [],
): PrivateMatch[] {
  if (text.length === 0) return [];
  const candidates: PrivateMatch[] = [];
  const index = knownIndex(known, knownTokens);
  if (index.tokens) index.tokens.lastIndex = 0;
  const guarded = protectedRanges(text, options.placeholders ?? DEFAULT_SCHEME, index.tokens);

  // Literal values are treated as literals, not as regexes. A rule's own
  // ignoreCase wins over the option, so the values form two alternations.
  const { exact, ignoreCase } = customPatterns(options);
  for (const custom of [exact, ignoreCase]) {
    if (!custom) continue;
    custom.lastIndex = 0;
    for (const match of text.matchAll(custom)) {
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        category: 'CUSTOM',
        priority: 0,
      });
    }
  }
  // Values already in the vault stay masked even after a config change or when a
  // detector would not find them again (e.g. an Edit result echoing restored text).
  const knownCategory = index.category;
  const knownPattern = index.values;
  if (knownPattern) {
    knownPattern.lastIndex = 0;
    for (const match of text.matchAll(knownPattern)) {
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        category: knownCategory.get(match[0]) ?? 'CUSTOM',
        priority: 0,
      });
    }
  }
  if (options.redactEmails) {
    for (const { start, end } of findEmails(text)) {
      candidates.push({ start, end, value: text.slice(start, end), category: 'EMAIL', priority: 1 });
    }
  }
  const outranking: PrivateMatch[] = [];
  const outranked = new Map<PrivateMatch, readonly string[]>();
  for (const detector of options.detectors ?? DEFAULT_DETECTORS) {
    for (const { start, end, label } of detector.find(text)) {
      const candidate = {
        start,
        end,
        value: text.slice(start, end),
        category: label ?? detector.label,
        priority: detector.rank ?? 1,
      };
      candidates.push(candidate);
      if (detector.outranks) {
        outranking.push(candidate);
        outranked.set(candidate, detector.outranks);
      }
    }
  }
  // A detector that knows better removes overlapping matches of the labels it outranks.
  const beaten = (candidate: PrivateMatch) =>
    outranking.some(
      winner =>
        winner !== candidate &&
        (outranked.get(winner) ?? []).includes(candidate.category) &&
        candidate.start < winner.end &&
        candidate.end > winner.start,
    );
  if (outranking.length > 0) {
    const survivors = candidates.filter(candidate => !beaten(candidate));
    candidates.splice(0, candidates.length, ...survivors);
  }

  // Leftmost wins, then longest; on a tie, configured values beat detectors.
  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.priority - b.priority);

  // A candidate that starts inside the previous span but runs past it is merged
  // into that span: dropping it would leave its tail (an email's domain, say) in
  // clear text, which the outbound audit would then refuse on every request.
  const selected: PrivateMatch[] = [];
  for (const candidate of candidates) {
    if (guarded.some(range => candidate.start < range.end && candidate.end > range.start)) continue;
    const last = selected[selected.length - 1];
    if (last && candidate.start < last.end) {
      if (candidate.end > last.end) {
        last.end = candidate.end;
        last.value = text.slice(last.start, last.end);
      }
      continue;
    }
    selected.push({ ...candidate });
  }
  return selected;
}
