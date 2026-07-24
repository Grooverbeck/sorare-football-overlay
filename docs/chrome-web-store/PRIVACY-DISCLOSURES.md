# Chrome Web Store – Datenschutzangaben

Diese Angaben müssen mit der veröffentlichten Datenschutzerklärung und dem
tatsächlichen Verhalten der Erweiterung übereinstimmen.

## Datentypen im Dashboard

### Website content / Website-Inhalte: Ja

Die Erweiterung verarbeitet ausschließlich folgende, auf sichtbaren
Sorare-Fußballkarten öffentliche Inhalte:

- Spielername und/oder Spieler-Slug
- Position der konkreten Karte

Diese Angaben werden an den eigenen HTTPS-Statistikdienst übertragen, um die
vom Nutzer sichtbar angeforderten Overlay-Werte zurückzugeben.

### Web history / Browserverlauf: Nein

Die Erweiterung läuft ausschließlich auf `sorare.com`. Sie speichert oder
überträgt weder die besuchte Sorare-Seitenadresse noch einen Verlauf besuchter
Seiten. Das Backend protokolliert nur seinen eigenen API-Pfad, nicht den
Sorare-Seitenpfad.

### Personally identifiable information: Nein

Es werden keine personenbezogenen Kontodaten des Extension-Nutzers erhoben.
Öffentliche Namen professioneller Fußballspieler dienen ausschließlich als
Schlüssel für öffentliche Sportstatistiken.

### Authentication information: Nein

Keine Sorare-E-Mail-Adresse, Passwörter, JWTs, Cookies oder andere
Authentifizierungsinformationen.

### Location / Ort: Ja – ausschließlich technische IP-Adresse

Cloudflare verarbeitet als Infrastrukturbetreiber bei HTTPS-Anfragen die
IP-Adresse, um die Anfrage auszuliefern und gegen Missbrauch zu schützen. Die
Erweiterung fragt keine GPS-Position, Region oder Sehenswürdigkeiten ab. Die
Anwendungslogs speichern die IP-Adresse nicht als eigenes Feld und es werden
keine Standortprofile erstellt.

### Financial, payment, health, communications, form data: Nein

Diese Daten werden nicht ausgelesen oder übertragen.

## Limited-Use-Bestätigungen

Alle Bestätigungen können wahrheitsgemäß aktiviert werden:

- Daten werden nur für die beschriebene, nutzerseitige Overlay-Funktion sowie
  deren Betrieb, Sicherheit und Zuverlässigkeit verwendet.
- Daten werden nicht an Werbeplattformen oder Datenhändler verkauft oder
  übertragen.
- Daten werden nicht für personalisierte oder interessenbezogene Werbung
  verwendet.
- Menschen lesen keine nutzerspezifischen Website-Inhalte; eine Ausnahme gilt
  nur für ausdrücklich angeforderten Support, Sicherheit oder gesetzliche
  Pflichten.
- Die Verarbeitung entspricht der Chrome Web Store User Data Policy
  einschließlich der Limited-Use-Anforderungen.

## Berechtigungsbegründungen

### `storage`

Speichert ausschließlich lokal, ob das Overlay ein- oder ausgeschaltet ist.

### Content Script auf `https://sorare.com/*`

Erforderlich, um sichtbare Fußballkarten zu erkennen und das vom Nutzer
installierte Overlay unmittelbar an diesen Karten anzuzeigen.

### Host-Berechtigung für den eigenen Cloudflare Worker

Erforderlich, damit der Extension Service Worker öffentliche Spielerkennungen
an den Statistikdienst senden und berechnete Statistiken empfangen kann.

## Remote Code

Die Erweiterung lädt keinen entfernten ausführbaren Code. Alle ausgeführten
JavaScript-Dateien befinden sich im geprüften Extension-Paket. Das Backend
liefert ausschließlich validierte JSON-Statistikdaten.
