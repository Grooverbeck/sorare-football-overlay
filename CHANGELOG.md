# Changelog

Alle wichtigen Änderungen am Sorare Football Stats Overlay werden in dieser
Datei dokumentiert.

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
