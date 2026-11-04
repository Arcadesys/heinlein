//! One explicit native Save dialog, writing a separate new Markdown file.
use super::{check_window, resolved_future_path, with_repository};
use std::{fs::OpenOptions, io::Write, path::Path};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 64 * 1024 * 1024;

fn save_new(path: &Path, source: &Path, private: &Path, text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("This export exceeds 64 MB. Choose a smaller folder or group".into());
    }
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
    {
        return Err("Choose a Markdown filename ending in .md or .markdown".into());
    }
    let destination = resolved_future_path(path)?;
    if destination.starts_with(resolved_future_path(source)?)
        || destination.starts_with(resolved_future_path(private)?)
    {
        return Err(
            "Choose a new export file outside the source project and Heinlein's private storage"
                .into(),
        );
    }
    // create_new refuses existing files, hard links and symlinks. Export never
    // opens an existing manuscript or export for writing.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Could not create the export. Choose a new filename in a writable folder")?;
    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|_| "The export could not be fully saved. A partial file may remain; choose a new filename to retry")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn save_markdown_export(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    filename: String,
    text: String,
) -> Result<bool, String> {
    check_window(&window)?;
    if text.is_empty() || text.len() > MAX_BYTES {
        return Err("The Markdown export is empty or exceeds 64 MB".into());
    }
    if filename.is_empty()
        || filename.len() > 512
        || filename.contains(['/', '\\'])
        || filename.chars().any(char::is_control)
    {
        return Err("Use a simple Markdown filename".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_repository(&app, &repository_id, |_| Ok(()))?;
        let Some(destination) = app
            .dialog()
            .file()
            .set_title("Export Markdown — choose a NEW file outside the source project")
            .set_file_name(filename)
            .add_filter("Markdown", &["md", "markdown"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        check_window(&window)?;
        let mut path = destination.into_path().map_err(|_| "Choose a local file")?;
        if path.extension().is_none() {
            path.set_extension("md");
        }
        let private = app
            .path()
            .app_data_dir()
            .map_err(|_| "Private storage unavailable")?;
        with_repository(&app, &repository_id, |repository| {
            save_new(&path, repository.root(), &private, &text)
        })?;
        Ok(true)
    })
    .await
    .map_err(|_| "The export task could not finish")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_exact_utf8_without_changing_sources_or_existing_exports() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let private = temp.path().join("private");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("scene.md"), "Original — 🐺\r\n").unwrap();
        let output = temp.path().join("beta.md");
        let text = "# Beta\n\nAuthor — 🐺\r\n\r\nPunch.\n";
        save_new(&output, &source, &private, text).unwrap();
        assert_eq!(std::fs::read_to_string(&output).unwrap(), text);
        assert!(save_new(&output, &source, &private, "Replacement").is_err());
        assert_eq!(std::fs::read_to_string(&output).unwrap(), text);
        assert!(save_new(&source.join("new.md"), &source, &private, text).is_err());
        assert_eq!(
            std::fs::read_to_string(source.join("scene.md")).unwrap(),
            "Original — 🐺\r\n"
        );
        std::fs::create_dir(&private).unwrap();
        assert!(save_new(&private.join("new.md"), &source, &private, text).is_err());
        assert!(save_new(&temp.path().join("beta.txt"), &source, &private, text).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_into_sources() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let private = temp.path().join("private");
        std::fs::create_dir(&source).unwrap();
        std::os::unix::fs::symlink(&source, temp.path().join("alias")).unwrap();
        assert!(save_new(&temp.path().join("alias/new.md"), &source, &private, "Text").is_err());
        let original = source.join("scene.md");
        std::fs::write(&original, "Original").unwrap();
        std::os::unix::fs::symlink(&original, temp.path().join("linked.md")).unwrap();
        assert!(save_new(&temp.path().join("linked.md"), &source, &private, "Changed").is_err());
        assert_eq!(std::fs::read_to_string(original).unwrap(), "Original");
    }
}
