# Vorschlag: paginierte Rezept-Discovery für XTend Hosted MCP

Stand: 4. November 2026. Status: lokal validierte Referenzimplementierung für einen Review-PR; keine Bereitstellung oder Änderung eines laufenden Endpunkts.

## Ausgangspunkt und Entscheidung

Geprüfte Hosting-Basis: `konnilabs/xtend-mcp`, `main` bei `917cf0ffe429630c5ae7c3ab2e545f9e9321b1f0` (Merge von PR #1 am 15. Oktober 2026). Alle 20 heruntergeladenen Textdateien wurden bytegenau gegen die Git-Blob-Hashes dieses Baums geprüft. Der unveränderte Ausgangsstand bestand die sechs vorhandenen Tests.

Das zusätzliche lesende Tool **`xtend_recipe_list`** liefert einen eigenen Rezeptkatalog über normales `tools/call`. `prompts/list` bleibt eine Liste von Prompt-Definitionen und verwendet ausschließlich den standardisierten Cursor-Parameter. Sprach-, Themen- und Versionsfilter gehören in das Eingabeschema des neuen Tools. Eine neue MCP-Methode oder eine Umdeutung des bestehenden Dokumentationskatalogs ist nicht erforderlich.

Bestehende Dokumentations- und Kit-URIs, `resources/list`, `resources/read`, `xtend_knowledge_search`, `xtend_knowledge_context` und `xtend_recipe` mit dem Argument `id` bleiben erhalten. Der Patch verändert das vendorte Retrieval-Modul nicht. Die beiden bestehenden Knowledge-Tools bleiben allgemeines Retrieval ohne neue Versionsfilter; ihre Treffer sind keine Kompatibilitätszusage. Für eine versionsbezogene Auswahl verwenden Clients den neuen Katalog und anschließend den Prompt-Abruf mit denselben Zielversionen.

SDK und Zod bleiben bei den vorhandenen Pins (`@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node` 2.1.1, Zod 4.6.7). Der Patch verwendet deren tatsächliche Low-Level-Handler mit Methodennamen als Strings und die vorhandenen `ProtocolError`/`INVALID_PARAMS`-Exporte. Für vollständige SemVer-Bereiche kommt `semver` 7.7.3 mit aktualisiertem Lockfile hinzu; Versionsvergleiche werden nicht selbst implementiert.

## Tool-Vertrag v1

Aufrufbeispiel über `POST /mcp` mit den bisher erforderlichen Bearer-/Accept-Headern:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "xtend_recipe_list",
    "arguments": {
      "pageSize": 25,
      "locale": "all",
      "topics": ["maraca"],
      "topicMode": "any",
      "target": {"xtend": "0.9.0", "adapters": {"react": "19.2.0"}},
      "includeUnknown": true,
      "includeIncompatible": false
    }
  }
}
```

Die Versionswerte im Beispiel illustrieren den Vertrag; sie behaupten keine Anforderungen eines heutigen XTend-Rezepts.

| Argument | Vertrag / Standardwert |
| --- | --- |
| `cursor` | Optionaler opaker String, 1–4.096 Zeichen; auf der ersten Seite weglassen. |
| `pageSize` | Ganze Zahl 1–100, Standard 25. Das Bytebudget kann eine kleinere Seite erzwingen. |
| `locale` | `all`, `de`, `en` oder `und`; Standard `all`. Ein konkreter Filter ist exakt. |
| `topics` | Höchstens 16 Suchbegriffe mit je 1–64 Zeichen; Standard leer, also kein Themenfilter. Kein Themen-Enum. |
| `topicMode` | `any` oder `all`, Standard `any`; OR bzw. AND innerhalb von `topics`. |
| `target.xtend` | Optionale Zielumgebung; wenn `target` gesetzt ist, ist eine kanonische exakte SemVer-Version erforderlich. Keine Bereiche oder Präfixe wie `v`. |
| `target.adapters` | Optionales Objekt mit höchstens 16 frei benannten Adaptern und exakten SemVer-Versionen. |
| `includeUnknown` | Boolean, Standard `true`. Bei `false` werden unbekannte Kompatibilitäten ausgeschlossen. |
| `includeIncompatible` | Boolean, Standard `false`. `true` erlaubt die bewusste Inspektion nachweislich inkompatibler Rezepte. |

Unbekannte Eingabefelder werden abgewiesen; es gibt keine stillen Zahlenkonvertierungen oder Klemmung ungültiger Seitengrößen. Zod prüft zusätzlich die SemVer-Semantik. Das in `tools/list` veröffentlichte Schema wird mit `z.toJSONSchema(listRecipesSchema, { io: 'input' })` erzeugt: Standardwerte dürfen optionale Eingaben im JSON Schema nicht versehentlich zu Pflichtfeldern machen. Die Adapterzahl steht zusätzlich als `maxProperties: 16` im Schema.

Das Ergebnis enthält `structuredContent` und denselben JSON-Wert als Text in `content[0]` für Clients ohne strukturierte Ergebnisverarbeitung. Beide Kopien zählen zum Bytebudget.

| Ergebnisfeld | Bedeutung |
| --- | --- |
| `schema` | `xtend.mcp.recipe-catalog.v1` |
| `provenance` | `repository`, `ref` und konkrete Wissens-Commit-SHA; kein abgeleiteter Versionsvergleich mit der Serverversion. |
| `catalogHash` | SHA-256 des nach stabilen IDs sortierten Rezeptbestands. |
| `filters` | Normalisierte Auswahl einschließlich Zielversionen, Flags und Seitengröße; zur Fortsetzung wiederverwenden. |
| `total` | Anzahl aller passenden Rezepte im ausgewählten Snapshot, nach Filtern. |
| `count` | Anzahl der Einträge dieser Seite, identisch mit `items.length`. |
| `items` | Zusammenfassungen; keine Rezeptquellen, Schritte oder Befehle. |
| `nextCursor` | Nur vorhanden, wenn noch weitere passende Einträge existieren. |

Jeder Eintrag enthält die unveränderte `id`, `title` (höchstens 200 Unicode-Codepoints), `intent` (höchstens 500 Codepoints), `locale`, `topics`, die kanonische `uri`, `prompt: "xtend_recipe"`, `promptAlias` und `compatibility`. Die Begrenzung der beiden Anzeigetexte verändert den vollständigen Datensatz nicht; dieser bleibt über URI oder Prompt abrufbar. Themen, IDs und Anforderungen werden niemals abgeschnitten. Ein leerer Bestand oder ein Filter ohne Treffer ergibt `items: []`, `count: 0`, `total: 0` ohne Cursor.

## Identität, Sprache und Themen

Die kanonische Rezept-ID kommt ausschließlich aus dem Datensatz. Es gibt weder Positions-IDs noch IDs aus Titeln. Groß-/Kleinschreibung und Unicode bleiben erhalten; ungültige Unicode-Strings werden beim Import abgewiesen. Die URI bleibt `xtend://rmt/kit/recipe/${encodeURIComponent(id)}`. Die Ordnung verwendet einen deterministischen Stringvergleich der IDs, unabhängig von Betriebssystem-Locale, übersetztem Titel und Reihenfolge der JSONL-Zeilen. Herausgeber müssen IDs beim Bearbeiten eines vorhandenen Rezepts beibehalten.

Die bestehenden `domains` werden für den Katalog als offene Themenmenge verwendet: Unicode NFC, Trim, Kleinschreibung, Deduplizierung und Sortierung. Themenfilter sind exakte Mengenvergleiche; neue Themen benötigen keinen Serverbuild. Sprache wird ausschließlich aus dem optionalen Datensatzfeld `locale` gelesen. Fehlende Sprache wird `und`, ohne aus englischen Titeln oder deutschen Suchanfragen zu raten. `locale: "de"` enthält deshalb keine unbekanntsprachigen Rezepte.

## Cursor und Snapshot-Konsistenz

Der Cursor ist versioniertes Base64url-JSON mit `v`, `kind`, `commit`, `scope`, `query` und `last`. `last` ist die letzte tatsächlich ausgegebene ID. `scope` bindet Repository, Ref und Kataloghash; `query` bindet alle normalisierten Filter einschließlich Zielversionen und Seitengröße. Prompt- und Rezeptcursor sind nicht austauschbar. Falsche Kodierung, zusätzliche Cursorfelder und nicht vorhandene Grenzen werden abgewiesen.

1. Erste Seite ohne Cursor anfordern; `provenance.commit` oder den Antwortheader `X-XTend-Snapshot` merken.
2. Auf jeder Folgeseite denselben Snapshot per `X-XTend-Snapshot` auswählen und die zurückgegebenen Filter mit `nextCursor` senden.
3. Für den anschließenden Prompt- oder Ressourcenabruf denselben Header verwenden, damit Entdeckung und Inhalt zusammenpassen.
4. Bei geändertem Standard-Snapshot wird ein ungebundener Folgeaufruf ausdrücklich abgewiesen. Nach Eviction muss der Client die Auflistung auf einem verfügbaren Snapshot neu starten.

Der Cursor reserviert keinen Snapshot über mehrere HTTP-Anfragen hinweg und startet keine Downloads. Die vorhandenen Leases schützen nur laufende Anfragen. Nach einem Neustart wird der Katalog aus den erneut validierten Dateien rekonstruiert; Cursor eines weiterhin aufbewahrten Snapshots funktionieren wieder. Die Kodierung ist weder Verschlüsselung noch Signatur und stellt keine Autorisierungsgrenze dar. Ein berechtigter Leser könnte eine andere gültige Seitengrenze einsetzen; er erhält dadurch keinen zusätzlichen Datenzugriff. Cursor sind ausschließlich als opake Fortsetzungstoken zu behandeln.

## Kompatibilitätsmetadaten und Verhalten

Die bestehenden Rezeptschemas bleiben v1. Der kanonische Generator im XTend-Hauptrepository kann diese optionalen Felder ergänzen:

```json
{
  "locale": "en",
  "compatibility": {
    "schema": "xtend.recipe.compatibility.v1",
    "xtend": ">=0.8.0 <1.0.0",
    "adapters": {"react": "^19.0.0"}
  }
}
```

Dieses Beispiel zeigt eine vorgeschlagene additive Datenerweiterung, keine bereits vorhandenen Anforderungen. Keine zweite Rezeptdatei und keine handgepflegte Hosting-Kopie werden angelegt. Bereits existierende Datensätze ohne diese Felder bleiben lesbar. Zusätzliche unbekannte Metadatenfelder bleiben erlaubt; ein nicht unterstützter Kompatibilitätsschema-Hauptstand oder ein ungültiger SemVer-Bereich verwirft dagegen den neuen Snapshot vollständig.

| Bedingung | Status / Standardverhalten |
| --- | --- |
| Keine Kompatibilitätsmetadaten | `unknown`, Grund `metadata_missing`; standardmäßig sichtbar. |
| Metadaten vorhanden, keine Zielumgebung | `unknown`, Grund `target_missing`. |
| XTend und alle angeforderten Adapter erfüllen die Anforderungen | `compatible`. |
| Benötigte Adapterversion nicht angegeben | `unknown`, Grund `adapter_version_missing:<name>`. |
| Mindestens eine bekannte Versionsanforderung verletzt | `incompatible`, auch wenn zusätzlich Angaben fehlen; standardmäßig ausgeschlossen. |

`requires` gibt vorhandene Anforderungen unverändert zurück. Die Auswertung folgt `node-semver`, einschließlich dessen normaler Prerelease-Regeln: Ein allgemeiner Release-Bereich schließt Prereleases nicht automatisch ein. Fehlende Versionsdaten werden weder aus `main` noch aus einer Git-SHA, dem Kit-Format oder der Serverversion hergeleitet. `unknown` ist keine Empfehlung oder Zusage; für ausschließlich nachgewiesen passende Ergebnisse müssen Zielversionen und `includeUnknown: false` gesetzt werden.

Das prüft deklarierte Versionsbedingungen, nicht die fachliche Ausführbarkeit, installierte Voraussetzungen oder Compiler-Frische. Lokale Validierung mit dem passenden XTend-Werkzeug bleibt erforderlich.

## Generischer Prompt und individuelle Aliase

`prompts/get` mit `name: "xtend_recipe"` und `arguments: {"id": "…"}` bleibt gültig. Die bisherige JSON-Payload enthält weiterhin `provenance` und den vollständigen unveränderten `recipe`-Datensatz; `compatibility` wird additiv ergänzt.

Optionale Prompt-Argumente sind Strings, wie im MCP-Prompt-Vertrag vorgesehen:

| Argument | Verhalten |
| --- | --- |
| `xtendVersion` | Exakte kanonische SemVer-Zielversion. |
| `adapterVersions` | JSON-Objekt als String, beispielsweise `{"react":"19.2.0"}`; benötigt `xtendVersion`. |
| `allowIncompatible` | String `"true"` oder `"false"`. Nur `"true"` erlaubt bewusst den Abruf eines nachweislich inkompatiblen Rezepts. |
| `task` | Optionaler Text bis 2.000 Zeichen, insbesondere für die bestehenden individuellen Aliase; bleibt Dateninhalt. |

Ohne Zielversion gibt es keine Versionsablehnung und keine erfundene positive Zusage. Mit nachweislichem Konflikt schlägt der Prompt-Abruf standardmäßig mit `RECIPE_INCOMPATIBLE` fehl. Bei bewusster Inspektion bleibt der Status `incompatible` im Ergebnis sichtbar. Direkte Ressourcenabrufe bleiben unveränderte Datenabrufe ohne zusätzliche Filter oder Ausführung.

Die individuellen Namen entsprechen exakt dem bisherigen XTend-Kern: `xtendRmt_` plus `id.replace(/[^a-zA-Z0-9_]+/gu, '_')`. Die sechs am vendorten Upstream-Stand vorhandenen Namen werden so wieder unterstützt. Beispielsweise wird aus `maraca-plan-build` der Name `xtendRmt_maraca_plan_build`. Ein Alias löst über eine Map auf dieselbe stabile Rezept-ID auf. Ein abweichend mitgeschicktes `id` wird abgewiesen.

Die erste `prompts/list`-Seite enthält den generischen Prompt zuerst; danach folgen Aliase in Rezept-ID-Ordnung. Jede Seite enthält höchstens 25 Definitionen und unterliegt ebenfalls dem Bytebudget. Volltexte erscheinen erst bei `prompts/get`. Auf Prompt-Listen werden keine nicht standardisierten Sprach-/Themenparameter aufgesetzt.

IDs wie `a-b` und `a_b` würden denselben Legacy-Alias erzeugen. Der Patch verwirft in diesem Fall den neuen Snapshot mit `RECIPE_ALIAS_COLLISION`, statt einen vorhandenen Namen umzubinden oder still ein Rezept zu verstecken. Das ist eine zusätzliche Importvalidierung: Bisher akzeptierte, aber mehrdeutige Bestände benötigen vor Übernahme des Patches eindeutige kanonische IDs bzw. eine ausdrücklich geplante Alias-Migration. Die tatsächlich geprüften historischen sechs IDs kollidieren nicht. Eine automatische Umbenennung vorhandener Aliase ist ausdrücklich kein Bestandteil dieses Vorschlags.

## Antwortbudgets und Fehler

`XTEND_RECIPE_PAGE_BYTES` ist ein Betreiberbudget (Standard 65.536 Bytes, konfigurierbar 4.096–1.048.576). Effektiv gilt `min(recipePageBytes, maxResponseBytes - 1024)`. Gemessen wird das vollständige serialisierte MCP-Tool-Ergebnis einschließlich Textkopie, strukturiertem Inhalt, Provenienz, Filterecho und Fortsetzungstoken; bei Prompt-Listen die gesamte Ergebnisstruktur. Dadurch zählen UTF-8, JSON-Escaping und lange IDs tatsächlich mit.

Das vorhandene HTTP-Transportbudget bleibt die abschließende Grenze des gesamten JSON-RPC-Pakets. Die 1-KiB-Reserve deckt normale Request-IDs ab; ungewöhnlich lange IDs können vom Transportguard kontrolliert abgewiesen werden. Der Patch ergänzt dabei eine HTTP-Vorprüfung: Überschreitet eine String-ID in ihrer JSON-Kodierung `maxResponseBytes - 256`, wird die Anfrage vor der SDK-Verarbeitung mit HTTP 413 und `request_id_too_large` abgewiesen. So passt auch eine eventuelle Fehlerantwort ins Budget, und die interne Request-/Response-Zuordnung des SDK bleibt erhalten. Dieser Ausnahmefall ist über HTTP getestet. Vollständige Einzelabrufe unterliegen ebenfalls dem Transportguard. Der Patch schneidet vollständige Rezepttexte nicht ab.

Eine Seite enthält nur ganze Zusammenfassungen. Falls ein zusätzlicher Eintrag das Budget überschreitet, wird er auf der nächsten Seite fortgesetzt. Passt schon ein einzelner Eintrag oder der Ergebnisrahmen nicht, gibt es `RECIPE_PAGE_BUDGET`. Es wird weder ein übergroßes Rezept übersprungen noch eine leere Seite mit demselben Cursor als Endlosschleife ausgegeben. Der Betreiber muss Budget bzw. Metadatenumfang korrigieren oder ein Client den Filterrahmen verkleinern. Kein Rezept wird beim Import aus Kapazitätsgründen abgeschnitten.

| Situation | Sichtbarer Vertrag |
| --- | --- |
| Ungültige Tool-/Prompt-Eingabe | JSON-RPC `-32602`, `error.data.code: "INVALID_ARGUMENTS"`. |
| Ungültiger Cursor oder geänderte Filter | JSON-RPC `-32602`, `INVALID_CURSOR`. |
| Cursor gehört zu anderem ausgewählten Snapshot | Beim Tool `isError: true` mit `STALE_CURSOR`; bei Prompt-Listen JSON-RPC `-32602` mit diesem Datencode. |
| Eine Seite passt nicht ins Budget | Beim Tool `isError: true` mit `RECIPE_PAGE_BUDGET`; bei Prompt-Listen JSON-RPC `-32602` mit diesem Datencode. |
| Request-ID kann nicht einmal in eine begrenzte Fehlerantwort passen | HTTP 413 mit `request_id_too_large`, vor Snapshot-Lease und SDK-Verarbeitung. |
| Fehlendes Rezept / unbekannter Alias | JSON-RPC `-32602`, `RECIPE_NOT_FOUND`. |
| Versionskonflikt beim Prompt-Abruf | JSON-RPC `-32602`, `RECIPE_INCOMPATIBLE`. |
| Explizit gewählter Snapshot wurde entfernt | Unverändertes bestehendes HTTP-Verhalten: 503 mit `request_failed`, kein stiller Wechsel. |
| Ungültige neue Metadaten / Alias-Kollision beim Sync | Keine Aktivierung; letzter gültiger vollständiger Snapshot bleibt aktiv; Sync-Status enthält den Fehlercode. |

Schema-/Cursorfehler stehen im Protokollfehler; zustands- bzw. budgetbezogene Fehler des neuen Tools stehen in dessen `isError`-Resultat. Clients müssen beide Ebenen behandeln. Bestehende HTTP-Zugangs-, Rate-, Body-, Parallelitäts- und Timeoutprüfungen bleiben vorgeschaltet.

## Konkrete Änderungen und Skalierung

| Datei | Änderung |
| --- | --- |
| `src/recipes.mjs` | Zod-Eingabeschemas, optionale Metadatenvalidierung, ID-/Alias-/URI-Maps, deterministische Ordnung, Kompatibilitätsauswertung, Cursor, Summaries und Budgetmessung. |
| `src/bundle.mjs` | Katalog während `validateBundle` vor Aktivierung vorbereiten; beim Neustart identisch rekonstruieren. |
| `src/mcp.mjs` | Neues Tool vor dem bisherigen Argumentparser dispatchen; Prompt-Liste paginieren; generischen und Alias-Abruf vereinheitlichen; explizite SDK-Fehler. |
| `src/config.mjs`, `src/http.mjs` | Konfigurierbares Seitenbytebudget an den pro Anfrage erzeugten SDK-Server weitergeben. |
| `test/fixtures.mjs` | Bisherigen synthetischen Bestand wiederverwenden; optionale Transformation ergänzt Sprache, Versionen und Grenzfälle. |
| `test/recipes.test.mjs` | Vertragstests und HTTP-Durchläufe mit dem vorhandenen SDK-Transport. |
| `test/service.test.mjs` | Additives Tool erwarten; atomare Ablehnung ungültiger Metadaten und Cursorfortsetzung nach Recovery prüfen. |
| `package.json`, `package-lock.json`, `README.md` | SemVer-Pin, Syntaxprüfung und dokumentierter Vertrag. |

Der Katalog gehört zum validierten In-Memory-Bundle und lebt genauso lange wie sein Snapshot. Es gibt keinen zusätzlichen unbegrenzten Prozesscache. Aufbau: Sortierung O(N log N), zusätzliche Maps/Themen O(N plus Metadatenumfang). ID-, Alias- und URI-Lookups sind über Maps möglich. Eine Katalogseite scannt den Bestand für Filter und `total` in O(N); sie serialisiert höchstens die begrenzte Zahl ausgewählter Summaries. Für erheblich größere Bestände können später invertierte Themen-/Sprachindizes und vorberechnete Filtermengen ergänzt werden, ohne den API-Vertrag zu ändern.

Die Testgrößen 0, 1, 7, 1.000 und 1.403 prüfen Verhalten und Wachstum. Keine davon ist Sollumfang oder Produktmaximum. Die 100 Einträge und 16 Filter-/Adapterwerte sind Grenzen einzelner Requests bzw. Metadatenstrukturen; die Anzahl gespeicherter Rezepte und die globale Menge von Themen bleiben offen. Bestehende Snapshot-Bytebudgets begrenzen die Betriebskapazität und dürfen nur den gesamten neuen Snapshot ablehnen.

## Prüfung, Anwendung und verbleibende Abnahmen

Lokal geprüft mit Node.js 24.22.1 und npm 11.9.0. `npm ci --ignore-scripts` installiert anhand des Lockfiles; `npm test` umfasst 16 erfolgreiche Tests, davon zehn neue Rezept-Vertragstests und sechs bestehende bzw. erweiterte Servicetests. `npm run check` besteht. Die vollständigen Befehlsausgaben stehen im beigefügten Validierungsprotokoll; ein zusätzlicher Bericht misst den 1.000-Rezepte-Durchlauf ohne daraus Hardware- oder Latenzzusagen abzuleiten.

Geprüft sind vollständige, duplikatfreie Seitenfolgen auch oberhalb von 1.000; unveränderte stabile IDs und URI-Escapes; offene Themen, Sprachfilter und AND/OR; unbekannte und inkompatible Zielversionen einschließlich Prereleases und Adaptern; ungültige/zweckfremde Cursor; Snapshot-Wechsel, Pinning, Eviction und Neustart; UTF-8-/Escaping-Budgets; komplette paginierte Aliaslisten; generischer Prompt, Alias und kanonischer Ressourcenabruf; sowie atomare Ablehnung ungültiger neuer Metadaten. Die tatsächlich registrierten JSON-Eingabeschemas werden über HTTP kontrolliert.

Zur späteren Übernahme in einen Review-Branch auf der angegebenen Basis:

```bash
git switch -c review/recipe-discovery 917cf0ffe429630c5ae7c3ab2e545f9e9321b1f0
git apply --check /absolute/path/recipe-discovery.patch
git apply /absolute/path/recipe-discovery.patch
npm ci --ignore-scripts
npm test
npm run check
```

Der beigefügte Patch enthält die Dokumentation ebenfalls. Er setzt keine externen Zugangsdaten voraus und verändert bei diesen Tests nur temporäre lokale Daten. Nach späterer fachlicher Freigabe muss der kanonische Upstream-Generator belastbare Sprach-/Versionsmetadaten ausgeben. Ein Serverbuild allein kann diese Informationen nicht herstellen. TLS-Reverse-Proxy-Abnahme, Container-Build, signierte Updates, Generator-Frische und Zielhardware-Benchmark bleiben die bereits offenen Betriebsarbeiten; dieser Vorschlag erklärt den Dienst nicht für produktionsreif. Die README empfiehlt Node 24.19.0; genau diese Patchversion wurde hier nicht ausgeführt.

## Quellen

- [Hosting-PR #1](https://github.com/konnilabs/xtend-mcp/pull/1)
- [Geprüfter Handler-Stand](https://github.com/konnilabs/xtend-mcp/blob/917cf0ffe429630c5ae7c3ab2e545f9e9321b1f0/src/mcp.mjs)
- [Geprüftes README](https://github.com/konnilabs/xtend-mcp/blob/917cf0ffe429630c5ae7c3ab2e545f9e9321b1f0/README.md)
- [Übergeordnetes XTend-Issue #113](https://github.com/konnilabs/xtend/issues/113)
- [Historischer Upstream-Prompt-Vertrag](https://github.com/konnilabs/xtend/blob/c31e380f13dfb3b64456f2b149b504efe4d81dfa/products/xtend-mcp/src/server.mjs)
- [Tatsächliche historische Rezeptdaten](https://github.com/konnilabs/xtend/blob/c31e380f13dfb3b64456f2b149b504efe4d81dfa/tools/rmt-language/generated/rmt-ai-developer-kit/rmt-ai-kit.recipes.jsonl)
- [MCP-Tools-Vertrag](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [MCP-Prompts-Vertrag](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- [Offizielles TypeScript-SDK](https://github.com/modelcontextprotocol/typescript-sdk), [node-semver](https://github.com/npm/node-semver)
