#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ResponseSpec {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub chunked: bool,
    pub chunks: Vec<Vec<u8>>,
}

impl ResponseSpec {
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
            chunked: false,
            chunks: Vec::new(),
        }
    }

    pub fn json(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".to_string(), "application/json".to_string())],
            body: body.into().into_bytes(),
            chunked: false,
            chunks: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into().into_bytes();
        self
    }

    pub fn with_chunks(mut self, chunks: Vec<Vec<u8>>) -> Self {
        self.chunked = true;
        self.chunks = chunks;
        self.body.clear();
        self
    }
}

#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub target: String,
    pub path: String,
    pub headers: HashMap<String, String>,
}

impl RecordedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

pub struct MockServer {
    pub base_url: String,
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

/// Bind and start listening before the port number is handed to a client.
///
/// `TcpListener` already listens inside `bind`; keeping the socket nonblocking
/// only for accept polling (and never closing/reopening it) means a client can
/// never connect to a port that is not yet in `LISTEN`.
fn bind_listener() -> (TcpListener, SocketAddr) {
    // One listener per mock server, bound once. A transient client-side abort
    // (reqwest is canceled, socket reused) must not permanently stop the mock,
    // because the same server serves multiple sequential requests in a test.
    // Accept errors are retried with backoff for the server's lifetime instead.
    static STAGGER: Mutex<()> = Mutex::new(());
    let _guard = STAGGER.lock().unwrap();

    let mut last_error = None;
    for _ in 0..10 {
        match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => {
                listener
                    .set_nonblocking(true)
                    .expect("set mock server nonblocking");
                let addr = listener.local_addr().expect("mock server address");
                return (listener, addr);
            }
            Err(error) => last_error = Some(error),
        }
    }
    panic!("could not bind a mock server port: {last_error:?}");
}

impl MockServer {
    pub fn start(responses: Vec<ResponseSpec>) -> Self {
        let (listener, addr) = bind_listener();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let thread_requests = Arc::clone(&requests);
        let thread_stop = Arc::clone(&stop);
        let join = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut next_response = 0usize;
            while next_response < responses.len()
                && Instant::now() < deadline
                && !thread_stop.load(Ordering::Relaxed)
            {
                match listener.accept() {
                    Ok((mut stream, _peer)) => {
                        // The listener socket is nonblocking, and on Windows a
                        // socket inherited/accepted from a nonblocking listener
                        // can still block. Reset the mode explicitly and use a
                        // bounded retry for the request head so one slow or
                        // aborted connection can never wedge the accept loop.
                        stream.set_nonblocking(false).ok();
                        stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
                        let Some(request) = read_request(&mut stream) else {
                            thread::sleep(Duration::from_millis(1));
                            continue;
                        };
                        let response = responses[next_response].clone();
                        next_response += 1;
                        write_response(&mut stream, &response);
                        thread_requests.lock().unwrap().push(request);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionAborted
                                | std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionRefused
                                | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(2));
                    }
                }
            }
        });

        Self {
            base_url: format!("http://{addr}"),
            addr,
            requests,
            stop,
            join: Some(join),
        }
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }

    pub fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    pub fn wait_for_requests(&self, count: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.request_count() >= count {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        self.request_count() >= count
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Read one request, write its prepared response and only then record it.
///
/// Recording last matters: `wait_for_requests` polls the recorded list, and a
/// request must not look "done" while its response is still being written.
fn read_request(stream: &mut TcpStream) -> Option<RecordedRequest> {
    let mut buffer = Vec::new();
    loop {
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        let mut chunk = [0u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                buffer.extend_from_slice(&chunk[..count]);
                if buffer.len() > 64 * 1024 {
                    return None;
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                // Do not consume a planned response for an incomplete request.
                return None;
            }
            Err(_) => break,
        }
    }

    let text = std::str::from_utf8(&buffer).ok()?;
    let head = text.split("\r\n\r\n").next().unwrap_or(text);
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let version = parts.next().unwrap_or_default();
    let path = target.split('?').next().unwrap_or(&target).to_string();

    // Only a complete HTTP/1.x request is a real request. A reset or aborted
    // connection must not consume a planned response, otherwise the next real
    // request would receive the following queued response.
    if !version.starts_with("HTTP/") || method != "GET" {
        return None;
    }

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Some(RecordedRequest {
        method,
        target,
        path,
        headers,
    })
}

fn write_response(stream: &mut TcpStream, response: &ResponseSpec) {
    let reason = match response.status {
        200 => "OK",
        204 => "No Content",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Response",
    };

    let mut head = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\n",
        response.status, reason
    );
    let mut has_length = false;
    let mut has_transfer_encoding = false;
    for (name, value) in &response.headers {
        if name.eq_ignore_ascii_case("content-length") {
            has_length = true;
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            has_transfer_encoding = true;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if response.chunked && !has_transfer_encoding {
        head.push_str("Transfer-Encoding: chunked\r\n");
    }
    if !response.chunked && !has_length {
        head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    }
    head.push_str("\r\n");

    stream.write_all(head.as_bytes()).ok();
    if response.chunked {
        for chunk in &response.chunks {
            stream
                .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                .ok();
            stream.write_all(chunk).ok();
            stream.write_all(b"\r\n").ok();
        }
        stream.write_all(b"0\r\n\r\n").ok();
    } else if !response.body.is_empty() {
        stream.write_all(&response.body).ok();
    }
    stream.flush().ok();
}
