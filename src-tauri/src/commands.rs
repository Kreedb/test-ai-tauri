use ssh_core::{ConnectionRequest, SshService, TerminalEvent, TerminalSize};
use tauri::State;

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, SshService>,
    request: ConnectionRequest,
    size: TerminalSize,
) -> Result<u32, String> {
    state.connect(request, size).await
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
