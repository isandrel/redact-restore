/**
 * Built-in detectors: one table, each entry an id, a label for its
 * placeholders, groups for configuration, and a finder that returns spans.
 * Pure and linear-time (prefix-anchored, bounded quantifiers, a literal hint
 * checked first). Validators (checksums, entropy, decoders) keep false
 * positives down; a detector masks only the secret part of what it matches.
 *
 * Sources of the rules: gitleaks and claude-code-redact (provider keys, JWT,
 * PEM, connection strings, assignments), maskit (Chinese ID, mobile, USCC,
 * Chinese assignment keywords), Presidio (Luhn, IBAN).
 */
import {
  GENERIC_INTERNAL_HOST,
  INTERNAL_HOST,
  KEYWORD_RESCAN_LIMIT,
  KEYWORD_WINDOW_AFTER,
  KEYWORD_WINDOW_BEFORE,
  MIN_CUSTOM_VALUE_LENGTH,
  TRIVIAL_VALUE,
} from './defaults.ts';
import { GITLEAKS_ALLOW, GITLEAKS_RULES, GITLEAKS_STOPWORDS, type GitleaksRule } from './vendor/gitleaks-rules.ts';

export interface Span {
  readonly start: number;
  readonly end: number;
  /** Overrides the detector's label (a table detector such as gitleaks labels per rule). */
  readonly label?: string;
}

export type DetectorGroup = 'secrets' | 'pii' | 'cn' | 'network' | 'gitleaks';

export interface Detector {
  readonly id: string;
  readonly label: string;
  readonly groups: readonly DetectorGroup[];
  readonly defaultOn: boolean;
  /** Labels this detector beats where their spans overlap (e.g. a password over an email). */
  readonly outranks?: readonly string[];
  /** Tie-break against other matches of the same span: lower wins (built-ins 1, gitleaks 2). */
  readonly rank?: number;
  /** What a match is, told to the model with its placeholder (pattern rules). */
  readonly description?: string;
  find(text: string): Span[];
}

/** Spans of a regex's `secret` named group (or the whole match), filtered by `accept`. */
function spans(
  pattern: RegExp,
  text: string,
  accept: (value: string, match: RegExpExecArray) => boolean = () => true,
): Span[] {
  const found: Span[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const secret = match.groups?.secret;
    const value = secret ?? match[0];
    const offset = secret === undefined ? 0 : match[0].lastIndexOf(secret);
    if (value && accept(value, match))
      found.push({ start: match.index + offset, end: match.index + offset + value.length });
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return found;
}

// `KEY=value` with an upper-case key: a whole line (as in .env files, where
// spaces around `=` and a value running to the end of the line are allowed),
// or inline with no spaces around `=` (`FOO=bar cmd`, a one-line paste).
const ENV_LINE = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{1,63})[ \t]*=[ \t]*([^\r\n]*)$/gm;
const ENV_INLINE = /(?<![\w.$-])([A-Z][A-Z0-9_]{1,63})=("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;,|&)]+)/g;

/** A value worth hiding: not empty, trivial (`true`, `8080`), a reference (`${HOME}`) or a placeholder. */
function envValueWorthMasking(value: string): boolean {
  return (
    value.length >= MIN_CUSTOM_VALUE_LENGTH &&
    !TRIVIAL_VALUE.test(value) &&
    // Code, not configuration: a call (`getLogger(__name__)`) or a comparison (`MODE==X`).
    !/[()]/.test(value) &&
    !value.startsWith('=') &&
    !/^\$\{?[A-Za-z_]/.test(value) &&
    !value.includes('{{') &&
    !/^<[^>]*>$/.test(value)
  );
}

/** The value's span inside a raw `=` right-hand side: quotes and a trailing comment removed. */
function valueSpan(text: string, rawStart: number, raw: string, comments: boolean): { start: number; end: number } {
  const quote = raw.charAt(0);
  const close = quote === '"' || quote === "'" ? raw.indexOf(quote, 1) : -1;
  if (close > 0) return { start: rawStart + 1, end: rawStart + close };
  let end = rawStart + raw.length;
  const comment = comments ? raw.search(/\s#/) : -1;
  if (comment >= 0) end = rawStart + comment;
  while (end > rawStart && /\s/.test(text.charAt(end - 1))) end -= 1;
  // An unquoted value stops at whitespace: `NODE_ENV=production bun run build` masks one word.
  const space = text.slice(rawStart, end).search(/\s/);
  if (space >= 0) end = rawStart + space;
  return { start: rawStart, end };
}

/**
 * Every `KEY=value` assignment's value, quotes and trailing comments removed:
 * the env detector masks them, and a path scan lists them.
 */
export function envAssignments(text: string): Array<{ key: string; value: string; start: number; end: number }> {
  if (!text.includes('=')) return [];
  const found: Array<{ key: string; value: string; start: number; end: number }> = [];
  const taken: Array<{ start: number; end: number }> = [];
  const add = (key: string, span: { start: number; end: number }) => {
    const value = text.slice(span.start, span.end);
    if (!envValueWorthMasking(value) || taken.some(t => span.start < t.end && t.start < span.end)) return;
    taken.push(span);
    found.push({ key, value, ...span });
  };
  ENV_LINE.lastIndex = 0;
  for (let match = ENV_LINE.exec(text); match; match = ENV_LINE.exec(text)) {
    const raw = match[2] ?? '';
    add(match[1] ?? '', valueSpan(text, match.index + match[0].length - raw.length, raw, true));
  }
  ENV_INLINE.lastIndex = 0;
  for (let match = ENV_INLINE.exec(text); match; match = ENV_INLINE.exec(text)) {
    const raw = match[2] ?? '';
    add(match[1] ?? '', valueSpan(text, match.index + match[0].length - raw.length, raw, false));
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Host names on private networks, told apart from code such as `self.local` or
 * `threading.local()`: three or more labels, a digit or hyphen in the first label,
 * or a host context (`//host`, `@host`, `host:port`); never a call.
 */
export function findInternalHosts(text: string): Span[] {
  const spans: Span[] = [];
  INTERNAL_HOST.lastIndex = 0;
  for (const match of text.matchAll(INTERNAL_HOST)) {
    const value = match[0];
    const start = match.index;
    const end = start + value.length;
    if (GENERIC_INTERNAL_HOST.test(value) || text.charAt(end) === '(') continue;
    const labels = value.split('.');
    const hostLike =
      labels.length >= 3 ||
      /[\d-]/.test(labels[0] ?? '') ||
      /(?:\/\/|@)$/.test(text.slice(Math.max(0, start - 2), start)) ||
      /^:\d/.test(text.slice(end, end + 2));
    if (hostLike) spans.push({ start, end });
  }
  return spans;
}

/** A detector from a regex, with an optional literal hint that must appear first. */
function regexDetector(
  id: string,
  label: string,
  groups: readonly DetectorGroup[],
  defaultOn: boolean,
  pattern: RegExp,
  hint?: string | readonly string[],
  accept?: (value: string, match: RegExpExecArray) => boolean,
): Detector {
  const hints = hint === undefined ? [] : typeof hint === 'string' ? [hint] : hint;
  return {
    id,
    label,
    groups,
    defaultOn,
    find: text => (hints.length > 0 && !hints.some(h => text.includes(h)) ? [] : spans(pattern, text, accept)),
  };
}

// --- validators -----------------------------------------------------------

/** Rejects documentation fillers such as ghp_xxxxxxxx or AKIA...EXAMPLE. */
function looksReal(value: string): boolean {
  return new Set(value).size >= 6 && !/EXAMPLE|example|x{6,}|X{6,}|\*{3,}/.test(value);
}

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_ID_CHECK = '10X98765432';
const CN_PROVINCES = new Set([
  11, 12, 13, 14, 15, 21, 22, 23, 31, 32, 33, 34, 35, 36, 37, 41, 42, 43, 44, 45, 46, 50, 51, 52, 53, 54, 61, 62, 63,
  64, 65, 71, 81, 82, 83, 91,
]);

/** 18-digit resident identity number: province code, real birth date, ISO 7064 check digit. */
export function cnIdValid(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id) || !CN_PROVINCES.has(Number(id.slice(0, 2)))) return false;
  const year = Number(id.slice(6, 10));
  const month = Number(id.slice(10, 12));
  const day = Number(id.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1880 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getTime() > Date.now()) {
    return false;
  }
  const sum = CN_ID_WEIGHTS.reduce((total, weight, index) => total + weight * Number(id[index]), 0);
  return CN_ID_CHECK[sum % 11] === id.charAt(17).toUpperCase();
}

const USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/** Unified social credit code (统一社会信用代码), GB 32100 MOD 31 check. */
export function usccValid(code: string): boolean {
  if (!/^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(code)) return false;
  const sum = USCC_WEIGHTS.reduce((total, weight, index) => total + weight * USCC_CHARS.indexOf(code.charAt(index)), 0);
  return USCC_CHARS.charAt((31 - (sum % 31)) % 31) === code.charAt(17);
}

/** ISO 13616 IBAN, spaces allowed: rearrange, letters to numbers, mod 97 == 1. */
export function ibanValid(raw: string): boolean {
  const iban = raw.replace(/ /g, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** A JWT whose header decodes to JSON with an `alg`. */
function jwtValid(token: string): boolean {
  try {
    const header = token.split('.')[0] ?? '';
    const json = atob(
      header
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(header.length / 4) * 4, '='),
    );
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && 'alg' in parsed;
  } catch {
    return false;
  }
}

const SECRET_STOPWORDS =
  /^(?:changeme|change_me|password|passwd|secret|token|example|sample|dummy|placeholder|null|none|nil|true|false|undefined|redacted|xxx+|\*+|<[^>]*>|test|testing)$/i;

/** A credential value, not code or a template: no env refs, identifiers or member chains. */
function credentialValue(value: string, minEntropy: number): boolean {
  if (value.length < 8 || value.length > 16_384) return false;
  if (SECRET_STOPWORDS.test(value)) return false;
  if (/\$\{|\{\{|%\(|process\.env|os\.environ|getenv|^\$[A-Z_]/.test(value)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?$/.test(value) && !/\d/.test(value)) return false;
  // Code, not a credential: a call or a member chain (`request.headers.get(`, `cfg.db.pass`).
  if (
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/.test(value) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}$/.test(value)
  ) {
    return false;
  }
  if (!/[\d\W_]/.test(value)) return false;
  return shannonEntropy(value) >= minEntropy && looksReal(value);
}

// --- special finders ------------------------------------------------------

/** PEM private key blocks; a key cut off before its END line is masked to its last base64 line. */
function findPrivateKeys(text: string): Span[] {
  const found: Span[] = [];
  const begin = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
  for (let match = begin.exec(text); match; match = begin.exec(text)) {
    const end = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
    end.lastIndex = begin.lastIndex;
    const closing = end.exec(text);
    const limit = match.index + 16_384;
    let stop: number;
    if (closing && closing.index < limit) {
      stop = closing.index + closing[0].length;
    } else {
      stop = begin.lastIndex;
      // Real or JSON-escaped line breaks (a service-account key cut off mid-string).
      const body = /(?:\r?\n|(?:\\r)?\\n)[A-Za-z0-9+/=:\- ]{1,200}(?=\r?\n|(?:\\r)?\\n|$|["',])/y;
      body.lastIndex = stop;
      for (let line = body.exec(text); line && body.lastIndex <= limit; line = body.exec(text)) stop = body.lastIndex;
    }
    found.push({ start: match.index, end: stop });
    begin.lastIndex = stop;
  }
  return found;
}

/** Card numbers: 13-19 digits, one consistent separator, issuer prefix 2-6, Luhn. */
function findCards(text: string): Span[] {
  return spans(
    /(?<![\d.])[2-6]\d{3}(?<sep>[ -]?)\d{4}\k<sep>\d{4}\k<sep>\d{1,4}(?:\k<sep>\d{1,3})?(?![\d.])/g,
    text,
    value => luhnValid(value.replace(/[ -]/g, '')) && value.replace(/[ -]/g, '').length <= 19,
  );
}

// --- the table --------------------------------------------------------------

export const DETECTORS: readonly Detector[] = [
  // Secrets: provider-prefixed keys and credentials (on by default).
  {
    id: 'private_key',
    label: 'PRIVATE_KEY',
    groups: ['secrets'],
    defaultOn: true,
    find: text => (text.includes('PRIVATE KEY') ? findPrivateKeys(text) : []),
  },
  regexDetector(
    'anthropic_key',
    'ANTHROPIC_KEY',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,200}/g,
    'sk-ant-',
    looksReal,
  ),
  regexDetector(
    'openai_key',
    'OPENAI_KEY',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,200}/g,
    'sk-',
    value => looksReal(value) && /\d/.test(value) && /[A-Za-z]/.test(value.slice(3)),
  ),
  regexDetector(
    'aws_access_key',
    'AWS_KEY',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}(?![A-Za-z0-9])/g,
    ['AKIA', 'ASIA', 'ABIA', 'ACCA'],
    looksReal,
  ),
  regexDetector(
    'aws_secret_key',
    'AWS_SECRET',
    ['secrets'],
    true,
    /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    ['secret', 'SECRET'],
    looksReal,
  ),
  regexDetector(
    'github_token',
    'GITHUB_TOKEN',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})(?![A-Za-z0-9_])/g,
    ['gh', 'github_pat_'],
    looksReal,
  ),
  regexDetector(
    'gitlab_token',
    'GITLAB_TOKEN',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,64}/g,
    'glpat-',
    looksReal,
  ),
  regexDetector(
    'slack_token',
    'SLACK_TOKEN',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9-])xox[abposr]-[A-Za-z0-9-]{10,250}/g,
    'xox',
    looksReal,
  ),
  regexDetector(
    'slack_webhook',
    'SLACK_WEBHOOK',
    ['secrets'],
    true,
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,120}/g,
    'hooks.slack.com',
  ),
  regexDetector(
    'stripe_key',
    'STRIPE_KEY',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,247}/g,
    ['sk_', 'rk_'],
    looksReal,
  ),
  regexDetector(
    'google_api_key',
    'GOOGLE_API_KEY',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_-])(?:AIza[A-Za-z0-9_-]{35}|GOCSPX-[A-Za-z0-9_-]{28})(?![A-Za-z0-9_-])/g,
    ['AIza', 'GOCSPX-'],
    looksReal,
  ),
  regexDetector(
    'huggingface_token',
    'HF_TOKEN',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{34,40}(?![A-Za-z0-9_])/g,
    'hf_',
    looksReal,
  ),
  regexDetector(
    'npm_token',
    'NPM_TOKEN',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g,
    'npm_',
    looksReal,
  ),
  regexDetector('pypi_token', 'PYPI_TOKEN', ['secrets'], true, /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,300}/g, 'pypi-'),
  regexDetector('sendgrid_key', 'SENDGRID_KEY', ['secrets'], true, /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, 'SG.'),
  regexDetector(
    'aliyun_key',
    'ALIYUN_KEY',
    ['secrets', 'cn'],
    true,
    /(?<![A-Za-z0-9])LTAI[A-Za-z0-9]{12,20}(?![A-Za-z0-9])/g,
    'LTAI',
    looksReal,
  ),
  regexDetector(
    'tencent_key',
    'TENCENT_KEY',
    ['secrets', 'cn'],
    true,
    /(?<![A-Za-z0-9])AKID[A-Za-z0-9]{32}(?![A-Za-z0-9])/g,
    'AKID',
    looksReal,
  ),
  regexDetector(
    'jwt',
    'JWT',
    ['secrets'],
    true,
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,8000}\.[A-Za-z0-9_-]{8,2000}/g,
    'eyJ',
    jwtValid,
  ),
  {
    ...regexDetector(
      'connection_password',
      'PASSWORD',
      ['secrets'],
      true,
      /\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/[^\s:/@]{1,100}:(?<secret>[^\s@/]{1,200})@/g,
      '://',
      value => !/^(?:\$\{.*\}|\{\{.*\}\}|\*+|x+|password|pass|pwd|<.*>|%.*%)$/i.test(value),
    ),
    outranks: ['EMAIL'],
  },
  // Generic catch-alls rank below provider-specific rules (built-in and gitleaks).
  {
    ...regexDetector(
      'bearer_token',
      'BEARER_TOKEN',
      ['secrets'],
      true,
      /\b(?:Bearer|Token)\s+(?<secret>[A-Za-z0-9._~+/-]{16,}=*)/g,
      ['Bearer', 'Token'],
      value => credentialValue(value, 3),
    ),
    rank: 3,
  },
  {
    ...regexDetector(
      'secret_assignment',
      'SECRET',
      ['secrets', 'cn'],
      true,
      /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|密码|口令|令牌|密钥)(?:[_-](?:id|value|key|secret|token|string|b64|base64|hash)){0,2}["']?\s*[:=：＝]\s*["'“]?(?<secret>[^\s"'”,;]{8,})/gi,
      undefined,
      value => credentialValue(value, 3),
    ),
    rank: 3,
  },

  // Configuration values: a value written as KEY=value is masked whatever the key,
  // so a .env file read by a tool never reaches the model in the clear.
  {
    id: 'env_assignment',
    label: 'ENV',
    groups: ['secrets'],
    defaultOn: true,
    rank: 3,
    find: text => envAssignments(text).map(({ start, end }) => ({ start, end })),
  },

  // Personal data with check digits (on by default).
  { id: 'card', label: 'CARD', groups: ['pii'], defaultOn: true, find: findCards },
  regexDetector(
    'iban',
    'IBAN',
    ['pii'],
    true,
    /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Za-z0-9])/g,
    undefined,
    ibanValid,
  ),
  regexDetector(
    'cn_id',
    'CN_ID',
    ['pii', 'cn'],
    true,
    /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g,
    undefined,
    cnIdValid,
  ),
  regexDetector(
    'cn_phone',
    'CN_PHONE',
    ['pii', 'cn'],
    true,
    /(?<![\d+])(?:(?:\+|00)?86[- ]?)?1[3-9]\d(?:-\d{4}-\d{4}|\s\d{4}\s\d{4}|\d{8})(?!\d)/g,
    undefined,
    value => new Set(value.replace(/\D/g, '').slice(-8)).size > 2,
  ),
  regexDetector(
    'cn_uscc',
    'CN_USCC',
    ['pii', 'cn'],
    true,
    /(?<![0-9A-Z])[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}(?![0-9A-Z])/g,
    undefined,
    usccValid,
  ),

  // Personal and network identifiers: on by default; turn off with
  // disable_detectors (`us_ssn`, `phone`, `ipv4`, or the `pii` / `network` groups).
  regexDetector(
    'us_ssn',
    'US_SSN',
    ['pii'],
    true,
    /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
  ),
  regexDetector(
    'phone',
    'PHONE',
    ['pii'],
    true,
    /(?<![\w+])\+[1-9]\d{0,2}[ -]?\d{2,4}[ -]?\d{3,4}[ -]?\d{3,4}(?!\d)/g,
    '+',
    value => {
      const digits = value.replace(/\D/g, '').length;
      return digits >= 8 && digits <= 15;
    },
  ),
  regexDetector(
    'ipv4',
    'IP',
    ['network'],
    true,
    /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g,
    '.',
    value => !/^(?:127\.|0\.0\.0\.0$|255\.255\.255\.255$)/.test(value),
  ),
  { id: 'internal_host', label: 'HOST', groups: ['network'], defaultOn: true, find: findInternalHosts },
  regexDetector(
    'ipv6',
    'IP',
    ['network'],
    true,
    /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){6})(?![\w:.])/gi,
    ':',
    // A real address has 3+ groups and a letter or a long group; skips times (12:30) and loopback.
    value =>
      value !== '::1' &&
      value.split(':').filter(Boolean).length >= 3 &&
      (/[a-f]/i.test(value) || value.split(':').some(group => group.length >= 3)),
  ),
  regexDetector(
    'mac_address',
    'MAC',
    ['network'],
    true,
    /(?<![\w:-])(?:[0-9a-f]{2}([:-]))(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}(?![\w:-])/gi,
    undefined,
    value => !/^(?:00[:-]){5}00$|^(?:ff[:-]){5}ff$/i.test(value),
  ),
];

// --- gitleaks (vendored rule table) ---------------------------------------

interface CompiledRule {
  readonly rule: GitleaksRule;
  readonly pattern: RegExp;
  readonly allow: readonly RegExp[];
}

let compiledRules: readonly CompiledRule[] | undefined;
let globalAllow: readonly RegExp[] = [];

function compile(source: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

/** Compiled once; a rule this engine cannot compile is skipped, never fatal. */
function gitleaksRules(): readonly CompiledRule[] {
  if (!compiledRules) {
    globalAllow = GITLEAKS_ALLOW.flatMap(r => compile(r.source, r.flags) ?? []);
    compiledRules = GITLEAKS_RULES.flatMap(rule => {
      const pattern = compile(rule.source, `${rule.flags}gd`);
      return pattern ? [{ rule, pattern, allow: rule.allow.flatMap(r => compile(r.source, r.flags) ?? []) }] : [];
    });
  }
  return compiledRules;
}

/** How many gitleaks rules compiled in this engine (for tests and diagnostics). */
export function gitleaksRuleCount(): number {
  return gitleaksRules().length;
}

/** gitleaks' checks on a candidate secret: entropy, allowlists, stopwords. */
function gitleaksAccepts(compiled: CompiledRule, secret: string): boolean {
  if (compiled.rule.entropy > 0 && shannonEntropy(secret) < compiled.rule.entropy) return false;
  if (compiled.allow.some(r => r.test(secret)) || globalAllow.some(r => r.test(secret))) return false;
  const lower = secret.toLowerCase();
  if (compiled.rule.stopwords.some(word => lower.includes(word))) return false;
  return !GITLEAKS_STOPWORDS.some(word => lower.includes(word));
}

/**
 * One detector over the gitleaks table: the text is lowercased once for the
 * keyword prefilter, and each match is labelled by its rule (`GITHUB_PAT`, ...).
 */
export function gitleaksDetector(ruleIds: ReadonlySet<string>): Detector {
  return {
    id: 'gitleaks',
    label: 'SECRET',
    groups: ['secrets', 'gitleaks'],
    defaultOn: true,
    rank: 2,
    find(text) {
      const rules = gitleaksRules().filter(compiled => ruleIds.has(compiled.rule.id));
      const lower = text.toLowerCase();
      const found: Span[] = [];
      for (const compiled of rules) {
        const { keywords, secretGroup, label } = compiled.rule;
        // gitleaks runs a rule only where a keyword appears; scanning just the
        // windows around those hits keeps large inputs fast.
        const windows = keywords.length > 0 ? keywordWindows(lower, keywords) : [{ start: 0, end: text.length }];
        for (const window of windows) {
          const slice = text.slice(window.start, window.end);
          compiled.pattern.lastIndex = 0;
          for (let match of slice.matchAll(compiled.pattern)) {
            let offset = window.start;
            // A match that runs into the window's end may be longer: rescan from its start.
            if (match.index + match[0].length >= slice.length && window.end < text.length) {
              const sticky = new RegExp(compiled.pattern.source, compiled.pattern.flags.replace('g', '') + 'y');
              sticky.lastIndex = window.start + match.index;
              const longer = sticky.exec(text.slice(0, Math.min(text.length, sticky.lastIndex + RESCAN_LIMIT)));
              if (longer) {
                match = longer;
                offset = 0;
              }
            }
            const group = secretGroup > 0 ? secretGroup : match.length > 1 && match[1] !== undefined ? 1 : 0;
            const range = match.indices?.[group];
            const secret = match[group];
            if (!range || !secret || !gitleaksAccepts(compiled, secret)) continue;
            found.push({ start: offset + range[0], end: offset + range[1], label });
          }
        }
      }
      return found;
    },
  };
}

const WINDOW_BEFORE = KEYWORD_WINDOW_BEFORE;
const WINDOW_AFTER = KEYWORD_WINDOW_AFTER;
const RESCAN_LIMIT = KEYWORD_RESCAN_LIMIT;

/** Merged windows around every keyword occurrence, or none when no keyword appears. */
function keywordWindows(lower: string, keywords: readonly string[]): Span[] {
  const windows: Span[] = [];
  for (const keyword of keywords) {
    for (let at = lower.indexOf(keyword); at !== -1; at = lower.indexOf(keyword, at + keyword.length)) {
      windows.push({
        start: Math.max(0, at - WINDOW_BEFORE),
        end: Math.min(lower.length, at + keyword.length + WINDOW_AFTER),
      });
    }
  }
  windows.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end)
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, window.end) };
    else merged.push(window);
  }
  return merged;
}

const GITLEAKS_PREFIX = 'gitleaks.';
const GITLEAKS_IDS = new Set(GITLEAKS_RULES.map(rule => rule.id));

/** Ids and groups a user may name, e.g. `cn_phone`, `secrets`, `gitleaks.generic-api-key`. */
export function detectorNames(): string[] {
  return [
    ...DETECTORS.map(d => d.id),
    'gitleaks',
    'secrets',
    'pii',
    'cn',
    'network',
    'all',
    ...[...GITLEAKS_IDS].map(id => GITLEAKS_PREFIX + id),
  ];
}

function selects(name: string, detector: Pick<Detector, 'id' | 'groups'>): boolean {
  return name === 'all' || name === detector.id || (detector.groups as readonly string[]).includes(name);
}

/**
 * The active detectors: defaults, plus `enable` names, minus `disable` names
 * (disable wins). `gitleaks.<rule-id>` turns one gitleaks rule on or off.
 * Unknown names are returned so the caller can report them.
 */
export function selectDetectors(
  enable: readonly string[],
  disable: readonly string[],
): { detectors: Detector[]; unknown: string[] } {
  const known = new Set(detectorNames());
  const unknown = [...enable, ...disable].filter(name => !known.has(name));
  const detectors = DETECTORS.filter(
    detector =>
      (detector.defaultOn || enable.some(name => selects(name, detector))) &&
      !disable.some(name => selects(name, detector)),
  );
  const gitleaks = { id: 'gitleaks', groups: ['secrets', 'gitleaks'] as const };
  if (!disable.some(name => selects(name, gitleaks))) {
    const ruleIds = new Set(
      GITLEAKS_RULES.filter(
        rule =>
          (rule.defaultOn || enable.includes(GITLEAKS_PREFIX + rule.id)) &&
          !disable.includes(GITLEAKS_PREFIX + rule.id),
      ).map(rule => rule.id),
    );
    if (ruleIds.size > 0) detectors.push(gitleaksDetector(ruleIds));
  }
  return { detectors, unknown };
}

/** Labels that detectors produce (for status counts). */
export const DETECTOR_LABELS: ReadonlySet<string> = new Set([
  ...DETECTORS.map(d => d.label),
  ...GITLEAKS_RULES.map(rule => rule.label),
]);
