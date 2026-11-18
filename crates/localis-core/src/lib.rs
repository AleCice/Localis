//! Localis domain logic and SQLite persistence. No Tauri dependency, so it can be
//! tested without GUI system libraries.

mod error;
mod store;
mod validation;

pub use error::{CoreError, Result};
pub use store::{NewProject, Project, Store, SCHEMA_VERSION};
pub use validation::{validate_description, validate_name, DESCRIPTION_MAX, NAME_MAX};
