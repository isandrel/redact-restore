// Descriptions: what a value is, told to the model instead of the value. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import { parseConfig } from '../../hooks/config.ts';
import { normalizeRules } from '../../hooks/matcher.ts';
import { patternDetector, patternProblem, type PatternRule } from '../../hooks/patterns.ts';
import { createMasker, legendText, maskText } from '../../hooks/privacy.ts';
import { exportRules, makePattern, makeRule, parseImport } from '../../hooks/rules.ts';
import { collectCandidates } from '../../hooks/scan.ts';

const NOW = new Date('2026-01-02T03:04:05.000Z');
const pattern = (extra: Partial<PatternRule> = {}): PatternRule => ({
  pattern: 'ACME-\\d{4}',
  ignoreCase: false,
  wholeWord: true,
  group: 0,
  ...extra,
});

describe('description checks', () => {
  test('a rule keeps a trimmed description', () => {
    const made = makeRule({ value: 'Acme Corp', description: '  client company name ' }, 'manual', NOW);
    expect(made).toMatchObject({ rule: { value: 'Acme Corp', description: 'client company name' } });
  });

  test('a description that holds its own value, or has the wrong shape, is refused', () => {
    expect(makeRule({ value: 'Acme Corp', description: 'the ACME CORP account' }, 'manual', NOW)).toEqual({
      problem: 'description-has-value',
    });
    for (const description of ['two\nlines', 'has {{braces}}', 'x'.repeat(121)]) {
      expect(makeRule({ value: 'Acme Corp', description }, 'manual', NOW)).toEqual({ problem: 'invalid-description' });
    }
  });

  test('a pattern description must not match the pattern', () => {
    expect(patternProblem(pattern({ description: 'internal ticket id' }))).toBeUndefined();
    expect(patternProblem(pattern({ description: 'like ACME-1234' }))).toBe('description-has-value');
    expect(patternProblem(pattern({ description: 'a{b' }))).toBe('invalid-description');
    const made = makePattern(pattern({ description: ' internal ticket id ' }), 'manual', NOW);
    expect(made).toMatchObject({ pattern: { description: 'internal ticket id' } });
  });
});

describe('notes from masking', () => {
  const base = parseConfig({}).matching;

  test('a rule, an alias and a pattern each describe their new placeholder', () => {
    const merged = normalizeRules([
      { value: 'Acme Corp', label: 'ORG', description: 'client company name' },
      { value: 'Beta Group', alias: 'CLIENT_B', description: 'second client' },
    ]);
    const options = {
      ...base,
      customValues: merged.values,
      rules: merged.rules,
      detectors: [patternDetector(pattern({ description: 'internal ticket id' }), 'p0'), ...(base.detectors ?? [])],
    };
    const masked = maskText('Acme Corp, Beta Group, ACME-1234 and bob@example.com', options, {});
    const byValue = Object.fromEntries(
      Object.entries(masked.notes).map(([token, note]) => [masked.additions[token], note]),
    );
    expect(byValue).toEqual({
      'Acme Corp': 'client company name',
      'Beta Group': 'second client',
      'ACME-1234': 'internal ticket id',
    });
    expect(masked.notes.CLIENT_B).toBe('second client');
  });

  test('known placeholders add no new notes', () => {
    const merged = normalizeRules([{ value: 'Acme Corp', description: 'client company name' }]);
    const options = { ...base, customValues: merged.values, rules: merged.rules };
    const first = maskText('Acme Corp', options, {});
    expect(maskText('Acme Corp again', options, first.additions).notes).toEqual({});
  });

  test('the legend masks private values inside descriptions and holds no value', () => {
    const merged = normalizeRules([{ value: 'Acme Corp', description: 'client of bob@example.com' }]);
    const masker = createMasker({ ...base, customValues: merged.values, rules: merged.rules }, {});
    masker.mask('Acme Corp');
    const legend = legendText(Object.entries(masker.notes()), 'Header:', masker.mask);
    expect(legend).toMatch(
      /^Header:\n- \{\{PRIVATE:CUSTOM#[a-f0-9]{12}\}\}: client of \{\{PRIVATE:EMAIL#[a-f0-9]{12}\}\}$/,
    );
    expect(legend).not.toContain('Acme Corp');
    expect(legend).not.toContain('bob@example.com');
  });
});

describe('descriptions travel', () => {
  test('export and import keep descriptions as fields', () => {
    const rule = makeRule({ value: 'Acme Corp', description: 'client company name' }, 'manual', NOW);
    const made = makePattern(pattern({ description: 'internal ticket id' }), 'manual', NOW);
    if (!('rule' in rule) || !('pattern' in made)) throw new Error('setup');
    const parsed = parseImport(exportRules([rule.rule], NOW, [made.pattern]));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.items[0]?.description).toBe('client company name');
    expect(parsed.patterns?.[0]?.description).toBe('internal ticket id');
  });

  test('scan candidates carry a description of where they came from', () => {
    const found = collectCandidates({
      gitName: 'Alice Example',
      envFiles: [{ name: '.env', text: 'DB_PASSWORD=hunter2hunter2\n' }],
    });
    expect(found.map(one => one.description)).toEqual(["the user's own name (git config)", 'the value of DB_PASSWORD']);
  });
});
