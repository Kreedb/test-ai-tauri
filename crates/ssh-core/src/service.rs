use std::{
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use russh::{ChannelMsg, Disconnect};
use tokio::{
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};

use crate::{
    ConnectionRequest, TerminalEvent, TerminalSize,
    client::{self, ConnectedSsh},
};

const IO_TIMEOUT: Duration = Duration::from_secs(5);
type Reply = oneshot::Sender<Result<(), String>>;

enum Control {
    Write(Vec<u8>, Reply),
    Resize(TerminalSize, Reply),
    Disconnect,
}

struct ActiveSession {
    id: u32,
    sender: mpsc::Sender<Control>,
    task: JoinHandle<()>,
    output: Arc<Mutex<mpsc::Receiver<TerminalEvent>>>,
}

impl Drop for ActiveSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct SshService {
    active: Mutex<Option<ActiveSession>>,
    next_id: AtomicU32,
}

impl SshService {
    pub async fn connect(
        &self,
        request: ConnectionRequest,
        size: TerminalSize,
    ) -> Result<u32, String> {
        request.validate()?;
        size.validate()?;
        let mut active = self.active.lock().await;
        if active
            .as_ref()
            .is_some_and(|session| !session.sender.is_closed())
        {
            return Err("已有 SSH 会话，请先断开连接".into());
        }
        active.take();
        let ssh = timeout(Duration::from_secs(15), client::connect(&request, size))
            .await
            .map_err(|_| "SSH 连接超时（15 秒）".to_string())??;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel(32);
        let (output_tx, output_rx) = mpsc::channel(8);
        let task = tokio::spawn(run(ssh, receiver, output_tx));
        *active = Some(ActiveSession {
            id,
            sender,
            task,
            output: Arc::new(Mutex::new(output_rx)),
        });
        Ok(id)
    }

    pub async fn read(&self, id: u32) -> Result<Option<TerminalEvent>, String> {
        let output = self
            .active
            .lock()
            .await
            .as_ref()
            .filter(|session| session.id == id)
            .map(|session| session.output.clone())
            .ok_or("SSH 会话不存在或已关闭")?;
        Ok(output.lock().await.recv().await)
    }

    pub async fn write(&self, id: u32, data: Vec<u8>) -> Result<(), String> {
        if data.len() > 65536 {
            return Err("单次终端输入不能超过 65536 字节".into());
        }
        self.request(id, |reply| Control::Write(data, reply)).await
    }

    pub async fn resize(&self, id: u32, size: TerminalSize) -> Result<(), String> {
        size.validate()?;
        self.request(id, |reply| Control::Resize(size, reply)).await
    }

    async fn request(&self, id: u32, command: impl FnOnce(Reply) -> Control) -> Result<(), String> {
        let sender = self
            .active
            .lock()
            .await
            .as_ref()
            .filter(|session| session.id == id)
            .map(|session| session.sender.clone())
            .ok_or("SSH 会话不存在或已关闭")?;
        let (reply, result) = oneshot::channel();
        timeout(IO_TIMEOUT, async {
            sender
                .send(command(reply))
                .await
                .map_err(|_| "SSH 会话已关闭")?;
            result.await.map_err(|_| "SSH 会话已关闭")?
        })
        .await
        .map_err(|_| "SSH 操作超时".to_string())?
    }

    pub async fn disconnect(&self, id: u32) -> Result<(), String> {
        let mut active = self.active.lock().await;
        if !active.as_ref().is_some_and(|session| session.id == id) {
            return Ok(());
        }
        let Some(mut session) = active.take() else {
            return Ok(());
        };
        drop(active);
        let _ = timeout(IO_TIMEOUT, session.sender.send(Control::Disconnect)).await;
        timeout(IO_TIMEOUT, &mut session.task)
            .await
            .map_err(|_| "SSH 断开超时".to_string())?
            .map_err(|error| format!("SSH 会话任务异常：{error}"))
    }
}

async fn run(
    ConnectedSsh {
        session,
        mut channel,
        mut early_output,
    }: ConnectedSsh,
    mut controls: mpsc::Receiver<Control>,
    output: mpsc::Sender<TerminalEvent>,
) {
    let mut pending = early_output.pop_front();
    let mut notify = true;
    let error = loop {
        tokio::select! {
            control = controls.recv() => {
                let (result, reply) = match control {
                    Some(Control::Write(data, reply)) => {
                        (timeout(IO_TIMEOUT, channel.data(&data[..])).await, reply)
                    }
                    Some(Control::Resize(size, reply)) => {
                        (timeout(IO_TIMEOUT, channel.window_change(size.cols, size.rows, 0, 0)).await, reply)
                    }
                    Some(Control::Disconnect) | None => {
                        notify = false;
                        break None;
                    }
                };
                let result = result.map_err(|_| "SSH 写入超时".to_string())
                    .and_then(|result| result.map_err(|e| e.to_string()));
                let failure = result.as_ref().err().cloned();
                let _ = reply.send(result);
                if failure.is_some() { break failure; }
            }
            permit = output.reserve(), if pending.is_some() => {
                let Ok(permit) = permit else { break None };
                if let Some(event) = pending.take() { permit.send(event); }
                pending = early_output.pop_front();
            }
            message = channel.wait(), if pending.is_none() => match message {
                Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                    pending = Some(TerminalEvent::Data { data: data.to_vec() });
                }
                Some(ChannelMsg::Failure) => break Some("服务器拒绝终端请求".into()),
                Some(ChannelMsg::Close) | None => break None,
                _ => {}
            }
        }
    };
    drop(controls);
    let _ = timeout(
        IO_TIMEOUT,
        session.disconnect(Disconnect::ByApplication, "", "en"),
    )
    .await;
    if notify {
        let _ = output.send(TerminalEvent::Closed { error }).await;
    }
}
