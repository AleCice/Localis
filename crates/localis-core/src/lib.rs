//! Localis domain logic and SQLite persistence. No Tauri dependency, so it can be
//! tested without GUI system libraries.

mod blobs;
mod chat;
mod chunks;
mod cloud_log;
mod cloud_send;
mod embedder;
mod error;
pub mod extract;
mod formats;
mod jobs;
mod keys;
mod library;
mod links;
mod llm;
mod media;
mod mesh;
mod models;
mod prices;
mod prism;
mod providers;
mod retrieval;
mod search;
mod settings;
mod store;
mod transcribe;
mod uploads;
mod validation;
mod whisper;

pub use blobs::sha256_hex;
pub use chat::{
    build_prompt, citation_numbers, prepare_cloud_send, send_message, Candidate, ChatEvent,
    ChatMessage, ChatPhase, ChatRuntime, Conversation, ErrorInfo, Evidence, MessageKind,
    MessageStatus, RetrievalInfo, RetrievalMode, RetrievalScope, Role, ScopeReason, SendInput,
    Source, StoreAccess, AMBIGUOUS_TITLE, CANCELLED_MESSAGE, DEFAULT_CONVERSATION_TITLE,
    HISTORY_PAIRS, INTERRUPTED_MESSAGE, NO_EVIDENCE_MESSAGE, NO_TEXT_NOTE, QUESTION_MAX_CHARS,
    SYSTEM_PROMPT, WHICH_DOCUMENT,
};
pub use chunks::{chunk_text, ChunkSpan, CHUNK_MAX_CHARS};
pub use cloud_log::{CloudLogEntry, CloudPurpose, CloudRequest, CLOUD_LOG_MAX};
pub use cloud_send::{
    list_provider_models, CloudEnv, CloudPreview, CloudRuntime, PreviewSource, ProviderModels,
    CLOUD_TOKEN_TTL, CONFIRMATION_REQUIRED, PROJECT_LOCAL_ONLY, ROUTE_CHANGED, TOKEN_INVALID,
    TOKEN_MISMATCH,
};
pub use embedder::{
    next_backoff, run_embedder, CloudEmbeddingEstimate, EmbedderConfig, EmbedderShared,
    EmbedderSnapshot, EmbeddingState, EmbeddingStatus,
};
pub use error::{CoreError, Result};
pub use formats::{
    detect_format, detect_media_file, kind_for_file_name, DetectedFormat, DocumentKind,
    MEDIA_IMPORT_MAX_BYTES,
};
pub use jobs::{
    run_worker, ClaimedJob, Job, JobState, WorkerConfig, JOBS_LIST_MAX, JOB_KIND_EXTRACT_TEXT,
};
pub use keys::{
    keyring_unavailable, validate_api_key, KeyringStatus, Keys, SecretStore, SystemKeyring,
    API_KEY_MAX, KEYRING_SERVICE,
};
pub use library::{
    check_kind_size, check_size, DocumentVersion, Folder, ImportFile, ImportOutcome,
    LibraryDocument, NewFolder, TextStatus, TextUnit, TranscriptionInfo, FILE_NAME_MAX,
    IMPORT_MAX_BYTES,
};
pub use links::{MediaLink, MediaLinkInput, Region, LINK_NOTE_MAX};
pub use llm::{
    LlmClient, LlmStatus, ModelInfo, ModelKind, PromptMessage, SseParser, StreamEnd,
    CONNECT_TIMEOUT, EMBED_BATCH_MAX, SHORT_TIMEOUT,
};
pub use media::{
    decode_to_whisper, DecodeError, DecodedAudio, TRANSCRIBE_MAX_MS, WHISPER_SAMPLE_RATE,
};
pub use mesh::{
    client_for, missing_key_message, CloudClient, ModelClient, CLOUD_MAX_OUTPUT_TOKENS, TEMPERATURE,
};
#[cfg(debug_assertions)]
pub use models::TEST_HF_BASE_URL_VAR;
pub use models::{
    allowed_hf_url, catalog as whisper_catalog, ModelManager, ModelSpec, WhisperModel,
    WhisperModelId, HF_ORIGIN, MODELS_DIR,
};
pub use prices::{estimate_tokens, validate_price, ModelPrice, Money, Usage, PRICE_MAX};
pub use prism::{
    route, LocalModels, RouteDecision, RouteInputs, LOCAL_ONLY_CLOUD_MODEL, MANUAL_REASON,
    NO_CHAT_MODEL,
};
pub use providers::{
    check_https_host, CloudPolicy, CloudProvider, Endpoints, ModelRef, ProviderId,
    CLOUD_CONNECT_TIMEOUT,
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
pub use settings::{
    validate_base_url, validate_llm_settings, LlmSettings, Routing, AUTO_MODELS_MAX,
    DEFAULT_BASE_URL,
};
pub use store::{NewProject, Project, Store, ORIGINALS_DIR, SCHEMA_VERSION};
pub use transcribe::{
    format_timestamp, parse_language, run_transcriber, segment_passages, ClaimedTranscription,
    TranscriberConfig, TranscriptSegment, TranscriptionOutcome, EXTRACTION_CANCELLED,
    JOB_KIND_TRANSCRIBE, MODEL_NOT_INSTALLED, TRANSCRIPTION_CANCELLED, TRANSCRIPTION_INTERRUPTED,
};
pub use uploads::{
    BeginUpload, FinishedUpload, UploadHandle, Uploads, UPLOADS_DIR, UPLOADS_MAX,
    UPLOAD_CHUNK_BYTES, UPLOAD_IDLE_TIMEOUT,
};
pub use validation::{validate_description, validate_name, DESCRIPTION_MAX, NAME_MAX};
pub use whisper::{
    default_threads, is_non_speech, Language, Recognized, RecognizedSegment, TranscribeError,
    TranscribeRequest, Transcriber, WhisperTranscriber,
};
