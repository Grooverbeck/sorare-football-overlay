# Shared Set-card identities

The extension can encounter a Sorare video/foil card with only a `cardsamplepicture` UUID and no player name/link. Local DOM learning is retained, but an unknown picture no longer requires a card-details click when it is in the shared catalogue.

## Trust boundary

- `POST /api/card-identities` accepts 1–100 picture UUIDs, **not** client-provided player mappings, card names, owners or collections.
- The handler only reads D1; it does not fetch Sorare or bookmaker data. It returns verified `{pictureId, playerSlug}` pairs and a five-minute retry interval for misses.
- Only the catalogue builder writes shared identities. Evidence is a public Sorare `cardsWhere` response tying an official HTTPS asset URL to the requested player and current Set edition. No user session/cookies are used.
- Picture/slug conflicts are quarantined. No card position, team, AA or odds are copied from the catalogue; normal card-position and stats logic still applies.

## Discovery and bounds

The current Set supplies its season, competitions and edition names. Players are discovered from paginated competition rosters. A first sample reads up to 50 common cards per player; missing official editions are then queried separately, up to five copies each. This avoids walking every minted copy.

Cron `*/5 * * * *` advances at most eight Sorare queries, with no upstream retries and a 60-second slice budget. A two-minute D1 lease and token-fenced atomic picture/progress writes prevent concurrent/stale cron runs from overwriting progress. Errors preserve the last successful checkpoint and known identities. A completed pass rests for a day; Set metadata is rechecked daily. Old picture mappings are kept across Set changes.

This is a bounded discovery catalogue, not a claim that every newly minted image is present instantly. Very rare/new images, transferred players outside the current Set competitions, or multiple image revisions under one edition can remain unknown until discovered. A missing mapping is never guessed from the club or nearby card.

## Extension

The existing scoped scanner collects unknown single-picture containers. The lookup coordinator coalesces duplicates, requests up to 100 IDs, and rescans only resolved pictures. Background storage updates also notify other tabs. Misses/errors are retried after five minutes only while cards remain connected and the tab is foreground; disabling the overlay stops lookups. No new browser permissions or page/network interception are needed.

## Initial population

From the repository root:

```powershell
node --env-file-if-exists=apps/api/.dev.vars --import tsx apps/api/scripts/build-card-catalog.ts
```

The script discovers current Set rosters and performs only the initial 50-card sample per player. It checkpoints public picture/slug data under the ignored `artifacts/card-catalog/` directory and generates a scoped SQL upsert file. Review the resulting counts, then import that file with Wrangler into the existing cache database. The recurring Worker fills in missing editions afterwards. No cache purge, table migration or hard-coded per-player exception is required.
