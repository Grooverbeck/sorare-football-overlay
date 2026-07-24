# Vorlage für GitHub-Releases

Diese Vorlage verhindert, dass bei einem neuen Release die Hinweise für
Erstinstallation und manuelle Updates fehlen. `<VERSION>` und die Änderungen
vor dem Veröffentlichen ersetzen.

```markdown
## Installation

1. Unter **Assets** die Datei
   `sorare-football-overlay-chrome-web-store-<VERSION>.zip` herunterladen.
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

- <Änderung 1>
- <Änderung 2>

## Hinweise

- Unterstützt Google Chrome und Microsoft Edge.
- Dies ist eine inoffizielle Erweiterung und kein Produkt von Sorare.
```

## Checkliste für Maintainer

- Versionsnummern in den Paketdateien und im Manifest stimmen überein.
- Produktionsbuild und Tests sind erfolgreich.
- Das Release enthält die installierbare
  `sorare-football-overlay-chrome-web-store-<VERSION>.zip`.
- Die Asset-Datei wurde testweise entpackt und enthält `manifest.json` auf der
  obersten Ebene.
- Release-Text enthält Installation, Update, Änderungen und den Link zu dieser
  Anleitung.
- Die automatisch erzeugten GitHub-Source-Code-Archive werden nicht als
  Installationspaket bezeichnet.
