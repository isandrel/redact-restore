/**
 * Which tools get original values back. Pure and data-driven: the defaults are
 * tables here, and every table can be replaced from plugin options.
 *
 * Threat model: only the model API must not see private values. Tools that run
 * on this machine get originals; tools that forward their input to a model
 * (subagents, WebFetch's summarizer, server-side search, other sessions) keep
 * placeholders, because no hook re-masks what they send. Built-in lists set
 * the floor; options only add to them.
 */
import { BUILTIN_KEEP_TOOLS, FILE_TOOLS } from './defaults.ts';
export type RestoreMode = 'all' | 'files' | 'none';

/** What happens to a tool call whose input holds placeholders. */
export type ToolAction = 'restore' | 'keep' | 'deny';

export interface RestorePolicy {
  readonly mode: RestoreMode;
  /** Extra tool name patterns that keep placeholders, on top of BUILTIN_KEEP_TOOLS. */
  readonly keepTools: readonly string[];
  /** Extra tool name patterns refused on placeholder text, on top of BUILTIN_DENY_UNRESTORED_TOOLS. */
  readonly denyUnrestoredTools: readonly string[];
}

export const RESTORE_MODES: readonly RestoreMode[] = ['all', 'files', 'none'];

export { BUILTIN_KEEP_TOOLS, FILE_TOOLS };

/** Placeholder text written into a file is silent data loss; always refused. */
export const BUILTIN_DENY_UNRESTORED_TOOLS: readonly string[] = FILE_TOOLS;

/** Options add to the built-in lists, so their defaults are empty. */
export const DEFAULT_POLICY: RestorePolicy = {
  mode: 'all',
  keepTools: [],
  denyUnrestoredTools: [],
};

/** `*` matches any run of characters; everything else is literal. */
export function matchesPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => matchesPattern(name, pattern));
}

/** The action for a tool call that carries placeholders. */
export function keptTools(policy: RestorePolicy): readonly string[] {
  return [...new Set([...BUILTIN_KEEP_TOOLS, ...policy.keepTools])];
}

export function toolAction(tool: string, policy: RestorePolicy): ToolAction {
  if (matchesAny(tool, keptTools(policy))) return 'keep';
  const restores = policy.mode === 'all' || (policy.mode === 'files' && FILE_TOOLS.includes(tool));
  if (restores) return 'restore';
  const denied = [...BUILTIN_DENY_UNRESTORED_TOOLS, ...policy.denyUnrestoredTools];
  return matchesAny(tool, denied) ? 'deny' : 'keep';
}

/** Comma- or newline-separated patterns; blanks dropped. */
export function parsePatternList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(item => item.length > 0);
}
