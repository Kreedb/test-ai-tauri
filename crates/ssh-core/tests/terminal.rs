use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use russh::{
    Channel, ChannelId, Pty,
    keys::{HashAlg, PrivateKey, ssh_key::private::Ed25519Keypair},
    server::{self, Server as _, Session},
};
use ssh_core::{ConnectionRequest, SshService, TerminalEvent, TerminalSize};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{interval, timeout},
};

const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

#[derive(Clone)]
struct EchoServer {
    auth_attempts: Arc<AtomicUsize>,
    sizes: mpsc::UnboundedSender<(u32, u32)>,
    opened: mpsc::UnboundedSender<usize>,
    closed: mpsc::UnboundedSender<()>,
    reject_shell: bool,
}

impl Drop for EchoServer {
    fn drop(&mut self) {
        let _ = self.closed.send(());
    }
}

impl server::Server for EchoServer {
    type Handler = Self;

    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for EchoServer {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "demo" && password == "test-only" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(term, "xterm-256color");
        assert_eq!(modes, [(Pty::IUTF8, 1)]);
        let _ = self.sizes.send((cols, rows));
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.reject_shell {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
            session.data(channel, b"ready\r\n".to_vec())?;
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if data == b"flood\r" {
            for _ in 0..256 {
                session.data(channel, vec![b'x'; 32768])?;
            }
        } else if data == [3] {
            let _ = self.sizes.send((0, 0));
        } else if data == b"exit\r" {
            session.exit_status_request(channel, 0)?;
            session.data(channel, b"goodbye\r\n".to_vec())?;
            session.close(channel)?;
        } else if data == b"crash\r" {
            session.exit_signal_request(channel, russh::Sig::SEGV, true, "segfault", "en")?;
            session.data(channel, b"boom\r\n".to_vec())?;
            session.close(channel)?;
        } else if data == b"open\r" {
            let handle = session.handle();
            let opened = self.opened.clone();
            tokio::spawn(async move {
                let mut accepted = 0;
                for _ in 0..200 {
                    if handle.channel_open_session().await.is_ok() {
                        accepted += 1;
                    }
                }
                let _ = opened.send(accepted);
            });
        } else if data == b"drop\r" {
            return Err(russh::Error::Disconnect);
        } else {
            for chunk in data.chunks(512) {
                session.data(channel, chunk.to_vec())?;
            }
        }
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        _: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        let _ = self.sizes.send((cols, rows));
        Ok(())
    }
}

struct TestServer {
    port: u16,
    fingerprint: String,
    auth_attempts: Arc<AtomicUsize>,
    sizes: mpsc::UnboundedReceiver<(u32, u32)>,
    opened: mpsc::UnboundedReceiver<usize>,
    closed: mpsc::UnboundedReceiver<()>,
    task: JoinHandle<()>,
}

impl TestServer {
    async fn start(reject_shell: bool) -> Self {
        Self::start_with(reject_shell, None).await
    }

    async fn start_with(reject_shell: bool, window_size: Option<u32>) -> Self {
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&[7; 32]));
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let mut config = server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        };
        if let Some(window_size) = window_size {
            config.window_size = window_size;
        }
        let config = Arc::new(config);
        let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let (sizes_tx, sizes) = mpsc::unbounded_channel();
        let (opened_tx, opened) = mpsc::unbounded_channel();
        let (closed_tx, closed) = mpsc::unbounded_channel();
        let auth_attempts = Arc::new(AtomicUsize::new(0));
        let mut handler = EchoServer {
            auth_attempts: auth_attempts.clone(),
            sizes: sizes_tx,
            opened: opened_tx,
            closed: closed_tx,
            reject_shell,
        };
        let task = tokio::spawn(async move {
            handler.run_on_socket(config, &socket).await.unwrap();
        });
        Self {
            port,
            fingerprint,
            auth_attempts,
            sizes,
            opened,
            closed,
            task,
        }
    }

    fn request(&self) -> ConnectionRequest {
        ConnectionRequest {
            host: "127.0.0.1".into(),
            port: self.port,
            username: "demo".into(),
            password: "test-only".into(),
            host_key_sha256: self.fingerprint.clone(),
            ignore_host_key: false,
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn connect(service: &SshService, server: &TestServer) -> u32 {
    service
        .connect(server.request(), SIZE, service.generation())
        .await
        .unwrap()
}

async fn read_bytes(service: &SshService, id: u32, expected: &[u8]) {
    timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        while bytes.len() < expected.len() {
            match service.read(id).await.unwrap().unwrap() {
                TerminalEvent::Data { data } => bytes.extend(data),
                TerminalEvent::Closed { error } => panic!("closed before output: {error:?}"),
            }
        }
        assert_eq!(bytes, expected);
    })
    .await
    .expect("terminal output timed out");
}

async fn stalled_peer() -> (ConnectionRequest, oneshot::Receiver<()>, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (ready_tx, ready) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut stream = BufReader::new(stream);
        stream.write_all(b"SSH-2.0-stalled-test\r\n").await.unwrap();
        let mut greeting = String::new();
        stream.read_line(&mut greeting).await.unwrap();
        assert!(greeting.starts_with("SSH-2.0-"));
        let length = stream.read_u32().await.unwrap() as usize;
        assert!((2..65536).contains(&length));
        let mut packet = vec![0; length];
        stream.read_exact(&mut packet).await.unwrap();
        assert_eq!(packet[1], 20, "client must have started key exchange");
        ready_tx.send(()).unwrap();

        // A valid SSH_MSG_IGNORE keeps resetting russh's inactivity timeout.
        let ignore = [0, 0, 0, 12, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let mut tick = interval(Duration::from_millis(100));
        let mut buffer = [0; 1024];
        loop {
            tokio::select! {
                result = stream.read(&mut buffer) => {
                    if matches!(result, Ok(0) | Err(_)) { break; }
                }
                _ = tick.tick() => {
                    if stream.write_all(&ignore).await.is_err() { break; }
                }
            }
        }
    });
    (
        ConnectionRequest {
            host: "127.0.0.1".into(),
            port,
            username: "demo".into(),
            password: "test-only".into(),
            host_key_sha256: format!("SHA256:{}", "A".repeat(43)),
            ignore_host_key: false,
        },
        ready,
        task,
    )
}

#[tokio::test]
async fn timed_out_handshake_closes_a_chatty_peer() {
    let (request, ready, peer) = stalled_peer().await;
    let service = SshService::default();
    let error = timeout(
        Duration::from_secs(20),
        service.connect(request, SIZE, service.generation()),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error, "SSH 连接超时（15 秒）");
    timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(2), peer)
        .await
        .expect("timed-out peer connection stayed open")
        .unwrap();
    let server = TestServer::start(false).await;
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    service.disconnect(id).await.unwrap();
}

#[tokio::test]
async fn reset_cancels_inflight_and_queued_connections() {
    let (request, ready, peer) = stalled_peer().await;
    let server = TestServer::start(false).await;
    let service = SshService::default();
    let (pending, queued, ()) = timeout(Duration::from_secs(5), async {
        tokio::join!(
            biased;
            service.connect(request, SIZE, service.generation()),
            service.connect(server.request(), SIZE, service.generation()),
            async {
                ready.await.unwrap();
                service.reset().await;
            },
        )
    })
    .await
    .expect("reset waited for the connection deadline");
    assert_eq!(pending.unwrap_err(), "SSH 连接已取消");
    assert_eq!(queued.unwrap_err(), "SSH 连接已取消");
    timeout(Duration::from_secs(2), peer)
        .await
        .expect("cancelled peer connection stayed open")
        .unwrap();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    service.disconnect(id).await.unwrap();
}

#[tokio::test]
async fn reset_rejects_dispatched_connections_before_their_first_poll() {
    let server = TestServer::start(false).await;
    let service = Arc::new(SshService::default());
    let old_page = service.clone();
    let request = server.request();
    let generation = service.generation();
    let dispatched = tokio::spawn(async move { old_page.connect(request, SIZE, generation).await });

    // The current-thread runtime cannot poll the spawned command before reset.
    service.reset().await;
    assert_eq!(dispatched.await.unwrap().unwrap_err(), "SSH 连接已取消");
    assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 0);

    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    assert_eq!(
        service
            .connect(server.request(), SIZE, generation)
            .await
            .unwrap_err(),
        "SSH 连接已取消"
    );
    service.write(id, b"new".to_vec()).await.unwrap();
    read_bytes(&service, id, b"new").await;
    service.disconnect(id).await.unwrap();
}

#[tokio::test]
async fn reset_closes_the_active_session_and_releases_pending_reads() {
    let mut server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    let (read, ()) = timeout(Duration::from_secs(2), async {
        tokio::join!(biased; service.read(id), service.reset())
    })
    .await
    .expect("reset did not release a pending read");
    assert!(read.unwrap().is_none());
    assert_eq!(
        timeout(Duration::from_secs(2), server.closed.recv())
            .await
            .expect("reset left the server session open"),
        Some(())
    );
    assert!(service.write(id, b"stale".to_vec()).await.is_err());
    let new_id = connect(&service, &server).await;
    assert_ne!(id, new_id);
    service.disconnect(id).await.unwrap();
    read_bytes(&service, new_id, b"ready\r\n").await;
    service.write(new_id, b"new".to_vec()).await.unwrap();
    read_bytes(&service, new_id, b"new").await;
    drop(service);
    assert_eq!(
        timeout(Duration::from_secs(2), server.closed.recv())
            .await
            .expect("dropping the service left the server session open"),
        Some(())
    );
}

#[tokio::test]
async fn interactive_bytes_resize_disconnect_and_reconnect() {
    let mut server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    assert_eq!(server.sizes.recv().await, Some((80, 24)));
    read_bytes(&service, id, b"ready\r\n").await;
    assert!(
        service
            .connect(server.request(), SIZE, service.generation())
            .await
            .is_err()
    );

    let input = "\u{1b}[31m中文\u{1b}[0m\r".as_bytes();
    for byte in input {
        service.write(id, vec![*byte]).await.unwrap();
    }
    read_bytes(&service, id, input).await;
    service
        .resize(
            id,
            TerminalSize {
                cols: 120,
                rows: 40,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(5), server.sizes.recv())
            .await
            .unwrap(),
        Some((120, 40))
    );
    assert!(service.write(id, vec![0; 65537]).await.is_err());
    service.disconnect(id).await.unwrap();
    assert!(service.write(id, vec![1]).await.is_err());
    service.disconnect(id).await.unwrap();

    let new_id = connect(&service, &server).await;
    assert_ne!(id, new_id);
    service.disconnect(id).await.unwrap();
    assert!(service.write(id, vec![1]).await.is_err());
    read_bytes(&service, new_id, b"ready\r\n").await;
    service.write(new_id, b"ok".to_vec()).await.unwrap();
    read_bytes(&service, new_id, b"ok").await;
    service.disconnect(new_id).await.unwrap();
}

#[tokio::test]
async fn rejects_host_key_before_sending_password() {
    let server = TestServer::start(false).await;
    let service = SshService::default();
    let mut request = server.request();
    request.host_key_sha256 = format!("SHA256:{}", "A".repeat(43));
    assert!(
        service
            .connect(request, SIZE, service.generation())
            .await
            .is_err()
    );
    assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn connects_without_a_trusted_fingerprint_only_with_explicit_opt_in() {
    let server = TestServer::start(false).await;
    let service = SshService::default();
    let mismatched = format!("SHA256:{}", "A".repeat(43));
    for fingerprint in ["", "SHA256:untrusted", &mismatched] {
        let mut request = server.request();
        request.host_key_sha256 = fingerprint.into();
        assert!(
            service
                .connect(request, SIZE, service.generation())
                .await
                .is_err()
        );
        let mut request = server.request();
        request.host_key_sha256 = fingerprint.into();
        request.ignore_host_key = true;
        let id = service
            .connect(request, SIZE, service.generation())
            .await
            .unwrap();
        read_bytes(&service, id, b"ready\r\n").await;
        service.disconnect(id).await.unwrap();
    }
    assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn rejects_bad_password_and_denied_shell() {
    let server = TestServer::start(true).await;
    let service = SshService::default();
    let mut request = server.request();
    request.password = "wrong".into();
    assert!(
        service
            .connect(request, SIZE, service.generation())
            .await
            .unwrap_err()
            .contains("认证")
    );
    assert!(
        service
            .connect(server.request(), SIZE, service.generation())
            .await
            .unwrap_err()
            .contains("PTY 或 shell")
    );
}

#[tokio::test]
async fn delivers_final_output_before_remote_close() {
    let server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    service.write(id, b"exit\r".to_vec()).await.unwrap();
    read_bytes(&service, id, b"goodbye\r\n").await;
    assert!(matches!(
        timeout(Duration::from_secs(5), service.read(id))
            .await
            .unwrap()
            .unwrap(),
        Some(TerminalEvent::Closed { error: None })
    ));
    let new_id = connect(&service, &server).await;
    service.disconnect(new_id).await.unwrap();
}

#[tokio::test]
async fn reports_an_unexpected_connection_loss() {
    let server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    service.write(id, b"drop\r".to_vec()).await.unwrap();
    assert!(matches!(
        timeout(Duration::from_secs(5), service.read(id))
            .await
            .unwrap()
            .unwrap(),
        Some(TerminalEvent::Closed { error: Some(_) })
    ));
}

#[tokio::test]
async fn rejects_channels_opened_by_the_server() {
    let mut server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    service.write(id, b"open\r".to_vec()).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(5), server.opened.recv())
            .await
            .expect("server channel opens were not answered")
            .unwrap(),
        0
    );
    // The terminal channel keeps working after the rejections.
    service.write(id, b"ok".to_vec()).await.unwrap();
    read_bytes(&service, id, b"ok").await;
    service.disconnect(id).await.unwrap();
}

#[tokio::test]
async fn reports_the_signal_that_killed_the_remote_shell() {
    let server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    service.write(id, b"crash\r".to_vec()).await.unwrap();
    read_bytes(&service, id, b"boom\r\n").await;
    match timeout(Duration::from_secs(5), service.read(id))
        .await
        .unwrap()
        .unwrap()
    {
        Some(TerminalEvent::Closed { error: Some(error) }) => {
            assert!(error.contains("SEGV"), "unexpected close reason: {error}")
        }
        _ => panic!("expected the crash signal to be reported"),
    }
}

#[tokio::test]
async fn completes_a_paste_larger_than_the_server_window() {
    let server = TestServer::start_with(false, Some(32 * 1024)).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;

    let paste = vec![b'p'; 48 * 1024];
    let writer = async { service.write(id, paste.clone()).await.unwrap() };
    let reader = async { read_bytes(&service, id, &paste).await };
    timeout(Duration::from_secs(10), async {
        tokio::join!(writer, reader);
    })
    .await
    .expect("paste stalled");
    service.disconnect(id).await.unwrap();
}

#[tokio::test]
async fn remains_responsive_with_a_full_output_queue() {
    let mut server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    assert_eq!(server.sizes.recv().await, Some((80, 24)));
    service.write(id, b"flood\r".to_vec()).await.unwrap();
    service
        .resize(
            id,
            TerminalSize {
                cols: 120,
                rows: 40,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(5), server.sizes.recv())
            .await
            .unwrap(),
        Some((120, 40))
    );
    read_bytes(&service, id, &vec![b'x'; 256 * 32768]).await;
    service.write(id, b"flood\r".to_vec()).await.unwrap();
    timeout(Duration::from_secs(2), service.disconnect(id))
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn sends_interrupt_during_backpressured_output() {
    let mut server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    read_bytes(&service, id, b"ready\r\n").await;
    assert_eq!(server.sizes.recv().await, Some((80, 24)));
    service.write(id, b"flood\r".to_vec()).await.unwrap();
    let reader = async {
        let mut bytes = 0;
        while bytes < 256 * 32768 {
            match service.read(id).await.unwrap().unwrap() {
                TerminalEvent::Data { data } => bytes += data.len(),
                TerminalEvent::Closed { error } => panic!("closed during output: {error:?}"),
            }
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
    };
    let interrupt = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        service.write(id, vec![3]).await.unwrap();
        assert_eq!(
            timeout(Duration::from_secs(2), server.sizes.recv())
                .await
                .unwrap(),
            Some((0, 0))
        );
    };
    timeout(Duration::from_secs(10), async {
        tokio::join!(reader, interrupt);
    })
    .await
    .unwrap();
    service.disconnect(id).await.unwrap();
}
