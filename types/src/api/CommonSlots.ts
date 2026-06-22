import { z } from 'zod';

export const SlotProgrammingOrderSchema = z.enum([
  'next',
  'shuffle',
  'ordered_shuffle',
  'alphanumeric',
  'chronological',
]);

export const SlotProgrammingFillerOrder = z.enum([
  'shuffle_prefer_short',
  'shuffle_prefer_long',
  'uniform',
]);

export const BaseSlotOrdering = z.object({
  order: SlotProgrammingOrderSchema,
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export const SlotFillerTypes = z.enum([
  'head',
  'pre',
  'post',
  'tail',
  'fallback',
  'mid',
]);

export type SlotFillerTypes = z.infer<typeof SlotFillerTypes>;

export const SlotFiller = z.object({
  types: z.array(SlotFillerTypes).nonempty(),
  fillerListId: z.uuid(),
  fillerOrder: SlotProgrammingFillerOrder.optional().default(
    'shuffle_prefer_short',
  ),
});

export type SlotFiller = z.infer<typeof SlotFiller>;

/**
 * Break rules that compute break offsets purely from the program's duration,
 * without relying on any detected/persisted markers. These may be used on their
 * own or as a fallback for the `detected` rule when a program has no detected
 * break points.
 */
export const MidRollComputedBreakRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('fixed_interval'),
    intervalMs: z.number().positive(),
  }),
  z.object({
    type: z.literal('percentage'),
    points: z.array(z.number().gt(0).lt(100)).nonempty(),
  }),
  z.object({
    type: z.literal('initial_then_interval'),
    initialDelayMs: z.number().positive(),
    intervalMs: z.number().positive(),
  }),
]);

export type MidRollComputedBreakRule = z.infer<
  typeof MidRollComputedBreakRuleSchema
>;

export const MidRollBreakRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('fixed_interval'),
    intervalMs: z.number().positive(),
  }),
  z.object({
    type: z.literal('percentage'),
    points: z.array(z.number().gt(0).lt(100)).nonempty(),
  }),
  z.object({
    type: z.literal('initial_then_interval'),
    initialDelayMs: z.number().positive(),
    intervalMs: z.number().positive(),
  }),
  // V3 break rule. Places breaks at break points detected offline from the
  // program's media (e.g. black frames + silence). When a program has no
  // detected break points, `fallback` (if set) is used to compute them from the
  // program duration instead.
  z.object({
    type: z.literal('detected'),
    // Drop detected break points that are closer together than this. Helps
    // collapse a cluster of black frames into a single break.
    minSpacingMs: z.number().positive().optional(),
    fallback: MidRollComputedBreakRuleSchema.optional(),
  }),
]);

export type MidRollBreakRule = z.infer<typeof MidRollBreakRuleSchema>;

export const MidRollConfigSchema = z
  .object({
    // V1 simple field (kept for backward compat; ignored when breakRule is set)
    intervalMs: z.number().positive().optional(),
    // V2 structured break rule. Falls back to fixed_interval(intervalMs) if absent.
    breakRule: MidRollBreakRuleSchema.optional(),
    maxBreaks: z.number().int().nonnegative(),
    minProgramDurationMs: z.number().nonnegative(),
    tailBufferMs: z.number().nonnegative().default(0),
    // Fixed duration (V1). Used when min/max are not set.
    breakDurationMs: z.number().positive().optional(),
    // Duration range (V2). System picks a random duration in [min, max] per break.
    breakDurationMinMs: z.number().positive().optional(),
    breakDurationMaxMs: z.number().positive().optional(),
    programTypes: z
      .array(
        z.enum(['movie', 'episode', 'track', 'music_video', 'other_video']),
      )
      .optional(),
    // 'eager' = resolve filler at schedule time (V1 behavior)
    // 'lazy'  = emit offline placeholders, resolve at stream time
    strategy: z.enum(['eager', 'lazy']).default('eager'),
  })
  .refine(
    (data) => {
      return data.intervalMs !== undefined || data.breakRule !== undefined;
    },
    { message: 'Either intervalMs or breakRule must be set' },
  )
  .refine(
    (data) => {
      if (
        data.breakDurationMinMs !== undefined ||
        data.breakDurationMaxMs !== undefined
      ) {
        return (
          data.breakDurationMinMs !== undefined &&
          data.breakDurationMaxMs !== undefined &&
          data.breakDurationMaxMs >= data.breakDurationMinMs
        );
      }
      return true;
    },
    {
      message:
        'breakDurationMinMs and breakDurationMaxMs must both be set, and max >= min',
    },
  )
  .refine(
    (data) => {
      return (
        data.breakDurationMs !== undefined ||
        (data.breakDurationMinMs !== undefined &&
          data.breakDurationMaxMs !== undefined)
      );
    },
    {
      message:
        'At least one of breakDurationMs or breakDurationMinMs/breakDurationMaxMs must be set',
    },
  );

export type MidRollConfig = z.infer<typeof MidRollConfigSchema>;

/**
 * Thresholds for the offline ad-break detection pass. Detection runs ffmpeg
 * `blackdetect` (and optionally `silencedetect`) over a program's media and
 * persists the resulting break points so the `detected` mid-roll break rule can
 * place flex breaks where TV stations would naturally cut to advertisements.
 */
export const AdBreakDetectionConfigSchema = z.object({
  // Minimum duration (seconds) a sequence of black frames must last to count as
  // a candidate break. Maps to ffmpeg blackdetect `d`.
  minBlackDurationSec: z.number().positive().default(0.5),
  // Black-pixel threshold for blackdetect `pic_th` (0-1).
  blackPixelThreshold: z.number().gt(0).lte(1).default(0.98),
  // When true, a black segment must overlap a silent segment to be considered a
  // real break (reduces false positives from fades within the program).
  requireSilence: z.boolean().default(true),
  // Noise floor (dB) below which audio is considered silent. Maps to ffmpeg
  // silencedetect `noise`. Typically a negative value such as -30.
  silenceThresholdDb: z.number().default(-30),
  // Minimum duration (seconds) of silence to count. Maps to silencedetect `d`.
  minSilenceDurationSec: z.number().positive().default(0.3),
  // Collapse detected break points that are closer than this many ms.
  minBreakSpacingMs: z.number().nonnegative().default(5 * 60 * 1000),
});

export type AdBreakDetectionConfig = z.infer<
  typeof AdBreakDetectionConfigSchema
>;

export const LinkableSlot = z.object({
  id: z.uuid(),
  iterationGroup: z.uuid().optional(),
  linkMode: z.enum(['continue', 'rerun']).default('continue').optional(),
  rerunOverflow: z.enum(['flex', 'continue']).default('flex').optional(),
});

export type LinkableSlot = z.infer<typeof LinkableSlot>;

export const SlotWithFiller = z.object({
  filler: z.array(SlotFiller).optional(),
  midRoll: MidRollConfigSchema.optional(),
});

export type SlotWithFiller = z.infer<typeof SlotWithFiller>;

export const Slot = z.object({
  ...LinkableSlot.shape,
  ...SlotWithFiller.shape,
});

//
// Base slots
//

export const MovieProgrammingSlotSchema = z.object({
  type: z.literal('movie'),
  ...BaseSlotOrdering.shape,
  ...Slot.shape,
});

export type BaseMovieProgrammingSlot = z.infer<
  typeof MovieProgrammingSlotSchema
>;

export const ShowProgrammingSlotSchema = z.object({
  type: z.literal('show'),
  showId: z.string(),
  seasonFilter: z.number().array().default([]).catch([]),
  seasonExcludeFilter: z.number().array().default([]).catch([]),
  ...BaseSlotOrdering.shape,
  ...Slot.shape,
});

export type BaseShowProgrammingSlot = z.infer<typeof ShowProgrammingSlotSchema>;

export const FlexProgrammingSlotSchema = z.object({
  type: z.literal('flex'),
});

export const RedirectProgrammingSlotSchema = z.object({
  type: z.literal('redirect'),
  channelId: z.string(),
  channelName: z.string().optional(),
});

export const CustomShowProgrammingSlotSchema = z.object({
  type: z.literal('custom-show'),
  customShowId: z.uuid(),
  ...BaseSlotOrdering.shape,
  ...Slot.shape,
});

export type BaseCustomShowProgrammingSlot = z.infer<
  typeof CustomShowProgrammingSlotSchema
>;

export const FillerProgrammingSlotSchema = z.object({
  ...Slot.shape,
  type: z.literal('filler'),
  fillerListId: z.uuid(),
  order: SlotProgrammingFillerOrder,
  durationWeighting: z.enum(['linear', 'log']),
  decayFactor: z.number().gte(0).lt(1),
  recoveryFactor: z.number().gte(0).lt(1),
});

export type FillerProgrammingSlot = z.infer<typeof FillerProgrammingSlotSchema>;

export const SmartCollectionProgrammingSlot = z.object({
  type: z.literal('smart-collection'),
  smartCollectionId: z.uuid(),
  ...BaseSlotOrdering.shape,
  ...Slot.shape,
});

export const BaseSlotSchema = z.discriminatedUnion('type', [
  MovieProgrammingSlotSchema,
  ShowProgrammingSlotSchema,
  FlexProgrammingSlotSchema,
  RedirectProgrammingSlotSchema,
  CustomShowProgrammingSlotSchema,
  FillerProgrammingSlotSchema,
  SmartCollectionProgrammingSlot,
]);

export type BaseSlot = z.infer<typeof BaseSlotSchema>;

export type LinkableBaseSlot = Extract<
  BaseSlot,
  { type: 'movie' | 'show' | 'custom-show' | 'smart-collection' }
>;

export type BaseSlotWithFiller = Extract<
  BaseSlot,
  { type: 'movie' | 'show' | 'custom-show' | 'smart-collection' }
>;

export function slotIsLinkable(
  slotType: BaseSlot['type'],
): slotType is LinkableBaseSlot['type'];
export function slotIsLinkable(slot: BaseSlot): slot is LinkableBaseSlot;
export function slotIsLinkable(slot: BaseSlot | BaseSlot['type']): boolean {
  const type = typeof slot === 'string' ? slot : slot.type;
  switch (type) {
    case 'custom-show':
    case 'movie':
    case 'show':
    case 'smart-collection':
      return true;
    case 'flex':
    case 'redirect':
    case 'filler':
      return false;
  }
}

export function slotHasFiller(slot: BaseSlot): slot is BaseSlotWithFiller {
  switch (slot.type) {
    case 'custom-show':
    case 'movie':
    case 'show':
    case 'smart-collection':
      return true;
    case 'flex':
    case 'redirect':
    case 'filler':
      return false;
  }
}
