import { z } from 'zod';

export const footballPositions = [
  'Goalkeeper',
  'Defender',
  'Midfielder',
  'Forward',
] as const;

export const FootballPositionSchema = z.enum(footballPositions);
export type FootballPosition = z.infer<typeof FootballPositionSchema>;

export const PlayerStatsRequestSchema = z
  .object({
    slugs: z
    .array(z.string().trim().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i))
    .max(50)
      .default([])
      .transform((slugs) => [...new Set(slugs.map((slug) => slug.toLowerCase()))]),
    playerNames: z
      .array(z.string().trim().min(2).max(120))
      .max(50)
      .default([])
      .transform((names) => [
        ...new Map(names.map((name) => [name.toLocaleLowerCase(), name.trim()])).values(),
      ]),
    positions: z.record(z.string(), FootballPositionSchema).optional(),
  })
  .superRefine((request, context) => {
    const total = request.slugs.length + request.playerNames.length;
    if (total < 1) {
      context.addIssue({ code: 'custom', message: 'At least one slug or player name is required' });
    }
    if (total > 50) {
      context.addIssue({ code: 'custom', message: 'At most 50 players are allowed' });
    }
  });

export type PlayerStatsRequest = z.input<typeof PlayerStatsRequestSchema>;
export type ValidatedPlayerStatsRequest = z.output<typeof PlayerStatsRequestSchema>;

export const MetricSchema = z.object({
  value: z.number().finite().nullable(),
  sampleSize: z.number().int().nonnegative(),
});

export const MatchProbabilitiesSchema = z.object({
  win: z.number().min(0).max(1).nullable(),
  draw: z.number().min(0).max(1).nullable(),
  loss: z.number().min(0).max(1).nullable(),
});

export const PlayerStatsSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  position: FootballPositionSchema,
  aaL10: MetricSchema,
  cleanSheetL10: MetricSchema,
  goalL10: MetricSchema,
  nextGame: z
    .object({
      date: z.string().datetime(),
      // Optional for backwards compatibility with fixture:v1 KV entries
      // written before team names were added to the response contract.
      homeTeamName: z.string().trim().min(1).nullable().optional(),
      awayTeamName: z.string().trim().min(1).nullable().optional(),
      // Player-relative names keep W/D/L labels unambiguous for away players.
      // They remain optional while older fixture:v1 entries migrate lazily.
      playerTeamName: z.string().trim().min(1).nullable().optional(),
      opponentTeamName: z.string().trim().min(1).nullable().optional(),
      cleanSheetProbability: z.number().min(0).max(1).nullable(),
      matchProbabilities: MatchProbabilitiesSchema.nullable(),
    })
    .nullable(),
  excludedLowCoverage: z.number().int().nonnegative(),
});

export type Metric = z.infer<typeof MetricSchema>;
export type MatchProbabilities = z.infer<typeof MatchProbabilitiesSchema>;
export type PlayerStats = z.infer<typeof PlayerStatsSchema>;

export const PlayerStatsSuccessResponseSchema = z.object({
  data: z.array(PlayerStatsSchema),
  meta: z.object({
    requested: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
    source: z.enum(['sorare', 'mock']),
  }),
});

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});

export type PlayerStatsSuccessResponse = z.infer<typeof PlayerStatsSuccessResponseSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const PlayerStatsApiResponseSchema = z.union([
  PlayerStatsSuccessResponseSchema,
  ApiErrorResponseSchema,
]);

export type PlayerStatsApiResponse = z.infer<typeof PlayerStatsApiResponseSchema>;
