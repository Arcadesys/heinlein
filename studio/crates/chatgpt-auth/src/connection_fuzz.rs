//! Synthetic callback/catalog/rotation sequences; no real account or endpoint.
use super::*;
fn seeds() -> std::ops::Range<u64> {
    let start = std::env::var("HEINLEIN_FUZZ_START")
        .map(|s| s.parse().unwrap())
        .unwrap_or(1);
    let count = std::env::var("HEINLEIN_FUZZ_SEEDS")
        .map(|s| s.parse::<u64>().unwrap())
        .unwrap_or(16);
    assert!((1..=1024).contains(&count));
    start..start.checked_add(count).unwrap()
}
fn next(state: &mut u64) -> usize {
    *state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (*state >> 32) as usize
}
#[tokio::test]
async fn connection_fuzz_authentication() {
    let mut counts = [0; 8];
    for seed in seeds() {
        let (temp, mut service, fake) = connected().await;
        let identity = service.load().unwrap().host_id;
        let mut rng = seed;
        for step in 0..64 {
            let kind = next(&mut rng) % counts.len();
            counts[kind] += 1;
            let before = fake.requests.lock().unwrap().len();
            match kind {
                0 => {
                    let mut attempt = oauth::Attempt::new(14000, CLIENT.into());
                    // Fix synthetic state so the corpus is fully replayable.
                    attempt.state = format!("state-{seed}-{step}");
                    let query = format!(
                        "state={}&code=synthetic-code&client_id={CLIENT}",
                        attempt.state
                    );
                    let valid = request(&attempt, &query);
                    assert!(attempt.parse_callback(&valid).is_ok());
                    let invalid = match next(&mut rng) % 5 {
                        0 => request(&attempt, &format!("{query}&code=duplicate")),
                        1 => request(&attempt, "state=wrong&code=synthetic-code"),
                        2 => String::from_utf8(valid)
                            .unwrap()
                            .replace("GET ", "POST ")
                            .into_bytes(),
                        3 => String::from_utf8(valid)
                            .unwrap()
                            .replace("127.0.0.1", "attacker.invalid")
                            .into_bytes(),
                        _ => vec![255; 1 + next(&mut rng) % 4096],
                    };
                    assert!(
                        attempt.parse_callback(&invalid).is_err(),
                        "seed={seed} step={step}"
                    );
                    assert_eq!(before, fake.requests.lock().unwrap().len());
                }
                1 => {
                    fake.catalog();
                    service.refresh_models().await.unwrap();
                    service.select_model("synthetic-model").unwrap();
                    assert_eq!(before + 1, fake.requests.lock().unwrap().len());
                }
                2 => {
                    fake.push(
                        200,
                        match next(&mut rng) % 3 {
                            0 => json!({"models":null}),
                            1 => json!({"models":[{"slug":42}]}),
                            _ => json!({"models":"synthetic-secret"}),
                        },
                    );
                    let error = service.refresh_models().await.err().unwrap();
                    assert!(!error.to_string().contains("synthetic-secret"));
                    assert!(service.status().unwrap().models.is_empty());
                    fake.catalog();
                    service.refresh_models().await.unwrap();
                    service.select_model("synthetic-model").unwrap();
                    assert_eq!(before + 2, fake.requests.lock().unwrap().len());
                }
                3 | 4 => {
                    expire_soon(&service);
                    let generation = service.status().unwrap().generation;
                    if kind == 4 {
                        let weak = Arc::downgrade(&service);
                        *fake.on_request.lock().unwrap() = Some(Box::new(move |req| {
                            if req.url == http::TOKEN {
                                weak.upgrade().unwrap().cancel();
                            }
                        }));
                    }
                    fake.keys();
                    let access = format!("synthetic-access-{seed}-{step}");
                    let refresh = format!("synthetic-refresh-{seed}-{step}");
                    fake.push(200,json!({"access_token":access,"refresh_token":refresh,"token_type":"Bearer","expires_in":3600}));
                    let result = service.credentials(generation).await;
                    if kind == 4 {
                        assert!(matches!(result, Err(AuthError::Cancelled)));
                    } else {
                        assert_eq!(result.unwrap().access_token, access);
                    }
                    *fake.on_request.lock().unwrap() = None;
                    let saved = service.load().unwrap();
                    let account = saved.account(CLIENT).unwrap();
                    assert!(!account.refresh_pending);
                    assert_eq!(
                        account.tokens.as_ref().unwrap().refresh_token.as_deref(),
                        Some(refresh.as_str())
                    );
                    assert_eq!(before + 2, fake.requests.lock().unwrap().len());
                    if kind == 4 {
                        fake.catalog();
                        service.refresh_models().await.unwrap();
                    }
                }
                5 => {
                    expire_soon(&service);
                    fake.replies
                        .lock()
                        .unwrap()
                        .push_back(Err(AuthError::Network));
                    let old = service
                        .load()
                        .unwrap()
                        .account(CLIENT)
                        .unwrap()
                        .tokens
                        .as_ref()
                        .unwrap()
                        .refresh_token
                        .clone();
                    assert!(matches!(
                        service
                            .credentials(service.status().unwrap().generation)
                            .await,
                        Err(AuthError::Network)
                    ));
                    assert_eq!(before + 1, fake.requests.lock().unwrap().len());
                    assert_eq!(
                        service
                            .load()
                            .unwrap()
                            .account(CLIENT)
                            .unwrap()
                            .tokens
                            .as_ref()
                            .unwrap()
                            .refresh_token,
                        old
                    );
                    // Restore only test fixture expiry after a pre-rotation JWKS failure.
                    let mut db = service.load().unwrap();
                    db.account_mut(CLIENT)
                        .unwrap()
                        .tokens
                        .as_mut()
                        .unwrap()
                        .expires_at = now().unwrap() + 3600;
                    service.store.save(&db).unwrap();
                    service.runtime().unwrap().db = db;
                }
                6 => {
                    service = Arc::new(
                        AuthService::with_transport(temp.path().join("auth"), fake.clone())
                            .unwrap(),
                    );
                    assert_eq!(before, fake.requests.lock().unwrap().len());
                    assert_eq!(
                        service.status().unwrap().selected_model.as_deref(),
                        Some("synthetic-model")
                    );
                    fake.catalog();
                    service.refresh_models().await.unwrap();
                }
                _ => {
                    assert!(service.select_model("synthetic-unknown").is_err());
                    assert!(matches!(
                        service.credentials(u64::MAX).await,
                        Err(AuthError::Cancelled)
                    ));
                    assert_eq!(before, fake.requests.lock().unwrap().len());
                }
            }
            assert_eq!(
                service.load().unwrap().host_id,
                identity,
                "seed={seed} step={step}"
            );
            assert_eq!(service.status().unwrap().accounts.len(), 1);
            assert!(fake.replies.lock().unwrap().is_empty());
            let status = serde_json::to_string(&service.status().unwrap()).unwrap();
            assert!(!status.contains("synthetic-access"));
            assert!(!status.contains("synthetic-refresh"));
        }
    }
    eprintln!("authentication operation counts: {counts:?}");
}
