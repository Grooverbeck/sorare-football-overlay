# Sorare Football Overlay 0.4.0

Mit dieser Version kannst du Spieler im Lineup Builder direkt nach ihrer
Torwahrscheinlichkeit oder ihrem AA-Wert sortieren.

![Neue Sortierung nach Torquote und AA](https://github.com/Grooverbeck/sorare-football-overlay/releases/download/v0.4.0/github-release-0.4.0-sort-menu.png)

## Das ist neu

### Torquote und AA direkt im Sorare-Menü

- Öffne im Lineup Builder das bekannte Sorare-Menü **Sortieren nach**. Dort
  findest du jetzt zusätzlich **Torquote** und **AA**.
- **Torquote** sortiert Spieler nach ihrer Torwahrscheinlichkeit. Wenn eine
  echte Marktquote vorhanden ist, wird sie verwendet. Andernfalls kann der
  historische Wert einspringen. Beide Werte werden in einer gemeinsamen Liste
  verglichen.
- **AA** sortiert nach dem durchschnittlichen All-Around Score der letzten zehn
  gültigen Spiele. Kurze Einsätze zählen nicht: Der Spieler muss mindestens
  60 Minuten gespielt haben.
- Spieler ohne passenden Wert bleiben am Ende der Liste. Treffen Daten etwas
  später ein, aktualisiert sich die Reihenfolge automatisch.
- Sobald du wieder eine normale Sorare-Sortierung auswählst, stellt die
  Erweiterung Sorare-Reihenfolge wieder her.

### Klammern bleiben bei ihrer Karte

- Beim Scrollen verschwinden die Klammern jetzt zusammen mit dem Kartenbild.
  Sie liegen dadurch nicht mehr über fixierten Sorare-Menüs oder anderen
  Bedienelementen, wenn die Karte selbst bereits verdeckt ist.

## Vorhandene Installation aktualisieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.4.0.zip` herunterladen.
2. Die ZIP entpacken und den Inhalt in den bisherigen Erweiterungsordner
   kopieren.
3. `chrome://extensions` oder `edge://extensions` öffnen.
4. Bei der Erweiterung auf **Neu laden** klicken.
5. Bereits geöffnete Sorare-Seiten einmal aktualisieren.

## Neu installieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.4.0.zip` herunterladen. Nicht die
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
