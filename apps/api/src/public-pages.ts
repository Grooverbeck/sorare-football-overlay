const pageStyles = `
  :root {
    color-scheme: dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #070b10;
    color: #e8eef5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(circle at 15% 5%, rgba(168, 85, 247, .15), transparent 32rem),
      radial-gradient(circle at 90% 15%, rgba(34, 197, 94, .11), transparent 28rem),
      #070b10;
  }
  main { width: min(900px, calc(100% - 32px)); margin: 0 auto; padding: 72px 0 96px; }
  .eyebrow {
    display: inline-flex;
    padding: 7px 11px;
    border: 1px solid #33475a;
    border-radius: 999px;
    color: #b8c7d5;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  h1 { margin: 22px 0 16px; font-size: clamp(36px, 7vw, 64px); line-height: 1.02; letter-spacing: -.04em; }
  h2 { margin: 40px 0 12px; color: #fff; font-size: 24px; }
  h3 { margin: 28px 0 8px; color: #fff; font-size: 18px; }
  p, li { color: #b8c7d5; font-size: 16px; line-height: 1.7; }
  li + li { margin-top: 8px; }
  a { color: #76a9ff; }
  strong { color: #f4f7fb; }
  .lead { max-width: 720px; font-size: 20px; }
  .notice {
    margin: 30px 0;
    padding: 20px 22px;
    border: 1px solid #33475a;
    border-left: 4px solid #22c55e;
    border-radius: 14px;
    background: rgba(16, 25, 35, .82);
  }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 30px 0; }
  .card { padding: 22px; border: 1px solid #2a3a4a; border-radius: 16px; background: rgba(13, 20, 28, .82); }
  .card h2 { margin-top: 0; font-size: 20px; }
  .button {
    display: inline-flex;
    margin-top: 18px;
    padding: 12px 16px;
    border-radius: 11px;
    background: #e8eef5;
    color: #070b10;
    font-weight: 800;
    text-decoration: none;
  }
  footer { margin-top: 64px; padding-top: 24px; border-top: 1px solid #263543; color: #718395; font-size: 14px; }
`;

function page(title: string, description: string, content: string): string {
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="${description}">
    <title>${title}</title>
    <style>${pageStyles}</style>
  </head>
  <body>
    <main>
      ${content}
      <footer>
        Unabhängiges, inoffizielles Projekt. Nicht mit Sorare verbunden, von Sorare unterstützt oder von Sorare herausgegeben.
      </footer>
    </main>
  </body>
</html>`;
}

export const homePage = page(
  'Football Stats Overlay – Inoffiziell',
  'Informationen zum inoffiziellen Football Stats Overlay für sorare.com.',
  `
    <span class="eyebrow">Browser Extension · Beta</span>
    <h1>Football Stats Overlay</h1>
    <p class="lead">
      Ein kompaktes, positionsbezogenes Statistik-Overlay für Fußballkarten auf sorare.com.
      All-Around-Werte, Clean-Sheet-, Tor- und Assistwahrscheinlichkeiten helfen beim
      Vergleichen der Spieler. Im Lineup Builder können Karten nach den verfügbaren Werten sortiert werden.
    </p>
    <div class="notice">
      <strong>Inoffizielle Erweiterung:</strong> Dieses Projekt ist nicht mit Sorare verbunden,
      wird nicht von Sorare unterstützt und verwendet keine Sorare-Anmeldedaten.
    </div>
    <div class="cards">
      <section class="card">
        <h2>Ein klarer Zweck</h2>
        <p>Öffentliche Fußballstatistiken passend zu den auf Sorare sichtbaren Karten anzeigen.</p>
      </section>
      <section class="card">
        <h2>Sparsame Berechtigungen</h2>
        <p>Aktiv nur auf sorare.com; lokal bleiben Anzeigeoptionen und begrenzte Zuordnungen von Kartenbildern zu öffentlichen Spielern gespeichert.</p>
      </section>
      <section class="card">
        <h2>Keine Zugangsdaten</h2>
        <p>Keine E-Mail, Passwörter, Authentifizierungs-Cookies, Wallet- oder Zahlungsdaten.</p>
      </section>
    </div>
    <a class="button" href="/privacy">Datenschutzerklärung lesen</a>
    <h2>Chrome Web Store Limited Use</h2>
    <p>
      Die Nutzung der durch die Erweiterung verarbeiteten Informationen entspricht der
      Chrome Web Store User Data Policy einschließlich der Limited-Use-Anforderungen.
      Daten werden ausschließlich für die beschriebene, nutzerseitige Overlay-Funktion,
      deren Betrieb, Sicherheit und Zuverlässigkeit verwendet.
    </p>
  `,
);

export const privacyPage = page(
  'Datenschutzerklärung – Football Stats Overlay',
  'Datenschutzerklärung für das inoffizielle Football Stats Overlay.',
  `
    <span class="eyebrow">Stand: 11. September 2026 · Version 1.2</span>
    <h1>Datenschutzerklärung</h1>
    <p class="lead">
      Diese Erklärung beschreibt, welche Daten das inoffizielle Football Stats Overlay
      verarbeitet, warum dies notwendig ist und was ausdrücklich nicht ausgelesen wird.
    </p>

    <h2>1. Verantwortlicher und Kontakt</h2>
    <p>
      Verantwortlich ist der unabhängige Herausgeber <strong>Grooverbeck</strong>.
      Kontakt ist über die im Chrome Web Store hinterlegte, verifizierte Entwickleradresse
      beziehungsweise den dort angegebenen Support-Kanal möglich.
    </p>

    <h2>2. Zweck der Erweiterung</h2>
    <p>
      Die Erweiterung ergänzt auf sorare.com sichtbare Fußballkarten um öffentliche,
      positionsbezogene Leistungsstatistiken und Wahrscheinlichkeiten und ermöglicht das Sortieren
      von Karten im Lineup Builder. Zweck ist der Vergleich von Fußballspielern direkt auf Sorare.
    </p>

    <h2>3. Verarbeitete Daten</h2>
    <h3>Auf sorare.com erkannte Karteninformationen</h3>
    <ul>
      <li>öffentlicher Spielername und/oder öffentlicher Spieler-Slug,</li>
      <li>Position der angezeigten Karte, soweit auf der Seite erkennbar,</li>
      <li>öffentliche Teamkennungen und Angaben zur Begegnung, soweit für die Zuordnung erforderlich,</li>
      <li>öffentliche Bild- und Kartenkennungen zur Wiedererkennung des Spielers.</li>
    </ul>
    <p>
      Öffentliche Spielerkennungen, Kartenpositionen, Team- und Begegnungskontext sowie erforderliche
      Abrufoptionen (zum Beispiel der gewünschte historische Zeitraum) werden über HTTPS an den eigenen
      Statistikdienst übertragen. Die Zuordnungsliste der Kartenbilder wird nicht als Liste übertragen.
      Bei einer aktiven Sortierung werden auch bereits geladene Karten außerhalb des sichtbaren
      Ausschnitts berücksichtigt, damit die Reihenfolge den vollständigen Kartenpool umfasst.
    </p>

    <h3>Lokale Einstellungen und Wiedererkennung</h3>
    <p>
      Im lokalen Chrome-Speicher werden der An/Aus-Status, die Aktivierung für Squad und Lineups,
      Klammerseite, Compact View, Werteformat und Optionen für historische Ersatzwerte gespeichert.
      Zusätzlich werden begrenzte Zuordnungen öffentlicher Kartenbild-Kennungen zu Spielernamen
      beziehungsweise Spieler-Slugs gespeichert (jeweils höchstens 2.000 Einträge).
      Daraus aufgelöste Spielerkennungen werden für die oben beschriebenen Statistikabfragen verwendet.
      Diese lokalen Speicherwerte können durch Entfernen der Erweiterung gelöscht werden.
      Geladene Statistiken und Sortierzustände werden außerdem vorübergehend im Arbeitsspeicher gehalten.
    </p>
    <h3>Lokale Bedien- und Seitenzustände</h3>
    <p>
      Die Erweiterung berücksichtigt auf Sorare den Seitentyp, sichtbare Karten, den gewählten Slot,
      Sortier- und Filterzustände sowie Klick-, Hover-, Scroll- und Sichtbarkeitsereignisse. Dies dient
      ausschließlich der Darstellung, Bedienung, Sortierung und bedarfsgerechten Aktualisierung.
      Es werden keine Maus- oder Scrollverlaufsprotokolle an den Statistikdienst gesendet und keine
      nutzerübergreifenden Verhaltensprofile erstellt. Versteckte Tabs pausieren die neuen
      zeitgesteuerten Spielstatus-Prüfungen.
    </p>

    <h3>Technische Betriebsdaten</h3>
    <p>
      Der Statistikdienst protokolliert zur Fehleranalyse und Betriebssicherheit eine zufällige
      Request-ID, HTTP-Methode, API-Pfad, Statuscode und Bearbeitungsdauer. Zur Fehlersuche können
      auch öffentliche Spieler- oder Begegnungskennungen und Fehlerdetails protokolliert werden.
      Diagnosen in der Browserkonsole bleiben lokal, sofern sie nicht vom Nutzer für Support geteilt werden. Cloudflare verarbeitet
      als Infrastrukturbetreiber technisch notwendige Verbindungsdaten, insbesondere die
      IP-Adresse, um die Anfrage auszuliefern und gegen Missbrauch zu schützen.
    </p>

    <h2>4. Nicht verarbeitete Daten</h2>
    <p>Die Erweiterung liest oder überträgt insbesondere nicht:</p>
    <ul>
      <li>Sorare-E-Mail-Adresse, Passwort, JWT, Cookies oder andere Zugangsdaten,</li>
      <li>Wallet-, Zahlungs-, Kauf- oder Verkaufsdaten,</li>
      <li>private Kontodaten oder eine eigenständige, kontobezogene Besitz- oder Aufstellungsdatenbank;
          angezeigte Spieler auf Squad- und Aufstellungsseiten werden wie andere Karten verarbeitet,</li>
      <li>private Nachrichten, Zugangsdaten aus Formularen oder Inhalte außerhalb von sorare.com,</li>
      <li>einen allgemeinen Browserverlauf.</li>
    </ul>

    <h2>5. Nutzung, Cache und Speicherdauer</h2>
    <p>
      Karteninformationen werden ausschließlich verwendet, um die angeforderten Statistikwerte
      zu bestimmen. Öffentliche Fußballstatistiken und Spielerzuordnungen werden unabhängig von
      einem einzelnen Nutzer zwischengespeichert, um Sorare-Abfragen und Ladezeiten zu reduzieren.
      Formwerte werden regulär bis zum Wochenwechsel (höchstens sieben Tage) gehalten,
      erfolgreiche Namenszuordnungen bis zu 30 Tage und erfolglose Zuordnungen bis zu zwei Stunden.
      Begegnungsdaten werden abhängig von Anpfiff, Spielstatus und Spielwechsel zwischengespeichert;
      Status-Prüfergebnisse und Daten bestätigter laufender oder unterbrochener Spiele können bis
      zu sieben Tage gespeichert bleiben. Das sind gemeinsam genutzte öffentliche Sportdaten,
      keine einer Person zugeordneten Nutzungsprofile.
      Öffentliche, vor dem Spiel erfasste Tor-, Assist- und Tor-oder-Assist-Marktsnapshots werden unabhängig von
      Nutzern ohne automatisches Ablaufdatum gespeichert, damit dieselben Buchmacherquoten nicht
      wiederholt kostenpflichtig abgerufen werden.
      Technische Logs unterliegen den konfigurierten Cloudflare-Aufbewahrungsfristen und werden
      nicht zum Aufbau von Nutzerprofilen verwendet.
    </p>

    <h2>6. Empfänger und Dienstleister</h2>
    <ul>
      <li>
        <strong>Cloudflare, Inc.</strong> stellt Worker-, Netzwerk-, Sicherheits-, Log- und
        D1-Datenbank- und Key-Value-Infrastruktur bereit.
      </li>
      <li>
        Die offizielle Sorare GraphQL API wird vom Backend ausschließlich mit öffentlichen
        Spieler- und Spieldaten abgefragt. Sorare erhält dabei keine Zugangsdaten des
        Extension-Nutzers.
      </li>
      <li>
        <strong>The Odds API</strong> wird vom Backend für öffentliche Tor- und
        Assist- sowie H/D/A-Buchmachermärkte einer Begegnung abgefragt.
      </li>
      <li>
        <strong>SportsGameOdds</strong> wird für öffentliche Tor-, Assist-,
        Tor-oder-Assist- und H/D/A-Buchmachermärkte einer Begegnung abgefragt.
      </li>
      <li>
        <strong>Odds-API.io</strong> wird als zusätzliche Quelle für öffentliche
        Tor-, Assist-, Tor-oder-Assist- und, in unterstützten Wettbewerben, Team-Buchmachermärkte abgefragt.
      </li>
    </ul>
    <p>
      An die Quotendienste werden keine Zugangsdaten, IP-Adressen oder sonstigen
      Identifikatoren des Extension-Nutzers übermittelt.
      Es findet kein Verkauf von Daten statt. Daten werden nicht für personalisierte Werbung,
      Retargeting, Kreditwürdigkeitsprüfung oder den Handel mit Nutzerprofilen verwendet.
    </p>

    <h2>7. Chrome Web Store Limited Use</h2>
    <div class="notice">
      Die Nutzung der durch die Erweiterung verarbeiteten Informationen entspricht der
      Chrome Web Store User Data Policy einschließlich der Limited-Use-Anforderungen.
      Die Verarbeitung ist auf die beschriebenen Overlay- und Sortierfunktionen sowie deren Betrieb,
      Sicherheit und Zuverlässigkeit beschränkt.
    </div>

    <h2>8. Rechtsgrundlage und Rechte</h2>
    <p>
      Die Verarbeitung erfolgt zur Bereitstellung der vom Nutzer installierten Funktion und
      auf Grundlage des berechtigten Interesses an einem sicheren, zuverlässigen Betrieb.
      Betroffene können über die im Store angegebene Kontaktadresse Auskunft, Berichtigung,
      Löschung, Einschränkung oder Widerspruch verlangen. Da keine Konten oder dauerhaften
      Nutzerprofile angelegt werden, ist eine Zuordnung technischer Einzelanfragen zu einer
      Person regelmäßig nicht möglich.
    </p>

    <h2>9. Sicherheit und Änderungen</h2>
    <p>
      Die Kommunikation mit dem Backend erfolgt ausschließlich über HTTPS. Secrets und
      API-Zugangsdaten für Sorare, The Odds API, SportsGameOdds und Odds-API.io sind nicht Bestandteil der Erweiterung. Änderungen dieser
      Erklärung werden auf dieser Seite mit einem neuen Stand veröffentlicht.
    </p>

    <h2>English summary</h2>
    <p>
      The extension processes public player, card-position, team and fixture information on Sorare
      and sends the identifiers and required query options via HTTPS to its statistics service.
      Display settings and bounded mappings from public card-picture IDs to player names or slugs
      are stored locally. Sorting includes already loaded offscreen cards. Page and interaction
      states are used locally for display, sorting and refresh scheduling, not behavioral profiling.
      No Sorare credentials, cookies, wallet or payment data are accessed. No separate account-linked
      ownership or lineup database is built. There is no general browsing-history collection.
      Cloudflare processes technical connection data including IP addresses. The backend queries
      Sorare and odds providers for public sports data without forwarding extension-user identifiers.
      Data is used only for the disclosed features, operation, security and reliability, not sold or used for advertising.
    </p>
  `,
);

export const supportPage = page(
  'Support – Football Stats Overlay',
  'Support-Informationen für das inoffizielle Football Stats Overlay.',
  `
    <span class="eyebrow">Support</span>
    <h1>Hilfe zum Overlay</h1>
    <p class="lead">
      Bei fehlenden oder offensichtlich falschen Werten helfen Spielername, Sorare-Seitenadresse,
      Screenshot und Extension-Version bei der Fehlersuche.
    </p>
    <div class="notice">
      Bitte niemals Sorare-Passwörter, JWTs, Cookies, Wallet-Schlüssel oder andere Zugangsdaten
      mitsenden.
    </div>
    <p>
      Verwende für eine Support-Anfrage die im Chrome Web Store hinterlegte Kontaktadresse.
      Die installierte Version findest du unter <strong>chrome://extensions</strong>.
    </p>
    <a class="button" href="/privacy">Datenschutzerklärung</a>
  `,
);

export const publicPageHeaders = {
  'cache-control': 'public, max-age=300',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const;
