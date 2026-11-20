# Roadmap di Localis

## Visione

Localis è un "secondo cervello" desktop per chi studia o fa ricerca, e funziona sul computer dell'utente. Ogni **progetto** è un contenitore libero (un corso, un esame, una tesi, una ricerca, un argomento) che raccoglie PDF, dispense, slide, foto di appunti e registrazioni.

Il valore centrale è l'affidabilità: ogni risposta e ogni materiale prodotto si riconducono all'originale (file, pagina, regione, timestamp). Se il contenuto manca o non è leggibile, Localis lo dice invece di inventarlo.

Principi permanenti:
- Dati locali per impostazione predefinita; nessun account o servizio cloud obbligatorio.
- Originali e provenienza preservati per testo estratto, appunti, trascrizioni e artefatti.
- Nomi file, metadati e ipotesi del modello non sono prove del contenuto.
- Nessuna funzione finta.
- Interfaccia minimale, leggibile e accessibile: uno strumento di lavoro.

Regola: non si passa alla versione successiva finché lo stato reale della corrente non è documentato in `docs/STATUS.md`.

## 0.1 — Fondazioni

Aprire Localis, creare un progetto, ritrovarlo dopo il riavvio ed eliminarlo consapevolmente. Shell con sidebar, onboarding, tema chiaro/scuro, SQLite con migrazioni versionate.

## 0.2 — Libreria documenti

Import di PDF, TXT, Markdown, DOCX e immagini; metadati, hash/versioni, cartelle di progetto, viewer PDF e immagini, ricerca FTS5 sul testo estratto, job queue base con stati e retry. Originali conservati e separati da testo estratto, anteprime e derivati; documentare se i file sono copiati nello storage dell'app o referenziati. Gestire duplicati e file mancanti o corrotti. Un PDF scansito si visualizza ma non è ricercabile: niente OCR, niente testo indicizzato dichiarato se non esiste.

## 0.3 — Chat locale con fonti

LM Studio, selettore del modello, embedding locale, retrieval iniziale, chat RAG; ID di fonti ed evidenze passate al modello registrati localmente. Niente Qdrant; non dichiarare embedding se esiste solo FTS5.
- Documento identificato con affidabilità → ricerca limitata a quel documento; riferimento ambiguo → selezione, cronologia o richiesta di chiarimento, mai un file a caso.
- Domande di inventario («Quali documenti ho caricato?») gestite a parte; se manca testo utile, dirlo senza inventare dai metadati.
- Separare risultati grezzi, evidenze nel prompt e citazioni effettive; «citate» solo le evidenze valide, presenti nel prompt e richiamate nella risposta; le altre come «Fonti consultate». Deduplica senza perdere pagine pertinenti.
- Ogni citazione apre file e pagina PDF corretti (o il blocco per altri formati); se l'evidenziazione non è affidabile, apri la pagina e mostra lo snippet.
- Conversazione leggibile, composer sempre raggiungibile, fonti compatte e collassate, inspector richiudibile che da chiuso non occupa spazio. Caricamento con spinner discreto o «Elaborazione…», non parte della cronologia.
- Markdown/GFM e LaTeX locale (KaTeX o equivalente) con `$...$`, `$$...$$`, `\(...\)`, `\[...\]`; raw preservato, delimitatori gestiti senza alterare i blocchi di codice, HTML raw non affidabile disabilitato, test di sanitizzazione e formule, scroll locale per tabelle, codice e formule lunghe.

## 0.4 — Cloud opzionale (anticipata dalla 0.6, su richiesta dell'utente)

Model Mesh (interfaccia comune provider locali/cloud) e PRISM (router per compito, disponibilità, privacy, costo). Gemini, OpenAI, Anthropic, DeepSeek, Qwen per la chat; OpenAI, Gemini e Qwen anche per gli **embedding**. API key nel portachiavi di sistema, mai nel database, nel repository o nel frontend. Prima di **ogni** domanda inviata al cloud: provider, dati inviati (domanda, fonti, cronologia) e stima del costo, poi conferma esplicita. Indicizzazione cloud solo con consenso esplicito per progetto e stima preventiva. Nessun invio senza consenso, nessun fallback silenzioso dal locale al cloud; la modalità solo locale resta il default e sempre disponibile. Registro locale degli invii al cloud.

## 0.5 — FARO base (era 0.4)

Import MP3/MP4, trascrizione locale, segmenti con timestamp e salto al punto della registrazione; import slide/PDF e foto di appunti; timeline per collegare manualmente clip, slide e appunti; crop e regioni come riferimenti non distruttivi. Prova end-to-end: importare una lezione, trascriverla localmente, collegare un intervallo a una slide o foto. Niente sincronizzazione automatica complessa, grafi avanzati, multi-agent nel prodotto o download pesanti senza conferma.

## 0.6 — OCR, formule e knowledge graph (era 0.5)

OCR per documenti e manoscritti, HMER per formule in LaTeX, Visual Evidence per regioni non convertibili, Coverage Ledger (regioni elaborate, mancanti, fallite, solo visive). Qdrant locale e ricerca ibrida densa + lessicale; prime relazioni verificabili tra appunti, trascrizioni e slide. Sempre originale, pagina, regione, versione e provenienza; conversioni incerte mai presentate come certe.

## 1.0 — Artifact Studio e skill

Skill preinstallate, template, export DOCX/PPTX/XLSX/PDF validati e collegati a fonti e richieste d'origine. Skill con permessi minimi, limiti espliciti e sandbox verificata; mai esecuzione automatica di codice generato. Backup/ripristino con prova reale, dashboard attività, benchmark, test di sicurezza.

