//! Library integration tests: temporary data directories, synthetic fixtures only.

mod common;

use common::*;
use localis_core::{
    check_size, CoreError, DocumentKind, ImportFile, ImportOutcome, JobState, NewFolder, Store,
    TextStatus, UnitKind, IMPORT_MAX_BYTES, SCHEMA_VERSION,
};

fn prepare<'a>(name: &str, bytes: &'a [u8]) -> Result<ImportFile<'a>, CoreError> {
    ImportFile::prepare(name, None, bytes)
}

fn sample_pdf() -> Vec<u8> {
    pdf(&[
        &text_page(&[b"Capitolo primo: analisi della citt\xe0", b"Seconda riga"]),
        DRAWING_PAGE,
        &text_page(&[b"Terza pagina con PERCH\xc9 maiuscolo"]),
    ])
}

// ------------------------------------------------------------------ migration

#[test]
fn migration_1_to_2_keeps_projects() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("localis.db");
    {
        // A v0.1 database, as created by migration 1.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (
                id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE UNIQUE INDEX projects_name_nocase ON projects (name COLLATE NOCASE);
             INSERT INTO projects VALUES
               ('p1', 'Tesi', 'note', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
               ('p2', 'Esame', NULL, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let projects = store.list_projects().unwrap();
    assert_eq!(projects.len(), 2);
    let tesi = projects.iter().find(|p| p.id == "p1").unwrap();
    assert_eq!(tesi.name, "Tesi");
    assert_eq!(tesi.description.as_deref(), Some("note"));
    assert_eq!(tesi.updated_at, "2026-01-02T00:00:00.000Z");
    // The new tables work with the old projects.
    store
        .create_folder(NewFolder {
            project_id: "p1".into(),
            parent_id: None,
            name: "Fonti".into(),
        })
        .unwrap();
    assert!(store.list_documents("p2").unwrap().is_empty());
    drop(store);
    // Reopening does not migrate again.
    assert_eq!(
        Store::open(&path).unwrap().list_projects().unwrap().len(),
        2
    );
}

#[test]
fn bundled_sqlite_has_fts5() {
    let env = Env::new();
    let enabled: bool = env
        .raw()
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(enabled);
}

// --------------------------------------------------------------------- import

#[test]
fn import_each_format() {
    let mut env = Env::new();
    let p = env.project("Tesi").id;
    type Case = (
        &'static str,
        Vec<u8>,
        DocumentKind,
        &'static str,
        Option<(u32, u32)>,
    );
    let cases: Vec<Case> = vec![
        (
            "articolo.pdf",
            sample_pdf(),
            DocumentKind::Pdf,
            "application/pdf",
            None,
        ),
        (
            "note.txt",
            b"uno\n\ndue".to_vec(),
            DocumentKind::Text,
            "text/plain",
            None,
        ),
        (
            "README.md",
            b"# Titolo".to_vec(),
            DocumentKind::Markdown,
            "text/markdown",
            None,
        ),
        (
            "appunti.markdown",
            b"*x*".to_vec(),
            DocumentKind::Markdown,
            "text/markdown",
            None,
        ),
        (
            "relazione.DOCX",
            docx(&["Ciao"]),
            DocumentKind::Docx,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            None,
        ),
        (
            "figura.png",
            png(640, 480),
            DocumentKind::Image,
            "image/png",
            Some((640, 480)),
        ),
        (
            "foto.jpg",
            jpeg(),
            DocumentKind::Image,
            "image/jpeg",
            Some((64, 32)),
        ),
        (
            "foto2.jpeg",
            {
                let mut j = jpeg();
                j.push(0);
                j
            },
            DocumentKind::Image,
            "image/jpeg",
            Some((64, 32)),
        ),
        (
            "anim.gif",
            gif(),
            DocumentKind::Image,
            "image/gif",
            Some((5, 7)),
        ),
        (
            "web.webp",
            webp(),
            DocumentKind::Image,
            "image/webp",
            Some((3, 2)),
        ),
    ];
    for (name, bytes, kind, media_type, size) in &cases {
        let doc = env.import(&p, name, bytes);
        let v = &doc.current;
        assert_eq!(doc.title, *name);
        assert_eq!(doc.folder_id, None);
        assert_eq!(doc.version_count, 1);
        assert_eq!(v.version_no, 1);
        assert_eq!(v.original_name, *name);
        assert_eq!(v.kind, *kind, "{name}");
        assert_eq!(v.media_type, *media_type);
        assert_eq!(v.size_bytes, bytes.len() as u64);
        assert_eq!(v.sha256, localis_core::sha256_hex(bytes));
        assert_eq!(
            v.source_modified_at.as_deref(),
            Some("2023-11-14T22:13:20.000Z")
        );
        assert_eq!(v.page_count, None);
        assert_eq!(v.image_width.zip(v.image_height), *size);
        let expected = if *kind == DocumentKind::Image {
            TextStatus::NotApplicable
        } else {
            TextStatus::Pending
        };
        assert_eq!(v.text_status, expected, "{name}");
        // Stored copy, byte for byte, at originals/<sha[0..2]>/<sha>.
        assert_eq!(std::fs::read(env.blob_path(&v.sha256)).unwrap(), *bytes);
        assert_eq!(env.store.read_original(&v.id).unwrap(), *bytes);
    }
    // One job per text-bearing version, none for images.
    assert_eq!(env.count("SELECT COUNT(*) FROM jobs"), 5);
    let docs = env.store.list_documents(&p).unwrap();
    assert_eq!(docs.len(), cases.len());
    // Sorted by title, case-insensitive.
    let titles: Vec<&str> = docs.iter().map(|d| d.title.as_str()).collect();
    let mut sorted = titles.clone();
    sorted.sort_by_key(|t| t.to_lowercase());
    assert_eq!(titles, sorted);
}

#[test]
fn rejected_files() {
    let unsupported = |name: &str, bytes: &[u8]| match prepare(name, bytes) {
        Err(CoreError::Unsupported { message }) => {
            assert!(message.starts_with("Formato non supportato"), "{message}")
        }
        other => panic!("{name}: expected unsupported, got {other:?}"),
    };
    unsupported("virus.exe", b"MZ\x90\x00");
    unsupported("senza_estensione", b"ciao");
    unsupported("finto.pdf", &png(1, 1));
    unsupported("finto.png", &jpeg());
    unsupported("finto.jpg", &png(1, 1));
    unsupported("finto.docx", &zip_with(&[("altro.xml", "<x/>")]));
    unsupported("finto.docx", b"PK\x03\x04 not really a zip");
    unsupported("binario.txt", b"\x00\x01\x02");
    unsupported("latin1.md", b"citt\xe0");
    unsupported("doc.txt", &sample_pdf());
    unsupported("rotta.png", b"\x89PNG\r\n\x1a\n");

    match prepare("vuoto.txt", b"") {
        Err(CoreError::Validation { field, message }) => {
            assert_eq!(field, "file");
            assert_eq!(message, "Il file è vuoto.");
        }
        other => panic!("expected validation, got {other:?}"),
    }
    for bad_name in ["", "  ", "a/b.txt", "..\\x.txt", "a\u{0}.txt"] {
        assert!(matches!(
            prepare(bad_name, b"x"),
            Err(CoreError::Validation { field: "file", .. })
        ));
    }
    // Over the limit: rejected before format detection or hashing.
    let big = vec![0u8; IMPORT_MAX_BYTES + 1];
    match prepare("grande.txt", &big) {
        Err(CoreError::TooLarge { message }) => {
            assert_eq!(message, "Il file supera il limite di 200 MB.")
        }
        other => panic!("expected too_large, got {other:?}"),
    }
    assert!(check_size(IMPORT_MAX_BYTES).is_ok());
}

#[test]
fn import_into_missing_project_or_foreign_folder() {
    let mut env = Env::new();
    let a = env.project("A").id;
    let b = env.project("B").id;
    let folder_b = env
        .store
        .create_folder(NewFolder {
            project_id: b.clone(),
            parent_id: None,
            name: "Cartella".into(),
        })
        .unwrap();
    let file = prepare("x.txt", b"x").unwrap();
    assert!(matches!(
        env.store.import_document("missing", None, &file),
        Err(CoreError::NotFound { .. })
    ));
    assert!(matches!(
        env.store.import_document(&a, Some(&folder_b.id), &file),
        Err(CoreError::Validation {
            field: "folderId",
            ..
        })
    ));
    assert!(matches!(
        env.store.import_document(&a, Some("missing"), &file),
        Err(CoreError::NotFound { .. })
    ));
    // Nothing was stored.
    assert!(env.blob_files().is_empty());
    // An empty folder id means the root.
    match env.store.import_document(&a, Some(""), &file).unwrap() {
        ImportOutcome::Imported(doc) => assert_eq!(doc.folder_id, None),
        other => panic!("{other:?}"),
    }
    match env
        .store
        .import_document(&b, Some(&folder_b.id), &file)
        .unwrap()
    {
        ImportOutcome::Imported(doc) => assert_eq!(doc.folder_id, Some(folder_b.id)),
        other => panic!("{other:?}"),
    }
}

#[test]
fn import_without_originals_dir_is_internal_error() {
    let mut store = Store::open_in_memory().unwrap();
    let p = store
        .create_project(localis_core::NewProject {
            name: "P".into(),
            description: None,
        })
        .unwrap();
    let file = prepare("x.txt", b"x").unwrap();
    assert!(matches!(
        store.import_document(&p.id, None, &file),
        Err(CoreError::Internal(_))
    ));
}

#[test]
fn duplicates_same_project_vs_other_project() {
    let mut env = Env::new();
    let a = env.project("A").id;
    let b = env.project("B").id;
    let bytes = b"stesso contenuto".to_vec();
    let first = env.import(&a, "uno.txt", &bytes);
    // Same bytes, different name, same project: duplicate, nothing new.
    match env.try_import(&a, None, "copia.txt", &bytes) {
        ImportOutcome::Duplicate(doc) => {
            assert_eq!(doc.id, first.id);
            assert_eq!(doc.title, "uno.txt");
        }
        other => panic!("expected duplicate, got {other:?}"),
    }
    assert_eq!(env.store.list_documents(&a).unwrap().len(), 1);
    assert_eq!(env.count("SELECT COUNT(*) FROM jobs"), 1);
    // Other project: imported, blob shared.
    let other = env.import(&b, "uno.txt", &bytes);
    assert_ne!(other.id, first.id);
    assert_eq!(other.current.sha256, first.current.sha256);
    assert_eq!(env.blob_files().len(), 1);
}

#[test]
fn versions_and_same_kind_rule() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "bozza.txt", b"prima versione alfa");
    let v2 = prepare("bozza-v2.txt", b"seconda versione beta").unwrap();
    let updated = env.store.import_version(&doc.id, &v2).unwrap();
    assert_eq!(updated.id, doc.id);
    assert_eq!(updated.title, "bozza.txt", "title stays the first name");
    assert_eq!(updated.version_count, 2);
    assert_eq!(updated.current.version_no, 2);
    assert_eq!(updated.current.original_name, "bozza-v2.txt");
    assert!(updated.updated_at >= doc.updated_at);
    // Markdown counts as a different kind from plain text.
    let md = prepare("bozza.md", b"terza").unwrap();
    match env.store.import_version(&doc.id, &md) {
        Err(CoreError::Validation { field, message }) => {
            assert_eq!(field, "file");
            assert_eq!(
                message,
                "La nuova versione deve essere dello stesso formato."
            );
        }
        other => panic!("expected validation, got {other:?}"),
    }
    // Same bytes as an existing version (even an old one): duplicate.
    let again = prepare("ancora.txt", b"prima versione alfa").unwrap();
    assert!(matches!(
        env.store.import_version(&doc.id, &again),
        Err(CoreError::Duplicate { field: "file", .. })
    ));
    assert!(matches!(
        env.store.import_version("missing", &again),
        Err(CoreError::NotFound { .. })
    ));
    let versions = env.store.list_versions(&doc.id).unwrap();
    assert_eq!(
        versions.iter().map(|v| v.version_no).collect::<Vec<_>>(),
        [2, 1]
    );
    assert_eq!(env.count("SELECT COUNT(*) FROM jobs"), 2);
    assert!(matches!(
        env.store.list_versions("missing"),
        Err(CoreError::NotFound { .. })
    ));
}

// ----------------------------------------------------------------- extraction

#[test]
fn pdf_extraction_per_page() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "a.pdf", &sample_pdf());
    assert_eq!(env.run_jobs(), 1);
    let v = env.store.get_version(&doc.current.id).unwrap();
    assert_eq!(v.text_status, TextStatus::Extracted);
    assert_eq!(v.page_count, Some(3));
    let text = env.store.get_text(&v.id).unwrap();
    // Page 2 has no text, so it has no unit.
    assert_eq!(text.iter().map(|u| u.unit).collect::<Vec<_>>(), [1, 3]);
    assert_eq!(
        text[0].text,
        "Capitolo primo: analisi della città\nSeconda riga"
    );
    assert_eq!(text[1].text, "Terza pagina con PERCHÉ maiuscolo");
    let job = &env.store.list_jobs(&p).unwrap()[0];
    assert_eq!(job.state, JobState::Done);
    assert_eq!(job.attempts, 1);
    assert_eq!(job.error, None);
}

#[test]
fn scanned_like_pdf_has_no_text() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "scansione.pdf", &pdf(&[DRAWING_PAGE, DRAWING_PAGE]));
    env.run_jobs();
    let v = env.store.get_version(&doc.current.id).unwrap();
    assert_eq!(v.text_status, TextStatus::NoText);
    assert_eq!(v.page_count, Some(2));
    assert!(env.store.get_text(&v.id).unwrap().is_empty());
    assert_eq!(env.store.list_jobs(&p).unwrap()[0].state, JobState::Done);
    // Still viewable.
    assert!(env.store.read_original(&v.id).is_ok());
}

#[test]
fn corrupt_pdf_fails_without_panicking() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let mut truncated = sample_pdf();
    truncated.truncate(40);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        (
            "rotto.pdf",
            b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> garbage".to_vec(),
        ),
        ("troncato.pdf", truncated),
        ("binario.pdf", {
            let mut b = b"%PDF-1.4\n".to_vec();
            b.extend((0..4096u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8));
            b
        }),
    ];
    for (name, bytes) in &cases {
        let doc = env.import(&p, name, bytes);
        env.run_jobs();
        let v = env.store.get_version(&doc.current.id).unwrap();
        assert_eq!(v.text_status, TextStatus::Failed, "{name}");
        let job = env
            .store
            .list_jobs(&p)
            .unwrap()
            .into_iter()
            .find(|j| j.version_id == v.id)
            .unwrap();
        assert_eq!(job.state, JobState::Failed);
        assert!(job.error.as_deref().unwrap().contains("PDF"), "{job:?}");
        assert!(!job.error_detail.as_deref().unwrap().is_empty());
    }
}

#[test]
fn text_markdown_docx_extraction() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let txt = env.import(
        &p,
        "a.txt",
        "Primo blocco\nstessa riga\r\n\r\n\r\nSecondo".as_bytes(),
    );
    let md = env.import(&p, "b.md", b"# Titolo\n\n- punto *uno*\n- punto due\n");
    let docx_doc = env.import(&p, "c.docx", &docx(&["Introduzione", "", "Uno\tdue & tre"]));
    let blank = env.import(&p, "vuoto.txt", b"  \n\n \t\n");
    let blank_docx = env.import(&p, "vuoto.docx", &docx(&["", "   "]));
    assert_eq!(env.run_jobs(), 5);

    let units = |env: &Env, id: &str| -> Vec<(u32, String)> {
        env.store
            .get_text(id)
            .unwrap()
            .into_iter()
            .map(|u| (u.unit, u.text))
            .collect()
    };
    assert_eq!(
        units(&env, &txt.current.id),
        [
            (1, "Primo blocco\nstessa riga".into()),
            (2, "Secondo".into())
        ]
    );
    assert_eq!(
        units(&env, &md.current.id),
        [
            (1, "# Titolo".into()),
            (2, "- punto *uno*\n- punto due".into())
        ]
    );
    assert_eq!(
        units(&env, &docx_doc.current.id),
        [(1, "Introduzione".into()), (2, "Uno\tdue & tre".into())]
    );
    for doc in [&txt, &md, &docx_doc] {
        assert_eq!(
            env.store.get_version(&doc.current.id).unwrap().text_status,
            TextStatus::Extracted
        );
    }
    for doc in [&blank, &blank_docx] {
        let v = env.store.get_version(&doc.current.id).unwrap();
        assert_eq!(v.text_status, TextStatus::NoText);
        assert_eq!(v.page_count, None);
    }
    assert!(matches!(
        env.store.get_text("missing"),
        Err(CoreError::NotFound { .. })
    ));
}

// ----------------------------------------------------------------------- jobs

#[test]
fn claim_is_atomic_and_in_order() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let a = env.import(&p, "a.txt", b"a");
    let b = env.import(&p, "b.txt", b"b");
    let first = env.store.claim_next_job().unwrap().unwrap();
    assert_eq!(first.version_id, a.current.id);
    // A second connection (like the worker's) sees it running and gets the next one.
    let mut other = env.reopen();
    let second = other.claim_next_job().unwrap().unwrap();
    assert_eq!(second.version_id, b.current.id);
    assert!(other.claim_next_job().unwrap().is_none());
    let jobs = env.store.list_jobs(&p).unwrap();
    assert!(jobs
        .iter()
        .all(|j| j.state == JobState::Running && j.attempts == 1));
    // Newest first.
    assert!(jobs[0].id > jobs[1].id);
}

#[test]
fn running_jobs_are_requeued_on_startup() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "a.txt", b"testo da estrarre");
    env.store.claim_next_job().unwrap().unwrap();
    // Simulated crash: the claim is never finished.
    let mut restarted = env.reopen();
    assert_eq!(restarted.requeue_interrupted_jobs().unwrap(), 1);
    let job = &restarted.list_jobs(&p).unwrap()[0];
    assert_eq!(job.state, JobState::Queued);
    assert!(restarted.run_next_job(TIMEOUT).unwrap());
    let job = &restarted.list_jobs(&p).unwrap()[0];
    assert_eq!(job.state, JobState::Done);
    assert_eq!(job.attempts, 2);
    assert_eq!(
        restarted.get_version(&doc.current.id).unwrap().text_status,
        TextStatus::Extracted
    );
}

#[test]
fn retry_job_rules() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "rotto.pdf", b"%PDF-1.4 nothing else");
    env.run_jobs();
    let failed = env.store.list_jobs(&p).unwrap().remove(0);
    assert_eq!(failed.state, JobState::Failed);
    assert_eq!(failed.document_id, doc.id);
    assert_eq!(failed.kind, "extract_text");

    let retried = env.store.retry_job(failed.id).unwrap();
    assert_eq!(retried.state, JobState::Queued);
    assert_eq!(retried.error, None);
    assert_eq!(retried.error_detail, None);
    assert_eq!(retried.attempts, 1);
    assert_eq!(
        env.store.get_version(&doc.current.id).unwrap().text_status,
        TextStatus::Pending
    );
    // Only failed jobs can be retried.
    match env.store.retry_job(failed.id) {
        Err(CoreError::Conflict { message }) => {
            assert_eq!(
                message,
                "Si possono ripetere solo le attività non riuscite."
            )
        }
        other => panic!("expected conflict, got {other:?}"),
    }
    assert!(matches!(
        env.store.retry_job(9999),
        Err(CoreError::NotFound { .. })
    ));
    env.run_jobs();
    let again = env.store.get_job(failed.id).unwrap();
    assert_eq!(again.state, JobState::Failed);
    assert_eq!(again.attempts, 2);
}

#[test]
fn finished_job_of_deleted_document_is_discarded() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "a.txt", b"contenuto");
    let mut worker = env.reopen();
    let job = worker.claim_next_job().unwrap().unwrap();
    env.store.delete_document(&doc.id).unwrap();
    worker
        .finish_job(
            &job,
            &Ok(localis_core::extract::Extracted {
                units: vec![(1, "contenuto".into())],
                page_count: None,
            }),
        )
        .unwrap();
    assert_eq!(env.count("SELECT COUNT(*) FROM document_text"), 0);
    assert_eq!(env.count("SELECT COUNT(*) FROM jobs"), 0);
}

#[test]
fn missing_blob_fails_the_job_with_integrity_message() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "a.txt", b"contenuto");
    std::fs::remove_file(env.blob_path(&doc.current.sha256)).unwrap();
    env.run_jobs();
    let job = &env.store.list_jobs(&p).unwrap()[0];
    assert_eq!(job.state, JobState::Failed);
    assert_eq!(
        job.error.as_deref(),
        Some("Il file originale non si trova nell'archivio di Localis.")
    );
}

#[test]
fn background_worker_runs_jobs_when_woken() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let db = env.db_path();
    let (wake, rx) = std::sync::mpsc::sync_channel::<()>(1);
    let worker = std::thread::spawn(move || {
        localis_core::run_worker(
            || Store::open(&db),
            rx,
            localis_core::WorkerConfig {
                poll_interval: std::time::Duration::from_secs(60),
                extract_timeout: TIMEOUT,
            },
        )
    });
    let doc = env.import(&p, "a.md", b"# Ciao\n\nmondo");
    let _ = wake.try_send(());
    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        let status = env.store.get_version(&doc.current.id).unwrap().text_status;
        if status == TextStatus::Extracted {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "worker did not run the job"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    drop(wake);
    worker.join().unwrap();
}

// --------------------------------------------------------------------- search

fn search_env() -> (Env, String, String) {
    let mut env = Env::new();
    let p = env.project("P").id;
    let other = env.project("Altro").id;
    env.import(&p, "a.pdf", &sample_pdf());
    env.import(
        &p,
        "b.txt",
        "La CITTÀ eterna.\n\nUn'analisi \"tra virgolette\" AND NEAR(x) e altro.".as_bytes(),
    );
    env.import(&other, "c.txt", b"citta in un altro progetto");
    env.run_jobs();
    (env, p, other)
}

#[test]
fn search_ignores_accents_and_case_and_matches_prefixes() {
    let (env, p, _) = search_env();
    let hits = env.store.search(&p, "citta", None).unwrap();
    let mut found: Vec<(String, u32)> = hits.iter().map(|h| (h.title.clone(), h.unit)).collect();
    found.sort();
    assert_eq!(found, [("a.pdf".into(), 1), ("b.txt".into(), 1)]);
    let pdf_hit = hits.iter().find(|h| h.title == "a.pdf").unwrap();
    assert_eq!(pdf_hit.unit_kind, UnitKind::Page);
    assert!(
        pdf_hit.snippet.contains("\u{2}città\u{3}"),
        "{:?}",
        pdf_hit.snippet
    );
    let txt_hit = hits.iter().find(|h| h.title == "b.txt").unwrap();
    assert_eq!(txt_hit.unit_kind, UnitKind::Block);
    assert!(
        txt_hit.snippet.contains("\u{2}CITTÀ\u{3}"),
        "{:?}",
        txt_hit.snippet
    );

    // Accented query, prefix on the last word, AND between words.
    assert_eq!(env.store.search(&p, "perché", None).unwrap()[0].unit, 3);
    assert_eq!(env.store.search(&p, "anal", None).unwrap().len(), 2);
    assert_eq!(env.store.search(&p, "analisi citt", None).unwrap().len(), 1);
    assert!(env
        .store
        .search(&p, "analisi inesistente", None)
        .unwrap()
        .is_empty());
    // Prefix applies only to the last word.
    assert!(env.store.search(&p, "anal citta", None).unwrap().is_empty());
}

#[test]
fn search_input_is_never_fts_syntax() {
    let (env, p, _) = search_env();
    for query in [
        "\"",
        "\"\"",
        "virgolette\"",
        "AND",
        "OR NOT",
        "NEAR(x",
        "*",
        "a*b",
        "-citta",
        "col:citta",
        "^citta",
        "(citta",
        "citta)",
        "{a b}",
        "'; DROP TABLE documents; --",
        "\u{0}\u{2}\u{3}",
    ] {
        if let Err(err) = env.store.search(&p, query, None) {
            panic!("{query:?} failed: {err:?}");
        }
    }
    // Operator words are searched as plain words.
    assert_eq!(env.store.search(&p, "AND NEAR", None).unwrap().len(), 1);
    assert_eq!(
        env.store.search(&p, "\"virgolette\"", None).unwrap().len(),
        1
    );
    assert!(env.store.search(&p, "", None).unwrap().is_empty());
    assert!(env.store.search(&p, "  ;; ", None).unwrap().is_empty());
}

#[test]
fn search_is_scoped_to_project_and_limited() {
    let (env, p, other) = search_env();
    let hits = env.store.search(&other, "citta", None).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "c.txt");
    assert_eq!(env.store.search(&p, "citta", Some(1)).unwrap().len(), 1);
    assert_eq!(env.store.search(&p, "citta", Some(0)).unwrap().len(), 1);
    assert_eq!(
        env.store.search(&p, "citta", Some(10_000)).unwrap().len(),
        2
    );
    assert!(matches!(
        env.store.search("missing", "citta", None),
        Err(CoreError::NotFound { .. })
    ));
}

#[test]
fn search_only_current_version() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "v.txt", b"parola alfa");
    env.run_jobs();
    assert_eq!(env.store.search(&p, "alfa", None).unwrap().len(), 1);
    env.store
        .import_version(&doc.id, &prepare("v.txt", b"parola beta").unwrap())
        .unwrap();
    env.run_jobs();
    assert!(env.store.search(&p, "alfa", None).unwrap().is_empty());
    let hits = env.store.search(&p, "parola", None).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].document_id, doc.id);
    assert_ne!(hits[0].version_id, doc.current.id);
    // The old version keeps its text.
    assert_eq!(
        env.store.get_text(&doc.current.id).unwrap()[0].text,
        "parola alfa"
    );
}

// -------------------------------------------------------------------- folders

#[test]
fn folder_rules() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let q = env.project("Q").id;
    let new = |project: &str, parent: Option<&str>, name: &str| NewFolder {
        project_id: project.into(),
        parent_id: parent.map(Into::into),
        name: name.into(),
    };
    let fonti = env.store.create_folder(new(&p, None, "  Fonti ")).unwrap();
    assert_eq!(fonti.name, "Fonti");
    assert_eq!(fonti.parent_id, None);
    let articoli = env
        .store
        .create_folder(new(&p, Some(&fonti.id), "Articoli"))
        .unwrap();
    assert_eq!(articoli.parent_id.as_deref(), Some(fonti.id.as_str()));
    // Unique among siblings, case-insensitive (Unicode).
    assert!(matches!(
        env.store.create_folder(new(&p, None, "FONTI")),
        Err(CoreError::Duplicate { field: "name", .. })
    ));
    assert!(matches!(
        env.store
            .create_folder(new(&p, Some(&fonti.id), "articoli")),
        Err(CoreError::Duplicate { field: "name", .. })
    ));
    // Same name under another parent or in another project is fine.
    env.store
        .create_folder(new(&p, Some(&fonti.id), "Fonti"))
        .unwrap();
    env.store.create_folder(new(&q, None, "Fonti")).unwrap();
    // Validation as for project names.
    assert!(matches!(
        env.store.create_folder(new(&p, None, "  ")),
        Err(CoreError::Validation { field: "name", .. })
    ));
    assert!(matches!(
        env.store.create_folder(new(&p, None, &"x".repeat(121))),
        Err(CoreError::Validation { field: "name", .. })
    ));
    // Parent from another project / missing / missing project.
    assert!(matches!(
        env.store.create_folder(new(&q, Some(&fonti.id), "X")),
        Err(CoreError::Validation {
            field: "parentId",
            ..
        })
    ));
    assert!(matches!(
        env.store.create_folder(new(&p, Some("missing"), "X")),
        Err(CoreError::NotFound { .. })
    ));
    assert!(matches!(
        env.store.create_folder(new("missing", None, "X")),
        Err(CoreError::NotFound { .. })
    ));
    // Rename.
    let zeta = env.store.create_folder(new(&p, None, "zeta")).unwrap();
    assert!(matches!(
        env.store.rename_folder(&zeta.id, "fonti"),
        Err(CoreError::Duplicate { .. })
    ));
    let renamed = env.store.rename_folder(&zeta.id, "Bozze").unwrap();
    assert_eq!(renamed.name, "Bozze");
    assert_eq!(renamed.parent_id, None);
    env.store.rename_folder(&zeta.id, "BOZZE").unwrap(); // itself: allowed
    assert!(matches!(
        env.store.rename_folder("missing", "X"),
        Err(CoreError::NotFound { .. })
    ));
    // Listing sorted by name, case-insensitive.
    let names: Vec<String> = env
        .store
        .list_folders(&p)
        .unwrap()
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(names, ["Articoli", "BOZZE", "Fonti", "Fonti"]);

    // Delete only when empty.
    match env.store.delete_folder(&fonti.id) {
        Err(CoreError::Conflict { message }) => assert_eq!(message, "La cartella non è vuota."),
        other => panic!("expected conflict, got {other:?}"),
    }
    let doc = match env.try_import(&p, Some(&articoli.id), "a.txt", b"a") {
        ImportOutcome::Imported(doc) => doc,
        other => panic!("{other:?}"),
    };
    assert!(matches!(
        env.store.delete_folder(&articoli.id),
        Err(CoreError::Conflict { .. })
    ));
    // Move: to another folder, to root, not to another project's folder.
    let q_folder = env.store.list_folders(&q).unwrap().remove(0);
    assert!(matches!(
        env.store.move_document(&doc.id, Some(&q_folder.id)),
        Err(CoreError::Validation {
            field: "folderId",
            ..
        })
    ));
    assert!(matches!(
        env.store.move_document(&doc.id, Some("missing")),
        Err(CoreError::NotFound { .. })
    ));
    assert!(matches!(
        env.store.move_document("missing", None),
        Err(CoreError::NotFound { .. })
    ));
    let moved = env.store.move_document(&doc.id, Some(&zeta.id)).unwrap();
    assert_eq!(moved.folder_id.as_deref(), Some(zeta.id.as_str()));
    let moved = env.store.move_document(&doc.id, None).unwrap();
    assert_eq!(moved.folder_id, None);
    env.store.delete_folder(&articoli.id).unwrap();
    assert!(matches!(
        env.store.delete_folder(&articoli.id),
        Err(CoreError::NotFound { .. })
    ));
    assert!(matches!(
        env.store.list_folders("missing"),
        Err(CoreError::NotFound { .. })
    ));
}

// ------------------------------------------------------------------ deletions

#[test]
fn delete_document_removes_rows_and_unreferenced_blobs_only() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let q = env.project("Q").id;
    // Files Localis must never touch: in the data dir, in originals/, in a shard dir.
    let doc = env.import(&p, "a.txt", b"testo condiviso");
    let solo = env.import(&p, "b.txt", b"testo solo qui");
    env.store
        .import_version(&solo.id, &prepare("b2.txt", b"testo solo qui v2").unwrap())
        .unwrap();
    env.import(&q, "a.txt", b"testo condiviso");
    env.run_jobs();
    let shard = env
        .blob_path(&solo.current.sha256)
        .parent()
        .unwrap()
        .to_path_buf();
    let sentinels = [
        env.dir.path().join("utente.txt"),
        env.originals().join("leggimi.txt"),
        shard.join("non-un-hash"),
    ];
    for s in &sentinels {
        std::fs::write(s, b"non toccare").unwrap();
    }

    env.store.delete_document(&solo.id).unwrap();
    assert!(matches!(
        env.store.delete_document(&solo.id),
        Err(CoreError::NotFound { .. })
    ));
    assert_eq!(env.count("SELECT COUNT(*) FROM document_versions"), 2);
    assert_eq!(env.count("SELECT COUNT(*) FROM jobs"), 2);
    assert_eq!(env.count("SELECT COUNT(*) FROM document_text"), 2);
    assert!(env.store.search(&p, "solo", None).unwrap().is_empty());
    // FTS index consistent with its content table.
    env.raw()
        .execute(
            "INSERT INTO document_text_fts (document_text_fts) VALUES ('integrity-check')",
            [],
        )
        .unwrap();
    // Both blobs of the deleted document are gone; the shared one stays.
    assert!(!env.blob_path(&solo.current.sha256).exists());
    assert!(!env
        .blob_path(&localis_core::sha256_hex(b"testo solo qui v2"))
        .exists());
    assert!(env.blob_path(&doc.current.sha256).exists());

    // Deleting one of two documents sharing a blob keeps the blob.
    env.store.delete_document(&doc.id).unwrap();
    assert!(env.blob_path(&doc.current.sha256).exists());
    assert_eq!(env.store.search(&q, "condiviso", None).unwrap().len(), 1);
    for s in &sentinels {
        assert_eq!(std::fs::read(s).unwrap(), b"non toccare", "{}", s.display());
    }
}

#[test]
fn delete_project_cascades_and_collects_blobs() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let q = env.project("Q").id;
    let parent = env
        .store
        .create_folder(NewFolder {
            project_id: p.clone(),
            parent_id: None,
            name: "A".into(),
        })
        .unwrap();
    let child = env
        .store
        .create_folder(NewFolder {
            project_id: p.clone(),
            parent_id: Some(parent.id.clone()),
            name: "B".into(),
        })
        .unwrap();
    env.try_import(&p, Some(&child.id), "x.pdf", &sample_pdf());
    env.import(&p, "shared.txt", b"condiviso fra progetti");
    env.import(&p, "img.png", &png(2, 2));
    env.import(&q, "shared.txt", b"condiviso fra progetti");
    env.run_jobs();
    let sentinel = env.dir.path().join("utente.pdf");
    std::fs::write(&sentinel, sample_pdf()).unwrap();

    env.store.delete_project(&p).unwrap();
    assert_eq!(env.count("SELECT COUNT(*) FROM folders"), 0);
    assert_eq!(env.count("SELECT COUNT(*) FROM documents"), 1);
    assert_eq!(env.count("SELECT COUNT(*) FROM document_versions"), 1);
    assert_eq!(env.count("SELECT COUNT(*) FROM jobs"), 1);
    assert_eq!(env.count("SELECT COUNT(*) FROM document_text"), 1);
    assert_eq!(
        env.blob_files(),
        [format!(
            "{}/{}",
            &localis_core::sha256_hex(b"condiviso fra progetti")[..2],
            localis_core::sha256_hex(b"condiviso fra progetti")
        )]
    );
    assert!(sentinel.exists());
    assert!(matches!(
        env.store.delete_project(&p),
        Err(CoreError::NotFound { .. })
    ));
    env.store.delete_project(&q).unwrap();
    assert!(env.blob_files().is_empty());
}

// ------------------------------------------------------------------ integrity

#[test]
fn read_original_checks_integrity() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "a.png", &png(4, 4));
    let path = env.blob_path(&doc.current.sha256);
    assert_eq!(env.store.read_original(&doc.current.id).unwrap(), png(4, 4));

    std::fs::write(&path, png(4, 5)).unwrap();
    match env.store.read_original(&doc.current.id) {
        Err(CoreError::Integrity { message, detail }) => {
            assert_eq!(message, "Il file originale nell'archivio risulta alterato.");
            assert!(detail.contains(&doc.current.sha256));
        }
        other => panic!("expected integrity error, got {other:?}"),
    }
    std::fs::remove_file(&path).unwrap();
    match env.store.read_original(&doc.current.id) {
        Err(CoreError::Integrity { message, .. }) => {
            assert_eq!(
                message,
                "Il file originale non si trova nell'archivio di Localis."
            )
        }
        other => panic!("expected integrity error, got {other:?}"),
    }
    assert!(matches!(
        env.store.read_original("missing"),
        Err(CoreError::NotFound { .. })
    ));
    // Importing the same bytes again in another project repairs the archive copy.
    let q = env.project("Q").id;
    env.import(&q, "a.png", &png(4, 4));
    assert_eq!(env.store.read_original(&doc.current.id).unwrap(), png(4, 4));
}

#[test]
fn interrupted_write_leftovers_are_swept() {
    let mut env = Env::new();
    let p = env.project("P").id;
    let doc = env.import(&p, "a.txt", b"a");
    let shard = env
        .blob_path(&doc.current.sha256)
        .parent()
        .unwrap()
        .to_path_buf();
    std::fs::write(shard.join(".tmp-interrupted"), b"partial").unwrap();
    std::fs::write(shard.join("keep.txt"), b"other").unwrap();
    env.store.sweep_temp_files();
    assert!(!shard.join(".tmp-interrupted").exists());
    assert!(shard.join("keep.txt").exists());
    assert!(env.blob_path(&doc.current.sha256).exists());
}
