import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import { Result } from '@/types/result.js';
import type { AdBreakDetectionConfig } from '@tunarr/types/api';
import { spawn } from 'node:child_process';

/**
 * A closed time interval (in seconds) of detected black video or silent audio.
 */
export type TimeInterval = {
  startSec: number;
  endSec: number;
};

const BLACK_LINE_RE =
  /black_start:(?<start>[0-9.]+)\s+black_end:(?<end>[0-9.]+)/;
const SILENCE_START_RE = /silence_start:\s*(?<start>-?[0-9.]+)/;
const SILENCE_END_RE = /silence_end:\s*(?<end>-?[0-9.]+)/;

/**
 * Parse the `blackdetect` lines emitted by ffmpeg on stderr into time
 * intervals. Lines look like:
 *   [blackdetect @ 0x..] black_start:12.34 black_end:15.67 black_duration:3.33
 */
export function parseBlackDetectOutput(output: string): TimeInterval[] {
  const intervals: TimeInterval[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = BLACK_LINE_RE.exec(line);
    if (!match?.groups) {
      continue;
    }
    const startSec = parseFloat(match.groups['start']!);
    const endSec = parseFloat(match.groups['end']!);
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
      intervals.push({ startSec, endSec });
    }
  }
  return intervals;
}

/**
 * Parse the `silencedetect` lines emitted by ffmpeg on stderr into time
 * intervals. silencedetect emits separate start and end lines:
 *   [silencedetect @ 0x..] silence_start: 12.0
 *   [silencedetect @ 0x..] silence_end: 15.0 | silence_duration: 3.0
 * A trailing silence_start without a matching end (silence to EOF) is ignored
 * since it can't bound a mid-program break.
 */
export function parseSilenceDetectOutput(output: string): TimeInterval[] {
  const intervals: TimeInterval[] = [];
  let pendingStart: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    const startMatch = SILENCE_START_RE.exec(line);
    if (startMatch?.groups) {
      pendingStart = parseFloat(startMatch.groups['start']!);
      continue;
    }
    const endMatch = SILENCE_END_RE.exec(line);
    if (endMatch?.groups && pendingStart !== undefined) {
      const endSec = parseFloat(endMatch.groups['end']!);
      if (Number.isFinite(endSec) && endSec > pendingStart) {
        intervals.push({ startSec: pendingStart, endSec });
      }
      pendingStart = undefined;
    }
  }
  return intervals;
}

function intervalsOverlap(a: TimeInterval, b: TimeInterval): boolean {
  return a.startSec < b.endSec && b.startSec < a.endSec;
}

export type ComputeAdBreakOptions = {
  requireSilence: boolean;
  minBreakSpacingMs: number;
};

/**
 * Combine detected black and silence intervals into a sorted list of break
 * point offsets (ms from the start of the program). Each break point is placed
 * at the midpoint of a qualifying black interval. When `requireSilence` is set,
 * a black interval only qualifies if it overlaps a silent interval. Breaks
 * closer together than `minBreakSpacingMs` are collapsed, keeping the earliest.
 */
export function computeAdBreakOffsetsMs(
  blackIntervals: TimeInterval[],
  silenceIntervals: TimeInterval[],
  options: ComputeAdBreakOptions,
): number[] {
  const qualifying = blackIntervals.filter((black) => {
    if (!options.requireSilence) {
      return true;
    }
    return silenceIntervals.some((silence) =>
      intervalsOverlap(black, silence),
    );
  });

  const offsets = qualifying
    .map((black) => Math.round(((black.startSec + black.endSec) / 2) * 1000))
    .filter((offset) => offset > 0)
    .sort((a, b) => a - b);

  if (options.minBreakSpacingMs <= 0) {
    return offsets;
  }

  const collapsed: number[] = [];
  let last = -Infinity;
  for (const offset of offsets) {
    if (offset - last >= options.minBreakSpacingMs) {
      collapsed.push(offset);
      last = offset;
    }
  }
  return collapsed;
}

/**
 * Runs an offline ffmpeg analysis pass over a media file to detect natural
 * ad-break points (black frames optionally coinciding with silence). This is
 * expensive (it fully decodes the file) and is intended to run during library
 * scanning or as a background task, never live during streaming.
 */
export class AdBreakDetector {
  constructor(private settingsDB: ISettingsDB) {}

  buildArgs(filePath: string, config: AdBreakDetectionConfig): string[] {
    return [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-vf',
      `blackdetect=d=${config.minBlackDurationSec}:pic_th=${config.blackPixelThreshold}`,
      '-af',
      `silencedetect=noise=${config.silenceThresholdDb}dB:d=${config.minSilenceDurationSec}`,
      '-f',
      'null',
      '-',
    ];
  }

  async detect(
    filePath: string,
    config: AdBreakDetectionConfig,
  ): Promise<Result<number[]>> {
    const ffmpegPath = this.settingsDB.ffmpegSettings().ffmpegExecutablePath;
    const args = this.buildArgs(filePath, config);

    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    proc.stderr.setEncoding('utf-8');
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    return new Promise<Result<number[]>>((resolve) => {
      proc.on('error', (err) => {
        resolve(Result.failure(err.message));
      });
      proc.on('close', () => {
        resolve(
          Result.attempt(() => {
            const black = parseBlackDetectOutput(stderr);
            const silence = parseSilenceDetectOutput(stderr);
            return computeAdBreakOffsetsMs(black, silence, {
              requireSilence: config.requireSilence,
              minBreakSpacingMs: config.minBreakSpacingMs,
            });
          }),
        );
      });
    });
  }
}
