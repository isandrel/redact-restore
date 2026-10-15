/**
 * Every tunable default in one place: limits, placeholder defaults, tool
 * lists, detection windows, scan sources, storage keys and user-facing text.
 * Modules import from here; person-facing options in plugin.json override the
 * ones they name. Algorithm tables (checksum weights, character classes) stay
 * beside their algorithms in detectors.ts and matcher.ts.
 */

// Matching
/** Shorter literals would shred ordinary text (single letters, common pairs). */
export const MIN_CUSTOM_VALUE_LENGTH = 3;
/** Text blocks the outbound audit remembers as clean (a very long session); past this it starts over. */
export const AUDIT_MEMO_LIMIT = 50_000;
/** Nesting depth walked when restoring tool input. */
export const MAX_INPUT_DEPTH = 32;

/** Pattern rules: a safe subset, checked deterministically (JavaScript has no regex timeout). */
export const PATTERN_LIMITS = {
  maxLength: 512,
  /** Open-ended repeats (`*`, `+`, `{n,}`) a pattern may use. */
  maxFreeRepeats: 2,
  /** The fixed text every match must contain; the regex runs only in windows around it. */
  minKeyword: 3,
} as const;

// Placeholders
export const DEFAULT_FORMAT = '{{PRIVATE:{label}#{id}}}';
export const DEFAULT_ID_LENGTH = 12;
export const MIN_ID_LENGTH = 8;
export const MAX_ID_LENGTH = 32;
export const EMAIL_LABEL = 'EMAIL';
export const CUSTOM_LABEL = 'CUSTOM';

// Restore policy
/** Tools that write local files: what `files` mode restores. */
export const FILE_TOOLS: readonly string[] = ['Write', 'Edit', 'NotebookEdit'];
/**
 * Tools whose input reaches a model or another session. Always kept: options
 * can add tools but never remove these, because restoring here would hand the
 * original values to a model, which is the one thing this mod exists to stop.
 */
export const BUILTIN_KEEP_TOOLS: readonly string[] = [
  // Their input becomes another model's prompt or reaches another session.
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'SendMessage',
  'Skill',
  'Workflow',
  'RemoteTrigger',
  'CronCreate',
  'ScheduleWakeup',
  // Their input is sent to Anthropic services.
  'SendFeedback',
  'PushNotification',
  'Artifact',
  'ArtifactData',
  'ArtifactComments',
];

// Detection windows (gitleaks keyword pre-filter)
/** Text around a keyword a rule can match within: before covers `[\w.-]{0,50}`-style lead-ins. */
export const KEYWORD_WINDOW_BEFORE = 256;
export const KEYWORD_WINDOW_AFTER = 1024;
/** How far a match touching the window's end may continue when rescanned. */
export const KEYWORD_RESCAN_LIMIT = 65_536;

// Rules store
/** One store key per rule or dismissed candidate, suffixed with the value's SHA-256. */
export const RULE_PREFIX = 'rule.';
export const IGNORED_PREFIX = 'ignored.';
export const PATTERN_PREFIX = 'pattern.';
export const EXPORT_FORMAT = 'redact-restore-rules';
export const EXPORT_VERSION = 1;
export const EXPORT_FILE = 'redact-restore-rules.json';
/** Dots in a masked preview (`P•••• (15)`). */
export const PREVIEW_DOTS = 4;

// Display
/**
 * Rendered rows that can show placeholders, and the props restored for drawing
 * on this machine. Add a row here to restore it; `restore_display_rows` picks
 * which ones are on. Only what is drawn changes: stored rows and model input keep placeholders.
 */
export const DISPLAY_RESTORE_FIELDS = {
  UserMessage: ['text'],
  AssistantMessage: ['text'],
  ToolUse: ['input', 'output'],
  ToolResult: ['output'],
  AskUserQuestion: ['questions'],
} as const satisfies Record<string, readonly string[]>;
export type DisplayRow = keyof typeof DISPLAY_RESTORE_FIELDS;
export const DISPLAY_ROWS = Object.keys(DISPLAY_RESTORE_FIELDS) as DisplayRow[];

// Scan
export const SCAN_TIMEOUT_MS = 5000;
export const SCAN_LOG_AUTHORS = 200;
export const SCAN_MAX_FILE_BYTES = 262_144;
/** A path scan looks at most at this many files (read or skipped), this many folders deep. */
export const SCAN_MAX_FILES = 2000;
/** The most `scan_max_files` may ask for. */
export const SCAN_FILES_CEILING = 20_000;
export const SCAN_MAX_DEPTH = 8;
/** Folders a path scan opens at most, so a huge tree of empty or skipped folders still ends. */
export const SCAN_MAX_DIRS = 5000;
/** Folders a path scan skips: dependencies, build output, version control. */
export const SCAN_SKIP_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  'vendor',
  '.next',
  'coverage',
  '.cache',
];
/** Host names on private networks: candidates a path scan offers as HOST. */
export const INTERNAL_HOST =
  /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:internal|corp|intranet|lan|local|private|localdomain|home\.arpa)(?![\w-])/gi;
/** Host names on private networks that say nothing about anyone. */
export const GENERIC_INTERNAL_HOST =
  /^(?:host\.docker\.internal|kubernetes\.default\.svc\.cluster\.local|[a-z0-9-]+\.svc\.cluster\.local)$/i;
/** Code hosts whose names are public; their owners are still candidates. */
export const PUBLIC_GIT_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'ssh.dev.azure.com',
  'dev.azure.com',
];
/** Account names too common to be private. */
export const GENERIC_ACCOUNTS: readonly string[] = [
  'root',
  'user',
  'admin',
  'runner',
  'ubuntu',
  'vagrant',
  'node',
  'default',
  'public',
];
export const BOT_AUTHOR = /\[bot\]|^dependabot|^github-actions|^renovate|noreply/i;
export const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/;
export const ENV_EXAMPLE = /\.(?:example|sample|template|dist|defaults?)$/i;
export const SECRET_KEY = /SECRET|TOKEN|PASSW(?:OR)?D|PWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH|SALT/i;
/** Values too ordinary to suggest as rules. */
export const TRIVIAL_VALUE =
  /^(?:true|false|yes|no|on|off|null|none|undefined|development|production|staging|test|debug|info|warn|error|localhost|127\.0\.0\.1|0\.0\.0\.0|changeme|example|xxx+|\*+|-?\d+(?:\.\d+)?)$/i;
/** Local-network suffixes dropped from the computer name. */
export const LOCAL_HOST_SUFFIX = /\.(?:local|lan|home|localdomain)$/i;

// Command and pane
/** Labels offered in the pane's rule form; any other valid label can be typed. */
export const RULE_LABELS: readonly string[] = [
  'CUSTOM',
  'NAME',
  'CUSTOMER',
  'ORG',
  'PROJECT',
  'HOST',
  'EMAIL',
  'USER',
  'SECRET',
  'ADDRESS',
  'PHONE',
];
/** Placeholders listed on the pane's Session tab (the newest). */
export const SESSION_PLACEHOLDER_LIMIT = 50;
export const COMMAND = 'redact-restore';
export const COMMAND_HINT = 'rules | scan [path] | test | session | status | export [file] | import <file> [--replace]';
export const PANE_ID = 'redact-restore';
export const PANE_TITLE = 'Redact Restore';

// User-facing text (never a value)
export const MESSAGES = {
  commandDescription: 'Redact Restore: manage private-value rules, scan for candidates, show status, import or export',
  usage: `Usage: /redact-restore ${COMMAND_HINT}`,
  blockedPrompt: 'Redact Restore: privacy scan failed; prompt not submitted.',
  unscannablePrompt:
    'Redact Restore: images and other attachments cannot be scanned for private values; remove them, ' +
    'or turn on "Allow unscannable media" in the plugin options.',
  restoreDenied: 'Redact Restore: a private placeholder could not be restored; tool call denied.',
  saveFailed: 'Redact Restore could not save the rules; nothing changed.',
  scanFailed: 'Scan failed.',
  testFailed: 'The check failed; nothing was sent.',
  commandFailed:
    'Redact Restore: the command failed; nothing was changed or only part of it was. Run /redact-restore status.',
  rulesUnreadable:
    'Redact Restore: saved rules could not be read from the plugin store; prompt not submitted. ' +
    'Retry, or check /redact-restore status.',
  alreadySent: ' If the value is already in this conversation, the next request is blocked: run /clear or /rewind.',
  withheld: '[Withheld by Redact Restore: privacy scan failed]',
} as const;
