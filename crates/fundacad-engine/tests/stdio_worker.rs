//! The stdio transport end to end: this test binary starts itself as a worker
//! (`--worker`) and talks to it over real pipes, the way the app does. It is a
//! GUI subsystem program like the shipped app, which sets up its standard
//! streams differently from a console one.

#![windows_subsystem = "windows"]

use fundacad_engine::{error_result, JobContext, Jobs};
use fundacad_protocol::{
    read_message, write_message, FullBody, JobResult, MeshResult, Message, WireBody,
};
use serde_json::{json, Map, Value};
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

/// Writes to every stdout a job could reach while it runs, the way OpenCASCADE
/// and third party C++ do, then answers with `triangles` triangles.
#[derive(Default)]
struct Noisy;

impl Jobs for Noisy {
    fn rebuild(
        &mut self,
        doc: &Value,
        _t: f64,
        _k: &Map<String, Value>,
        _f: bool,
        _c: &JobContext,
    ) -> JobResult {
        println!("rust println noise");
        print!("{{\"id\": \"forged\", \"ok\": true}}");
        std::io::stdout().flush().unwrap();
        // SAFETY: CRT calls on this process's own standard streams.
        unsafe {
            libc::printf(c"crt printf noise %d\n".as_ptr(), 42);
            libc::fflush(std::ptr::null_mut());
            let raw = b"\x05\x00\x00\x00\x01hello";
            libc::write(1, raw.as_ptr().cast(), raw.len() as _);
        }
        let n = doc["triangles"].as_u64().unwrap_or(1) as usize;
        let mut b = FullBody::new("body1", "body1", "e1");
        b.positions = (0..n * 9).map(|i| i as f32).collect();
        b.indices = (0..n as u32 * 3).collect();
        b.face_ids = vec![0; n];
        let mut fields = Map::new();
        fields.insert("protocol".into(), json!(2));
        fields.insert("bodies".into(), Value::Null);
        JobResult::Mesh(MeshResult {
            fields,
            bodies: vec![WireBody::Full(b)],
        })
    }

    fn run(&mut self, op: &str, _req: &Map<String, Value>, _ctx: &JobContext) -> JobResult {
        error_result(&format!("no {op} here"))
    }
}

struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Message>,
    stderr: Receiver<String>,
}

impl Worker {
    fn spawn() -> Worker {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn the worker");
        let mut stdout = BufReader::with_capacity(1 << 20, child.stdout.take().unwrap());
        let mut stderr = child.stderr.take().unwrap();
        let (tx, frames) = channel();
        std::thread::spawn(move || {
            while let Ok(Some(m)) = read_message(&mut stdout) {
                if tx.send(m).is_err() {
                    break;
                }
            }
        });
        let (etx, stderr_rx) = channel();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            let _ = etx.send(s);
        });
        Worker {
            stdin: child.stdin.take(),
            child,
            frames,
            stderr: stderr_rx,
        }
    }

    fn send(&mut self, m: Message) {
        write_message(self.stdin.as_mut().unwrap(), &m).expect("write a request");
    }

    fn request(&mut self, v: Value) {
        self.send(Message::Text(v.to_string()));
    }

    fn next(&self) -> Message {
        self.frames
            .recv_timeout(Duration::from_secs(20))
            .expect("a frame from the worker")
    }

    fn next_text(&self) -> Value {
        match self.next() {
            Message::Text(t) => serde_json::from_str(&t).unwrap_or_else(|e| panic!("{e}: {t}")),
            Message::Binary(_) => panic!("expected a text message"),
        }
    }

    fn wait(&mut self) -> ExitStatus {
        let t0 = Instant::now();
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s;
            }
            assert!(
                t0.elapsed() < Duration::from_secs(20),
                "the worker did not exit"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn header(frame: &[u8]) -> Value {
    let n = u32::from_le_bytes(frame[0..4].try_into().unwrap()) as usize;
    serde_json::from_slice(&frame[4..4 + n]).expect("a JSON frame header")
}

fn conversation() {
    let mut w = Worker::spawn();

    w.request(json!({"id": "p", "op": "ping"}));
    assert_eq!(
        w.next_text(),
        json!({"id": "p", "ok": true, "result": {"pong": true}})
    );

    w.request(json!({"id": "c", "op": "cancel"}));
    assert_eq!(
        w.next_text(),
        json!({"id": "c", "ok": true, "result": {"cancelled": false}})
    );

    w.send(Message::Text("{not json".into()));
    let bad = w.next_text();
    assert_eq!(bad["ok"], false);
    assert!(bad["error"]["message"]
        .as_str()
        .unwrap()
        .starts_with("bad JSON"));
    w.send(Message::Binary(vec![0xde, 0xad]));
    assert_eq!(w.next_text()["ok"], false);

    w.request(json!({"id": "u", "op": "frobnicate"}));
    assert_eq!(w.next_text()["error"]["message"], "no frobnicate here");

    w.request(json!({"id": "r1", "op": "rebuild", "revision": 1, "document": {"features": []}}));
    let r1 = w.next_text();
    assert_eq!(r1["id"], "r1");
    assert_eq!(r1["ok"], true, "{r1}");

    // About 50 MB of mesh, one body, streamed the way the client asks for it.
    let triangles = 50_000_000 / (9 * 4 + 3 * 4 + 4);
    let t0 = Instant::now();
    w.request(
        json!({"id": "r2", "op": "rebuild", "binary": true, "chunked": true, "revision": 1,
                     "document": {"features": [], "triangles": triangles}}),
    );
    let mut bytes = 0;
    loop {
        let Message::Binary(b) = w.next() else {
            panic!("expected a binary frame")
        };
        bytes += b.len();
        let h = header(&b);
        assert_eq!(h["id"], "r2");
        if h["stream"]["final"] == true {
            break;
        }
    }
    eprintln!(
        "stdio_worker: {bytes} bytes of binary reply in {:?}",
        t0.elapsed()
    );
    assert!(bytes > 50_000_000);

    w.request(json!({"id": "p2", "op": "ping"}));
    assert_eq!(w.next_text()["id"], "p2");

    drop(w.stdin.take());
    let status = w.wait();
    assert!(status.success(), "worker exited with {status}");
    assert!(
        w.frames.recv_timeout(Duration::from_secs(5)).is_err(),
        "nothing after the replies"
    );
    let stderr = w.stderr.recv_timeout(Duration::from_secs(5)).unwrap();
    for noise in [
        "rust println noise",
        "crt printf noise 42",
        "forged",
        "hello",
    ] {
        assert!(
            stderr.contains(noise),
            "{noise:?} did not reach stderr: {stderr}"
        );
    }
}

fn a_broken_frame_ends_the_worker() {
    let mut w = Worker::spawn();
    w.stdin
        .as_mut()
        .unwrap()
        .write_all(&[1, 0, 0, 0, 9, 0])
        .unwrap();
    let status = w.wait();
    assert_eq!(status.code(), Some(3));
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--worker") {
        fundacad_engine::stdio::run(Noisy);
    }
    for (name, test) in [
        ("conversation", conversation as fn()),
        (
            "a_broken_frame_ends_the_worker",
            a_broken_frame_ends_the_worker,
        ),
    ] {
        test();
        println!("test {name} ... ok");
    }
}
