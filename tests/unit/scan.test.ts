// Scan candidates. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import { envAssignments } from '../../hooks/detectors.ts';
import { findPrivateMatches } from '../../hooks/matcher.ts';
import {
  assignedValues,
  collectCandidates,
  fileCandidates,
  maskedKinds,
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

describe('KEY=value values in any text', () => {
  test('values are found with quotes and comments removed; trivial values and references are not', () => {
    const text = [
      'export TEAM_CODENAME="bluefalcon-internal"',
      "DB_HOST='db.acme.internal' ",
      'API_URL=https://api.acme.internal/v1 # primary',
      'NODE_ENV=production',
      'PORT=8080',
      'HOME_DIR=${HOME}/x',
      'lower_case=not-an-env-line',
      '  const X = 5',
    ].join('\n');
    expect(envAssignments(text).map(({ key, value }) => [key, value])).toEqual([
      ['TEAM_CODENAME', 'bluefalcon-internal'],
      ['DB_HOST', 'db.acme.internal'],
      ['API_URL', 'https://api.acme.internal/v1'],
    ]);
  });

  test('the env detector masks them by default and can be turned off', () => {
    const text = 'cat .env\nTEAM_CODENAME=bluefalcon-internal\nDEBUG=true';
    expect(findPrivateMatches(text, parseConfig({}).matching).map(m => [m.category, m.value])).toEqual([
      ['ENV', 'bluefalcon-internal'],
    ]);
    expect(findPrivateMatches(text, parseConfig({ disable_detectors: 'env_assignment' }).matching)).toEqual([]);
  });
});

describe('path scan', () => {
  const files = [
    { name: 'config/app.env', text: 'TEAM_CODENAME=bluefalcon-internal\nSERVICE_TOKEN=Zx9Lm2Qa7Wp4Rt8Y\n' },
    { name: 'docs/setup.md', text: 'Connect to build.acme.internal and mail ops@example.com.\n' },
  ];

  test('candidates: KEY=value values and private host names, with where they were found', () => {
    expect(fileCandidates(files).map(one => [one.value, one.label, one.source])).toEqual([
      ['bluefalcon-internal', 'ENV', 'config/app.env (TEAM_CODENAME)'],
      ['Zx9Lm2Qa7Wp4Rt8Y', 'SECRET', 'config/app.env (SERVICE_TOKEN)'],
      ['build.acme.internal', 'HOST', 'docs/setup.md'],
    ]);
  });

  test('values masked anyway are counted by label, distinct values only', async () => {
    const { matching } = parseConfig({});
    expect(maskedKinds([...files, files[1] ?? { text: '' }], matching)).toEqual([
      ['EMAIL', 1],
      ['ENV', 1],
      ['SECRET', 1],
    ]);
    const assigned = assignedValues(files);
    const result = await triage(fileCandidates(files), matching, new Set(), one => assigned.has(one.value));
    expect(result.candidates.map(one => one.value)).toEqual(['build.acme.internal']);
    expect(result.covered).toBe(2);
  });

  test('skip folders and the file limit are options', () => {
    expect(parseConfig({}).scan.maxFiles).toBe(2000);
    expect(parseConfig({ scan_max_files: 50, scan_skip_dirs: 'fixtures, tmp' }).scan).toMatchObject({ maxFiles: 50 });
    expect(parseConfig({ scan_skip_dirs: 'fixtures, tmp' }).scan.skipDirs).toContain('fixtures');
    expect(parseConfig({ scan_skip_dirs: 'fixtures' }).scan.skipDirs).toContain('node_modules');
    expect(parseConfig({ scan_max_files: 10_000_000 }).scan.maxFiles).toBe(20_000);
  });
});
