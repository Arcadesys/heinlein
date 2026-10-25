mod support;
use github_workspace::{auth::Auth, registry::StateDir, Error, StoreFailure};
use std::sync::{atomic::Ordering, Arc};
use support::*;
#[test]
fn missing_configuration_never_starts_fake_auth() {
    let f = Fixture::new();
    let auth = Auth::new(
        String::new(),
        Arc::new(MemorySecrets::default()),
        StateDir::open(&f.root.join("auth")).unwrap(),
    )
    .unwrap();
    let api = MockApi::default();
    assert!(!auth.view().unwrap().configured);
    assert!(matches!(auth.begin(&api, 1000), Err(Error::Unavailable)));
    assert_eq!(api.polls.load(Ordering::SeqCst), 0);
}
#[test]
fn polling_account_confirmation_and_signout_are_explicit() {
    let f = Fixture::new();
    let api = MockApi::default();
    let store = Arc::new(MemorySecrets::default());
    let auth = Auth::new(
        "public-client".into(),
        store,
        StateDir::open(&f.root.join("auth")).unwrap(),
    )
    .unwrap();
    auth.begin(&api, 1000).unwrap();
    assert!(matches!(auth.poll(&api, 1001), Err(Error::RateLimit)));
    let view = auth.poll(&api, 1005).unwrap();
    assert!(!view.confirmed);
    assert!(matches!(auth.credential(&api, 1006), Err(Error::Account)));
    assert!(auth.confirm(10).is_err());
    auth.confirm(9).unwrap();
    let credential = auth.credential(&api, 1006).unwrap();
    let json = serde_json::to_string(&auth.view().unwrap()).unwrap();
    assert!(!json.contains("secret"));
    auth.sign_out().unwrap();
    assert!(!credential.valid());
    assert!(auth.credential(&api, 1007).is_err());
}
#[test]
fn refresh_is_durable_and_account_never_falls_back() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, store) = connected(&f.root, &api);
    let old = auth.credential(&api, 1006).unwrap();
    let new = auth.credential(&api, 4590).unwrap();
    assert_eq!(old.binding, new.binding);
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 1);
    assert!(
        String::from_utf8(store.bytes.lock().unwrap().clone().unwrap())
            .unwrap()
            .contains("rotated-secret")
    );
    api.user_id.store(10, Ordering::SeqCst);
    assert!(matches!(auth.credential(&api, 8180), Err(Error::Account)));
}
#[test]
fn unavailable_secure_store_never_falls_back_to_a_file() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, store) = connected(&f.root, &api);
    store.fail.store(true, Ordering::SeqCst);
    assert!(auth.credential(&api, 4590).is_err());
    let state = std::fs::read_dir(f.root.join("auth"))
        .unwrap()
        .map(|p| p.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(state, vec!["auth.lock"]);
}
#[test]
fn confirmed_and_unconfirmed_records_reopen_without_oauth_or_new_storage() {
    for confirmed in [false, true] {
        let f = Fixture::new();
        let api = MockApi::default();
        let store = Arc::new(MemorySecrets::default());
        let auth = Auth::new(
            "public-client".into(),
            store.clone(),
            StateDir::open(&f.root.join("auth")).unwrap(),
        )
        .unwrap();
        auth.begin(&api, 1000).unwrap();
        auth.poll(&api, 1005).unwrap();
        if confirmed {
            auth.confirm(9).unwrap();
        }
        drop(auth);
        let before = store.writes.load(Ordering::SeqCst);
        let reopened = Auth::new(
            "public-client".into(),
            store.clone(),
            StateDir::open(&f.root.join("auth")).unwrap(),
        )
        .unwrap();
        let view = reopened.retry_saved().unwrap();
        assert_eq!(view.confirmed, confirmed);
        assert_eq!(view.account.unwrap().id, 9);
        assert_eq!(api.polls.load(Ordering::SeqCst), 1);
        assert_eq!(store.writes.load(Ordering::SeqCst), before);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn every_store_read_failure_retains_bytes_and_never_starts_replacement() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, store) = connected(&f.root, &api);
    let original = store.bytes.lock().unwrap().clone();
    let writes = store.writes.load(Ordering::SeqCst);
    for error in [
        Error::StoreLocked,
        Error::StoreDenied,
        Error::StoreCancelled,
        Error::StoreUnavailable,
        Error::StoreInvalid,
    ] {
        *store.read_error.lock().unwrap() = Some(error);
        assert!(matches!(auth.view(),Err(e)if e==error));
        assert!(matches!(auth.retry_saved(),Err(e)if e==error));
        assert!(matches!(auth.begin(&api,1100),Err(e)if e==error));
        assert!(matches!(auth.credential(&api,4590),Err(e)if e==error));
        assert_eq!(*store.bytes.lock().unwrap(), original);
        assert_eq!(store.writes.load(Ordering::SeqCst), writes);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    }
    *store.read_error.lock().unwrap() = None;
    assert!(auth.retry_saved().unwrap().confirmed);
}
#[test]
fn failed_rotation_can_retry_store_write_without_another_refresh_or_oauth() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, store) = connected(&f.root, &api);
    let old = store.bytes.lock().unwrap().clone();
    assert!(auth.ready_to_quit().is_ok());
    *store.write_error.lock().unwrap() = Some(Error::StoreDenied);
    assert!(matches!(
        auth.credential(&api, 4590),
        Err(Error::RotationNotSaved(_))
    ));
    assert!(matches!(
        auth.ready_to_quit(),
        Err(Error::RotationNotSaved(_))
    ));
    assert_eq!(*store.bytes.lock().unwrap(), old);
    assert!(matches!(auth.view(), Err(Error::RotationNotSaved(_))));
    assert!(matches!(
        auth.begin(&api, 4600),
        Err(Error::RotationNotSaved(_))
    ));
    *store.write_error.lock().unwrap() = None;
    assert!(auth.retry_saved().unwrap().confirmed);
    assert!(auth.ready_to_quit().is_ok());
    auth.credential(&api, 4600).unwrap();
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(api.polls.load(Ordering::SeqCst), 1);
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
}
#[test]
fn network_and_expired_or_revoked_refresh_are_distinct_without_store_reset() {
    for error in [Error::Network, Error::Reconnect] {
        let f = Fixture::new();
        let api = MockApi::default();
        let (auth, store) = connected(&f.root, &api);
        let before = store.bytes.lock().unwrap().clone();
        let writes = store.writes.load(Ordering::SeqCst);
        *api.refresh_error.lock().unwrap() = Some(error);
        assert!(matches!(auth.credential(&api,4590),Err(e)if e==error));
        assert!(auth.view().unwrap().confirmed);
        assert_eq!(*store.bytes.lock().unwrap(), before);
        assert_eq!(store.writes.load(Ordering::SeqCst), writes);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    }
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, store) = connected(&f.root, &api);
    assert!(matches!(
        auth.credential(&api, 200_000),
        Err(Error::Reconnect)
    ));
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 0);
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
}

#[test]
fn rotation_retains_each_sanitized_write_cause_across_queries_and_retry() {
    let cases = [
        (Error::StoreLocked, StoreFailure::Locked, "store is locked"),
        (Error::StoreDenied, StoreFailure::Denied, "was denied"),
        (
            Error::StoreCancelled,
            StoreFailure::Cancelled,
            "was cancelled",
        ),
        (
            Error::StoreUnavailable,
            StoreFailure::Unavailable,
            "store is unavailable",
        ),
        (
            Error::StoreInvalid,
            StoreFailure::Invalid,
            "could not be handled safely",
        ),
        (
            Error::Network,
            StoreFailure::Unknown,
            "unknown secure-store failure",
        ),
    ];
    for (initial, expected, initial_text) in cases {
        let f = Fixture::new();
        let api = MockApi::default();
        let (auth, store) = connected(&f.root, &api);
        let old = store.bytes.lock().unwrap().clone();
        *store.write_error.lock().unwrap() = Some(initial);
        let failure = auth.credential(&api, 4590).err().unwrap();
        let renewed_bytes = store.attempted_write.lock().unwrap().clone();
        assert_eq!(failure, Error::RotationNotSaved(expected));
        assert!(failure.to_string().contains(initial_text), "{failure}");
        for (cause, expected, text) in cases {
            *store.write_error.lock().unwrap() = Some(cause);
            let failure = auth.retry_saved().err().unwrap();
            assert_eq!(failure, Error::RotationNotSaved(expected));
            assert!(failure.to_string().contains(text), "{failure}");
            assert!(failure.to_string().contains("Keep Heinlein open"));
            assert!(failure
                .to_string()
                .contains("Retry saved GitHub connection"));
            let reads = store.reads.load(Ordering::SeqCst);
            *store.read_error.lock().unwrap() = Some(Error::StoreInvalid);
            assert_eq!(auth.ready_to_quit().err(), Some(failure));
            assert_eq!(auth.view().err(), Some(failure));
            assert_eq!(auth.credential(&api, 4600).err(), Some(failure));
            assert_eq!(auth.begin(&api, 4600).err(), Some(failure));
            assert_eq!(store.reads.load(Ordering::SeqCst), reads);
            *store.read_error.lock().unwrap() = None;
            assert_eq!(*store.bytes.lock().unwrap(), old);
        }
        *store.write_error.lock().unwrap() = None;
        assert!(auth.retry_saved().unwrap().confirmed);
        assert!(auth.ready_to_quit().is_ok());
        assert!(auth.credential(&api, 4600).is_ok());
        assert!(
            *store.bytes.lock().unwrap() == renewed_bytes,
            "retry must persist the exact initially attempted renewed record"
        );
        let saved = store.bytes.lock().unwrap().clone().unwrap();
        let record: serde_json::Value = serde_json::from_slice(&saved).unwrap();
        assert_eq!(record["access_token"], "rotated-secret");
        assert_eq!(api.refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(api.polls.load(Ordering::SeqCst), 1);
        assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn retry_load_and_account_failures_preserve_pending_record_and_last_write_cause() {
    let f = Fixture::new();
    let api = MockApi::default();
    let (auth, store) = connected(&f.root, &api);
    let old = store.bytes.lock().unwrap().clone();
    *store.write_error.lock().unwrap() = Some(Error::StoreCancelled);
    let pending = auth.credential(&api, 4590).err().unwrap();
    let writes = store.writes.load(Ordering::SeqCst);
    for cause in [
        Error::StoreLocked,
        Error::StoreDenied,
        Error::StoreCancelled,
        Error::StoreUnavailable,
        Error::StoreInvalid,
        Error::Network,
    ] {
        *store.read_error.lock().unwrap() = Some(cause);
        let failure = auth.retry_saved().err().unwrap();
        assert!(failure.to_string().contains("Keep Heinlein open"));
        assert!(failure.to_string().contains("not yet saved"));
        assert_eq!(auth.ready_to_quit().err(), Some(pending));
        assert_eq!(auth.view().err(), Some(pending));
        assert_eq!(store.writes.load(Ordering::SeqCst), writes);
        assert_eq!(*store.bytes.lock().unwrap(), old);
    }
    *store.read_error.lock().unwrap() = None;
    for field in ["user", "binding", "missing", "invalid"] {
        let mut record: serde_json::Value = serde_json::from_slice(old.as_ref().unwrap()).unwrap();
        match field {
            "user" => record["user"]["id"] = 10.into(),
            "binding" => record["binding"] = uuid::Uuid::new_v4().to_string().into(),
            _ => {}
        }
        *store.bytes.lock().unwrap() = match field {
            "missing" => None,
            "invalid" => Some(b"not a credential record".to_vec()),
            _ => Some(serde_json::to_vec(&record).unwrap()),
        };
        let failure = auth.retry_saved().err().unwrap();
        assert!(failure.to_string().contains("not yet saved"));
        assert!(failure.to_string().contains("Keep Heinlein open"));
        assert_eq!(auth.ready_to_quit().err(), Some(pending));
        assert_eq!(store.writes.load(Ordering::SeqCst), writes);
    }
    *store.bytes.lock().unwrap() = old;
    *store.write_error.lock().unwrap() = None;
    assert!(auth.retry_saved().unwrap().confirmed);
    assert!(auth.ready_to_quit().is_ok());
    let saved: serde_json::Value =
        serde_json::from_slice(store.bytes.lock().unwrap().as_ref().unwrap()).unwrap();
    assert_eq!(saved["access_token"], "rotated-secret");
    assert_eq!(api.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(api.polls.load(Ordering::SeqCst), 1);
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
}
