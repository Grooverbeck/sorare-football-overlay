import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { print } from 'graphql';
import { PLAYER_STATS_BATCH_QUERY } from '../src/graphql/player-stats.query.ts';

const DEFAULT_SLUGS = [
  'dominik-robin-schmid',
  'serge-philippe-raux-yao',
  'stjepan-radeljic',
  'sergi-dominguez-viloria',
  'nenad-n-cvetkovic',
  'andres-andrade-cedeno',
  'fabian-wilfinger',
  'ante-majstorovic',
  'dario-maresic',
  'joao-victor-tornich',
  'zvonimir-sarlija',
  'benedikt-zech',
  'lukas-spendlhofer',
  'nicolas-wimmer',
  'miguel-freckleton',
];

const VALID_POSITIONS = new Set([
  'Goalkeeper',
  'Defender',
  'Midfielder',
  'Forward',
]);
const ANONYMOUS_REQUEST_BUDGET = 20;

function readArguments(argv) {
  const output = {
    dryRun: false,
    json: false,
    skipAnonymous: false,
  };
  for (const argument of argv) {
    if (argument === '--dry-run') output.dryRun = true;
    else if (argument === '--json') output.json = true;
    else if (argument === '--skip-anonymous') output.skipAnonymous = true;
    else throw new Error(`Unbekanntes Argument: ${argument}`);
  }
  return output;
}

function positiveInteger(value, fallback, name, { allowZero = false } = {}) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} muss eine ganze Zahl >= ${minimum} sein.`);
  }
  return parsed;
}

function commaSeparatedIntegers(value, fallback, name) {
  const entries = (value ?? fallback)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry));
  if (
    entries.length === 0 ||
    entries.some((entry) => !Number.isInteger(entry) || entry < 1 || entry > 50)
  ) {
    throw new Error(`${name} muss Batchgrößen zwischen 1 und 50 enthalten.`);
  }
  return [...new Set(entries)];
}

function commaSeparatedSlugs(value) {
  const slugs = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selected = slugs.length > 0 ? slugs : DEFAULT_SLUGS;
  if (new Set(selected).size !== selected.length) {
    throw new Error('BENCHMARK_SORARE_SLUGS darf keine doppelten Slugs enthalten.');
  }
  if (
    selected.some(
      (slug) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug),
    )
  ) {
    throw new Error(
      'BENCHMARK_SORARE_SLUGS enthält mindestens einen ungültigen Slug.',
    );
  }
  return selected;
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function rounded(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function complexityFromMessage(message) {
  const match = message.match(
    /complexity(?:\s+of)?\s+(\d+).*?max(?:imum)?\s+complexity(?:\s+of)?\s+(\d+)/i,
  );
  if (!match) return null;
  return {
    query: Number(match[1]),
    maximum: Number(match[2]),
    source: 'graphql-error',
  };
}

function reportedComplexity(response, envelope, errorMessages) {
  const header = response.headers.get('x-query-complexity');
  if (header && Number.isFinite(Number(header))) {
    return { query: Number(header), maximum: null, source: 'header' };
  }
  const extensions = envelope?.extensions;
  if (extensions && typeof extensions === 'object') {
    for (const key of ['complexity', 'queryComplexity']) {
      const value = extensions[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { query: value, maximum: null, source: `extensions.${key}` };
      }
    }
  }
  for (const message of errorMessages) {
    const parsed = complexityFromMessage(message);
    if (parsed) return parsed;
  }
  return null;
}

function classifyFailure(response, errorMessages) {
  if (response.status === 429) return 'rate-limit';
  if (!response.ok) return `http-${response.status}`;
  if (
    errorMessages.some((message) =>
      /(?:query\s+)?complexity|exceeds?\s+(?:the\s+)?max(?:imum)?\s+complexity/i.test(
        message,
      ),
    )
  ) {
    return 'complexity';
  }
  if (errorMessages.length > 0) return 'graphql';
  return null;
}

function safeErrorMessage(errorMessages) {
  const first = errorMessages[0];
  if (!first) return null;
  return first.replace(/\s+/g, ' ').slice(0, 180);
}

class StartRateGate {
  constructor(minimumIntervalMs) {
    this.minimumIntervalMs = minimumIntervalMs;
    this.nextStartAt = 0;
    this.tail = Promise.resolve();
  }

  async wait() {
    let release;
    const previous = this.tail;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const waitMs = Math.max(0, this.nextStartAt - performance.now());
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.nextStartAt = performance.now() + this.minimumIntervalMs;
    release();
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

async function requestBatch({
  apiKey,
  batch,
  position,
  timeoutMs,
  url,
  gate,
}) {
  await gate.wait();
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'sorare-football-overlay-batching-benchmark/0.1',
        ...(apiKey ? { APIKEY: apiKey } : {}),
      },
      body: JSON.stringify({
        query: print(PLAYER_STATS_BATCH_QUERY),
        variables: { slugs: batch, position },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let envelope = null;
    let invalidJson = false;
    try {
      envelope = await response.json();
    } catch {
      invalidJson = true;
    }
    const errorMessages = Array.isArray(envelope?.errors)
      ? envelope.errors.flatMap((error) =>
          typeof error?.message === 'string' ? [error.message] : [],
        )
      : [];
    const failure =
      (invalidJson ? 'invalid-json' : null) ??
      classifyFailure(response, errorMessages);
    const returnedSlugs = Array.isArray(envelope?.data?.players)
      ? envelope.data.players.flatMap((player) =>
          player?.__typename === 'Player' && typeof player.slug === 'string'
            ? [player.slug]
            : [],
        )
      : [];
    const returnedSlugSet = new Set(returnedSlugs);
    const requestedSlugSet = new Set(batch);
    const missingPlayers = batch.filter(
      (slug) => !returnedSlugSet.has(slug),
    ).length;
    const unexpectedPlayers = returnedSlugs.filter(
      (slug) => !requestedSlugSet.has(slug),
    ).length;
    const duplicatePlayers = returnedSlugs.length - returnedSlugSet.size;
    return {
      durationMs: performance.now() - startedAt,
      failure,
      message: safeErrorMessage(errorMessages),
      complexity: reportedComplexity(response, envelope, errorMessages),
      duplicatePlayers,
      missingPlayers,
      requestedPlayers: batch.length,
      returnedPlayers: returnedSlugs.length,
      status: response.status,
      success: failure === null && envelope?.data !== undefined,
      unexpectedPlayers,
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      durationMs: performance.now() - startedAt,
      failure: timedOut ? 'timeout' : 'network',
      message: timedOut ? 'Request timed out' : 'Network request failed',
      complexity: null,
      duplicatePlayers: 0,
      missingPlayers: batch.length,
      requestedPlayers: batch.length,
      returnedPlayers: 0,
      status: null,
      success: false,
      unexpectedPlayers: 0,
    };
  }
}

async function runRound(config, scenario) {
  const batches = chunks(config.slugs, scenario.batchSize);
  const startedAt = performance.now();
  const requests = await mapWithConcurrency(
    batches,
    config.concurrency,
    async (batch) => {
      const result = await requestBatch({
        apiKey: scenario.apiKey,
        batch,
        position: config.position,
        timeoutMs: config.timeoutMs,
        url: config.url,
        gate: scenario.gate,
      });
      return {
        ...result,
        completedAfterMs: performance.now() - startedAt,
      };
    },
  );
  return {
    wallMs: performance.now() - startedAt,
    firstBatchMs: Math.min(
      ...requests.map(({ completedAfterMs }) => completedAfterMs),
    ),
    duplicatePlayers: requests.reduce(
      (sum, request) => sum + request.duplicatePlayers,
      0,
    ),
    missingPlayers: requests.reduce(
      (sum, request) => sum + request.missingPlayers,
      0,
    ),
    unexpectedPlayers: requests.reduce(
      (sum, request) => sum + request.unexpectedPlayers,
      0,
    ),
    requests,
  };
}

function scenarioSummary(scenario, rounds) {
  const requests = rounds.flatMap((round) => round.requests);
  const durations = requests.map(({ durationMs }) => durationMs);
  const wallTimes = rounds.map(({ wallMs }) => wallMs);
  const firstBatchTimes = rounds.map(({ firstBatchMs }) => firstBatchMs);
  const complexityValues = requests.flatMap(({ complexity }) =>
    complexity?.query !== undefined ? [complexity.query] : [],
  );
  const failures = requests.filter(({ success }) => !success);
  const missingPlayers = requests.reduce(
    (sum, request) => sum + request.missingPlayers,
    0,
  );
  const unexpectedPlayers = requests.reduce(
    (sum, request) => sum + request.unexpectedPlayers,
    0,
  );
  const duplicatePlayers = requests.reduce(
    (sum, request) => sum + request.duplicatePlayers,
    0,
  );
  return {
    id: scenario.id,
    authentication: scenario.authentication,
    configuredBatchSize: scenario.batchSize,
    effectiveLargestBatch: Math.min(scenario.batchSize, scenario.slugCount),
    rounds: rounds.length,
    requestCount: requests.length,
    successfulRequests: requests.length - failures.length,
    failedRequests: failures.length,
    complexityFailures: failures.filter(
      ({ failure }) => failure === 'complexity',
    ).length,
    duplicatePlayers,
    missingPlayers,
    requestsWithMissingPlayers: requests.filter(
      ({ missingPlayers: count }) => count > 0,
    ).length,
    missingPlayersPerRequest: requests.map(
      ({ missingPlayers: count }) => count,
    ),
    unexpectedPlayers,
    unexpectedPlayersPerRequest: requests.map(
      ({ unexpectedPlayers: count }) => count,
    ),
    duplicatePlayersPerRequest: requests.map(
      ({ duplicatePlayers: count }) => count,
    ),
    roundsWithMissingPlayers: rounds.filter(
      ({ missingPlayers: count }) => count > 0,
    ).length,
    missingPlayersPerRound: rounds.map(
      ({ missingPlayers: count }) => count,
    ),
    unexpectedPlayersPerRound: rounds.map(
      ({ unexpectedPlayers: count }) => count,
    ),
    duplicatePlayersPerRound: rounds.map(
      ({ duplicatePlayers: count }) => count,
    ),
    returnedPlayers: requests.reduce(
      (sum, request) => sum + request.returnedPlayers,
      0,
    ),
    requestP50Ms: rounded(quantile(durations, 0.5)),
    requestP90Ms: rounded(quantile(durations, 0.9)),
    firstBatchP50Ms: rounded(quantile(firstBatchTimes, 0.5)),
    firstBatchP90Ms: rounded(quantile(firstBatchTimes, 0.9)),
    wallP50Ms: rounded(quantile(wallTimes, 0.5)),
    wallP90Ms: rounded(quantile(wallTimes, 0.9)),
    totalWallMs: rounded(
      wallTimes.reduce((sum, duration) => sum + duration, 0),
    ),
    reportedComplexity:
      complexityValues.length > 0
        ? {
            minimum: Math.min(...complexityValues),
            maximum: Math.max(...complexityValues),
          }
        : null,
    comparable:
      failures.length === 0 &&
      missingPlayers === 0 &&
      unexpectedPlayers === 0 &&
      duplicatePlayers === 0,
    failures: failures.map(({ failure, message, status, complexity }) => ({
      failure,
      status,
      ...(message ? { message } : {}),
      ...(complexity ? { complexity } : {}),
    })),
  };
}

function rotated(values, offset) {
  if (values.length === 0) return [];
  const normalized = offset % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

function reportHuman(result) {
  console.log('Sorare Batching Benchmark');
  console.log(
    [
      `Spieler: ${result.config.slugCount} (${result.config.slugSetHash})`,
      `Position: ${result.config.position ?? 'auto'}`,
      `Warm-up: ${result.config.warmups}, Messläufe: ${result.config.repeats}`,
      `Parallelität: ${result.config.concurrency}`,
      `API-Key lokal verfügbar: ${result.config.apiKeyAvailable ? 'ja' : 'nein'}`,
    ].join(' | '),
  );
  console.table(
    result.scenarios.map((scenario) => ({
      Szenario: scenario.id,
      Batch: scenario.configuredBatchSize,
      Requests: scenario.requestCount,
      Erfolgreich: scenario.successfulRequests,
      Fehler: scenario.failedRequests,
      'Fehlende Spieler': scenario.missingPlayers,
      Slugfehler: scenario.unexpectedPlayers + scenario.duplicatePlayers,
      'Lückenhafte Runden': scenario.roundsWithMissingPlayers,
      'Kompl.-Fehler': scenario.complexityFailures,
      'Kompl. gemessen': scenario.reportedComplexity
        ? `${scenario.reportedComplexity.minimum}-${scenario.reportedComplexity.maximum}`
        : '-',
      'Request p50': `${scenario.requestP50Ms ?? '-'} ms`,
      'Request p90': `${scenario.requestP90Ms ?? '-'} ms`,
      'Erster Batch p50': `${scenario.firstBatchP50Ms ?? '-'} ms`,
      'Erster Batch p90': `${scenario.firstBatchP90Ms ?? '-'} ms`,
      'Wall p50': `${scenario.wallP50Ms ?? '-'} ms`,
      'Wall p90': `${scenario.wallP90Ms ?? '-'} ms`,
      'Vs. anon safe': scenario.speedupVsAnonymousP50
        ? `${scenario.speedupVsAnonymousP50}x`
        : '-',
      'Vs. Key B3': scenario.speedupVsKeyBatch3P50
        ? `${scenario.speedupVsKeyBatch3P50}x`
        : '-',
    })),
  );
  for (const skipped of result.skipped) {
    console.log(`Übersprungen: ${skipped.id} – ${skipped.reason}`);
  }
  for (const scenario of result.scenarios.filter(
    ({ missingPlayers, unexpectedPlayers, duplicatePlayers }) =>
      missingPlayers > 0 || unexpectedPlayers > 0 || duplicatePlayers > 0,
  )) {
    console.log(
      `${scenario.id}: fehlend je Request ` +
        `[${scenario.missingPlayersPerRequest.join(', ')}], je Runde ` +
        `[${scenario.missingPlayersPerRound.join(', ')}]; unerwartet je Request ` +
        `[${scenario.unexpectedPlayersPerRequest.join(', ')}]; doppelt je Request ` +
        `[${scenario.duplicatePlayersPerRequest.join(', ')}].`,
    );
  }
  const failures = result.scenarios.flatMap((scenario) =>
    scenario.failures.map((failure) => ({ scenario: scenario.id, ...failure })),
  );
  if (failures.length > 0) {
    console.log('Fehlerdetails (ohne Secrets):');
    console.table(failures);
  }
  console.log(
    'Hinweis: Gemessen wird die gebündelte PlayerStatsBatch-Basisabfrage. ' +
      'Zusätzliche Einzelabfragen für tiefe Vereinshistorien sind nicht enthalten.',
  );
}

function buildConfig(arguments_) {
  const slugs = commaSeparatedSlugs(process.env.BENCHMARK_SORARE_SLUGS);
  const position = process.env.BENCHMARK_SORARE_POSITION?.trim() || 'Defender';
  if (position && !VALID_POSITIONS.has(position)) {
    throw new Error(
      'BENCHMARK_SORARE_POSITION muss eine gültige Football-Position sein.',
    );
  }
  const repeats = positiveInteger(
    process.env.BENCHMARK_SORARE_REPEATS,
    3,
    'BENCHMARK_SORARE_REPEATS',
  );
  const warmups = positiveInteger(
    process.env.BENCHMARK_SORARE_WARMUPS,
    0,
    'BENCHMARK_SORARE_WARMUPS',
    { allowZero: true },
  );
  const anonymousRequests =
    Math.ceil(slugs.length / 3) * (repeats + warmups);
  if (
    !arguments_.skipAnonymous &&
    anonymousRequests > ANONYMOUS_REQUEST_BUDGET
  ) {
    throw new Error(
      `Die Konfiguration würde ${anonymousRequests} anonyme Requests erzeugen. ` +
        `Erlaubt sind höchstens ${ANONYMOUS_REQUEST_BUDGET}. Reduziere Spieler, ` +
        'Warm-ups oder Messläufe oder nutze --skip-anonymous.',
    );
  }
  return {
    apiKey: process.env.SORARE_API_KEY?.trim() || undefined,
    anonymousMinimumIntervalMs: positiveInteger(
      process.env.BENCHMARK_SORARE_ANONYMOUS_INTERVAL_MS,
      3_100,
      'BENCHMARK_SORARE_ANONYMOUS_INTERVAL_MS',
      { allowZero: true },
    ),
    concurrency: positiveInteger(
      process.env.BENCHMARK_SORARE_CONCURRENCY,
      2,
      'BENCHMARK_SORARE_CONCURRENCY',
    ),
    keyBatchSizes: commaSeparatedIntegers(
      process.env.BENCHMARK_SORARE_KEY_BATCH_SIZES,
      '3,6,12,25',
      'BENCHMARK_SORARE_KEY_BATCH_SIZES',
    ),
    keyMinimumIntervalMs: positiveInteger(
      process.env.BENCHMARK_SORARE_KEY_INTERVAL_MS,
      125,
      'BENCHMARK_SORARE_KEY_INTERVAL_MS',
      { allowZero: true },
    ),
    position: position || null,
    repeats,
    skipAnonymous: arguments_.skipAnonymous,
    slugs,
    timeoutMs: positiveInteger(
      process.env.BENCHMARK_SORARE_TIMEOUT_MS,
      15_000,
      'BENCHMARK_SORARE_TIMEOUT_MS',
    ),
    url:
      process.env.SORARE_GRAPHQL_URL?.trim() ||
      'https://api.sorare.com/graphql',
    warmups,
  };
}

async function main() {
  const arguments_ = readArguments(process.argv.slice(2));
  const config = buildConfig(arguments_);
  const scenarios = [];
  if (!config.skipAnonymous) {
    scenarios.push({
      id: 'anonymous/batch-3',
      authentication: 'anonymous',
      apiKey: undefined,
      batchSize: 3,
      gate: new StartRateGate(config.anonymousMinimumIntervalMs),
      slugCount: config.slugs.length,
    });
  }
  const skipped = [];
  for (const batchSize of config.keyBatchSizes) {
    if (!config.apiKey) {
      skipped.push({
        id: `api-key/batch-${batchSize}`,
        reason: 'SORARE_API_KEY ist lokal nicht gesetzt.',
      });
      continue;
    }
    scenarios.push({
      id: `api-key/batch-${batchSize}`,
      authentication: 'api-key',
      apiKey: config.apiKey,
      batchSize,
      gate: new StartRateGate(config.keyMinimumIntervalMs),
      slugCount: config.slugs.length,
    });
  }
  if (scenarios.length === 0) {
    throw new Error(
      'Kein ausführbares Szenario. Entferne --skip-anonymous oder setze SORARE_API_KEY.',
    );
  }

  const publicConfig = {
    apiKeyAvailable: Boolean(config.apiKey),
    concurrency: config.concurrency,
    keyBatchSizes: config.keyBatchSizes,
    position: config.position,
    repeats: config.repeats,
    slugCount: config.slugs.length,
    slugIntegrity: 'unique-and-format-validated',
    slugSetHash: createHash('sha256')
      .update(config.slugs.join('\n'))
      .digest('hex')
      .slice(0, 12),
    timeoutMs: config.timeoutMs,
    warmups: config.warmups,
  };
  if (arguments_.dryRun) {
    const plan = {
      dryRun: true,
      config: publicConfig,
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        batchSize: scenario.batchSize,
        requestsPerRound: Math.ceil(
          config.slugs.length / scenario.batchSize,
        ),
        totalRequests:
          Math.ceil(config.slugs.length / scenario.batchSize) *
          (config.warmups + config.repeats),
      })),
      skipped,
    };
    if (arguments_.json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log('Dry-run; es wurden keine Netzwerkrequests gesendet.');
      console.table(plan.scenarios);
      for (const item of skipped) {
        console.log(`Übersprungen: ${item.id} – ${item.reason}`);
      }
    }
    return;
  }

  const measuredRounds = new Map(
    scenarios.map((scenario) => [scenario.id, []]),
  );
  const progress = (...values) => {
    if (!arguments_.json) console.error(...values);
  };

  for (let warmup = 0; warmup < config.warmups; warmup += 1) {
    for (const scenario of rotated(scenarios, warmup)) {
      progress(`Warm-up ${warmup + 1}/${config.warmups}: ${scenario.id}`);
      await runRound(config, scenario);
    }
  }
  for (let round = 0; round < config.repeats; round += 1) {
    for (const scenario of rotated(scenarios, round)) {
      progress(`Messlauf ${round + 1}/${config.repeats}: ${scenario.id}`);
      const result = await runRound(config, scenario);
      measuredRounds.get(scenario.id).push(result);
    }
  }

  const summaries = scenarios.map((scenario) =>
    scenarioSummary(scenario, measuredRounds.get(scenario.id)),
  );
  const anonymous = summaries.find(
    ({ authentication }) => authentication === 'anonymous',
  );
  const keyBatchThree = summaries.find(
    ({ id }) => id === 'api-key/batch-3',
  );
  for (const summary of summaries) {
    summary.speedupVsAnonymousP50 =
      anonymous?.comparable &&
      summary.comparable &&
      anonymous.wallP50Ms &&
      summary.wallP50Ms
        ? Math.round((anonymous.wallP50Ms / summary.wallP50Ms) * 100) / 100
        : null;
    summary.speedupVsKeyBatch3P50 =
      summary.authentication === 'api-key' &&
      keyBatchThree?.comparable &&
      summary.comparable &&
      keyBatchThree.wallP50Ms &&
      summary.wallP50Ms
        ? Math.round((keyBatchThree.wallP50Ms / summary.wallP50Ms) * 100) /
          100
        : null;
  }
  const result = {
    retrievedAt: new Date().toISOString(),
    config: publicConfig,
    scenarios: summaries,
    skipped,
  };
  if (arguments_.json) console.log(JSON.stringify(result, null, 2));
  else reportHuman(result);
}

await main();
