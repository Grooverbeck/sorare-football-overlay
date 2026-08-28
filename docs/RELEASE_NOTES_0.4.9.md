# Sorare Football Overlay 0.4.9

Version 0.4.9 ist ein Hotfix für Spielerquoten, die bereits verfügbar waren,
im Overlay aber gelegentlich nur als historischer Ersatzwert erschienen.

## Fehlerbehebungen

- **Aktuelle Torquoten ohne manuelles Neuladen:** Bereits vorhandene
  Marktquoten werden zuverlässig nachgeladen, wenn eine Spielerkarte erneut
  sichtbar wird.
- **Historische Werte werden ersetzt:** Sobald eine echte Torquote verfügbar
  ist, ersetzt sie den historischen Ersatzwert automatisch.
- **Einheitliche Werte im selben Spiel:** Neue Marktwerte werden auch bei
  bereits sichtbaren Spielern derselben Begegnung berücksichtigt.
- **Keine zusätzlichen Buchmacherabfragen:** Die Nachprüfung liest nur den
  vorhandenen Overlay-Cache und verbraucht keine zusätzlichen Anbieter-Credits.

## Vorhandene Installation aktualisieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.4.9.zip` herunterladen.
2. Die ZIP entpacken und den Inhalt in den bisherigen Erweiterungsordner
   kopieren.
3. `chrome://extensions` oder `edge://extensions` öffnen.
4. Bei der Erweiterung auf **Neu laden** klicken.
5. Bereits geöffnete Sorare-Seiten einmal aktualisieren.

## Neu installieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.4.9.zip` herunterladen. Nicht die
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
