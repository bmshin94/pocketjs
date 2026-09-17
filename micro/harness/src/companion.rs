//! Desktop IO worker. Sync channels bound both directions to one record;
//! the render thread uses try_send/try_recv and never waits on the child.
use pocket_micro::window::{Bridge, Transport};
use std::{
    cell::RefCell,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender},
        Arc,
    },
    thread,
};
struct Endpoint {
    send: SyncSender<String>,
    receive: Receiver<String>,
    online: Arc<AtomicBool>,
}
thread_local! { static ENDPOINT: RefCell<Option<Endpoint>> = const { RefCell::new(None) }; }
pub fn connect(manifest: &str, directory: &str) -> Bridge {
    let (send, requests) = sync_channel::<String>(1);
    let (responses, receive) = sync_channel::<String>(1);
    let online = Arc::new(AtomicBool::new(true));
    let alive = online.clone();
    let mut child = Command::new("bun")
        .args(["micro/companion/stdio.ts", manifest, directory])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start Companion");
    thread::spawn(move || {
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        while let Ok(record) = requests.recv() {
            if writeln!(input, "{record}").is_err() {
                break;
            }
            let mut reply = String::new();
            // Bounded read: reject a provider record larger than the wire budget.
            if std::io::Read::take(&mut output, 4098)
                .read_line(&mut reply)
                .unwrap_or(0)
                == 0
                || reply.len() > 4097
                || !reply.ends_with('\n')
            {
                break;
            }
            reply.pop(); // The newline belongs to stdio framing, not the record.
            if responses.send(reply).is_err() {
                break;
            }
        }
        alive.store(false, Ordering::Release);
        let _ = child.kill();
        let _ = child.wait();
    });
    ENDPOINT.with(|e| {
        *e.borrow_mut() = Some(Endpoint {
            send,
            receive,
            online,
        })
    });
    Bridge::new(Transport {
        session: || {
            ENDPOINT.with(|e| {
                e.borrow()
                    .as_ref()
                    .map_or(0, |e| i32::from(e.online.load(Ordering::Acquire)))
            })
        },
        submit: |s| {
            ENDPOINT.with(|e| {
                e.borrow()
                    .as_ref()
                    .is_some_and(|e| e.send.try_send(s.into()).is_ok())
            })
        },
        take: || ENDPOINT.with(|e| e.borrow().as_ref().and_then(|e| e.receive.try_recv().ok())),
    })
}
