# Chrome-Web-Store-Upload 0.4.16

## Paket

- Datei: `artifacts/sorare-football-overlay-chrome-web-store-0.4.16.zip`
- Den bestehenden Store-Eintrag aktualisieren, keinen neuen Eintrag anlegen.
- [Öffentlicher Store-Link](https://chromewebstore.google.com/detail/sorare-football-stats-ove/ddolakmpillologhigdmolbbmfphakjm)
- Das Backend mit der Nationalteam-Korrektur ist bereits produktiv.
- Keine neuen Browserberechtigungen. Vorherige ZIP-Dateien bleiben unverändert.
- Größe: 821.214 Bytes.
- SHA-256: `1ddabe4843f25c722c8f09ae6dbcfb9dbcbe76223ca1e0cd653b729b8ed682da`.

## Paketprüfung

- 928 Tests erfolgreich: Shared 84, API 353, Worker 48, Extension 443.
- Typechecks und Produktionsbuild erfolgreich.
- ZIP testweise entpackt: 11 Dateien, Manifest V3 und Version 0.4.16.
- Dateien entsprechen dem geprüften Build; Balken-Fix in JavaScript und CSS enthalten.
- Keine Source Maps oder lokalen Secrets; ausschließlich das Produktions-Backend.
- Berechtigungen unverändert: `storage` und Zugriff auf das Produktions-Backend.

## Kurzer Update-Text

**Bugfixes:** Keine doppelten Matchbalken mehr: Sobald unser Overlay einen
eigenen Balken anzeigt, wird der neue Sorare-Balken ausgeblendet. Ohne eigene
Werte bleibt Sorare sichtbar. Außerdem werden vorhandene Match- und
Clean-Sheet-Quoten bei Länderspielen jetzt dem richtigen Nationalteam zugeordnet.

## Vor dem Absenden

1. Neues Paket in den bestehenden Store-Eintrag hochladen.
2. Prüfen, dass das Dashboard Version **0.4.16** anzeigt.
3. Beschreibung anhand von [LISTING.de.md](LISTING.de.md) aktualisieren.
4. Falls 0.4.15 im Store übersprungen wurde: Auch die Hinweise zur gemeinsamen
   Kartenerkennung aus [PRIVACY-DISCLOSURES.md](PRIVACY-DISCLOSURES.md) berücksichtigen.
5. Bestehende Grafiken, Store-URL und Datenschutzerklärung beibehalten.
6. Veröffentlichungsoption prüfen und das Update zur Prüfung einreichen.

Der GitHub-Release bedeutet nicht, dass diese Version bereits im Store
eingereicht oder von Google freigegeben wurde.
