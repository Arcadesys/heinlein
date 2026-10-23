//! Isolated libgit2 object/HTTPS access. Never checkout through filters or run Git.
use crate::{auth::Credential, registry::StateDir, Error, Result};
use git2::{
    Config, ConfigLevel, CredentialType, FetchOptions, Oid, PushOptions, RemoteCallbacks,
    RemoteRedirect, Repository, RepositoryInitOptions,
};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::Path,
};
use unicode_normalization::UnicodeNormalization;
pub type Files = BTreeMap<String, Vec<u8>>;
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_FILES: usize = 4096;
pub fn valid_ref(branch: &str) -> Result<()> {
    if branch.starts_with('-')
        || branch.len() > 200
        || !git2::Reference::is_valid_name(&format!("refs/heads/{branch}"))
    {
        Err(Error::InvalidRef)
    } else {
        Ok(())
    }
}
pub fn safe_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || p.eq_ignore_ascii_case(".git")
                || p.ends_with(['.', ' '])
                || p.chars().any(|c| c.is_control() || "\\:".contains(c))
        })
    {
        Err(Error::UnsafeTree)
    } else {
        Ok(())
    }
}
pub fn validate_files(files: &Files) -> Result<()> {
    if files.len() > MAX_FILES || files.values().map(Vec::len).sum::<usize>() > MAX_BYTES {
        return Err(Error::Limit);
    }
    let mut paths = HashMap::new();
    for (path, bytes) in files {
        safe_path(path)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(Error::Limit);
        }
        let mut prefix = String::new();
        for component in path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/')
            }
            prefix.push_str(component);
            let key = prefix
                .nfc()
                .flat_map(char::to_lowercase)
                .collect::<String>();
            if let Some(previous) = paths.insert(key, prefix.clone()) {
                if previous != prefix {
                    return Err(Error::UnsafeTree);
                }
            }
        }
        if bytes.starts_with(b"version https://git-lfs.github.com/spec/")
            || path.ends_with(".gitattributes")
                && String::from_utf8_lossy(bytes)
                    .to_ascii_lowercase()
                    .contains("lfs")
        {
            return Err(Error::UnsafeTree);
        }
    }
    Ok(())
}
pub fn isolated(repo: &Repository, private: &StateDir, source: &Path) -> Result<()> {
    private.check()?;
    let config = private.path().join("isolated.config");
    // This sole backend is app-authored. No system/global/local Git settings enter it.
    private.write_bytes(
        "isolated.config",
        b"[core]\n bare = false\n autocrlf = false\n filemode = false\n symlinks = false\n",
    )?;
    let mut c = Config::new()?;
    c.add_file(&config, ConfigLevel::App, false)?;
    repo.set_config(&c)?;
    repo.set_workdir(source, false)?;
    private.check()?;
    Ok(())
}
pub fn initialize(private: &StateDir, source: &Path) -> Result<Repository> {
    let mut options = RepositoryInitOptions::new();
    options
        .bare(true)
        .external_template(false)
        .initial_head("heinlein-initial");
    let repo = Repository::init_opts(private.path().join("objects.git"), &options)?;
    isolated(&repo, private, source)?;
    Ok(repo)
}
pub fn open(private: &StateDir, source: &Path) -> Result<Repository> {
    private.check()?;
    let db = private.path().join("objects.git");
    if fs::symlink_metadata(&db)?.file_type().is_symlink() {
        return Err(Error::Storage);
    }
    let repo = Repository::open_bare(db)?;
    isolated(&repo, private, source)?;
    Ok(repo)
}
pub fn tree_files(repo: &Repository, commit: Oid) -> Result<Files> {
    let tree = repo.find_commit(commit)?.tree()?;
    let mut files = Files::new();
    fn visit(
        repo: &Repository,
        tree: &git2::Tree<'_>,
        prefix: &str,
        files: &mut Files,
        depth: usize,
    ) -> Result<()> {
        if depth > 32 {
            return Err(Error::Limit);
        }
        for entry in tree.iter() {
            let name = entry.name().map_err(|_| Error::UnsafeTree)?;
            let path = format!("{prefix}{name}");
            safe_path(&path)?;
            match entry.filemode() {
                0o040000 => visit(
                    repo,
                    &repo.find_tree(entry.id())?,
                    &format!("{path}/"),
                    files,
                    depth + 1,
                )?,
                0o100644 | 0o100755 => {
                    let blob = repo.find_blob(entry.id())?;
                    if blob.size() > 2 * 1024 * 1024 {
                        return Err(Error::Limit);
                    }
                    if files.values().map(Vec::len).sum::<usize>() + blob.size() > MAX_BYTES {
                        return Err(Error::Limit);
                    }
                    files.insert(path, blob.content().to_vec());
                    if files.len() > MAX_FILES {
                        return Err(Error::Limit);
                    }
                }
                _ => return Err(Error::UnsafeTree),
            }
        }
        Ok(())
    }
    visit(repo, &tree, "", &mut files, 0)?;
    validate_files(&files)?;
    validate_manuscript(&files)?;
    Ok(files)
}
pub fn materialize(root: &Path, files: &Files) -> Result<()> {
    use std::io::Write;
    validate_files(files)?;
    for (path, bytes) in files {
        let target = root.join(path);
        fs::create_dir_all(target.parent().ok_or(Error::UnsafeTree)?)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        file.write_all(bytes)?;
        file.sync_all()?
    }
    fs::File::open(root)?.sync_all()?;
    Ok(())
}
pub fn tree_from_files(repo: &Repository, files: &Files) -> Result<Oid> {
    validate_files(files)?;
    let mut index = git2::Index::new()?;
    for (path, bytes) in files {
        let id = repo.blob(bytes)?;
        index.add(&git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o100644,
            uid: 0,
            gid: 0,
            file_size: bytes.len() as u32,
            id,
            flags: 0,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        })?;
    }
    Ok(index.write_tree_to(repo)?)
}
fn callbacks<'a>(url: &'a str, credential: &'a Credential) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |requested, _, kind| {
        if requested != url || !kind.contains(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::from_str("Unsupported credential request"));
        }
        git2::Cred::userpass_plaintext(
            "x-access-token",
            credential
                .value()
                .map_err(|_| git2::Error::from_str("Sign-in changed"))?,
        )
    });
    cb.transfer_progress(move |p| {
        credential.valid() && p.received_bytes() <= 100 * 1024 * 1024 && p.total_objects() <= 50_000
    });
    cb
}
pub fn fetch(repo: &Repository, url: &str, branch: &str, credential: &Credential) -> Result<Oid> {
    crate::locator(url)?;
    fetch_to(repo, url, branch, callbacks(url, credential))
}
fn fetch_to(
    repo: &Repository,
    url: &str,
    branch: &str,
    callbacks: RemoteCallbacks<'_>,
) -> Result<Oid> {
    valid_ref(branch)?;
    let mut remote = repo.remote_anonymous(url)?;
    let mut options = FetchOptions::new();
    options
        .remote_callbacks(callbacks)
        .follow_redirects(RemoteRedirect::None)
        .update_fetchhead(false);
    // Only this app-private quarantine ref may move between unrelated fetched
    // branch tips. No working or remote branch is reset or force-pushed.
    let reference = format!("+refs/heads/{branch}:refs/heinlein/fetched");
    remote
        .fetch(&[&reference], Some(&mut options), None)
        .map_err(|_| Error::Network)?;
    Ok(repo.refname_to_id("refs/heinlein/fetched")?)
}
pub fn push(
    repo: &Repository,
    url: &str,
    branch: &str,
    head: Oid,
    expected: Option<Oid>,
    credential: &Credential,
) -> Result<()> {
    crate::locator(url)?;
    push_to(repo, url, branch, head, expected, Some(credential))
}
// Private transport seam: tests use only synthetic local bare repositories;
// production entry above always validates canonical HTTPS before reaching it.
fn push_to(
    repo: &Repository,
    url: &str,
    branch: &str,
    head: Oid,
    expected: Option<Oid>,
    credential: Option<&Credential>,
) -> Result<()> {
    valid_ref(branch)?;
    if !branch.starts_with("heinlein/story-") {
        return Err(Error::InvalidRef);
    }
    let reference = format!("refs/heads/{branch}");
    let expected = expected.unwrap_or(Oid::ZERO_SHA1);
    let wanted = reference.clone();
    let moved = std::cell::Cell::new(false);
    let rejected = std::cell::Cell::new(false);
    let mut cb = credential.map(|c| callbacks(url, c)).unwrap_or_default();
    cb.push_negotiation(|updates| {
        if updates.len() != 1
            || updates[0].dst_refname().ok() != Some(wanted.as_str())
            || updates[0].src() != expected
            || updates[0].dst() != head
        {
            moved.set(true);
            return Err(git2::Error::from_str("Remote branch changed"));
        }
        Ok(())
    });
    cb.push_update_reference(|_, error| {
        if error.is_some() {
            rejected.set(true)
        }
        Ok(())
    });
    let mut options = PushOptions::new();
    options
        .remote_callbacks(cb)
        .follow_redirects(RemoteRedirect::None);
    let mut remote = repo.remote_anonymous(url)?;
    let result = remote.push(&[&format!("{head}:{reference}")], Some(&mut options));
    drop(options);
    if moved.get() {
        return Err(Error::Changed);
    }
    if rejected.get() {
        return Err(Error::Permission);
    }
    result.map_err(|_| Error::Uncertain)
}

pub fn validate_manuscript(files: &Files) -> Result<()> {
    if files.keys().any(|p| p.ends_with("scene-manifest.json")) {
        return Err(Error::Unsupported);
    }
    if let Some(bytes) = files.get("ms/manuscript.json") {
        let text = std::str::from_utf8(bytes).map_err(|_| Error::Unsupported)?;
        let m = repository_core::parse_workspace_manifest(text).map_err(|_| Error::Unsupported)?;
        for scene in m.scenes {
            let bytes = files.get(&scene.path).ok_or(Error::Unsupported)?;
            std::str::from_utf8(bytes).map_err(|_| Error::Unsupported)?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod push_tests {
    use super::*;
    fn version(repo: &Repository, parent: Option<Oid>, text: &str) -> Oid {
        let tree = tree_from_files(
            repo,
            &Files::from([("story.md".into(), text.as_bytes().to_vec())]),
        )
        .unwrap();
        let tree = repo.find_tree(tree).unwrap();
        let signature =
            git2::Signature::now("Synthetic Writer", "test@users.noreply.github.com").unwrap();
        let parent = parent.map(|p| repo.find_commit(p).unwrap());
        repo.commit(
            None,
            &signature,
            &signature,
            "Synthetic transport version",
            &tree,
            &parent.iter().collect::<Vec<_>>(),
        )
        .unwrap()
    }
    #[test]
    fn real_libgit2_push_creates_updates_and_rejects_stale_remote_without_force() {
        let temp = tempfile::tempdir().unwrap();
        let source = Repository::init_bare(temp.path().join("source.git")).unwrap();
        let destination = Repository::init_bare(temp.path().join("destination.git")).unwrap();
        let url = destination.path().to_str().unwrap();
        let branch = "heinlein/story-00000000-0000-4000-8000-000000000001";
        let reference = format!("refs/heads/{branch}");
        let first = version(&source, None, "First exact story.\n");
        push_to(&source, url, branch, first, None, None).unwrap();
        assert_eq!(destination.refname_to_id(&reference).unwrap(), first);
        let second = version(&source, Some(first), "Second exact story — intentional.\n");
        push_to(&source, url, branch, second, Some(first), None).unwrap();
        assert_eq!(destination.refname_to_id(&reference).unwrap(), second);
        let third = version(&source, Some(second), "Third exact story.\n");
        assert!(push_to(&source, url, branch, third, Some(first), None).is_err());
        assert_eq!(destination.refname_to_id(&reference).unwrap(), second);
        assert!(push_to(&source, url, "main", third, None, None).is_err());
        assert!(destination.find_reference("refs/heads/main").is_err());
    }
    #[test]
    fn real_libgit2_fetch_quarantines_alternating_branch_heads_without_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let remote = Repository::init_bare(temp.path().join("remote.git")).unwrap();
        let local = Repository::init_bare(temp.path().join("local.git")).unwrap();
        let base = version(&remote, None, "Base scene.\n");
        let main = version(&remote, Some(base), "Main branch scene.\n");
        let feedback = version(&remote, Some(base), "Feedback branch scene.\n");
        remote
            .reference("refs/heads/main", main, false, "Synthetic main")
            .unwrap();
        remote
            .reference(
                "refs/heads/heinlein/story-test",
                feedback,
                false,
                "Synthetic feedback",
            )
            .unwrap();
        let url = remote.path().to_str().unwrap();
        for (branch, oid) in [
            ("main", main),
            ("heinlein/story-test", feedback),
            ("main", main),
        ] {
            assert_eq!(
                fetch_to(&local, url, branch, RemoteCallbacks::new()).unwrap(),
                oid
            );
            assert_eq!(
                tree_files(&local, oid).unwrap()["story.md"],
                tree_files(&remote, oid).unwrap()["story.md"]
            );
        }
        assert!(local.find_reference("refs/heads/main").is_err());
        assert!(std::fs::read(local.path().join("FETCH_HEAD"))
            .unwrap_or_default()
            .is_empty());
    }
}
