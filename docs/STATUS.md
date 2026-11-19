# Stato di Localis

**Versione corrente: 0.3 — Chat locale con fonti.** Verificata su Linux, in un container senza display, con un **finto server LM Studio** (`e2e/fake-lmstudio.mjs`, che non è un modello). **Il funzionamento con un LM Studio reale e con modelli reali non è verificato**: nel container non ce n'erano. Non verificata su macOS e Windows.

Ultimo aggiornamento: 19 novembre 2026.

## 0.3 — Requisiti della roadmap

| Requisito | Stato | Evidenza |
|---|---|---|
| Integrazione LM Studio | ⚠️ solo con il server finto | Elenco modelli (`/api/v0/models`, con ripiego su `/v1/models`), embedding e chat in streaming SSE. Errori (server spento, HTTP 500, nessun modello) mostrati come `llm_unavailable` con indicazioni. URL accettato solo su indirizzo locale: 10 casi limite rifiutati, `[::1]` accettato. Le variabili proxy vengono ignorate e il traffico osservato andava solo a loopback. |
| Selettore del modello | ✅ (server finto) | Impostazioni e intestazione della chat mostrano solo i modelli segnalati da LM Studio, disattivati se il server non è raggiungibile. |
| Embedding locale | ⚠️ solo con il server finto | L'indicizzazione in background arriva a «14 di 14» e riprova con attesa crescente se LM Studio non risponde. La modalità «Ibrida» compare solo se esistono vettori per l'ambito **e** l'embedding della domanda è riuscito. |
| Retrieval iniziale | ✅ | FTS5 in OR senza stopword italiane, coseno sui vettori, fusione RRF, al massimo 8 evidenze entro 6000 caratteri. |
| Chat RAG | ✅ (meccanismi) | La risposta salvata coincide byte per byte con l'output del modello; la qualità con un modello reale non è verificata. |
| ID di fonti ed evidenze registrati | ✅ | Tre livelli nel database (risultati grezzi, passati nel prompt, citati), identici dopo il riavvio. Sono copie fissate al momento della risposta, quindi restano leggibili anche dopo la cancellazione del documento («Documento non più disponibile»). |
| Documento identificato → ricerca solo su quello | ✅ | Ambito per titolo, per selezione e dalla conversazione, verificato nell'app vera. |
| Riferimento ambiguo → chiarimento | ✅ | Due candidati, nessuna chiamata al modello; la scelta reinvia la domanda limitata a quel documento. In un progetto con un solo documento «questo documento» indica quello. |
| Inventario («Quali documenti ho caricato?») | ✅ | Funziona anche senza LM Studio; elenca i documenti reali con lo stato del testo, per esempio «senza testo ricercabile». |
| Grezzi, evidenze e citazioni separati | ✅ | `[1]` è citato; `[99]` e `[2]` dentro il codice no. «Fonti citate» e «Fonti consultate» sono separate; i risultati grezzi stanno solo nel pannello «Dettagli». |
| Deduplica senza perdere pagine | ✅ (test Rust) | `select_evidence` e RRF tengono pagine diverse dello stesso documento. Non provato nell'app nativa. |
| La citazione apre file e pagina o blocco giusti | ✅ versione corrente | PDF alla pagina 2 di 2, testo al blocco 2, con pannello dello snippet e «Torna alla chat». L'apertura di una versione precedente citata non è provata nell'app nativa. |
| Layout della chat | ✅ | Composer sempre visibile a 480, 720, 1280 e 1920 px e con zoom al 200%. Fonti chiuse di default. Il pannello «Dettagli» chiuso non occupa spazio. «Elaborazione…» non resta nella cronologia. |
| Markdown/GFM e KaTeX con i 4 delimitatori | ✅ | `$…$`, `$$…$$`, `\(…\)` e `\[…\]` sono renderizzati, anche le tabelle. Il codice con `$` o `\(` resta letterale. Nessuna violazione della CSP: i font KaTeX non sono più incorporati come `data:`. |
| Testo originale preservato, niente HTML eseguito | ✅ | Una risposta ostile viene salvata identica e resta inerte nell'app nativa: `<script>`, `<img onerror>`, `<svg onload>`, link `javascript:`, `\href`. I link non si aprono. |
| Scroll locale | ✅ | Tabelle, codice e formule lunghe scorrono dentro il proprio riquadro; la pagina non scorre in orizzontale. |
| Interruzione e recupero | ✅ | «Interrompi» conserva il testo parziale (con le citazioni valide); un secondo invio durante la generazione dà `conflict`. Dopo un SIGKILL a metà risposta, il riavvio mostra «Risposta interrotta.». |

## Verifiche eseguite (ultima esecuzione)

| Comando | Esito |
|---|---|
| `npm run typecheck` | ok |
| `npm test` (3 esecuzioni) | 86/86 ogni volta |
| `npm run build` | ok; codice del backend finto assente dal bundle; font KaTeX come file locali |
| `npm audit` | 0 vulnerabilità (KaTeX forzato alla 0.19.1 con `overrides`) |
| `cargo fmt --all --check` | ok |
| `cargo clippy --workspace --all-targets -- -D warnings` | ok |
| `cargo test --workspace` | 158/158: 27 nell'app Tauri, 63 unitari del core, 25 di integrazione della chat, 27 della libreria, 16 dei progetti |
| `npm run tauri build -- --debug --no-bundle` | ok |
| `node e2e/chat.mjs` (app nativa e server LM Studio finto) | 100/100 |
| `node e2e/chat-ui.mjs` (Playwright su `dev:mock`) | 31/31 |
| `node e2e/library.mjs` | 98/98 |
| `node e2e/native.mjs` | 39/39 |

## Decisioni 0.3

- **Rete:** solo il backend parla con LM Studio, solo su loopback (`127.0.0.1`, `localhost`, `[::1]`), con `ureq` senza TLS, senza proxy e senza redirect. La webview non fa richieste di rete e la CSP resta invariata.
- **Passaggi (chunk):**
  - derivati dal testo estratto, al massimo circa 1200 caratteri, su confini di paragrafo o frase;
  - creati alla fine dell'estrazione e, per i documenti importati con la 0.2, recuperati al primo avvio della 0.3.
- **Embedding:**
  - vettori f32 normalizzati in SQLite, per modello;
  - si usano solo quelli del modello configurato e nessun Qdrant;
  - i risultati semantici molto peggiori del migliore (oltre 0,15 di coseno) vengono scartati.
- **Senza termini da cercare non si usa la ricerca semantica:** la similarità da sola trova sempre qualcosa di vagamente simile. «Riassumi tutto» sull'intero progetto risponde quindi «nessun passaggio pertinente». Con un ambito su un documento si passano invece le sue parti iniziali, dichiarate come tali al modello e nell'interfaccia (`via: "position"`).
- **Regole deterministiche, senza LLM,** per inventario, titolo nominato, ambiguità e «questo documento».
- **Prompt:**
  - sistema in italiano;
  - fonti come dati non affidabili, racchiuse da delimitatori con un codice casuale per richiesta, così un documento non può chiudere la propria fonte;
  - nella cronologia, le ultime 3 coppie domanda/risposta.
- **Citazioni** `[n]`, `[n, m]`, `[n-m]` riconosciute fuori da codice e formule. Contano solo i numeri passati nel prompt. Il testo raw non viene mai modificato.
- **Dipendenze nuove:**
  - Rust: `ureq` 3.5 (senza TLS) e `serde_json`;
  - frontend: `react-markdown`, `remark-gfm`, `remark-math`, `rehype-katex`, `katex` 0.19.1.

## Limiti noti 0.3

- **LM Studio reale non verificato.** Restano da provare la qualità delle risposte, le particolarità dello streaming reale, la distribuzione reale delle similarità e il timeout di lettura di 300 s su prompt lunghi.
- **Titoli:** un titolo di una sola parola di 4 o più lettere (per esempio «note.md») limita l'ambito a quel documento ogni volta che la parola compare nella domanda.
- **Viewer PDF:** una citazione apre la pagina e mostra lo snippet, ma non evidenzia il passaggio sulla pagina.
- **Blocchi di codice indentati:** quelli con 4 spazi non vengono riconosciuti per la conversione dei delimitatori LaTeX. Quelli con ``` e il codice inline sì.
- **Thread in background:** dopo un'interruzione, un server bloccato può tenere attivo il thread di lettura fino a 300 s. L'utente non resta bloccato.

## Come provare con LM Studio reale

1. Installa LM Studio, scarica un modello di chat e, se vuoi, uno di embedding (per esempio `nomic-embed-text`). Avvia il server locale.
2. `npm run tauri dev`, poi Impostazioni → Modelli locali → «Verifica connessione». Scegli i modelli e aspetta «indicizzati X di X».
3. In un progetto con qualche PDF fai una domanda sul contenuto. La risposta deve citare `[n]` e la citazione deve aprire la pagina giusta.
4. Prova «Quali documenti ho caricato?», una domanda su un argomento assente (deve dire che non ha trovato passaggi) e «Riassumi questo documento» con un documento selezionato.
5. Chiudi LM Studio e fai una domanda: deve comparire «LM Studio non è raggiungibile…».

## 0.2 — Libreria documenti (verificata)

| Requisito | Stato | Evidenza |
|---|---|---|
| Import di PDF, TXT, Markdown, DOCX e immagini | ✅ | `e2e/library.mjs` importa nell'app vera, tramite il vero `<input type=file>`, un PDF con testo, un PDF «scansionato», un DOCX, un TXT, un MD e un PNG. JPEG, GIF e WebP sono coperti solo dai test Rust. |
| Metadati | ✅ | sha256, dimensione, tipo, numero di pagine, dimensioni dell'immagine e data di modifica del file letti dall'app coincidono con i file di prova. |
| Hash e versioni | ✅ | Nuova versione di un TXT: la versione 2 diventa corrente; la ricerca trova il testo nuovo e non quello vecchio; le copie di entrambe le versioni restano nell'archivio. |
| Cartelle di progetto | ✅ | Creazione, spostamento di un documento, eliminazione rifiutata su cartella non vuota, eliminazione di cartella vuota, persistenza dopo il riavvio. |
| Viewer PDF | ✅ | La pagina disegnata non è vuota; un risultato di ricerca apre la pagina giusta; navigazione e zoom funzionano; nessuna violazione della CSP registrata nella webview. |
| Viewer immagini | ✅ | PNG mostrato alla dimensione naturale. |
| Ricerca FTS5 sul testo estratto | ✅ | La ricerca ignora gli accenti («citta» trova «città»); funzionano prefissi e risultati con pagina o blocco ed evidenziazione; 10 query con caratteri speciali FTS non danno errori; la ricerca copre solo la versione corrente. |
| Job queue con stati e retry | ✅ | Un PDF corrotto finisce in errore con «Riprova»; il nuovo tentativo viene eseguito (`attempts` passa da 1 a 2); riprovare un job completato restituisce `conflict`. |
| Originali conservati e separati dai derivati | ✅ | Le copie in `originals/<2>/<sha256>` sono identiche byte per byte ai file di prova; i file di partenza non vengono modificati; testo estratto e indice stanno solo nel database; non vengono generate anteprime. |
| Copia o riferimento documentato | ✅ | Scelta: **copia** (README, sezione «Documenti importati»). |
| Duplicati | ✅ | Reimportare un file nello stesso progetto dà «Già presente» e non crea un documento; in un altro progetto il documento viene creato e la copia condivisa. |
| File mancanti o corrotti | ✅ | Una copia alterata o mancante nell'archivio viene segnalata nel viewer (errore `integrity`). Vengono rifiutati: `.exe`, un file con estensione e contenuto diversi, un file vuoto, nomi e header non validi. |
| PDF scansito visualizzabile ma non ricercabile | ✅ | Stato «Senza testo ricercabile», nessun testo indicizzato, nota che l'OCR non è disponibile. |
| Cancellazioni | ✅ | Eliminare un documento rimuove la sua copia; eliminare un progetto rimuove le sue copie e conserva quelle condivise con altri progetti; nessun file fuori da `originals/` viene toccato. |
| Persistenza dopo il riavvio | ✅ | Documenti, cartelle, versioni e stati di estrazione restano dopo la riapertura. |

## 0.1 — Fondazioni

Tutti gli 8 criteri verificati; dettagli nella cronologia Git di questo file. `e2e/native.mjs` passa ancora 39/39.

## Prossimo passo: 0.4 — FARO base

Primo lavoro: import di MP3 e MP4 con conservazione dell'originale e scelta del motore di trascrizione locale, da scaricare solo con la tua conferma. Poi segmenti con timestamp e salto al punto della registrazione. Vedi `docs/ROADMAP.md`.
