//! TEST FIXTURE ONLY: a fake Hugging Face file server on 127.0.0.1, reached through the
//! debug-only `ModelManager::with_test_server`. Routes answer with a body, a redirect or an
//! HTTP error; a slow mode trickles the body so downloads can be cancelled. Never used by
//! the app.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone)]
pub enum Route {
    /// 200 with this body.
    Body(Vec<u8>),
    /// 200, body sent in small pieces with a pause between them.
    SlowBody(Vec<u8>),
    /// 302 to this location.
    Redirect(String),
    Status(u16),
}

pub struct FakeHf {
    pub url: String,
    pub routes: Arc<Mutex<HashMap<String, Route>>>,
    pub hits: Arc<Mutex<Vec<String>>>,
}

impl FakeHf {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let routes: Arc<Mutex<HashMap<String, Route>>> = Arc::default();
        let hits: Arc<Mutex<Vec<String>>> = Arc::default();
        let (r, h) = (Arc::clone(&routes), Arc::clone(&hits));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let (r, h) = (Arc::clone(&r), Arc::clone(&h));
                std::thread::spawn(move || {
                    let _ = handle(stream, &r, &h);
                });
            }
        });
        FakeHf { url, routes, hits }
    }

    pub fn route(&self, path: &str, route: Route) {
        self.routes.lock().unwrap().insert(path.to_owned(), route);
    }

    pub fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }
}

fn handle(
    stream: TcpStream,
    routes: &Mutex<HashMap<String, Route>>,
    hits: &Mutex<Vec<String>>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" {
            break;
        }
    }
    hits.lock().unwrap().push(path.clone());
    let route = routes.lock().unwrap().get(&path).cloned();
    let mut out = stream;
    match route {
        Some(Route::Body(body)) => {
            write!(
                out,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            out.write_all(&body)?;
        }
        Some(Route::SlowBody(body)) => {
            write!(
                out,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            for piece in body.chunks(64) {
                out.write_all(piece)?;
                out.flush()?;
                std::thread::sleep(Duration::from_millis(30));
            }
        }
        Some(Route::Redirect(location)) => {
            write!(
                out,
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )?;
        }
        Some(Route::Status(code)) => {
            write!(
                out,
                "HTTP/1.1 {code} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )?;
        }
        None => {
            write!(
                out,
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )?;
        }
    }
    out.flush()
}
