//! Synthetic fixtures generated in code: no real documents are used in tests.
#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use localis_core::{ImportFile, ImportOutcome, LibraryDocument, NewProject, Project, Store};
use tempfile::TempDir;

pub const TIMEOUT: Duration = Duration::from_secs(30);

/// A temporary data directory with `localis.db` and `originals/` inside.
pub struct Env {
    pub dir: TempDir,
    pub store: Store,
}

impl Env {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("localis.db")).unwrap();
        Env { dir, store }
    }

    pub fn db_path(&self) -> PathBuf {
        self.dir.path().join("localis.db")
    }

    pub fn originals(&self) -> PathBuf {
        self.dir.path().join("originals")
    }

    pub fn blob_path(&self, sha: &str) -> PathBuf {
        self.originals().join(&sha[..2]).join(sha)
    }

    pub fn reopen(&self) -> Store {
        Store::open(&self.db_path()).unwrap()
    }

    pub fn project(&mut self, name: &str) -> Project {
        self.store
            .create_project(NewProject {
                name: name.into(),
                description: None,
            })
            .unwrap()
    }

    pub fn import(&mut self, project: &str, name: &str, bytes: &[u8]) -> LibraryDocument {
        match self.try_import(project, None, name, bytes) {
            ImportOutcome::Imported(doc) => doc,
            ImportOutcome::Duplicate(doc) => panic!("unexpected duplicate {doc:?}"),
        }
    }

    pub fn try_import(
        &mut self,
        project: &str,
        folder: Option<&str>,
        name: &str,
        bytes: &[u8],
    ) -> ImportOutcome {
        let file = ImportFile::prepare(name, Some(1_700_000_000_000), bytes).unwrap();
        self.store.import_document(project, folder, &file).unwrap()
    }

    /// Runs every queued job synchronously.
    pub fn run_jobs(&mut self) -> usize {
        let mut n = 0;
        while self.store.run_next_job(TIMEOUT).unwrap() {
            n += 1;
        }
        n
    }

    pub fn raw(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.db_path()).unwrap()
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.raw().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// Regular files under `originals/`, relative paths.
    pub fn blob_files(&self) -> Vec<String> {
        let mut out = Vec::new();
        collect_files(&self.originals(), &self.originals(), &mut out);
        out.sort();
        out
    }
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out);
        } else {
            out.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

/// A minimal PDF: one page per content stream, Helvetica with WinAnsiEncoding.
pub fn pdf(pages: &[&[u8]]) -> Vec<u8> {
    let n = pages.len();
    let mut objects: Vec<Vec<u8>> = Vec::new();
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 4 + 2 * i)).collect();
    objects.push(format!("<< /Type /Pages /Kids [{}] /Count {n} >>", kids.join(" ")).into_bytes());
    objects.push(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
    );
    for (i, content) in pages.iter().enumerate() {
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                 /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>",
                5 + 2 * i
            )
            .into_bytes(),
        );
        let mut stream = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
        stream.extend_from_slice(content);
        stream.extend_from_slice(b"\nendstream");
        objects.push(stream);
    }
    let mut out = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// Content stream showing `lines` (WinAnsi bytes) one under the other.
pub fn text_page(lines: &[&[u8]]) -> Vec<u8> {
    let mut out = b"BT /F1 12 Tf 72 720 Td ".to_vec();
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.extend_from_slice(b" 0 -14 Td ");
        }
        out.push(b'(');
        out.extend_from_slice(line);
        out.extend_from_slice(b") Tj");
    }
    out.extend_from_slice(b" ET");
    out
}

/// Content stream with drawing only, like a scanned page without a text layer.
pub const DRAWING_PAGE: &[u8] = b"q 0.5 g 72 72 468 648 re f Q";

/// A DOCX with one `w:p` per paragraph (`w:t` text, `\t` → `w:tab`).
pub fn docx(paragraphs: &[&str]) -> Vec<u8> {
    let mut body = String::new();
    for p in paragraphs {
        body.push_str("<w:p><w:r>");
        for (i, part) in p.split('\t').enumerate() {
            if i > 0 {
                body.push_str("<w:tab/>");
            }
            let escaped = part.replace('&', "&amp;").replace('<', "&lt;");
            body.push_str(&format!("<w:t xml:space=\"preserve\">{escaped}</w:t>"));
        }
        body.push_str("</w:r></w:p>");
    }
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
         <w:body>{body}</w:body></w:document>"
    );
    zip_with(&[
        ("[Content_Types].xml", "<Types/>"),
        ("word/document.xml", &document),
    ])
}

pub fn zip_with(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in entries {
        writer.start_file(*name, options).unwrap();
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

pub fn png(width: u32, height: u32) -> Vec<u8> {
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    out.extend_from_slice(&13u32.to_be_bytes());
    out.extend_from_slice(b"IHDR");
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(&[8, 6, 0, 0, 0]);
    out.extend_from_slice(&[0, 0, 0, 0]); // CRC (not checked by the sniffer)
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(b"IEND\xAE\x42\x60\x82");
    out
}

/// JPEG markers only: SOI, APP0, SOF0 (64×32), EOI.
pub fn jpeg() -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8];
    out.extend_from_slice(&[
        0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    ]);
    out.extend_from_slice(&[
        0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11,
        0x01, 0x03, 0x11, 0x01,
    ]);
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

/// GIF header 5×7.
pub fn gif() -> Vec<u8> {
    let mut out = b"GIF89a".to_vec();
    out.extend_from_slice(&5u16.to_le_bytes());
    out.extend_from_slice(&7u16.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, b';']);
    out
}

/// Lossless WebP header 3×2.
pub fn webp() -> Vec<u8> {
    let chunk: [u8; 6] = [0x2f, 0x02, 0x40, 0x00, 0x00, 0x00];
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&((4 + 8 + chunk.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"WEBPVP8L");
    out.extend_from_slice(&5u32.to_le_bytes());
    out.extend_from_slice(&chunk);
    out
}
