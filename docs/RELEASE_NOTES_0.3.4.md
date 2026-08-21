# Sorare Football Stats Overlay 0.3.4

## Installation

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.3.4.zip` herunterladen.
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

### Mehr und verlässlichere Quoten

- Verbesserte Anbieter-Routen liefern je nach Wettbewerb mehr Spiel-, Tor- und
  Assistquoten für Premier League, La Liga, Ligue 1, Ligue 2, Bundesliga,
  2. Bundesliga, HNL, österreichische Bundesliga, MLS und UEFA-Wettbewerbe.
- Kanonische Team-Identitäten, Transfers und abweichende Spielernamen werden
  robuster zugeordnet. Das reduziert fehlende Quoten und falsche Vereine.
- Bereits gecachte Tor- und Assistquoten gehen bei Teilantworten nicht mehr
  verloren und verdrängen historische Ersatzwerte zuverlässig.
- Neue Marktquoten erscheinen nach einem laufenden Anbieterabruf automatisch,
  ohne dass die Sorare-Seite manuell neu geladen werden muss.

### Aussagekräftigere Formwerte

- AA zählt nur Spiele, in denen der Spieler mindestens 60 Minuten eingesetzt
  wurde, und wird dadurch weniger von kurzen Einwechslungen beeinflusst.
- Spielerwerte bleiben über unterschiedliche Sorare-Kartenansichten hinweg
  konsistent, ohne echte Positionsvarianten zu vermischen.

### Compact View und Kartenanzeige

- Die neue optionale **Compact View** zeigt auf Squad- und Lineups-Seiten
  zunächst nur das farbige AA- beziehungsweise Marktsymbol. Beim Überfahren
  der Karte werden die vollständigen Werte eingeblendet.
- Auf `/compose-team` bleiben die Klammern dauerhaft vollständig sichtbar.
- Abstände, Ausrichtung, Schrift, Symbole und No-Data-Darstellung wurden für
  kleine Karten vereinheitlicht.
- Vorhandene Werte bleiben während kurzzeitiger Wiederholungsversuche sichtbar,
  statt vorzeitig durch „nicht verfügbar“ ersetzt zu werden.

## Hinweise

- Unterstützt Google Chrome und Microsoft Edge.
- Die Erweiterung nutzt das produktive Backend; eigene API-Schlüssel oder
  Sorare-Zugangsdaten sind nicht erforderlich.
- Dies ist eine inoffizielle Erweiterung und kein Produkt von Sorare.
