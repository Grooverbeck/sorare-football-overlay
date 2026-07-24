import type { AppConfig } from '../config.js';
import type { AppLogger, LogContext } from '../logger.js';

const levels: Record<AppConfig['logLevel'], number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    const normalized: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    if (value.cause !== undefined) {
      normalized.cause = normalizeValue(value.cause);
    }
    if ('code' in value) {
      normalized.code = value.code;
    }
    if ('status' in value) {
      normalized.status = value.status;
    }
    return normalized;
  }
  return value;
}

function normalizeContext(context: LogContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, normalizeValue(value)]),
  );
}

export function createWorkerLogger(configuredLevel: AppConfig['logLevel']): AppLogger {
  const enabled = (level: 'debug' | 'info' | 'warn' | 'error') =>
    levels[level] >= levels[configuredLevel];
  const write = (
    level: 'debug' | 'info' | 'warn' | 'error',
    context: LogContext,
    message: string,
  ) => {
    if (!enabled(level)) return;
    const event = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...normalizeContext(context),
    };
    console[level](JSON.stringify(event));
  };

  return {
    debug: (context, message) => write('debug', context, message),
    info: (context, message) => write('info', context, message),
    warn: (context, message) => write('warn', context, message),
    error: (context, message) => write('error', context, message),
  };
}
