import { normalizeTeamName, normalizePlayerName, playerIdentityMatchScore } from '../../src/providers/market-odds-provider.ts';

export const LEAGUES = ['premier-league-gb-eng', 'bundesliga-de', 'laliga-es', 'ligue-1-fr'];
export const POSITIONS = ['Defender', 'Midfielder', 'Forward'];
export const PERCENTILES = [.2, .4, .6, .8, .9];

export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function summarize(rows) {
  return Object.fromEntries(['goal', 'assist'].map(market => [market,
    Object.fromEntries(POSITIONS.map(position => {
      const sample = rows.filter(row => row.market === market && row.position === position);
      const values = sample.map(row => row.probability);
      return [position, {
        samples: sample.length,
        players: new Set(sample.map(row => row.slug)).size,
        fixtures: new Set(sample.map(row => row.fixture).filter(Boolean)).size,
        byLeague: Object.fromEntries(LEAGUES.map(league => [league, sample.filter(row => row.league === league).length])),
        raw: PERCENTILES.map(p => quantile(values, p)),
        // 0.5 percentage-point cut points avoid excessive precision while
        // retaining small but meaningful defender goal bands.
        rounded: PERCENTILES.map(p => {
          const q = quantile(values, p);
          return q === null ? null : Math.round(q * 200) / 200;
        }),
      }];
    })),
  ]));
}

export function buildRoster(exports) {
  const all = new Map();
  for (const data of exports) {
    if (!data.complete || !LEAGUES.includes(data.league)) throw new Error('Incomplete or unsupported roster');
    for (const player of data.players) {
      const club = player.activeClub;
      if (!club || club.domesticLeague?.slug !== data.league) continue;
      const common = player.commonPlayer;
      // Use actual common-card positions. Never infer a Set card from a Pro
      // position, and never assign an old common-card team to a new club.
      if (!common || common.anyTeam?.slug !== club.slug) continue;
      const positions = [...new Set(common.positions)].filter(p => POSITIONS.includes(p));
      if (!positions.length) continue;
      const current = { ...player, positions, league: data.league };
      const old = all.get(player.slug);
      if (old && (old.activeClub.slug !== club.slug || old.league !== data.league)) throw new Error('Conflicting roster identity');
      all.set(player.slug, current);
    }
  }
  return all;
}

export function teamIndex(roster, fixtureRows) {
  const index = new Map(), clubs = new Set([...roster.values()].map(p => p.activeClub.slug));
  const add = (name, slug) => {
    if (!name || !clubs.has(slug)) return;
    const key = normalizeTeamName(name);
    const ids = index.get(key) ?? new Set();
    ids.add(slug); index.set(key, ids);
  };
  for (const p of roster.values()) {
    add(p.activeClub.name, p.activeClub.slug);
    add(p.activeClub.shortName, p.activeClub.slug);
  }
  for (const { value } of fixtureRows) {
    const game = value.nextGame;
    if (!game) continue;
    add(game.homeTeamName, game.homeTeamSlug);
    add(game.awayTeamName, game.awayTeamSlug);
  }
  return name => {
    const slugs = index.get(normalizeTeamName(name));
    return slugs?.size === 1 ? [...slugs][0] : null;
  };
}

export function resolvePlayer(name, candidates) {
  const scored = candidates.map(player => ({ player, score: playerIdentityMatchScore(player, name) }))
    .filter(candidate => candidate.score >= 80).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === scored[1]?.score) return null;
  return scored[0].player;
}

export function deriveMarkets(cache, roster, { from, to, maxLeadHours = 72 }) {
  const lookupTeam = teamIndex(roster, cache.groups.fixtures);
  const selected = new Map(), conflicts = new Map(), rejected = {}, unresolved = new Set();
  const reject = reason => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  for (const row of cache.groups.markets) {
    const key = decodeURIComponent(row.cache_key);
    const match = key.match(/^market-odds:v1:odds-api-io\|([^|]+)\|([^|]+)\|([^:]+):(player_assists|player_goal_scorer_anytime)$/);
    if (!match) continue;
    const [, date, homeName, awayName, marketKey] = match;
    const kick = Date.parse(date), capture = Date.parse(row.value.capturedAt);
    if (!Number.isFinite(kick) || kick < Date.parse(from) || kick >= Date.parse(to)) continue;
    if (!Number.isFinite(capture) || capture > kick || kick - capture > maxLeadHours * 3600000) { reject('captureOutsidePrematchWindow'); continue; }
    const home = lookupTeam(homeName), away = lookupTeam(awayName);
    if (!home || !away || home === away) { reject('unknownOrAmbiguousTeams'); continue; }
    const candidates = [...roster.values()].filter(p => p.activeClub.slug === home || p.activeClub.slug === away);
    const leagues = new Set(candidates.map(p => p.league));
    if (leagues.size !== 1) { reject('crossLeagueFixture'); continue; }
    const market = marketKey === 'player_assists' ? 'assist' : 'goal';
    const fixture = `${new Date(kick).toISOString()}|${home}|${away}`;
    for (const [name, value] of Object.entries(row.value.players)) {
      // One consistent probability convention: Odds.io / Bet365 1/decimal.
      // No SGO fair odds, provider medians or synthetic score-or-assist values.
      const quotes = value.bookmakerQuotes?.filter(q => normalizePlayerName(q.title) === 'bet365');
      if (quotes?.length !== 1) { reject('noUniqueBet365Quote'); continue; }
      const quote = quotes[0], price = quote.decimalOdds;
      if (!Number.isFinite(price) || price <= 1 || !Number.isFinite(quote.probability) ||
        Math.abs(quote.probability - 1 / price) > 1e-7) { reject('inconsistentProbability'); continue; }
      const player = resolvePlayer(name, candidates);
      if (!player) { unresolved.add(`${fixture}|${name}`); continue; }
      for (const position of player.positions) {
        const sample = { fixture, date, capturedAt: row.value.capturedAt, slug: player.slug, displayName: player.displayName,
          position, market, league: player.league, team: player.activeClub.slug, probability: quote.probability };
        const id = `${fixture}|${player.slug}|${position}|${market}`;
        const previous = selected.get(id);
        if ((conflicts.get(id) ?? -Infinity) >= capture) continue;
        if (previous && Date.parse(previous.capturedAt) === capture && Math.abs(previous.probability - sample.probability) > 1e-7) {
          selected.delete(id); conflicts.set(id, capture); reject('conflictingAliasPrices'); continue;
        }
        // Latest pre-match capture wins; aliases and provider rows never vote twice.
        if (!previous || Date.parse(previous.capturedAt) < capture) selected.set(id, sample);
      }
    }
  }
  return { rows: [...selected.values()], rejected, unresolved: [...unresolved].sort() };
}

export function deriveHistory(cache, roster, minimumSample = 20) {
  const selected = new Map();
  for (const row of cache.groups.forms) {
    const form = row.value, player = roster.get(form.slug);
    if (!player || !player.positions.includes(form.position) || !row.cache_key.endsWith(':no-low')) continue;
    for (const market of ['goal', 'assist']) {
      const version = market === 'goal' ? form.historicalGoalPlayerScopeVersion : form.historicalAssistPlayerScopeVersion;
      const metric = (market === 'goal' ? form.historicalGoals : form.historicalAssists)?.l40;
      if (version !== 1 || !metric || metric.sampleSize < minimumSample || metric.sampleSize > 40 ||
        typeof metric.value !== 'number' || !Number.isFinite(metric.value) || metric.value < 0 || metric.value > 1) continue;
      const id = `${form.slug}|${form.position}|${market}`, old = selected.get(id);
      if (!old || row.updated_at > old.updatedAt) selected.set(id, {
        slug: form.slug, displayName: form.displayName, position: form.position, market, league: player.league,
        probability: metric.value, sampleSize: metric.sampleSize, updatedAt: row.updated_at,
      });
    }
  }
  return [...selected.values()];
}

export function deriveHistorySample(sample, roster, minimumSample = 20) {
  if (!sample.complete) throw new Error('Historical calibration requires a complete sample');
  const selected = new Set(sample.selection.map(row => `${row.slug}|${row.position}`));
  if (selected.size !== sample.selection.length) throw new Error('Duplicate history selection');
  const seen = new Set(), rows = [];
  for (const player of sample.rows) {
    const identity = `${player.slug}|${player.position}`;
    if (!selected.has(identity) || seen.has(identity)) throw new Error('Unexpected or duplicate history identity');
    seen.add(identity);
    const current = roster.get(player.slug);
    if (!current?.positions.includes(player.position) || current.league !== player.league) throw new Error('History roster mismatch');
    for (const market of ['goal', 'assist']) {
      const metric = (market === 'goal' ? player.historicalGoals : player.historicalAssists)?.l40;
      if (!metric || metric.sampleSize < minimumSample || metric.sampleSize > 40 ||
        typeof metric.value !== 'number' || !Number.isFinite(metric.value) || metric.value < 0 || metric.value > 1) continue;
      rows.push({ slug: player.slug, position: player.position, league: player.league,
        market, probability: metric.value, sampleSize: metric.sampleSize });
    }
  }
  if (seen.size !== selected.size) throw new Error('History sample is missing selected players');
  return rows;
}
