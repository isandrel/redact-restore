// Placeholder formats, labels and aliases. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import { createScheme, DEFAULT_FORMAT, formatProblem, isUsableAlias, type ValueRule } from '../../hooks/placeholder.ts';
import { normalizeCustomValues, normalizeRules } from '../../hooks/matcher.ts';
import {
  createStreamRestorer,
  findPlaceholders,
  inputHasPlaceholder,
  maskText,
  restoreInput,
  unmaskText,
} from '../../hooks/privacy.ts';
import { parseConfig } from '../../hooks/config.ts';
import { hmacSha256Hex } from '../../hooks/hmac.ts';

const base = { customValues: ['Project Phoenix'], customCaseInsensitive: false, redactEmails: true };

describe('formats', () => {
  test('default keeps the original shape', () => {
    const token = createScheme().make('EMAIL');
    expect(token).toMatch(/^\{\{PRIVATE:EMAIL#[a-f0-9]{12}\}\}$/);
  });

  test('custom marks, label and id length', () => {
    const scheme = createScheme('{{{label}_{id}}}', 8);
    const token = scheme.make('PROJECT');
    expect(token).toMatch(/^\{\{PROJECT_[a-f0-9]{8}\}\}$/);
    expect(scheme.labelOf(token)).toBe('PROJECT');
    expect(findPlaceholders(`a ${token} b`, scheme)).toEqual([token]);
  });

  test('id length is clamped to 8..32', () => {
    expect(createScheme().idLength).toBe(12);
    expect(createScheme(DEFAULT_FORMAT, 2).idLength).toBe(8);
    expect(createScheme(DEFAULT_FORMAT, 99).idLength).toBe(32);
  });

  test('unusable formats are explained and fall back to the default', () => {
    expect(formatProblem('[{label}]')).toMatch(/\{id\}/);
    expect(formatProblem('{id}]')).toMatch(/start with literal text/);
    expect(formatProblem('PII {label} {id}')).toMatch(/whitespace/);
    expect(formatProblem('PII_{label}{id}')).toMatch(/between \{label\} and \{id\}/);
    expect(formatProblem('PII_{id}_{label}')).toMatch(/end with \{id\} or literal text/);
    expect(formatProblem('PII-{label}-{id}')).toBeUndefined();
    expect(formatProblem('<{id}{id}>')).toMatch(/exactly once/);
    expect(formatProblem('<{label}:{id}:{nope}>')).toMatch(/unknown field/);
    expect(formatProblem('<<{label}:{id}>>')).toBeUndefined();
    expect(createScheme('{id}').format).toBe(DEFAULT_FORMAT);
    expect(parseConfig({ placeholder_format: '{id}' }).formatProblem).toMatch(/literal text/);
  });

  test('masking and restoring round-trip in a custom format', () => {
    const placeholders = createScheme('<<{label}:{id}>>', 12);
    const masked = maskText('Mail alice@example.com about Project Phoenix', { ...base, placeholders }, {});
    expect(masked.text).toMatch(/^Mail <<EMAIL:[a-f0-9]{12}>> about <<CUSTOM:[a-f0-9]{12}>>$/);
    expect(unmaskText(masked.text, masked.additions, true, placeholders)).toBe(
      'Mail alice@example.com about Project Phoenix',
    );
    expect(() => unmaskText('<<CUSTOM:0123456789ab>>', {}, true, placeholders)).toThrow(/unknown/);
  });

  test('streaming holds a split placeholder in a custom format', () => {
    const placeholders = createScheme('{{{label}_{id}}}', 8);
    const masked = maskText('Project Phoenix', { ...base, placeholders }, {});
    const restorer = createStreamRestorer(masked.additions, placeholders);
    const pieces = ['x ', ...(masked.text.match(/.{1,3}/g) ?? []), ' y {not a token}'];
    expect(pieces.map(piece => restorer.push(0, piece)).join('') + restorer.flush(0)).toBe(
      'x Project Phoenix y {not a token}',
    );
  });

  test('tokens from an earlier format still restore after the format changes', () => {
    const old = maskText('Project Phoenix', base, {});
    expect(unmaskText(old.text, old.additions, true, createScheme('<<{label}:{id}>>'))).toBe('Project Phoenix');
  });
});

/** Matching options from structured rules, as the rules pane saves them. */
function structured(rules: readonly ValueRule[]) {
  const merged = normalizeRules(rules);
  return { ...parseConfig({}).matching, customValues: merged.values, rules: merged.rules };
}

describe('per-value rules', () => {
  test('option entries are plain values, never parsed', () => {
    const normalized = normalizeCustomValues([' Project Phoenix ', 'a => b == CODE_9', '', 'ab']);
    expect(normalized.values).toEqual(['Project Phoenix', 'a => b == CODE_9']);
    expect(normalized.rules.get('a => b == code_9')).toEqual({ value: 'a => b == CODE_9' });
    expect(normalized.tooShort).toBe(1);
  });

  test('aliases must not look like ordinary text', () => {
    expect(isUsableAlias('CODENAME_X', 'Project Phoenix')).toBe(true);
    expect(isUsableAlias('PX', 'Project Phoenix')).toBe(false);
    expect(isUsableAlias('phoenix', 'Project Phoenix')).toBe(false);
    expect(isUsableAlias('Project', 'Project Phoenix')).toBe(false);
    expect(isUsableAlias('TWO WORDS', 'Project Phoenix')).toBe(false);
  });

  test('a reused alias is counted and dropped; its value is still masked', () => {
    const normalized = normalizeRules([
      { value: 'Project Phoenix', alias: 'CODENAME_X' },
      { value: 'acme.internal', alias: 'CODENAME_X' },
    ]);
    expect(normalized.values).toEqual(['Project Phoenix', 'acme.internal']);
    expect(normalized.rules.get('acme.internal')).toEqual({ value: 'acme.internal' });
    expect(normalized.invalid).toBe(1);
  });

  test('label and alias in masking, restore and tool input', () => {
    const matching = structured([
      { value: 'Project Phoenix', label: 'PROJECT' },
      { value: 'acme.internal', alias: 'HOST_ALPHA' },
    ]);
    const masked = maskText('Project Phoenix on acme.internal', matching, {});
    expect(masked.text).toMatch(/^\{\{PRIVATE:PROJECT#[a-f0-9]{12}\}\} on HOST_ALPHA$/);
    expect(unmaskText(masked.text, masked.additions)).toBe('Project Phoenix on acme.internal');
    const input = { command: 'ping HOST_ALPHA' };
    expect(inputHasPlaceholder(input, masked.additions)).toBe(true);
    expect(restoreInput(input, masked.additions)).toEqual({ command: 'ping acme.internal' });
  });

  test('an alias is restored only as a whole word and never masked again', () => {
    const matching = structured([{ value: 'acme.internal', alias: 'HOST_ALPHA' }]);
    const masked = maskText('acme.internal', matching, {});
    expect(unmaskText('HOST_ALPHA2 HOST_ALPHA', masked.additions)).toBe('HOST_ALPHA2 acme.internal');
    expect(maskText('HOST_ALPHA', matching, masked.additions).text).toBe('HOST_ALPHA');
  });
});

describe('stable placeholder ids', () => {
  const KEY = 'ab'.repeat(32);

  test('HMAC-SHA-256 matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  test('stable: the same value and label give the same placeholder in a new session', () => {
    const matching = (key?: string) =>
      parseConfig({ custom_values: ['Project Phoenix'], placeholder_ids: 'stable' }, () => key).matching;
    const first = maskText('see Project Phoenix', matching(KEY), {});
    const second = maskText('Project Phoenix again', matching(KEY), {});
    expect(Object.keys(first.additions)).toEqual(Object.keys(second.additions));
    expect(Object.keys(first.additions)[0]).toMatch(/^\{\{PRIVATE:CUSTOM#[a-f0-9]{12}\}\}$/);
    // Another key, or no key loaded yet, gives a different (random) id.
    expect(Object.keys(maskText('Project Phoenix', matching('cd'.repeat(32)), {}).additions)).not.toEqual(
      Object.keys(first.additions),
    );
    expect(Object.keys(maskText('Project Phoenix', matching(undefined), {}).additions)).not.toEqual(
      Object.keys(first.additions),
    );
  });

  test('random is the default, and a key is ignored then', () => {
    const config = parseConfig({ custom_values: ['Project Phoenix'] }, () => KEY);
    expect(config.placeholderIds).toBe('random');
    const a = maskText('Project Phoenix', config.matching, {});
    const b = maskText('Project Phoenix', config.matching, {});
    expect(Object.keys(a.additions)).not.toEqual(Object.keys(b.additions));
  });

  test('a stable id already held by another value falls back to random', () => {
    const { matching } = parseConfig({ custom_values: ['Project Phoenix'], placeholder_ids: 'stable' }, () => KEY);
    const stable = Object.keys(maskText('Project Phoenix', matching, {}).additions)[0] ?? '';
    const masked = maskText('Project Phoenix', matching, { [stable]: 'Other Value' });
    const token = Object.keys(masked.additions)[0] ?? '';
    expect(token).not.toBe(stable);
    expect(masked.additions[token]).toBe('Project Phoenix');
  });
});
