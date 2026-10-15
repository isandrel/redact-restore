/**
 * The placeholder map of one session, kept in a local file so `/resume` can
 * restore what earlier turns masked. Pure: register.ts reads and writes the
 * file. The file holds original values: it never leaves this machine.
 */
import { SESSION_MAP_FORMAT, SESSION_MAP_VERSION } from './defaults.ts';
import type { Notes, Vault } from './privacy.ts';

export interface SessionMap {
  readonly vault: Vault;
  readonly notes: Notes;
  /** Placeholders whose description the model has already been told. */
  readonly sent: Readonly<Record<string, true>>;
}

/** Session ids become file names: letters, digits, `-` and `_` only. */
export function isSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function serializeSessionMap(map: SessionMap, now: Date): string {
  return JSON.stringify({
    format: SESSION_MAP_FORMAT,
    version: SESSION_MAP_VERSION,
    updatedAt: now.toISOString(),
    ...map,
  });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string')
    ? (Object.fromEntries(entries) as Record<string, string>)
    : undefined;
}

/** The saved map, or undefined for a file that is not one (a person may edit it). */
export function parseSessionMap(text: string): SessionMap | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  if (record.format !== SESSION_MAP_FORMAT || typeof record.version !== 'number') return undefined;
  if (record.version > SESSION_MAP_VERSION) return undefined;
  const vault = stringRecord(record.vault);
  if (!vault) return undefined;
  const notes = stringRecord(record.notes) ?? {};
  const sent: Record<string, true> = {};
  if (typeof record.sent === 'object' && record.sent !== null) {
    for (const [token, flag] of Object.entries(record.sent)) if (flag === true) sent[token] = true;
  }
  return { vault, notes, sent };
}
