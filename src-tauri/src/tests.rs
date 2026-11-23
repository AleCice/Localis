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
        cloud_policy: "local_only",
        cloud_embedding_consent: false,
    };
    assert_eq!(
        to_json(dto.clone()),
        r#"{"id":"id-1","name":"Tesi","description":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-02T00:00:00.000Z","cloudPolicy":"local_only","cloudEmbeddingConsent":false}"#
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
            duration_ms: None,
            transcription: None,
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
                r#""textStatus":"no_text","pageCount":2,"imageWidth":null,"imageHeight":null,"#,
                r#""durationMs":null,"transcription":null},"#,
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
                text: "testo".into(),
                start_ms: None,
                end_ms: None,
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
                start_ms: None,
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
                progress: None,
                attempts: 1,
                error: Some("Il PDF non può essere letto.".into()),
                error_detail: Some("xref".into()),
                created_at: "c".into(),
                updated_at: "u".into(),
            }),
            r#"{"id":7,"documentId":"d1","versionId":"v1","kind":"extract_text","state":"failed","progress":null,"attempts":1,"error":"Il PDF non può essere letto.","errorDetail":"xref","createdAt":"c","updatedAt":"u"}"#
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
        // v0.5
        assert_eq!(DocumentKind::Audio.as_str(), "audio");
        assert_eq!(DocumentKind::Video.as_str(), "video");
        assert_eq!(UnitKind::Segment.as_str(), "segment");
        assert_eq!(localis_core::JOB_KIND_TRANSCRIBE, "transcribe");
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
        LlmSettingsDto, LlmStatusDto, ModelInfoDto, ModelRefDto, RetrievalInfoDto,
        SendMessageInput, SourceDto,
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
            provider: Some("lmstudio"),
            route_reason: Some("Scelto manualmente nelle impostazioni.".into()),
            usage: None,
            cost: None,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            retrieval: Some(RetrievalInfoDto {
                mode: "hybrid",
                scope: "documents",
                document_ids: vec!["d1".into()],
                scope_reason: Some("title"),
                embedding_model: Some("nomic".into()),
                embedding_provider: Some("lmstudio"),
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
                start_ms: None,
                via: "both",
                available: false,
            }],
            candidates: vec![],
        }
    }

    const ANSWER_JSON: &str = concat!(
        r#"{"id":"a1","conversationId":"c1","role":"assistant","kind":"answer","#,
        r#""content":"Vero [1].","status":"complete","error":null,"model":"qwen","#,
        r#""provider":"lmstudio","routeReason":"Scelto manualmente nelle impostazioni.","#,
        r#""usage":null,"cost":null,"createdAt":"2026-01-01T00:00:00.000Z","#,
        r#""retrieval":{"mode":"hybrid","scope":"documents","documentIds":["d1"],"#,
        r#""scopeReason":"title","embeddingModel":"nomic","embeddingProvider":"lmstudio","#,
        r#""query":"\"vero\"*"},"#,
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
        no_reason.retrieval.as_mut().unwrap().embedding_provider = None;
        assert!(to_json(no_reason)
            .contains(r#""scopeReason":null,"embeddingModel":null,"embeddingProvider":null"#));
        let cloud = ChatMessageDto {
            model: Some("gpt-x".into()),
            provider: Some("openai"),
            usage: Some(crate::commands::TokenUsageDto {
                input_tokens: Some(1200),
                output_tokens: None,
            }),
            cost: Some(crate::commands::MoneyDto {
                amount: 0.5,
                currency: "USD".into(),
            }),
            ..answer()
        };
        assert!(to_json(cloud).contains(
            r#""model":"gpt-x","provider":"openai","routeReason":"Scelto manualmente nelle impostazioni.","usage":{"inputTokens":1200,"outputTokens":null},"cost":{"amount":0.5,"currency":"USD"},"createdAt""#
        ));
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
            chat_model: Some(ModelRefDto {
                provider: "lmstudio".into(),
                model: "qwen".into(),
            }),
            embedding_model: None,
            routing: "auto".into(),
            auto_models: vec![ModelRefDto {
                provider: "openai".into(),
                model: "gpt-x".into(),
            }],
        };
        let json = r#"{"baseUrl":"http://127.0.0.1:1234","chatModel":{"provider":"lmstudio","model":"qwen"},"embeddingModel":null,"routing":"auto","autoModels":[{"provider":"openai","model":"gpt-x"}]}"#;
        assert_eq!(to_json(settings.clone()), json);
        let parsed: LlmSettingsDto = serde_json::from_str(json).unwrap();
        assert_eq!(parsed, settings);
        let core = localis_core::LlmSettings::try_from(parsed).unwrap();
        assert_eq!(core.routing, localis_core::Routing::Auto);
        assert_eq!(
            core.auto_models[0].provider,
            localis_core::ProviderId::Cloud(localis_core::CloudProvider::OpenAi)
        );
        let minimal: LlmSettingsDto =
            serde_json::from_str(r#"{"baseUrl":"http://localhost:1234"}"#).unwrap();
        assert_eq!(minimal.chat_model, None);
        assert_eq!(minimal.routing, "manual");
        assert!(minimal.auto_models.is_empty());
        // Unknown providers or routing modes are validation errors on the field.
        let bad: LlmSettingsDto = serde_json::from_str(
            r#"{"baseUrl":"http://localhost:1234","chatModel":{"provider":"acme","model":"x"}}"#,
        )
        .unwrap();
        let err = localis_core::LlmSettings::try_from(bad).unwrap_err();
        assert_eq!(err.code, ErrorCode::Validation);
        assert_eq!(err.field.as_deref(), Some("chatModel"));
        let bad: LlmSettingsDto =
            serde_json::from_str(r#"{"baseUrl":"http://localhost:1234","routing":"magic"}"#)
                .unwrap();
        let err = localis_core::LlmSettings::try_from(bad).unwrap_err();
        assert_eq!(err.field.as_deref(), Some("routing"));
        // The 0.3 shape (model as a plain string) is rejected by the 0.4 contract.
        assert!(serde_json::from_str::<LlmSettingsDto>(
            r#"{"baseUrl":"http://localhost:1234","chatModel":"qwen"}"#
        )
        .is_err());

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
                state: "needs_consent",
                provider: Some("openai"),
                model: Some("text-embedding-3-small".into()),
                total: 10,
                embedded: 4,
                message: None,
            }),
            r#"{"state":"needs_consent","provider":"openai","model":"text-embedding-3-small","total":10,"embedded":4,"message":null}"#
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
            r#"{"conversationId":"c1","text":"ciao","documentIds":["d1","d2"],"confirmToken":"t1"}"#,
        )
        .unwrap();
        assert_eq!(
            SendInput::from(full),
            SendInput {
                conversation_id: "c1".into(),
                text: "ciao".into(),
                document_ids: vec!["d1".into(), "d2".into()],
                confirm_token: Some("t1".into()),
            }
        );
        let empty_token: SendMessageInput =
            serde_json::from_str(r#"{"conversationId":"c1","text":"ciao","confirmToken":""}"#)
                .unwrap();
        assert_eq!(SendInput::from(empty_token).confirm_token, None);
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
                EmbeddingState::Unreachable,
                EmbeddingState::NeedsConsent
            ]
            .map(EmbeddingState::as_str),
            [
                "disabled",
                "idle",
                "running",
                "unreachable",
                "needs_consent"
            ]
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
            "consent_required",
            "keyring_unavailable",
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
            &state.cloud,
            SendInput {
                conversation_id: conversation.clone(),
                text: "Quali documenti ho caricato?".into(),
                document_ids: vec![],
                confirm_token: None,
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

mod cloud {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use localis_core::{
        CloudPolicy, CloudPreview, CloudProvider, CloudPurpose, CloudRequest, CloudRuntime,
        CoreError, Endpoints, KeyringStatus, ModelPrice, ModelRef, Money, NewProject,
        PreviewSource, ProviderId, RouteDecision, SecretStore, Store, UnitKind, Usage, Via,
    };

    use super::to_json;
    use crate::commands::{
        AppState, CloudEmbeddingEstimateDto, CloudPreviewDto, CloudRequestDto, KeyringStatusDto,
        ModelPriceDto, ProjectDto, ProviderInfoDto, ProviderModelsDto,
    };
    use crate::error::{AppError, ErrorCode};

    #[derive(Default)]
    struct MemoryKeys(Mutex<HashMap<CloudProvider, String>>);

    impl SecretStore for MemoryKeys {
        fn status(&self) -> KeyringStatus {
            KeyringStatus {
                available: true,
                message: None,
                detail: None,
            }
        }
        fn get(&self, p: CloudProvider) -> localis_core::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(&p).cloned())
        }
        fn set(&self, p: CloudProvider, key: &str) -> localis_core::Result<()> {
            self.0.lock().unwrap().insert(p, key.to_owned());
            Ok(())
        }
        fn delete(&self, p: CloudProvider) -> localis_core::Result<()> {
            self.0.lock().unwrap().remove(&p);
            Ok(())
        }
    }

    const OPENAI: ProviderId = ProviderId::Cloud(CloudProvider::OpenAi);

    #[test]
    fn new_error_codes_json() {
        let consent: AppError = CoreError::ConsentRequired {
            message: "Serve la tua conferma.".into(),
        }
        .into();
        assert_eq!(
            to_json(consent),
            r#"{"code":"consent_required","message":"Serve la tua conferma."}"#
        );
        let keyring: AppError = localis_core::keyring_unavailable("no secret service").into();
        assert_eq!(keyring.code, ErrorCode::KeyringUnavailable);
        assert!(to_json(keyring).starts_with(r#"{"code":"keyring_unavailable","message":"Il portachiavi di sistema non è disponibile"#));
        // A validation error on the key never echoes it.
        let err: AppError = localis_core::validate_api_key("sk secret with spaces")
            .unwrap_err()
            .into();
        assert_eq!(err.field.as_deref(), Some("key"));
        assert!(!to_json(err).contains("secret"));
    }

    #[test]
    fn provider_keyring_and_models_json() {
        assert_eq!(
            to_json(ProviderInfoDto::new(CloudProvider::Qwen, true)),
            r#"{"id":"qwen","name":"Qwen (Alibaba Cloud)","host":"dashscope-intl.aliyuncs.com","hasKey":true,"supportsChat":true,"supportsEmbeddings":true}"#
        );
        assert_eq!(
            to_json(ProviderInfoDto::new(CloudProvider::Anthropic, false)),
            r#"{"id":"anthropic","name":"Anthropic","host":"api.anthropic.com","hasKey":false,"supportsChat":true,"supportsEmbeddings":false}"#
        );
        let names: Vec<&str> = CloudProvider::ALL.iter().map(|p| p.name()).collect();
        assert_eq!(
            names,
            [
                "OpenAI",
                "Anthropic",
                "Google Gemini",
                "DeepSeek",
                "Qwen (Alibaba Cloud)"
            ]
        );
        assert_eq!(
            to_json(KeyringStatusDto {
                available: false,
                message: Some("m".into()),
                detail: None
            }),
            r#"{"available":false,"message":"m","detail":null}"#
        );
        assert_eq!(
            to_json(ProviderModelsDto {
                provider: "gemini",
                reachable: true,
                message: None,
                detail: None,
                models: vec![crate::commands::ModelInfoDto {
                    id: "gemini-x".into(),
                    kind: "llm",
                    state: None
                }],
            }),
            r#"{"provider":"gemini","reachable":true,"message":null,"detail":null,"models":[{"id":"gemini-x","kind":"llm","state":null}]}"#
        );
    }

    #[test]
    fn price_json_round_trip_and_validation() {
        let json = r#"{"provider":"openai","model":"gpt-x","inputPerMTok":2.5,"outputPerMTok":10.0,"currency":"USD"}"#;
        let dto: ModelPriceDto = serde_json::from_str(json).unwrap();
        let price = ModelPrice::try_from(dto.clone()).unwrap();
        assert_eq!(price.input_per_mtok, 2.5);
        assert_eq!(
            to_json(ModelPriceDto::from(price)),
            r#"{"provider":"openai","model":"gpt-x","inputPerMTok":2.5,"outputPerMTok":10.0,"currency":"USD"}"#
        );
        let lm: ModelPriceDto = serde_json::from_str(
            r#"{"provider":"lmstudio","model":"x","inputPerMTok":1,"outputPerMTok":1,"currency":"USD"}"#,
        )
        .unwrap();
        let err = ModelPrice::try_from(lm).unwrap_err();
        assert_eq!(err.field.as_deref(), Some("provider"));
    }

    #[test]
    fn preview_estimate_and_log_json() {
        let preview = CloudPreview {
            token: "t".into(),
            route: RouteDecision {
                model: ModelRef::new(OPENAI, "gpt-x"),
                cloud: true,
                reason: "Scelto manualmente nelle impostazioni.".into(),
            },
            provider_name: "OpenAI".into(),
            host: "api.openai.com".into(),
            question: "Domanda?".into(),
            sources: vec![PreviewSource {
                n: 1,
                title: "a.pdf".into(),
                unit: 3,
                unit_kind: UnitKind::Page,
                chars: 120,
                via: Via::Both,
                start_ms: None,
            }],
            history_pairs: 1,
            history_chars: 40,
            total_chars: 2000,
            est_input_tokens: 500,
            max_output_tokens: 2048,
            est_cost: Some((
                Money {
                    amount: 0.001,
                    currency: "USD".into(),
                },
                Money {
                    amount: 0.021,
                    currency: "USD".into(),
                },
            )),
            query_embedded_by: Some(ModelRef::new(OPENAI, "emb")),
            expires_at: "2026-01-01T00:10:00.000Z".into(),
        };
        assert_eq!(
            to_json(CloudPreviewDto::from(preview.clone())),
            concat!(
                r#"{"token":"t","route":{"model":{"provider":"openai","model":"gpt-x"},"cloud":true,"#,
                r#""reason":"Scelto manualmente nelle impostazioni."},"providerName":"OpenAI","#,
                r#""host":"api.openai.com","question":"Domanda?","sources":[{"n":1,"title":"a.pdf","#,
                r#""unit":3,"unitKind":"page","chars":120,"via":"both"}],"historyPairs":1,"#,
                r#""historyChars":40,"totalChars":2000,"estInputTokens":500,"maxOutputTokens":2048,"#,
                r#""estCost":{"min":{"amount":0.001,"currency":"USD"},"max":{"amount":0.021,"currency":"USD"}},"#,
                r#""queryEmbeddedBy":{"provider":"openai","model":"emb"},"expiresAt":"2026-01-01T00:10:00.000Z"}"#
            )
        );
        let no_cost = CloudPreview {
            est_cost: None,
            query_embedded_by: None,
            ..preview
        };
        assert!(to_json(CloudPreviewDto::from(no_cost))
            .contains(r#""estCost":null,"queryEmbeddedBy":null"#));
        assert_eq!(
            to_json(CloudEmbeddingEstimateDto {
                provider: "gemini",
                model: "text-embedding-004".into(),
                chunks: 3,
                chars: 900,
                est_tokens: 225,
                est_cost: None,
            }),
            r#"{"provider":"gemini","model":"text-embedding-004","chunks":3,"chars":900,"estTokens":225,"estCost":null}"#
        );
        let log = CloudRequest {
            id: 7,
            created_at: "c".into(),
            provider: CloudProvider::DeepSeek,
            model: Some("chat".into()),
            purpose: CloudPurpose::Chat,
            project_id: Some("p".into()),
            conversation_id: None,
            chars_sent: 1234,
            usage: Some(Usage {
                input_tokens: Some(300),
                output_tokens: Some(50),
            }),
            cost: None,
            ok: false,
            error: Some("DeepSeek non raggiungibile.".into()),
        };
        assert_eq!(
            to_json(CloudRequestDto::from(log)),
            r#"{"id":7,"createdAt":"c","provider":"deepseek","model":"chat","purpose":"chat","projectId":"p","conversationId":null,"charsSent":1234,"usage":{"inputTokens":300,"outputTokens":50},"cost":null,"ok":false,"error":"DeepSeek non raggiungibile."}"#
        );
        assert_eq!(
            [
                CloudPurpose::Chat,
                CloudPurpose::QueryEmbedding,
                CloudPurpose::IndexEmbedding,
                CloudPurpose::ListModels
            ]
            .map(CloudPurpose::as_str),
            ["chat", "query_embedding", "index_embedding", "list_models"]
        );
    }

    /// Project DTOs carry the policy; a cloud send through AppState without a token is
    /// refused with `consent_required` and nothing is stored.
    #[test]
    fn project_policy_and_consent_through_app_state() {
        let keys = Arc::new(MemoryKeys::default());
        keys.set(CloudProvider::OpenAi, "sk-test").unwrap();
        let state = AppState::new(|| Ok(Store::open_in_memory().unwrap()))
            .with_cloud(CloudRuntime::new(keys, Endpoints::default()));
        let (project, conversation) = state
            .with_store(|s| {
                let p = s.create_project(NewProject {
                    name: "P".into(),
                    description: None,
                })?;
                let mut settings = s.llm_settings()?;
                settings.chat_model = Some(ModelRef::new(OPENAI, "gpt-x"));
                s.set_llm_settings(&settings)?;
                Ok((p.id.clone(), s.create_conversation(&p.id)?.id))
            })
            .unwrap();
        let dto: ProjectDto = state
            .with_store(|s| Ok(s.set_project_cloud_policy(&project, CloudPolicy::CloudAllowed)?))
            .unwrap()
            .into();
        assert_eq!(dto.cloud_policy, "cloud_allowed");
        assert!(to_json(dto)
            .ends_with(r#""cloudPolicy":"cloud_allowed","cloudEmbeddingConsent":false}"#));
        let input = localis_core::SendInput {
            conversation_id: conversation.clone(),
            text: "Domanda qualsiasi sul testo".into(),
            document_ids: vec![],
            confirm_token: Some("forged".into()),
        };
        let err: AppError =
            localis_core::send_message(&state, &state.chat, &state.cloud, input, &mut |_| {})
                .unwrap_err()
                .into();
        assert_eq!(err.code, ErrorCode::ConsentRequired);
        let stored = state
            .with_store(|s| Ok(s.list_messages(&conversation)?))
            .unwrap();
        assert!(stored.is_empty());
        // Local-only project: even preparing is refused.
        state
            .with_store(|s| Ok(s.set_project_cloud_policy(&project, CloudPolicy::LocalOnly)?))
            .unwrap();
        let err: AppError = localis_core::prepare_cloud_send(
            &state,
            &state.cloud,
            &localis_core::SendInput {
                conversation_id: conversation,
                text: "Domanda".into(),
                document_ids: vec![],
                confirm_token: None,
            },
        )
        .unwrap_err()
        .into();
        assert_eq!(err.code, ErrorCode::ConsentRequired);
    }
}

// ---------------------------------------------------------------- v0.5 FARO

mod lectures {
    use std::sync::Arc;

    use localis_core::{
        Language, ModelManager, NewProject, Store, Uploads, WhisperModelId, WhisperModelId as M,
    };
    use tauri::http::{HeaderMap, HeaderName, HeaderValue, Request};

    use super::{tempdir, to_json};
    use crate::commands::{AppState, DocumentVersionDto, ImportResultDto, JobDto};
    use crate::error::{AppError, ErrorCode};
    use crate::headers::ChunkHeaders;
    use crate::lectures::{
        BeginUploadInput, MediaLinkDto, MediaLinkInputDto, RegionDto, TranscriptSegmentDto,
        TranscriptionInfoDto, UploadHandleDto, WhisperModelDto,
    };
    use crate::media_protocol;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../crates/localis-core/tests/fixtures")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn new_dto_json_shapes() {
        assert_eq!(
            to_json(UploadHandleDto {
                upload_id: "u1".into(),
                chunk_bytes: 8_388_608
            }),
            r#"{"uploadId":"u1","chunkBytes":8388608}"#
        );
        let models = ModelManager::new(tempdir().join("models"));
        let tiny: WhisperModelDto = models.list().remove(0).into();
        assert_eq!(
            to_json(tiny),
            concat!(
                r#"{"id":"tiny","name":"Whisper Tiny","fileName":"ggml-tiny.bin","#,
                r#""sizeBytes":77691713,"#,
                r#""sha256":"be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21","#,
                r#""installed":false,"download":null,"error":null}"#
            )
        );
        let ids: Vec<&str> = models.list().iter().map(|m| m.spec.id.as_str()).collect();
        assert_eq!(ids, ["tiny", "base", "small", "large-v3-turbo-q5"]);
        let downloading = WhisperModelDto {
            download: Some(crate::lectures::DownloadDto {
                received_bytes: 10,
                total_bytes: 20,
            }),
            ..models.list().remove(1).into()
        };
        assert!(to_json(downloading).contains(r#""download":{"receivedBytes":10,"totalBytes":20}"#));
        assert_eq!(
            to_json(TranscriptionInfoDto {
                model: "small".into(),
                language: "it".into(),
                created_at: "c".into(),
                segment_count: 12
            }),
            r#"{"model":"small","language":"it","createdAt":"c","segmentCount":12}"#
        );
        assert_eq!(
            to_json(TranscriptSegmentDto {
                index: 1,
                start_ms: 1000,
                end_ms: 2500,
                text: "Buongiorno".into()
            }),
            r#"{"index":1,"startMs":1000,"endMs":2500,"text":"Buongiorno"}"#
        );
        let link = MediaLinkDto {
            id: "l1".into(),
            project_id: "p".into(),
            media_document_id: "md".into(),
            media_version_id: "mv".into(),
            start_ms: 1000,
            end_ms: 2000,
            target_document_id: "td".into(),
            target_version_id: "tv".into(),
            target_page: Some(3),
            region: Some(RegionDto {
                x: 0.1,
                y: 0.2,
                w: 0.5,
                h: 0.25,
            }),
            note: None,
            created_at: "c".into(),
            updated_at: "u".into(),
            media_title: "lezione.mp4".into(),
            target_title: "slide.pdf".into(),
            available: true,
        };
        assert_eq!(
            to_json(link),
            concat!(
                r#"{"id":"l1","projectId":"p","mediaDocumentId":"md","mediaVersionId":"mv","#,
                r#""startMs":1000,"endMs":2000,"targetDocumentId":"td","targetVersionId":"tv","#,
                r#""targetPage":3,"region":{"x":0.1,"y":0.2,"w":0.5,"h":0.25},"note":null,"#,
                r#""createdAt":"c","updatedAt":"u","mediaTitle":"lezione.mp4","#,
                r#""targetTitle":"slide.pdf","available":true}"#
            )
        );
        // Optional v0.5 fields appear only for segments.
        let unit = crate::commands::TextUnitDto {
            unit: 2,
            text: "t".into(),
            start_ms: Some(5),
            end_ms: Some(9),
        };
        assert_eq!(
            to_json(unit),
            r#"{"unit":2,"text":"t","startMs":5,"endMs":9}"#
        );
    }

    #[test]
    fn inputs_parse_from_camel_case() {
        let input: BeginUploadInput = serde_json::from_str(
            r#"{"projectId":"p","fileName":"l.mp4","sizeBytes":5000000000,"lastModified":1,"documentId":null}"#,
        )
        .unwrap();
        assert_eq!(input.size_bytes, 5_000_000_000);
        assert_eq!(input.folder_id, None);
        let link: MediaLinkInputDto = serde_json::from_str(
            r#"{"mediaVersionId":"m","startMs":-5,"endMs":10,"targetVersionId":"t","region":{"x":0,"y":0,"w":1,"h":1}}"#,
        )
        .unwrap();
        assert_eq!(
            (link.start_ms, link.target_page, link.note),
            (-5, None, None)
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("x-upload-id"),
            HeaderValue::from_static("abc-1"),
        );
        headers.insert(
            HeaderName::from_static("x-offset"),
            HeaderValue::from_static("8388608"),
        );
        assert_eq!(
            ChunkHeaders::parse(&headers).unwrap(),
            ChunkHeaders {
                upload_id: "abc-1".into(),
                offset: 8_388_608
            }
        );
        for bad in ["-1", "", "1e3", "99999999999999999999999"] {
            headers.insert(
                HeaderName::from_static("x-offset"),
                HeaderValue::from_str(bad).unwrap(),
            );
            assert!(ChunkHeaders::parse(&headers).is_err(), "{bad}");
        }
        headers.insert(
            HeaderName::from_static("x-offset"),
            HeaderValue::from_static("0"),
        );
        headers.insert(
            HeaderName::from_static("x-upload-id"),
            HeaderValue::from_static("../x"),
        );
        assert!(ChunkHeaders::parse(&headers).is_err());
    }

    struct App {
        dir: std::path::PathBuf,
        state: AppState,
        project: String,
    }

    fn app() -> App {
        let dir = tempdir();
        let db = dir.join("localis.db");
        let state = AppState::new(move || Ok(Store::open(&db)?))
            .with_uploads(Arc::new(Uploads::new(&dir.join("originals"))))
            .with_models(Arc::new(ModelManager::new(dir.join("models/whisper"))));
        let project = state
            .with_store(|s| {
                Ok(s.create_project(NewProject {
                    name: "Lezioni".into(),
                    description: None,
                })?
                .id)
            })
            .unwrap();
        App {
            dir,
            state,
            project,
        }
    }

    /// The chunked import path of `finish_upload`, through the managed state.
    fn upload(app: &App, name: &str, bytes: &[u8]) -> ImportResultDto {
        let uploads = app.state.uploads.clone().unwrap();
        let input = localis_core::BeginUpload {
            project_id: app.project.clone(),
            file_name: name.into(),
            size_bytes: bytes.len() as u64,
            ..Default::default()
        };
        app.state
            .with_store(|s| Ok(s.check_upload_target(&input)?))
            .unwrap();
        let id = uploads.begin(input).unwrap().upload_id;
        let mut offset = 0;
        for chunk in bytes.chunks(4096) {
            uploads.write_chunk(&id, offset, chunk).unwrap();
            offset += chunk.len() as u64;
        }
        let finished = uploads.finish(&id).unwrap();
        let file = finished.prepare().unwrap();
        app.state
            .with_store(|s| Ok(s.import_upload(&finished, &file)?))
            .unwrap()
            .into()
    }

    fn get(path: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut b = Request::builder()
            .method("GET")
            .uri(format!("localis-media://localhost{path}"));
        if let Some(r) = range {
            b = b.header("range", r);
        }
        b.body(Vec::new()).unwrap()
    }

    #[test]
    fn upload_then_stream_with_ranges() {
        let app = app();
        let mp3 = fixture("lezione.mp3");
        let ImportResultDto::Imported { document } = upload(&app, "lezione.mp3", &mp3) else {
            panic!("expected imported");
        };
        let v: DocumentVersionDto = document.current;
        assert_eq!((v.kind, v.media_type.as_str()), ("audio", "audio/mpeg"));
        assert!(v.duration_ms.is_some_and(|d| d > 9000));
        let json = to_json(v.clone());
        assert!(json.contains(r#""textStatus":"not_applicable""#), "{json}");
        assert!(json.contains(r#""transcription":null"#), "{json}");

        let path = format!("/{}", v.id);
        let r = media_protocol::handle(&app.state, &get(&path, None));
        assert_eq!(r.status(), 200);
        assert_eq!(r.body(), &mp3);
        assert_eq!(r.headers()["content-type"], "audio/mpeg");
        assert_eq!(r.headers()["accept-ranges"], "bytes");
        let r = media_protocol::handle(&app.state, &get(&path, Some("bytes=100-")));
        assert_eq!(r.status(), 206);
        assert_eq!(r.body(), &mp3[100..]);
        assert_eq!(
            r.headers()["content-range"],
            format!("bytes 100-{}/{}", mp3.len() - 1, mp3.len()).as_str()
        );
        let r = media_protocol::handle(
            &app.state,
            &get(&path, Some(&format!("bytes={}-", mp3.len()))),
        );
        assert_eq!(r.status(), 416);
        // Unknown ids, non-media versions and anything that is not an id: 404.
        assert_eq!(
            media_protocol::handle(&app.state, &get("/nope", None)).status(),
            404
        );
        assert_eq!(
            media_protocol::handle(&app.state, &get("/../localis.db", None)).status(),
            404
        );
        let ImportResultDto::Imported { document: txt } =
            upload(&app, "note.txt", b"appunti di testo")
        else {
            panic!()
        };
        assert_eq!(
            media_protocol::handle(&app.state, &get(&format!("/{}", txt.current.id), None))
                .status(),
            404
        );
        // A stored file that changed size is not served.
        let sha = &v.sha256;
        let blob = app.dir.join("originals").join(&sha[..2]).join(sha);
        std::fs::write(&blob, b"troncato").unwrap();
        assert_eq!(
            media_protocol::handle(&app.state, &get(&path, None)).status(),
            500
        );
    }

    #[test]
    fn transcription_and_link_errors_map_to_codes_and_fields() {
        let app = app();
        let ImportResultDto::Imported { document } =
            upload(&app, "lezione.mp4", &fixture("lezione.mp4"))
        else {
            panic!()
        };
        let v = document.current.id;
        // Queued job JSON: kind transcribe, progress null.
        let job: JobDto = app
            .state
            .with_store(|s| Ok(s.start_transcription(&v, M::Base, Language::Auto)?))
            .unwrap()
            .into();
        let json = to_json(job.clone());
        assert!(
            json.contains(r#""kind":"transcribe","state":"queued","progress":null"#),
            "{json}"
        );
        let err: AppError = app
            .state
            .with_store(|s| Ok(s.start_transcription(&v, M::Base, Language::It)?))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        let cancelled: JobDto = app
            .state
            .with_store(|s| Ok(s.cancel_job(job.id)?))
            .unwrap()
            .into();
        assert_eq!(cancelled.state, "failed");
        assert_eq!(
            cancelled.error.as_deref(),
            Some(localis_core::TRANSCRIPTION_CANCELLED)
        );
        let status = app
            .state
            .with_store(|s| Ok(s.get_version(&v)?.text_status.as_str()))
            .unwrap();
        assert_eq!(status, "not_applicable");
        let bad_model: AppError = WhisperModelId::parse_input("huge").unwrap_err().into();
        assert_eq!(
            (bad_model.code, bad_model.field.as_deref()),
            (ErrorCode::Validation, Some("model"))
        );

        // Link validation errors carry the camelCase field the form shows them under.
        let ImportResultDto::Imported { document: photo } = upload(&app, "foto.png", &png()) else {
            panic!()
        };
        let input = |start: i64, end: i64, page: Option<i64>| MediaLinkInputDto {
            media_version_id: v.clone(),
            start_ms: start,
            end_ms: end,
            target_version_id: photo.current.id.clone(),
            target_page: page,
            region: None,
            note: None,
        };
        for (i, field) in [
            (input(-1, 10, None), "startMs"),
            (input(10, 5, None), "endMs"),
            (input(0, 10, Some(1)), "targetPage"),
            (
                MediaLinkInputDto {
                    region: Some(RegionDto {
                        x: 0.5,
                        y: 0.5,
                        w: 0.6,
                        h: 0.1,
                    }),
                    ..input(0, 10, None)
                },
                "region",
            ),
            (
                MediaLinkInputDto {
                    note: Some("n".repeat(2001)),
                    ..input(0, 10, None)
                },
                "note",
            ),
        ] {
            let core = localis_core::MediaLinkInput::from(i);
            let err: AppError = app
                .state
                .with_store(|s| Ok(s.create_media_link(&core)?))
                .unwrap_err();
            assert_eq!(
                (err.code, err.field.as_deref()),
                (ErrorCode::Validation, Some(field))
            );
        }
        let ok = localis_core::MediaLinkInput::from(input(0, 1000, None));
        let link: MediaLinkDto = app
            .state
            .with_store(|s| Ok(s.create_media_link(&ok)?))
            .unwrap()
            .into();
        assert_eq!(
            (link.media_title.as_str(), link.target_page),
            ("lezione.mp4", None)
        );
    }

    /// A 1×1 PNG.
    fn png() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ]
    }
}
