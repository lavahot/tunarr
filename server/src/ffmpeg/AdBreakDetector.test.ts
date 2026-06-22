import { describe, expect, it } from 'vitest';
import {
  computeAdBreakOffsetsMs,
  parseBlackDetectOutput,
  parseSilenceDetectOutput,
} from './AdBreakDetector.ts';

const blackOutput = `
ffmpeg version n6.0
[blackdetect @ 0x55] black_start:60.0 black_end:63.5 black_duration:3.5
frame=  100 fps=0.0 q=-0.0 size=N/A
[blackdetect @ 0x55] black_start:600.2 black_end:603.0 black_duration:2.8
[blackdetect @ 0x55] black_start:900 black_end:902 black_duration:2
`;

const silenceOutput = `
[silencedetect @ 0x77] silence_start: 59.8
[silencedetect @ 0x77] silence_end: 63.7 | silence_duration: 3.9
[silencedetect @ 0x77] silence_start: 601.0
[silencedetect @ 0x77] silence_end: 603.5 | silence_duration: 2.5
[silencedetect @ 0x77] silence_start: 1200.0
`;

describe('parseBlackDetectOutput', () => {
  it('parses all black intervals', () => {
    const result = parseBlackDetectOutput(blackOutput);
    expect(result).toEqual([
      { startSec: 60.0, endSec: 63.5 },
      { startSec: 600.2, endSec: 603.0 },
      { startSec: 900, endSec: 902 },
    ]);
  });

  it('returns empty for output with no black lines', () => {
    expect(parseBlackDetectOutput('no matches here')).toEqual([]);
  });
});

describe('parseSilenceDetectOutput', () => {
  it('pairs start and end lines into intervals', () => {
    const result = parseSilenceDetectOutput(silenceOutput);
    expect(result).toEqual([
      { startSec: 59.8, endSec: 63.7 },
      { startSec: 601.0, endSec: 603.5 },
    ]);
  });

  it('ignores a trailing silence_start with no matching end', () => {
    const result = parseSilenceDetectOutput(
      '[silencedetect @ 0x] silence_start: 5.0',
    );
    expect(result).toEqual([]);
  });
});

describe('computeAdBreakOffsetsMs', () => {
  const black = parseBlackDetectOutput(blackOutput);
  const silence = parseSilenceDetectOutput(silenceOutput);

  it('places breaks at the midpoint of black intervals overlapping silence', () => {
    const result = computeAdBreakOffsetsMs(black, silence, {
      requireSilence: true,
      minBreakSpacingMs: 0,
    });
    // 60-63.5 -> 61.75s, 600.2-603 -> 601.6s. 900-902 has no silence overlap.
    expect(result).toEqual([61750, 601600]);
  });

  it('includes all black intervals when silence is not required', () => {
    const result = computeAdBreakOffsetsMs(black, silence, {
      requireSilence: false,
      minBreakSpacingMs: 0,
    });
    expect(result).toEqual([61750, 601600, 901000]);
  });

  it('collapses breaks closer than the minimum spacing', () => {
    const closeBlack = [
      { startSec: 60, endSec: 62 },
      { startSec: 120, endSec: 122 },
      { startSec: 600, endSec: 602 },
    ];
    const result = computeAdBreakOffsetsMs(closeBlack, [], {
      requireSilence: false,
      minBreakSpacingMs: 5 * 60 * 1000,
    });
    // 61s kept, 121s dropped (within 5 min of 61s), 601s kept.
    expect(result).toEqual([61000, 601000]);
  });

  it('returns empty when nothing qualifies', () => {
    expect(
      computeAdBreakOffsetsMs([], [], {
        requireSilence: true,
        minBreakSpacingMs: 0,
      }),
    ).toEqual([]);
  });
});
