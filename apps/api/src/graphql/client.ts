import { print, type DocumentNode } from 'graphql';
import { AppError } from '../errors.js';
import type { AppLogger } from '../logger.js';

interface GraphqlError {
  message?: string;
}

interface GraphqlEnvelope<TData> {
  data?: TData;
  errors?: GraphqlError[];
}

export interface SorareGraphqlClientOptions {
  url: string;
  requestTimeoutMs: number;
  maxRetries: number;
  apiKey?: string;
  authToken?: string;
  jwtAud?: string;
  logger: AppLogger;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

// Query documents are static module objects. Printing their AST on every
// Sorare request adds avoidable synchronous work to cold player batches.
const printedDocuments = new WeakMap<DocumentNode, string>();

function printedDocument(document: DocumentNode): string {
  const existing = printedDocuments.get(document);
  if (existing) return existing;
  const value = print(document);
  printedDocuments.set(document, value);
  return value;
}

function retryAfterMs(value: string | null, attempt: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 150);
}

export class SorareGraphqlClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: SorareGraphqlClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<TData, TVariables>(
    document: DocumentNode,
    variables: TVariables,
  ): Promise<TData> {
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

      try {
        const response = await this.fetchImpl(this.options.url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ query: printedDocument(document), variables }),
          signal: controller.signal,
        });

        const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
        if (retryable && attempt < this.options.maxRetries) {
          const waitMs = retryAfterMs(response.headers.get('retry-after'), attempt);
          this.options.logger.warn(
            { attempt: attempt + 1, status: response.status, waitMs },
            'Sorare request throttled or temporarily unavailable; retrying',
          );
          await response.body?.cancel();
          await this.sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          throw new AppError(
            502,
            'SORARE_HTTP_ERROR',
            `Sorare API returned HTTP ${response.status}`,
          );
        }

        const envelope = (await response.json()) as GraphqlEnvelope<TData>;
        if (envelope.errors?.length) {
          const message = envelope.errors.map((error) => error.message ?? 'Unknown error').join('; ');
          throw new AppError(502, 'SORARE_GRAPHQL_ERROR', `Sorare GraphQL error: ${message}`);
        }
        if (!envelope.data) {
          throw new AppError(502, 'SORARE_INVALID_RESPONSE', 'Sorare response contained no data');
        }
        return envelope.data;
      } catch (error) {
        if (error instanceof AppError) throw error;
        const timedOut = error instanceof Error && error.name === 'AbortError';
        throw new AppError(
          502,
          timedOut ? 'SORARE_TIMEOUT' : 'SORARE_NETWORK_ERROR',
          timedOut ? 'Sorare request timed out' : 'Sorare request failed',
          error,
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new AppError(502, 'SORARE_RETRY_EXHAUSTED', 'Sorare retry budget exhausted');
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'sorare-football-overlay/0.1',
      ...(this.options.apiKey ? { APIKEY: this.options.apiKey } : {}),
      ...(this.options.authToken ? { authorization: `Bearer ${this.options.authToken}` } : {}),
      ...(this.options.jwtAud ? { 'JWT-AUD': this.options.jwtAud } : {}),
    };
  }
}
