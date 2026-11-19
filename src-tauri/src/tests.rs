//! Tests for the error mapping and the JSON contract with `src/api/types.ts`.
//! JSON is produced through Tauri's own IPC serialization (the same path used for
//! command responses), so no extra dev-dependency is needed.

use localis_core::{CoreError, NewProject, Store};
use serde::de::value::{Error as DeError, MapDeserializer};
use serde::Deserialize;
use tauri::ipc::{InvokeResponseBody, IpcResponse};

use crate::commands::{AppState, NewProjectInput, ProjectDto};
use crate::error::{AppError, ErrorCode};

fn to_json<T: serde::Serialize>(value: T) -> String {
    match value.body().unwrap() {
        InvokeResponseBody::Json(json) => json,
        InvokeResponseBody::Raw(_) => panic!("expected JSON body"),
    }
}

#[test]
fn validation_error_mapping() {
    let mut store = Store::open_in_memory().unwrap();
    let err: AppError = store
        .create_project(NewProject {
            name: "   ".into(),
            description: None,
        })
        .unwrap_err()
        .into();
    assert_eq!(err.code, ErrorCode::Validation);
    assert_eq!(err.message, "Inserisci un nome.");
    assert_eq!(err.field.as_deref(), Some("name"));
    assert_eq!(err.detail, None);
    assert_eq!(
        to_json(err),
        r#"{"code":"validation","message":"Inserisci un nome.","field":"name"}"#
    );
}

#[test]
fn duplicate_error_mapping() {
    let mut store = Store::open_in_memory().unwrap();
    let input = || NewProject {
        name: "Tesi".into(),
        description: None,
    };
    store.create_project(input()).unwrap();
    let err: AppError = store.create_project(input()).unwrap_err().into();
    assert_eq!(err.code, ErrorCode::Duplicate);
    assert_eq!(err.field.as_deref(), Some("name"));
    assert_eq!(
        to_json(err),
        r#"{"code":"duplicate","message":"Esiste già un progetto con questo nome.","field":"name"}"#
    );
}

#[test]
fn not_found_error_mapping() {
    let mut store = Store::open_in_memory().unwrap();
    let err: AppError = store.delete_project("missing").unwrap_err().into();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.field, None);
    assert_eq!(err.detail, None);
    assert_eq!(
        to_json(err),
        r#"{"code":"not_found","message":"Il progetto non esiste più."}"#
    );
}

#[test]
fn storage_error_keeps_detail_out_of_message() {
    // A real storage failure: a file that is not a SQLite database.
    let dir = tempdir();
    let path = dir.join("localis.db");
    std::fs::write(
        &path,
        b"synthetic bytes, definitely not a sqlite database file",
    )
    .unwrap();
    let err: AppError = Store::open(&path).unwrap_err().into();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(err.code, ErrorCode::Storage);
    assert_eq!(err.message, "Impossibile aprire il database.");
    assert_eq!(err.field, None);
    let detail = err.detail.clone().unwrap();
    assert!(!detail.is_empty());
    assert!(!err.message.contains(&detail));
    let json = to_json(err);
    assert!(
        json.starts_with(
            r#"{"code":"storage","message":"Impossibile aprire il database.","detail":"#
        ),
        "{json}"
    );
}

#[test]
fn internal_error_mapping() {
    let err: AppError = CoreError::Internal("boom".into()).into();
    assert_eq!(err.code, ErrorCode::Internal);
    assert_eq!(err.message, "Si è verificato un errore imprevisto.");
    assert_eq!(err.detail.as_deref(), Some("boom"));
    assert_eq!(
        to_json(err),
        r#"{"code":"internal","message":"Si è verificato un errore imprevisto.","detail":"boom"}"#
    );
}

#[test]
fn project_dto_is_camel_case_with_nullable_description() {
    let dto = ProjectDto {
        id: "id-1".into(),
        name: "Tesi".into(),
        description: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-02T00:00:00.000Z".into(),
    };
    assert_eq!(
        to_json(dto.clone()),
        r#"{"id":"id-1","name":"Tesi","description":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-02T00:00:00.000Z"}"#
    );
    let with_description = ProjectDto {
        description: Some("note".into()),
        ..dto
    };
    assert!(to_json(with_description).contains(r#""description":"note""#));
}

#[test]
fn new_project_input_description_is_optional() {
    let input = NewProjectInput::deserialize(MapDeserializer::<_, DeError>::new(
        [("name", "Tesi")].into_iter(),
    ))
    .unwrap();
    assert_eq!(
        input,
        NewProjectInput {
            name: "Tesi".into(),
            description: None
        }
    );
    // A present description is not exercised here: serde's value deserializer cannot
    // turn a plain string into `Some`, and serde_json is not a dev-dependency.
}

#[test]
fn failed_open_is_reported_and_retried() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let open_err: AppError = CoreError::Storage {
        message: "Impossibile aprire il database.".into(),
        detail: "synthetic failure".into(),
    }
    .into();
    // Fails on the first two attempts (startup + first command), then succeeds.
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&attempts);
    let err = open_err.clone();
    let state = AppState::new(move || {
        if counter.fetch_add(1, Ordering::SeqCst) < 2 {
            Err(err.clone())
        } else {
            Ok(Store::open_in_memory().unwrap())
        }
    });
    assert_eq!(
        state.with_store(|s| Ok(s.list_projects()?)).unwrap_err(),
        open_err
    );
    assert!(state
        .with_store(|s| Ok(s.list_projects()?))
        .unwrap()
        .is_empty());
    // Once open, the store is reused rather than reopened.
    state.with_store(|s| Ok(s.list_projects()?)).unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
}

/// Unique temporary directory (std only: tempfile is not a dependency of this crate).
fn tempdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "localis-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ---------------------------------------------------------------- v0.2 Library

mod library {
    use localis_core::{CoreError, ImportFile, ImportOutcome, NewFolder, NewProject, Store};
    use tauri::http::{HeaderMap, HeaderName, HeaderValue};
    use tauri::ipc::InvokeBody;

    use super::{tempdir, to_json};
    use crate::commands::{
        DocumentVersionDto, FolderDto, ImportResultDto, JobDto, LibraryDocumentDto, SearchHitDto,
        TextUnitDto,
    };
    use crate::error::{AppError, ErrorCode};
    use crate::headers::{percent_decode, raw_body, ImportHeaders, VersionHeaders};

    fn headers(pairs: &[(&'static str, &[u8])]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_static(name),
                HeaderValue::from_bytes(value).unwrap(),
            );
        }
        map
    }

    fn version() -> DocumentVersionDto {
        DocumentVersionDto {
            id: "v1".into(),
            document_id: "d1".into(),
            version_no: 1,
            original_name: "a.pdf".into(),
            kind: "pdf",
            media_type: "application/pdf".into(),
            size_bytes: 1234,
            sha256: "ab".into(),
            source_modified_at: None,
            imported_at: "2026-01-01T00:00:00.000Z".into(),
            text_status: "no_text",
            page_count: Some(2),
            image_width: None,
            image_height: None,
        }
    }

    fn document() -> LibraryDocumentDto {
        LibraryDocumentDto {
            id: "d1".into(),
            project_id: "p1".into(),
            folder_id: None,
            title: "a.pdf".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            current: version(),
            version_count: 1,
        }
    }

    #[test]
    fn new_error_codes_are_snake_case() {
        let cases = [
            (
                CoreError::Conflict {
                    message: "La cartella non è vuota.".into(),
                },
                r#"{"code":"conflict","message":"La cartella non è vuota."}"#,
            ),
            (
                CoreError::Unsupported {
                    message: "Formato non supportato: .exe".into(),
                },
                r#"{"code":"unsupported","message":"Formato non supportato: .exe"}"#,
            ),
            (
                CoreError::TooLarge {
                    message: "Il file supera il limite di 200 MB.".into(),
                },
                r#"{"code":"too_large","message":"Il file supera il limite di 200 MB."}"#,
            ),
            (
                CoreError::Integrity {
                    message: "Il file originale nell'archivio risulta alterato.".into(),
                    detail: "hash mismatch".into(),
                },
                r#"{"code":"integrity","message":"Il file originale nell'archivio risulta alterato.","detail":"hash mismatch"}"#,
            ),
        ];
        for (core, json) in cases {
            assert_eq!(to_json(AppError::from(core)), json);
        }
        let err: AppError = CoreError::Duplicate {
            field: "file",
            message: "Questa versione è già presente nel documento.".into(),
        }
        .into();
        assert_eq!(err.code, ErrorCode::Duplicate);
        assert_eq!(err.field.as_deref(), Some("file"));
    }

    #[test]
    fn real_core_errors_map_to_codes() {
        let dir = tempdir();
        let mut store = Store::open(&dir.join("localis.db")).unwrap();
        let p = store
            .create_project(NewProject {
                name: "P".into(),
                description: None,
            })
            .unwrap();
        let parent = store
            .create_folder(NewFolder {
                project_id: p.id.clone(),
                parent_id: None,
                name: "A".into(),
            })
            .unwrap();
        store
            .create_folder(NewFolder {
                project_id: p.id.clone(),
                parent_id: Some(parent.id.clone()),
                name: "B".into(),
            })
            .unwrap();
        let conflict: AppError = store.delete_folder(&parent.id).unwrap_err().into();
        assert_eq!(conflict.code, ErrorCode::Conflict);
        let unsupported: AppError = ImportFile::prepare("x.exe", None, b"MZ")
            .unwrap_err()
            .into();
        assert_eq!(unsupported.code, ErrorCode::Unsupported);
        let empty: AppError = ImportFile::prepare("x.txt", None, b"").unwrap_err().into();
        assert_eq!(empty.code, ErrorCode::Validation);
        assert_eq!(empty.field.as_deref(), Some("file"));

        let file = ImportFile::prepare("x.txt", None, b"contenuto").unwrap();
        let ImportOutcome::Imported(doc) = store.import_document(&p.id, None, &file).unwrap()
        else {
            panic!("expected import");
        };
        let blob = dir
            .join("originals")
            .join(&doc.current.sha256[..2])
            .join(&doc.current.sha256);
        std::fs::remove_file(blob).unwrap();
        let integrity: AppError = store.read_original(&doc.current.id).unwrap_err().into();
        assert_eq!(integrity.code, ErrorCode::Integrity);
        assert!(integrity.detail.is_some());
        let not_found: AppError = store.retry_job(424242).unwrap_err().into();
        assert_eq!(not_found.code, ErrorCode::NotFound);
        drop(store);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn document_dto_json_shape() {
        assert_eq!(
            to_json(document()),
            concat!(
                r#"{"id":"d1","projectId":"p1","folderId":null,"title":"a.pdf","#,
                r#""createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","#,
                r#""current":{"id":"v1","documentId":"d1","versionNo":1,"originalName":"a.pdf","#,
                r#""kind":"pdf","mediaType":"application/pdf","sizeBytes":1234,"sha256":"ab","#,
                r#""sourceModifiedAt":null,"importedAt":"2026-01-01T00:00:00.000Z","#,
                r#""textStatus":"no_text","pageCount":2,"imageWidth":null,"imageHeight":null},"#,
                r#""versionCount":1}"#
            )
        );
    }

    #[test]
    fn import_result_is_tagged_by_status() {
        let imported = to_json(ImportResultDto::Imported {
            document: document(),
        });
        assert!(imported.starts_with(r#"{"status":"imported","document":{"id":"d1","#));
        let duplicate = to_json(ImportResultDto::Duplicate {
            document: document(),
        });
        assert!(duplicate.starts_with(r#"{"status":"duplicate","document":{"id":"d1","#));
    }

    #[test]
    fn other_dto_json_shapes() {
        assert_eq!(
            to_json(FolderDto {
                id: "f1".into(),
                project_id: "p1".into(),
                parent_id: Some("f0".into()),
                name: "Fonti".into(),
                created_at: "c".into(),
                updated_at: "u".into(),
            }),
            r#"{"id":"f1","projectId":"p1","parentId":"f0","name":"Fonti","createdAt":"c","updatedAt":"u"}"#
        );
        assert_eq!(
            to_json(TextUnitDto {
                unit: 3,
                text: "testo".into()
            }),
            r#"{"unit":3,"text":"testo"}"#
        );
        assert_eq!(
            to_json(SearchHitDto {
                document_id: "d1".into(),
                version_id: "v1".into(),
                title: "a.pdf".into(),
                folder_id: None,
                unit: 2,
                unit_kind: "page",
                snippet: "\u{2}città\u{3} eterna".into(),
            }),
            r#"{"documentId":"d1","versionId":"v1","title":"a.pdf","folderId":null,"unit":2,"unitKind":"page","snippet":"\u0002città\u0003 eterna"}"#
        );
        assert_eq!(
            to_json(JobDto {
                id: 7,
                document_id: "d1".into(),
                version_id: "v1".into(),
                kind: "extract_text".into(),
                state: "failed",
                attempts: 1,
                error: Some("Il PDF non può essere letto.".into()),
                error_detail: Some("xref".into()),
                created_at: "c".into(),
                updated_at: "u".into(),
            }),
            r#"{"id":7,"documentId":"d1","versionId":"v1","kind":"extract_text","state":"failed","attempts":1,"error":"Il PDF non può essere letto.","errorDetail":"xref","createdAt":"c","updatedAt":"u"}"#
        );
    }

    #[test]
    fn dto_strings_match_core_enums() {
        use localis_core::{DocumentKind, JobState, TextStatus, UnitKind};
        let kinds: Vec<&str> = [
            DocumentKind::Pdf,
            DocumentKind::Text,
            DocumentKind::Markdown,
            DocumentKind::Docx,
            DocumentKind::Image,
        ]
        .map(DocumentKind::as_str)
        .to_vec();
        assert_eq!(kinds, ["pdf", "text", "markdown", "docx", "image"]);
        let statuses = [
            TextStatus::Pending,
            TextStatus::Extracted,
            TextStatus::NoText,
            TextStatus::Failed,
            TextStatus::NotApplicable,
        ]
        .map(TextStatus::as_str);
        assert_eq!(
            statuses,
            [
                "pending",
                "extracted",
                "no_text",
                "failed",
                "not_applicable"
            ]
        );
        let states = [
            JobState::Queued,
            JobState::Running,
            JobState::Done,
            JobState::Failed,
        ]
        .map(JobState::as_str);
        assert_eq!(states, ["queued", "running", "done", "failed"]);
        assert_eq!(UnitKind::Page.as_str(), "page");
        assert_eq!(UnitKind::Block.as_str(), "block");
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(
            percent_decode("tesi%20finale.pdf").unwrap(),
            "tesi finale.pdf"
        );
        assert_eq!(percent_decode("citt%C3%A0.txt").unwrap(), "città.txt");
        assert_eq!(percent_decode("a+b%2Bc").unwrap(), "a+b+c");
        assert_eq!(percent_decode("%e2%82%ac").unwrap(), "€");
        assert!(percent_decode("bad%").is_err());
        assert!(percent_decode("bad%2").is_err());
        assert!(percent_decode("bad%zz").is_err());
        assert!(percent_decode("%C3").is_err(), "truncated UTF-8");
        assert!(percent_decode("%FF%FE").is_err(), "invalid UTF-8");
    }

    #[test]
    fn import_headers_parse() {
        let parsed = ImportHeaders::parse(&headers(&[
            ("x-project-id", b"3f2c1a9e-0000-4000-8000-000000000001"),
            ("x-folder-id", b""),
            (
                "x-file-name",
                b"Relazione%20finale%20%E2%80%94%20citt%C3%A0.pdf",
            ),
            ("x-last-modified", b"1700000000123"),
        ]))
        .unwrap();
        assert_eq!(
            parsed,
            ImportHeaders {
                project_id: "3f2c1a9e-0000-4000-8000-000000000001".into(),
                folder_id: None,
                file_name: "Relazione finale — città.pdf".into(),
                last_modified: Some(1_700_000_000_123),
            }
        );
        let with_folder = ImportHeaders::parse(&headers(&[
            ("x-project-id", b"p1"),
            ("x-folder-id", b"f1"),
            ("x-file-name", b"a.txt"),
            ("x-last-modified", b""),
        ]))
        .unwrap();
        assert_eq!(with_folder.folder_id.as_deref(), Some("f1"));
        assert_eq!(with_folder.last_modified, None);

        let version = VersionHeaders::parse(&headers(&[
            ("x-document-id", b"d1"),
            ("x-file-name", b"b.txt"),
        ]))
        .unwrap();
        assert_eq!(version.document_id, "d1");
        assert_eq!(version.last_modified, None);
    }

    #[test]
    fn invalid_import_headers_are_rejected() {
        let bad: Vec<Vec<(&'static str, &[u8])>> = vec![
            vec![("x-file-name", b"a.txt")], // missing project
            vec![("x-project-id", b""), ("x-file-name", b"a.txt")], // empty project
            vec![("x-project-id", b"p1")],   // missing file name
            vec![("x-project-id", b"p1/../x"), ("x-file-name", b"a.txt")],
            vec![
                ("x-project-id", b"p1"),
                ("x-folder-id", b"f 1"),
                ("x-file-name", b"a.txt"),
            ],
            vec![("x-project-id", b"p1"), ("x-file-name", b"a%ZZ.txt")],
            vec![("x-project-id", b"p1"), ("x-file-name", b"%FF.txt")],
            vec![("x-project-id", b"p1"), ("x-file-name", b"\xc3\xa0.txt")], // not ASCII
            vec![
                ("x-project-id", b"p1"),
                ("x-file-name", b"a.txt"),
                ("x-last-modified", b"ieri"),
            ],
            vec![
                ("x-project-id", b"p1"),
                ("x-file-name", b"a.txt"),
                ("x-last-modified", b"1.5"),
            ],
            vec![
                ("x-project-id", b"p1"),
                ("x-file-name", b"a.txt"),
                ("x-last-modified", b"99999999999999999999"),
            ],
            vec![
                ("x-project-id", b"p1"),
                ("x-project-id", b"p2"),
                ("x-file-name", b"a.txt"),
            ],
        ];
        for pairs in bad {
            let err = ImportHeaders::parse(&headers(&pairs)).unwrap_err();
            assert_eq!(err.code, ErrorCode::Validation, "{pairs:?}");
            assert_eq!(err.message, "Richiesta non valida.");
            assert!(err.detail.is_some());
        }
        let long_id = "a".repeat(65);
        let err = VersionHeaders::parse(&headers(&[
            ("x-document-id", long_id.as_bytes()),
            ("x-file-name", b"a.txt"),
        ]))
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        // A negative timestamp parses; the core then ignores out-of-range values.
        let ok = ImportHeaders::parse(&headers(&[
            ("x-project-id", b"p1"),
            ("x-file-name", b"a.txt"),
            ("x-last-modified", b"-1"),
        ]))
        .unwrap();
        assert_eq!(ok.last_modified, Some(-1));
    }

    #[test]
    fn json_body_is_rejected_for_raw_commands() {
        let raw = InvokeBody::Raw(vec![1, 2, 3]);
        assert_eq!(raw_body(&raw).unwrap(), &[1, 2, 3]);
        let err = raw_body(&json_body()).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(
            to_json(err),
            r#"{"code":"validation","message":"Richiesta non valida.","detail":"expected a raw binary body, got JSON"}"#
        );
    }

    /// A JSON body as Tauri builds it for `invoke(cmd, {...})` (`Default` is an empty
    /// JSON object; serde_json is not a direct dependency).
    fn json_body() -> InvokeBody {
        let body = InvokeBody::default();
        assert!(matches!(body, InvokeBody::Json(_)));
        body
    }

    #[test]
    fn worker_wake_never_blocks() {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let state =
            crate::commands::AppState::new(|| Ok(Store::open_in_memory().unwrap())).with_worker(tx);
        for _ in 0..5 {
            state.wake_worker();
        }
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err(), "wake-ups coalesce");
    }
}

// ---------------------------------------------------------------- v0.3 Local chat

mod chat {
    use localis_core::{ChatEvent, CoreError, ErrorInfo, NewProject, SendInput, Store};

    use super::to_json;
    use crate::commands::{
        AppState, CandidateDto, ChatEventDto, ChatMessageDto, ConversationDto, EmbeddingStatusDto,
        LlmSettingsDto, LlmStatusDto, ModelInfoDto, RetrievalInfoDto, SendMessageInput, SourceDto,
    };
    use crate::error::{AppError, ErrorCode};

    fn answer() -> ChatMessageDto {
        ChatMessageDto {
            id: "a1".into(),
            conversation_id: "c1".into(),
            role: "assistant",
            kind: "answer",
            content: "Vero [1].".into(),
            status: "complete",
            error: None,
            model: Some("qwen".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            retrieval: Some(RetrievalInfoDto {
                mode: "hybrid",
                scope: "documents",
                document_ids: vec!["d1".into()],
                scope_reason: Some("title"),
                embedding_model: Some("nomic".into()),
                query: "\"vero\"*".into(),
            }),
            sources: vec![SourceDto {
                rank: 1,
                n: Some(1),
                cited: true,
                document_id: "d1".into(),
                version_id: "v1".into(),
                title: "a.pdf".into(),
                unit: 3,
                unit_kind: "page",
                text: "testo".into(),
                via: "both",
                available: false,
            }],
            candidates: vec![],
        }
    }

    const ANSWER_JSON: &str = concat!(
        r#"{"id":"a1","conversationId":"c1","role":"assistant","kind":"answer","#,
        r#""content":"Vero [1].","status":"complete","error":null,"model":"qwen","#,
        r#""createdAt":"2026-01-01T00:00:00.000Z","#,
        r#""retrieval":{"mode":"hybrid","scope":"documents","documentIds":["d1"],"#,
        r#""scopeReason":"title","embeddingModel":"nomic","query":"\"vero\"*"},"#,
        r#""sources":[{"rank":1,"n":1,"cited":true,"documentId":"d1","versionId":"v1","#,
        r#""title":"a.pdf","unit":3,"unitKind":"page","text":"testo","via":"both","#,
        r#""available":false}],"candidates":[]}"#
    );

    #[test]
    fn chat_message_json_shape() {
        assert_eq!(to_json(answer()), ANSWER_JSON);
        let clarification = ChatMessageDto {
            kind: "clarification",
            status: "complete",
            model: None,
            retrieval: None,
            sources: vec![],
            candidates: vec![CandidateDto {
                document_id: "d2".into(),
                title: "b.md".into(),
            }],
            ..answer()
        };
        let json = to_json(clarification);
        assert!(
            json.contains(
                r#""retrieval":null,"sources":[],"candidates":[{"documentId":"d2","title":"b.md"}]"#
            ),
            "{json}"
        );
        let failed = ChatMessageDto {
            status: "error",
            error: Some(AppError::from(&ErrorInfo {
                code: "llm_unavailable".into(),
                message: "LM Studio non risponde.".into(),
                detail: Some("connection refused".into()),
            })),
            ..answer()
        };
        assert!(to_json(failed).contains(
            r#""status":"error","error":{"code":"llm_unavailable","message":"LM Studio non risponde.","detail":"connection refused"}"#
        ));
        let mut no_reason = answer();
        no_reason.retrieval.as_mut().unwrap().scope_reason = None;
        no_reason.retrieval.as_mut().unwrap().embedding_model = None;
        assert!(to_json(no_reason).contains(r#""scopeReason":null,"embeddingModel":null"#));
    }

    #[test]
    fn chat_event_variants_are_tagged_by_type() {
        let cases = [
            (
                ChatEventDto::Accepted {
                    user_message: ChatMessageDto {
                        role: "user",
                        kind: "question",
                        retrieval: None,
                        sources: vec![],
                        model: None,
                        ..answer()
                    },
                    assistant_message_id: "a2".into(),
                },
                r#"{"type":"accepted","userMessage":{"id":"a1","#,
            ),
            (
                ChatEventDto::Phase {
                    phase: "retrieving",
                },
                r#"{"type":"phase","phase":"retrieving"}"#,
            ),
            (
                ChatEventDto::Phase {
                    phase: "generating",
                },
                r#"{"type":"phase","phase":"generating"}"#,
            ),
            (
                ChatEventDto::Delta {
                    text: "ciao".into(),
                },
                r#"{"type":"delta","text":"ciao"}"#,
            ),
            (
                ChatEventDto::Done { message: answer() },
                r#"{"type":"done","message":{"id":"a1","#,
            ),
            (
                ChatEventDto::Error {
                    error: AppError::from(&ErrorInfo {
                        code: "cancelled".into(),
                        message: "Risposta interrotta dall'utente.".into(),
                        detail: None,
                    }),
                    message: None,
                },
                r#"{"type":"error","error":{"code":"cancelled","message":"Risposta interrotta dall'utente."},"message":null}"#,
            ),
        ];
        for (event, prefix) in cases {
            let json = to_json(event);
            assert!(json.starts_with(prefix), "{json}");
        }
        let accepted = to_json(ChatEventDto::Accepted {
            user_message: answer(),
            assistant_message_id: "a2".into(),
        });
        assert!(
            accepted.ends_with(r#","assistantMessageId":"a2"}"#),
            "{accepted}"
        );
        assert_eq!(
            to_json(ChatEventDto::Done { message: answer() }),
            format!(r#"{{"type":"done","message":{ANSWER_JSON}}}"#)
        );
    }

    #[test]
    fn core_events_convert() {
        assert_eq!(
            ChatEventDto::from(ChatEvent::Phase(localis_core::ChatPhase::Generating)),
            ChatEventDto::Phase {
                phase: "generating"
            }
        );
        assert_eq!(
            ChatEventDto::from(ChatEvent::Delta("x".into())),
            ChatEventDto::Delta { text: "x".into() }
        );
    }

    #[test]
    fn settings_status_and_conversation_json_shapes() {
        let settings = LlmSettingsDto {
            base_url: "http://127.0.0.1:1234".into(),
            chat_model: Some("qwen".into()),
            embedding_model: None,
        };
        assert_eq!(
            to_json(settings.clone()),
            r#"{"baseUrl":"http://127.0.0.1:1234","chatModel":"qwen","embeddingModel":null}"#
        );
        let parsed: LlmSettingsDto = serde_json::from_str(
            r#"{"baseUrl":"http://127.0.0.1:1234","chatModel":"qwen","embeddingModel":null}"#,
        )
        .unwrap();
        assert_eq!(parsed, settings);
        let minimal: LlmSettingsDto =
            serde_json::from_str(r#"{"baseUrl":"http://localhost:1234"}"#).unwrap();
        assert_eq!(minimal.chat_model, None);

        assert_eq!(
            to_json(LlmStatusDto {
                reachable: true,
                message: None,
                detail: None,
                models: vec![
                    ModelInfoDto {
                        id: "qwen".into(),
                        kind: "llm",
                        state: Some("loaded".into())
                    },
                    ModelInfoDto {
                        id: "m".into(),
                        kind: "unknown",
                        state: None
                    },
                ],
            }),
            r#"{"reachable":true,"message":null,"detail":null,"models":[{"id":"qwen","kind":"llm","state":"loaded"},{"id":"m","kind":"unknown","state":null}]}"#
        );
        assert_eq!(
            to_json(EmbeddingStatusDto {
                state: "running",
                model: Some("nomic".into()),
                total: 10,
                embedded: 4,
                message: None,
            }),
            r#"{"state":"running","model":"nomic","total":10,"embedded":4,"message":null}"#
        );
        assert_eq!(
            to_json(ConversationDto {
                id: "c1".into(),
                project_id: "p1".into(),
                title: "Nuova conversazione".into(),
                created_at: "c".into(),
                updated_at: "u".into(),
            }),
            r#"{"id":"c1","projectId":"p1","title":"Nuova conversazione","createdAt":"c","updatedAt":"u"}"#
        );
    }

    #[test]
    fn send_message_input_parses() {
        let full: SendMessageInput = serde_json::from_str(
            r#"{"conversationId":"c1","text":"ciao","documentIds":["d1","d2"]}"#,
        )
        .unwrap();
        assert_eq!(
            SendInput::from(full),
            SendInput {
                conversation_id: "c1".into(),
                text: "ciao".into(),
                document_ids: vec!["d1".into(), "d2".into()],
            }
        );
        for json in [
            r#"{"conversationId":"c1","text":"ciao"}"#,
            r#"{"conversationId":"c1","text":"ciao","documentIds":null}"#,
            r#"{"conversationId":"c1","text":"ciao","documentIds":[]}"#,
        ] {
            let input: SendMessageInput = serde_json::from_str(json).unwrap();
            assert!(SendInput::from(input).document_ids.is_empty(), "{json}");
        }
    }

    #[test]
    fn dto_strings_match_core_enums() {
        use localis_core::{
            ChatPhase, EmbeddingState, MessageKind, MessageStatus, ModelKind, RetrievalMode,
            RetrievalScope, Role, ScopeReason, Via,
        };
        assert_eq!(
            [
                MessageKind::Question,
                MessageKind::Answer,
                MessageKind::Inventory,
                MessageKind::Clarification,
                MessageKind::NoEvidence
            ]
            .map(MessageKind::as_str),
            [
                "question",
                "answer",
                "inventory",
                "clarification",
                "no_evidence"
            ]
        );
        assert_eq!(
            [
                MessageStatus::Complete,
                MessageStatus::Streaming,
                MessageStatus::Cancelled,
                MessageStatus::Error
            ]
            .map(MessageStatus::as_str),
            ["complete", "streaming", "cancelled", "error"]
        );
        assert_eq!(
            [Role::User, Role::Assistant].map(Role::as_str),
            ["user", "assistant"]
        );
        assert_eq!(
            [RetrievalMode::Lexical, RetrievalMode::Hybrid].map(RetrievalMode::as_str),
            ["lexical", "hybrid"]
        );
        assert_eq!(
            [RetrievalScope::Project, RetrievalScope::Documents].map(RetrievalScope::as_str),
            ["project", "documents"]
        );
        assert_eq!(
            [
                ScopeReason::Selection,
                ScopeReason::Title,
                ScopeReason::History
            ]
            .map(ScopeReason::as_str),
            ["selection", "title", "history"]
        );
        assert_eq!(
            [Via::Lexical, Via::Semantic, Via::Both].map(Via::as_str),
            ["lexical", "semantic", "both"]
        );
        assert_eq!(
            [ChatPhase::Retrieving, ChatPhase::Generating].map(ChatPhase::as_str),
            ["retrieving", "generating"]
        );
        assert_eq!(
            [ModelKind::Llm, ModelKind::Embedding, ModelKind::Unknown].map(ModelKind::as_str),
            ["llm", "embedding", "unknown"]
        );
        assert_eq!(
            [
                EmbeddingState::Disabled,
                EmbeddingState::Idle,
                EmbeddingState::Running,
                EmbeddingState::Unreachable
            ]
            .map(EmbeddingState::as_str),
            ["disabled", "idle", "running", "unreachable"]
        );
    }

    #[test]
    fn new_error_codes() {
        let llm: AppError = CoreError::LlmUnavailable {
            message: "LM Studio non risponde su http://127.0.0.1:1234.".into(),
            detail: "connection refused".into(),
        }
        .into();
        assert_eq!(
            to_json(llm),
            r#"{"code":"llm_unavailable","message":"LM Studio non risponde su http://127.0.0.1:1234.","detail":"connection refused"}"#
        );
        let cancelled: AppError = CoreError::Cancelled {
            message: "Risposta interrotta dall'utente.".into(),
        }
        .into();
        assert_eq!(
            to_json(cancelled),
            r#"{"code":"cancelled","message":"Risposta interrotta dall'utente."}"#
        );
        // Every core code round-trips through ErrorCode::parse.
        for code in [
            "validation",
            "duplicate",
            "not_found",
            "conflict",
            "unsupported",
            "too_large",
            "integrity",
            "llm_unavailable",
            "cancelled",
            "storage",
            "internal",
        ] {
            let json = to_json(ErrorCode::parse(code));
            assert_eq!(json, format!("\"{code}\""));
        }
        assert_eq!(ErrorCode::parse("bogus"), ErrorCode::Internal);
        let url: AppError = Store::open_in_memory()
            .unwrap()
            .set_llm_settings(&localis_core::LlmSettings {
                base_url: "http://127.0.0.1.evil.com".into(),
                ..Default::default()
            })
            .unwrap_err()
            .into();
        assert_eq!(url.code, ErrorCode::Validation);
        assert_eq!(url.field.as_deref(), Some("baseUrl"));
    }

    /// The pipeline runs through `AppState` (StoreAccess) and the DTO conversion, without
    /// network (an inventory answer needs no model).
    #[test]
    fn send_message_through_app_state() {
        let state = AppState::new(|| Ok(Store::open_in_memory().unwrap()));
        let conversation = state
            .with_store(|s| {
                let p = s.create_project(NewProject {
                    name: "P".into(),
                    description: None,
                })?;
                Ok(s.create_conversation(&p.id)?.id)
            })
            .unwrap();
        let mut events = Vec::new();
        let message = localis_core::send_message(
            &state,
            &state.chat,
            SendInput {
                conversation_id: conversation.clone(),
                text: "Quali documenti ho caricato?".into(),
                document_ids: vec![],
            },
            &mut |e| events.push(to_json(ChatEventDto::from(e))),
        )
        .unwrap();
        assert_eq!(message.kind.as_str(), "inventory");
        assert_eq!(events.len(), 3);
        assert!(events[0].starts_with(r#"{"type":"accepted","userMessage":{"#));
        assert_eq!(events[1], r#"{"type":"phase","phase":"retrieving"}"#);
        assert!(events[2].starts_with(r#"{"type":"done","message":{"#));
        assert!(events[2].contains(r#""kind":"inventory""#));
        // Cancel with nothing running is a no-op.
        state.chat.cancel(&conversation);
        let listed = state
            .with_store(|s| Ok(s.list_messages(&conversation)?))
            .unwrap();
        assert_eq!(listed.len(), 2);
    }
}
