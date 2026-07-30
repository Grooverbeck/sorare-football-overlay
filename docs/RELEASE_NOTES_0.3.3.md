# Sorare Football Stats Overlay 0.3.3

## Installation

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.3.3.zip` herunterladen.
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

### Mehr verfügbare Quoten

- Fehlende Matchquoten können kurz vor dem Anpfiff aus einer externen Quelle
  ergänzt werden, wenn Sorare noch keine H/D/A-Werte liefert.
- Eine zusätzliche Quotenquelle ergänzt fehlende Torquoten, wenn die bisherigen
  Anbieter keinen passenden Markt liefern oder ihr Abrufbudget geschont werden
  muss.
- Die zusätzliche Abdeckung umfasst MLS, österreichische Bundesliga,
  2. Bundesliga, HNL, Ligue 2 sowie Champions-, Europa- und Conference-League.
- Bereits gefundene Quoten bleiben gespeichert und auch bei geschützten
  Anbieterlimits verfügbar.

### Schnellere und robustere Anzeige

- Sichtbare Karten werden zuerst geladen; große Kartenlisten reagieren dadurch
  schneller.
- Vorhandene Form- und Begegnungswerte bleiben bei vorübergehenden Fehlern
  sichtbar und werden automatisch ergänzt.
- Große oder zu komplexe Spielerabfragen werden zuverlässig in kleinere
  Gruppen aufgeteilt.
- Technische Fehlermeldungen oberhalb der Karte wurden durch einen kurzen,
  verständlichen Hinweis ersetzt.

## Hinweise

- Unterstützt Google Chrome und Microsoft Edge.
- Die Erweiterung nutzt das produktive Backend; eigene API-Schlüssel oder
  Sorare-Zugangsdaten sind nicht erforderlich.
- Dies ist eine inoffizielle Erweiterung und kein Produkt von Sorare.
