/**
 * Pattern rules: a user's own regular expression, as structured fields (never
 * parsed from an entry string). Pure.
 *
 * JavaScript cannot time out a regex, and timing probes are neither reliable nor
 * able to catch quadratic slowdowns, so a pattern must fall inside a safe subset,
 * checked deterministically:
 * - quantifiers only on single atoms (a character, an escape, a class), never on
 *   a group, which rules out exponential backtracking;
 * - at most two free repeats (`*`, `+`, `{n,}`);
 * - no backreferences and no lookarounds;
 * - a fixed text of 3+ characters every match contains (the keyword).
 * At run time the regex runs only in a window around each keyword occurrence
 * (as gitleaks does), so even a quadratic pattern costs a bounded amount per hit.
 */
import {
  CUSTOM_LABEL,
  KEYWORD_RESCAN_LIMIT,
  KEYWORD_WINDOW_AFTER,
  KEYWORD_WINDOW_BEFORE,
  MIN_CUSTOM_VALUE_LENGTH,
  PATTERN_LIMITS,
} from './defaults.ts';
import type { Detector, Span } from './detectors.ts';
import { LABEL_PATTERN } from './placeholder.ts';

export interface PatternRule {
  /** The regex source, without slashes or flags. */
  readonly pattern: string;
  readonly label?: string;
  readonly ignoreCase: boolean;
  /** Only where no letter or digit touches either end (GitHub's default boundary). */
  readonly wholeWord: boolean;
  /** 0 masks the whole match; N masks capture group N only. */
  readonly group: number;
  /** A sample that must match when the rule is saved; never sent anywhere. */
  readonly example?: string;
}

export type PatternProblem =
  | 'empty'
  | 'too-long'
  | 'invalid'
  | 'unbalanced'
  | 'backreference'
  | 'lookaround'
  | 'group-quantifier'
  | 'too-many-repeats'
  | 'no-keyword'
  | 'no-group'
  | 'invalid-label'
  | 'no-example'
  | 'example-no-match'
  | 'example-too-short';

/** What the scanner learns about a source: a problem, or its keyword and capture groups. */
interface Shape {
  readonly problem?: PatternProblem;
  readonly keyword?: string;
  readonly groups: number;
}

const QUANTIFIER = /^(?:[*+?]|\{\d+(?:,\d*)?\})/;
const LITERAL_CHAR = /[A-Za-z0-9_\-:#@/%=~!<>"' ]/;
const LOOKAROUNDS = ['(?=', '(?!', '(?<=', '(?<!'];

/**
 * Walks the source once. Escapes and character classes are single atoms; a
 * quantifier may follow only an atom; the longest run of plain characters at the
 * top level (outside any alternation, not made optional or repeated) is the keyword.
 */
function analyze(source: string): Shape {
  let depth = 0;
  let groups = 0;
  let freeRepeats = 0;
  let topAlternation = false;
  let run = '';
  let best = '';
  const endRun = () => {
    if (run.trim().length > best.trim().length) best = run;
    run = '';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '(') {
      endRun();
      if (LOOKAROUNDS.some(open => source.startsWith(open, i))) return { problem: 'lookaround', groups };
      depth += 1;
      if (source.startsWith('(?:', i)) {
        i += 3;
      } else if (source.startsWith('(?<', i)) {
        groups += 1;
        const close = source.indexOf('>', i);
        i = close > 0 ? close + 1 : i + 3;
      } else {
        groups += 1;
        i += 1;
      }
      continue;
    }
    if (ch === ')') {
      endRun();
      if (depth === 0) return { problem: 'unbalanced', groups };
      depth -= 1;
      i += 1;
      if (QUANTIFIER.test(source.slice(i))) return { problem: 'group-quantifier', groups };
      continue;
    }
    if (ch === '|') {
      endRun();
      if (depth === 0) topAlternation = true;
      i += 1;
      continue;
    }
    let atom: string;
    let literal: string | undefined;
    if (ch === '\\') {
      const next = source.charAt(i + 1);
      if (/[1-9]/.test(next) || next === 'k') return { problem: 'backreference', groups };
      atom = source.slice(i, i + 2);
      // An escaped punctuation character is a literal; \d, \w, \s, \b … are not.
      if (/[^A-Za-z0-9]/.test(next)) literal = next;
    } else if (ch === '[') {
      let end = i + 1;
      while (end < source.length && source.charAt(end) !== ']') end += source.charAt(end) === '\\' ? 2 : 1;
      atom = source.slice(i, end + 1);
    } else {
      atom = ch;
      if (LITERAL_CHAR.test(ch)) literal = ch;
    }
    i += atom.length;
    const quantifier = QUANTIFIER.exec(source.slice(i))?.[0];
    if (quantifier) {
      i += quantifier.length;
      if (source.charAt(i) === '?') i += 1;
      if (quantifier === '*' || quantifier === '+' || quantifier.endsWith(',}')) freeRepeats += 1;
      if (freeRepeats > PATTERN_LIMITS.maxFreeRepeats) return { problem: 'too-many-repeats', groups };
      endRun();
      continue;
    }
    if (literal !== undefined && depth === 0) run += literal;
    else endRun();
  }
  endRun();
  if (depth !== 0) return { problem: 'unbalanced', groups };
  const keyword = topAlternation ? '' : best.trim();
  return keyword.length >= PATTERN_LIMITS.minKeyword ? { keyword, groups } : { problem: 'no-keyword', groups };
}

/** The rule as a global regex with match indices: whole-word guards added, the user's own flags never accepted. */
export function compilePattern(rule: PatternRule): RegExp {
  const source = rule.wholeWord ? `(?<![A-Za-z0-9])(?:${rule.pattern})(?![A-Za-z0-9])` : rule.pattern;
  return new RegExp(source, rule.ignoreCase ? 'dgiu' : 'dgu');
}

/** The span a match masks: the whole match, or its capture group, at the group's own position. */
function maskedSpan(match: RegExpExecArray, group: number, offset: number): { start: number; end: number } | undefined {
  const range = match.indices?.[group];
  if (!range) return undefined;
  return { start: offset + range[0], end: offset + range[1] };
}

/** Windows around each keyword occurrence, merged; the regex runs only there. */
function keywordWindows(text: string, keyword: string, ignoreCase: boolean): Span[] {
  const haystack = ignoreCase ? text.toLowerCase() : text;
  const needle = ignoreCase ? keyword.toLowerCase() : keyword;
  const windows: Array<{ start: number; end: number }> = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    const window = {
      start: Math.max(0, at - KEYWORD_WINDOW_BEFORE),
      end: Math.min(text.length, at + needle.length + KEYWORD_WINDOW_AFTER),
    };
    const last = windows[windows.length - 1];
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else windows.push(window);
  }
  return windows;
}

/** Every span the rule masks in a text: matches found in keyword windows, a match at a window's edge rescanned. */
function findSpans(rule: PatternRule, regex: RegExp, keyword: string, text: string): Span[] {
  const spans: Span[] = [];
  let sticky: RegExp | undefined;
  for (const window of keywordWindows(text, keyword, rule.ignoreCase)) {
    const slice = text.slice(window.start, window.end);
    regex.lastIndex = 0;
    for (let match = regex.exec(slice); match; match = regex.exec(slice)) {
      let found: RegExpExecArray = match;
      let offset = window.start;
      if (match.index + match[0].length >= slice.length && window.end < text.length) {
        sticky ??= new RegExp(regex.source, regex.flags.replace('g', 'y'));
        sticky.lastIndex = window.start + match.index;
        const longer = sticky.exec(text.slice(0, Math.min(text.length, sticky.lastIndex + KEYWORD_RESCAN_LIMIT)));
        if (longer) {
          found = longer;
          offset = 0;
        }
      }
      const span = maskedSpan(found, rule.group, offset);
      // A match that starts at the window's left edge may have begun earlier:
      // widen the mask over the run of non-space characters it sits in (fail safe).
      if (span && offset === window.start && span.start === window.start && window.start > 0) {
        let start = span.start;
        const limit = Math.max(0, span.start - KEYWORD_RESCAN_LIMIT);
        while (start > limit && !/\s/.test(text.charAt(start - 1))) start -= 1;
        span.start = start;
      }
      if (span && span.end - span.start >= MIN_CUSTOM_VALUE_LENGTH) spans.push(span);
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }
  return spans;
}

/** What is wrong with a rule, or undefined when it may be saved. Deterministic: no timing. */
export function patternProblem(rule: PatternRule): PatternProblem | undefined {
  const source = rule.pattern;
  if (!source.trim()) return 'empty';
  if (source.length > PATTERN_LIMITS.maxLength) return 'too-long';
  if (rule.label !== undefined && !LABEL_PATTERN.test(rule.label)) return 'invalid-label';
  try {
    // On its own first: a stray `)` must not hide behind the whole-word wrapper.
    new RegExp(source, 'u');
    compilePattern(rule);
  } catch {
    return 'invalid';
  }
  const shape = analyze(source);
  if (shape.problem) return shape.problem;
  if (rule.group < 0 || rule.group > shape.groups) return 'no-group';
  if (rule.example === undefined) return undefined;
  if (!rule.example.trim()) return 'no-example';
  if (findSpans(rule, compilePattern(rule), shape.keyword ?? '', rule.example).length > 0) return undefined;
  return compilePattern(rule).exec(rule.example) ? 'example-too-short' : 'example-no-match';
}

/** The keyword a valid pattern is found by, for the form to show. */
export function patternKeyword(pattern: string): string | undefined {
  return analyze(pattern).keyword;
}

export function describePatternProblem(problem: PatternProblem): string {
  switch (problem) {
    case 'empty':
      return 'Type a pattern first.';
    case 'too-long':
      return `A pattern can be at most ${PATTERN_LIMITS.maxLength} characters.`;
    case 'invalid':
      return 'That is not a valid regular expression (patterns use the u flag: escape only characters that need it, so write - rather than \\-).';
    case 'unbalanced':
      return 'The parentheses do not balance.';
    case 'backreference':
      return 'Backreferences (\\1, \\k<name>) are not allowed.';
    case 'lookaround':
      return 'Lookarounds such as (?=…) and (?<!…) are not allowed; use Whole word for boundaries.';
    case 'group-quantifier':
      return 'Repeat single characters or classes, not groups: write [a-z0-9.-]+ rather than ([a-z0-9-]+\\.)+.';
    case 'too-many-repeats':
      return `Use at most ${PATTERN_LIMITS.maxFreeRepeats} open-ended repeats (*, +, {n,}); give the others a size such as {1,40}.`;
    case 'no-keyword':
      return `The pattern needs a fixed text of at least ${PATTERN_LIMITS.minKeyword} characters that every match contains, such as ACME- (not inside a group or a | alternative).`;
    case 'no-group':
      return 'The pattern has no capture group with that number.';
    case 'invalid-label':
      return 'A label is a letter, then letters, digits or _ (up to 32 characters).';
    case 'no-example':
      return 'Type an example that the pattern should match.';
    case 'example-no-match':
      return 'The pattern does not match the example.';
    case 'example-too-short':
      return `The part the pattern masks in the example must be at least ${MIN_CUSTOM_VALUE_LENGTH} characters.`;
  }
}

/** A detector for the matching code: spans of each match (or its group), under the rule's label. */
export function patternDetector(rule: PatternRule, id: string): Detector {
  const regex = compilePattern(rule);
  const keyword = analyze(rule.pattern).keyword ?? '';
  const label = rule.label ?? CUSTOM_LABEL;
  return {
    id,
    label,
    groups: [],
    defaultOn: true,
    // Same standing as exact values: a user's own rule beats the built-in detectors.
    rank: 0,
    find: text => (keyword ? findSpans(rule, regex, keyword, text) : []),
  };
}

/** A stable identity for a rule: its source and the flags that change what it matches. */
export function patternKey(rule: Pick<PatternRule, 'pattern' | 'ignoreCase' | 'wholeWord' | 'group'>): string {
  return `${rule.pattern}\u0001${rule.ignoreCase ? 'i' : ''}${rule.wholeWord ? 'w' : ''}${rule.group}`;
}
