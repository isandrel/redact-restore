// Scan candidates. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import {
  collectCandidates,
  countByLabel,
  isEnvFile,
  isMasked,
  packageAuthor,
  parseEnvFile,
  parseRemotes,
  triage,
} from '../../hooks/scan.ts';
import { parseConfig } from '../../hooks/config.ts';
import { fingerprint } from '../../hooks/rules.ts';

describe('sources', () => {
  test('.env files, not their examples', () => {
    expect(['.env', '.env.local', '.env.production'].every(isEnvFile)).toBe(true);
    expect(['.env.example', '.env.sample', '.env.template', 'env', '.envrc'].some(isEnvFile)).toBe(false);
  });

  test('dotenv values: export, quotes and comments', () => {
    const pairs = parseEnvFile(
      [
        '# comment',
        'export DB_HOST=db.acme.internal # primary',
        'API_TOKEN="tok en"',
        "NAME='Acme Labs'",
        'BAD LINE',
      ].join('\n'),
    );
    expect(pairs).toEqual([
      { key: 'DB_HOST', value: 'db.acme.internal' },
      { key: 'API_TOKEN', value: 'tok en' },
      { key: 'NAME', value: 'Acme Labs' },
    ]);
  });

  test('remote URLs in https, ssh and scp forms', () => {
    const remotes = parseRemotes(
      [
        'origin\thttps://github.com/octo-org/widget.git (fetch)',
        'corp\tgit@git.acme.internal:platform/billing.git (push)',
        'other\tssh://git@code.acme.internal:2222/team/tools (fetch)',
      ].join('\n'),
    );
    expect(remotes).toEqual([
      { host: 'github.com', owner: 'octo-org', repo: 'widget' },
      { host: 'git.acme.internal', owner: 'platform', repo: 'billing' },
      { host: 'code.acme.internal', owner: 'team', repo: 'tools' },
    ]);
    expect(
      parseRemotes(
        [
          'a\thttps://dev.azure.com/acme-org/proj/_git/billing (fetch)',
          'b\tgit@ssh.dev.azure.com:v3/acme-org/proj/billing (fetch)',
          'c\thttps://gitlab.acme.internal/group/sub/widget.git (fetch)',
        ].join('\n'),
      ),
    ).toEqual([
      { host: 'dev.azure.com', owner: 'acme-org', repo: 'billing' },
      { host: 'ssh.dev.azure.com', owner: 'acme-org', repo: 'billing' },
      { host: 'gitlab.acme.internal', owner: 'group', repo: 'widget' },
    ]);
  });

  test('package author in string and object form', () => {
    expect(packageAuthor('{"author":"Alice Example <alice@example.com> (https://example.com)"}')).toEqual({
      name: 'Alice Example',
      email: 'alice@example.com',
    });
    expect(packageAuthor('{"author":{"name":"Bob Example"}}')).toEqual({ name: 'Bob Example' });
    expect(packageAuthor('not json')).toEqual({});
  });
});

describe('candidates', () => {
  const found = collectCandidates({
    gitName: 'Alice Example\n',
    gitEmail: 'alice@example.com\n',
    remotes:
      'origin\tgit@git.acme.internal:platform/billing.git (fetch)\nhub\thttps://github.com/octo-org/widget.git (fetch)',
    logAuthors:
      'Alice Example\u0000alice@example.com\nci-bot[bot]\u0000ci-bot@example.com\nBob Example\u0000bob@example.com',
    hostname: 'alices-laptop.local\n',
    home: '/Users/alice',
    envFiles: [{ name: '.env', text: 'DB_PASSWORD=hunter2hunter2\nDEBUG=true\nPORT=8080\nURL=${BASE}/x\n' }],
    packageJson: '{"author":"Carol Example"}',
  });

  test('each source, labeled, with no repeats or trivial values', () => {
    expect(found.map(one => [one.value, one.label, one.source])).toEqual([
      ['Alice Example', 'NAME', 'git config user.name'],
      ['alice@example.com', 'EMAIL', 'git config user.email'],
      ['git.acme.internal', 'HOST', 'git remote host'],
      ['platform', 'ORG', 'git remote owner'],
      ['billing', 'PROJECT', 'git remote repository'],
      ['octo-org', 'ORG', 'git remote owner'],
      ['Bob Example', 'NAME', 'git log author'],
      ['bob@example.com', 'EMAIL', 'git log author'],
      ['Carol Example', 'NAME', 'package.json author'],
      ['alices-laptop', 'HOST', 'computer name'],
      ['alice', 'USER', 'home folder name'],
      ['hunter2hunter2', 'SECRET', '.env (DB_PASSWORD)'],
    ]);
  });

  test('generic account names are skipped', () => {
    expect(collectCandidates({ home: '/home/runner' })).toEqual([]);
    expect(collectCandidates({ home: 'C:\\Users\\alice' }).map(one => one.value)).toEqual(['alice']);
  });

  test('counts by label never carry values', () => {
    const summary = countByLabel(found);
    expect(summary).toBe('3 NAME, 2 EMAIL, 2 HOST, 2 ORG, 1 PROJECT, 1 USER, 1 SECRET');
    for (const candidate of found) expect(summary).not.toContain(candidate.value);
  });

  test('triage splits new, already masked and ignored values', async () => {
    const { matching } = parseConfig({ custom_values: ['Bob Example'] });
    const ignored = new Set([await fingerprint('Carol Example')]);
    const result = await triage(found, matching, ignored);
    expect(isMasked('alice@example.com', matching)).toBe(true);
    expect(isMasked('Alice Example', matching)).toBe(false);
    expect(result.candidates.map(one => one.value)).not.toContain('Bob Example');
    expect(result.candidates.map(one => one.value)).not.toContain('Carol Example');
    expect(result.ignored).toBe(1);
    expect(result.covered).toBe(3);
  });
});
