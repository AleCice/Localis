use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, ErrorCode, OptionalExtension, TransactionBehavior};

use crate::blobs::BlobStore;
use crate::error::{CoreError, Result};
use crate::providers::CloudPolicy;
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
    // 2: document library (folders, documents, versions, extracted text + FTS, jobs)
    "CREATE TABLE folders (
        id          TEXT PRIMARY KEY NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        parent_id   TEXT REFERENCES folders (id),
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE INDEX folders_project ON folders (project_id);
    CREATE INDEX folders_parent ON folders (parent_id);

    CREATE TABLE documents (
        id          TEXT PRIMARY KEY NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        folder_id   TEXT REFERENCES folders (id),
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE INDEX documents_project ON documents (project_id);
    CREATE INDEX documents_folder ON documents (folder_id);

    CREATE TABLE document_versions (
        id                  TEXT PRIMARY KEY NOT NULL,
        document_id         TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        version_no          INTEGER NOT NULL CHECK (version_no >= 1),
        original_name       TEXT NOT NULL,
        kind                TEXT NOT NULL
                            CHECK (kind IN ('pdf', 'text', 'markdown', 'docx', 'image')),
        media_type          TEXT NOT NULL,
        size_bytes          INTEGER NOT NULL,
        sha256              TEXT NOT NULL,
        source_modified_at  TEXT,
        imported_at         TEXT NOT NULL,
        text_status         TEXT NOT NULL
                            CHECK (text_status IN
                                ('pending', 'extracted', 'no_text', 'failed', 'not_applicable')),
        page_count          INTEGER,
        image_width         INTEGER,
        image_height        INTEGER,
        UNIQUE (document_id, version_no)
    );
    CREATE INDEX document_versions_sha256 ON document_versions (sha256);

    CREATE TABLE document_text (
        id          INTEGER PRIMARY KEY,
        version_id  TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
        unit        INTEGER NOT NULL,
        text        TEXT NOT NULL,
        UNIQUE (version_id, unit)
    );

    CREATE VIRTUAL TABLE document_text_fts USING fts5 (
        text,
        content = 'document_text',
        content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER document_text_ai AFTER INSERT ON document_text BEGIN
        INSERT INTO document_text_fts (rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER document_text_ad AFTER DELETE ON document_text BEGIN
        INSERT INTO document_text_fts (document_text_fts, rowid, text)
        VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER document_text_au AFTER UPDATE ON document_text BEGIN
        INSERT INTO document_text_fts (document_text_fts, rowid, text)
        VALUES ('delete', old.id, old.text);
        INSERT INTO document_text_fts (rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TABLE jobs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id    TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN ('extract_text')),
        state         TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        error         TEXT,
        error_detail  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
    );
    CREATE INDEX jobs_state ON jobs (state, id);
    CREATE INDEX jobs_version ON jobs (version_id);",
    // 3: local chat with sources (settings, passages + FTS, embeddings, conversations)
    "CREATE TABLE settings (
        key    TEXT PRIMARY KEY NOT NULL,
        value  TEXT NOT NULL
    );

    CREATE TABLE chunks (
        id          INTEGER PRIMARY KEY,
        version_id  TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
        unit        INTEGER NOT NULL,
        ordinal     INTEGER NOT NULL,
        char_start  INTEGER NOT NULL,
        char_end    INTEGER NOT NULL,
        text        TEXT NOT NULL,
        UNIQUE (version_id, unit, ordinal)
    );

    CREATE VIRTUAL TABLE chunks_fts USING fts5 (
        text,
        content = 'chunks',
        content_rowid = 'id',
        tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TABLE chunk_embeddings (
        chunk_id  INTEGER NOT NULL REFERENCES chunks (id) ON DELETE CASCADE,
        model     TEXT NOT NULL,
        dim       INTEGER NOT NULL CHECK (dim > 0),
        vector    BLOB NOT NULL,
        PRIMARY KEY (chunk_id, model)
    );
    CREATE INDEX chunk_embeddings_model ON chunk_embeddings (model);

    CREATE TABLE conversations (
        id          TEXT PRIMARY KEY NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE INDEX conversations_project ON conversations (project_id, updated_at);

    CREATE TABLE messages (
        id                  TEXT PRIMARY KEY NOT NULL,
        conversation_id     TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        seq                 INTEGER NOT NULL,
        role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        kind                TEXT NOT NULL CHECK (kind IN
                                ('question', 'answer', 'inventory', 'clarification', 'no_evidence')),
        content             TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN
                                ('complete', 'streaming', 'cancelled', 'error')),
        error_code          TEXT,
        error_message       TEXT,
        error_detail        TEXT,
        model               TEXT,
        retrieval_mode      TEXT CHECK (retrieval_mode IN ('lexical', 'hybrid')),
        retrieval_scope     TEXT CHECK (retrieval_scope IN ('project', 'documents')),
        scope_reason        TEXT CHECK (scope_reason IN ('selection', 'title', 'history')),
        scope_document_ids  TEXT,
        embedding_model     TEXT,
        retrieval_query     TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (conversation_id, seq)
    );
    CREATE INDEX messages_status ON messages (status);

    CREATE TABLE message_sources (
        message_id   TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        rank         INTEGER NOT NULL CHECK (rank >= 1),
        n            INTEGER CHECK (n >= 1),
        cited        INTEGER NOT NULL DEFAULT 0 CHECK (cited IN (0, 1)),
        document_id  TEXT NOT NULL,
        version_id   TEXT NOT NULL,
        title        TEXT NOT NULL,
        unit         INTEGER NOT NULL,
        unit_kind    TEXT NOT NULL CHECK (unit_kind IN ('page', 'block')),
        text         TEXT NOT NULL,
        via          TEXT NOT NULL CHECK (via IN ('lexical', 'semantic', 'both', 'position')),
        PRIMARY KEY (message_id, rank)
    );

    CREATE TABLE message_candidates (
        message_id   TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        position     INTEGER NOT NULL,
        document_id  TEXT NOT NULL,
        title        TEXT NOT NULL,
        PRIMARY KEY (message_id, position)
    );",
    // 4: optional cloud (Model Mesh + PRISM): project policy and consent, models stored as
    // {provider, model}, embeddings keyed by provider:model, prices, cloud request log.
    // No column ever holds an API key (they live in the system keychain).
    "ALTER TABLE projects ADD COLUMN cloud_policy TEXT NOT NULL DEFAULT 'local_only'
        CHECK (cloud_policy IN ('local_only', 'cloud_allowed'));
    ALTER TABLE projects ADD COLUMN cloud_embedding_consent INTEGER NOT NULL DEFAULT 0
        CHECK (cloud_embedding_consent IN (0, 1));

    UPDATE settings SET value = json_object('provider', 'lmstudio', 'model', value)
    WHERE key IN ('llm.chat_model', 'llm.embedding_model');

    UPDATE chunk_embeddings SET model = 'lmstudio:' || model;

    ALTER TABLE messages ADD COLUMN provider TEXT;
    ALTER TABLE messages ADD COLUMN route_reason TEXT;
    ALTER TABLE messages ADD COLUMN input_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN output_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN cost_amount REAL;
    ALTER TABLE messages ADD COLUMN cost_currency TEXT;
    ALTER TABLE messages ADD COLUMN embedding_provider TEXT;
    UPDATE messages SET provider = 'lmstudio' WHERE model IS NOT NULL;
    UPDATE messages SET embedding_provider = 'lmstudio' WHERE embedding_model IS NOT NULL;

    CREATE TABLE model_prices (
        provider         TEXT NOT NULL,
        model            TEXT NOT NULL,
        input_per_mtok   REAL NOT NULL CHECK (input_per_mtok >= 0),
        output_per_mtok  REAL NOT NULL CHECK (output_per_mtok >= 0),
        currency         TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (provider, model)
    );

    CREATE TABLE cloud_requests (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at       TEXT NOT NULL,
        provider         TEXT NOT NULL,
        model            TEXT,
        purpose          TEXT NOT NULL CHECK (purpose IN
                             ('chat', 'query_embedding', 'index_embedding', 'list_models')),
        project_id       TEXT REFERENCES projects (id) ON DELETE SET NULL,
        conversation_id  TEXT REFERENCES conversations (id) ON DELETE SET NULL,
        chars_sent       INTEGER NOT NULL CHECK (chars_sent >= 0),
        input_tokens     INTEGER,
        output_tokens    INTEGER,
        cost_amount      REAL,
        cost_currency    TEXT,
        ok               INTEGER NOT NULL CHECK (ok IN (0, 1)),
        error            TEXT
    );
    CREATE INDEX cloud_requests_project ON cloud_requests (project_id);
    CREATE INDEX cloud_requests_conversation ON cloud_requests (conversation_id);",
    // 5: lectures (FARO base): audio/video versions with duration, transcription jobs with
    // progress, transcripts (segments also feed document_text/chunks, hence FTS and
    // embeddings), manual media links, segment sources in chat. CHECK constraints cannot be
    // altered in SQLite, so three tables are rebuilt (foreign keys are off while migrating,
    // see `Store::migrate`; rows, ids and indexes are preserved).
    "CREATE TABLE document_versions_v5 (
        id                  TEXT PRIMARY KEY NOT NULL,
        document_id         TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        version_no          INTEGER NOT NULL CHECK (version_no >= 1),
        original_name       TEXT NOT NULL,
        kind                TEXT NOT NULL CHECK (kind IN
                                ('pdf', 'text', 'markdown', 'docx', 'image', 'audio', 'video')),
        media_type          TEXT NOT NULL,
        size_bytes          INTEGER NOT NULL,
        sha256              TEXT NOT NULL,
        source_modified_at  TEXT,
        imported_at         TEXT NOT NULL,
        text_status         TEXT NOT NULL
                            CHECK (text_status IN
                                ('pending', 'extracted', 'no_text', 'failed', 'not_applicable')),
        page_count          INTEGER,
        image_width         INTEGER,
        image_height        INTEGER,
        duration_ms         INTEGER CHECK (duration_ms >= 0),
        UNIQUE (document_id, version_no)
    );
    INSERT INTO document_versions_v5 (id, document_id, version_no, original_name, kind,
        media_type, size_bytes, sha256, source_modified_at, imported_at, text_status,
        page_count, image_width, image_height)
    SELECT id, document_id, version_no, original_name, kind, media_type, size_bytes, sha256,
        source_modified_at, imported_at, text_status, page_count, image_width, image_height
    FROM document_versions;
    DROP TABLE document_versions;
    ALTER TABLE document_versions_v5 RENAME TO document_versions;
    CREATE INDEX document_versions_sha256 ON document_versions (sha256);

    CREATE TABLE jobs_v5 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id    TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN ('extract_text', 'transcribe')),
        state         TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        error         TEXT,
        error_detail  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        progress      INTEGER CHECK (progress BETWEEN 0 AND 100),
        model         TEXT,
        language      TEXT
    );
    INSERT INTO jobs_v5 (id, version_id, kind, state, attempts, error, error_detail,
        created_at, updated_at)
    SELECT id, version_id, kind, state, attempts, error, error_detail, created_at, updated_at
    FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_v5 RENAME TO jobs;
    CREATE INDEX jobs_state ON jobs (state, id);
    CREATE INDEX jobs_version ON jobs (version_id);
    CREATE INDEX jobs_kind_state ON jobs (kind, state, id);

    CREATE TABLE message_sources_v5 (
        message_id   TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        rank         INTEGER NOT NULL CHECK (rank >= 1),
        n            INTEGER CHECK (n >= 1),
        cited        INTEGER NOT NULL DEFAULT 0 CHECK (cited IN (0, 1)),
        document_id  TEXT NOT NULL,
        version_id   TEXT NOT NULL,
        title        TEXT NOT NULL,
        unit         INTEGER NOT NULL,
        unit_kind    TEXT NOT NULL CHECK (unit_kind IN ('page', 'block', 'segment')),
        text         TEXT NOT NULL,
        via          TEXT NOT NULL CHECK (via IN ('lexical', 'semantic', 'both', 'position')),
        start_ms     INTEGER,
        PRIMARY KEY (message_id, rank)
    );
    INSERT INTO message_sources_v5 (message_id, rank, n, cited, document_id, version_id,
        title, unit, unit_kind, text, via)
    SELECT message_id, rank, n, cited, document_id, version_id, title, unit, unit_kind, text,
        via
    FROM message_sources;
    DROP TABLE message_sources;
    ALTER TABLE message_sources_v5 RENAME TO message_sources;

    CREATE TABLE transcriptions (
        version_id     TEXT PRIMARY KEY NOT NULL
                       REFERENCES document_versions (id) ON DELETE CASCADE,
        model          TEXT NOT NULL,
        language       TEXT NOT NULL,
        segment_count  INTEGER NOT NULL CHECK (segment_count >= 0),
        created_at     TEXT NOT NULL
    );

    CREATE TABLE transcript_segments (
        version_id  TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
        idx         INTEGER NOT NULL CHECK (idx >= 1),
        start_ms    INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms      INTEGER NOT NULL CHECK (end_ms >= start_ms),
        text        TEXT NOT NULL,
        PRIMARY KEY (version_id, idx)
    );

    CREATE TABLE media_links (
        id                  TEXT PRIMARY KEY NOT NULL,
        project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        media_document_id   TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        media_version_id    TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
        start_ms            INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms              INTEGER NOT NULL CHECK (end_ms > start_ms),
        target_document_id  TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        target_version_id   TEXT NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
        target_page         INTEGER CHECK (target_page >= 1),
        region_x            REAL,
        region_y            REAL,
        region_w            REAL,
        region_h            REAL,
        note                TEXT,
        media_title         TEXT NOT NULL,
        target_title        TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        CHECK ((region_x IS NULL AND region_y IS NULL AND region_w IS NULL AND region_h IS NULL)
            OR (region_x >= 0 AND region_y >= 0 AND region_w > 0 AND region_h > 0
                AND region_x + region_w <= 1.000001 AND region_y + region_h <= 1.000001))
    );
    CREATE INDEX media_links_media ON media_links (media_version_id, start_ms);
    CREATE INDEX media_links_target ON media_links (target_version_id);
    CREATE INDEX media_links_project ON media_links (project_id);
    CREATE INDEX media_links_media_document ON media_links (media_document_id);
    CREATE INDEX media_links_target_document ON media_links (target_document_id);",
];

/// Schema version this build of the app knows about.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const OPEN_MESSAGE: &str = "Impossibile aprire il database.";
const NEWER_SCHEMA_MESSAGE: &str =
    "Il database è stato creato da una versione più recente di Localis.";
const DUPLICATE_MESSAGE: &str = "Esiste già un progetto con questo nome.";
const NOT_FOUND_MESSAGE: &str = "Il progetto non esiste più.";
const CONSENT_NEEDS_CLOUD: &str =
    "Per dare il consenso all'indicizzazione cloud consenti prima l'uso del cloud nel progetto.";
const PROJECT_COLUMNS: &str =
    "id, name, description, created_at, updated_at, cloud_policy, cloud_embedding_consent";

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
    /// `LocalOnly` (default): nothing of the project is ever sent to a cloud provider.
    pub cloud_policy: CloudPolicy,
    /// Consent to index the project's passages with the configured cloud embedding model.
    pub cloud_embedding_consent: bool,
}

/// Unvalidated input for [`Store::create_project`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewProject {
    pub name: String,
    pub description: Option<String>,
}

/// Name of the originals directory, next to the database file.
pub const ORIGINALS_DIR: &str = "originals";

/// SQLite-backed storage for Localis, plus the archive of imported originals.
#[derive(Debug)]
pub struct Store {
    pub(crate) conn: Connection,
    /// `None` only for in-memory stores opened without an originals directory.
    blobs: Option<BlobStore>,
}

impl Store {
    /// Opens (or creates) the database at `path`, creating the parent directory if
    /// needed, and applies pending migrations. Originals are kept in
    /// [`ORIGINALS_DIR`] next to the database file (created on first import).
    pub fn open(path: &Path) -> Result<Self> {
        let parent = path.parent().unwrap_or(Path::new(""));
        Self::open_with_originals(path, &parent.join(ORIGINALS_DIR))
    }

    /// Like [`Store::open`], with an explicit originals directory.
    pub fn open_with_originals(path: &Path, originals_dir: &Path) -> Result<Self> {
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
        Self::init(conn, Some(BlobStore::new(originals_dir.to_path_buf())))
    }

    /// Opens a private in-memory database without an originals directory: importing
    /// documents fails (for tests and tooling that only need projects).
    pub fn open_in_memory() -> Result<Self> {
        let conn =
            Connection::open_in_memory().map_err(|err| CoreError::storage(OPEN_MESSAGE, err))?;
        Self::init(conn, None)
    }

    /// Opens a private in-memory database with originals kept in `originals_dir`.
    pub fn open_in_memory_with_originals(originals_dir: &Path) -> Result<Self> {
        let conn =
            Connection::open_in_memory().map_err(|err| CoreError::storage(OPEN_MESSAGE, err))?;
        Self::init(conn, Some(BlobStore::new(originals_dir.to_path_buf())))
    }

    fn init(conn: Connection, blobs: Option<BlobStore>) -> Result<Self> {
        conn.busy_timeout(BUSY_TIMEOUT)
            .and_then(|()| conn.pragma_update(None, "foreign_keys", true))
            .map_err(|err| CoreError::storage(OPEN_MESSAGE, err))?;
        let mut store = Store { conn, blobs };
        store.migrate()?;
        Ok(store)
    }

    pub(crate) fn blobs(&self) -> Result<&BlobStore> {
        self.blobs
            .as_ref()
            .ok_or_else(|| CoreError::Internal("no originals directory configured".into()))
    }

    /// Directory holding the originals, if configured.
    pub fn originals_dir(&self) -> Option<&Path> {
        self.blobs.as_ref().map(BlobStore::root)
    }

    /// Removes temporary files left in the originals directory by an interrupted import.
    pub fn sweep_temp_files(&self) {
        if let Some(blobs) = &self.blobs {
            blobs.sweep_temp_files();
        }
    }

    /// Deletes the originals among `candidates` no version references any more.
    /// Never fails: errors are logged.
    pub(crate) fn gc_blobs(&self, candidates: impl IntoIterator<Item = String>) {
        let Some(blobs) = &self.blobs else {
            return;
        };
        let mut seen = std::collections::HashSet::new();
        for sha in candidates {
            if !seen.insert(sha.clone()) {
                continue;
            }
            let referenced = self.conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM document_versions WHERE sha256 = ?1)",
                params![sha],
                |row| row.get::<_, bool>(0),
            );
            match referenced {
                Ok(false) => blobs.remove(&sha),
                Ok(true) => {}
                Err(err) => eprintln!("localis: blob gc: cannot check {sha}: {err}"),
            }
        }
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
        // Table rebuilds (migration 5) must not fire ON DELETE CASCADE: foreign keys are
        // off while migrating (the pragma is a no-op inside a transaction, so it is set
        // here) and the result is checked before they are turned back on.
        self.conn
            .pragma_update(None, "foreign_keys", false)
            .map_err(open_err)?;
        let result = self.apply_migrations();
        let check = self.foreign_key_violations();
        self.conn
            .pragma_update(None, "foreign_keys", true)
            .map_err(open_err)?;
        result?;
        // The migrations only copy rows that already satisfied the constraints; a violation
        // would be a bug, logged rather than making the database unopenable.
        match check {
            Ok(0) => {}
            Ok(n) => eprintln!("localis: {n} foreign key violations after migrating"),
            Err(err) => eprintln!("localis: cannot check foreign keys after migrating: {err}"),
        }
        Ok(())
    }

    fn foreign_key_violations(&self) -> rusqlite::Result<usize> {
        let mut stmt = self.conn.prepare("PRAGMA foreign_key_check")?;
        let mut rows = stmt.query([])?;
        let mut n = 0;
        while rows.next()?.is_some() {
            n += 1;
        }
        Ok(n)
    }

    fn apply_migrations(&mut self) -> Result<()> {
        let open_err = |err: rusqlite::Error| CoreError::storage(OPEN_MESSAGE, err);
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
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {PROJECT_COLUMNS} FROM projects
             ORDER BY updated_at DESC, created_at DESC, id ASC"
        ))?;
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

        let now = now(&tx)?;
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            description,
            created_at: now.clone(),
            updated_at: now,
            cloud_policy: CloudPolicy::LocalOnly,
            cloud_embedding_consent: false,
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

    /// Deletes the project with its folders, documents, versions, text, jobs and
    /// conversations, then
    /// removes the originals no other project references. Never touches user files.
    pub fn delete_project(&mut self, id: &str) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let shas = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT v.sha256 FROM document_versions v
                 JOIN documents d ON d.id = v.document_id
                 WHERE d.project_id = ?1",
            )?;
            let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let changed = tx.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        if changed == 0 {
            return Err(CoreError::NotFound {
                message: NOT_FOUND_MESSAGE.to_owned(),
            });
        }
        tx.commit()?;
        self.gc_blobs(shas);
        Ok(())
    }

    pub fn get_project(&self, id: &str) -> Result<Project> {
        self.conn
            .query_row(
                &format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1"),
                params![id],
                row_to_project,
            )
            .optional()?
            .ok_or_else(|| CoreError::not_found(NOT_FOUND_MESSAGE))
    }

    /// Sets whether the project may use cloud providers. `LocalOnly` also revokes the
    /// consent to cloud indexing.
    pub fn set_project_cloud_policy(&mut self, id: &str, policy: CloudPolicy) -> Result<Project> {
        let now = now(&self.conn)?;
        let changed = self.conn.execute(
            "UPDATE projects SET cloud_policy = ?2,
                 cloud_embedding_consent = CASE WHEN ?2 = 'local_only' THEN 0
                                                ELSE cloud_embedding_consent END,
                 updated_at = ?3
             WHERE id = ?1",
            params![id, policy.as_str(), now],
        )?;
        if changed == 0 {
            return Err(CoreError::not_found(NOT_FOUND_MESSAGE));
        }
        self.get_project(id)
    }

    /// Gives or revokes the consent to index the project with the cloud embedding model.
    /// Giving it requires `CloudAllowed` (`conflict` otherwise).
    pub fn set_cloud_embedding_consent(&mut self, id: &str, consent: bool) -> Result<Project> {
        let project = self.get_project(id)?;
        if consent && project.cloud_policy != CloudPolicy::CloudAllowed {
            return Err(CoreError::conflict(CONSENT_NEEDS_CLOUD));
        }
        let now = now(&self.conn)?;
        self.conn.execute(
            "UPDATE projects SET cloud_embedding_consent = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, consent, now],
        )?;
        self.get_project(id)
    }

    /// Checks that the project exists.
    pub(crate) fn ensure_project(&self, id: &str) -> Result<()> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )?;
        if exists {
            Ok(())
        } else {
            Err(CoreError::not_found(NOT_FOUND_MESSAGE))
        }
    }
}

/// Current time as ISO 8601 UTC with milliseconds.
pub(crate) fn now(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| {
        r.get(0)
    })
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
    let policy: String = row.get(5)?;
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        // Anything unexpected is treated as the safe default.
        cloud_policy: CloudPolicy::parse(&policy).unwrap_or_default(),
        cloud_embedding_consent: row.get(6)?,
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

    /// A v0.4 database (migrations 1–4 exactly as released) with data in every table that
    /// migration 5 rebuilds.
    fn v04_database(path: &Path) {
        let conn = Connection::open(path).unwrap();
        for sql in &MIGRATIONS[..4] {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             INSERT INTO projects (id, name, created_at, updated_at, cloud_policy)
               VALUES ('p', 'Tesi', 't0', 't0', 'cloud_allowed');
             INSERT INTO folders VALUES ('f', 'p', NULL, 'Fonti', 't0', 't0');
             INSERT INTO documents VALUES ('d', 'p', 'f', 'note.txt', 't0', 't0');
             INSERT INTO document_versions VALUES ('v', 'd', 1, 'note.txt', 'text',
               'text/plain', 5, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
               NULL, 't0', 'extracted', NULL, NULL, NULL);
             INSERT INTO document_text (version_id, unit, text) VALUES ('v', 1, 'derivata prima');
             INSERT INTO jobs (id, version_id, kind, state, attempts, created_at, updated_at)
               VALUES (41, 'v', 'extract_text', 'done', 1, 't0', 't0');
             INSERT INTO chunks (version_id, unit, ordinal, char_start, char_end, text)
               VALUES ('v', 1, 1, 0, 14, 'derivata prima');
             INSERT INTO chunk_embeddings VALUES (1, 'lmstudio:e', 2, x'0000803f00000000');
             INSERT INTO conversations VALUES ('c', 'p', 'Domanda', 't0', 't0');
             INSERT INTO messages (id, conversation_id, seq, role, kind, content, status,
               created_at, updated_at) VALUES ('m', 'c', 2, 'assistant', 'answer', 'R [1]',
               'complete', 't0', 't0');
             INSERT INTO message_sources VALUES ('m', 1, 1, 1, 'd', 'v', 'note.txt', 1, 'block',
               'derivata prima', 'lexical');
             PRAGMA user_version = 4;",
        )
        .unwrap();
    }

    #[test]
    fn migration_4_to_5_keeps_data_and_constraints() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("localis.db");
        v04_database(&path);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), 5);
        // Rows survived the rebuilds, nothing cascaded away.
        let count = |store: &Store, sql: &str| -> i64 {
            store.conn.query_row(sql, [], |r| r.get(0)).unwrap()
        };
        for (table, n) in [
            ("document_versions", 1),
            ("document_text", 1),
            ("jobs", 1),
            ("chunks", 1),
            ("chunk_embeddings", 1),
            ("message_sources", 1),
            ("transcriptions", 0),
            ("media_links", 0),
        ] {
            assert_eq!(
                count(&store, &format!("SELECT COUNT(*) FROM {table}")),
                n,
                "{table}"
            );
        }
        assert_eq!(store.foreign_key_violations().unwrap(), 0);
        let fk: i64 = store
            .conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "foreign keys back on after migrating");
        let v = store.get_version("v").unwrap();
        assert_eq!((v.duration_ms, v.transcription.is_none()), (None, true));
        let job = store.get_job(41).unwrap();
        assert_eq!((job.kind.as_str(), job.progress), ("extract_text", None));
        // FTS and passages still work.
        assert_eq!(store.search("p", "derivata", None).unwrap().len(), 1);
        let messages = store.list_messages("c").unwrap();
        assert_eq!(messages[0].sources.len(), 1);
        assert_eq!(messages[0].sources[0].start_ms, None);
        assert!(messages[0].sources[0].available);
        // The new CHECKs accept the new values; AUTOINCREMENT continues after the old ids.
        store
            .conn
            .execute_batch(
                "INSERT INTO document_versions (id, document_id, version_no, original_name, kind,
                   media_type, size_bytes, sha256, imported_at, text_status, duration_ms)
                 VALUES ('a', 'd', 2, 'l.mp3', 'audio', 'audio/mpeg', 1, 'x', 't', 'pending', 5);
                 INSERT INTO jobs (version_id, kind, state, created_at, updated_at, progress)
                 VALUES ('a', 'transcribe', 'running', 't', 't', 40);",
            )
            .unwrap();
        assert_eq!(store.conn.last_insert_rowid(), 42);
        assert!(store
            .conn
            .execute(
                "INSERT INTO jobs (version_id, kind, state, created_at, updated_at, progress)
                 VALUES ('a', 'transcribe', 'running', 't', 't', 101)",
                [],
            )
            .is_err());
        // Cascades through the rebuilt tables.
        store.delete_document("d").unwrap();
        for table in [
            "document_versions",
            "document_text",
            "jobs",
            "chunks",
            "chunk_embeddings",
        ] {
            assert_eq!(
                count(&store, &format!("SELECT COUNT(*) FROM {table}")),
                0,
                "{table}"
            );
        }
        // Snapshots in message sources outlive the document.
        assert!(!store.list_messages("c").unwrap()[0].sources[0].available);
        drop(store);
        // Reopening does not migrate again.
        assert_eq!(Store::open(&path).unwrap().schema_version().unwrap(), 5);
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
