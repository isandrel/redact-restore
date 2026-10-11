#!/usr/bin/env bun
/**
 * Holds a headless Zellij client attached at a fixed size, so the panes of a
 * background session get a usable terminal size. Runs until the session ends.
 *
 *   bun tests/e2e/zclient.ts            (session: $REDACT_RESTORE_ZELLIJ or redact-restore-live)
 */
const session = process.env.REDACT_RESTORE_ZELLIJ ?? 'redact-restore-live';

const client = Bun.spawn(['zellij', 'attach', session], {
  env: { ...process.env, TERM: 'xterm-256color' },
  terminal: {
    cols: 160,
    rows: 50,
    data() {
      /* the screen is read with `zj.ts dump` */
    },
  },
});

process.exit(await client.exited);

export {};
