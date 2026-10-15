/**
 * How placeholders look. Pure: a scheme is built once from the options and
 * passed to the matcher, the masker and the restorers.
 *
 * A format is literal text with `{label}` and `{id}` fields. The default,
 * `{{PRIVATE:{label}#{id}}}` (e.g. `{{PRIVATE:EMAIL#3fa1c09e8b2d}}`), is easy for models to
 * copy and has no shell glob or redirect characters; it is also template
 * syntax (Jinja, Handlebars, Actions) and needs quoting in YAML, which matters
 * only where a tool receives placeholders unrestored. A format must
 * start with literal text and contain no whitespace, so a placeholder can be
 * found in running text and recognized while it streams in pieces; it ends
 * with literal text or with the fixed-length `{id}`.
 */
import {
  CUSTOM_LABEL,
  DEFAULT_FORMAT,
  DEFAULT_ID_LENGTH,
  EMAIL_LABEL,
  MAX_ID_LENGTH,
  MIN_ID_LENGTH,
} from './defaults.ts';

export { CUSTOM_LABEL, DEFAULT_FORMAT, DEFAULT_ID_LENGTH, EMAIL_LABEL, MAX_ID_LENGTH, MIN_ID_LENGTH };

/** Labels a user may give a value: letters, digits, underscore. */
export const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export interface PlaceholderScheme {
  readonly format: string;
  readonly idLength: number;
  /** A fresh placeholder for a label. */
  make(label: string): string;
  /** Every placeholder of this format (global regex; reset `lastIndex` yourself). */
  readonly pattern: RegExp;
  /** The label inside a placeholder of this format, or undefined. */
  labelOf(token: string): string | undefined;
  /** Where to stop emitting streamed text so a split placeholder waits whole. */
  holdPoint(text: string): number;
  /** An example for the model note: `{{PRIVATE:EMAIL#<id>}}`. */
  example(label: string): string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Why a format cannot be used, or undefined when it can. */
export function formatProblem(format: string): string | undefined {
  if (format.length > 80) return 'is longer than 80 characters';
  if (/\s/.test(format)) return 'contains whitespace';
  if (format.split('{id}').length !== 2) return 'must contain {id} exactly once';
  if (format.split('{label}').length > 2) return 'may contain {label} at most once';
  if (/\{label\}\{id\}|\{id\}\{label\}/.test(format)) return 'needs literal text between {label} and {id}';
  if (/\{[a-z]+\}/.test(format.replace(/\{(?:id|label)\}/g, ''))) return 'uses an unknown field';
  if (!format.split(/\{(?:id|label)\}/)[0]) return 'must start with literal text, e.g. {{';
  if (format.endsWith('{label}')) return 'must end with {id} or literal text';
  return undefined;
}

function randomHex(length: number): string {
  let hex = '';
  while (hex.length < length) hex += crypto.randomUUID().replaceAll('-', '');
  return hex.slice(0, length);
}

export function createScheme(format = DEFAULT_FORMAT, idLength = DEFAULT_ID_LENGTH): PlaceholderScheme {
  const usable = formatProblem(format) === undefined ? format : DEFAULT_FORMAT;
  const length = Math.min(MAX_ID_LENGTH, Math.max(MIN_ID_LENGTH, Math.round(idLength)));
  const parts = usable.split(/(\{(?:id|label)\})/);
  const source = parts
    .map(part =>
      part === '{id}'
        ? `[a-f0-9]{${length}}`
        : part === '{label}'
          ? '([A-Za-z][A-Za-z0-9_]{0,31})'
          : escapeRegExp(part),
    )
    .join('');
  const whole = new RegExp(`^${source}$`);
  const opening = parts[0] ?? '';
  const complete = new RegExp(`^${source}`);
  const maxLength = usable.length + 32 + length;

  return {
    format: usable,
    idLength: length,
    make: label => usable.replace('{label}', label).replace('{id}', randomHex(length)),
    pattern: new RegExp(source, 'g'),
    labelOf(token) {
      const match = whole.exec(token);
      if (!match) return undefined;
      return usable.includes('{label}') ? match[1] : CUSTOM_LABEL;
    },
    holdPoint(text) {
      // Hold from the leftmost place near the end where a placeholder may have
      // started but is not complete yet: a partial opening, or an opening whose
      // placeholder could still grow (no whitespace, not yet a full match).
      let hold = text.length;
      const first = opening[0] ?? '';
      for (let start = text.lastIndexOf(first); start !== -1; start = text.lastIndexOf(first, start - 1)) {
        const tail = text.slice(start);
        if (tail.length > maxLength) break;
        const partial = opening.startsWith(tail);
        const growing = tail.startsWith(opening) && !/\s/.test(tail) && !complete.test(tail);
        if (partial || growing) hold = start;
        if (start === 0) break;
      }
      return hold;
    },
    example: label => usable.replace('{label}', label).replace('{id}', '<id>'),
  };
}

export const DEFAULT_SCHEME = createScheme();

/** One rule: a value, with an optional label or a fixed alias (structured fields, never parsed from text). */
export interface ValueRule {
  readonly value: string;
  readonly label?: string;
  readonly alias?: string;
  /** Match regardless of case; absent follows the `custom_case_insensitive` option. */
  readonly ignoreCase?: boolean;
}

/**
 * An alias replaces the value verbatim, so it must not look like ordinary
 * text: restoring would turn every genuine occurrence back into the original.
 */
export function isUsableAlias(alias: string, value: string): boolean {
  return (
    alias.length >= 4 &&
    alias.length <= 64 &&
    !/\s/.test(alias) &&
    /[_\d]|[A-Z].*[A-Z]/.test(alias) &&
    alias !== value &&
    !alias.includes(value) &&
    !value.includes(alias)
  );
}
