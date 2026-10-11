// Regressions from the pre-publish review: each case leaked or misbehaved before
// its fix. Synthetic values only; key-shaped values are built at run time.
import { describe, expect, test } from 'claude-code/testing';
import { findPrivateMatches } from '../../hooks/matcher.ts';
import { createStreamRestorer, inputHasPlaceholder, maskText, unmaskText } from '../../hooks/privacy.ts';
import { createScheme } from '../../hooks/placeholder.ts';
import { DEFAULT_POLICY, toolAction } from '../../hooks/policy.ts';
import { parseConfig } from '../../hooks/config.ts';

const options = parseConfig({ custom_values: ['Project Phoenix'] }).matching;
const varied = (n: number) => {
  const chars = 'q7W2e9R4t1Y8u3I6o5P0aSdFgHjKlZxCvBnM';
  let out = '';
  for (let i = 0; out.length < n; i += 1) out += chars.charAt((i * 7 + Math.floor(i / 36)) % chars.length);
  return out;
};

describe('long secrets are masked whole', () => {
  test('a 717-character session token in an assignment', () => {
    const token = varied(717);
    const masked = maskText(`aws_session_token = ${token}\n`, options, {});
    expect(masked.text).toMatch(/^aws_session_token = \{\{PRIVATE:SECRET#[a-f0-9]{12}\}\}\n$/);
  });

  test('a 900-character bearer token', () => {
    const token = varied(900);
    expect(maskText(`Authorization: Bearer ${token}`, options, {}).text).not.toContain(token.slice(500, 520));
  });

  test('a gitleaks token longer than the keyword window', () => {
    const token = `${['ops', '_eyJ'].join('')}${varied(1400)}`;
    const masked = maskText(`export OP_SERVICE_ACCOUNT_TOKEN=${token}\n`, options, {});
    expect(masked.text).not.toContain(token.slice(1200, 1220));
  });

  test('a JSON-escaped private key cut off before its END line', () => {
    const body = varied(64);
    const json = `{"private_key": "-----BEGIN PRIVATE KEY-----\\n${body}\\n${body}\\n${body.slice(0, 40)}`;
    const masked = maskText(json, options, {});
    expect(masked.text).not.toContain(body.slice(0, 20));
  });
});

describe('overlapping matches are merged, not dropped', () => {
  test('a custom value running into an email', () => {
    const masked = maskText('owner: Project Phoenix-ops@corp.example', options, {});
    expect(masked.text).toMatch(/^owner: \{\{PRIVATE:CUSTOM#[a-f0-9]{12}\}\}$/);
    expect(findPrivateMatches(masked.text, options, [], Object.keys(masked.additions))).toEqual([]);
    expect(unmaskText(masked.text, masked.additions)).toBe('owner: Project Phoenix-ops@corp.example');
  });
});

describe('remote and model-bound tools keep placeholders', () => {
  test('built-in keep list', () => {
    for (const tool of ['RemoteTrigger', 'Workflow', 'CronCreate', 'SendFeedback', 'PushNotification', 'Artifact']) {
      expect(toolAction(tool, DEFAULT_POLICY)).toBe('keep');
    }
  });
});

describe('placeholder formats', () => {
  test('streaming restores a {{…}} placeholder split at every position', () => {
    const placeholders = createScheme('{{{label}_{id}}}', 8);
    const masked = maskText('Project Phoenix', { ...options, placeholders }, {});
    const text = `a ${masked.text} b`;
    for (let cut = 1; cut < text.length; cut += 1) {
      const restorer = createStreamRestorer(masked.additions, placeholders);
      const out = restorer.push(0, text.slice(0, cut)) + restorer.push(0, text.slice(cut)) + restorer.flush(0);
      expect(out).toBe('a Project Phoenix b');
    }
  });

  test('a format with letters at its edges restores inside a word', () => {
    const placeholders = createScheme('PII{label}x{id}Z', 8);
    const masked = maskText('Project Phoenix', { ...options, placeholders }, {});
    const input = `x${masked.text}y`;
    expect(inputHasPlaceholder({ command: input }, masked.additions, placeholders)).toBe(true);
    expect(unmaskText(input, masked.additions, true, placeholders)).toBe('xProject Phoenixy');
  });
});
