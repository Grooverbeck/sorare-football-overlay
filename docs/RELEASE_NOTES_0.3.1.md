# Sorare Football Stats Overlay 0.3.1

## Installation

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.3.1.zip` herunterladen.
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

### Schnellere und robustere Daten

- Vorhandene L10-Werte erscheinen sofort, auch wenn die nächste Begegnung
  aktualisiert werden muss.
- Bereits geladene Statistiken bleiben auch bei vorübergehenden
  Einschränkungen zuverlässig verfügbar.
- Spielerform und MLS-AA-Rangliste werden gebündelt montags aktualisiert.

### Zuverlässigere dynamische Karten

- Wiederverwendete Sorare-Karten wechseln zuverlässig auf den richtigen
  Spieler und die richtige Position.
- Pack- und Bonusanimationen zeigen die Klammern erst nach dem stabilen
  Kartenstand und ohne nachlaufende oder flackernde Zustände.
- Ansichten ohne echte Kartenansicht sowie Ergebnisdetails erhalten keine
  frei schwebenden Overlays.

### Konsistente positionsabhängige Werte

- AA-, Clean-Sheet-, Tor- und Assistklammern behalten feste Kategorienhöhen.
- Goalkeeper und Defender laden Clean-Sheet-Werte unabhängig von
  Tor-/Assistmärkten.
- Die letzte gültige Top-3-Rangliste bleibt erhalten, falls eine wöchentliche
  Aktualisierung fehlschlägt.

## Hinweise

- Unterstützt Google Chrome und Microsoft Edge.
- Die Erweiterung nutzt das produktive Cloudflare-Backend; eigene API-Schlüssel
  oder Sorare-Zugangsdaten sind nicht erforderlich.
- Dies ist eine inoffizielle Erweiterung und kein Produkt von Sorare.
