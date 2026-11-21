//! Publish: build the designed book (PDF, EPUB, DOCX…) from the live manuscript.
//!
//! The renderer supplies the assembled manuscript (Library order, current editor
//! text) and the author's metadata. The bundled Python publisher runs the same
//! `heinlein.build` pipeline as `heinlein build` in a disposable workspace, and the
//! host writes the results into a NEW folder the author picks. Nothing in the
//! source project is written; existing files are never replaced.
use super::{
    check_window,
    export_pipeline::{self, Format, MAX_INPUT, MAX_OUTPUT},
    manuscript_export::publishing_root,
    resolved_future_path, with_repository,
};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Pdf,
    Epub,
    Docx,
    Html,
    Text,
}
impl BookFormat {
    pub fn id(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Epub => "epub",
            Self::Docx => "docx",
            Self::Html => "html",
            Self::Text => "text",
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Self::Text => "txt",
            other => other.id(),
        }
    }
    fn looks_valid(self, bytes: &[u8]) -> bool {
        match self {
            Self::Pdf => export_pipeline::looks_like(Format::Pdf, bytes),
            Self::Epub => export_pipeline::looks_like(Format::Epub, bytes),
            Self::Docx => export_pipeline::looks_like(Format::Docx, bytes),
            Self::Html => export_pipeline::looks_like(Format::Html, bytes),
            Self::Text => std::str::from_utf8(bytes).is_ok(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishSpec {
    pub title: String,
    pub author: String,
    pub rights: String,
    pub formats: Vec<BookFormat>,
    pub folder_name: String,
    pub branding_approved: bool,
    pub text: String,
}
fn plain(value: &str, max: usize) -> bool {
    value.len() <= max && !value.chars().any(char::is_control)
}
impl PublishSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.text.trim().is_empty() || self.text.len() > MAX_INPUT {
            return Err(
                "Write something first. The manuscript must be nonempty and below 64 MiB.".into(),
            );
        }
        if self.title.trim().is_empty() || !plain(&self.title, 200) || !plain(&self.author, 200) {
            return Err(
                "Use a book title and author on one line each, up to 200 characters.".into(),
            );
        }
        if !plain(&self.rights, 2000) {
            return Err("Keep the rights statement on one line, up to 2,000 characters.".into());
        }
        let unique: std::collections::HashSet<_> = self.formats.iter().collect();
        if self.formats.is_empty() || unique.len() != self.formats.len() {
            return Err("Choose at least one book format.".into());
        }
        if self.folder_name.trim().is_empty()
            || self.folder_name.len() > 120
            || self.folder_name.starts_with('.')
            || self
                .folder_name
                .chars()
                .any(|c| c.is_control() || "/\\:".contains(c))
        {
            return Err("Use a simple folder name without slashes or colons.".into());
        }
        if !self.branding_approved {
            return Err("Approve the book design and imprint branding before publishing.".into());
        }
        Ok(())
    }
}

/// Built book files, named and verified, ready to write.
pub type BookFiles = Vec<(BookFormat, String, Vec<u8>)>;

/// Run the designed-book pipeline. `project_config` is the source project's own
/// `heinlein.yaml`, when it has one, so its page size, accents, styles and cover apply.
pub fn build_book(
    root: &Path,
    python: &Path,
    spec: &PublishSpec,
    project_config: Option<&Path>,
) -> Result<BookFiles, String> {
    spec.validate()?;
    if !root.join("heinlein/studio_publish.py").is_file() {
        return Err("The bundled publishing pipeline is missing. Rebuild this app with its publishing resources.".into());
    }
    let work = tempfile::Builder::new()
        .prefix("heinlein-publish-")
        .tempdir()
        .map_err(|_| "Could not create a private publishing workspace.")?;
    let input = work.path().join("live-manuscript.md");
    let output = work.path().join("book");
    fs::write(&input, &spec.text).map_err(|_| "Could not stage the manuscript.")?;
    let formats = spec
        .formats
        .iter()
        .map(|f| f.id())
        .collect::<Vec<_>>()
        .join(",");
    let mut args: Vec<OsString> = vec![
        "--input".into(),
        input.into_os_string(),
        "--output-dir".into(),
        output.clone().into_os_string(),
    ];
    for (flag, value) in [
        ("--formats", formats.as_str()),
        ("--title", spec.title.as_str()),
        ("--author", spec.author.as_str()),
        ("--rights", spec.rights.as_str()),
    ] {
        args.push(flag.into());
        args.push(value.into());
    }
    if let Some(config) = project_config {
        args.push("--config".into());
        args.push(config.as_os_str().to_owned());
    }
    export_pipeline::run_publisher(
        root,
        python,
        "heinlein.studio_publish",
        &args,
        work.path(),
        "Book",
    )?;
    let mut files = BookFiles::new();
    for format in &spec.formats {
        let built: Vec<PathBuf> = fs::read_dir(&output)
            .map_err(|_| "The publisher produced no book files.")?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == format.extension()))
            .collect();
        let [path] = built.as_slice() else {
            return Err(format!(
                "The publisher did not produce exactly one {} file.",
                format.id().to_uppercase()
            ));
        };
        let meta = fs::symlink_metadata(path).map_err(|_| "A built book file is unavailable.")?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_OUTPUT {
            return Err("A built book file is empty, unavailable or exceeds 128 MiB.".into());
        }
        let bytes = fs::read(path).map_err(|_| "Could not read a built book file.")?;
        if !format.looks_valid(&bytes) {
            return Err(format!(
                "The publisher returned an invalid {} file.",
                format.id().to_uppercase()
            ));
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("A built book file has an unusual name.")?;
        files.push((*format, name.to_string(), bytes));
    }
    Ok(files)
}

/// Write the book into a NEW folder under `parent`. Never replaces anything, and
/// refuses destinations inside the source project or Heinlein's private storage.
pub fn write_book(
    parent: &Path,
    folder_name: &str,
    source: &Path,
    private: &Path,
    files: &BookFiles,
) -> Result<PathBuf, String> {
    if files.is_empty() {
        return Err("No book files were built.".into());
    }
    let destination = parent.join(folder_name);
    let resolved = resolved_future_path(&destination)?;
    if resolved.starts_with(resolved_future_path(source)?)
        || resolved.starts_with(resolved_future_path(private)?)
    {
        return Err(
            "Choose a folder outside the story project and Heinlein's private storage.".into(),
        );
    }
    fs::create_dir(&destination).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "A folder with this name already exists there. Existing folders are never replaced; publish again for a new one.".to_string()
        } else {
            "Choose a writable folder for the published book.".to_string()
        }
    })?;
    for (_, name, bytes) in files {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination.join(name))
            .map_err(|_| "Could not create a book file in the new folder.")?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "A book file could not be fully saved. The new folder may be incomplete; publish again for a fresh copy.")?;
    }
    Ok(destination)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
/// Names only: no absolute paths enter the renderer.
pub struct Published {
    folder: String,
    files: Vec<String>,
}

/// The source project's own design settings, if it has a regular `heinlein.yaml`.
fn project_config(root: &Path) -> Option<PathBuf> {
    let path = root.join("heinlein.yaml");
    fs::symlink_metadata(&path)
        .ok()
        .filter(|m| m.is_file() && m.len() < 1024 * 1024)
        .map(|_| path)
}

#[tauri::command]
pub async fn publish_book(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    spec: PublishSpec,
) -> Result<Option<Published>, String> {
    check_window(&window)?;
    spec.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = with_repository(&app, &repository_id, |repo| Ok(repo.root().to_path_buf()))?;
        let private = app
            .path()
            .app_data_dir()
            .map_err(|_| "Private storage unavailable.")?;
        let root = publishing_root(&app)?;
        let python = export_pipeline::python_runtime(
            &app.path()
                .home_dir()
                .map_err(|_| "Home directory unavailable.")?,
        )?;
        let files = build_book(&root, &python, &spec, project_config(&source).as_deref())?;
        check_window(&window)?;
        let Some(folder) = app
            .dialog()
            .file()
            .set_title("Publish — choose where to put the new book folder")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let parent = folder.into_path().map_err(|_| "Choose a local folder.")?;
        check_window(&window)?;
        let destination = with_repository(&app, &repository_id, |repo| {
            if repo.root() != source {
                return Err("The active project changed. Publish again.".into());
            }
            write_book(&parent, &spec.folder_name, &source, &private, &files)
        })?;
        {
            use tauri_plugin_opener::OpenerExt;
            if let Some((_, name, _)) = files.first() {
                let _ = app.opener().reveal_item_in_dir(destination.join(name));
            }
        }
        Ok(Some(Published {
            folder: destination
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            files: files.iter().map(|(_, name, _)| name.clone()).collect(),
        }))
    })
    .await
    .map_err(|_| "The publish task stopped unexpectedly.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec() -> PublishSpec {
        PublishSpec {
            title: "Synthetic Book".into(),
            author: "Example Author".into(),
            rights: "Example Author retains rights.".into(),
            formats: vec![BookFormat::Pdf, BookFormat::Epub, BookFormat::Docx],
            folder_name: "Synthetic Book — 2026-11-21 0303".into(),
            branding_approved: true,
            text: "# Synthetic Book\n\n## Opening\n\nALPHA-BEGIN — 星 🦊.\n\n## Ending\n\nOMEGA-END.\n".into(),
        }
    }
    #[test]
    fn spec_validation_refuses_unsafe_or_unapproved_requests() {
        assert!(spec().validate().is_ok());
        for broken in [
            PublishSpec {
                title: " ".into(),
                ..spec()
            },
            PublishSpec {
                title: "Title\n--bad".into(),
                ..spec()
            },
            PublishSpec {
                author: "a\u{0}".into(),
                ..spec()
            },
            PublishSpec {
                formats: vec![],
                ..spec()
            },
            PublishSpec {
                formats: vec![BookFormat::Pdf, BookFormat::Pdf],
                ..spec()
            },
            PublishSpec {
                folder_name: "../escape".into(),
                ..spec()
            },
            PublishSpec {
                folder_name: ".hidden".into(),
                ..spec()
            },
            PublishSpec {
                folder_name: "a:b".into(),
                ..spec()
            },
            PublishSpec {
                branding_approved: false,
                ..spec()
            },
            PublishSpec {
                text: "  \n".into(),
                ..spec()
            },
        ] {
            assert!(broken.validate().is_err(), "{broken:?}");
        }
        assert!(serde_json::from_str::<BookFormat>("\"sh\"").is_err());
    }
    #[test]
    fn write_book_creates_only_a_new_folder_outside_source_and_private() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        let (source, private, parent) = (
            root.join("source"),
            root.join("private"),
            root.join("books"),
        );
        for dir in [&source, &private, &parent] {
            fs::create_dir(dir).unwrap();
        }
        let files: BookFiles = vec![
            (
                BookFormat::Pdf,
                "synthetic-book.pdf".into(),
                b"%PDF-1.7 synthetic".to_vec(),
            ),
            (
                BookFormat::Epub,
                "synthetic-book.epub".into(),
                b"PK synthetic".to_vec(),
            ),
        ];
        let out = write_book(&parent, "Synthetic Book", &source, &private, &files).unwrap();
        assert_eq!(
            fs::read(out.join("synthetic-book.pdf")).unwrap(),
            b"%PDF-1.7 synthetic"
        );
        // A second publish with the same name never replaces the first book.
        assert!(write_book(&parent, "Synthetic Book", &source, &private, &files).is_err());
        assert_eq!(
            fs::read(out.join("synthetic-book.epub")).unwrap(),
            b"PK synthetic"
        );
        assert!(write_book(&source, "Inside", &source, &private, &files).is_err());
        assert!(write_book(&private, "Inside", &source, &private, &files).is_err());
        assert!(!source.join("Inside").exists() && !private.join("Inside").exists());
        assert!(write_book(&parent, "Empty", &source, &private, &vec![]).is_err());
    }
    #[test]
    fn project_config_is_used_only_when_it_is_a_regular_file() {
        let t = tempfile::tempdir().unwrap();
        assert!(project_config(t.path()).is_none());
        fs::create_dir(t.path().join("heinlein.yaml")).unwrap();
        assert!(project_config(t.path()).is_none());
        fs::remove_dir(t.path().join("heinlein.yaml")).unwrap();
        fs::write(t.path().join("heinlein.yaml"), "page:\n  size: trade\n").unwrap();
        assert_eq!(
            project_config(t.path()),
            Some(t.path().join("heinlein.yaml"))
        );
    }
    #[test]
    #[ignore = "explicit real-publisher validation; needs Python, Pandoc and Chrome"]
    fn real_pipeline_builds_designed_pdf_epub_and_docx_from_live_text() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let python =
            export_pipeline::python_runtime(&PathBuf::from(std::env::var("HOME").unwrap()))
                .unwrap();
        let files = build_book(&root, &python, &spec(), None).unwrap();
        let names: Vec<_> = files.iter().map(|(_, n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "synthetic-book.pdf",
                "synthetic-book.epub",
                "synthetic-book.docx"
            ]
        );
        assert!(files[0].2.starts_with(b"%PDF-"));
    }
}
