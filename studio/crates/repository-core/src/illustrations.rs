//! Project-local raster illustrations. Resolve author links relative to their owning scene.
use super::*;
use image::{GenericImageView, ImageFormat, ImageReader};
use pulldown_cmark::{Event, LinkType, Parser, Tag};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};

pub const IMAGE_LIMIT: u64 = 16 * 1024 * 1024;
pub struct Illustration {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
}

impl Illustration {
    pub fn read(file: std::fs::File) -> Result<Self> {
        let meta = file.metadata().map_err(|_| Error::Io)?;
        if !meta.is_file() || meta.len() > IMAGE_LIMIT {
            return Err(Error::InvalidImage);
        }
        let mut bytes = Vec::new();
        file.take(IMAGE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Io)?;
        if bytes.len() as u64 > IMAGE_LIMIT {
            return Err(Error::InvalidImage);
        }
        let format = image::guess_format(&bytes).map_err(|_| Error::InvalidImage)?;
        if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg) {
            return Err(Error::InvalidImage);
        }
        let (width, height) = ImageReader::with_format(Cursor::new(&bytes), format)
            .into_dimensions()
            .map_err(|_| Error::InvalidImage)?;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 24_000_000 {
            return Err(Error::InvalidImage);
        }
        let decoded = ImageReader::with_format(Cursor::new(&bytes), format)
            .decode()
            .map_err(|_| Error::InvalidImage)?;
        if decoded.dimensions() != (width, height) {
            return Err(Error::InvalidImage);
        }
        Ok(Self {
            bytes,
            width,
            height,
            format,
        })
    }
    pub fn extension(&self) -> &'static str {
        if self.format == ImageFormat::Png {
            "png"
        } else {
            "jpg"
        }
    }
    pub fn mime(&self) -> &'static str {
        if self.format == ImageFormat::Png {
            "image/png"
        } else {
            "image/jpeg"
        }
    }
    pub fn filename(&self) -> String {
        format!("{:x}.{}", Sha256::digest(&self.bytes), self.extension())
    }
    pub fn description_png(&self) -> Result<Vec<u8>> {
        use image::ImageDecoder;
        let mut decoder = ImageReader::with_format(Cursor::new(&self.bytes), self.format)
            .into_decoder()
            .map_err(|_| Error::InvalidImage)?;
        let orientation = decoder.orientation().map_err(|_| Error::InvalidImage)?;
        let mut pixels =
            image::DynamicImage::from_decoder(decoder).map_err(|_| Error::InvalidImage)?;
        pixels.apply_orientation(orientation);
        let mut output = Cursor::new(Vec::new());
        if pixels.width() > 1024 || pixels.height() > 1024 {
            pixels = pixels.thumbnail(1024, 1024);
        }
        pixels
            .write_to(&mut output, ImageFormat::Png)
            .map_err(|_| Error::InvalidImage)?;
        Ok(output.into_inner())
    }
}

pub fn resolve_image(scene: &str, url: &str) -> Result<String> {
    parts(scene)?;
    let link = percent_encoding::percent_decode_str(url)
        .decode_utf8()
        .map_err(|_| Error::InvalidPath)?;
    if link.starts_with('/') || link.contains(['\\', ':']) || url.contains(['?', '#']) {
        return Err(Error::InvalidPath);
    }
    let mut pieces = parts(scene)?;
    pieces.pop();
    for piece in link.split('/') {
        match piece {
            "." => (),
            ".." => {
                pieces.pop().ok_or(Error::InvalidPath)?;
            }
            "" => return Err(Error::InvalidPath),
            p => pieces.push(p),
        }
    }
    let path = pieces.join("/");
    parts(&path)?;
    if !matches!(
        path.rsplit('.').next().map(str::to_lowercase).as_deref(),
        Some("png" | "jpeg" | "jpg")
    ) {
        return Err(Error::InvalidImage);
    }
    Ok(path)
}

pub fn relative_image(scene: &str, target: &str) -> Result<String> {
    let mut dir = parts(scene)?;
    dir.pop();
    let file = parts(target)?;
    let common = dir.iter().zip(&file).take_while(|(a, b)| a == b).count();
    const ESCAPE: percent_encoding::AsciiSet = percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    let mut result = vec!["..".to_string(); dir.len() - common];
    result.extend(
        file[common..]
            .iter()
            .map(|s| percent_encoding::utf8_percent_encode(s, &ESCAPE).to_string()),
    );
    Ok(result.join("/"))
}

impl Repository {
    pub fn read_image(&self, scene: &str, url: &str) -> Result<Illustration> {
        let path = resolve_image(scene, url)?;
        self.allowed(scene, false)?;
        self.allowed(&path, false)?;
        Illustration::read(self.handle(&path, false)?)
    }

    #[cfg(unix)]
    pub fn import_image(&self, scene: &str, image: &Illustration) -> Result<String> {
        use rustix::fs::{linkat, openat, unlinkat, AtFlags, Mode, OFlags};
        use std::io::Write;
        self.require_clean_structure()?;
        let doc = self.read(scene)?;
        if doc.generated_compatibility {
            return Err(Error::ReadOnly);
        }
        let dir = self.ensure_directory("assets/images")?;
        let name = image.filename();
        let dest = format!("assets/images/{name}");
        self.allowed(&dest, false)?;
        let temp = format!(".heinlein-image-{}", uuid::Uuid::new_v4());
        let mut stage = std::fs::File::from(
            openat(
                &dir,
                temp.as_str(),
                OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(errno)?,
        );
        let result = (|| {
            stage
                .write_all(&image.bytes)
                .and_then(|_| stage.sync_all())
                .map_err(|_| Error::Io)?;
            match linkat(&dir, temp.as_str(), &dir, name.as_str(), AtFlags::empty()) {
                Ok(()) => dir.sync_all().map_err(|_| Error::Io)?,
                Err(rustix::io::Errno::EXIST) => {}
                Err(e) => return Err(errno(e)),
            }
            let link = relative_image(scene, &dest)?;
            if self.read_image(scene, &link)?.bytes != image.bytes {
                return Err(Error::Conflict);
            }
            Ok(link)
        })();
        let _ = unlinkat(&dir, temp.as_str(), AtFlags::empty());
        result
    }
    #[cfg(not(unix))]
    pub fn import_image(&self, _: &str, _: &Illustration) -> Result<String> {
        Err(Error::UnsupportedPlatform)
    }

    pub(crate) fn move_images(
        &self,
        source: &str,
        target: &str,
        body: &str,
    ) -> Result<(String, Vec<String>)> {
        use std::collections::{BTreeMap, BTreeSet};
        let parser = Parser::new(body);
        let mut spans = BTreeSet::new();
        let mut replacements = BTreeMap::new();
        let mut warnings = Vec::new();
        let mut checked = BTreeSet::new();
        let mut iter = parser.into_offset_iter();
        while let Some((event, range)) = iter.next() {
            let Event::Start(Tag::Image {
                link_type,
                dest_url,
                id,
                ..
            }) = event
            else {
                continue;
            };
            let (markup, separator) = match link_type {
                LinkType::Inline => (range.clone(), "]("),
                LinkType::Reference | LinkType::Shortcut | LinkType::Collapsed => {
                    let def = iter
                        .reference_definitions()
                        .get(&id)
                        .ok_or(Error::AssetReferences)?;
                    (def.span.clone(), "]:")
                }
                _ => return Err(Error::AssetReferences),
            };
            spans.insert((range.start, range.end));
            spans.insert((markup.start, markup.end));
            let syntax = &body[markup.clone()];
            // Match the parsed destination directly after its delimiter. Never
            // search-and-replace prose, alt text, or a matching URL in a title.
            let mut candidates = syntax.match_indices(separator).filter_map(|(pos, _)| {
                let tail = syntax[pos + separator.len()..].trim_start();
                let raw = tail.strip_prefix('<').unwrap_or(tail);
                raw.strip_prefix(dest_url.as_ref())
                    .filter(|rest| {
                        rest.is_empty() || rest.starts_with(['>', ')', ' ', '\n', '\r', '\t'])
                    })
                    .map(|_| markup.end - raw.len())
            });
            let offset = candidates.next().ok_or(Error::AssetReferences)?;
            if candidates.next().is_some() {
                return Err(Error::AssetReferences);
            }
            let path = resolve_image(source, &dest_url).map_err(|_| Error::AssetReferences)?;
            if checked.insert(path.clone()) {
                self.read_image(source, &dest_url)
                    .map_err(|_| Error::AssetReferences)?;
            }
            let new = relative_image(target, &path)?;
            if new != dest_url.as_ref()
                && replacements
                    .insert((offset, offset + dest_url.len()), new.clone())
                    .is_none()
            {
                warnings.push(format!("Image link in {source}: {dest_url} → {new}"));
            }
        }
        let mut remaining = String::new();
        let mut last = 0;
        for (from, to) in spans {
            if from < last {
                return Err(Error::AssetReferences);
            }
            remaining.push_str(&body[last..from]);
            last = to;
        }
        remaining.push_str(&body[last..]);
        if crate::drafting::reference_bearing(&remaining) {
            return Err(Error::AssetReferences);
        }
        let mut output = body.to_owned();
        for ((from, to), link) in replacements.into_iter().rev() {
            output.replace_range(from..to, &link);
        }
        Ok((output, warnings))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use image::{DynamicImage, RgbImage};
    #[test]
    fn project_references_and_metadata_free_description() {
        let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let repo = Repository::open(t.path()).unwrap();
        let inner = t.path().join("ms");
        std::fs::create_dir(&inner).unwrap();
        let file = inner.join("a map.jpg");
        DynamicImage::ImageRgb8(RgbImage::new(200, 100))
            .save(&file)
            .unwrap();
        // JPEG comment segment, absent from the pixels.
        let mut bytes = std::fs::read(&file).unwrap();
        bytes.splice(2..2, b"\xff\xfe\x00\x10PRIVATE-MARKER".iter().copied());
        std::fs::write(&file, bytes).unwrap();
        let image = repo.read_image("ms/old.md", "a%20map.jpg").unwrap();
        assert!(image.bytes.windows(14).any(|v| v == b"PRIVATE-MARKER"));
        let clean = image.description_png().unwrap();
        assert!(!clean.windows(14).any(|v| v == b"PRIVATE-MARKER"));
        assert_eq!(
            image::load_from_memory(&clean).unwrap().dimensions(),
            (200, 100)
        );
        let source =
            "![North][map]\r\n\r\n[map]: <a map.jpg> \"Keep my title\"\r\nEnd — exactly.\r\n";
        let (moved, warnings) = repo
            .move_images("ms/old.md", "ms/part/new.md", source)
            .unwrap();
        assert_eq!(moved, source.replace("a map.jpg", "../a%20map.jpg"));
        assert_eq!(warnings.len(), 1);
        std::os::unix::fs::symlink(&file, inner.join("linked.jpg")).unwrap();
        for url in [
            "linked.jpg",
            "../../outside.png",
            "https://example.org/a.png",
            "%2Fetc/a.png",
            "unreadable.gif",
            "../.private/a.png",
        ] {
            assert!(repo.read_image("ms/old.md", url).is_err(), "{url}");
        }
    }
}
