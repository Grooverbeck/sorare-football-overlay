import {
  ApiErrorResponseSchema,
  PlayerStatsRequestSchema,
  PlayerStatsSuccessResponseSchema,
} from '@sorare-overlay/shared';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from './errors.js';
import type { AppLogger } from './logger.js';
import {
  homePage,
  privacyPage,
  publicPageHeaders,
  supportPage,
} from './public-pages.js';
import type { StatsService } from './services/stats-service.js';
import {
  mlsAaContextForPlayer,
  type MlsAaBenchmarkStore,
} from './services/mls-aa-benchmark.js';

type AppEnv = {
  Variables: {
    requestId: string;
  };
};

function servePublicHtml(context: Context<AppEnv>, html: string): Response {
  for (const [name, value] of Object.entries(publicPageHeaders)) context.header(name, value);
  return context.html(html);
}

export interface CreateAppOptions {
  statsService: StatsService;
  logger: AppLogger;
  corsOrigins: readonly string[];
  mlsAaBenchmarkStore?: MlsAaBenchmarkStore;
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (context, next) => {
    const requestId = context.req.header('x-request-id') ?? crypto.randomUUID();
    context.set('requestId', requestId);
    context.header('x-request-id', requestId);
    const startedAt = performance.now();
    await next();
    options.logger.info(
      {
        requestId,
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'Request completed',
    );
  });

  app.use(
    '/api/*',
    cors({
      origin: (origin) => {
        if (origin.startsWith('chrome-extension://')) return origin;
        if (origin.startsWith('moz-extension://')) return origin;
        return options.corsOrigins.includes(origin) ? origin : undefined;
      },
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'x-request-id'],
      maxAge: 86_400,
    }),
  );

  app.get('/', (context) => servePublicHtml(context, homePage));
  app.get('/privacy', (context) => servePublicHtml(context, privacyPage));
  app.get('/support', (context) => servePublicHtml(context, supportPage));
  app.get('/health', (context) => context.json({ status: 'ok' }));

  app.post('/api/player-stats', async (context) => {
    const body = await context.req
      .json<unknown>()
      .catch(() => {
        throw new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON');
      });
    const parsed = PlayerStatsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        400,
        'INVALID_REQUEST',
        parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }

    const result = await options.statsService.getPlayerStats(parsed.data);
    options.logger.info(
      {
        requestId: context.get('requestId'),
        ...result.diagnostics,
      },
      'Player statistics phases completed',
    );
    let data = result.data;
    if (options.mlsAaBenchmarkStore) {
      try {
        const benchmark = await options.mlsAaBenchmarkStore.get();
        data = result.data.map((stats) => ({
          ...stats,
          mlsAaContext: mlsAaContextForPlayer(benchmark, stats),
        }));
      } catch (error) {
        options.logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          'Weekly MLS AA benchmark unavailable; serving player stats without it',
        );
      }
    }
    const response = PlayerStatsSuccessResponseSchema.parse({
      data,
      meta: {
        requested: parsed.data.slugs.length + parsed.data.playerNames.length,
        returned: result.data.length,
        cacheHits: result.cacheHits,
        source: result.source,
        ...(result.deferredPlayerNames.length > 0
          ? { deferredPlayerNames: result.deferredPlayerNames }
          : {}),
        ...(result.deferredPlayerSlugs.length > 0
          ? { deferredPlayerSlugs: result.deferredPlayerSlugs }
          : {}),
      },
    });
    return context.json(response);
  });

  app.notFound((context) =>
    context.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'NOT_FOUND',
          message: 'Route not found',
          requestId: context.get('requestId'),
        },
      }),
      404,
    ),
  );

  app.onError((error, context) => {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(500, 'INTERNAL_ERROR', 'Unexpected server error', error);
    options.logger.error(
      { err: error, requestId: context.get('requestId'), code: appError.code },
      'Request failed',
    );
    return context.json(
      ApiErrorResponseSchema.parse({
        error: {
          code: appError.code,
          message: appError.message,
          requestId: context.get('requestId'),
        },
      }),
      appError.status as ContentfulStatusCode,
    );
  });

  return app;
}
