// Built-in detectors: HIDE (must mask) and KEEP (must not) lists. All values are
// synthetic; key-shaped values are assembled at run time so the repository holds
// no secret-looking literal.
import { describe, expect, test } from 'claude-code/testing';
import {
  cnIdValid,
  DETECTORS,
  ibanValid,
  luhnValid,
  selectDetectors,
  shannonEntropy,
  usccValid,
} from '../../hooks/detectors.ts';
import { findPrivateMatches } from '../../hooks/matcher.ts';
import { maskText } from '../../hooks/privacy.ts';
import { parseConfig } from '../../hooks/config.ts';

const join = (...parts: string[]) => parts.join('');
const alnum = (n: number) => 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3'.repeat(8).slice(0, n);

function cnId(body17: string): string {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = weights.reduce((total, w, i) => total + w * Number(body17[i]), 0);
  return body17 + '10X98765432'.charAt(sum % 11);
}

function uscc(body17: string): string {
  const chars = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const sum = weights.reduce((total, w, i) => total + w * chars.indexOf(body17.charAt(i)), 0);
  return body17 + chars.charAt((31 - (sum % 31)) % 31);
}

function jwt(): string {
  const b64 = (value: string) => btoa(value).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64('{"sub":"synthetic-user","iat":1}')}.${alnum(43)}`;
}

const options = parseConfig({}).matching;
const labelsIn = (text: string) => findPrivateMatches(text, options).map(m => m.category);

// [label, text containing the secret, the exact secret part]
const HIDE: Array<[string, string, string]> = [
  ['ANTHROPIC_KEY', `key ${join('sk-', 'ant-api03-', alnum(40))}`, join('sk-', 'ant-api03-', alnum(40))],
  ['OPENAI_KEY', `OPENAI_API_KEY=${join('sk-', 'proj-', alnum(40))}`, join('sk-', 'proj-', alnum(40))],
  ['AWS_KEY', `id ${join('AK', 'IA', 'ZQ3X7WB2LM5R4TY6')}`, join('AK', 'IA', 'ZQ3X7WB2LM5R4TY6')],
  ['AWS_SECRET', `aws_secret_access_key = ${alnum(40)}`, alnum(40)],
  ['GITHUB_TOKEN', `token ${join('gh', 'p_', alnum(36))}`, join('gh', 'p_', alnum(36))],
  ['GITLAB_TOKEN', `${join('gl', 'pat-', alnum(20))}`, join('gl', 'pat-', alnum(20))],
  ['SLACK_TOKEN', `${join('xo', 'xb-', '1234567890-', alnum(24))}`, join('xo', 'xb-', '1234567890-', alnum(24))],
  ['STRIPE_KEY', `${join('sk', '_live_', alnum(24))}`, join('sk', '_live_', alnum(24))],
  ['GOOGLE_API_KEY', `${join('AI', 'za', alnum(35))}`, join('AI', 'za', alnum(35))],
  ['HF_TOKEN', `${join('hf', '_', alnum(34).replace(/\d/g, 'q'))}`, join('hf', '_', alnum(34).replace(/\d/g, 'q'))],
  ['NPM_TOKEN', `${join('np', 'm_', alnum(36))}`, join('np', 'm_', alnum(36))],
  ['ALIYUN_KEY', `${join('LT', 'AI', alnum(16))}`, join('LT', 'AI', alnum(16))],
  ['JWT', `Authorization: x ${jwt()}`, jwt()],
  ['PASSWORD', 'postgres://app:S3cr3t-Pa55@db.example.com:5432/app', 'S3cr3t-Pa55'],
  ['BEARER_TOKEN', `Authorization: Bearer ${alnum(32)}`, alnum(32)],
  ['SECRET', 'db_password = "Tr0ub4dor&3xq"', 'Tr0ub4dor&3xq'],
  ['SECRET', '数据库密码：Zx9!Lm2#Qa7', 'Zx9!Lm2#Qa7'],
  ['CARD', 'card 4111 1111 1111 1111 exp', '4111 1111 1111 1111'],
  ['IBAN', 'IBAN GB82 WEST 1234 5698 7654 32.', 'GB82 WEST 1234 5698 7654 32'],
  ['CN_ID', `身份证 ${cnId('11010519491231002')}`, cnId('11010519491231002')],
  ['CN_PHONE', '电话 138 0013 8000', '138 0013 8000'],
  ['CN_PHONE', '+86 13912345678', '+86 13912345678'],
  ['CN_USCC', `代码 ${uscc('91350100M000100Y4')}`, uscc('91350100M000100Y4')],
  ['IP', 'host 10.20.30.40 is down', '10.20.30.40'],
  ['US_SSN', 'SSN 078-05-1120', '078-05-1120'],
  ['PHONE', 'call +1 415 555 0100', '+1 415 555 0100'],
];

const KEEP = [
  'password = getPassword()',
  'token: ${API_TOKEN}',
  'apiKey = process.env.API_KEY',
  'const secret = config.secretValue',
  'the secret is out and the password policy changed',
  'import sklearn; sk-learn is a package',
  `placeholder ${join('gh', 'p_', 'x'.repeat(36))}`,
  `docs ${join('AK', 'IA', 'IOSFODNN7', 'EXAMPLE')}`,
  'postgres://user:${DB_PASS}@localhost/db and mysql://root:password@localhost',
  'Bearer ${token} and Bearer <token>',
  'card 4111 1111 1111 1112 fails Luhn',
  `id ${cnId('11010519491231002').slice(0, 17)}0 has a wrong check digit`,
  'timestamp 1717171717171 and order 19999999999',
  'sha a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 uuid 123e4567-e89b-12d3-a456-426614174000',
  'loopback 127.0.0.1 and 0.0.0.0',
  'call +1 555 0100 or 000-12-3456',
  'eyJhbGciOi.eyJzdWIiOi.invalidsignature (not a real JWT header)',
];

describe('validators', () => {
  test('checksums', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
    expect(cnIdValid(cnId('11010519491231002'))).toBe(true);
    expect(cnIdValid(cnId('11010519491331002'))).toBe(false);
    expect(usccValid(uscc('91350100M000100Y4'))).toBe(true);
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });
});

describe('detectors', () => {
  for (const [label, text, secret] of HIDE) {
    test(`hides ${label}: ${text.slice(0, 24)}…`, () => {
      const masked = maskText(text, options, {});
      expect(masked.text).not.toContain(secret);
      expect(masked.text).toContain(`{{PRIVATE:${label}#`);
      expect(Object.values(masked.additions)).toContain(secret);
    });
  }

  for (const text of KEEP) {
    test(`keeps: ${text.slice(0, 40)}`, () => {
      expect(labelsIn(text)).toEqual([]);
    });
  }

  test('only the password of a connection string is masked', () => {
    const masked = maskText('postgres://app:S3cr3t-Pa55@db.example.com/app', options, {});
    expect(masked.text).toMatch(/^postgres:\/\/app:\{\{PRIVATE:PASSWORD#[a-f0-9]{12}\}\}@db\.example\.com\/app$/);
  });

  test('PEM private keys, whole or cut off', () => {
    const body = alnum(64);
    const whole = `x\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n-----END RSA PRIVATE KEY-----\ny`;
    expect(maskText(whole, options, {}).text).toMatch(/^x\n\{\{PRIVATE:PRIVATE_KEY#[a-f0-9]{12}\}\}\ny$/);
    const cut = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n${body}`;
    expect(maskText(cut, options, {}).text).toMatch(/^\{\{PRIVATE:PRIVATE_KEY#[a-f0-9]{12}\}\}$/);
  });

  test('every detector stays fast on 1 MB of awkward input', () => {
    const blob = [
      '1'.repeat(5000),
      'sk-'.repeat(2000),
      'a@b'.repeat(2000),
      '://'.repeat(2000),
      'password='.repeat(2000),
      'eyJ'.repeat(2000),
      '-----BEGIN PRIVATE KEY-----\n',
      'A'.repeat(300_000),
    ]
      .join(' ')
      .repeat(2)
      .slice(0, 1_000_000);
    const started = Date.now();
    for (const detector of DETECTORS) detector.find(blob);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('selection', () => {
  test('defaults, groups, enable and disable', () => {
    const ids = (enable: string[], disable: string[]) => selectDetectors(enable, disable).detectors.map(d => d.id);
    expect(ids([], [])).toContain('cn_id');
    for (const id of ['us_ssn', 'phone', 'ipv4']) expect(ids([], [])).toContain(id);
    expect(ids([], ['network'])).not.toContain('ipv4');
    expect(ids(['ipv4'], ['network'])).not.toContain('ipv4');
    expect(ids(['all'], ['cn'])).not.toContain('cn_phone');
    expect(ids([], ['secrets'])).not.toContain('github_token');
    expect(selectDetectors(['nope'], []).unknown).toEqual(['nope']);
  });

  test('options turn detectors on and off', () => {
    expect(labelsIn('10.20.30.40')).toEqual(['IP']);
    expect(findPrivateMatches('10.20.30.40', parseConfig({ disable_detectors: 'ipv4' }).matching)).toEqual([]);
    expect(findPrivateMatches('138 0013 8000', parseConfig({ disable_detectors: 'cn_phone' }).matching)).toEqual([]);
  });
});
