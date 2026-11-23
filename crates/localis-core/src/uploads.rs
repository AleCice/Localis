//! v0.5 chunked import: the webview sends a file in consecutive blocks (raw IPC bodies of at
//! most [`UPLOAD_CHUNK_BYTES`]), which are appended to a temporary file inside the originals
//! directory while their sha256 is computed. Nothing is ever held whole in memory, and the
//! backend never reads a path chosen by the webview.
//!
//! Temporary files live in `<originals>/.uploads/<uuid>.part`. They are removed when the
//! upload is cancelled, finished (moved into the archive or discarded), after
//! [`UPLOAD_IDLE_TIMEOUT`] without activity, and at startup ([`Uploads::sweep_all`]).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::blobs::hex_digest;
use crate::error::{CoreError, Result};
use crate::formats::kind_for_file_name;
use crate::library::{check_kind_size, validate_file_name, ImportFile};

/// Size of the blocks the frontend sends (`UPLOAD_CHUNK_BYTES` in `src/api/types.ts`).
pub const UPLOAD_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
/// An upload with no block for this long is discarded.
pub const UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Directory of the temporary files, inside the originals directory.
pub const UPLOADS_DIR: &str = ".uploads";
/// Uploads in progress at the same time.
pub const UPLOADS_MAX: usize = 16;

const UPLOAD_NOT_FOUND: &str = "Il caricamento non è più attivo: riprova l'importazione.";
const OUT_OF_ORDER: &str = "Il file è arrivato in modo incompleto: riprova l'importazione.";
const OVER_SIZE: &str = "Il file ricevuto è più grande della dimensione dichiarata.";
const CHUNK_INVALID: &str = "Blocco del file non valido.";
const INCOMPLETE: &str = "Il caricamento del file non è completo.";
const TOO_MANY: &str = "Troppi caricamenti in corso: attendi che finiscano.";
const WRITE_MESSAGE: &str = "Impossibile salvare il file caricato.";

/// Unvalidated input of `begin_upload` (`BeginUploadInput` in `src/api/types.ts`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BeginUpload {
    pub project_id: String,
    pub folder_id: Option<String>,
    pub file_name: String,
    pub size_bytes: u64,
    /// ms since the Unix epoch (`File.lastModified`).
    pub last_modified: Option<i64>,
    /// Set to add a new version of this document.
    pub document_id: Option<String>,
}

/// Returned by [`Uploads::begin`] (`UploadHandle` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadHandle {
    pub upload_id: String,
    pub chunk_bytes: u64,
}

struct Upload {
    input: BeginUpload,
    path: PathBuf,
    file: File,
    hasher: Sha256,
    received: u64,
    last_activity: Instant,
    /// Set when finished or cancelled: a block that raced with it is refused.
    closed: bool,
}

/// A completely received upload, removed from the active ones. Dropping it deletes the
/// temporary file if it was not moved into the archive.
#[derive(Debug)]
pub struct FinishedUpload {
    pub input: BeginUpload,
    pub path: PathBuf,
    pub sha256: String,
}

impl FinishedUpload {
    /// Recognizes the file (format, duration) without taking any lock.
    pub fn prepare(&self) -> Result<ImportFile<'static>> {
        ImportFile::prepare_temp_file(
            &self.input.file_name,
            self.input.last_modified,
            &self.path,
            self.input.size_bytes,
            &self.sha256,
        )
    }
}

impl Drop for FinishedUpload {
    fn drop(&mut self) {
        remove_quietly(&self.path);
    }
}

fn remove_quietly(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => eprintln!("localis: cannot remove upload {}: {err}", path.display()),
    }
}

/// Uploads in progress (shared by the commands; independent of the database lock).
pub struct Uploads {
    dir: PathBuf,
    timeout: Duration,
    active: Mutex<HashMap<String, Arc<Mutex<Upload>>>>,
}

impl std::fmt::Debug for Uploads {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Uploads").field("dir", &self.dir).finish()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A panic while holding the lock cannot leave the map inconsistent (single inserts and
    // removals), so a poisoned lock is still usable.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Uploads {
    /// `originals_dir` is the archive directory; temporary files go in its `.uploads`.
    pub fn new(originals_dir: &Path) -> Self {
        Uploads {
            dir: originals_dir.join(UPLOADS_DIR),
            timeout: UPLOAD_IDLE_TIMEOUT,
            active: Mutex::new(HashMap::new()),
        }
    }

    /// Same, with another inactivity timeout (tests).
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Removes every temporary file (call at startup, before any upload begins).
    pub fn sweep_all(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let active: Vec<PathBuf> = lock(&self.active)
            .values()
            .map(|u| lock(u).path.clone())
            .collect();
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_file()) && !active.contains(&path) {
                remove_quietly(&path);
            }
        }
    }

    /// Discards the uploads inactive for longer than the timeout. Returns how many.
    pub fn sweep_expired(&self) -> usize {
        let mut active = lock(&self.active);
        let expired: Vec<String> = active
            .iter()
            .filter(|(_, u)| {
                // An upload busy writing a block is active by definition.
                u.try_lock()
                    .map(|u| u.last_activity.elapsed() > self.timeout)
                    .unwrap_or(false)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            if let Some(upload) = active.remove(id) {
                let mut upload = lock(&upload);
                upload.closed = true;
                remove_quietly(&upload.path);
            }
        }
        expired.len()
    }

    /// Validates name and declared size (by kind: audio/video 4 GB, others 200 MB) and
    /// creates the temporary file. Project, folder and document are checked by the caller
    /// ([`crate::Store::check_upload_target`]).
    pub fn begin(&self, input: BeginUpload) -> Result<UploadHandle> {
        self.sweep_expired();
        let file_name = validate_file_name(&input.file_name)?;
        let kind = kind_for_file_name(&file_name)?;
        check_kind_size(kind, input.size_bytes)?;
        let mut active = lock(&self.active);
        if active.len() >= UPLOADS_MAX {
            return Err(CoreError::conflict(TOO_MANY));
        }
        fs::create_dir_all(&self.dir)
            .map_err(|err| CoreError::storage(WRITE_MESSAGE, format!("{}: {err}", self.dir.display())))?;
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.dir.join(format!("{id}.part"));
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|err| CoreError::storage(WRITE_MESSAGE, format!("{}: {err}", path.display())))?;
        active.insert(
            id.clone(),
            Arc::new(Mutex::new(Upload {
                input: BeginUpload { file_name, ..input },
                path,
                file,
                hasher: Sha256::new(),
                received: 0,
                last_activity: Instant::now(),
                closed: false,
            })),
        );
        Ok(UploadHandle {
            upload_id: id,
            chunk_bytes: UPLOAD_CHUNK_BYTES,
        })
    }

    fn get(&self, id: &str) -> Result<Arc<Mutex<Upload>>> {
        lock(&self.active)
            .get(id)
            .cloned()
            .ok_or_else(|| CoreError::not_found(UPLOAD_NOT_FOUND))
    }

    fn discard(&self, id: &str) {
        if let Some(upload) = lock(&self.active).remove(id) {
            let mut upload = lock(&upload);
            upload.closed = true;
            remove_quietly(&upload.path);
        }
    }

    /// Appends one block. `offset` must be exactly the number of bytes received so far and
    /// the total must not exceed the declared size (`validation` otherwise; the upload stays
    /// usable for a correct retry).
    pub fn write_chunk(&self, id: &str, offset: u64, bytes: &[u8]) -> Result<()> {
        let upload = self.get(id)?;
        let mut upload = lock(&upload);
        if upload.closed {
            return Err(CoreError::not_found(UPLOAD_NOT_FOUND));
        }
        if bytes.is_empty() || bytes.len() as u64 > UPLOAD_CHUNK_BYTES {
            return Err(CoreError::validation("file", CHUNK_INVALID));
        }
        if offset != upload.received {
            return Err(CoreError::validation("file", OUT_OF_ORDER));
        }
        if upload.received + bytes.len() as u64 > upload.input.size_bytes {
            return Err(CoreError::validation("file", OVER_SIZE));
        }
        if let Err(err) = upload.file.write_all(bytes) {
            let detail = format!("{}: {err}", upload.path.display());
            drop(upload);
            self.discard(id);
            return Err(CoreError::storage(WRITE_MESSAGE, detail));
        }
        upload.hasher.update(bytes);
        upload.received += bytes.len() as u64;
        upload.last_activity = Instant::now();
        Ok(())
    }

    /// Completes an upload whose bytes have all been received: the file is synced and handed
    /// over (with its sha256) for import.
    pub fn finish(&self, id: &str) -> Result<FinishedUpload> {
        let upload = self.get(id)?;
        let mut guard = lock(&upload);
        if guard.closed {
            return Err(CoreError::not_found(UPLOAD_NOT_FOUND));
        }
        if guard.received != guard.input.size_bytes {
            return Err(CoreError::validation("file", INCOMPLETE));
        }
        guard.closed = true;
        let synced = guard.file.sync_all();
        let path = guard.path.clone();
        let sha256 = hex_digest(&std::mem::take(&mut guard.hasher).finalize());
        let input = guard.input.clone();
        drop(guard);
        lock(&self.active).remove(id);
        let finished = FinishedUpload {
            input,
            path,
            sha256,
        };
        synced.map_err(|err| {
            CoreError::storage(WRITE_MESSAGE, format!("{}: {err}", finished.path.display()))
        })?;
        Ok(finished)
    }

    /// Stops an upload and deletes its temporary file. Unknown ids are ignored (the upload
    /// may have expired or finished meanwhile).
    pub fn cancel(&self, id: &str) {
        self.discard(id);
    }

    /// Uploads in progress.
    pub fn active_count(&self) -> usize {
        lock(&self.active).len()
    }
}
