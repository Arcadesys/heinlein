use super::*;
use crate::fuzz_support::{campaign, Case};
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt};
use tempfile::TempDir;

type Files = BTreeMap<String, (Vec<u8>, u32)>;
fn files(root: &Path) -> Files {
    fn visit(root: &Path, dir: &Path, found: &mut Files) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, found);
            } else {
                found.insert(
                    path.strip_prefix(root).unwrap().to_str().unwrap().into(),
                    (
                        fs::read(&path).unwrap(),
                        fs::metadata(path).unwrap().mode() & 0o777,
                    ),
                );
            }
        }
    }
    let mut found = Files::new();
    visit(root, root, &mut found);
    found
}
struct Fixture {
    temp: TempDir,
    repo: Repository,
    recovery: RecoveryStore,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        fs::create_dir(temp.path().join("repo")).unwrap();
        let repo = Repository::open(temp.path().join("repo")).unwrap();
        let recovery = RecoveryStore::open(temp.path().join("private")).unwrap();
        Self {
            temp,
            repo,
            recovery,
        }
    }
    fn restart(self) -> Self {
        let Self {
            temp,
            repo,
            recovery,
        } = self;
        drop(recovery);
        drop(repo);
        let repo = Repository::open(temp.path().join("repo")).unwrap();
        let recovery = RecoveryStore::open(temp.path().join("private")).unwrap();
        Self {
            temp,
            repo,
            recovery,
        }
    }
    fn put(&self, path: &str, text: &str, mode: u32) {
        let path = self.repo.root().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }
    fn preview(&self, change: DraftingChange) -> Result<DraftingPlan> {
        self.repo.preview_drafting(
            self.repo.load_drafting()?.revision.as_deref(),
            change,
            &[],
            &self.recovery,
        )
    }
    fn apply(&self, change: DraftingChange) -> DraftingUndo {
        self.repo
            .apply_drafting(&self.preview(change).unwrap(), &self.recovery)
            .unwrap()
    }
    fn initialize(&self) {
        self.apply(DraftingChange::Initialize {
            project: "Synthetic—東京".into(),
        });
    }
}
fn create(path: &str) -> DraftingChange {
    DraftingChange::CreateScene {
        title: "Synthetic scene".into(),
        path: path.into(),
        group_id: None,
        before_id: None,
    }
}
fn moving(scene: &DraftingScene, path: &str) -> DraftingChange {
    DraftingChange::MoveScene {
        scene_id: scene.id.clone(),
        path: path.into(),
        group_id: scene.group_id.clone(),
        before_id: None,
    }
}
fn copied(scene: &DraftingScene, destination: &str) -> DraftingChange {
    DraftingChange::ImportRepository {
        paths: vec![scene.path.clone()],
        destination: destination.into(),
        mode: "copy".into(),
        group_id: None,
        before_id: None,
    }
}
fn capture_new(f: &Fixture, model: &mut Vec<DraftingScene>, path: &str) {
    let state = f.repo.load_drafting().unwrap();
    let scene = state.scenes.last().unwrap().clone();
    assert_eq!(scene.path, path);
    assert!(uuid::Uuid::parse_str(&scene.id).is_ok());
    assert!(!model.iter().any(|old| old.id == scene.id));
    model.push(scene);
}
fn verify(f: &Fixture, model: &[DraftingScene], contents: &Files) {
    let state = f.repo.load_drafting().unwrap();
    assert_eq!(state.scenes, model);
    assert!(state.untracked_paths.is_empty());
    assert!(state.missing_paths.is_empty());
    assert!(!state.recovery_required);
    let mut actual = files(f.repo.root());
    actual.remove(MANIFEST).unwrap();
    assert_eq!(
        actual.keys().collect::<Vec<_>>(),
        contents.keys().collect::<Vec<_>>()
    );
    for (path, expected) in contents {
        assert_eq!(&actual[path], expected, "file differs: {path}");
    }
    assert_eq!(
        state.revision.unwrap(),
        content_hash(&fs::read_to_string(f.repo.root().join(MANIFEST)).unwrap())
    );
    assert_clean_private_transaction(f);
}
fn assert_clean_private_transaction(f: &Fixture) {
    for entry in fs::read_dir(f.temp.path().join("private")).unwrap() {
        let name = entry.unwrap().file_name();
        assert!(
            !name.to_string_lossy().ends_with(".tmp"),
            "leftover private temporary: {name:?}"
        );
        assert!(
            !name.to_string_lossy().starts_with(".heinlein-structure-"),
            "leftover private receipt: {name:?}"
        );
    }
}

#[test]
fn seeded_structure_state_machine() {
    campaign("structure", |case| {
        let mut f = Fixture::new();
        f.initialize();
        let mut model = vec![];
        let mut contents = Files::new();
        for n in 0..3 {
            let path = format!("ms/start-{n}.md");
            f.apply(create(&path));
            capture_new(&f, &mut model, &path);
            let text = case.text();
            f.repo.save(&path, &content_hash(""), &text).unwrap();
            contents.insert(path, (text.into_bytes(), 0o600));
        }
        for step in 0..case.steps {
            let index = case.pick(model.len());
            let scene = model[index].clone();
            let target = format!("ms/step-{step}/épisode.md");
            let operation = if step < 14 { step } else { case.pick(14) };
            case.record(
                [
                    "create",
                    "move",
                    "copy",
                    "reorder",
                    "save",
                    "undo-move",
                    "guarded-undo",
                    "restart",
                    "stale-source-plan",
                    "stale-membership-reconcile",
                    "pending-recovery",
                    "owner-transfer",
                    "reconcile-removal",
                    "stale-index-plan",
                ][operation],
                format!("source={} step={step}", scene.path),
            );
            match operation {
                0 => {
                    f.apply(create(&target));
                    capture_new(&f, &mut model, &target);
                    contents.insert(target, (vec![], 0o600));
                }
                1 => {
                    f.apply(moving(&scene, &target));
                    let bytes = contents.remove(&scene.path).unwrap();
                    contents.insert(target.clone(), bytes);
                    let mut moved = model.remove(index);
                    moved.path = target;
                    model.push(moved);
                }
                2 => {
                    let directory = format!("ms/copy-{step}");
                    let path = format!(
                        "{directory}/{}",
                        Path::new(&scene.path)
                            .file_name()
                            .unwrap()
                            .to_str()
                            .unwrap()
                    );
                    f.apply(copied(&scene, &directory));
                    capture_new(&f, &mut model, &path);
                    contents.insert(path, (contents[&scene.path].0.clone(), 0o600));
                }
                3 => {
                    let before = if case.pick(2) == 0 {
                        model
                            .iter()
                            .find(|s| s.id != scene.id)
                            .map(|s| s.id.clone())
                    } else {
                        None
                    };
                    f.apply(DraftingChange::ReorderScene {
                        scene_id: scene.id.clone(),
                        before_id: before.clone(),
                        group_id: None,
                    });
                    let mut moved = model.remove(index);
                    moved.group_id = None;
                    let position = before
                        .and_then(|id| model.iter().position(|s| s.id == id))
                        .unwrap_or(model.len());
                    model.insert(position, moved);
                }
                4 => {
                    let text = case.text();
                    let doc = f.repo.read(&scene.path).unwrap();
                    f.repo
                        .save_with_recovery(&scene.path, &doc.content_hash, &text, &f.recovery)
                        .unwrap();
                    contents.get_mut(&scene.path).unwrap().0 = text.into_bytes();
                }
                5 => {
                    let before = files(f.repo.root());
                    let undo = f.apply(moving(&scene, &target));
                    f.repo.undo_drafting(&undo, &f.recovery).unwrap();
                    assert_eq!(files(f.repo.root()), before);
                }
                6 => {
                    let undo = f.apply(moving(&scene, &target));
                    let text = case.text();
                    f.put(&target, &text, contents[&scene.path].1);
                    let before = files(f.repo.root());
                    assert_eq!(
                        f.repo.undo_drafting(&undo, &f.recovery).unwrap_err(),
                        Error::DraftingChanged
                    );
                    assert_eq!(files(f.repo.root()), before);
                    let (_, mode) = contents.remove(&scene.path).unwrap();
                    contents.insert(target.clone(), (text.into_bytes(), mode));
                    let mut moved = model.remove(index);
                    moved.path = target;
                    model.push(moved);
                }
                7 => {
                    f = f.restart();
                }
                8 => {
                    let plan = f
                        .preview(copied(&scene, &format!("ms/stale-{step}")))
                        .unwrap();
                    let text = case.text();
                    f.put(&scene.path, &text, contents[&scene.path].1);
                    contents.get_mut(&scene.path).unwrap().0 = text.into_bytes();
                    let before = files(f.repo.root());
                    assert_eq!(
                        f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
                        Error::DraftingChanged
                    );
                    assert_eq!(files(f.repo.root()), before);
                }
                9 => {
                    let plan = f.preview(create(&target)).unwrap();
                    let path = format!("ms/loose-{step}.md");
                    let text = case.text();
                    f.put(&path, &text, 0o640);
                    let before = files(f.repo.root());
                    assert_eq!(
                        f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
                        Error::DraftingChanged
                    );
                    assert_eq!(files(f.repo.root()), before);
                    f.apply(DraftingChange::Reconcile {});
                    capture_new(&f, &mut model, &path);
                    contents.insert(path, (text.into_bytes(), 0o640));
                }
                10 => {
                    let plan = f.preview(moving(&scene, &target)).unwrap();
                    let doc = f.repo.read(&scene.path).unwrap();
                    let draft = f
                        .recovery
                        .stage(&f.repo, &scene.path, &doc.content_hash, &case.text())
                        .unwrap();
                    let before = files(f.repo.root());
                    assert_eq!(
                        f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
                        Error::PendingRecovery
                    );
                    assert_eq!(
                        f.preview(moving(&scene, &target)).unwrap_err(),
                        Error::PendingRecovery
                    );
                    assert_eq!(files(f.repo.root()), before);
                    assert_eq!(
                        f.recovery.read(&f.repo, &scene.path).unwrap(),
                        Some(draft.clone())
                    );
                    f.recovery.discard(&f.repo, &scene.path, &draft.id).unwrap();
                }
                11 => {
                    f = f.restart();
                    let other = RecoveryStore::open(f.temp.path().join("private")).unwrap();
                    other.read(&f.repo, &scene.path).unwrap();
                    let before = files(f.repo.root());
                    assert_eq!(
                        f.preview(moving(&scene, &target)).unwrap_err(),
                        Error::RecoveryBusy
                    );
                    assert_eq!(files(f.repo.root()), before);
                    drop(other);
                    f.recovery.read(&f.repo, &scene.path).unwrap();
                }
                12 if model.len() > 1 => {
                    fs::remove_file(f.repo.root().join(&scene.path)).unwrap();
                    contents.remove(&scene.path);
                    assert_eq!(
                        f.repo.load_drafting().unwrap().missing_paths,
                        vec![scene.path.clone()]
                    );
                    f.apply(DraftingChange::Reconcile {});
                    model.remove(index);
                }
                12 => {
                    f.apply(create(&target));
                    capture_new(&f, &mut model, &target);
                    contents.insert(target, (vec![], 0o600));
                }
                13 => {
                    let plan = f.preview(create(&target)).unwrap();
                    let second = format!("ms/fresh-{step}.md");
                    f.apply(create(&second));
                    capture_new(&f, &mut model, &second);
                    contents.insert(second, (vec![], 0o600));
                    let before = files(f.repo.root());
                    assert_eq!(
                        f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
                        Error::DraftingChanged
                    );
                    assert_eq!(files(f.repo.root()), before);
                }
                _ => unreachable!(),
            }
            verify(&f, &model, &contents);
        }
    });
}

struct FailureGuard;
impl Drop for FailureGuard {
    fn drop(&mut self) {
        FAIL_AFTER_EDIT.with(|s| s.set(None));
    }
}
fn transfer_batch(f: &Fixture, case: &mut Case, round: usize) -> DraftingPlan {
    let count = 1 + case.pick(4);
    let paths: Vec<_> = (0..count)
        .map(|n| {
            let path = format!("draft/round-{round}-{n}.md");
            f.put(&path, &case.text(), [0o600, 0o640, 0o644][case.pick(3)]);
            path
        })
        .collect();
    f.preview(DraftingChange::ImportRepository {
        paths,
        destination: format!("ms/round-{round}"),
        mode: if case.pick(2) == 0 { "move" } else { "copy" }.into(),
        group_id: None,
        before_id: None,
    })
    .unwrap()
}
#[test]
fn seeded_transaction_failure_and_restart_state_machine() {
    campaign("transaction-recovery", |case| {
        let mut f = Fixture::new();
        f.initialize();
        // Each round covers a randomly sized batch and all of its mutation boundaries.
        // Bound this more expensive family independently of the action count.
        for round in 0..case.steps.div_ceil(8) {
            let plan = transfer_batch(&f, case, round);
            let before = files(f.repo.root());
            for cut in 1..=plan.edits.len() {
                case.record(
                    "failed-io-rollback",
                    format!("round={round} cut={cut}/{}", plan.edits.len()),
                );
                let _reset = FailureGuard;
                FAIL_AFTER_EDIT.with(|s| s.set(Some(cut)));
                assert_eq!(
                    f.repo.apply_drafting(&plan, &f.recovery).unwrap_err(),
                    Error::Io
                );
                assert_eq!(files(f.repo.root()), before);
                assert!(!f.repo.load_drafting().unwrap().recovery_required);
                assert_clean_private_transaction(&f);
            }
            // Simulate a crash after a durably published journal and a chosen prefix.
            // Existing SIGKILL tests separately verify actual process-death handling.
            let cut = case.pick(plan.edits.len() + 1);
            case.record(
                "interrupted-reopen-rollback",
                format!("round={round} cut={cut}/{}", plan.edits.len()),
            );
            let journal = Journal {
                schema_version: 1,
                repository_key: f.repo.project_key(),
                id: plan.preview.id.clone(),
                edits: plan.edits.clone(),
            };
            f.recovery
                .with_clean_paths(&f.repo, &plan.recovery_paths, || {
                    f.repo.write_journal(&journal, &f.recovery)
                })
                .unwrap();
            for edit in plan.edits.iter().take(cut) {
                f.repo.write_transition(edit).unwrap();
            }
            f = f.restart();
            assert!(f.repo.load_drafting().unwrap().recovery_required);
            let rollback = f.preview(DraftingChange::RecoverInterrupted {}).unwrap();
            let undo = f.repo.apply_drafting(&rollback, &f.recovery).unwrap();
            assert!(!undo.is_available());
            assert_eq!(files(f.repo.root()), before);
            assert!(!f.repo.load_drafting().unwrap().recovery_required);
            assert_clean_private_transaction(&f);
            // The recovered state remains usable; commit then undo a fresh preview.
            let paths: Vec<_> = journal
                .edits
                .iter()
                .filter_map(|e| {
                    if e.path.starts_with("draft/") {
                        Some(e.path.clone())
                    } else {
                        None
                    }
                })
                .collect();
            if !paths.is_empty() {
                case.record("post-recovery-commit-undo", round);
                let undo = f.apply(DraftingChange::ImportRepository {
                    paths,
                    destination: format!("ms/retry-{round}"),
                    mode: "move".into(),
                    group_id: None,
                    before_id: None,
                });
                assert_clean_private_transaction(&f);
                f.repo.undo_drafting(&undo, &f.recovery).unwrap();
                assert_eq!(files(f.repo.root()), before);
                assert_clean_private_transaction(&f);
            }
        }
    });
}
