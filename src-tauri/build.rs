fn main() {
    // Generate permissions only for our own commands so capabilities can allow them explicitly.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["list_projects", "create_project", "delete_project"]),
    ))
    .expect("failed to run tauri-build");
}
