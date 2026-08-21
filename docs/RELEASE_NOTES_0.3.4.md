# Sorare Football Overlay 0.3.4

Diese Version zeigt Quoten zuverlässiger an, verbessert den AA-Wert und bringt
eine platzsparende Ansicht für Squad- und Lineup-Seiten.

## Das ist neu

### Mehr Quoten für mehr Wettbewerbe

- Die Erweiterung findet jetzt häufiger Spiel-, Tor- und Assistquoten. Die
  Abdeckung wurde unter anderem für Premier League, La Liga, Ligue 1, Ligue 2,
  Bundesliga, 2. Bundesliga, HNL, österreichische Bundesliga, MLS und die
  europäischen Wettbewerbe verbessert.
- Spieler werden auch nach einem Vereinswechsel oder bei leicht abweichenden
  Schreibweisen zuverlässiger erkannt. Dadurch fehlen seltener Quoten oder
  werden dem falschen Verein zugeordnet.
- Sobald eine echte Tor- oder Assistquote verfügbar ist, ersetzt sie den
  vorläufigen historischen Wert automatisch. Ein Neuladen der Sorare-Seite ist
  dafür nicht mehr nötig.

### Passenderer AA-Wert

- Für den AA-Wert zählen nur noch Spiele, in denen der Spieler mindestens
  60 Minuten eingesetzt wurde. Kurze Einwechslungen verfälschen den Wert damit
  nicht mehr so stark.
- Derselbe Spieler erhält in Suche, Lineup und Aufstellung konsistentere Werte.
  Tatsächlich unterschiedliche Kartenpositionen bleiben weiterhin getrennt.

### Neue Compact View

- In den Einstellungen kann jetzt die **Compact View** aktiviert werden.
- Auf Squad- und Lineup-Seiten sind zunächst nur die kleinen farbigen
  Kennzeichen sichtbar. Sobald du mit der Maus über die Karte fährst, werden
  alle Werte eingeblendet.
- Beim Zusammenstellen eines Teams bleiben alle Werte wie bisher dauerhaft
  sichtbar.
- Kleine Klammern, Symbole und Hinweise bei fehlenden Daten wurden besser
  ausgerichtet und vereinheitlicht.

### Zuverlässigere Anzeige

- Bereits angezeigte Werte verschwinden bei einer kurzen Störung nicht mehr so
  schnell. Die Erweiterung versucht den Abruf automatisch erneut.
- Neu gefundene Quoten werden selbstständig auf den sichtbaren Karten ergänzt.

## Vorhandene Installation aktualisieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.3.4.zip` herunterladen.
2. Die ZIP entpacken und den Inhalt in den bisherigen Erweiterungsordner
   kopieren.
3. `chrome://extensions` oder `edge://extensions` öffnen.
4. Bei der Erweiterung auf **Neu laden** klicken.
5. Bereits geöffnete Sorare-Seiten einmal aktualisieren.

## Neu installieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.3.4.zip` herunterladen. Nicht die
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
