# Sorare Football Overlay 0.4.11

Dieses Update macht das Laden und Aktualisieren der Spielerwerte zuverlässiger.

## Verbesserungen

- **Aktuellere Spielerwerte:** Ältere gespeicherte Daten werden bei erneuter Nutzung aktualisiert – auch wenn die Sorare-Seite schon länger geöffnet ist.
- **Zuverlässigeres Nachladen:** Fehlende Clean-Sheet-Chancen werden zuverlässiger nachgeprüft und ergänzt, sobald sie verfügbar sind.
- **Robusteres Laden:** Bereits verfügbare Spielerwerte gehen nicht mehr verloren, wenn einzelne andere Spieler länger laden. Gleichzeitige Abrufe werden besser gebündelt.

## Fehlerbehebungen

- **Torquoten-Sortierung:** Der Ladevorgang wird auch dann korrekt abgeschlossen, wenn Sorare die Kartenliste zwischendurch neu aufbaut.
- **Spielernamen:** Abweichende Namen bei Quotenanbietern, zum Beispiel „Rodri“, werden zuverlässiger zugeordnet.

## Vorhandene Installation aktualisieren

1. Unter **Assets** die Datei `sorare-football-overlay-chrome-web-store-0.4.11.zip` herunterladen.
2. Die ZIP entpacken und den Inhalt in den bisherigen Erweiterungsordner kopieren.
3. `chrome://extensions` oder `edge://extensions` öffnen und bei der Erweiterung auf **Neu laden** klicken.
4. Bereits geöffnete Sorare-Seiten einmal aktualisieren.

Die Backend-Verbesserungen sind bereits aktiv. Für die Änderungen an der Erweiterung bitte das neue Paket installieren.

## Neu installieren

Die ZIP unter **Assets** herunterladen und in einen dauerhaften Ordner entpacken. Unter `chrome://extensions` oder `edge://extensions` den **Entwicklermodus** aktivieren und über **Entpackte Erweiterung laden** den entpackten Ordner auswählen. Nicht die automatisch angebotene Datei **Source code (zip)** verwenden.

[Ausführliche Installationsanleitung](https://github.com/Grooverbeck/sorare-football-overlay/blob/main/docs/INSTALLATION.md)

Für Google Chrome und Microsoft Edge. Eigene API-Schlüssel oder Sorare-Zugangsdaten sind nicht erforderlich. Dies ist eine inoffizielle Erweiterung und kein Produkt von Sorare.
