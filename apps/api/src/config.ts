import { z } from 'zod';

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
  corsOrigins: string[];
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = EnvSchema.parse(env);
  const legacyCacheTtlSeconds = parsed.CACHE_TTL_SECONDS ?? 86_400;
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
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  };
}
