import { z } from 'zod';

export const footballPositions = [
  'Goalkeeper',
  'Defender',
  'Midfielder',
  'Forward',
] as const;

export const FootballPositionSchema = z.enum(footballPositions);
export type FootballPosition = z.infer<typeof FootballPositionSchema>;

export const HistoricalMarketWindowSchema = z.union([
  z.literal(10),
  z.literal(15),
  z.literal(40),
]);
export type HistoricalMarketWindow = z.infer<
  typeof HistoricalMarketWindowSchema
>;

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
    playerTeams: z
      .record(
        z.string(),
        z.string().trim().min(1).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
      )
      .optional(),
    includeHistoricalAssists: z.boolean().default(false),
    // Capability handshake for rollout safety. Older extension versions reject
    // the `formHistory` refresh hint, so the backend may only return an early
    // partial form window when the caller opts in explicitly.
    supportsPartialFormHistory: z.boolean().default(false),
    // Follow-up reads may hydrate a missing/expired fixture synchronously.
    // The initial request remains fast and can return cached L10 form values
    // with `pendingRefreshes: ['fixture']`.
    refreshFixtures: z.boolean().default(false),
    // Extension follow-ups for a known bookmaker warmup only observe the
    // shared snapshot cache. They must never start another provider request.
    oddsCacheOnly: z.boolean().default(false),
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

export const LineupSortValuesRequestSchema = z
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
    playerTeams: z
      .record(
        z.string(),
        z.string().trim().min(1).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
      )
      .optional(),
    historicalGoalWindow: HistoricalMarketWindowSchema.nullable().default(null),
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

export type LineupSortValuesRequest = z.input<
  typeof LineupSortValuesRequestSchema
>;
export type ValidatedLineupSortValuesRequest = z.output<
  typeof LineupSortValuesRequestSchema
>;

export const MetricSchema = z.object({
  value: z.number().finite().nullable(),
  sampleSize: z.number().int().nonnegative(),
});

export const PerformanceToneSchema = z.enum([
  'very-low',
  'low',
  'balanced',
  'good',
  'strong',
  'elite',
]);

export const MlsAaContextSchema = z.object({
  asOf: z.string().date(),
  tone: PerformanceToneSchema.nullable(),
  percentileBand: z
    .enum(['P0–20', 'P20–40', 'P40–60', 'P60–80', 'P80–90', 'P90–100'])
    .nullable(),
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable(),
});

export const HistoricalAssistMetricsSchema = z.object({
  l10: MetricSchema,
  l15: MetricSchema,
  l40: MetricSchema,
});

export const MatchProbabilitiesSchema = z.object({
  win: z.number().min(0).max(1).nullable(),
  draw: z.number().min(0).max(1).nullable(),
  loss: z.number().min(0).max(1).nullable(),
});

export const BookmakerMarketQuoteSchema = z.object({
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  decimalOdds: z.number().finite().gt(1),
  probability: z.number().min(0).max(1),
  // Optional provider provenance keeps parser decisions auditable without
  // invalidating snapshots captured before the fields existed.
  providerMarketName: z.string().trim().min(1).max(200).optional(),
  providerSelectionLabel: z.string().trim().min(1).max(300).optional(),
});

export const MarketProbabilitySchema = z.object({
  probability: z.number().min(0).max(1),
  bookmakerCount: z.number().int().positive(),
  // Optional so immutable market-odds:v1 snapshots captured before individual
  // bookmaker details were introduced remain readable and can be enriched once.
  bookmakerQuotes: z.array(BookmakerMarketQuoteSchema).min(1).optional(),
});

export const PlayerMarketOddsSchema = z.object({
  source: z.enum([
    'the-odds-api',
    'odds-api-io',
    'sports-game-odds',
    'mixed',
    'mock',
  ]),
  capturedAt: z.string().datetime(),
  goal: MarketProbabilitySchema.nullable(),
  assist: MarketProbabilitySchema.nullable(),
  // Optional so responses and cached fixtures created before the direct
  // goals+assists market was introduced remain valid.
  decisive: MarketProbabilitySchema.nullable().optional(),
});

export const PlayerStatsSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  position: FootballPositionSchema,
  aaL10: MetricSchema,
  // Player- and card-position-specific team win rate over exactly the
  // appearances used by aaL10. Optional keeps old extension responses and
  // form cache entries backwards compatible during lazy enrichment.
  aaL10TeamWinRate: MetricSchema.optional(),
  // Response-only league comparison. It is supplied from the weekly backend
  // snapshot and deliberately kept out of the per-player form cache.
  mlsAaContext: MlsAaContextSchema.optional(),
  cleanSheetL10: MetricSchema,
  goalL10: MetricSchema,
  // Optional so existing cached player-form entries remain readable. The
  // backend only hydrates these windows when the extension explicitly enables
  // the historical market fallback.
  historicalGoals: HistoricalAssistMetricsSchema.optional(),
  historicalAssists: HistoricalAssistMetricsSchema.optional(),
  historicalDecisives: HistoricalAssistMetricsSchema.optional(),
  nextGame: z
    .object({
      date: z.string().datetime(),
      // Optional while existing fixture cache entries migrate lazily.
      // New responses use the stable Sorare competition slug to decide
      // whether a bookmaker provider supports this fixture.
      competitionSlug: z.string().trim().min(1).nullable().optional(),
      // Optional for backwards compatibility with fixture:v1 KV entries
      // written before team names were added to the response contract.
      homeTeamName: z.string().trim().min(1).nullable().optional(),
      awayTeamName: z.string().trim().min(1).nullable().optional(),
      // Canonical Sorare identities used internally for provider-fixture
      // resolution. Optional keeps legacy fixture cache entries readable.
      homeTeamSlug: z
        .string()
        .trim()
        .min(1)
        .max(180)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
        .optional(),
      awayTeamSlug: z
        .string()
        .trim()
        .min(1)
        .max(180)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
        .optional(),
      // Player-relative names keep W/D/L labels unambiguous for away players.
      // They remain optional while older fixture:v1 entries migrate lazily.
      playerTeamName: z.string().trim().min(1).nullable().optional(),
      opponentTeamName: z.string().trim().min(1).nullable().optional(),
      // Canonical identity of the player's side in this fixture. This is
      // server-derived from Sorare team ids and never trusted from the client.
      playerTeamSlug: z
        .string()
        .trim()
        .min(1)
        .max(180)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
        .optional(),
      cleanSheetProbability: z.number().min(0).max(1).nullable(),
      matchProbabilities: MatchProbabilitiesSchema.nullable(),
      // Added after the split player/fixture caches. Optional lets old KV
      // entries parse; the API response hydrates it from the dedicated
      // immutable market snapshot store on every request.
      marketOdds: PlayerMarketOddsSchema.nullable().optional(),
    })
    .nullable(),
  // Response-only hint. Cache implementations deliberately omit this field.
  // The extension uses it for a small number of follow-up reads while the
  // Worker refreshes form history, fixtures or player-prop snapshots in the
  // background. `formHistory` always denotes an intentionally partial form
  // response which must never be persisted as the normal weekly L10 value.
  pendingRefreshes: z
    .array(z.enum(['formHistory', 'fixture', 'marketOdds']))
    .min(1)
    .optional(),
  excludedLowCoverage: z.number().int().nonnegative(),
});

export type Metric = z.infer<typeof MetricSchema>;
export type MlsAaContext = z.infer<typeof MlsAaContextSchema>;
export type HistoricalAssistMetrics = z.infer<
  typeof HistoricalAssistMetricsSchema
>;
export type MatchProbabilities = z.infer<typeof MatchProbabilitiesSchema>;
export type BookmakerMarketQuote = z.infer<typeof BookmakerMarketQuoteSchema>;
export type MarketProbability = z.infer<typeof MarketProbabilitySchema>;
export type PlayerMarketOdds = z.infer<typeof PlayerMarketOddsSchema>;
export type PlayerStats = z.infer<typeof PlayerStatsSchema>;

export const PlayerStatsSuccessResponseSchema = z.object({
  data: z.array(PlayerStatsSchema),
  meta: z.object({
    requested: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
    source: z.enum(['sorare', 'mock']),
    // Cold gallery names may be resolved and warmed after the response. The
    // extension keeps only these cards in loading state and retries them.
    deferredPlayerNames: z.array(z.string().trim().min(2).max(120)).optional(),
    deferredPlayerSlugs: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(160)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
      )
      .optional(),
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

// A market follow-up already has canonical player and fixture data from the
// preceding player-stats response. Sending that compact context back avoids a
// second form/fixture lookup while the backend only reads immutable provider
// snapshots. The endpoint using this contract must stay cache-only.
export const PlayerMarketSnapshotTargetSchema = PlayerStatsSchema.pick({
  slug: true,
  displayName: true,
  position: true,
  nextGame: true,
});

export const PlayerMarketSnapshotsRequestSchema = z.object({
  players: z.array(PlayerMarketSnapshotTargetSchema).min(1).max(50),
});

export const PlayerMarketRefreshStateSchema = z.enum([
  'pending',
  'settled',
  'unsupported',
]);

export const PlayerMarketSnapshotSchema = z.object({
  slug: z.string(),
  position: FootballPositionSchema,
  fixture: z
    .object({
      date: z.string().datetime(),
      homeTeamSlug: z.string().trim().min(1).max(180).optional(),
      awayTeamSlug: z.string().trim().min(1).max(180).optional(),
      playerTeamSlug: z.string().trim().min(1).max(180).optional(),
    })
    .nullable(),
  marketOdds: PlayerMarketOddsSchema.nullable(),
  refreshState: PlayerMarketRefreshStateSchema,
});

export const PlayerMarketSnapshotsSuccessResponseSchema = z.object({
  data: z.array(PlayerMarketSnapshotSchema),
  meta: z.object({
    requested: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    source: z.enum(['sorare', 'mock']),
    durationMs: z.number().nonnegative(),
  }),
});

export type PlayerMarketSnapshotTarget = z.infer<
  typeof PlayerMarketSnapshotTargetSchema
>;
export type PlayerMarketSnapshotsRequest = z.input<
  typeof PlayerMarketSnapshotsRequestSchema
>;
export type ValidatedPlayerMarketSnapshotsRequest = z.output<
  typeof PlayerMarketSnapshotsRequestSchema
>;
export type PlayerMarketRefreshState = z.infer<
  typeof PlayerMarketRefreshStateSchema
>;
export type PlayerMarketSnapshot = z.infer<typeof PlayerMarketSnapshotSchema>;
export type PlayerMarketSnapshotsSuccessResponse = z.infer<
  typeof PlayerMarketSnapshotsSuccessResponseSchema
>;

export const LineupSortValueSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  position: FootballPositionSchema,
  goal: z
    .object({
      probability: z.number().min(0).max(1),
      source: z.enum(['market', 'historical']),
    })
    .nullable(),
  aa: z.number().finite().nullable(),
});

export const LineupSortValuesSuccessResponseSchema = z.object({
  data: z.array(LineupSortValueSchema),
  meta: z.object({
    requested: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
    source: z.enum(['sorare', 'mock']),
    durationMs: z.number().nonnegative(),
    deferredPlayerNames: z.array(z.string().trim().min(2).max(120)).optional(),
    deferredPlayerSlugs: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(160)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
      )
      .optional(),
  }),
});

export type LineupSortValue = z.infer<typeof LineupSortValueSchema>;
export type LineupSortValuesSuccessResponse = z.infer<
  typeof LineupSortValuesSuccessResponseSchema
>;

export const PlayerStatsApiResponseSchema = z.union([
  PlayerStatsSuccessResponseSchema,
  ApiErrorResponseSchema,
]);

export type PlayerStatsApiResponse = z.infer<typeof PlayerStatsApiResponseSchema>;
