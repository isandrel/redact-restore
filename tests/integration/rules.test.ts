// The /redact-restore command, the rules pane and the stored rules, through
// the engine's own dispatch. Synthetic values only.
import { describe, expect, mock, test, type TestBody } from 'claude-code/testing';

type Engine = Parameters<TestBody>[0];
type On = Parameters<TestBody>[1];

const NAME = 'Alice Example';
const HOST = 'git.acme.internal';
const PLACEHOLDER = /\{\{PRIVATE:[A-Z_]+#[a-f0-9]{12}\}\}/;
const HOME = '/home/alice';

interface World {
  prompt: string;
  files: Map<string, string>;
  opened: string[];
  argv: string[][];
}

/** Every stub the command, the pane and prompt.submit need; registered before the first $ call. */
function world(on: On, store: Record<string, unknown> | 'broken' = {}, files: Record<string, string> = {}): World {
  const seen: World = { prompt: '', files: new Map(Object.entries(files)), opened: [], argv: [] };
  if (store === 'broken') {
    on('store.keys', () => ({ deny: 'store unreadable' }) as never);
    on('store.get', () => ({ deny: 'store unreadable' }) as never);
    on('store.set', () => ({ deny: 'store unreadable' }) as never);
  } else mock.store(on, store);
  mock.env(on, { HOME });
  on('fs.list', () => ({ value: [{ name: '.env', kind: 'file', size: 40, mtimeMs: 0, isLink: false }] }) as never);
  on('fs.read', ($, e) => {
    const hit = [...seen.files.entries()].find(([path]) => e.path.endsWith(path));
    return (hit ? { value: hit[1] } : { deny: 'ENOENT' }) as never;
  });
  on('fs.write', ($, e) => {
    seen.files.set(e.path, e.text);
    return { value: undefined } as never;
  });
  on('process.run', ($, e) => {
    seen.argv.push([...e.argv]);
    const out: Record<string, string> = {
      'git config --get user.name': `${NAME}\n`,
      'git remote -v': `origin\tgit@${HOST}:platform/billing.git (fetch)\n`,
    };
    return { value: { exitCode: 0, stdout: out[e.argv.join(' ')] ?? '', stderr: '' } } as never;
  });
  on('ui.open', ($, e) => {
    seen.opened.push(e.id);
    return { value: { isPlaced: true } } as never;
  });
  on('ui.close', () => ({ value: undefined }) as never);
  on('ui.status', () => ({ value: undefined }) as never);
  on('ui.toast', () => ({ value: undefined }) as never);
  on('ui.log', () => ({ value: undefined }) as never);
  on('session.id', () => ({ value: 'session-1' }) as never);
  on('session.model', () => ({ value: 'test-model' }) as never);
  on('prompt.submit', ($, e) => {
    seen.prompt = e.text;
    return { text: e.text };
  });
  return seen;
}

/** An export file, the only import format: structured rules, never text to parse. */
function exportFile(rules: ReadonlyArray<{ value: string; label?: string; alias?: string }>): string {
  return JSON.stringify({ format: 'redact-restore-rules', version: 1, rules });
}

async function submit($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } });
}

async function run($: Engine, args: string): Promise<string> {
  const run = await $.command.run({
    command: 'redact-restore',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  });
  return run.text ?? '';
}

async function mountPane<P extends 'terminal' | 'desktop' | 'mobile' = 'terminal'>(
  $: Engine,
  surface: P = 'terminal' as P,
) {
  return $.ui.mount({
    plugin: 'redact-restore',
    component: 'Pane',
    requestId: 'redact-restore',
    surface,
    viewport: { columns: 120, rows: 40 },
    props: {
      title: 'Redact Restore',
      isFocused: true,
      bodyColumns: 120,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 36 },
      view: {},
    },
  });
}

// The kit's lib has no DOM or Node typings; the runtime has the timer.
const timers = globalThis as unknown as { setTimeout(run: () => void, ms: number): unknown };
const sleep = (ms: number) => new Promise<void>(resolve => timers.setTimeout(resolve, ms));

/** Handlers run after the press resolves; wait for their writes. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 50; tries += 1) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error('condition not reached');
}

async function masks($: Engine, seen: World, value: string): Promise<boolean> {
  await submit($, `about ${value}`);
  return !seen.prompt.includes(value) && PLACEHOLDER.test(seen.prompt);
}

describe('rules pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`adding and removing a rule on ${surface} takes effect at once`, async ($, on) => {
      const seen = world(on);
      expect(await run($, 'rules')).toBe('Redact Restore rules pane opened.');
      expect(seen.opened).toEqual(['redact-restore']);
      const pane = await mountPane($, surface);
      await pane.select({ key: 'draft-label', value: 'NAME' });
      await pane.input({ key: 'draft-value', text: NAME });
      await eventually(() => masks($, seen, NAME));
      expect(seen.prompt).toMatch(/\{\{PRIVATE:NAME#/);

      const drawn = JSON.stringify(await pane.drawn());
      expect(drawn).not.toContain(NAME);
      expect(drawn).toContain('A•••• (13)');

      // Removed from the store; the session vault keeps masking it until /clear.
      await pane.press({ key: 'remove-0' });
      await eventually(async () => /Rules: 0 saved/.test(await run($, 'status')));
      expect(await masks($, seen, NAME)).toBe(true);
    });
  }

  test('the form: a picked label, a fixed alias, a typed label, and editing a rule', async ($, on) => {
    const seen = world(on);
    await run($, 'rules');
    const pane = await mountPane($, 'desktop');
    // A picked label; the preview shows what the model will see.
    await pane.input({ key: 'draft-value', text: NAME, kind: 'change' });
    await pane.select({ key: 'draft-label', value: 'CUSTOMER' });
    await eventually(async () => (await pane.find({ text: /The model sees: \{\{PRIVATE:CUSTOMER#/ })) !== undefined);
    await pane.press({ key: 'draft-save' });
    await eventually(() => masks($, seen, NAME));
    expect(seen.prompt).toMatch(/\{\{PRIVATE:CUSTOMER#/);
    // A fixed alias, saved with Enter in the value field.
    await pane.select({ key: 'draft-mode', value: 'alias' });
    await pane.input({ key: 'draft-alias', text: 'CLIENT_A', kind: 'change' });
    await eventually(async () => (await pane.find({ text: /The model sees: CLIENT_A/ })) !== undefined);
    await pane.input({ key: 'draft-value', text: HOST });
    await eventually(async () => {
      await submit($, `ping ${HOST}`);
      return seen.prompt === 'ping CLIENT_A';
    });
    // A typed label that is not valid is refused and the form is kept.
    await pane.select({ key: 'draft-mode', value: 'label' });
    await pane.select({ key: 'draft-label', value: '__other' });
    await pane.input({ key: 'draft-custom-label', text: '1bad', kind: 'change' });
    await pane.input({ key: 'draft-value', text: 'Project Phoenix' });
    await eventually(async () => (await pane.find({ text: /A label is a letter/ })) !== undefined);
    expect(await run($, 'status')).toMatch(/Rules: 2 saved/);
    // Edit fills the form from a saved rule; saving updates it.
    await pane.press({ key: 'draft-clear' });
    await pane.press({ key: 'edit-0' });
    await eventually(async () => (await pane.find({ text: /Editing A/ })) !== undefined);
    await pane.select({ key: 'draft-label', value: 'NAME' });
    await pane.press({ key: 'draft-save' });
    await eventually(async () => (await pane.find({ text: /updated/ })) !== undefined);
    // Updated in place: same position, new label.
    expect(JSON.stringify(await pane.drawn())).toMatch(/"rule-0".*?"A•••• \(13\)".*?"NAME"," · ","manual"/);
  });

  test('editing keeps the value fixed and masked; it never creates a second rule', async ($, on) => {
    world(on);
    await run($, 'rules');
    const pane = await mountPane($, 'desktop');
    await pane.input({ key: 'draft-value', text: NAME });
    await eventually(async () => /Rules: 1 saved/.test(await run($, 'status')));
    await pane.press({ key: 'edit-0' });
    await eventually(async () => (await pane.find({ text: /fixed while editing/ })) !== undefined);
    expect(await pane.find({ key: 'draft-value' })).toBeUndefined();
    expect(JSON.stringify(await pane.drawn())).not.toContain(NAME);
    await pane.select({ key: 'draft-mode', value: 'alias' });
    await pane.input({ key: 'draft-alias', text: 'PERSON_1' });
    await eventually(async () => (await pane.find({ text: /updated/ })) !== undefined);
    expect(await run($, 'status')).toMatch(/Rules: 1 saved/);
    expect(JSON.stringify(await pane.drawn())).toContain('alias PERSON_1');
  });

  test('the form names what is missing, and closing the pane drops an unsaved value', async ($, on) => {
    world(on);
    await run($, 'rules');
    const pane = await mountPane($, 'desktop');
    await pane.press({ key: 'draft-save' });
    await eventually(async () => (await pane.find({ text: /Type a value first/ })) !== undefined);
    await pane.input({ key: 'draft-value', text: NAME, kind: 'change' });
    await pane.select({ key: 'draft-mode', value: 'alias' });
    await pane.press({ key: 'draft-save' });
    await eventually(async () => (await pane.find({ text: /Type an alias/ })) !== undefined);
    await pane.select({ key: 'draft-mode', value: 'label' });
    await pane.select({ key: 'draft-label', value: '__other' });
    await pane.press({ key: 'draft-save' });
    await eventually(async () => (await pane.find({ text: /Type a label/ })) !== undefined);
    expect(await run($, 'status')).toMatch(/Rules: 0 saved/);
    await pane.press({ key: 'close' });
    await eventually(async () => !JSON.stringify(await pane.drawn()).includes(`"value":"${NAME}"`));
  });

  test(
    'the label list comes from rule_labels plus labels in use',
    { options: { rule_labels: 'VENDOR, TEAM' } },
    async ($, on) => {
      world(on, {
        'rule.1111111111111111111111111111111111111111111111111111111111111111': {
          value: 'Project Phoenix',
          label: 'CODENAME',
          source: 'manual',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      await submit($, 'load the saved rules');
      await run($, 'rules');
      const pane = await mountPane($, 'desktop');
      const select = await pane.find({ key: 'draft-label' });
      const values = ((select?.props.options ?? []) as Array<{ value: string }>).map(option => option.value);
      expect(values).toEqual(['CUSTOM', 'VENDOR', 'TEAM', 'CODENAME', '__other']);
    },
  );

  test('the value field takes text as typed, never as entry syntax', async ($, on) => {
    const seen = world(on);
    await run($, 'rules');
    const pane = await mountPane($, 'desktop');
    await pane.input({ key: 'draft-value', text: 'a => b == CODE_9' });
    await eventually(async () => /Rules: 1 saved/.test(await run($, 'status')));
    expect(await masks($, seen, 'a => b == CODE_9')).toBe(true);
    expect(seen.prompt).toMatch(/\{\{PRIVATE:CUSTOM#/);
  });

  test('values show only when asked', async ($, on) => {
    world(on);
    await run($, 'rules');
    const pane = await mountPane($);
    await pane.input({ key: 'draft-value', text: NAME });
    await eventually(async () => JSON.stringify(await pane.drawn()).includes('A••••'));
    await pane.press({ key: 'reveal' });
    await eventually(async () => JSON.stringify(await pane.drawn()).includes(NAME));
  });

  test('a rejected entry explains the problem and saves nothing', async ($, on) => {
    world(on);
    await run($, 'rules');
    const pane = await mountPane($);
    await pane.input({ key: 'draft-value', text: 'ab' });
    await eventually(async () => (await pane.find({ text: /at least 3 characters/ })) !== undefined);
    expect(await run($, 'status')).toMatch(/Rules: 0 saved/);
  });

  test('mobile has no text field and says so', async ($, on) => {
    world(on);
    await run($, 'rules');
    const pane = await mountPane($, 'mobile');
    expect(await pane.find({ text: /needs the terminal or the desktop app/ })).toBeDefined();
  });

  test('rules saved by another session are read on the next prompt', async ($, on) => {
    const seen = world(on, {
      'rule.0000000000000000000000000000000000000000000000000000000000000000': {
        value: NAME,
        label: 'PERSON',
        source: 'manual',
        addedAt: '2026-01-01T00:00:00.000Z',
      },
      'unrelated-key': 'ignored',
    });
    expect(await masks($, seen, NAME)).toBe(true);
    expect(seen.prompt).toMatch(/\{\{PRIVATE:PERSON#/);
  });
});

describe('scan', () => {
  test('the command reports counts only; the pane adds a candidate', async ($, on) => {
    const seen = world(on, {}, { '.env': 'DB_PASSWORD=hunter2hunter2\n' });
    const text = await run($, 'scan');
    expect(text).toMatch(/^Scan found \d+ new candidate/);
    for (const value of [NAME, HOST, 'hunter2hunter2', 'alice']) expect(text).not.toContain(value);
    expect(seen.argv.every(argv => argv[0] === 'git' || argv[0] === 'hostname')).toBe(true);

    const pane = await mountPane($);
    expect(JSON.stringify(await pane.drawn())).not.toContain(NAME);
    await pane.press({ key: 'accept-0' });
    await eventually(() => masks($, seen, NAME));
    expect(seen.prompt).toMatch(/\{\{PRIVATE:NAME#/);
  });

  test('an ignored candidate is skipped by later scans, by fingerprint only', async ($, on) => {
    world(on);
    const first = await run($, 'scan');
    const pane = await mountPane($);
    await pane.press({ key: 'ignore-0' });
    await eventually(async () => /1 ignored before/.test(await run($, 'scan')));
    expect(first).not.toMatch(/1 ignored before/);
  });
});

describe('import and export', () => {
  test('export writes the values to a file and reports only the path and count', async ($, on) => {
    const seen = world(on);
    await run($, 'rules');
    const pane = await mountPane($);
    await pane.select({ key: 'draft-label', value: 'NAME' });
    await pane.input({ key: 'draft-value', text: NAME });
    await eventually(async () => /Rules: 1 saved/.test(await run($, 'status')));

    const text = await run($, 'export');
    expect(text).toMatch(/^Exported 1 saved rule\(s\) to ~\/\.claude\/redact-restore\/redact-restore-rules\.json\./);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain(HOME);
    const file = seen.files.get(`${HOME}/.claude/redact-restore/redact-restore-rules.json`) ?? '';
    expect(JSON.parse(file).rules).toEqual([{ value: NAME, label: 'NAME' }]);
  });

  test('import merges an export file, or replaces with --replace', async ($, on) => {
    const seen = world(
      on,
      {},
      {
        '/tmp/rules.json': exportFile([{ value: NAME }, { value: HOST, label: 'HOST' }, { value: 'ab' }]),
        '/tmp/one.json': exportFile([{ value: 'Project Phoenix' }]),
      },
    );
    const merged = await run($, 'import /tmp/rules.json');
    expect(merged).toMatch(/2 added, 0 updated, 0 unchanged, 1 skipped as invalid\. 2 saved rule\(s\) now\./);
    expect(merged).not.toContain(NAME);
    expect(await masks($, seen, HOST)).toBe(true);
    expect(seen.prompt).toMatch(/\{\{PRIVATE:HOST#/);

    expect(await run($, 'import /tmp/one.json --replace')).toMatch(/replaced all saved rules.*1 saved rule\(s\) now/);
    expect(await run($, 'status')).toMatch(/Rules: 1 saved/);
  });

  test('plain text files are refused; nothing is parsed from text', async ($, on) => {
    world(on, {}, { '/tmp/rules.txt': `${NAME}\n${HOST} => HOST\n` });
    expect(await run($, 'import /tmp/rules.txt')).toBe(
      'Nothing imported: The file is not a redact-restore-rules export (JSON).',
    );
    expect(await run($, 'status')).toMatch(/Rules: 0 saved/);
  });

  test('--replace is refused unless every entry is valid, and keeps the saved rules', async ($, on) => {
    const seen = world(
      on,
      {},
      {
        '/tmp/good.json': exportFile([{ value: NAME }]),
        '/tmp/mixed.json': exportFile([{ value: 'Project Phoenix' }, { value: 'ab' }]),
        '/tmp/none.json': exportFile([]),
      },
    );
    await run($, 'import /tmp/good.json');
    expect(await run($, 'import /tmp/mixed.json --replace')).toMatch(
      /^Nothing imported: --replace needs .*1 invalid, 1 valid/,
    );
    expect(await run($, 'import /tmp/none.json --replace')).toMatch(/^Nothing imported: --replace needs/);
    expect(await run($, 'status')).toMatch(/Rules: 1 saved/);
    expect(await masks($, seen, NAME)).toBe(true);
  });

  test('a missing or foreign file imports nothing', async ($, on) => {
    world(on, {}, { '/tmp/other.json': '{"format":"other","rules":[]}' });
    expect(await run($, 'import /tmp/missing.json')).toBe('Could not read /tmp/missing.json.');
    expect(await run($, 'import /tmp/other.json')).toMatch(/^Nothing imported: /);
    expect(await run($, 'import')).toMatch(/^Usage: /);
  });
});

describe('session tab', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows this session's counts and placeholders on ${surface}, values masked`, async ($, on) => {
      const seen = world(on);
      await submit($, `mail alice@example.com about ${HOST}`);
      const placeholder = seen.prompt.match(PLACEHOLDER)?.[0] ?? '';
      expect(await run($, 'session')).toBe('Redact Restore session pane opened.');
      const pane = await mountPane($, surface);
      const drawn = JSON.stringify(await pane.drawn());
      expect(drawn).toContain(placeholder);
      expect(drawn).toContain('1 values');
      expect(drawn).toContain('EMAIL 1');
      expect(drawn).toContain('prompt 1');
      expect(drawn).not.toContain('alice@example.com');
      await pane.press({ key: 'reveal' });
      await eventually(async () => JSON.stringify(await pane.drawn()).includes('alice@example.com'));
    });
  }

  test('an empty session says so', async ($, on) => {
    world(on);
    await run($, 'session');
    const pane = await mountPane($);
    expect(await pane.find({ text: /Nothing masked yet/ })).toBeDefined();
  });
});

describe('store failures', () => {
  test('an unreadable store holds the prompt instead of sending it without saved rules', async ($, on) => {
    const seen = world(on, 'broken');
    const result = await submit($, `about ${NAME}`);
    expect('drop' in result ? result.drop : '').toMatch(/saved rules could not be read/);
    expect(seen.prompt).toBe('');
  });

  test('a failing command answers with fixed text', async ($, on) => {
    world(on, 'broken', { '/tmp/rules.json': exportFile([{ value: NAME }]) });
    const text = await run($, 'import /tmp/rules.json');
    expect(text).toMatch(/^Redact Restore: the command failed/);
    expect(text).not.toContain(NAME);
  });
});

describe('status', () => {
  test('counts only', async ($, on) => {
    world(on, {}, {});
    const text = await run($, 'status');
    expect(text).toMatch(/Rules: 0 saved, 0 in plugin options; \d+ detectors\./);
    expect(text).toMatch(/Restore mode: all/);
    expect(await run($, 'bogus')).toMatch(/^Usage: /);
  });
});
