import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';

export function assertCompatibilityDate(configured, supported) {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(configured ?? '') || !isoDate.test(supported ?? '') || configured > supported) {
    throw new Error(`Worker test runtime supports ${supported}, but production requires ${configured}. Update the test runtime; do not lower the production date.`);
  }
}

export function checkWorkerCompatibility() {
  // Resolve through the testpool, not an unrelated hoisted Wrangler runtime.
  const poolRequire = createRequire(import.meta.resolve('@cloudflare/vitest-pool-workers'));
  const miniflareRequire = createRequire(poolRequire.resolve('miniflare'));
  const runtime = miniflareRequire('workerd');
  const config = parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assertCompatibilityDate(config.compatibility_date, runtime.compatibilityDate);
  return {configured:config.compatibility_date,supported:runtime.compatibilityDate,version:runtime.version};
}
