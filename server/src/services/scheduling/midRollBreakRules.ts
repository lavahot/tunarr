import type {
  MidRollBreakRule,
  MidRollComputedBreakRule,
  MidRollConfig,
} from '@tunarr/types/api';

export type BreakPoint = { offsetMs: number };

export function resolveBreakDuration(
  config: MidRollConfig,
  random?: { integer(min: number, max: number): number },
): number {
  if (
    config.breakDurationMinMs !== undefined &&
    config.breakDurationMaxMs !== undefined
  ) {
    if (!random) {
      return config.breakDurationMaxMs;
    }
    return random.integer(config.breakDurationMinMs, config.breakDurationMaxMs);
  }

  if (config.breakDurationMs === undefined) {
    throw new Error(
      'MidRollConfig must have either breakDurationMs or breakDurationMinMs/breakDurationMaxMs',
    );
  }

  return config.breakDurationMs;
}

/**
 * Compute candidate break offsets (ms from the start of the program) for a
 * rule that derives its break points purely from the program duration.
 */
function computedRuleOffsets(
  rule: MidRollComputedBreakRule,
  programDurationMs: number,
): number[] {
  switch (rule.type) {
    case 'fixed_interval': {
      const offsets: number[] = [];
      let offset = rule.intervalMs;
      while (offset < programDurationMs) {
        offsets.push(offset);
        offset += rule.intervalMs;
      }
      return offsets;
    }
    case 'percentage': {
      const offsets = rule.points.map((p) =>
        Math.round((programDurationMs * p) / 100),
      );
      offsets.sort((a, b) => a - b);
      return offsets;
    }
    case 'initial_then_interval': {
      const offsets: number[] = [];
      let offset = rule.initialDelayMs;
      while (offset < programDurationMs) {
        offsets.push(offset);
        offset += rule.intervalMs;
      }
      return offsets;
    }
  }
}

/**
 * Filter a sorted list of offsets so that no two are closer together than
 * `minSpacingMs`. Greedily keeps the earliest of any cluster.
 */
function enforceMinSpacing(offsets: number[], minSpacingMs: number): number[] {
  if (minSpacingMs <= 0) return [...offsets].sort((a, b) => a - b);
  const sorted = [...offsets].sort((a, b) => a - b);
  const result: number[] = [];
  let last = -Infinity;
  for (const offset of sorted) {
    if (offset - last >= minSpacingMs) {
      result.push(offset);
      last = offset;
    }
  }
  return result;
}

/**
 * Compute break offsets for the `detected` break rule using the program's
 * detected break points. Falls back to a computed rule when the program has no
 * detected break points.
 */
function detectedRuleOffsets(
  rule: Extract<MidRollBreakRule, { type: 'detected' }>,
  programDurationMs: number,
  detectedOffsetsMs: readonly number[] | undefined,
): number[] {
  const detected = (detectedOffsetsMs ?? []).filter(
    (offset) => offset > 0 && offset < programDurationMs,
  );

  if (detected.length > 0) {
    return enforceMinSpacing(detected, rule.minSpacingMs ?? 0);
  }

  if (rule.fallback) {
    return computedRuleOffsets(rule.fallback, programDurationMs);
  }

  return [];
}

export function resolveBreakPoints(
  programDurationMs: number,
  config: MidRollConfig,
  detectedOffsetsMs?: readonly number[],
): BreakPoint[] | null {
  if (programDurationMs < config.minProgramDurationMs) return null;

  let breakRule: MidRollBreakRule;
  if (config.breakRule) {
    breakRule = config.breakRule;
  } else if (config.intervalMs !== undefined) {
    breakRule = { type: 'fixed_interval', intervalMs: config.intervalMs };
  } else {
    throw new Error(
      'MidRollConfig must have either breakRule or intervalMs when enabled',
    );
  }

  let offsets: number[];
  if (breakRule.type === 'detected') {
    offsets = detectedRuleOffsets(
      breakRule,
      programDurationMs,
      detectedOffsetsMs,
    );
  } else {
    offsets = computedRuleOffsets(breakRule, programDurationMs);
  }

  // Use max of range for conservative filtering
  const breakDuration = resolveBreakDuration(config);
  const tailBuffer = config.tailBufferMs ?? 0;

  offsets = offsets.filter(
    (offset) => programDurationMs - offset - breakDuration >= tailBuffer,
  );

  if (config.maxBreaks > 0) {
    offsets = offsets.slice(0, config.maxBreaks);
  }

  if (offsets.length === 0) return null;

  return offsets.map((offsetMs) => ({ offsetMs }));
}
