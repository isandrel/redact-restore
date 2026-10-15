/**
 * The rules and scan pane, drawn from plain data and handler closures. Values
 * appear here only, on this screen; they never reach the model. Masked unless
 * the person asks to show them.
 */
import type { Elements } from 'claude-code';
import { CUSTOM_LABEL, SESSION_PLACEHOLDER_LIMIT } from './defaults.ts';
import type { Metrics } from './metrics.ts';
import { describePatternProblem, patternDetector, patternProblem, type PatternRule } from './patterns.ts';
import { LABEL_PATTERN, type PlaceholderScheme, type ValueRule } from './placeholder.ts';
import { maskPreview, type RuleProblem, type StoredPattern, type StoredRule } from './rules.ts';
import type { ScanCandidate } from './scan.ts';
import type { StatusStats } from './status.ts';

export type PaneTab = 'rules' | 'scan' | 'session' | 'test';

/** The Test tab's result: computed on this machine, never recorded in the session or sent anywhere. */
export interface TestView {
  readonly text: string;
  /** The text as the model would receive it. */
  readonly masked: string;
  /** Each value found, once, in order: its label and the original. */
  readonly found: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

/** One placeholder this session minted, and the value it stands for (shown masked unless revealed). */
export interface SessionEntry {
  readonly placeholder: string;
  readonly label: string;
  readonly value: string;
}

/** The current session, as counts and the placeholders it made. */
export interface SessionView {
  readonly stats: StatusStats;
  readonly metrics: Metrics;
  readonly byLabel: ReadonlyArray<readonly [string, number]>;
  /** The newest placeholders, oldest first. */
  readonly entries: readonly SessionEntry[];
  readonly total: number;
  readonly placeholderFormat: string;
  readonly detectors: number;
  readonly savedRules: number;
  readonly optionRules: number;
}

/** Builds the session view from the vault (placeholder to value) and the counters. */
export function sessionView(
  vault: Readonly<Record<string, string>>,
  metrics: Metrics,
  stats: StatusStats,
  scheme: PlaceholderScheme,
  counts: { detectors: number; savedRules: number; optionRules: number },
): SessionView {
  const all = Object.entries(vault).map(([placeholder, value]) => ({
    placeholder,
    value,
    label: scheme.labelOf(placeholder) ?? 'ALIAS',
  }));
  const byLabel = new Map<string, number>();
  for (const entry of all) byLabel.set(entry.label, (byLabel.get(entry.label) ?? 0) + 1);
  return {
    stats,
    metrics,
    byLabel: [...byLabel.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    entries: all.slice(-SESSION_PLACEHOLDER_LIMIT),
    total: all.length,
    placeholderFormat: scheme.format,
    ...counts,
  };
}

/** `Bash 2, Write 1`, or `none`. */
function tally(counts: Readonly<Record<string, number>> | ReadonlyArray<readonly [string, number]>): string {
  const pairs = Array.isArray(counts) ? counts : Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return pairs.length ? pairs.map(([name, count]) => `${name} ${count}`).join(' · ') : 'none';
}

function clock(ms: number): string {
  if (!ms) return '—';
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export type DraftMode = 'label' | 'alias';

/** The rule form: what the person has typed and picked so far (this screen only). */
export type DraftKind = 'value' | 'pattern';
export type DraftCase = 'default' | 'yes' | 'no';

export interface RuleDraft {
  /** An exact value, or a pattern (regex). */
  readonly kind: DraftKind;
  readonly value: string;
  readonly mode: DraftMode;
  readonly label: string;
  /** True when the label is typed rather than picked from the list. */
  readonly customLabel: boolean;
  readonly alias: string;
  /** The form was filled from a saved rule; saving updates it. */
  readonly editing: boolean;
  /** Ignore case: follow the `custom_case_insensitive` option, or yes / no for this rule. */
  readonly ignoreCase: DraftCase;
  readonly pattern: string;
  readonly wholeWord: boolean;
  /** 0 masks the whole match; N masks capture group N. */
  readonly group: number;
  /** A sample the pattern must match; checked on save, never stored. */
  readonly example: string;
}

export const EMPTY_DRAFT: RuleDraft = {
  kind: 'value',
  ignoreCase: 'default',
  pattern: '',
  wholeWord: true,
  group: 0,
  example: '',
  value: '',
  mode: 'label',
  label: CUSTOM_LABEL,
  customLabel: false,
  alias: '',
  editing: false,
};

export interface PaneView {
  readonly view: PaneTab;
  readonly reveal: boolean;
  readonly notice: string;
  readonly draft: RuleDraft;
  readonly test?: TestView;
}

export interface ScanView {
  readonly candidates: readonly ScanCandidate[];
  /** Found values a rule, the email scanner or a detector already masks. */
  readonly covered: number;
  /** Found values dismissed before. */
  readonly ignored: number;
  /** A path scan: the folder or file as shown (`~/…`), files read, and values already masked by label. */
  readonly target?: string;
  readonly files?: number;
  readonly kinds?: ReadonlyArray<readonly [string, number]>;
}

export interface PaneData {
  readonly view: PaneView;
  readonly stored: readonly StoredRule[];
  /** Rules from the plugin options (keychain): shown, never edited here. */
  readonly optionRules: readonly ValueRule[];
  readonly scan: ScanView | null;
  readonly session: SessionView;
  /** False where the surface has no text field (mobile). */
  readonly canType: boolean;
  /** A sample placeholder for a label, in the active format. */
  readonly example: (label: string) => string;
  /** Labels offered in the rule form (see `formLabels`). */
  readonly labels: readonly string[];
  readonly patterns: readonly StoredPattern[];
  /** Patterns from the plugin options (keychain), counted only. */
  readonly optionPatterns: number;
  /** The `custom_case_insensitive` option: what "Follow the option" means. */
  readonly caseDefault: boolean;
}

export interface PaneActions {
  show(view: PaneTab): void;
  toggleReveal(): void;
  setDraft(change: Partial<RuleDraft>): void;
  /** Saves the form; `patch` is a field's latest text when Enter submitted it. */
  saveDraft(patch?: Partial<RuleDraft>): void;
  clearDraft(): void;
  edit(rule: StoredRule): void;
  remove(value: string): void;
  removePattern(pattern: StoredPattern): void;
  scan(): void;
  accept(candidate: ScanCandidate): void;
  acceptAll(): void;
  ignore(candidate: ScanCandidate): void;
  close(): void;
  /** Checks text in the Test tab; empty clears it. */
  test(text: string): void;
}

export type PaneElements = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'> & {
  readonly Input?: Elements['desktop']['Input'];
  readonly Select?: Elements['desktop']['Select'];
};

export const EMPTY_VIEW: PaneView = { view: 'rules', reveal: false, notice: '', draft: EMPTY_DRAFT };

const OTHER_LABEL = '__other';

/** What is missing or wrong in the form before it can be saved (the full check runs on save). */
export function draftProblem(draft: RuleDraft): RuleProblem | undefined {
  if (draft.kind === 'pattern') {
    const label = draft.label.trim();
    if (!label) return 'no-label';
    return LABEL_PATTERN.test(label) ? undefined : 'invalid-label';
  }
  if (!draft.value.trim()) return 'empty';
  if (draft.mode === 'alias') return draft.alias.trim() ? undefined : 'no-alias';
  const label = draft.label.trim();
  if (!label) return 'no-label';
  return LABEL_PATTERN.test(label) ? undefined : 'invalid-label';
}

/** The pattern rule the form describes; `caseDefault` is the `custom_case_insensitive` option. */
export function draftPattern(draft: RuleDraft, caseDefault: boolean): PatternRule {
  const label = draft.label.trim().toUpperCase();
  return {
    pattern: draft.pattern.trim(),
    ...(label && label !== CUSTOM_LABEL ? { label } : {}),
    ignoreCase: draft.ignoreCase === 'default' ? caseDefault : draft.ignoreCase === 'yes',
    wholeWord: draft.wholeWord,
    group: draft.group,
    example: draft.example,
  };
}

/** A pattern's example as the model would see it, or why the pattern cannot be saved yet. */
export function patternPreview(draft: RuleDraft, caseDefault: boolean, example: (label: string) => string): string {
  if (!draft.pattern.trim()) return '(type a pattern and an example it must match)';
  const rule = draftPattern(draft, caseDefault);
  const problem = patternProblem(rule);
  if (problem) return `(${describePatternProblem(problem)})`;
  const spans = patternDetector(rule, 'preview').find(draft.example);
  let text = draft.example;
  for (const { start, end } of [...spans].reverse()) {
    text = `${text.slice(0, start)}${example(rule.label ?? CUSTOM_LABEL)}${text.slice(end)}`;
  }
  return text;
}

/** What the model would see for the form as filled in. */
export function draftPreview(draft: RuleDraft, example: (label: string) => string): string {
  if (draft.mode === 'alias') return draft.alias.trim() || '(type an alias)';
  const label = draft.label.trim().toUpperCase();
  if (!label) return '(type a label)';
  return LABEL_PATTERN.test(label) ? example(label) : '(not a valid label)';
}

/** The form's label list: CUSTOM, the configured labels, then every label a rule already uses. */
export function formLabels(configured: readonly string[], rules: ReadonlyArray<Pick<ValueRule, 'label'>>): string[] {
  const used = rules.flatMap(rule => (rule.label ? [rule.label] : []));
  return [...new Set([CUSTOM_LABEL, ...configured, ...used])];
}

/** The form filled from a saved rule, for editing its label or alias. */
export function draftFrom(
  rule: Pick<StoredRule, 'value' | 'label' | 'alias' | 'ignoreCase'>,
  labels: readonly string[],
): RuleDraft {
  const label = rule.label ?? CUSTOM_LABEL;
  return {
    ...EMPTY_DRAFT,
    ignoreCase: rule.ignoreCase === undefined ? 'default' : rule.ignoreCase ? 'yes' : 'no',
    value: rule.value,
    mode: rule.alias ? 'alias' : 'label',
    label,
    customLabel: !labels.includes(label),
    alias: rule.alias ?? '',
    editing: true,
  };
}

function tag(rule: Pick<StoredRule, 'label' | 'alias'>): string {
  if (rule.alias) return `alias ${rule.alias}`;
  return rule.label ?? 'CUSTOM';
}

export function drawPane(ui: PaneElements, data: PaneData, act: PaneActions) {
  const { Box, Text, Button, Input, Select } = ui;
  const draft: RuleDraft = { ...EMPTY_DRAFT, ...data.view.draft };
  const shown = (value: string) => (data.view.reveal ? value : maskPreview(value));
  const tab = data.view.view;

  const header = (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      <Button key="tab-rules" variant={tab === 'rules' ? 'primary' : 'secondary'} onPress={() => act.show('rules')}>
        Rules
      </Button>
      <Button key="tab-scan" variant={tab === 'scan' ? 'primary' : 'secondary'} onPress={() => act.show('scan')}>
        Scan
      </Button>
      <Button
        key="tab-session"
        variant={tab === 'session' ? 'primary' : 'secondary'}
        onPress={() => act.show('session')}
      >
        Session
      </Button>
      <Button key="tab-test" variant={tab === 'test' ? 'primary' : 'secondary'} onPress={() => act.show('test')}>
        Test
      </Button>
      <Button key="reveal" onPress={() => act.toggleReveal()}>
        {data.view.reveal ? 'Hide values' : 'Show values'}
      </Button>
      <Button key="close" role="dismiss" onPress={() => act.close()}>
        Close
      </Button>
    </Box>
  );

  const notice = data.view.notice ? <Text bold>{data.view.notice}</Text> : null;

  if (tab === 'test') {
    const result = data.view.test;
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {notice}
        <Text dimColor>
          Paste text to see what the model would receive. It is checked on this machine: nothing is sent, saved or added
          to the session.
        </Text>
        {data.canType && Input ? (
          <Input
            key="test-input"
            label="Text to check"
            placeholder="Paste a log, config or message"
            submitLabel="check"
            autoFocus
            onSubmit={text => act.test(text)}
          />
        ) : (
          <Text dimColor>Testing text needs the terminal or the desktop app.</Text>
        )}
        {result ? (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text bold>The model would see</Text>
              <Text>{result.masked}</Text>
            </Box>
            <Box flexDirection="column">
              <Text bold>
                {result.found.length === 0
                  ? 'Nothing found: this text would be sent as it is.'
                  : `${result.found.length} value(s) found`}
              </Text>
              {result.found.map((item, index) => (
                <Box key={`found-${index}`} flexDirection="row" gap={1} flexWrap="wrap">
                  <Text dimColor>{item.label}</Text>
                  <Text>{shown(item.value)}</Text>
                </Box>
              ))}
              {result.found.length === 0 ? (
                <Text dimColor>Something private in it? Add it as a rule on the Rules tab.</Text>
              ) : null}
            </Box>
            <Button key="test-clear" onPress={() => act.test('')}>
              Clear
            </Button>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (tab === 'session') {
    const { stats, metrics: m } = data.session;
    const row = (name: string, text: string, key: string) => (
      <Box key={key} flexDirection="row" gap={1}>
        <Box width={10} flexShrink={0}>
          <Text bold>{name}</Text>
        </Box>
        <Text>{text}</Text>
      </Box>
    );
    const errors = Object.values(m.hookErrors).reduce((sum, count) => sum + count, 0);
    const block = m.lastBlock
      ? ` · last block: ${m.lastBlock.kind}${m.lastBlock.block ? ` in ${m.lastBlock.block}` : ''}`
      : '';
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {notice}
        <Box flexDirection="column">
          {row(
            'State',
            `${stats.state} · since ${clock(m.startedAt)} · last ${m.lastEvent} at ${clock(m.updatedAt)}`,
            's-state',
          )}
          {row(
            'Masked',
            `${stats.masked} values · ${stats.occurrences} replacements · ${stats.lastTurn} since last prompt`,
            's-masked',
          )}
          {row('Kinds', tally(data.session.byLabel), 's-kinds')}
          {row('Sources', tally(m.bySource), 's-sources')}
          {row(
            'Tools',
            `restored ${m.restoredCalls} (${tally(m.restoredByTool)}) · kept ${m.keptCalls} · denied ${m.deniedCalls}`,
            's-tools',
          )}
          {row('Requests', `audited ${m.audits} · blocked ${m.blocked}${block}`, 's-requests')}
          {row(
            'Other',
            `media withheld ${m.mediaWithheld} · prompts refused ${m.promptsDropped} · hook errors ${errors}${errors ? ` (${tally(m.hookErrors)})` : ''}`,
            's-other',
          )}
          {row(
            'Settings',
            `restore ${stats.mode} · audit ${stats.audit ? 'on' : 'off'} · streaming ${stats.streaming ? 'on' : 'off'} · ` +
              `${data.session.detectors} detectors · rules ${data.session.savedRules} saved + ${data.session.optionRules} options`,
            's-settings',
          )}
          {row('Format', data.session.placeholderFormat, 's-format')}
        </Box>
        <Box flexDirection="column">
          <Text bold>
            Placeholders ({data.session.total}
            {data.session.total > data.session.entries.length ? `, newest ${data.session.entries.length}` : ''})
          </Text>
          {data.session.total === 0 ? <Text dimColor>Nothing masked yet in this session.</Text> : null}
          {data.session.entries.map((entry, index) => (
            <Box key={`placeholder-${index}`} flexDirection="row" gap={1} flexWrap="wrap">
              <Text>{entry.placeholder}</Text>
              <Text dimColor>{shown(entry.value)}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  if (tab === 'scan') {
    const scan = data.scan;
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {notice}
        {scan === null ? (
          <Box flexDirection="column">
            <Text>
              Scan looks at the git identity, remotes and recent authors, this computer's name, your account name, .env
              files and the package author; /redact-restore scan PATH checks a folder or file. Everything runs on this
              machine, and results stay in this pane.
            </Text>
            <Button key="scan-run" variant="primary" onPress={() => act.scan()}>
              Scan now
            </Button>
          </Box>
        ) : (
          <Box flexDirection="column">
            {scan.target ? (
              <Text dimColor>
                {scan.target} · {scan.files ?? 0} file(s) read
              </Text>
            ) : null}
            <Text dimColor>
              {scan.candidates.length} new · {scan.covered} already masked · {scan.ignored} ignored before
            </Text>
            {scan.kinds && scan.kinds.length > 0 ? (
              <Text dimColor>Already masked in these files: {tally(scan.kinds)}</Text>
            ) : null}
            <Box flexDirection="row" gap={1}>
              <Button key="scan-again" onPress={() => act.scan()}>
                Scan again
              </Button>
              {scan.candidates.length > 0 ? (
                <Button key="scan-all" variant="primary" onPress={() => act.acceptAll()}>
                  Add all
                </Button>
              ) : null}
            </Box>
            {scan.candidates.map((candidate, index) => (
              <Box key={`candidate-${index}`} flexDirection="row" gap={1} flexWrap="wrap">
                <Text>{shown(candidate.value)}</Text>
                <Text dimColor>
                  {candidate.label} · {candidate.source}
                </Text>
                <Button key={`accept-${index}`} onPress={() => act.accept(candidate)}>
                  Add
                </Button>
                <Button key={`ignore-${index}`} onPress={() => act.ignore(candidate)}>
                  Ignore
                </Button>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      {notice}
      {data.canType && Input && Select ? (
        <Box key="form" flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{draft.editing ? 'Edit rule' : 'Add a rule'}</Text>
          {draft.editing ? null : (
            <Select
              key="draft-kind"
              label="Rule type"
              value={draft.kind}
              options={[
                { value: 'value', label: 'Exact value' },
                { value: 'pattern', label: 'Pattern (regular expression)' },
              ]}
              onSelect={kind => act.setDraft({ kind: kind === 'pattern' ? 'pattern' : 'value' })}
            />
          )}
          {draft.kind === 'pattern' ? (
            <Input
              key="draft-pattern"
              label="Pattern"
              placeholder="e.g. ACME-[A-Z0-9]{16}"
              value={draft.pattern}
              autoFocus
              onInput={pattern => act.setDraft({ pattern })}
              onSubmit={pattern => act.setDraft({ pattern })}
            />
          ) : draft.editing ? (
            <Box flexDirection="row" gap={1}>
              <Text>Private value:</Text>
              <Text>{shown(draft.value)}</Text>
              <Text dimColor>(fixed while editing; remove the rule to change it)</Text>
            </Box>
          ) : (
            <Input
              key="draft-value"
              label="Private value"
              placeholder="e.g. Acme Corp"
              value={draft.value}
              submitLabel="save"
              autoFocus
              onInput={value => act.setDraft({ value })}
              onSubmit={value => act.saveDraft({ value })}
            />
          )}
          {draft.kind === 'pattern' ? (
            <Input
              key="draft-example"
              label="Example it must match"
              placeholder="a made-up sample, e.g. ACME-0000AAAA1111BBBB"
              value={draft.example}
              submitLabel="save"
              onInput={example => act.setDraft({ example })}
              onSubmit={example => act.saveDraft({ example })}
            />
          ) : (
            <Select
              key="draft-mode"
              label="Replace with"
              value={draft.mode}
              options={[
                { value: 'label', label: 'Placeholder with a label' },
                { value: 'alias', label: 'Fixed alias' },
              ]}
              onSelect={mode => act.setDraft({ mode: mode === 'alias' ? 'alias' : 'label' })}
            />
          )}
          {draft.kind === 'pattern' || draft.mode === 'label' ? (
            <Select
              key="draft-label"
              label="Label"
              value={draft.customLabel ? OTHER_LABEL : draft.label}
              options={[
                ...data.labels.map(label => ({ value: label, label })),
                { value: OTHER_LABEL, label: 'Other label…' },
              ]}
              onSelect={label =>
                act.setDraft(label === OTHER_LABEL ? { customLabel: true, label: '' } : { customLabel: false, label })
              }
            />
          ) : (
            <Input
              key="draft-alias"
              label="Alias"
              placeholder="e.g. CLIENT_A"
              value={draft.alias}
              submitLabel="save"
              onInput={alias => act.setDraft({ alias })}
              onSubmit={alias => act.saveDraft({ alias })}
            />
          )}
          {(draft.kind === 'pattern' || draft.mode === 'label') && draft.customLabel ? (
            <Input
              key="draft-custom-label"
              label="Custom label"
              placeholder="e.g. VENDOR"
              value={draft.label}
              submitLabel="save"
              onInput={label => act.setDraft({ label })}
              onSubmit={label => act.saveDraft({ label })}
            />
          ) : null}
          <Select
            key="draft-case"
            label="Ignore case"
            value={draft.ignoreCase}
            options={[
              { value: 'default', label: `Follow the option (${data.caseDefault ? 'yes' : 'no'})` },
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
            onSelect={ignoreCase =>
              act.setDraft({ ignoreCase: ignoreCase === 'yes' ? 'yes' : ignoreCase === 'no' ? 'no' : 'default' })
            }
          />
          {draft.kind === 'pattern' ? (
            <Select
              key="draft-whole"
              label="Whole word"
              value={draft.wholeWord ? 'yes' : 'no'}
              options={[
                { value: 'yes', label: 'Yes: no letter or digit touching either end' },
                { value: 'no', label: 'No: match inside longer text too' },
              ]}
              onSelect={whole => act.setDraft({ wholeWord: whole !== 'no' })}
            />
          ) : null}
          {draft.kind === 'pattern' ? (
            <Select
              key="draft-group"
              label="Mask"
              value={String(draft.group)}
              options={[
                { value: '0', label: 'The whole match' },
                { value: '1', label: 'Capture group 1 only' },
                { value: '2', label: 'Capture group 2 only' },
                { value: '3', label: 'Capture group 3 only' },
              ]}
              onSelect={group => act.setDraft({ group: Number(group) || 0 })}
            />
          ) : null}
          <Text dimColor>
            The model sees:{' '}
            {draft.kind === 'pattern'
              ? patternPreview(draft, data.caseDefault, data.example)
              : draftPreview(draft, data.example)}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="draft-save" variant="primary" onPress={() => act.saveDraft()}>
              {draft.editing ? 'Save rule' : 'Add rule'}
            </Button>
            <Button key="draft-clear" onPress={() => act.clearDraft()}>
              Clear
            </Button>
          </Box>
        </Box>
      ) : (
        <Text dimColor>Adding rules needs the terminal or the desktop app.</Text>
      )}
      <Box flexDirection="column">
        <Text bold>Saved rules ({data.stored.length}) · plugin store, takes effect now</Text>
        {data.stored.length === 0 ? <Text dimColor>None yet. Add one above, or use Scan.</Text> : null}
        {data.stored.map((rule, index) => (
          <Box key={`rule-${index}`} flexDirection="row" gap={1} flexWrap="wrap">
            <Text>{shown(rule.value)}</Text>
            <Text dimColor>
              {tag(rule)} · {rule.source}
            </Text>
            {data.canType ? (
              <Button key={`edit-${index}`} onPress={() => act.edit(rule)}>
                Edit
              </Button>
            ) : null}
            <Button key={`remove-${index}`} onPress={() => act.remove(rule.value)}>
              Remove
            </Button>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text bold>Saved patterns ({data.patterns.length}) · plugin store, takes effect now</Text>
        {data.patterns.length === 0 ? <Text dimColor>None yet. Pick Pattern as the rule type to add one.</Text> : null}
        {data.patterns.map((pattern, index) => (
          <Box key={`pattern-${index}`} flexDirection="row" gap={1} flexWrap="wrap">
            <Text>/{pattern.pattern}/</Text>
            <Text dimColor>
              {pattern.label ?? CUSTOM_LABEL}
              {pattern.ignoreCase ? ' · ignore case' : ''}
              {pattern.wholeWord ? ' · whole word' : ''}
              {pattern.group ? ` · group ${pattern.group}` : ''} · {pattern.source}
            </Text>
            <Button key={`remove-pattern-${index}`} onPress={() => act.removePattern(pattern)}>
              Remove
            </Button>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text bold>
          Plugin options ({data.optionRules.length}
          {data.optionPatterns ? ` values, ${data.optionPatterns} patterns` : ''}) · keychain, edit in /plugin
        </Text>
        {data.optionRules.map((rule, index) => (
          <Box key={`option-${index}`} flexDirection="row" gap={1}>
            <Text>{shown(rule.value)}</Text>
            <Text dimColor>{tag(rule)}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
