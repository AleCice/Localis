//! Content-addressed store for Localis' own copies of imported originals:
//! `<root>/<sha256[0..2]>/<sha256>` (no extension). Only files whose name is a sha256
//! hex digest inside `root` are ever written or removed.

use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};

const WRITE_MESSAGE: &str = "Impossibile salvare il file nell'archivio di Localis.";
const MISSING_MESSAGE: &str = "Il file originale non si trova nell'archivio di Localis.";
const ALTERED_MESSAGE: &str = "Il file originale nell'archivio risulta alterato.";
const TEMP_PREFIX: &str = ".tmp-";

/// Lowercase hex sha256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.iter() {
        out.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        out.push(char::from(b"0123456789abcdef"[usize::from(byte & 0x0f)]));
    }
    out
}

/// Lowercase hex of a finished sha256 digest.
pub(crate) fn hex_digest(digest: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        out.push(char::from(b"0123456789abcdef"[usize::from(byte & 0x0f)]));
    }
    out
}

/// sha256 of a file, read in blocks (never whole in memory).
pub(crate) fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = std::io::Read::read(&mut file, &mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

/// True for a 64-character lowercase hex string.
pub(crate) fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(Debug, Clone)]
pub(crate) struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        BlobStore { root }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn path_for(&self, sha: &str) -> Result<PathBuf> {
        if !is_sha256_hex(sha) {
            return Err(CoreError::Internal(format!("invalid blob name {sha:?}")));
        }
        Ok(self.root.join(&sha[..2]).join(sha))
    }

    /// Stores `bytes` under `sha` (their sha256, already computed by the caller).
    /// An existing blob is kept if it still matches its name, otherwise it is replaced.
    /// The write is atomic: temporary file in the same directory, fsync, rename.
    pub(crate) fn put(&self, sha: &str, bytes: &[u8]) -> Result<()> {
        let path = self.path_for(sha)?;
        if let Ok(existing) = fs::read(&path) {
            if sha256_hex(&existing) == sha {
                return Ok(());
            }
        }
        let dir = path.parent().expect("blob path has a parent");
        let write_err = |what: &str, err: std::io::Error| {
            CoreError::storage(WRITE_MESSAGE, format!("{what} {}: {err}", dir.display()))
        };
        fs::create_dir_all(dir).map_err(|e| write_err("cannot create", e))?;
        let tmp = dir.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut file = File::create(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&tmp, &path)?;
            sync_dir(dir);
            Ok(())
        })();
        if let Err(err) = result {
            let _ = fs::remove_file(&tmp);
            return Err(write_err("cannot write blob in", err));
        }
        Ok(())
    }

    /// v0.5: moves `temp` (a fully written and synced file inside the originals directory,
    /// whose sha256 is `sha`) into the archive with an atomic rename. If a valid blob with
    /// that name already exists, it is kept and `temp` is removed.
    pub(crate) fn put_file(&self, sha: &str, temp: &Path) -> Result<()> {
        let path = self.path_for(sha)?;
        if path.is_file() && sha256_file(&path).is_ok_and(|actual| actual == sha) {
            let _ = fs::remove_file(temp);
            return Ok(());
        }
        let dir = path.parent().expect("blob path has a parent");
        let result = fs::create_dir_all(dir).and_then(|()| fs::rename(temp, &path));
        if let Err(err) = result {
            return Err(CoreError::storage(
                WRITE_MESSAGE,
                format!("cannot move {} to {}: {err}", temp.display(), path.display()),
            ));
        }
        sync_dir(dir);
        Ok(())
    }

    /// Reads the blob and verifies its sha256.
    pub(crate) fn read_verified(&self, sha: &str) -> Result<Vec<u8>> {
        let path = self.path_for(sha)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                return Err(CoreError::Integrity {
                    message: MISSING_MESSAGE.to_owned(),
                    detail: format!("missing blob {}", path.display()),
                })
            }
            Err(err) => {
                return Err(CoreError::storage(
                    "Impossibile leggere il file originale.",
                    format!("{}: {err}", path.display()),
                ))
            }
        };
        let actual = sha256_hex(&bytes);
        if actual != sha {
            return Err(CoreError::Integrity {
                message: ALTERED_MESSAGE.to_owned(),
                detail: format!("{}: expected sha256 {sha}, found {actual}", path.display()),
            });
        }
        Ok(bytes)
    }

    /// Removes the blob named `sha` (and its shard directory if left empty).
    /// Errors are logged, never returned: garbage collection must not fail an operation.
    pub(crate) fn remove(&self, sha: &str) {
        let path = match self.path_for(sha) {
            Ok(path) => path,
            Err(err) => {
                eprintln!("localis: blob gc: {err:?}");
                return;
            }
        };
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => eprintln!("localis: blob gc: cannot remove {}: {err}", path.display()),
        }
        if let Some(dir) = path.parent() {
            // Fails harmlessly when the shard still holds other blobs.
            let _ = fs::remove_dir(dir);
        }
    }

    /// Removes temporary files left in shard directories by an interrupted write.
    pub(crate) fn sweep_temp_files(&self) {
        let Ok(shards) = fs::read_dir(&self.root) else {
            return;
        };
        for shard in shards.flatten() {
            let name = shard.file_name();
            let is_shard = name.len() == 2
                && name
                    .to_str()
                    .is_some_and(|n| n.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
            if !is_shard || !shard.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(entries) = fs::read_dir(shard.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let is_temp = entry
                    .file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with(TEMP_PREFIX));
                if is_temp && entry.file_type().is_ok_and(|t| t.is_file()) {
                    if let Err(err) = fs::remove_file(entry.path()) {
                        eprintln!(
                            "localis: cannot remove temporary file {}: {err}",
                            entry.path().display()
                        );
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    // Makes the rename durable; best effort.
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_of_known_input() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_name_check() {
        assert!(is_sha256_hex(&sha256_hex(b"x")));
        assert!(!is_sha256_hex("../etc/passwd"));
        assert!(!is_sha256_hex(&"A".repeat(64)));
        assert!(!is_sha256_hex(&"a".repeat(63)));
    }
}
