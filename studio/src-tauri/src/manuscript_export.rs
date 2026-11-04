use super::{
    check_window,
    export_pipeline::{self, Format, Spec},
    resolved_future_path, with_repository,
};
use std::{fs::OpenOptions, io::Write, path::Path};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub fn save_new(
    path: &Path,
    source: &Path,
    private: &Path,
    format: Format,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() as u64 > export_pipeline::MAX_OUTPUT {
        return Err("The export is empty or exceeds 128 MiB.".into());
    }
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(format.extension()))
    {
        return Err(format!(
            "Choose a new .{} filename for {}.",
            format.extension(),
            format.label()
        ));
    }
    let destination = resolved_future_path(path)?;
    if destination.starts_with(resolved_future_path(source)?)
        || destination.starts_with(resolved_future_path(private)?)
    {
        return Err(
            "Choose a new export file outside the source project and Heinlein's private storage."
                .into(),
        );
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| {
            "Choose a new filename in a writable folder. Existing files are never replaced."
        })?;
    file.write_all(bytes).and_then(|()|file.sync_all()).map_err(|_|"The export could not be fully saved. A partial new file may remain; use a new filename to retry.".into())
}
#[tauri::command]
pub async fn export_manuscript(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    filename: String,
    spec: Spec,
) -> Result<bool, String> {
    check_window(&window)?;
    spec.validate()?;
    if filename.is_empty()
        || filename.len() > 512
        || filename.contains(['/', '\\'])
        || filename.chars().any(char::is_control)
    {
        return Err("Use a simple export filename.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let source = with_repository(&app, &repository_id, |repo| Ok(repo.root().to_path_buf()))?;
        let private = app
            .path()
            .app_data_dir()
            .map_err(|_| "Private storage unavailable.")?;
        let root = app
            .path()
            .resource_dir()
            .map_err(|_| "Publishing resources unavailable.")?
            .join("publishing");
        #[cfg(debug_assertions)]
        let root = if root.join("heinlein/studio_export.py").is_file() {
            root
        } else {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_path_buf()
        };
        let python = if spec.format == Format::Markdown {
            std::path::PathBuf::new()
        } else {
            export_pipeline::python_runtime(
                &app.path()
                    .home_dir()
                    .map_err(|_| "Home directory unavailable.")?,
            )?
        };
        let bytes = export_pipeline::convert(&root, &python, &spec)?;
        check_window(&window)?;
        with_repository(&app, &repository_id, |_| Ok(()))?;
        let Some(destination) = app
            .dialog()
            .file()
            .set_title(format!(
                "Export {} — choose a NEW file outside the project",
                spec.format.label()
            ))
            .set_file_name(filename)
            .add_filter(spec.format.label(), &[spec.format.extension()])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut path = destination
            .into_path()
            .map_err(|_| "Choose a local file.")?;
        if path.extension().is_none() {
            path.set_extension(spec.format.extension());
        }
        check_window(&window)?;
        with_repository(&app, &repository_id, |repo| {
            if repo.root() != source {
                return Err("The active project changed. Export again.".into());
            }
            save_new(&path, &source, &private, spec.format, &bytes)
        })?;
        Ok(true)
    })
    .await
    .map_err(|_| "The export task stopped unexpectedly.")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_formats_refuse_overwrite_or_source_and_private_destinations() {
        let t = tempfile::tempdir().unwrap();
        let source = t.path().join("source");
        let private = t.path().join("private");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&private).unwrap();
        for format in [
            Format::Markdown,
            Format::Pdf,
            Format::Epub,
            Format::Html,
            Format::Docx,
        ] {
            let p = t.path().join(format!("new.{}", format.extension()));
            save_new(&p, &source, &private, format, b"Exact synthetic artifact").unwrap();
            assert!(save_new(&p, &source, &private, format, b"Replacement").is_err());
            assert_eq!(std::fs::read(&p).unwrap(), b"Exact synthetic artifact");
            assert!(save_new(
                &source.join(p.file_name().unwrap()),
                &source,
                &private,
                format,
                b"Text"
            )
            .is_err());
            assert!(save_new(
                &private.join(p.file_name().unwrap()),
                &source,
                &private,
                format,
                b"Text"
            )
            .is_err());
        }
    }
}
