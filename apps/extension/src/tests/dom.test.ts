import type { PlayerStatsRequest, PlayerStatsSuccessResponse } from '@sorare-overlay/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractPlayerSlug,
  findCardTargets,
  hydrateCardPictureNames,
} from '../dom.js';
import {
  applyHistoricalAssistFallbackSettings,
  applyMarketBracketSide,
  applyMarketValueFormat,
  OverlayView,
} from '../overlay.js';
import { SorareCardScanner, StatsBatchCoordinator } from '../scanner.js';

describe('Sorare card DOM discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: undefined,
    });
    applyMarketBracketSide('right');
    applyMarketValueFormat('percentage');
    applyHistoricalAssistFallbackSettings(false, 15);
    hydrateCardPictureNames({});
    window.history.replaceState({}, '', '/football');
  });

  it('extracts player slugs only from Sorare player links', () => {
    const valid = document.createElement('a');
    valid.href = '/football/players/virgil-van-dijk/cards';
    const invalid = document.createElement('a');
    invalid.href = 'https://example.com/football/players/virgil-van-dijk';

    expect(extractPlayerSlug(valid)).toBe('virgil-van-dijk');
    expect(extractPlayerSlug(invalid)).toBeNull();
  });

  it('uses stable data attributes and identifies the concrete card position', () => {
    document.body.innerHTML = `
      <article data-testid="football-card" data-position="Defender">
        <a href="/football/players/virgil-van-dijk">Player</a>
      </article>
    `;

    expect(findCardTargets(document)).toMatchObject([
      { slug: 'virgil-van-dijk', position: 'Defender' },
    ]);
  });

  it('uses Fernández-Mercau\'s German MF card marker instead of his Defender base position', () => {
    document.body.innerHTML = `
      <article data-testid="football-card">
        <a href="/football/players/nicolas-fernandez-mercau">Nicolás Fernández-Mercau</a>
        <span aria-label="Kartenposition">MF</span>
        <span data-testid="base-position">Defender</span>
      </article>
    `;

    expect(findCardTargets(document)).toMatchObject([
      { slug: 'nicolas-fernandez-mercau', position: 'Midfielder' },
    ]);
  });

  it('does not mount an overlay on a player-profile link without a card', () => {
    window.history.replaceState({}, '', '/football/players/fehmi-mert-gunok');
    document.body.innerHTML = `
      <section data-testid="player-profile-header">
        <div data-testid="player-position">Torwart</div>
        <div class="player-title">
          <a href="/football/players/fehmi-mert-gunok">Mert Günok</a>
        </div>
      </section>
    `;

    expect(findCardTargets(document)).toEqual([]);
  });

  it('keeps a player link as a target when it directly wraps a card image', () => {
    document.body.innerHTML = `
      <div>
        <a href="/football/players/fehmi-mert-gunok">
          <img
            alt="Mert Günok - limited"
            src="https://assets.sorare.com/image-resize/card/example/picture/card.png"
          >
        </a>
      </div>
    `;

    expect(findCardTargets(document)).toMatchObject([
      { slug: 'fehmi-mert-gunok' },
    ]);
  });

  it.each([
    ['TW', 'Goalkeeper'],
    ['VER', 'Defender'],
    ['DF', 'Defender'],
    ['MF', 'Midfielder'],
    ['ST', 'Forward'],
    ['Stürmer', 'Forward'],
  ] as const)('recognizes the localized card position %s as %s', (marker, position) => {
    document.body.innerHTML = `
      <article data-testid="football-card">
        <a href="/football/players/test-player">Player</a>
        <span aria-label="Kartenposition">${marker}</span>
      </article>
    `;

    expect(findCardTargets(document)).toMatchObject([{ position }]);
  });

  it('recognizes lineup cards from their stable image alt text', async () => {
    document.body.innerHTML = `
      <button type="button" data-position="Goalkeeper">
        <img
          loading="lazy"
          draggable="false"
          width="160"
          height="259.2"
          class="generated-classes-are-ignored"
          alt="Matt Turner - common"
          src="https://assets.sorare.com/image-resize/cardsamplepicture/example/picture/card.png"
        >
      </button>
    `;
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'matt-turner',
          displayName: 'Matt Turner',
          position: 'Goalkeeper',
          aaL10: { value: 8.5, sampleSize: 10 },
          cleanSheetL10: { value: 0.6, sampleSize: 10 },
          goalL10: { value: 0, sampleSize: 10 },
          nextGame: {
            date: '2026-07-27T18:45:00.000Z',
            cleanSheetProbability: 0.44,
            matchProbabilities: { win: 0.48, draw: 0.27, loss: 0.25 },
          },
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'mock' },
    };
    const fetcher = vi.fn(async () => response);
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000);
    const scanner = new SorareCardScanner(coordinator);

    expect(findCardTargets(document)).toMatchObject([
      { playerName: 'Matt Turner', position: 'Goalkeeper' },
    ]);
    scanner.scan(document);
    scanner.scan(document);
    await coordinator.flush();

    expect(document.querySelectorAll('[data-sorare-overlay-root]')).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith({
      slugs: [],
      playerNames: ['Matt Turner'],
      positions: { 'Matt Turner': 'Goalkeeper' },
    });
  });

  it('uses the uniquely active lineup position for an image-only player card', () => {
    document.body.innerHTML = `
      <section data-testid="lineup-builder">
        <nav aria-label="Positionen">
          <button type="button" class="generated highlighted">
            <span>TW</span>
          </button>
          <button type="button"><span>VER</span></button>
          <button type="button"><span>MF</span></button>
          <button type="button"><span>FWD</span></button>
        </nav>
        <div data-testid="player-pool">
          <button type="button">
            <img
              alt="Ederson - common"
              src="https://assets.sorare.com/image-resize/cardsamplepicture/ederson/picture/card.png"
            >
          </button>
        </div>
      </section>
    `;

    expect(findCardTargets(document)).toMatchObject([
      { playerName: 'Ederson', position: 'Goalkeeper' },
    ]);
  });

  it('uses the concrete five-slot lineup order before the active picker position', () => {
    document.body.innerHTML = `
      <section data-testid="lineup-builder">
        <nav aria-label="Positionen">
          <button type="button" class="highlighted"><span>TW</span></button>
        </nav>
        <div class="FOOTBALL spread slots5 smartWidth">
          <div><button><img alt="Keeper - common" src="/keeper.png"></button></div>
          <div><button><img alt="Defender - common" src="/defender.png"></button></div>
          <div><button><img alt="Midfielder - common" src="/midfielder.png"></button></div>
          <div><button><img alt="Forward - common" src="/forward.png"></button></div>
          <div><button><img alt="Extra - common" src="/extra.png"></button></div>
        </div>
      </section>
    `;

    expect(
      findCardTargets(document).map(({ playerName, position }) => ({
        playerName,
        position,
      })),
    ).toEqual([
      { playerName: 'Keeper', position: 'Goalkeeper' },
      { playerName: 'Defender', position: 'Defender' },
      { playerName: 'Midfielder', position: 'Midfielder' },
      { playerName: 'Forward', position: 'Forward' },
      { playerName: 'Extra', position: undefined },
    ]);
  });

  it('does not inherit an underlying lineup position inside a pack reveal', () => {
    document.body.innerHTML = `
      <main>
        <button type="button" class="highlighted"><span>TW</span></button>
        <section data-testid="pack-reveal">
          <h1>DEINE KARTEN: 1/5</h1>
          <button type="button">
            <img
              alt="Ederson - common"
              src="https://assets.sorare.com/image-resize/cardsamplepicture/ederson/picture/card.png"
            >
          </button>
        </section>
      </main>
    `;

    expect(findCardTargets(document)).toMatchObject([
      { playerName: 'Ederson' },
    ]);
    expect(findCardTargets(document)[0]?.position).toBeUndefined();
  });

  it('keeps overlays on cards in an editable inline lineup overview', async () => {
    document.body.innerHTML = `
      <article class="isInline">
        <div class="FOOTBALL forced_inline slots5">
          <button type="button" data-position="Midfielder">
            <img
              width="160"
              height="259.2"
              alt="Marcel Hartel - common"
              src="https://assets.sorare.com/image-resize/cardsamplepicture/example/picture/card.png"
            >
          </button>
        </div>
        <a
          role="button"
          href="/de/football/series/test-series/compose-team/test-lineup"
        >
          Aufstellung bearbeiten
        </a>
      </article>
    `;
    const fetcher = vi.fn(async (): Promise<PlayerStatsSuccessResponse> => ({
      data: [
        {
          slug: 'marcel-hartel',
          displayName: 'Marcel Hartel',
          position: 'Midfielder',
          aaL10: { value: 15.6, sampleSize: 10 },
          cleanSheetL10: { value: null, sampleSize: 0 },
          goalL10: { value: 0.2, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    }));
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000);
    const scanner = new SorareCardScanner(coordinator);

    expect(findCardTargets(document)).toMatchObject([
      { playerName: 'Marcel Hartel', position: 'Midfielder' },
    ]);
    scanner.scan(document);
    await coordinator.flush();

    expect(fetcher).toHaveBeenCalledWith({
      slugs: [],
      playerNames: ['Marcel Hartel'],
      positions: { 'Marcel Hartel': 'Midfielder' },
    });
    expect(document.querySelector('[data-sorare-overlay-root]')).not.toBeNull();
  });

  it('excludes only the miniature card inside a score-details dialog', () => {
    document.body.innerHTML = `
      <article class="isInline">
        <button type="button" data-position="Forward">
          <img
            width="160"
            height="259.2"
            alt="Wout Weghorst - common"
            src="https://assets.sorare.com/image-resize/cardsamplepicture/weghorst/picture/card.png"
          >
        </button>
        <a href="/de/football/series/test-series/compose-team/test-lineup">
          Aufstellung bearbeiten
        </a>
      </article>
      <div role="dialog">
        <a href="/de/football/series/cards/wout-weghorst-2025-common-card">
          <img
            width="80"
            height="129.6"
            alt=""
            src="https://assets.sorare.com/image-resize/cardsamplepicture/weghorst/picture/card.png"
          >
        </a>
        <div data-testid="score-details-player">
          <a href="/de/football/players/wout-weghorst">Wout Weghorst</a>
          <p>FC Twente</p>
        </div>
        <div>Bewertung (Zusatz)</div>
      </div>
    `;

    expect(findCardTargets(document)).toMatchObject([
      {
        playerName: 'Wout Weghorst',
        position: 'Forward',
      },
    ]);

    const scoreDetailsPlayer = document.querySelector<HTMLElement>(
      '[data-testid="score-details-player"]',
    );
    if (!scoreDetailsPlayer) throw new Error('Expected score details player');
    const view = new OverlayView(
      scoreDetailsPlayer,
      { slug: 'wout-weghorst' },
      'Forward',
    );

    expect(view.host.style.display).toBe('none');
    view.destroy();
  });

  it.each([
    [
      'lineup builder',
      '/de/football/series/test-series/compose-team',
    ],
    [
      'squad selection',
      '/de/football/series/test-series/squad-selection',
    ],
  ])('shows home, draw, and away probabilities below the team row in the %s', async (
    _screen,
    pathname,
  ) => {
    window.history.replaceState(
      {},
      '',
      pathname,
    );
    document.body.innerHTML = `
      <section data-testid="lineup-player">
        <button type="button" data-position="Goalkeeper">
          <img
            alt="Angus Gunn - common"
            src="https://assets.sorare.com/card.png"
          >
        </button>
        <button type="button">
          <div data-testid="fixture-teams">
            <div aria-label="Team">SJ</div>
            <div aria-label="Team">LA</div>
          </div>
          <time>So., 04:30</time>
        </button>
      </section>
    `;
    const card = document.querySelector<HTMLElement>(
      '[data-testid="lineup-player"] > button',
    );
    const teamRow = document.querySelector<HTMLElement>(
      '[data-testid="fixture-teams"]',
    );
    if (!card || !teamRow) throw new Error('Expected lineup card and team row');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 40,
      y: 100,
      top: 100,
      right: 150,
      bottom: 278,
      left: 40,
      width: 110,
      height: 178,
      toJSON: () => ({}),
    });
    vi.spyOn(teamRow, 'getBoundingClientRect').mockReturnValue({
      x: 40,
      y: 300,
      top: 300,
      right: 150,
      bottom: 320,
      left: 40,
      width: 110,
      height: 20,
      toJSON: () => ({}),
    });
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'angus-gunn',
          displayName: 'Angus Gunn',
          position: 'Goalkeeper',
          aaL10: { value: 8.7, sampleSize: 10 },
          cleanSheetL10: { value: 0.4, sampleSize: 10 },
          goalL10: { value: 0, sampleSize: 10 },
          nextGame: {
            date: '2026-07-26T02:30:00.000Z',
            homeTeamName: 'San Jose Earthquakes',
            awayTeamName: 'LA Galaxy',
            playerTeamName: 'LA Galaxy',
            opponentTeamName: 'San Jose Earthquakes',
            cleanSheetProbability: 0.29,
            matchProbabilities: { win: 0.52, draw: 0.22, loss: 0.26 },
            marketOdds: {
              source: 'the-odds-api',
              capturedAt: '2026-07-25T12:00:00.000Z',
              goal: {
                probability: 0.34,
                bookmakerCount: 2,
                bookmakerQuotes: [
                  {
                    key: 'draftkings',
                    title: 'DraftKings',
                    decimalOdds: 2.9,
                    probability: 0.34,
                  },
                  {
                    key: 'fanduel',
                    title: 'FanDuel',
                    decimalOdds: 3.05,
                    probability: 0.32,
                  },
                ],
              },
              assist: {
                probability: 0.18,
                bookmakerCount: 1,
                bookmakerQuotes: [
                  {
                    key: 'betmgm',
                    title: 'BetMGM',
                    decimalOdds: 5.5,
                    probability: 0.18,
                  },
                ],
              },
            },
          },
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    };
    const coordinator = new StatsBatchCoordinator(vi.fn(async () => response), 60_000);
    const scanner = new SorareCardScanner(coordinator);
    scanner.start();
    await coordinator.flush();

    const companion = document.querySelector<HTMLElement>(
      '[data-sorare-overlay-companion="lineup-odds"]',
    );
    const overlay = document.querySelector<HTMLElement>(
      '[data-sorare-overlay-root]',
    );
    const bar = companion?.shadowRoot?.querySelector<HTMLElement>('.lineup-odds-bar');
    expect(companion?.hidden).toBe(false);
    expect(teamRow.nextElementSibling).toBe(companion);
    expect(
      companion?.style.getPropertyValue('--lineup-tooltip-clearance'),
    ).toBe('25px');
    expect(bar?.textContent).toBe('26%22%52%');
    const home = bar?.querySelector<HTMLElement>(
      '[data-outcome="home"][data-role="opponent"]',
    );
    const draw = bar?.querySelector<HTMLElement>(
      '[data-outcome="draw"][data-role="draw"]',
    );
    const away = bar?.querySelector<HTMLElement>(
      '[data-outcome="away"][data-role="player"]',
    );
    expect(home?.textContent).toBe('26%');
    expect(home?.style.getPropertyValue('--probability-share')).toBe('26%');
    expect(draw?.textContent).toBe('22%');
    expect(draw?.style.getPropertyValue('--probability-share')).toBe('22%');
    expect(away?.textContent).toBe('52%');
    expect(away?.style.getPropertyValue('--probability-share')).toBe('52%');
    const tooltip =
      companion?.shadowRoot?.querySelector<HTMLElement>('.lineup-odds-tooltip');
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.querySelector('.tooltip-label')?.textContent).toBe('Quoten');
    expect(tooltip?.querySelector('.tooltip-fixture')?.textContent).toBe(
      'San Jose Earthquakes–LA Galaxy',
    );
    expect(
      tooltip?.querySelector<HTMLElement>(
        '.tooltip-team[data-outcome="away"][data-role="player"]',
      )?.textContent,
    ).toBe('LA Galaxy');
    expect(tooltip?.querySelector('.tooltip-odds')?.textContent).toBe(
      'H 26%D 22%A 52%',
    );
    expect(
      tooltip?.querySelector<HTMLElement>(
        '.tooltip-odd[data-outcome="away"][data-role="player"]',
      )?.textContent,
    ).toBe('A 52%');
    expect(tooltip?.querySelector('.bookmaker-markets')).toBeNull();
    const playerTooltip =
      overlay?.shadowRoot?.querySelector<HTMLElement>('.player-market-tooltip');
    expect(playerTooltip?.hidden).toBe(false);
    expect(playerTooltip?.querySelector('.tooltip-label')?.textContent).toBe(
      'Spielerquoten',
    );
    const bookmakerMarkets =
      playerTooltip?.querySelector<HTMLElement>('.bookmaker-markets');
    expect(
      bookmakerMarkets?.querySelector(
        '.bookmaker-market:first-child .bookmaker-market-header',
      )?.textContent,
    ).toBe('TorQuote · fair');
    expect(
      bookmakerMarkets?.querySelector('[data-bookmaker="draftkings"]')
        ?.textContent,
    ).toBe('DraftKings2,90 · 34%');
    expect(
      bookmakerMarkets?.querySelector('[data-bookmaker="fanduel"]')
        ?.textContent,
    ).toBe('FanDuel3,05 · 32%');
    expect(
      bookmakerMarkets?.querySelector('[data-bookmaker="betmgm"]')
        ?.textContent,
    ).toBe('BetMGM5,50 · 18%');
    teamRow.dispatchEvent(new MouseEvent('mouseenter'));
    expect(companion?.dataset.tooltipOpen).toBeUndefined();
    const teamNames = teamRow.querySelectorAll<HTMLElement>('[aria-label="Team"]');
    teamNames[0]?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(companion?.dataset.tooltipOpen).toBe('true');
    expect(overlay?.dataset.playerMarketTooltipOpen).toBeUndefined();
    teamNames[0]?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(companion?.dataset.tooltipOpen).toBeUndefined();
    bar?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(companion?.dataset.tooltipOpen).toBe('true');
    bar?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(companion?.dataset.tooltipOpen).toBeUndefined();
    card.dispatchEvent(new MouseEvent('mouseenter'));
    expect(companion?.dataset.tooltipOpen).toBeUndefined();
    expect(overlay?.dataset.playerMarketTooltipOpen).toBeUndefined();
    card.dispatchEvent(new MouseEvent('mouseleave'));
    expect(companion?.dataset.tooltipOpen).toBeUndefined();
    expect(overlay?.dataset.playerMarketTooltipOpen).toBeUndefined();
    const cardImage = card.querySelector('img');
    cardImage?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(companion?.dataset.tooltipOpen).toBeUndefined();
    cardImage?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(companion?.dataset.tooltipOpen).toBeUndefined();
    expect(document.querySelectorAll('[data-sorare-overlay-root]')).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-sorare-overlay-companion="lineup-odds"]'),
    ).toHaveLength(1);
    scanner.stop();
  });

  it('does not borrow a fixture row from a different lineup slot', () => {
    document.body.innerHTML = `
      <div class="FOOTBALL slots5">
        <div>
          <button data-testid="empty-slot">TW</button>
        </div>
        <div>
          <button data-testid="card"><img alt="Local Player - common" src="/card.png"></button>
          <div>
            <span aria-label="Team">HOME</span>
            <span aria-label="Team">AWAY</span>
          </div>
        </div>
        <div><button>MF</button></div>
        <div><button>FWD</button></div>
        <div><button>EX</button></div>
      </div>
    `;
    const emptySlot = document.querySelector<HTMLElement>(
      '[data-testid="empty-slot"]',
    );
    if (!emptySlot) throw new Error('Expected empty lineup slot');
    const view = new OverlayView(
      emptySlot,
      { playerName: 'Former Goalkeeper' },
      'Goalkeeper',
    );
    view.render({
      slug: 'former-goalkeeper',
      displayName: 'Former Goalkeeper',
      position: 'Goalkeeper',
      aaL10: { value: 8, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      nextGame: {
        date: '2026-07-27T18:45:00.000Z',
        homeTeamName: 'Home',
        awayTeamName: 'Away',
        playerTeamName: 'Home',
        opponentTeamName: 'Away',
        cleanSheetProbability: 0.3,
        matchProbabilities: { win: 0.5, draw: 0.25, loss: 0.25 },
      },
      excludedLowCoverage: 0,
    });

    const companion = document.querySelector<HTMLElement>(
      '[data-sorare-overlay-companion="lineup-odds"]',
    );
    expect(companion).toBeNull();
    view.destroy();
  });

  it('removes an overlay when a reused lineup slot becomes empty', async () => {
    document.body.innerHTML = `
      <button type="button" data-position="Goalkeeper">
        <img alt="Mert GÃ¼nok - common" src="/mert.png">
      </button>
    `;
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'fehmi-mert-gunok',
          displayName: 'Mert GÃ¼nok',
          position: 'Goalkeeper',
          aaL10: { value: 8, sampleSize: 10 },
          cleanSheetL10: { value: 0.3, sampleSize: 10 },
          goalL10: { value: 0, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'mock' },
    };
    const coordinator = new StatsBatchCoordinator(
      vi.fn(async () => response),
      60_000,
    );
    const scanner = new SorareCardScanner(coordinator);
    scanner.start();
    await coordinator.flush();
    expect(
      document.querySelectorAll('[data-sorare-overlay-root]'),
    ).toHaveLength(1);

    document.querySelector('img')?.remove();

    await vi.waitFor(() =>
      expect(
        document.querySelectorAll('[data-sorare-overlay-root]'),
      ).toHaveLength(0),
    );
    scanner.stop();
  });

  it('maps a common card name to Sorare\'s longer official display name', async () => {
    document.body.innerHTML = `
      <button type="button">
        <img alt="Sam Surridge - rare" src="https://assets.sorare.com/card.png">
      </button>
    `;
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'sam-surridge',
          displayName: 'Samuel Surridge',
          position: 'Forward',
          aaL10: { value: 12.4, sampleSize: 8 },
          cleanSheetL10: { value: null, sampleSize: 0 },
          goalL10: { value: 0.25, sampleSize: 8 },
          nextGame: {
            date: '2026-07-27T18:45:00.000Z',
            homeTeamName: 'Nashville',
            awayTeamName: 'Atlanta',
            playerTeamName: 'Nashville',
            opponentTeamName: 'Atlanta',
            cleanSheetProbability: null,
            matchProbabilities: { win: 0.48, draw: 0.27, loss: 0.25 },
            marketOdds: {
              source: 'the-odds-api',
              capturedAt: '2026-07-25T04:20:00.000Z',
              goal: { probability: 0.35, bookmakerCount: 4 },
              assist: { probability: 0.15, bookmakerCount: 2 },
              decisive: { probability: 0.45, bookmakerCount: 2 },
            },
          },
          excludedLowCoverage: 1,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    };
    const coordinator = new StatsBatchCoordinator(vi.fn(async () => response), 60_000);
    new SorareCardScanner(coordinator).scan(document);
    await coordinator.flush();

    const host = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(host?.dataset.position).toBe('Forward');
    expect(host?.shadowRoot?.querySelector('.decisive-probability')).toBeNull();
    expect(host?.shadowRoot?.querySelector('.compact')).toBeNull();
    expect(
      host?.shadowRoot?.querySelector('.panel')?.classList.contains('bracket-only'),
    ).toBe(true);
    document.querySelector('button')?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(host?.dataset.expanded).toBeUndefined();
    expect(host?.shadowRoot?.querySelector('.details')).toBeNull();
  });

  it('recognizes an anonymized selected lineup card by its remembered picture id', () => {
    const pictureId = '8249d58d-6f30-4edf-abc9-3a7fee6f4985';
    document.body.innerHTML = `
      <button type="button">
        <img
          alt="Mamadou Fofana - common"
          src="https://assets.sorare.com/image-resize/cardsamplepicture/${pictureId}/picture/tinified.png?width=640"
        >
      </button>
    `;
    expect(findCardTargets(document)).toMatchObject([
      { playerName: 'Mamadou Fofana' },
    ]);

    document.body.innerHTML = `
      <section data-testid="selected-lineup-player">
        <button type="button">
          <img
            alt=""
            src="https://assets.sorare.com/image-resize/cardsamplepicture/${pictureId}/picture/tinified.png?width=640"
          >
        </button>
        <button type="button">
          <div data-testid="fixture-teams">
            <div aria-label="Team">NE</div>
            <div aria-label="Team">ATL</div>
          </div>
        </button>
      </section>
    `;

    expect(findCardTargets(document)).toMatchObject([
      {
        playerName: 'Mamadou Fofana',
        container: document.querySelector(
          '[data-testid="selected-lineup-player"] > button',
        ),
      },
    ]);
  });

  it('ignores anonymized card thumbnails without a nearby fixture row', () => {
    const pictureId = '8249d58d-6f30-4edf-abc9-3a7fee6f4985';
    hydrateCardPictureNames({ [pictureId]: 'Mamadou Fofana' });
    document.body.innerHTML = `
      <footer>
        <button type="button">
          <img
            alt=""
            src="https://assets.sorare.com/image-resize/cardsamplepicture/${pictureId}/picture/avatar.png?width=640"
          >
        </button>
      </footer>
    `;

    expect(findCardTargets(document)).toEqual([]);
  });

  it('retries a transient no-data response and updates the existing card automatically', async () => {
    document.body.innerHTML = `
      <button type="button">
        <img alt="Roman Bürki - common" src="https://assets.sorare.com/card.png">
      </button>
    `;
    const stats: PlayerStatsSuccessResponse['data'][number] = {
      slug: 'roman-burki',
      displayName: 'Roman Bürki',
      position: 'Goalkeeper',
      aaL10: { value: 5.39, sampleSize: 10 },
      cleanSheetL10: { value: 0.1, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      nextGame: {
        date: '2026-07-26T00:30:00.000Z',
        cleanSheetProbability: 0.3125,
        matchProbabilities: { win: 0.51, draw: 0.24, loss: 0.25 },
      },
      excludedLowCoverage: 0,
    };
    const fetcher = vi.fn(async (): Promise<PlayerStatsSuccessResponse> => {
      const data =
        fetcher.mock.calls.length === 1
          ? [
              {
                ...stats,
                aaL10: { value: null, sampleSize: 0 },
                cleanSheetL10: { value: null, sampleSize: 0 },
                goalL10: { value: null, sampleSize: 0 },
              },
            ]
          : [stats];
      return {
        data,
        meta: {
          requested: 1,
          returned: data.length,
          cacheHits: 0,
          source: 'sorare',
        },
      };
    });
    const coordinator = new StatsBatchCoordinator(fetcher, 0, [5]);
    new SorareCardScanner(coordinator).scan(document);
    await coordinator.flush();

    const host = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(host?.shadowRoot?.textContent).toContain('Keine L10-Daten');

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(host?.shadowRoot?.querySelector('.aa-bracket-cell')).toBeNull();
    expect(
      host?.shadowRoot?.querySelector(
        '.clean-sheet-bracket-cell .cs-market-icon',
      )
        ?.textContent,
    ).toBe('CS');
    expect(
      host?.shadowRoot?.querySelector(
        '.clean-sheet-bracket-cell .market-value',
      )
        ?.textContent,
    ).toBe('31%');
    expect(
      host?.shadowRoot?.querySelector<HTMLElement>(
        '.clean-sheet-bracket-cell',
      )?.dataset.tone,
    ).toBe('good');
    expect(
      host?.shadowRoot?.querySelector('.clean-sheet-probability'),
    ).toBeNull();
    expect(host?.shadowRoot?.textContent).not.toContain('Keine L10-Daten');
  });

  it('loads large card lists progressively in small request groups', async () => {
    const fetcher = vi.fn(
      async (
        request: PlayerStatsRequest,
      ): Promise<PlayerStatsSuccessResponse> => ({
        data: request.slugs.map((slug, index) => ({
          slug,
          displayName: `Progressive Player ${index + 1}`,
          position: 'Midfielder',
          aaL10: { value: 10 + index, sampleSize: 10 },
          cleanSheetL10: { value: 0.2, sampleSize: 10 },
          goalL10: { value: 0.1, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        })),
        meta: {
          requested: request.slugs.length,
          returned: request.slugs.length,
          cacheHits: 0,
          source: 'sorare',
        },
      }),
    );
    const coordinator = new StatsBatchCoordinator(
      fetcher,
      60_000,
      [5_000],
      4,
      2,
    );
    const views: OverlayView[] = [];
    for (let index = 0; index < 19; index += 1) {
      const card = document.createElement('article');
      document.body.append(card);
      const slug = `progressive-player-${index + 1}`;
      const view = new OverlayView(card, { slug }, 'Midfielder');
      views.push(view);
      coordinator.enqueue(
        { slug, position: 'Midfielder', container: card },
        view,
      );
    }

    await coordinator.flush();

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(
      fetcher.mock.calls.map(([request]) => request.slugs.length),
    ).toEqual([4, 4, 4, 4, 3]);
    expect(
      views.every(
        (view) =>
          view.host.shadowRoot?.querySelector(
            '.aa-percentile .market-value',
          ) !== null,
      ),
    ).toBe(true);
    for (const view of views) view.destroy();
  });

  it('uses anonymous-safe groups of three by default', async () => {
    const fetcher = vi.fn(
      async (
        request: PlayerStatsRequest,
      ): Promise<PlayerStatsSuccessResponse> => ({
        data: request.slugs.map((slug) => ({
          slug,
          displayName: slug,
          position: 'Midfielder',
          aaL10: { value: 10, sampleSize: 10 },
          cleanSheetL10: { value: 0.2, sampleSize: 10 },
          goalL10: { value: 0.1, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        })),
        meta: {
          requested: request.slugs.length,
          returned: request.slugs.length,
          cacheHits: 0,
          source: 'sorare',
        },
      }),
    );
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000);
    const views: OverlayView[] = [];
    for (let index = 0; index < 8; index += 1) {
      const card = document.createElement('article');
      document.body.append(card);
      const slug = `anonymous-safe-${index + 1}`;
      const view = new OverlayView(card, { slug }, 'Midfielder');
      views.push(view);
      coordinator.enqueue(
        { slug, position: 'Midfielder', container: card },
        view,
      );
    }

    await coordinator.flush();

    expect(
      fetcher.mock.calls.map(([request]) => request.slugs.length),
    ).toEqual([3, 3, 2]);
    for (const view of views) view.destroy();
  });

  it('refreshes response-only pending data without making the card wait', async () => {
    const baseStats: PlayerStatsSuccessResponse['data'][number] = {
      slug: 'pending-market-player',
      displayName: 'Pending Market Player',
      position: 'Forward',
      aaL10: { value: 12.4, sampleSize: 10 },
      cleanSheetL10: { value: 0.1, sampleSize: 10 },
      goalL10: { value: 0.3, sampleSize: 10 },
      nextGame: null,
      excludedLowCoverage: 0,
    };
    const fetcher = vi.fn(
      async (): Promise<PlayerStatsSuccessResponse> => ({
        data: [
          fetcher.mock.calls.length === 1
            ? { ...baseStats, pendingRefreshes: ['marketOdds'] }
            : { ...baseStats, aaL10: { value: 13.7, sampleSize: 10 } },
        ],
        meta: {
          requested: 1,
          returned: 1,
          cacheHits: 1,
          source: 'sorare',
        },
      }),
    );
    const coordinator = new StatsBatchCoordinator(
      fetcher,
      0,
      [5_000],
      8,
      2,
      [5],
    );
    const card = document.createElement('article');
    document.body.append(card);
    const view = new OverlayView(
      card,
      { slug: 'pending-market-player' },
      'Forward',
    );
    coordinator.enqueue(
      {
        slug: 'pending-market-player',
        position: 'Forward',
        container: card,
      },
      view,
    );

    await coordinator.flush();

    expect(
      view.host.shadowRoot?.querySelector('.aa-percentile .market-value')
        ?.textContent,
    ).toBe('12.4');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(
      view.host.shadowRoot?.querySelector('.aa-percentile .market-value')
        ?.textContent,
    ).toBe('13.7');
    view.destroy();
  });

  it('requests synchronous fixture hydration on a pending-fixture follow-up', async () => {
    const baseStats: PlayerStatsSuccessResponse['data'][number] = {
      slug: 'pending-fixture-player',
      displayName: 'Pending Fixture Player',
      position: 'Goalkeeper',
      aaL10: { value: 8.7, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      nextGame: null,
      excludedLowCoverage: 0,
    };
    const fetcher = vi.fn(
      async (
        request: PlayerStatsRequest,
      ): Promise<PlayerStatsSuccessResponse> => ({
        data: [
          fetcher.mock.calls.length === 1
            ? { ...baseStats, pendingRefreshes: ['fixture'] }
            : {
                ...baseStats,
                nextGame: {
                  date: '2026-07-26T02:30:00.000Z',
                  homeTeamName: 'SJ Earthquakes',
                  awayTeamName: 'LA Galaxy',
                  playerTeamName: 'SJ Earthquakes',
                  opponentTeamName: 'LA Galaxy',
                  cleanSheetProbability: 0.29,
                  matchProbabilities: { win: 0.52, draw: 0.22, loss: 0.26 },
                },
              },
        ],
        meta: {
          requested: request.slugs.length,
          returned: 1,
          cacheHits: 1,
          source: 'sorare',
        },
      }),
    );
    const coordinator = new StatsBatchCoordinator(
      fetcher,
      0,
      [5_000],
      8,
      2,
      [5],
    );
    const card = document.createElement('article');
    document.body.append(card);
    const view = new OverlayView(
      card,
      { slug: 'pending-fixture-player' },
      'Goalkeeper',
    );
    coordinator.enqueue(
      {
        slug: 'pending-fixture-player',
        position: 'Goalkeeper',
        container: card,
      },
      view,
    );

    await coordinator.flush();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    expect(fetcher.mock.calls[1]?.[0]).toMatchObject({
      refreshFixtures: true,
    });
    expect(
      view.host.shadowRoot?.querySelector('.clean-sheet-bracket-cell .market-value')
        ?.textContent,
    ).toBe('29%');
    view.destroy();
  });

  it('replaces the overlay when a pack swipe reuses the image container', async () => {
    document.body.innerHTML = `
      <button type="button">
        <img alt="Matt Turner - common" src="https://assets.sorare.com/first.png">
      </button>
    `;
    const statsByName: Record<string, PlayerStatsSuccessResponse['data'][number]> = {
      'Matt Turner': {
        slug: 'matt-turner',
        displayName: 'Matt Turner',
        position: 'Goalkeeper',
        aaL10: { value: 8.5, sampleSize: 10 },
        cleanSheetL10: { value: 0.6, sampleSize: 10 },
        goalL10: { value: 0, sampleSize: 10 },
        nextGame: null,
        excludedLowCoverage: 0,
      },
      'Angus Gunn': {
        slug: 'angus-gunn',
        displayName: 'Angus Gunn',
        position: 'Goalkeeper',
        aaL10: { value: 9, sampleSize: 4 },
        cleanSheetL10: { value: 0.5, sampleSize: 4 },
        goalL10: { value: 0, sampleSize: 4 },
        nextGame: null,
        excludedLowCoverage: 0,
      },
    };
    const fetcher = vi.fn(async (request: PlayerStatsRequest) => ({
      data: request.playerNames.flatMap((name) => (statsByName[name] ? [statsByName[name]] : [])),
      meta: { requested: request.playerNames.length, returned: 1, cacheHits: 0, source: 'sorare' as const },
    }));
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000);
    const scanner = new SorareCardScanner(coordinator);
    scanner.scan(document);
    await coordinator.flush();
    const firstHost = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(firstHost?.dataset.playerName).toBe('Matt Turner');

    const image = document.querySelector('img');
    if (!image) throw new Error('Expected pack card image');
    image.alt = 'Angus Gunn - common';
    image.src = 'https://assets.sorare.com/second.png';
    scanner.scan(image);
    await coordinator.flush();

    const hosts = document.querySelectorAll<HTMLElement>('[data-sorare-overlay-root]');
    expect(hosts).toHaveLength(1);
    expect(firstHost?.isConnected).toBe(false);
    expect(hosts[0]?.dataset.playerName).toBe('Angus Gunn');
    expect(hosts[0]?.shadowRoot?.querySelector('.details')).toBeNull();
    expect(
      hosts[0]?.shadowRoot?.querySelector('.aa-bracket-cell'),
    ).toBeNull();
    expect(
      hosts[0]?.shadowRoot?.querySelector('.market-bracket')?.getAttribute(
        'aria-label',
      ),
    ).toBe('Clean-Sheet-Quote');
  });

  it('hides an old carousel overlay when Sorare retains the card with zero opacity', async () => {
    document.body.innerHTML = `
      <button type="button">
        <img alt="Matt Turner - common" src="https://assets.sorare.com/first.png">
      </button>
    `;
    const button = document.querySelector('button');
    if (!button) throw new Error('Expected carousel card');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 200,
      top: 200,
      right: 260,
      bottom: 459,
      left: 100,
      width: 160,
      height: 259,
      toJSON: () => ({}),
    });
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'matt-turner',
          displayName: 'Matt Turner',
          position: 'Goalkeeper',
          aaL10: { value: 8.5, sampleSize: 10 },
          cleanSheetL10: { value: 0.6, sampleSize: 10 },
          goalL10: { value: 0, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    };
    const coordinator = new StatsBatchCoordinator(vi.fn(async () => response), 60_000);
    const scanner = new SorareCardScanner(coordinator);
    scanner.start();
    await coordinator.flush();
    const host = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(host?.style.display).toBe('');
    expect(host?.style.top).toBe('199px');
    expect(host?.style.bottom).toBe('');
    expect(host?.style.transform).toBe('translateY(-100%)');

    button.style.opacity = '0';
    await vi.waitFor(() => expect(host?.style.display).toBe('none'));
    scanner.stop();
  });

  it('keeps the compact overlay stable when a large card is hovered', () => {
    document.body.innerHTML = `
      <article data-testid="football-card">
        <a href="/football/players/noel-caliskan">Noel Caliskan</a>
      </article>
    `;
    const card = document.querySelector<HTMLElement>('article');
    if (!card) throw new Error('Expected large player card');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 400,
      y: 40,
      top: 40,
      right: 700,
      bottom: 540,
      left: 400,
      width: 300,
      height: 500,
      toJSON: () => ({}),
    });
    const view = new OverlayView(
      card,
      { slug: 'noel-caliskan' },
      'Midfielder',
    );
    view.render({
      slug: 'noel-caliskan',
      displayName: 'Noel Caliskan',
      position: 'Midfielder',
      aaL10: { value: 18.9, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      nextGame: null,
      excludedLowCoverage: 0,
    });
    card.dispatchEvent(new MouseEvent('mouseenter'));
    expect(view.host.dataset.placement).toBe('above');
    expect(view.host.style.left).toBe('404px');
    expect(view.host.style.width).toBe('292px');
    expect(view.host.style.top).toBe('39px');
    expect(view.host.style.bottom).toBe('');
    expect(view.host.style.transform).toBe('translateY(-100%)');
    expect(view.host.dataset.expanded).toBeUndefined();
    expect(view.host.shadowRoot?.querySelector('.details')).toBeNull();
    view.destroy();
  });

  it('aligns the compact header exactly with the visible Sorare card image', () => {
    document.body.innerHTML = `
      <article data-testid="football-card">
        <img alt="Noel Caliskan - limited" src="https://assets.sorare.com/card.png">
      </article>
    `;
    const card = document.querySelector<HTMLElement>('article');
    const image = document.querySelector<HTMLImageElement>('img');
    if (!card || !image) throw new Error('Expected card and card image');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 396,
      y: 40,
      top: 40,
      right: 704,
      bottom: 548,
      left: 396,
      width: 308,
      height: 508,
      toJSON: () => ({}),
    });
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
      x: 400.25,
      y: 44,
      top: 44,
      right: 700.75,
      bottom: 544,
      left: 400.25,
      width: 300.5,
      height: 500,
      toJSON: () => ({}),
    });

    const view = new OverlayView(
      card,
      { playerName: 'Noel Caliskan' },
      'Midfielder',
    );

    expect(view.host.dataset.horizontalAnchor).toBe('card-image');
    expect(view.host.style.left).toBe('400.25px');
    expect(view.host.style.width).toBe('300.5px');
    view.destroy();
  });

  it('hides overlays for background cards covered by a pack modal', async () => {
    document.body.innerHTML = `
      <main>
        <article data-testid="football-card">
          <img alt="Angus Gunn - common" src="https://assets.sorare.com/background.png">
        </article>
      </main>
    `;
    const backgroundCard = document.querySelector<HTMLElement>('article');
    const backgroundImage = backgroundCard?.querySelector('img');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `
      <h1>DEINE KARTEN: 1/5</h1>
      <section>
        <div data-pack-status>Neue Karte</div>
        <article data-testid="football-card">
          <img alt="Justin Haak - common" src="https://assets.sorare.com/pack.png">
        </article>
      </section>
    `;
    const packCard = dialog.querySelector<HTMLElement>('article');
    const packImage = packCard?.querySelector('img');
    const packStatus = dialog.querySelector<HTMLElement>('[data-pack-status]');
    if (!backgroundCard || !packCard || !backgroundImage || !packImage || !packStatus || !dialog) {
      throw new Error('Expected background card and pack dialog');
    }
    vi.spyOn(backgroundCard, 'getBoundingClientRect').mockReturnValue({
      x: 700,
      y: 180,
      top: 180,
      right: 1_030,
      bottom: 440,
      left: 700,
      width: 330,
      height: 260,
      toJSON: () => ({}),
    });
    vi.spyOn(packCard, 'getBoundingClientRect').mockReturnValue({
      x: 130,
      y: 190,
      top: 190,
      right: 318,
      bottom: 495,
      left: 130,
      width: 188,
      height: 305,
      toJSON: () => ({}),
    });
    vi.spyOn(packStatus, 'getBoundingClientRect').mockReturnValue({
      x: 130,
      y: 165,
      top: 165,
      right: 318,
      bottom: 185,
      left: 130,
      width: 188,
      height: 20,
      toJSON: () => ({}),
    });
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 70,
      top: 70,
      right: 900,
      bottom: 700,
      left: 100,
      width: 800,
      height: 630,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn((x: number) =>
        dialog.isConnected && x <= 500 ? packImage : backgroundImage),
    });

    const statsByName: Record<string, PlayerStatsSuccessResponse['data'][number]> = {
      'Angus Gunn': {
        slug: 'angus-gunn',
        displayName: 'Angus Gunn',
        position: 'Goalkeeper',
        aaL10: { value: 7.2, sampleSize: 10 },
        cleanSheetL10: { value: 0.4, sampleSize: 10 },
        goalL10: { value: 0, sampleSize: 10 },
        nextGame: null,
        excludedLowCoverage: 0,
      },
      'Justin Haak': {
        slug: 'justin-haak',
        displayName: 'Justin Haak',
        position: 'Defender',
        aaL10: { value: 17, sampleSize: 10 },
        cleanSheetL10: { value: 0.3, sampleSize: 10 },
        goalL10: { value: 0, sampleSize: 10 },
        nextGame: null,
        excludedLowCoverage: 0,
      },
    };
    const fetcher = vi.fn(async (request: PlayerStatsRequest) => ({
      data: request.playerNames.flatMap((name) => (statsByName[name] ? [statsByName[name]] : [])),
      meta: {
        requested: request.playerNames.length,
        returned: request.playerNames.length,
        cacheHits: 0,
        source: 'sorare' as const,
      },
    }));
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000);
    const scanner = new SorareCardScanner(coordinator);
    scanner.start();
    await coordinator.flush();

    const backgroundOverlay = document.querySelector<HTMLElement>(
      '[data-sorare-overlay-root][data-player-name="Angus Gunn"]',
    );
    expect(backgroundOverlay?.style.display).toBe('');

    document.body.append(dialog);
    await vi.waitFor(() => expect(backgroundOverlay?.style.display).toBe('none'));
    await coordinator.flush();

    const packOverlay = document.querySelector<HTMLElement>(
      '[data-sorare-overlay-root][data-player-name="Justin Haak"]',
    );
    expect(packOverlay?.style.display).toBe('');
    expect(packOverlay?.style.width).toBe('180px');
    expect(packOverlay?.dataset.placement).toBe('pack-card-edge');
    expect(packOverlay?.style.top).toBe('189px');
    expect(packOverlay?.style.bottom).toBe('');

    scanner.stop();
  });

  it('places a new-player pack overlay above its status without relying on a dialog wrapper', async () => {
    document.body.innerHTML = `
      <section>
        <div>Neuer Spieler</div>
        <div>
          <img alt="Tyrese Spicer - common" src="https://assets.sorare.com/pack.png">
        </div>
      </section>
    `;
    const card = document.querySelector<HTMLElement>('img')?.parentElement;
    const status = document.querySelector<HTMLElement>('section > div');
    if (!card || !status) throw new Error('Expected pack status and card image container');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 110,
      y: 160,
      top: 160,
      right: 300,
      bottom: 468,
      left: 110,
      width: 190,
      height: 308,
      toJSON: () => ({}),
    });
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({
      x: 110,
      y: 136,
      top: 136,
      right: 300,
      bottom: 156,
      left: 110,
      width: 190,
      height: 20,
      toJSON: () => ({}),
    });
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'tyrese-spicer',
          displayName: 'Tyrese Spicer',
          position: 'Forward',
          aaL10: { value: 5.9, sampleSize: 10 },
          cleanSheetL10: { value: 0.2, sampleSize: 10 },
          goalL10: { value: 0.2, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    };
    const coordinator = new StatsBatchCoordinator(vi.fn(async () => response), 60_000);
    const scanner = new SorareCardScanner(coordinator);
    scanner.scan(document);
    await coordinator.flush();

    const overlay = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(overlay?.dataset.playerName).toBe('Tyrese Spicer');
    expect(overlay?.dataset.placement).toBe('pack-card-edge');
    expect(overlay?.style.top).toBe('159px');
    expect(overlay?.style.bottom).toBe('');
  });

  it('keeps an animated pack overlay below the Deine-Karten heading', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <div data-pack-heading>Deine Karten: 2/5</div>
        <section>
          <div data-pack-status>Neuer Spieler</div>
          <div data-card>
            <img alt="Alex Bono - common" src="https://assets.sorare.com/pack.png">
          </div>
        </section>
      </div>
    `;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const heading = document.querySelector<HTMLElement>('[data-pack-heading]');
    const status = document.querySelector<HTMLElement>('[data-pack-status]');
    const card = document.querySelector<HTMLElement>('[data-card]');
    if (!dialog || !heading || !status || !card) {
      throw new Error('Expected animated pack dialog');
    }
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      x: 80,
      y: 40,
      top: 40,
      right: 524,
      bottom: 700,
      left: 80,
      width: 444,
      height: 660,
      toJSON: () => ({}),
    });
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue({
      x: 180,
      y: 90,
      top: 90,
      right: 424,
      bottom: 116,
      left: 180,
      width: 244,
      height: 26,
      toJSON: () => ({}),
    });
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({
      x: 190,
      y: 125,
      top: 125,
      right: 414,
      bottom: 145,
      left: 190,
      width: 224,
      height: 20,
      toJSON: () => ({}),
    });
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 190,
      y: 150,
      top: 150,
      right: 414,
      bottom: 512,
      left: 190,
      width: 224,
      height: 362,
      toJSON: () => ({}),
    });

    const view = new OverlayView(
      card,
      { playerName: 'Alex Bono' },
      'Goalkeeper',
    );
    const panel = view.host.shadowRoot?.querySelector<HTMLElement>('.panel');
    if (!panel) throw new Error('Expected overlay panel');
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      x: 194,
      y: 95,
      top: 95,
      right: 410,
      bottom: 115,
      left: 194,
      width: 216,
      height: 20,
      toJSON: () => ({}),
    });

    view.refreshPositionNow({ modalScope: dialog });

    expect(view.host.dataset.placement).toBe('pack-status-above');
    expect(view.host.dataset.packHeaderClamped).toBe('true');
    expect(view.host.style.top).toBe('144px');
    expect(view.host.style.bottom).toBe('');
    view.destroy();
  });

  it('reserves a status row above a pack card when Sorare shows no decision label', async () => {
    document.body.innerHTML = `
      <section>
        <h1>DEINE KARTEN: 1/5</h1>
        <button type="button">
          <img alt="Luis Otávio - common" src="https://assets.sorare.com/pack.png">
        </button>
      </section>
    `;
    const card = document.querySelector<HTMLElement>('button');
    if (!card) throw new Error('Expected pack card without decision label');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 110,
      y: 160,
      top: 160,
      right: 300,
      bottom: 468,
      left: 110,
      width: 190,
      height: 308,
      toJSON: () => ({}),
    });
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'luis-otavio',
          displayName: 'Luis Otávio',
          position: 'Midfielder',
          aaL10: { value: 5.1, sampleSize: 10 },
          cleanSheetL10: { value: 0.1, sampleSize: 10 },
          goalL10: { value: 0.1, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    };
    const coordinator = new StatsBatchCoordinator(vi.fn(async () => response), 60_000);
    new SorareCardScanner(coordinator).scan(document);
    await coordinator.flush();

    const overlay = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(overlay?.dataset.playerName).toBe('Luis Otávio');
    expect(overlay?.dataset.placement).toBe('pack-card-edge');
    expect(overlay?.style.top).toBe('159px');
    expect(overlay?.style.bottom).toBe('');
  });

  it.each([
    { bonusPercent: 5, bonusTop: 145 },
    { bonusPercent: 10, bonusTop: 130 },
  ])(
    'anchors a +$bonusPercent% special-edition bracket to the card edge',
    async ({ bonusPercent, bonusTop }) => {
    document.body.innerHTML = `
      <div role="dialog"><span>570</span><h1>Deine Karten: 2/5</h1><section><div>
            <div>Neuer Spieler</div></div><div><svg role="img" aria-labelledby="special-bonus">
              <title id="special-bonus">Bonus von ${bonusPercent} %</title>
              <text>+${bonusPercent} % Bonus</text>
            </svg></div><div>
            <div>
              <div>
                <div>
                  <img alt="Oleksandr Svatok - common" src="https://assets.sorare.com/special-edition.png">
                </div>
              </div>
            </div>
          </div></section></div>
    `;
    const card = document.querySelector<HTMLImageElement>('img')?.parentElement;
    const status = document.querySelector<HTMLElement>('section > div:first-child > div');
    const bonus = document.querySelector<SVGElement>('svg[role="img"]');
    if (!card || !status || !bonus) {
      throw new Error('Expected special-edition pack status, bonus, and card');
    }
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 110,
      y: 170,
      top: 170,
      right: 300,
      bottom: 478,
      left: 110,
      width: 190,
      height: 308,
      toJSON: () => ({}),
    });
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({
      x: 110,
      y: 138,
      top: 138,
      right: 300,
      bottom: 158,
      left: 110,
      width: 190,
      height: 20,
      toJSON: () => ({}),
    });
    vi.spyOn(bonus, 'getBoundingClientRect').mockReturnValue({
      x: 240,
      y: bonusTop,
      top: bonusTop,
      right: 320,
      bottom: bonusTop + 44,
      left: 240,
      width: 80,
      height: 44,
      toJSON: () => ({}),
    });
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'oleksandr-svatok',
          displayName: 'Oleksandr Svatok',
          position: 'Defender',
          aaL10: { value: 6.4, sampleSize: 10 },
          cleanSheetL10: { value: 0.2, sampleSize: 10 },
          goalL10: { value: 0, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    };
    const coordinator = new StatsBatchCoordinator(vi.fn(async () => response), 60_000);
    const scanner = new SorareCardScanner(coordinator);
    scanner.scan(document);
    await coordinator.flush();

    const overlay = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(overlay?.dataset.playerName).toBe('Oleksandr Svatok');
    expect(overlay?.dataset.placement).toBe('pack-card-edge');
    expect(overlay?.style.top).toBe('169px');
    expect(overlay?.style.bottom).toBe('');
    },
  );

  it('reveals pack brackets only after the card animation has settled', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.body.innerHTML = `
      <section data-testid="pack-reveal">
        <h1>Deine Karten: 1/5</h1>
        <article data-testid="pack-card">
          <div data-testid="pack-status">Neuer Spieler</div>
          <img alt="Alex Roldan - common" src="https://assets.sorare.com/pack.png">
        </article>
      </section>
    `;
    const scope = document.querySelector<HTMLElement>('[data-testid="pack-reveal"]');
    const card = document.querySelector<HTMLElement>('[data-testid="pack-card"]');
    const status = document.querySelector<HTMLElement>(
      '[data-testid="pack-status"]',
    );
    const image = document.querySelector<HTMLImageElement>('img');
    if (!scope || !card || !status || !image) {
      throw new Error('Expected animated pack card');
    }
    let cardTop = 180;
    const cardRect = () => ({
      x: 140,
      y: cardTop,
      top: cardTop,
      right: 330,
      bottom: cardTop + 308,
      left: 140,
      width: 190,
      height: 308,
      toJSON: () => ({}),
    });
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(cardRect);
    vi.spyOn(image, 'getBoundingClientRect').mockImplementation(cardRect);
    let statusTop = 145;
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => ({
      x: 140,
      y: statusTop,
      top: statusTop,
      right: 330,
      bottom: statusTop + 18,
      left: 140,
      width: 190,
      height: 18,
      toJSON: () => ({}),
    }));
    const view = new OverlayView(
      card,
      { playerName: 'Alex Roldan' },
      'Defender',
    );

    const stats = {
      slug: 'alex-roldan',
      displayName: 'Alex Roldan',
      position: 'Defender' as const,
      aaL10: { value: 19.2, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      nextGame: {
        date: '2026-07-27T18:45:00.000Z',
        opponent: 'Opponent',
        cleanSheetProbability: 0.21,
      },
      excludedLowCoverage: 0,
    };
    view.render(stats);

    expect(view.host.dataset.packSettling).toBe('true');
    for (let frame = 0; frame < 3; frame += 1) {
      cardTop += 4;
      frameCallbacks.shift()?.(frame * 16);
    }
    expect(view.host.dataset.packSettling).toBe('true');

    cardTop = 180;
    for (let frame = 0; frame < 7; frame += 1) {
      frameCallbacks.shift()?.((frame + 3) * 16);
    }
    expect(view.host.dataset.packSettling).toBeUndefined();
    expect(view.host.dataset.placement).toBe('pack-card-edge');
    expect(view.host.style.top).toBe('179px');

    view.render(stats);
    expect(view.host.dataset.packSettling).toBeUndefined();

    view.noData();
    expect(view.host.dataset.packSettling).toBe('true');
    for (let frame = 0; frame < 3; frame += 1) {
      statusTop += 3;
      frameCallbacks.shift()?.((frame + 10) * 16);
    }
    expect(view.host.dataset.packSettling).toBe('true');
    for (let frame = 0; frame < 7; frame += 1) {
      frameCallbacks.shift()?.((frame + 13) * 16);
    }
    expect(view.host.dataset.packSettling).toBeUndefined();
    expect(view.host.dataset.placement).toBe('pack-status-above');

    view.destroy();
    vi.unstubAllGlobals();
  });

  it('ignores card hover but re-settles for a later pack animation', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.body.innerHTML = `
      <div role="dialog" data-testid="pack-results">
        <div><span>Sorare</span><span>Neuverpflichtungen</span></div>
        ${'<div>'.repeat(13)}
          <article data-testid="pack-result-card">
            <div data-testid="hover-card" style="--active: 1">
              <img alt="Tim Ream - common" src="https://assets.sorare.com/pack.png">
            </div>
            <span data-testid="bonus-animation">Bonus</span>
          </article>
        ${'</div>'.repeat(13)}
      </div>
    `;
    const scope = document.querySelector<HTMLElement>('[data-testid="pack-results"]');
    const card = document.querySelector<HTMLElement>(
      '[data-testid="pack-result-card"]',
    );
    const image = card?.querySelector<HTMLImageElement>('img');
    const hoverCard = card?.querySelector<HTMLElement>(
      '[data-testid="hover-card"]',
    );
    const bonusAnimation = card?.querySelector<HTMLElement>(
      '[data-testid="bonus-animation"]',
    );
    if (!scope || !card || !image || !hoverCard || !bonusAnimation) {
      throw new Error('Expected pack result card');
    }
    let cardTop = 184;
    const cardRect = () => ({
      x: 380,
      y: cardTop,
      top: cardTop,
      right: 500,
      bottom: cardTop + 194,
      left: 380,
      width: 120,
      height: 194,
      toJSON: () => ({}),
    });
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(cardRect);
    vi.spyOn(image, 'getBoundingClientRect').mockImplementation(cardRect);
    const view = new OverlayView(
      card,
      { playerName: 'Tim Ream' },
      'Defender',
    );
    view.render({
      slug: 'tim-ream',
      displayName: 'Tim Ream',
      position: 'Defender',
      aaL10: { value: 14.1, sampleSize: 10 },
      cleanSheetL10: { value: 0.3, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      nextGame: null,
      excludedLowCoverage: 0,
    });

    for (let frame = 0; frame < 30; frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
    }
    expect(view.host.dataset.packReveal).toBe('true');
    expect(view.host.dataset.packSettling).toBeUndefined();

    hoverCard.dispatchEvent(new Event('animationstart', { bubbles: true }));
    frameCallbacks.shift()?.(128);
    expect(view.host.dataset.packSettling).toBeUndefined();
    expect(view.host.dataset.placement).toBe('pack-card-edge');

    bonusAnimation.dispatchEvent(
      new Event('animationstart', { bubbles: true }),
    );
    frameCallbacks.shift()?.(144);
    frameCallbacks.shift()?.(160);
    expect(view.host.dataset.packSettling).toBeUndefined();

    bonusAnimation.dispatchEvent(
      new Event('animationstart', { bubbles: true }),
    );
    cardTop = 190;
    frameCallbacks.shift()?.(176);
    expect(view.host.dataset.packSettling).toBe('true');

    cardTop = 184;
    for (
      let frame = 0;
      frame < 80 && view.host.dataset.packSettling === 'true';
      frame += 1
    ) {
      frameCallbacks.shift()?.((frame + 9) * 16);
    }
    expect(view.host.dataset.packSettling).toBeUndefined();

    view.noData();
    expect(view.host.dataset.packSettling).toBe('true');
    for (
      let frame = 0;
      frame < 80 && view.host.dataset.packSettling === 'true';
      frame += 1
    ) {
      frameCallbacks.shift()?.((frame + 90) * 16);
    }
    expect(view.host.dataset.packSettling).toBeUndefined();
    expect(view.host.dataset.placement).toBe('pack-card-edge');
    expect(view.host.shadowRoot?.textContent).toContain('Keine L10-Daten');

    view.destroy();
    vi.unstubAllGlobals();
  });

  it('shows only the centered card while a single-card pack carousel retains neighbors', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.body.innerHTML = `
      <div role="dialog" data-testid="pack-carousel">
        <h1>Deine Karten: 4/5</h1>
        <article data-testid="previous-card">
          <img alt="Previous Player - common" src="/previous.png">
        </article>
        <article data-testid="current-card">
          <img alt="Current Player - common" src="/current.png">
        </article>
      </div>
    `;
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="pack-carousel"]',
    );
    const previousCard = document.querySelector<HTMLElement>(
      '[data-testid="previous-card"]',
    );
    const currentCard = document.querySelector<HTMLElement>(
      '[data-testid="current-card"]',
    );
    const previousImage = previousCard?.querySelector<HTMLImageElement>('img');
    const currentImage = currentCard?.querySelector<HTMLImageElement>('img');
    if (
      !dialog ||
      !previousCard ||
      !currentCard ||
      !previousImage ||
      !currentImage
    ) {
      throw new Error('Expected retained pack carousel cards');
    }
    const broadContainerRect = {
      x: 0,
      y: 100,
      top: 100,
      right: 1024,
      bottom: 700,
      left: 0,
      width: 1024,
      height: 600,
      toJSON: () => ({}),
    };
    vi.spyOn(previousCard, 'getBoundingClientRect').mockReturnValue(
      broadContainerRect,
    );
    vi.spyOn(currentCard, 'getBoundingClientRect').mockReturnValue(
      broadContainerRect,
    );
    vi.spyOn(previousImage, 'getBoundingClientRect').mockReturnValue({
      ...broadContainerRect,
      x: -300,
      left: -300,
      right: -180,
      width: 120,
      height: 194,
      bottom: 294,
    });
    vi.spyOn(currentImage, 'getBoundingClientRect').mockReturnValue({
      ...broadContainerRect,
      x: 452,
      left: 452,
      right: 572,
      width: 120,
      height: 194,
      bottom: 294,
    });
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value: vi.fn(() => [
        {
          playState: 'running',
          effect: {
            getComputedTiming: () => ({ iterations: 1, endTime: 500 }),
          },
        } as unknown as Animation,
      ]),
    });
    const previousView = new OverlayView(
      previousCard,
      { playerName: 'Previous Player' },
      'Defender',
    );
    const currentView = new OverlayView(
      currentCard,
      { playerName: 'Current Player' },
      'Defender',
    );
    const stats = {
      position: 'Defender' as const,
      aaL10: { value: 10, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      nextGame: null,
      excludedLowCoverage: 0,
    };
    previousView.render({
      ...stats,
      slug: 'previous-player',
      displayName: 'Previous Player',
    });
    currentView.render({
      ...stats,
      slug: 'current-player',
      displayName: 'Current Player',
    });

    for (let frame = 0; frame < 14; frame += 1) {
      frameCallbacks.shift()?.(frame * 16);
    }

    expect(previousView.host.dataset.packPrimary).toBe('false');
    expect(previousView.host.style.display).toBe('none');
    expect(currentView.host.dataset.packPrimary).toBe('true');
    expect(currentView.host.style.display).toBe('');
    expect(currentView.host.dataset.packSettling).toBeUndefined();

    previousView.destroy();
    currentView.destroy();
    delete (document as Document & { getAnimations?: () => Animation[] })
      .getAnimations;
    vi.unstubAllGlobals();
  });

  it('inserts one Shadow DOM overlay and renders returned stats', async () => {
    document.body.innerHTML = `
      <article data-testid="football-card" data-position="Defender">
        <a href="/football/players/virgil-van-dijk">Player</a>
        <a href="/football/players/virgil-van-dijk/cards">Cards</a>
      </article>
    `;
    const card = document.querySelector<HTMLElement>('article');
    if (!card) throw new Error('Expected football card');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      right: 120,
      bottom: 294,
      left: 0,
      width: 120,
      height: 194,
      toJSON: () => ({}),
    });
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'virgil-van-dijk',
          displayName: 'Virgil van Dijk',
          position: 'Defender',
          aaL10: { value: 14.2, sampleSize: 9 },
          cleanSheetL10: { value: 0.5, sampleSize: 8 },
          goalL10: { value: 0.1, sampleSize: 9 },
          nextGame: {
            date: '2026-07-27T18:45:00.000Z',
            homeTeamName: 'Arsenal',
            awayTeamName: 'Liverpool',
            playerTeamName: 'Liverpool',
            opponentTeamName: 'Arsenal',
            cleanSheetProbability: 0.47,
            matchProbabilities: { win: 0.48, draw: 0.27, loss: 0.25 },
            marketOdds: {
              source: 'the-odds-api',
              capturedAt: '2026-07-24T12:00:00.000Z',
              goal: {
                probability: 0.18,
                bookmakerCount: 4,
                bookmakerQuotes: [
                  {
                    key: 'draftkings',
                    title: 'DraftKings',
                    decimalOdds: 5.5,
                    probability: 0.18,
                  },
                ],
              },
              assist: { probability: 0.11, bookmakerCount: 3 },
            },
          },
          excludedLowCoverage: 1,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'mock' },
    };
    const fetcher = vi.fn(async () => response);
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000);
    const scanner = new SorareCardScanner(coordinator);

    scanner.scan(document);
    scanner.scan(document);
    await coordinator.flush();

    const hosts = document.querySelectorAll<HTMLElement>('[data-sorare-overlay-root]');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.parentElement).toBe(document.body);
    expect(hosts[0]?.style.position).toBe('fixed');
    expect(hosts[0]?.style.left).toBe('4px');
    expect(hosts[0]?.style.top).toBe('99px');
    expect(hosts[0]?.dataset.expanded).toBeUndefined();
    const marketBracket =
      hosts[0]?.shadowRoot?.querySelector<HTMLElement>('.market-bracket');
    const compactAa =
      marketBracket?.querySelector<HTMLElement>('.aa-bracket-cell');
    expect(compactAa?.querySelector('.aa-market-icon')?.textContent).toBe('AA');
    expect(compactAa?.querySelector('.market-value')?.textContent).toBe('14.2');
    expect(compactAa?.dataset.tone).toBe('strong');
    expect(compactAa?.dataset.percentileBand).toBe('P80–90');
    expect(compactAa?.querySelector('.performance-scale')).toBeNull();
    expect(marketBracket?.textContent).toBe('AA14.2CS47%18%11%');
    expect(marketBracket?.firstElementChild).toBe(compactAa);
    expect(compactAa?.classList.contains('aa-bracket-top')).toBe(true);
    const cleanSheetBracket =
      marketBracket?.querySelector<HTMLElement>('.clean-sheet-bracket-cell');
    expect(cleanSheetBracket?.querySelector('.cs-market-icon')?.textContent).toBe(
      'CS',
    );
    expect(cleanSheetBracket?.querySelector('.market-value')?.textContent).toBe(
      '47%',
    );
    expect(cleanSheetBracket?.dataset.tone).toBe('elite');
    expect(cleanSheetBracket?.dataset.percentileBand).toBe('P90–100');
    expect(cleanSheetBracket?.classList.contains('market-first')).toBe(true);
    expect(cleanSheetBracket?.classList.contains('market-last')).toBe(true);
    expect(cleanSheetBracket?.classList.contains('market-group-gap')).toBe(true);
    expect(
      marketBracket
        ?.querySelector<HTMLElement>('[data-market="goal"]')
        ?.classList.contains('market-first'),
    ).toBe(true);
    expect(
      marketBracket
        ?.querySelector<HTMLElement>('[data-market="goal"]')
        ?.classList.contains('market-last'),
    ).toBe(false);
    expect(
      marketBracket
        ?.querySelector<HTMLElement>('[data-market="assist"]')
        ?.classList.contains('market-last'),
    ).toBe(true);
    expect(
      marketBracket?.querySelector('[data-market-icon="goal"]'),
    ).not.toBeNull();
    expect(
      marketBracket?.querySelector('[data-market-icon="assist"]'),
    ).not.toBeNull();
    const goalIcon =
      marketBracket?.querySelector<SVGSVGElement>('[data-market-icon="goal"]');
    const assistIcon =
      marketBracket?.querySelector<SVGSVGElement>('[data-market-icon="assist"]');
    expect(goalIcon?.tagName.toLowerCase()).toBe('svg');
    expect(assistIcon?.tagName.toLowerCase()).toBe('svg');
    expect(
      goalIcon?.querySelector('[data-tone-layer="true"]')?.getAttribute('fill'),
    ).toBe('currentColor');
    expect(
      assistIcon?.querySelector('[data-tone-layer="true"]')?.getAttribute('fill'),
    ).toBe('currentColor');
    expect(
      marketBracket?.querySelector<HTMLElement>('[data-market="goal"]')?.dataset.tone,
    ).toBe('elite');
    expect(
      marketBracket?.querySelector<HTMLElement>('[data-market="assist"]')?.dataset.tone,
    ).toBe('good');
    expect(
      marketBracket
        ?.querySelector<HTMLElement>('[data-market="goal"]')
        ?.getAttribute('aria-label'),
    ).toBe('Tor: 18 Prozent, 4 Buchmacher');
    expect(
      marketBracket
        ?.querySelector<HTMLElement>('[data-market="assist"]')
        ?.getAttribute('aria-label'),
    ).toBe('Assist: 11 Prozent, 3 Buchmacher');
    document.querySelector('article')?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(hosts[0]?.dataset.expanded).toBeUndefined();
    expect(hosts[0]?.dataset.playerMarketTooltipOpen).toBeUndefined();
    expect(hosts[0]?.shadowRoot?.querySelector('.details')).toBeNull();
    marketBracket
      ?.querySelector('[data-market="goal"]')
      ?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(hosts[0]?.dataset.playerMarketTooltipOpen).toBe('true');
    marketBracket
      ?.querySelector('[data-market="goal"]')
      ?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(hosts[0]?.dataset.playerMarketTooltipOpen).toBeUndefined();
    compactAa?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(hosts[0]?.dataset.playerMarketTooltipOpen).toBeUndefined();
    expect(hosts[0]?.shadowRoot?.querySelector('.compact')).toBeNull();
    expect(
      hosts[0]?.shadowRoot
        ?.querySelector('.panel')
        ?.classList.contains('bracket-only'),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('hides missing markets and shows only available goal/assist odds', () => {
    document.body.innerHTML = `
      <article data-testid="football-card">
        <a href="/football/players/pep-biel">Pep Biel</a>
      </article>
    `;
    const card = document.querySelector<HTMLElement>('article');
    if (!card) throw new Error('Expected football card');
    const view = new OverlayView(card, { slug: 'pep-biel' }, 'Midfielder');
    view.render({
      slug: 'pep-biel',
      displayName: 'Pep Biel',
      position: 'Midfielder',
      aaL10: { value: 13.6, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.2, sampleSize: 10 },
      nextGame: {
        date: '2026-07-27T18:45:00.000Z',
        cleanSheetProbability: null,
        matchProbabilities: { win: 0.49, draw: 0.27, loss: 0.24 },
      },
      excludedLowCoverage: 0,
    });

    let bracket = view.host.shadowRoot?.querySelector<HTMLElement>('.market-bracket');
    expect(bracket?.querySelector('[data-market]')).toBeNull();
    expect(
      bracket?.querySelector('.aa-bracket-cell .market-value')?.textContent,
    ).toBe('13.6');
    expect(view.host.shadowRoot?.querySelector('.decisive-probability')).toBeNull();

    vi.stubGlobal('__MARKET_ODDS_PREVIEW__', true);
    view.render({
      slug: 'pep-biel',
      displayName: 'Pep Biel',
      position: 'Midfielder',
      aaL10: { value: 13.6, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.2, sampleSize: 10 },
      nextGame: {
        date: '2026-07-27T18:45:00.000Z',
        cleanSheetProbability: null,
        matchProbabilities: { win: 0.49, draw: 0.27, loss: 0.24 },
      },
      excludedLowCoverage: 0,
    });
    bracket = view.host.shadowRoot?.querySelector<HTMLElement>('.market-bracket');
    expect(bracket?.textContent).toBe('AA13.634%18%');
    expect(bracket?.dataset.preview).toBe('true');
    expect(
      bracket?.querySelector<HTMLElement>('[data-market="goal"]')?.dataset.tone,
    ).toBe('elite');
    expect(
      bracket?.querySelector<HTMLElement>('[data-market="assist"]')?.dataset.tone,
    ).toBe('low');
    expect(bracket?.dataset.foldTone).toBe('low');
    expect(
      bracket
        ?.querySelector<HTMLElement>('[data-market="goal"]')
        ?.getAttribute('aria-label'),
    ).toBe('Tor: Vorschau 34 Prozent');
    vi.unstubAllGlobals();

    view.render({
      slug: 'pep-biel',
      displayName: 'Pep Biel',
      position: 'Midfielder',
      aaL10: { value: 13.6, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.2, sampleSize: 10 },
      nextGame: {
        date: '2026-07-27T18:45:00.000Z',
        cleanSheetProbability: null,
        matchProbabilities: { win: 0.49, draw: 0.27, loss: 0.24 },
        marketOdds: {
          source: 'the-odds-api',
          capturedAt: '2026-07-24T12:00:00.000Z',
          goal: null,
          assist: { probability: 0.18, bookmakerCount: 1 },
        },
      },
      excludedLowCoverage: 0,
    });

    bracket = view.host.shadowRoot?.querySelector<HTMLElement>('.market-bracket');
    expect(bracket?.textContent).toBe('AA13.618%');
    expect(bracket?.querySelector('[data-market="goal"]')).toBeNull();
    expect(
      bracket?.querySelector<HTMLElement>('[data-market="assist"]')?.dataset.available,
    ).toBe('true');
    expect(bracket?.dataset.foldTone).toBe('low');
    expect(view.host.shadowRoot?.querySelector('.decisive-probability')).toBeNull();

    view.render({
      slug: 'pep-biel',
      displayName: 'Pep Biel',
      position: 'Goalkeeper',
      aaL10: { value: 13.6, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0.2, sampleSize: 10 },
      nextGame: {
        date: '2026-07-27T18:45:00.000Z',
        cleanSheetProbability: 0.3,
        matchProbabilities: { win: 0.49, draw: 0.27, loss: 0.24 },
        marketOdds: {
          source: 'the-odds-api',
          capturedAt: '2026-07-24T12:00:00.000Z',
          goal: { probability: 0.01, bookmakerCount: 1 },
          assist: null,
        },
      },
      excludedLowCoverage: 0,
    });
    const goalkeeperBracket =
      view.host.shadowRoot?.querySelector<HTMLElement>('.market-bracket');
    expect(goalkeeperBracket?.querySelector('[data-market]')).toBeNull();
    const cleanSheetBracket =
      goalkeeperBracket?.querySelector<HTMLElement>(
        '.clean-sheet-bracket-cell',
      );
    expect(cleanSheetBracket?.classList.contains('market-cell')).toBe(true);
    expect(
      cleanSheetBracket?.querySelector('.cs-market-icon')?.textContent,
    ).toBe('CS');
    expect(
      cleanSheetBracket?.querySelector('.market-value')?.textContent,
    ).toBe('30%');
    expect(cleanSheetBracket?.dataset.tone).toBe('good');
    expect(cleanSheetBracket?.dataset.percentileBand).toBe('P60–80');
    expect(goalkeeperBracket?.querySelector('.aa-bracket-cell')).toBeNull();
    expect(
      Array.from(goalkeeperBracket?.children ?? []).map(
        (child) => (child as HTMLElement).dataset.bracketSlot,
      ),
    ).toEqual(['aa', 'clean-sheet', 'goal', 'assist']);
    expect(
      goalkeeperBracket?.children[0]?.classList.contains('market-slot-spacer'),
    ).toBe(true);
    expect(
      goalkeeperBracket?.children[1]?.classList.contains(
        'clean-sheet-bracket-cell',
      ),
    ).toBe(true);
    expect(
      goalkeeperBracket?.children[2]?.classList.contains('market-slot-spacer'),
    ).toBe(true);
    expect(
      goalkeeperBracket?.children[3]?.classList.contains('market-slot-spacer'),
    ).toBe(true);
    expect(
      view.host.shadowRoot?.querySelector('.clean-sheet-probability'),
    ).toBeNull();
    expect(view.host.shadowRoot?.querySelector('.compact')).toBeNull();
    expect(
      view.host.shadowRoot?.querySelector('.panel')?.classList.contains(
        'bracket-only',
      ),
    ).toBe(true);
    view.destroy();
  });

  it.each([
    ['Goalkeeper', ['clean-sheet']],
    ['Defender', ['aa', 'clean-sheet', 'goal', 'assist']],
    ['Midfielder', ['aa', 'goal', 'assist']],
    ['Forward', ['aa', 'goal', 'assist']],
  ] as const)(
    'keeps AA, CS, goal, and assist in fixed vertical slots for %s cards',
    (position, visibleSlots) => {
      const card = document.createElement('article');
      document.body.append(card);
      const view = new OverlayView(
        card,
        { slug: `fixed-slots-${position.toLowerCase()}` },
        position,
      );
      view.render({
        slug: `fixed-slots-${position.toLowerCase()}`,
        displayName: `Fixed Slots ${position}`,
        position,
        aaL10: { value: 12.4, sampleSize: 10 },
        cleanSheetL10: { value: 0.3, sampleSize: 10 },
        goalL10: { value: 0.2, sampleSize: 10 },
        nextGame: {
          date: '2026-07-27T18:45:00.000Z',
          cleanSheetProbability: 0.31,
          marketOdds: {
            source: 'the-odds-api',
            capturedAt: '2026-07-24T12:00:00.000Z',
            goal: { probability: 0.28, bookmakerCount: 2 },
            assist: { probability: 0.17, bookmakerCount: 2 },
          },
        },
        excludedLowCoverage: 0,
      });

      const bracket =
        view.host.shadowRoot?.querySelector<HTMLElement>('.market-bracket');
      const slots = Array.from(bracket?.children ?? []);
      expect(bracket?.dataset.slotLayout).toBe('fixed');
      expect(
        slots.map((slot) => (slot as HTMLElement).dataset.bracketSlot),
      ).toEqual(['aa', 'clean-sheet', 'goal', 'assist']);
      expect(
        slots
          .filter((slot) => !slot.classList.contains('market-slot-spacer'))
          .map((slot) => (slot as HTMLElement).dataset.bracketSlot),
      ).toEqual(visibleSlots);
      expect(
        bracket?.querySelectorAll('.market-cell.market-fold-end'),
      ).toHaveLength(1);

      view.destroy();
    },
  );

  it('moves existing and newly created market brackets to the selected side', () => {
    const firstCard = document.createElement('article');
    const secondCard = document.createElement('article');
    document.body.append(firstCard, secondCard);

    const firstView = new OverlayView(
      firstCard,
      { slug: 'luis-suarez' },
      'Forward',
    );
    expect(firstView.host.dataset.marketBracketSide).toBe('right');

    applyMarketBracketSide('left');
    expect(firstView.host.dataset.marketBracketSide).toBe('left');

    const secondView = new OverlayView(
      secondCard,
      { slug: 'denis-bouanga' },
      'Forward',
    );
    expect(secondView.host.dataset.marketBracketSide).toBe('left');

    applyMarketBracketSide('right');
    expect(firstView.host.dataset.marketBracketSide).toBe('right');
    expect(secondView.host.dataset.marketBracketSide).toBe('right');

    firstView.destroy();
    secondView.destroy();
  });

  it('marks the current MLS AA leader per concrete position with a podium rank', async () => {
    document.body.innerHTML = `
      <article data-testid="football-card" data-position="Midfielder">
        <a href="/football/players/alonso-coello-camarero">Player</a>
      </article>
    `;
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'alonso-coello-camarero',
          displayName: 'Alonso Coello',
          position: 'Midfielder',
          aaL10: { value: 24.09, sampleSize: 10 },
          cleanSheetL10: { value: 0.1, sampleSize: 10 },
          goalL10: { value: 0.2, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    };
    const coordinator = new StatsBatchCoordinator(vi.fn(async () => response), 60_000);
    new SorareCardScanner(coordinator).scan(document);
    await coordinator.flush();

    const host = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    const aa = host?.shadowRoot?.querySelector<HTMLElement>('.aa-percentile');
    expect(aa?.dataset.topRank).toBe('1');
    expect(aa?.dataset.podiumFrame).toBe('gold');
    expect(aa?.querySelector('.aa-market-icon')?.textContent).toBe('#1');
    expect(aa?.querySelector('.aa-market-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(aa?.getAttribute('aria-label')).toContain('Rang 1');
    expect(host?.shadowRoot?.querySelector('.details')).toBeNull();
  });

  it('renders distinct silver and bronze rank badges for places two and three', async () => {
    document.body.innerHTML = `
      <article data-testid="football-card" data-position="Midfielder">
        <a href="/football/players/carles-gil-de-pareja-vicent">Carles Gil</a>
      </article>
      <article data-testid="football-card" data-position="Defender">
        <a href="/football/players/nouhou-tolo">Nouhou Tolo</a>
      </article>
    `;
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'carles-gil-de-pareja-vicent',
          displayName: 'Carles Gil',
          position: 'Midfielder',
          aaL10: { value: 19.4, sampleSize: 10 },
          cleanSheetL10: { value: 0.3, sampleSize: 10 },
          goalL10: { value: 0.1, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
        {
          slug: 'nouhou-tolo',
          displayName: 'Nouhou Tolo',
          position: 'Defender',
          aaL10: { value: 20.86, sampleSize: 10 },
          cleanSheetL10: { value: 0.4, sampleSize: 10 },
          goalL10: { value: 0, sampleSize: 10 },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 2, returned: 2, cacheHits: 0, source: 'sorare' },
    };
    const coordinator = new StatsBatchCoordinator(vi.fn(async () => response), 60_000);
    new SorareCardScanner(coordinator).scan(document);
    await coordinator.flush();

    const silver = document.querySelector<HTMLElement>(
      '[data-sorare-overlay-root][data-player-slug="carles-gil-de-pareja-vicent"]',
    );
    const bronze = document.querySelector<HTMLElement>(
      '[data-sorare-overlay-root][data-player-slug="nouhou-tolo"]',
    );
    expect(silver?.shadowRoot?.querySelector('.aa-percentile')?.getAttribute('data-top-rank')).toBe('2');
    expect(
      silver?.shadowRoot?.querySelector<HTMLElement>('.aa-percentile')?.dataset
        .podiumFrame,
    ).toBe('silver');
    expect(silver?.shadowRoot?.querySelector('.aa-market-icon')?.textContent).toBe('#2');
    expect(bronze?.shadowRoot?.querySelector('.aa-percentile')?.getAttribute('data-top-rank')).toBe('3');
    expect(
      bronze?.shadowRoot?.querySelector<HTMLElement>('.aa-percentile')?.dataset
        .podiumFrame,
    ).toBe('bronze');
    expect(bronze?.shadowRoot?.querySelector('.aa-market-icon')?.textContent).toBe('#3');
  });

  it('batches repeated scroll events into one positioning pass per animation frame', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.body.innerHTML = `
      <article data-testid="card-one"></article>
      <article data-testid="card-two"></article>
    `;
    const cards = [
      document.querySelector<HTMLElement>('[data-testid="card-one"]'),
      document.querySelector<HTMLElement>('[data-testid="card-two"]'),
    ];
    if (cards.some((card) => !card)) throw new Error('Expected performance-test cards');
    const rectSpies = cards.map((card, index) =>
      vi.spyOn(card as HTMLElement, 'getBoundingClientRect').mockReturnValue({
        x: 20 + index * 130,
        y: 100,
        top: 100,
        right: 140 + index * 130,
        bottom: 294,
        left: 20 + index * 130,
        width: 120,
        height: 194,
        toJSON: () => ({}),
      }),
    );
    const views = cards.map(
      (card, index) =>
        new OverlayView(card as HTMLElement, { playerName: `Player ${index + 1}` }),
    );
    rectSpies.forEach((spy) => spy.mockClear());

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(rectSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    frameCallbacks.shift()?.(performance.now());
    expect(rectSpies.map((spy) => spy.mock.calls.length)).toEqual([1, 1]);

    views.forEach((view) => view.destroy());
    vi.unstubAllGlobals();
  });

  it('realigns overlays after Sorare card transitions settle', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.body.innerHTML = `
      <section data-testid="pack-results">
        <div style="view-transition-name: pack-card-0">
          <article data-testid="pack-result-card"></article>
        </div>
      </section>
    `;
    const card = document.querySelector<HTMLElement>(
      '[data-testid="pack-result-card"]',
    );
    const transitionContainer = document.querySelector<HTMLElement>(
      '[style*="view-transition-name"]',
    );
    if (!card || !transitionContainer) {
      throw new Error('Expected pack result transition fixture');
    }
    const rectSpy = vi
      .spyOn(card, 'getBoundingClientRect')
      .mockReturnValue({
        x: 360,
        y: 220,
        top: 220,
        right: 480,
        bottom: 414,
        left: 360,
        width: 120,
        height: 194,
        toJSON: () => ({}),
      });
    const view = new OverlayView(card, { playerName: 'Pack Result Player' });
    rectSpy.mockClear();

    transitionContainer.dispatchEvent(
      new Event('animationend', { bubbles: true }),
    );
    transitionContainer.dispatchEvent(
      new Event('transitionend', { bubbles: true }),
    );

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(rectSpy).not.toHaveBeenCalled();
    frameCallbacks.shift()?.(performance.now());
    expect(rectSpy).toHaveBeenCalledTimes(1);
    expect(view.host.style.left).toBe('364px');
    expect(view.host.style.top).toBe('219px');

    view.destroy();
    vi.unstubAllGlobals();
  });

  it('does not rerun card discovery for repeated visual-only mutations', async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.body.innerHTML = '<main data-testid="virtualized-list"></main>';
    const list = document.querySelector<HTMLElement>('[data-testid="virtualized-list"]');
    if (!list) throw new Error('Expected virtualized list');
    const scanner = new SorareCardScanner();
    const scan = vi.spyOn(scanner, 'scan');
    scanner.start();
    scan.mockClear();

    list.style.transform = 'translateY(10px)';
    list.style.transform = 'translateY(20px)';
    list.style.opacity = '0.99';

    await vi.waitFor(() => expect(requestAnimationFrame).toHaveBeenCalledTimes(1));
    frameCallbacks.shift()?.(performance.now());
    expect(scan).not.toHaveBeenCalled();

    scanner.stop();
    vi.unstubAllGlobals();
  });

  it('requests historical assist windows only after the fallback is enabled', async () => {
    const card = document.createElement('article');
    document.body.append(card);
    const view = new OverlayView(
      card,
      { slug: 'historical-assist-player' },
      'Forward',
    );
    const response: PlayerStatsSuccessResponse = {
      data: [
        {
          slug: 'historical-assist-player',
          displayName: 'Historical Assist Player',
          position: 'Forward',
          aaL10: { value: 12, sampleSize: 10 },
          cleanSheetL10: { value: 0, sampleSize: 10 },
          goalL10: { value: 0.2, sampleSize: 10 },
          historicalGoals: {
            l10: { value: 0.2, sampleSize: 10 },
            l15: { value: 0.4, sampleSize: 15 },
            l40: { value: 0.1, sampleSize: 40 },
          },
          historicalAssists: {
            l10: { value: 0.2, sampleSize: 10 },
            l15: { value: 4 / 15, sampleSize: 15 },
            l40: { value: 0.3, sampleSize: 40 },
          },
          historicalDecisives: {
            l10: { value: 0.3, sampleSize: 10 },
            l15: { value: 0.6, sampleSize: 15 },
            l40: { value: 0.35, sampleSize: 40 },
          },
          nextGame: null,
          excludedLowCoverage: 0,
        },
      ],
      meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
    };
    const fetcher = vi.fn(async () => response);
    const coordinator = new StatsBatchCoordinator(fetcher, 60_000);
    coordinator.setIncludeHistoricalAssists(true);
    coordinator.enqueue(
      {
        slug: 'historical-assist-player',
        position: 'Forward',
        container: card,
      },
      view,
    );

    await coordinator.flush();

    expect(fetcher).toHaveBeenCalledWith({
      slugs: ['historical-assist-player'],
      playerNames: [],
      positions: { 'historical-assist-player': 'Forward' },
      includeHistoricalAssists: true,
    });
    view.destroy();
  });

  it('uses a clearly labelled historical assist value only when market odds are missing', () => {
    document.body.innerHTML = '<article data-testid="football-card"></article>';
    const card = document.querySelector<HTMLElement>('article');
    if (!card) throw new Error('Expected football card');
    const view = new OverlayView(
      card,
      { slug: 'historical-assist-player' },
      'Forward',
    );
    const baseStats = {
      slug: 'historical-assist-player',
      displayName: 'Historical Assist Player',
      position: 'Forward' as const,
      aaL10: { value: 12, sampleSize: 10 },
      cleanSheetL10: { value: 0, sampleSize: 10 },
      goalL10: { value: 0.2, sampleSize: 10 },
      historicalGoals: {
        l10: { value: 0.2, sampleSize: 10 },
        l15: { value: 0.4, sampleSize: 15 },
        l40: { value: 0.1, sampleSize: 40 },
      },
      historicalAssists: {
        l10: { value: 0.2, sampleSize: 10 },
        l15: { value: 4 / 15, sampleSize: 15 },
        l40: { value: 0.3, sampleSize: 37 },
      },
      historicalDecisives: {
        l10: { value: 0.3, sampleSize: 10 },
        l15: { value: 0.6, sampleSize: 15 },
        l40: { value: 0.5, sampleSize: 37 },
      },
      nextGame: {
        date: '2026-07-27T18:45:00.000Z',
        cleanSheetProbability: null,
        matchProbabilities: null,
        marketOdds: {
          source: 'the-odds-api' as const,
          capturedAt: '2026-07-25T12:00:00.000Z',
          goal: null,
          assist: null,
          decisive: null,
        },
      },
      excludedLowCoverage: 0,
    };

    applyHistoricalAssistFallbackSettings(true, 15);
    view.render(baseStats);

    let assist = view.host.shadowRoot?.querySelector<HTMLElement>(
      '[data-market="assist"]',
    );
    expect(assist?.textContent).toBe('(27%)');
    expect(assist?.dataset.source).toBe('historical');
    expect(assist?.dataset.window).toBe('L15');
    expect(assist?.dataset.benchmarkSource).toBe('historical');
    expect(assist?.dataset.tone).toBe('elite');
    expect(assist?.getAttribute('aria-label')).toBe(
      'Historischer Assist L15: 27 Prozent, n=15; keine Marktquote',
    );
    let goal = view.host.shadowRoot?.querySelector<HTMLElement>(
      '[data-market="goal"]',
    );
    expect(goal?.textContent).toBe('(40%)');
    expect(goal?.dataset.source).toBe('historical');
    expect(goal?.dataset.benchmarkSource).toBe('historical');
    expect(goal?.dataset.tone).toBe('elite');
    expect(goal?.getAttribute('aria-label')).toBe(
      'Historisches Tor L15: 40 Prozent, n=15; keine Marktquote',
    );
    expect(view.host.shadowRoot?.querySelector('.player-market-tooltip')?.textContent)
      .toContain('Assist · historisch L15');
    expect(view.host.shadowRoot?.querySelector('.player-market-tooltip')?.textContent)
      .toContain('Tor · historisch L15');
    expect(view.host.shadowRoot?.querySelector('.player-market-tooltip')?.textContent)
      .toContain('Keine Marktquote');
    expect(view.host.shadowRoot?.querySelector('.player-market-tooltip')?.textContent)
      .toContain('27% · n=15');
    expect(view.host.shadowRoot?.querySelector('.decisive-probability')).toBeNull();

    applyMarketValueFormat('decimal');
    view.render(baseStats);
    assist = view.host.shadowRoot?.querySelector<HTMLElement>(
      '[data-market="assist"]',
    );
    goal = view.host.shadowRoot?.querySelector<HTMLElement>(
      '[data-market="goal"]',
    );
    expect(assist?.textContent).toBe('(3,75)');
    expect(goal?.textContent).toBe('(2,50)');
    expect(assist?.getAttribute('aria-label')).toContain(
      'faire Dezimalquote 3,75',
    );
    expect(view.host.dataset.marketValueFormat).toBe('decimal');

    applyMarketValueFormat('percentage');
    applyHistoricalAssistFallbackSettings(true, 40);
    view.render(baseStats);
    assist = view.host.shadowRoot?.querySelector<HTMLElement>(
      '[data-market="assist"]',
    );
    expect(assist?.textContent).toBe('(30%)');
    expect(assist?.dataset.window).toBe('L40');
    goal = view.host.shadowRoot?.querySelector<HTMLElement>(
      '[data-market="goal"]',
    );
    expect(goal?.textContent).toBe('(10%)');

    view.render({
      ...baseStats,
      nextGame: {
        ...baseStats.nextGame,
        marketOdds: {
          ...baseStats.nextGame.marketOdds,
          goal: { probability: 0.34, bookmakerCount: 3 },
          assist: { probability: 0.18, bookmakerCount: 2 },
          decisive: { probability: 0.55, bookmakerCount: 2 },
        },
      },
    });
    assist = view.host.shadowRoot?.querySelector<HTMLElement>(
      '[data-market="assist"]',
    );
    expect(assist?.textContent).toBe('18%');
    expect(assist?.dataset.source).toBeUndefined();
    expect(assist?.dataset.benchmarkSource).toBe('market');
    expect(assist?.dataset.tone).toBe('balanced');
    expect(assist?.getAttribute('aria-label')).toBe(
      'Assist: 18 Prozent, 2 Buchmacher',
    );
    goal = view.host.shadowRoot?.querySelector<HTMLElement>(
      '[data-market="goal"]',
    );
    expect(goal?.textContent).toBe('34%');
    expect(goal?.dataset.source).toBeUndefined();

    applyMarketValueFormat('decimal');
    view.render({
      ...baseStats,
      nextGame: {
        ...baseStats.nextGame,
        marketOdds: {
          ...baseStats.nextGame.marketOdds,
          goal: { probability: 0.34, bookmakerCount: 3 },
          assist: { probability: 0.18, bookmakerCount: 2 },
        },
      },
    });
    expect(
      view.host.shadowRoot?.querySelector<HTMLElement>(
        '[data-market="goal"]',
      )?.textContent,
    ).toBe('2,94');
    expect(
      view.host.shadowRoot?.querySelector<HTMLElement>(
        '[data-market="assist"]',
      )?.textContent,
    ).toBe('5,56');

    view.destroy();
  });
});
