#!/usr/bin/env bun
/**
 * Drives a real interactive Claude Code CLI inside a background Zellij session.
 *
 *   bun tests/e2e/zj.ts send "<text>"   type text and press Enter
 *   bun tests/e2e/zj.ts key <byte>...   send bytes (13 Enter, 27 Esc, 3 Ctrl-C; 27 91 66 = Down)
 *   bun tests/e2e/zj.ts wait [seconds]  wait until the TUI has been idle for 4 seconds
 *   bun tests/e2e/zj.ts dump [full]     print the pane (full = with scrollback)
 *
 * Session: $REDACT_RESTORE_ZELLIJ (default redact-restore-live). See docs/TEST_PLAN.md.
 */
const session = process.env.REDACT_RESTORE_ZELLIJ ?? 'redact-restore-live';
const PANE = 'terminal_0';
/** Screen text that means the CLI is still working. */
const BUSY = /… \(\d+s|esc to interrupt|Running \d+ shell/;

function action(...args: string[]): string {
  const result = Bun.spawnSync(['zellij', '-s', session, 'action', ...args]);
  if (result.exitCode !== 0) throw new Error(`zellij action ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

function screen(full = false): string {
  return action('dump-screen', '-p', PANE, ...(full ? ['--full'] : []))
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

async function waitIdle(maxSeconds: number): Promise<number> {
  let quiet = 0;
  for (let second = 1; second <= maxSeconds; second += 1) {
    await Bun.sleep(1000);
    quiet = BUSY.test(screen()) ? 0 : quiet + 1;
    if (quiet >= 4) return second;
  }
  return maxSeconds;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'send':
    action('write-chars', '-p', PANE, rest.join(' '));
    await Bun.sleep(500);
    action('write', '-p', PANE, '13');
    break;
  case 'key':
    action('write', '-p', PANE, ...rest);
    break;
  case 'wait':
    console.log(`waited ${await waitIdle(Number(rest[0] ?? 180))}s`);
    break;
  case 'dump':
    console.log(screen(rest[0] === 'full'));
    break;
  default:
    console.error('usage: zj.ts send <text> | key <byte>... | wait [seconds] | dump [full]');
    process.exit(2);
}

export {};
