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
/// Immutable Git tree metadata is shared across previews. Only bounded author
/// text is hydrated; passive assets stay in the object database until materialized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    pub oid: Oid,
    pub mode: u32,
    pub size: usize,
    pub editable: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Files {
    pub entries: std::sync::Arc<BTreeMap<String, TreeEntry>>,
    payloads: BTreeMap<String, std::sync::Arc<Vec<u8>>>,
}
impl Files {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(
        &mut self,
        path: String,
        bytes: impl Into<std::sync::Arc<Vec<u8>>>,
    ) -> Option<std::sync::Arc<Vec<u8>>> {
        self.payloads.insert(path, bytes.into())
    }
    pub fn payload_bytes(&self) -> usize {
        self.payloads.values().map(|b| b.len()).sum()
    }
}
impl std::ops::Deref for Files {
    type Target = BTreeMap<String, std::sync::Arc<Vec<u8>>>;
    fn deref(&self) -> &Self::Target {
        &self.payloads
    }
}
impl std::ops::DerefMut for Files {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.payloads
    }
}
impl<const N: usize> From<[(String, Vec<u8>); N]> for Files {
    fn from(value: [(String, Vec<u8>); N]) -> Self {
        value.into_iter().collect()
    }
}
impl<V: Into<std::sync::Arc<Vec<u8>>>> FromIterator<(String, V)> for Files {
    fn from_iter<T: IntoIterator<Item = (String, V)>>(iter: T) -> Self {
        Self {
            entries: Default::default(),
            payloads: iter.into_iter().map(|(p, b)| (p, b.into())).collect(),
        }
    }
}
impl std::ops::Index<&str> for Files {
    type Output = Vec<u8>;
    fn index(&self, key: &str) -> &Self::Output {
        &self.payloads[key]
    }
}
pub struct PayloadIter<'a>(std::collections::btree_map::Iter<'a, String, std::sync::Arc<Vec<u8>>>);
impl<'a> Iterator for PayloadIter<'a> {
    type Item = (&'a String, &'a Vec<u8>);
    fn next(&mut self) -> Option<Self::Item> {
        self.0.next().map(|(p, b)| (p, b.as_ref()))
    }
}
impl<'a> IntoIterator for &'a Files {
    type Item = (&'a String, &'a Vec<u8>);
    type IntoIter = PayloadIter<'a>;
    fn into_iter(self) -> Self::IntoIter {
        PayloadIter(self.payloads.iter())
    }
}
impl IntoIterator for Files {
    type Item = (String, Vec<u8>);
    type IntoIter = std::vec::IntoIter<Self::Item>;
    fn into_iter(self) -> Self::IntoIter {
        self.payloads
            .into_iter()
            .map(|(p, b)| (p, std::sync::Arc::unwrap_or_clone(b)))
            .collect::<Vec<_>>()
            .into_iter()
    }
}
// Editor/merge text is separately bounded from passive repository storage.
pub const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_EDIT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_BLOB_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_FILES: usize = 16_384;
pub fn budget(phase: &'static str, kind: &'static str, observed: usize, cap: usize) -> Error {
    Error::Budget {
        phase,
        kind,
        observed: observed as u64,
        cap: cap as u64,
    }
}
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
    let paths: std::collections::BTreeSet<_> = files.entries.keys().chain(files.keys()).collect();
    if paths.len() > MAX_FILES {
        return Err(budget("tree", "file count", paths.len(), MAX_FILES));
    }
    if files.payload_bytes() > MAX_TEXT_BYTES {
        return Err(budget(
            "editor",
            "hydrated text bytes",
            files.payload_bytes(),
            MAX_TEXT_BYTES,
        ));
    }
    let mut total = 0usize;
    let mut folded = HashMap::new();
    for path in paths {
        safe_path(path)?;
        let size = files
            .get(path)
            .map(|b| b.len())
            .unwrap_or_else(|| files.entries[path].size);
        total = total.checked_add(size).ok_or(Error::Limit)?;
        if size > MAX_BLOB_BYTES {
            return Err(budget("tree", "blob bytes", size, MAX_BLOB_BYTES));
        }
        if files.get(path).is_some() && size > MAX_EDIT_BYTES {
            return Err(budget("editor", "file bytes", size, MAX_EDIT_BYTES));
        }
        let mut prefix = String::new();
        for component in path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(component);
            let key = prefix
                .nfc()
                .flat_map(char::to_lowercase)
                .collect::<String>();
            if let Some(previous) = folded.insert(key, prefix.clone()) {
                if previous != prefix {
                    return Err(Error::UnsafeTree);
                }
            }
        }
        if let Some(bytes) = files.get(path) {
            validate_lfs(path, bytes)?;
        }
    }
    if total > MAX_BYTES {
        return Err(budget("tree", "total bytes", total, MAX_BYTES));
    }
    Ok(())
}
fn validate_lfs(path: &str, bytes: &[u8]) -> Result<()> {
    if bytes.starts_with(b"version https://git-lfs.github.com/spec/")
        || path.ends_with(".gitattributes")
            && String::from_utf8_lossy(bytes)
                .to_ascii_lowercase()
                .contains("lfs")
    {
        return Err(Error::UnsafeTree);
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
    let mut entries = BTreeMap::new();
    fn visit(
        repo: &Repository,
        tree: &git2::Tree<'_>,
        prefix: &str,
        entries: &mut BTreeMap<String, TreeEntry>,
        files: &mut Files,
        total: &mut usize,
        depth: usize,
    ) -> Result<()> {
        if depth > 32 {
            return Err(budget("tree", "directory depth", depth, 32));
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
                    entries,
                    files,
                    total,
                    depth + 1,
                )?,
                0o100644 | 0o100755 => {
                    let (size, kind) = repo.odb()?.read_header(entry.id())?;
                    if kind != git2::ObjectType::Blob {
                        return Err(Error::UnsafeTree);
                    }
                    if size > MAX_BLOB_BYTES {
                        return Err(budget("tree", "blob bytes", size, MAX_BLOB_BYTES));
                    }
                    *total = total.checked_add(size).ok_or(Error::Limit)?;
                    if *total > MAX_BYTES {
                        return Err(budget("tree", "total bytes", *total, MAX_BYTES));
                    }
                    if entries.len() >= MAX_FILES {
                        return Err(budget("tree", "file count", entries.len() + 1, MAX_FILES));
                    }
                    // At most one bounded decompressed passive blob is live here.
                    let blob = repo.find_blob(entry.id())?;
                    validate_lfs(&path, blob.content())?;
                    let editable = crate::operations::author_path(&path) && size <= MAX_EDIT_BYTES;
                    if editable {
                        if files.payload_bytes() + size > MAX_TEXT_BYTES {
                            return Err(budget(
                                "editor",
                                "hydrated text bytes",
                                files.payload_bytes() + size,
                                MAX_TEXT_BYTES,
                            ));
                        }
                        files.insert(path.clone(), blob.content().to_vec());
                    }
                    entries.insert(
                        path,
                        TreeEntry {
                            oid: entry.id(),
                            mode: entry.filemode() as u32,
                            size,
                            editable,
                        },
                    );
                }
                _ => return Err(Error::UnsafeTree),
            }
        }
        Ok(())
    }
    visit(repo, &tree, "", &mut entries, &mut files, &mut 0, 0)?;
    files.entries = std::sync::Arc::new(entries);
    validate_files(&files)?;
    validate_manuscript(&files)?;
    Ok(files)
}
pub fn materialize(repo: &Repository, root: &Path, files: &Files) -> Result<()> {
    use std::io::Write;
    validate_files(files)?;
    for (path, entry) in files.entries.iter() {
        let target = root.join(path);
        fs::create_dir_all(target.parent().ok_or(Error::UnsafeTree)?)?;
        let blob = repo.find_blob(entry.oid)?;
        if blob.size() != entry.size {
            return Err(Error::Changed);
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        file.write_all(blob.content())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(if entry.mode == 0o100755 {
                0o755
            } else {
                0o644
            }))?;
        }
        file.sync_all()?;
    }
    let mut directories = std::collections::BTreeSet::from([root.to_owned()]);
    for path in files.entries.keys() {
        let mut parent = root.join(path).parent().map(Path::to_owned);
        while let Some(dir) = parent {
            if !dir.starts_with(root) {
                break;
            }
            directories.insert(dir.clone());
            if dir == root {
                break;
            }
            parent = dir.parent().map(Path::to_owned);
        }
    }
    let mut directories: Vec<_> = directories.into_iter().collect();
    directories.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for dir in directories {
        fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}
/// Reuse every passive OID and mode. Only hydrated text is replaced/deleted.
pub fn snapshot_tree(repo: &Repository, files: &Files) -> Result<Oid> {
    validate_files(files)?;
    let mut index = git2::Index::new()?;
    let keys: std::collections::BTreeSet<_> = files.entries.keys().chain(files.keys()).collect();
    for path in keys {
        let entry = files.entries.get(path);
        let (oid, size) = match files.get(path) {
            Some(bytes) => (repo.blob(bytes)?, bytes.len()),
            None if entry.is_some_and(|e| !e.editable) => {
                let e = entry.unwrap();
                (e.oid, e.size)
            }
            None => continue,
        };
        index.add(&git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: entry.map(|e| e.mode).unwrap_or(0o100644),
            uid: 0,
            gid: 0,
            file_size: size as u32,
            id: oid,
            flags: 0,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        })?;
    }
    Ok(index.write_tree_to(repo)?)
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
fn callbacks<'a>(
    url: &'a str,
    credential: &'a Credential,
    failure: Option<std::sync::Arc<std::sync::Mutex<Option<Error>>>>,
) -> RemoteCallbacks<'a> {
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
        let over = if p.received_bytes() > 100 * 1024 * 1024 {
            Some(budget(
                "fetch",
                "transfer bytes",
                p.received_bytes(),
                100 * 1024 * 1024,
            ))
        } else if p.total_objects() > 50_000 {
            Some(budget("fetch", "object count", p.total_objects(), 50_000))
        } else {
            None
        };
        if let (Some(error), Some(failure)) = (over, &failure) {
            if let Ok(mut slot) = failure.lock() {
                *slot = Some(error);
            }
        }
        credential.valid() && over.is_none()
    });
    cb
}
pub fn fetch(repo: &Repository, url: &str, branch: &str, credential: &Credential) -> Result<Oid> {
    crate::locator(url)?;
    object_disk_budget(repo.path())?;
    let failure = std::sync::Arc::new(std::sync::Mutex::new(None));
    let result = fetch_to(
        repo,
        url,
        branch,
        callbacks(url, credential, Some(failure.clone())),
    );
    if let Some(error) = *failure.lock().map_err(|_| Error::Storage)? {
        return Err(error);
    }
    let oid = result?;
    object_disk_budget(repo.path())?;
    Ok(oid)
}
fn object_disk_budget(root: &Path) -> Result<()> {
    let mut pending = vec![root.to_owned()];
    let mut bytes = 0usize;
    let mut count = 0usize;
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                return Err(Error::Storage);
            }
            count += 1;
            if count > 60_000 {
                return Err(budget(
                    "private objects",
                    "filesystem entries",
                    count,
                    60_000,
                ));
            }
            if meta.is_dir() {
                pending.push(entry.path());
            } else {
                bytes = bytes.checked_add(meta.len() as usize).ok_or(Error::Limit)?;
            }
            if bytes > 512 * 1024 * 1024 {
                return Err(budget(
                    "private objects",
                    "disk bytes",
                    bytes,
                    512 * 1024 * 1024,
                ));
            }
        }
    }
    Ok(())
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
    credential: &Credential,
    authority: &crate::branches::Authority,
) -> Result<()> {
    crate::locator(&authority.url)?;
    if !credential.valid()
        || credential.account.id != authority.account_id
        || credential.binding != authority.binding
    {
        return Err(Error::Account);
    }
    push_to(
        repo,
        &authority.url,
        &authority.branch,
        authority.head,
        authority.remote,
        Some(credential),
        Some(&authority.branch),
    )
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
    authorized_ref: Option<&str>,
) -> Result<()> {
    valid_ref(branch)?;
    if authorized_ref
        .map(|name| name != branch)
        .unwrap_or_else(|| !branch.starts_with("heinlein/story-"))
    {
        return Err(Error::InvalidRef);
    }
    let reference = format!("refs/heads/{branch}");
    let expected = expected.unwrap_or(Oid::ZERO_SHA1);
    let wanted = reference.clone();
    let moved = std::cell::Cell::new(false);
    let rejected = std::cell::Cell::new(false);
    let mut cb = credential
        .map(|c| callbacks(url, c, None))
        .unwrap_or_default();
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
        push_to(&source, url, branch, first, None, None, None).unwrap();
        assert_eq!(destination.refname_to_id(&reference).unwrap(), first);
        let second = version(&source, Some(first), "Second exact story — intentional.\n");
        push_to(&source, url, branch, second, Some(first), None, None).unwrap();
        assert_eq!(destination.refname_to_id(&reference).unwrap(), second);
        let third = version(&source, Some(second), "Third exact story.\n");
        assert!(push_to(&source, url, branch, third, Some(first), None, None).is_err());
        assert_eq!(destination.refname_to_id(&reference).unwrap(), second);
        assert!(push_to(&source, url, "main", third, None, None, None).is_err());
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
