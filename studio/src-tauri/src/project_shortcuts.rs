//! Readable Finder names for managed writing.
//!
//! Managed checkouts live at `Documents/Heinlein/github-sources-v1/<uuid>` so
//! their identity never depends on a repository name. Beside that folder,
//! Heinlein keeps one relative symlink per project, named after the project
//! (`Documents/Heinlein/Ink and Paint Trilogy`), so authors can browse their
//! writing in Finder. Only symlinks that point at a managed checkout are ever
//! created, renamed or removed; every other entry in the folder is the
//! author's and is left untouched.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// One managed project that should be visible in the writing folder.
pub(crate) struct Shortcut<'a> {
    pub id: &'a str,
    pub owner: &'a str,
    pub name: &'a str,
}

const MAX_ENTRIES: usize = 4096;

/// `ink-and-paint-trilogy` -> `Ink and Paint Trilogy`.
pub(crate) fn readable_name(repo: &str) -> String {
    const SMALL: &[&str] = &[
        "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the",
        "to", "vs",
    ];
    let words: Vec<&str> = repo
        .split(|c: char| c == '-' || c == '_' || c == '.' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .collect();
    let last = words.len().saturating_sub(1);
    let pretty: Vec<String> = words
        .iter()
        .enumerate()
        .map(|(i, word)| {
            let lower = word.to_lowercase();
            // Keep author capitalization such as "TH4F" or "McKay".
            if word.chars().any(|c| c.is_uppercase()) {
                word.to_string()
            } else if i != 0 && i != last && SMALL.contains(&lower.as_str()) {
                lower
            } else {
                let mut chars = lower.chars();
                chars
                    .next()
                    .map(|c| c.to_uppercase().chain(chars).collect())
                    .unwrap_or_default()
            }
        })
        .collect();
    let joined = pretty.join(" ");
    let safe: String = joined
        .chars()
        .map(|c| if c == '/' || c == ':' || c.is_control() { ' ' } else { c })
        .collect();
    let safe = safe.trim().trim_start_matches('.').trim().to_string();
    if safe.is_empty() {
        "Untitled project".into()
    } else {
        safe.chars().take(120).collect()
    }
}

/// The managed checkout id a shortcut points at, if `path` is one of ours.
fn managed_target(path: &Path, sources_dir: &str) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_symlink() {
        return None;
    }
    let target = std::fs::read_link(path).ok()?;
    let mut parts = target.components();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(Component::Normal(dir)), Some(Component::Normal(id)), None)
            if dir == sources_dir =>
        {
            let id = id.to_str()?;
            uuid::Uuid::parse_str(id).ok().map(|_| id.to_owned())
        }
        _ => None,
    }
}

/// Bring `home` in line with `projects`. Best effort per entry: a failure on
/// one shortcut never blocks the others, and nothing but our own symlinks is
/// ever modified.
pub(crate) fn refresh(home: &Path, sources_dir: &str, projects: &[Shortcut<'_>]) -> std::io::Result<()> {
    let sources = home.join(sources_dir);
    let mut ours: HashMap<OsString, String> = HashMap::new();
    let mut taken: HashSet<String> = HashSet::new();
    for (count, entry) in std::fs::read_dir(home)?.enumerate() {
        if count >= MAX_ENTRIES {
            return Ok(());
        }
        let entry = entry?;
        let name = entry.file_name();
        match managed_target(&entry.path(), sources_dir) {
            Some(id) => {
                ours.insert(name, id);
            }
            None => {
                taken.insert(name.to_string_lossy().to_lowercase());
            }
        }
    }

    // Decide names first so they are stable regardless of directory order.
    let live: Vec<&Shortcut<'_>> = projects
        .iter()
        .filter(|p| uuid::Uuid::parse_str(p.id).is_ok() && sources.join(p.id).is_dir())
        .collect();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for p in &live {
        *counts.entry(readable_name(p.name).to_lowercase()).or_default() += 1;
    }
    let mut wanted: HashMap<&str, PathBuf> = HashMap::new();
    let mut used = taken;
    for p in &live {
        let base = readable_name(p.name);
        let mut candidate = if counts[&base.to_lowercase()] > 1 {
            format!("{base} ({})", p.owner)
        } else {
            base.clone()
        };
        let stem = candidate.clone();
        let mut n = 2;
        while used.contains(&candidate.to_lowercase()) {
            candidate = format!("{stem} {n}");
            n += 1;
        }
        used.insert(candidate.to_lowercase());
        wanted.insert(p.id, home.join(candidate));
    }

    // Drop shortcuts that are stale, duplicated or misnamed.
    for (name, id) in &ours {
        let path = home.join(name);
        if wanted.get(id.as_str()) != Some(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
    for (id, path) in wanted {
        if managed_target(&path, sources_dir).as_deref() == Some(id) {
            continue;
        }
        let target = Path::new(sources_dir).join(id);
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(&target, &path);
        #[cfg(not(unix))]
        let _ = (target, path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = "github-sources-v1";

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("Heinlein");
        std::fs::create_dir_all(home.join(DIR)).unwrap();
        (temp, home)
    }

    fn checkout(home: &Path) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir(home.join(DIR).join(&id)).unwrap();
        std::fs::write(home.join(DIR).join(&id).join("scene.md"), "Saved writing").unwrap();
        id
    }

    #[test]
    fn readable_names() {
        assert_eq!(readable_name("ink-and-paint-trilogy"), "Ink and Paint Trilogy");
        assert_eq!(readable_name("it-takes-a-zoo"), "It Takes a Zoo");
        assert_eq!(readable_name("singularity_log.memoir"), "Singularity Log Memoir");
        assert_eq!(readable_name("the-end-of-the"), "The End of The");
        assert_eq!(readable_name("TH4F-notes"), "TH4F Notes");
        assert_eq!(readable_name("..."), "Untitled project");
    }

    #[test]
    fn creates_readable_links_and_reads_through_them() {
        let (_t, home) = setup();
        let id = checkout(&home);
        let projects = [Shortcut { id: &id, owner: "a", name: "it-takes-a-zoo" }];
        refresh(&home, DIR, &projects).unwrap();
        refresh(&home, DIR, &projects).unwrap();
        let link = home.join("It Takes a Zoo");
        assert_eq!(std::fs::read_link(&link).unwrap(), Path::new(DIR).join(&id));
        assert_eq!(std::fs::read_to_string(link.join("scene.md")).unwrap(), "Saved writing");
    }

    #[test]
    fn never_touches_author_entries_and_avoids_collisions() {
        let (_t, home) = setup();
        let a = checkout(&home);
        let b = checkout(&home);
        std::fs::create_dir(home.join("It Takes a Zoo")).unwrap();
        std::fs::write(home.join("It Takes a Zoo").join("mine.md"), "mine").unwrap();
        let projects = [
            Shortcut { id: &a, owner: "alice", name: "it-takes-a-zoo" },
            Shortcut { id: &b, owner: "bob", name: "solo" },
        ];
        refresh(&home, DIR, &projects).unwrap();
        assert_eq!(std::fs::read_to_string(home.join("It Takes a Zoo/mine.md")).unwrap(), "mine");
        assert_eq!(std::fs::read_link(home.join("It Takes a Zoo 2")).unwrap(), Path::new(DIR).join(&a));
        assert!(home.join("Solo").exists());
    }

    #[test]
    fn same_name_from_two_owners_is_disambiguated() {
        let (_t, home) = setup();
        let a = checkout(&home);
        let b = checkout(&home);
        let projects = [
            Shortcut { id: &a, owner: "alice", name: "zoo" },
            Shortcut { id: &b, owner: "bob", name: "zoo" },
        ];
        refresh(&home, DIR, &projects).unwrap();
        assert!(home.join("Zoo (alice)").exists());
        assert!(home.join("Zoo (bob)").exists());
    }

    #[test]
    fn removes_only_stale_managed_links() {
        let (_t, home) = setup();
        let id = checkout(&home);
        refresh(&home, DIR, &[Shortcut { id: &id, owner: "a", name: "old-name" }]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/tmp", home.join("Author link")).unwrap();
        refresh(&home, DIR, &[Shortcut { id: &id, owner: "a", name: "new-name" }]).unwrap();
        assert!(std::fs::symlink_metadata(home.join("Old Name")).is_err());
        assert!(home.join("New Name").exists());
        assert!(std::fs::symlink_metadata(home.join("Author link")).is_ok());
        refresh(&home, DIR, &[]).unwrap();
        assert!(std::fs::symlink_metadata(home.join("New Name")).is_err());
        assert_eq!(std::fs::read_to_string(home.join(DIR).join(&id).join("scene.md")).unwrap(), "Saved writing");
    }
}
