import {
  AdBreakDetectionConfigSchema,
  type AdBreakDetectionConfig,
} from '@tunarr/types/api';
import { inject, injectable } from 'inversify';
import { z } from 'zod';
import { IProgramDB } from '../db/interfaces/IProgramDB.ts';
import { ISettingsDB } from '../db/interfaces/ISettingsDB.ts';
import { AdBreakDetector } from '../ffmpeg/AdBreakDetector.ts';
import { KEYS } from '../types/inject.ts';
import { fileExists } from '../util/fsUtil.ts';
import { InjectLogger } from '../util/inject.ts';
import { Logger } from '../util/logging/LoggerFactory.ts';
import { Task2 } from './Task.ts';
import { taskDef } from './TaskRegistry.ts';

export const DetectAdBreaksTaskRequest = z
  .object({
    // Limit detection to specific programs. When omitted, all programs with a
    // resolvable local file are analyzed.
    programIds: z.array(z.string()).optional(),
    // Detection thresholds. Defaults are applied by the schema when omitted.
    detection: AdBreakDetectionConfigSchema.optional(),
  })
  .optional();

export type DetectAdBreaksTaskRequest = z.infer<
  typeof DetectAdBreaksTaskRequest
>;

/**
 * Offline task that scans programs for natural ad-break points (black frames
 * coinciding with silence) using ffmpeg and persists them as `ad_break`
 * program chapters. These are later consumed by the `detected` mid-roll break
 * rule to insert flex/filler where TV stations would cut to advertisements.
 *
 * Detection fully decodes each file and is therefore expensive; it is intended
 * to run as a background task, never live during streaming.
 */
@injectable()
@taskDef({
  name: DetectAdBreaksTask.name,
  description:
    'Detects natural ad-break points (black frames + silence) in programs for mid-roll flex insertion.',
  schema: DetectAdBreaksTaskRequest,
})
export class DetectAdBreaksTask extends Task2<typeof DetectAdBreaksTaskRequest> {
  static KEY = Symbol.for(DetectAdBreaksTask.name);
  static ID = DetectAdBreaksTask.name;
  public ID = DetectAdBreaksTask.ID;

  schema = DetectAdBreaksTaskRequest;

  @InjectLogger() declare protected readonly logger: Logger;

  constructor(
    @inject(KEYS.ProgramDB) private programDB: IProgramDB,
    @inject(KEYS.SettingsDB) private settingsDB: ISettingsDB,
  ) {
    super();
  }

  protected async runInternal(
    request?: DetectAdBreaksTaskRequest,
  ): Promise<void> {
    const detectionConfig: AdBreakDetectionConfig =
      request?.detection ?? AdBreakDetectionConfigSchema.parse({});

    const detector = new AdBreakDetector(this.settingsDB);
    const targets = await this.programDB.getProgramsForAdBreakDetection(
      request?.programIds,
    );

    this.logger.debug(
      'Running ad-break detection over %d program(s)',
      targets.length,
    );

    for (const target of targets) {
      if (!(await fileExists(target.filePath))) {
        this.logger.trace(
          'Skipping ad-break detection for program %s, file not found: %s',
          target.programId,
          target.filePath,
        );
        continue;
      }

      const result = await detector.detect(target.filePath, detectionConfig);
      if (result.isFailure()) {
        this.logger.warn(
          result.error,
          'Ad-break detection failed for program %s',
          target.programId,
        );
        continue;
      }

      const offsets = result.get();
      await this.programDB.replaceAdBreakChapters(
        target.programVersionId,
        offsets,
      );
      this.logger.trace(
        'Detected %d ad-break point(s) for program %s',
        offsets.length,
        target.programId,
      );
    }
  }
}
