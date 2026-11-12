//! Offline DOCX/EPUB exports through the app's pinned, separately signed Pandoc helper.
//! The source is only a captured string; conversion happens in a disposable directory.
use super::export_pipeline::{Format, Spec, MAX_OUTPUT};
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub fn helper(root: &Path) -> PathBuf {
    root.parent()
        .and_then(Path::parent)
        .unwrap_or(root)
        .join("Helpers/pandoc")
}

pub fn uses_bundle(root: &Path) -> bool {
    root.parent()
        .is_some_and(|p| p.join("direct-download.json").exists())
        || helper(root).is_file()
}

// Match frontmatter.strip_title_block and Python's universal-newline read_text.
fn manuscript(spec: &Spec) -> String {
    let normalized = spec.text.replace("\r\n", "\n").replace('\r', "\n");
    let mut body = normalized;
    for byline in [false, true] {
        let start = body.len() - body.trim_start().len();
        let tail = &body[start..];
        if let Some(end) = tail.find('\n') {
            let line = &tail[..end];
            if (!byline && line.starts_with("# "))
                || (byline && line.starts_with("*by ") && line.ends_with('*'))
            {
                body.replace_range(start..start + end + 1, "");
            }
        }
    }
    let byline = if spec.author.is_empty() {
        String::new()
    } else {
        format!("*by {}*\n\n", spec.author.replace('*', "\\*"))
    };
    format!("# {}\n\n{byline}{body}", spec.title)
}

fn epub_metadata(spec: &Spec) -> serde_json::Value {
    let mut metadata = serde_json::json!({"title": spec.title, "language": "en-US"});
    if !spec.author.trim().is_empty() {
        metadata["creator"] = serde_json::json!([{"role": "author", "text": spec.author}]);
    }
    metadata
}

pub fn convert(root: &Path, spec: &Spec) -> Result<Vec<u8>, String> {
    spec.validate()?;
    if !matches!(spec.format, Format::Docx | Format::Epub) {
        return Err("The bundled document converter supports DOCX and EPUB.".into());
    }
    let executable = helper(root);
    if !executable.is_file() {
        return Err("The bundled document converter is missing. Reinstall Heinlein Studio from its original download.".into());
    }
    let work = tempfile::Builder::new()
        .prefix("heinlein-document-")
        .tempdir()
        .map_err(|_| "Could not create a private export workspace.")?;
    let input = work.path().join("snapshot.md");
    let output = work
        .path()
        .join(format!("manuscript.{}", spec.format.extension()));
    fs::write(&input, manuscript(spec)).map_err(|_| "Could not stage the manuscript snapshot.")?;
    let data = work.path().join("data");
    fs::create_dir(&data).map_err(|_| "Could not create private converter data storage.")?;
    let mut command = Command::new(&executable);
    command
        .arg(&input)
        .args(["--from=markdown", "--sandbox", "--to"])
        .arg(spec.format.extension())
        .arg("--output")
        .arg(&output)
        .arg("--data-dir")
        .arg(&data)
        .env_clear()
        .env("HOME", work.path())
        .env("TMPDIR", work.path())
        .env("PATH", &data)
        .env("LANG", "en_US.UTF-8")
        .current_dir(work.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if spec.format == Format::Epub {
        // Optional OPF fields must be absent rather than empty: empty Dublin
        // Core values are invalid EPUB metadata.
        let metadata = work.path().join("metadata.json");
        let meta = epub_metadata(spec);
        fs::write(
            &metadata,
            serde_json::to_vec(&meta).map_err(|_| "Could not prepare export metadata.")?,
        )
        .map_err(|_| "Could not stage export metadata.")?;
        command.arg("--metadata-file").arg(metadata);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| "The bundled document converter could not start. Reinstall Heinlein Studio from its original download.")?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "The document converter stopped unexpectedly.")?
        {
            break status;
        }
        if started.elapsed() > Duration::from_secs(180) {
            #[cfg(unix)]
            {
                if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
                    let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Document export timed out after three minutes. No destination file was written."
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    if !status.success() {
        return Err(format!(
            "{} conversion failed in the offline converter. No destination file was written.",
            spec.format.label()
        ));
    }
    let meta =
        fs::symlink_metadata(&output).map_err(|_| "The document converter produced no output.")?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_OUTPUT {
        return Err("Converted output is empty, unavailable or exceeds 128 MiB.".into());
    }
    let bytes = fs::read(&output).map_err(|_| "Could not read the converted document.")?;
    if !bytes.starts_with(b"PK") {
        return Err("The document converter produced an invalid document.".into());
    }
    if spec.format == Format::Epub {
        let css = fs::read(root.join("heinlein/templates/manuscript.css")).map_err(|_| {
            "The bundled manuscript stylesheet is missing. Reinstall Heinlein Studio."
        })?;
        return manuscript_stylesheet(bytes, &css);
    }
    Ok(bytes)
}

// Pandoc's sandbox blocks CSS filesystem reads too. Replace only its generated
// stylesheet without extracting files or changing the reading order/manifest.
fn manuscript_stylesheet(bytes: Vec<u8>, css: &[u8]) -> Result<Vec<u8>, String> {
    let patch = || -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let mut source = zip::ZipArchive::new(Cursor::new(bytes))?;
        let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let mut replaced = 0;
        for index in 0..source.len() {
            let file = source.by_index(index)?;
            if file.name()? == "EPUB/styles/stylesheet1.css" {
                replaced += 1;
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(file.compression())
                    .last_modified_time(file.last_modified().unwrap_or_default());
                output.start_file(file.name()?, options)?;
                output.write_all(css)?;
            } else {
                output.raw_copy_file(file)?;
            }
        }
        if replaced != 1 {
            return Err("Unexpected EPUB stylesheet layout".into());
        }
        let bytes = output.finish()?.into_inner();
        if bytes.len() as u64 > MAX_OUTPUT {
            return Err("EPUB exceeds output limit".into());
        }
        Ok(bytes)
    };
    patch().map_err(|_| "Could not apply the manuscript stylesheet to the EPUB. No destination file was written.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepares_the_same_review_manuscript_without_mutating_snapshot() {
        let spec = Spec {
            format: Format::Docx,
            title: "Review".into(),
            author: "A * Name".into(),
            text: "# Old\r\n\r\n*by Former*\r\n\r\n## First\r\n\r\nWords — *emphasis*.\r\n".into(),
        };
        let before = spec.text.clone();
        assert_eq!(
            manuscript(&spec),
            "# Review\n\n*by A \\* Name*\n\n\n\n## First\n\nWords — *emphasis*.\n"
        );
        assert_eq!(spec.text, before);
    }
    #[test]
    fn epub_metadata_omits_absent_optional_values() {
        let mut spec = Spec {
            format: Format::Epub,
            title: "Synthetic".into(),
            author: "".into(),
            text: "Words".into(),
        };
        for author in ["", "  ", "Writer"] {
            spec.author = author.into();
            let metadata = epub_metadata(&spec);
            assert!(metadata.get("publisher").is_none());
            assert!(metadata.get("rights").is_none());
            assert_eq!(metadata.get("creator").is_some(), !author.trim().is_empty());
        }
    }
    #[test]
    fn damaged_direct_bundle_never_uses_host_tools() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Contents/Resources/publishing");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.parent().unwrap().join("direct-download.json"), "{}").unwrap();
        assert!(uses_bundle(&root));
        let spec = Spec {
            format: Format::Docx,
            title: "Synthetic".into(),
            author: "".into(),
            text: "Words".into(),
        };
        assert!(convert(&root, &spec)
            .unwrap_err()
            .contains("bundled document converter is missing"));
    }
    #[test]
    fn stylesheet_replacement_preserves_epub_mimetype_and_other_members() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "mimetype",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(b"application/epub+zip").unwrap();
        writer
            .start_file(
                "EPUB/styles/stylesheet1.css",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"old style").unwrap();
        writer
            .start_file(
                "EPUB/text/ch001.xhtml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"<p>Exact prose</p>").unwrap();
        let original = writer.finish().unwrap().into_inner();
        let modified = manuscript_stylesheet(original, b"new style").unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(modified)).unwrap();
        assert_eq!(archive.by_index(0).unwrap().name().unwrap(), "mimetype");
        assert_eq!(
            archive.by_index(0).unwrap().compression(),
            zip::CompressionMethod::Stored
        );
        use std::io::Read;
        let mut style = String::new();
        archive
            .by_name("EPUB/styles/stylesheet1.css")
            .unwrap()
            .read_to_string(&mut style)
            .unwrap();
        assert_eq!(style, "new style");
        let mut chapter = String::new();
        archive
            .by_name("EPUB/text/ch001.xhtml")
            .unwrap()
            .read_to_string(&mut chapter)
            .unwrap();
        assert_eq!(chapter, "<p>Exact prose</p>");
        assert!(manuscript_stylesheet(Vec::new(), b"style").is_err());
    }
    #[test]
    #[ignore = "real bundled converter acceptance; synthetic source only"]
    fn bundled_documents() {
        let root = PathBuf::from(
            std::env::var("HEINLEIN_PUBLISHING_ROOT").expect("Set exact app publishing resources"),
        );
        let destination = PathBuf::from(
            std::env::var("HEINLEIN_EXPORT_VALIDATION_DIR")
                .expect("Set synthetic artifact directory"),
        );
        fs::create_dir_all(&destination).unwrap();
        let original = "# Synthetic Export\n\n## First chapter\n\nALPHA-BEGIN. Exact prose — with *italic words*, **bold words**, and [a link](https://example.org).\n\n> Quoted words.\n\n- First list item\n- Second list item\n\n## Last chapter\n\nOMEGA-END. Final source marker.\n";
        let source = destination.join("original.md");
        fs::write(&source, original).unwrap();
        for format in [Format::Docx, Format::Epub] {
            let spec = Spec {
                format,
                title: "Synthetic Export".into(),
                author: "Synthetic Author".into(),
                text: original.into(),
            };
            let bytes =
                super::super::export_pipeline::convert(&root, Path::new("/missing-python"), &spec)
                    .unwrap();
            fs::write(
                destination.join(format!("synthetic-export.{}", format.extension())),
                bytes,
            )
            .unwrap();
            assert_eq!(fs::read(&source).unwrap(), original.as_bytes());
            assert_eq!(spec.text, original);
        }
        let spec = Spec {
            format: Format::Epub,
            title: "Synthetic Export".into(),
            author: "".into(),
            text: original.into(),
        };
        let bytes =
            super::super::export_pipeline::convert(&root, Path::new("/missing-python"), &spec)
                .unwrap();
        let mut epub = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut opf = String::new();
        epub.by_name("EPUB/content.opf")
            .unwrap()
            .read_to_string(&mut opf)
            .unwrap();
        for absent in ["<dc:publisher", "<dc:rights", "<dc:creator"] {
            assert!(
                !opf.contains(absent),
                "Absent optional metadata must not appear: {absent}"
            );
        }
        fs::write(destination.join("synthetic-no-author.epub"), &bytes).unwrap();
        assert_eq!(fs::read(&source).unwrap(), original.as_bytes());
    }
}
