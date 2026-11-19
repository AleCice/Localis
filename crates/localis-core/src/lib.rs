//! Localis domain logic and SQLite persistence. No Tauri dependency, so it can be
//! tested without GUI system libraries.

mod blobs;
mod chat;
mod chunks;
mod embedder;
mod error;
pub mod extract;
mod formats;
mod jobs;
mod library;
mod llm;
mod retrieval;
mod search;
mod settings;
mod store;
mod validation;

pub use blobs::sha256_hex;
pub use chat::{
    build_prompt, citation_numbers, send_message, Candidate, ChatEvent, ChatMessage, ChatPhase,
    ChatRuntime, Conversation, ErrorInfo, Evidence, MessageKind, MessageStatus, RetrievalInfo,
    RetrievalMode, RetrievalScope, Role, ScopeReason, SendInput, Source, StoreAccess,
    AMBIGUOUS_TITLE, CANCELLED_MESSAGE, DEFAULT_CONVERSATION_TITLE, HISTORY_PAIRS,
    INTERRUPTED_MESSAGE, NO_CHAT_MODEL, NO_EVIDENCE_MESSAGE, NO_TEXT_NOTE, QUESTION_MAX_CHARS,
    SYSTEM_PROMPT, WHICH_DOCUMENT,
};
pub use chunks::{chunk_text, ChunkSpan, CHUNK_MAX_CHARS};
pub use embedder::{
    next_backoff, run_embedder, EmbedderConfig, EmbedderShared, EmbedderSnapshot, EmbeddingState,
    EmbeddingStatus,
};
pub use error::{CoreError, Result};
pub use formats::{detect_format, DetectedFormat, DocumentKind};
pub use jobs::{
    run_worker, ClaimedJob, Job, JobState, WorkerConfig, JOBS_LIST_MAX, JOB_KIND_EXTRACT_TEXT,
};
pub use library::{
    check_size, DocumentVersion, Folder, ImportFile, ImportOutcome, LibraryDocument, NewFolder,
    TextStatus, TextUnit, FILE_NAME_MAX, IMPORT_MAX_BYTES,
};
pub use llm::{
    LlmClient, LlmStatus, ModelInfo, ModelKind, PromptMessage, SseParser, StreamEnd,
    CONNECT_TIMEOUT, EMBED_BATCH_MAX, SHORT_TIMEOUT,
};
pub use retrieval::{
    fuse, has_deictic_reference, is_inventory_question, lexical_query, match_titles,
    normalize_text, select_evidence, DocRef, Passage, Ranked, TitleMatch, Via,
    EVIDENCE_BUDGET_CHARS, EVIDENCE_MAX, MIN_COSINE, RAW_MAX, RRF_K,
};
pub use search::{
    fts_query, SearchHit, UnitKind, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SNIPPET_MARK_END,
    SNIPPET_MARK_START,
};
pub use settings::{validate_base_url, LlmSettings, DEFAULT_BASE_URL};
pub use store::{NewProject, Project, Store, ORIGINALS_DIR, SCHEMA_VERSION};
pub use validation::{validate_description, validate_name, DESCRIPTION_MAX, NAME_MAX};
