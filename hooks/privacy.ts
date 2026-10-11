import { MAX_INPUT_DEPTH, MESSAGES } from './defaults.ts';
import { findPrivateMatches, type KnownValue, type MatchingOptions, type PrivacyCategory } from './matcher.ts';
import { CUSTOM_LABEL, DEFAULT_SCHEME, type PlaceholderScheme } from './placeholder.ts';

/** Side-effect-free matching and token restoration helpers.
 * No Claude Code $ API is imported or passed here: its static validator forbids
 * passing $ into functions imported from other local files.
 */
export type Vault = Record<string, string>;

export interface MaskResult {
  text: string;
  additions: Vault;
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
  return Object.entries(vault).map(([token, value]) => ({ value, category: categoryOf(token, scheme) }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Known tokens restore exactly, whatever format minted them. A side that starts
// or ends with a word character gets a boundary, so an alias such as CODENAME_X
// is not restored inside CODENAME_X2.
let tokenCache: { key: string; pattern: RegExp } | undefined;
function knownTokenPattern(vault: Vault, scheme: PlaceholderScheme = DEFAULT_SCHEME): RegExp | undefined {
  const tokens = Object.keys(vault).sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return undefined;
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
    tokenCache = { key, pattern: new RegExp(source, 'g') };
  }
  tokenCache.pattern.lastIndex = 0;
  return tokenCache.pattern;
}

export function maskText(text: string, options: MatchingOptions, vault: Vault): MaskResult {
  const scheme = options.placeholders ?? DEFAULT_SCHEME;
  const matches = findPrivateMatches(text, options, knownValues(vault, scheme), Object.keys(vault));
  if (matches.length === 0) return { text, additions: {}, count: 0 };

  const reverse = new Map(Object.entries(vault).map(([token, value]) => [value, token]));
  const additions: Vault = {};
  const fragments: string[] = [];
  let last = 0;

  for (const match of matches) {
    let token = reverse.get(match.value);
    if (!token) {
      const rule = options.rules?.get(match.value.toLowerCase());
      if (rule?.alias !== undefined) {
        // One alias per configured value; a case variant reuses it.
        token = rule.alias;
        if (vault[token] === undefined && additions[token] === undefined) additions[token] = match.value;
      } else {
        token = scheme.make(rule?.label ?? match.category);
        additions[token] = match.value;
      }
      reverse.set(match.value, token);
    }
    fragments.push(text.slice(last, match.start), token);
    last = match.end;
  }
  fragments.push(text.slice(last));
  return { text: fragments.join(''), additions, count: matches.length };
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
  const working: Vault = { ...vault };
  const additions: Vault = {};
  let count = 0;
  return {
    mask(text: string): string {
      const masked = maskText(text, options, working);
      Object.assign(working, masked.additions);
      Object.assign(additions, masked.additions);
      count += masked.count;
      return masked.text;
    },
    additions: (): Vault => additions,
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

  return { content, additions: masker.additions(), withheldMedia, count: masker.count() };
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
export function auditMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly content: readonly ContentBlock[] }>,
  options: MatchingOptions,
  vault: Vault,
  policy: BlockPolicy,
): AuditFinding[] {
  const known = knownValues(vault, options.placeholders);
  const tokens = Object.keys(vault);
  const findings: AuditFinding[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user') return;
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && SYSTEM_REMINDER.test(block.text)) continue;
      for (const part of userTexts(block)) {
        if (typeof part !== 'string') {
          if (!policy.allowMedia) findings.push({ messageIndex, blockType: block.type, reason: 'MEDIA' });
          continue;
        }
        const first = findPrivateMatches(part, options, known, tokens)[0];
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
