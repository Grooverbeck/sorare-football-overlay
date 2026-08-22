# Firefox-/AMO-Datenschutzangaben

Diese Angaben ergänzen die öffentliche [Datenschutzerklärung](https://sorare-football-overlay-api.grooverbeck.workers.dev/privacy)
für die Firefox-Version des Sorare Football Stats Overlay. Sie sind für eine
AMO-Einreichung und die Beschreibung eines selbst verteilten, unlisted Add-ons
gedacht.

## Von der Erweiterung verarbeitete Website-Inhalte

Das Content Script läuft ausschließlich auf `https://sorare.com/*` und
`https://www.sorare.com/*`. Es verarbeitet nur sichtbare, öffentliche
Fußballkarteninformationen, die für das Overlay benötigt werden:

- den öffentlichen Spieler-Slug, sofern ein Sorare-Spielerlink erkannt wird,
- den sichtbaren Spielernamen, sofern der Slug nicht zuverlässig erkannt wird,
- die konkrete Kartenposition (`Goalkeeper`, `Defender`, `Midfielder` oder
  `Forward`),
- einen öffentlichen Team-Slug, sofern er aus dem sichtbaren Karten-/Fixture-
  Kontext oder einem bereits geladenen öffentlichen Statistikdatensatz bekannt
  ist.

Diese Werte werden als `slugs`, `playerNames`, `positions` und optional
`playerTeams` in einer Anfrage an den eigenen HTTPS-Statistikdienst übertragen.
Zusätzliche boolesche Felder steuern ausschließlich die angeforderten
Statistik- und Cache-Funktionen (`includeHistoricalAssists`,
`supportsPartialFormHistory`, `refreshFixtures`, `oddsCacheOnly`). Die
Erweiterung überträgt nicht die aktuelle Seiten-URL als Nutzdatenfeld, keinen
Browserverlauf und keine privaten Sorare-Kontoinformationen.

Der Service Worker erzeugt außerdem eine zufällige Request-ID zur technischen
Fehlerzuordnung und sendet sie als `x-request-id`. Sie ist kein Konto- oder
Werbeidentifier.

## Nicht verarbeitete Daten

Die Erweiterung liest oder überträgt keine Sorare-E-Mail-Adresse, Passwörter,
JWTs, Cookies, Wallet-, Zahlungs-, Besitz- oder privaten Profildaten. Sie
lädt keinen entfernten ausführbaren Code. Lokale Einstellungen wie der
Overlay-Schalter, die Klammerseite und Anzeigeoptionen verbleiben im lokalen
Extension-Speicher.

## Firefox-Manifest und AMO

Die Firefox-Version verwendet die Datenberechtigung `websiteContent`, weil sie
sichtbare Inhalte von Sorare-Karten verarbeitet. Sie verwendet nicht
`websiteActivity` und erfasst keinen allgemeinen Browserverlauf.

Für die AMO-Prüfung sind insbesondere folgende Angaben konsistent zu halten:

- `browser_specific_settings.gecko.id` bleibt stabil,
- `storage` wird nur für lokale Einstellungen verwendet,
- die Host-Berechtigung gilt nur für den eigenen Statistikdienst,
- die Content-Script-Matches sind auf Sorare beschränkt,
- die öffentliche Datenschutzerklärung bleibt unter `/privacy` erreichbar.

Für selbst verteilte Firefox-Versionen wird das Paket über AMO als `unlisted`
signiert. Das resultierende `.xpi` kann anschließend als GitHub-Release-Asset
verteilt werden. Ein unsigniertes ZIP ist nur für temporäre
Entwicklungsinstallationen geeignet.
