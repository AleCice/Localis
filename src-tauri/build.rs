fn main() {
    // Generate permissions only for our own commands so capabilities can allow them explicitly.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_projects",
            "create_project",
            "delete_project",
            "list_folders",
            "create_folder",
            "rename_folder",
            "delete_folder",
            "list_documents",
            "list_versions",
            "import_document",
            "import_version",
            "move_document",
            "delete_document",
            "read_original",
            "get_text",
            "search",
            "list_jobs",
            "retry_job",
        ]),
    ))
    .expect("failed to run tauri-build");
}
