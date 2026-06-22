import type { MidRollConfig } from '@tunarr/types/api';
import { describe, expect, it } from 'vitest';
import { resolveBreakPoints } from './midRollBreakRules.ts';

const baseConfig = (
  overrides: Partial<MidRollConfig> = {},
): MidRollConfig => ({
  breakRule: { type: 'detected' },
  maxBreaks: 0,
  minProgramDurationMs: 0,
  breakDurationMs: 60 * 1000,
  strategy: 'eager',
  ...overrides,
});

describe('resolveBreakPoints - detected rule', () => {
  it('returns null when program is shorter than minProgramDurationMs', () => {
    const config = baseConfig({ minProgramDurationMs: 10_000 });
    expect(resolveBreakPoints(5_000, config, [1_000])).toBeNull();
  });

  it('uses detected offsets as break points', () => {
    const config = baseConfig();
    const result = resolveBreakPoints(60 * 60 * 1000, config, [
      10 * 60 * 1000,
      30 * 60 * 1000,
    ]);
    expect(result).toEqual([
      { offsetMs: 10 * 60 * 1000 },
      { offsetMs: 30 * 60 * 1000 },
    ]);
  });

  it('ignores detected offsets at or beyond the program duration', () => {
    const config = baseConfig();
    const result = resolveBreakPoints(60 * 60 * 1000, config, [
      30 * 60 * 1000,
      99 * 60 * 1000, // beyond program
    ]);
    expect(result).toEqual([{ offsetMs: 30 * 60 * 1000 }]);
  });

  it('enforces minimum spacing between detected breaks', () => {
    const config = baseConfig({
      breakRule: { type: 'detected', minSpacingMs: 5 * 60 * 1000 },
    });
    const result = resolveBreakPoints(60 * 60 * 1000, config, [
      10 * 60 * 1000,
      12 * 60 * 1000, // within 5 min of previous -> dropped
      30 * 60 * 1000,
    ]);
    expect(result).toEqual([
      { offsetMs: 10 * 60 * 1000 },
      { offsetMs: 30 * 60 * 1000 },
    ]);
  });

  it('caps breaks at maxBreaks', () => {
    const config = baseConfig({ maxBreaks: 1 });
    const result = resolveBreakPoints(60 * 60 * 1000, config, [
      10 * 60 * 1000,
      30 * 60 * 1000,
    ]);
    expect(result).toEqual([{ offsetMs: 10 * 60 * 1000 }]);
  });

  it('falls back to a computed rule when no detected offsets exist', () => {
    const config = baseConfig({
      breakRule: {
        type: 'detected',
        fallback: { type: 'fixed_interval', intervalMs: 20 * 60 * 1000 },
      },
    });
    const result = resolveBreakPoints(60 * 60 * 1000, config, []);
    expect(result).toEqual([
      { offsetMs: 20 * 60 * 1000 },
      { offsetMs: 40 * 60 * 1000 },
    ]);
  });

  it('returns null when no detected offsets and no fallback', () => {
    const config = baseConfig();
    expect(resolveBreakPoints(60 * 60 * 1000, config, [])).toBeNull();
    expect(resolveBreakPoints(60 * 60 * 1000, config, undefined)).toBeNull();
  });

  it('drops detected breaks that violate the tail buffer', () => {
    const config = baseConfig({
      breakDurationMs: 60 * 1000,
      tailBufferMs: 5 * 60 * 1000,
    });
    const result = resolveBreakPoints(60 * 60 * 1000, config, [
      30 * 60 * 1000,
      59 * 60 * 1000, // too close to the end given break + tail buffer
    ]);
    expect(result).toEqual([{ offsetMs: 30 * 60 * 1000 }]);
  });
});
