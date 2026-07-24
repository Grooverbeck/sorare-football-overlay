# Changelog

Alle wichtigen Änderungen am Sorare Football Stats Overlay werden in dieser
Datei dokumentiert.

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

- Begegnungen stehen immer in der eindeutigen Reihenfolge
  `Heimteam – Auswärtsteam`.
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
