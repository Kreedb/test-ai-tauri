use ssh_core::{ConnectionRequest, SshService, TerminalEvent, TerminalSize};
use tauri::{
    Runtime, State,
    ipc::{CommandArg, CommandItem, Invoke},
};

pub fn handle<R: Runtime>(invoke: Invoke<R>) -> bool {
    if invoke.message.command() != "ssh_connect" {
        let handler: fn(Invoke<R>) -> bool =
            tauri::generate_handler![ssh_read, ssh_write, ssh_resize, ssh_disconnect];
        return handler(invoke);
    }

    let state = invoke.message.state();
    // An async #[tauri::command] would capture this only after its task is polled.
    let generation = state.get::<SshService>().generation();
    let request = ConnectionRequest::from_command(CommandItem {
        plugin: None,
        name: "ssh_connect",
        key: "request",
        message: &invoke.message,
        acl: &invoke.acl,
    });
    let size = TerminalSize::from_command(CommandItem {
        plugin: None,
        name: "ssh_connect",
        key: "size",
        message: &invoke.message,
        acl: &invoke.acl,
    });
    invoke.resolver.respond_async(async move {
        state
            .get::<SshService>()
            .connect(request?, size?, generation)
            .await
            .map_err(Into::into)
    });
    true
}

#[tauri::command]
pub async fn ssh_read(
    state: State<'_, SshService>,
    session_id: u32,
) -> Result<Option<TerminalEvent>, String> {
    state.read(session_id).await
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, SshService>,
    session_id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    state.write(session_id, data).await
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, SshService>,
    session_id: u32,
    size: TerminalSize,
) -> Result<(), String> {
    state.resize(session_id, size).await
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, SshService>, session_id: u32) -> Result<(), String> {
    state.disconnect(session_id).await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tauri::{
        Manager, WebviewWindow,
        ipc::{CallbackFn, InvokeResponse},
        test::{MockRuntime, mock_builder},
        webview::InvokeRequest,
    };
    use tokio::{net::TcpListener, sync::oneshot, time::timeout};

    use super::*;

    fn dispatch_connect(
        webview: &WebviewWindow<MockRuntime>,
        port: u16,
        url: tauri::Url,
    ) -> oneshot::Receiver<InvokeResponse> {
        let (sender, response) = oneshot::channel();
        webview.clone().on_message(
            InvokeRequest {
                cmd: "ssh_connect".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url,
                body: json!({
                    "request": {
                        "host": "127.0.0.1",
                        "port": port,
                        "username": "test",
                        "password": "test-only",
                        "hostKeySha256": "",
                        "ignoreHostKey": true,
                    },
                    "size": { "cols": 80, "rows": 24 },
                })
                .into(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
            Box::new(move |_, _, result, _, _| {
                sender.send(result).unwrap();
            }),
        );
        response
    }

    #[tokio::test]
    async fn dispatch_binds_connection_before_the_async_command_is_polled() {
        tauri::async_runtime::set(tokio::runtime::Handle::current());
        let app = mock_builder()
            .manage(SshService::default())
            .invoke_handler(handle)
            .build(tauri::generate_context!())
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let service = app.state::<SshService>();

        let stale = dispatch_connect(&webview, port, webview.url().unwrap());
        service.reset().await;
        let response = timeout(Duration::from_secs(2), stale)
            .await
            .expect("stale command started connecting instead of being cancelled")
            .unwrap();
        match response {
            InvokeResponse::Err(error) => assert_eq!(error.0, json!("SSH 连接已取消")),
            InvokeResponse::Ok(_) => panic!("stale command created a session"),
        }

        let fresh = dispatch_connect(&webview, port, webview.url().unwrap());
        let (socket, _) = timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("replacement page could not start a connection")
            .unwrap();
        service.reset().await;
        assert!(matches!(
            timeout(Duration::from_secs(2), fresh).await.unwrap().unwrap(),
            InvokeResponse::Err(error) if error.0 == json!("SSH 连接已取消")
        ));
        drop(socket);
    }

    #[tokio::test]
    async fn shipped_permissions_limit_ssh_commands_to_the_local_main_window() {
        let app = mock_builder()
            .manage(SshService::default())
            .invoke_handler(handle)
            .build(tauri::generate_context!())
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .unwrap();

        // Denials happen before the command spawns, so no async runtime is needed.
        for (webview, url) in [
            (&main, tauri::Url::parse("https://example.com/").unwrap()),
            (&other, other.url().unwrap()),
        ] {
            let response = timeout(Duration::from_secs(2), dispatch_connect(webview, 1, url))
                .await
                .expect("permission check hung")
                .unwrap();
            match response {
                InvokeResponse::Err(error) => {
                    let message = error.0.as_str().unwrap_or_default();
                    assert!(message.contains("not allowed"), "{message}");
                }
                InvokeResponse::Ok(_) => {
                    panic!("{} escaped the shipped capability", webview.label())
                }
            }
        }
    }
}
