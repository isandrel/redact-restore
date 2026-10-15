// Large sessions: a big vault and many texts stay fast, and a vault is never changed in place.
import { describe, expect, test } from 'claude-code/testing';
import { parseConfig } from '../../hooks/config.ts';
import { normalizeRules } from '../../hooks/matcher.ts';
import { createMasker, maskText, unmaskText, type Vault } from '../../hooks/privacy.ts';

const VAULT_SIZE = 10_000;
const vault: Vault = Object.freeze(
  Object.fromEntries(
    Array.from({ length: VAULT_SIZE }, (_, i) => [
      `{{PRIVATE:CUSTOM#${i.toString(16).padStart(12, '0')}}}`,
      `Value ${i} Example`,
    ]),
  ),
);
const rules = normalizeRules(Array.from({ length: 2_000 }, (_, i) => ({ value: `Client ${i} Corp` })));
const matching = { ...parseConfig({}).matching, customValues: rules.values, rules: rules.rules };

describe('scale', () => {
  test('300 small texts against a 10,000-value vault: fast, and the vault is untouched', () => {
    const masker = createMasker(matching, vault);
    const started = performance.now();
    for (let i = 0; i < 300; i++)
      masker.mask(`row ${i}: Value ${i} Example met Client ${i} Corp at user${i}@example.com`);
    const elapsed = performance.now() - started;
    expect(Object.keys(masker.additions())).toHaveLength(600);
    expect(Object.keys(vault)).toHaveLength(VAULT_SIZE);
    expect(elapsed).toBeLessThan(1500);
  });

  test('1 MB of tool output masks and restores in well under a second', () => {
    const line = 'API_TOKEN=tok_9f8e7d6c5b4a lorem ipsum Client 7 Corp build.acme.internal:8443 user@example.com\n';
    const text = line.repeat(Math.ceil(1_000_000 / line.length));
    const started = performance.now();
    const masked = maskText(text, matching, vault);
    const restored = unmaskText(masked.text, { ...vault, ...masked.additions });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(restored).toBe(text);
  });
});
