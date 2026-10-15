//! Native-only private credential persistence. No paths or file contents enter errors.
//!
//! The caller supplies an absolute application-data directory outside repositories,
//! and holds the owned `StoreGuard` across the complete load/refresh/save operation.
//! A fresh descriptor per guard also serializes independent tasks in one process.
//! Advisory locks assume cooperating trusted processes; they do not protect against
//! an attacker who already controls the account or the native host.

#[cfg(unix)]
pub(crate) use unix::Store;

/// The descriptor owns the lock, so the guard can safely cross an async await.
/// Never remove the stable lock file on unlock or sign-out.
#[cfg(unix)]
pub(crate) struct StoreGuard(std::fs::File);

#[cfg(unix)]
impl Drop for StoreGuard {
    fn drop(&mut self) {
        let _ = rustix::fs::flock(&self.0, rustix::fs::FlockOperation::Unlock);
    }
}

#[cfg(unix)]
mod unix {
    use super::StoreGuard;
    use crate::AuthError;
    use rustix::fs::{
        flock, mkdirat, open, openat, renameat, unlinkat, AtFlags, FlockOperation, Mode, OFlags,
    };
    use serde::{de::DeserializeOwned, Serialize};
    use std::{
        fs::File,
        io::{Read, Write},
        os::unix::fs::MetadataExt,
        path::{Component, Path, PathBuf},
    };

    type Result<T> = std::result::Result<T, AuthError>;
    const RECORD: &str = "auth.json";
    const LOCK: &str = ".auth.lock";
    const MAX_BYTES: u64 = 2 * 1024 * 1024;

    pub(crate) struct Store {
        path: PathBuf,
        directory: File,
        // Keep the original inode alive. A replaced lock must never silently create
        // a second refresh owner, even when an old lock guard is still held.
        lock_anchor: File,
    }

    impl Store {
        pub(crate) fn open(path: PathBuf) -> Result<Self> {
            let directory = open_directory(&path, true)?;
            private_metadata(&directory, true)?;
            let lock_anchor = File::from(
                openat(
                    &directory,
                    LOCK,
                    OFlags::RDWR
                        | OFlags::CREATE
                        | OFlags::NOFOLLOW
                        | OFlags::NONBLOCK
                        | OFlags::CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(|_| AuthError::Storage)?,
            );
            private_lock(&lock_anchor)?;
            lock_anchor.sync_all().map_err(|_| AuthError::Storage)?;
            directory.sync_all().map_err(|_| AuthError::Storage)?;
            let store = Self {
                path,
                directory,
                lock_anchor,
            };
            store.check_store()?;
            Ok(store)
        }

        /// Nonblocking: a concurrent refresh returns Busy rather than blocking the
        /// async runtime or reusing a refresh token while another process rotates it.
        pub(crate) fn lock(&self) -> Result<StoreGuard> {
            self.check_store()?;
            let file = self.open_file(LOCK)?.ok_or(AuthError::Storage)?;
            private_lock(&file)?;
            same_inode(&file, &self.lock_anchor)?;
            flock(&file, FlockOperation::NonBlockingLockExclusive).map_err(|error| {
                if error == rustix::io::Errno::WOULDBLOCK {
                    AuthError::Busy
                } else {
                    AuthError::Storage
                }
            })?;
            let guard = StoreGuard(file);
            // A name/directory replacement while acquiring the lock invalidates it.
            self.check_store()?;
            self.check_entry(LOCK, &guard.0)?;
            Ok(guard)
        }

        /// Caller holds `lock()` through both this read and any subsequent refresh.
        pub(crate) fn load<T: DeserializeOwned>(&self) -> Result<Option<T>> {
            self.check_store()?;
            let Some(file) = self.open_file(RECORD)? else {
                self.check_store()?;
                return Ok(None);
            };
            private_record(&file)?;
            let mut bytes = Vec::new();
            (&file)
                .take(MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| AuthError::Storage)?;
            if bytes.len() as u64 > MAX_BYTES {
                return Err(AuthError::Storage);
            }
            private_record(&file)?;
            self.check_store()?;
            self.check_entry(RECORD, &file)?;
            serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| AuthError::Storage)
        }

        /// Caller holds `lock()`. Rename makes readers see one complete record;
        /// syncing both file and directory makes successful writes durable.
        pub(crate) fn save<T: Serialize>(&self, value: &T) -> Result<()> {
            self.save_inner(value, |_| Ok(()))
        }

        fn save_inner<T: Serialize>(
            &self,
            value: &T,
            before_commit: impl FnOnce(&str) -> Result<()>,
        ) -> Result<()> {
            self.check_store()?;
            self.check_record_destination()?;
            // Bound serialization as well as reads, without first allocating an
            // arbitrarily large JSON string containing credentials.
            let mut bytes = BoundedBytes(Vec::new());
            serde_json::to_writer(&mut bytes, value).map_err(|_| AuthError::Storage)?;
            let temporary = format!(".auth-{}.tmp", uuid::Uuid::new_v4());
            let mut file = File::from(
                openat(
                    &self.directory,
                    temporary.as_str(),
                    OFlags::WRONLY
                        | OFlags::CREATE
                        | OFlags::EXCL
                        | OFlags::NOFOLLOW
                        | OFlags::CLOEXEC,
                    Mode::from_bits_truncate(0o600),
                )
                .map_err(|_| AuthError::Storage)?,
            );
            let result = (|| {
                private_metadata(&file, false)?;
                file.write_all(&bytes.0).map_err(|_| AuthError::Storage)?;
                file.sync_all().map_err(|_| AuthError::Storage)?;
                before_commit(&temporary)?;
                self.check_store()?;
                self.check_record_destination()?;
                private_record(&file)?;
                self.check_entry(&temporary, &file)?;
                renameat(&self.directory, temporary.as_str(), &self.directory, RECORD)
                    .map_err(|_| AuthError::Storage)?;
                self.directory.sync_all().map_err(|_| AuthError::Storage)?;
                // Do not report a successful save if a concurrent external writer
                // replaced the store or newly committed entry while it was synced.
                self.check_store()?;
                self.check_entry(RECORD, &file)?;
                Ok(())
            })();
            // This only removes a name in the descriptor-pinned private directory.
            // It never follows a replacement link or touches a link's target.
            let _ = unlinkat(&self.directory, temporary.as_str(), AtFlags::empty());
            result
        }

        fn open_file(&self, name: &str) -> Result<Option<File>> {
            match openat(
                &self.directory,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(fd) => Ok(Some(File::from(fd))),
                Err(rustix::io::Errno::NOENT) => Ok(None),
                Err(_) => Err(AuthError::Storage),
            }
        }

        fn check_entry(&self, name: &str, expected: &File) -> Result<()> {
            let current = self.open_file(name)?.ok_or(AuthError::Storage)?;
            private_metadata(expected, false)?;
            private_metadata(&current, false)?;
            same_inode(expected, &current)
        }

        fn check_store(&self) -> Result<()> {
            private_metadata(&self.directory, true)?;
            let current = open_directory(&self.path, false)?;
            private_metadata(&current, true)?;
            same_inode(&self.directory, &current)?;
            private_lock(&self.lock_anchor)?;
            self.check_entry(LOCK, &self.lock_anchor)
        }

        fn check_record_destination(&self) -> Result<()> {
            if let Some(file) = self.open_file(RECORD)? {
                private_record(&file)?;
            }
            Ok(())
        }
    }

    struct BoundedBytes(Vec<u8>);
    impl Write for BoundedBytes {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_BYTES as usize - self.0.len() {
                return Err(std::io::Error::other("private storage limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn same_inode(first: &File, second: &File) -> Result<()> {
        let first = first.metadata().map_err(|_| AuthError::Storage)?;
        let second = second.metadata().map_err(|_| AuthError::Storage)?;
        if (first.dev(), first.ino()) != (second.dev(), second.ino()) {
            return Err(AuthError::Storage);
        }
        Ok(())
    }

    fn private_metadata(file: &File, directory: bool) -> Result<()> {
        let metadata = file.metadata().map_err(|_| AuthError::Storage)?;
        if metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
            || if directory {
                !metadata.is_dir() || metadata.nlink() == 0
            } else {
                !metadata.is_file() || metadata.nlink() != 1
            }
        {
            return Err(AuthError::Storage);
        }
        Ok(())
    }

    fn private_record(file: &File) -> Result<()> {
        private_metadata(file, false)?;
        if file.metadata().map_err(|_| AuthError::Storage)?.len() > MAX_BYTES {
            return Err(AuthError::Storage);
        }
        Ok(())
    }

    fn private_lock(file: &File) -> Result<()> {
        private_metadata(file, false)?;
        if file.metadata().map_err(|_| AuthError::Storage)?.len() != 0 {
            return Err(AuthError::Storage);
        }
        Ok(())
    }

    fn open_directory(path: &Path, create: bool) -> Result<File> {
        if !path.is_absolute() || path == Path::new("/") {
            return Err(AuthError::Storage);
        }
        // Validate before making any directories; never traverse `..` or a symlink.
        if path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err(AuthError::Storage);
        }
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut directory =
            File::from(open("/", flags, Mode::empty()).map_err(|_| AuthError::Storage)?);
        for component in path.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            let fd = match openat(&directory, name, flags, Mode::empty()) {
                Ok(fd) => fd,
                Err(rustix::io::Errno::NOENT) if create => {
                    match mkdirat(&directory, name, Mode::from_bits_truncate(0o700)) {
                        Ok(()) => directory.sync_all().map_err(|_| AuthError::Storage)?,
                        Err(rustix::io::Errno::EXIST) => {}
                        Err(_) => return Err(AuthError::Storage),
                    }
                    openat(&directory, name, flags, Mode::empty())
                        .map_err(|_| AuthError::Storage)?
                }
                Err(_) => return Err(AuthError::Storage),
            };
            directory = File::from(fd);
        }
        Ok(directory)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde::{Deserialize, Serialize};
        use std::{
            fs,
            os::unix::fs::{symlink, PermissionsExt},
            process::Command,
        };

        #[derive(Debug, PartialEq, Serialize, Deserialize)]
        struct Synthetic {
            generation: u64,
            token: String,
        }

        fn record(generation: u64) -> Synthetic {
            Synthetic {
                generation,
                token: "synthetic-test-token-never-valid".into(),
            }
        }

        fn temporary() -> tempfile::TempDir {
            // Some Unix systems expose their temp directory through a symlink;
            // canonicalize only this test-owned base, never a production store.
            tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
        }

        fn private_file(path: &Path, contents: &[u8]) {
            fs::write(path, contents).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }

        fn storage_error<T>(result: Result<T>) {
            assert!(matches!(result, Err(AuthError::Storage)));
        }

        #[test]
        fn private_atomic_roundtrip_and_owned_guard() {
            fn is_send<T: Send>() {}
            is_send::<StoreGuard>();
            let temp = temporary();
            let path = temp.path().join("nested/private-auth");
            let store = Store::open(path.clone()).unwrap();
            let guard = store.lock().unwrap();
            assert_eq!(store.load::<Synthetic>().unwrap(), None);
            store.save(&record(1)).unwrap();
            let first_inode = fs::metadata(path.join(RECORD)).unwrap().ino();
            store.save(&record(2)).unwrap();
            assert_ne!(first_inode, fs::metadata(path.join(RECORD)).unwrap().ino());
            assert_eq!(store.load::<Synthetic>().unwrap(), Some(record(2)));
            for (entry, mode) in [
                (&path, 0o700),
                (&path.join(RECORD), 0o600),
                (&path.join(LOCK), 0o600),
            ] {
                let metadata = fs::metadata(entry).unwrap();
                assert_eq!(metadata.mode() & 0o7777, mode);
                assert_eq!(metadata.uid(), rustix::process::geteuid().as_raw());
            }
            assert_eq!(fs::read_dir(&path).unwrap().count(), 2);
            drop(store);
            let second = Store::open(path).unwrap();
            assert!(matches!(second.lock(), Err(AuthError::Busy)));
            drop(guard);
            assert!(second.lock().is_ok());
        }

        #[test]
        fn independent_descriptors_serialize_same_process() {
            let temp = temporary();
            let store = Store::open(temp.path().join("auth")).unwrap();
            let other = Store::open(temp.path().join("auth")).unwrap();
            let held = store.lock().unwrap();
            assert!(matches!(store.lock(), Err(AuthError::Busy)));
            assert!(matches!(other.lock(), Err(AuthError::Busy)));
            drop(held);
            let held = other.lock().unwrap();
            assert!(matches!(store.lock(), Err(AuthError::Busy)));
            drop(held);
            assert!(store.lock().is_ok());
        }

        #[test]
        fn cross_process_refresh_lock() {
            let temp = temporary();
            let path = temp.path().join("auth");
            let store = Store::open(path.clone()).unwrap();
            let guard = store.lock().unwrap();
            run_probe(&path, "busy");
            drop(guard);
            run_probe(&path, "free");
        }

        fn run_probe(path: &Path, expected: &str) {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::unix::tests::lock_process_probe",
                    "--nocapture",
                ])
                .env("HEINLEIN_SYNTHETIC_AUTH_LOCK_PATH", path)
                .env("HEINLEIN_SYNTHETIC_AUTH_LOCK_EXPECTED", expected)
                .output()
                .unwrap();
            assert!(output.status.success(), "synthetic lock subprocess failed");
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        }

        #[test]
        fn lock_process_probe() {
            let Some(path) = std::env::var_os("HEINLEIN_SYNTHETIC_AUTH_LOCK_PATH") else {
                return;
            };
            let store = Store::open(PathBuf::from(path)).unwrap();
            match std::env::var("HEINLEIN_SYNTHETIC_AUTH_LOCK_EXPECTED")
                .unwrap()
                .as_str()
            {
                "busy" => assert!(matches!(store.lock(), Err(AuthError::Busy))),
                "free" => assert!(store.lock().is_ok()),
                _ => panic!("invalid synthetic test mode"),
            }
        }

        #[test]
        fn rejects_relative_parent_and_root_paths_before_creation() {
            let temp = temporary();
            storage_error(Store::open(PathBuf::from("relative-auth")));
            storage_error(Store::open(PathBuf::from("/")));
            storage_error(Store::open(temp.path().join("new/../auth")));
            assert!(!temp.path().join("new").exists());
        }

        #[test]
        fn rejects_symlink_ancestors_and_final_directory() {
            let temp = temporary();
            let real = temp.path().join("real");
            fs::create_dir(&real).unwrap();
            let link = temp.path().join("link");
            symlink(&real, &link).unwrap();
            storage_error(Store::open(link.clone()));
            storage_error(Store::open(link.join("auth")));
            assert!(!real.join("auth").exists());
        }

        #[test]
        fn rejects_nonprivate_directory_and_permission_changes() {
            let temp = temporary();
            let path = temp.path().join("auth");
            fs::create_dir(&path).unwrap();
            for mode in [0o755, 0o770, 0o1700] {
                fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
                storage_error(Store::open(path.clone()));
            }
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            let store = Store::open(path.clone()).unwrap();
            let _guard = store.lock().unwrap();
            store.save(&record(1)).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            storage_error(store.load::<Synthetic>());
            storage_error(store.save(&record(2)));
            storage_error(store.lock());
        }

        #[test]
        fn rejects_symlink_hardlink_and_nonprivate_record_without_target_changes() {
            let temp = temporary();
            let path = temp.path().join("auth");
            let store = Store::open(path.clone()).unwrap();
            let _guard = store.lock().unwrap();
            let outside = temp.path().join("unrelated");
            private_file(&outside, b"untouched");
            symlink(&outside, path.join(RECORD)).unwrap();
            storage_error(store.load::<Synthetic>());
            storage_error(store.save(&record(1)));
            assert_eq!(fs::read(&outside).unwrap(), b"untouched");
            fs::remove_file(path.join(RECORD)).unwrap();
            fs::hard_link(&outside, path.join(RECORD)).unwrap();
            storage_error(store.load::<Synthetic>());
            storage_error(store.save(&record(1)));
            fs::remove_file(path.join(RECORD)).unwrap();
            private_file(&path.join(RECORD), b"{}");
            for mode in [0o644, 0o660, 0o4600] {
                fs::set_permissions(path.join(RECORD), fs::Permissions::from_mode(mode)).unwrap();
                storage_error(store.load::<Synthetic>());
                storage_error(store.save(&record(1)));
            }
        }

        #[test]
        fn rejects_special_record_and_lock_files_without_blocking() {
            let temp = temporary();
            let path = temp.path().join("auth");
            let store = Store::open(path.clone()).unwrap();
            let _guard = store.lock().unwrap();
            rustix::fs::mknodat(
                &store.directory,
                RECORD,
                rustix::fs::FileType::Fifo,
                Mode::from_bits_truncate(0o600),
                0,
            )
            .unwrap();
            storage_error(store.load::<Synthetic>());
            storage_error(store.save(&record(1)));
            fs::remove_file(path.join(RECORD)).unwrap();
            fs::create_dir(path.join(RECORD)).unwrap();
            storage_error(store.load::<Synthetic>());
            storage_error(store.save(&record(1)));
        }

        #[test]
        fn rejects_invalid_lock_entries() {
            let temp = temporary();
            let path = temp.path().join("auth");
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            let outside = temp.path().join("unrelated");
            private_file(&outside, b"");
            symlink(&outside, path.join(LOCK)).unwrap();
            storage_error(Store::open(path.clone()));
            fs::remove_file(path.join(LOCK)).unwrap();
            fs::hard_link(&outside, path.join(LOCK)).unwrap();
            storage_error(Store::open(path.clone()));
            fs::remove_file(path.join(LOCK)).unwrap();
            private_file(&path.join(LOCK), b"unexpected-content");
            storage_error(Store::open(path.clone()));
            private_file(&path.join(LOCK), b"");
            fs::set_permissions(path.join(LOCK), fs::Permissions::from_mode(0o644)).unwrap();
            storage_error(Store::open(path));
        }

        #[test]
        fn lock_replacement_invalidates_existing_store_and_guard() {
            let temp = temporary();
            let path = temp.path().join("auth");
            let store = Store::open(path.clone()).unwrap();
            let _guard = store.lock().unwrap();
            fs::rename(path.join(LOCK), path.join("old-lock")).unwrap();
            private_file(&path.join(LOCK), b"");
            storage_error(store.lock());
            storage_error(store.load::<Synthetic>());
            storage_error(store.save(&record(1)));
        }

        #[test]
        fn directory_replacement_and_symlink_races_fail_closed() {
            for symlink_replacement in [false, true] {
                let temp = temporary();
                let path = temp.path().join("auth");
                let store = Store::open(path.clone()).unwrap();
                let _guard = store.lock().unwrap();
                store.save(&record(1)).unwrap();
                let moved = temp.path().join("moved");
                let outside = temp.path().join("outside");
                fs::create_dir(&outside).unwrap();
                let result = store.save_inner(&record(2), |_| {
                    fs::rename(&path, &moved).unwrap();
                    if symlink_replacement {
                        symlink(&outside, &path).unwrap();
                    } else {
                        fs::create_dir(&path).unwrap();
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
                    }
                    Ok(())
                });
                storage_error(result);
                assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
                let saved: Synthetic =
                    serde_json::from_slice(&fs::read(moved.join(RECORD)).unwrap()).unwrap();
                assert_eq!(saved, record(1));
                assert_eq!(fs::read_dir(&moved).unwrap().count(), 2);
                storage_error(store.load::<Synthetic>());
                storage_error(store.lock());
            }
        }

        #[test]
        fn failed_stage_and_temporary_replacement_preserve_previous_record() {
            let temp = temporary();
            let path = temp.path().join("auth");
            let store = Store::open(path.clone()).unwrap();
            let _guard = store.lock().unwrap();
            store.save(&record(1)).unwrap();
            storage_error(store.save_inner(&record(2), |_| Err(AuthError::Storage)));
            assert_eq!(store.load::<Synthetic>().unwrap(), Some(record(1)));
            let unrelated = temp.path().join("unrelated");
            private_file(&unrelated, b"untouched");
            storage_error(store.save_inner(&record(2), |temporary| {
                fs::remove_file(path.join(temporary)).unwrap();
                symlink(&unrelated, path.join(temporary)).unwrap();
                Ok(())
            }));
            assert_eq!(store.load::<Synthetic>().unwrap(), Some(record(1)));
            assert_eq!(fs::read(&unrelated).unwrap(), b"untouched");
            assert_eq!(fs::read_dir(&path).unwrap().count(), 2);
        }

        #[test]
        fn destination_link_race_is_rejected_without_following_link() {
            let temp = temporary();
            let path = temp.path().join("auth");
            let store = Store::open(path.clone()).unwrap();
            let _guard = store.lock().unwrap();
            let unrelated = temp.path().join("unrelated");
            private_file(&unrelated, b"untouched");
            storage_error(store.save_inner(&record(1), |_| {
                symlink(&unrelated, path.join(RECORD)).unwrap();
                Ok(())
            }));
            assert_eq!(fs::read(&unrelated).unwrap(), b"untouched");
            assert!(fs::symlink_metadata(path.join(RECORD))
                .unwrap()
                .file_type()
                .is_symlink());
        }

        #[test]
        fn bounded_reads_writes_and_malformed_data_fail_closed() {
            let temp = temporary();
            let path = temp.path().join("auth");
            let store = Store::open(path.clone()).unwrap();
            let _guard = store.lock().unwrap();
            store.save(&record(1)).unwrap();
            storage_error(store.save(&"x".repeat(MAX_BYTES as usize)));
            assert_eq!(store.load::<Synthetic>().unwrap(), Some(record(1)));
            // An exact-limit JSON string remains valid; a byte beyond it is denied.
            let exact = "x".repeat(MAX_BYTES as usize - 2);
            store.save(&exact).unwrap();
            assert_eq!(store.load::<String>().unwrap(), Some(exact));
            private_file(&path.join(RECORD), &vec![b' '; MAX_BYTES as usize + 1]);
            storage_error(store.load::<serde_json::Value>());
            for malformed in [b"".as_slice(), b"{malformed", b"{} {}", b"\xff"] {
                private_file(&path.join(RECORD), malformed);
                storage_error(store.load::<Synthetic>());
            }
        }
    }
}

// No weaker fallback on platforms where this descriptor-relative implementation
// cannot guarantee the same owner-only, no-symlink storage semantics.
#[cfg(not(unix))]
pub(crate) struct Store;
#[cfg(not(unix))]
pub(crate) struct StoreGuard;
#[cfg(not(unix))]
impl Store {
    pub(crate) fn open(_path: std::path::PathBuf) -> Result<Self, crate::AuthError> {
        Err(crate::AuthError::Storage)
    }
    pub(crate) fn lock(&self) -> Result<StoreGuard, crate::AuthError> {
        Err(crate::AuthError::Storage)
    }
    pub(crate) fn load<T: serde::de::DeserializeOwned>(
        &self,
    ) -> Result<Option<T>, crate::AuthError> {
        Err(crate::AuthError::Storage)
    }
    pub(crate) fn save<T: serde::Serialize>(&self, _value: &T) -> Result<(), crate::AuthError> {
        Err(crate::AuthError::Storage)
    }
}
