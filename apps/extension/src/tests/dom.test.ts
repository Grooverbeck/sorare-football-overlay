import type { PlayerStatsRequest, PlayerStatsSuccessResponse } from '@sorare-overlay/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPlayerSlug, findCardTargets } from '../dom.js';
import { OverlayView } from '../overlay.js';
import { SorareCardScanner, StatsBatchCoordinator } from '../scanner.js';

describe('Sorare card DOM discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
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

  it('replaces Fernández-Mercau\'s default stats when MF loads later beside the profile link', async () => {
    window.history.replaceState({}, '', '/football/players/nicolas-fernandez-mercau');
    document.body.innerHTML = `
      <section data-testid="player-profile-header">
        <div data-testid="player-position"></div>
        <div class="player-title">
          <a href="/football/players/nicolas-fernandez-mercau">Nicolás Fernández-Mercau</a>
        </div>
      </section>
    `;
    const fetcher = vi.fn(async (request: PlayerStatsRequest): Promise<PlayerStatsSuccessResponse> => {
      const isMidfielder = request.positions?.['nicolas-fernandez-mercau'] === 'Midfielder';
      return {
        data: [
          {
            slug: 'nicolas-fernandez-mercau',
            displayName: 'Nicolás Fernández-Mercau',
            position: isMidfielder ? 'Midfielder' : 'Defender',
            aaL10: { value: isMidfielder ? 15.13 : 8.4, sampleSize: 10 },
            cleanSheetL10: { value: 0.2, sampleSize: 10 },
            goalL10: { value: 0.1, sampleSize: 10 },
            nextGame: null,
            excludedLowCoverage: 0,
          },
        ],
        meta: { requested: 1, returned: 1, cacheHits: 0, source: 'sorare' },
      };
    });
    const coordinator = new StatsBatchCoordinator(fetcher, 0);
    const scanner = new SorareCardScanner(coordinator);
    scanner.start();
    await coordinator.flush();

    let host = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(host?.dataset.position).toBe('Defender');
    expect(host?.shadowRoot?.querySelector('.compact-value')?.textContent).toBe('8.4');

    const position = document.querySelector<HTMLElement>('[data-testid="player-position"]');
    if (!position) throw new Error('Expected profile position container');
    position.setAttribute('aria-label', 'Kartenposition');
    position.textContent = 'MF';

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await coordinator.flush();
    host = document.querySelector<HTMLElement>('[data-sorare-overlay-root]');
    expect(fetcher).toHaveBeenLastCalledWith({
      slugs: ['nicolas-fernandez-mercau'],
      playerNames: [],
      positions: { 'nicolas-fernandez-mercau': 'Midfielder' },
    });
    expect(host?.dataset.position).toBe('Midfielder');
    expect(host?.shadowRoot?.querySelector('.compact-value')?.textContent).toBe('15.1');
    scanner.stop();
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

  it('shows home, draw, and away probabilities below the team row in the lineup builder', async () => {
    window.history.replaceState(
      {},
      '',
      '/de/football/series/test-series/compose-team',
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
    const bar = companion?.shadowRoot?.querySelector<HTMLElement>('.lineup-odds-bar');
    expect(companion?.hidden).toBe(false);
    expect(teamRow.nextElementSibling).toBe(companion);
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
    expect(document.querySelectorAll('[data-sorare-overlay-root]')).toHaveLength(1);
    expect(
      document.querySelectorAll('[data-sorare-overlay-companion="lineup-odds"]'),
    ).toHaveLength(1);
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
    expect(host?.shadowRoot?.textContent).toContain('Goal L10');
    expect(host?.shadowRoot?.textContent).toContain('25%');
    expect(
      host?.shadowRoot?.querySelector('.win-probability .compact-label')?.textContent,
    ).toBe('NEXT W%');
    const winProbability =
      host?.shadowRoot?.querySelector<HTMLElement>('.win-probability');
    expect(winProbability?.dataset.tone).toBe('good');
    expect(winProbability?.dataset.percentileBand).toBe('P60–80');
    document.querySelector('button')?.dispatchEvent(new MouseEvent('mouseenter'));
    const odds = host?.shadowRoot?.querySelector<HTMLElement>('.odds');
    expect(odds?.querySelector('.detail-label')?.textContent).toBe('Quoten');
    expect(odds?.textContent).toContain('H 48%');
    expect(odds?.textContent).toContain('D 27%');
    expect(odds?.textContent).toContain('A 25%');
    expect(
      odds?.querySelector('.odds-outcome[data-player-team-odd="true"]')?.textContent,
    ).toBe('H 48%');
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
    expect(host?.shadowRoot?.querySelector('.compact-value')?.textContent).toBe('5.4');
    expect(host?.shadowRoot?.textContent).not.toContain('Keine L10-Daten');
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
    expect(hosts[0]?.shadowRoot?.textContent).toContain('CS L10');
    expect(hosts[0]?.shadowRoot?.textContent).toContain('50%');
    const compactAa = hosts[0]?.shadowRoot?.querySelector<HTMLElement>('.compact-stat');
    expect(compactAa?.querySelector('.compact-label')?.textContent).toBe('AA L10');
    expect(compactAa?.querySelector('.compact-value')?.textContent).toBe('9.0');
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
    expect(host?.style.bottom).toBe(`${window.innerHeight - 200 + 1}px`);

    button.style.opacity = '0';
    await vi.waitFor(() => expect(host?.style.display).toBe('none'));
    scanner.stop();
  });

  it('moves an expanded large-card tooltip sideways when it would cross the viewport top', () => {
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
    vi.spyOn(view.host, 'getBoundingClientRect').mockImplementation(() => ({
      x: 404,
      y: view.host.dataset.expanded === 'true' ? -62 : 20,
      top: view.host.dataset.expanded === 'true' ? -62 : 20,
      right: 696,
      bottom: view.host.dataset.expanded === 'true' ? 38 : 39,
      left: 404,
      width: 292,
      height: view.host.dataset.expanded === 'true' ? 100 : 19,
      toJSON: () => ({}),
    }));

    card.dispatchEvent(new MouseEvent('mouseenter'));

    expect(view.host.dataset.placement).toBe('expanded-left');
    expect(view.host.style.left).toBe('100px');
    expect(view.host.style.top).toBe('40px');
    expect(view.host.style.bottom).toBe('');

    card.dispatchEvent(new MouseEvent('mouseleave'));
    expect(view.host.dataset.placement).toBe('above');
    expect(view.host.style.left).toBe('404px');
    expect(view.host.style.top).toBe('');
    expect(view.host.style.bottom).toBe(`${window.innerHeight - 40 + 1}px`);
    view.destroy();
  });

  it('keeps an expanded tooltip above the card when it fits without the optional margin', () => {
    document.body.innerHTML = `
      <article data-testid="football-card">
        <a href="/football/players/chris-brady">Chris Brady</a>
      </article>
    `;
    const card = document.querySelector<HTMLElement>('article');
    if (!card) throw new Error('Expected player card');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 166,
      y: 132,
      top: 132,
      right: 276,
      bottom: 310,
      left: 166,
      width: 110,
      height: 178,
      toJSON: () => ({}),
    });
    const view = new OverlayView(
      card,
      { slug: 'chris-brady' },
      'Goalkeeper',
    );
    view.render({
      slug: 'chris-brady',
      displayName: 'Chris Brady',
      position: 'Goalkeeper',
      aaL10: { value: 8.2, sampleSize: 10 },
      cleanSheetL10: { value: 0.2, sampleSize: 10 },
      goalL10: { value: 0, sampleSize: 10 },
      nextGame: null,
      excludedLowCoverage: 0,
    });
    vi.spyOn(view.host, 'getBoundingClientRect').mockImplementation(() => ({
      x: 137,
      y: view.host.dataset.expanded === 'true' ? 3 : 112,
      top: view.host.dataset.expanded === 'true' ? 3 : 112,
      right: view.host.dataset.expanded === 'true' ? 305 : 272,
      bottom: 131,
      left: view.host.dataset.expanded === 'true' ? 137 : 170,
      width: view.host.dataset.expanded === 'true' ? 168 : 102,
      height: view.host.dataset.expanded === 'true' ? 128 : 19,
      toJSON: () => ({}),
    }));

    card.dispatchEvent(new MouseEvent('mouseenter'));

    expect(view.host.dataset.placement).toBe('above');
    expect(view.host.style.left).toBe('137px');
    expect(view.host.style.width).toBe('168px');
    expect(view.host.style.top).toBe('');
    expect(view.host.style.bottom).toBe(`${window.innerHeight - 132 + 1}px`);

    card.dispatchEvent(new MouseEvent('mouseleave'));
    expect(view.host.style.left).toBe('170px');
    expect(view.host.style.width).toBe('102px');
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
    expect(packOverlay?.dataset.placement).toBe('pack-status-above');
    expect(packOverlay?.style.top).toBe('');
    expect(packOverlay?.style.bottom).toBe(`${window.innerHeight - 165 + 10}px`);

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
    expect(overlay?.dataset.placement).toBe('pack-status-above');
    expect(overlay?.style.top).toBe('');
    expect(overlay?.style.bottom).toBe(`${window.innerHeight - 136 + 10}px`);
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
    expect(overlay?.dataset.placement).toBe('pack-safe-above');
    expect(overlay?.style.top).toBe('');
    expect(overlay?.style.bottom).toBe(`${window.innerHeight - 160 + 24}px`);
  });

  it.each([
    { bonusPercent: 5, bonusTop: 145, expectedAnchorTop: 138 },
    { bonusPercent: 10, bonusTop: 130, expectedAnchorTop: 130 },
  ])(
    'places a +$bonusPercent% special-edition overlay above the upper visible decision hint',
    async ({ bonusPercent, bonusTop, expectedAnchorTop }) => {
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
    expect(overlay?.dataset.placement).toBe('pack-status-above');
    expect(overlay?.style.top).toBe('');
    expect(overlay?.style.bottom).toBe(
      `${window.innerHeight - expectedAnchorTop + 10}px`,
    );
    },
  );

  it('inserts one Shadow DOM overlay and renders returned stats', async () => {
    document.body.innerHTML = `
      <article data-testid="football-card" data-position="Defender">
        <a href="/football/players/virgil-van-dijk">Player</a>
        <a href="/football/players/virgil-van-dijk/cards">Cards</a>
      </article>
    `;
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
    expect(hosts[0]?.style.top).toBe('');
    expect(hosts[0]?.dataset.expanded).toBe('false');
    const compactStats = hosts[0]?.shadowRoot?.querySelectorAll<HTMLElement>('.compact-stat');
    expect(compactStats?.[0]?.querySelector('.compact-label')?.textContent).toBe('AA L10');
    expect(compactStats?.[0]?.querySelector('.compact-value')?.textContent).toBe('14.2');
    expect(compactStats?.[0]?.dataset.tone).toBe('strong');
    expect(compactStats?.[0]?.dataset.percentileBand).toBe('P80–90');
    expect(compactStats?.[0]?.querySelector('.performance-scale')).toBeNull();
    document.querySelector('article')?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(hosts[0]?.dataset.expanded).toBe('true');
    document.querySelector('article')?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(hosts[0]?.dataset.expanded).toBe('false');
    expect(hosts[0]?.shadowRoot?.textContent).toContain('CS L10');
    expect(hosts[0]?.shadowRoot?.textContent).toContain('50%');
    expect(hosts[0]?.shadowRoot?.textContent).toContain('n=8');
    const details = hosts[0]?.shadowRoot?.querySelector<HTMLElement>('.details');
    expect(details?.querySelector('.detail-row')?.classList.contains('odds')).toBe(true);
    expect(details?.textContent).toContain('AA-Rang vs MLS DEF');
    expect(details?.textContent).toContain('P80–90');
    expect(details?.textContent).not.toContain('Nächstes Spiel');
    expect(details?.textContent).not.toContain('Next CS');
    expect(details?.textContent).toContain('Low Coverage');
    expect(details?.textContent).toContain('1 ausgeschlossen');
    expect(details?.textContent).not.toContain('14.2');
    const cleanSheetBadge =
      hosts[0]?.shadowRoot?.querySelector<HTMLElement>('.clean-sheet-probability');
    expect(cleanSheetBadge?.querySelector('.compact-label')?.textContent).toBe('NEXT CS%');
    expect(cleanSheetBadge?.querySelector('.compact-value')?.textContent).toBe('47');
    expect(cleanSheetBadge?.dataset.tone).toBe('elite');
    expect(cleanSheetBadge?.dataset.percentileBand).toBe('P90–100');
    expect(cleanSheetBadge?.querySelector('.performance-scale')).toBeNull();
    expect(details?.textContent).toContain('H 25%');
    expect(details?.textContent).toContain('D 27%');
    expect(details?.textContent).toContain('A 48%');
    expect(details?.querySelector('.fixture-line')?.textContent).toBe(
      'Arsenal–Liverpool',
    );
    expect(
      details?.querySelector('.fixture-team[data-player-team="true"]')?.textContent,
    ).toBe('Liverpool');
    expect(
      details?.querySelector('.player-team-context'),
    ).toBeNull();
    expect(
      details?.querySelector('.player-team-badge'),
    ).toBeNull();
    expect(
      details?.querySelector('.player-team-name'),
    ).toBeNull();
    expect(
      details
        ?.querySelector<HTMLElement>('.fixture-team[data-player-team="false"]')
        ?.textContent,
    ).toBe('Arsenal');
    expect(
      details?.querySelector('.odds-outcome[data-player-team-odd="true"]')?.textContent,
    ).toBe('A 48%');
    expect(
      details?.querySelector('.odds-outcome[data-player-team-odd="false"].odd-loss')
        ?.textContent,
    ).toBe('H 25%');
    expect(details?.querySelector('.odds .detail-label')?.textContent).toBe('Quoten');
    expect(fetcher).toHaveBeenCalledTimes(1);
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
    expect(aa?.querySelector('.top-rank-badge')?.textContent).toBe('#1');
    expect(aa?.querySelector('.top-rank-badge')?.getAttribute('aria-hidden')).toBe('true');
    expect(aa?.getAttribute('aria-label')).toContain('Rang 1');

    document.querySelector('article')?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(host?.shadowRoot?.querySelector('.aa-rank')?.textContent).toContain('#1');
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
    expect(silver?.shadowRoot?.querySelector('.top-rank-badge')?.textContent).toBe('#2');
    expect(bronze?.shadowRoot?.querySelector('.aa-percentile')?.getAttribute('data-top-rank')).toBe('3');
    expect(bronze?.shadowRoot?.querySelector('.top-rank-badge')?.textContent).toBe('#3');
  });
});
