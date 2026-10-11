/**
 * What the mod reports about itself: counts and settings only, never a value
 * or a placeholder. Pure; register.ts decides where it is shown or written.
 */
import type { Vault } from './privacy.ts';
import type { RestoreMode } from './policy.ts';
import { DEFAULT_SCHEME, EMAIL_LABEL, type PlaceholderScheme } from './placeholder.ts';
import { emptyMetrics, healthState, type HealthState, type Metrics } from './metrics.ts';
import { DETECTOR_LABELS } from './detectors.ts';

export type StatusLine = 'off' | 'count' | 'detailed';

export const STATUS_LINES: readonly StatusLine[] = ['off', 'count', 'detailed'];

export interface StatusStats {
  readonly masked: number;
  readonly emails: number;
  /** Values found by other built-in detectors (keys, cards, IDs, ...). */
  readonly detected: number;
  readonly custom: number;
  readonly mode: RestoreMode;
  readonly audit: boolean;
  readonly streaming: boolean;
  readonly occurrences: number;
  readonly lastTurn: number;
  readonly restored: number;
  readonly kept: number;
  readonly denied: number;
  readonly audits: number;
  readonly blocked: number;
  readonly media: number;
  readonly state: HealthState;
  readonly version: string;
}

/** Built-in templates; `status_format` replaces them when set. */
export const STATUS_TEMPLATES: Readonly<Record<Exclude<StatusLine, 'off'>, string>> = {
  count: '{masked} private values masked',
  detailed: '{masked} masked ({emails} email, {detected} detected, {custom} custom) · tools: {mode} · audit: {audit}',
};

/** Names a template may use: `{masked}`, `{blocked}`, ... */
export const STATUS_FIELDS: readonly (keyof StatusStats)[] = [
  'masked',
  'emails',
  'detected',
  'custom',
  'mode',
  'audit',
  'streaming',
  'occurrences',
  'lastTurn',
  'restored',
  'kept',
  'denied',
  'audits',
  'blocked',
  'media',
  'state',
  'version',
];

export interface StatusSettings {
  readonly mode: RestoreMode;
  readonly audit: boolean;
  readonly streaming: boolean;
  /** Rejected format plus ignored custom entries. */
  readonly configProblems: number;
}

export function statusStats(
  vault: Vault,
  settings: StatusSettings,
  metrics: Metrics = emptyMetrics(0),
  scheme: PlaceholderScheme = DEFAULT_SCHEME,
): StatusStats {
  const labels = Object.keys(vault).map(token => scheme.labelOf(token));
  const emails = labels.filter(label => label === EMAIL_LABEL).length;
  const detected = labels.filter(
    label => label !== undefined && label !== EMAIL_LABEL && DETECTOR_LABELS.has(label),
  ).length;
  return {
    masked: labels.length,
    emails,
    detected,
    custom: labels.length - emails - detected,
    mode: settings.mode,
    audit: settings.audit,
    streaming: settings.streaming,
    occurrences: metrics.occurrences,
    lastTurn: metrics.lastTurnMasked,
    restored: metrics.restoredCalls,
    kept: metrics.keptCalls,
    denied: metrics.deniedCalls,
    audits: metrics.audits,
    blocked: metrics.blocked,
    media: metrics.mediaWithheld,
    state: healthState(metrics, settings.configProblems),
    version: metrics.version,
  };
}

function show(value: StatusStats[keyof StatusStats]): string {
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

/**
 * The status text, or undefined to clear it: when the line is off, or while
 * nothing is masked. Unknown `{names}` stay as written.
 */
export function formatStatus(line: StatusLine, format: string, stats: StatusStats): string | undefined {
  if (line === 'off' || stats.masked === 0) return undefined;
  const template = format.trim() || STATUS_TEMPLATES[line];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    (STATUS_FIELDS as readonly string[]).includes(name) ? show(stats[name as keyof StatusStats]) : whole,
  );
}

/** Settings echoed in the status file; never values, labels or paths. */
export interface StatusFileConfig {
  readonly placeholderFormat: string;
  readonly idLength: number;
  readonly statusLine: StatusLine;
  readonly extraKeepTools: number;
  readonly ignoredRules: number;
  readonly formatProblem: boolean;
}

/** The JSON a status-line script reads (`status_file`). */
export function statusFileContent(
  stats: StatusStats,
  metrics: Metrics,
  config: StatusFileConfig,
  extra: { model?: string; updatedAt: number },
): string {
  const { bySource, restoredByTool, lastBlock, hookErrors, startedAt, lastEvent, surface } = metrics;
  return `${JSON.stringify({
    ...stats,
    ...extra,
    startedAt,
    lastEvent,
    surface,
    bySource,
    restoredByTool,
    lastBlock,
    hookErrors,
    config,
  })}\n`;
}
