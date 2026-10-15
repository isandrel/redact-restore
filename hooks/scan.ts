/**
 * Finds likely private values on this machine and in this folder: the git
 * identity, remotes and recent authors, the host and user names, `.env` values
 * and the package author. Pure: the caller gathers the inputs (git, files) and
 * shows candidates only in the local pane. Never send a candidate's value to the model.
 */
import {
  BOT_AUTHOR,
  ENV_EXAMPLE,
  ENV_FILE,
  GENERIC_ACCOUNTS,
  LOCAL_HOST_SUFFIX,
  MIN_CUSTOM_VALUE_LENGTH,
  PUBLIC_GIT_HOSTS,
  SECRET_KEY,
  TRIVIAL_VALUE,
  SCAN_DESCRIPTIONS,
} from './defaults.ts';
import { envAssignments, findInternalHosts } from './detectors.ts';
import { findPrivateMatches, type MatchingOptions } from './matcher.ts';
import { fingerprint, ruleKey } from './rules.ts';

export interface ScanCandidate {
  readonly value: string;
  /** The label a rule for it gets: NAME, EMAIL, ORG, HOST, PROJECT, USER, SECRET or ENV. */
  readonly label: string;
  /** Where it was found, without the value (`git config user.name`, `.env (DB_PASSWORD)`). */
  readonly source: string;
  /** What it is, for the rule's description (told to the model, never the value). */
  readonly description?: string;
}

export interface ScanInputs {
  readonly gitName?: string;
  readonly gitEmail?: string;
  /** `git remote -v` output. */
  readonly remotes?: string;
  /** `git log --format=%an%x00%ae` output. */
  readonly logAuthors?: string;
  readonly hostname?: string;
  /** The home folder path; its last segment is the account name. */
  readonly home?: string;
  readonly envFiles?: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  /** package.json text. */
  readonly packageJson?: string;
}

export { PUBLIC_GIT_HOSTS };

/** Whether a root-level file name is a real `.env` file (not an example). */
export function isEnvFile(name: string): boolean {
  return ENV_FILE.test(name) && !ENV_EXAMPLE.test(name);
}

/** `KEY=value` pairs of a dotenv file: `export`, quotes and trailing comments handled. */
export function parseEnvFile(text: string): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? '';
    let value = (match[2] ?? '').trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'" || quote === '`') && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    pairs.push({ key, value });
  }
  return pairs;
}

/**
 * Host, owner and repository of each remote URL (https, ssh, scp-like):
 * the owner is the first path segment, the repository the last, so GitLab
 * subgroups and Azure DevOps (`v3/org/project/repo`, `org/project/_git/repo`) parse.
 */
export function parseRemotes(text: string): Array<{ host: string; owner: string; repo: string }> {
  const found: Array<{ host: string; owner: string; repo: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    const match = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(url);
    if (!match) continue;
    const segments = (match[2] ?? '')
      .split('/')
      .filter(segment => segment && segment !== '_git' && !/^v\d+$/.test(segment));
    if (segments.length < 2) continue;
    found.push({
      host: (match[1] ?? '').toLowerCase(),
      owner: segments[0] ?? '',
      repo: segments[segments.length - 1] ?? '',
    });
  }
  return found;
}

/** `Name <email> (url)` or `{ name, email }` from package.json's `author`. */
export function packageAuthor(text: string): { name?: string; email?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof data !== 'object' || data === null || !('author' in data)) return {};
  const author = data.author;
  if (typeof author === 'string') {
    const match = /^([^<(]*?)\s*(?:<([^>]+)>)?\s*(?:\([^)]*\))?$/.exec(author.trim());
    return {
      ...(match?.[1] ? { name: match[1] } : {}),
      ...(match?.[2] ? { email: match[2] } : {}),
    };
  }
  if (typeof author === 'object' && author !== null) {
    const name = 'name' in author && typeof author.name === 'string' ? author.name : undefined;
    const email = 'email' in author && typeof author.email === 'string' ? author.email : undefined;
    return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
  }
  return {};
}

function lastSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  );
}

/** Every candidate, first source wins for a repeated value; nothing shorter than a rule allows. */
export function collectCandidates(inputs: ScanInputs): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined, label: string, source: string, description?: string) => {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length < MIN_CUSTOM_VALUE_LENGTH || TRIVIAL_VALUE.test(trimmed)) return;
    const key = ruleKey(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ value: trimmed, label, source, ...(description ? { description } : {}) });
  };

  add(inputs.gitName, 'NAME', 'git config user.name', SCAN_DESCRIPTIONS.gitName);
  add(inputs.gitEmail, 'EMAIL', 'git config user.email', SCAN_DESCRIPTIONS.gitEmail);

  for (const remote of parseRemotes(inputs.remotes ?? '')) {
    const isPublic = PUBLIC_GIT_HOSTS.includes(remote.host);
    if (!isPublic) add(remote.host, 'HOST', 'git remote host', SCAN_DESCRIPTIONS.remoteHost);
    add(remote.owner, 'ORG', 'git remote owner', SCAN_DESCRIPTIONS.remoteOwner);
    if (!isPublic) add(remote.repo, 'PROJECT', 'git remote repository', SCAN_DESCRIPTIONS.remoteRepo);
  }

  for (const line of (inputs.logAuthors ?? '').split(/\r?\n/)) {
    const [name, email] = line.split('\u0000');
    if (!name || BOT_AUTHOR.test(name) || BOT_AUTHOR.test(email ?? '')) continue;
    add(name, 'NAME', 'git log author', SCAN_DESCRIPTIONS.logName);
    add(email, 'EMAIL', 'git log author', SCAN_DESCRIPTIONS.logEmail);
  }

  const author = inputs.packageJson ? packageAuthor(inputs.packageJson) : {};
  add(author.name, 'NAME', 'package.json author', SCAN_DESCRIPTIONS.packageName);
  add(author.email, 'EMAIL', 'package.json author', SCAN_DESCRIPTIONS.packageEmail);

  const host = inputs.hostname?.trim().replace(LOCAL_HOST_SUFFIX, '');
  add(host, 'HOST', 'computer name', SCAN_DESCRIPTIONS.computer);
  const account = inputs.home ? lastSegment(inputs.home) : '';
  if (!GENERIC_ACCOUNTS.includes(account.toLowerCase()))
    add(account, 'USER', 'home folder name', SCAN_DESCRIPTIONS.account);

  for (const file of inputs.envFiles ?? []) {
    for (const { key, value } of parseEnvFile(file.text)) {
      if (value.startsWith('${') || value.includes('{{')) continue;
      add(value, SECRET_KEY.test(key) ? 'SECRET' : 'ENV', `${file.name} (${key})`, SCAN_DESCRIPTIONS.envValue(key));
    }
  }
  return candidates;
}

/**
 * Candidates in any text files (a path scan): `KEY=value` values and host names
 * on private networks. Values masked anyway are counted, not offered, by `triage`.
 */
export function fileCandidates(
  files: ReadonlyArray<{ readonly name: string; readonly text: string }>,
): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string, source: string, description?: string) => {
    const key = ruleKey(value);
    if (value.length < MIN_CUSTOM_VALUE_LENGTH || seen.has(key)) return;
    seen.add(key);
    candidates.push({ value, label, source, ...(description ? { description } : {}) });
  };
  for (const file of files) {
    for (const { key, value } of envAssignments(file.text)) {
      add(value, SECRET_KEY.test(key) ? 'SECRET' : 'ENV', `${file.name} (${key})`, SCAN_DESCRIPTIONS.envValue(key));
    }
    for (const { start, end } of findInternalHosts(file.text)) add(file.text.slice(start, end), 'HOST', file.name);
  }
  return candidates;
}

/** The KEY=value values in these files: masked wherever they appear as an assignment while the env detector is on. */
export function assignedValues(files: ReadonlyArray<{ readonly text: string }>): Set<string> {
  return new Set(files.flatMap(file => envAssignments(file.text).map(({ value }) => value)));
}

/** Distinct values the current rules and detectors already mask in these files, by label. */
export function maskedKinds(
  files: ReadonlyArray<{ readonly text: string }>,
  matching: MatchingOptions,
): Array<readonly [string, number]> {
  const byLabel = new Map<string, Set<string>>();
  for (const file of files) {
    for (const match of findPrivateMatches(file.text, matching)) {
      const values = byLabel.get(match.category) ?? new Set<string>();
      values.add(match.value);
      byLabel.set(match.category, values);
    }
  }
  return [...byLabel.entries()]
    .map(([label, values]) => [label, values.size] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Candidates by label, for command output that must not carry values: `2 NAME, 1 HOST`. */
export function countByLabel(candidates: readonly ScanCandidate[]): string {
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.label, (counts.get(candidate.label) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(', ');
}

/** Whether the current rules, the email scanner or a detector already mask the whole value. */
export function isMasked(value: string, matching: MatchingOptions): boolean {
  return findPrivateMatches(value, matching).some(match => match.start === 0 && match.end === value.length);
}

/** Splits found values into new ones, ones already masked, and ones dismissed before. */
export async function triage(
  found: readonly ScanCandidate[],
  matching: MatchingOptions,
  ignored: ReadonlySet<string>,
  /** Also masked in context (a KEY=value value the env detector hides), though not on its own. */
  maskedInContext: (candidate: ScanCandidate) => boolean = () => false,
): Promise<{ candidates: ScanCandidate[]; covered: number; ignored: number }> {
  const candidates: ScanCandidate[] = [];
  let covered = 0;
  let dismissed = 0;
  for (const candidate of found) {
    if (maskedInContext(candidate) || isMasked(candidate.value, matching)) covered += 1;
    else if (ignored.has(await fingerprint(candidate.value))) dismissed += 1;
    else candidates.push(candidate);
  }
  return { candidates, covered, ignored: dismissed };
}
