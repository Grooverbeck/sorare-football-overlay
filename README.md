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

Über das Extension-Symbol in der Browserleiste öffnet sich ein kleines Popup mit dem Schalter „Overlay aktiviert/deaktiviert“. Der Zustand wird über `chrome.storage.local` gespeichert und gilt für alle Sorare-Tabs. Ausschalten entfernt vorhandene Overlays sofort und pausiert den Scanner; Einschalten scannt die aktuell geöffnete Seite erneut.

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
| `PLAYER_FORM_CACHE_TTL_SECONDS` | `86400` | AA-, CS- und Goal-L10-Formwerte (24 Stunden) |
| `FIXTURE_CACHE_TTL_SECONDS` | `14400` | Nächstes Spiel und W/D/L-/CS-Wahrscheinlichkeiten (4 Stunden) |
| `NAME_CACHE_TTL_SECONDS` | `2592000` | Erfolgreiche Spielername-zu-Slug-Zuordnungen (30 Tage) |
| `NAME_MISS_CACHE_TTL_SECONDS` | `7200` | Nicht gefundene Spielernamen (2 Stunden) |
| `SORARE_BATCH_SIZE` | `25` | Spieler pro GraphQL-Batch, maximal 50; ohne API-Key automatisch auf 3 begrenzt |
| `SORARE_REQUEST_TIMEOUT_MS` | `10000` | Timeout einer Sorare-Anfrage |
| `SORARE_MAX_RETRIES` | `3` | Retry-Budget für 429 und temporäre 5xx-Fehler |
| `SORARE_GRAPHQL_URL` | `https://api.sorare.com/graphql` | Offizielle Football-GraphQL-API |
| `SORARE_API_KEY` | leer | Optionaler Sorare-API-Key, Header `APIKEY` |
| `SORARE_AUTH_TOKEN` | leer | Optionales serverseitiges Bearer-Token |
| `SORARE_JWT_AUD` | leer | Optionaler `JWT-AUD`-Header |
| `CORS_ORIGINS` | `http://localhost:5173` | Zusätzliche, kommagetrennte Web-Origins |
| `LOG_LEVEL` | `info` | Pino-Log-Level |

Für die echte API:

```dotenv
MOCK_MODE=false
SORARE_API_KEY=server-side-secret
```

Unauthentifizierte Abfragen sind ebenfalls möglich, unterliegen aber dem niedrigeren Sorare-Rate-Limit. Bei HTTP 429 respektiert der Client `Retry-After`; strukturierte Logs enthalten Request-ID, Status und Laufzeit, aber keine Secrets.

Das Backend pollt Sorare nicht periodisch. Es fragt einen Spieler nur bei einem tatsächlichen Cache-Miss an. In Cloudflare KV werden Formwerte und Informationen zum nächsten Spiel getrennt gespeichert: L10-Werte bleiben 24 Stunden gültig, Spielwahrscheinlichkeiten vier Stunden, erfolgreiche Name-zu-Slug-Zuordnungen 30 Tage und ein „nicht gefunden“ zwei Stunden. Alte kombinierte `player-stats:v1`-Einträge werden beim ersten Zugriff in die neuen Schlüssel migriert und laufen danach automatisch aus. Die frühere Variable `CACHE_TTL_SECONDS` wird aus Kompatibilitätsgründen noch als Fallback für die Form-TTL akzeptiert.

## Cloudflare-Worker-Deployment

Das API-Backend kann unverändert lokal unter Node.js oder als Cloudflare Worker laufen. Der Worker-Einstieg liegt in `apps/api/src/cloudflare/worker.ts`; `apps/api/wrangler.jsonc` enthält die versionierte Deployment-Konfiguration.

Für Cloudflare wird `STATS_CACHE` als KV-Namespace gebunden. Darin liegen:

- berechnete Spielerstatistiken, getrennt nach Slug, Kartenposition und Low-Coverage-Einstellung;
- erfolgreiche Namensauflösungen von Kartenbildern;
- vorübergehend auch nicht auflösbare Namen, damit anonyme Sorare-Anfragen nicht ständig wiederholt werden.

Die Einträge werden beim Lesen erneut mit Zod validiert. Ungültige oder veraltete Cache-Formate werden verworfen. KV-Schreibvorgänge laufen über `ExecutionContext.waitUntil()`, damit die API-Antwort nicht auf den Schreibvorgang warten muss und Cloudflare ihn trotzdem zuverlässig zu Ende führt.

Der Worker stellt zusätzlich öffentliche Seiten für die Store-Einreichung bereit:

- `/` – Projekt- und Limited-Use-Informationen
- `/privacy` – Datenschutzerklärung
- `/support` – Supporthinweise

### Lokal in der Worker-Laufzeit testen

```powershell
Copy-Item apps/api/.dev.vars.example apps/api/.dev.vars
npm run dev:cloudflare
```

Die Beispielkonfiguration aktiviert Mock-Daten. `apps/api/.dev.vars` ist ignoriert und darf lokale Secrets enthalten. `wrangler dev` stellt denselben Worker mit lokal emuliertem KV bereit.

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

Beim ersten echten Deployment stellt Wrangler den in `wrangler.jsonc` deklarierten KV-Namespace automatisch bereit. Es ist kein Sorare-Schlüssel zwingend erforderlich; dann greift das Backend anonym zu und begrenzt die GraphQL-Batches entsprechend.

Optionale Zugangsdaten werden ausschließlich als verschlüsselte Worker-Secrets gesetzt, niemals unter `vars`, in `.env`-Beispielen mit echtem Wert oder in der Extension:

```bash
npx wrangler secret put SORARE_API_KEY --config apps/api/wrangler.jsonc
npx wrangler secret put SORARE_AUTH_TOKEN --config apps/api/wrangler.jsonc
npx wrangler secret put SORARE_JWT_AUD --config apps/api/wrangler.jsonc
```

Nach dem Deployment zeigt Wrangler die öffentliche `workers.dev`-URL an. Diese URL kommt anschließend in `apps/extension/.env`:

```powershell
Copy-Item apps/extension/.env.cloudflare.example apps/extension/.env
npm run build --workspace=@sorare-overlay/extension
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

Zulässige Positionen sind `Goalkeeper`, `Defender`, `Midfielder` und `Forward`. Insgesamt werden maximal 50 eindeutige Slugs und Namen akzeptiert. Zur sparsamen Namensauflösung prüft das Backend zunächst alle aus den Namen abgeleiteten Slug-Kandidaten in einer einzigen Sorare-Abfrage; nur ungelöste Namen verwenden anschließend parallel `searchPlayers`. Danach werden die Spieler nach Position gruppiert. Ohne API-Key sind vollständige L10-Batches automatisch auf drei Spieler begrenzt, weil bereits vier Spieler Sorare's anonyme GraphQL-Komplexitätsgrenze überschreiten. Mit API-Key gilt die konfigurierbare `SORARE_BATCH_SIZE`. Dadurch entstehen innerhalb der jeweils erlaubten Grenze möglichst wenige Abfragen.

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
        "cleanSheetProbability": 0.47,
        "matchProbabilities": {
          "win": 0.48,
          "draw": 0.27,
          "loss": 0.25
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
- Jede Kennzahl trägt ihre tatsächliche Stichprobe als `n=…`; fehlende Werte erscheinen als „keine Daten“.
- Für Goalkeeper/Defender zeigt das Overlay CS L10, AA L10 und – sofern vorhanden – die teambezogene `Next CS`-Quote des nächsten Spiels.
- Für Midfielder/Forward zeigt es Goal L10 und AA L10. **Goal L10 ist ausdrücklich ein historischer Wert und keine Next-Game-Prognose.**
- Für alle Positionen rechnet die Extension die von Sorare aus Sicht des Spielerteams gelieferten Sieg-/Unentschieden-/Niederlagen-Wahrscheinlichkeiten in die feste Spielreihenfolge `H/D/A` um. Fehlende Werte werden als „keine Quote“ dargestellt.

`HistoricalGoalscorerProvider` implementiert die austauschbare `GoalscorerProbabilityProvider`-Schnittstelle. Ein späterer externer Prognoseanbieter kann dadurch ergänzt werden, ohne API-Route oder UI-Vertrag umzubauen.

### MLS-Perzentile für AA, Next W und Next CS

Der kompakte Kartenheader zeigt `AA L10` sowie bei Goalkeepern/Defendern `NEXT CS%` und bei Midfieldern/Forwards `NEXT W%`. Die Next-Werte beziehen sich immer auf das nächste noch nicht gestartete Spiel des Teams und sind ausdrücklich keine Live-Wahrscheinlichkeiten für ein bereits laufendes Spiel. Alle Kennzahlen verwenden dasselbe sechsstufige Leistungsband: Rot, Orange, Gelb, Grün, Blau und Lila.

Für AA basiert die Farbe auf dem positionsbezogenen MLS-Perzentil:

- Rot: `P0–20`
- Orange: `P20–40`
- Gelb: `P40–60`
- Grün: `P60–80`
- Blau: `P80–90`
- Lila: `P90–100`

Für `NEXT W%` stammen die Grenzen aus den historischen Sorare-Siegquoten beider Teamseiten in der laufenden MLS-Saison:

- Rot: `<24 %`
- Orange: `24–31 %`
- Gelb: `32–41 %`
- Grün: `42–50 %`
- Blau: `51–56 %`
- Lila: `≥57 %`

Der Win-Snapshot umfasst bis zum 23. Juli 2026 insgesamt 238 abgeschlossene Spiele beziehungsweise 470 Teamseiten mit vollständigen W/D/L-Quoten. Die Quotenabdeckung beträgt 98,7 %. Fehlende oder für AA noch nicht belastbare Daten bleiben neutral grau.

Für `NEXT CS%` stammen die Grenzen aus den historischen Sorare-Clean-Sheet-Quoten der laufenden MLS-Saison:

- Rot: `<19,05 %`
- Orange: `19,05–23,80 %`
- Gelb: `23,81–28,16 %`
- Grün: `28,17–33,32 %`
- Blau: `33,33–37,73 %`
- Lila: `≥37,74 %`

Der CS-Snapshot umfasst bis zum 23. Juli 2026 insgesamt 238 abgeschlossene Spiele beziehungsweise 470 Teamseiten mit historischer Quote. Die Quotenabdeckung beträgt 98,7 %. Die tatsächliche Clean-Sheet-Rate steigt über die sechs Farbbänder monoton von 8,8 % über 13,8 %, 19,8 %, 26,3 % und 30,7 % bis 42,3 %. Der Ligadurchschnitt lag bei 21,5 % tatsächlichen Clean Sheets; Sorare's mittlere implizite Prognose lag bei 26,2 %.

Die versionierten Snapshots liegen in `packages/shared/src/mls-aa-benchmarks.ts` und `packages/shared/src/mls-clean-sheet-benchmarks.ts`. Grundlage für AA sind Spieler der Sorare-Competition `mlspa` mit mindestens fünf gültigen Club-Einsätzen. Das Analyseskript verwendet dieselbe Berechnung wie das Overlay: die neuesten zehn tatsächlich gespielten Partien der konkreten Kartenposition, ohne DNPs und Low-Coverage-Spiele. Bei weniger als fünf Einsätzen bleibt die AA-Anzeige neutral. Der AA-Snapshot vom 24. Juli 2026 umfasst 551 Spieler. Die drei höchsten AA-L10-Spieler jeder Position erhalten am AA-Feld zusätzlich einen Podiumsrahmen in Gold, Silber oder Bronze sowie die Kennzeichnung `★1`, `★2` oder `★3`; der Mouseover nennt den Rang als `#1`, `#2` oder `#3`. Die Podiumsmarkierung bleibt anhand von Position und Spieler-Slug bis zur nächsten bewussten Snapshot-Aktualisierung stabil; sie kann zwischen zwei Aktualisierungen daher vorübergehend veraltet sein.

Die Analyse wird nicht im normalen Backendbetrieb ausgeführt. Sie kann bei Bedarf – beispielsweise monatlich – anonym neu erzeugt werden:

```bash
npm run benchmark:mls-aa
npm run benchmark:mls-cs
```

Die Skripte paginieren mit kleinen Seiten unterhalb des anonymen Sorare-Komplexitätslimits. Die CS-Analyse vergleicht `1 / cleanSheetOdds` mit dem tatsächlichen Ergebnis „Gegner erzielt null Tore“ und gibt Verteilung, Kalibrierung, Heim-/Auswärtswerte und Teamwerte als JSON aus. Dadurch verursacht die Extension selbst keine zusätzlichen Liga-Massenabfragen.

## DOM-Integration

Der Content-Script-Scanner erkennt Spieler über Sorare-Links wie `/football/players/<slug>` und in Live-/Aufstellungsübersichten über Bildbeschriftungen wie `alt="Matt Turner - common"`. Primär verwendet er stabile `data-*`-/`data-testid`-Attribute, semantische Elemente und Bild-Metadaten, keine generierten CSS-Klassen. Ein `MutationObserver` verarbeitet nachgeladene Nodes und relevante Attributänderungen. Pro Kartencontainer und Spieler wird nur ein Host eingefügt; die eigentliche UI ist durch ein Shadow DOM isoliert.

Loading-, Backend-Fehler- und No-Data-Zustände werden direkt in derselben kompakten Oberfläche dargestellt.

Beim Mouseover erweitert sich der Header um ergänzenden Kontext, ohne die beiden kompakten Kennzahlen zu wiederholen: Rollenmetrik mit Sample Size, AA-Perzentil im positionsbezogenen MLS-Vergleich, Spielquoten sowie ausgeschlossene Low-Coverage-Spiele. Die Begegnung steht immer in der festen Reihenfolge Heimteam – Auswärtsteam. Das Spielerteam wird fett-kursiv hervorgehoben. Darunter erscheinen die umgerechneten Quoten als `H / D / A`; auch die zum Spielerteam gehörende Siegquote wird fett-kursiv dargestellt.

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
```

Die API-Integrationstests laufen vollständig gegen die injizierte Mock-Datenquelle und benötigen weder Internetzugriff noch Zugangsdaten. Ein zusätzlicher Integrationstest startet den echten Worker lokal in Miniflare und prüft Health-Endpunkt, Hono-Routing, Mock-Statistiken, KV-Bindung und den korrekten Workerd-Aufruf des globalen `fetch`.
