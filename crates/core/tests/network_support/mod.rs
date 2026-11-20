#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Bounded wait for the client to finish sending its request head.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
/// Bounded wait for the kernel to accept response bytes. A client that stops
/// reading must not be able to block the mock server thread indefinitely.
const RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
/// How long `Drop` waits for the server thread before detaching it.
const SERVER_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Hard lifetime bound for a mock server thread, even if a client vanishes.
const SERVER_LIFETIME: Duration = Duration::from_secs(30);

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
    shutdown_listener: Option<TcpListener>,
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
        // The shutdown handle owns its own listener clone, so `Drop` can
        // unblock a pending `accept` on every platform without waiting for the
        // polling loop to notice `stop`.
        let shutdown_listener = listener.try_clone().ok();
        // Bound the whole server lifetime so a hung client cannot leak the
        // thread for the duration of the test run.
        let deadline = Instant::now() + SERVER_LIFETIME;
        let join = thread::spawn(move || {
            let mut next_response = 0usize;
            while next_response < responses.len()
                && !thread_stop.load(Ordering::Relaxed)
                && Instant::now() < deadline
            {
                match listener.accept() {
                    Ok((mut stream, _peer)) => {
                        // Bound every socket operation. A read timeout alone is
                        // not enough: the oversized-response test makes the
                        // client stop reading at its cap, so a large write would
                        // block forever and `Drop` would join that thread until
                        // the CI job is cancelled.
                        stream.set_nonblocking(false).ok();
                        stream.set_read_timeout(Some(REQUEST_TIMEOUT)).ok();
                        stream.set_write_timeout(Some(RESPONSE_WRITE_TIMEOUT)).ok();
                        let Some(request) = read_request(&mut stream) else {
                            thread::sleep(Duration::from_millis(1));
                            continue;
                        };
                        let response = responses[next_response].clone();
                        next_response += 1;
                        // Record the completed request regardless of how much of
                        // the response the client was willing to read; the
                        // remaining planned responses stay queued in order. The
                        // write-then-record order is deliberate -- see the note
                        // on `read_request`.
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
            shutdown_listener,
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

    /// Wait until at least `count` requests have been recorded, or the timeout
    /// expires. Returns whether the count was reached.
    ///
    /// The server records a request *after* it has written the response, so a
    /// caller that has just received a response may observe a count that is
    /// still one short. Callers must therefore wait here rather than assert on
    /// `request_count()` immediately.
    ///
    /// That ordering is deliberate: it keeps the count from running ahead of
    /// delivery, so `wait_for_requests(n)` is a reliable signal that n
    /// responses have actually been written. Reversing the two would make this
    /// function return while a response was still going out.
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
        // Dropping a listener clone wakes a pending nonblocking `accept` with an
        // error/poll wakeup instead of waiting for the next poll tick.
        if let Some(listener) = self.shutdown_listener.take() {
            let _ = listener.set_nonblocking(true);
            // Bind-then-connect on the same port makes `accept` observe a
            // ready state immediately on platforms that need a wakeup.
            let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(50));
            drop(listener);
        }
        if let Some(join) = self.join.take() {
            // The server thread polls `stop` and every socket operation has a
            // timeout, so it should exit promptly. Wait with a bounded grace
            // period and detach instead of joining forever: a hung mock in a
            // test must never hold the whole CI job.
            let deadline = Instant::now() + SERVER_SHUTDOWN_GRACE;
            while !join.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if join.is_finished() {
                let _ = join.join();
            }
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

    if !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
        return None;
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

    // Every write is bounded by the socket write timeout and aborts the rest of
    // the response on the first error. A client that deliberately stops reading
    // after a cap must never pin this thread (and `Drop`'s join) indefinitely.
    if write_chunk(stream, head.as_bytes()).is_err() {
        return;
    }
    if response.chunked {
        for chunk in &response.chunks {
            if write_chunk(stream, format!("{:x}\r\n", chunk.len()).as_bytes()).is_err() {
                return;
            }
            if write_chunk(stream, chunk).is_err() {
                return;
            }
            if write_chunk(stream, b"\r\n").is_err() {
                return;
            }
        }
        let _ = write_chunk(stream, b"0\r\n\r\n");
        return;
    }
    if !response.body.is_empty() && write_chunk(stream, &response.body).is_err() {
        return;
    }
    let _ = stream.flush();
}

/// Write the whole buffer or fail; no partial retry loop is attempted.
fn write_chunk(stream: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    stream.write_all(bytes)
}
