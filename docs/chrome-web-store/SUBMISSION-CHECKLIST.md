# Chrome Web Store – Einreichungscheckliste

## Bereits vorbereitet

- [x] Manifest V3
- [x] Store-konformer Name und Kurzbeschreibung
- [x] Icons in 16, 32, 48 und 128 Pixel
- [x] 1280×800-Screenshot
- [x] 440×280-Promo-Kachel
- [x] ZIP mit `manifest.json` im Wurzelverzeichnis
- [x] ZIP ohne Source Maps und ohne Secrets
- [x] Single-Purpose-Erklärung
- [x] Berechtigungsbegründungen
- [x] Datenschutzangaben
- [x] öffentliche Homepage, Datenschutz- und Supportseite
- [x] inoffizieller Sorare-Hinweis

## Im Chrome Web Store Developer Dashboard

- [ ] Entwicklerkonto registrieren und einmalige Gebühr bezahlen
- [ ] Kontakt-E-Mail verifizieren
- [ ] Publisher-Name prüfen
- [ ] ZIP aus `artifacts/` hochladen
- [ ] Text aus `LISTING.de.md` eintragen
- [ ] Store-Icon, Screenshot und kleine Promo-Kachel hochladen
- [ ] Single-Purpose-Erklärung eintragen
- [ ] Berechtigungen mit den Texten aus `PRIVACY-DISCLOSURES.md` begründen
- [ ] Website-Inhalte und Ort (technische IP-Verarbeitung durch Cloudflare) als
      verarbeitete Datentypen angeben
- [ ] Limited-Use-Angaben bestätigen
- [ ] Datenschutzerklärung verlinken
- [ ] Sichtbarkeit auf **Unlisted / Nicht gelistet** setzen
- [ ] automatische Veröffentlichung nach erfolgreichem Review deaktivieren
- [ ] Einreichung zur Prüfung absenden

## Vor jedem Update

1. Manifest-Version erhöhen.
2. `npm run verify` ausführen.
3. `npm run package:chrome-web-store` ausführen.
4. ZIP-Inhalt und Prüfsumme kontrollieren.
5. Neue Version im Dashboard hochladen und zur Prüfung einreichen.
