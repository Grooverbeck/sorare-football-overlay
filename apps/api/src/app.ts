import {
  ApiErrorResponseSchema,
  PlayerStatsRequestSchema,
  PlayerStatsSuccessResponseSchema,
} from '@sorare-overlay/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from './errors.js';
import type { AppLogger } from './logger.js';
import type { StatsService } from './services/stats-service.js';

type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export interface CreateAppOptions {
  statsService: StatsService;
  logger: AppLogger;
  corsOrigins: readonly string[];
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
    const response = PlayerStatsSuccessResponseSchema.parse({
      data: result.data,
      meta: {
        requested: parsed.data.slugs.length + parsed.data.playerNames.length,
        returned: result.data.length,
        cacheHits: result.cacheHits,
        source: result.source,
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
