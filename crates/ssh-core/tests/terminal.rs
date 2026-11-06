use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use russh::{
    Channel, ChannelId, Pty,
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Server as _, Session},
};
use ssh_core::{ConnectionRequest, SshService, TerminalEvent, TerminalSize};
use tokio::{net::TcpListener, sync::mpsc, task::JoinHandle, time::timeout};

const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

#[derive(Clone)]
struct EchoServer {
    auth_attempts: Arc<AtomicUsize>,
    sizes: mpsc::UnboundedSender<(u32, u32)>,
    reject_shell: bool,
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
        _: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(term, "xterm-256color");
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
        } else {
            session.data(channel, data.to_vec())?;
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
    task: JoinHandle<()>,
}

impl TestServer {
    async fn start(reject_shell: bool) -> Self {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let socket = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let (sizes_tx, sizes) = mpsc::unbounded_channel();
        let auth_attempts = Arc::new(AtomicUsize::new(0));
        let mut handler = EchoServer {
            auth_attempts: auth_attempts.clone(),
            sizes: sizes_tx,
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
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn connect(service: &SshService, server: &TestServer) -> u32 {
    service.connect(server.request(), SIZE).await.unwrap()
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

#[tokio::test]
async fn interactive_bytes_resize_disconnect_and_reconnect() {
    let mut server = TestServer::start(false).await;
    let service = SshService::default();
    let id = connect(&service, &server).await;
    assert_eq!(server.sizes.recv().await, Some((80, 24)));
    read_bytes(&service, id, b"ready\r\n").await;
    assert!(service.connect(server.request(), SIZE).await.is_err());

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
    assert!(service.connect(request, SIZE).await.is_err());
    assert_eq!(server.auth_attempts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rejects_bad_password_and_denied_shell() {
    let server = TestServer::start(true).await;
    let service = SshService::default();
    let mut request = server.request();
    request.password = "wrong".into();
    assert!(
        service
            .connect(request, SIZE)
            .await
            .unwrap_err()
            .contains("认证")
    );
    assert!(
        service
            .connect(server.request(), SIZE)
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
