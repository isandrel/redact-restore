/** Pure matching code: never logs, stores, or transmits matched values. */
import { DEFAULT_SCHEME, isUsableAlias, type PlaceholderScheme, type ValueRule } from './placeholder.ts';
import { selectDetectors, type Detector } from './detectors.ts';
import { KNOWN_SEGMENT_CACHE, KNOWN_SEGMENT_MIN, MIN_CUSTOM_VALUE_LENGTH } from './defaults.ts';

/** A placeholder label: `CUSTOM`, `EMAIL`, a detector's label, or a user's label. */
export type PrivacyCategory = string;

export interface PrivateMatch {
  start: number;
  end: number;
  value: string;
  category: PrivacyCategory;
  /** 0 for configured or already-known values, 1 for detectors; lower wins a tie. */
  priority: number;
  /** The detector's description (a pattern rule's), told to the model with the placeholder. */
  description?: string;
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
      kept = { value: rule.value, ...(rule.description ? { description: rule.description } : {}) };
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

/**
 * Compiled matchers for the session's known values and tokens. The vault only
 * grows (a /clear starts a new one), so its values are compiled in segments
 * whose sizes are powers of two, like a binary counter: adding a value
 * recompiles only small segments, and a large vault is never compiled whole
 * again for one new value. Matching runs one regex per segment (a handful).
 */
interface KnownIndex {
  readonly values: readonly RegExp[];
  readonly category: ReadonlyMap<string, PrivacyCategory>;
  /** Tokens the placeholder format does not cover: aliases and older formats. */
  readonly tokens?: RegExp;
}

/** A 53-bit hash with the length (cyrb53): a cache key for text, not a security hash. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(2097151 & h2) * 4294967296 + (h1 >>> 0)}`;
}

const segmentCache = new Map<string, RegExp>();

/**
 * One segment's alternation, cached by its whole content (another vault may hold
 * other values at the same positions); least recently used first out.
 */
function segment(values: readonly string[], start: number, end: number): RegExp {
  const key = textHash(values.slice(start, end).join('\u0000'));
  let pattern = segmentCache.get(key);
  if (pattern) segmentCache.delete(key);
  else pattern = compileLiterals(values.slice(start, end), false);
  segmentCache.set(key, pattern);
  if (segmentCache.size > KNOWN_SEGMENT_CACHE) {
    const oldest = segmentCache.keys().next().value;
    if (oldest !== undefined) segmentCache.delete(oldest);
  }
  return pattern;
}

function segments(values: readonly string[]): RegExp[] {
  const found: RegExp[] = [];
  let start = 0;
  let size = 1;
  while (size * 2 <= values.length) size *= 2;
  for (; start < values.length; size = Math.max(1, size / 2)) {
    const rest = values.length - start;
    // The tail under the smallest segment size is compiled as one piece.
    if (rest <= KNOWN_SEGMENT_MIN) {
      found.push(segment(values, start, values.length));
      break;
    }
    if (size <= rest) {
      found.push(segment(values, start, start + size));
      start += size;
    }
  }
  return found;
}

// Lookups derived from one known list (the vault view caches the list itself).
const knownLookups = new WeakMap<
  readonly KnownValue[],
  {
    readonly values: readonly string[];
    readonly category: ReadonlyMap<string, PrivacyCategory>;
    segments?: readonly RegExp[];
  }
>();
const tokenPatterns = new WeakMap<readonly string[], { readonly format: string; readonly pattern?: RegExp }>();

function knownIndex(known: readonly KnownValue[], tokens: readonly string[], scheme: PlaceholderScheme): KnownIndex {
  let lookup = knownLookups.get(known);
  if (!lookup) {
    lookup = {
      values: known.map(entry => entry.value),
      category: new Map(known.map(entry => [entry.value, entry.category])),
    };
    knownLookups.set(known, lookup);
  }
  let literal = tokenPatterns.get(tokens);
  if (literal?.format !== scheme.format) {
    // Placeholders of the active format are found by the format's own pattern.
    const others = tokens.filter(token => scheme.labelOf(token) === undefined);
    literal = { format: scheme.format, ...(others.length ? { pattern: compileLiterals(others, false) } : {}) };
    tokenPatterns.set(tokens, literal);
  }
  // Segments are hashed once per known list, not once per text.
  lookup.segments ??= lookup.values.length ? segments(lookup.values) : [];
  return {
    values: lookup.segments,
    category: lookup.category,
    ...(literal.pattern ? { tokens: literal.pattern } : {}),
  };
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

type Range = { readonly start: number; readonly end: number };

/** Sorted, non-overlapping ranges. */
function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end)
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    else merged.push(range);
  }
  return merged;
}

/** The text with each range replaced by `x` of the same length: offsets stay the same. */
function blankRanges(text: string, ranges: readonly Range[]): string {
  const parts: string[] = [];
  let last = 0;
  for (const range of ranges) {
    parts.push(text.slice(last, range.start), 'x'.repeat(range.end - range.start));
    last = range.end;
  }
  parts.push(text.slice(last));
  return parts.join('');
}

/**
 * Candidates with placeholder ranges cut out. A configured or known value that
 * touches a placeholder is dropped, as before; a detector's match keeps its
 * parts outside placeholders that are long enough to be a value. Candidates
 * arrive sorted by start, so one pointer walks the ranges.
 */
function outsideRanges(candidates: readonly PrivateMatch[], ranges: readonly Range[], text: string): PrivateMatch[] {
  const kept: PrivateMatch[] = [];
  let first = 0;
  for (const candidate of candidates) {
    while (first < ranges.length && (ranges[first]?.end ?? 0) <= candidate.start) first += 1;
    if (first >= ranges.length || (ranges[first]?.start ?? Infinity) >= candidate.end) {
      kept.push(candidate);
      continue;
    }
    if (candidate.priority === 0) continue;
    let cursor = candidate.start;
    const piece = (start: number, end: number) => {
      if (end - start >= MIN_CUSTOM_VALUE_LENGTH)
        kept.push({ ...candidate, start, end, value: text.slice(start, end) });
    };
    for (let index = first; index < ranges.length && (ranges[index]?.start ?? Infinity) < candidate.end; index += 1) {
      const range = ranges[index] as Range;
      piece(cursor, Math.min(range.start, candidate.end));
      cursor = Math.max(cursor, range.end);
    }
    piece(cursor, candidate.end);
  }
  return kept;
}

/** For each outranked label, the winners' starts and the furthest end so far: overlap tests by binary search. */
function winnersByLabel(
  winners: readonly PrivateMatch[],
  labels: ReadonlyMap<PrivateMatch, readonly string[]>,
): Map<string, { readonly starts: number[]; readonly maxEnd: number[] }> {
  const byLabel = new Map<string, PrivateMatch[]>();
  for (const winner of winners) {
    for (const label of labels.get(winner) ?? []) {
      const list = byLabel.get(label);
      if (list) list.push(winner);
      else byLabel.set(label, [winner]);
    }
  }
  const result = new Map<string, { starts: number[]; maxEnd: number[] }>();
  for (const [label, list] of byLabel) {
    list.sort((a, b) => a.start - b.start);
    let furthest = -1;
    result.set(label, {
      starts: list.map(winner => winner.start),
      maxEnd: list.map(winner => (furthest = Math.max(furthest, winner.end))),
    });
  }
  return result;
}

/** Whether a winner that starts before the candidate ends reaches past its start. */
function overlapsWinner(
  winners: { readonly starts: readonly number[]; readonly maxEnd: readonly number[] } | undefined,
  candidate: PrivateMatch,
): boolean {
  if (!winners) return false;
  let low = 0;
  let high = winners.starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((winners.starts[mid] ?? 0) < candidate.end) low = mid + 1;
    else high = mid;
  }
  return low > 0 && (winners.maxEnd[low - 1] ?? -1) > candidate.start;
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
  const index = knownIndex(known, knownTokens, options.placeholders ?? DEFAULT_SCHEME);
  if (index.tokens) index.tokens.lastIndex = 0;
  const guarded = mergeRanges(protectedRanges(text, options.placeholders ?? DEFAULT_SCHEME, index.tokens));
  // Detectors read placeholders as filler of the same length, so a raw value
  // right next to one (`KEY={{…}}tail`, `postgres://{{…}}:password@host`) is
  // still found; the parts inside placeholders are cut away below.
  const scanText = guarded.length > 0 ? blankRanges(text, guarded) : text;

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
  for (const knownPattern of index.values) {
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
    for (const { start, end } of findEmails(scanText)) {
      candidates.push({ start, end, value: text.slice(start, end), category: 'EMAIL', priority: 1 });
    }
  }
  const outranking: PrivateMatch[] = [];
  const outranked = new Map<PrivateMatch, readonly string[]>();
  for (const detector of options.detectors ?? DEFAULT_DETECTORS) {
    for (const { start, end, label } of detector.find(scanText)) {
      const candidate = {
        start,
        end,
        value: text.slice(start, end),
        category: label ?? detector.label,
        priority: detector.rank ?? 1,
        ...(detector.description ? { description: detector.description } : {}),
      };
      candidates.push(candidate);
      if (detector.outranks) {
        outranking.push(candidate);
        outranked.set(candidate, detector.outranks);
      }
    }
  }
  // A detector that knows better removes overlapping matches of the labels it outranks.
  if (outranking.length > 0) {
    const beats = winnersByLabel(outranking, outranked);
    const survivors = candidates.filter(candidate => !overlapsWinner(beats.get(candidate.category), candidate));
    candidates.splice(0, candidates.length, ...survivors);
  }

  // Leftmost wins, then longest; on a tie, configured values beat detectors.
  const byPosition = (a: PrivateMatch, b: PrivateMatch) =>
    a.start - b.start || b.end - b.start - (a.end - a.start) || a.priority - b.priority;
  candidates.sort(byPosition);
  const pieces = guarded.length > 0 ? outsideRanges(candidates, guarded, text).sort(byPosition) : candidates;

  // A candidate that starts inside the previous span but runs past it is merged
  // into that span: dropping it would leave its tail (an email's domain, say) in
  // clear text, which the outbound audit would then refuse on every request.
  const selected: PrivateMatch[] = [];
  for (const candidate of pieces) {
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
