mod commands;

pub fn run() {
    tauri::Builder::default()
        .manage(ssh_core::SshService::default())
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
