mod support;
use github_workspace::{auth::Auth, registry::StateDir, Error};
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
