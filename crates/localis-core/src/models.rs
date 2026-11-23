//! v0.5 Whisper model manager: a fixed catalog of whisper.cpp models, downloaded only when
//! the user asks (after a confirmation showing the size) from
//! `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`, into
//! `<app_data>/models/whisper/`. This is the only network access besides LM Studio and the
//! cloud providers, and it sends no user data.
//!
//! Safety of the download: HTTPS with verified certificates; redirects are followed by hand
//! and only to `https://huggingface.co/…` or an `https://<…>.hf.co/…` host (the CDN); the
//! body streams to a temporary file in the models directory and is renamed into place only
//! after its size and SHA-256 match the catalog. A model counts as installed when its file
//! exists with the catalog size (the hash is verified once, at download).
//!
//! **Test-only override.** In builds with `debug_assertions` (compiled out of release
//! builds), the environment variable named by [`TEST_HF_BASE_URL_VAR`] replaces the
//! origin with a loopback `http` URL, for end-to-end tests against a fake server.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::blobs::hex_digest;
use crate::error::{CoreError, Result};

/// Production origin of the models.
pub const HF_ORIGIN: &str = "https://huggingface.co";
const HF_PATH: &str = "/ggerganov/whisper.cpp/resolve/main/";
/// Directory of the models, relative to the app data directory.
pub const MODELS_DIR: &str = "models/whisper";
const MAX_REDIRECTS: usize = 5;
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const TEMP_PREFIX: &str = ".download-";

/// Name of the debug-only environment override.
#[cfg(debug_assertions)]
pub const TEST_HF_BASE_URL_VAR: &str = "LOCALIS_TEST_HF_BASE_URL";

const UNKNOWN_MODEL: &str = "Modello di trascrizione non valido.";
const NOT_REACHABLE: &str = "Impossibile scaricare il modello: huggingface.co non è raggiungibile.";
const BAD_REDIRECT: &str =
    "Download interrotto: il server ha reindirizzato verso un indirizzo non consentito.";
const VERIFY_FAILED: &str =
    "Il file scaricato non corrisponde al modello atteso (verifica SHA-256 non riuscita).";
const DISK_FAILED: &str = "Impossibile salvare il modello sul disco.";
const CANCELLED: &str = "Download annullato.";
const DELETE_FAILED: &str = "Impossibile eliminare il modello.";

/// Models of the catalog (`WhisperModelId` in `src/api/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum WhisperModelId {
    Tiny,
    Base,
    Small,
    LargeV3TurboQ5,
}

impl WhisperModelId {
    pub const ALL: [WhisperModelId; 4] = [
        WhisperModelId::Tiny,
        WhisperModelId::Base,
        WhisperModelId::Small,
        WhisperModelId::LargeV3TurboQ5,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            WhisperModelId::Tiny => "tiny",
            WhisperModelId::Base => "base",
            WhisperModelId::Small => "small",
            WhisperModelId::LargeV3TurboQ5 => "large-v3-turbo-q5",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        WhisperModelId::ALL.into_iter().find(|m| m.as_str() == s)
    }

    /// Parses or fails with `validation` (field `model`).
    pub fn parse_input(s: &str) -> Result<Self> {
        Self::parse(s).ok_or_else(|| CoreError::validation("model", UNKNOWN_MODEL))
    }
}

/// One catalog entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: WhisperModelId,
    pub name: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// The models offered (sizes and SHA-256 from the Hugging Face API, 23/11/2026).
pub fn catalog() -> Vec<ModelSpec> {
    let spec = |id, name: &str, file: &str, size, sha: &str| ModelSpec {
        id,
        name: name.to_owned(),
        file_name: file.to_owned(),
        size_bytes: size,
        sha256: sha.to_owned(),
    };
    vec![
        spec(
            WhisperModelId::Tiny,
            "Whisper Tiny",
            "ggml-tiny.bin",
            77_691_713,
            "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        ),
        spec(
            WhisperModelId::Base,
            "Whisper Base",
            "ggml-base.bin",
            147_951_465,
            "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        ),
        spec(
            WhisperModelId::Small,
            "Whisper Small",
            "ggml-small.bin",
            487_601_967,
            "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        ),
        spec(
            WhisperModelId::LargeV3TurboQ5,
            "Whisper Large v3 Turbo (Q5)",
            "ggml-large-v3-turbo-q5_0.bin",
            574_041_195,
            "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        ),
    ]
}

/// State of one model (`WhisperModel` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhisperModel {
    pub spec: ModelSpec,
    pub installed: bool,
    /// (received, total) while downloading.
    pub download: Option<(u64, u64)>,
    /// Italian, after a failed download.
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct Download {
    received: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Default)]
struct Entry {
    download: Option<Download>,
    error: Option<String>,
}

/// Downloads, lists and deletes the Whisper models.
#[derive(Debug)]
pub struct ModelManager {
    dir: PathBuf,
    catalog: Vec<ModelSpec>,
    /// Always [`HF_ORIGIN`] in release builds.
    origin: String,
    entries: Mutex<HashMap<WhisperModelId, Entry>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Why a download stopped (message for the UI, or a cancellation).
#[derive(Debug)]
enum Failure {
    Cancelled,
    Error(CoreError),
}

impl From<CoreError> for Failure {
    fn from(err: CoreError) -> Self {
        Failure::Error(err)
    }
}

fn failed(message: &str, detail: impl ToString) -> Failure {
    Failure::Error(CoreError::storage(message, detail))
}

impl ModelManager {
    /// Models in `dir` (usually `<app_data>/models/whisper`), downloaded from
    /// huggingface.co. Debug builds honour the loopback test override.
    pub fn new(dir: PathBuf) -> Self {
        #[allow(unused_mut)]
        let mut origin = HF_ORIGIN.to_owned();
        #[cfg(debug_assertions)]
        if let Ok(value) = std::env::var(TEST_HF_BASE_URL_VAR) {
            match crate::settings::validate_base_url(&value) {
                Ok(o) => origin = o,
                Err(_) => eprintln!("localis: ignoring invalid {TEST_HF_BASE_URL_VAR}"),
            }
        }
        ModelManager {
            dir,
            catalog: catalog(),
            origin,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Test servers only (debug builds): another catalog and a loopback origin.
    #[cfg(debug_assertions)]
    pub fn with_test_server(dir: PathBuf, origin: &str, catalog: Vec<ModelSpec>) -> Result<Self> {
        Ok(ModelManager {
            dir,
            catalog,
            origin: crate::settings::validate_base_url(origin)?,
            entries: Mutex::new(HashMap::new()),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Origin the downloads start from (`https://huggingface.co` in release builds).
    pub fn origin(&self) -> &str {
        &self.origin
    }

    fn spec(&self, id: WhisperModelId) -> Result<&ModelSpec> {
        self.catalog
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| CoreError::validation("model", UNKNOWN_MODEL))
    }

    fn final_path(&self, spec: &ModelSpec) -> PathBuf {
        self.dir.join(&spec.file_name)
    }

    fn is_installed(&self, spec: &ModelSpec) -> bool {
        fs::metadata(self.final_path(spec)).is_ok_and(|m| m.is_file() && m.len() == spec.size_bytes)
    }

    /// Path of an installed model.
    pub fn installed_path(&self, id: WhisperModelId) -> Option<PathBuf> {
        let spec = self.spec(id).ok()?;
        self.is_installed(spec).then(|| self.final_path(spec))
    }

    /// All catalog models with their state.
    pub fn list(&self) -> Vec<WhisperModel> {
        let entries = lock(&self.entries);
        self.catalog
            .iter()
            .map(|spec| {
                let entry = entries.get(&spec.id);
                WhisperModel {
                    spec: spec.clone(),
                    installed: self.is_installed(spec),
                    download: entry.and_then(|e| e.download.as_ref()).map(|d| {
                        (
                            d.received.load(Ordering::Relaxed).min(spec.size_bytes),
                            spec.size_bytes,
                        )
                    }),
                    error: entry.and_then(|e| e.error.clone()),
                }
            })
            .collect()
    }

    /// Removes partial downloads left by an interrupted run (call at startup).
    pub fn sweep_temp_files(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let busy = lock(&self.entries).values().any(|e| e.download.is_some());
        if busy {
            return;
        }
        for entry in entries.flatten() {
            let temp = entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(TEMP_PREFIX));
            if temp && entry.file_type().is_ok_and(|t| t.is_file()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Starts downloading `id` on a background thread (no-op if installed or already
    /// downloading). Progress and errors appear in [`ModelManager::list`].
    pub fn start_download(self: &Arc<Self>, id: WhisperModelId) -> Result<()> {
        let spec = self.spec(id)?.clone();
        if self.is_installed(&spec) {
            return Ok(());
        }
        let Some(download) = self.register(id) else {
            return Ok(());
        };
        let this = Arc::clone(self);
        std::thread::Builder::new()
            .name("localis-model-download".into())
            .spawn(move || this.run_download(&spec, &download))
            .map(|_| ())
            .map_err(|err| {
                lock(&self.entries).remove(&id);
                CoreError::Internal(format!("cannot start the download thread: {err}"))
            })
    }

    /// Downloads `id` on the calling thread (for tests and tools). `Cancelled` when
    /// cancelled, the Italian error otherwise.
    pub fn download_blocking(&self, id: WhisperModelId) -> Result<()> {
        let spec = self.spec(id)?.clone();
        if self.is_installed(&spec) {
            return Ok(());
        }
        let Some(download) = self.register(id) else {
            return Err(CoreError::conflict("Il modello è già in download."));
        };
        self.run_download(&spec, &download);
        if self.is_installed(&spec) {
            return Ok(());
        }
        let error = lock(&self.entries).get(&id).and_then(|e| e.error.clone());
        Err(match error {
            Some(message) => CoreError::storage(&message, "download failed"),
            None => CoreError::Cancelled {
                message: CANCELLED.to_owned(),
            },
        })
    }

    /// Marks `id` as downloading; `None` if it already is.
    fn register(&self, id: WhisperModelId) -> Option<Download> {
        let mut entries = lock(&self.entries);
        let entry = entries.entry(id).or_default();
        if entry.download.is_some() {
            return None;
        }
        let download = Download {
            received: Arc::new(AtomicU64::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        entry.download = Some(download.clone());
        entry.error = None;
        Some(download)
    }

    fn run_download(&self, spec: &ModelSpec, download: &Download) {
        let result = self.fetch(spec, download);
        let mut entries = lock(&self.entries);
        let entry = entries.entry(spec.id).or_default();
        entry.download = None;
        entry.error = match result {
            Ok(()) | Err(Failure::Cancelled) => None,
            Err(Failure::Error(err)) => {
                eprintln!(
                    "localis: model download {}: {err} ({})",
                    spec.id.as_str(),
                    err.detail().unwrap_or("no detail")
                );
                Some(err.to_string())
            }
        };
    }

    /// Asks a running download to stop (no-op otherwise).
    pub fn cancel_download(&self, id: WhisperModelId) {
        if let Some(d) = lock(&self.entries).get(&id).and_then(|e| e.download.as_ref()) {
            d.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Deletes an installed model (cancelling its download, if any). Never touches files
    /// other than the catalog file names in the models directory.
    pub fn delete(&self, id: WhisperModelId) -> Result<()> {
        let spec = self.spec(id)?.clone();
        self.cancel_download(id);
        if let Some(entry) = lock(&self.entries).get_mut(&id) {
            entry.error = None;
        }
        match fs::remove_file(self.final_path(&spec)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(CoreError::storage(DELETE_FAILED, err)),
        }
    }

    fn is_test_origin(&self) -> bool {
        #[cfg(debug_assertions)]
        {
            self.origin != HF_ORIGIN
        }
        #[cfg(not(debug_assertions))]
        {
            false
        }
    }

    /// Whether a redirect to `url` may be followed.
    fn redirect_allowed(&self, url: &str) -> bool {
        if self.is_test_origin() {
            return url
                .strip_prefix(self.origin.as_str())
                .is_some_and(|rest| rest.starts_with('/'));
        }
        allowed_hf_url(url)
    }

    fn fetch(&self, spec: &ModelSpec, download: &Download) -> std::result::Result<(), Failure> {
        fs::create_dir_all(&self.dir).map_err(|e| failed(DISK_FAILED, e))?;
        let agent = crate::providers::cloud_agent(self.is_test_origin(), None, Some(READ_TIMEOUT));
        let mut url = format!("{}{HF_PATH}{}", self.origin, spec.file_name);
        let mut hops = 0;
        let response = loop {
            if download.cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            let response = agent
                .get(&url)
                .call()
                .map_err(|err| failed(NOT_REACHABLE, err))?;
            let status = response.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default();
                let next = resolve_location(&url, location);
                hops += 1;
                if hops > MAX_REDIRECTS || !self.redirect_allowed(&next) {
                    return Err(failed(BAD_REDIRECT, format!("redirect to {next:?}")));
                }
                url = next;
                continue;
            }
            if status != 200 {
                return Err(Failure::Error(CoreError::storage(
                    &format!("Download del modello non riuscito (errore HTTP {status})."),
                    format!("GET {url}: HTTP {status}"),
                )));
            }
            break response;
        };
        if let Some(len) = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
        {
            if len != spec.size_bytes {
                return Err(failed(
                    VERIFY_FAILED,
                    format!("content-length {len}, expected {}", spec.size_bytes),
                ));
            }
        }
        let temp = self
            .dir
            .join(format!("{TEMP_PREFIX}{}-{}", spec.file_name, uuid::Uuid::new_v4()));
        let result = self.stream_to(&temp, response.into_body().into_reader(), spec, download);
        match result {
            Ok(()) => fs::rename(&temp, self.final_path(spec)).map_err(|e| {
                let _ = fs::remove_file(&temp);
                failed(DISK_FAILED, e)
            }),
            Err(err) => {
                let _ = fs::remove_file(&temp);
                Err(err)
            }
        }
    }

    fn stream_to(
        &self,
        temp: &Path,
        mut body: impl Read,
        spec: &ModelSpec,
        download: &Download,
    ) -> std::result::Result<(), Failure> {
        let mut file = File::create(temp).map_err(|e| failed(DISK_FAILED, e))?;
        let mut hasher = Sha256::new();
        let mut received: u64 = 0;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            if download.cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            let n = body.read(&mut buf).map_err(|e| failed(NOT_REACHABLE, e))?;
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > spec.size_bytes {
                return Err(failed(VERIFY_FAILED, "more bytes than expected"));
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| failed(DISK_FAILED, e))?;
            download.received.store(received, Ordering::Relaxed);
        }
        let actual = hex_digest(&hasher.finalize());
        if received != spec.size_bytes || actual != spec.sha256 {
            return Err(failed(
                VERIFY_FAILED,
                format!(
                    "received {received} bytes with sha256 {actual}, expected {} / {}",
                    spec.size_bytes, spec.sha256
                ),
            ));
        }
        file.sync_all().map_err(|e| failed(DISK_FAILED, e))?;
        Ok(())
    }
}

/// `true` for `https://huggingface.co/…` and `https://<sub>.hf.co/…` (no port, no user info).
pub fn allowed_hf_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = rest[..end].to_ascii_lowercase();
    if !rest[end..].starts_with('/') {
        return false;
    }
    let valid_chars = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
    if !valid_chars || host.starts_with('.') || host.contains("..") {
        return false;
    }
    host == "huggingface.co" || (host.ends_with(".hf.co") && host.len() > ".hf.co".len())
}

/// Absolute URL of a `Location` header relative to `base`.
fn resolve_location(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_owned();
    }
    let scheme_end = base.find("://").map(|i| i + 3).unwrap_or(0);
    let authority_end = base[scheme_end..]
        .find('/')
        .map(|i| i + scheme_end)
        .unwrap_or(base.len());
    if let Some(stripped) = location.strip_prefix("//") {
        return format!("{}{stripped}", &base[..scheme_end]);
    }
    if location.starts_with('/') {
        return format!("{}{location}", &base[..authority_end]);
    }
    // Relative path: replace the last segment.
    let last_slash = base.rfind('/').filter(|&i| i >= authority_end).unwrap_or(authority_end);
    format!("{}/{location}", &base[..last_slash])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_the_contract() {
        let c = catalog();
        assert_eq!(c.len(), 4);
        for (spec, id) in c.iter().zip(WhisperModelId::ALL) {
            assert_eq!(spec.id, id);
            assert_eq!(WhisperModelId::parse(id.as_str()), Some(id));
            assert_eq!(spec.sha256.len(), 64);
        }
        assert_eq!(c[2].size_bytes, 487_601_967);
        assert_eq!(c[3].file_name, "ggml-large-v3-turbo-q5_0.bin");
        assert_eq!(WhisperModelId::parse("medium"), None);
    }

    #[test]
    fn redirect_host_rules() {
        for ok in [
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
            "https://cdn-lfs.hf.co/repos/x/y?sig=1",
            "https://cas-bridge.xethub.hf.co/a",
            "https://HUGGINGFACE.CO/x",
        ] {
            assert!(allowed_hf_url(ok), "{ok}");
        }
        for bad in [
            "http://huggingface.co/x",
            "https://huggingface.co.evil.com/x",
            "https://evilhf.co/x",
            "https://hf.co/x",
            "https://.hf.co/x",
            "https://user@huggingface.co/x",
            "https://huggingface.co:8443/x",
            "https://huggingface.co",
            "https://a..hf.co/x",
            "ftp://cdn.hf.co/x",
        ] {
            assert!(!allowed_hf_url(bad), "{bad}");
        }
    }

    #[test]
    fn location_resolution() {
        let base = "https://huggingface.co/a/b/c.bin";
        assert_eq!(resolve_location(base, "https://x.hf.co/y"), "https://x.hf.co/y");
        assert_eq!(resolve_location(base, "/z"), "https://huggingface.co/z");
        assert_eq!(resolve_location(base, "//cdn.hf.co/q"), "https://cdn.hf.co/q");
        assert_eq!(resolve_location(base, "d.bin"), "https://huggingface.co/a/b/d.bin");
    }

    #[test]
    fn release_origin_is_fixed() {
        // In release builds the override is compiled out; in debug builds without the
        // variable the origin is the production one.
        if std::env::var_os("LOCALIS_TEST_HF_BASE_URL").is_none() {
            let m = ModelManager::new(std::env::temp_dir().join("localis-no-models"));
            assert_eq!(m.origin(), HF_ORIGIN);
            assert!(!m.is_test_origin());
        }
    }
}
