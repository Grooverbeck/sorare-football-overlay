# Öffentliche Roadmap

Stand: 26. Juli 2026

Diese Roadmap zeigt die geplanten Entwicklungsbereiche des Sorare Football
Stats Overlay. Sie beschreibt bewusst die sichtbaren Produktziele; detaillierte
technische Betriebs- und Sicherheitsaufgaben werden intern verwaltet.

## Aktueller Schwerpunkt

### Zuverlässigkeit und Geschwindigkeit

- [ ] Statistiken auch bei vorübergehend nicht verfügbaren Datenquellen
  möglichst stabil anzeigen
- [ ] Ladezeiten in großen Kartenlisten weiter reduzieren
- [ ] Aktualisierungen im Hintergrund durchführen, ohne vorhandene Werte
  unnötig auszublenden
- [ ] Pack-, Scroll- und Animationsansichten noch robuster behandeln

### Richtige Spieler-, Positions- und Spielzuordnung

- [ ] Konkrete Kartenposition in allen unterstützten Sorare-Ansichten
  zuverlässig erkennen
- [ ] Laufende, abgeschlossene und kommende Begegnungen eindeutig
  unterscheiden
- [ ] Club- und Nationalmannschaftsspiele konsistent unterstützen
- [ ] Bei unsicherer Zuordnung lieber neutral als irreführend anzeigen

### Fachliche Qualität

- [ ] Herkunft und Aktualität von Wahrscheinlichkeiten transparenter machen
- [ ] Stichprobengrößen und fehlende Daten verständlicher darstellen
- [ ] Vergleichsgruppen nach Wettbewerb, Saison und Position verbessern
- [ ] Farbskalen regelmäßig anhand größerer Datengrundlagen überprüfen
- [ ] Ranglisten und Podiumsplätze langfristig stabil und nachvollziehbar
  halten

## Danach

### Browser- und Oberflächenqualität

- [ ] Automatisierte Tests in echten Chrome-/Edge-Browsern ergänzen
- [ ] Unterschiedliche Bildschirmgrößen und Zoomstufen testen
- [ ] Tastatur-, Touch- und Barrierefreiheitsunterstützung verbessern
- [ ] Deutsche und englische Oberfläche vollständig vereinheitlichen

### Veröffentlichung und Updates

- [ ] Automatisierte Qualitätsprüfungen für jede Änderung einführen
- [ ] Erweiterung und Backend über Versionsgrenzen hinweg kompatibel halten
- [ ] Store-Pakete reproduzierbar und nachvollziehbar erstellen
- [ ] Öffentliche Produkt-, Installations- und Datenschutzinformationen
  fortlaufend synchron halten

## Bewährte Grundlagen

Folgende Grundlagen sollen erhalten bleiben:

- keine API-Secrets oder Sorare-Zugangsdaten in der Extension
- sparsame Browserberechtigungen
- isolierte Darstellung über Shadow DOM
- gemeinsame validierte TypeScript-Verträge
- versioniertes Sorare-GraphQL-Schema
- Mock-Modus für lokale Entwicklung
- automatisierte Unit- und Integrationstests

## Hinweise

Die Reihenfolge kann sich ändern, wenn Sorare seine Seitenstruktur oder
Schnittstellen anpasst oder wenn eine wichtige Regression zuerst behoben werden
muss. Abgeschlossene größere Funktionen werden im
[Changelog](../CHANGELOG.md) und in den jeweiligen Release Notes dokumentiert.

