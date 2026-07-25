# Chrome Web Store – Listing (Deutsch)

## Produktdaten

- **Name:** Sorare Football Stats Overlay – Unofficial
- **Kurzbeschreibung:** Inoffizielles Overlay mit positionsbezogenen Fußballstatistiken auf Sorare-Karten.
- **Kategorie:** Sport
- **Sprache:** Deutsch
- **Sichtbarkeit für die Beta:** Nicht gelistet (Unlisted)
- **Homepage:** https://sorare-football-overlay-api.grooverbeck.workers.dev/
- **Datenschutzerklärung:** https://sorare-football-overlay-api.grooverbeck.workers.dev/privacy
- **Support:** https://sorare-football-overlay-api.grooverbeck.workers.dev/support

## Detaillierte Beschreibung

Mehr Statistik-Kontext, ohne Sorare zu verlassen.

Das inoffizielle Sorare Football Stats Overlay ergänzt Fußballkarten auf
sorare.com um kompakte, positionsbezogene Werte:

- AA L10 mit positionsbezogener MLS-Einordnung
- CS% als Seitenklammer für Goalkeeper und Next CS% im Header für Defender
- kompakte Tor- und Assistquoten direkt an der Karte
- optionale, klar als historisch markierte Tor-/Assist-Ersatzwerte aus L10, L15 oder L40
- Heim-/Remis-/Auswärtsquoten als Balken im Lineup Builder
- verständliche Hinweise bei fehlenden oder unvollständigen Daten
- besondere Kennzeichnung der Top 3 einer positionsbezogenen MLS-AA-Rangliste

Die Erweiterung erkennt auch dynamisch geladene Karten, Pack-Ansichten und
Kartenwechsel. Das Overlay lässt sich jederzeit über das Symbol in der
Browserleiste ausschalten.

Die Werte sind Statistik-Kontext und keine Garantie für zukünftige Ergebnisse.
Historische L10-Werte werden als historische Werte gekennzeichnet.

Datenschutz:

- keine Sorare-E-Mail oder Passwörter
- keine JWTs, Cookies oder Wallet-Daten
- keine Zahlungs-, Kauf- oder Verkaufsdaten
- kein allgemeiner Browserverlauf
- lokal werden ausschließlich Overlay-Einstellungen und eine begrenzte Zuordnung bereits sichtbarer Kartenbilder zu öffentlichen Spielernamen gespeichert

Die Erweiterung sendet lediglich den auf einer sichtbaren Sorare-Karte
erkannten öffentlichen Spielernamen beziehungsweise Spieler-Slug und die
Kartenposition verschlüsselt an ihren eigenen Statistikdienst.

Dieses Projekt ist unabhängig und inoffiziell. Es ist nicht mit Sorare
verbunden, wird nicht von Sorare unterstützt und wird nicht von Sorare
herausgegeben.

## Single-Purpose-Erklärung

Die Erweiterung verfolgt einen einzigen Zweck: Auf sorare.com sichtbaren
Fußballkarten direkt an der Karte öffentliche, positionsbezogene
Leistungsstatistiken und Wahrscheinlichkeitskontext hinzuzufügen.

## Prüfungshinweise

1. Die Erweiterung auf einer beliebigen Fußballseite unter `https://sorare.com/`
   öffnen, auf der Spielerkarten sichtbar sind.
2. `AA L10` erscheint bei Feldspielern als farbcodierte Seitenklammer.
   Goalkeeper zeigen stattdessen `CS%`; Defender zeigen `NEXT CS%` zusätzlich
   im Kartenheader.
3. Soweit Marktquoten verfügbar sind, erscheinen Tor und Assist kompakt an der
   gewählten Kartenseite.
4. Über das Extension-Symbol lässt sich das Overlay aus- und einschalten.
5. Für die Funktion ist kein Sorare-Login der Erweiterung und kein gesondertes
   Extension-Konto erforderlich.

## Grafiken

- Store-Icon: `apps/extension/store-assets/store-icon-128.png`
- Screenshot: `apps/extension/store-assets/screenshot-1-1280x800.png`
- Kleine Promo-Kachel: `apps/extension/store-assets/small-promo-tile-440x280.png`
