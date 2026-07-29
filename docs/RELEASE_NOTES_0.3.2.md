# Sorare Football Stats Overlay 0.3.2

## Installation

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.3.2.zip` herunterladen.
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

## Änderungen

### Verlässlichere Spielerwerte

- AA L10 verwendet nur Einsätze für den aktuellen Verein. Frühere Vereine und
  Nationalteamspiele fließen nicht mehr ein.
- Eine gut sichtbare Warnung kennzeichnet AA-Werte mit weniger als zehn
  gültigen Vereinseinsätzen.
- Die AA-Farbe zeigt die positionsbezogene Einordnung bereits ab dem ersten
  gültigen Einsatz.
- Goalkeeper und Karten mit mehrdeutigen Spielernamen werden zuverlässiger
  erkannt.

### Konsistentere Begegnungen und Quoten

- Spieler desselben Teams zeigen dieselbe nächste Begegnung sowie dieselben
  Match- und Clean-Sheet-Wahrscheinlichkeiten.
- Nach einem Spiel bleibt dessen Kontext bis zum Folgetag erhalten. Die Werte
  des nächsten Spiels werden nicht mehr zu früh eingeblendet.
- Fehlende Match- und Clean-Sheet-Werte werden gezielt nachgeladen, sobald die
  betroffenen Karten angesehen werden.
- Zusätzliche Wettbewerbe können Tor- und Assistquoten liefern; Schutzregeln
  vermeiden unnötige Anfragen an die Quotenanbieter.

### Schnellere und stabilere Anzeige

- Sichtbare Karten werden zuerst geladen und große Listen schrittweise ergänzt.
- Vorhandene L10-Werte erscheinen sofort, ohne auf langsamere Quotenabfragen zu
  warten.
- Overlays folgen dynamischen Kartenwechseln zuverlässiger und bleiben bei
  Pack- und Bonusanimationen ruhig an ihrer Position.
- Klammern, Matchbalken und Tooltips sind in Lineups, Galerien und Pack-Ansichten
  konsistenter.

## Hinweise

- Unterstützt Google Chrome und Microsoft Edge.
- Die Erweiterung nutzt das produktive Backend; eigene API-Schlüssel oder
  Sorare-Zugangsdaten sind nicht erforderlich.
- Dies ist eine inoffizielle Erweiterung und kein Produkt von Sorare.
