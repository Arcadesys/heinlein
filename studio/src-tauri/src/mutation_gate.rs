type Result<T> = std::result::Result<T, String>;
/// Ordinary save and recovery staging may overlap. Confirmed author operations
/// exclusively pause both. Dirty notifications only advance an atomic epoch and
/// never wait on filesystem I/O or a native dialog.
#[derive(Default)]
pub struct MutationGate {
    lock: std::sync::RwLock<()>,
    epoch: std::sync::atomic::AtomicU64,
    activity: std::sync::atomic::AtomicU64,
    exiting: std::sync::atomic::AtomicBool,
}
impl MutationGate {
    pub fn close_guard(&self) -> Result<std::sync::RwLockWriteGuard<'_, ()>> {
        self.lock
            .try_write()
            .map_err(|_| "Finish the current save or manuscript operation before quitting".into())
    }
    pub fn edit(&self) -> Result<std::sync::RwLockReadGuard<'_, ()>> {
        let guard = self
            .lock
            .read()
            .map_err(|_| "Editor operations unavailable")?;
        if self.exiting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Heinlein is quitting".into());
        }
        self.note_activity();
        Ok(guard)
    }
    pub fn author_operation(&self) -> Result<std::sync::RwLockWriteGuard<'_, ()>> {
        let guard = self
            .lock
            .write()
            .map_err(|_| "Editor operations unavailable")?;
        if self.exiting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Heinlein is quitting".into());
        }
        self.note_activity();
        Ok(guard)
    }
    pub fn activity(&self) -> u64 {
        self.activity.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn note_activity(&self) {
        self.activity
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    /// Called only with the final exclusive close guard held; queued writers fail.
    pub fn seal_for_exit(&self) {
        self.exiting
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn invalidate(&self) {
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn generation(&self) -> u64 {
        self.epoch.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_quiescence_rejects_queued_and_future_mutations() {
        let gate = std::sync::Arc::new(MutationGate::default());
        let before = gate.activity();
        drop(gate.edit().unwrap());
        assert!(gate.activity() > before);
        assert_eq!(
            gate.generation(),
            0,
            "activity must not invalidate proposal epoch"
        );
        let exclusive = gate.close_guard().unwrap();
        let queued = gate.clone();
        let worker = std::thread::spawn(move || queued.author_operation().is_err());
        gate.seal_for_exit();
        drop(exclusive);
        assert!(worker.join().unwrap());
        assert!(gate.edit().is_err());
        assert!(gate.author_operation().is_err());
    }
}
