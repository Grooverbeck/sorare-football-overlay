# Erweiterung installieren und aktualisieren

Diese Anleitung ist für Nutzer gedacht, die die fertige Sorare-Erweiterung
verwenden möchten. Node.js, npm und eigene Sorare-API-Zugangsdaten sind dafür
nicht erforderlich.

## Unterstützte Browser

- Google Chrome
- Microsoft Edge
- Mozilla Firefox Desktop ab Version 140 (Android ab Version 142)

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

## Firefox aus dem Quellcode laden

Für Firefox wird ein eigenes Manifest mit einem Background-Skript gebaut. Die
Chromium-Ausgabe bleibt davon getrennt und liegt weiterhin unter `dist`.
Der direkte Firefox-Build ist ein Entwicklungsbuild und verwendet standardmäßig
`http://localhost:8787`. Starte dafür bei Bedarf in einem zweiten Terminal das
lokale Backend mit `npm run dev:api`; ohne lokales Backend erscheinen keine
Statistiken.

1. Installiere Node.js 22 oder neuer und npm.
2. Klone oder entpacke das Projekt und führe im Projektordner aus:

   ```powershell
   npm install
   npm run build:firefox
   ```

   Für einen normalen Test gegen das öffentliche Backend verwende
   `npm run package:firefox`. Dieser Befehl baut `dist-firefox` gegen das
   produktive Cloudflare-Backend und erzeugt zusätzlich eine als
   `-unsigned` markierte ZIP unter `artifacts/`. Diese ZIP ist nicht dauerhaft
   installierbar.

3. Öffne in Firefox `about:debugging#/runtime/this-firefox`.
4. Klicke auf **Temporäres Add-on laden**.
5. Wähle
   `apps/extension/dist-firefox/manifest.json` aus.
6. Öffne oder aktualisiere anschließend eine Sorare-Fußballseite.

Die temporäre Installation endet beim Neustart von Firefox. Nach einem neuen
Build auf der Debugging-Seite **Neu laden** anklicken und die bereits geöffneten
Sorare-Tabs aktualisieren.

Eine dauerhafte Installation in Firefox Release/Beta erfordert ein von Mozilla
signiertes Add-on. Dafür kann das erzeugte Firefox-Paket später über AMO als
gelistetes oder nicht gelistetes Add-on signiert werden; der Release-Workflow
kann bei konfigurierten AMO-Secrets ein signiertes XPI erzeugen.
Ohne diese Secrets wird nur das ausdrücklich als `-unsigned` gekennzeichnete
Entwicklerpaket veröffentlicht.

### Firefox aus einem GitHub-Release installieren

Wenn das Release ein Asset wie
`sorare-football-overlay-firefox-<VERSION>.xpi` enthält, kann es in einem
normalen Firefox Release/Beta installiert werden: XPI herunterladen, in
Firefox öffnen und die Installation bestätigen. Dieses XPI ist über Mozilla
AMO signiert.

Ein Asset mit dem Namen
`sorare-football-overlay-firefox-<VERSION>-unsigned.zip` ist dagegen nur für
die temporäre Installation über `about:debugging` geeignet.

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

Bei Firefox für die lokale Entwicklung muss in `about:debugging` die Datei
`apps/extension/dist-firefox/manifest.json` ausgewählt werden. Eine unsignierte
ZIP lässt sich in einem normalen Firefox Release nicht als dauerhaftes Add-on
installieren.

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

Für Firefox `about:addons` öffnen und die Erweiterung entfernen. Bei einer
temporären Installation verschwindet sie alternativ beim Neustart des Browsers.

Sobald eine freigegebene Chrome-Web-Store-Version verfügbar ist, übernimmt
der Store Installation und Updates automatisch. Bis dahin ist das hier
beschriebene Release-Verfahren die vorgesehene Installationsmethode.
