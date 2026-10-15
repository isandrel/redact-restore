/**
 * Pattern rules: a user's own regular expression, as structured fields (never
 * parsed from an entry string). Pure. A pattern runs on everything sent to the
 * model, so it is checked before it is saved: it must compile, stay small, avoid
 * the shapes that backtrack catastrophically, finish quickly on adversarial
 * input, and match its own example. JavaScript has no regex timeout, so these
 * checks are the only guard.
 */
import { CUSTOM_LABEL, MIN_CUSTOM_VALUE_LENGTH, PATTERN_LIMITS } from './defaults.ts';
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
  | 'no-group'
  | 'backreference'
  | 'nested-quantifier'
  | 'quantified-alternation'
  | 'matches-empty'
  | 'slow'
  | 'invalid-label'
  | 'no-example'
  | 'example-no-match'
  | 'example-too-short';

const WORD_EDGE = '[A-Za-z0-9]';

/** The rule as a global regex: whole-word guards added, the user's own flags never accepted. */
export function compilePattern(rule: PatternRule): RegExp {
  const source = rule.wholeWord ? `(?<!${WORD_EDGE})(?:${rule.pattern})(?!${WORD_EDGE})` : rule.pattern;
  return new RegExp(source, rule.ignoreCase ? 'giu' : 'gu');
}

/** Capture groups in a source: what an always-matching variant of it returns. */
function groupCount(source: string): number {
  return (new RegExp(`(?:${source})|`, 'u').exec('') ?? ['']).length - 1;
}

/** Whether the quantifier at `at` repeats without a small bound (`*`, `+`, `{n,}`, `{n,1000}`). */
function unboundedAt(source: string, at: number): boolean {
  const next = source.charAt(at);
  if (next === '*' || next === '+') return true;
  if (next !== '{') return false;
  return /^\{\d*,\}/.test(source.slice(at)) || /^\{\d+,\d{3,}\}/.test(source.slice(at));
}

/**
 * Shapes that backtrack catastrophically: a quantified group whose body is
 * itself quantified (`(a+)+`, `(\w*)*`), or that holds alternatives (`(a|aa)+`).
 * A small scanner over the source: escapes and character classes are single atoms.
 */
function riskyShape(source: string): 'nested-quantifier' | 'quantified-alternation' | undefined {
  type Frame = { quantified: boolean; alternation: boolean };
  const stack: Frame[] = [{ quantified: false, alternation: false }];
  const top = () => stack[stack.length - 1] as Frame;
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '(') {
      stack.push({ quantified: false, alternation: false });
      i += 1;
      continue;
    }
    if (ch === '|') {
      top().alternation = true;
      i += 1;
      continue;
    }
    if (ch === ')') {
      const closed = stack.length > 1 ? (stack.pop() as Frame) : { quantified: false, alternation: false };
      // A group repeated 3+ times whose body repeats freely is as risky: (.*a){12}.
      const repeated = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i + 1));
      if (repeated && closed.quantified && Math.max(Number(repeated[1]), Number(repeated[2] || 0)) >= 3) {
        return 'nested-quantifier';
      }
      if (unboundedAt(source, i + 1)) {
        if (closed.quantified) return 'nested-quantifier';
        if (closed.alternation) return 'quantified-alternation';
        top().quantified = true;
      } else if (closed.quantified) {
        top().quantified = true;
      }
      i += 1;
      continue;
    }
    // One atom: an escape, a character class, or a single character.
    let end = i + 1;
    if (ch === '\\') end = i + 2;
    else if (ch === '[') {
      end = i + 1;
      while (end < source.length && source.charAt(end) !== ']') end += source.charAt(end) === '\\' ? 2 : 1;
      end += 1;
    }
    if (unboundedAt(source, end)) top().quantified = true;
    i = end;
  }
  return undefined;
}

/** Inputs that make a backtracking engine work hardest: long runs that almost match, then fail. */
function adversarialInputs(length: number): string[] {
  return ['a', 'A', '0', ' ', '-', '_', '.', '=', 'a0'].map(unit => `${unit.repeat(Math.ceil(length / unit.length))}!`);
}

/** Runs the regex over adversarial inputs of growing size; false when a run exceeds the budget. */
function fastEnough(regex: RegExp): boolean {
  for (const length of PATTERN_LIMITS.probeLengths) {
    for (const input of adversarialInputs(length)) {
      const started = Date.now();
      regex.lastIndex = 0;
      for (const _ of input.matchAll(regex)) {
        if (Date.now() - started > PATTERN_LIMITS.budgetMs) return false;
      }
      if (Date.now() - started > PATTERN_LIMITS.budgetMs) return false;
    }
  }
  return true;
}

/** The span a match masks: the whole match, or its capture group. */
function maskedSpan(match: RegExpMatchArray, group: number): Span | undefined {
  const index = match.index ?? 0;
  if (group === 0) return { start: index, end: index + match[0].length };
  const value = match[group];
  if (value === undefined) return undefined;
  const offset = match[0].indexOf(value);
  if (offset < 0) return undefined;
  return { start: index + offset, end: index + offset + value.length };
}

/** What is wrong with a rule, or undefined when it may be saved. */
export function patternProblem(rule: PatternRule): PatternProblem | undefined {
  const source = rule.pattern;
  if (!source.trim()) return 'empty';
  if (source.length > PATTERN_LIMITS.maxLength) return 'too-long';
  if (rule.label !== undefined && !LABEL_PATTERN.test(rule.label)) return 'invalid-label';
  let regex: RegExp;
  try {
    regex = compilePattern(rule);
  } catch {
    return 'invalid';
  }
  if (/\\[1-9]|\\k</.test(source)) return 'backreference';
  const risky = riskyShape(source);
  if (risky) return risky;
  if (rule.group < 0 || rule.group > groupCount(source)) return 'no-group';
  if (new RegExp(`^(?:${source})$`, 'u').test('')) return 'matches-empty';
  if (!fastEnough(regex)) return 'slow';
  if (rule.example === undefined) return undefined;
  if (!rule.example.trim()) return 'no-example';
  regex.lastIndex = 0;
  const match = regex.exec(rule.example);
  if (!match) return 'example-no-match';
  const span = maskedSpan(match, rule.group);
  if (!span || span.end - span.start < MIN_CUSTOM_VALUE_LENGTH) return 'example-too-short';
  return undefined;
}

export function describePatternProblem(problem: PatternProblem): string {
  switch (problem) {
    case 'empty':
      return 'Type a pattern first.';
    case 'too-long':
      return `A pattern can be at most ${PATTERN_LIMITS.maxLength} characters.`;
    case 'invalid':
      return 'That is not a valid regular expression.';
    case 'no-group':
      return 'The pattern has no capture group with that number.';
    case 'backreference':
      return 'Backreferences (\\1, \\k<name>) are not allowed: they can make matching slow.';
    case 'nested-quantifier':
      return 'A repeated group holds another repetition, as in (a+)+: rewrite it without the nesting.';
    case 'quantified-alternation':
      return 'A repeated group holds alternatives, as in (a|aa)+: use a character class such as [ab]+ instead.';
    case 'matches-empty':
      return 'The pattern matches empty text: require at least one character.';
    case 'slow':
      return 'The pattern is too slow on long input: simplify its repetitions.';
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
  const label = rule.label ?? CUSTOM_LABEL;
  return {
    id,
    label,
    groups: [],
    defaultOn: true,
    // Same standing as exact values: a user's own rule beats the built-in detectors.
    rank: 0,
    find: text => {
      const spans: Span[] = [];
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        const span = maskedSpan(match, rule.group);
        if (span && span.end - span.start >= MIN_CUSTOM_VALUE_LENGTH) spans.push(span);
        if (spans.length >= PATTERN_LIMITS.maxMatches) break;
      }
      return spans;
    },
  };
}

/** A stable identity for a rule: its source and the flags that change what it matches. */
export function patternKey(rule: Pick<PatternRule, 'pattern' | 'ignoreCase' | 'wholeWord' | 'group'>): string {
  return `${rule.pattern}\u0001${rule.ignoreCase ? 'i' : ''}${rule.wholeWord ? 'w' : ''}${rule.group}`;
}
