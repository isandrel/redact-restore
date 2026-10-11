// Status text and status file: counts and settings only. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import { maskText } from '../../hooks/privacy.ts';
import { formatStatus, statusFileContent, statusStats } from '../../hooks/status.ts';
import { combine, emptyMetrics, healthState, metricsChange } from '../../hooks/metrics.ts';
import { parseConfig } from '../../hooks/config.ts';

const config = { customValues: ['Project Phoenix'], customCaseInsensitive: false, redactEmails: true };
const vault = maskText('Project Phoenix alice@example.com bob@example.com', config, {}).additions;
const settings = { mode: 'all', audit: true, streaming: false, configProblems: 0 } as const;
const stats = statusStats(vault, settings);
const fileConfig = {
  placeholderFormat: '{{PRIVATE:{label}#{id}}}',
  idLength: 32,
  statusLine: 'count',
  extraKeepTools: 0,
  ignoredRules: 0,
  formatProblem: false,
} as const;

describe('status', () => {
  test('counts by kind', () => {
    expect(stats).toMatchObject({ masked: 3, emails: 2, custom: 1 });
  });

  test('presets', () => {
    expect(formatStatus('count', '', stats)).toBe('3 private values masked');
    expect(formatStatus('detailed', '', stats)).toBe(
      '3 masked (2 email, 0 detected, 1 custom) · tools: all · audit: on',
    );
  });

  test('off, or nothing masked yet, clears the line', () => {
    expect(formatStatus('off', '', stats)).toBeUndefined();
    expect(formatStatus('count', '', statusStats({}, settings))).toBeUndefined();
  });

  test('a template overrides the preset; unknown fields stay as written', () => {
    expect(formatStatus('count', '🔒 {masked} ({emails}✉ {custom}★) {streaming} {nope}', stats)).toBe(
      '🔒 3 (2✉ 1★) off {nope}',
    );
  });

  test('never contains a value or a placeholder', () => {
    const outputs = [
      formatStatus('detailed', '', stats),
      formatStatus('count', '{masked}{emails}{custom}{mode}', stats),
      statusFileContent(stats, emptyMetrics(0), fileConfig, { updatedAt: 0 }),
    ].join(' ');
    expect(outputs).not.toMatch(/example\.com|Phoenix|\{\{PRIVATE:[A-Z_]+#[a-f0-9]{12}\}\}/);
    expect(JSON.parse(statusFileContent(stats, emptyMetrics(0), fileConfig, { updatedAt: 5 }))).toMatchObject({
      ...stats,
      updatedAt: 5,
    });
  });

  test('counters feed the template and the health state', () => {
    const now = 10;
    const change = combine(
      metricsChange.newTurn(),
      metricsChange.masked('prompt', 3, 'prompt.submit'),
      metricsChange.masked('conversation', 2, 'session.append'),
      metricsChange.tool('Bash', 'restore'),
      metricsChange.tool('WebFetch', 'keep'),
      metricsChange.tool('Write', 'deny'),
      metricsChange.media(1),
      metricsChange.audit({ kind: 'email', message: 3, block: 'text' }),
    );
    const m = change(emptyMetrics(0, '0.9.0'), now);
    expect(m).toMatchObject({
      occurrences: 5,
      lastTurnMasked: 5,
      bySource: { prompt: 3, conversation: 2 },
      restoredCalls: 1,
      restoredByTool: { Bash: 1 },
      keptCalls: 1,
      deniedCalls: 1,
      mediaWithheld: 1,
      audits: 1,
      blocked: 1,
      lastAuditBlocked: true,
      lastBlock: { kind: 'email', message: 3, block: 'text' },
    });
    const s = statusStats(vault, settings, m);
    expect(
      formatStatus('count', '{state} {occurrences} +{lastTurn} ⛔{blocked} ↺{restored} ✕{denied} v{version}', s),
    ).toBe('blocked 5 +5 ⛔1 ↺1 ✕1 v0.9.0');
    expect(healthState(metricsChange.audit(null)(m, now), 0)).toBe('ok');
    expect(healthState(metricsChange.hookError('session.append')(emptyMetrics(0), now), 0)).toBe('warn');
    expect(healthState(emptyMetrics(0), 1)).toBe('warn');
  });

  test('the status file carries counters and settings, never values or labels', () => {
    const m = metricsChange.audit({ kind: 'custom', message: 1, block: 'tool_result' })(emptyMetrics(0), 1);
    const json = JSON.parse(
      statusFileContent(statusStats(vault, settings, m), m, fileConfig, { model: 'm', updatedAt: 2 }),
    );
    expect(json).toMatchObject({
      state: 'blocked',
      lastBlock: { kind: 'custom' },
      config: { idLength: 32 },
      model: 'm',
    });
    expect(JSON.stringify(json)).not.toMatch(/example\.com|Phoenix|\{\{PRIVATE:[A-Z_]+#[a-f0-9]{12}\}\}/);
  });

  test('options: defaults and an unknown line value', () => {
    expect(parseConfig({})).toMatchObject({ statusLine: 'count', statusFormat: '', statusFile: false });
    expect(parseConfig({ status_line: 'loud' }).statusLine).toBe('count');
  });
});
