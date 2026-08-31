import * as z from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}, z.boolean());

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalTtlSeconds = (maximum: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(60).max(maximum).optional(),
  );

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MOCK_MODE: booleanFromEnv.default(true),
  EXCLUDE_LOW_COVERAGE: booleanFromEnv.default(true),
  CACHE_TTL_SECONDS: optionalTtlSeconds(86_400),
  PLAYER_FORM_CACHE_TTL_SECONDS: optionalTtlSeconds(604_800),
  FIXTURE_CACHE_TTL_SECONDS: optionalTtlSeconds(86_400),
  NAME_CACHE_TTL_SECONDS: optionalTtlSeconds(31_536_000),
  NAME_MISS_CACHE_TTL_SECONDS: optionalTtlSeconds(86_400),
  SORARE_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(25),
  SORARE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  SORARE_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  SORARE_GRAPHQL_URL: z.string().url().default('https://api.sorare.com/graphql'),
  SORARE_API_KEY: optionalString,
  SORARE_AUTH_TOKEN: optionalString,
  SORARE_JWT_AUD: optionalString,
  THE_ODDS_API_KEY: optionalString,
  ODDS_API_BASE_URL: z
    .string()
    .url()
    .default('https://api.the-odds-api.com/v4'),
  ODDS_API_SPORT_KEY: z.string().trim().min(1).default('soccer_usa_mls'),
  ODDS_API_REGION: z.string().trim().min(1).default('us'),
  ODDS_API_FALLBACK_REGION: optionalString,
  ODDS_FETCH_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(72),
  MATCH_ODDS_FALLBACK_WINDOW_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .default(72),
  MATCH_ODDS_MISS_CACHE_TTL_SECONDS: optionalTtlSeconds(86_400),
  ODDS_MISS_CACHE_TTL_SECONDS: optionalTtlSeconds(86_400),
  SPORTS_GAME_ODDS_API_KEY: optionalString,
  SPORTS_GAME_ODDS_BASE_URL: z
    .string()
    .url()
    .default('https://api.sportsgameodds.com/v2'),
  SPORTS_GAME_ODDS_LEAGUE_ID: z.string().trim().min(1).default('MLS'),
  ODDS_API_IO_KEY: optionalString,
  ODDS_API_IO_BASE_URL: z
    .string()
    .url()
    .default('https://api.odds-api.io/v3'),
  ODDS_API_IO_LEAGUE: z.string().trim().min(1).default('austria-bundesliga'),
  ODDS_API_IO_BOOKMAKERS: z
    .string()
    .trim()
    .min(1)
    .default('Bet365,Unibet'),
  ODDS_API_IO_DAILY_REQUEST_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(500),
  ODDS_API_IO_HOURLY_REQUEST_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(100),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
});

export interface AppConfig {
  port: number;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  mockMode: boolean;
  excludeLowCoverage: boolean;
  playerFormCacheTtlMs: number;
  fixtureCacheTtlMs: number;
  nameCacheTtlMs: number;
  nameMissCacheTtlMs: number;
  /** @deprecated Use the purpose-specific cache TTL fields. */
  cacheTtlMs: number;
  sorareBatchSize: number;
  requestTimeoutMs: number;
  maxRetries: number;
  graphqlUrl: string;
  apiKey?: string;
  authToken?: string;
  jwtAud?: string;
  oddsApiKey?: string;
  oddsApiBaseUrl: string;
  oddsApiSportKey: string;
  oddsApiRegion: string;
  oddsApiFallbackRegion?: string;
  oddsFetchWindowMs: number;
  matchOddsFallbackWindowMs: number;
  matchOddsMissCacheTtlMs: number;
  oddsMissCacheTtlMs: number;
  sportsGameOddsApiKey?: string;
  sportsGameOddsBaseUrl: string;
  sportsGameOddsLeagueId: string;
  oddsApiIoKey?: string;
  oddsApiIoBaseUrl: string;
  oddsApiIoLeague: string;
  oddsApiIoBookmakers: string[];
  oddsApiIoDailyRequestLimit: number;
  oddsApiIoHourlyRequestLimit: number;
  corsOrigins: string[];
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = EnvSchema.parse(env);
  const legacyCacheTtlSeconds = parsed.CACHE_TTL_SECONDS ?? 604_800;
  const playerFormCacheTtlMs =
    (parsed.PLAYER_FORM_CACHE_TTL_SECONDS ?? legacyCacheTtlSeconds) * 1_000;
  return {
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    mockMode: parsed.MOCK_MODE,
    excludeLowCoverage: parsed.EXCLUDE_LOW_COVERAGE,
    playerFormCacheTtlMs,
    fixtureCacheTtlMs: (parsed.FIXTURE_CACHE_TTL_SECONDS ?? 14_400) * 1_000,
    nameCacheTtlMs: (parsed.NAME_CACHE_TTL_SECONDS ?? 2_592_000) * 1_000,
    nameMissCacheTtlMs: (parsed.NAME_MISS_CACHE_TTL_SECONDS ?? 7_200) * 1_000,
    cacheTtlMs: playerFormCacheTtlMs,
    sorareBatchSize: parsed.SORARE_BATCH_SIZE,
    requestTimeoutMs: parsed.SORARE_REQUEST_TIMEOUT_MS,
    maxRetries: parsed.SORARE_MAX_RETRIES,
    graphqlUrl: parsed.SORARE_GRAPHQL_URL,
    ...(parsed.SORARE_API_KEY ? { apiKey: parsed.SORARE_API_KEY } : {}),
    ...(parsed.SORARE_AUTH_TOKEN ? { authToken: parsed.SORARE_AUTH_TOKEN } : {}),
    ...(parsed.SORARE_JWT_AUD ? { jwtAud: parsed.SORARE_JWT_AUD } : {}),
    ...(parsed.THE_ODDS_API_KEY
      ? { oddsApiKey: parsed.THE_ODDS_API_KEY }
      : {}),
    oddsApiBaseUrl: parsed.ODDS_API_BASE_URL,
    oddsApiSportKey: parsed.ODDS_API_SPORT_KEY,
    oddsApiRegion: parsed.ODDS_API_REGION,
    ...(parsed.ODDS_API_FALLBACK_REGION
      ? { oddsApiFallbackRegion: parsed.ODDS_API_FALLBACK_REGION }
      : {}),
    oddsFetchWindowMs: parsed.ODDS_FETCH_WINDOW_HOURS * 60 * 60 * 1_000,
    matchOddsFallbackWindowMs:
      parsed.MATCH_ODDS_FALLBACK_WINDOW_HOURS * 60 * 60 * 1_000,
    matchOddsMissCacheTtlMs:
      (parsed.MATCH_ODDS_MISS_CACHE_TTL_SECONDS ?? 3_600) * 1_000,
    oddsMissCacheTtlMs:
      (parsed.ODDS_MISS_CACHE_TTL_SECONDS ?? 21_600) * 1_000,
    ...(parsed.SPORTS_GAME_ODDS_API_KEY
      ? { sportsGameOddsApiKey: parsed.SPORTS_GAME_ODDS_API_KEY }
      : {}),
    sportsGameOddsBaseUrl: parsed.SPORTS_GAME_ODDS_BASE_URL,
    sportsGameOddsLeagueId: parsed.SPORTS_GAME_ODDS_LEAGUE_ID,
    ...(parsed.ODDS_API_IO_KEY
      ? { oddsApiIoKey: parsed.ODDS_API_IO_KEY }
      : {}),
    oddsApiIoBaseUrl: parsed.ODDS_API_IO_BASE_URL,
    oddsApiIoLeague: parsed.ODDS_API_IO_LEAGUE,
    oddsApiIoBookmakers: parsed.ODDS_API_IO_BOOKMAKERS.split(',')
      .map((bookmaker) => bookmaker.trim())
      .filter(Boolean),
    oddsApiIoDailyRequestLimit: parsed.ODDS_API_IO_DAILY_REQUEST_LIMIT,
    oddsApiIoHourlyRequestLimit: parsed.ODDS_API_IO_HOURLY_REQUEST_LIMIT,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  };
}
