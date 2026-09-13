# Vollständige Sortierwerte und stabile Reihenfolge

## Hintergrund

Beim EX-Test mit 638 Karten ohne Zeitraum- und Startelf-Filter meldete das
Overlay den Pool als fertig, obwohl noch Werte fehlten. Einige bereits
geladene Karten erhielten erst beim Sichtbarwerden ihre historischen Werte
oder vorhandenen Marktquoten und wanderten nach oben.

## Prüfstatus

Die kompakte Sortierantwort liefert optional `readiness` für `goal`, `aa`
und `cleanSheet`. Mögliche Zustände:

- `pending`: Daten oder Cache-Lesezugriff sind noch nicht vollständig.
- `ready`: Ein gültiger Wert liegt vor, einschließlich echter 0 %.
- `unavailable`: Die abgeschlossene Prüfung hat keinen Wert ergeben.
- `error`: Die Prüfung konnte nicht erfolgreich abgeschlossen werden.

Die Sortierung zählt nur `ready` und `unavailable` als geprüft. Netzwerkfehler,
fehlende Antwortzeilen, nicht erkannte Karten und ausgeschöpfte Wiederholungen
werden nicht mehr als endgültige Datenlücke ausgegeben. Vorhandene Zahlen
bleiben bei vorläufigen leeren Antworten erhalten, solange die Begegnung
nicht gewechselt hat.

Ein gewünschtes L15-/L40-Fenster wird nicht stillschweigend durch L10 ersetzt.
Unvollständige Historie hält AA und historische Torwerte offen, aber keine
bereits vorhandene echte Markt-Torquote. Nicht benötigte Metriken blockieren
den gewählten Sortiermodus nicht.

## Nachladen

Jede Karte belegt im Request genau einen Identitätseintrag: vorhandene
Spielerkennung hat Vorrang vor dem zusätzlich bekannten Namen. Auch gemischte
Batches aus gelernten Karten und reinen Namens-Karten bleiben damit innerhalb
des gemeinsamen Limits von 50 Einträgen. Der große Regressionstest prüft
zusätzlich die echte Request-Schema-Validierung.

Der Sortier-Lader arbeitet über den gesamten erkannten Pool, unabhängig vom
Viewport. Automatische Wiederholungen sind begrenzt (nach 1, 5, 15 und 30
Sekunden); bei Erschöpfung bleibt ein sichtbarer Fehlerstatus. „Erneut prüfen“
lädt gezielt die offenen Zustände, statt sämtliche Kartendaten zu verwerfen.

Nach der anfänglichen Prüfung gibt es einmalig einen gemeinsamen Cache-Abgleich:
bei Torquoten für Karten ohne Marktwert, bei CS für Karten ohne CS-Wert.
Der Abschluss berücksichtigt diese letzte Prüfung. Auch ein Wechsel vom
kompakten Ergebnis zurück zu vorläufigen ausführlichen Kartendaten wird
weiter abgearbeitet, ohne erneutes Scrollen zu verlangen.

`/api/lineup-sort-values` erzwingt weiterhin `oddsCacheOnly: true`.
Sorare-Begegnungen dürfen vervollständigt werden (`refreshFixtures: true`),
aber externe Quotenanbieter werden nicht für den ganzen Pool aufgerufen.
Cache-Lesezeitüberschreitungen werden als ausstehend weitergegeben.
Normale sichtbare Karten können wie bisher Quotenabrufe auslösen.

Der zusätzliche Abgleich kostet Backend-Cache-Lesezugriffe; eine garantierte
Zeitersparnis oder Lastfreiheit wird nicht behauptet. Die vorhandenen Batches,
Response-Budgets und serverseitigen In-flight-Sperren bleiben erhalten.

## Darstellung und Interaktion

- Während des Ladens bleibt die Anzahl der gefundenen Spieler sichtbar.
- Nach vollständiger Erkennung wird die Zahl der tatsächlich geprüften
  Karten angezeigt. Fehler bleiben als „offen“ sichtbar, mit „Erneut prüfen“.
- Nach dem Abschluss (oder einem ausdrücklich unvollständigen Ergebnis ohne
  weiter laufende Versuche) wird die visuelle Reihenfolge festgehalten.
- Spätere Werte aktualisieren weiterhin die Daten, verschieben aber keine
  Karten beim Scrollen. Der Hinweis „Neue Werte verfügbar“ und „Neu sortieren“
  erlauben eine bewusste Aktualisierung.
- Ein bewusster Wechsel zwischen Tor, AA und CS verwendet die neuesten
  vorhandenen Werte. Die native Sorare-Sortierung sowie Filter-/Slotwechsel
  behalten ihre bisherigen Wiederherstellungs- und Abbruchregeln.
- Gleichwertige DOM-Neumounts derselben Karte übernehmen ihren bisherigen
  Platz; neue Pools erhalten einen eigenen Prüf- und Sortierdurchlauf.

## Rollout und Tests

Die API-Erweiterung ist additiv. Ältere Extensions ignorieren die neuen Felder;
sie werden dadurch nicht unbrauchbar. Für die vollständige Korrektur sind
jedoch sowohl das aktualisierte Backend als auch die aktualisierte Extension
nötig. Die neue Extension akzeptiert ältere Antworten weiterhin, kann ohne
Statusfeld aber deren Vollständigkeit nicht zuverlässig feststellen.

Regressionen decken 638 zunächst vorläufige Karten, Cache-Nachprüfung,
Viewport-unabhängige Wiederholungen, Fehler/Nullwerte, bewusste Neusortierung,
Karten-Neumounts und vorhandene Positions-/Filterwechsel ab. Eine spätere
Store-Veröffentlichung muss dieses Extension-Update gesondert enthalten;
das bereits hochgeladene Store-Paket 0.4.14 wird nicht nachträglich verändert.
