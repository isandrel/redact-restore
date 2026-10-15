// Hook integration tests through the engine's own dispatch. Synthetic values only.
import { describe, expect, mock, test, type TestBody } from 'claude-code/testing';
import { hmacSha256Hex } from '../../hooks/hmac.ts';
import { MESSAGES } from '../../hooks/defaults.ts';

type Engine = Parameters<TestBody>[0];
type On = Parameters<TestBody>[1];

const SECRET = 'Project Phoenix';
const EMAIL = 'alice@example.com';
const UNKNOWN = '{{PRIVATE:CUSTOM#0123456789ab}}';
const PLACEHOLDER = /\{\{PRIVATE:(CUSTOM|EMAIL)#[a-f0-9]{12}\}\}/g;
const base = { custom_values: [SECRET, 'a.b[c]'] };
const configured = { options: base };
const notRestoring = { options: { ...base, restore_mode: 'none' } };
const filesOnly = { options: { ...base, restore_mode: 'files' } };

/**
 * The engine beneath the plugin, recorded. Every hook a test needs is registered
 * here, before the test's first call on `$`, as the kit requires.
 */
function harness(
  on: On,
  messages: unknown[] = [],
  store: Record<string, unknown> = {},
  disk: Record<string, string> = {},
) {
  const seen = {
    prompt: '',
    context: [] as readonly string[],
    tools: [] as Array<{ tool: string; input: Record<string, unknown> }>,
    drawn: [] as string[],
    appended: undefined as unknown,
    sent: false,
    status: [] as Array<string | undefined>,
    files: [] as Array<{ path: string; text: string }>,
  };
  mock.store(on, store);
  on('ui.status', ($, e) => {
    seen.status.push(e.text);
    return { value: undefined } as never;
  });
  on('env.get', () => ({ value: '/home/user' }) as never);
  on('session.id', () => ({ value: 'session-1' }) as never);
  on('session.model', () => ({ value: 'test-model' }) as never);
  on('fs.write', ($, e) => {
    seen.files.push({ path: e.path, text: e.text });
    return { value: undefined } as never;
  });
  on('fs.read', ($, e) => {
    const written = seen.files.findLast(file => file.path === e.path)?.text ?? disk[e.path];
    return (written === undefined ? { deny: 'ENOENT' } : { value: written }) as never;
  });
  on('ui.toast', () => ({ value: undefined }) as never);
  on('ui.log', () => ({ value: undefined }) as never);
  on('prompt.submit', ($, e) => {
    seen.prompt = e.text;
    seen.context = e.context ?? [];
    return { text: e.text };
  });
  on('tool.call', ($, e) => {
    const { tool, ...input } = e as { tool: string } & Record<string, unknown>;
    seen.tools.push({ tool, input });
    return { deny: 'bottom' };
  });
  on('ui.render', ($, e) => {
    if (e.component === 'UserMessage' || e.component === 'AssistantMessage') seen.drawn.push(e.props.text);
    if (e.component === 'ToolUse') seen.drawn.push(JSON.stringify([e.props.input, e.props.output]));
    if (e.component === 'ToolResult') seen.drawn.push(JSON.stringify(e.props.output));
    if (e.component === 'AskUserQuestion') seen.drawn.push(JSON.stringify(e.props.questions));
    return h('Text', null, 'drawn') as never;
  });
  on('session.messages', () => ({ value: messages }) as never);
  on('session.end', ($, e) => ({ sessionId: e.sessionId }));
  on('turn.step', async function* (_$, e) {
    seen.sent = true;
    return { turnId: e.turnId, index: e.index, answer: 'sent', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  return seen;
}

async function submit($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } });
}

/** Masks a value through prompt.submit and returns its placeholder. */
async function placeholderFor($: Engine, seen: ReturnType<typeof harness>, value: string): Promise<string> {
  await submit($, value);
  const token = seen.prompt.match(PLACEHOLDER)?.[0];
  if (!token) throw new Error('no placeholder produced');
  return token;
}

async function drawAssistant($: Engine, text: string, surface: 'terminal' | 'desktop' = 'terminal') {
  await $.ui.render({
    surface,
    component: 'AssistantMessage',
    requestId: `m-${surface}`,
    props: { text, isFirstOfReply: true },
  });
}

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 });
  let item = await stream.next();
  while (!item.done) item = await stream.next();
  return item.value;
}

describe('prompt and context masking', () => {
  test('prompt.submit forwards only placeholders, and they restore locally', configured, async ($, on) => {
    const seen = harness(on);
    await submit($, `Ask ${EMAIL} about ${SECRET} and a.b[c]`);
    expect(seen.prompt).not.toMatch(/alice@example\.com|Project Phoenix|a\.b\[c\]/);
    expect(seen.prompt.match(PLACEHOLDER)).toHaveLength(3);
    await drawAssistant($, seen.prompt);
    expect(seen.drawn).toEqual([`Ask ${EMAIL} about ${SECRET} and a.b[c]`]);
  });

  test('repeated values reuse one placeholder across prompts', configured, async ($, on) => {
    const seen = harness(on);
    const first = await placeholderFor($, seen, SECRET);
    const second = await placeholderFor($, seen, `again ${SECRET}`);
    expect(second).toBe(first);
  });

  test('prompt.submit refuses attachments it cannot scan', configured, async ($, on) => {
    harness(on);
    const result = await $.prompt.submit({
      text: 'see image',
      wait: false,
      origin: { kind: 'composer' },
      attachments: [{ type: 'image' }],
    } as never);
    expect('drop' in result ? result.drop : '').toMatch(/cannot be scanned/);
  });

  test('prompt.context masks the userEmail and CLAUDE.md blocks', configured, async ($, on) => {
    let seen: readonly { name: string; text: string }[] = [];
    on('prompt.context', ($, e) => {
      seen = e.blocks;
      return { blocks: e.blocks };
    });
    await $.prompt.context({
      blocks: [
        { name: 'userEmail', text: `The user's email is ${EMAIL}.` },
        { name: 'claudeMd', text: `Codename ${SECRET}` },
        { name: 'currentDate', text: 'Today is 2026-10-11.' },
      ],
    });
    expect(JSON.stringify(seen)).not.toMatch(/alice@example\.com|Project Phoenix/);
    expect(seen[2]?.text).toBe('Today is 2026-10-11.');
  });

  test('prompt.attachment masks injected text', configured, async ($, on) => {
    let seen = '';
    on('prompt.attachment', ($, e) => {
      seen = e.text;
      return { text: e.text };
    });
    await $.prompt.attachment({ type: 'file', text: `contents: ${SECRET}`, origin: { kind: 'engine' } } as never);
    expect(seen).not.toMatch(/Project Phoenix/);
    expect(seen).toMatch(PLACEHOLDER);
  });

  test('prompt.compose masks system prompt sections', configured, async ($, on) => {
    on('prompt.compose', () => ({
      sections: [
        { id: 'intro', text: 'You are Claude.', scope: 'shared' },
        { id: 'memory', text: `Remember ${EMAIL}`, scope: 'session' },
      ],
    }));
    const result = await $.prompt.compose({
      model: 'm',
      promptModel: 'm',
      surfaces: [],
      tools: [],
      outputStyle: null,
      traits: [],
    });
    expect(result.sections[0]?.text).toBe('You are Claude.');
    expect(result.sections[1]?.text).not.toMatch(/alice@example\.com/);
    expect(result.sections.at(-1)).toMatchObject({ id: 'redact-restore:placeholders', scope: 'session' });
  });
});

describe('conversation rows', () => {
  // 2.1.287's kit has no row store beneath session.append (2.1.295 adds one), so
  // the test reads the row its bottom hook receives and tolerates the missing store.
  test('session.append masks tool results and withholds media', configured, async ($, on) => {
    let stored: unknown;
    // Recent engines require a session.append hook to pass the row on with next(e).
    on('session.append', ($, e, next) => {
      stored = e.message.content;
      return next(e);
    });
    await $.session
      .append({
        door: 'tool-result',
        uuid: 'u1',
        origin: { kind: 'tool', tool: 'Read' },
        message: {
          type: 'user',
          role: 'user',
          content: [
            { type: 'text', text: `note for ${SECRET}` },
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: `owner: ${EMAIL}` },
                { type: 'image', source: { type: 'base64', data: '' } },
              ],
            },
          ],
        },
      } as never)
      .catch(() => undefined);
    const text = JSON.stringify(stored);
    expect(text).toMatch(/\{\{PRIVATE:EMAIL#/);
    expect(text).not.toMatch(/alice@example\.com|Project Phoenix|"type":"image"/);
  });
});

describe('outbound audit', () => {
  const clean = [{ role: 'user', content: [{ type: 'text', text: 'nothing private' }] }];
  const leaking = [{ role: 'user', content: [{ type: 'text', text: `hi ${EMAIL}` }] }];

  test('turn.step sends when user content is clean', configured, async ($, on) => {
    const seen = harness(on, clean);
    expect((await step($))?.answer).toBe('sent');
    expect(seen.sent).toBe(true);
  });

  test('turn.step refuses to send an unmasked value', configured, async ($, on) => {
    const seen = harness(on, leaking);
    expect((await step($))?.answer).toBe('');
    expect(seen.sent).toBe(false);
  });

  test('steps skip re-rendered attachments (subagent and after compaction)', configured, async ($, on) => {
    const seen = harness(on, [
      {
        role: 'user',
        content: [
          { type: 'text', text: `<system-reminder>\n# Environment\n - /drive/${EMAIL}/x\n</system-reminder>` },
          { type: 'text', text: 'Reply OK' },
        ],
      },
    ]);
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: 'a1' });
    let item = await stream.next();
    while (!item.done) item = await stream.next();
    expect(seen.sent).toBe(true);
  });

  test('turn.step audit can be turned off', { options: { ...base, outbound_audit: false } }, async ($, on) => {
    const seen = harness(on, leaking);
    await step($);
    expect(seen.sent).toBe(true);
  });
});

describe('streaming restoration', () => {
  async function streamed($: Engine, on: On, chunksOf: (token: string) => string[]) {
    let token = '';
    mock.store(on, {});
    on('ui.status', () => ({ value: undefined }) as never);
    on('session.messages', () => ({ value: [] }) as never);
    on('prompt.submit', ($, e) => {
      token = e.text.match(PLACEHOLDER)?.[0] ?? '';
      return { text: e.text };
    });
    on('turn.step', async function* (_$, e) {
      for (const text of chunksOf(token)) yield { kind: 'text', index: 0, text };
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null };
    });
    await submit($, SECRET);
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 });
    const texts: string[] = [];
    let item = await stream.next();
    while (!item.done) {
      if (item.value.kind === 'text') texts.push(item.value.text);
      item = await stream.next();
    }
    return { token, text: texts.join('') };
  }
  const split = (token: string) => ['About ', token.slice(0, 9), token.slice(9, 30), token.slice(30), '.'];

  test('on by default: placeholders split across chunks are restored', configured, async ($, on) => {
    const { text } = await streamed($, on, split);
    expect(text).toBe(`About ${SECRET}.`);
  });

  test('off: the stream keeps placeholders', { options: { ...base, restore_streaming: false } }, async ($, on) => {
    const { token, text } = await streamed($, on, split);
    expect(text).toBe(`About ${token}.`);
  });
});

describe('local restoration', () => {
  const write = (content: string) => ({
    tool: 'Write' as const,
    tool_use_id: 'w1',
    file_path: '/tmp/redact-restore-test.txt',
    content,
  });

  test('Write restores known placeholders by default', configured, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    await $.tool.call(write(`name = "${token}"`));
    expect(seen.tools[0]?.input.content).toBe(`name = "${SECRET}"`);
  });

  test('Edit restores old_string and new_string', configured, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    await $.tool.call({
      tool: 'Edit',
      tool_use_id: 'e1',
      file_path: '/tmp/x',
      old_string: token,
      new_string: `${token}!`,
    });
    expect(seen.tools[0]?.input).toMatchObject({ old_string: SECRET, new_string: `${SECRET}!` });
  });

  test('Write with an unknown placeholder is denied', configured, async ($, on) => {
    const seen = harness(on);
    const result = await $.tool.call(write(UNKNOWN));
    expect(seen.tools).toHaveLength(0);
    expect(JSON.stringify(result)).toMatch(/could not be restored/);
  });

  test('placeholders are not written into files while restoration is off', notRestoring, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    const result = await $.tool.call(write(token));
    expect(seen.tools).toHaveLength(0);
    expect(JSON.stringify(result)).toMatch(/restoration is off for it/);
  });

  test('Write without placeholders passes untouched', configured, async ($, on) => {
    const seen = harness(on);
    await $.tool.call(write('plain'));
    expect(seen.tools[0]?.input.content).toBe('plain');
  });

  test('Bash receives restored values by default', configured, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: `echo "${token}" > out.txt` });
    expect(seen.tools[0]?.input.command).toBe(`echo "${SECRET}" > out.txt`);
  });

  test('Bash with an unknown placeholder is denied', configured, async ($, on) => {
    const seen = harness(on);
    const result = await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: `echo ${UNKNOWN}` });
    expect(seen.tools).toHaveLength(0);
    expect(JSON.stringify(result)).toMatch(/could not be restored/);
  });

  test('model-bound tools keep placeholders', configured, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    await $.tool.call({ tool: 'WebFetch', tool_use_id: 'f1', url: 'https://example.com', prompt: `find ${token}` });
    await $.tool.call({ tool: 'Agent', tool_use_id: 'a1', description: 'd', prompt: `about ${token}` } as never);
    expect(seen.tools.map(call => JSON.stringify(call.input))).toEqual([
      expect.stringContaining(token),
      expect.stringContaining(token),
    ]);
    expect(JSON.stringify(seen.tools)).not.toContain(SECRET);
  });

  test('files mode keeps placeholders for Bash', filesOnly, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b3', command: `echo ${token}` });
    expect(seen.tools[0]?.input.command).toBe(`echo ${token}`);
  });

  test(
    'keep_tools patterns protect MCP tools',
    { options: { ...base, keep_tools: 'mcp__remote__*' } },
    async ($, on) => {
      const seen = harness(on);
      const token = await placeholderFor($, seen, SECRET);
      await $.tool.call({ tool: 'mcp__remote__post', tool_use_id: 'm1', body: { text: token } } as never);
      expect(JSON.stringify(seen.tools[0]?.input)).toContain(token);
    },
  );

  test('messages render restored on terminal and desktop', configured, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    await drawAssistant($, `Hello ${token}`, 'terminal');
    await drawAssistant($, `Hello ${token}`, 'desktop');
    expect(seen.drawn).toEqual([`Hello ${SECRET}`, `Hello ${SECRET}`]);
  });

  test('tool rows, tool results and questions render restored', configured, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    const unknown = '{{PRIVATE:EMAIL#000000000000}}';
    const row = { tool_use_id: 'tu-1', tool: 'Bash', isRunning: false, isErrored: false, isInterrupted: false };
    await $.ui.render({
      surface: 'terminal',
      component: 'ToolUse',
      requestId: 'tu-1',
      props: { ...row, input: { command: `echo ${token} ${unknown}` }, output: { stdout: token, stderr: '' } },
    } as never);
    await $.ui.render({
      surface: 'desktop',
      component: 'ToolResult',
      requestId: 'tu-1',
      props: { tool_use_id: 'tu-1', tool: 'Bash', isErrored: false, output: { stdout: `got ${token}`, stderr: '' } },
    } as never);
    await $.ui.render({
      surface: 'terminal',
      component: 'AskUserQuestion',
      requestId: 'q-1',
      props: { tool: 'AskUserQuestion', questions: [{ question: `Use ${token}?`, header: 'Pick', options: [] }] },
    } as never);
    expect(seen.drawn).toEqual([
      JSON.stringify([{ command: `echo ${SECRET} ${unknown}` }, { stdout: SECRET, stderr: '' }]),
      JSON.stringify({ stdout: `got ${SECRET}`, stderr: '' }),
      JSON.stringify([{ question: `Use ${SECRET}?`, header: 'Pick', options: [] }]),
    ]);
  });

  test(
    'restore_display_rows picks the rows restored on screen',
    { options: { ...base, restore_display_rows: 'assistantmessage, NoSuchRow' } },
    async ($, on) => {
      const seen = harness(on);
      const token = await placeholderFor($, seen, SECRET);
      await drawAssistant($, `Hello ${token}`);
      await $.ui.render({
        surface: 'terminal',
        component: 'ToolResult',
        requestId: 'tu-2',
        props: { tool_use_id: 'tu-2', tool: 'Bash', isErrored: false, output: { stdout: token, stderr: '' } },
      } as never);
      expect(seen.drawn).toEqual([`Hello ${SECRET}`, JSON.stringify({ stdout: token, stderr: '' })]);
    },
  );

  test('display restoration can be turned off', { options: { ...base, restore_display: false } }, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    await $.ui.render({
      surface: 'terminal',
      component: 'UserMessage',
      requestId: 'u',
      props: { text: token, origin: { kind: 'composer' }, isExpanded: false },
    } as never);
    expect(seen.drawn).toEqual([token]);
  });
});

describe('descriptions', () => {
  const described = {
    [`rule.${'2'.repeat(64)}`]: {
      value: SECRET,
      label: 'PROJECT',
      description: 'internal codename of the launch',
      source: 'manual',
      addedAt: '2026-01-01T00:00:00.000Z',
    },
  };

  // The value comes from a saved rule alone: for the same value, an option without a description wins.
  test('a description goes once, as hidden context, never with the value', { options: {} }, async ($, on) => {
    const seen = harness(on, [], described);
    await submit($, `Plan for ${SECRET}`);
    const token = seen.prompt.match(/\{\{PRIVATE:PROJECT#[a-f0-9]{12}\}\}/)?.[0] ?? 'missing';
    expect(seen.prompt).toBe(`Plan for ${token}`);
    expect(seen.context).toEqual([`${MESSAGES.legendHeader}\n- ${token}: internal codename of the launch`]);
    expect(JSON.stringify(seen.context)).not.toContain(SECRET);
    await submit($, `More on ${SECRET}`);
    expect(seen.context).toEqual([]);
  });

  test('a value first seen in a tool result is described in that result', { options: {} }, async ($, on) => {
    let stored: unknown;
    on('session.append', ($, e, next) => {
      stored = e.message.content;
      return next(e);
    });
    harness(on, [], described);
    await submit($, 'hello'); // Loads the saved rules, as session.start does.
    await $.session
      .append({
        door: 'tool-result',
        uuid: 'u1',
        origin: { kind: 'tool', tool: 'Bash' },
        message: {
          type: 'user',
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: `cat said ${SECRET}` }],
        },
      } as never)
      .catch(() => undefined);
    const text = JSON.stringify(stored);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('internal codename of the launch');
  });

  test('after a compaction, descriptions are told again', { options: {} }, async ($, on) => {
    const summary = { role: 'user', text: 'summary', toolUses: [] };
    on('session.compact', () => ({ messages: [summary] }) as never);
    const seen = harness(on, [], described);
    await submit($, `Plan for ${SECRET}`);
    expect(seen.context).toHaveLength(1);
    await $.session.compact({ trigger: 'manual', messages: [summary] } as never);
    await submit($, `Again ${SECRET}`);
    expect(JSON.stringify(seen.context)).toContain('internal codename of the launch');
  });

  test('the system note explains labels and the description note', configured, async ($, on) => {
    harness(on);
    on('prompt.compose', () => ({ sections: [] }));
    const result = await $.prompt.compose({
      model: 'm',
      promptModel: 'm',
      surfaces: [],
      tools: [],
      outputStyle: null,
      traits: [],
    });
    const note = result.sections.at(-1)?.text ?? '';
    expect(note).toContain('HOST is a private host name');
    expect(note).toContain('A note starting "Redact Restore:" may describe what a placeholder is');
  });
});

describe('stable placeholder ids', () => {
  const stable = { options: { ...base, placeholder_ids: 'stable' } };
  const KEY = 'ab'.repeat(32);

  test('stable ids come from the stored key: the same value gets the same placeholder', stable, async ($, on) => {
    const seen = harness(on, [], { 'placeholder-id-key': KEY });
    await submit($, `Ask about ${SECRET}`);
    const id = hmacSha256Hex(KEY, `CUSTOM\u0000${SECRET}`).slice(0, 12);
    expect(seen.prompt).toBe(`Ask about {{PRIVATE:CUSTOM#${id}}}`);
  });

  test('without a stored key, one is made and used', stable, async ($, on) => {
    const seen = harness(on);
    await submit($, SECRET);
    const first = seen.prompt;
    expect(first).toMatch(PLACEHOLDER);
    expect(first).not.toContain(SECRET);
  });
});

describe('custom placeholders', () => {
  const custom = { options: { placeholder_format: '{{{label}_{id}}}', placeholder_id_length: 8 } };
  // Labels and aliases come from saved rules (structured fields), as the rules pane stores them.
  const saved = {
    [`rule.${'1'.repeat(64)}`]: {
      value: SECRET,
      label: 'PROJECT',
      source: 'manual',
      addedAt: '2026-01-01T00:00:00.000Z',
    },
    [`rule.${'2'.repeat(64)}`]: {
      value: 'acme.internal',
      alias: 'HOST_ALPHA',
      source: 'manual',
      addedAt: '2026-01-02T00:00:00.000Z',
    },
  };

  test('custom format, label and alias reach the model and restore locally', custom, async ($, on) => {
    const seen = harness(on, [], saved);
    await submit($, `Deploy Project Phoenix to acme.internal for ${EMAIL}`);
    expect(seen.prompt).toMatch(/^Deploy \{\{PROJECT_[a-f0-9]{8}\}\} to HOST_ALPHA for \{\{EMAIL_[a-f0-9]{8}\}\}$/);
    await drawAssistant($, seen.prompt);
    expect(seen.drawn).toEqual([`Deploy ${SECRET} to acme.internal for ${EMAIL}`]);
    await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: `ssh HOST_ALPHA '${seen.prompt}'` });
    expect(seen.tools[0]?.input.command).toBe(`ssh acme.internal 'Deploy ${SECRET} to acme.internal for ${EMAIL}'`);
  });

  test('an unknown placeholder in the custom format is refused', custom, async ($, on) => {
    const seen = harness(on);
    const result = await $.tool.call({ tool: 'Bash', tool_use_id: 'c2', command: 'echo {{PROJECT_0123abcd}}' });
    expect(seen.tools).toHaveLength(0);
    expect(JSON.stringify(result)).toMatch(/could not be restored/);
  });
});

describe('status line', () => {
  test('count by default, cleared by /clear', configured, async ($, on) => {
    const seen = harness(on);
    await submit($, `${SECRET} ${EMAIL}`);
    expect(seen.status.at(-1)).toBe('2 private values masked');
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { sessionId: 's' } } as never);
    expect(seen.status.at(-1)).toBeUndefined();
  });

  test(
    'detailed preset and custom template',
    { options: { ...base, status_line: 'detailed', status_format: '🔒 {masked}' } },
    async ($, on) => {
      const seen = harness(on);
      await submit($, SECRET);
      expect(seen.status.at(-1)).toBe('🔒 1');
    },
  );

  test('off draws nothing', { options: { ...base, status_line: 'off' } }, async ($, on) => {
    const seen = harness(on);
    await submit($, SECRET);
    expect(seen.status.every(text => text === undefined)).toBe(true);
  });

  test(
    'status_file writes counts for a status-line script, never values',
    { options: { ...base, status_file: true } },
    async ($, on) => {
      const seen = harness(on);
      await submit($, `${SECRET} ${EMAIL}`);
      const file = seen.files.at(-1);
      expect(file?.path).toBe('/home/user/.claude/redact-restore/status/session-1.json');
      expect(JSON.parse(file?.text ?? '{}')).toMatchObject({
        masked: 2,
        emails: 1,
        custom: 1,
        mode: 'all',
        occurrences: 2,
        lastTurn: 2,
        bySource: { prompt: 2 },
        state: 'ok',
        model: 'test-model',
      });
      expect(file?.text).not.toMatch(/Phoenix|example\.com|\{\{PRIVATE:[A-Z_]+#[a-f0-9]{12}\}\}/);
    },
  );

  test('no file by default', configured, async ($, on) => {
    const seen = harness(on);
    await submit($, SECRET);
    expect(seen.files.filter(file => file.path.includes('/status/'))).toHaveLength(0);
  });
});

describe('session maps for /resume', () => {
  const MAP = '/home/user/.claude/redact-restore/sessions/session-1.json';

  test('the map is kept in a local file as values are masked', configured, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    const saved = JSON.parse(seen.files.findLast(file => file.path === MAP)?.text ?? '{}');
    expect(saved).toMatchObject({ format: 'redact-restore-session', version: 1, vault: { [token]: SECRET } });
  });

  test('a resumed session restores placeholders from before, on screen and in tools', configured, async ($, on) => {
    const token = '{{PRIVATE:CUSTOM#0123456789ab}}';
    const disk = {
      [MAP]: JSON.stringify({
        format: 'redact-restore-session',
        version: 1,
        vault: { [token]: SECRET },
        notes: {},
        sent: {},
      }),
    };
    const seen = harness(on, [], {}, disk);
    await drawAssistant($, `Hello ${token}`);
    expect(seen.drawn).toEqual([`Hello ${SECRET}`]);
    await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/tmp/x', content: token });
    expect(seen.tools[0]?.input.content).toBe(SECRET);
    // The same value keeps its placeholder after the resume.
    await submit($, `again ${SECRET}`);
    expect(seen.prompt).toBe(`again ${token}`);
  });

  test('a file that is not a session map is ignored', configured, async ($, on) => {
    const seen = harness(on, [], {}, { [MAP]: '{"vault":{"x":1}}' });
    await drawAssistant($, 'Hello {{PRIVATE:CUSTOM#0123456789ab}}');
    expect(seen.drawn).toEqual(['Hello {{PRIVATE:CUSTOM#0123456789ab}}']);
  });

  test('off: nothing is written', { options: { ...base, persist_session_map: false } }, async ($, on) => {
    const seen = harness(on);
    await submit($, SECRET);
    expect(seen.files.filter(file => file.path.includes('/sessions/'))).toEqual([]);
  });
});

describe('lifecycle', () => {
  test('/clear empties the vault', configured, async ($, on) => {
    const seen = harness(on);
    const token = await placeholderFor($, seen, SECRET);
    await $.session.end({ reason: 'clear', sessionId: 's', resume: { sessionId: 's' } } as never);
    await drawAssistant($, token);
    expect(seen.drawn).toEqual([token]);
  });

  test('disabled plugin passes text through', { options: { ...base, enabled: false } }, async ($, on) => {
    const seen = harness(on);
    await submit($, SECRET);
    expect(seen.prompt).toBe(SECRET);
  });
});
