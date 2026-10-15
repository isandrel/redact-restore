import { normalizeCustomValues, type MatchingOptions } from './matcher.ts';
import { patternDetector, patternProblem, type PatternRule } from './patterns.ts';
import { DEFAULT_POLICY, RESTORE_MODES, parsePatternList, type RestoreMode, type RestorePolicy } from './policy.ts';
import { STATUS_LINES, type StatusLine } from './status.ts';
import { selectDetectors } from './detectors.ts';
import {
  RULE_LABELS,
  SCAN_FILES_CEILING,
  SCAN_MAX_FILES,
  SCAN_SKIP_DIRS,
  DISPLAY_ROWS,
  type DisplayRow,
  DEFAULT_ID_MODE,
  PLACEHOLDER_ID_MODES,
  type PlaceholderIdMode,
  SESSION_MAP_DAYS,
  SESSION_MAP_DAYS_CEILING,
} from './defaults.ts';
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
  /** Patterns from `custom_patterns` that passed the checks, and how many did not (never which). */
  readonly optionPatterns: readonly PatternRule[];
  readonly invalidPatterns: number;
  /** Detector ids active this session (for the model note and status). */
  readonly detectorIds: readonly string[];
  /** Names in enable_detectors / disable_detectors that match no detector or group. */
  readonly unknownDetectors: readonly string[];
  /** Why `placeholder_format` was rejected (the default is used), or undefined. */
  readonly formatProblem: string | undefined;
  readonly placeholders: PlaceholderScheme;
  /** `placeholder_ids`: random per session, or stable across sessions. */
  readonly placeholderIds: PlaceholderIdMode;
  readonly restoreDisplay: boolean;
  /** Rendered rows restored for display (`restore_display_rows`). */
  readonly displayRows: readonly DisplayRow[];
  /** Also restore in the live streamed reply (the engine records that text too; it is re-masked on store). */
  readonly restoreStreaming: boolean;
  readonly restore: RestorePolicy;
  readonly allowMedia: boolean;
  readonly statusLine: StatusLine;
  /** Template overriding the status_line preset; empty uses the preset. */
  readonly statusFormat: string;
  /** Write per-session counts for a custom status-line script. */
  readonly statusFile: boolean;
  /**
   * Keep each session's placeholder map in a local file so `/resume` restores
   * (`persist_session_map`); delete files untouched for `days` (`session_map_days`, 0 = never).
   */
  readonly sessionMap: { readonly persist: boolean; readonly days: number };
  /** Labels offered in the pane's rule form (`rule_labels`, or the built-in list). */
  readonly ruleLabels: readonly string[];
  /** A path scan's limits: folders it skips (built-ins plus `scan_skip_dirs`) and files it reads at most. */
  readonly scan: { readonly skipDirs: readonly string[]; readonly maxFiles: number };
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

/** Known row names, case-insensitive; unknown names are dropped. */
function displayRows(names: readonly string[]): DisplayRow[] {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  return DISPLAY_ROWS.filter(row => wanted.has(row.toLowerCase()));
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
/** `stableKey` supplies the local key once loaded; it is used only when `placeholder_ids` is `stable`. */
export function parseConfig(options: RawOptions, stableKey?: () => string | undefined): RedactRestoreConfig {
  const custom = normalizeCustomValues(stringList(options.custom_values));
  const caseInsensitive = flag(options, 'custom_case_insensitive', false);
  // Each custom_patterns entry is one regex source, used whole: nothing in it is parsed.
  const patternEntries = stringList(options.custom_patterns)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map((pattern): PatternRule => ({ pattern, ignoreCase: caseInsensitive, wholeWord: true, group: 0 }));
  const optionPatterns = patternEntries.filter(rule => patternProblem(rule) === undefined);
  const format =
    typeof options.placeholder_format === 'string' && options.placeholder_format.trim()
      ? options.placeholder_format.trim()
      : DEFAULT_FORMAT;
  const idLength =
    typeof options.placeholder_id_length === 'number' ? options.placeholder_id_length : DEFAULT_ID_LENGTH;
  const placeholderIds = PLACEHOLDER_ID_MODES.find(mode => mode === options.placeholder_ids) ?? DEFAULT_ID_MODE;
  const placeholders = createScheme(format, idLength, placeholderIds === 'stable' ? stableKey : undefined);
  const selection = selectDetectors(
    patterns(options, 'enable_detectors', []).map(name => name.toLowerCase()),
    patterns(options, 'disable_detectors', []).map(name => name.toLowerCase()),
  );
  return {
    enabled: flag(options, 'enabled', true),
    matching: {
      customValues: custom.values,
      customCaseInsensitive: caseInsensitive,
      redactEmails: flag(options, 'redact_emails', true),
      placeholders,
      rules: custom.rules,
      detectors: [
        ...optionPatterns.map((rule, index) => patternDetector(rule, `option_pattern_${index}`)),
        ...selection.detectors,
      ],
    },
    detectorIds: selection.detectors.map(detector => detector.id),
    unknownDetectors: selection.unknown,
    ignoredShortValues: custom.tooShort,
    optionPatterns,
    invalidPatterns: patternEntries.length - optionPatterns.length,
    formatProblem: formatProblem(format),
    placeholders,
    placeholderIds,
    restoreDisplay: flag(options, 'restore_display', true),
    displayRows: displayRows(patterns(options, 'restore_display_rows', DISPLAY_ROWS)),
    restoreStreaming: flag(options, 'restore_streaming', true),
    restore: {
      mode: restoreMode(options.restore_mode),
      keepTools: patterns(options, 'keep_tools', DEFAULT_POLICY.keepTools),
      denyUnrestoredTools: patterns(options, 'deny_unrestored_tools', DEFAULT_POLICY.denyUnrestoredTools),
    },
    allowMedia: flag(options, 'allow_media', false),
    statusLine: statusLine(options.status_line),
    statusFormat: typeof options.status_format === 'string' ? options.status_format : '',
    statusFile: flag(options, 'status_file', false),
    sessionMap: {
      persist: flag(options, 'persist_session_map', true),
      // 0 keeps every file; a negative or missing value uses the default.
      days:
        typeof options.session_map_days === 'number' && options.session_map_days >= 0
          ? Math.min(Math.floor(options.session_map_days), SESSION_MAP_DAYS_CEILING)
          : SESSION_MAP_DAYS,
    },
    ruleLabels: ruleLabels(options.rule_labels),
    scan: {
      skipDirs: [...new Set([...SCAN_SKIP_DIRS, ...patterns(options, 'scan_skip_dirs', [])])],
      maxFiles:
        typeof options.scan_max_files === 'number' && options.scan_max_files > 0
          ? Math.min(Math.floor(options.scan_max_files), SCAN_FILES_CEILING)
          : SCAN_MAX_FILES,
    },
    outboundAudit: flag(options, 'outbound_audit', true),
  };
}
