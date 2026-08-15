import { describe, expect, it } from 'vitest';
import { supportsCompactViewPath } from '../compact-view-route.js';

describe('Compact View route scope', () => {
  it('supports squad and lineups routes', () => {
    expect(
      supportsCompactViewPath('/de/football/my-club/squads/contender'),
    ).toBe(true);
    expect(
      supportsCompactViewPath('/de/football/lineups/123/performance'),
    ).toBe(true);
    expect(
      supportsCompactViewPath('/de/football/series/123/squad-selection'),
    ).toBe(true);
  });

  it('keeps compose-team and unrelated routes fully expanded', () => {
    expect(
      supportsCompactViewPath('/de/football/series/123/compose-team/456'),
    ).toBe(false);
    expect(
      supportsCompactViewPath('/de/football/lineups/123/compose-team/456'),
    ).toBe(false);
    expect(supportsCompactViewPath('/de/football/players')).toBe(false);
  });
});
