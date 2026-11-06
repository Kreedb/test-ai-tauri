use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub host_key_sha256: String,
}

impl ConnectionRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.host.is_empty()
            || self.host.len() > 253
            || !self
                .host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%'))
        {
            return Err("主机必须是有效的主机名或 IP 地址，不包含协议、端口或空格");
        }
        if self.port == 0 {
            return Err("端口必须在 1 到 65535 之间");
        }
        if self.username.trim().is_empty()
            || self.username.len() > 256
            || self.username.chars().any(char::is_control)
        {
            return Err("用户名为空、过长或包含控制字符");
        }
        if self.password.is_empty() || self.password.len() > 16384 {
            return Err("密码不能为空且不能超过 16384 字节");
        }
        let hash = self.host_key_sha256.strip_prefix("SHA256:").unwrap_or("");
        if hash.len() != 43
            || !hash
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
        {
            return Err("请输入可信的 OpenSSH SHA256 主机指纹（SHA256: 后接 43 个字符）");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Deserialize)]
pub struct TerminalSize {
    pub cols: u32,
    pub rows: u32,
}

impl TerminalSize {
    pub fn validate(self) -> Result<(), &'static str> {
        if !(1..=1000).contains(&self.cols) || !(1..=1000).contains(&self.rows) {
            return Err("终端行列数必须在 1 到 1000 之间");
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data { data: Vec<u8> },
    Closed { error: Option<String> },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ConnectionRequest {
        ConnectionRequest {
            host: "localhost".into(),
            port: 22,
            username: "demo".into(),
            password: "test-only".into(),
            host_key_sha256: format!("SHA256:{}", "A".repeat(43)),
        }
    }

    #[test]
    fn validates_connection_boundary() {
        assert!(request().validate().is_ok());
        for host in ["", "ssh://localhost", "localhost/path", "a b", "a\n"] {
            let mut input = request();
            input.host = host.into();
            assert!(input.validate().is_err(), "accepted {host:?}");
        }
        for host in ["example.com", "127.0.0.1", "::1"] {
            let mut input = request();
            input.host = host.into();
            assert!(input.validate().is_ok());
        }
        let mut input = request();
        input.port = 0;
        assert!(input.validate().is_err());
        input = request();
        input.username = "\n".into();
        assert!(input.validate().is_err());
        input = request();
        input.password.clear();
        assert!(input.validate().is_err());
        input = request();
        input.host_key_sha256 = "SHA256:untrusted".into();
        assert!(input.validate().is_err());
    }

    #[test]
    fn bounds_terminal_dimensions() {
        assert!(TerminalSize { cols: 80, rows: 24 }.validate().is_ok());
        for size in [
            TerminalSize { cols: 0, rows: 24 },
            TerminalSize {
                cols: 80,
                rows: 1001,
            },
        ] {
            assert!(size.validate().is_err());
        }
    }
}
