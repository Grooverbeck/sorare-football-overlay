# Sorare Football Overlay 0.4.3

Diese Version macht die neuen Sortierfunktionen im Lineup Builder vollständiger
und behebt vertauschte oder unpassende Spielquoten-Balken.

## Das ist neu

- **Alle passenden Spieler werden einsortiert:** Vor einer Sortierung nach
  **Torquote** oder **AA** lädt die Erweiterung auch die Spieler nach, die Sorare
  zunächst außerhalb des sichtbaren Bereichs zurückhält.
- **Keine störenden Scrollsprünge:** Das Nachladen läuft im Hintergrund. Ein
  verständlicher Fortschrittsstatus zeigt, was gerade passiert.
- **Sorare-Filter funktionieren wie gewohnt:** Das geöffnete Filtermenü hat
  Vorrang. Nach dem Schließen wird die gewählte Sortierung automatisch auf die
  gefilterte Liste angewendet.
- **Positionen bleiben sauber getrennt:** Beim Wechsel des Lineup-Platzes werden
  beispielsweise keine Verteidiger mehr in eine Mittelfeld-Auswahl übernommen.
- **Spielbalken stehen auf der richtigen Seite:** Heim-, Unentschieden- und
  Auswärtssieg werden passend zur sichtbaren Teamreihenfolge angezeigt.
- **Keine Quoten aus der falschen Begegnung:** Passt eine gespeicherte Begegnung
  nicht zum sichtbaren Gegner, bleibt der Balken ausgeblendet, statt irreführende
  Werte zu zeigen.

## Vorhandene Installation aktualisieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.4.3.zip` herunterladen.
2. Die ZIP entpacken und den Inhalt in den bisherigen Erweiterungsordner
   kopieren.
3. `chrome://extensions` oder `edge://extensions` öffnen.
4. Bei der Erweiterung auf **Neu laden** klicken.
5. Bereits geöffnete Sorare-Seiten einmal aktualisieren.

## Neu installieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.4.3.zip` herunterladen. Nicht die
   automatisch erzeugte Datei **Source code (zip)** verwenden.
2. Die ZIP in einen dauerhaften Ordner entpacken.
3. `chrome://extensions` oder `edge://extensions` öffnen.
4. Den Entwicklermodus aktivieren.
5. **Entpackte Erweiterung laden** wählen und den entpackten Ordner öffnen.

Eine ausführliche Anleitung findest du unter
[Installation und Updates](https://github.com/Grooverbeck/sorare-football-overlay/blob/main/docs/INSTALLATION.md).

Die Erweiterung unterstützt Google Chrome und Microsoft Edge. Eigene
API-Schlüssel oder Sorare-Zugangsdaten sind nicht erforderlich. Dies ist eine
inoffizielle Erweiterung und kein Produkt von Sorare.
