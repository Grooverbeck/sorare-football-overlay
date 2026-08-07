# Sorare Football Stats Overlay

Produktionsnahes TypeScript-Monorepo für eine Chrome-/Edge-Manifest-V3-Extension, die kompakte, positionsabhängige L10-Statistiken auf dynamisch geladenen Sorare-Fußballkarten anzeigt.

> Du möchtest die fertige Erweiterung nur benutzen?
> Zur [Installations- und Update-Anleitung](docs/INSTALLATION.md) – Node.js
> oder ein eigener Build sind dafür nicht erforderlich.

## Architektur

```text
apps/
  api/          Hono-Backend, Sorare-GraphQL-Client, Cache, Provider, Mock-Daten
  extension/    MV3-Content-Script, Service Worker, DOM-Scanner, Shadow-DOM-UI
packages/
  shared/       Zod-API-Verträge, gemeinsame Typen und Statistikberechnungen
```

Die Extension ruft ausschließlich das eigene Backend auf. Sorare-API-Key, JWT und andere Secrets werden nur vom Backend gelesen und gelangen nicht in Manifest oder Browser-Bundle.

## Voraussetzungen und Installation

- Node.js 22 oder neuer
- npm 11 oder neuer
- Chrome oder Edge mit aktiviertem Entwicklermodus

```bash
npm install
npm run codegen
npm run verify
```

`npm run verify` führt GraphQL-Codegen, Typecheck, Vitest und beide Builds aus.

## Lokal mit Mock-Daten starten

Mock-Modus ist standardmäßig aktiv; echte Sorare-Zugangsdaten sind nicht erforderlich.

PowerShell:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/extension/.env.example apps/extension/.env
npm run dev:api
```

In einem zweiten Terminal:

```powershell
npm run dev:extension
```

Bekannte Mock-Slugs sind `kylian-mbappe-lottin`, `virgil-van-dijk`, `manuel-neuer` und `jude-bellingham`. Für jeden anderen erkannten Slug erzeugt der Mock-Adapter deterministische Beispieldaten, sodass sich reale Sorare-Seiten lokal testen lassen.

## Extension in Chrome oder Edge laden

1. `npm run build --workspace=@sorare-overlay/extension` ausführen.
2. `chrome://extensions` beziehungsweise `edge://extensions` öffnen.
3. Entwicklermodus aktivieren.
4. „Entpackte Erweiterung laden“ wählen und `apps/extension/dist` auswählen.
5. Nach jedem Neubau die Extension auf der Extensions-Seite neu laden.

Über das Extension-Symbol in der Browserleiste öffnet sich ein kleines Popup mit dem Schalter „Overlay aktiviert/deaktiviert“ und der Wahl, ob die Tor-/Assistklammer links oder rechts an der Karte sitzt. Die Klammerwerte lassen sich als Prozent oder als faire Dezimalquote anzeigen. Dort können außerdem historische Ersatzwerte für fehlende Tor- und Assistquoten ein- und ausgeschaltet sowie auf `L10`, `L15` oder `L40` gestellt werden. Die Einstellungen werden über `chrome.storage.local` gespeichert und gelten für alle Sorare-Tabs. Änderungen wirken sofort: Ausschalten entfernt vorhandene Overlays und pausiert den Scanner; Einschalten scannt die aktuell geöffnete Seite erneut.

`EXTENSION_API_BASE_URL` wird beim Build eingebettet und zugleich als eng begrenzte `host_permission` ins generierte Manifest geschrieben. Nach einer URL-Änderung muss neu gebaut und neu geladen werden. In diese Variable gehört nur die URL des eigenen Backends, niemals ein Token.

### Chrome-Web-Store-Paket

Für eine Store-konforme, nicht gelistete Beta:

```bash
npm run package:chrome-web-store
```

Der Befehl erzeugt die Icons und Listing-Grafiken, baut die Extension gegen
das produktive Cloudflare-Backend und schreibt eine ZIP ohne Source Maps nach
`artifacts/`. Store-Texte, Datenschutzangaben und die Einreichungscheckliste
liegen unter `docs/chrome-web-store/`.

## Backend-Konfiguration

Alle Werte werden aus `apps/api/.env` oder der Prozessumgebung gelesen.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `8787` | HTTP-Port |
| `MOCK_MODE` | `true` | Mock- statt Sorare-Datenquelle |
| `EXCLUDE_LOW_COVERAGE` | `true` | Low-Coverage-Spiele aus L10 ausschließen |
| `PLAYER_FORM_CACHE_TTL_SECONDS` | `604800` | Maximale Gültigkeit der Formwerte; in Cloudflare KV auf Montag 10:00 UTC ausgerichtet |
| `FIXTURE_CACHE_TTL_SECONDS` | `14400` | Nächstes Spiel und W/D/L-/CS-Wahrscheinlichkeiten (4 Stunden) |
| `NAME_CACHE_TTL_SECONDS` | `2592000` | Erfolgreiche Spielername-zu-Slug-Zuordnungen (30 Tage) |
| `NAME_MISS_CACHE_TTL_SECONDS` | `7200` | Nicht gefundene Spielernamen (2 Stunden) |
| `SORARE_BATCH_SIZE` | `25` | Spieler pro GraphQL-Batch, maximal 50; ohne API-Key automatisch auf 3 begrenzt |
| `SORARE_REQUEST_TIMEOUT_MS` | `10000` | Timeout einer Sorare-Anfrage |
| `SORARE_MAX_RETRIES` | `3` | Retry-Budget für 429 und temporäre 5xx-Fehler |
| `SORARE_GRAPHQL_URL` | `https://api.sorare.com/graphql` | Offizielle Football-GraphQL-API |
| `SORARE_API_KEY` | leer | Serverseitiger Sorare-API-Key, Header `APIKEY`; für das Cloudflare-Deployment erforderlich |
| `SORARE_AUTH_TOKEN` | leer | Optionales serverseitiges Bearer-Token |
| `SORARE_JWT_AUD` | leer | Optionaler `JWT-AUD`-Header |
| `THE_ODDS_API_KEY` | leer | Serverseitiger Schlüssel für Tor-/Assist-Märkte und den H/D/A-Fallback |
| `ODDS_API_BASE_URL` | `https://api.the-odds-api.com/v4` | Basis-URL von The Odds API |
| `ODDS_API_SPORT_KEY` | `soccer_usa_mls` | Liga bei The Odds API |
| `ODDS_API_REGION` | `us` | Primäre Buchmacherregion |
| `ODDS_API_FALLBACK_REGION` | leer | Optionale zweite Region für weiterhin fehlende Spieler- oder H/D/A-Märkte; Produktion nutzt `uk` |
| `ODDS_FETCH_WINDOW_HOURS` | `72` | Tor-/Assistquoten frühestens so viele Stunden vor Anpfiff abrufen |
| `MATCH_ODDS_FALLBACK_WINDOW_HOURS` | `72` | Externe H/D/A-Quoten nur innerhalb dieses Zeitfensters ergänzen, wenn Sorare noch Werte fehlen |
| `MATCH_ODDS_MISS_CACHE_TTL_SECONDS` | `3600` | Fehlende H/D/A-Märkte nach spätestens einer Stunde erneut prüfen; ein erfolgreicher Abruf wird weiterhin bis nach Anpfiff eingefroren |
| `ODDS_MISS_CACHE_TTL_SECONDS` | `21600` | Legacy-Fallback für alte negative Quoten-Cacheeinträge; neue Einträge nutzen 12h/24h plus eine letzte Prüfung vier Stunden vor Anpfiff |
| `SPORTS_GAME_ODDS_API_KEY` | leer | Serverseitiger Schlüssel für direkte Tor-, Assist- und Tor-oder-Assist-Märkte |
| `SPORTS_GAME_ODDS_BASE_URL` | `https://api.sportsgameodds.com/v2` | Basis-URL von SportsGameOdds |
| `SPORTS_GAME_ODDS_LEAGUE_ID` | `MLS` | Liga bei SportsGameOdds |
| `ODDS_API_IO_KEY` | leer | Serverseitiger Schlüssel für den zusätzlichen Torquoten-Fallback |
| `ODDS_API_IO_BASE_URL` | `https://api.odds-api.io/v3` | Basis-URL von Odds-API.io |
| `ODDS_API_IO_LEAGUE` | `austria-bundesliga` | Überschreibbarer Odds-API.io-Slug für die österreichische Bundesliga |
| `ODDS_API_IO_BOOKMAKERS` | `Bet365,Unibet` | Gemeinsam und gebündelt abgefragte Buchmacher |
| `ODDS_API_IO_DAILY_REQUEST_LIMIT` | `500` | Lokales Tagesbudget zum Schutz des Free-Tarifs |
| `ODDS_API_IO_HOURLY_REQUEST_LIMIT` | `100` | Lokales Stundenbudget zum Schutz des Free-Tarifs |
| `CORS_ORIGINS` | `http://localhost:5173` | Zusätzliche, kommagetrennte Web-Origins |
| `LOG_LEVEL` | `info` | Pino-Log-Level |

Für die echte API:

```dotenv
MOCK_MODE=false
SORARE_API_KEY=server-side-secret
```

Unauthentifizierte Abfragen bleiben für lokale Diagnose und Tests möglich,
unterliegen aber dem niedrigeren Sorare-Rate-Limit. Das produktive
Cloudflare-Deployment verlangt den API-Key, damit es nicht unbemerkt auf den
anonymen Zugriff zurückfällt. Bei HTTP 429 respektiert der Client
`Retry-After`; strukturierte Logs enthalten Request-ID, Status und Laufzeit,
aber keine Secrets.

Den möglichen Geschwindigkeitsgewinn größerer API-Key-Batches kann ein
reproduzierbarer Benchmark mit derselben Spielerliste messen:

```bash
npm run benchmark:sorare-batching -- --dry-run
npm run benchmark:sorare-batching
```

Ohne lokal gesetzten `SORARE_API_KEY` wird nur die anonyme Baseline ausgeführt.
Messmethodik, Sicherheitsgrenzen und Konfigurationsmöglichkeiten stehen in
[`docs/SORARE_BATCHING_BENCHMARK.md`](docs/SORARE_BATCHING_BENCHMARK.md).

Das Backend pollt einzelne Spieler nicht periodisch. Es fragt einen Spieler nur
bei einem tatsächlichen Cache-Miss an. In Cloudflare KV werden Formwerte und
Informationen zum nächsten Spiel getrennt gespeichert: AA-, CS-, Goal- und
Assist-Formwerte laufen gemeinsam am nächsten Montag um 10:00 UTC aus
(höchstens nach sieben Tagen), Spielwahrscheinlichkeiten nach vier Stunden,
erfolgreiche Name-zu-Slug-Zuordnungen nach 30 Tagen und ein „nicht gefunden“
nach zwei Stunden. Dadurch bleibt die Form innerhalb einer Spielwoche stabil
und wird erst nach dem Wochenwechsel beim nächsten tatsächlichen Kartenaufruf
neu geladen. Alte kombinierte `player-stats:v1`-Einträge werden beim ersten
Zugriff in die neuen Schlüssel migriert und laufen danach automatisch aus. Die
frühere Variable `CACHE_TTL_SECONDS` wird aus Kompatibilitätsgründen noch als
Fallback für die Form-TTL akzeptiert.

SportsGameOdds wird primär für direkte Tor-, Assist- und
Tor-oder-Assist-Märkte verwendet. The Odds API ergänzt nur weiterhin fehlende
Tor- oder Assistwerte. Odds-API.io ergänzt als letzte Rückfallebene eine noch
fehlende Torquote. Assist-Lücken allein lösen dort keinen Abruf aus, weil
dieser Feed dafür aktuell keine Assist-Märkte liefert. Die Spielerquoten
mehrerer Begegnungen desselben Wettbewerbs werden in möglichst wenigen
Sammelabfragen geladen. Die Anbieter werden nicht bei jedem Kartenaufruf
abgefragt. Innerhalb des konfigurierten Zeitfensters lädt das Backend die
angebotenen Märkte einmalig. Ein täglich um 05:00 UTC laufender Cloudflare-Cron
wärmt MLS-Begegnungen vor, die in den nächsten 72 Stunden beginnen. Erfolgreich
erfasste Spielerwerte bleiben als unveränderlicher Begegnungs-Snapshot ohne
Ablaufdatum gespeichert. Ein Ergänzungslauf kann später gelistete Spieler und
Buchmacherdetails hinzufügen, verändert aber keine bereits eingefrorene
Spielerwahrscheinlichkeit. Fehlende Märkte und konkret angefragte, noch nicht
gelistete Spieler verwenden einen spielbezogenen Retry-Zustand: nach dem ersten
Fehlschlag frühestens nach zwölf Stunden, danach nach 24 Stunden und höchstens
noch einmal vier Stunden vor Anpfiff. Nach der letzten Prüfung und nach
Spielbeginn werden keine weiteren Quotenabrufe ausgelöst. Bei dem produktiven
72-Stunden-Abruffenster ergeben sich dadurch höchstens drei Marktprüfungen pro
Begegnung statt einer Prüfung alle sechs Stunden.

Vor einem externen Abruf prüft das Backend zusätzlich die von Sorare gelieferte
Competition. SportsGameOdds unterstützt gezielt MLS, Champions League
einschließlich Qualifikation und Europa League. The Odds API ergänzt diese
Wettbewerbe sowie die Conference League. Aus dem Sorare-27-Contender-Pool sind
über The Odds API außerdem die österreichische Bundesliga und die
2. Bundesliga freigeschaltet. Odds-API.io ist als Goal-only-Fallback für MLS,
die drei UEFA-Wettbewerbe und alle vier Contender-Wettbewerbe einschließlich
kroatischer HNL und Ligue 2 freigeschaltet. Externe H/D/A-Fallbacks bleiben
für HNL und Ligue 2 weiterhin deaktiviert. Für europäische Spiele bei
The Odds API werden zuerst europäische und nur bei Bedarf britische Buchmacher
abgefragt. Unbekannte oder andere Wettbewerbe lösen keinen externen
Feed-Aufruf aus. Alte Fixture-Cacheeinträge ohne Competition werden einmalig
beim nächsten Kartenaufruf aktualisiert.

H/D/A-Wahrscheinlichkeiten stammen weiterhin vorrangig von Sorare. Erst ab
72 Stunden vor Anpfiff darf The Odds API noch fehlende H-, D- oder A-Werte
ergänzen. Der Abruf läuft nach der eigentlichen Statistikantwort gebündelt pro
Wettbewerb. Der bereinigte Buchmacher-Median wird anschließend bis nach dem
Spiel gespeichert. Bereits vorhandene Sorare-Werte werden dabei nie durch den
externen Fallback ersetzt.

Der tägliche Cron speichert außerdem die Kontingentnutzung beider
Quotenanbieter. Ab 50 % wird eine Warnung protokolliert. The Odds API verzichtet
ab 70 % auf den zusätzlichen Regionen-Fallback, ab 85 % auf reine
Ergänzungsprüfungen und stoppt ab 90 % neue externe Abrufe. SportsGameOdds lädt
zwischen 70 und 85 % nur noch bisher unbekannte Begegnungen, aber keine
Ergänzungen für bereits geprüfte Spiele. Ab 85 % arbeitet dieser Anbieter nur
noch aus dem Cache, ab 90 % greift zusätzlich der allgemeine Notstopp. Die Zahl
der empfangenen Spielobjekte wird zwischen den täglichen exakten
Kontingentprüfungen lokal fortgeschrieben. Neue Karten desselben Spiels lösen
außerdem erst am nächsten gemeinsamen Prüfzeitpunkt einen Ergänzungsabruf aus.
Bereits gespeicherte Quoten bleiben in allen Schutzstufen lesbar.

Für Odds-API.io führt das Backend zusätzlich lokale Stunden- und Tageszähler.
Ab 85 % des jeweils engeren Fensters werden keine Ergänzungsprüfungen
bestehender Snapshots mehr durchgeführt; ab 90 % erfolgen bis zum nächsten
Stunden- beziehungsweise UTC-Tagesfenster ausschließlich Cache-Lesezugriffe.

Der aktuelle SportsGameOdds-Verbrauch kann lokal abgefragt werden:

```bash
npm run usage:sports-game-odds
```

Die Ausgabe nennt das monatliche Intervall, den vom Anbieter gemeldeten
Zeitraum beziehungsweise einen deutlichen Hinweis, falls kein exakter
Reset-Zeitpunkt geliefert wird, sowie Verbrauch und Restkontingent. Der API-Key
wird dabei nur aus `apps/api/.dev.vars` gelesen und nicht ausgegeben.

## Cloudflare-Worker-Deployment

Das API-Backend kann unverändert lokal unter Node.js oder als Cloudflare Worker laufen. Der Worker-Einstieg liegt in `apps/api/src/cloudflare/worker.ts`; `apps/api/wrangler.jsonc` enthält die versionierte Deployment-Konfiguration.

Für Cloudflare wird `CACHE_DB` als persistenter D1-Cache gebunden. Der bisherige
`STATS_CACHE`-KV-Namespace bleibt während der Übergangsphase als reiner
Lesefallback aktiv, damit bereits vorhandene Wochenwerte weiterverwendet werden.
Im Cache liegen:

- berechnete Spielerstatistiken, getrennt nach Slug, Kartenposition und Low-Coverage-Einstellung;
- erfolgreiche Namensauflösungen von Kartenbildern;
- vorübergehend auch nicht auflösbare Namen, damit anonyme Sorare-Anfragen nicht ständig wiederholt werden.
- unveränderliche Tor-/Assist-Marktsnapshots pro Begegnung und kurzlebige
  Negativtreffer für noch nicht angebotene Märkte.
- den zuletzt bestätigten Kontingentstand der externen Quotenanbieter.

Die Einträge werden beim Lesen erneut mit Zod validiert. Ungültige oder veraltete Cache-Formate werden verworfen. Normale Statistik-Schreibvorgänge laufen über `ExecutionContext.waitUntil()`. Der erstmalige Marktquoten-Snapshot wird dagegen vor der Antwort bestätigt, damit parallele Aufrufe möglichst keinen zweiten kostenpflichtigen Abruf auslösen.

Der Worker stellt zusätzlich öffentliche Seiten für die Store-Einreichung bereit:

- `/` – Projekt- und Limited-Use-Informationen
- `/privacy` – Datenschutzerklärung
- `/support` – Supporthinweise

### Lokal in der Worker-Laufzeit testen

```powershell
Copy-Item apps/api/.dev.vars.example apps/api/.dev.vars
npm run dev:cloudflare
```

Die Beispielkonfiguration aktiviert Mock-Daten. `apps/api/.dev.vars` ist ignoriert und darf lokale Secrets enthalten. `wrangler dev` stellt denselben Worker mit lokal emuliertem D1 und KV-Lesefallback bereit.

Die Worker-spezifischen Prüfungen laufen ohne Cloudflare-Konto:

```bash
npm run cf:typegen --workspace=@sorare-overlay/api
npm run typecheck:worker --workspace=@sorare-overlay/api
npm run test:worker --workspace=@sorare-overlay/api
```

`cf:typegen` erzeugt `apps/api/worker-configuration.d.ts` direkt aus `wrangler.jsonc`. Nach Änderungen an Bindings oder Variablen muss der Befehl erneut ausgeführt und die generierte Datei mit committed werden.

### Einmalige Veröffentlichung

```bash
npx wrangler login
npm run deploy:cloudflare:dry-run
npm run cf:deploy --workspace=@sorare-overlay/api
```

Vor dem ersten Deployment werden die D1-Migrationen ausgeführt:

```bash
npx wrangler d1 migrations apply sorare-overlay-cache --remote --config apps/api/wrangler.jsonc
```

Wrangler bindet anschließend die in `wrangler.jsonc` deklarierte D1-Datenbank
und den bestehenden KV-Lesefallback ein. Der Sorare-Schlüssel ist dort als
erforderliches Secret deklariert; fehlt er, bricht Wrangler das Deployment ab,
statt das Backend unbemerkt anonym zu betreiben.

Zugangsdaten werden ausschließlich als verschlüsselte Worker-Secrets gesetzt,
niemals unter `vars`, in `.env`-Beispielen mit echtem Wert oder in der
Extension:

```bash
npx wrangler secret put SORARE_API_KEY --config apps/api/wrangler.jsonc
npx wrangler secret put SORARE_AUTH_TOKEN --config apps/api/wrangler.jsonc
npx wrangler secret put SORARE_JWT_AUD --config apps/api/wrangler.jsonc
npx wrangler secret put THE_ODDS_API_KEY --config apps/api/wrangler.jsonc
npx wrangler secret put SPORTS_GAME_ODDS_API_KEY --config apps/api/wrangler.jsonc
```

Nach dem Deployment zeigt Wrangler die öffentliche `workers.dev`-URL an. Diese URL kommt anschließend in `apps/extension/.env`:

```powershell
Copy-Item apps/extension/.env.cloudflare.example apps/extension/.env
npm run build --workspace=@sorare-overlay/extension
```

Die automatische Quoten-Vorwärmung wird mit dem Cron-Ausdruck `0 5 * * *`
direkt beim Worker-Deployment aktiviert. Zusätzlich erzeugt
`0 10 * * MON` jeden Montag um 10:00 UTC den MLS-AA-Vergleich einschließlich
Perzentilgrenzen und Top 3 je Position neu. Schlägt dieser Lauf fehl, bleibt der
letzte gültige Snapshot aktiv; die Spielerstatistiken werden dadurch nicht
blockiert. Für eine einmalige manuelle Quoten-Vorwärmung, etwa
unmittelbar nach einem Deployment, kann ohne lokalen Odds-API-Key der
Produktiv-Worker aufgerufen werden:

```bash
npm run prewarm:mls-props --workspace=@sorare-overlay/api
```

Die aktuell veröffentlichte API ist unter
`https://sorare-football-overlay-api.grooverbeck.workers.dev` erreichbar.

Der Extension-Build übernimmt nur die öffentliche Backend-URL und erzeugt dafür eine eng begrenzte `host_permission`. Secrets werden nicht in das Browser-Bundle eingebettet.

Die Worker-Konfiguration verwendet das aktuelle Compatibility Date, `nodejs_compat`, Smart Placement sowie strukturierte Logs und Traces. `global_fetch_strictly_public` stellt sicher, dass das ebenfalls über Cloudflare erreichbare Sorare-API-Ziel über dessen öffentliche Route angesprochen wird. Produktionslogs sind im Cloudflare-Dashboard sichtbar; Request-IDs, Laufzeiten, Fehlerursachen und Fehlercodes werden protokolliert, Zugangsdaten nicht.

## API

### `POST /api/player-stats`

Mindestens eine Spielerreferenz ist Pflicht. Direkte Spieler-Links liefern `slugs`; Kartenbilder in Live- und Aufstellungsübersichten können alternativ über `playerNames` serverseitig zu Slug und Position aufgelöst werden. `positions` ist optional und kann sowohl Slugs als auch Spielernamen als Schlüssel verwenden, um die Position der konkreten Karte zu berücksichtigen. Bei Namen wird zuerst die offizielle Sorare-Spielersuche verwendet; ein aus dem Namen abgeleiteter Slug dient nur noch als Fallback. Das verhindert Fehlzuordnungen bei gleichnamigen Spielern wie Diego Luna oder Joaquín Pereyra.

```json
{
  "slugs": ["virgil-van-dijk", "jude-bellingham"],
  "playerNames": ["Matt Turner"],
  "positions": {
    "virgil-van-dijk": "Defender",
    "jude-bellingham": "Midfielder"
  }
}
```

Zulässige Positionen sind `Goalkeeper`, `Defender`, `Midfielder` und `Forward`. Insgesamt werden maximal 50 eindeutige Slugs und Namen akzeptiert. Zur sparsamen Namensauflösung prüft das Backend zunächst alle aus den Namen abgeleiteten Slug-Kandidaten in einer einzigen Sorare-Abfrage; nur ungelöste Namen verwenden anschließend parallel `searchPlayers`. Danach werden die Spieler nach Position gruppiert. Ohne Sorare-API-Key sind die vollständigen Statistik-Batches automatisch auf drei Spieler begrenzt, damit die anonyme GraphQL-Komplexitätsgrenze nicht überschritten wird. Mit API-Key gilt die konfigurierbare `SORARE_BATCH_SIZE`. Dadurch entstehen innerhalb der jeweils erlaubten Grenze möglichst wenige Abfragen.

Beispielantwort:

```json
{
  "data": [
    {
      "slug": "virgil-van-dijk",
      "displayName": "Virgil van Dijk",
      "position": "Defender",
      "aaL10": { "value": 14.22, "sampleSize": 9 },
      "cleanSheetL10": { "value": 0.5, "sampleSize": 8 },
      "goalL10": { "value": 0.11, "sampleSize": 9 },
      "nextGame": {
        "date": "2026-07-27T18:45:00.000Z",
        "homeTeamName": "Arsenal",
        "awayTeamName": "Liverpool",
        "playerTeamName": "Liverpool",
        "opponentTeamName": "Arsenal",
        "cleanSheetProbability": 0.47,
        "matchProbabilities": {
          "win": 0.48,
          "draw": 0.27,
          "loss": 0.25
        },
        "marketOdds": {
          "source": "the-odds-api",
          "capturedAt": "2026-07-27T10:05:00.000Z",
          "goal": {
            "probability": 0.18,
            "bookmakerCount": 4,
            "bookmakerQuotes": [
              {
                "key": "example-book",
                "title": "Example Book",
                "decimalOdds": 5.5,
                "probability": 0.18
              }
            ]
          },
          "assist": {
            "probability": 0.11,
            "bookmakerCount": 3,
            "bookmakerQuotes": [
              {
                "key": "example-book",
                "title": "Example Book",
                "decimalOdds": 9,
                "probability": 0.11
              }
            ]
          }
        }
      },
      "excludedLowCoverage": 1
    }
  ],
  "meta": { "requested": 1, "returned": 1, "cacheHits": 0, "source": "mock" }
}
```

`GET /health` dient als einfacher Readiness-Check.

## Berechnungsregeln und Anzeige

- DNPs (`minsPlayed <= 0`) werden immer ausgeschlossen.
- Optional ausgeschlossene Low-Coverage-Spiele werden gezählt und im Overlay kenntlich gemacht.
- AA L10 ist der Mittelwert von `allAroundScore` über höchstens zehn gültige Einsätze.
- CS L10 ist `cleanSheet60 >= 1` geteilt durch Einsätze mit mindestens 60 Minuten.
- Goal L10 ist `goals >= 1` geteilt durch Einsätze mit mindestens einer Minute.
- Assist L10/L15/L40 ist `goalAssist >= 1` geteilt durch die tatsächlichen Einsätze des gewählten Fensters.
- Decisive L10/L15/L40 ist `(goals >= 1 ODER goalAssist >= 1)` geteilt durch die tatsächlichen Einsätze. Ein Spiel mit Tor und Assist zählt dabei nur einmal. DNPs und – je nach Backend-Konfiguration – Low-Coverage-Spiele werden ausgeschlossen.
- Die API führt für jede historische Kennzahl die tatsächliche Stichprobe als `n=…`; fehlende Kopfleistenwerte erscheinen als `—`.
- `AA L10` sitzt bei Feldspielern als eigene, farbcodierte Seitenklammer an der Karte.
- Goalkeeper zeigen stattdessen ausschließlich die teambezogene `CS%` als Seitenklammer. Defender zeigen `NEXT CS%` zusätzlich im Kartenheader; bei Midfieldern und Forwards bleibt die Kopfleiste ausgeblendet.
- Für alle Positionen rechnet die Extension die von Sorare aus Sicht des Spielerteams gelieferten Sieg-/Unentschieden-/Niederlagen-Wahrscheinlichkeiten in die feste Spielreihenfolge `H/D/A` um. Fehlende Werte werden als „keine Quote“ dargestellt.

`HistoricalGoalscorerProvider` implementiert die austauschbare `GoalscorerProbabilityProvider`-Schnittstelle. Ein späterer externer Prognoseanbieter kann dadurch ergänzt werden, ohne API-Route oder UI-Vertrag umzubauen.

### Tor- und Assist-Marktquoten

Für Defender, Midfielder und Forward zeigt die seitlich an der Karte sitzende
Quotenklammer die von SportsGameOdds und ergänzend The Odds API gelieferten
Märkte für „erzielt mindestens ein Tor“ und „liefert mindestens einen Assist“,
sofern Buchmacher diese Märkte anbieten.
Das Backend wandelt Dezimalquoten in implizite Wahrscheinlichkeiten um,
entfernt bei vorhandenen Gegenquoten die Buchmachermarge und verwendet den
Median der verfügbaren Buchmacher.
Die kompakte Klammer kann wahlweise diese Wahrscheinlichkeit in Prozent oder
die daraus berechnete faire Dezimalquote (`1 / Wahrscheinlichkeit`) anzeigen.
Beim Überfahren der Tor- oder Assist-Klammer zeigt die Extension zusätzlich
jeden verfügbaren Buchmacher mit seiner originalen Dezimalquote und der daraus
berechneten, margenbereinigten Einzelwahrscheinlichkeit. Ältere eingefrorene
Snapshots ohne diese Details werden innerhalb des Abruffensters genau einmal
angereichert; bleibt der Abruf erfolglos, wird der vorhandene Konsenswert nicht
überschrieben.

Optional kann die Extension für fehlende Tor- und Assistquoten die jeweiligen
historischen Anteile aus `L10`, `L15` oder `L40` anzeigen.
Ersatzwerte stehen in runden Klammern; der Tooltip nennt Zeitraum, Stichprobe
und ausdrücklich „Keine Marktquote“. Die jeweilige echte Marktquote hat immer
Vorrang. Die zusätzliche Einsatzhistorie wird nur geladen, wenn diese Option
aktiv ist. Die Option ist bei einer neuen Installation standardmäßig
deaktiviert.

Historische Werte verwenden bewusst eine andere, niedrigere Farbskala als
Next-Match-Quoten. Die sechs Grenzen sind Rot, Orange, Gelb, Grün, Blau und
Lila:

| Historischer Wert | Position | Rot unter | Orange unter | Gelb unter | Grün unter | Blau unter | Lila ab |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Tor | Defender | 1 % | 4 % | 7,5 % | 10 % | 15 % | 15 % |
| Tor | Midfielder | 3 % | 7,5 % | 12 % | 18 % | 25 % | 25 % |
| Tor | Forward | 5 % | 10 % | 18 % | 25 % | 35 % | 35 % |
| Assist | Defender | 1 % | 4 % | 7,5 % | 12 % | 18 % | 18 % |
| Assist | Midfielder | 3 % | 8 % | 13 % | 20 % | 27 % | 27 % |
| Assist | Forward | 3 % | 7,5 % | 12 % | 18 % | 25 % | 25 % |

Damit ist beispielsweise ein historischer Assist-Anteil von 20 % bei einem
Forward bereits blau („sehr gut“), während dieselbe direkte Next-Match-Quote
weiterhin nur gelb („mittel“) ist. Die historische Skala ist separat
versioniert und kann später anhand einer vollständigen MLS-Saisonverteilung
neu kalibriert werden.

Das Backend lädt die Märkte erst in den letzten 72 Stunden vor Anpfiff und
friert jeden erfolgreich gelieferten Markt anschließend dauerhaft in
Cloudflare KV ein. SportsGameOdds wird als primäre Quelle abgefragt; The Odds
API ergänzt weiterhin fehlende Tor- und Assistwerte. Odds-API.io ergänzt als
letzte Quelle noch fehlende Torquoten. Alle API-Secrets bleiben ausschließlich
im Worker.

### MLS-Perzentile für AA und Next CS

`AA L10` erscheint bei Feldspielern in einer eigenen Seitenklammer über Tor und
Assist. Goalkeeper zeigen an dieser Stelle ausschließlich `CS%`. Nur bei
Defendern bleibt `NEXT CS%` zusätzlich in der Kopfleiste. Für Midfielder und
Forwards gibt es keine Kopfleiste mehr.

Für AA basiert die Farbe auf dem positionsbezogenen MLS-Perzentil:

- Rot: `P0–20`
- Orange: `P20–40`
- Gelb: `P40–60`
- Grün: `P60–80`
- Blau: `P80–90`
- Lila: `P90–100`

Für `NEXT CS%` stammen die Grenzen aus den historischen Sorare-Clean-Sheet-Quoten der laufenden MLS-Saison:

- Rot: `<19,05 %`
- Orange: `19,05–23,80 %`
- Gelb: `23,81–28,16 %`
- Grün: `28,17–33,32 %`
- Blau: `33,33–37,73 %`
- Lila: `≥37,74 %`

Der CS-Snapshot umfasst bis zum 23. Juli 2026 insgesamt 238 abgeschlossene Spiele beziehungsweise 470 Teamseiten mit historischer Quote. Die Quotenabdeckung beträgt 98,7 %. Die tatsächliche Clean-Sheet-Rate steigt über die sechs Farbbänder monoton von 8,8 % über 13,8 %, 19,8 %, 26,3 % und 30,7 % bis 42,3 %. Der Ligadurchschnitt lag bei 21,5 % tatsächlichen Clean Sheets; Sorare's mittlere implizite Prognose lag bei 26,2 %.

Die statischen Fallback-Snapshots liegen in
`packages/shared/src/mls-aa-benchmarks.ts`,
`packages/shared/src/mls-clean-sheet-benchmarks.ts` und
`packages/shared/src/market-probability-benchmarks.ts`. Grundlage für AA sind
Spieler der Sorare-Competition `mlspa` mit mindestens fünf gültigen
Club-Einsätzen. Das Analyseskript verwendet dieselbe Berechnung wie das Overlay:
die neuesten zehn tatsächlich gespielten Partien der konkreten Kartenposition,
ohne DNPs und Low-Coverage-Spiele. Bei weniger als fünf Einsätzen bleibt die
AA-Anzeige neutral. Der gebündelte AA-Fallback vom 24. Juli 2026 umfasst 551
Spieler. Im produktiven Backend wird derselbe Vergleich montags um 10:00 UTC
neu berechnet und als einzelner KV-Snapshot gespeichert. Die
drei höchsten AA-L10-Spieler jeder Position erhalten am AA-Feld zusätzlich
einen Podiumsrahmen in Gold, Silber oder Bronze sowie die Kennzeichnung `#1`,
`#2` oder `#3`. Die Podiumsmarkierung bleibt anhand von Position und
Spieler-Slug bis zum nächsten erfolgreichen Montagslauf stabil. Fällt die
Aktualisierung aus, verschwinden bestehende Ränge daher nicht, sondern bleiben
bewusst vorübergehend veraltet.

Die Analyse kann für Kontrolle und Entwicklung weiterhin manuell erzeugt werden:

```bash
npm run benchmark:mls-aa
npm run benchmark:mls-cs
npm run benchmark:mls-market
```

Die Skripte paginieren mit kleinen Seiten unterhalb des anonymen Sorare-Komplexitätslimits. Die CS-Analyse vergleicht `1 / cleanSheetOdds` mit dem tatsächlichen Ergebnis „Gegner erzielt null Tore“ und gibt Verteilung, Kalibrierung, Heim-/Auswärtswerte und Teamwerte als JSON aus. Dadurch verursacht die Extension selbst keine zusätzlichen Liga-Massenabfragen.

## DOM-Integration

Der Content-Script-Scanner erkennt Spieler über Sorare-Links wie `/football/players/<slug>` und in Live-/Aufstellungsübersichten über Bildbeschriftungen wie `alt="Matt Turner - common"`. Primär verwendet er stabile `data-*`-/`data-testid`-Attribute, semantische Elemente und Bild-Metadaten, keine generierten CSS-Klassen. Ein `MutationObserver` verarbeitet nachgeladene Nodes und relevante Attributänderungen. Pro Kartencontainer und Spieler wird nur ein Host eingefügt; die eigentliche UI ist durch ein Shadow DOM isoliert.

Loading-, Backend-Fehler- und No-Data-Zustände werden direkt in derselben
kompakten Oberfläche dargestellt. Der Header bleibt beim Mouseover unverändert.
Im Lineup Builder erscheinen die umgerechneten Spielquoten als durchgehender
`H / D / A`-Balken unter den Teamnamen.

## GraphQL-Schema und TypeScript-Codegen

Das am 23. Juli 2026 vom [offiziellen Sorare-Schema-Endpunkt](https://api.sorare.com/graphql/schema) geladene Schema liegt versioniert unter `apps/api/schema/sorare-2026-07-23.graphql`. `schema.lock.json` hält Quelle, Abrufzeitpunkt, Dateiname und SHA-256 fest.

Aktualisieren:

```bash
npm run schema:pull
npm run codegen
```

Der Pull erzeugt eine datierte Datei und aktualisiert den Lock. Codegen liest automatisch den dort referenzierten Dateinamen, validiert die Query gegen das Schema und schreibt die generierten Operationstypen nach `apps/api/src/generated/sorare.ts`. Schemaänderungen sollten gemeinsam mit Lock, Schema, Query-Anpassungen und generierten Typen committed werden.

Die Batch-Query lädt `allAroundScore`, `goals`, `minsPlayed`, `cleanSheet60`, `positionTyped`, Spieldatum und `lowCoverage` zunächst für bis zu 15 Scores sowie `cleanSheetOdds`, `winOddsBasisPoints`, `drawOddsBasisPoints` und `loseOddsBasisPoints` des nächsten Spiels, sofern Sorare sie liefert. Falls DNPs oder Low Coverage darin weniger als zehn gültige Einsätze übrig lassen, lädt das Backend gezielt eine längere, auf 40 Spiele begrenzte Historie für diesen Spieler und wählt daraus die letzten zehn gültigen Einsätze.

## Tests und weitere Skripte

```bash
npm test                 # Berechnungs-, API-, Retry- und DOM-Tests
npm run typecheck        # Strict TypeScript für alle Workspaces
npm run build            # Shared, API und MV3-Extension
npm run dev:api          # Backend mit Watch-Modus
npm run dev:cloudflare   # Backend lokal in der Worker-Laufzeit mit KV
npm run dev:extension    # Extension mit Watch-Modus
npm run deploy:cloudflare:dry-run # Worker-Bundle und Konfiguration prüfen
npm run benchmark:mls-aa # MLS-AA-Verteilung als JSON analysieren
npm run analyze:player-prediction -- --player <slug>:FWD # separate lokale Prognose
```

Die API-Integrationstests laufen vollständig gegen die injizierte Mock-Datenquelle und benötigen weder Internetzugriff noch Zugangsdaten. Ein zusätzlicher Integrationstest startet den echten Worker lokal in Miniflare und prüft Health-Endpunkt, Hono-Routing, Mock-Statistiken, KV-Bindung und den korrekten Workerd-Aufruf des globalen `fetch`.

Die Spieler-Prognose ist bewusst vom Overlay getrennt. Sie läuft nur bei einem
manuellen Aufruf des Analysebefehls und verändert weder API-Antworten noch
Extension-Caches. Formel, Optionen und Beispiele stehen in
[`docs/PLAYER_PREDICTION_MODEL.md`](docs/PLAYER_PREDICTION_MODEL.md).
