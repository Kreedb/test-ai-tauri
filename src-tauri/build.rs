fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ssh_connect",
            "ssh_read",
            "ssh_write",
            "ssh_resize",
            "ssh_disconnect",
        ]),
    ))
    .expect("failed to build Tauri application metadata");
}
