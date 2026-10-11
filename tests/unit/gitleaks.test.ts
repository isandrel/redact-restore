// Vendored gitleaks rules: they load in the engine's environment, catch providers
// the built-ins do not, stay quiet on ordinary code, and stay fast. Key-shaped
// fixtures are assembled at run time.
import { describe, expect, test } from 'claude-code/testing';
import { gitleaksRuleCount, selectDetectors } from '../../hooks/detectors.ts';
import { GITLEAKS_RULES, GITLEAKS_VERSION } from '../../hooks/vendor/gitleaks-rules.ts';
import { findPrivateMatches } from '../../hooks/matcher.ts';
import { maskText } from '../../hooks/privacy.ts';
import { parseConfig } from '../../hooks/config.ts';

const join = (...parts: string[]) => parts.join('');
const hex = (n: number) => '3f9a1c7e5b2d8046'.repeat(8).slice(0, n);
const alnum = (n: number) => 'q7w2e9r4t1y8u3i6o5p0a'.repeat(8).slice(0, n);
const options = parseConfig({}).matching;

describe('gitleaks table', () => {
  test('pinned version and every converted rule compiles here', () => {
    expect(GITLEAKS_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(GITLEAKS_RULES.length).toBeGreaterThan(200);
    expect(gitleaksRuleCount()).toBe(GITLEAKS_RULES.length);
  });

  test('labels are valid placeholder labels', () => {
    for (const rule of GITLEAKS_RULES) expect(rule.label).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
  });
});

describe('gitleaks detection', () => {
  const HIDE: Array<[string, string]> = [
    ['SHOPIFY_ACCESS_TOKEN', join('shp', 'at_', hex(32))],
    ['LINEAR_API_KEY', join('lin', '_api_', alnum(40))],
    ['DIGITALOCEAN_PAT', join('dop', '_v1_', hex(64))],
    ['DOPPLER_API_TOKEN', join('dp', '.pt.', alnum(43))],
  ];
  for (const [label, secret] of HIDE) {
    test(`hides ${label}`, () => {
      const masked = maskText(`token: ${secret}\n`, options, {});
      expect(masked.text).not.toContain(secret);
      expect(masked.text).toContain(`{{PRIVATE:${label}#`);
    });
  }

  test('built-in detectors keep their label where both match', () => {
    const token = join('gh', 'p_', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2');
    expect(findPrivateMatches(`x ${token} y`, options).map(m => m.category)).toEqual(['GITHUB_TOKEN']);
  });

  test('quiet on ordinary code and docs', () => {
    const code = [
      'const apiKey = process.env.API_KEY;',
      'token = request.headers.get("Authorization")',
      'export const accessKeyId = config.aws.accessKeyId',
      'password: ${{ secrets.DB_PASSWORD }}',
      'curl -H "Authorization: Bearer $TOKEN" https://api.example.com',
      'key = "changeme"',
      'sha256 a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 build 2026.10.11',
    ];
    for (const line of code) expect(findPrivateMatches(line, options)).toEqual([]);
  });

  test('generic-api-key is off unless enabled by name', () => {
    const line = 'service_auth_value = "Zt8kQ2mN7vB4xC9pL3rS"';
    expect(findPrivateMatches(line, parseConfig({ disable_detectors: 'secret_assignment' }).matching)).toEqual([]);
    const enabled = parseConfig({
      enable_detectors: 'gitleaks.generic-api-key',
      disable_detectors: 'secret_assignment',
    });
    expect(findPrivateMatches(line, enabled.matching).map(m => m.category)).toEqual(['GENERIC_API_KEY']);
  });

  test('the whole table can be turned off, or one rule', () => {
    const ids = (enable: string[], disable: string[]) => selectDetectors(enable, disable).detectors.map(d => d.id);
    expect(ids([], [])).toContain('gitleaks');
    expect(ids([], ['gitleaks'])).not.toContain('gitleaks');
    const secret = join('shp', 'at_', hex(32));
    expect(
      findPrivateMatches(secret, parseConfig({ disable_detectors: 'gitleaks.shopify-access-token' }).matching),
    ).toEqual([]);
    expect(selectDetectors([], ['gitleaks.no-such-rule']).unknown).toEqual(['gitleaks.no-such-rule']);
  });

  test('1 MB of keyword-heavy text stays fast', () => {
    const keywords = [...new Set(GITLEAKS_RULES.flatMap(rule => rule.keywords))].slice(0, 300).join('=x ');
    const blob = `${keywords} ${'a'.repeat(200_000)} `.repeat(5).slice(0, 1_000_000);
    const started = Date.now();
    findPrivateMatches(blob, options);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
