// State contract for redact-restore: what $.state holds for one session.
// Counts, kinds and positions, except where marked: the vault, the stored
// rules and the scan candidates hold originals, for this machine only.

export type RedactRestoreBlockInfo = {
  readonly kind: string;
  readonly message: number;
  readonly block: string;
};

export type RedactRestoreMetrics = {
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly lastEvent: string;
  readonly version: string;
  readonly surface: string;
  /** Replacements made, counting every occurrence. */
  readonly occurrences: number;
  readonly bySource: Readonly<Record<string, number>>;
  /** Replacements since the person's last prompt. */
  readonly lastTurnMasked: number;
  readonly restoredCalls: number;
  readonly restoredByTool: Readonly<Record<string, number>>;
  readonly keptCalls: number;
  readonly deniedCalls: number;
  readonly audits: number;
  readonly blocked: number;
  readonly lastAuditBlocked: boolean;
  readonly lastBlock: RedactRestoreBlockInfo | null;
  readonly mediaWithheld: number;
  readonly promptsDropped: number;
  readonly hookErrors: Readonly<Record<string, number>>;
};

/** A rule kept in the plugin store; holds an original value. */
export type RedactRestoreRule = {
  readonly value: string;
  readonly label?: string;
  readonly alias?: string;
  readonly source: 'manual' | 'scan' | 'import';
  readonly addedAt: string;
};

/** A value a scan found; holds an original value, shown only in the pane. */
export type RedactRestoreCandidate = {
  readonly value: string;
  readonly label: string;
  readonly source: string;
};

export type RedactRestoreScan = {
  readonly candidates: readonly RedactRestoreCandidate[];
  readonly covered: number;
  readonly ignored: number;
  readonly target?: string;
  readonly files?: number;
  readonly kinds?: ReadonlyArray<readonly [string, number]>;
};

export type RedactRestoreDraft = {
  readonly value: string;
  readonly mode: 'label' | 'alias';
  readonly label: string;
  readonly customLabel: boolean;
  readonly alias: string;
  readonly editing: boolean;
};

export type RedactRestorePane = {
  readonly view: 'rules' | 'scan' | 'session';
  readonly reveal: boolean;
  readonly notice: string;
  /** The rule form; holds a typed value (an original) while it is filled in. */
  readonly draft: RedactRestoreDraft;
};

declare module 'claude-code' {
  interface PluginState {
    'redact-restore': {
      vault: Record<string, string>;
      metrics: RedactRestoreMetrics;
      rules: readonly RedactRestoreRule[];
      scan: RedactRestoreScan | null;
      pane: RedactRestorePane;
    };
  }
}
