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

    pub(crate) fn storage(message: &str, detail: impl ToString) -> Self {
        CoreError::Storage {
            message: message.to_owned(),
            detail: detail.to_string(),
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
            CoreError::Storage { detail, .. } => Some(detail),
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
