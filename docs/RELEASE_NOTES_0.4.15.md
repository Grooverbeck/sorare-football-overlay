# Sorare Football Overlay 0.4.15

## Im Chrome Web Store installieren

**[Zur Store-Version](https://chromewebstore.google.com/detail/sorare-football-stats-ove/ddolakmpillologhigdmolbbmfphakjm)**

Die Store-Version erhält Updates automatisch. Dort kann zunächst noch eine
ältere Version angeboten werden: 0.4.15 erscheint erst nach Einreichung und
Freigabe durch Google. Wer die neue Version schon jetzt manuell installieren
möchte, findet das fertige Paket unten unter **Assets**.

## Features und Verbesserungen

- **Bessere Erkennung animierter Set-Karten:** Ein gemeinsamer Kartenkatalog
  hilft dem Overlay, auch Videokarten ohne lesbaren Spielernamen zu erkennen.
  Bereits erfasste Varianten müssen nicht mehr auf jedem PC einzeln durch
  Öffnen der Kartendetails angelernt werden. Neue Varianten werden laufend ergänzt.
- **Passendere Farben für das europäische Set:** Die Farbstufen für Tor- und
  Assistwahrscheinlichkeiten orientieren sich an Premier League, Bundesliga,
  LaLiga und Ligue 1. Die Prozentwerte selbst ändern sich dadurch nicht.
- **Klarere Hinweise bei fehlenden AA-Daten:** Auch die graue AA-Klammer zeigt
  jetzt ein Hinweiszeichen mit einer Erklärung beim Darüberfahren.
- **Aufgeräumtere Karten:** Die zusätzlichen Buchstabenbewertungen neben der
  Startelfwahrscheinlichkeit werden ausgeblendet. Die Startelfwahrscheinlichkeit
  selbst bleibt sichtbar.

## Bugfixes

- Große Spielerpools werden zuverlässiger vollständig geladen und sortiert.
  Nachgeladene Videokarten bleiben beim Scrollen besser berücksichtigt.
- Hängenbleibende Sortierungen nach AA, Torquote und Clean Sheet sowie
  springende Fortschrittsanzeigen wurden korrigiert.
- **Torquote und Sortierung passen zusammen:** Bereits verfügbare Marktquoten
  werden auch in der Klammer angezeigt, statt dort weiter den historischen
  Ersatzwert zu zeigen.
- Die Kartenposition wird in belegten Lineup-Slots zuverlässiger erkannt,
  damit die passende AA-Auswertung verwendet wird.
- Spielerzuordnungen bei ähnlichen Namen und Vereinswechseln wurden verbessert.
- Flackernde Matchbalken beim Scrollen wurden stabilisiert.

## Manuell installieren oder aktualisieren

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-0.4.15.zip` herunterladen –
   **nicht** die automatisch erzeugte Datei **Source code (zip)**.
2. Die ZIP in einen dauerhaften Ordner entpacken. Bei einem Update den Inhalt
   des bisherigen Erweiterungsordners durch die neuen Dateien ersetzen.
3. `chrome://extensions` oder `edge://extensions` öffnen.
4. Bei der Erstinstallation den **Entwicklermodus** aktivieren und
   **Entpackte Erweiterung laden** wählen. Bei einem Update **Neu laden** anklicken.
5. Geöffnete Sorare-Seiten einmal aktualisieren.

[Ausführliche Installations- und Update-Anleitung](https://github.com/Grooverbeck/sorare-football-overlay/blob/v0.4.15/docs/INSTALLATION.md)

Store- und manuelle Version nicht gleichzeitig aktivieren, damit Anzeigen
nicht doppelt erscheinen.

## Hinweise

Die Verfügbarkeit von Marktquoten hängt weiterhin vom Spieler, der Begegnung
und den Datenquellen ab. Sehr neue oder seltene Kartenvarianten können noch
fehlen, bis der Kartenkatalog sie erfasst hat. Es sind keine neuen
Browserberechtigungen erforderlich.

Unabhängige, inoffizielle Erweiterung für Google Chrome und Microsoft Edge –
kein Produkt von Sorare.
