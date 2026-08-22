# Changelog

Alle wichtigen Änderungen am Sorare Football Stats Overlay werden in dieser
Datei dokumentiert.

## 0.4.1 – 22. August 2026

### Hotfix für Captain-Karten

- Sorare legt bei ausgewählten Captains eine eigene Dekoration über die Karte.
  Diese wurde von der Erweiterung fälschlich als verdeckende Oberfläche
  behandelt und konnte dadurch sämtliche Klammern des Captains ausblenden.
- Captain-Karten bleiben nun sichtbar. Bei Torhütern und Verteidigern wird
  dadurch insbesondere die Clean-Sheet-Wahrscheinlichkeit wieder angezeigt.
- Tatsächlich verdeckte Karten bleiben weiterhin ausgeblendet, damit Klammern
  nicht über fixierten Menüs oder anderen Sorare-Oberflächen schweben.

## 0.4.0 – 22. August 2026

### Spieler im Lineup Builder besser vergleichen

- Im vorhandenen Sorare-Sortiermenü stehen jetzt zusätzlich **Torquote** und
  **AA** zur Auswahl.
- **Torquote** vergleicht echte Marktquoten und historische Ersatzwerte in
  einer gemeinsamen Reihenfolge. Spieler ohne Marktquote verschwinden dadurch
  nicht automatisch am Ende der Liste.
- **AA** sortiert nach dem durchschnittlichen All-Around Score der letzten zehn
  gültigen Spiele. Es zählen nur Einsätze mit mindestens 60 Minuten.
- Fehlende Werte bleiben am Listenende. Neu eintreffende Daten aktualisieren
  die Reihenfolge automatisch.
- Beim Wechsel zurück zu einer Sorare-Sortierung wird die ursprüngliche
  Reihenfolge zuverlässig wiederhergestellt.

### Ruhigere Anzeige beim Scrollen

- Klammern werden ausgeblendet, sobald das zugehörige Kartenbild hinter einer
  fixierten Sorare-Leiste oder einem abgeschnittenen Bereich verschwindet.
  Dadurch schweben Werte nicht mehr über anderen Bedienelementen.

## 0.3.4 – 22. August 2026

### Mehr und verlässlichere Quoten

- Je nach Wettbewerb werden Spiel-, Tor- und Assistquoten über verbesserte
  Anbieter-Routen für Premier League, La Liga, Ligue 1, Ligue 2, Bundesliga,
  2. Bundesliga, HNL, österreichische Bundesliga, MLS und UEFA-Wettbewerbe
  ergänzt.
- Spieler- und Teamzuordnungen berücksichtigen kanonische Sorare-Identitäten,
  Transfers und abweichende Anbieter-Namen robuster. Dadurch landen Quoten
  seltener beim falschen Verein oder bleiben wegen einer abweichenden
  Namensform aus.
- Bereits gecachte Marktquoten bleiben bei Teilfehlern erhalten und ersetzen
  historische Ersatzwerte automatisch, sobald die echte Quote verfügbar ist.
- Laufende Fixture-Abrufe werden für alle betroffenen Teamkollegen erkannt;
  neue Quoten erscheinen ohne manuelles Neuladen der Sorare-Seite.

### Aussagekräftigere Formwerte

- AA berücksichtigt nur Einsätze mit mindestens 60 gespielten Minuten und
  basiert dadurch weniger auf kurzen Einwechslungen.
- Positions- und Namensvarianten desselben Spielers teilen passende Daten,
  ohne echte abweichende Kartenpositionen miteinander zu vermischen.

### Kompaktere Kartenanzeige

- Die neue optionale Compact View klappt die farbigen Klammern auf Squad- und
  Lineups-Seiten erst beim Überfahren der Karte aus; der Lineup Builder bleibt
  vollständig sichtbar.
- Klammern, Symbole, Schrift und No-Data-Zustände wurden für kleine Karten
  harmonisiert und besser am Kartenrand ausgerichtet.
- Lade- und Wiederholungslogik hält vorhandene Werte sichtbar und reduziert
  breitflächige „nicht verfügbar“-Zustände bei kurzzeitigen Backend-Problemen.

## 0.3.3 – 30. Juli 2026

### Mehr verfügbare Quoten

- Wenn Sorare kurz vor dem Anpfiff noch keine H/D/A-Werte liefert, kann das
  Backend die fehlenden Matchquoten aus einer externen Quelle ergänzen.
- Eine zusätzliche Quotenquelle ergänzt fehlende Torquoten, wenn die bisherigen
  Anbieter keinen passenden Markt liefern oder ihr Abrufbudget geschont werden
  muss.
- Die zusätzliche Abdeckung umfasst MLS, österreichische Bundesliga,
  2. Bundesliga, HNL, Ligue 2 sowie Champions-, Europa- und Conference-League.
- Bereits gefundene Quoten bleiben gespeichert und sichtbar. Schutzregeln
  verhindern unnötige Wiederholungsabfragen bei den Quotenanbietern.

### Schnellere und robustere Kartenlisten

- Sichtbare Karten und wichtige Folgeabfragen werden bevorzugt, während
  Hintergrundkarten erst später geladen werden.
- Vorhandene Form- und Begegnungswerte bleiben bei einem vorübergehenden
  Netzwerkfehler sichtbar und werden automatisch erneut ergänzt.
- Große Spielerlisten werden effizienter gebündelt. Zu komplexe Anfragen werden
  automatisch in kleinere Teile zerlegt, statt die gesamte Liste fehlschlagen
  zu lassen.
- Ein kurzer, verständlicher Hinweis ersetzt lange technische Fehlermeldungen
  oberhalb der Karte.

## 0.3.2 – 29. Juli 2026

### Verlässlichere Spieler- und Kartenwerte

- AA L10 berücksichtigt nur Einsätze für den aktuellen Verein. Frühere Vereine
  und Nationalteamspiele verfälschen den Wert nicht mehr.
- Bei weniger als zehn gültigen Vereinseinsätzen zeigt die AA-Klammer einen
  verständlichen Hinweis. Die positionsbezogene Farbbewertung funktioniert
  bereits ab dem ersten gültigen Einsatz.
- Goalkeeper werden auch auf ungewöhnlichen Sorare-Seiten zuverlässiger als
  Torhüter erkannt und erhalten keine AA-Klammer.
- Karten mit mehrdeutigen Namen sowie dynamisch ausgetauschte Karten werden
  robuster dem richtigen Spieler und der richtigen Position zugeordnet.

### Aktuellere und konsistentere Begegnungsdaten

- Spieler desselben Teams verwenden dieselbe nächste Begegnung und dieselben
  Match- und Clean-Sheet-Wahrscheinlichkeiten.
- Neue Begegnungswerte erscheinen erst am Folgetag eines beendeten Spiels,
  statt schon während oder unmittelbar nach der laufenden Partie.
- Fehlende Match- und Clean-Sheet-Werte werden bei tatsächlich angesehenen
  Karten gezielt nachgeladen, ohne vorhandene Formwerte zu blockieren.
- Tor- und Assistmärkte decken zusätzliche Wettbewerbe ab und schützen die
  verfügbaren Anbieterlimits durch abgestufte Cache- und Reserve-Regeln.

### Schnellere und ruhigere Oberfläche

- Sichtbare Karten werden zuerst und große Kartenlisten schrittweise geladen.
- Bereits vorhandene Statistiken erscheinen sofort; langsame Quotenabfragen
  halten L10-Werte nicht mehr auf.
- Pack-, Bonus- und Kartenwechselanimationen zeigen die Klammern erst an einer
  stabilen Position und vermeiden nachlaufende oder flackernde Overlays.
- Matchbalken, Team-Tooltips und positionsabhängige Klammern werden in
  Lineups, Galerien und Pack-Ansichten konsistenter dargestellt.

## 0.3.1 – 26. Juli 2026

### Schnellere und robustere Daten

- Bereits vorhandene L10-Werte werden sofort angezeigt, während eine
  abgelaufene nächste Begegnung unabhängig im Hintergrund aktualisiert wird.
- Bereits geladene Statistiken bleiben auch bei vorübergehenden
  Speichereinschränkungen verfügbar und verschwinden nicht plötzlich.
- Spielerform und MLS-AA-Rangliste werden gebündelt montags aktualisiert.
  Schlägt die neue Rangliste fehl, bleibt der letzte gültige Stand erhalten.

### Dynamische Karten und Packs

- Overlays folgen wiederverwendeten oder ausgetauschten Sorare-Karten korrekt
  und übernehmen nicht mehr die Daten der vorherigen Karte.
- Bei Pack- und Bonusanimationen erscheinen die Klammern erst, wenn die Karte
  stabil steht; Loading-, No-Data- und Statistikzustände flackern dabei nicht
  mehr mit.
- Ergebnisdetails, reine Spieler-Infoseiten und andere Ansichten ohne echte
  Kartenansicht erhalten keine frei schwebenden Overlays.

### Positions- und Anzeigekorrekturen

- Kartenpositionen werden aus der konkreten Karte beziehungsweise dem
  Lineup-Slot bestimmt, ohne Positionsfilter aus benachbarten Pack-Inhalten zu
  übernehmen.
- AA-, Clean-Sheet-, Tor- und Assistklammern behalten über verschiedene
  Positionen hinweg feste Kategorienhöhen.
- Clean-Sheet-Werte für Goalkeeper und Defender werden unabhängig von den
  Spielerquotenmärkten geladen.

## 0.3.0 – 25. Juli 2026

### Spielerquoten

- Tor- und Assistwahrscheinlichkeiten für das nächste MLS-Spiel werden aus
  echten Buchmacherquoten von SportsGameOdds und The Odds API zusammengeführt.
- Verfügbare Einzelquoten der Buchmacher sind direkt an der jeweiligen
  Tor- oder Assistklammer nachvollziehbar.
- Fehlende Marktquoten können optional durch klar gekennzeichnete historische
  Werte aus L10, L15 oder L40 ersetzt werden.
- Wahrscheinlichkeiten lassen sich wahlweise als Prozent oder als faire
  Dezimalquote anzeigen.

### Positionsabhängige Kartenanzeige

- Feldspieler erhalten eine AA-Klammer sowie – soweit verfügbar – separate
  Tor- und Assistklammern.
- Goalkeeper zeigen ausschließlich die Clean-Sheet-Wahrscheinlichkeit; Defender
  behalten zusätzlich die nächste Clean-Sheet-Wahrscheinlichkeit im Header.
- Die Tor-/Assistklammer kann in den Einstellungen links oder rechts an der
  Karte platziert werden.
- Die besten drei MLS-Spieler jeder Feldposition werden anhand ihres AA L10 mit
  Gold-, Silber- oder Bronze-Rang gekennzeichnet.

### Sorare-Ansichten

- Im Lineup Builder zeigt ein proportionaler H/D/A-Balken die
  Spielwahrscheinlichkeiten; Teamnamen öffnen den zugehörigen Match-Tooltip.
- Dynamische Karten in Packs, Karussells und ausgewählten Lineups werden
  aktualisiert, ohne Sorare-Status- oder Bonusinformationen zu verdecken.
- Große Kartenlisten werden schrittweise geladen, damit die Spielerauswahl
  reaktionsfähig bleibt.

### Backend und Datenqualität

- Spieler-, Positions- und Begegnungszuordnung wurden für Karten ohne stabile
  Spielerlinks robuster gemacht.
- Spielerform, nächste Begegnung und Marktquoten werden getrennt gecacht und
  unabhängig aktualisiert, sodass vorhandene L10-Werte sofort erscheinen.
- Erfolgreiche Marktquoten werden pro Begegnung eingefroren; ein täglicher
  Vorwärmlauf und begrenzte Wiederholungsversuche reduzieren externe
  API-Anfragen.
- Torhüter werden nicht bei den Spielerquoten-Anbietern abgefragt.

## 0.2.4 – 24. Juli 2026

### Pack-Ansicht

- Pack-Hinweise und Bonusanimationen werden auch dann zuverlässig erkannt,
  wenn Sorare ihre Texte ohne Leerraum in benachbarten Elementen rendert.
- Die Stats bleiben dadurch vollständig oberhalb von „Neuer Spieler“ und
  `+5 % BONUS`, statt die Animation zu überdecken.

## 0.2.3 – 24. Juli 2026

### Pack-Ansicht

- Das Overlay hält oberhalb jeder Pack-Karte Platz für Sorare-Hinweise frei,
  auch wenn „Neue Karte“, „Neue Edition“ oder ein Bonusstatus nicht sichtbar
  beziehungsweise noch nicht geladen ist.
- Bei einem erkannten Status sitzt das Overlay mit zusätzlichem Abstand
  oberhalb der Meldung und verdeckt sie nicht.

## 0.2.2 – 24. Juli 2026

### Lineup Builder

- Unter der semantisch erkannten Teamzeile erscheint ein durchgehender,
  proportional segmentierter H/D/A-Quotenstrahl.
- Spielerteam, Remis und Gegner werden grün, grau und rot dargestellt; die
  Segmentbreiten entsprechen exakt den normalisierten Wahrscheinlichkeiten.
- Die zusätzliche Shadow-DOM-Anzeige fügt sich in den Kartenaufbau ein, ohne
  Teamnamen oder Anstoßzeit zu verdecken, und erzeugt bei dynamischen
  Aktualisierungen keine Duplikate.

## 0.2.1 – 24. Juli 2026

### Chrome-Web-Store-Vorbereitung

- Store-konforme Icons, ein 1280×800-Screenshot und eine 440×280-Promo-Kachel
  ergänzt.
- Extension-Name und Beschreibung weisen die Erweiterung ausdrücklich als
  inoffizielles Projekt aus.
- Reproduzierbarer Store-Build erzeugt eine ZIP mit Manifest im
  Wurzelverzeichnis, ohne Source Maps und ohne Secrets.
- Öffentliche Homepage, Supportseite und ausführliche Datenschutzerklärung
  werden vom vorhandenen Cloudflare Worker bereitgestellt.
- Store-Beschreibung, Single-Purpose-Erklärung, Berechtigungsbegründungen,
  Datenschutzangaben und Einreichungscheckliste dokumentiert.

## 0.2.0 – 24. Juli 2026

Diese Version fasst die Verbesserungen seit der zuletzt weitergegebenen ZIP
zusammen.

### Neue und verbesserte Statistiken

- `AA L10` wird positionsbezogen mit echten MLS-Perzentilen eingefärbt.
- Goalkeeper und Defender zeigen `NEXT CS%`; Midfielder und Forwards zeigen
  `NEXT W%`.
- `NEXT W%` nutzt nun echte MLS-Perzentile aus 238 abgeschlossenen Spielen
  statt starrer, für einen Dreiwegemarkt zu hoher Grenzwerte.
- Die neuen W%-Farbbänder sind Rot `<24 %`, Orange `24–31 %`, Gelb
  `32–41 %`, Grün `42–50 %`, Blau `51–56 %` und Lila `≥57 %`.
- Die Top 3 der positionsbezogenen MLS-AA-Rangliste erhalten beständige
  Gold-, Silber- und Bronze-Kennzeichnungen.
- Sample Size, Low Coverage und historische Rollenwerte bleiben im
  Mouseover-Tooltip nachvollziehbar.

### Spielquoten und Tooltip

- Quoten werden konsistent als `H / D / A` angezeigt.
- Spielerteam und zugehörige Siegquote werden fett-kursiv hervorgehoben.
- Aufgeklappte Tooltips kleiner Karten werden breiter und kompakter, damit sie
  möglichst einheitlich oberhalb der Karte erscheinen.
- Tooltips großer Karten weichen automatisch nach links, rechts oder unten
  aus, wenn sie sonst am Bildschirmrand abgeschnitten würden.

### Karten- und Spielererkennung

- Dynamisch geladene Karten werden über stabile Links und Bildbeschriftungen
  erkannt, ohne generierte Sorare-CSS-Klassen als primäre Selektoren zu nutzen.
- Kartenwechsel in Packs und Karussells aktualisieren das bestehende Overlay.
- Die konkrete Kartenposition wird bevorzugt über die Backend-Daten bestimmt.
- Namensvarianten und längere offizielle Sorare-Spielernamen werden robuster
  zugeordnet.
- Unsichtbare Hintergrundkarten hinter Pack-Dialogen erhalten keine störenden
  Overlays mehr.

### Pack-Ansicht und Bedienung

- Overlays berücksichtigen dynamisch „Neuer Spieler“, „Neue Edition“ und
  Bonusanimationen, ohne diese Entscheidungshinweise zu verdecken.
- Das Overlay kann über das Extension-Popup ein- und ausgeschaltet werden.
- Loading-, Fehler- und No-Data-Zustände werden verständlicher dargestellt.

### Backend und Zuverlässigkeit

- Das Cloudflare-Backend trennt Spielerform und Spielquoten in unterschiedlich
  lange Cache-Zeiträume.
- KV-Schreibvorgänge wurden reduziert, um das kostenlose Cloudflare-Limit zu
  schonen.
- Fixture-Daten enthalten Heimteam, Auswärtsteam, Spielerteam und Gegner,
  sodass Quoten korrekt zwischen Spieler- und H/D/A-Perspektive umgerechnet
  werden.
- Fehlende anonyme Sorare-Daten werden verzögert erneut versucht, statt
  dauerhaft als „nicht verfügbar“ zu gelten.
- Historische MLS-Analysen für AA, Clean Sheets und Siegquoten sind als
  wiederholbare Projektskripte enthalten.

## 0.1.0 – 23. Juli 2026

- Erste lokal verteilbare Chrome-/Edge-Version.
- Shadow-DOM-Overlay mit AA L10 und positionsabhängigen Zusatzwerten.
- TypeScript-Backend, gemeinsame Typen, Mock-Daten und automatisierte Tests.
