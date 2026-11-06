use std::{collections::VecDeque, sync::Arc, time::Duration};

use russh::{
    Channel, ChannelMsg, client,
    keys::{HashAlg, PublicKeyOrCertificate},
};

use crate::{ConnectionRequest, TerminalEvent, TerminalSize};

pub(crate) struct PinnedHostKey(String);

impl client::Handler for PinnedHostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.0)
    }
}

pub(crate) struct ConnectedSsh {
    pub session: client::Handle<PinnedHostKey>,
    pub channel: Channel<client::Msg>,
    pub early_output: VecDeque<TerminalEvent>,
}

pub(crate) async fn connect(
    request: &ConnectionRequest,
    size: TerminalSize,
) -> Result<ConnectedSsh, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        // Keep the receive backlog short so terminal input is not queued behind many rendered chunks.
        channel_buffer_size: 8,
        ..Default::default()
    });
    let mut session = client::connect(
        config,
        (request.host.as_str(), request.port),
        PinnedHostKey(request.host_key_sha256.clone()),
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
