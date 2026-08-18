import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DispatchLogger } from '../../server/services/dispatch-logger';

describe('M4: DispatchLogger', () => {
  let logger: DispatchLogger;
  let logs: string[];

  beforeEach(() => {
    logger = new DispatchLogger();
    logger.setEnabled(true);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes SHA-256 of first 200 chars', () => {
    const hash1 = logger.computeSpecHash('a'.repeat(300));
    const hash2 = logger.computeSpecHash('a'.repeat(200));
    const hash3 = logger.computeSpecHash('a'.repeat(200) + 'b');

    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
    expect(hash1).toHaveLength(64);
  });

  it('emits structured JSONL log', () => {
    logger.logDispatch('spec content here', 'feature', 'gpt-5.4-mini');

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toMatchObject({
      spec_hash: logger.computeSpecHash('spec content here'),
      routing_output: 'feature',
      model_selected: 'gpt-5.4-mini',
    });
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('skips logging when disabled', () => {
    logger.setEnabled(false);
    logger.logDispatch('spec', 'feature', 'gpt-5.4-mini');
    expect(logs).toHaveLength(0);
  });
});
