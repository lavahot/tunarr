import type { ProgramExternalIdType } from '@/db/custom_types/ProgramExternalIdType.js';
import { KEYS } from '@/types/inject.js';
import type { Maybe } from '@/types/util.js';
import { inject, injectable } from 'inversify';
import type { Kysely } from 'kysely';
import { chunk, isEmpty, uniq } from 'lodash-es';
import type { MarkRequired } from 'ts-essentials';
import type { ProgramExternalId } from '../schema/ProgramExternalId.ts';
import { ProgramGroupingType } from '../schema/ProgramGrouping.ts';
import type { DB } from '../schema/db.ts';
import type { ProgramWithRelationsOrm } from '../schema/derivedTypes.ts';
import type { DrizzleDBAccess } from '../schema/index.ts';

@injectable()
export class BasicProgramRepository {
  constructor(
    @inject(KEYS.Database) private db: Kysely<DB>,
    @inject(KEYS.DrizzleDB) private drizzleDB: DrizzleDBAccess,
  ) {}

  async getProgramById(
    id: string,
  ): Promise<Maybe<MarkRequired<ProgramWithRelationsOrm, 'externalIds'>>> {
    return this.drizzleDB.query.program.findFirst({
      where: (fields, { eq }) => eq(fields.uuid, id),
      with: {
        externalIds: true,
        artwork: true,
        subtitles: true,
        credits: true,
        versions: {
          with: {
            mediaStreams: true,
            mediaFiles: true,
            chapters: true,
          },
        },
      },
    });
  }

  async getProgramExternalIds(
    id: string,
    externalIdTypes?: ProgramExternalIdType[],
  ): Promise<ProgramExternalId[]> {
    return await this.db
      .selectFrom('programExternalId')
      .selectAll()
      .where('programExternalId.programUuid', '=', id)
      .$if(!isEmpty(externalIdTypes), (qb) =>
        qb.where('programExternalId.sourceType', 'in', externalIdTypes!),
      )
      .execute();
  }

  async getShowIdFromTitle(title: string): Promise<Maybe<string>> {
    const matchedGrouping = await this.db
      .selectFrom('programGrouping')
      .select('uuid')
      .where('title', '=', title)
      .where('type', '=', ProgramGroupingType.Show)
      .executeTakeFirst();

    return matchedGrouping?.uuid;
  }

  async updateProgramDuration(
    programId: string,
    duration: number,
  ): Promise<void> {
    await this.db
      .updateTable('program')
      .where('uuid', '=', programId)
      .set({
        duration,
      })
      .executeTakeFirst();
  }

  async getProgramsByIds(
    ids: string[] | readonly string[],
    batchSize: number = 500,
  ): Promise<MarkRequired<ProgramWithRelationsOrm, 'externalIds'>[]> {
    const results: MarkRequired<ProgramWithRelationsOrm, 'externalIds'>[] = [];
    for (const idChunk of chunk(uniq(ids), batchSize)) {
      const res = await this.drizzleDB.query.program.findMany({
        where: (fields, { inArray }) => inArray(fields.uuid, idChunk),
        with: {
          album: {
            with: {
              externalIds: true,
              artwork: true,
            },
          },
          artist: {
            with: {
              externalIds: true,
            },
          },
          season: {
            with: {
              externalIds: true,
            },
          },
          show: {
            with: {
              externalIds: true,
              artwork: true,
            },
          },
          externalIds: true,
          artwork: true,
          tags: {
            with: {
              tag: true,
            },
          },
        },
      });
      results.push(...res);
    }
    return results;
  }

  /**
   * Fetch detected ad-break offsets (in ms from the start of the program) for
   * the given program ids. Offsets come from `program_chapter` rows of type
   * `ad_break`, associated via `program_version`. The returned map only
   * contains entries for programs that have at least one detected break.
   */
  async getAdBreakOffsetsByProgramIds(
    ids: string[] | readonly string[],
    batchSize: number = 500,
  ): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    const uniqIds = uniq(ids);
    if (uniqIds.length === 0) {
      return result;
    }

    for (const idChunk of chunk(uniqIds, batchSize)) {
      const versions = await this.drizzleDB.query.programVersion.findMany({
        where: (fields, { inArray }) => inArray(fields.programId, idChunk),
        columns: { programId: true },
        with: {
          chapters: {
            where: (fields, { eq }) => eq(fields.chapterType, 'ad_break'),
            columns: { startTime: true },
          },
        },
      });

      for (const version of versions) {
        if (version.chapters.length === 0) {
          continue;
        }
        const offsets = result.get(version.programId) ?? [];
        for (const chapter of version.chapters) {
          offsets.push(chapter.startTime);
        }
        result.set(version.programId, offsets);
      }
    }

    for (const [programId, offsets] of result) {
      result.set(programId, uniq(offsets).sort((a, b) => a - b));
    }

    return result;
  }


  async filterNonExistentProgramIds(
    programIds: string[],
  ): Promise<Set<string>> {
    const uniqIds = uniq(programIds);
    if (uniqIds.length === 0) {
      return new Set();
    }

    const promises = chunk(programIds, 500).map((programChunk) =>
      this.drizzleDB.query.program.findMany({
        where: (fields, { inArray }) => inArray(fields.uuid, programChunk),
        columns: {
          uuid: true,
        },
      }),
    );

    const allPrograms = await Promise.all(promises);

    return new Set([...allPrograms.flat().map(({ uuid }) => uuid)]);
  }
}
