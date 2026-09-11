# Chrome Web Store – Datenschutzangaben (0.4.13)

Abgeglichen mit der öffentlichen Datenschutzerklärung vom 11. September 2026 und dem aktuellen Code. Keine neue Datenerhebung durch diese Textaktualisierung.

## Datentypen im Dashboard

- Websitecontent: Ja. Öffentliche Spieler-/Kartenkennungen, Kartenpositionen, Team-/Begegnungskontext. Anzeige, Zuordnung und Sortierung; erforderliche Kennungen und Abrufoptionen gehen per HTTPS an das eigene Backend. Sortierungen berücksichtigen auch bereits geladene, nicht sichtbare Karten.
- Ort: Ja. Technische IP-Verarbeitung durch Cloudflare für Auslieferung und Missbrauchsschutz; kein GPS oder Standortprofil.
- Nutzeraktivität: Ja, lokale Bedien- und Sichtbarkeitszustände für Darstellung, Sortierung und Aktualisierung. Keine Maus-/Scrollverlaufsprotokolle an das Backend, keine Verhaltensprofile.
- Webprotokoll: Nein. Der aktuelle Sorare-Seitentyp wird lokal ausgewertet; es wird keine Liste besuchter Seiten oder allgemeiner Browserverlauf gespeichert oder übertragen.
- Personenidentifizierbare Kontoinformationen, Authentifizierungsdaten, Finanz-/Zahlungsdaten, Gesundheitsdaten, persönliche Kommunikation: Nein. Öffentliche Fußballspielernamen sind Website-Inhalte, keine Kontodaten des Nutzers.

## Alleiniger Zweck

Die Erweiterung hilft beim Vergleichen von Sorare-Fußballspielern: Sie ergänzt dargestellte Karten um öffentliche Leistungsstatistiken und Wahrscheinlichkeiten und sortiert Karten im Lineup Builder nach diesen Werten. Karten-, Team- und Begegnungskennungen dienen der richtigen Zuordnung; lokale Anzeigeoptionen und Bedienzustände steuern Darstellung und bedarfsgerechte Aktualisierung.

## Begründung für storage

Die storage-Berechtigung speichert lokal Anzeigeoptionen: Aktivierung insgesamt sowie für Squad/Lineups, Klammerseite, Compact View, Werteformat und historische Ersatzwerte. Zusätzlich werden begrenzte Zuordnungen öffentlicher Kartenbild-Kennungen zu Spielernamen und Spieler-Slugs gespeichert (jeweils maximal 2.000). Das verbessert die Wiedererkennung dynamischer Karten. Es werden keine Zugangsdaten, Wallet-, Zahlungs- oder privaten Kontodaten gespeichert.

## Begründung für Hostberechtigung

Das Content Script arbeitet nur auf sorare.com und www.sorare.com, um dargestellte Fußballkarten zu erkennen, mit Statistiken zu ergänzen und im Lineup Builder zu sortieren. Der Zugriff auf sorare-football-overlay-api.grooverbeck.workers.dev dient HTTPS-Anfragen mit öffentlichen Spielerkennungen, Kartenpositionen, Team-/Begegnungskontext und erforderlichen Abrufoptionen. Das Backend liefert JSON-Daten. Für vollständige Sortierungen werden auch bereits geladene, nicht sichtbare Karten berücksichtigt.

## Remote Code

Nein. Alle ausgeführten JavaScript-Dateien befinden sich im Erweiterungspaket. Das Backend liefert JSON-Sportdaten, keinen ausführbaren Erweiterungscode.

## Limited Use

Daten werden nur für die beschriebenen nutzerseitigen Funktionen, Betrieb, Sicherheit und Zuverlässigkeit verwendet; nicht für Werbung, Datenhandel oder Kreditwürdigkeitsprüfung. Bestehende entsprechende Bestätigungen bleiben erhalten.

Datenschutzerklärung: https://sorare-football-overlay-api.grooverbeck.workers.dev/privacy

## Referenz

Google verlangt auch die Offenlegung lokaler Datenverarbeitung: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
