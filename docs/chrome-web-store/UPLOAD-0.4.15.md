# Chrome-Web-Store-Upload 0.4.15

## Paket

- Datei: `artifacts/sorare-football-overlay-chrome-web-store-0.4.15.zip`
- Bestehenden Store-Eintrag aktualisieren, keinen neuen Eintrag anlegen.
- [Öffentlicher Store-Link](https://chromewebstore.google.com/detail/sorare-football-stats-ove/ddolakmpillologhigdmolbbmfphakjm)
- Das Backend mit dem gemeinsamen Kartenkatalog ist bereits produktiv.
- Keine neuen Browserberechtigungen; die bisherige ZIP 0.4.14 bleibt unverändert.
- Größe: 818.395 Bytes.
- SHA-256: `0bec57db7f739e932da8bcc79d895f370c50799f57edf4fd99ea52b8281a850a`.

## Paketprüfung

- 909 Tests erfolgreich (Shared 84, API 346, Worker 46, Extension 433).
- Codegen, Typechecks und Produktionsbuild erfolgreich.
- ZIP testweise entpackt: 11 Dateien, `manifest.json` auf der obersten Ebene,
  Version 0.4.15 und Manifest V3.
- Paketdateien stimmen mit dem geprüften Build überein; keine Source Maps,
  lokalen Secrets oder Entwicklungs-Backend-Adressen enthalten.
- Berechtigungen unverändert: `storage` und Zugriff auf das Produktions-Backend.

## Texte für das Dashboard

Die vollständige aktualisierte Beschreibung steht in [LISTING.de.md](LISTING.de.md).
Die Kartenbild-Abfragen sind in [PRIVACY-DISCLOSURES.md](PRIVACY-DISCLOSURES.md)
und der öffentlichen Datenschutzerklärung (Stand 20. September 2026, Version 1.3)
beschrieben. Die passenden Dashboard-Beschreibungen vor dem Einreichen abgleichen.

### Kurzer Update-Text

**Neu und verbessert:** Bessere automatische Erkennung animierter Set-Karten,
passendere Farben für das europäische Set und klarere Hinweise bei fehlenden
AA-Daten. Die Buchstabenbewertungen neben der Startelfwahrscheinlichkeit werden
ausgeblendet.

**Bugfixes:** Zuverlässigere Sortierung großer Spielerpools, weniger Probleme
mit nachgeladenen Videokarten und korrigierte Ladeanzeigen. Angezeigte Torquoten
passen zur Sortierung. Außerdem wurden die Kartenpositionserkennung für AA
und flackernde Matchbalken verbessert.

## Vor dem Absenden

1. Neues Paket in den bestehenden Store-Eintrag hochladen.
2. Prüfen, dass das Dashboard Version **0.4.15** anzeigt.
3. Beschreibung und Datenschutzhinweise anhand der oben verlinkten Dateien aktualisieren.
4. Bestehende Grafiken und Store-URL beibehalten.
5. Gewünschte Veröffentlichungsoption prüfen und das Update zur Prüfung einreichen.

Der GitHub-Release bedeutet nicht, dass diese Version bereits im Store
eingereicht oder von Google freigegeben wurde.
