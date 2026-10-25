//! Recover only a paired local metadata update, never refs, source or remote actions.
use super::*;
use crate::branches::{read_book, Book};
const JOURNAL: &str = "workspace-metadata-v1.json";
const BOOK: &str = "branch-capabilities-v1.json";
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) enum Change {
    Ordinary,
    Rebind,
    Branch,
    Legacy,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    operation: String,
    parent_operation: Option<String>,
    before: Workspace,
    after: Workspace,
    before_book: Option<Book>,
    after_book: Option<Book>,
    change: Change,
}
fn validate_workspace(w: &Workspace) -> Result<()> {
    uuid_id(&w.id)?;
    uuid_id(&w.auth_binding)?;
    w.repo.validate()?;
    crate::transport::valid_ref(&w.branch)?;
    if let Some(base) = &w.base_branch {
        crate::transport::valid_ref(base)?;
    }
    git2::Oid::from_str(&w.head_oid)?;
    git2::Oid::from_str(&w.base_oid)?;
    if let Some(head) = &w.remote_oid {
        git2::Oid::from_str(head)?;
    }
    if w.account_id == 0 {
        return Err(Error::Recovery);
    }
    Ok(())
}
fn expected_book(
    before: &Workspace,
    after: &Workspace,
    old: &Option<Book>,
    change: &Change,
) -> Result<Option<Book>> {
    validate_workspace(before)?;
    validate_workspace(after)?;
    if before.id != after.id || before.repo.id != after.repo.id {
        return Err(Error::Recovery);
    }
    if let Some(book) = old {
        if book.version != 1
            || book.workspace_id != before.id
            || book.repo_id != before.repo.id
            || book.branches.len() > 64
            || book.branches.get(&before.branch) != Some(before)
        {
            return Err(Error::Recovery);
        }
        for (branch, w) in &book.branches {
            validate_workspace(w)?;
            if branch != &w.branch
                || w.id != before.id
                || w.repo != before.repo
                || w.account_id != before.account_id
                || w.auth_binding != before.auth_binding
            {
                return Err(Error::Recovery);
            }
        }
    }
    if change != &Change::Rebind
        && (before.repo != after.repo
            || before.account_id != after.account_id
            || before.auth_binding != after.auth_binding)
    {
        return Err(Error::Recovery);
    }
    if matches!(change, Change::Ordinary | Change::Rebind) && before.branch != after.branch {
        return Err(Error::Recovery);
    }
    if change == &Change::Ordinary && before.base_branch != after.base_branch {
        return Err(Error::Recovery);
    }
    if change == &Change::Rebind {
        let mut identity_only = before.clone();
        identity_only.repo = after.repo.clone();
        identity_only.account_id = after.account_id;
        identity_only.auth_binding = after.auth_binding.clone();
        if identity_only != *after {
            return Err(Error::Recovery);
        }
    }
    if change == &Change::Branch && after.branch == after.repo.default_branch {
        return Err(Error::Recovery);
    }
    if change == &Change::Legacy
        && (before.head_oid != after.head_oid || !after.branch.starts_with("heinlein/story-"))
    {
        return Err(Error::Recovery);
    }
    let mut book = old.clone();
    if change == &Change::Branch && book.is_none() {
        if !before.branch.starts_with("heinlein/story-") {
            return Err(Error::Recovery);
        }
        book = Some(Book {
            version: 1,
            workspace_id: before.id.clone(),
            repo_id: before.repo.id,
            branches: std::collections::BTreeMap::from([(before.branch.clone(), before.clone())]),
        });
    }
    if let Some(book) = &mut book {
        if change == &Change::Rebind {
            for state in book.branches.values_mut() {
                state.repo = after.repo.clone();
                state.account_id = after.account_id;
                state.auth_binding = after.auth_binding.clone();
            }
        }
        book.branches.insert(after.branch.clone(), after.clone());
        if book.branches.len() > 64 {
            return Err(Error::Limit);
        }
    }
    Ok(book)
}
impl Record {
    fn validate(&self, dir: &StateDir) -> Result<()> {
        if self.version != 1 || serde_json::to_vec(self)?.len() > 4 * 1024 * 1024 {
            return Err(Error::Recovery);
        }
        uuid_id(&self.operation)?;
        if expected_book(&self.before, &self.after, &self.before_book, &self.change)?
            != self.after_book
        {
            return Err(Error::Recovery);
        }
        if !matches!(self.change, Change::Branch) && self.parent_operation.is_some() {
            return Err(Error::Recovery);
        }
        let parent = match self.change {
            Change::Branch => Some("branch-switch-v1.json"),
            Change::Legacy => Some("branch-transaction.json"),
            _ => None,
        };
        if let Some(name) = parent {
            let parent = dir
                .read::<serde_json::Value>(name)?
                .filter(|v| !v.is_null())
                .ok_or(Error::Recovery)?;
            if parent.get("version") != Some(&serde_json::json!(1)) {
                return Err(Error::Recovery);
            }
            if self.change == Change::Branch {
                let id = parent
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or(Error::Recovery)?;
                uuid_id(id)?;
                if self.parent_operation.as_deref() != Some(id) {
                    return Err(Error::Recovery);
                }
            } else if self.parent_operation.is_some() {
                return Err(Error::Recovery);
            }
            if parent.get("before") != Some(&serde_json::to_value(&self.before)?)
                || parent.get("after") != Some(&serde_json::to_value(&self.after)?)
            {
                return Err(Error::Recovery);
            }
            if self.change == Change::Branch
                && parent.get("book")
                    != Some(&serde_json::to_value(
                        self.after_book.as_ref().ok_or(Error::Recovery)?,
                    )?)
            {
                return Err(Error::Recovery);
            }
        }
        Ok(())
    }
}
impl Registry {
    pub(super) fn check_workspace_lock(&self, lock: &WorkspaceLock, id: &str) -> Result<()> {
        if lock.id != id || lock.registry != self.state.path() {
            return Err(Error::Recovery);
        }
        self.state.check()
    }
    pub fn metadata_pending(&self, id: &str) -> Result<bool> {
        Ok(self
            .directory(id)?
            .read::<Option<Record>>(JOURNAL)
            .map_err(|_| Error::Recovery)?
            .flatten()
            .is_some())
    }
    pub fn recover_metadata(&self, id: &str) -> Result<Workspace> {
        let lock = self.workspace_lock(id)?;
        self.recover_metadata_locked(&lock)?;
        let w = self.get(id)?;
        crate::branches::local_authorized(self, &w)?;
        Ok(w)
    }
    pub(crate) fn recover_metadata_locked(&self, lock: &WorkspaceLock) -> Result<()> {
        self.check_workspace_lock(lock, &lock.id)?;
        let _catalog = self.state.lock("catalog.lock")?;
        let dir = self.directory(&lock.id)?;
        let Some(record) = dir
            .read::<Option<Record>>(JOURNAL)
            .map_err(|_| Error::Recovery)?
            .flatten()
        else {
            return Ok(());
        };
        if record.before.id != lock.id {
            return Err(Error::Recovery);
        }
        self.finish_metadata(&dir, &record, &mut |_| Ok(()))
    }
    fn finish_metadata(
        &self,
        dir: &StateDir,
        r: &Record,
        hook: &mut impl FnMut(usize) -> Result<()>,
    ) -> Result<()> {
        r.validate(dir)?;
        let mut all = self.read().map_err(|_| Error::Recovery)?;
        let current = all
            .iter_mut()
            .find(|w| w.id == r.before.id)
            .ok_or(Error::Recovery)?;
        if *current != r.before && *current != r.after {
            return Err(Error::Recovery);
        }
        let book = read_book(self, &r.before).map_err(|_| Error::Recovery)?;
        if book != r.before_book && book != r.after_book {
            return Err(Error::Recovery);
        }
        if let Some(after) = &r.after_book {
            dir.write(BOOK, after).map_err(|_| Error::Recovery)?;
        }
        hook(2).map_err(|_| Error::Recovery)?;
        *current = r.after.clone();
        self.state
            .write(
                "registry-v1.json",
                &Catalog {
                    version: 1,
                    workspaces: all,
                },
            )
            .map_err(|_| Error::Recovery)?;
        hook(3).map_err(|_| Error::Recovery)?;
        if self.read()?.iter().find(|w| w.id == r.after.id) != Some(&r.after)
            || read_book(self, &r.after)? != r.after_book
        {
            return Err(Error::Recovery);
        }
        hook(4).map_err(|_| Error::Recovery)?;
        if dir.write(JOURNAL, &Option::<Record>::None).is_err() {
            // A rename may have succeeded before directory sync failed. Restore
            // the recovery record when possible; never acknowledge that outcome.
            let _ = dir.write(JOURNAL, &Some(r));
            return Err(Error::Recovery);
        }
        Ok(())
    }
    pub(crate) fn save_locked(
        &self,
        lock: &WorkspaceLock,
        before: &Workspace,
        after: &Workspace,
    ) -> Result<()> {
        self.save_metadata(lock, before, after, Change::Ordinary, None, &mut |_| Ok(()))
    }
    pub(crate) fn save_rebind_locked(
        &self,
        lock: &WorkspaceLock,
        before: &Workspace,
        after: &Workspace,
    ) -> Result<()> {
        self.save_metadata(lock, before, after, Change::Rebind, None, &mut |_| Ok(()))
    }
    pub(crate) fn save_branch_locked(
        &self,
        lock: &WorkspaceLock,
        before: &Workspace,
        after: &Workspace,
        book: Option<Book>,
        legacy: bool,
    ) -> Result<()> {
        self.save_metadata(
            lock,
            before,
            after,
            if legacy {
                Change::Legacy
            } else {
                Change::Branch
            },
            Some(book),
            &mut |_| Ok(()),
        )
    }
    /// Synthetic fault seam at each real durable paired-metadata boundary.
    pub fn save_with_hook(
        &self,
        before: &Workspace,
        after: &Workspace,
        mut hook: impl FnMut(usize) -> Result<()>,
    ) -> Result<()> {
        let lock = self.workspace_lock(&before.id)?;
        self.save_metadata(&lock, before, after, Change::Ordinary, None, &mut hook)
    }
    #[allow(clippy::too_many_arguments)]
    fn save_metadata(
        &self,
        lock: &WorkspaceLock,
        before: &Workspace,
        after: &Workspace,
        change: Change,
        target: Option<Option<Book>>,
        hook: &mut impl FnMut(usize) -> Result<()>,
    ) -> Result<()> {
        self.check_workspace_lock(lock, &before.id)?;
        let _catalog = self.state.lock("catalog.lock")?;
        let dir = self.directory(&before.id)?;
        if dir.read::<Option<Record>>(JOURNAL)?.flatten().is_some() {
            return Err(Error::Recovery);
        }
        let all = self.read()?;
        let current = all
            .iter()
            .find(|w| w.id == before.id)
            .ok_or(Error::Missing)?;
        let old = read_book(self, before)?;
        if let Some(target) = &target {
            // Only a still-present native parent transaction can complete idempotently.
            if current == after && old == *target {
                let parent = if change == Change::Branch {
                    "branch-switch-v1.json"
                } else {
                    "branch-transaction.json"
                };
                let p = dir
                    .read::<serde_json::Value>(parent)?
                    .ok_or(Error::Recovery)?;
                if p.get("version") != Some(&serde_json::json!(1)) {
                    return Err(Error::Recovery);
                }
                if change == Change::Branch {
                    uuid_id(
                        p.get("id")
                            .and_then(|v| v.as_str())
                            .ok_or(Error::Recovery)?,
                    )?;
                }
                if p.get("before") != Some(&serde_json::to_value(before)?)
                    || p.get("after") != Some(&serde_json::to_value(after)?)
                {
                    return Err(Error::Recovery);
                }
                return Ok(());
            }
        }
        if current != before {
            return Err(Error::Changed);
        }
        let new = expected_book(before, after, &old, &change)?;
        if target.as_ref().is_some_and(|wanted| wanted != &new) {
            return Err(Error::Recovery);
        }
        let parent_operation = if change == Change::Branch {
            let parent = dir
                .read::<serde_json::Value>("branch-switch-v1.json")?
                .ok_or(Error::Recovery)?;
            Some(
                parent
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or(Error::Recovery)?
                    .to_owned(),
            )
        } else {
            None
        };
        let record = Record {
            version: 1,
            operation: uuid::Uuid::new_v4().to_string(),
            parent_operation,
            before: before.clone(),
            after: after.clone(),
            before_book: old,
            after_book: new,
            change,
        };
        record.validate(&dir)?;
        hook(0)?;
        dir.write(JOURNAL, &Some(&record))
            .map_err(|_| Error::Recovery)?;
        hook(1).map_err(|_| Error::Recovery)?;
        self.finish_metadata(&dir, &record, hook)
    }
}
