mod commands;

use tauri::{Manager, webview::PageLoadEvent};

pub fn run() {
    tauri::Builder::default()
        .manage(ssh_core::SshService::default())
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                // Finish cleanup before the replacement page can issue commands.
                tauri::async_runtime::block_on(webview.state::<ssh_core::SshService>().reset());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_read,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri SSH Terminal");
}
