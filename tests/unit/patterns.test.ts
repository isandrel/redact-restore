// Pattern rules: checks, matching and storage. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import { parseConfig } from '../../hooks/config.ts';
import { findPrivateMatches, normalizeRules } from '../../hooks/matcher.ts';
import { patternDetector, patternProblem, type PatternRule } from '../../hooks/patterns.ts';
import { maskText } from '../../hooks/privacy.ts';
import {
  applyPatternImport,
  exportRules,
  makePattern,
  parseImport,
  parseStoredPatterns,
  upsertPattern,
} from '../../hooks/rules.ts';

const NOW = new Date('2026-01-02T03:04:05.000Z');
const rule = (pattern: string, extra: Partial<PatternRule> = {}): PatternRule => ({
  pattern,
  ignoreCase: false,
  wholeWord: true,
  group: 0,
  ...extra,
});
const spans = (r: PatternRule, text: string) =>
  patternDetector(r, 'test')
    .find(text)
    .map(({ start, end }) => text.slice(start, end));

describe('pattern checks', () => {
  test('a well-formed pattern with a matching example passes', () => {
    expect(patternProblem(rule('ACME-[A-Z0-9]{16}', { example: 'id ACME-0000AAAA1111BBBB' }))).toBeUndefined();
  });

  test('each problem is named', () => {
    const cases: Array<[PatternRule, string]> = [
      [rule('  '), 'empty'],
      [rule('x'.repeat(513)), 'too-long'],
      [rule('(unclosed'), 'invalid'],
      [rule('[A-Z]\\-\\d+'), 'invalid'],
      [rule('x+)+(?:y'), 'invalid'],
      [rule('(acme)\\1x'), 'backreference'],
      [rule('(?=.)acme'), 'lookaround'],
      [rule('acme(a+)+b'), 'group-quantifier'],
      [rule('acme(?:b{1,2})+c'), 'group-quantifier'],
      [rule('acme((?:b|bb))+c'), 'group-quantifier'],
      [rule('acme-\\w+-\\w+-\\w+'), 'too-many-repeats'],
      [rule('\\s+X'), 'no-keyword'],
      [rule('token_[a-z]{4}|key_[a-z]{4}'), 'no-keyword'],
      [rule('\\b'), 'no-keyword'],
      [rule('key=(\\w+)', { group: 2 }), 'no-group'],
      [rule('ACME-\\d{4}', { label: '1bad' }), 'invalid-label'],
      [rule('ACME-\\d{4}', { example: 'nothing here' }), 'example-no-match'],
      [rule('key=(\\w+)', { group: 1, example: 'key=ab' }), 'example-too-short'],
    ];
    for (const [input, problem] of cases) expect(patternProblem(input)).toBe(problem);
    // Safe shapes that an earlier check refused.
    for (const ok of ['C:\\\\1\\d+', '[a-z0-9.-]+\\.corp\\.example', 'user=\\w+;pass=(\\w+)']) {
      expect(patternProblem(rule(ok, ok.includes('(') ? { group: 1 } : {}))).toBeUndefined();
    }
  });

  test('patterns that once passed and then hung stay fast: the regex runs only near its keyword', () => {
    const slow = rule('\\w+@acme\\.example', { wholeWord: false });
    const text = `${'a'.repeat(200_000)}x ${'f'.repeat(200_000)}`;
    const started = performance.now();
    expect(spans(slow, text)).toEqual([]);
    expect(spans(rule('[a-f0-9]+-secret', { wholeWord: false }), `${'0'.repeat(200_000)}-secre`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('pattern matching', () => {
  test('whole word by default; inside words when asked', () => {
    expect(spans(rule('ACME-\\d{4}'), 'a ACME-1234 b XACME-5678')).toEqual(['ACME-1234']);
    expect(spans(rule('ACME-\\d{4}', { wholeWord: false }), 'XACME-5678')).toEqual(['ACME-5678']);
  });

  test('ignore case, and a capture group masks only its part', () => {
    expect(spans(rule('acme-\\d{4}', { ignoreCase: true }), 'ACME-1234')).toEqual(['ACME-1234']);
    expect(spans(rule('acme-\\d{4}'), 'ACME-1234')).toEqual([]);
    expect(spans(rule('ticket=(\\w+)', { group: 1 }), 'see ticket=Zq7Lm2Xk ok')).toEqual(['Zq7Lm2Xk']);
  });

  test('a capture group masks its own position, not an earlier copy of its text', () => {
    expect(
      patternDetector(rule('user=\\w+;pass=(\\w+)', { group: 1 }), 't').find('user=hunter22x;pass=hunter2'),
    ).toEqual([{ start: 20, end: 27 }]);
  });

  test('every match is masked, however many; a value longer than the window is masked whole', () => {
    const many = Array.from({ length: 1500 }, (_, i) => `ACME-${String(i).padStart(4, '0')}`).join(' ');
    expect(spans(rule('ACME-\\d{4}'), many)).toHaveLength(1500);
    const long = `${'x'.repeat(400)}@acme.example`;
    expect(spans(rule('\\w+@acme\\.example', { wholeWord: false }), `mail ${long} now`)).toEqual([long]);
  });

  test('a pattern rule masks under its label and beats a built-in detector', () => {
    const base = parseConfig({}).matching;
    const matching = {
      ...base,
      detectors: [patternDetector(rule('ACME-[A-Z0-9]{16}', { label: 'ACME_TOKEN' }), 'p0'), ...(base.detectors ?? [])],
    };
    const masked = maskText('token ACME-0000AAAA1111BBBB end', matching, {});
    expect(masked.text).toMatch(/^token \{\{PRIVATE:ACME_TOKEN#[a-f0-9]{12}\}\} end$/);
  });

  test('custom_patterns from the options: valid ones mask, invalid ones are counted', () => {
    const config = parseConfig({ custom_patterns: ['ACME-\\d{4}', 'acme(a+)+b', '  '] });
    expect([config.optionPatterns.length, config.invalidPatterns]).toEqual([1, 1]);
    expect(findPrivateMatches('id ACME-1234', config.matching).map(m => [m.category, m.value])).toEqual([
      ['CUSTOM', 'ACME-1234'],
    ]);
  });
});

describe('exact values: per-rule ignore case', () => {
  test('a rule ignoreCase wins over the option, both ways', () => {
    const base = parseConfig({}).matching;
    const merged = normalizeRules([{ value: 'Acme Corp', ignoreCase: true }, { value: 'Beta Group' }]);
    const options = { ...base, customValues: merged.values, rules: merged.rules };
    expect(findPrivateMatches('ACME CORP and BETA GROUP', options).map(m => m.value)).toEqual(['ACME CORP']);
    const insensitive = { ...options, customCaseInsensitive: true };
    const strict = normalizeRules([{ value: 'Beta Group', ignoreCase: false }]);
    expect(
      findPrivateMatches('BETA GROUP', { ...insensitive, customValues: strict.values, rules: strict.rules }),
    ).toEqual([]);
  });
});

describe('exact values: spellings that disagree on case', () => {
  test('if any spelling ignores case, every spelling does', () => {
    const base = parseConfig({}).matching;
    const merged = normalizeRules([{ value: 'Acme Corp' }, { value: 'acme corp', ignoreCase: true }]);
    const options = { ...base, customValues: merged.values, rules: merged.rules };
    expect(findPrivateMatches('ACME CORP', options).map(m => m.value)).toEqual(['ACME CORP']);
  });
});

describe('stored patterns', () => {
  test('the example is checked and never stored; CUSTOM is the default label', () => {
    const made = makePattern(rule('ACME-\\d{4}', { label: 'CUSTOM', example: 'ACME-1234' }), 'manual', NOW);
    if (!('pattern' in made)) throw new Error(made.problem);
    expect(JSON.stringify(made.pattern)).not.toContain('ACME-1234');
    expect(made.pattern.label).toBeUndefined();
    expect(makePattern(rule('acme(a+)+'), 'manual', NOW)).toEqual({ problem: 'group-quantifier' });
  });

  test('loading drops malformed or risky entries; upsert updates the label in place', () => {
    const loaded = parseStoredPatterns([
      { pattern: 'ACME-\\d{4}', label: 'TOKEN', source: 'manual', addedAt: '2026-01-01T00:00:00.000Z' },
      { pattern: 'acme(a+)+', source: 'manual' },
      { label: 'NOPATTERN' },
      'text',
    ]);
    expect(loaded.map(one => one.pattern)).toEqual(['ACME-\\d{4}']);
    const first = loaded[0];
    if (!first) throw new Error('missing');
    const relabeled = upsertPattern(loaded, { ...first, label: 'KEY', addedAt: NOW.toISOString() });
    expect(relabeled.change).toBe('updated');
    expect(relabeled.patterns[0]?.addedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(upsertPattern(loaded, first).change).toBe('unchanged');
  });

  test('export and import carry patterns as fields', () => {
    const made = makePattern(rule('ACME-\\d{4}', { label: 'TOKEN', ignoreCase: true }), 'manual', NOW);
    if (!('pattern' in made)) throw new Error(made.problem);
    const parsed = parseImport(exportRules([], NOW, [made.pattern]));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.patterns).toEqual([
      { pattern: 'ACME-\\d{4}', label: 'TOKEN', ignoreCase: true, wholeWord: true, group: 0 },
    ]);
    const summary = applyPatternImport([], [...(parsed.patterns ?? []), rule('acme(a|aa)+')], 'merge', NOW);
    expect([summary.added, summary.invalid]).toEqual([1, 1]);
  });
});
