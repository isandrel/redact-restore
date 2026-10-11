import { normalizeCustomValues, type MatchingOptions } from './matcher.ts';
import { DEFAULT_POLICY, RESTORE_MODES, parsePatternList, type RestoreMode, type RestorePolicy } from './policy.ts';
import { STATUS_LINES, type StatusLine } from './status.ts';
import { selectDetectors } from './detectors.ts';
import { RULE_LABELS } from './defaults.ts';
import {
  createScheme,
  DEFAULT_FORMAT,
  DEFAULT_ID_LENGTH,
  formatProblem,
  LABEL_PATTERN,
  type PlaceholderScheme,
} from './placeholder.ts';

/** Plugin options as Claude Code hands them to `register` (PluginOptions). */
export type RawOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export interface RedactRestoreConfig {
  readonly enabled: boolean;
  readonly matching: MatchingOptions;
  /** Count of configured custom values ignored as too short; never the values. */
  readonly ignoredShortValues: number;
  /** Detector ids active this session (for the model note and status). */
  readonly detectorIds: readonly string[];
  /** Names in enable_detectors / disable_detectors that match no detector or group. */
  readonly unknownDetectors: readonly string[];
  /** Why `placeholder_format` was rejected (the default is used), or undefined. */
  readonly formatProblem: string | undefined;
  readonly placeholders: PlaceholderScheme;
  readonly restoreDisplay: boolean;
  /** Also restore in the live streamed reply (the engine records that text too; it is re-masked on store). */
  readonly restoreStreaming: boolean;
  readonly restore: RestorePolicy;
  readonly allowMedia: boolean;
  readonly statusLine: StatusLine;
  /** Template overriding the status_line preset; empty uses the preset. */
  readonly statusFormat: string;
  /** Write per-session counts for a custom status-line script. */
  readonly statusFile: boolean;
  /** Labels offered in the pane's rule form (`rule_labels`, or the built-in list). */
  readonly ruleLabels: readonly string[];
  readonly outboundAudit: boolean;
}

function flag(options: RawOptions, key: string, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
}

function patterns(options: RawOptions, key: string, fallback: readonly string[]): readonly string[] {
  const value = options[key];
  if (typeof value === 'string') return parsePatternList(value);
  if (Array.isArray(value)) return value.flatMap(item => parsePatternList(item));
  return fallback;
}

function restoreMode(value: RawOptions[string] | undefined): RestoreMode {
  return RESTORE_MODES.find(mode => mode === value) ?? DEFAULT_POLICY.mode;
}

function statusLine(value: RawOptions[string] | undefined): StatusLine {
  return STATUS_LINES.find(line => line === value) ?? 'count';
}

function stringList(value: RawOptions[string] | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/** `rule_labels` as valid, upper-cased, unique labels; the built-in list when empty or all invalid. */
function ruleLabels(value: RawOptions[string] | undefined): readonly string[] {
  const listed = stringList(value)
    .flatMap(item => parsePatternList(item))
    .map(label => label.toUpperCase())
    .filter(label => LABEL_PATTERN.test(label));
  return listed.length > 0 ? [...new Set(listed)] : RULE_LABELS;
}

/** Defaults mirror plugin.json and lean to the safe side when a value is missing. */
export function parseConfig(options: RawOptions): RedactRestoreConfig {
  const custom = normalizeCustomValues(stringList(options.custom_values));
  const format =
    typeof options.placeholder_format === 'string' && options.placeholder_format.trim()
      ? options.placeholder_format.trim()
      : DEFAULT_FORMAT;
  const idLength =
    typeof options.placeholder_id_length === 'number' ? options.placeholder_id_length : DEFAULT_ID_LENGTH;
  const placeholders = createScheme(format, idLength);
  const selection = selectDetectors(
    patterns(options, 'enable_detectors', []).map(name => name.toLowerCase()),
    patterns(options, 'disable_detectors', []).map(name => name.toLowerCase()),
  );
  return {
    enabled: flag(options, 'enabled', true),
    matching: {
      customValues: custom.values,
      customCaseInsensitive: flag(options, 'custom_case_insensitive', false),
      redactEmails: flag(options, 'redact_emails', true),
      placeholders,
      rules: custom.rules,
      detectors: selection.detectors,
    },
    detectorIds: selection.detectors.map(detector => detector.id),
    unknownDetectors: selection.unknown,
    ignoredShortValues: custom.tooShort,
    formatProblem: formatProblem(format),
    placeholders,
    restoreDisplay: flag(options, 'restore_display', true),
    restoreStreaming: flag(options, 'restore_streaming', false),
    restore: {
      mode: restoreMode(options.restore_mode),
      keepTools: patterns(options, 'keep_tools', DEFAULT_POLICY.keepTools),
      denyUnrestoredTools: patterns(options, 'deny_unrestored_tools', DEFAULT_POLICY.denyUnrestoredTools),
    },
    allowMedia: flag(options, 'allow_media', false),
    statusLine: statusLine(options.status_line),
    statusFormat: typeof options.status_format === 'string' ? options.status_format : '',
    statusFile: flag(options, 'status_file', false),
    ruleLabels: ruleLabels(options.rule_labels),
    outboundAudit: flag(options, 'outbound_audit', true),
  };
}
