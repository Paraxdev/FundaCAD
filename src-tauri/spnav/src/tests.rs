use super::*;

fn record(data: [i32; 8]) -> [u8; RECORD_BYTES] {
    let mut bytes = [0u8; RECORD_BYTES];
    for (chunk, value) in bytes.as_chunks_mut::<4>().0.iter_mut().zip(data) {
        chunk.copy_from_slice(&value.to_ne_bytes());
    }
    bytes
}

#[test]
fn motion_is_in_the_hid_frame_and_range() {
    assert_eq!(
        decode(&record([0, 500, 500, 500, 250, 250, 250, 8])),
        Some(Event::Motion { t: [350.0, -350.0, -350.0], r: [175.0, -175.0, -175.0] })
    );
    // The daemon swaps y and z before it sends: its y is a lift, its z a push
    // or pull, the HID report has them the other way round.
    assert_eq!(
        decode(&record([0, 0, 100, 200, 10, 20, 30, 8])),
        Some(Event::Motion { t: [0.0, -140.0, -70.0], r: [7.0, -21.0, -14.0] })
    );
    assert_eq!(decode(&record([0, 0, 0, 0, 0, 0, 0, 1200])), Some(Event::Motion { t: [0.0; 3], r: [0.0; 3] }));
}

#[test]
fn extreme_values_stay_inside_an_i16_axis() {
    let extreme = record([0, i32::MIN, i32::MIN, i32::MAX, i32::MAX, i32::MIN, i32::MIN, -1]);
    assert_eq!(
        decode(&extreme),
        Some(Event::Motion { t: [-32767.0, -32767.0, 32767.0], r: [32767.0, 32767.0, 32767.0] })
    );
}

#[test]
fn buttons_press_and_release_and_unknown_kinds_are_skipped() {
    assert_eq!(decode(&record([1, 1, 0, 0, 0, 0, 0, 0])), Some(Event::Button { number: 1, pressed: true }));
    assert_eq!(decode(&record([2, 1, 0, 0, 0, 0, 0, 0])), Some(Event::Button { number: 1, pressed: false }));
    assert_eq!(decode(&record([7, 500, 500, 500, 500, 500, 500, 0])), None);
}

#[test]
fn the_mask_follows_presses_and_ignores_numbers_it_cannot_hold() {
    let mask = apply_button(apply_button(0, 0, true), 1, true);
    assert_eq!(mask, 0b11);
    assert_eq!(apply_button(mask, 0, false), 0b10);
    assert_eq!(apply_button(mask, 32, true), mask);
    assert_eq!(apply_button(mask, -1, true), mask);
}

struct Trickle<'a>(&'a [u8]);
impl Read for Trickle<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.0.len().min(buf.len()).min(5);
        buf[..n].copy_from_slice(&self.0[..n]);
        self.0 = &self.0[n..];
        Ok(n)
    }
}

#[test]
fn records_split_across_reads_come_out_whole_and_the_end_is_an_error() {
    let mut bytes = Vec::new();
    bytes.extend(record([0, 100, 0, 0, 0, 0, 0, 8]));
    bytes.extend(record([1, 3, 0, 0, 0, 0, 0, 0]));
    bytes.extend([1, 2, 3]);
    let mut seen = Vec::new();
    let ended = pump(Trickle(&bytes), || true, |e| seen.push(e));
    assert_eq!(ended.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    assert_eq!(seen, [Event::Motion { t: [70.0, 0.0, 0.0], r: [0.0; 3] }, Event::Button { number: 3, pressed: true }]);
}

#[test]
fn a_stopped_reader_returns_cleanly() {
    assert!(pump(Trickle(&[]), || false, |_| {}).is_ok());
}

#[test]
fn a_daemon_that_is_absent_or_not_answering_gets_a_hint_that_fits() {
    let absent = NoDaemon::Absent.hint();
    assert!(absent.contains("start spacenavd"), "{absent}");
    assert!(absent.contains("udev rule"), "{absent}");
    let refused = NoDaemon::Refused.hint();
    assert!(refused.contains("not answering"), "{refused}");
    assert!(refused.contains("udev rule"), "{refused}");
}

#[cfg(unix)]
mod socket {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;

    fn socket_path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("fundacad-spnav-{}-{name}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    /// A device read directly that sends `report` from `after` on, and says when
    /// it was let go.
    #[derive(Debug)]
    struct FakeDevice {
        report: Vec<u8>,
        after: Instant,
        reads: Arc<AtomicUsize>,
        closed: Arc<AtomicBool>,
    }

    impl Device for FakeDevice {
        fn read_timeout(&mut self, buf: &mut [u8], ms: i32) -> io::Result<usize> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let left = self.after.saturating_duration_since(Instant::now());
            let wait = Duration::from_millis(ms as u64);
            if left > wait {
                thread::sleep(wait);
                return Ok(0);
            }
            thread::sleep(left);
            buf[..self.report.len()].copy_from_slice(&self.report);
            Ok(self.report.len())
        }
    }

    impl Drop for FakeDevice {
        fn drop(&mut self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    fn fake_device(after: Duration) -> (FakeDevice, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let reads = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let dev = FakeDevice {
            report: vec![1, 10, 0, 0, 0, 0, 0],
            after: Instant::now() + after,
            reads: reads.clone(),
            closed: closed.clone(),
        };
        (dev, reads, closed)
    }

    fn until(deadline: Duration, seen: &AtomicUsize, enough: usize) -> impl Fn() -> bool + '_ {
        let stop_at = Instant::now() + deadline;
        move || seen.load(Ordering::SeqCst) < enough && Instant::now() < stop_at
    }

    #[test]
    fn a_fake_daemon_socket_is_read_and_a_missing_one_is_not_connected() {
        let path = socket_path("read");
        let listener = UnixListener::bind(&path).expect("bind");
        let daemon = thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            conn.write_all(&record([0, 0, 500, 0, 0, 0, 0, 8])).expect("write");
            conn.write_all(&record([2, 0, 0, 0, 0, 0, 0, 0])).expect("write");
        });
        let stream = UnixStream::connect(&path).expect("connects to the fake daemon");
        let mut seen = Vec::new();
        let ended = pump(stream, || true, |e| seen.push(e));
        daemon.join().expect("daemon thread");
        let _ = std::fs::remove_file(&path);
        assert_eq!(ended.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(
            seen,
            [Event::Motion { t: [0.0, 0.0, -350.0], r: [0.0; 3] }, Event::Button { number: 0, pressed: false }]
        );
        assert!(UnixStream::connect(&path).is_err());
    }

    // Regression: an idle puck at launch with spacenavd running and no udev rule must not give up on the daemon.
    #[test]
    fn a_connected_daemon_silent_past_the_old_grace_is_kept_and_its_record_arrives() {
        let path = socket_path("silent");
        let listener = UnixListener::bind(&path).expect("bind");
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let daemon = thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            thread::sleep(Duration::from_secs(6));
            let wrote = conn.write_all(&record([0, 0, 0, 100, 0, 0, 0, 8]));
            let _ = done_rx.recv_timeout(Duration::from_secs(10));
            listener.set_nonblocking(true).expect("nonblocking");
            let second = listener.accept().is_ok();
            (wrote.map_err(|e| e.kind()), second)
        });
        let (path_used, stream) = connect(&[&path]).expect("the fake daemon answers");
        assert_eq!(path_used, path);
        let seen = AtomicUsize::new(0);
        let mut events = Vec::new();
        let opened = AtomicUsize::new(0);
        let started = Instant::now();
        let served = serve(
            stream,
            || {
                opened.fetch_add(1, Ordering::SeqCst);
                None::<FakeDevice>
            },
            until(Duration::from_secs(12), &seen, 1),
            |e| {
                seen.fetch_add(1, Ordering::SeqCst);
                events.push(e);
            },
        );
        let took = started.elapsed();
        done_tx.send(()).expect("daemon waits");
        let (wrote, second) = daemon.join().expect("daemon thread");
        let _ = std::fs::remove_file(&path);
        assert!(matches!(served, Served::Ended(Ok(()))), "{served:?}");
        assert_eq!(wrote, Ok(()), "the connection was still open at 6 s");
        assert!(!second, "the same connection was kept, no reconnect");
        assert!(took >= Duration::from_secs(6), "returned at {took:?}, before the record");
        assert_eq!(events, [Event::Motion { t: [0.0, -70.0, 0.0], r: [0.0; 3] }]);
        assert!(opened.load(Ordering::SeqCst) >= 2, "an unreadable device is tried again");
    }

    #[test]
    fn the_device_sending_first_is_kept_and_the_daemon_records_are_not_read() {
        let path = socket_path("device-first");
        let listener = UnixListener::bind(&path).expect("bind");
        let daemon = thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            thread::sleep(Duration::from_millis(400));
            let _ = conn.write_all(&record([0, 100, 0, 0, 0, 0, 0, 8]));
        });
        let (_, stream) = connect(&[&path]).expect("connects");
        let (dev, _, closed) = fake_device(Duration::from_millis(150));
        let mut dev = Some(dev);
        let seen = AtomicUsize::new(0);
        let served = serve(
            stream,
            || dev.take(),
            until(Duration::from_secs(3), &seen, 1),
            |_| {
                seen.fetch_add(1, Ordering::SeqCst);
            },
        );
        daemon.join().expect("daemon thread");
        let _ = std::fs::remove_file(&path);
        let Served::Device(kept, first) = served else {
            panic!("the device sent first, got {served:?}");
        };
        assert_eq!(first, kept.report);
        assert!(!closed.load(Ordering::SeqCst), "the device is handed back open");
        assert_eq!(seen.load(Ordering::SeqCst), 0, "no daemon event reached the page");
    }

    #[test]
    fn the_daemon_sending_first_is_kept_and_the_device_is_let_go() {
        let path = socket_path("daemon-first");
        let listener = UnixListener::bind(&path).expect("bind");
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let daemon = thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            thread::sleep(Duration::from_millis(100));
            conn.write_all(&record([1, 2, 0, 0, 0, 0, 0, 0])).expect("write");
            let _ = done_rx.recv_timeout(Duration::from_secs(5));
        });
        let (_, stream) = connect(&[&path]).expect("connects");
        let (dev, reads, closed) = fake_device(Duration::from_millis(300));
        let mut dev = Some(dev);
        let seen = AtomicUsize::new(0);
        let mut events = Vec::new();
        let served = serve(
            stream,
            || dev.take(),
            until(Duration::from_millis(900), &seen, usize::MAX),
            |e| {
                seen.fetch_add(1, Ordering::SeqCst);
                events.push(e);
            },
        );
        done_tx.send(()).expect("daemon waits");
        daemon.join().expect("daemon thread");
        let _ = std::fs::remove_file(&path);
        assert!(matches!(served, Served::Ended(Ok(()))), "{served:?}");
        assert_eq!(events, [Event::Button { number: 2, pressed: true }]);
        assert!(closed.load(Ordering::SeqCst), "the device is let go");
        assert!(reads.load(Ordering::SeqCst) <= 4, "the device is not read once the daemon is kept");
    }

    #[test]
    fn when_both_have_sent_the_daemon_is_preferred_over_the_device() {
        let path = socket_path("tie");
        let listener = UnixListener::bind(&path).expect("bind");
        let (_, stream) = connect(&[&path]).expect("connects");
        let (mut conn, _) = listener.accept().expect("accept");
        conn.write_all(&record([1, 4, 0, 0, 0, 0, 0, 0])).expect("write");
        let (dev, _, closed) = fake_device(Duration::ZERO);
        let mut dev = Some(dev);
        let seen = AtomicUsize::new(0);
        let served = serve(
            stream,
            || dev.take(),
            until(Duration::from_secs(2), &seen, 1),
            |_| {
                seen.fetch_add(1, Ordering::SeqCst);
            },
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
        assert!(matches!(served, Served::Ended(Ok(()))), "{served:?}");
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        assert!(closed.load(Ordering::SeqCst));
    }

    #[test]
    fn a_daemon_a_moment_behind_the_device_is_still_preferred() {
        let path = socket_path("behind");
        let listener = UnixListener::bind(&path).expect("bind");
        let (_, stream) = connect(&[&path]).expect("connects");
        let (mut conn, _) = listener.accept().expect("accept");
        let (dev, _, closed) = fake_device(Duration::from_millis(100));
        let daemon = thread::spawn(move || {
            thread::sleep(Duration::from_millis(110));
            conn.write_all(&record([0, 100, 0, 0, 0, 0, 0, 8])).expect("write");
            thread::sleep(Duration::from_millis(300));
        });
        let mut dev = Some(dev);
        let seen = AtomicUsize::new(0);
        let served = serve(
            stream,
            || dev.take(),
            until(Duration::from_secs(2), &seen, 1),
            |_| {
                seen.fetch_add(1, Ordering::SeqCst);
            },
        );
        daemon.join().expect("daemon thread");
        let _ = std::fs::remove_file(&path);
        assert!(matches!(served, Served::Ended(Ok(()))), "{served:?}");
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        assert!(closed.load(Ordering::SeqCst), "the device is let go");
    }

    #[test]
    fn a_restarted_daemon_ends_the_connection_and_the_next_one_is_read() {
        let path = socket_path("restart");
        let listener = UnixListener::bind(&path).expect("bind");
        let (_, stream) = connect(&[&path]).expect("connects");
        drop(listener.accept().expect("accept"));
        drop(listener);
        let seen = AtomicUsize::new(0);
        let served = serve(stream, || None::<FakeDevice>, until(Duration::from_secs(3), &seen, 1), |_| {});
        let Served::Ended(Err(e)) = served else {
            panic!("a closed daemon ends the connection, got {served:?}");
        };
        assert_eq!(e.kind(), io::ErrorKind::UnexpectedEof);

        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind again");
        let daemon = thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            conn.write_all(&record([2, 1, 0, 0, 0, 0, 0, 0])).expect("write");
            thread::sleep(Duration::from_millis(300));
        });
        let (_, stream) = connect(&[&path]).expect("the restarted daemon answers");
        let mut events = Vec::new();
        let served = serve(
            stream,
            || None::<FakeDevice>,
            until(Duration::from_secs(3), &seen, 1),
            |e| {
                seen.fetch_add(1, Ordering::SeqCst);
                events.push(e);
            },
        );
        daemon.join().expect("daemon thread");
        let _ = std::fs::remove_file(&path);
        assert!(matches!(served, Served::Ended(Ok(()))), "{served:?}");
        assert_eq!(events, [Event::Button { number: 1, pressed: false }]);
    }

    #[test]
    fn no_socket_is_absent_and_a_dead_one_is_not_answering() {
        let missing = socket_path("missing");
        assert_eq!(connect(&[&missing]).unwrap_err(), NoDaemon::Absent);

        let stale = socket_path("stale");
        drop(UnixListener::bind(&stale).expect("bind"));
        assert!(stale.exists(), "a daemon that died leaves its socket file");
        assert_eq!(connect(&[&missing, &stale]).unwrap_err(), NoDaemon::Refused);
        let _ = std::fs::remove_file(&stale);
    }
}
