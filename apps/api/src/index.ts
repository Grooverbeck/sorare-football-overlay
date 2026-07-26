import 'dotenv/config';
import { serve } from '@hono/node-server';
import pino from 'pino';
import {
  SplitPlayerStatsCache,
  TtlCache,
  type PlayerFixtureStats,
  type PlayerFormStats,
} from './cache.js';
import { InMemoryMarketSnapshotStore } from './providers/market-odds-provider.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createStatsRuntime } from './service-factory.js';
import { StaticMlsAaBenchmarkStore } from './services/mls-aa-benchmark.js';

const config = loadConfig(process.env);
const logger = pino({ level: config.logLevel });
const runtime = createStatsRuntime({
  config,
  logger,
  statsCache: new SplitPlayerStatsCache(
    new TtlCache<PlayerFormStats>(config.playerFormCacheTtlMs),
    new TtlCache<PlayerFixtureStats>(config.fixtureCacheTtlMs),
  ),
  marketSnapshotStore: new InMemoryMarketSnapshotStore(
    config.oddsMissCacheTtlMs,
  ),
  scheduleBackground: (task) => {
    void task.catch((error: unknown) => {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Background stats refresh failed',
      );
    });
  },
});
const { statsService } = runtime;
const app = createApp({
  statsService,
  logger,
  corsOrigins: config.corsOrigins,
  mlsAaBenchmarkStore: new StaticMlsAaBenchmarkStore(),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    { port: info.port, mockMode: config.mockMode, source: runtime.source },
    'Sorare overlay API listening',
  );
});
