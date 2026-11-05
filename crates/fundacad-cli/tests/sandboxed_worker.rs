//! The app's worker with its reduced rights and the real kernel: it still imports a user's file and exports into its
//! own folder, while an export into any other folder is refused where the system can limit writes.

use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use fundacad_protocol::{read_message, write_message, Message};
use serde_json::{json, Value};

struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Message>,
    stderr: Receiver<String>,
}

impl Worker {
    fn spawn(root: &Path) -> Worker {
        let tmp = root.join("tmp");
        let mut child = Command::new(env!("CARGO_BIN_EXE_fundacad-engine"))
            .arg("--stdio")
            .env("FUNDACAD_ENGINE_SANDBOX", "1")
            .env("TMP", &tmp)
            .env("TEMP", &tmp)
            .env("TMPDIR", &tmp)
            .env("FUNDACAD_BLOB_DIR", root.join("blobs"))
            .env("XDG_CACHE_HOME", root.join("cache"))
            .env("FUNDACAD_PLUGIN_DIR", root.join("plugins"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn the engine");
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
        Worker { stdin: child.stdin.take(), child, frames, stderr: stderr_rx }
    }

    /// The final reply to `req`, past any progress frames.
    fn call(&mut self, req: Value) -> Value {
        let id = req["id"].clone();
        write_message(self.stdin.as_mut().unwrap(), &Message::Text(req.to_string())).expect("write a request");
        let t0 = Instant::now();
        loop {
            let left = Duration::from_secs(120).saturating_sub(t0.elapsed());
            let m = self.frames.recv_timeout(left).unwrap_or_else(|_| panic!("no reply to {id}"));
            let Message::Text(t) = m else { continue };
            let v: Value = serde_json::from_str(&t).unwrap_or_else(|e| panic!("{e}: {t}"));
            if v["id"] == id && v.get("ok").is_some() {
                return v;
            }
        }
    }

    fn finish(mut self) -> String {
        drop(self.stdin.take());
        let t0 = Instant::now();
        while self.child.try_wait().unwrap().is_none() {
            if t0.elapsed() > Duration::from_secs(30) {
                let _ = self.child.kill();
                panic!("the engine did not exit");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        self.stderr.recv_timeout(Duration::from_secs(5)).unwrap_or_default()
    }
}

/// Whether this system lets the engine limit its own writes.
fn limits_writes() -> bool {
    #[cfg(target_os = "linux")]
    {
        // landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) answers the ABI, or fails without landlock.
        let abi = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, std::ptr::null::<u8>(), 0usize, 1u32) };
        abi >= 1
    }
    #[cfg(not(target_os = "linux"))]
    {
        cfg!(windows)
    }
}

fn two_bodies() -> Value {
    json!({"features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b", "type": "sphere", "radius": 4},
        {"id": "m", "type": "move", "x": 30},
    ]})
}

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn the_sandboxed_engine_imports_user_files_and_exports_into_its_own_folder() {
    // Labelling needs a folder the user owns, so not the repo's drive: a child of the shared temp folder.
    let root: PathBuf = std::env::temp_dir().join(format!("fundacad-sandboxed-worker-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let outside = root.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::create_dir_all(root.join("plugins")).unwrap();

    let mut w = Worker::spawn(&root);
    assert_eq!(w.call(json!({"id": "p", "op": "ping"}))["ok"], true);

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/asm_colors.step");
    let r = w.call(json!({"id": "i", "op": "import", "format": "step", "path": text(&fixture)}));
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["result"]["parts"][0], json!({"node": 1, "faces": 6, "color": "#e51919"}));
    let geom = r["result"]["geom"].as_str().expect("a geometry blob");
    assert!(root.join("blobs").join(format!("{geom}.bbrep")).is_file(), "the blob store was not written");

    // Made after the engine labelled its temp folder, as the app makes its export stages.
    let stage = root.join("tmp").join("exports").join("1");
    std::fs::create_dir_all(&stage).unwrap();
    for (n, format) in ["step", "stl"].into_iter().enumerate() {
        let path = stage.join(format!("part.{format}"));
        let r = w.call(json!({"id": format!("e{n}"), "op": "export", "document": two_bodies(), "format": format,
                              "path": text(&path)}));
        assert_eq!(r["ok"], true, "{r}");
        assert!(std::fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false), "{format} was not written");
    }

    let away = outside.join("part.stl");
    let refused = w.call(json!({"id": "x", "op": "export", "document": two_bodies(), "format": "stl",
                                "path": text(&away)}));
    let written = away.exists();
    let stderr = w.finish();
    let _ = std::fs::remove_dir_all(&root);

    let without = stderr.lines().find(|l| l.starts_with("engine: runs without reduced rights"));
    if cfg!(any(windows, target_os = "linux")) {
        assert!(without.is_none(), "the engine runs without its reduced rights: {stderr}");
    }
    if without.is_none() && limits_writes() {
        assert_eq!(refused["ok"], false, "an export outside the engine's folders went through: {refused}");
        assert!(!written, "the engine wrote outside its folders");
    } else {
        println!("note: this system cannot limit the engine's writes, so the export outside was not checked");
    }
}
