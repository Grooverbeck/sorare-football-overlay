import { describe, expect, it, vi } from 'vitest';
import { overlayPage, OverlayVisibilityController } from '../overlay-visibility.js';

describe('overlay page visibility', () => {
  it.each([
    ['/de/football/series/squad/lineups/BoardStep%3A123','squad'],
    ['/football/series/squad','squad'],
    ['/de/football/my-club/squads/contender','squad'],
    ['/football/series/123/squad-selection','squad'],
    ['/de/football/series/123/lineups','lineups'],
    ['/football/lineups/123/performance','lineups'],
    ['/football/series/squad/compose/123','other'],
    ['/football/series/123/compose-team','other'],
    ['/football/lineups/123/compose-team/456','other'],
    ['/football/players/squad-player','other'],
    ['/football/series/my-club/squad-collectors','other'],
    ['/football/lineups-extra','other'],
    ['/baseball/squad','other'],
  ])('classifies %s as %s', (path, expected) => {
    expect(overlayPage(path)).toBe(expected);
  });

  it('switches immediately between hidden overview and visible builder without repeated starts', () => {
    let path = '/football/series/123/lineups';
    const apply = vi.fn();
    const controller = new OverlayVisibilityController(() => path,apply);
    controller.initialize({enabled:true,squad:true,lineups:true});
    controller.update({lineups:false});
    controller.refresh();
    path = '/football/series/123/compose-team';
    controller.refresh();
    path = '/football/series/123/lineups';
    controller.refresh();
    expect(apply.mock.calls.map(([active])=>active)).toEqual([true,false,true,false]);
  });

  it('keeps Squad lineups independent and gives the global switch precedence', () => {
    const apply = vi.fn();
    const controller = new OverlayVisibilityController(() => '/football/series/squad/lineups/step',apply);
    controller.initialize({enabled:true,squad:true,lineups:false});
    controller.update({squad:false});
    controller.update({enabled:false,squad:true});
    controller.update({enabled:true});
    expect(apply.mock.calls.map(([active])=>active)).toEqual([true,false,true]);
  });

  it('does not flash the overlay before settings load or overwrite a newer toggle', () => {
    const apply = vi.fn();
    const controller = new OverlayVisibilityController(() => '/football/lineups/123',apply);
    controller.refresh();
    controller.update({lineups:false});
    controller.initialize({enabled:true,squad:true,lineups:true});
    expect(apply).not.toHaveBeenCalled();
    controller.update({lineups:true});
    expect(apply).toHaveBeenCalledExactlyOnceWith(true);
  });
});
