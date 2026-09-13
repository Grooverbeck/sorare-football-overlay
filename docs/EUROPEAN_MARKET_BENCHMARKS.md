# Europäische Farbbänder für Tor und Assist – Version 1

Stand: 13. September 2026. Ersetzt im Overlay die bisherigen MLS-Farbbänder
für Tor und Assist. AA, CS, Sortierung, historische Berechnung und angezeigte
Quoten selbst bleiben unverändert. Kein Worker-Deployment erforderlich.

## Bedeutung

Rot / Orange / Gelb / Grün / Blau / Lila orientieren sich an
P20 / P40 / P60 / P80 / P90 der jeweiligen Referenzverteilung. Es gibt eine
gemeinsame Skala für Premier League, Bundesliga, LaLiga und Ligue 1, jeweils
getrennt nach Kartenposition und Markt. Die Farbe beschreibt den
Positionsvergleich, nicht die Sicherheit eines Ereignisses.

Die Tabellen sind fest in der Extension hinterlegt. Filter, Sammlung,
sichtbare Karten, Nachladen und Sortieren verändern die Referenz nicht.
Auch außerhalb des Set-Bildschirms bleibt diese europäische Referenz gleich;
es findet kein automatischer ligaabhängiger Wechsel statt.

Grenzen werden auf 0,5 Prozentpunkte gerundet. Genau auf einer positiven
Grenze beginnt das höhere Band. Gleiche historische Werte werden niemals
künstlich auf verschiedene Farben verteilt: 0 % bleibt immer rot,
fehlende Werte bleiben neutral/grau. Wegen Rundung, identischen Quoten und
wechselnder Spielpaarungen sind die tatsächlichen Farbanteile nicht exakt
20/20/20/20/10/10. Das gilt besonders für kurze historische Fenster.

## Direkte Marktquoten

| Markt | Position | Orange ab | Gelb ab | Grün ab | Blau ab | Lila ab |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Tor | DF | 6,5 % | 9 % | 10,5 % | 13,5 % | 15,5 % |
| Tor | MF | 12,5 % | 15,5 % | 20 % | 25 % | 29,5 % |
| Tor | FW | 22 % | 28 % | 32,5 % | 39 % | 45,5 % |
| Assist | DF | 7,5 % | 9 % | 11 % | 13,5 % | 18 % |
| Assist | MF | 11 % | 13,5 % | 16,5 % | 22 % | 23 % |
| Assist | FW | 12,5 % | 14,5 % | 18 % | 22 % | 25 % |

Unterhalb der ersten Grenze gilt Rot.

### Datenbasis

- Read-only D1-Export vom 13.09.2026, 14:09 UTC: 766 erfolgreiche
  Markt-Snapshots, zusätzlich vorhandene Spieler-/Fixture-Metadaten.
- Öffentliche aktuelle Sorare-Ligakader vollständig paginiert gelesen.
  Berücksichtigt werden nur Spieler mit Common-Kartenpositionen und
  übereinstimmendem Common-Kartenteam / aktivem Klub / Ligakontext.
  Konservativer Referenzkader: 1.069 Feldspieler aus 71 Klubs
  (England 19, Deutschland 18, Spanien 18, Frankreich 16).
  Das ist ein überprüfbarer Common-Karten-Proxy, kein Nachweis einer
  vollständig abgefragten Hyperglitch-Packliste. Nicht bestätigte Karten
  werden nicht aus Pro-Positionen oder Kartennamen erraten.
- 72 unterschiedliche Paarungen mit Anstoß vom 30.08. bis 13.09.2026.
  **Keine drei oder vier vollständig abgedeckten Spieltage:** Der Cache
  enthält Teile von drei Wochenenden, nicht jedes Spiel/jeden Spieler.
- Ausschließlich vorhandene Odds-API.io-/Bet365-Quoten; einheitlich
  `1 / Dezimalquote`. Dies sind implizite Wahrscheinlichkeiten einschließlich
  Buchmachermarge, keine behaupteten fairen Wahrscheinlichkeiten.
  Andere Provider oder Berechnungskonventionen werden nicht hineingemischt.
  An der laufenden Provider-Auswahl/Berechnung wurde nichts geändert.
- Gespeicherter Capture-Zeitpunkt maximal 72 Stunden vor, nie nach Anstoß.
  Keine extern nachgekauften historischen Quoten und keine Live-Quote.
- Ein Wert pro Spieler, Paarung inklusive Datum, Kartenposition und Markt.
  Neuere zulässige Captures haben Vorrang; widersprüchliche Aliaspreise
  desselben Zeitpunkts werden ausgeschlossen (vier Fälle).
- Namensabgleich nur innerhalb der beiden bestätigten Klubs, eindeutiger
  Treffer mit mindestens 80 Punkten im bestehenden Identitätsabgleich.
  Unklare Namen und Teams sowie ligaübergreifende Paarungen bleiben außen vor.

| Markt / Position | Spieler-Spiel-Werte | Eindeutige Spieler | Spiele | England / Deutschland / Spanien / Frankreich |
| --- | ---: | ---: | ---: | --- |
| Tor DF | 744 | 349 | 72 | 231 / 195 / 175 / 143 |
| Tor MF | 694 | 324 | 72 | 207 / 168 / 171 / 148 |
| Tor FW | 539 | 257 | 72 | 165 / 115 / 166 / 93 |
| Assist DF | 711 | 346 | 71 | 230 / 181 / 175 / 125 |
| Assist MF | 666 | 324 | 72 | 207 / 149 / 171 / 139 |
| Assist FW | 525 | 256 | 72 | 165 / 109 / 166 / 85 |

Gesamt: **1.977 Tor- und 1.902 Assistwerte**. Mehrere Werte desselben Spielers
an unterschiedlichen Spieltagen sind nicht statistisch unabhängig. Die
Stichprobe bildet das vorhandene Marktangebot ab, nicht die vollständige
Liga-Population. Buchmacher listen beispielsweise nicht jeden Reservisten.
Die Häufigkeit der Browserabfragen führt dagegen zu keiner Mehrfachgewichtung
desselben Spieler-Spiels. Version 1 ist eine empirische Startkalibrierung,
kein langfristig validiertes Prognosemodell.

## Historische Tor-/Assist-Anteile

Separate Referenz aus Sorares Einsatzhistorien, nicht aus Marktquoten.
Die vorhandenen Cache-Historien wurden nur diagnostisch betrachtet und
**nicht** als finale Vergleichspopulation verwendet.

- Vor dem Laden deterministisch 30 Spieler je Liga und Kartenposition
  ausgewählt (360 insgesamt). Auswahl nach SHA-256 von Seed und Spieler-Slug;
  unabhängig von Sammlung, Marktquote, historischem Wert oder Cache-Treffer.
- Seed: `european-set-history-v1-2026-09-13`.
- Alle 360 Historien frisch und nur lesend geladen. Identischer
  `SorareDataSource` und dieselben historischen Berechnungsfunktionen wie im
  Overlay: clubübergreifend, tatsächliche Einsätze, richtige Kartenposition,
  ohne DNP/Low Coverage. Keine zusätzliche 60-Minuten-Regel für Tor/Assist;
  diese gehört weiterhin ausschließlich zur AA-Berechnung.
- Referenzfenster L40 mit mindestens 20 verwertbaren Einsätzen. Der aktuelle
  Loader betrachtet maximal 40 vergangene Spiele; nach Ausschlüssen können
  weniger Einsätze übrig bleiben. Keine nachträgliche Auffüllung bis exakt 40.
- 280 Spieler erfüllen diese Voraussetzung: DF 87, MF 96, FW 97.
  Je Liga/Position verbleiben 21–28 Spieler. Die Auswahl ist geschichtet;
  das Mindest-Einsatzkriterium kann junge/selten eingesetzte Spieler
  unterrepräsentieren. Die Stichprobe ist kleiner als die Marktstichprobe.
- Dieselbe feste historische Referenz färbt L10/L15/L40. Sie behauptet
  keine fensterspezifischen Perzentile. Fenster, Werte, Nenner und die
  Kennzeichnung `(…)` werden nicht verändert.

| Markt | Position | Orange ab | Gelb ab | Grün ab | Blau ab | Lila ab |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Tor | DF | entfällt | über 0 % | 4 % | 8 % | 10,5 % |
| Tor | MF | 2,5 % | 5,5 % | 9 % | 13,5 % | 19 % |
| Tor | FW | 8,5 % | 13 % | 22 % | 28,5 % | 35,5 % |
| Assist | DF | über 0 % | 3 % | 4,5 % | 9 % | 13 % |
| Assist | MF | 3 % | 6 % | 9,5 % | 14 % | 16,5 % |
| Assist | FW | 3,5 % | 7 % | 10 % | 17,5 % | 21,5 % |

Bei DF-Toren liegen P20 und P40 bei null. Deshalb gibt es für diese
Referenz kein eigenständiges oranges Intervall; null bleibt rot. Eine
scheinpräzise Grenze zwischen Spielern mit demselben Nullwert wäre falsch.

## Reproduktion und Betrieb

Die Skripte werden vom Repository-Root gestartet; zuvor API und Shared bauen.
Rohdaten bleiben in `outputs/` und werden nicht auf GitHub veröffentlicht.

```powershell
node apps/api/scripts/export-market-benchmark-cache.mjs outputs/european-market-benchmarks-2026-09-13/cache.json
node --env-file=apps/api/.dev.vars apps/api/scripts/export-european-benchmark-roster.mjs outputs/european-market-benchmarks-2026-09-13
node --import tsx --env-file=apps/api/.dev.vars apps/api/scripts/export-european-benchmark-history.mjs outputs/european-market-benchmarks-2026-09-13
node --import tsx apps/api/scripts/derive-european-market-benchmarks.mjs outputs/european-market-benchmarks-2026-09-13
node --import tsx apps/api/scripts/verify-european-market-benchmarks.mjs outputs/european-market-benchmarks-2026-09-13
```

Die letzten beiden Befehle laufen vollständig offline. Der Verifikator
prüft alle 60 Grenzen gegen das Analyseergebnis sowie Mindestabdeckung pro
Position und Liga. Roster/History-Exporter verwenden Checkpoints; für eine
neue Erhebung ist ein neuer Ausgabeordner und ein dokumentierter Seed nötig.

Input-Prüfsummen SHA-256:

- Cache: `41ef2a3e6d15c0f0073d8b8ed3eeed46981c4b547400bf50f83cfdbe04a50365`
- Roster: `56e7f0bcd0b46dbab765ad7a117068fa503a510e2baf0db0baf9cd244e2739ef`
- History: `ebe37be0062f910e3ba5c00f80fff7305bfd892afafb3c06043b1df6cd2bdb2d`

Für die Analyse wurden **keine Quotenanbieter-Credits** verbraucht. Die
historische Stichprobe benötigte 900 Sorare-Leseanfragen, zusätzlich zur
Kaderabfrage und vier D1-SELECT-Abfragen inklusive Bestandsübersicht.
Im normalen Betrieb entstehen durch die Farbtabelle keine Zusatzabfragen,
keine neuen Cronjobs und keine neuen Datenbank-Schreibvorgänge.

Spätere Neukalibrierung bewusst anhand weiterer archivierter Spieltage
prüfen; nicht bei jedem Seitenaufruf oder anhand des aktuellen Filters.
Es wurde keine automatische Datensammlung für die Zukunft aktiviert.
