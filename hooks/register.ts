import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, TurnStepChunk, TurnStepResult } from 'claude-code';
import { parseConfig, type RedactRestoreConfig } from './config.ts';
import {
  COMMAND,
  COMMAND_HINT,
  EXPORT_FILE,
  MESSAGES,
  PANE_ID,
  PANE_TITLE,
  SCAN_LOG_AUTHORS,
  DISPLAY_RESTORE_FIELDS,
  SESSION_MAP_DAYS,
  SESSION_MAP_DIR,
  LABEL_DESCRIPTIONS,
  LEGEND_MAX_ENTRIES,
  ID_KEY_STORE_KEY,
  type DisplayRow,
  SCAN_MAX_DEPTH,
  SCAN_MAX_DIRS,
  SCAN_MAX_FILE_BYTES,
  SCAN_TIMEOUT_MS,
} from './defaults.ts';
import { normalizeRules, type MatchingOptions } from './matcher.ts';
import {
  draftFrom,
  draftPattern,
  draftProblem,
  drawPane,
  formLabels,
  EMPTY_DRAFT,
  EMPTY_VIEW,
  sessionView,
  type PaneView,
  type RuleDraft,
  type ScanView,
  type SessionView,
} from './pane.tsx';
import type { ValueRule } from './placeholder.ts';
import {
  applyImport,
  applyPatternImport,
  describeProblem,
  displayPath,
  expandHome,
  exportRules,
  IGNORED_PREFIX,
  isRuleKey,
  makeRule,
  maskPreview,
  mergedRules,
  parseImport,
  isPatternKey,
  makePattern,
  parseStoredPatterns,
  parseStoredRules,
  PATTERN_PREFIX,
  patternsKey,
  RULE_PREFIX,
  ruleKey,
  rulesKey,
  sortRules,
  storeKeyFor,
  upsertRule,
  type StoredPattern,
  type StoredRule,
  upsertPattern,
} from './rules.ts';
import { describePatternProblem, patternDetector, patternKey } from './patterns.ts';
import {
  assignedValues,
  collectCandidates,
  countByLabel,
  fileCandidates,
  isEnvFile,
  maskedKinds,
  triage,
  type ScanCandidate,
} from './scan.ts';
import { isSessionId, parseSessionMap, type SessionMap, serializeSessionMap } from './session-map.ts';
import { formatStatus, statusFileContent, statusStats } from './status.ts';
import { combine, emptyMetrics, metricsChange, type Metrics, type MetricsChange } from './metrics.ts';
import { CUSTOM_LABEL, EMAIL_LABEL, isIdKey, newIdKey } from './placeholder.ts';
import { keptTools, toolAction, type RestorePolicy } from './policy.ts';
import {
  auditMessages,
  createAuditMemo,
  createMasker,
  createStreamRestorer,
  describeFindings,
  inputHasPlaceholder,
  maskContentBlocks,
  maskText,
  restoreInput,
  uniqueMatches,
  restoreFields,
  legendText,
  type Notes,
  unmaskText,
  withholdContentBlocks,
  type AuditMemo,
  type Vault,
} from './privacy.ts';

// Session-scoped reactive state survives source hot reload. A /clear resets it
// explicitly (session.end below). Any installed plugin can read $.state, so
// other mods are inside Redact Restore's trust boundary (docs/SECURITY.md).
const vault = atom({ plugin: 'redact-restore', key: 'vault' }, {} as Vault);
const metrics = atom({ plugin: 'redact-restore', key: 'metrics' }, emptyMetrics(0));
// Rules from the plugin store, mirrored per session so the pane and the hooks
// read one value; the store is read again on each prompt (other sessions edit
// it, and /clear or /resume reset $.state without a new session.start).
const rules = atom({ plugin: 'redact-restore', key: 'rules' }, [] as readonly StoredRule[]);
const patterns = atom({ plugin: 'redact-restore', key: 'patterns' }, [] as readonly StoredPattern[]);
const scanResult = atom({ plugin: 'redact-restore', key: 'scan' }, null as ScanView | null);
const pane = atom({ plugin: 'redact-restore', key: 'pane' }, EMPTY_VIEW);
interface Legend {
  readonly notes: Notes;
  readonly sent: Readonly<Record<string, true>>;
}
const EMPTY_LEGEND: Legend = { notes: {}, sent: {} };

// Descriptions of this session's placeholders, and which ones the model has been told.
const legend = atom({ plugin: 'redact-restore', key: 'legend' }, EMPTY_LEGEND);
// The session whose saved placeholder map was looked for (see loadSessionMap).
const mapChecked = atom({ plugin: 'redact-restore', key: 'mapChecked' }, null as string | null);

function unrestoredDenied(tool: string): string {
  return (
    `Redact Restore: ${tool} would receive private placeholder text, and restoration is off for it ` +
    '("restore_mode"). Rewrite the call without placeholders, or change the option.'
  );
}

/**
 * Records new token mappings (the only writer of the vault) and a counter
 * change, then refreshes the status. Counters and status are informational:
 * their failure never fails the hook, while a failed vault write does (and the
 * hook's fallback then masks without recording).
 */
async function record(
  $: EngineInterface,
  config: RedactRestoreConfig,
  additions: Vault,
  change?: MetricsChange,
  notes: Notes = {},
): Promise<void> {
  if (Object.keys(notes).length > 0)
    await update($, legend, current => ({ ...current, notes: { ...current.notes, ...notes } }));
  const stored =
    Object.keys(additions).length > 0 ? await update($, vault, current => ({ ...current, ...additions })) : undefined;
  if (stored) lastVault = stored;
  if (stored || Object.keys(notes).length > 0) {
    try {
      await saveSessionMap($);
    } catch {
      // The map is for /resume only: a failed write must not block masking.
    }
  }
  if (!change && !stored) return;
  try {
    const counters = change ? await update($, metrics, current => change(current, Date.now())) : await read($, metrics);
    await publishStatus($, stored ?? (await vaultNow($)), counters, config);
  } catch {
    // Reporting must not block masking.
  }
}

/** Counts a hook failure from its fallback; never throws. */
async function recordHookError($: EngineInterface, config: RedactRestoreConfig, hook: string): Promise<void> {
  try {
    await record($, config, {}, metricsChange.hookError(hook));
  } catch {
    // A fallback's own $ calls may be refused (re-entry); the count is best effort.
  }
}

/** Settings Redact Restore had to ignore: short values, bad rules, unknown detectors, a bad format. */
function configProblems(config: RedactRestoreConfig): number {
  return (
    config.ignoredShortValues + config.invalidPatterns + config.unknownDetectors.length + (config.formatProblem ? 1 : 0)
  );
}

/**
 * Shows the status line and, when asked, writes the counts a status-line
 * script reads.
 */
async function publishStatus(
  $: EngineInterface,
  current: Vault,
  counters: Metrics,
  config: RedactRestoreConfig,
): Promise<void> {
  const stats = statusStats(
    current,
    {
      mode: config.restore.mode,
      audit: config.outboundAudit,
      streaming: config.restoreStreaming,
      configProblems: configProblems(config),
    },
    counters,
    config.placeholders,
  );
  $.ui.status(formatStatus(config.statusLine, config.statusFormat, stats));
  if (!config.statusFile) return;
  const home = await homeDir($);
  if (!home) return;
  await $.fs.write(
    `${home}/.claude/redact-restore/status/${await $.session.id()}.json`,
    statusFileContent(
      stats,
      counters,
      {
        placeholderFormat: config.placeholders.format,
        idLength: config.placeholders.idLength,
        statusLine: config.statusLine,
        extraKeepTools: config.restore.keepTools.length,
        ignoredRules: config.ignoredShortValues,
        formatProblem: config.formatProblem !== undefined,
      },
      { model: await $.session.model(), updatedAt: Date.now() },
    ),
  );
}

/** The plugin's version from its manifest, or '' when unreadable. */
async function pluginVersion($: EngineInterface): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)));
    return manifest && typeof manifest === 'object' && 'version' in manifest ? String(manifest.version) : '';
  } catch {
    return '';
  }
}

/** What the top-level helpers need from `register`: they may take `$`, closures may not. */
interface Context {
  readonly config: RedactRestoreConfig;
  /** Rules from the plugin options (keychain), normalized. */
  readonly optionRules: readonly ValueRule[];
  /** The local key for stable placeholder ids, once loaded (`placeholder_ids: stable`). */
  readonly idKey: { value?: string };
}

/**
 * The last vault this module read, for fallbacks (which may not call $): known
 * values then keep their placeholders, so a failure does not change text the
 * prompt cache has already seen.
 */
let lastVault: Vault = {};

async function vaultNow($: EngineInterface): Promise<Vault> {
  let current = await read($, vault);
  if (sessionMapSettings.persist && isEmpty(current)) {
    try {
      current = (await loadSessionMap($)) ?? current;
    } catch {
      // The saved map only helps after /resume; masking goes on without it.
    }
  }
  lastVault = current;
  return current;
}

function isEmpty(record: object): boolean {
  for (const _ in record) return false;
  return true;
}

// Session maps: each session's placeholder map in a local file, so /resume (which
// starts $.state empty) restores what earlier turns masked. Set from the options.
let sessionMapSettings: RedactRestoreConfig['sessionMap'] = { persist: false, days: SESSION_MAP_DAYS };
let mapSaving: Promise<void> | undefined;
let mapDirty = false;
const mapPathsReady = new Set<string>();

async function sessionMapDir($: EngineInterface): Promise<string | undefined> {
  const home = await homeDir($);
  return home ? `${home.replace(/[\\/]+$/, '')}/${SESSION_MAP_DIR}` : undefined;
}

async function sessionMapPath($: EngineInterface): Promise<string | undefined> {
  const dir = await sessionMapDir($);
  const id = await $.session.id();
  return dir && isSessionId(id) ? `${dir}/${id}.json` : undefined;
}

/** Brings back the session's saved map once, after a resume or a restart. */
async function loadSessionMap($: EngineInterface): Promise<Vault | undefined> {
  // Kept in $.state, which a resume empties: each resumed session looks once.
  const id = await $.session.id();
  if ((await read($, mapChecked)) === id) return undefined;
  await update($, mapChecked, () => id);
  const path = await sessionMapPath($);
  if (!path) return undefined;
  let saved: SessionMap | undefined;
  try {
    saved = parseSessionMap(String(await $.fs.read(path)));
  } catch {
    return undefined; // No saved map: a new session.
  }
  if (!saved || isEmpty(saved.vault)) return undefined;
  const { vault: savedVault, notes, sent } = saved;
  const merged = await update($, vault, current => ({ ...savedVault, ...current }));
  await update($, legend, current => ({
    notes: { ...notes, ...current.notes },
    sent: { ...sent, ...current.sent },
  }));
  return merged;
}

/** A tool result with a note added after its content, as the model reads it. */
function withNote<T extends { readonly type: string }>(block: T, note: string): T {
  const content = (block as { readonly content?: unknown }).content;
  if (typeof content === 'string') return { ...block, content: `${content}\n\n${note}` };
  if (Array.isArray(content)) return { ...block, content: [...content, { type: 'text', text: note }] };
  return { ...block, content: note };
}

/** Described placeholders the model has not been told about yet, oldest first. */
async function untoldNotes($: EngineInterface, notes: Notes, additions: Vault): Promise<Array<[string, string]>> {
  const told = await read($, legend);
  const known = { ...(await vaultNow($)), ...additions };
  return Object.entries({ ...told.notes, ...notes })
    .filter(([token]) => known[token] !== undefined && !told.sent[token])
    .slice(0, LEGEND_MAX_ENTRIES);
}

async function markTold($: EngineInterface, entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
  if (entries.length === 0) return;
  await update($, legend, current => ({
    ...current,
    sent: { ...current.sent, ...Object.fromEntries(entries.map(([token]) => [token, true] as const)) },
  }));
  await saveSessionMap($).catch(ignore);
}

/**
 * The vault for drawing. A render may not write $.state, so after a resume the
 * rows drawn before the next event read the saved map without loading it.
 */
let drawnMap: { readonly id: string; readonly vault: Vault } | undefined;
async function displayVault($: EngineInterface): Promise<Vault> {
  const current = await read($, vault);
  if (!sessionMapSettings.persist || !isEmpty(current)) return current;
  try {
    const id = await $.session.id();
    if (drawnMap?.id !== id) {
      // Remembered per session, found or not: a missing file is not read again on every draw.
      drawnMap = { id, vault: {} };
      const path = await sessionMapPath($);
      const saved = path ? parseSessionMap(String(await $.fs.read(path).catch(() => ''))) : undefined;
      if (saved) drawnMap = { id, vault: saved.vault };
    }
    return drawnMap.vault;
  } catch {
    return current;
  }
}

/** Writes the session's map; saves that arrive while one runs are folded into one more. */
async function saveSessionMap($: EngineInterface): Promise<void> {
  if (!sessionMapSettings.persist) return;
  if (mapSaving) {
    mapDirty = true;
    return mapSaving;
  }
  mapSaving = (async () => {
    do {
      mapDirty = false;
      await writeSessionMap($);
    } while (mapDirty);
  })().finally(() => {
    mapSaving = undefined;
  });
  return mapSaving;
}

async function writeSessionMap($: EngineInterface): Promise<void> {
  const path = await sessionMapPath($);
  const current = await read($, vault);
  if (!path || isEmpty(current)) return;
  const told = await read($, legend);
  // Owner-only folder and file where the system has chmod; elsewhere the home folder's own access applies.
  if (!mapPathsReady.has(path)) await runQuietly($, ['mkdir', '-p', '-m', '700', path.slice(0, path.lastIndexOf('/'))]);
  await $.fs.write(path, serializeSessionMap({ vault: current, notes: told.notes, sent: told.sent }, new Date()));
  if (!mapPathsReady.has(path)) {
    await runQuietly($, ['chmod', '600', path]);
    mapPathsReady.add(path);
  }
}

/** Deletes maps of sessions untouched for `session_map_days`. */
async function pruneSessionMaps($: EngineInterface): Promise<void> {
  const dir = await sessionMapDir($);
  if (!dir) return;
  let entries: readonly { name: string; kind: string; mtimeMs: number }[];
  try {
    entries = await $.fs.list(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - sessionMapSettings.days * 86_400_000;
  const old = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json') && entry.mtimeMs < cutoff)
    .map(entry => `${dir}/${entry.name}`);
  if (old.length > 0) await runQuietly($, ['rm', '-f', '--', ...old]);
}

// Text the audit found clean, per matching options: new rules or detectors start a fresh memo.
const auditMemos = new WeakMap<MatchingOptions, AuditMemo>();
function auditMemoFor(matching: MatchingOptions): AuditMemo {
  let memo = auditMemos.get(matching);
  if (!memo) {
    memo = createAuditMemo();
    auditMemos.set(matching, memo);
  }
  return memo;
}

/** The home folder on macOS, Linux (HOME) and Windows (USERPROFILE). */
async function homeDir($: EngineInterface): Promise<string | undefined> {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || undefined;
}

// Options plus stored rules; rebuilt only when either changes.
const mergedCache = new WeakMap<RedactRestoreConfig, { key: string; options: MatchingOptions }>();
/** The last merged rules, for fallbacks after a reload (a superset is safe: it only masks more). */
let lastMerged: MatchingOptions | undefined;

function matchingFor(
  ctx: Context,
  stored: readonly StoredRule[],
  storedPatterns: readonly StoredPattern[] = [],
): MatchingOptions {
  const { matching } = ctx.config;
  if (stored.length === 0 && storedPatterns.length === 0) return matching;
  const key = `${rulesKey(stored)}\u0000${patternsKey(storedPatterns)}`;
  const cached = mergedCache.get(ctx.config);
  if (cached?.key === key) return cached.options;
  const normalized = normalizeRules(mergedRules(ctx.optionRules, stored));
  const options = {
    ...matching,
    customValues: normalized.values,
    rules: normalized.rules,
    detectors: [
      ...storedPatterns.map((rule, index) => patternDetector(rule, `pattern_${index}`)),
      ...(matching.detectors ?? []),
    ],
  };
  mergedCache.set(ctx.config, { key, options });
  lastMerged = options;
  return options;
}

async function currentMatching($: EngineInterface, ctx: Context): Promise<MatchingOptions> {
  await ensureIdKey($, ctx);
  return matchingFor(ctx, await read($, rules), await read($, patterns));
}

/**
 * Loads the key for stable ids from the plugin store, or makes one. Until it
 * loads (or if the store fails), placeholders are random: never less private.
 */
async function ensureIdKey($: EngineInterface, ctx: Context): Promise<void> {
  if (ctx.config.placeholderIds !== 'stable' || ctx.idKey.value !== undefined) return;
  try {
    let key = await $.store.get(ID_KEY_STORE_KEY);
    if (!isIdKey(key)) {
      await $.store.set(ID_KEY_STORE_KEY, newIdKey());
      // Read back: two sessions starting together adopt the key written last.
      key = await $.store.get(ID_KEY_STORE_KEY);
    }
    if (isIdKey(key)) ctx.idKey.value = key;
  } catch {
    // Random ids for now; the next masking tries again.
  }
}

/** For fallbacks, which may not call $: the last merged rules, a superset of the options. */
function fallbackMatching(ctx: Context): MatchingOptions {
  return mergedCache.get(ctx.config)?.options ?? lastMerged ?? ctx.config.matching;
}

/**
 * Reads the stored rules (one store key per rule, so concurrent sessions never
 * overwrite each other's edits) into the session. Keeps the session's copy when
 * the store is unreadable.
 */
async function loadRules($: EngineInterface, strict = false): Promise<readonly StoredRule[]> {
  const current = await read($, rules);
  let stored: StoredRule[];
  let storedPatterns: StoredPattern[];
  try {
    const keys = await $.store.keys();
    const ruleKeys = keys.filter(isRuleKey);
    const patternKeys = keys.filter(isPatternKey);
    const [rawRules, rawPatterns] = await Promise.all([
      Promise.all(ruleKeys.map(key => $.store.get(key))),
      Promise.all(patternKeys.map(key => $.store.get(key))),
    ]);
    stored = sortRules(parseStoredRules(rawRules));
    storedPatterns = parseStoredPatterns(rawPatterns);
  } catch (error) {
    // Prompts must not go out without the saved rules (prompt.submit is strict);
    // the pane and commands work on the session's copy.
    if (strict) throw error;
    return current;
  }
  if (rulesKey(stored) !== rulesKey(current)) await update($, rules, () => stored);
  if (patternsKey(storedPatterns) !== patternsKey(await read($, patterns))) {
    await update($, patterns, () => storedPatterns);
  }
  return stored;
}

async function putPattern($: EngineInterface, pattern: StoredPattern): Promise<void> {
  await $.store.set(await storeKeyFor(PATTERN_PREFIX, patternKey(pattern)), pattern);
}

async function deletePattern($: EngineInterface, pattern: StoredPattern): Promise<void> {
  await $.store.delete(await storeKeyFor(PATTERN_PREFIX, patternKey(pattern)));
  await loadRules($);
  await setNotice($, 'Pattern removed. This session keeps masking what it already masked until /clear.');
}

/** The rule as the list now holds it (an update keeps its added time). */
function savedRule(list: readonly StoredRule[], rule: StoredRule): StoredRule {
  return list.find(one => ruleKey(one.value) === ruleKey(rule.value)) ?? rule;
}

async function putRule($: EngineInterface, rule: StoredRule): Promise<void> {
  await $.store.set(await storeKeyFor(RULE_PREFIX, rule.value), rule);
}

async function setNotice($: EngineInterface, notice: string, change: Partial<PaneView> = {}): Promise<void> {
  await update($, pane, current => ({ ...current, ...change, notice }));
}

/** Runs a command for the scan; an error or a missing program reads as no output. */
async function runQuietly($: EngineInterface, argv: readonly string[]): Promise<string> {
  try {
    const result = await $.process.run(argv, { timeoutMs: SCAN_TIMEOUT_MS });
    return result.exitCode === 0 ? result.stdout : '';
  } catch {
    return '';
  }
}

/**
 * Saves the pane's rule form. `patch` carries a field's latest text when Enter
 * submitted it (its last change may not be in the draft yet). While editing,
 * the value is fixed: only the label or alias changes.
 */
async function saveDraft($: EngineInterface, ctx: Context, patch: Partial<RuleDraft> = {}): Promise<void> {
  const draft: RuleDraft = { ...EMPTY_DRAFT, ...(await read($, pane)).draft, ...patch };
  const problem = draftProblem(draft);
  if (problem) {
    await setNotice($, describeProblem(problem), { draft });
    return;
  }
  if (draft.kind === 'pattern') {
    await savePatternDraft($, ctx, draft);
    return;
  }
  const stored = await loadRules($);
  const value = draft.value.trim();
  const label = draft.label.trim().toUpperCase();
  const ignoreCase = draft.ignoreCase === 'default' ? {} : { ignoreCase: draft.ignoreCase === 'yes' };
  const description = draft.description.trim() ? { description: draft.description.trim() } : {};
  const parsed = makeRule(
    draft.mode === 'alias'
      ? { value, alias: draft.alias.trim(), ...ignoreCase, ...description }
      : { value, ...(label !== CUSTOM_LABEL ? { label } : {}), ...ignoreCase, ...description },
    'manual',
    new Date(),
    [...ctx.optionRules, ...stored],
  );
  if (!('rule' in parsed)) {
    await setNotice($, describeProblem(parsed.problem), { draft });
    return;
  }
  const result = upsertRule(stored, parsed.rule);
  if (result.change !== 'unchanged') await putRule($, savedRule(result.rules, parsed.rule));
  await loadRules($);
  const notice =
    result.change === 'unchanged'
      ? `${maskPreview(parsed.rule.value)} is already saved like this.`
      : `${maskPreview(parsed.rule.value)} ${result.change}.${MESSAGES.alreadySent}`;
  await setNotice($, notice, { draft: EMPTY_DRAFT });
}

/** Saves a pattern rule from the form: checked (example included) before it is stored. */
async function savePatternDraft($: EngineInterface, ctx: Context, draft: RuleDraft): Promise<void> {
  const made = makePattern(draftPattern(draft, ctx.config.matching.customCaseInsensitive), 'manual', new Date());
  if (!('pattern' in made)) {
    await setNotice($, describePatternProblem(made.problem), { draft });
    return;
  }
  await loadRules($);
  const result = upsertPattern(await read($, patterns), made.pattern);
  const saved = result.patterns.find(one => patternKey(one) === patternKey(made.pattern)) ?? made.pattern;
  if (result.change !== 'unchanged') await putPattern($, saved);
  await loadRules($);
  const notice =
    result.change === 'unchanged'
      ? 'That pattern is already saved like this.'
      : `Pattern ${result.change}.${MESSAGES.alreadySent}`;
  await setNotice($, notice, { draft: EMPTY_DRAFT });
}

async function setDraft($: EngineInterface, change: Partial<RuleDraft>): Promise<void> {
  await update($, pane, current => ({ ...current, draft: { ...EMPTY_DRAFT, ...current.draft, ...change } }));
}

/** For pane handlers whose failure leaves nothing to undo (a view switch, a draft keystroke). */
function ignore(): void {}

/**
 * Checks pasted text as the masking hooks would, with the session's known values
 * and placeholders, but records nothing: the result stays in the pane.
 */
async function testText($: EngineInterface, ctx: Context, text: string): Promise<void> {
  if (!text.trim()) {
    await update($, pane, current => ({ ...current, test: undefined, notice: '' }));
    return;
  }
  const matching = matchingFor(ctx, await loadRules($), await read($, patterns));
  const masked = maskText(text, matching, await vaultNow($));
  const found = uniqueMatches(text, matching, await vaultNow($));
  await update($, pane, current => ({ ...current, notice: '', test: { text, masked: masked.text, found } }));
}

/** Closing the pane drops an unsaved draft and a tested text: both may hold originals. */
async function closePane($: EngineInterface): Promise<void> {
  await update($, pane, current => ({ ...current, draft: EMPTY_DRAFT, test: undefined, notice: '' }));
  await $.ui.close({ id: PANE_ID });
}

async function deleteRule($: EngineInterface, value: string): Promise<void> {
  await $.store.delete(await storeKeyFor(RULE_PREFIX, value));
  await loadRules($);
  await setNotice($, `${maskPreview(value)} removed. This session keeps masking it until /clear; new sessions do not.`);
}

/** Looks for candidates on this machine and in the working folder; values stay in the pane's state. */
async function scanNow($: EngineInterface, ctx: Context): Promise<ScanView> {
  const home = await homeDir($);
  let entries: readonly { name: string; kind: string; size: number }[] = [];
  try {
    entries = await $.fs.list();
  } catch {
    // No readable working folder: scan the machine-level sources only.
  }
  const envFiles: Array<{ name: string; text: string }> = [];
  let packageJson: string | undefined;
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.size > SCAN_MAX_FILE_BYTES) continue;
    try {
      if (isEnvFile(entry.name)) envFiles.push({ name: entry.name, text: String(await $.fs.read(entry.name)) });
      else if (entry.name === 'package.json') packageJson = String(await $.fs.read(entry.name));
    } catch {
      // Unreadable files are skipped.
    }
  }
  const found = collectCandidates({
    gitName: await runQuietly($, ['git', 'config', '--get', 'user.name']),
    gitEmail: await runQuietly($, ['git', 'config', '--get', 'user.email']),
    remotes: await runQuietly($, ['git', 'remote', '-v']),
    logAuthors: await runQuietly($, ['git', 'log', `-n${SCAN_LOG_AUTHORS}`, '--format=%an%x00%ae']),
    hostname: await runQuietly($, ['hostname']),
    ...(home ? { home } : {}),
    envFiles,
    ...(packageJson ? { packageJson } : {}),
  });
  const ignored = await ignoredFingerprints($);
  const result = await triage(found, matchingFor(ctx, await loadRules($), await read($, patterns)), ignored);
  await update($, scanResult, () => result);
  return result;
}

/**
 * Reads the text files under a folder (or one file) for a path scan: skipped
 * folders, binary files and files over the size limit are left out. Every file
 * looked at counts toward the file limit, read or not. Nothing read here is
 * sent anywhere; the caller keeps candidates in the pane's state.
 */
async function readTextFiles(
  $: EngineInterface,
  ctx: Context,
  root: string,
): Promise<{ files: Array<{ name: string; text: string }>; skipped: number; partial: boolean }> {
  const files: Array<{ name: string; text: string }> = [];
  const { skipDirs, maxFiles } = ctx.config.scan;
  let seen = 0;
  let dirs = 0;
  let partial = false;
  const addFile = async (path: string, name: string, size: number) => {
    seen += 1;
    if (size > SCAN_MAX_FILE_BYTES) return;
    try {
      const text = String(await $.fs.read(path));
      if (!text.slice(0, 1024).includes('\u0000')) files.push({ name, text });
    } catch {
      // Unreadable files are skipped.
    }
  };
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (dirs >= SCAN_MAX_DIRS) {
      partial = true;
      return;
    }
    dirs += 1;
    let entries: readonly { name: string; kind: string; size: number }[];
    try {
      entries = await $.fs.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skipped folders and other kinds are never looked at: they do not make a scan partial.
      if (entry.kind === 'dir' ? skipDirs.includes(entry.name) : entry.kind !== 'file') continue;
      if (seen >= maxFiles || dirs > SCAN_MAX_DIRS) {
        partial = true;
        return;
      }
      const path = `${dir}/${entry.name}`;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'dir') {
        if (depth < SCAN_MAX_DEPTH) await walk(path, name, depth + 1);
        else partial = true;
      } else if (entry.kind === 'file') {
        await addFile(path, name, entry.size);
      }
    }
  };
  let stat: { kind: string; size: number } | undefined;
  try {
    stat = await $.fs.stat(root);
  } catch {
    // Missing or unreadable: nothing to read.
  }
  if (stat?.kind === 'dir') await walk(root.replace(/[\\/]+$/, '') || root, '', 0);
  else if (stat?.kind === 'file') await addFile(root, root.split(/[\\/]/).pop() ?? root, stat.size);
  return { files, skipped: seen - files.length, partial };
}

/** Scans a folder or file on this machine: new candidates to the pane, counts by label to the caller. */
async function scanPath($: EngineInterface, ctx: Context, target: string): Promise<ScanView> {
  const home = await homeDir($);
  const root = expandHome(target, home);
  const { files, skipped, partial } = await readTextFiles($, ctx, root);
  const matching = matchingFor(ctx, await loadRules($), await read($, patterns));
  const ignored = await ignoredFingerprints($);
  const envOn = ctx.config.detectorIds.includes('env_assignment');
  const assigned = assignedValues(files);
  const result: ScanView = {
    ...(await triage(fileCandidates(files), matching, ignored, candidate => envOn && assigned.has(candidate.value))),
    target: displayPath(root, home),
    files: files.length,
    ...(skipped ? { skipped } : {}),
    ...(partial ? { partial } : {}),
    kinds: maskedKinds(files, matching),
  };
  await update($, scanResult, () => result);
  return result;
}

/** Scan again what was scanned last: the same folder, or this machine. */
async function rescan($: EngineInterface, ctx: Context): Promise<void> {
  const last = await read($, scanResult);
  if (last?.target) await scanPath($, ctx, expandHome(last.target, await homeDir($)));
  else await scanNow($, ctx);
}

/** What a scan tells the model: counts by label, and the path as shown (`~/…`); never a value. */
function scanSummary(result: ScanView): string {
  const left = [
    result.skipped ? `${result.skipped} skipped as binary, too large or unreadable` : '',
    result.partial ? 'stopped at a file, folder or depth limit' : '',
  ].filter(Boolean);
  const where = result.target
    ? `Scan of ${result.target} (${result.files ?? 0} file(s) read${left.length ? `; ${left.join('; ')}` : ''})`
    : 'Scan';
  const masked = result.kinds?.length
    ? ` Already masked in these files: ${result.kinds.map(([label, count]) => `${count} ${label}`).join(', ')}.`
    : '';
  return (
    `${where} found ${result.candidates.length} new candidate(s)` +
    (result.candidates.length ? ` (${countByLabel(result.candidates)})` : '') +
    `; ${result.covered} already masked, ${result.ignored} ignored before.${masked} ` +
    'Review them in the Redact Restore pane. Values are shown only there, on this machine.'
  );
}

async function ignoredFingerprints($: EngineInterface): Promise<Set<string>> {
  const ignored = new Set<string>();
  try {
    for (const key of await $.store.keys())
      if (key.startsWith(IGNORED_PREFIX)) ignored.add(key.slice(IGNORED_PREFIX.length));
  } catch {
    // An unreadable ignore list shows every candidate again.
  }
  return ignored;
}

async function ignoreCandidate($: EngineInterface, candidate: ScanCandidate): Promise<void> {
  await $.store.set(await storeKeyFor(IGNORED_PREFIX, candidate.value), true);
  await update($, scanResult, current =>
    current
      ? {
          ...current,
          candidates: current.candidates.filter(one => one.value !== candidate.value),
          ignored: current.ignored + 1,
        }
      : current,
  );
  await setNotice($, `${maskPreview(candidate.value)} ignored; later scans skip it.`);
}

async function acceptCandidates($: EngineInterface, ctx: Context, accepted: readonly ScanCandidate[]): Promise<void> {
  let stored = [...(await loadRules($))];
  const now = new Date();
  const taken: string[] = [];
  for (const candidate of accepted) {
    const existing = [...ctx.optionRules, ...stored];
    const input = { value: candidate.value, label: candidate.label };
    let parsed = makeRule(
      candidate.description ? { ...input, description: candidate.description } : input,
      'scan',
      now,
      existing,
    );
    // A suggested description that does not fit is dropped, not the rule.
    if ('problem' in parsed && parsed.problem.includes('description')) parsed = makeRule(input, 'scan', now, existing);
    if (!('rule' in parsed)) continue;
    const result = upsertRule(stored, parsed.rule);
    stored = result.rules;
    if (result.change !== 'unchanged') await putRule($, savedRule(result.rules, parsed.rule));
    taken.push(candidate.value);
  }
  await loadRules($);
  await update($, scanResult, current =>
    current
      ? {
          ...current,
          candidates: current.candidates.filter(one => !taken.includes(one.value)),
          covered: current.covered + taken.length,
        }
      : current,
  );
  await setNotice($, `${taken.length} rule(s) added.${taken.length > 0 ? MESSAGES.alreadySent : ''}`);
}

async function acceptAll($: EngineInterface, ctx: Context): Promise<void> {
  await acceptCandidates($, ctx, (await read($, scanResult))?.candidates ?? []);
}

async function exportTo($: EngineInterface, target: string): Promise<string> {
  const home = await homeDir($);
  const path = target ? expandHome(target, home) : home ? `${home}/.claude/redact-restore/${EXPORT_FILE}` : EXPORT_FILE;
  const stored = await loadRules($);
  const savedPatterns = await read($, patterns);
  await $.fs.write(path, exportRules(stored, new Date(), savedPatterns));
  const withPatterns = savedPatterns.length ? ` and ${savedPatterns.length} pattern(s)` : '';
  return (
    `Exported ${stored.length} saved rule(s)${withPatterns} to ${displayPath(path, home)}. Rules in the plugin options ` +
    '(keychain) are not exported. The file holds the original values in plain text: keep it out of ' +
    'version control and delete it after importing.'
  );
}

async function importFrom($: EngineInterface, ctx: Context, args: string): Promise<string> {
  const replace = /(?:^|\s)--replace(?:\s|$)/.test(args);
  const target = args.replace(/(?:^|\s)--replace(?=\s|$)/, '').trim();
  if (!target) return MESSAGES.usage;
  const home = await homeDir($);
  const path = expandHome(target, home);
  let text: string;
  try {
    text = String(await $.fs.read(path));
  } catch {
    return `Could not read ${displayPath(path, home)}.`;
  }
  const parsed = parseImport(text);
  if ('error' in parsed) return `Nothing imported: ${parsed.error}`;
  const before = await loadRules($, true);
  const beforePatterns = await read($, patterns);
  const mode = replace ? 'replace' : 'merge';
  // A file without a patterns list (an older export) leaves the saved patterns alone.
  const patternMode = replace && parsed.patterns ? 'replace' : 'merge';
  const summary = applyImport(before, parsed.items, mode, new Date(), ctx.optionRules);
  const patternSummary = applyPatternImport(beforePatterns, parsed.patterns ?? [], patternMode, new Date());
  // Replacing drops every saved rule: only from a file whose every entry is valid.
  const invalid = summary.invalid + patternSummary.invalid;
  const valid =
    summary.added +
    summary.updated +
    summary.unchanged +
    patternSummary.added +
    patternSummary.updated +
    patternSummary.unchanged;
  if (replace && (invalid > 0 || valid === 0)) {
    return (
      `Nothing imported: --replace needs a file whose entries are all valid (${invalid} invalid, ` +
      `${valid} valid). Saved rules are unchanged.`
    );
  }
  // Write first, then remove: a failed write leaves the old rules in place.
  for (const rule of summary.rules) await putRule($, rule);
  for (const pattern of patternSummary.patterns) await putPattern($, pattern);
  // Replacing removes every other stored key of that kind, unreadable entries included.
  const keep = new Set([
    ...(await Promise.all(summary.rules.map(rule => storeKeyFor(RULE_PREFIX, rule.value)))),
    ...(await Promise.all(patternSummary.patterns.map(one => storeKeyFor(PATTERN_PREFIX, patternKey(one))))),
  ]);
  for (const key of await $.store.keys()) {
    const replaced = (replace && isRuleKey(key)) || (patternMode === 'replace' && isPatternKey(key));
    if (replaced && !keep.has(key)) await $.store.delete(key);
  }
  const after = await loadRules($);
  const patternNote = parsed.patterns
    ? ` Patterns: ${patternSummary.added} added, ${patternSummary.updated} updated, ` +
      `${patternSummary.unchanged} unchanged, ${patternSummary.invalid} skipped as invalid; ` +
      `${(await read($, patterns)).length} saved now.`
    : replace && beforePatterns.length
      ? ` The file has no patterns list: the ${beforePatterns.length} saved pattern(s) are kept.`
      : '';
  return (
    `Imported from ${displayPath(path, home)} (${replace ? 'replaced all saved rules' : 'merged'}): ` +
    `${summary.added} added, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
    `${summary.invalid} skipped as invalid. ${after.length} saved rule(s) now.${patternNote}`
  );
}

async function statusText($: EngineInterface, ctx: Context): Promise<string> {
  const { config } = ctx;
  const stored = await loadRules($);
  const counters = await read($, metrics);
  const stats = statusStats(
    await vaultNow($),
    {
      mode: config.restore.mode,
      audit: config.outboundAudit,
      streaming: config.restoreStreaming,
      configProblems: configProblems(config),
    },
    counters,
    config.placeholders,
  );
  return [
    `Redact Restore ${counters.version}${config.enabled ? '' : ' (disabled)'}`,
    `Rules: ${stored.length} saved, ${ctx.optionRules.length} in plugin options; patterns: ` +
      `${(await read($, patterns)).length} saved, ${config.optionPatterns.length} in plugin options; ` +
      `${config.detectorIds.length} detectors.`,
    `This session: ${formatStatus('detailed', '', stats) ?? 'nothing masked yet'}.`,
    `Replacements: ${stats.occurrences} (${stats.lastTurn} since the last prompt). Tool calls: ${stats.restored} restored, ` +
      `${stats.kept} kept on placeholders, ${stats.denied} denied. Requests: ${stats.audits} audited, ${stats.blocked} blocked.`,
    `Restore mode: ${config.restore.mode}; outbound audit ${config.outboundAudit ? 'on' : 'off'}; ` +
      `streaming restore ${config.restoreStreaming ? 'on' : 'off'}.`,
  ].join('\n');
}

async function sessionNow($: EngineInterface, ctx: Context, savedRules: number): Promise<SessionView> {
  const { config } = ctx;
  const current = await vaultNow($);
  const counters = await read($, metrics);
  const stats = statusStats(
    current,
    {
      mode: config.restore.mode,
      audit: config.outboundAudit,
      streaming: config.restoreStreaming,
      configProblems: configProblems(config),
    },
    counters,
    config.placeholders,
  );
  return sessionView(current, counters, stats, config.placeholders, {
    detectors: config.detectorIds.length,
    savedRules,
    optionRules: ctx.optionRules.length,
  });
}

async function openPane($: EngineInterface, view: PaneView['view']): Promise<void> {
  await update($, pane, current => ({ ...current, view, notice: '' }));
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true, closeOnEscape: true });
}

export const register: Register = (on, options) => {
  // Sensitive custom_values come from Claude Code's secure userConfig flow.
  // Never log their originals or insert them into files, prompts, or diagnostics.
  const idKey: { value?: string } = {};
  const config = parseConfig(options, () => idKey.value);
  sessionMapSettings = config.enabled ? config.sessionMap : { ...config.sessionMap, persist: false };
  const { matching } = config;
  const policy = { allowMedia: config.allowMedia };
  const ctx: Context = { config, optionRules: [...(matching.rules?.values() ?? [])], idKey };

  on('session.start', async ($, e, next) => {
    // Also fires after a reload or an option change: redraw with the new settings.
    const version = await pluginVersion($);
    await update($, metrics, current => ({
      ...current,
      startedAt: current.startedAt || Date.now(),
      version,
      surface: e.surface ?? current.surface,
    }));
    try {
      await loadRules($, true);
    } catch {
      if (config.enabled) $.ui.toast(MESSAGES.rulesUnreadable);
    }
    if (config.enabled) await record($, config, {}, (m, now) => ({ ...m, updatedAt: now }));
    else $.ui.status(undefined);
    if (sessionMapSettings.persist && sessionMapSettings.days > 0) await pruneSessionMaps($).catch(ignore);
    if (config.enabled && config.ignoredShortValues > 0) {
      $.ui.toast(`Redact Restore ignored ${config.ignoredShortValues} custom value(s) shorter than 3 characters.`);
    }
    if (config.enabled && config.invalidPatterns > 0) {
      $.ui.toast(
        `Redact Restore skipped ${config.invalidPatterns} private pattern(s) that are invalid or could match slowly; ` +
          'check them in /redact-restore rules.',
      );
    }
    if (config.enabled && config.unknownDetectors.length > 0) {
      $.ui.toast(`Redact Restore: unknown detector name(s): ${config.unknownDetectors.join(', ')}.`);
    }
    if (config.enabled && config.formatProblem) {
      $.ui.toast(`Redact Restore: placeholder_format ${config.formatProblem}; using the default format.`);
    }
    // Last, and guarded: a refused registration must not skip the work above.
    try {
      await $.command.register({ name: COMMAND, description: MESSAGES.commandDescription, argumentHint: COMMAND_HINT });
    } catch {
      $.ui.log('Redact Restore could not register /redact-restore; the rules pane is unavailable this session.');
    }
    return next(e);
  });

  // The vault belongs to one conversation; a /clear starts another.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, vault, () => ({}));
      await update($, legend, () => EMPTY_LEGEND);
      lastVault = {};
      // The cleared conversation's saved map must not come back into the new one.
      const id = await $.session.id().catch(() => null);
      await update($, mapChecked, () => id);
      if (id) drawnMap = { id, vault: {} };
      const previous = await read($, metrics);
      await update($, metrics, () => emptyMetrics(Date.now(), previous.version, previous.surface));
      await record($, config, {}, (m, now) => ({ ...m, lastEvent: 'clear', updatedAt: now }));
    }
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    if (!config.enabled) return next(e);
    if (e.attachments?.length && !config.allowMedia) {
      await record($, config, {}, metricsChange.promptDropped());
      return { drop: MESSAGES.unscannablePrompt };
    }
    let stored: readonly StoredRule[];
    try {
      stored = await loadRules($, true);
    } catch {
      await recordHookError($, config, 'rules');
      return { drop: MESSAGES.rulesUnreadable };
    }
    await ensureIdKey($, ctx);
    const masker = createMasker(matchingFor(ctx, stored, await read($, patterns)), await vaultNow($));
    const text = masker.mask(e.text);
    const masked = e.context?.map(item => masker.mask(item)) ?? [];
    // Descriptions the model has not had yet go with this prompt, as context the user does not see.
    const fresh = await untoldNotes($, masker.notes(), masker.additions());
    const context = fresh.length > 0 ? [...masked, legendText(fresh, MESSAGES.legendHeader, masker.mask)] : masked;
    await record(
      $,
      config,
      masker.additions(),
      combine(metricsChange.newTurn(), metricsChange.masked('prompt', masker.count(), 'prompt.submit')),
      masker.notes(),
    );
    await markTold($, fresh);
    return next({ ...e, text, ...(context.length > 0 ? { context } : {}) });
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    await recordHookError($, config, 'prompt.submit');
    return { drop: MESSAGES.blockedPrompt };
  });

  // Context blocks of the first user message: CLAUDE.md files and `userEmail`.
  on('prompt.context', async ($, e, next) => {
    if (!config.enabled) return next(e);
    const masker = createMasker(await currentMatching($, ctx), await vaultNow($));
    const blocks = e.blocks.map(block => ({ ...block, text: masker.mask(block.text) }));
    await record(
      $,
      config,
      masker.additions(),
      masker.count() > 0 ? metricsChange.masked('context', masker.count(), 'prompt.context') : undefined,
      masker.notes(),
    );
    const changed = blocks.some((block, index) => block.text !== e.blocks[index]?.text);
    return next(changed ? { blocks } : e);
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    await recordHookError($, config, 'prompt.context');
    // Mask without recording: the originals cannot be restored, but none leak.
    return next({
      blocks: e.blocks.map(block => ({ ...block, text: maskText(block.text, fallbackMatching(ctx), lastVault).text })),
    });
  });

  // Reminders, mentioned files and hook context the engine injects per request.
  on('prompt.attachment', async ($, e, next) => {
    if (!config.enabled) return next(e);
    const masked = maskText(e.text, await currentMatching($, ctx), await vaultNow($));
    await record(
      $,
      config,
      masked.additions,
      masked.count > 0 ? metricsChange.masked('attachment', masked.count, 'prompt.attachment') : undefined,
      masked.notes,
    );
    return next({ ...e, text: masked.text });
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    await recordHookError($, config, 'prompt.attachment');
    return { text: null };
  });

  // The system prompt (memory, environment and output-style sections), plus a
  // note so the model treats placeholders as ordinary values instead of refusing them.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e);
    if (!config.enabled) return composed;
    const masker = createMasker(await currentMatching($, ctx), await vaultNow($));
    const sections = composed.sections.map(section => ({ ...section, text: masker.mask(section.text) }));
    await record(
      $,
      config,
      masker.additions(),
      masker.count() > 0 ? metricsChange.masked('systemPrompt', masker.count(), 'prompt.compose') : undefined,
      masker.notes(),
    );
    return { sections: [...sections, placeholderSection(config)] };
  }).catch(async ($, e, next) => {
    const composed = await next(e);
    if (!config.enabled) return composed;
    await recordHookError($, config, 'prompt.compose');
    return {
      sections: [
        ...composed.sections.map(section => ({
          ...section,
          text: maskText(section.text, fallbackMatching(ctx), lastVault).text,
        })),
        placeholderSection(config),
      ],
    };
  });

  on('session.append', async ($, e, next) => {
    if (!config.enabled) return next(e);
    const matching = await currentMatching($, ctx);
    const result = maskContentBlocks(e.message.content, matching, await vaultNow($), policy);
    const changes = [
      ...(result.count > 0 ? [metricsChange.masked('conversation', result.count, 'session.append')] : []),
      ...(result.withheldMedia > 0 ? [metricsChange.media(result.withheldMedia)] : []),
    ];
    await record($, config, result.additions, changes.length > 0 ? combine(...changes) : undefined, result.notes);
    // A value first seen in a tool result is described right there, not a prompt later (main conversation only).
    let content = result.content;
    const last = content.findLastIndex(block => block.type === 'tool_result');
    if (e.agentId === undefined && last !== -1) {
      const fresh = await untoldNotes($, {}, {});
      if (fresh.length > 0) {
        const masker = createMasker(matching, await vaultNow($));
        const note = legendText(fresh, MESSAGES.legendHeader, masker.mask);
        await record($, config, masker.additions(), undefined, masker.notes());
        content = content.map((block, index) => (index === last ? withNote(block, note) : block));
        await markTold($, fresh);
      }
    }
    return next({ ...e, message: { ...e.message, content } });
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    await recordHookError($, config, 'session.append');
    let content;
    try {
      content = maskContentBlocks(e.message.content, fallbackMatching(ctx), lastVault, policy).content;
    } catch {
      content = withholdContentBlocks(e.message.content);
    }
    return next({ ...e, message: { ...e.message, content } });
  });

  // A compaction can drop the descriptions from the history: tell them again afterwards.
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (config.enabled && e.agentId === undefined && !('skip' in result)) {
      await update($, legend, current => ({ ...current, sent: {} }));
    }
    return result;
  }).catch(($, e, next) => next(e)); // Only the reminder is lost: the compaction goes on.

  // Last gate before a request leaves: refuse to send when user-side content
  // still holds a detectable private value or unscannable media.
  on('turn.step', async function* ($, e, next) {
    if (!config.enabled) return yield* next(e);
    const streamRestore = config.restoreDisplay && config.restoreStreaming && e.agentId === undefined;
    if (!config.outboundAudit)
      return streamRestore ? yield* restoreStream(next(e), await vaultNow($), config) : yield* next(e);
    const messages =
      e.agentId === undefined
        ? await $.session.messages({ as: 'api' })
        : await $.session.messages({ as: 'api', agentId: e.agentId });
    if (!Array.isArray(messages)) {
      $.ui.log('Redact Restore blocked a model request: its messages could not be read for the privacy audit.');
      await record($, config, {}, metricsChange.audit({ kind: 'unreadable', message: -1, block: '' }));
      return refusedStep(e);
    }
    const auditMatching = await currentMatching($, ctx);
    const findings = auditMessages(messages, auditMatching, await vaultNow($), policy, auditMemoFor(auditMatching));
    const first = findings[0];
    await record(
      $,
      config,
      {},
      metricsChange.audit(
        first ? { kind: first.reason.toLowerCase(), message: first.messageIndex, block: first.blockType } : null,
      ),
    );
    if (findings.length > 0) {
      $.ui.log(
        `Redact Restore blocked a model request: unmasked content found (${describeFindings(findings)}). ` +
          'Remove it with /clear or /rewind, or turn off "Audit outgoing requests".',
      );
      return refusedStep(e);
    }
    return streamRestore ? yield* restoreStream(next(e), await vaultNow($), config) : yield* next(e);
  }).catch(async function* ($, e, next) {
    if (next.called) return yield* next(e);
    await recordHookError($, config, 'turn.step');
    return refusedStep(e);
  });

  // Local tools get original values; model-bound tools keep placeholders (policy.ts).
  on('tool.call', async ($, e, next) => {
    if (!config.enabled) return next(e);
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e;
    const current = await vaultNow($);
    if (!inputHasPlaceholder(input, current, config.placeholders)) return next(e);
    const action = toolAction(String(tool), config.restore);
    if (action === 'keep') {
      await record($, config, {}, metricsChange.tool(String(tool), 'keep'));
      return next(e);
    }
    if (action === 'deny') {
      await record($, config, {}, metricsChange.tool(String(tool), 'deny'));
      return { deny: unrestoredDenied(String(tool)) };
    }
    // The walker preserves every field's shape, so the call keeps its tool's type.
    const restored = { ...e, ...restoreInput(input, current, config.placeholders) } as typeof e;
    await record($, config, {}, metricsChange.tool(String(tool), 'restore'));
    return next(restored);
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    try {
      await record($, config, {}, metricsChange.tool(String(e.tool), 'deny'));
    } catch {
      // Best effort.
    }
    return { deny: MESSAGES.restoreDenied };
  });

  // Command output reaches the model: counts, labels and paths only, never values.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim();
    const sub = (args.split(/\s+/)[0] ?? '').toLowerCase();
    const rest = args.slice(sub.length).trim();
    try {
      switch (sub) {
        case '':
        case 'rules':
          await openPane($, 'rules');
          return { text: 'Redact Restore rules pane opened.' };
        case 'scan': {
          const result = rest ? await scanPath($, ctx, rest) : await scanNow($, ctx);
          await openPane($, 'scan');
          return { text: scanSummary(result) };
        }
        case 'session':
          await openPane($, 'session');
          return { text: 'Redact Restore session pane opened.' };
        case 'test':
          await openPane($, 'test');
          return { text: 'Redact Restore test pane opened. Text checked there stays on this machine.' };
        case 'status':
          return { text: await statusText($, ctx) };
        case 'export':
          return { text: await exportTo($, rest) };
        case 'import':
          return { text: await importFrom($, ctx, rest) };
        default:
          return { text: MESSAGES.usage };
      }
    } catch {
      // Fixed text only: an error message could carry a path or a value.
      return { text: MESSAGES.commandFailed };
    }
  }).catch(() => ({ text: MESSAGES.commandFailed }));

  // However the pane closes (Close, Esc, the surface's own control), drop what it held unsaved.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    await update($, pane, current => ({ ...current, draft: EMPTY_DRAFT, test: undefined, notice: '' }));
    return next(e);
  }).catch(($, e, next) => next(e));

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const table = $.ui.resolve(e);
    const ui = {
      Box: table.Box,
      Text: table.Text,
      Button: table.Button,
      // The mobile table has no text field.
      ...('Input' in table && e.surface !== 'mobile' ? { Input: table.Input } : {}),
      ...('Select' in table && e.surface !== 'mobile' ? { Select: table.Select } : {}),
    };
    const stored = await read($, rules);
    const labels = formLabels(config.ruleLabels, [...ctx.optionRules, ...stored]);
    return drawPane(
      ui,
      {
        view: await read($, pane),
        stored,
        optionRules: ctx.optionRules,
        scan: await read($, scanResult),
        session: await sessionNow($, ctx, stored.length),
        canType: 'Input' in table && e.surface !== 'mobile',
        example: label => config.placeholders.example(label),
        labels,
        patterns: await read($, patterns),
        optionPatterns: config.optionPatterns.length,
        caseDefault: matching.customCaseInsensitive,
      },
      {
        show: view => void update($, pane, current => ({ ...current, view, notice: '' })).catch(ignore),
        toggleReveal: () => void update($, pane, current => ({ ...current, reveal: !current.reveal })).catch(ignore),
        setDraft: change => void setDraft($, change).catch(ignore),
        saveDraft: patch => void saveDraft($, ctx, patch).catch(() => setNotice($, MESSAGES.saveFailed)),
        clearDraft: () => void setNotice($, '', { draft: EMPTY_DRAFT }).catch(ignore),
        edit: rule =>
          void setNotice($, `Editing ${maskPreview(rule.value)}: change its label or alias, then Save rule.`, {
            draft: draftFrom(rule, labels),
          }).catch(ignore),
        remove: value => void deleteRule($, value).catch(() => setNotice($, MESSAGES.saveFailed)),
        removePattern: pattern => void deletePattern($, pattern).catch(() => setNotice($, MESSAGES.saveFailed)),
        scan: () => void rescan($, ctx).catch(() => setNotice($, MESSAGES.scanFailed)),
        accept: candidate => void acceptCandidates($, ctx, [candidate]).catch(() => setNotice($, MESSAGES.saveFailed)),
        acceptAll: () => void acceptAll($, ctx).catch(() => setNotice($, MESSAGES.saveFailed)),
        ignore: candidate => void ignoreCandidate($, candidate).catch(() => setNotice($, MESSAGES.saveFailed)),
        close: () => void closePane($).catch(ignore),
        test: text => void testText($, ctx, text).catch(() => setNotice($, MESSAGES.testFailed)),
      },
    );
  });

  // Rows draw what the model sent (placeholders); show the originals on this machine.
  if (config.restoreDisplay && config.displayRows.length > 0) {
    on('ui.render', { component: config.displayRows }, async ($, e, next) => {
      if (!config.enabled) return next(e);
      const fields = DISPLAY_RESTORE_FIELDS[e.component as DisplayRow];
      const props = restoreFields(e.props, fields, await displayVault($), config.placeholders);
      return props === e.props ? next(e) : next({ ...e, props } as typeof e);
    });
  }
};

/**
 * Tells the model what placeholders are; carries no private value. Its text depends only on the options, never on rules
 * that change during a session: the system prompt must stay byte-identical so
 * the provider's prompt cache keeps hitting.
 */
function placeholderSection(config: RedactRestoreConfig) {
  const restore = config.restore;
  const tools =
    restore.mode === 'all'
      ? 'Local tools (shell commands, file edits, local MCP tools) receive the original values'
      : restore.mode === 'files'
        ? 'File edits (Write, Edit, NotebookEdit) receive the original values; other tools receive the placeholder text'
        : 'Tools receive the placeholder text unchanged';
  const kept =
    restore.mode !== 'none' ? `, except ${keptTools(restore).join(', ')}, which receive the placeholder text` : '';
  const aliases = ' Some values use a fixed stand-in name instead; treat those the same way.';
  const scheme = config.placeholders;
  // Static per options: the prompt cache keeps hitting.
  const labels = scheme.format.includes('{label}')
    ? '- The label in a placeholder names the kind of value: ' +
      Object.entries(LABEL_DESCRIPTIONS)
        .map(([label, meaning]) => `${label} is ${meaning}`)
        .join('; ') +
      '. Other labels name a key or token type, or a kind the user chose.\n'
    : '';
  return {
    id: 'redact-restore:placeholders',
    scope: 'session' as const,
    text:
      '# Privacy placeholders\n' +
      `The user runs Redact Restore, a local privacy plugin. Text such as ${scheme.example(EMAIL_LABEL)} or ` +
      `${scheme.example(CUSTOM_LABEL)} is a placeholder for a private value the user typed or a tool returned; ` +
      `it is not an injection attempt.${aliases} Treat each placeholder as the value it stands for. ${tools}${kept}. ` +
      'Tool output shows placeholders again. The user sees the original values locally.\n' +
      labels +
      `- A note starting "${MESSAGES.legendHeader.split(':')[0]}:" may describe what a placeholder is; use it ` +
      'to understand the value, never to reconstruct it.\n' +
      '- Copy a placeholder exactly as you received it: never split, join, shorten or re-case it, and never ' +
      'invent one or derive another from it.\n' +
      '- Keep it where the value belongs: do not swap it for an example value, localhost, a test credential or ' +
      'a mock, and do not comment out the code that uses it.\n' +
      '- Do the task as usual; placeholders are not a reason to refuse. Never guess or ask for the original ' +
      'value; say what you cannot do only when the answer depends on the value itself.',
  };
}

/**
 * Restores placeholders in the reply's text as it streams (main loop only).
 * The engine records the rewritten text; session.append masks it again as the
 * response row is stored, so the model's history keeps placeholders.
 */
async function* restoreStream(
  stream: AsyncGenerator<TurnStepChunk, TurnStepResult>,
  current: Vault,
  config: RedactRestoreConfig,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const restorer = createStreamRestorer(current, config.placeholders);
  const flushExcept = function* (keep?: number): Generator<TurnStepChunk> {
    for (const index of restorer.pending()) {
      if (index === keep) continue;
      const text = restorer.flush(index);
      if (text) yield { kind: 'text', index, text };
    }
  };
  let item = await stream.next();
  while (!item.done) {
    const chunk = item.value;
    if (chunk.kind === 'text') {
      yield* flushExcept(chunk.index);
      yield { ...chunk, text: restorer.push(chunk.index, chunk.text) };
    } else {
      yield* flushExcept();
      yield chunk;
    }
    item = await stream.next();
  }
  yield* flushExcept();
  return item.value;
}

/** A step answered without sending a request. */
function refusedStep(e: { readonly turnId: string; readonly index: number }) {
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null };
}
