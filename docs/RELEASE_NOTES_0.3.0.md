# Sorare Football Stats Overlay 0.3.0

## Installation

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.3.0.zip` herunterladen.
2. Nicht die von GitHub erzeugte Datei **Source code (zip)** verwenden.
3. Die ZIP in einen dauerhaften Ordner entpacken.
4. `chrome://extensions` oder `edge://extensions` öffnen.
5. Den Entwicklermodus aktivieren.
6. **Entpackte Erweiterung laden** wählen und den Ordner mit `manifest.json`
   auswählen.

Ausführliche Anleitung:
[Installation und Updates](https://github.com/Grooverbeck/sorare-football-overlay/blob/main/docs/INSTALLATION.md)

## Update einer vorhandenen Installation

Den Inhalt der neuen ZIP in denselben Erweiterungsordner entpacken, auf der
Erweiterungsseite **Neu laden** anklicken und offene Sorare-Tabs aktualisieren.

## Neue Funktionen

### Echte Spielerquoten

- Tor- und Assistwahrscheinlichkeiten aus SportsGameOdds und The Odds API
- Einzelquoten der verfügbaren Buchmacher im jeweiligen Markt-Tooltip
- optionale historische Ersatzwerte aus L10, L15 oder L40
- Anzeige als Prozent oder faire Dezimalquote

### Positionsabhängige Kartenwerte

- Feldspieler: AA sowie verfügbare Tor- und Assistquoten
- Goalkeeper: ausschließlich die nächste Clean-Sheet-Wahrscheinlichkeit
- Defender: zusätzliche nächste Clean-Sheet-Wahrscheinlichkeit im Header
- Gold-, Silber- und Bronze-Kennzeichnung für die AA-Top-3 jeder
  MLS-Feldposition

### Lineup Builder und dynamische Karten

- proportionaler H/D/A-Quotenbalken mit Match-Tooltip
- Unterstützung für dynamische Pack-, Karussell- und Lineup-Karten
- schrittweises Laden großer Kartenlisten

### Zuverlässigere Daten

- robustere Zuordnung von Spielern, Kartenpositionen und Begegnungen
- unabhängige Aktualisierung von Spielerform, nächstem Spiel und Marktquoten
- eingefrorene Quoten-Snapshots pro Begegnung mit sparsamer Vorwärmung und
  begrenzten Wiederholungsversuchen

## Hinweise

- Unterstützt Google Chrome und Microsoft Edge.
- Die Erweiterung nutzt das produktive Cloudflare-Backend; eigene API-Schlüssel
  oder Sorare-Zugangsdaten sind nicht erforderlich.
- Dies ist eine inoffizielle Erweiterung und kein Produkt von Sorare.
