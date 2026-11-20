# Localis

App desktop local-first per studio e ricerca. Ogni **progetto** è un contenitore libero (un corso, una tesi, una ricerca) in cui raccogli documenti e fai domande con citazioni verificabili. Nelle prossime versioni arriveranno lezioni registrate, OCR e materiali di studio collegati alle fonti.

**Versione 0.4 — Cloud opzionale.** Oggi Localis permette di:
- creare, ritrovare ed eliminare progetti (onboarding, tema chiaro/scuro);
- importare in un progetto PDF, TXT, Markdown, DOCX e immagini (PNG, JPEG, GIF, WebP), fino a 200 MB per file, con il pulsante «Importa» o trascinandoli nella finestra;
- organizzarli in cartelle e caricarne nuove versioni;
- aprirli: PDF e immagini nel viewer, gli altri formati come testo estratto;
- cercare nel testo estratto, con l'indicazione della pagina o del blocco;
- fare domande sui documenti di un progetto a un modello che gira sul tuo computer in LM Studio. Le risposte citano le fonti con `[n]` e ogni citazione apre il documento alla pagina o al blocco giusto;
- se lo scegli, usare modelli cloud con la tua API key (OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen), anche per gli embedding. Va abilitato progetto per progetto e chiede conferma a ogni invio.

Visione e versioni: [`docs/ROADMAP.md`](docs/ROADMAP.md). Stato verificato: [`docs/STATUS.md`](docs/STATUS.md).

Per impostazione predefinita tutti i dati restano sul tuo computer. Nessun account, nessuna telemetria. Localis si collega solo:
- a LM Studio sul tuo stesso computer;
- se lo abiliti, ai cinque provider cloud, ognuno su un unico indirizzo HTTPS fisso, solo per i progetti in cui hai consentito il cloud e solo dopo la tua conferma.

## Prerequisiti

- **Node.js** 22 o successivo, con npm.
- **Rust** stabile 1.90 o successivo (`rustup`), con `rustfmt` e `clippy` per le verifiche.
- **Prerequisiti di sistema di Tauri v2** per la tua piattaforma: <https://v2.tauri.app/start/prerequisites/>
  - **Linux (Debian/Ubuntu):**
    ```bash
    sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev build-essential file
    ```
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Microsoft C++ Build Tools e WebView2 (già presente su Windows 10/11 aggiornati).

## Installazione

```bash
git clone https://github.com/AleCice/Localis.git
```

```bash
cd Localis
```

```bash
npm ci
```

## Avvio

App desktop in sviluppo (avvia Vite e la finestra nativa, con ricarica automatica):

```bash
npm run tauri dev
```

Build dell'app desktop (installer nella cartella `target/release/bundle/`):

```bash
npm run tauri build
```

Build di debug senza installer, più rapida (binario in `target/debug/localis`):

```bash
npm run tauri build -- --debug --no-bundle
```

Solo interfaccia nel browser, con un backend finto in memoria (utile per lavorare sulla UI; i dati spariscono chiudendo la scheda):

```bash
npm run dev:mock
```

## Chat con LM Studio

La Chat usa [LM Studio](https://lmstudio.ai) come server locale dei modelli. LM Studio va installato a parte; Localis non scarica modelli.

1. In LM Studio scarica un modello di chat, per esempio un modello instruct da 7–8B se il computer lo regge, e avvia il server locale dalla scheda «Developer»/«Server». L'indirizzo predefinito è `http://127.0.0.1:1234`.
2. In Localis, **Impostazioni → Modelli locali (LM Studio)**: premi «Verifica connessione» e scegli il modello di chat.
3. Facoltativo: scegli anche un modello di **embedding**, per esempio `nomic-embed-text`. Localis indicizza i passaggi in background (vedi «indicizzati X di Y») e da quel momento la ricerca diventa **ibrida**, cioè lessicale più semantica. Senza modello di embedding la ricerca resta **lessicale** (FTS5) e la chat lo indica.

Come risponde la chat:
- **Fonti:** il modello riceve solo passaggi dei documenti del progetto, numerati. Le risposte li citano con `[n]` e solo i numeri che corrispondono a fonti davvero passate sono cliccabili. Sotto ogni risposta trovi «Fonti citate» e «Fonti consultate»; il pannello «Dettagli» mostra modalità, ambito, query, risultati grezzi, evidenze e citazioni.
- **Domande sui documenti** («Quali documenti ho caricato?»): risponde Localis dall'elenco, senza modello.
- **Nessun passaggio pertinente:** Localis lo dice e non chiama il modello.
- **Ambito della ricerca:**
  - se nomini un documento, la ricerca si limita a quello; se il nome è ambiguo, Localis chiede quale intendi;
  - «Limita a documenti…» restringe la domanda a una selezione;
  - «questo documento» si riferisce a quello della risposta precedente.
- **«Riassumi questo documento»:** non ci sono parole da cercare, quindi il modello riceve le parti iniziali del documento ed è avvisato che non si tratta del testo completo. Le fonti lo indicano come «Passaggio iniziale».
- **Formule e testo:** sono supportate formule LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`), tabelle e codice. L'HTML nelle risposte non viene mai eseguito e i link non si aprono.

## Modelli cloud (facoltativi)

Ogni progetto nasce **«Solo locale»**: in quel caso nessun suo dato può andare a un provider cloud, e il blocco vale anche nel backend, non solo nell'interfaccia.

1. **Impostazioni → Provider cloud:** incolla la API key del provider e premi «Salva». La chiave va **solo nel portachiavi di sistema** (Credential Manager su Windows, Keychain su macOS, Secret Service su Linux). Non finisce mai nel database o nei log e Localis non la rimostra. Se il portachiavi non è disponibile, Localis lo dice e non salva la chiave altrove.
2. **«Carica modelli»** contatta il provider con la tua chiave e ne elenca i modelli.
3. **Prezzi:** Localis non contiene prezzi, perché cambiano spesso. Se vuoi le stime di costo, inseriscili in Impostazioni dal listino del provider (per milione di token, input e output). Senza prezzo vedi solo i token stimati.
4. **Progetti → dettaglio → «Uso del cloud» → «Consenti cloud».**
5. **In chat**, scegli un modello cloud. Prima di **ogni** domanda compare un'anteprima con:
   - provider e indirizzo, modello e perché è stato scelto;
   - domanda, fonti con titoli e pagine, cronologia;
   - caratteri, token stimati e costo stimato.

   Parte solo con «Invia a …» e viene inviato esattamente ciò che hai visto. «Annulla» non invia nulla.

Altre funzioni:
- **Instradamento automatico** (facoltativo): con un elenco di modelli candidati, Localis preferisce un modello locale se LM Studio risponde; altrimenti sceglie il modello cloud più economico secondo i tuoi prezzi. Il motivo della scelta è sempre mostrato.
- **Nessun ripiego silenzioso:** se un modello fallisce (chiave non valida, limite di richieste, provider irraggiungibile) Localis lo dice e non riprova con un altro.
- **Embedding cloud** (OpenAI, Gemini, Qwen): l'indicizzazione dei passaggi richiede un **consenso esplicito per progetto**, dato dopo aver visto una stima di passaggi, token e costo. Si può revocare. Tornare a «Solo locale» revoca anche il consenso.
- **Attività cloud** (Impostazioni): registro locale di ogni richiesta inviata (provider, modello, scopo, caratteri, token, costo, esito). Il contenuto non viene registrato.

Per lo sviluppo: le build **di debug** permettono di puntare i provider a server finti in locale con le variabili `LOCALIS_TEST_<PROVIDER>_BASE_URL`, usate dagli E2E. Nelle build di release questo codice non esiste.

## Dove sono i dati

Il database SQLite `localis.db` sta nella directory dati dell'app, mai nel repository:

| Sistema | Percorso |
|---|---|
| Linux | `~/.local/share/app.localis.desktop/localis.db` (o `$XDG_DATA_HOME/app.localis.desktop/`) |
| macOS | `~/Library/Application Support/app.localis.desktop/localis.db` |
| Windows | `%APPDATA%\app.localis.desktop\localis.db` |

Le preferenze dell'interfaccia (tema, stato della sidebar, onboarding completato) sono nello storage locale della webview: su Linux in `app.localis.desktop/localstorage/`, su macOS e Windows nella cartella dati della webview di sistema (non verificato su queste piattaforme).

### Documenti importati

Localis **copia** ogni file importato nel proprio archivio, la sottocartella `originals/` della cartella dati, e non tiene riferimenti ai file sul tuo disco. Così le copie restano valide anche se sposti o cancelli i file di partenza, al costo dello spazio occupato.

- Ogni copia è salvata con il nome del suo hash SHA-256 (`originals/ab/abcd…`). È identica byte per byte al file importato e viene ricontrollata ogni volta che la apri: se manca o è stata alterata, Localis lo dice invece di mostrarla.
- Lo stesso file importato due volte nello stesso progetto viene riconosciuto come «già presente». In progetti diversi è consentito e la copia viene condivisa.
- Il testo estratto e l'indice di ricerca stanno nel database, separati dagli originali. Non vengono generate anteprime.
- Un PDF senza testo (per esempio una scansione) si apre ma non è ricercabile: l'OCR non c'è ancora. Le immagini si aprono ma non sono ricercabili.
- Conversazioni, passaggi indicizzati, embedding e fonti di ogni risposta (anche dopo la cancellazione di un documento) stanno nello stesso database.

### Cancellazioni e reset

Eliminare un documento o un progetto rimuove i record e le copie di Localis che nessun altro documento usa più. Eliminare un progetto elimina anche le sue conversazioni. **I file sul tuo disco non vengono mai toccati.**

Per ripartire da zero, chiudi Localis e cancella la cartella `app.localis.desktop` indicata sopra. Così rimuovi database e archivio e, su Linux, anche le preferenze.

## Verifiche

Frontend:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

Rust:

```bash
cargo fmt --all --check
```

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

```bash
cargo test --workspace
```

Test end-to-end sull'app desktop vera (Linux), con una directory dati temporanea isolata. `e2e/native.mjs` copre i progetti: crea, valida, riavvia, elimina. `e2e/library.mjs` copre la libreria con file sintetici: import, estrazione, ricerca, viewer, cartelle, versioni, duplicati, integrità, cancellazioni, riavvio. Richiede `WebKitWebDriver` (pacchetto `webkit2gtk-driver`), `tauri-driver` (`cargo install tauri-driver --locked`) e, senza display, `xvfb-run`. Dettagli in testa a [`e2e/native.mjs`](e2e/native.mjs).

```bash
npm run tauri build -- --debug --no-bundle
```

```bash
node e2e/native.mjs
```

```bash
node e2e/library.mjs
```

```bash
node e2e/chat.mjs
```

```bash
node e2e/cloud.mjs
```

`e2e/chat.mjs` usa `e2e/fake-lmstudio.mjs`, un **finto** server LM Studio per i test. Non è un modello: costruisce le risposte meccanicamente dal prompt. `e2e/chat-ui.mjs` controlla layout e tastiera della chat nel browser (Playwright).

`e2e/cloud.mjs` usa `e2e/fake-cloud.mjs`, cioè finti provider cloud (anche questi non sono modelli), e un portachiavi privato. Richiede `dbus-daemon`, `gnome-keyring-daemon` e `secret-tool` (Debian/Ubuntu: `dbus`, `gnome-keyring`, `libsecret-tools`) e una `TMPDIR` corta: va bene `/tmp`. `e2e/cloud-ui.mjs` controlla l'interfaccia cloud nel browser.

## Struttura

```
crates/localis-core/   dominio e SQLite (migrazioni, validazione, test); non dipende da Tauri
src-tauri/             app Tauri: comandi, permessi, configurazione
src/                   interfaccia React + TypeScript
  api/                 contratto e client verso il backend
e2e/                   test end-to-end sull'app nativa
docs/                  roadmap e stato
```

Convenzioni per chi contribuisce (anche agenti AI): [`CLAUDE.md`](CLAUDE.md).
