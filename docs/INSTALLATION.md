# Erweiterung installieren und aktualisieren

Diese Anleitung ist für Nutzer gedacht, die die fertige Sorare-Erweiterung
verwenden möchten. Node.js, npm und eigene Sorare-API-Zugangsdaten sind dafür
nicht erforderlich.

## Unterstützte Browser

- Google Chrome
- Microsoft Edge

Die manuell installierte Version wird gegen das öffentliche Backend des
Projekts gebaut. Zugangsdaten oder Sorare-Passwörter gehören niemals in die
Erweiterung.

## Erstinstallation

1. Öffne das
   [neueste GitHub-Release](https://github.com/Grooverbeck/sorare-football-overlay/releases/latest).
2. Klappe unten den Bereich **Assets** auf.
3. Lade die Datei herunter, deren Name mit
   `sorare-football-overlay-chrome-web-store-` beginnt und mit `.zip` endet.
4. Verwende **nicht** die automatisch von GitHub angebotenen Dateien
   `Source code (zip)` oder `Source code (tar.gz)`.
5. Erstelle einen dauerhaften Ordner, zum Beispiel
   `C:\SorareOverlay\extension`.
6. Entpacke den Inhalt der heruntergeladenen ZIP direkt in diesen Ordner.
   Im ausgewählten Ordner muss anschließend die Datei `manifest.json` liegen.
7. Öffne die Erweiterungsverwaltung:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
8. Aktiviere den **Entwicklermodus**.
9. Klicke auf **Entpackte Erweiterung laden** und wähle den Ordner aus, in dem
   die `manifest.json` liegt.
10. Öffne oder aktualisiere anschließend eine Sorare-Fußballseite.

Über das Erweiterungssymbol in der Browserleiste lässt sich das Overlay
jederzeit ein- und ausschalten.

## Manuelles Update

Bei einer manuellen Installation installiert der Browser GitHub-Releases
nicht automatisch. Ein Update dauert aber nur wenige Schritte:

1. Lade im
   [neuesten Release](https://github.com/Grooverbeck/sorare-football-overlay/releases/latest)
   die neue Erweiterungs-ZIP aus **Assets** herunter.
2. Beende offene Sorare-Tabs oder lasse sie bis zum abschließenden Neuladen
   unbenutzt.
3. Lösche den Inhalt deines bisherigen Erweiterungsordners und entpacke den
   Inhalt der neuen ZIP wieder in **denselben Ordner**.
4. Öffne `chrome://extensions` beziehungsweise `edge://extensions`.
5. Klicke bei **Sorare Football Stats Overlay – Unofficial** auf
   **Neu laden**.
6. Aktualisiere bereits geöffnete Sorare-Tabs.
7. Kontrolliere auf der Erweiterungsseite, ob die neue Versionsnummer
   angezeigt wird.

Der gleichbleibende Ordner ist wichtig: Wird jede Version aus einem anderen
Pfad geladen, kann der Browser sie als zusätzliche Erweiterung behandeln.

## Fehlerbehebung

### „Manifestdatei fehlt“ oder der Ordner lässt sich nicht laden

Meist wurde der übergeordnete Download-Ordner ausgewählt. Öffne den entpackten
Ordner und wähle genau den Ordner aus, in dem `manifest.json` liegt.

### Nach einem Update erscheint noch die alte Anzeige

1. Auf der Erweiterungsseite **Neu laden** anklicken.
2. Den Sorare-Tab mit `Strg+R` aktualisieren.
3. Prüfen, ob nicht versehentlich zwei Versionen der Erweiterung installiert
   sind.

### Es werden keine Statistiken angezeigt

1. Über das Erweiterungssymbol prüfen, ob das Overlay aktiviert ist.
2. Die Sorare-Seite neu laden.
3. Den Status des Backends unter
   [sorare-football-overlay-api.grooverbeck.workers.dev/health](https://sorare-football-overlay-api.grooverbeck.workers.dev/health)
   prüfen.
4. Falls nur einzelne Spieler betroffen sind, kann für diese Karte oder das
   nächste Spiel vorübergehend keine ausreichende Datenbasis vorliegen.

## Deinstallation

1. `chrome://extensions` beziehungsweise `edge://extensions` öffnen.
2. Bei der Erweiterung **Entfernen** auswählen.
3. Danach kann der lokale Erweiterungsordner gelöscht werden.

Sobald eine freigegebene Chrome-Web-Store-Version verfügbar ist, übernimmt
der Store Installation und Updates automatisch. Bis dahin ist das hier
beschriebene Release-Verfahren die vorgesehene Installationsmethode.
