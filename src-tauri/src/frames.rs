//! Native frames into the page, behind src/viewport/pathtrace/nativeTracer.ts.
//! Windows posts three WebView2 shared buffers and the page pulls one tiny
//! invoke per frame (index, generation, seq), so no pixel crosses Tauri IPC;
//! a runtime without shared buffers (before 114), and every other platform,
//! uses the loopback WebSocket of fundacad-frames.

use std::sync::{Arc, OnceLock};

use fundacad_frames::{frame_size, Current, FrameSource, Transport, WebSocketTransport};
use serde::Serialize;

mod pattern;
pub mod tracer;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// What frames_close names, so a late close leaves a newer transport open.
    id: u64,
    kind: &'static str,
    generation: u32,
    port: Option<u16>,
    token: Option<String>,
    /// What renders the frames, for the log.
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Next {
    index: usize,
    generation: u32,
    seq: u32,
    width: u32,
    height: u32,
}

enum Open {
    Ws(WebSocketTransport),
    #[cfg(windows)]
    Shared(Arc<shared::SharedBufferTransport>),
}

impl Open {
    fn transport(&self) -> &dyn Transport {
        match self {
            Open::Ws(t) => t,
            #[cfg(windows)]
            Open::Shared(t) => t.as_ref(),
        }
    }
}

static OPEN: Current<Open> = Current::new();
static SOURCE: OnceLock<(Arc<dyn FrameSource>, String)> = OnceLock::new();

fn source() -> (Arc<dyn FrameSource>, String) {
    SOURCE
        .get_or_init(|| match tracer::tracer() {
            Some(t) => {
                let name = t.name();
                (t as Arc<dyn FrameSource>, name)
            }
            None => pattern::create(),
        })
        .clone()
}

fn token() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn open_ws(src: Arc<dyn FrameSource>, width: u32, height: u32) -> Result<(Open, Opened), String> {
    let token = token()?;
    let extra = fundacad_engine::ws::appenv("EXTRA_ORIGINS").unwrap_or_default();
    let gate = fundacad_engine::ws::Gate::new(token.clone(), &extra);
    let authorize: fundacad_frames::Authorize = Arc::new(move |q: Option<&str>, o: Option<&str>| gate.authorized(q, o));
    let notes: fundacad_frames::Notes = Arc::new(|s| eprintln!("[frames] {s}"));
    let t = WebSocketTransport::start(src, authorize, Some(notes), width, height).map_err(|e| e.to_string())?;
    let opened = Opened {
        id: 0,
        kind: "websocket",
        generation: t.generation(),
        port: Some(t.port()),
        token: Some(token),
        source: String::new(),
    };
    Ok((Open::Ws(t), opened))
}

/// Replaces any open transport. `prefer` "websocket" skips the shared buffers,
/// to compare the two on one machine.
#[tauri::command]
pub async fn frames_open(
    window: tauri::WebviewWindow,
    width: u32,
    height: u32,
    prefer: Option<String>,
) -> Result<Opened, String> {
    let (width, height) = frame_size(width, height)?;
    tauri::async_runtime::spawn_blocking(move || {
        close_open(OPEN.take());
        let (src, name) = source();
        #[cfg(windows)]
        if prefer.as_deref() != Some("websocket") {
            match shared::SharedBufferTransport::open(window, src.clone(), width, height) {
                Ok(t) => {
                    let generation = t.generation();
                    let id = install(Open::Shared(t));
                    return Ok(Opened { id, kind: "sharedbuffer", generation, port: None, token: None, source: name });
                }
                Err(e) => eprintln!("[frames] no shared buffers, WebSocket instead: {e}"),
            }
        }
        #[cfg(not(windows))]
        let _ = (window, prefer);
        let (open, mut opened) = open_ws(src, width, height)?;
        opened.source = name;
        opened.id = install(open);
        Ok(opened)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn install(open: Open) -> u64 {
    let (id, displaced) = OPEN.replace(open);
    close_open(displaced);
    id
}

/// The one invoke per frame on the shared buffer path. Releases the slots the
/// page finished with, as (index, generation), renders into a free one and
/// names it.
#[tauri::command]
pub async fn frames_next(release: Vec<(usize, u32)>) -> Result<Next, String> {
    #[cfg(windows)]
    {
        let t = match OPEN.with(|o| match o {
            Some(Open::Shared(t)) => Some(t.clone()),
            _ => None,
        }) {
            Some(t) => t,
            None => return Err("no shared buffers are open".into()),
        };
        tauri::async_runtime::spawn_blocking(move || t.next(release))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = release;
        Err("no shared buffers are open".into())
    }
}

/// Returns the generation frames of the new size carry.
#[tauri::command]
pub async fn frames_resize(width: u32, height: u32) -> Result<u32, String> {
    let (width, height) = frame_size(width, height)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let shared = OPEN.with(|o| match o {
            Some(Open::Shared(t)) => Some(t.clone()),
            _ => None,
        });
        #[cfg(windows)]
        if let Some(t) = shared {
            return t.resize_now(width, height);
        }
        OPEN.with(|o| match o {
            Some(open) => Ok(open.transport().resize(width, height)),
            None => Err("no frame transport is open".into()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Closes the transport `id` names, unless a newer one replaced it already.
#[tauri::command]
pub async fn frames_close(id: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || close_open(OPEN.take_if(id))).await;
}

fn close_open(open: Option<Open>) {
    #[cfg(windows)]
    if let Some(Open::Shared(t)) = &open {
        t.close();
    }
    drop(open);
}

#[cfg(windows)]
mod shared {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use fundacad_frames::{frame_bytes, Buffers, FrameSource, Transport, SLOTS};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17, ICoreWebView2_2,
        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
    };
    use windows_core::{Interface, HSTRING, PCWSTR};

    use super::Next;

    const UI_WAIT: Duration = Duration::from_secs(5);
    // The page reads a frame in a few ms; this long without a release means it
    // went away (a reload), and frames_open starts over.
    const SLOT_WAIT: Duration = Duration::from_secs(5);

    thread_local! {
        // The buffers are COM objects of the UI thread: created, posted and
        // Closed only inside with_webview.
        static POSTED: RefCell<Vec<ICoreWebView2SharedBuffer>> = const { RefCell::new(Vec::new()) };
    }

    #[derive(Clone, Copy)]
    struct Slots {
        ptrs: [usize; SLOTS],
        width: u32,
        height: u32,
    }

    pub struct SharedBufferTransport {
        window: tauri::WebviewWindow,
        buffers: Buffers<Slots>,
        seq: AtomicU32,
        source: Arc<dyn FrameSource>,
    }

    impl SharedBufferTransport {
        pub fn open(
            window: tauri::WebviewWindow,
            source: Arc<dyn FrameSource>,
            width: u32,
            height: u32,
        ) -> Result<Arc<SharedBufferTransport>, String> {
            let t = Arc::new(SharedBufferTransport {
                window,
                buffers: Buffers::new(Slots { ptrs: [0; SLOTS], width, height }),
                seq: AtomicU32::new(0),
                source,
            });
            t.resize_now(width, height)?;
            Ok(t)
        }

        pub fn generation(&self) -> u32 {
            self.buffers.ring.generation()
        }

        pub fn resize_now(&self, width: u32, height: u32) -> Result<u32, String> {
            self.buffers.swap(|generation| {
                let ptrs = self.post(generation, width, height)?;
                Ok(Slots { ptrs, width, height })
            })
        }

        pub fn next(&self, release: Vec<(usize, u32)>) -> Result<Next, String> {
            for (index, generation) in release {
                self.buffers.ring.release(index, generation);
            }
            let slot = self.buffers.ring.begin(SLOT_WAIT).ok_or("the page holds every frame buffer")?;
            let s = self.buffers.mem();
            let seq = self.seq.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
            let bytes = frame_bytes(s.width, s.height);
            // SAFETY: the section is `bytes` long, alive until retire, and the
            // page does not hold this slot, so nothing reads it while it is written.
            let out = unsafe { std::slice::from_raw_parts_mut(s.ptrs[slot.index] as *mut u8, bytes) };
            self.source.render(out, s.width, s.height, seq);
            self.buffers.ring.publish(slot);
            Ok(Next { index: slot.index, generation: slot.generation, seq, width: s.width, height: s.height })
        }

        pub fn close(&self) {
            self.buffers.close(|| {
                let _ = self.window.with_webview(|_| close_posted());
            });
        }

        /// Closes the old buffers and posts three new ones tagged with
        /// `generation`; the page releases its old ones when it sees it.
        fn post(&self, generation: u32, width: u32, height: u32) -> Result<[usize; SLOTS], String> {
            let bytes = frame_bytes(width, height) as u64;
            let (tx, rx) = mpsc::channel();
            self.window
                .with_webview(move |wv| {
                    let r = unsafe { post_on_ui(wv, generation, width, height, bytes) };
                    let _ = tx.send(r);
                })
                .map_err(|e| e.to_string())?;
            rx.recv_timeout(UI_WAIT).map_err(|_| "the UI thread never posted the buffers".to_string())?
        }
    }

    impl Transport for SharedBufferTransport {
        fn kind(&self) -> &'static str {
            "sharedbuffer"
        }

        fn resize(&self, width: u32, height: u32) -> u32 {
            self.resize_now(width, height).unwrap_or_else(|e| {
                eprintln!("[frames] resize: {e}");
                self.buffers.ring.generation()
            })
        }
    }

    fn close_posted() {
        POSTED.with(|p| {
            for b in p.borrow_mut().drain(..) {
                unsafe {
                    let _ = b.Close();
                }
            }
        });
    }

    unsafe fn post_on_ui(
        wv: tauri::webview::PlatformWebview,
        generation: u32,
        width: u32,
        height: u32,
        bytes: u64,
    ) -> Result<[usize; SLOTS], String> {
        let e = |e: windows_core::Error| e.to_string();
        let core = wv.controller().CoreWebView2().map_err(e)?;
        let env12 = core
            .cast::<ICoreWebView2_2>()
            .and_then(|c| c.Environment())
            .and_then(|env| env.cast::<ICoreWebView2Environment12>())
            .map_err(e)?;
        let core17 = core.cast::<ICoreWebView2_17>().map_err(e)?;
        close_posted();
        let mut ptrs = [0usize; SLOTS];
        for (i, ptr) in ptrs.iter_mut().enumerate() {
            let sb = env12.CreateSharedBuffer(bytes).map_err(e)?;
            let mut p: *mut u8 = std::ptr::null_mut();
            sb.Buffer(&mut p).map_err(e)?;
            *ptr = p as usize;
            let meta = HSTRING::from(format!(
                "{{\"frames\":1,\"i\":{i},\"g\":{generation},\"w\":{width},\"h\":{height}}}"
            ));
            let posted = core17.PostSharedBufferToScript(&sb, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, PCWSTR(meta.as_ptr()));
            POSTED.with(|list| list.borrow_mut().push(sb));
            posted.map_err(e)?;
        }
        Ok(ptrs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;
    use tungstenite::client::IntoClientRequest;

    struct Flat;
    impl FrameSource for Flat {
        fn render(&self, out: &mut [u8], _w: u32, _h: u32, _seq: u32) {
            out.fill(7);
        }
    }

    fn handshake(port: u16, query: &str, origin: &str) -> Result<(), u16> {
        let mut req = format!("ws://127.0.0.1:{port}/{query}").into_client_request().unwrap();
        req.headers_mut().insert("origin", origin.parse().unwrap());
        match tungstenite::client::client(req, TcpStream::connect(("127.0.0.1", port)).unwrap()) {
            Ok(_) => Ok(()),
            Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(r))) => Err(r.status().as_u16()),
            Err(e) => panic!("{e}"),
        }
    }

    // The app's WebSocket goes through the engine's Gate: the launch token and
    // the webview Origins only.
    #[test]
    fn the_websocket_takes_the_launch_token_from_the_webview_origin_only() {
        let (open, opened) = open_ws(Arc::new(Flat), 8, 8).unwrap();
        let port = opened.port.unwrap();
        let token = opened.token.unwrap();
        assert_eq!(handshake(port, &format!("?token={token}"), "http://tauri.localhost"), Ok(()));
        assert_eq!(handshake(port, &format!("?token={token}"), "tauri://localhost"), Ok(()));
        assert_eq!(handshake(port, &format!("?token={token}"), "https://evil.example"), Err(403));
        assert_eq!(handshake(port, "?token=nope", "tauri://localhost"), Err(403));
        drop(open);
    }
}
