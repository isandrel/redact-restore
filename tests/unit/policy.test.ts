// Restoration policy and tool-input walker. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import {
  DEFAULT_POLICY,
  matchesPattern,
  parsePatternList,
  toolAction,
  type RestorePolicy,
} from '../../hooks/policy.ts';
import { inputHasPlaceholder, maskText, restoreInput } from '../../hooks/privacy.ts';
import { parseConfig } from '../../hooks/config.ts';

const policy = (overrides: Partial<RestorePolicy>): RestorePolicy => ({ ...DEFAULT_POLICY, ...overrides });

describe('patterns', () => {
  test('exact names and * globs', () => {
    expect(matchesPattern('Bash', 'Bash')).toBe(true);
    expect(matchesPattern('BashOutput', 'Bash')).toBe(false);
    expect(matchesPattern('mcp__remote__search', 'mcp__remote__*')).toBe(true);
    expect(matchesPattern('mcp__local__search', 'mcp__remote__*')).toBe(false);
    expect(matchesPattern('mcp__a__b', '*__b')).toBe(true);
    expect(matchesPattern('a.b', 'a*b')).toBe(true);
    expect(matchesPattern('axb', 'a.b')).toBe(false);
  });

  test('lists split on commas and newlines, blanks dropped', () => {
    expect(parsePatternList(' Agent, WebFetch ,\nmcp__x__*,, ')).toEqual(['Agent', 'WebFetch', 'mcp__x__*']);
    expect(parsePatternList('')).toEqual([]);
  });
});

describe('tool actions', () => {
  test('default: local tools restore, model-bound tools keep placeholders', () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Grep', 'Read', 'mcp__local__query']) {
      expect(toolAction(tool, DEFAULT_POLICY)).toBe('restore');
    }
    for (const tool of ['Agent', 'Task', 'WebFetch', 'WebSearch', 'SendMessage', 'Skill']) {
      expect(toolAction(tool, DEFAULT_POLICY)).toBe('keep');
    }
  });

  test('files mode restores file tools only', () => {
    const files = policy({ mode: 'files' });
    expect(toolAction('Edit', files)).toBe('restore');
    expect(toolAction('Bash', files)).toBe('keep');
  });

  test('none mode denies file tools and keeps the rest', () => {
    const none = policy({ mode: 'none' });
    expect(toolAction('Write', none)).toBe('deny');
    expect(toolAction('Bash', none)).toBe('keep');
  });

  test('keep_tools adds to the built-in list and wins over restoration and denial', () => {
    const extra = policy({ keepTools: ['mcp__remote__*'] });
    expect(toolAction('mcp__remote__post', extra)).toBe('keep');
    expect(toolAction('WebFetch', extra)).toBe('keep');
    expect(toolAction('Write', policy({ mode: 'none', keepTools: ['Write'] }))).toBe('keep');
  });

  test('built-in model-bound tools cannot be removed by options', () => {
    expect(toolAction('Agent', parseConfig({ keep_tools: '' }).restore)).toBe('keep');
    expect(toolAction('Write', parseConfig({ restore_mode: 'none', deny_unrestored_tools: '' }).restore)).toBe('deny');
  });

  test('extra deny list adds to the file tools', () => {
    const extra = policy({ mode: 'files', denyUnrestoredTools: ['Bash'] });
    expect(toolAction('Bash', extra)).toBe('deny');
    expect(toolAction('Grep', extra)).toBe('keep');
  });
});

describe('tool input walker', () => {
  const config = { customValues: ['Project Phoenix'], customCaseInsensitive: false, redactEmails: true };
  const masked = maskText('Project Phoenix alice@example.com', config, {});
  const [custom = '', email = ''] = masked.text.split(' ');

  test('restores nested strings and leaves keys, numbers and unchanged objects alone', () => {
    const untouched = { flag: true, n: 3 };
    const input = { query: `name:${custom}`, filters: [{ to: email }, 'plain'], untouched };
    const restored = restoreInput(input, masked.additions);
    expect(restored).toEqual({
      query: 'name:Project Phoenix',
      filters: [{ to: 'alice@example.com' }, 'plain'],
      untouched,
    });
    expect(restored.untouched).toBe(untouched);
    expect(input.query).toBe(`name:${custom}`);
  });

  test('returns the same object when there is nothing to restore', () => {
    const input = { command: 'ls' };
    expect(restoreInput(input, masked.additions)).toBe(input);
    expect(inputHasPlaceholder(input)).toBe(false);
    expect(inputHasPlaceholder({ deep: [[{ x: custom }]] })).toBe(true);
  });

  test('unknown placeholders throw', () => {
    expect(() => restoreInput({ command: '{{PRIVATE:CUSTOM#0123456789ab}}' }, {})).toThrow(
      /unknown private placeholder/,
    );
  });
});

describe('restore options', () => {
  test('defaults mirror plugin.json', () => {
    expect(parseConfig({}).restore).toEqual(DEFAULT_POLICY);
  });

  test('options set the mode and the extra lists', () => {
    const parsed = parseConfig({ restore_mode: 'files', keep_tools: 'mcp__remote__*', deny_unrestored_tools: '' });
    expect(parsed.restore).toEqual({ mode: 'files', keepTools: ['mcp__remote__*'], denyUnrestoredTools: [] });
  });

  test('an unknown mode falls back to the default', () => {
    expect(parseConfig({ restore_mode: 'everything' }).restore.mode).toBe('all');
  });
});
