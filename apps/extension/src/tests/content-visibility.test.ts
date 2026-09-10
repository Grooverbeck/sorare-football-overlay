import { afterEach, expect, it, vi } from 'vitest';
import { SQUAD_OVERLAY_ENABLED_KEY, LINEUPS_OVERLAY_ENABLED_KEY, OVERLAY_ENABLED_KEY } from '../settings.js';

const scanner = vi.hoisted(() => ({start:vi.fn(),stop:vi.fn(),configureHistoricalAssistFallback:vi.fn(),refreshAllOverlays:vi.fn(),refreshRememberedCardPictures:vi.fn()}));
vi.mock('../scanner.js', () => ({SorareCardScanner:class {
  start = scanner.start;
  stop = scanner.stop;
  configureHistoricalAssistFallback = scanner.configureHistoricalAssistFallback;
  refreshAllOverlays = scanner.refreshAllOverlays;
  refreshRememberedCardPictures = scanner.refreshRememberedCardPictures;
}}));
afterEach(() => vi.unstubAllGlobals());

it('starts and stops the actual content-script scanner on settings and SPA route changes', async () => {
  window.history.replaceState({},'', '/football/series/squad/lineups/step');
  const mutations: Array<() => void> = [];
  vi.stubGlobal('MutationObserver',class {constructor(callback:()=>void){mutations.push(callback);}observe(){}disconnect(){}});
  let changed!: (changes: Record<string,{newValue:boolean}>, area:string) => void;
  vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async defaults=>defaults)},onChanged:{addListener:(fn:typeof changed)=>{changed=fn;}}}});
  await import('../content.js');
  await vi.waitFor(() => expect(scanner.start).toHaveBeenCalledTimes(1));
  changed({[SQUAD_OVERLAY_ENABLED_KEY]:{newValue:false}},'local');
  expect(scanner.stop).toHaveBeenCalledTimes(1);
  window.history.replaceState({},'', '/football/series/step/lineups');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(scanner.start).toHaveBeenCalledTimes(2);
  changed({[LINEUPS_OVERLAY_ENABLED_KEY]:{newValue:false}},'local');
  expect(scanner.stop).toHaveBeenCalledTimes(2);
  window.history.replaceState({},'', '/football/series/squad/compose/step');
  mutations.forEach(callback=>callback());
  expect(scanner.start).toHaveBeenCalledTimes(3);
  changed({[OVERLAY_ENABLED_KEY]:{newValue:false}},'local');
  expect(scanner.stop).toHaveBeenCalledTimes(3);
  changed({[SQUAD_OVERLAY_ENABLED_KEY]:{newValue:true}},'local');
  expect(scanner.start).toHaveBeenCalledTimes(3);
  changed({[OVERLAY_ENABLED_KEY]:{newValue:true}},'local');
  expect(scanner.start).toHaveBeenCalledTimes(4);
});
