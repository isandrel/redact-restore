// Stored rules, import and export. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import {
  applyImport,
  displayPath,
  expandHome,
  exportRules,
  fingerprint,
  isRuleKey,
  makeRule,
  maskPreview,
  mergedRules,
  parseImport,
  parseStoredRules,
  removeRule,
  RULE_PREFIX,
  sortRules,
  storeKeyFor,
  upsertRule,
  type StoredRule,
} from '../../hooks/rules.ts';
import { normalizeRules } from '../../hooks/matcher.ts';
import { formLabels } from '../../hooks/pane.tsx';
import type { ValueRule } from '../../hooks/placeholder.ts';
import { RULE_LABELS } from '../../hooks/defaults.ts';
import { parseConfig } from '../../hooks/config.ts';
import { maskText } from '../../hooks/privacy.ts';

function normalizedOptions(rules: readonly StoredRule[]) {
  const merged = normalizeRules(rules);
  return { customValues: merged.values, rules: merged.rules };
}

const NOW = new Date('2026-01-02T03:04:05.000Z');

function rule(input: ValueRule, existing: readonly StoredRule[] = []): StoredRule {
  const parsed = makeRule(input, 'manual', NOW, existing);
  if (!('rule' in parsed)) throw new Error(`rejected: ${parsed.problem}`);
  return parsed.rule;
}

describe('parsing rules', () => {
  test('plain, labeled and aliased entries', () => {
    expect(rule({ value: 'Project Phoenix' })).toEqual({
      value: 'Project Phoenix',
      source: 'manual',
      addedAt: NOW.toISOString(),
    });
    expect(rule({ value: 'Project Phoenix', label: 'PROJECT' }).label).toBe('PROJECT');
    expect(rule({ value: 'Project Phoenix', alias: 'CODENAME_X' }).alias).toBe('CODENAME_X');
  });

  test('problems are named, never the value', () => {
    expect(makeRule({ value: '  ' }, 'manual', NOW)).toEqual({ problem: 'empty' });
    expect(makeRule({ value: 'ab' }, 'manual', NOW)).toEqual({ problem: 'too-short' });
    expect(makeRule({ value: 'Project Phoenix', label: '1BAD' }, 'manual', NOW)).toEqual({ problem: 'invalid-label' });
    expect(makeRule({ value: 'Project Phoenix', alias: 'x' }, 'manual', NOW)).toEqual({ problem: 'invalid-alias' });
    expect(makeRule({ value: 'Project Phoenix', alias: '' }, 'manual', NOW)).toEqual({ problem: 'no-alias' });
    const first = rule({ value: 'Project Phoenix', alias: 'CODENAME_X' });
    expect(makeRule({ value: 'Acme Labs', alias: 'CODENAME_X' }, 'manual', NOW, [first])).toEqual({
      problem: 'alias-in-use',
    });
    // Option rules count as well as saved ones.
    expect(
      makeRule({ value: 'Beta Group', alias: 'CODE_ONE' }, 'manual', NOW, [{ value: 'Alpha Team', alias: 'CODE_ONE' }]),
    ).toEqual({
      problem: 'alias-in-use',
    });
  });

  test('an alias may not overlap another rule value, nor a value another alias', () => {
    expect(makeRule({ value: 'Gamma Inc', alias: 'Delta_22' }, 'manual', NOW, [{ value: 'Delta_22' }])).toEqual({
      problem: 'alias-overlap',
    });
    expect(makeRule({ value: 'Delta_22' }, 'manual', NOW, [{ value: 'Gamma Inc', alias: 'Delta_22' }])).toEqual({
      problem: 'alias-overlap',
    });
  });

  test('a bad alias in the merged rules is dropped, never the value', () => {
    const merged = normalizeRules([
      { value: 'Alpha Team', alias: 'CODE_ONE' },
      { value: 'Beta Group', alias: 'CODE_ONE' },
      { value: 'Gamma Inc', alias: 'Delta_22' },
      { value: 'Delta_22' },
    ]);
    expect(merged.values).toEqual(['Alpha Team', 'Beta Group', 'Gamma Inc', 'Delta_22']);
    expect(merged.rules.get('beta group')).toEqual({ value: 'Beta Group' });
    expect(merged.rules.get('gamma inc')).toEqual({ value: 'Gamma Inc' });
    expect(merged.invalid).toBe(2);
    const options = { ...parseConfig({}).matching, customValues: merged.values, rules: merged.rules };
    const masked = maskText('Beta Group, Gamma Inc and Delta_22', options, {});
    expect(masked.text).not.toMatch(/Beta Group|Gamma Inc|Delta_22/);
  });

  test('structured rules keep values the entry syntax would misread', () => {
    const parsed = makeRule({ value: 'c2VjcmV0dmFsdWU==', label: 'secret' }, 'scan', NOW);
    expect('rule' in parsed && parsed.rule).toEqual({
      value: 'c2VjcmV0dmFsdWU==',
      label: 'SECRET',
      source: 'scan',
      addedAt: NOW.toISOString(),
    });
  });
});

describe('the stored list', () => {
  test('malformed, duplicate and conflicting items are dropped', () => {
    const stored = parseStoredRules([
      { value: 'Project Phoenix', label: 'PROJECT', source: 'manual', addedAt: '2026-01-01T00:00:00.000Z' },
      { value: 'project phoenix', source: 'scan' },
      { value: 'ab' },
      { label: 'NOLABEL' },
      'text',
      { value: 'Acme Labs', alias: 'CODENAME_X', source: 'bogus' },
      { value: 'Other Labs', alias: 'CODENAME_X' },
    ]);
    // Rules are keyed by exact value: a case variant is its own rule.
    expect(stored.map(one => one.value)).toEqual(['Project Phoenix', 'project phoenix', 'Acme Labs']);
    expect(stored[0]?.addedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(stored[2]?.source).toBe('manual');
    expect(parseStoredRules({ not: 'a list' })).toEqual([]);
  });

  test('upsert adds, updates a label, or leaves the rule unchanged', () => {
    const first = rule({ value: 'Project Phoenix' });
    const added = upsertRule([], first);
    expect(added.change).toBe('added');
    expect(upsertRule(added.rules, rule({ value: 'Project Phoenix', label: 'PROJECT' })).change).toBe('updated');
    expect(upsertRule(added.rules, rule({ value: 'Project Phoenix' })).change).toBe('unchanged');
    expect(removeRule(added.rules, 'Project Phoenix')).toEqual([]);
  });

  test('case variants are separate rules, and both are masked', () => {
    const both = upsertRule(upsertRule([], rule({ value: 'Foo Bar' })).rules, rule({ value: 'foo bar' }));
    expect(both.change).toBe('added');
    expect(both.rules.map(one => one.value)).toEqual(['Foo Bar', 'foo bar']);
    const options = { ...parseConfig({}).matching, ...normalizedOptions(both.rules) };
    expect(maskText('Foo Bar and foo bar', options, {}).text).not.toMatch(/foo bar/i);
  });

  test('a saved case variant of an option value is masked too', () => {
    const merged = normalizeRules(mergedRules([{ value: 'Acme Corp' }], [rule({ value: 'ACME CORP' })]));
    const options = { ...parseConfig({}).matching, customValues: merged.values, rules: merged.rules };
    expect(maskText('ACME CORP and Acme Corp', options, {}).text).not.toMatch(/acme corp/i);
  });

  test('options win over stored rules for the same value', () => {
    const merged = normalizeRules(
      mergedRules(
        [{ value: 'Project Phoenix', label: 'OPTION' }],
        [rule({ value: 'Project Phoenix', label: 'STORED' })],
      ),
    );
    expect(merged.rules.get('project phoenix')?.label).toBe('OPTION');
  });

  test('order is oldest first, then by value', () => {
    const late = { ...rule({ value: 'Zeta Corp' }), addedAt: '2026-02-01T00:00:00.000Z' };
    const early = { ...rule({ value: 'Beta Corp' }), addedAt: '2026-01-01T00:00:00.000Z' };
    const same = { ...rule({ value: 'Alpha Corp' }), addedAt: '2026-01-01T00:00:00.000Z' };
    expect(sortRules([late, early, same]).map(one => one.value)).toEqual(['Alpha Corp', 'Beta Corp', 'Zeta Corp']);
  });

  test('store keys are fingerprints, never values', async () => {
    const key = await storeKeyFor(RULE_PREFIX, 'Project Phoenix');
    expect(key).toMatch(/^rule\.[a-f0-9]{64}$/);
    expect(key).not.toBe(await storeKeyFor(RULE_PREFIX, 'project PHOENIX'));
    expect(key).not.toContain('Phoenix');
    expect(isRuleKey(key)).toBe(true);
    expect(isRuleKey('ignored.abc')).toBe(false);
    expect(await fingerprint('a')).not.toBe(await fingerprint('b'));
  });

  test('previews show one character and the length', () => {
    expect(maskPreview('Project Phoenix')).toBe('P•••• (15)');
    expect(maskPreview('Project Phoenix')).not.toContain('Phoenix');
  });
});

describe('form labels', () => {
  test('rule_labels replaces the built-in list; bad entries are dropped', () => {
    expect(parseConfig({}).ruleLabels).toEqual(RULE_LABELS);
    expect(parseConfig({ rule_labels: 'vendor, TEAM, 1bad, team' }).ruleLabels).toEqual(['VENDOR', 'TEAM']);
    expect(parseConfig({ rule_labels: '1bad' }).ruleLabels).toEqual(RULE_LABELS);
  });

  test('CUSTOM first, then configured labels, then labels rules already use', () => {
    expect(formLabels(['VENDOR'], [{ label: 'TEAM' }, {}, { label: 'VENDOR' }])).toEqual(['CUSTOM', 'VENDOR', 'TEAM']);
  });
});

describe('import and export', () => {
  test('an export imports back to the same rules', () => {
    const stored = [
      rule({ value: 'Project Phoenix', label: 'PROJECT' }),
      rule({ value: 'Acme Labs', alias: 'CODENAME_X' }),
      rule({ value: 'c2VjcmV0dmFsdWU==' }),
    ];
    const parsed = parseImport(exportRules(stored, NOW));
    if ('error' in parsed) throw new Error(parsed.error);
    const summary = applyImport([], parsed.items, 'merge', NOW);
    expect(summary.rules.map(one => [one.value, one.label, one.alias])).toEqual(
      stored.map(one => [one.value, one.label, one.alias]),
    );
    expect(summary.added).toBe(3);
  });

  test('only structured JSON imports: plain text is refused, entries are never parsed', () => {
    expect(parseImport('Project Phoenix => PROJECT\nAcme Labs\n')).toEqual({
      error: 'The file is not a redact-restore-rules export (JSON).',
    });
    const parsed = parseImport(
      JSON.stringify({
        format: 'redact-restore-rules',
        version: 1,
        rules: [{ value: 'a => b == CODE_9' }, { value: 'ab' }, { label: 'NOVALUE' }, { value: 'Acme Labs' }],
      }),
    );
    if ('error' in parsed) throw new Error(parsed.error);
    const summary = applyImport([rule({ value: 'Acme Labs' })], parsed.items, 'merge', NOW);
    expect(summary.rules.map(one => one.value)).toEqual(['Acme Labs', 'a => b == CODE_9']);
    expect([summary.added, summary.unchanged, summary.invalid]).toEqual([1, 1, 2]);
  });

  test('imports check aliases against the option rules', () => {
    const summary = applyImport([], [{ value: 'Beta Group', alias: 'CODE_ONE' }], 'merge', NOW, [
      { value: 'Alpha Team', alias: 'CODE_ONE' },
    ]);
    expect([summary.added, summary.invalid]).toEqual([0, 1]);
  });

  test('merge keeps existing rules; replace drops them', () => {
    const existing = [rule({ value: 'Old Corp' })];
    expect(applyImport(existing, [{ value: 'New Corp' }], 'merge', NOW).rules.map(one => one.value)).toEqual([
      'Old Corp',
      'New Corp',
    ]);
    expect(applyImport(existing, [{ value: 'New Corp' }], 'replace', NOW).rules.map(one => one.value)).toEqual([
      'New Corp',
    ]);
  });

  test('foreign or newer files are refused', () => {
    expect(parseImport('{"format":"other","rules":[]}')).toEqual({
      error: 'The file is not a redact-restore-rules export.',
    });
    expect(parseImport('{"format":"redact-restore-rules","version":99,"rules":[]}')).toEqual({
      error: 'The file comes from a newer Redact Restore version.',
    });
    expect(parseImport('{not json')).toEqual({ error: 'The file is not a redact-restore-rules export (JSON).' });
  });

  test('paths under home are shown with ~ and expanded from ~', () => {
    expect(displayPath('/home/user/.claude/x.json', '/home/user')).toBe('~/.claude/x.json');
    expect(displayPath('/srv/x.json', '/home/user')).toBe('/srv/x.json');
    expect(displayPath('C:\\Users\\user\\x.json', 'C:\\Users\\user')).toBe('~\\x.json');
    expect(displayPath('c:/users/user/x.json', 'C:\\Users\\user')).toBe('~/x.json');
    expect(displayPath('/HOME/USER/x.json', '/home/user')).toBe('~/x.json');
    expect(displayPath('/srv/user2/x.json', '/srv/user')).toBe('/srv/user2/x.json');
    expect(expandHome('~/x.json', '/home/user/')).toBe('/home/user/x.json');
    expect(expandHome('x.json', '/home/user')).toBe('x.json');
  });
});
