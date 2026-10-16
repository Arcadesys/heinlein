//! Repository-owned, append-only chat records. No credentials or manuscript writes.
use crate::{Error, Repository, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatThread {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub created_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatEvent {
    pub schema_version: u32,
    pub request_id: String,
    pub kind: String,
    pub created_at: u64,
    pub data: Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTranscript {
    pub thread: ChatThread,
    pub events: Vec<ChatEvent>,
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|v| v.to_string() == id)
}
impl ChatThread {
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1
            || !valid_id(&self.id)
            || self.title.trim().is_empty()
            || self.title.len() > 512
        {
            return Err(Error::InvalidPath);
        }
        Ok(())
    }
}
impl ChatEvent {
    fn validate(&self) -> Result<()> {
        if self.schema_version != 1
            || !valid_id(&self.request_id)
            || !matches!(self.kind.as_str(), "question" | "answer" | "error")
            || !self.data.is_object()
        {
            return Err(Error::InvalidPath);
        }
        Ok(())
    }
}
#[cfg(unix)]
mod native {
    use super::*;
    use rustix::{
        fd::AsFd,
        fs::{linkat, mkdirat, openat, unlinkat, AtFlags, Dir, Mode, OFlags},
    };
    use std::{
        fs::File,
        io::{Read, Write},
        os::unix::fs::MetadataExt,
    };
    const MAX_RECORD: u64 = 512_000;
    const MAX_TRANSCRIPT: usize = 16_000_000;
    fn dir(parent: impl AsFd, name: &str, create: bool) -> Result<File> {
        if create {
            match mkdirat(&parent, name, Mode::from_bits_truncate(0o700)) {
                Ok(()) => File::from(rustix::io::dup(&parent).map_err(|_| Error::Io)?)
                    .sync_all()
                    .map_err(|_| Error::Io)?,
                Err(rustix::io::Errno::EXIST) => {}
                Err(_) => return Err(Error::Io),
            }
        }
        openat(
            &parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(crate::errno)
    }
    fn read<T: serde::de::DeserializeOwned>(directory: &File, name: &str) -> Result<(T, usize)> {
        let file = File::from(
            openat(
                directory,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(crate::errno)?,
        );
        let meta = file.metadata().map_err(|_| Error::Io)?;
        if !meta.is_file() || meta.nlink() != 1 {
            return Err(Error::Denied);
        }
        if meta.len() > MAX_RECORD {
            return Err(Error::TooLarge);
        }
        let mut bytes = Vec::new();
        file.take(MAX_RECORD + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Io)?;
        if bytes.len() as u64 > MAX_RECORD {
            return Err(Error::TooLarge);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| Error::UnsupportedText)?;
        Ok((value, bytes.len()))
    }
    fn write_new(directory: &File, name: &str, value: &impl Serialize) -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|_| Error::Io)?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_RECORD {
            return Err(Error::TooLarge);
        }
        let temporary = format!(".pending-{}", uuid::Uuid::new_v4());
        let result = (|| {
            let mut file = File::from(
                openat(
                    directory,
                    temporary.as_str(),
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(crate::errno)?,
            );
            file.write_all(&bytes).map_err(|_| Error::Io)?;
            file.sync_all().map_err(|_| Error::Io)?;
            // Publishing a new name never replaces an existing question/answer.
            linkat(
                directory,
                temporary.as_str(),
                directory,
                name,
                AtFlags::empty(),
            )
            .map_err(|e| {
                if e == rustix::io::Errno::EXIST {
                    Error::Conflict
                } else {
                    Error::Io
                }
            })?;
            unlinkat(directory, temporary.as_str(), AtFlags::empty())
                .map_err(|_| Error::SaveUncertain)?;
            directory.sync_all().map_err(|_| Error::SaveUncertain)
        })();
        let _ = unlinkat(directory, temporary.as_str(), AtFlags::empty());
        result
    }
    fn names(directory: &File) -> Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in Dir::read_from(directory).map_err(|_| Error::Io)? {
            let entry = entry.map_err(|_| Error::Io)?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| Error::UnsupportedText)?;
            if name.starts_with('.') {
                continue;
            }
            if names.len() >= 4096 {
                return Err(Error::LimitExceeded);
            }
            names.push(name.to_owned());
        }
        names.sort();
        Ok(names)
    }
    impl Repository {
        fn chat_root(&self, create: bool) -> Result<File> {
            dir(dir(&self.fd, ".heinlein", create)?, "chats", create)
        }
        pub fn create_chat(&self, thread: &ChatThread) -> Result<()> {
            thread.validate()?;
            let root = self.chat_root(true)?;
            // An existing directory is allowed only when it has no thread record.
            let folder = dir(&root, &thread.id, true)?;
            write_new(&folder, "thread.json", thread)
        }
        pub fn chat_threads(&self) -> Result<Vec<ChatThread>> {
            let root = match self.chat_root(false) {
                Ok(root) => root,
                Err(Error::NotFound) => return Ok(Vec::new()),
                Err(e) => return Err(e),
            };
            let mut threads = Vec::new();
            for id in names(&root)? {
                if !valid_id(&id) {
                    continue;
                }
                let folder = dir(&root, &id, false)?;
                let (thread, _) = read::<ChatThread>(&folder, "thread.json")?;
                thread.validate()?;
                if thread.id != id {
                    return Err(Error::Conflict);
                }
                threads.push(thread);
            }
            threads.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
            Ok(threads)
        }
        pub fn chat_transcript(&self, id: &str) -> Result<ChatTranscript> {
            if !valid_id(id) {
                return Err(Error::InvalidPath);
            }
            let folder = dir(self.chat_root(false)?, id, false)?;
            let (thread, _) = read::<ChatThread>(&folder, "thread.json")?;
            thread.validate()?;
            if thread.id != id {
                return Err(Error::Conflict);
            }
            let mut events = Vec::new();
            let mut total = 0;
            for name in names(&folder)? {
                if name == "thread.json" || !name.ends_with(".json") {
                    continue;
                }
                let (event, size) = read::<ChatEvent>(&folder, &name)?;
                event.validate()?;
                if name != format!("{}-{}.json", event.request_id, event.kind) {
                    return Err(Error::Conflict);
                }
                total += size;
                if total > MAX_TRANSCRIPT {
                    return Err(Error::TooLarge);
                }
                events.push(event);
            }
            events.sort_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then(a.request_id.cmp(&b.request_id))
                    .then(a.kind.cmp(&b.kind))
            });
            Ok(ChatTranscript { thread, events })
        }
        pub fn append_chat_event(&self, id: &str, event: &ChatEvent) -> Result<()> {
            if !valid_id(id) {
                return Err(Error::InvalidPath);
            }
            event.validate()?;
            let folder = dir(self.chat_root(false)?, id, false)?;
            let (thread, _) = read::<ChatThread>(&folder, "thread.json")?;
            thread.validate()?;
            if thread.id != id {
                return Err(Error::Conflict);
            }
            write_new(
                &folder,
                &format!("{}-{}.json", event.request_id, event.kind),
                event,
            )
        }
    }
}
#[cfg(not(unix))]
impl Repository {
    pub fn create_chat(&self, _: &ChatThread) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn chat_threads(&self) -> Result<Vec<ChatThread>> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn chat_transcript(&self, _: &str) -> Result<ChatTranscript> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn append_chat_event(&self, _: &str, _: &ChatEvent) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    fn thread() -> ChatThread {
        ChatThread {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            title: "A persistent chat — 🦊".into(),
            created_at: 1,
        }
    }
    fn question() -> ChatEvent {
        ChatEvent {
            schema_version: 1,
            request_id: uuid::Uuid::new_v4().to_string(),
            kind: "question".into(),
            created_at: 2,
            data: serde_json::json!({"question":"What next?","context":"Explicit 🦊 context","history":[],"model":"test-model"}),
        }
    }
    #[test]
    fn chat_records_survive_reopen_and_do_not_modify_manuscripts() {
        let root = tempfile::tempdir().unwrap();
        let source = b"Author's exact words\r\n";
        fs::write(root.path().join("scene.md"), source).unwrap();
        let repo = Repository::open(root.path().canonicalize().unwrap()).unwrap();
        assert!(repo.chat_threads().unwrap().is_empty());
        assert!(!root.path().join(".heinlein").exists());
        let header = thread();
        repo.create_chat(&header).unwrap();
        let q = question();
        repo.append_chat_event(&header.id, &q).unwrap();
        drop(repo);
        let repo = Repository::open(root.path().canonicalize().unwrap()).unwrap();
        let saved = repo.chat_transcript(&header.id).unwrap();
        assert_eq!(saved.events.len(), 1);
        assert_eq!(saved.events[0].data, q.data);
        let answer = ChatEvent {
            kind: "answer".into(),
            created_at: 3,
            data: serde_json::json!({"text":"Advisory answer"}),
            ..q.clone()
        };
        repo.append_chat_event(&header.id, &answer).unwrap();
        assert!(matches!(
            repo.append_chat_event(&header.id, &answer),
            Err(Error::Conflict)
        ));
        assert!(repo.create_chat(&header).is_err());
        drop(repo);
        let repo = Repository::open(root.path().canonicalize().unwrap()).unwrap();
        assert_eq!(repo.chat_threads().unwrap()[0].id, header.id);
        let saved = repo.chat_transcript(&header.id).unwrap();
        assert_eq!(saved.events.len(), 2);
        assert_eq!(saved.events[1].data["text"], "Advisory answer");
        assert_eq!(fs::read(root.path().join("scene.md")).unwrap(), source);
    }
    #[test]
    fn chat_records_reject_traversal_symlinks_hardlinks_and_corruption() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let repo = Repository::open(root.path().canonicalize().unwrap()).unwrap();
        let header = thread();
        symlink(outside.path(), root.path().join(".heinlein")).unwrap();
        assert!(repo.create_chat(&header).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_file(root.path().join(".heinlein")).unwrap();
        repo.create_chat(&header).unwrap();
        assert!(repo.chat_transcript("../scene.md").is_err());
        let q = question();
        let folder = root.path().join(".heinlein/chats").join(&header.id);
        let record = folder.join(format!("{}-question.json", q.request_id));
        symlink(outside.path().join("secret"), &record).unwrap();
        assert!(repo.append_chat_event(&header.id, &q).is_err());
        assert!(repo.chat_transcript(&header.id).is_err());
        fs::remove_file(&record).unwrap();
        repo.append_chat_event(&header.id, &q).unwrap();
        fs::hard_link(&record, outside.path().join("linked")).unwrap();
        assert!(repo.chat_transcript(&header.id).is_err());
        fs::remove_file(outside.path().join("linked")).unwrap();
        fs::write(&record, b"broken JSON").unwrap();
        assert!(repo.chat_transcript(&header.id).is_err());
        assert_eq!(fs::read(&record).unwrap(), b"broken JSON");
    }
    #[test]
    fn concurrent_chat_writers_never_replace_a_record_and_orphan_temporary_is_ignored() {
        let root = tempfile::tempdir().unwrap();
        let repo =
            std::sync::Arc::new(Repository::open(root.path().canonicalize().unwrap()).unwrap());
        let header = thread();
        repo.create_chat(&header).unwrap();
        let q = question();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let repo = repo.clone();
                let q = q.clone();
                let id = header.id.clone();
                std::thread::spawn(move || repo.append_chat_event(&id, &q))
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .map(|h| h.join().unwrap().is_ok() as usize)
                .sum::<usize>(),
            1
        );
        fs::write(
            root.path()
                .join(".heinlein/chats")
                .join(&header.id)
                .join(".pending-interrupted"),
            b"partial",
        )
        .unwrap();
        assert_eq!(repo.chat_transcript(&header.id).unwrap().events.len(), 1);
    }
}
