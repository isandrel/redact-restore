// Session maps kept for /resume. Synthetic values only.
import { describe, expect, test } from 'claude-code/testing';
import { isSessionId, parseSessionMap, serializeSessionMap } from '../../hooks/session-map.ts';

describe('session maps', () => {
  const map = {
    vault: { '{{PRIVATE:ORG#0123456789ab}}': 'Acme Corp' },
    notes: { '{{PRIVATE:ORG#0123456789ab}}': 'client company name' },
    sent: { '{{PRIVATE:ORG#0123456789ab}}': true as const },
  };

  test('round trip', () => {
    expect(parseSessionMap(serializeSessionMap(map, new Date(0)))).toEqual(map);
  });

  test('anything else is refused: not JSON, another format, a newer version, non-string values', () => {
    for (const text of [
      'not json',
      '{"format":"other","version":1,"vault":{}}',
      '{"format":"redact-restore-session","version":99,"vault":{}}',
      '{"format":"redact-restore-session","version":1,"vault":{"a":1}}',
      '{"format":"redact-restore-session","version":1}',
    ]) {
      expect(parseSessionMap(text)).toBeUndefined();
    }
  });

  test('session ids are safe file names', () => {
    expect(isSessionId('375d241f-050b-461e-bd67-fc135f9d8781')).toBe(true);
    for (const id of ['', '../x', 'a/b', 'a b']) expect(isSessionId(id)).toBe(false);
  });
});
