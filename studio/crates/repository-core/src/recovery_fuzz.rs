use super::*;
use crate::fuzz_support::campaign;
use std::{fs, os::unix::fs::PermissionsExt};

fn stage_exact(
    store: &RecoveryStore,
    repo: &Repository,
    path: &str,
    hash: &str,
    text: &str,
) -> RecoveryDraft {
    let draft = store.stage(repo, path, hash, text).unwrap();
    assert_eq!(draft.path, path);
    assert_eq!(draft.base_hash, hash);
    assert_eq!(draft.text.as_bytes(), text.as_bytes());
    assert_eq!(draft.actor, "author");
    assert_eq!(draft.client, "studio");
    assert!(uuid::Uuid::parse_str(&draft.id).is_ok());
    draft
}

#[test]
fn seeded_saves_and_recovery_state_machine() {
    campaign("saves-recovery", |case| {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = temp.path().join("repo");
        let private = temp.path().join("private");
        fs::create_dir(&root).unwrap();
        let paths = ["scene.md", "épisode.markdown", "東京.md"];
        let mut texts: Vec<_> = paths.iter().map(|_| case.text()).collect();
        for (path, text) in paths.iter().zip(&texts) {
            fs::write(root.join(path), text).unwrap();
            fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o640)).unwrap();
        }
        let mut repo = Repository::open(&root).unwrap();
        let mut store = RecoveryStore::open(&private).unwrap();
        let mut drafts: Vec<Option<RecoveryDraft>> = vec![None; paths.len()];
        for step in 0..case.steps {
            let index = case.pick(paths.len());
            let path = paths[index];
            let hash = crate::content_hash(&texts[index]);
            let next = case.text();
            let operation = if step < 15 { step } else { case.pick(15) };
            case.record(
                [
                    "stage-save-clear",
                    "stage",
                    "external-stale-save",
                    "noop",
                    "stale-discard",
                    "readonly-save",
                    "failed-save-io",
                    "failed-stage-io",
                    "ownership-busy",
                    "restart-unobserved",
                    "missing-source",
                    "staging-external-edit",
                    "same-bytes-inode-swap",
                    "invalid-input",
                    "clean-recovery-save",
                ][operation],
                path,
            );
            match operation {
                0 => {
                    let draft = stage_exact(&store, &repo, path, &hash, &next);
                    let saved = repo.save_with_recovery(path, &hash, &next, &store).unwrap();
                    assert_eq!(saved.text, next);
                    assert_eq!(store.read(&repo, path).unwrap(), Some(draft.clone()));
                    store.discard(&repo, path, &draft.id).unwrap();
                    texts[index] = next;
                    drafts[index] = None;
                }
                1 => drafts[index] = Some(stage_exact(&store, &repo, path, &hash, &next)),
                2 => {
                    fs::write(root.join(path), &next).unwrap();
                    // Protect buffered text even when its saved base is stale.
                    drafts[index] = Some(stage_exact(&store, &repo, path, &hash, &texts[index]));
                    for attempt in [&texts[index], &next] {
                        assert_eq!(
                            repo.save_with_recovery(path, &hash, attempt, &store)
                                .unwrap_err(),
                            Error::Conflict
                        );
                    }
                    texts[index] = next;
                }
                3 => {
                    let before = fs::metadata(root.join(path)).unwrap();
                    let saved = repo
                        .save_with_recovery(path, &hash, &texts[index], &store)
                        .unwrap();
                    let after = fs::metadata(root.join(path)).unwrap();
                    assert_eq!(saved.content_hash, hash);
                    assert_eq!(
                        (before.ino(), before.modified().unwrap()),
                        (after.ino(), after.modified().unwrap())
                    );
                }
                4 => {
                    let first = stage_exact(&store, &repo, path, &hash, &next);
                    let second = stage_exact(&store, &repo, path, &hash, &case.text());
                    assert_ne!(first.id, second.id);
                    assert_eq!(
                        store.discard(&repo, path, &first.id).unwrap_err(),
                        Error::RecoveryChanged
                    );
                    drafts[index] = Some(second);
                }
                5 => {
                    drafts[index] = Some(stage_exact(&store, &repo, path, &hash, &next));
                    fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o440))
                        .unwrap();
                    assert_eq!(
                        repo.save_with_recovery(path, &hash, &next, &store)
                            .unwrap_err(),
                        Error::Denied
                    );
                    fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o640))
                        .unwrap();
                }
                6 => {
                    let error = if case.pick(2) == 0 {
                        Error::Io
                    } else {
                        Error::EditorChanged
                    };
                    assert_eq!(
                        repo.save_inner(path, &hash, &next, || Err(error))
                            .unwrap_err(),
                        error
                    );
                }
                7 => {
                    assert_eq!(
                        store
                            .stage_inner(&repo, path, &hash, &next, || Err(Error::RecoveryIo))
                            .unwrap_err(),
                        Error::RecoveryIo
                    );
                }
                8 => {
                    store.read(&repo, path).unwrap();
                    let contender = RecoveryStore::open(&private).unwrap();
                    assert_eq!(
                        contender.read(&repo, path).unwrap_err(),
                        Error::RecoveryBusy
                    );
                    assert_eq!(
                        contender.stage(&repo, path, &hash, &next).unwrap_err(),
                        Error::RecoveryBusy
                    );
                    assert_eq!(
                        repo.save_with_recovery(path, &hash, &next, &contender)
                            .unwrap_err(),
                        Error::RecoveryBusy
                    );
                    if let Some(draft) = &drafts[index] {
                        assert_eq!(
                            contender.discard(&repo, path, &draft.id).unwrap_err(),
                            Error::RecoveryBusy
                        );
                    }
                }
                9 => {
                    // Ensure this transition exercises persisted, previously unseen recovery.
                    drafts[index] = Some(stage_exact(&store, &repo, path, &hash, &next));
                    let key = repo.project_key();
                    drop(store);
                    drop(repo);
                    repo = Repository::open(&root).unwrap();
                    store = RecoveryStore::open(&private).unwrap();
                    assert_eq!(repo.project_key(), key);
                    for _ in 0..2 {
                        assert_eq!(
                            store.stage(&repo, path, &hash, "stale retry").unwrap_err(),
                            Error::RecoveryChanged
                        );
                    }
                    assert_eq!(
                        store
                            .discard(&repo, path, &drafts[index].as_ref().unwrap().id)
                            .unwrap_err(),
                        Error::RecoveryChanged
                    );
                }
                10 => {
                    drafts[index] = Some(stage_exact(&store, &repo, path, &hash, &next));
                    fs::remove_file(root.join(path)).unwrap();
                    assert_eq!(store.read(&repo, path).unwrap(), drafts[index]);
                    assert_eq!(
                        store.stage(&repo, path, &hash, "cannot stage").unwrap_err(),
                        Error::NotFound
                    );
                    if case.pick(2) == 0 {
                        store
                            .discard(&repo, path, &drafts[index].as_ref().unwrap().id)
                            .unwrap();
                        drafts[index] = None;
                    }
                    fs::write(root.join(path), &texts[index]).unwrap();
                    fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o640))
                        .unwrap();
                }
                11 => {
                    let external = case.text();
                    assert_eq!(
                        repo.save_inner(path, &hash, &next, || {
                            fs::write(root.join(path), &external).unwrap();
                            Ok(())
                        })
                        .unwrap_err(),
                        Error::Conflict
                    );
                    texts[index] = external;
                }
                12 => {
                    assert_eq!(
                        repo.save_inner(path, &hash, &next, || {
                            fs::write(root.join("replacement"), &texts[index]).unwrap();
                            fs::set_permissions(
                                root.join("replacement"),
                                fs::Permissions::from_mode(0o640),
                            )
                            .unwrap();
                            fs::rename(root.join("replacement"), root.join(path)).unwrap();
                            Ok(())
                        })
                        .unwrap_err(),
                        Error::Conflict
                    );
                }
                13 => {
                    let invalid = [
                        "../scene.md",
                        "/scene.md",
                        "ms//scene.md",
                        "scene.md/..",
                        "x\\scene.md",
                        ".private.md",
                    ];
                    let invalid = invalid[case.pick(invalid.len())];
                    assert!(repo.save(invalid, &hash, &next).is_err());
                    assert!(store.stage(&repo, invalid, &hash, &next).is_err());
                    assert_eq!(
                        repo.save(path, &hash, "binary\0").unwrap_err(),
                        Error::UnsupportedText
                    );
                    assert_eq!(
                        store.stage(&repo, path, "invalid hash", &next).unwrap_err(),
                        Error::InvalidRecovery
                    );
                }
                14 => {
                    let result = repo.save_with_clean_recovery(path, &hash, &next, &store);
                    if drafts[index].is_some() {
                        assert_eq!(result.unwrap_err(), Error::PendingRecovery);
                    } else {
                        result.unwrap();
                        texts[index] = next;
                    }
                }
                _ => unreachable!(),
            }
            for (i, path) in paths.iter().enumerate() {
                let doc = repo.read(path).unwrap();
                assert_eq!(doc.text, texts[i]);
                assert_eq!(doc.size_bytes as usize, texts[i].len());
                assert_eq!(doc.content_hash, crate::content_hash(&texts[i]));
                assert_eq!(fs::read(root.join(path)).unwrap(), texts[i].as_bytes());
                assert_eq!(fs::metadata(root.join(path)).unwrap().mode() & 0o777, 0o640);
                assert_eq!(store.read(&repo, path).unwrap(), drafts[i]);
            }
            assert_eq!(fs::read_dir(&root).unwrap().count(), paths.len());
            for entry in fs::read_dir(&private).unwrap() {
                let entry = entry.unwrap();
                assert!(!entry.file_name().to_string_lossy().ends_with(".tmp"));
                assert_eq!(entry.metadata().unwrap().mode() & 0o777, 0o600);
            }
        }
    });
}
