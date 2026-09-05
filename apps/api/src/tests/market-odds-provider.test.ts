import type { PlayerStats } from '@sorare-overlay/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../logger.js';
import {
  FIXTURE_IDENTITY_VERSION,
  InMemoryMarketSnapshotStore,
  TheOddsApiPlayerMarketOddsProvider,
  createPlayerProbabilityResolver,
  marketFixtureKey,
  missingMarketSnapshot,
  normalizeTeamName,
  playerIdentityMatchScore,
  providerTeamNamesMatch,
  playerNameMatchScore,
  playerMarketOddsKey,
  resolveProviderFixture,
  resolveProviderFixtureCandidates,
  resolvePlayerProbability,
  shouldRetryMarketFailure,
  supplementFrozenSnapshot,
  supportsFixtureCompetition,
  type MarketSnapshotStore,
  type FixtureGroup,
  type MarketSnapshot,
  type PlayerMarketOddsProvider,
} from '../providers/market-odds-provider.js';
import {
  InMemoryProviderQuotaUsageStore,
  quotaUsage,
} from '../providers/odds-usage.js';
import { SupplementingPlayerMarketOddsProvider } from '../providers/sports-game-odds-provider.js';

const now = Date.parse('2026-07-24T12:00:00.000Z');
const kickoff = '2026-07-24T18:00:00.000Z';

const logger: AppLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function player(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    slug: 'timo-werner',
    displayName: 'Timo Werner',
    position: 'Forward',
    aaL10: { value: 10, sampleSize: 10 },
    cleanSheetL10: { value: 0, sampleSize: 0 },
    goalL10: { value: 0.3, sampleSize: 10 },
    nextGame: {
      date: kickoff,
      homeTeamName: 'Chicago Fire FC',
      awayTeamName: 'Atlanta United FC',
      playerTeamName: 'Atlanta United FC',
      opponentTeamName: 'Chicago Fire FC',
      cleanSheetProbability: 0.2,
      matchProbabilities: { win: 0.34, draw: 0.25, loss: 0.41 },
    },
    excludedLowCoverage: 0,
    ...overrides,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function eventResponse() {
  return [
    {
      id: 'fixture-1',
      commence_time: kickoff,
      home_team: 'Chicago Fire',
      away_team: 'Atlanta United',
    },
  ];
}

function marketResponse(displayName = 'Timo Werner') {
  return {
    id: 'fixture-1',
    commence_time: kickoff,
    home_team: 'Chicago Fire',
    away_team: 'Atlanta United',
    bookmakers: [
      {
        key: 'book-one',
        title: 'Book One',
        markets: [
          {
            key: 'player_goal_scorer_anytime',
            outcomes: [
              { name: 'Yes', description: displayName, price: 2 },
              { name: 'No', description: displayName, price: 1.8 },
            ],
          },
          {
            key: 'player_assists',
            outcomes: [
              {
                name: 'Over',
                description: displayName,
                price: 4,
                point: 0.5,
              },
              {
                name: 'Under',
                description: displayName,
                price: 1.3,
                point: 0.5,
              },
            ],
          },
        ],
      },
      {
        key: 'book-two',
        title: 'Book Two',
        markets: [
          {
            key: 'player_goal_scorer_anytime',
            outcomes: [
              { name: 'Yes', description: displayName, price: 2.5 },
              { name: 'No', description: displayName, price: 1.6 },
            ],
          },
          {
            key: 'player_assists',
            outcomes: [
              {
                name: 'Yes',
                description: displayName,
                price: 5,
                point: 0.5,
              },
              {
                name: 'No',
                description: displayName,
                price: 1.2,
                point: 0.5,
              },
            ],
          },
        ],
      },
    ],
  };
}

function marketResponseForPlayers(displayNames: readonly string[]) {
  const [first = 'Timo Werner', ...remaining] = displayNames;
  const response = marketResponse(first);
  return {
    ...response,
    bookmakers: response.bookmakers.map((bookmaker) => ({
      ...bookmaker,
      markets: bookmaker.markets.map((market) => {
        const template = market.outcomes.filter(
          ({ description }) => description === first,
        );
        return {
          ...market,
          outcomes: [
            ...market.outcomes,
            ...remaining.flatMap((displayName) =>
              template.map((outcome) => ({
                ...outcome,
                description: displayName,
              })),
            ),
          ],
        };
      }),
    })),
  };
}

function singleMarketResponse(
  market: 'player_goal_scorer_anytime' | 'player_assists',
) {
  const response = marketResponse();
  return {
    ...response,
    bookmakers: response.bookmakers.map((bookmaker) => ({
      ...bookmaker,
      markets: bookmaker.markets.filter((candidate) => candidate.key === market),
    })),
  };
}

function unavailableMarketResponse() {
  return {
    id: 'fixture-1',
    commence_time: kickoff,
    home_team: 'Chicago Fire',
    away_team: 'Atlanta United',
    bookmakers: [],
  };
}

describe('TheOddsApiPlayerMarketOddsProvider', () => {
  it('normalizes common Liga MX names used by Leagues Cup feeds', () => {
    expect(normalizeTeamName('Atlético de San Luis FC')).toBe(
      'atletico san luis',
    );
    expect(normalizeTeamName('Chivas Guadalajara')).toBe('guadalajara');
    expect(normalizeTeamName('CF Monterrey')).toBe('monterrey');
    expect(normalizeTeamName('Club América')).toBe('club america');
  });

  it('matches conservative European provider aliases without accepting ambiguous names', () => {
    expect(providerTeamNamesMatch('FC Bayern München', 'Bayern Munich')).toBe(
      true,
    );
    expect(
      providerTeamNamesMatch('Olympique de Marseille', 'Marseille'),
    ).toBe(true);
    expect(providerTeamNamesMatch('Olympique Lyonnais', 'Lyon')).toBe(true);
    expect(providerTeamNamesMatch('Paris Saint-Germain', 'PSG')).toBe(true);
    expect(normalizeTeamName('Paris SG')).toBe('psg');
    expect(providerTeamNamesMatch('Real Madrid', 'Real Sociedad')).toBe(
      false,
    );
    expect(providerTeamNamesMatch('Manchester City', 'Leicester City')).toBe(
      false,
    );
    expect(normalizeTeamName('NEC')).toBe('nec nijmegen');
    expect(normalizeTeamName('NEC Nijmegen')).toBe('nec nijmegen');
    expect(normalizeTeamName('Bodø / Glimt')).toBe('bodo glimt');
    expect(normalizeTeamName('Bodoe/Glimt')).toBe('bodo glimt');
    expect(normalizeTeamName('Tromsø')).toBe('tromso');
    expect(normalizeTeamName('Tromsoe IL')).toBe('tromso');
  });

  it('resolves expanded PSG provider names against Sorare fixture identity', () => {
    const fixture: FixtureGroup = {
      key: 'lille-psg',
      date: kickoff,
      homeTeamName: 'Lille',
      awayTeamName: 'PSG',
      homeTeamSlug: 'lille-villeneuve-d-ascq',
      awayTeamSlug: 'psg-paris',
      players: [],
    };

    expect(
      resolveProviderFixtureCandidates(fixture, [
        {
          event: { id: 'lille-psg-provider-event' },
          eventId: 'lille-psg-provider-event',
          date: kickoff,
          homeTeamName: 'Lille OSC',
          awayTeamName: 'Paris Saint-Germain',
        },
      ]),
    ).toMatchObject({
      status: 'matched',
      eventId: 'lille-psg-provider-event',
      highConfidence: true,
    });
  });

  it('resolves a fixture jointly and rejects an equally plausible duplicate', () => {
    const fixture: FixtureGroup = {
      key: 'nec-bodo',
      date: kickoff,
      homeTeamName: 'NEC',
      awayTeamName: 'Bodø / Glimt',
      homeTeamSlug: 'nec-nijmegen',
      awayTeamSlug: 'bodo-glimt-bodo',
      players: [],
    };
    const candidate = {
      event: { id: 'provider-event' },
      eventId: 'provider-event',
      date: kickoff,
      homeTeamName: 'NEC Nijmegen',
      awayTeamName: 'Bodoe/Glimt',
    };

    expect(
      resolveProviderFixtureCandidates(fixture, [candidate]),
    ).toMatchObject({
      status: 'matched',
      eventId: 'provider-event',
      highConfidence: true,
    });
    expect(
      resolveProviderFixtureCandidates(fixture, [
        candidate,
        {
          ...candidate,
          event: { id: 'duplicate-event' },
          eventId: 'duplicate-event',
        },
      ]),
    ).toMatchObject({ status: 'ambiguous' });
  });

  it('learns only high-confidence provider aliases from Sorare team slugs', async () => {
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    const providerCandidate = {
      event: { id: 'learned-event' },
      eventId: 'learned-event',
      date: kickoff,
      homeTeamName: 'Home Sponsor',
      awayTeamName: 'Away Sponsor',
    };
    const initialFixture: FixtureGroup = {
      key: 'initial',
      date: kickoff,
      homeTeamName: 'Home Sponsor',
      awayTeamName: 'Away Sponsor',
      homeTeamSlug: 'home-club',
      awayTeamSlug: 'away-club',
      players: [],
    };
    await expect(
      resolveProviderFixture(
        store,
        'the-odds-api',
        initialFixture,
        [providerCandidate],
      ),
    ).resolves.toMatchObject({ status: 'matched', highConfidence: true });

    const renamedFixture: FixtureGroup = {
      ...initialFixture,
      key: 'renamed',
      homeTeamName: 'Canonical Home',
      awayTeamName: 'Canonical Away',
    };
    await expect(
      resolveProviderFixture(
        store,
        'the-odds-api',
        renamedFixture,
        [providerCandidate],
      ),
    ).resolves.toMatchObject({ status: 'matched', eventId: 'learned-event' });

    await resolveProviderFixture(
      store,
      'the-odds-api',
      {
        ...initialFixture,
        key: 'conflicting',
        homeTeamSlug: 'different-home-club',
        awayTeamSlug: 'different-away-club',
      },
      [providerCandidate],
    );
    await expect(
      store.getProviderTeamAliases('the-odds-api', [
        'Home Sponsor',
        'Away Sponsor',
      ]),
    ).resolves.toEqual(
      new Map([
        ['home sponsor', 'home-club'],
        ['away sponsor', 'away-club'],
      ]),
    );
  });

  it('lazily retries negative snapshots from an older fixture resolver', () => {
    const fixture: FixtureGroup = {
      key: 'resolver-upgrade',
      date: kickoff,
      homeTeamName: 'NEC',
      awayTeamName: 'Bodø / Glimt',
      players: [],
    };
    const legacyMiss: MarketSnapshot = {
      status: 'unavailable',
      market: 'player_goal_scorer_anytime',
      checkedAt: new Date(now).toISOString(),
      attemptCount: 2,
      nextRetryAt: new Date(now + 60 * 60 * 1_000).toISOString(),
      expiresAt: new Date(Date.parse(kickoff) + 24 * 60 * 60 * 1_000).toISOString(),
    };

    expect(shouldRetryMarketFailure(legacyMiss, Date.parse(kickoff), now)).toBe(
      true,
    );
    const currentMiss = missingMarketSnapshot(
      fixture,
      'player_goal_scorer_anytime',
      undefined,
      now,
      'provider-event',
    );
    expect(currentMiss).toMatchObject({
      fixtureIdentityVersion: FIXTURE_IDENTITY_VERSION,
      reason: 'market_not_offered',
      eventId: 'provider-event',
    });
  });

  it('maps NEC Nijmegen and Bodoe/Glimt to the canonical Sorare fixture', async () => {
    const patrick = player({
      slug: 'patrick-berg',
      displayName: 'Patrick Berg',
      position: 'Midfielder',
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'uefa-champions-league',
        homeTeamName: 'NEC',
        awayTeamName: 'Bodø / Glimt',
        homeTeamSlug: 'nec-nijmegen',
        awayTeamSlug: 'bodo-glimt-bodo',
        playerTeamName: 'Bodø / Glimt',
        opponentTeamName: 'NEC',
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) {
        return json([
          {
            id: 'nec-bodo-event',
            commence_time: kickoff,
            home_team: 'NEC Nijmegen',
            away_team: 'Bodoe/Glimt',
          },
        ]);
      }
      return json({
        ...marketResponse('Patrick Berg'),
        id: 'nec-bodo-event',
        home_team: 'NEC Nijmegen',
        away_team: 'Bodoe/Glimt',
      });
    });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_uefa_champs_league_qualification',
      region: 'eu',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      supportedCompetitionSlugs: ['uefa-champions-league'],
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([patrick]);

    expect(result.get(playerMarketOddsKey(patrick))).toMatchObject({
      goal: { probability: expect.any(Number) },
      assist: { probability: expect.any(Number) },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not persist a market miss when fixture identity is unresolved', async () => {
    const store = new InMemoryMarketSnapshotStore(60_000, () => now);
    const stats = player();
    const fixtureKey = marketFixtureKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json([
        {
          id: 'unrelated-event',
          commence_time: kickoff,
          home_team: 'Real Madrid',
          away_team: 'Real Sociedad',
        },
      ]),
    );
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    await provider.load([stats]);

    await expect(
      store.get(fixtureKey, 'player_goal_scorer_anytime'),
    ).resolves.toBeUndefined();
    await expect(store.get(fixtureKey, 'player_assists')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('accepts Leagues Cup only through its dedicated competition route', () => {
    const leaguesCupPlayer = player({
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'leagues-cup-mls',
        homeTeamName: 'Inter Miami CF',
        awayTeamName: 'Atlético de San Luis',
        playerTeamName: 'Inter Miami CF',
        opponentTeamName: 'Atlético de San Luis',
      },
    });

    expect(
      supportsFixtureCompetition(leaguesCupPlayer, [
        'leagues-cup-mls',
      ]),
    ).toBe(true);
    expect(supportsFixtureCompetition(leaguesCupPlayer, ['mlspa'])).toBe(
      false,
    );
  });

  it('advertises only the player markets enabled by the route capability', () => {
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_spain_la_liga',
      region: 'us',
      fetchWindowMs: 24 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      supportedCompetitionSlugs: ['laliga-es'],
      supportedMarkets: ['goal'],
      fetchImpl: vi.fn<typeof fetch>(),
      now: () => now,
    });
    const laLigaPlayer = player({
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'laliga-es',
      },
    });

    expect(provider.supportsMarket(laLigaPlayer, 'goal')).toBe(true);
    expect(provider.supportsMarket(laLigaPlayer, 'assist')).toBe(false);
  });

  it('does not call the MLS feed for an explicitly unsupported competition', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });
    const unsupported = player({
      nextGame: {
        ...player().nextGame!,
        competitionSlug: 'k-league-1',
        homeTeamName: 'FC Seoul',
        awayTeamName: 'Ulsan HD',
      },
    });

    const result = await provider.load([unsupported]);

    expect(result.get(playerMarketOddsKey(unsupported))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('routes a supported UEFA fixture across qualification and main competition feeds', async () => {
    const uefaPlayer = player({
      slug: 'muhammed-kerem-akturkoglu',
      displayName: 'Kerem Aktürkoğlu',
      nextGame: {
        date: kickoff,
        competitionSlug: 'uefa-champions-league',
        homeTeamName: 'Górnik Zabrze',
        awayTeamName: 'Fenerbahçe',
        playerTeamName: 'Fenerbahçe',
        opponentTeamName: 'Górnik Zabrze',
        cleanSheetProbability: 0.43,
        matchProbabilities: { win: 0.61, draw: 0.23, loss: 0.16 },
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (
        url.includes(
          '/sports/soccer_uefa_champs_league_qualification/events?',
        )
      ) {
        return json([]);
      }
      if (url.includes('/sports/soccer_uefa_champs_league/events?')) {
        return json([
          {
            id: 'fixture-uefa',
            commence_time: kickoff,
            home_team: 'Gornik Zabrze',
            away_team: 'Fenerbahce',
          },
        ]);
      }
      if (
        url.includes(
          '/sports/soccer_uefa_champs_league/events/fixture-uefa/odds?',
        )
      ) {
        return json({
          ...marketResponse('Kerem Aktürkoğlu'),
          id: 'fixture-uefa',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_uefa_champs_league_qualification',
      additionalSportKeys: ['soccer_uefa_champs_league'],
      region: 'eu',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      supportedCompetitionSlugs: ['uefa-champions-league'],
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([uefaPlayer]);

    expect(
      fetchImpl.mock.calls.map(([input]) => String(input)),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '/sports/soccer_uefa_champs_league_qualification/events?',
        ),
        expect.stringContaining(
          '/sports/soccer_uefa_champs_league/events?',
        ),
        expect.stringContaining(
          '/sports/soccer_uefa_champs_league/events/fixture-uefa/odds?',
        ),
      ]),
    );
    expect(result.get(playerMarketOddsKey(uefaPlayer))).toMatchObject({
      source: 'the-odds-api',
      goal: { probability: expect.any(Number) },
      assist: { probability: expect.any(Number) },
    });
  });

  it('persists exact usage returned by The Odds API response headers', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json([], {
        headers: {
          'content-type': 'application/json',
          'x-requests-last': '0',
          'x-requests-used': '211',
          'x-requests-remaining': '289',
        },
      }),
    );
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    const refreshed = await provider.refreshUsage();

    expect(refreshed).toEqual([
      expect.objectContaining({
        provider: 'the-odds-api',
        unit: 'requests',
        used: 211,
        limit: 500,
        remaining: 289,
      }),
    ]);
    expect(await usageStore.get('the-odds-api')).toEqual(refreshed[0]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/sports?apiKey=');
  });

  it('can disable duplicate usage refreshes for additional competition routes', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_uefa_europa_league',
      region: 'eu',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      logger,
      refreshUsage: false,
      fetchImpl,
      now: () => now,
    });

    await expect(provider.refreshUsage()).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('disables the UK fallback once provider usage reaches 70 percent', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const usage = quotaUsage(
      'the-odds-api',
      'requests',
      70,
      100,
      new Date(now).toISOString(),
    );
    if (!usage) throw new Error('Expected quota usage');
    usageStore.set(usage);
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('Timo Werner')));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    await provider.load([griezmann]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('regions=uk'),
      ),
    ).toBe(false);
  });

  it('keeps missing first snapshots enabled at 90 percent without regional fallback', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const usage = quotaUsage(
      'the-odds-api',
      'requests',
      90,
      100,
      new Date(now).toISOString(),
    );
    if (!usage) throw new Error('Expected quota usage');
    usageStore.set(usage);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse()));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(60_000, () => now),
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });

    const requestedPlayer = player();
    const result = await provider.load([requestedPlayer]);

    expect(result.get(playerMarketOddsKey(requestedPlayer))).toMatchObject({
      goal: { probability: expect.any(Number) },
      assist: { probability: expect.any(Number) },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('regions=uk'),
      ),
    ).toBe(false);
  });

  it('keeps frozen values but skips missing-player supplement checks at 85 percent', async () => {
    const usageStore = new InMemoryProviderQuotaUsageStore();
    const snapshotStore = new InMemoryMarketSnapshotStore(
      60_000,
      () => now,
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('Timo Werner')));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: snapshotStore,
      usageStore,
      logger,
      fetchImpl,
      now: () => now,
    });
    const werner = player();
    await provider.load([werner]);
    const usage = quotaUsage(
      'the-odds-api',
      'requests',
      85,
      100,
      new Date(now).toISOString(),
    );
    if (!usage) throw new Error('Expected quota usage');
    usageStore.set(usage);
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
    });

    const result = await provider.load([griezmann]);

    expect(result.get(playerMarketOddsKey(griezmann))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('normalizes Sorare short team names and bookmaker team names identically', () => {
    expect(normalizeTeamName('Montreal Impact')).toBe(
      normalizeTeamName('CF Montreal'),
    );
    expect(normalizeTeamName('New York RB')).toBe(
      normalizeTeamName('New York Red Bulls'),
    );
    expect(normalizeTeamName('SJ Earthquakes')).toBe(
      normalizeTeamName('San Jose Earthquakes'),
    );
    expect(normalizeTeamName('Wattens')).toBe(
      normalizeTeamName('WSG Tirol'),
    );
    expect(normalizeTeamName('Salzburg')).toBe(
      normalizeTeamName('RB Salzburg'),
    );
    expect(normalizeTeamName('Hertha BSC')).toBe(
      normalizeTeamName('Hertha Berlin'),
    );
    expect(normalizeTeamName('Bochum')).toBe(
      normalizeTeamName('VfL Bochum'),
    );
  });

  it('does not treat a legacy Contender fixture as MLS after adding team aliases', () => {
    const legacyContenderPlayer = player({
      nextGame: {
        ...player().nextGame!,
        competitionSlug: undefined,
        homeTeamName: 'Wattens',
        awayTeamName: 'Sturm Graz',
        playerTeamName: 'Wattens',
        opponentTeamName: 'Sturm Graz',
      },
    });

    expect(
      supportsFixtureCompetition(legacyContenderPlayer, ['mlspa']),
    ).toBe(false);
  });

  it('freezes real goal and assist market consensus after the first capture', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(
        json(marketResponse(), {
          headers: {
            'content-type': 'application/json',
            'x-requests-last': '2',
            'x-requests-used': '2',
            'x-requests-remaining': '498',
          },
        }),
      );
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 1,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });
    const stats = player();

    const first = await provider.load([stats]);
    const odds = first.get(playerMarketOddsKey(stats));
    expect(odds).toMatchObject({
      source: 'the-odds-api',
      capturedAt: '2026-07-24T12:00:00.000Z',
      goal: { bookmakerCount: 2 },
      assist: { bookmakerCount: 2 },
    });
    expect(odds?.goal?.probability).toBeCloseTo(0.43196, 4);
    expect(odds?.assist?.probability).toBeCloseTo(0.21942, 4);
    expect(odds?.goal?.bookmakerQuotes).toEqual([
      {
        key: 'book-one',
        title: 'Book One',
        decimalOdds: 2,
        probability: expect.closeTo(0.47368, 4),
      },
      {
        key: 'book-two',
        title: 'Book Two',
        decimalOdds: 2.5,
        probability: expect.closeTo(0.39024, 4),
      },
    ]);
    expect(odds?.assist?.bookmakerQuotes).toEqual([
      {
        key: 'book-one',
        title: 'Book One',
        decimalOdds: 4,
        probability: expect.closeTo(0.24528, 4),
      },
      {
        key: 'book-two',
        title: 'Book Two',
        decimalOdds: 5,
        probability: expect.closeTo(0.19355, 4),
      },
    ]);

    const second = await provider.load([stats]);
    expect(second.get(playerMarketOddsKey(stats))).toEqual(odds);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      '/sports/soccer_usa_mls/events?apiKey=test-key',
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      'markets=player_goal_scorer_anytime%2Cplayer_assists',
    );
  });

  it('uses the UK fallback only when the US markets miss the requested player', async () => {
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('Timo Werner')))
      .mockResolvedValueOnce(json(marketResponse('Antoine Griezmann')));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([griezmann]);

    expect(result.get(playerMarketOddsKey(griezmann))).toMatchObject({
      goal: { bookmakerCount: 2 },
      assist: { bookmakerCount: 2 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('regions=us');
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain('regions=uk');
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain(
      'markets=player_goal_scorer_anytime%2Cplayer_assists',
    );
  });

  it('keeps useful UK outcomes even when the requested player is still missing', async () => {
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
    });
    const werner = player({
      slug: 'timo-werner',
      displayName: 'Timo Werner',
      position: 'Forward',
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('US-only Player')))
      .mockResolvedValueOnce(json(marketResponse('Timo Werner')));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fallbackRegion: 'uk',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const missing = await provider.load([griezmann]);
    expect(missing.get(playerMarketOddsKey(griezmann))).toBeNull();

    const supplemented = await provider.load([werner]);
    expect(supplemented.get(playerMarketOddsKey(werner))).toMatchObject({
      goal: { bookmakerCount: 2 },
      assist: { bookmakerCount: 2 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('enriches legacy frozen snapshots once with individual bookmaker quotes', async () => {
    const store = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => now,
    );
    const stats = player();
    const fixtureKey = marketFixtureKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-1',
      capturedAt: '2026-07-24T10:00:00.000Z',
      players: {
        'timo werner': { probability: 0.4, bookmakerCount: 2 },
      },
    });
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_assists',
      eventId: 'fixture-1',
      capturedAt: '2026-07-24T10:00:00.000Z',
      players: {
        'timo werner': { probability: 0.2, bookmakerCount: 2 },
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse()));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    const enriched = await provider.load([stats]);
    expect(
      enriched.get(playerMarketOddsKey(stats))?.goal?.bookmakerQuotes,
    ).toHaveLength(2);
    expect(
      enriched.get(playerMarketOddsKey(stats))?.assist?.bookmakerQuotes,
    ).toHaveLength(2);

    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('allows only one provider instance to refresh a fixture at a time', async () => {
    const store = new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now);
    let releaseCatalog: (() => void) | undefined;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/events?')) {
        await catalogGate;
        return json(eventResponse());
      }
      return json(marketResponse());
    });
    const createProvider = () =>
      new TheOddsApiPlayerMarketOddsProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.the-odds-api.com/v4',
        sportKey: 'soccer_usa_mls',
        region: 'us',
        fetchWindowMs: 12 * 60 * 60 * 1_000,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
        store,
        logger,
        fetchImpl,
        now: () => now,
      });
    const firstProvider = createProvider();
    const secondProvider = createProvider();
    const stats = player();

    const first = firstProvider.load([stats]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const competing = await secondProvider.load([stats]);

    expect(competing.get(playerMarketOddsKey(stats))).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    releaseCatalog?.();
    await expect(first).resolves.toBeInstanceOf(Map);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const cached = await secondProvider.load([stats], { cacheOnly: true });
    expect(cached.get(playerMarketOddsKey(stats))?.goal).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps a cached market when another market key fails to read', async () => {
    const stats = player();
    const fixtureKey = marketFixtureKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    const backingStore = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => now,
    );
    backingStore.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-1',
      capturedAt: new Date(now).toISOString(),
      players: {
        'timo werner': { probability: 0.4, bookmakerCount: 1 },
      },
    });
    const store: MarketSnapshotStore = {
      get: async (key, market) => {
        if (market === 'player_assists') {
          throw new Error('isolated assist cache read failure');
        }
        return backingStore.get(key, market);
      },
      set: (key, snapshot) => backingStore.set(key, snapshot),
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    const cached = await provider.load([stats], { cacheOnly: true });

    expect(cached.get(playerMarketOddsKey(stats))).toMatchObject({
      goal: { probability: 0.4 },
      assist: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates a normal-path cache read failure before contacting the external API', async () => {
    const stats = player();
    const failure = new Error('normal market cache read failure');
    const store: MarketSnapshotStore = {
      get: async (_key, market) => {
        if (market === 'player_assists') throw failure;
        return undefined;
      },
      set: () => undefined,
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => now,
    });

    await expect(provider.load([stats])).rejects.toBe(failure);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a later cached fixture when earlier fixture reads hang', async () => {
    const earlyPlayers = [0, 1].map((offset) =>
      player({
        slug: `early-player-${offset}`,
        displayName: `Early Player ${offset}`,
        nextGame: {
          ...player().nextGame!,
          date: new Date(Date.parse(kickoff) + offset * 60_000).toISOString(),
        },
      }),
    );
    const healthyPlayer = player({
      slug: 'healthy-player',
      displayName: 'Healthy Player',
      nextGame: {
        ...player().nextGame!,
        date: new Date(Date.parse(kickoff) + 2 * 60_000).toISOString(),
      },
    });
    const earlyKeys = new Set(
      earlyPlayers.map((stats) => {
        const key = marketFixtureKey(stats.nextGame!);
        if (!key) throw new Error('Expected early fixture key');
        return key;
      }),
    );
    const healthyKey = marketFixtureKey(healthyPlayer.nextGame!);
    if (!healthyKey) throw new Error('Expected healthy fixture key');
    const backingStore = new InMemoryMarketSnapshotStore(60_000, () => now);
    backingStore.set(healthyKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'healthy-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        'healthy player': { probability: 0.42, bookmakerCount: 1 },
      },
    });
    const store: MarketSnapshotStore = {
      get: (key, market) =>
        earlyKeys.has(key)
          ? new Promise(() => undefined)
          : backingStore.get(key, market),
      set: (key, snapshot) => backingStore.set(key, snapshot),
    };
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl: vi.fn<typeof fetch>(),
      now: () => now,
    });
    const emptyFallback: PlayerMarketOddsProvider = {
      load: async () => new Map(),
      supportsMarket: () => false,
    };
    const bounded = new SupplementingPlayerMarketOddsProvider(
      provider,
      emptyFallback,
      ['goal'],
      180,
    );

    const cached = await bounded.load(
      [...earlyPlayers, healthyPlayer],
      { cacheOnly: true },
    );

    expect(cached.get(playerMarketOddsKey(healthyPlayer))).toMatchObject({
      goal: { probability: 0.42 },
    });
  });

  it('collects progressive missing players before one supplement request', async () => {
    const store = new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now);
    const base = player();
    const fixtureKey = marketFixtureKey(base.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    for (const market of [
      'player_goal_scorer_anytime',
      'player_assists',
    ] as const) {
      store.set(fixtureKey, {
        status: 'available',
        market,
        eventId: 'fixture-1',
        capturedAt: '2026-07-23T00:00:00.000Z',
        players: {
          'timo werner': {
            probability:
              market === 'player_goal_scorer_anytime' ? 0.4 : 0.2,
            bookmakerCount: 1,
            bookmakerQuotes: [
              {
                key: 'frozen-book',
                title: 'Frozen Book',
                decimalOdds:
                  market === 'player_goal_scorer_anytime' ? 2.5 : 5,
                probability:
                  market === 'player_goal_scorer_anytime' ? 0.4 : 0.2,
              },
            ],
          },
        },
      });
    }

    let releaseBatch: (() => void) | undefined;
    const batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const sleep = vi.fn(async () => batchGate);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/events')) return json(eventResponse());
      return url.searchParams.get('regions') === 'uk'
        ? json(marketResponseForPlayers(['Luis Suarez']))
        : json(marketResponseForPlayers(['Antoine Griezmann']));
    });
    const createProvider = () =>
      new TheOddsApiPlayerMarketOddsProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.the-odds-api.com/v4',
        sportKey: 'soccer_usa_mls',
        region: 'us',
        fallbackRegion: 'uk',
        fetchWindowMs: 12 * 60 * 60 * 1_000,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
        store,
        logger,
        fetchImpl,
        sleep,
        supplementBatchDelayMs: 1_500,
        now: () => now,
      });
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
    });
    const suarez = player({
      slug: 'luis-suarez',
      displayName: 'Luis Suarez',
    });

    const leader = createProvider().load([griezmann]);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(1_500));
    const follower = await createProvider().load([suarez]);
    expect(follower.get(playerMarketOddsKey(suarez))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();

    releaseBatch?.();
    await expect(leader).resolves.toBeInstanceOf(Map);
    expect(
      fetchImpl.mock.calls.filter(([input]) =>
        String(input).includes('/events/fixture-1/odds'),
      ),
    ).toHaveLength(2);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('regions=uk'),
      ),
    ).toBe(true);

    const cached = await createProvider().load([suarez], { cacheOnly: true });
    expect(cached.get(playerMarketOddsKey(suarez))).toMatchObject({
      goal: { probability: expect.any(Number) },
      assist: { probability: expect.any(Number) },
    });
  });

  it('rechecks a missing player at the adaptive pre-kickoff checkpoint without changing frozen odds', async () => {
    let clock = now;
    const store = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => clock,
    );
    const timo = player();
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
    });
    const fixtureKey = marketFixtureKey(timo.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-1',
      capturedAt: '2026-07-24T10:00:00.000Z',
      players: {
        'timo werner': {
          probability: 0.4,
          bookmakerCount: 2,
          bookmakerQuotes: [
            {
              key: 'frozen-book',
              title: 'Frozen Book',
              decimalOdds: 2.5,
              probability: 0.4,
            },
          ],
        },
      },
    });
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_assists',
      eventId: 'fixture-1',
      capturedAt: '2026-07-24T10:00:00.000Z',
      players: {
        'timo werner': {
          probability: 0.2,
          bookmakerCount: 2,
          bookmakerQuotes: [
            {
              key: 'frozen-book',
              title: 'Frozen Book',
              decimalOdds: 5,
              probability: 0.2,
            },
          ],
        },
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(
        json(marketResponseForPlayers(['Timo Werner', 'Antoine Griezmann'])),
      );
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => clock,
    });

    const missing = await provider.load([griezmann]);
    expect(missing.get(playerMarketOddsKey(griezmann))).toBeNull();
    await provider.load([griezmann]);
    expect(fetchImpl).not.toHaveBeenCalled();

    clock += 2 * 60 * 60 * 1_000;
    const supplemented = await provider.load([griezmann]);
    expect(
      supplemented.get(playerMarketOddsKey(griezmann))?.goal,
    ).toBeTruthy();
    expect(
      supplemented.get(playerMarketOddsKey(griezmann))?.assist,
    ).toBeTruthy();

    const frozen = await provider.load([timo]);
    expect(frozen.get(playerMarketOddsKey(timo))).toMatchObject({
      capturedAt: '2026-07-24T10:00:00.000Z',
      goal: {
        probability: 0.4,
        bookmakerQuotes: [
          {
            key: 'frozen-book',
            probability: 0.4,
          },
        ],
      },
      assist: {
        probability: 0.2,
        bookmakerQuotes: [
          {
            key: 'frozen-book',
            probability: 0.2,
          },
        ],
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('backs off a missing player even when the refreshed market is completely unavailable', async () => {
    let clock = now;
    const store = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => clock,
    );
    const griezmann = player({
      slug: 'antoine-griezmann',
      displayName: 'Antoine Griezmann',
      position: 'Forward',
    });
    const fixtureKey = marketFixtureKey(griezmann.nextGame!);
    if (!fixtureKey) throw new Error('Expected fixture key');
    for (const market of [
      'player_goal_scorer_anytime',
      'player_assists',
    ] as const) {
      store.set(fixtureKey, {
        status: 'available',
        market,
        eventId: 'fixture-1',
        capturedAt: '2026-07-24T10:00:00.000Z',
        players: {
          'timo werner': {
            probability:
              market === 'player_goal_scorer_anytime' ? 0.4 : 0.2,
            bookmakerCount: 2,
            bookmakerQuotes: [
              {
                key: 'frozen-book',
                title: 'Frozen Book',
                decimalOdds:
                  market === 'player_goal_scorer_anytime' ? 2.5 : 5,
                probability:
                  market === 'player_goal_scorer_anytime' ? 0.4 : 0.2,
              },
            ],
          },
        },
      });
    }
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(unavailableMarketResponse()));
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => clock,
    });

    await provider.load([griezmann]);
    expect(fetchImpl).not.toHaveBeenCalled();
    clock += 2 * 60 * 60 * 1_000;
    await provider.load([griezmann]);
    await provider.load([griezmann]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      store.get(fixtureKey, 'player_assists'),
    ).resolves.toMatchObject({
      status: 'available',
      missingPlayerChecks: {
        [playerMarketOddsKey(griezmann)]: {
          attemptCount: 1,
          nextRetryAt: null,
        },
      },
    });
  });

  it('requests goal and assist separately when the combined market is unsupported', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (!url.includes('/events/fixture-1/odds')) {
        return json(eventResponse());
      }
      if (url.includes('player_goal_scorer_anytime%2Cplayer_assists')) {
        return json({}, { status: 422 });
      }
      if (url.includes('markets=player_goal_scorer_anytime')) {
        return json(singleMarketResponse('player_goal_scorer_anytime'));
      }
      return json(singleMarketResponse('player_assists'));
    });
    const stats = player();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);
    const odds = result.get(playerMarketOddsKey(stats));

    expect(odds?.goal).toBeTruthy();
    expect(odds?.assist).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('markets=player_goal_scorer_anytime&'),
      ),
    ).toBe(true);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes('markets=player_assists&'),
      ),
    ).toBe(true);
  });

  it('checks unavailable markets at most three times across the 72-hour window', async () => {
    const adaptiveKickoff = Date.parse('2026-07-26T12:00:00.000Z');
    let clock = adaptiveKickoff - 72 * 60 * 60 * 1_000;
    const store = new InMemoryMarketSnapshotStore(
      30 * 60 * 1_000,
      () => clock,
    );
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.includes('/events?')
        ? json([
            {
              id: 'fixture-1',
              commence_time: new Date(adaptiveKickoff).toISOString(),
              home_team: 'Chicago Fire',
              away_team: 'Atlanta United',
            },
          ])
        : json({
            ...unavailableMarketResponse(),
            commence_time: new Date(adaptiveKickoff).toISOString(),
          });
    });
    const stats = player({
      nextGame: {
        ...player().nextGame!,
        date: new Date(adaptiveKickoff).toISOString(),
      },
    });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 72 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store,
      logger,
      fetchImpl,
      now: () => clock,
    });
    const fixtureKey = marketFixtureKey(stats.nextGame!);
    if (!fixtureKey) throw new Error('Expected a fixture key');

    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      store.get(fixtureKey, 'player_assists'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      attemptCount: 1,
      nextRetryAt: new Date(
        adaptiveKickoff - 24 * 60 * 60 * 1_000,
      ).toISOString(),
    });

    clock = adaptiveKickoff - 25 * 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock = adaptiveKickoff - 24 * 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await expect(
      store.get(fixtureKey, 'player_assists'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      attemptCount: 2,
      nextRetryAt: new Date(
        adaptiveKickoff - 4 * 60 * 60 * 1_000,
      ).toISOString(),
    });

    clock = adaptiveKickoff - 5 * 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    clock = adaptiveKickoff - 4 * 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    await expect(
      store.get(fixtureKey, 'player_assists'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      attemptCount: 3,
      nextRetryAt: null,
    });

    clock = adaptiveKickoff - 60 * 60 * 1_000;
    await provider.load([stats]);
    clock = adaptiveKickoff + 60 * 60 * 1_000;
    await provider.load([stats]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('does not spend quota outside the configured pre-kickoff window', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 2 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([player()]);

    expect(result.get(playerMarketOddsKey(player()))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries HTTP 429 without exposing or replacing the API key', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse()));
    const stats = player();
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 1,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      sleep,
      now: () => now,
    });

    await expect(provider.load([stats])).resolves.toBeInstanceOf(Map);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it('matches a bookmaker nickname to a longer Sorare family name', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('Nick Fernandez')));
    const stats = player({
      slug: 'nicolas-fernandez-mercau',
      displayName: 'Nicolás Fernández-Mercau',
      position: 'Midfielder',
    });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))?.goal).toBeTruthy();
    expect(playerNameMatchScore(stats.displayName, 'Nick Fernandez')).toBe(81);
  });

  it('matches Korean names when the feed uses family-name-first order', () => {
    expect(playerNameMatchScore('Heung-min Son', 'Son Heung Min')).toBe(95);
    expect(playerNameMatchScore('Heung-min Son', 'Son Heung-Woo')).toBe(0);
  });

  it('matches the known Oh Hyeon-gyu transliterations and name orders only', () => {
    expect(playerNameMatchScore('Hyeongyu Oh', 'Oh Hyeon-gyu')).toBe(100);
    expect(playerNameMatchScore('Hyun-Gyu Oh', 'Hyeon-Gyu Oh')).toBe(100);
    expect(playerNameMatchScore('Hyeongyu Kim', 'Oh Hyeon-gyu')).toBe(0);
    expect(playerNameMatchScore('Hyeon-Jun Oh', 'Oh Hyeon-gyu')).toBe(0);
  });

  it('matches Icelandic thorn and eth with provider transliterations', () => {
    expect(playerNameMatchScore('Stefán Þórðarson', 'Stefan Thordarson')).toBe(100);
    expect(playerNameMatchScore('Stefán Þórðarson', 'Stefán Thórdarson')).toBe(100);
  });

  it('matches the known Markhiev bookmaker transliteration', () => {
    expect(playerNameMatchScore('Adam Markhiev', 'Adam Markhiyev')).toBe(100);
  });

  it('matches written and abbreviated junior suffixes', () => {
    expect(playerNameMatchScore('Vinícius Júnior', 'Vinicius Jr.')).toBe(100);
  });

  it('merges legacy market aliases for one uniquely identified junior', () => {
    const vini = player({
      slug: 'vinicius-jose-paixao-de-oliveira-junior',
      displayName: 'Vinícius Júnior',
    });
    const snapshot = {
      status: 'available' as const,
      market: 'player_goal_scorer_anytime' as const,
      eventId: 'real-madrid-malaga',
      capturedAt: new Date(now).toISOString(),
      players: {
        vinicius: {
          probability: 1 / 1.909,
          bookmakerCount: 1,
          bookmakerQuotes: [
            {
              key: 'bet365',
              title: 'Bet365',
              decimalOdds: 1.909,
              probability: 1 / 1.909,
            },
          ],
        },
        'vinicius junior': {
          probability: 1 / 2.05,
          bookmakerCount: 1,
          bookmakerQuotes: [
            {
              key: 'unibet',
              title: 'Unibet',
              decimalOdds: 2.05,
              probability: 1 / 2.05,
            },
          ],
        },
      },
    };

    expect(resolvePlayerProbability(snapshot, vini, [vini])).toMatchObject({
      status: 'available',
      probability: {
        probability: (1 / 1.909 + 1 / 2.05) / 2,
        bookmakerCount: 2,
        bookmakerQuotes: [
          expect.objectContaining({ key: 'bet365' }),
          expect.objectContaining({ key: 'unibet' }),
        ],
      },
    });
  });

  it('reuses one prepared fixture identity result within a provider load', () => {
    const target = player({
      slug: 'cached-player',
      displayName: 'Cached Player',
    });
    const snapshot = {
      status: 'available' as const,
      market: 'player_goal_scorer_anytime' as const,
      eventId: 'cached-event',
      capturedAt: new Date(now).toISOString(),
      players: {
        'cached player': {
          probability: 0.25,
          bookmakerCount: 1,
        },
      },
    };
    const resolver = createPlayerProbabilityResolver([target]);

    const first = resolver.resolve(snapshot, target);

    expect(resolver.resolve(snapshot, target)).toBe(first);
    expect(resolver.probability(snapshot, target)).toBe(
      first.status === 'available' ? first.probability : null,
    );
  });

  it('fails closed when removing a junior suffix fits two fixture players', () => {
    const seniorName = player({
      slug: 'vinicius-santos',
      displayName: 'Vinícius',
    });
    const juniorName = player({
      slug: 'vinicius-jose-paixao-de-oliveira-junior',
      displayName: 'Vinícius Júnior',
    });
    const snapshot = {
      status: 'available' as const,
      market: 'player_assists' as const,
      eventId: 'ambiguous-vinicius-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        vinicius: { probability: 0.4, bookmakerCount: 1 },
      },
    };

    expect(
      resolvePlayerProbability(snapshot, juniorName, [seniorName, juniorName]),
    ).toMatchObject({ status: 'roster_ambiguous' });
  });

  it("matches Tah D'Avilla to his Djé D'Avilla bookmaker identity only", () => {
    expect(playerNameMatchScore("Tah D'Avilla", "Djé D'Avilla")).toBe(100);
    expect(playerNameMatchScore('Tah Traoré', 'Djé Traoré')).toBe(0);
  });

  it('uses a unique Sorare-slug alias without broad fuzzy matching', () => {
    const jose = player({
      slug: 'jose-pepe-martinez',
      displayName: 'José Martínez',
    });
    const pedro = player({
      slug: 'pedro-martinez',
      displayName: 'Pedro Martínez',
    });
    const snapshot = {
      status: 'available' as const,
      market: 'player_goal_scorer_anytime' as const,
      eventId: 'slug-alias-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        'pepe martinez': { probability: 0.25, bookmakerCount: 1 },
      },
    };

    expect(playerNameMatchScore(jose.displayName, 'Pepe Martinez')).toBe(0);
    expect(playerIdentityMatchScore(jose, 'Pepe Martinez')).toBe(90);
    expect(resolvePlayerProbability(snapshot, jose, [jose, pedro])).toMatchObject(
      {
        status: 'available',
        matchedBy: 'sorare_slug',
        probability: { probability: 0.25 },
      },
    );
  });

  it('matches Rodri only through Rodrigo Hernandez Cascante\'s explicit slug alias', () => {
    const rodri = player({
      slug: 'rodrigo-hernandez-cascante',
      displayName: 'Rodrigo',
    });
    const otherRodrigo = player({
      slug: 'rodrigo-ribeiro',
      displayName: 'Rodrigo',
    });
    const snapshot = {
      status: 'available' as const,
      market: 'player_goal_scorer_anytime' as const,
      eventId: 'valencia-barcelona',
      capturedAt: new Date(now).toISOString(),
      players: {
        rodri: { probability: 0.2, bookmakerCount: 1 },
      },
    };

    expect(playerNameMatchScore(rodri.displayName, 'Rodri')).toBe(0);
    expect(playerIdentityMatchScore(rodri, 'Rodri')).toBe(100);
    expect(playerIdentityMatchScore(otherRodrigo, 'Rodri')).toBe(0);
    expect(
      resolvePlayerProbability(snapshot, rodri, [rodri, otherRodrigo]),
    ).toMatchObject({
      status: 'available',
      matchedBy: 'player_alias',
      probability: { probability: 0.2 },
    });
  });

  it('fails closed when the same slug alias fits two fixture players', () => {
    const first = player({
      slug: 'jose-pepe-martinez',
      displayName: 'José Martínez',
    });
    const second = player({
      slug: 'pedro-pepe-martinez',
      displayName: 'Pedro Martínez',
    });
    const snapshot = {
      status: 'available' as const,
      market: 'player_goal_scorer_anytime' as const,
      eventId: 'ambiguous-slug-alias-fixture',
      capturedAt: new Date(now).toISOString(),
      players: {
        'pepe martinez': { probability: 0.25, bookmakerCount: 1 },
      },
    };

    expect(resolvePlayerProbability(snapshot, first, [first, second])).toMatchObject(
      { status: 'roster_ambiguous' },
    );
  });

  it('records a newer parser version when supplementing a legacy snapshot', () => {
    const stats = player();
    const legacy = {
      status: 'available' as const,
      market: 'player_assists' as const,
      eventId: 'parser-upgrade-fixture',
      capturedAt: new Date(now - 1_000).toISOString(),
      players: {
        'timo werner': { probability: 0.2, bookmakerCount: 1 },
      },
    };
    const reparsed = {
      ...legacy,
      capturedAt: new Date(now).toISOString(),
      parserVersion: 2,
    };

    expect(
      supplementFrozenSnapshot(
        legacy,
        reparsed,
        [stats],
        stats.nextGame!.date,
      ),
    ).toMatchObject({ parserVersion: 2 });
  });

  it('rejects an abbreviated market name that fits two fixture players', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(eventResponse()))
      .mockResolvedValueOnce(json(marketResponse('J Smith')));
    const john = player({ slug: 'john-smith', displayName: 'John Smith' });
    const jack = player({ slug: 'jack-smith', displayName: 'Jack Smith' });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([john, jack]);

    expect(result.get(playerMarketOddsKey(john))).toBeNull();
    expect(result.get(playerMarketOddsKey(jack))).toBeNull();
  });

  it('does not request odds for a player whose team is not in the fixture', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const stats = player({
      nextGame: {
        ...player().nextGame!,
        playerTeamName: 'New York City FC',
      },
    });
    const provider = new TheOddsApiPlayerMarketOddsProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.the-odds-api.com/v4',
      sportKey: 'soccer_usa_mls',
      region: 'us',
      fetchWindowMs: 12 * 60 * 60 * 1_000,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      store: new InMemoryMarketSnapshotStore(30 * 60 * 1_000, () => now),
      logger,
      fetchImpl,
      now: () => now,
    });

    const result = await provider.load([stats]);

    expect(result.get(playerMarketOddsKey(stats))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('InMemoryMarketSnapshotStore', () => {
  it('expires misses but retains successful snapshots', async () => {
    let clock = now;
    const store = new InMemoryMarketSnapshotStore(1_000, () => clock);
    const fixtureKey = marketFixtureKey(player().nextGame!);
    if (!fixtureKey) throw new Error('Expected a fixture key');

    store.set(fixtureKey, {
      status: 'unavailable',
      market: 'player_assists',
      checkedAt: new Date(clock).toISOString(),
    });
    store.set(fixtureKey, {
      status: 'available',
      market: 'player_goal_scorer_anytime',
      eventId: 'fixture-1',
      capturedAt: new Date(clock).toISOString(),
      players: {
        'timo werner': { probability: 0.4, bookmakerCount: 2 },
      },
    });

    clock += 1_001;
    await expect(store.get(fixtureKey, 'player_assists')).resolves.toBeUndefined();
    await expect(
      store.get(fixtureKey, 'player_goal_scorer_anytime'),
    ).resolves.toMatchObject({ status: 'available' });
  });

  it('expires compact provider evidence independently from frozen snapshots', async () => {
    let clock = now;
    const store = new InMemoryMarketSnapshotStore(1_000, () => clock);
    const fixtureKey = 'provider-evidence-fixture';
    store.setEvidence(
      fixtureKey,
      'odds-api-io',
      { parserVersion: 1, markets: ['Player To Assist'] },
      new Date(clock + 1_000).toISOString(),
    );

    await expect(
      store.getEvidence(fixtureKey, 'odds-api-io'),
    ).resolves.toMatchObject({ parserVersion: 1 });
    clock += 1_001;
    await expect(
      store.getEvidence(fixtureKey, 'odds-api-io'),
    ).resolves.toBeUndefined();
  });
});
