//! Convert a captured manuscript in a disposable directory. Never invokes a shell.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const MAX_INPUT: usize = 64 * 1024 * 1024;
pub const MAX_OUTPUT: u64 = 128 * 1024 * 1024;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Markdown,
    Pdf,
    Epub,
    Html,
    Docx,
}
impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Pdf => "pdf",
            Self::Epub => "epub",
            Self::Html => "html",
            Self::Docx => "docx",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Markdown => "Markdown",
            Self::Pdf => "PDF",
            Self::Epub => "EPUB",
            Self::Html => "HTML",
            Self::Docx => "DOCX",
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    #[serde(default)]
    pub images: Vec<ExportImage>,
    pub format: Format,
    pub title: String,
    pub author: String,
    pub text: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExportImage {
    pub scene: String,
    pub url: String,
}
impl Spec {
    pub fn validate(&self) -> Result<(), String> {
        if self.images.len() > 512
            || (!self.images.is_empty() && !matches!(self.format, Format::Epub | Format::Pdf))
        {
            return Err(
                "Illustrated exports support up to 512 local images in EPUB or PDF.".into(),
            );
        }
        if self.text.is_empty() || self.text.len() > MAX_INPUT {
            return Err("Choose a nonempty manuscript below 64 MiB.".into());
        }
        if self.title.trim().is_empty()
            || self.title.len() > 1024
            || self.author.len() > 1024
            || self
                .title
                .chars()
                .chain(self.author.chars())
                .any(char::is_control)
        {
            return Err(
                "Use a title and author without control characters (up to 1,024 bytes each)."
                    .into(),
            );
        }
        Ok(())
    }
}
pub fn python_runtime(home: &Path) -> Result<PathBuf, String> {
    [home.join(".local/share/uv/tools/heinlein/bin/python3"),home.join(".local/pipx/venvs/heinlein/bin/python"),PathBuf::from("/opt/homebrew/bin/python3"),PathBuf::from("/usr/local/bin/python3"),PathBuf::from("/usr/bin/python3")]
        .into_iter().find(|p|p.is_file()).ok_or_else(||"The Heinlein Python publishing runtime is missing. Install the Heinlein Python CLI; non-Markdown exports also need Pandoc, and PDF needs Chrome.".into())
}
#[cfg(test)]
pub fn convert(root: &Path, python: &Path, spec: &Spec) -> Result<Vec<u8>, String> {
    convert_with_images(root, python, spec, |_, _| {
        Err("Image source unavailable.".into())
    })
}
pub fn convert_with_images(
    root: &Path,
    python: &Path,
    spec: &Spec,
    mut load: impl FnMut(&str, &str) -> Result<repository_core::illustrations::Illustration, String>,
) -> Result<Vec<u8>, String> {
    spec.validate()?;
    if spec.format == Format::Markdown {
        if spec.author.trim().is_empty() {
            return Ok(spec.text.as_bytes().to_vec());
        }
        let author = spec
            .author
            .replace('\\', "\\\\")
            .replace('*', "\\*")
            .replace('_', "\\_");
        let (title, body) = spec.text.split_once('\n').unwrap_or((&spec.text, ""));
        return Ok(format!("{title}\n\n*by {author}*\n{body}").into_bytes());
    }
    if !root.join("heinlein/studio_export.py").is_file() {
        return Err("The bundled publishing pipeline is missing. Rebuild this app with its publishing resources.".into());
    }
    let work = tempfile::Builder::new()
        .prefix("heinlein-export-")
        .tempdir()
        .map_err(|_| "Could not create a private export workspace.")?;
    let assets = work.path().join("illustrations");
    if !spec.images.is_empty() {
        fs::create_dir(&assets).map_err(|_| "Could not stage illustrations.")?;
    }
    let mut total = 0;
    for (index, reference) in spec.images.iter().enumerate() {
        let image = load(&reference.scene, &reference.url)
            .map_err(|e| format!("{}: {} — {e}", reference.scene, reference.url))?;
        total += image.bytes.len();
        if total > MAX_OUTPUT as usize {
            return Err("Illustrations exceed the 128 MiB export limit.".into());
        }
        fs::write(
            assets.join(format!("{index}.{}", image.extension())),
            image.bytes,
        )
        .map_err(|_| "Could not stage illustration.")?;
    }
    let input = work.path().join("snapshot.md");
    let output = work.path().join("output");
    let errors = work.path().join("conversion.log");
    fs::write(&input, &spec.text).map_err(|_| "Could not stage the manuscript snapshot.")?;
    let log = File::create(&errors).map_err(|_| "Could not create the conversion log.")?;
    let mut cmd = Command::new(python);
    cmd.args(["-m", "heinlein.studio_export", "--input"])
        .arg(&input)
        .arg("--output-dir")
        .arg(&output)
        .arg("--format")
        .arg(spec.format.extension())
        .arg("--title")
        .arg(&spec.title)
        .arg("--author")
        .arg(&spec.author)
        .env("PYTHONPATH", root)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env(
            "PATH",
            format!(
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .current_dir(work.path())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child=cmd.spawn().map_err(|_|"Could not start the Heinlein Python runtime. Install the Heinlein Python CLI and Pandoc; PDF also requires Chrome.")?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "The publishing process stopped unexpectedly.")?
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
                "Export timed out after three minutes. No destination file was written.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    if !status.success() {
        let mut reason = String::new();
        if let Ok(file) = File::open(&errors) {
            let _ = file.take(4096).read_to_string(&mut reason);
        }
        return Err(format!("{} conversion failed. Check the Heinlein Python dependencies, Pandoc, and (for PDF) Chrome. No destination file was written. {}",spec.format.label(),reason.trim()));
    }
    let files: Vec<_> = fs::read_dir(&output)
        .map_err(|_| "The converter produced no output.")?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == spec.format.extension()))
        .collect();
    if files.len() != 1 {
        return Err("The converter did not produce exactly one output file.".into());
    }
    let path = &files[0];
    let meta = fs::symlink_metadata(path).map_err(|_| "Converted output is unavailable.")?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_OUTPUT {
        return Err("Converted output is empty, unavailable or exceeds 128 MiB.".into());
    }
    let bytes = fs::read(path).map_err(|_| "Could not read converted output.")?;
    let valid = match spec.format {
        Format::Pdf => bytes.starts_with(b"%PDF-"),
        Format::Epub | Format::Docx => bytes.starts_with(b"PK"),
        Format::Html => String::from_utf8_lossy(&bytes[..bytes.len().min(1024)])
            .to_lowercase()
            .contains("<html"),
        Format::Markdown => true,
    };
    if !valid {
        return Err("The converter returned an invalid file for the selected format.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_needs_no_runtime_and_preserves_exact_source() {
        let s = Spec {
            images: vec![],
            format: Format::Markdown,
            title: "Synthetic".into(),
            author: "".into(),
            text: "# Synthetic\r\n\nWords — 🦊.\n".into(),
        };
        assert_eq!(
            convert(Path::new("/missing"), Path::new("/missing"), &s).unwrap(),
            s.text.as_bytes()
        );
    }
    #[test]
    fn renderer_cannot_choose_a_command_or_supply_control_characters() {
        assert!(serde_json::from_str::<Format>("\"sh\"").is_err());
        let s = Spec {
            images: vec![],
            format: Format::Pdf,
            title: "Title\n--bad".into(),
            author: "".into(),
            text: "Words".into(),
        };
        assert!(s.validate().is_err());
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires installed publishing runtime, Pandoc and Chrome"]
    fn illustrated_book_round_trip() {
        use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
        use repository_core::illustrations::Illustration;
        use repository_core::{DraftingChange, RecoveryStore, Repository};
        let tmp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let project = tmp.path().join("book");
        fs::create_dir(&project).unwrap();
        let store = RecoveryStore::open(tmp.path().join("recovery")).unwrap();
        let repo = Repository::open(&project).unwrap();
        let apply = |change| {
            let rev = repo.load_drafting().unwrap().revision;
            let plan = repo
                .preview_drafting(rev.as_deref(), change, &[], &store)
                .unwrap();
            repo.apply_drafting(&plan, &store).unwrap();
            plan.preview
        };
        apply(DraftingChange::Initialize {
            project: "Illustrated book".into(),
        });
        let scene = "ms/chapter-3.md";
        apply(DraftingChange::CreateScene {
            title: "Chapter 3".into(),
            path: scene.into(),
            group_id: None,
            before_id: None,
        });
        let pick = tmp.path().join("map.png");
        let mut urls = Vec::new();
        for (format, color) in [
            (ImageFormat::Png, [40, 160, 80]),
            (ImageFormat::Jpeg, [175, 70, 125]),
        ] {
            let pixels = RgbImage::from_fn(400, 200, |x, y| {
                if (x / 8 + y / 8) % 7 == 0 {
                    Rgb([25, 60, 145])
                } else {
                    Rgb(color)
                }
            });
            DynamicImage::ImageRgb8(pixels)
                .save_with_format(&pick, format)
                .unwrap();
            let img = Illustration::read(File::open(&pick).unwrap()).unwrap();
            let url = repo.import_image(scene, &img).unwrap();
            assert_eq!(repo.import_image(scene, &img).unwrap(), url);
            urls.push(url);
        }
        assert_ne!(urls[0], urls[1]);
        let source=format!("Earlier prose — exact.\r\n\r\n![Map of the river]({})\r\n\r\n![Map of the town]({})\r\n",urls[0],urls[1]);
        let blank = repo.read(scene).unwrap();
        let first = repo
            .save_with_recovery(scene, &blank.content_hash, &source, &store)
            .unwrap();
        repo.save_with_recovery(
            scene,
            &first.content_hash,
            &format!("{source}Later prose."),
            &store,
        )
        .unwrap();
        let id = repo.load_drafting().unwrap().scenes[0].id.clone();
        let moved = "ms/part/chapter-3.md";
        let preview = apply(DraftingChange::MoveScene {
            scene_id: id,
            path: moved.into(),
            before_id: None,
            group_id: None,
        });
        assert!(preview
            .warnings
            .iter()
            .any(|w| w.contains("../../assets/images/")));
        apply(DraftingChange::CreateScene {
            title: "Another scene".into(),
            path: scene.into(),
            group_id: None,
            before_id: None,
        });
        drop((repo, store));
        let repo = Repository::open(&project).unwrap();
        let store = RecoveryStore::open(tmp.path().join("recovery")).unwrap();
        let versions = store.scene_versions(&repo, moved).unwrap();
        let version = versions
            .iter()
            .find(|v| v.hash == first.content_hash)
            .unwrap();
        assert_eq!(version.source_path.as_deref(), Some(scene));
        assert_eq!(
            store
                .scene_version(&repo, moved, version.saved_at, &version.hash)
                .unwrap(),
            source
        );
        assert!(store.scene_versions(&repo, scene).unwrap().is_empty());
        let doc = repo.read(moved).unwrap();
        assert_eq!(
            doc.text,
            format!(
                "{}Later prose.",
                source.replace("../assets", "../../assets")
            )
        );
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let python = python_runtime(&PathBuf::from(std::env::var("HOME").unwrap())).unwrap();
        let destination = PathBuf::from(std::env::var("HEINLEIN_EXPORT_VALIDATION_DIR").unwrap());
        fs::create_dir_all(&destination).unwrap();
        for format in [Format::Epub, Format::Pdf] {
            let mut text = doc.text.clone();
            let mut images = vec![];
            for (i, url) in urls.iter().enumerate() {
                let url = format!("../{url}");
                text = text.replace(&url, &format!("heinlein-illustration-{i}"));
                images.push(ExportImage {
                    scene: moved.into(),
                    url,
                });
            }
            let spec = Spec {
                format,
                title: "Chapter 3".into(),
                author: "Synthetic".into(),
                text,
                images,
            };
            let bytes = convert_with_images(&root, &python, &spec, |path, url| {
                repo.read_image(path, url).map_err(|e| e.to_string())
            })
            .unwrap();
            fs::write(
                destination.join(format!("illustrated.{}", format.extension())),
                bytes,
            )
            .unwrap();
        }
    }

    #[test]
    #[ignore = "explicit real-converter validation; writes only synthetic artifacts"]
    fn real_formats() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let python = python_runtime(&PathBuf::from(std::env::var("HOME").unwrap())).unwrap();
        let destination = PathBuf::from(
            std::env::var("HEINLEIN_EXPORT_VALIDATION_DIR")
                .expect("Set the synthetic artifact directory"),
        );
        fs::create_dir_all(&destination).unwrap();
        for format in [
            Format::Markdown,
            Format::Pdf,
            Format::Epub,
            Format::Html,
            Format::Docx,
        ] {
            let spec=Spec{images:vec![],format,title:"Synthetic Export".into(),author:"Synthetic Author".into(),text:"# Synthetic Export\n\n## First chapter\n\nALPHA-BEGIN. A quiet harbor — 星 🦊.\n\n## Last chapter\n\nOMEGA-END. Final source marker.\n".into()};
            let bytes = convert(&root, &python, &spec)
                .unwrap_or_else(|e| panic!("{}: {e}", format.label()));
            fs::write(
                destination.join(format!("synthetic-export.{}", format.extension())),
                &bytes,
            )
            .unwrap();
            println!("{} verified: {} bytes", format.label(), bytes.len());
        }
    }
}
