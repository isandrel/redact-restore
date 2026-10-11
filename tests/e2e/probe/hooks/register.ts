import type { Register } from 'claude-code';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Placeholders in the default format ({{PRIVATE:<LABEL>#<12 hex>}}).
const TOKEN = /\{\{PRIVATE:[A-Za-z][A-Za-z0-9_]{0,31}#[a-f0-9]{12}\}\}/g;

// Test-only. Logs booleans and counts about raw model answers; never text or values.
/** The id's first six characters: enough to tell placeholders apart in a log, never a value. */
const short = (token: string): string => token.slice(-14, -8);

export const register: Register = on => {
  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e);
    const tokens = [...new Set((result.text ?? '').match(TOKEN) ?? [])];
    if (tokens.length > 0) {
      const held = await ($.state.get as (ref: unknown) => Promise<{ value?: Record<string, string> }>)({
        plugin: 'redact-restore',
        key: 'vault',
      });
      const vault = held.value ?? {};
      $.ui.log(`PROBE-ATT ${e.type} tokens=${tokens.map(t => short(t) + (t in vault ? '+' : '-')).join(',')}`);
    }
    return result;
  });

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    const tokens = [...new Set(result.answer.match(TOKEN) ?? [])];
    const held = await ($.state.get as (ref: unknown) => Promise<{ value?: Record<string, string> }>)({
      plugin: 'redact-restore',
      key: 'vault',
    });
    const vault = held.value ?? {};
    const known = tokens.filter(token => token in vault).length;
    // Synthetic test values, `|`-separated, from the test's environment: counted, never logged.
    const probes = ((await $.env.get('REDACT_RESTORE_PROBE_VALUES')) ?? '').split('|').filter(Boolean);
    const raw = probes.filter(value => result.answer.includes(value)).length;
    $.ui.log(
      `PROBE agent=${e.agentId ?? 'main'} placeholder=${tokens.length > 0} rawEmail=${EMAIL.test(result.answer)} ` +
        `rawValues=${raw}/${probes.length} ` +
        `tokensInVault=${known}/${tokens.length} vaultSize=${Object.keys(vault).length} ` +
        `answer=${tokens.map(short).join(',')} vault=${Object.keys(vault).map(short).join(',')}`,
    );
    return result;
  });
};
