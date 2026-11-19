use localis_core::CoreError;
use serde::Serialize;

/// Error codes shared with the frontend (`AppErrorCode` in `src/api/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Validation,
    Duplicate,
    NotFound,
    Conflict,
    Unsupported,
    TooLarge,
    Integrity,
    LlmUnavailable,
    Cancelled,
    Storage,
    Internal,
}

impl ErrorCode {
    /// Parses a code as produced by `CoreError::code` (unknown → `Internal`).
    pub fn parse(code: &str) -> Self {
        match code {
            "validation" => ErrorCode::Validation,
            "duplicate" => ErrorCode::Duplicate,
            "not_found" => ErrorCode::NotFound,
            "conflict" => ErrorCode::Conflict,
            "unsupported" => ErrorCode::Unsupported,
            "too_large" => ErrorCode::TooLarge,
            "integrity" => ErrorCode::Integrity,
            "llm_unavailable" => ErrorCode::LlmUnavailable,
            "cancelled" => ErrorCode::Cancelled,
            "storage" => ErrorCode::Storage,
            _ => ErrorCode::Internal,
        }
    }
}

/// Structured error returned by every command (`AppError` in `src/api/types.ts`).
/// `message` is short Italian text for the UI; `detail` carries diagnostics only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    /// A malformed request from the webview (bad header or body): not a user mistake,
    /// so the message is generic and the specifics go in `detail`.
    pub fn bad_request(detail: impl Into<String>) -> Self {
        AppError {
            code: ErrorCode::Validation,
            message: "Richiesta non valida.".to_owned(),
            field: None,
            detail: Some(detail.into()),
        }
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        AppError {
            code: ErrorCode::Internal,
            message: "Si è verificato un errore imprevisto.".to_owned(),
            field: None,
            detail: Some(detail.into()),
        }
    }
}

impl From<&localis_core::ErrorInfo> for AppError {
    /// An error stored on a chat message or sent in a chat event (already logged, if at all).
    fn from(info: &localis_core::ErrorInfo) -> Self {
        AppError {
            code: ErrorCode::parse(&info.code),
            message: info.message.clone(),
            field: None,
            detail: info.detail.clone(),
        }
    }
}

impl From<AppError> for CoreError {
    /// For the chat pipeline, which takes the store through `localis_core::StoreAccess`:
    /// only store-opening errors travel this way.
    fn from(err: AppError) -> Self {
        match err.code {
            ErrorCode::Internal => CoreError::Internal(err.detail.unwrap_or(err.message)),
            _ => CoreError::Storage {
                message: err.message,
                detail: err.detail.unwrap_or_default(),
            },
        }
    }
}

impl From<CoreError> for AppError {
    fn from(err: CoreError) -> Self {
        let code = match err {
            CoreError::Validation { .. } => ErrorCode::Validation,
            CoreError::Duplicate { .. } => ErrorCode::Duplicate,
            CoreError::NotFound { .. } => ErrorCode::NotFound,
            CoreError::Conflict { .. } => ErrorCode::Conflict,
            CoreError::Unsupported { .. } => ErrorCode::Unsupported,
            CoreError::TooLarge { .. } => ErrorCode::TooLarge,
            CoreError::Integrity { .. } => ErrorCode::Integrity,
            CoreError::LlmUnavailable { .. } => ErrorCode::LlmUnavailable,
            CoreError::Cancelled { .. } => ErrorCode::Cancelled,
            CoreError::Storage { .. } => ErrorCode::Storage,
            CoreError::Internal(_) => ErrorCode::Internal,
        };
        let app = AppError {
            code,
            message: err.to_string(),
            field: err.field().map(str::to_owned),
            detail: err.detail().map(str::to_owned),
        };
        // Diagnostics go to stderr only; the UI gets them in the separate `detail` field.
        if let Some(detail) = &app.detail {
            eprintln!("localis: {:?}: {detail}", app.code);
        }
        app
    }
}
