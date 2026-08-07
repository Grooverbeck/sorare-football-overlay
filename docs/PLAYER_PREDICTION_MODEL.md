# Separate Spieler-Prognose v1

Die Prognose ist ein **lokales Analysewerkzeug** und ausdrücklich kein Teil des
Browser-Overlays oder der produktiven `player-stats`-Antwort. Normale
Sorare-Seitenaufrufe berechnen, laden und speichern keine Prognosewerte.

## Start

Aus dem Repository-Stamm:

```powershell
npm run analyze:player-prediction -- --player kylian-mbappe-lottin:FWD
```

Mehrere Spieler können gemeinsam ausgewertet werden:

```powershell
npm run analyze:player-prediction -- `
  --player kylian-mbappe-lottin:FWD `
  --player jude-bellingham:MID `
  --player virgil-van-dijk:DEF `
  --player manuel-neuer:GK
```

Weitere Optionen:

```text
--json                 vollständige JSON-Ausgabe
--refresh-fixtures     fehlende/abgelaufene nächste Spiele synchron laden
--api-url <url>        anderes Backend verwenden
--input <datei>        gespeicherte API-Antwort offline auswerten
```

Alternativ kann `PREDICTION_API_URL` gesetzt werden. Ohne Angabe verwendet das
Tool das produktive Overlay-Backend. Die zusätzlichen L15-Daten werden nur dann
angefordert, wenn dieser Befehl manuell gestartet wird.

## Modell

Standardkonfiguration:

- Stürmer und Mittelfeldspieler:
  `AA L10 + 10 × P(Tor) + 10 × P(Assist)`
- Verteidiger:
  `AA L10 + (10 × P(Clean Sheet)) × 2`
- Torhüter:
  `P(Clean Sheet)`

Für Tor und Assist wird zuerst die vorhandene Marktquote verwendet. Fehlt sie,
verwendet das Tool den historischen L15-Anteil. Das Backend berechnet diese
vorhandenen L15-Felder derzeit über die Spielerhistorie insgesamt, nicht
ausschließlich über den aktuellen Verein.

Die Wahrscheinlichkeiten werden intern als Werte von `0` bis `1` geführt. Der
Faktor `10` macht ihren Beitrag für Feldspieler neben AA lesbar. Alle Gewichte
sind in der JSON-Ausgabe sichtbar.

## Fehlende Daten

Jede Ausgabe enthält:

- `complete`: ob alle für die Position vorgesehenen Komponenten vorhanden sind
- `missingComponents`: welche Bestandteile fehlen
- Quelle und Stichprobengröße jeder Komponente
- eine versionierte Modellkennung (`player-prediction-v1`)

Für Feldspieler und Verteidiger wird ohne AA-Basis kein Gesamtindex ausgegeben.
Fehlt nur eine Tor-, Assist- oder Clean-Sheet-Komponente, bleibt ein vorhandener
Teilwert sichtbar, wird aber klar als unvollständig markiert.

## Vergleichbarkeit und technische Trennung

Die Ergebnisse sind nur innerhalb derselben Position sinnvoll vergleichbar.
Der Modellcode wird über den separaten Unterpfad
`@sorare-overlay/shared/player-prediction` geladen. Weder die Extension noch der
produktive API-Service importieren diesen Unterpfad. Alte Cacheeinträge, die
kurzzeitig ein Prognosefeld enthielten, sind weiterhin lesbar; unbekannte Felder
werden beim Parsen verworfen und nicht mehr ausgeliefert.
