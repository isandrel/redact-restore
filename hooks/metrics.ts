/**
 * Session counters for the status line and status file. Pure: every change
 * returns a new object, so register.ts can apply it with `update` on $.state.
 * Counts, kinds and positions only; never a value, placeholder or path.
 * The shapes are the state contract's, in types/index.d.ts.
 */
import type { RedactRestoreBlockInfo, RedactRestoreMetrics } from '../types/index.d.ts';

export type MaskSource = 'prompt' | 'context' | 'attachment' | 'systemPrompt' | 'conversation';

export type BlockInfo = RedactRestoreBlockInfo;
export type Metrics = RedactRestoreMetrics;

export function emptyMetrics(now: number, version = '', surface = ''): Metrics {
  return {
    startedAt: now,
    updatedAt: now,
    lastEvent: 'session.start',
    version,
    surface,
    occurrences: 0,
    bySource: {},
    lastTurnMasked: 0,
    restoredCalls: 0,
    restoredByTool: {},
    keptCalls: 0,
    deniedCalls: 0,
    audits: 0,
    blocked: 0,
    lastAuditBlocked: false,
    lastBlock: null,
    mediaWithheld: 0,
    promptsDropped: 0,
    hookErrors: {},
  };
}

function bump(counts: Readonly<Record<string, number>>, key: string, by = 1): Record<string, number> {
  return { ...counts, [key]: (counts[key] ?? 0) + by };
}

function touched(m: Metrics, event: string, now: number): Metrics {
  return { ...m, lastEvent: event, updatedAt: now };
}

/** A change to apply: `(metrics, now) => metrics`. */
export type MetricsChange = (m: Metrics, now: number) => Metrics;

export const metricsChange = {
  newTurn: (): MetricsChange => (m, now) => touched({ ...m, lastTurnMasked: 0 }, 'prompt.submit', now),
  masked:
    (source: MaskSource, count: number, event: string): MetricsChange =>
    (m, now) =>
      touched(
        {
          ...m,
          occurrences: m.occurrences + count,
          lastTurnMasked: m.lastTurnMasked + count,
          bySource: bump(m.bySource, source, count),
        },
        event,
        now,
      ),
  media:
    (count: number): MetricsChange =>
    (m, now) =>
      touched({ ...m, mediaWithheld: m.mediaWithheld + count }, 'session.append', now),
  promptDropped: (): MetricsChange => (m, now) =>
    touched({ ...m, promptsDropped: m.promptsDropped + 1 }, 'prompt.submit', now),
  tool:
    (tool: string, action: 'restore' | 'keep' | 'deny'): MetricsChange =>
    (m, now) =>
      touched(
        action === 'restore'
          ? { ...m, restoredCalls: m.restoredCalls + 1, restoredByTool: bump(m.restoredByTool, tool) }
          : action === 'keep'
            ? { ...m, keptCalls: m.keptCalls + 1 }
            : { ...m, deniedCalls: m.deniedCalls + 1 },
        'tool.call',
        now,
      ),
  audit:
    (block: BlockInfo | null): MetricsChange =>
    (m, now) =>
      touched(
        {
          ...m,
          audits: m.audits + 1,
          lastAuditBlocked: block !== null,
          blocked: m.blocked + (block ? 1 : 0),
          lastBlock: block ?? m.lastBlock,
        },
        'turn.step',
        now,
      ),
  hookError:
    (hook: string): MetricsChange =>
    (m, now) =>
      touched({ ...m, hookErrors: bump(m.hookErrors, hook) }, hook, now),
};

/** Applies several changes in order. */
export function combine(...changes: MetricsChange[]): MetricsChange {
  return (m, now) => changes.reduce((current, change) => change(current, now), m);
}

export type HealthState = 'ok' | 'warn' | 'blocked';

/** `blocked` while the last audited request was refused; `warn` on hook errors or rejected settings. */
export function healthState(m: Metrics, configProblems: number): HealthState {
  if (m.lastAuditBlocked) return 'blocked';
  const errors = Object.values(m.hookErrors).reduce((sum, n) => sum + n, 0);
  return errors > 0 || configProblems > 0 ? 'warn' : 'ok';
}
