use thiserror::Error;

/// Errors returned by the core. `Display` yields a short, user-facing Italian message;
/// technical diagnostics are available through [`CoreError::detail`].
#[derive(Debug, Error)]
pub enum CoreError {
    /// Input rejected by validation.
    #[error("{message}")]
    Validation {
        field: &'static str,
        message: String,
    },
    /// Input conflicts with an existing record.
    #[error("{message}")]
    Duplicate {
        field: &'static str,
        message: String,
    },
    /// The requested record does not exist.
    #[error("{message}")]
    NotFound { message: String },
    /// The operation is not allowed in the current state (e.g. folder not empty).
    #[error("{message}")]
    Conflict { message: String },
    /// File format not supported, or extension and content do not match.
    #[error("{message}")]
    Unsupported { message: String },
    /// File over the import size limit.
    #[error("{message}")]
    TooLarge { message: String },
    /// Stored original missing or not matching its hash.
    #[error("{message}")]
    Integrity { message: String, detail: String },
    /// A model provider is not reachable, the key is invalid, no model is selected, or the
    /// model failed.
    #[error("{message}")]
    LlmUnavailable { message: String, detail: String },
    /// A cloud send without a valid confirmation, or a cloud path for a local-only project.
    #[error("{message}")]
    ConsentRequired { message: String },
    /// The system keychain cannot be used (API keys are never stored elsewhere).
    #[error("{message}")]
    KeyringUnavailable { message: String, detail: String },
    /// The operation was stopped by the user.
    #[error("{message}")]
    Cancelled { message: String },
    /// The database could not be opened, read or written.
    #[error("{message}")]
    Storage { message: String, detail: String },
    /// Unexpected condition (a bug, not a user or storage problem).
    #[error("Si è verificato un errore imprevisto.")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

pub(crate) const STORAGE_MESSAGE: &str = "Impossibile salvare i dati. Riprova.";

impl CoreError {
    pub(crate) fn validation(field: &'static str, message: &str) -> Self {
        CoreError::Validation {
            field,
            message: message.to_owned(),
        }
    }

    pub(crate) fn not_found(message: &str) -> Self {
        CoreError::NotFound {
            message: message.to_owned(),
        }
    }

    pub(crate) fn conflict(message: &str) -> Self {
        CoreError::Conflict {
            message: message.to_owned(),
        }
    }

    pub(crate) fn unsupported(message: impl Into<String>) -> Self {
        CoreError::Unsupported {
            message: message.into(),
        }
    }

    pub(crate) fn storage(message: &str, detail: impl ToString) -> Self {
        CoreError::Storage {
            message: message.to_owned(),
            detail: detail.to_string(),
        }
    }

    pub(crate) fn llm(message: impl Into<String>, detail: impl ToString) -> Self {
        CoreError::LlmUnavailable {
            message: message.into(),
            detail: detail.to_string(),
        }
    }

    pub(crate) fn consent(message: impl Into<String>) -> Self {
        CoreError::ConsentRequired {
            message: message.into(),
        }
    }

    /// Error code shared with the frontend (`AppErrorCode` in `src/api/types.ts`).
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Validation { .. } => "validation",
            CoreError::Duplicate { .. } => "duplicate",
            CoreError::NotFound { .. } => "not_found",
            CoreError::Conflict { .. } => "conflict",
            CoreError::Unsupported { .. } => "unsupported",
            CoreError::TooLarge { .. } => "too_large",
            CoreError::Integrity { .. } => "integrity",
            CoreError::LlmUnavailable { .. } => "llm_unavailable",
            CoreError::ConsentRequired { .. } => "consent_required",
            CoreError::KeyringUnavailable { .. } => "keyring_unavailable",
            CoreError::Cancelled { .. } => "cancelled",
            CoreError::Storage { .. } => "storage",
            CoreError::Internal(_) => "internal",
        }
    }

    /// Field concerned, for validation and duplicate errors.
    pub fn field(&self) -> Option<&'static str> {
        match self {
            CoreError::Validation { field, .. } | CoreError::Duplicate { field, .. } => Some(field),
            _ => None,
        }
    }

    /// Technical diagnostics, never meant for the main UI message.
    pub fn detail(&self) -> Option<&str> {
        match self {
            CoreError::Storage { detail, .. }
            | CoreError::Integrity { detail, .. }
            | CoreError::LlmUnavailable { detail, .. }
            | CoreError::KeyringUnavailable { detail, .. } => Some(detail),
            CoreError::Internal(detail) => Some(detail),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(err: rusqlite::Error) -> Self {
        CoreError::storage(STORAGE_MESSAGE, err)
    }
}
