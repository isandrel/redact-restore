// Pure matcher/tokenizer tests. Synthetic values only: never put real secrets here.
import { describe, expect, test } from 'claude-code/testing';
import { findEmails, findPrivateMatches, normalizeCustomValues } from '../../hooks/matcher.ts';
import {
  auditMessages,
  createAuditMemo,
  createStreamRestorer,
  findPlaceholders,
  maskContentBlocks,
  maskText,
  unmaskText,
  withholdContentBlocks,
  type ContentBlock,
} from '../../hooks/privacy.ts';
import { parseConfig } from '../../hooks/config.ts';

const config = {
  customValues: ['Project Phoenix', 'a.b[c]', 'acme.internal'],
  customCaseInsensitive: false,
  redactEmails: true,
} as const;
const media = { allowMedia: false } as const;
const TOKEN = /^\{\{PRIVATE:(CUSTOM|EMAIL)#[a-f0-9]{12}\}\}$/;

describe('matching', () => {
  test('exact values, regex-looking literals, and emails are masked', () => {
    const source = 'Project Phoenix at acme.internal and a.b[c]: alice@example.com';
    const result = maskText(source, config, {});
    expect(result.text).not.toMatch(/Project Phoenix|acme\.internal|a\.b\[c\]|alice@example\.com/);
    expect(unmaskText(result.text, result.additions, true)).toBe(source);
    for (const token of findPlaceholders(result.text)) expect(token).toMatch(TOKEN);
  });

  test('regex metacharacters in a literal do not act as a pattern', () => {
    expect(findPrivateMatches('aXb[c] abc', config)).toHaveLength(0);
  });

  test('reuses the existing token for the same value', () => {
    const first = maskText('Project Phoenix and Project Phoenix', config, {});
    expect(Object.keys(first.additions)).toHaveLength(1);
    const second = maskText('Project Phoenix', config, first.additions);
    expect(first.text.startsWith(second.text)).toBe(true);
    expect(second.additions).toEqual({});
  });

  test('tokens are unpredictable per mapping', () => {
    const a = maskText('Project Phoenix', config, {});
    const b = maskText('Project Phoenix', config, {});
    expect(a.text).not.toBe(b.text);
  });

  test('case sensitive by default; optional insensitive matching', () => {
    expect(findPrivateMatches('project phoenix', config)).toHaveLength(0);
    expect(findPrivateMatches('project phoenix', { ...config, customCaseInsensitive: true })).toHaveLength(1);
  });

  test('does not scan previously-created placeholders', () => {
    const result = maskText('Project Phoenix', config, {});
    const again = maskText(result.text, { ...config, customValues: ['PRIVATE', 'CUSTOM'] }, result.additions);
    expect(again.text).toBe(result.text);
    expect(again.additions).toEqual({});
  });

  test('longer custom value takes precedence over an overlapping shorter one', () => {
    const matches = findPrivateMatches('Project Phoenix', { ...config, customValues: ['Project', 'Project Phoenix'] });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toBe('Project Phoenix');
  });

  test('a custom domain inside an email is covered by the email token', () => {
    const result = maskText('mail bob@acme.internal', config, {});
    expect(result.text).not.toMatch(/acme|bob/);
    expect(Object.keys(result.additions)).toHaveLength(1);
  });

  test('values already in the vault stay masked after the detector is removed', () => {
    const first = maskText('Project Phoenix', config, {});
    const later = maskText('echo: Project Phoenix', { ...config, customValues: [] }, first.additions);
    expect(later.text).not.toMatch(/Project Phoenix/);
    expect(later.additions).toEqual({});
  });

  test('empty, blank, short and duplicate custom values are normalized', () => {
    expect(normalizeCustomValues(['', '  ', 'ab', ' Project Phoenix ', 'Project Phoenix'])).toMatchObject({
      values: ['Project Phoenix'],
      tooShort: 1,
      invalid: 0,
    });
  });
});

describe('email scanner', () => {
  test('matches what the reference regex matches', () => {
    const reference = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const samples = [
      'alice@example.com',
      'x a.b+c@sub.example.co.uk.',
      'a@x.example1',
      'a@x.example.x1',
      'x@a.example@b.test',
      '@nolocal.example',
      'name@nodot',
      'two a@x.test and c@y.test',
      'a@.com',
      'a@b..example',
    ];
    for (const sample of samples) {
      const expected = [...sample.matchAll(reference)].map(m => [m.index, m.index + m[0].length]);
      expect(findEmails(sample).map(m => [m.start, m.end])).toEqual(expected);
    }
  });

  test('stays linear on long runs without an @', () => {
    const blob = 'A'.repeat(400_000) + '@' + 'b'.repeat(400_000);
    const started = Date.now();
    expect(findEmails(blob)).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('restoration', () => {
  test('unknown private token is refused in strict mode and kept otherwise', () => {
    const unknown = '{{PRIVATE:CUSTOM#0123456789ab}}';
    expect(() => unmaskText(unknown, {}, true)).toThrow(/unknown private placeholder/);
    expect(unmaskText(unknown, {})).toBe(unknown);
  });

  test('a malformed placeholder is left alone', () => {
    expect(findPlaceholders('{{PRIVATE:CUSTOM#XYZ}}')).toHaveLength(0);
  });
});

describe('stream restoration', () => {
  const masked = maskText('Project Phoenix', config, {});
  const token = masked.text;

  test('restores a placeholder split across many chunks', () => {
    const restorer = createStreamRestorer(masked.additions);
    const pieces = ['Hello ', ...(token.match(/.{1,5}/g) ?? []), '!'];
    const out = pieces.map(piece => restorer.push(0, piece)).join('') + restorer.flush(0);
    expect(out).toBe('Hello Project Phoenix!');
  });

  test('does not hold ordinary braces', () => {
    const restorer = createStreamRestorer(masked.additions);
    expect(restorer.push(0, 'see {a} and {')).toBe('see {a} and ');
    expect(restorer.push(0, 'b}')).toBe('{b}');
  });

  test('keeps unknown placeholders and releases a dangling prefix on flush', () => {
    const restorer = createStreamRestorer({});
    const unknown = '{{PRIVATE:CUSTOM#0123456789ab}}';
    expect(restorer.push(0, unknown)).toBe(unknown);
    expect(restorer.push(1, 'end {{PRIVATE:EM')).toBe('end ');
    expect(restorer.pending()).toEqual([1]);
    expect(restorer.flush(1)).toBe('{{PRIVATE:EM');
  });
});

describe('content blocks', () => {
  test('masks text and tool results, leaves pinned kinds, withholds media', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Project Phoenix' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo alice@example.com' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'alice@example.com' },
      {
        type: 'tool_result',
        tool_use_id: 't2',
        content: [
          { type: 'text', text: 'acme.internal' },
          { type: 'image', source: {} },
        ],
      },
      { type: 'image', source: {} },
    ];
    const result = maskContentBlocks(blocks, config, {}, media);
    const serialized = JSON.stringify(result.content.filter(block => block.type !== 'tool_use'));
    expect(serialized).not.toMatch(/Project Phoenix|alice@example\.com|acme\.internal/);
    expect(result.content[1]).toBe(blocks[1]);
    expect(result.withheldMedia).toBe(2);
    expect(serialized).not.toMatch(/"type":"image"/);
  });

  test('allow_media keeps media blocks', () => {
    const result = maskContentBlocks([{ type: 'image', source: {} }], config, {}, { allowMedia: true });
    expect(result.content[0]?.type).toBe('image');
  });

  test('withholding replaces every text, tool result and media block', () => {
    const out = withholdContentBlocks([
      { type: 'text', text: 'Project Phoenix' },
      { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x' }] },
      { type: 'document', source: {} },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/Project Phoenix|document/);
  });
});

describe('outbound audit', () => {
  const masked = maskText('Project Phoenix', config, {});

  test('passes masked user content and ignores model-authored content', () => {
    expect(
      auditMessages(
        [
          { role: 'user', content: [{ type: 'text', text: masked.text }] },
          { role: 'assistant', content: [{ type: 'tool_use', input: { x: 'alice@example.com' } }] },
        ],
        config,
        masked.additions,
        media,
      ),
    ).toHaveLength(0);
  });

  test('flags unmasked text, tool results, vault values and media', () => {
    const findings = auditMessages(
      [
        { role: 'user', content: [{ type: 'text', text: 'alice@example.com' }] },
        { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Project Phoenix' }] }] },
        { role: 'user', content: [{ type: 'image', source: {} }] },
      ],
      { ...config, customValues: [] },
      masked.additions,
      media,
    );
    expect(findings.map(f => f.reason)).toEqual(['EMAIL', 'CUSTOM', 'MEDIA']);
    expect(JSON.stringify(findings)).not.toMatch(/alice|Phoenix/);
  });
});

describe('outbound audit memo', () => {
  test('text found clean is checked again against values learned later', () => {
    const plain = { ...config, customValues: [], redactEmails: false, detectors: [] };
    const memo = createAuditMemo();
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'x Phoenix Example' }] }];
    expect(auditMessages(messages, plain, {}, media, memo)).toEqual([]);
    const later = { '{{PRIVATE:CUSTOM#000000000001}}': 'Phoenix Example' };
    expect(auditMessages(messages, plain, later, media, memo).map(f => f.reason)).toEqual(['CUSTOM']);
  });
});

describe('outbound audit scope', () => {
  test('skips engine attachments, which prompt.attachment masks at send time', () => {
    expect(
      auditMessages(
        [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '<system-reminder>\n# Environment\n - /drive/alice@example.com/x\n</system-reminder>',
              },
            ],
          },
        ],
        config,
        {},
        media,
      ),
    ).toHaveLength(0);
  });

  test('still audits plain user text that merely mentions a reminder', () => {
    expect(
      auditMessages(
        [{ role: 'user', content: [{ type: 'text', text: 'see <system-reminder> alice@example.com' }] }],
        config,
        {},
        media,
      ),
    ).toHaveLength(1);
  });
});

describe('config', () => {
  test('defaults: masking on, restoration on, media and audit safe', () => {
    const parsed = parseConfig({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.matching.redactEmails).toBe(true);
    expect(parsed.restore.mode).toBe('all');
    expect(parsed.allowMedia).toBe(false);
    expect(parsed.outboundAudit).toBe(true);
  });

  test('accepts a single string or a list of custom values', () => {
    expect(parseConfig({ custom_values: 'Project Phoenix' }).matching.customValues).toEqual(['Project Phoenix']);
    expect(parseConfig({ custom_values: ['Project Phoenix', 'x'] }).ignoredShortValues).toBe(1);
  });
});
