# Stato di Localis

**Versione corrente: 0.2 — Libreria documenti.** Completata e verificata su Linux, in un container senza display (Xvfb). Non verificata su macOS e Windows.

Ultimo aggiornamento: 18 novembre 2026.

## 0.2 — Requisiti della roadmap

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

Tutti gli 8 criteri di accettazione sono verificati: il dettaglio è nella cronologia Git di questo file. `e2e/native.mjs` passa ancora 39 controlli su 39 sulla 0.2.

## Verifiche eseguite (ultima esecuzione)

| Comando | Esito |
|---|---|
| `npm run typecheck` | ok |
| `npm test` (3 esecuzioni) | 43/43 ogni volta |
| `npm run build` | ok; il backend finto non è nel bundle; pdf.js viene caricato solo quando si apre un PDF |
| `npm audit` | 0 vulnerabilità |
| `cargo fmt --all --check` | ok |
| `cargo clippy --workspace --all-targets -- -D warnings` | ok |
| `cargo test --workspace` | 94/94: 19 nell'app Tauri, 32 unitari del core, 27 di integrazione della libreria, 16 dei progetti |
| `npm run tauri build -- --debug --no-bundle` | ok |
| `node e2e/library.mjs` (app nativa) | 98/98 |
| `node e2e/native.mjs` (app nativa) | 39/39 |
| Playwright su `npm run dev:mock`: tastiera e layout a 480, 720, 1280 e 1920 px e zoom al 200% con un PDF aperto | 38/39; l'unico fallimento riguarda il comportamento di Chromium con Tab nei dialoghi, mentre nella webview nativa il focus resta nel dialogo. Lo script è del QA e non è nel repository. |

## Decisioni 0.2

- **Copia degli originali**, scelta dall'utente. L'archivio è indirizzato per contenuto: i file prendono il nome dal loro SHA-256, la scrittura è atomica (file temporaneo e poi rinomina) e l'hash viene verificato a ogni lettura.
- **Import tramite byte**: l'interfaccia legge il file scelto e lo invia al backend. Il backend non legge mai percorsi sul disco e non usa i plugin `fs` o `dialog`. Il drag & drop nativo della finestra è disattivato, così il trascinamento arriva all'interfaccia.
- **Estrazione** in un worker in background con la propria connessione al database:
  - PDF per pagina, con `lopdf` e un estrattore proprio. Ho scartato `pdf-extract` perché può far crollare l'app su PDF malformati.
  - DOCX per paragrafo, TXT e Markdown per blocco.
  - Limiti, `catch_unwind` e un timeout di 300 s.
  - Nessun nuovo tentativo automatico: le estrazioni falliscono sempre allo stesso modo, quindi c'è solo «Riprova».
- **Ricerca**: FTS5 con `unicode61 remove_diacritics 2`. Quello che scrivi viene diviso in parole e citato, mai passato come sintassi di ricerca. L'ultima parola vale anche come prefisso.
- **pdf.js 6.5.438**:
  - nessun fetch esterno, script, form o XFA; i decodificatori wasm sono disattivati;
  - i link nei PDF non sono cliccabili;
  - la 5.x è stata scartata per una vulnerabilità nota.
- **Polling** dello stato dei job ogni secondo, solo mentre c'è un'estrazione in corso. Non servono permessi per gli eventi.

## Limiti noti

- **PDF:**
  - Il testo dentro le form XObject non viene estratto, per sicurezza.
  - L'ordine di lettura segue il contenuto del PDF.
  - I PDF protetti da password non vengono estratti.
  - Le immagini JPEG 2000 e JBIG2 nei PDF non vengono mostrate, perché servirebbe abilitare il wasm.
  - I font non incorporati usano i font di sistema.
- **Viewer PDF:** mostra una pagina alla volta, senza scorrimento continuo.
- **Duplicati:** reimportare un file già presente non ripara una copia mancante o alterata nell'archivio.
- **Job:** un'estrazione andata in timeout lascia il suo thread attivo finché termina da sola.
- **Memoria:** un import tiene l'intero file in memoria, fino a 200 MB.
- **Riprova:** l'elenco dei job è limitato agli ultimi 200, quindi il pulsante «Riprova» può mancare per errori molto vecchi.
- **Interfaccia:**
  - La sidebar in sovrapposizione nelle finestre strette non è modale.
  - La vista corrente non viene ricordata.

## Non verificato

- macOS, Windows e build di release con installer.
- Drag & drop reale da un file manager: WebDriver non lo permette e l'import è stato provato con il selettore di file.
- Limite di 200 MB nell'app nativa: coperto solo dai test Rust.
- Ripresa dei job interrotti da un crash e timeout di 300 s: coperti solo dai test Rust.
- Layout stretto e zoom al 200% nella webview nativa con un PDF aperto: provati solo in Chromium.
- Screen reader.

## Come verificare ciò che qui non è stato provato

1. Avvia con `npm run tauri dev` (vedi README) su macOS o Windows, oppure su Linux con display.
2. Trascina nella Libreria un PDF, un DOCX e un'immagine da un file manager: devono comparire, il PDF deve diventare «Ricercabile», l'immagine «Non ricercabile».
3. Cerca una parola del PDF senza accenti e apri il risultato: il viewer deve aprirsi sulla pagina giusta.
4. Riduci la finestra al minimo con il PDF aperto e prova lo zoom del sistema: non deve comparire lo scorrimento orizzontale.

## Prossimo passo: 0.3 — Chat locale con fonti

Primo lavoro: integrazione con LM Studio, cioè rilevare il server locale e i modelli disponibili e scegliere il modello, senza fallback silenziosi. Poi un retrieval iniziale su FTS5 che registra le evidenze passate al modello. Gli embedding locali vanno dichiarati solo quando esistono davvero. Vedi `docs/ROADMAP.md`.
