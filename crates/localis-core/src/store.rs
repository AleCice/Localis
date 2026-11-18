use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, ErrorCode, TransactionBehavior};

use crate::error::{CoreError, Result};
use crate::validation::{name_key, validate_description, validate_name};

/// Ordered schema migrations. Migration `i` (0-based) brings `user_version` to `i + 1`.
/// Never edit an entry once released: append a new one instead.
const MIGRATIONS: &[&str] = &[
    // 1: projects
    "CREATE TABLE projects (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX projects_name_nocase ON projects (name COLLATE NOCASE);",
];

/// Schema version this build of the app knows about.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const OPEN_MESSAGE: &str = "Impossibile aprire il database.";
const NEWER_SCHEMA_MESSAGE: &str =
    "Il database è stato creato da una versione più recente di Localis.";
const DUPLICATE_MESSAGE: &str = "Esiste già un progetto con questo nome.";
const NOT_FOUND_MESSAGE: &str = "Il progetto non esiste più.";

/// A project as stored in the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// UUID v4.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// ISO 8601 UTC with milliseconds, e.g. `2026-01-31T12:00:00.000Z`.
    pub created_at: String,
    /// ISO 8601 UTC with milliseconds.
    pub updated_at: String,
}

/// Unvalidated input for [`Store::create_project`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewProject {
    pub name: String,
    pub description: Option<String>,
}

/// SQLite-backed storage for Localis.
#[derive(Debug)]
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Opens (or creates) the database at `path`, creating the parent directory if
    /// needed, and applies pending migrations.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|err| {
                CoreError::storage(
                    OPEN_MESSAGE,
                    format!("cannot create directory {}: {err}", parent.display()),
                )
            })?;
        }
        let conn = Connection::open(path).map_err(|err| {
            CoreError::storage(OPEN_MESSAGE, format!("{}: {err}", path.display()))
        })?;
        let mode: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
            .map_err(|err| CoreError::storage(OPEN_MESSAGE, err))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(CoreError::storage(
                OPEN_MESSAGE,
                format!("cannot enable WAL journal mode (got {mode})"),
            ));
        }
        Self::init(conn)
    }

    /// Opens a private in-memory database (for tests and tooling).
    pub fn open_in_memory() -> Result<Self> {
        let conn =
            Connection::open_in_memory().map_err(|err| CoreError::storage(OPEN_MESSAGE, err))?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.busy_timeout(BUSY_TIMEOUT)
            .and_then(|()| conn.pragma_update(None, "foreign_keys", true))
            .map_err(|err| CoreError::storage(OPEN_MESSAGE, err))?;
        let mut store = Store { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Current `user_version` of the database.
    pub fn schema_version(&self) -> Result<u32> {
        Ok(user_version(&self.conn)?)
    }

    fn migrate(&mut self) -> Result<()> {
        let open_err = |err: rusqlite::Error| CoreError::storage(OPEN_MESSAGE, err);
        // Fast path: refuse newer schemas and skip the write lock when up to date.
        let current = user_version(&self.conn).map_err(open_err)?;
        check_not_newer(current)?;
        if current == SCHEMA_VERSION {
            return Ok(());
        }
        for (index, sql) in MIGRATIONS.iter().enumerate() {
            let target = index as u32 + 1;
            // IMMEDIATE takes the write lock up front, so a concurrent opener cannot
            // apply the same migration twice: re-check the version inside the lock.
            let tx = self
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(open_err)?;
            let version = user_version(&tx).map_err(open_err)?;
            check_not_newer(version)?;
            if version >= target {
                continue;
            }
            tx.execute_batch(sql).map_err(|err| {
                CoreError::storage(OPEN_MESSAGE, format!("migration {target} failed: {err}"))
            })?;
            tx.pragma_update(None, "user_version", target)
                .map_err(open_err)?;
            tx.commit().map_err(open_err)?;
        }
        Ok(())
    }

    /// All projects, most recently updated first (then most recently created, then id).
    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description, created_at, updated_at
             FROM projects
             ORDER BY updated_at DESC, created_at DESC, id ASC",
        )?;
        let rows = stmt.query_map([], row_to_project)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Validates `input` and inserts a new project.
    pub fn create_project(&mut self, input: NewProject) -> Result<Project> {
        let name = validate_name(&input.name)?;
        let description = validate_description(input.description.as_deref())?;

        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        // SQLite's NOCASE only folds ASCII: check with Unicode-aware lowercasing too.
        let key = name_key(&name);
        let duplicate = {
            let mut stmt = tx.prepare("SELECT name FROM projects")?;
            let mut rows = stmt.query([])?;
            let mut found = false;
            while let Some(row) = rows.next()? {
                if name_key(&row.get::<_, String>(0)?) == key {
                    found = true;
                    break;
                }
            }
            found
        };
        if duplicate {
            return Err(duplicate_name());
        }

        let now: String =
            tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| {
                r.get(0)
            })?;
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            description,
            created_at: now.clone(),
            updated_at: now,
        };
        tx.execute(
            "INSERT INTO projects (id, name, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                project.id,
                project.name,
                project.description,
                project.created_at,
                project.updated_at
            ],
        )
        .map_err(map_unique_violation)?;
        tx.commit()?;
        Ok(project)
    }

    /// Deletes the project record with `id`. Never touches the filesystem.
    pub fn delete_project(&mut self, id: &str) -> Result<()> {
        let changed = self
            .conn
            .execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        if changed == 0 {
            return Err(CoreError::NotFound {
                message: NOT_FOUND_MESSAGE.to_owned(),
            });
        }
        Ok(())
    }
}

fn user_version(conn: &Connection) -> rusqlite::Result<u32> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

fn check_not_newer(version: u32) -> Result<()> {
    if version > SCHEMA_VERSION {
        return Err(CoreError::storage(
            NEWER_SCHEMA_MESSAGE,
            format!("database schema version {version} is newer than supported {SCHEMA_VERSION}"),
        ));
    }
    Ok(())
}

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn duplicate_name() -> CoreError {
    CoreError::Duplicate {
        field: "name",
        message: DUPLICATE_MESSAGE.to_owned(),
    }
}

fn map_unique_violation(err: rusqlite::Error) -> CoreError {
    match err.sqlite_error() {
        Some(e)
            if e.code == ErrorCode::ConstraintViolation
                && e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            duplicate_name()
        }
        _ => err.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_index_violation_maps_to_duplicate() {
        let mut store = Store::open_in_memory().unwrap();
        store
            .create_project(NewProject {
                name: "Tesi".into(),
                description: None,
            })
            .unwrap();
        // Bypass the application-level check to exercise the index mapping.
        let err = store
            .conn
            .execute(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('x', 'TESI', 'a', 'a')",
                [],
            )
            .map_err(map_unique_violation)
            .unwrap_err();
        assert!(matches!(err, CoreError::Duplicate { field: "name", .. }));
    }

    #[test]
    fn other_sqlite_errors_map_to_storage() {
        let store = Store::open_in_memory().unwrap();
        let err = store
            .conn
            .execute("INSERT INTO missing_table VALUES (1)", [])
            .map_err(map_unique_violation)
            .unwrap_err();
        match err {
            CoreError::Storage { message, detail } => {
                assert_eq!(message, "Impossibile salvare i dati. Riprova.");
                assert!(detail.contains("missing_table"));
            }
            other => panic!("expected storage error, got {other:?}"),
        }
    }

    #[test]
    fn foreign_keys_enabled() {
        let store = Store::open_in_memory().unwrap();
        let fk: i64 = store
            .conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
    }
}
