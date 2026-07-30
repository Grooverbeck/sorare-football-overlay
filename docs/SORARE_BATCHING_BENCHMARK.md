# Sorare-Batching-Benchmark

Der Benchmark misst, wie schnell dieselbe Liste von Spielern mit der
produktiven `PlayerStatsBatch`-GraphQL-Abfrage geladen wird:

- anonym mit maximal drei Spielern pro Request;
- mit `SORARE_API_KEY` und konfigurierten Batchgrößen von 3, 6, 12 und 25.

Die Key-Messung mit Batchgröße 3 ist die Kontrollgruppe: Sie trennt den
reinen Authentifizierungseffekt vom eigentlichen Gewinn durch größere Batches.

Der API-Key wird ausschließlich aus der lokalen Umgebungsvariable
`SORARE_API_KEY` gelesen. Er wird weder als Kommandozeilenargument akzeptiert
noch protokolliert oder in das Ergebnis geschrieben.

## Ausführen

Zuerst kann der Request-Plan ohne Netzwerkzugriff geprüft werden:

```powershell
npm run benchmark:sorare-batching -- --dry-run
```

Der Live-Benchmark:

```powershell
npm run benchmark:sorare-batching
```

`apps/api/.dev.vars` wird dabei automatisch eingelesen, falls die Datei
existiert. Fehlt `SORARE_API_KEY`, wird nur die anonyme Baseline ausgeführt und
die Key-Szenarien werden ausdrücklich als übersprungen markiert. Ein bei
Cloudflare gespeichertes Worker-Secret kann aus Sicherheitsgründen nicht
ausgelesen werden; für den lokalen Vergleich muss der Key auch lokal als
Umgebungsvariable oder in der ignorierten Datei `apps/api/.dev.vars` vorhanden
sein.

Für maschinenlesbare Ausgabe:

```powershell
npm run benchmark:sorare-batching -- --json
```

## Sichere Standardkonfiguration

Der Standard verwendet:

- dieselben 15 Verteidiger in jedem Szenario;
- standardmäßig keinen Warm-up und drei Messläufe;
- höchstens zwei gleichzeitige Requests;
- mindestens 3,1 Sekunden Abstand zwischen anonymen Requeststarts;
- 15 anonyme Requests und damit fünf Requests Puffer zum bekannten
  Minutenbudget.

Damit überschreitet der Benchmark aus eigener Kraft nicht das bekannte
anonyme Minutenbudget. Der optionale Warm-up kann über
`BENCHMARK_SORARE_WARMUPS=1` aktiviert werden;
dann werden mit der Standardliste exakt 20 anonyme Requests erzeugt. Bereits
unmittelbar vorher gesendete Sorare-Anfragen können trotzdem zu einem HTTP-429
führen; dieser wird gemessen und nicht automatisch wiederholt.

Die Szenarioreihenfolge rotiert in jedem Messlauf. Dadurch profitiert nicht
immer dieselbe Batchgröße von einer möglicherweise bereits warmen Verbindung
oder einem serverseitigen Cache.

## Ergebnis

Pro Szenario werden ausgegeben:

- Anzahl der Netzwerkrequests;
- erfolgreiche und fehlgeschlagene Requests;
- fehlende, unerwartete oder doppelte Spieler pro Request und Messrunde;
- erkannte GraphQL-Komplexitätsfehler;
- Request-Latenz p50 und p90;
- Zeit bis zum ersten abgeschlossenen Batch p50 und p90;
- Gesamtzeit pro Spielerliste p50 und p90;
- Summe der gemessenen Gesamtzeiten;
- Geschwindigkeitsfaktor gegenüber der sicher auf 20 Requests pro Minute
  begrenzten anonymen Baseline;
- separater Batching-Faktor gegenüber der API-Key-Kontrollgruppe mit
  Batchgröße 3.

Die GraphQL-Komplexität wird angezeigt, wenn Sorare sie in einem Header, in
`extensions` oder in einer Fehlermeldung übermittelt. Bei erfolgreichen
Antworten liefert die API diesen Wert nicht zwingend; dann steht dort
entsprechend kein Messwert.

Die Eingabeliste wird vor dem ersten Request auf gültiges Slugformat und
Duplikate geprüft. Eine Antwort mit fehlenden, unerwarteten oder doppelten
Spielern wird gesondert als lückenhaft markiert.
Der Geschwindigkeitsfaktor wird nur berechnet, wenn sowohl die anonyme
Baseline als auch das Key-Szenario ohne Requestfehler und ohne
Slugabweichungen vollständig waren. Eine unvollständige Antwort kann dadurch
nicht unbemerkt wie ein Geschwindigkeitsgewinn aussehen.

Der Faktor gegenüber der anonymen Baseline enthält bewusst auch deren
3,1-Sekunden-Abstand und zeigt damit den sicheren Durchsatz unter dem
anonymen Minutenlimit. Er darf nicht als reine Netzwerklatenz interpretiert
werden. Der Vergleich mit `api-key/batch-3` isoliert den zusätzlichen Gewinn
größerer Batches deutlich besser.

Wichtig: Gemessen wird gezielt die gebündelte Basisabfrage, deren Batchgröße
der API-Key verändern könnte. Die Extension sendet derzeit weiterhin
progressive Dreiergruppen. Die größeren Key-Batches messen deshalb das
Potenzial einer späteren vorsichtigen Erhöhung und nicht automatisch den
sofortigen Ist-Gewinn nach Eintragen des Keys. Eventuelle nachgelagerte
Einzelabfragen für eine tiefere Vereinshistorie sind ebenfalls nicht Teil
dieser Messung und können bei kalten Spielern weiterhin zusätzliche Zeit
kosten.

## Optionale Konfiguration

Alle Anpassungen erfolgen über Umgebungsvariablen, niemals über einen Key in
der Kommandozeile:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `BENCHMARK_SORARE_SLUGS` | 15 feste Slugs | Kommagetrennte, identische Spielerliste |
| `BENCHMARK_SORARE_POSITION` | `Defender` | Kartenposition der Basisabfrage |
| `BENCHMARK_SORARE_KEY_BATCH_SIZES` | `3,6,12,25` | Batchgrößen mit API-Key |
| `BENCHMARK_SORARE_REPEATS` | `3` | Messläufe |
| `BENCHMARK_SORARE_WARMUPS` | `0` | Nicht gewertete Warm-ups |
| `BENCHMARK_SORARE_CONCURRENCY` | `2` | Maximale parallele Requests |
| `BENCHMARK_SORARE_TIMEOUT_MS` | `15000` | Timeout pro Request |
| `BENCHMARK_SORARE_ANONYMOUS_INTERVAL_MS` | `3100` | Abstand anonymer Requeststarts |
| `BENCHMARK_SORARE_KEY_INTERVAL_MS` | `125` | Abstand authentifizierter Requeststarts |

Wenn eine eigene Konfiguration mehr als 20 anonyme Requests erzeugen würde,
bricht der Benchmark vor dem ersten Netzwerkzugriff ab. Für umfangreichere
reine API-Key-Messungen kann die anonyme Baseline bewusst ausgelassen werden:

```powershell
npm run benchmark:sorare-batching -- --skip-anonymous
```
