# Chrome Web Store – Datenschutzangaben

Abgeglichen mit der öffentlichen Datenschutzerklärung vom 20. September 2026 (1.3). Die neue Kartenkatalog-Funktion überträgt zusätzlich unbekannte öffentliche Kartenbild-Kennungen zur Spielerauflösung. Vor der nächsten Store-Einreichung diese aktualisierte Beschreibung im Dashboard berücksichtigen; das Store-Paket wird durch ein Backend-Deployment nicht geändert.

## Datentypen im Dashboard

- Websitecontent: Ja. Öffentliche Spieler-/Kartenkennungen, Kartenpositionen, Team-/Begegnungskontext. Anzeige, Zuordnung und Sortierung; erforderliche Kennungen und Abrufoptionen gehen per HTTPS an das eigene Backend. Sortierungen berücksichtigen auch bereits geladene, nicht sichtbare Karten.
- Ort: Ja. Technische IP-Verarbeitung durch Cloudflare für Auslieferung und Missbrauchsschutz; kein GPS oder Standortprofil.
- Nutzeraktivität: Ja, lokale Bedien- und Sichtbarkeitszustände für Darstellung, Sortierung und Aktualisierung. Keine Maus-/Scrollverlaufsprotokolle an das Backend, keine Verhaltensprofile.
- Webprotokoll: Nein. Der aktuelle Sorare-Seitentyp wird lokal ausgewertet; es wird keine Liste besuchter Seiten oder allgemeiner Browserverlauf gespeichert oder übertragen.
- Personenidentifizierbare Kontoinformationen, Authentifizierungsdaten, Finanz-/Zahlungsdaten, Gesundheitsdaten, persönliche Kommunikation: Nein. Öffentliche Fußballspielernamen sind Website-Inhalte, keine Kontodaten des Nutzers.

## Alleiniger Zweck

Die Erweiterung hilft beim Vergleichen von Sorare-Fußballspielern: Sie ergänzt dargestellte Karten um öffentliche Leistungsstatistiken und Wahrscheinlichkeiten und sortiert Karten im Lineup Builder nach diesen Werten. Karten-, Team- und Begegnungskennungen dienen der richtigen Zuordnung; lokale Anzeigeoptionen und Bedienzustände steuern Darstellung und bedarfsgerechte Aktualisierung.

## Begründung für storage

Die storage-Berechtigung speichert lokal Anzeigeoptionen: Aktivierung insgesamt sowie für Squad/Lineups, Klammerseite, Compact View, Werteformat und historische Ersatzwerte. Zusätzlich werden begrenzte Zuordnungen öffentlicher Kartenbild-Kennungen zu Spielernamen und Spieler-Slugs gespeichert (jeweils maximal 2.000). Unbekannte Bildkennungen werden in Gruppen von höchstens 100 an den eigenen Statistikdienst gesendet, der sie mit einem aus öffentlichen Sorare-Daten aufgebauten Katalog abgleicht. Bestätigte Katalogeinträge haben kein automatisches Ablaufdatum und werden nicht mit Nutzerkonten verknüpft. Die lokale Zuordnungsliste und Kartenbesitz-Kennungen werden nicht hochgeladen. Es werden keine Zugangsdaten, Wallet-, Zahlungs- oder privaten Kontodaten gespeichert.

## Begründung für Hostberechtigung

Das Content Script arbeitet nur auf sorare.com und www.sorare.com, um dargestellte Fußballkarten zu erkennen, mit Statistiken zu ergänzen und im Lineup Builder zu sortieren. Der Zugriff auf sorare-football-overlay-api.grooverbeck.workers.dev dient HTTPS-Anfragen mit öffentlichen Spielerkennungen, Kartenpositionen, Team-/Begegnungskontext und erforderlichen Abrufoptionen. Das Backend liefert JSON-Daten. Für vollständige Sortierungen werden auch bereits geladene, nicht sichtbare Karten berücksichtigt.

## Remote Code

Nein. Alle ausgeführten JavaScript-Dateien befinden sich im Erweiterungspaket. Das Backend liefert JSON-Sportdaten, keinen ausführbaren Erweiterungscode.

## Limited Use

Daten werden nur für die beschriebenen nutzerseitigen Funktionen, Betrieb, Sicherheit und Zuverlässigkeit verwendet; nicht für Werbung, Datenhandel oder Kreditwürdigkeitsprüfung. Bestehende entsprechende Bestätigungen bleiben erhalten.

Datenschutzerklärung: https://sorare-football-overlay-api.grooverbeck.workers.dev/privacy

## Referenz

Google verlangt auch die Offenlegung lokaler Datenverarbeitung: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
