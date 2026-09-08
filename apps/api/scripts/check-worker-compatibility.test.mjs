import { expect, it } from 'vitest';
import { assertCompatibilityDate, checkWorkerCompatibility } from './check-worker-compatibility.mjs';

it('fails instead of silently testing an older compatibility date', () => {
  expect(() => assertCompatibilityDate('2026-07-25','2026-03-10')).toThrow('Update the test runtime');
  expect(() => assertCompatibilityDate(undefined,'2026-08-15')).toThrow();
  expect(() => assertCompatibilityDate('2026-07-25','2026-07-25')).not.toThrow();
});
it('resolves the runtime actually used by the Worker testpool', () => {
  const result = checkWorkerCompatibility();
  expect(result.supported >= result.configured).toBe(true);
});
