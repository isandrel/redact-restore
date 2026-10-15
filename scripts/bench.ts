/**
 * Local benchmark of the pure masking paths on synthetic data: what a large
 * session costs per hook. Run: bun run bench [--json]
 *
 * Nothing here reads real files or values; every input is generated.
 */
import { parseConfig } from '../hooks/config.ts';
import { DETECTORS } from '../hooks/detectors.ts';
import { findPrivateMatches, normalizeRules } from '../hooks/matcher.ts';
import {
  auditMessages,
  createAuditMemo,
  maskContentBlocks,
  maskText,
  restoreForDisplay,
  unmaskText,
  type Vault,
} from '../hooks/privacy.ts';

const RUNS = 5;
const VAULT_SIZES = [0, 1_000, 10_000];
const RULE_COUNT = 2_000;

/** Deterministic pseudo-random text: code-like lines with a few private values mixed in. */
function syntheticText(bytes: number, seed: number): string {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state;
  };
  const lines: string[] = [];
  let size = 0;
  while (size < bytes) {
    const n = next() % 7;
    const line =
      n === 0
        ? `const value${next() % 1000} = compute(${next() % 100}, "item-${next() % 10_000}");`
        : n === 1
          ? `user${next() % 500}@example.com sent ${next() % 100} messages`
          : n === 2
            ? `curl https://build${next() % 50}.acme.internal:8443/api/v1/items?id=${next()}`
            : n === 3
              ? `API_TOKEN=tok_${next().toString(16)}${next().toString(16)}`
              : n === 4
                ? `${'a'.repeat(next() % 120)} lorem ipsum dolor sit amet`
                : n === 5
                  ? `Client ${next() % RULE_COUNT} Corp signed the order`
                  : `  at Module.run (src/file${next() % 300}.ts:${next() % 400}:${next() % 80})`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

function syntheticVault(size: number): Vault {
  const vault: Vault = {};
  for (let i = 0; i < size; i++) vault[`{{PRIVATE:CUSTOM#${i.toString(16).padStart(12, '0')}}}`] = `Value ${i} Example`;
  return vault;
}

function time(label: string, run: () => unknown, results: Array<{ label: string; ms: number }>): void {
  run(); // Warm caches and the JIT once.
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results.push({ label, ms: Math.round((samples[Math.floor(RUNS / 2)] ?? 0) * 10) / 10 });
}

const results: Array<{ label: string; ms: number }> = [];
const rules = normalizeRules(Array.from({ length: RULE_COUNT }, (_, i) => ({ value: `Client ${i} Corp` })));
const base = parseConfig({}).matching;
const matching = { ...base, customValues: rules.values, rules: rules.rules };
const text100k = syntheticText(100_000, 1);
const text1m = syntheticText(1_000_000, 2);

for (const size of VAULT_SIZES) {
  const vault = syntheticVault(size);
  time(`maskText 100 KB, ${RULE_COUNT} rules, vault ${size}`, () => maskText(text100k, matching, vault), results);
  time(`maskText 1 MB, ${RULE_COUNT} rules, vault ${size}`, () => maskText(text1m, matching, vault), results);
  const masked = maskText(text1m, matching, vault);
  const full = { ...vault, ...masked.additions };
  time(`unmaskText 1 MB, vault ${Object.keys(full).length}`, () => unmaskText(masked.text, full), results);
  time(
    `restoreForDisplay tool row, vault ${Object.keys(full).length}`,
    () =>
      restoreForDisplay(
        { command: masked.text.slice(0, 2000), output: { stdout: masked.text.slice(0, 20_000) } },
        full,
      ),
    results,
  );
  const messages = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: [{ type: 'text', text: masked.text.slice(i * 5000, i * 5000 + 5000) }],
  }));
  time(
    `audit 200 messages (1 MB), vault ${Object.keys(full).length}, cold`,
    () => auditMessages(messages, matching, full, { allowMedia: false }),
    results,
  );
  const memo = createAuditMemo();
  auditMessages(messages, matching, full, { allowMedia: false }, memo);
  time(
    `audit 200 messages, vault ${Object.keys(full).length}, memo warm`,
    () => auditMessages(messages, matching, full, { allowMedia: false }, memo),
    results,
  );
  time(
    `session.append tool_result 1 MB, vault ${size}`,
    () =>
      maskContentBlocks([{ type: 'tool_result', tool_use_id: 't', content: text1m }], matching, vault, {
        allowMedia: false,
      }),
    results,
  );
}

// Each active detector (gitleaks as one) alone on 1 MB: the slow ones show up here.
const perDetector = (base.detectors ?? DETECTORS)
  .map(detector => {
    const start = performance.now();
    findPrivateMatches(text1m, { ...base, customValues: [], redactEmails: false, detectors: [detector] });
    return { label: `detector ${detector.id} 1 MB`, ms: Math.round((performance.now() - start) * 10) / 10 };
  })
  .sort((a, b) => b.ms - a.ms)
  .slice(0, 8);
results.push(...perDetector);

if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
else for (const { label, ms } of results) console.log(`${String(ms).padStart(8)} ms  ${label}`);
