use std::{collections::VecDeque, net::Shutdown, sync::Arc, time::Duration};

use russh::{
    Channel, ChannelMsg, client,
    keys::{HashAlg, PublicKeyOrCertificate},
};
use tokio::net::TcpStream;

use crate::{ConnectionRequest, TerminalEvent, TerminalSize};

pub(crate) struct HostKeyVerifier {
    fingerprint: String,
    ignore: bool,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(self.ignore
            || key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.fingerprint)
    }
}

pub(crate) struct SocketGuard(std::net::TcpStream);

impl Drop for SocketGuard {
    fn drop(&mut self) {
        // russh can detach its protocol task before connect_stream returns.
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

pub(crate) struct ConnectedSsh {
    pub session: client::Handle<HostKeyVerifier>,
    pub channel: Channel<client::Msg>,
    pub early_output: VecDeque<TerminalEvent>,
    pub socket: SocketGuard,
}

pub(crate) async fn connect(
    request: &ConnectionRequest,
    size: TerminalSize,
) -> Result<ConnectedSsh, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(120)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        // Keep the receive backlog short so terminal input is not queued behind many rendered chunks.
        channel_buffer_size: 8,
        ..Default::default()
    });
    let stream = TcpStream::connect((request.host.as_str(), request.port))
        .await
        .map_err(|error| format!("SSH 连接失败：{error}"))?
        .into_std()
        .map_err(|error| error.to_string())?;
    let socket = SocketGuard(stream.try_clone().map_err(|error| error.to_string())?);
    let stream = TcpStream::from_std(stream).map_err(|error| error.to_string())?;
    let mut session = client::connect_stream(
        config,
        stream,
        HostKeyVerifier {
            fingerprint: request.host_key_sha256.clone(),
            ignore: request.ignore_host_key,
        },
    )
    .await
    .map_err(|error| format!("SSH 握手失败，请核对地址和主机指纹：{error}"))?;

    let auth = session
        .authenticate_password(&request.username, &request.password)
        .await
        .map_err(|error| format!("SSH 认证失败：{error}"))?;
    if !auth.success() {
        return Err("SSH 密码认证被拒绝".into());
    }

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_pty(true, "xterm-256color", size.cols, size.rows, 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    let mut early_output = VecDeque::new();
    expect_success(&mut channel, &mut early_output).await?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| e.to_string())?;
    expect_success(&mut channel, &mut early_output).await?;
    Ok(ConnectedSsh {
        session,
        channel,
        early_output,
        socket,
    })
}

async fn expect_success(
    channel: &mut Channel<client::Msg>,
    early_output: &mut VecDeque<TerminalEvent>,
) -> Result<(), String> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                if early_output.len() >= 8 {
                    return Err("服务器在确认 shell 前发送了过多数据".into());
                }
                early_output.push_back(TerminalEvent::Data {
                    data: data.to_vec(),
                });
            }
            Some(ChannelMsg::Failure) => return Err("服务器拒绝创建 PTY 或 shell".into()),
            Some(ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err("服务器在创建终端时关闭了连接".into());
            }
            _ => {}
        }
    }
}
