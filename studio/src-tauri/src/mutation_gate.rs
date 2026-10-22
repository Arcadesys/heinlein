type Result<T> = std::result::Result<T, String>;
/// Ordinary save and recovery staging may overlap. Confirmed author operations
/// exclusively pause both. Dirty notifications only advance an atomic epoch and
/// never wait on filesystem I/O or a native dialog.
#[derive(Default)]
pub struct MutationGate {
    lock: std::sync::RwLock<()>,
    epoch: std::sync::atomic::AtomicU64,
}
impl MutationGate {
    pub fn close_guard(&self) -> Result<std::sync::RwLockWriteGuard<'_, ()>> {
        self.lock
            .try_write()
            .map_err(|_| "Finish the current save or manuscript operation before quitting".into())
    }
    pub fn edit(&self) -> Result<std::sync::RwLockReadGuard<'_, ()>> {
        self.lock
            .read()
            .map_err(|_| "Editor operations unavailable".into())
    }
    pub fn author_operation(&self) -> Result<std::sync::RwLockWriteGuard<'_, ()>> {
        self.lock
            .write()
            .map_err(|_| "Editor operations unavailable".into())
    }
    pub fn invalidate(&self) {
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn generation(&self) -> u64 {
        self.epoch.load(std::sync::atomic::Ordering::SeqCst)
    }
}
