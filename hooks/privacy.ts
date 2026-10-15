import { AUDIT_MEMO_LIMIT, MAX_INPUT_DEPTH, MESSAGES } from './defaults.ts';
import {
  findPrivateMatches,
  type KnownValue,
  type MatchingOptions,
  type PrivacyCategory,
  type PrivateMatch,
} from './matcher.ts';
import { CUSTOM_LABEL, DEFAULT_SCHEME, type PlaceholderScheme } from './placeholder.ts';

/** Side-effect-free matching and token restoration helpers.
 * No Claude Code $ API is imported or passed here: its static validator forbids
 * passing $ into functions imported from other local files.
 */
/**
 * Placeholder to original value. A vault is never changed in place: every
 * addition makes a new object, so lookups built from one can be cached by identity.
 */
export type Vault = Record<string, string>;

/** Placeholder to description ("client company name"), for the model; never a value. */
export type Notes = Record<string, string>;

export interface MaskResult {
  text: string;
  additions: Vault;
  /** Descriptions of new placeholders, from their rule or pattern. */
  notes: Notes;
  /** Replacements made, counting every occurrence. */
  count: number;
}

/** A block as the Messages API spells it; the engine's ApiContentBlock has this shape. */
export interface ContentBlock {
  readonly type: string;
  readonly [field: string]: unknown;
}

const MEDIA_TYPES = new Set(['image', 'document']);

export const WITHHELD_TEXT = MESSAGES.withheld;

export function withheldMediaText(type: string): string {
  return `[Withheld by Redact Restore: ${type} content cannot be scanned for private values]`;
}

function categoryOf(token: string, scheme: PlaceholderScheme): PrivacyCategory {
  return scheme.labelOf(token) ?? CUSTOM_LABEL;
}

export function knownValues(vault: Vault, scheme: PlaceholderScheme = DEFAULT_SCHEME): KnownValue[] {
  return [...vaultView(vault, scheme).known];
}

interface VaultView {
  readonly known: readonly KnownValue[];
  readonly tokens: readonly string[];
  /** Value to its placeholder. */
  readonly reverse: ReadonlyMap<string, string>;
}

// Built once per vault object and format: a large session masks many texts against one vault.
const vaultViews = new WeakMap<Vault, { readonly format: string; readonly view: VaultView }>();

function vaultView(vault: Vault, scheme: PlaceholderScheme): VaultView {
  const cached = vaultViews.get(vault);
  if (cached?.format === scheme.format) return cached.view;
  const entries = Object.entries(vault);
  const view: VaultView = {
    known: entries.map(([token, value]) => ({ value, category: categoryOf(token, scheme) })),
    tokens: entries.map(([token]) => token),
    reverse: new Map(entries.map(([token, value]) => [value, token])),
  };
  vaultViews.set(vault, { format: scheme.format, view });
  return view;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Known tokens restore exactly, whatever format minted them. A side that starts
// or ends with a word character gets a boundary, so an alias such as CODENAME_X
// is not restored inside CODENAME_X2.
let tokenCache: { vault: Vault; size: number; key: string; pattern: RegExp } | undefined;
function knownTokenPattern(vault: Vault, scheme: PlaceholderScheme = DEFAULT_SCHEME): RegExp | undefined {
  const tokens = Object.keys(vault);
  if (tokens.length === 0) return undefined;
  // A vault only grows and never remaps a token: the same object at the same size is unchanged.
  if (
    tokenCache?.vault === vault &&
    tokenCache.size === tokens.length &&
    tokenCache.key.startsWith(`${scheme.format}\u0001`)
  ) {
    tokenCache.pattern.lastIndex = 0;
    return tokenCache.pattern;
  }
  tokens.sort((a, b) => b.length - a.length);
  const key = `${scheme.format}\u0001${tokens.join('\u0000')}`;
  if (tokenCache?.key !== key) {
    const word = /[A-Za-z0-9_]/;
    // Placeholders restore wherever they appear; aliases only as whole words.
    const bounded = (token: string) => scheme.labelOf(token) === undefined;
    const source = tokens
      .map(
        token =>
          `${bounded(token) && word.test(token.charAt(0)) ? '(?<![A-Za-z0-9_])' : ''}` +
          escapeRegExp(token) +
          `${bounded(token) && word.test(token.charAt(token.length - 1)) ? '(?![A-Za-z0-9_])' : ''}`,
      )
      .join('|');
    tokenCache = { vault, size: tokens.length, key, pattern: new RegExp(source, 'g') };
  } else tokenCache = { ...tokenCache, vault, size: tokens.length };
  tokenCache.pattern.lastIndex = 0;
  return tokenCache.pattern;
}

/** Each private value in the text, once and in order, with its label: for a local preview, never for sending. */
export function uniqueMatches(
  text: string,
  options: MatchingOptions,
  vault: Vault,
): Array<{ label: string; value: string }> {
  const scheme = options.placeholders ?? DEFAULT_SCHEME;
  const seen = new Set<string>();
  const found: Array<{ label: string; value: string }> = [];
  const view = vaultView(vault, scheme);
  for (const match of findPrivateMatches(text, options, view.known, view.tokens)) {
    if (seen.has(match.value)) continue;
    seen.add(match.value);
    found.push({ label: options.rules?.get(match.value.toLowerCase())?.label ?? match.category, value: match.value });
  }
  return found;
}

export function maskText(text: string, options: MatchingOptions, vault: Vault): MaskResult {
  return maskAgainst(text, options, vault, NO_PENDING);
}

/**
 * Placeholders a masker minted for earlier texts, kept apart from the vault so
 * the vault's cached lookups stay valid. Their values are found again by the
 * same rules and detectors that found them first.
 */
interface Pending {
  readonly tokens: Vault;
  readonly byValue: ReadonlyMap<string, string>;
}
const NO_PENDING: Pending = { tokens: {}, byValue: new Map() };

function maskAgainst(text: string, options: MatchingOptions, vault: Vault, pending: Pending): MaskResult {
  const scheme = options.placeholders ?? DEFAULT_SCHEME;
  const view = vaultView(vault, scheme);
  const matches = findPrivateMatches(text, options, view.known, view.tokens);
  if (matches.length === 0) return { text, additions: {}, notes: {}, count: 0 };

  const reverse = view.reverse;
  // Values first masked in this text; the cached view stays as it was.
  const added = new Map<string, string>();
  const additions: Vault = {};
  const notes: Notes = {};
  const fragments: string[] = [];
  let last = 0;

  for (const match of matches) {
    let token = reverse.get(match.value) ?? pending.byValue.get(match.value) ?? added.get(match.value);
    if (!token) {
      const rule = options.rules?.get(match.value.toLowerCase());
      if (rule?.alias !== undefined) {
        // One alias per configured value; a case variant reuses it.
        token = rule.alias;
        if (vault[token] === undefined && pending.tokens[token] === undefined && additions[token] === undefined) {
          additions[token] = match.value;
          if (rule.description) notes[token] = rule.description;
        }
      } else {
        const label = rule?.label ?? match.category;
        token = scheme.make(label, match.value);
        // A stable id that another value already holds (a truncated-hash collision) falls back to random.
        const holder = vault[token] ?? pending.tokens[token] ?? additions[token];
        if (holder !== undefined && holder !== match.value) token = scheme.make(label);
        additions[token] = match.value;
        const description = rule?.description ?? match.description;
        if (description) notes[token] = description;
      }
      added.set(match.value, token);
    }
    fragments.push(text.slice(last, match.start), token);
    last = match.end;
  }
  fragments.push(text.slice(last));
  return { text: fragments.join(''), additions, notes, count: matches.length };
}

/** Placeholders of the active format in `text`, known or not. */
export function findPlaceholders(text: string, scheme: PlaceholderScheme = DEFAULT_SCHEME): string[] {
  return [...text.matchAll(scheme.pattern)].map(match => match[0]);
}

/**
 * Restores every known token (placeholders of any format, and aliases). With
 * `failOnUnknown`, a placeholder of the active format that the vault does not
 * know throws: a tool must not run on text that looks restored but is not.
 */
export function unmaskText(
  text: string,
  vault: Vault,
  failOnUnknown = false,
  scheme: PlaceholderScheme = DEFAULT_SCHEME,
): string {
  if (failOnUnknown && findPlaceholders(text, scheme).some(token => vault[token] === undefined)) {
    throw new Error('Cannot restore an unknown private placeholder');
  }
  const known = knownTokenPattern(vault, scheme);
  return known ? text.replace(known, token => vault[token] ?? token) : text;
}

/** Calls `visit` on every string inside plain objects and arrays, up to a depth cap. */
function mapStrings(value: unknown, visit: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return visit(value);
  if (depth >= MAX_INPUT_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const mapped = value.map(item => mapStrings(item, visit, depth + 1));
    return mapped.some((item, index) => item !== value[index]) ? mapped : value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, child]) => {
    const mapped = mapStrings(child, visit, depth + 1);
    if (mapped !== child) changed = true;
    return [key, mapped] as const;
  });
  return changed ? Object.fromEntries(entries) : value;
}

/** Whether any string inside a tool input holds a placeholder or a known alias. */
export function inputHasPlaceholder(
  input: unknown,
  vault: Vault = {},
  scheme: PlaceholderScheme = DEFAULT_SCHEME,
): boolean {
  const known = knownTokenPattern(vault, scheme);
  let found = false;
  mapStrings(input, text => {
    if (!found && (findPlaceholders(text, scheme).length > 0 || (known !== undefined && known.test(text))))
      found = true;
    if (known) known.lastIndex = 0;
    return text;
  });
  return found;
}

/**
 * Restores placeholders in every string of a tool input, keys untouched.
 * Unknown placeholders throw: a tool must not run on text that looks restored
 * but is not. Returns the same object when nothing changed.
 */
export function restoreInput<T>(input: T, vault: Vault, scheme: PlaceholderScheme = DEFAULT_SCHEME): T {
  return mapStrings(input, text => unmaskText(text, vault, true, scheme)) as T;
}

/**
 * Restores known tokens in every string of a value, for drawing on this
 * machine only. Unknown placeholders stay as they are. Returns the same value
 * when nothing changed.
 */
export function restoreForDisplay<T>(value: T, vault: Vault, scheme: PlaceholderScheme = DEFAULT_SCHEME): T {
  return mapStrings(value, text => unmaskText(text, vault, false, scheme)) as T;
}

/**
 * The props with the named fields restored for display; the same object when
 * nothing changed, and a field that was absent stays absent.
 */
export function restoreFields<T extends object>(
  props: T,
  fields: readonly string[],
  vault: Vault,
  scheme: PlaceholderScheme = DEFAULT_SCHEME,
): T {
  let changed: Record<string, unknown> | undefined;
  for (const field of fields) {
    if (!(field in props)) continue;
    const value = (props as Record<string, unknown>)[field];
    const restored = restoreForDisplay(value, vault, scheme);
    if (restored !== value) changed = { ...changed, [field]: restored };
  }
  return changed ? { ...props, ...changed } : props;
}

/**
 * Restores placeholders in streamed text, one buffer per content block. A tail
 * that may be the start of a placeholder waits for the next piece, so a token
 * split across chunks is still restored; `flush` releases what is left.
 */
export function createStreamRestorer(vault: Vault, scheme: PlaceholderScheme = DEFAULT_SCHEME) {
  const held = new Map<number, string>();
  return {
    push(index: number, text: string): string {
      const combined = (held.get(index) ?? '') + text;
      const cut = scheme.holdPoint(combined);
      held.set(index, combined.slice(cut));
      return unmaskText(combined.slice(0, cut), vault, false, scheme);
    },
    flush(index: number): string {
      const rest = held.get(index) ?? '';
      held.delete(index);
      return unmaskText(rest, vault, false, scheme);
    },
    /** Blocks that still hold text, in the order they started. */
    pending(): number[] {
      return [...held].filter(([, text]) => text.length > 0).map(([index]) => index);
    },
  };
}

/** Masks several strings against one evolving vault, collecting new mappings. */
export function createMasker(options: MatchingOptions, vault: Vault) {
  const additions: Vault = {};
  const byValue = new Map<string, string>();
  const pending: Pending = { tokens: additions, byValue };
  const notes: Notes = {};
  let count = 0;
  return {
    mask(text: string): string {
      const masked = maskAgainst(text, options, vault, pending);
      for (const [token, value] of Object.entries(masked.additions)) {
        additions[token] = value;
        byValue.set(value, token);
      }
      Object.assign(notes, masked.notes);
      count += masked.count;
      return masked.text;
    },
    additions: (): Vault => additions,
    notes: (): Notes => notes,
    count: (): number => count,
  };
}

export interface BlockPolicy {
  /** Keep image/document blocks (which cannot be scanned) instead of withholding them. */
  readonly allowMedia: boolean;
}

export interface MaskBlocksResult<T> {
  content: T[];
  additions: Vault;
  notes: Notes;
  withheldMedia: number;
  /** Replacements made, counting every occurrence. */
  count: number;
}

/** Scan conversation content blocks without mutating the input.
 *
 * Covers text blocks and tool_result content (string, or nested text/media
 * items). Media blocks are replaced by a text notice unless the policy allows
 * them. Every other kind (tool_use, thinking, server tool blocks) is returned
 * as-is: Claude Code pins those blocks in `session.append` and puts back any
 * rewrite, so masking them here would only give a false sense of coverage.
 */
export function maskContentBlocks<T extends ContentBlock>(
  blocks: readonly T[],
  options: MatchingOptions,
  vault: Vault,
  policy: BlockPolicy,
): MaskBlocksResult<T> {
  const masker = createMasker(options, vault);
  let withheldMedia = 0;

  const maskItem = (item: unknown): unknown => {
    if (!item || typeof item !== 'object' || !('type' in item)) return item;
    const block = item as ContentBlock;
    if (block.type === 'text' && typeof block.text === 'string') {
      return { ...block, text: masker.mask(block.text) };
    }
    if (MEDIA_TYPES.has(block.type) && !policy.allowMedia) {
      withheldMedia += 1;
      return { type: 'text', text: withheldMediaText(block.type) };
    }
    return item;
  };

  const content = blocks.map((block): T => {
    if (block.type === 'text' || MEDIA_TYPES.has(block.type)) return maskItem(block) as T;
    if (block.type === 'tool_result') {
      if (typeof block.content === 'string') {
        return { ...block, content: masker.mask(block.content) };
      }
      if (Array.isArray(block.content)) {
        return { ...block, content: block.content.map(maskItem) };
      }
    }
    return block;
  });

  return { content, additions: masker.additions(), notes: masker.notes(), withheldMedia, count: masker.count() };
}

/** Replacement content when scanning failed: no text, tool result or media survives. */
export function withholdContentBlocks<T extends ContentBlock>(blocks: readonly T[]): T[] {
  return blocks.map((block): T => {
    if (block.type === 'text') return { ...block, text: WITHHELD_TEXT };
    if (block.type === 'tool_result') return { ...block, content: WITHHELD_TEXT };
    if (MEDIA_TYPES.has(block.type)) return { type: 'text', text: WITHHELD_TEXT } as unknown as T;
    return block;
  });
}

export interface AuditFinding {
  readonly messageIndex: number;
  /** The block kind the finding sits in (`text`, `tool_result`, `image`...), never its content. */
  readonly blockType: string;
  /** The detector label (`EMAIL`, `AWS_KEY`, `CUSTOM`, ...) or `MEDIA`. */
  readonly reason: string;
}

/** The parts of a user-role message that carry text the model has not authored. */
function* userTexts(block: ContentBlock): Generator<string | { media: string }> {
  if (block.type === 'text' && typeof block.text === 'string') yield block.text;
  else if (MEDIA_TYPES.has(block.type)) yield { media: block.type };
  else if (block.type === 'tool_result') {
    if (typeof block.content === 'string') yield block.content;
    else if (Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item && typeof item === 'object' && 'type' in item) yield* userTexts(item as ContentBlock);
      }
    }
  }
}

/**
 * Engine attachments (environment, mentioned files, files re-attached after
 * compaction, reminders) arrive as `<system-reminder>` text blocks. Every
 * request re-renders them through `prompt.attachment`, which masks them after
 * this audit runs, while `$.session.messages()` can hold their raw copy (after
 * compaction, and in subagents). The audit leaves them to that hook.
 */
const SYSTEM_REMINDER = /^\s*<system-reminder>/;

/**
 * Pre-send audit of a request's messages. Scans only user-role content: the
 * assistant's text and tool calls were written by the model, so sending them
 * back discloses nothing it has not already seen. Returns no values, only where
 * and which kind of detector fired.
 */
/**
 * What an audit remembers between requests: text it found clean, and how many
 * vault entries existed then. A long conversation is resent whole on every
 * request; with the memo only new text gets the full scan, and old text is
 * checked only for values the vault learned since. Keep one memo per matching
 * options object: new rules or detectors need a full scan.
 */
export interface AuditMemo {
  readonly clean: Map<string, number>;
}

export function createAuditMemo(): AuditMemo {
  return { clean: new Map() };
}

/** A 53-bit hash with the length: a key for text already audited (cyrb53). */
function textKey(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${(2097151 & h2) * 4294967296 + (h1 >>> 0)}`;
}

/** Options that match only known values: for re-checking clean text against values learned since. */
function knownOnly(options: MatchingOptions): MatchingOptions {
  return {
    customValues: [],
    customCaseInsensitive: false,
    redactEmails: false,
    detectors: [],
    ...(options.placeholders ? { placeholders: options.placeholders } : {}),
  };
}

export function auditMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly content: readonly ContentBlock[] }>,
  options: MatchingOptions,
  vault: Vault,
  policy: BlockPolicy,
  memo?: AuditMemo,
): AuditFinding[] {
  const { known, tokens } = vaultView(vault, options.placeholders ?? DEFAULT_SCHEME);
  const findings: AuditFinding[] = [];
  const recheck = knownOnly(options);
  // The first match in a part, scanning only what the memo has not seen yet.
  const firstMatch = (part: string): PrivateMatch | undefined => {
    if (!memo) return findPrivateMatches(part, options, known, tokens)[0];
    const key = textKey(part);
    const seenAt = memo.clean.get(key);
    if (seenAt === tokens.length) return undefined;
    const match =
      seenAt === undefined
        ? findPrivateMatches(part, options, known, tokens)[0]
        : findPrivateMatches(part, recheck, known.slice(seenAt), tokens)[0];
    if (!match) {
      if (memo.clean.size >= AUDIT_MEMO_LIMIT) memo.clean.clear();
      memo.clean.set(key, tokens.length);
    }
    return match;
  };
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user') return;
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && SYSTEM_REMINDER.test(block.text)) continue;
      for (const part of userTexts(block)) {
        if (typeof part !== 'string') {
          if (!policy.allowMedia) findings.push({ messageIndex, blockType: block.type, reason: 'MEDIA' });
          continue;
        }
        const first = firstMatch(part);
        if (first) findings.push({ messageIndex, blockType: block.type, reason: first.category });
      }
    }
  });
  return findings;
}

/** Counts and locations only; never a value. */
export function describeFindings(findings: readonly AuditFinding[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const key = `${finding.reason.toLowerCase()} in message ${finding.messageIndex} ${finding.blockType}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${count} ${key}`).join(', ');
}

/**
 * The note for the model that says what new placeholders stand for: one line
 * per placeholder, in the order given, at most `limit` of them. Descriptions
 * pass through `mask` first, so a description that names another private value
 * carries that value's placeholder. Never holds a value.
 */
export function legendText(
  entries: ReadonlyArray<readonly [token: string, description: string]>,
  header: string,
  mask: (text: string) => string,
): string {
  return [header, ...entries.map(([token, description]) => `- ${token}: ${mask(description)}`)].join('\n');
}
