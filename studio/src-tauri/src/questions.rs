//! Main-window-only advice, pending revision proposals, and ChatGPT controls.
//! Revisions read only the explicitly bound local source. No manuscript writes.

use drafting_questions::{
    splice_revision, validate_revision_request, validate_revision_selection, Configuration,
    QuestionAnswer, QuestionError, QuestionRequest, QuestionService,
};
use heinlein_chatgpt_auth::{AccountView, AuthError, AuthService, AuthStatus, ModelView};
use serde::{Deserialize, Serialize};
use std::sync::{atomic::Ordering, Arc, Mutex};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

const USAGE_URL: &str = "https://chatgpt.com/settings/usage";

#[derive(Default)]
pub(crate) struct QuestionHost {
    questions: QuestionService,
    review: Mutex<Option<crate::review_state::ReviewSession>>,
    review_active: std::sync::atomic::AtomicBool,
    auth: Mutex<Option<Arc<AuthService>>>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum NativeError {
    Question(QuestionError),
    Auth { code: &'static str, message: String },
}

impl From<QuestionError> for NativeError {
    fn from(error: QuestionError) -> Self {
        Self::Question(error)
    }
}
impl From<AuthError> for NativeError {
    fn from(error: AuthError) -> Self {
        // AuthError's Display and code are deliberately static safe categories.
        Self::Auth {
            code: error.code(),
            message: error.to_string(),
        }
    }
}
impl NativeError {
    fn revision(message: impl Into<String>) -> Self {
        Self::Auth {
            code: "revisionUnavailable",
            message: message.into(),
        }
    }
    fn unavailable() -> Self {
        Self::Auth {
            code: "unavailable",
            message:
                "ChatGPT account controls are unavailable. The manuscript editor remains usable."
                    .into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuestionStatus {
    configured: bool,
    model: Option<String>,
    message: String,
    accounts: Vec<AccountView>,
    active_account_id: Option<String>,
    models: Vec<ModelView>,
    selected_model: Option<String>,
    sign_in_pending: bool,
    generation: u64,
    usage_limited: bool,
}

/// The visible native connection snapshot at the author's explicit Send.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuestionConnection {
    generation: u64,
    account_id: String,
    model: String,
}

/// Local bindings are never included in the provider payload. The selected text
/// alone is sent as the exact separately previewed revision target.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RevisionTarget {
    repository_id: String,
    path: String,
    source_hash: String,
    from_utf8: usize,
    to_utf8: usize,
    selected_text: String,
}

struct RevisionSnapshot {
    target: RevisionTarget,
    source: String,
    generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionAnswer {
    #[serde(flatten)]
    answer: QuestionAnswer,
    proposal_id: String,
    replacement_text: String,
}

fn validate_target(target: &RevisionTarget) -> Result<(), QuestionError> {
    if target.repository_id.is_empty()
        || target.repository_id.len() > 128
        || target.path.is_empty()
        || target.path.len() > 4096
        || target.path.contains(['\\', ':'])
        || target.path.split('/').count() > 32
        || target.path.split('/').any(|part| {
            part.is_empty() || part.starts_with('.') || part.chars().any(char::is_control)
        })
        || !matches!(
            std::path::Path::new(&target.path)
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("md" | "markdown")
        )
        || target.source_hash.len() != 64
        || !target
            .source_hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || target.from_utf8 >= target.to_utf8
        || target.selected_text.is_empty()
        || target.selected_text.len() > drafting_questions::MAX_CONTEXT_BYTES
    {
        return Err(QuestionError::invalid_revision());
    }
    Ok(())
}

fn clean_generation(state: &super::BrowserState, generation: u64) -> bool {
    !state.unsaved_changes.load(Ordering::SeqCst) && state.mutation_gate.generation() == generation
}

fn same_revision_source(snapshot: &RevisionSnapshot, current: &repository_core::Document) -> bool {
    !current.generated_compatibility
        && current.path == snapshot.target.path
        && current.content_hash == snapshot.target.source_hash
        && current.text == snapshot.source
}

fn selected_revision_session(state: &super::BrowserState, repository_id: &str) -> bool {
    state.selected.lock().is_ok_and(|selected| {
        selected
            .as_ref()
            .is_some_and(|selected| selected.id == repository_id)
    })
}

fn capture_revision(
    app: &tauri::AppHandle,
    target: RevisionTarget,
) -> Result<RevisionSnapshot, NativeError> {
    validate_target(&target)?;
    let state = app.state::<super::BrowserState>();
    let _selection = state
        .selection_gate
        .try_lock()
        .map_err(|_| QuestionError::stale_revision())?;
    let _mutation = state
        .mutation_gate
        .author_operation()
        .map_err(NativeError::revision)?;
    let generation = state.mutation_gate.generation();
    if !clean_generation(&state, generation) {
        return Err(QuestionError::stale_revision().into());
    }
    let recovery = super::recovery_store(app).map_err(NativeError::revision)?;
    let source = super::with_repository(app, &target.repository_id, |repo| {
        recovery
            .with_clean_paths(repo, std::slice::from_ref(&target.path), || {
                repo.read(&target.path)
            })
            .map_err(|error| error.to_string())
    })
    .map_err(NativeError::revision)?;
    if source.generated_compatibility
        || source.content_hash != target.source_hash
        || !clean_generation(&state, generation)
    {
        return Err(QuestionError::stale_revision().into());
    }
    validate_revision_selection(
        &source.text,
        target.from_utf8,
        target.to_utf8,
        &target.selected_text,
    )?;
    Ok(RevisionSnapshot {
        target,
        source: source.text,
        generation,
    })
}

fn persist_revision(
    app: &tauri::AppHandle,
    auth: &AuthService,
    connection: &QuestionConnection,
    snapshot: &RevisionSnapshot,
    answer: &QuestionAnswer,
    replacement: &str,
) -> Result<String, NativeError> {
    let state = app.state::<super::BrowserState>();
    let _selection = state
        .selection_gate
        .try_lock()
        .map_err(|_| QuestionError::stale_revision())?;
    let _mutation = state
        .mutation_gate
        .author_operation()
        .map_err(NativeError::revision)?;
    if !clean_generation(&state, snapshot.generation) || !auth.is_current(connection.generation) {
        return Err(QuestionError::stale_revision().into());
    }
    let target = &snapshot.target;
    let next = splice_revision(
        &snapshot.source,
        target.from_utf8,
        target.to_utf8,
        &target.selected_text,
        replacement,
    )?;
    if next.len() as u64 > repository_core::MAX_FILE_BYTES {
        return Err(QuestionError::invalid_revision().into());
    }
    let (store, _) = super::proposals::stores(app).map_err(NativeError::revision)?;
    let recovery = super::recovery_store(app).map_err(NativeError::revision)?;
    super::with_repository(app, &target.repository_id, |repo| {
        recovery
            .with_clean_paths(repo, std::slice::from_ref(&target.path), || {
                let current = repo.read(&target.path)?;
                if !same_revision_source(snapshot, &current) {
                    return Ok(Err(QuestionError::stale_revision().to_string()));
                }
                Ok(store
                    .submit_checked(
                        repo,
                        &target.path,
                        &target.source_hash,
                        &next,
                        proposal_store::ProposalOrigin::native_openai(
                            answer.model.clone(),
                            answer.request_id.clone(),
                        ),
                        || {
                            if !clean_generation(&state, snapshot.generation)
                                || !auth.is_current(connection.generation)
                            {
                                return Err(proposal_store::Error::Conflict);
                            }
                            Ok(())
                        },
                    )
                    .map(|proposal| proposal.id)
                    .map_err(|error| error.to_string()))
            })
            .map_err(|error| error.to_string())?
    })
    .map_err(NativeError::revision)
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), NativeError> {
    if window.label() != "main" {
        return Err(QuestionError::unsupported_window().into());
    }
    Ok(())
}

impl QuestionHost {
    fn auth(&self, app: &tauri::AppHandle) -> Result<Arc<AuthService>, NativeError> {
        let mut slot = self.auth.lock().map_err(|_| NativeError::unavailable())?;
        if let Some(service) = slot.as_ref() {
            return Ok(service.clone());
        }
        let path =
            super::private_question_auth_path(app).map_err(|_| NativeError::unavailable())?;
        let service = Arc::new(AuthService::open(path)?);
        *slot = Some(service.clone());
        Ok(service)
    }

    fn status(&self, auth: AuthStatus) -> Result<QuestionStatus, NativeError> {
        let usage_limited = match auth.active_account_id.as_deref() {
            Some(id) => self.questions.is_usage_limited(id)?,
            None => false,
        };
        let active = auth
            .accounts
            .iter()
            .find(|account| Some(&account.id) == auth.active_account_id.as_ref());
        let model_valid = auth
            .selected_model
            .as_ref()
            .is_some_and(|slug| auth.models.iter().any(|model| &model.slug == slug));
        let configured = !auth.sign_in_pending
            && !usage_limited
            && model_valid
            && active.is_some_and(|account| account.signed_in && account.plan_enabled);
        let message = if usage_limited {
            QuestionError::usage_limited().message.to_owned()
        } else if let Some(message) = auth.message {
            message
        } else if auth.sign_in_pending {
            "Finish Continue with ChatGPT in your system browser, or cancel sign-in.".into()
        } else if configured {
            "Connected to ChatGPT. Send uses the selected account's plan and model; no API-key fallback is used.".into()
        } else if active.is_some_and(|account| account.signed_in && !account.plan_enabled) {
            "Signed in, but ChatGPT plan usage was not granted. Enable it with Continue with ChatGPT before sending.".into()
        } else if active.is_some_and(|account| account.signed_in) {
            "Choose an available ChatGPT model before sending. Recheck the connection if the model list is empty.".into()
        } else {
            "Continue with ChatGPT to connect your account and choose a model.".into()
        };
        Ok(QuestionStatus {
            configured,
            model: auth.selected_model.clone(),
            message,
            accounts: auth.accounts,
            active_account_id: auth.active_account_id,
            models: auth.models,
            selected_model: auth.selected_model,
            sign_in_pending: auth.sign_in_pending,
            generation: auth.generation,
            usage_limited,
        })
    }
}

fn matches_connection(status: &AuthStatus, connection: &QuestionConnection) -> bool {
    !status.sign_in_pending
        && status.generation == connection.generation
        && status.active_account_id.as_deref() == Some(connection.account_id.as_str())
        && status.selected_model.as_deref() == Some(connection.model.as_str())
        && status
            .models
            .iter()
            .any(|model| model.slug == connection.model)
        && status.accounts.iter().any(|account| {
            account.id == connection.account_id && account.signed_in && account.plan_enabled
        })
}

fn safe_authorization_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("auth.openai.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
            && url.path() == "/api/accounts/authorize"
            && url.fragment().is_none()
            && url.query().is_some()
    })
}

#[tauri::command]
pub(crate) fn question_status(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
) -> Result<QuestionStatus, NativeError> {
    main_window(&window)?;
    host.status(host.auth(&app)?.status()?)
}

#[tauri::command]
pub(crate) async fn ask_question(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    request: QuestionRequest,
    connection: QuestionConnection,
) -> Result<QuestionAnswer, NativeError> {
    main_window(&window)?;
    request.validate()?;
    let auth = host.auth(&app)?;
    if !matches_connection(&auth.status()?, &connection) {
        return Err(QuestionError::stale_connection().into());
    }
    if host.questions.is_usage_limited(&connection.account_id)? {
        return Err(QuestionError::usage_limited().into());
    }
    let permit = host.questions.reserve(&request, &connection.account_id)?;
    let credentials = auth.credentials(connection.generation).await?;
    if credentials.generation != connection.generation
        || credentials.account_id != connection.account_id
        || credentials.model != connection.model
        || !matches_connection(&auth.status()?, &connection)
    {
        return Err(QuestionError::stale_connection().into());
    }
    let config = Configuration::new(&credentials.access_token, &credentials.model)?
        .with_account(&credentials.account_id)?
        .with_cancellation(credentials.cancelled);
    // Cancel records the ID even while native authentication is still refreshing.
    // The auth lease also invalidates a not-yet-started or active HTTP request.
    let answer = host.questions.ask_reserved(request, config, permit).await?;
    if !auth.is_current(connection.generation) {
        return Err(QuestionError::stale_connection().into());
    }
    Ok(answer)
}

#[tauri::command]
pub(crate) async fn suggest_question_revision(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    request: QuestionRequest,
    connection: QuestionConnection,
    target: RevisionTarget,
) -> Result<RevisionAnswer, NativeError> {
    main_window(&window)?;
    validate_target(&target)?;
    validate_revision_request(&request, &target.selected_text)?;
    let auth = host.auth(&app)?;
    if !matches_connection(&auth.status()?, &connection) {
        return Err(QuestionError::stale_connection().into());
    }
    let permit = host.questions.reserve(&request, &connection.account_id)?;
    let capture_app = app.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || capture_revision(&capture_app, target))
            .await
            .map_err(|_| NativeError::unavailable())??;
    let credentials = auth.credentials(connection.generation).await?;
    if credentials.generation != connection.generation
        || credentials.account_id != connection.account_id
        || credentials.model != connection.model
        || !matches_connection(&auth.status()?, &connection)
    {
        return Err(QuestionError::stale_connection().into());
    }
    if !clean_generation(&app.state::<super::BrowserState>(), snapshot.generation)
        || !selected_revision_session(
            &app.state::<super::BrowserState>(),
            &snapshot.target.repository_id,
        )
    {
        return Err(QuestionError::stale_revision().into());
    }
    let config = Configuration::new(&credentials.access_token, &credentials.model)?
        .with_account(&credentials.account_id)?
        .with_cancellation(credentials.cancelled);
    let prepared = host
        .questions
        .revise_reserved(
            request,
            snapshot.target.selected_text.clone(),
            config,
            permit,
        )
        .await?;
    // No source/save/recovery locks span inference. The retained request permit
    // serializes cancellation with this final, local pending-proposal operation.
    tauri::async_runtime::spawn_blocking(move || {
        let (answer, replacement_text, proposal_id) = prepared.persist(|answer, replacement| {
            persist_revision(&app, &auth, &connection, &snapshot, answer, replacement)
        })?;
        Ok(RevisionAnswer {
            answer,
            proposal_id,
            replacement_text,
        })
    })
    .await
    .map_err(|_| NativeError::unavailable())?
}

#[tauri::command]
pub(crate) fn cancel_question(
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    request_id: String,
) -> Result<bool, NativeError> {
    main_window(&window)?;
    Ok(host.questions.cancel(&request_id)?)
}

#[tauri::command]
pub(crate) async fn connect_question_account(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    allow_chatgpt_plan: bool,
    account_id: Option<String>,
) -> Result<QuestionStatus, NativeError> {
    main_window(&window)?;
    if !allow_chatgpt_plan {
        return Err(NativeError::Auth { code: "consentRequired", message: "Choose to allow ChatGPT plan usage before continuing to the browser consent screen.".into() });
    }
    host.questions.cancel_active()?;
    let auth = host.auth(&app)?;
    let status = auth
        .connect(account_id.as_deref(), |url| {
            if !safe_authorization_url(url) {
                return Err(AuthError::Browser);
            }
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| AuthError::Browser)
        })
        .await?;
    host.status(status)
}

#[tauri::command]
pub(crate) fn cancel_question_sign_in(
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
) -> Result<(), NativeError> {
    main_window(&window)?;
    host.questions.cancel_active()?;
    if let Some(auth) = host
        .auth
        .lock()
        .map_err(|_| NativeError::unavailable())?
        .as_ref()
    {
        auth.cancel();
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn select_question_account(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    account_id: String,
) -> Result<QuestionStatus, NativeError> {
    main_window(&window)?;
    host.questions.cancel_active()?;
    let auth = host.auth(&app)?;
    host.status(auth.select_account(&account_id).await?)
}

#[tauri::command]
pub(crate) fn select_question_model(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    slug: String,
) -> Result<QuestionStatus, NativeError> {
    main_window(&window)?;
    host.questions.cancel_active()?;
    host.status(host.auth(&app)?.select_model(&slug)?)
}

#[tauri::command]
pub(crate) async fn refresh_question_connection(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
) -> Result<QuestionStatus, NativeError> {
    main_window(&window)?;
    host.questions.cancel_active()?;
    let auth = host.auth(&app)?;
    let status = auth.refresh_models().await?;
    if let Some(id) = status.active_account_id.as_deref() {
        host.questions.clear_usage_limit(id)?;
    }
    host.status(status)
}

#[tauri::command]
pub(crate) async fn sign_out_question_account(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    account_id: Option<String>,
) -> Result<QuestionStatus, NativeError> {
    main_window(&window)?;
    host.questions.cancel_active()?;
    let auth = host.auth(&app)?;
    host.status(auth.sign_out(account_id.as_deref()).await?)
}

#[tauri::command]
pub(crate) fn open_question_usage(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), NativeError> {
    main_window(&window)?;
    app.opener()
        .open_url(USAGE_URL, None::<&str>)
        .map_err(|_| AuthError::Browser.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision_target() -> RevisionTarget {
        RevisionTarget {
            repository_id: "native-session".into(),
            path: "scenes/fox.md".into(),
            source_hash: "a".repeat(64),
            from_utf8: 0,
            to_utf8: 3,
            selected_text: "Fox".into(),
        }
    }

    #[test]
    fn revision_target_wire_is_bounded_and_rejects_hidden_paths_or_extra_input() {
        let target = revision_target();
        assert!(validate_target(&target).is_ok());
        for path in [
            "../fox.md",
            "/fox.md",
            ".private/fox.md",
            "scenes\\fox.md",
            "scenes/file.txt",
            "scenes//fox.md",
        ] {
            let mut target = revision_target();
            target.path = path.into();
            assert!(validate_target(&target).is_err());
        }
        let mut target = revision_target();
        target.source_hash = "A".repeat(64);
        assert!(validate_target(&target).is_err());
        let mut target = revision_target();
        target.to_utf8 = target.from_utf8;
        assert!(validate_target(&target).is_err());
        assert!(serde_json::from_value::<RevisionTarget>(serde_json::json!({
            "repositoryId":"session","path":"scenes/fox.md","sourceHash":"a".repeat(64),
            "fromUtf8":0,"toUtf8":3,"selectedText":"Fox","fullSource":"unpreviewed"
        }))
        .is_err());
    }

    #[test]
    fn revision_source_binds_exact_bytes_path_hash_and_edit_epoch_even_after_undo() {
        let snapshot = RevisionSnapshot {
            target: revision_target(),
            source: "Fox".into(),
            generation: 0,
        };
        let mut document = repository_core::Document {
            path: "scenes/fox.md".into(),
            text: "Fox".into(),
            content_hash: "a".repeat(64),
            size_bytes: 3,
            frontmatter: None,
            generated_compatibility: false,
        };
        assert!(same_revision_source(&snapshot, &document));
        document.text = "Dog".into();
        assert!(!same_revision_source(&snapshot, &document));
        document.text = "Fox".into();
        document.content_hash = "b".repeat(64);
        assert!(!same_revision_source(&snapshot, &document));
        document.content_hash = "a".repeat(64);
        document.path = "scenes/other.md".into();
        assert!(!same_revision_source(&snapshot, &document));
        document.path = "scenes/fox.md".into();
        document.generated_compatibility = true;
        assert!(!same_revision_source(&snapshot, &document));
        let state = super::super::BrowserState::default();
        assert!(clean_generation(&state, snapshot.generation));
        state.unsaved_changes.store(true, Ordering::SeqCst);
        assert!(!clean_generation(&state, snapshot.generation));
        state.mutation_gate.invalidate();
        state.unsaved_changes.store(false, Ordering::SeqCst);
        assert!(!clean_generation(&state, snapshot.generation));
        assert!(clean_generation(&state, state.mutation_gate.generation()));
        assert!(!selected_revision_session(&state, "native-session"));
    }

    #[test]
    fn revision_answer_exposes_advice_and_selected_replacement_without_full_source() {
        let result = RevisionAnswer {
            answer: QuestionAnswer {
                request_id: "r".into(),
                text: "Explanation".into(),
                model: "test-model".into(),
                input_tokens: None,
                output_tokens: None,
                incomplete: false,
            },
            proposal_id: "pending-id".into(),
            replacement_text: "  Literal—🦊\r\n".into(),
        };
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["text"], "Explanation");
        assert_eq!(value["replacementText"], "  Literal—🦊\r\n");
        assert_eq!(value["proposalId"], "pending-id");
        assert_eq!(value["incomplete"], false);
        assert!(value.get("source").is_none());
        assert!(value.get("answer").is_none());
    }

    fn status() -> AuthStatus {
        AuthStatus {
            accounts: vec![AccountView {
                id: "oaiapp_account-one".into(),
                label: "Writing account".into(),
                signed_in: true,
                plan_enabled: true,
            }],
            active_account_id: Some("oaiapp_account-one".into()),
            models: vec![ModelView {
                slug: "test-model".into(),
                display_name: "Test model".into(),
            }],
            selected_model: Some("test-model".into()),
            sign_in_pending: false,
            generation: 7,
            message: None,
        }
    }

    fn connection() -> QuestionConnection {
        QuestionConnection {
            generation: 7,
            account_id: "oaiapp_account-one".into(),
            model: "test-model".into(),
        }
    }

    #[test]
    fn send_binding_requires_exact_generation_account_and_available_model() {
        assert!(matches_connection(&status(), &connection()));
        let mut binding = connection();
        binding.generation += 1;
        assert!(!matches_connection(&status(), &binding));
        let mut binding = connection();
        binding.account_id = "other".into();
        assert!(!matches_connection(&status(), &binding));
        let mut binding = connection();
        binding.model = "other".into();
        assert!(!matches_connection(&status(), &binding));
        let mut auth = status();
        auth.models.clear();
        assert!(!matches_connection(&auth, &connection()));
        let mut auth = status();
        auth.sign_in_pending = true;
        assert!(!matches_connection(&auth, &connection()));
        let mut auth = status();
        auth.accounts[0].plan_enabled = false;
        assert!(!matches_connection(&auth, &connection()));
        let mut auth = status();
        auth.accounts[0].signed_in = false;
        assert!(!matches_connection(&auth, &connection()));
    }

    #[test]
    fn authorization_opener_allows_only_exact_native_https_route() {
        assert!(safe_authorization_url("https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=fake"));
        for url in [
            "http://auth.openai.com/api/accounts/authorize?x=1",
            "https://auth.openai.com:444/api/accounts/authorize?x=1",
            "https://auth.openai.com.evil.test/api/accounts/authorize?x=1",
            "https://user@auth.openai.com/api/accounts/authorize?x=1",
            "https://user:pass@auth.openai.com/api/accounts/authorize?x=1",
            "https://auth.openai.com/api/accounts/authorize?x=1#fragment",
            "https://auth.openai.com/api/accounts/authorize",
            "https://auth.openai.com/another-route?x=1",
            "file:///tmp/private",
            "javascript:alert(1)",
        ] {
            assert!(!safe_authorization_url(url), "unexpectedly accepted URL");
        }
    }

    #[test]
    fn renderer_status_has_no_native_credential_fields_and_requires_plan_grant() {
        let host = QuestionHost::default();
        let value = serde_json::to_value(host.status(status()).ok().unwrap()).unwrap();
        assert_eq!(value["configured"], true);
        assert_eq!(value["generation"], 7);
        assert_eq!(value["activeAccountId"], "oaiapp_account-one");
        for key in [
            "accessToken",
            "refreshToken",
            "idToken",
            "authorizationUrl",
            "auth",
        ] {
            assert!(value.get(key).is_none());
        }
        let mut auth = status();
        auth.accounts[0].plan_enabled = false;
        assert!(!host.status(auth).ok().unwrap().configured);
    }

    #[test]
    fn connection_payload_rejects_extra_fields() {
        assert!(serde_json::from_value::<QuestionConnection>(serde_json::json!({
            "generation":7,"accountId":"oaiapp_account-one","model":"test-model","url":"https://evil.test"
        })).is_err());
    }

    #[test]
    fn private_account_storage_cannot_overlap_manuscript_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let manuscript = root.join("manuscript");
        std::fs::create_dir(&manuscript).unwrap();
        let future_private = root.join("private").join("chatgpt-auth");
        assert!(
            super::super::guard_auth_repository_separation(&manuscript, &future_private).is_ok()
        );
        assert!(super::super::guard_auth_repository_separation(&root, &future_private).is_err());
        std::fs::create_dir_all(&future_private).unwrap();
        assert!(
            super::super::guard_auth_repository_separation(&future_private, &future_private)
                .is_err()
        );
        assert!(super::super::guard_auth_repository_separation(
            &future_private.join("scenes"),
            &future_private
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn private_storage_overlap_resolves_symlinked_existing_parent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let manuscript = root.join("manuscript");
        std::fs::create_dir(&manuscript).unwrap();
        let alias = root.join("storage-alias");
        std::os::unix::fs::symlink(&manuscript, &alias).unwrap();
        let future_private = alias.join("not-created").join("chatgpt-auth");
        assert!(
            super::super::guard_auth_repository_separation(&manuscript, &future_private).is_err()
        );
        assert!(!manuscript.join("not-created").exists());
    }
}

/// Review snapshots are explicit renderer captures. Unsaved text remains advisory;
/// preparation below requires these exact bytes to have been saved through Core.
#[tauri::command]
pub(crate) async fn request_review(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    request: drafting_questions::review::ReviewRequest,
    connection: QuestionConnection,
) -> Result<crate::review_state::ReviewResult, NativeError> {
    main_window(&window)?;
    if request.workflow.is_some() {
        return request_review_workflow(app, host, request, connection).await;
    }

    request.validate()?;
    let auth = host.auth(&app)?;
    if !matches_connection(&auth.status()?, &connection) {
        return Err(QuestionError::stale_connection().into());
    }
    let permit = host
        .questions
        .reserve(&request.question_request()?, &connection.account_id)?;
    let capture = request.clone();
    let capture_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = capture_app.state::<super::BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| NativeError::revision("Repository operation in progress"))?;
        super::with_repository(&capture_app, &capture.repository_id, |repo| {
            for snapshot in &capture.snapshots {
                let current = repo.read(&snapshot.path).map_err(|e| e.to_string())?;
                if current.generated_compatibility
                    || (current.content_hash != snapshot.source_hash
                        && current.text != snapshot.source)
                {
                    return Err("The saved base changed; capture the review again".into());
                }
            }
            Ok(())
        })
        .map_err(NativeError::revision)
    })
    .await
    .map_err(|_| NativeError::unavailable())??;
    let credentials = auth.credentials(connection.generation).await?;
    if credentials.generation != connection.generation
        || credentials.account_id != connection.account_id
        || credentials.model != connection.model
        || !matches_connection(&auth.status()?, &connection)
    {
        return Err(QuestionError::stale_connection().into());
    }
    let config = Configuration::new(&credentials.access_token, &credentials.model)?
        .with_account(&credentials.account_id)?
        .with_cancellation(credentials.cancelled);
    let prepared = host
        .questions
        .review_reserved(request.clone(), config, permit)
        .await?;
    let (_, _, result) = prepared.persist(|answer, json| {
        let state = app.state::<super::BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| NativeError::revision("Repository operation in progress"))?;
        if !selected_revision_session(&state, &request.repository_id)
            || !auth.is_current(connection.generation)
        {
            return Err(QuestionError::stale_connection().into());
        }
        let output = serde_json::from_str(json)
            .map_err(|_| NativeError::revision("Invalid review output"))?;
        let session =
            crate::review_state::ReviewSession::new(request, output, answer.model.clone())
                .map_err(NativeError::revision)?;
        let result = session.view();
        *host.review.lock().map_err(|_| NativeError::unavailable())? = Some(session);
        Ok::<_, NativeError>(result)
    })?;
    Ok(result)
}

fn review_session<'a>(
    slot: &'a mut Option<crate::review_state::ReviewSession>,
    repository_id: &str,
    review_id: &str,
) -> Result<&'a mut crate::review_state::ReviewSession, String> {
    slot.as_mut()
        .filter(|s| s.matches(repository_id, review_id))
        .ok_or_else(|| {
            "Review expired or belongs to another repository; request a new review".into()
        })
}

#[tauri::command]
pub(crate) fn get_review(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    repository_id: String,
    review_id: String,
) -> Result<crate::review_state::ReviewResult, String> {
    super::check_window(&window)?;
    if !selected_revision_session(&app.state::<super::BrowserState>(), &repository_id) {
        return Err("Repository changed".into());
    }
    let mut slot = host.review.lock().map_err(|_| "Review unavailable")?;
    super::with_repository(&app, &repository_id, |repo| {
        ensure_review(&app, &mut slot, repo, &repository_id, &review_id)?;
        Ok(review_session(&mut slot, &repository_id, &review_id)?.view())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedReviewEdit {
    proposal_id: String,
}

#[tauri::command]
pub(crate) async fn prepare_review_edit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    review_id: String,
    edit_id: String,
) -> Result<PreparedReviewEdit, String> {
    super::check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<super::BrowserState>();
        let _selection = state.selection_gate.try_lock().map_err(|_|"Repository operation in progress")?;
        let _mutation = state.mutation_gate.author_operation()?;
        let epoch = state.mutation_gate.generation();
        if !clean_generation(&state,epoch) { return Err("Save the exact reviewed snapshot and resolve recovery before accepting edits".into()); }
        let host = app.state::<QuestionHost>();
        if host.review_active.load(Ordering::SeqCst){return Err("Wait for the active reviewer batch to settle before approval".into())}
        let mut slot = host.review.lock().map_err(|_|"Review unavailable")?;
        super::with_repository(&app,&repository_id,|repo|ensure_review(&app,&mut slot,repo,&repository_id,&review_id))?;
        let session = review_session(&mut slot,&repository_id,&review_id)?;
        let (store,_) = super::proposals::stores(&app)?;
        let recovery = super::recovery_store(&app)?;
        super::with_repository(&app,&repository_id,|repo| {
            let candidate = session.candidate(&edit_id,&repo.project_key())?;
            let was_prepared = session.is_prepared(&edit_id);
            let path = candidate.path.clone();
            let proposal = recovery.with_clean_paths(repo,std::slice::from_ref(&path),|| {
                let current = repo.read(&path)?;
                if current.generated_compatibility || current.text != candidate.base_text || current.content_hash != candidate.base_hash {
                    return Ok(Err("The saved scene differs from the exact review snapshot or accepted-edit lineage; request a new review".to_string()));
                }
                // Reopening a prepared edit reuses its immutable proposal.
                if was_prepared || store.get(repo,&candidate.id).is_ok() {
                    return Ok(store.get(repo,&candidate.id).map_err(|e|e.to_string()).and_then(|stored| {
                        if stored.path==candidate.path && stored.base_hash==candidate.base_hash && stored.replacement_hash==candidate.replacement_hash && stored.diff_hash==candidate.diff_hash && stored.origin.review==candidate.origin.review { Ok(stored) }
                        else { Err("The pending proposal changed; request a new review".into()) }
                    }));
                }
                Ok(store.submit_checked(repo,&path,&candidate.base_hash,&candidate.replacement_text,candidate.origin.clone(),|| {
                    if !clean_generation(&state,epoch) { return Err(proposal_store::Error::Conflict); }
                    Ok(())
                }).map_err(|e|e.to_string()))
            }).map_err(|e|e.to_string())??;
            let proposal_id = proposal.id.clone();
            session.prepared(&edit_id,proposal)?;
            session.persist(&review_records(&app)?,repo)?;
            Ok(PreparedReviewEdit {proposal_id})
        })
    }).await.map_err(|_|"Review unavailable".to_string())?
}

#[tauri::command]
pub(crate) async fn reject_review_edit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    review_id: String,
    edit_id: String,
) -> Result<crate::review_state::ReviewResult, String> {
    super::check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<super::BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Repository operation in progress")?;
        let host = app.state::<QuestionHost>();
        let mut slot = host.review.lock().map_err(|_| "Review unavailable")?;
        super::with_repository(&app, &repository_id, |repo| {
            ensure_review(&app, &mut slot, repo, &repository_id, &review_id)
        })?;
        let session = review_session(&mut slot, &repository_id, &review_id)?;
        let (_, receipts) = super::proposals::stores(&app)?;
        super::with_repository(&app, &repository_id, |repo| {
            let proposal = session.rejection_candidate(&edit_id, &repo.project_key())?;
            let receipt = state
                .proposals
                .lock()
                .map_err(|_| "Proposal unavailable")?
                .authority
                .reject_snapshot(repo, &receipts, proposal)?;
            session.rejected(&edit_id, receipt.proposal_id)?;
            session.persist(&review_records(&app)?, repo)?;
            Ok(session.view())
        })
    })
    .await
    .map_err(|_| "Review unavailable".to_string())?
}

pub(crate) fn record_review_apply(
    app: &tauri::AppHandle,
    repository_id: &str,
    receipt: &super::proposals::authority::Receipt,
) {
    if receipt.kind != "apply" || receipt.status != "completed" {
        return;
    }
    let host = app.state::<QuestionHost>();
    if let Ok(mut slot) = host.review.lock() {
        if let Some(session) = slot.as_mut() {
            session.applied(
                repository_id,
                &receipt.proposal_id,
                &receipt.base_hash,
                &receipt.replacement_hash,
                &receipt.diff_hash,
            );
            let _ = super::with_repository(app, repository_id, |repo| {
                session.persist(&review_records(app)?, repo)
            });
        }
    };
}

pub(crate) fn record_review_rejection(
    app: &tauri::AppHandle,
    repository_id: &str,
    receipt: &super::proposals::authority::Receipt,
) {
    if receipt.kind != "reject" || receipt.status != "rejected" {
        return;
    }
    let host = app.state::<QuestionHost>();
    if let Ok(mut slot) = host.review.lock() {
        if let Some(session) = slot.as_mut() {
            session.rejected_proposal(repository_id, &receipt.proposal_id);
            let _ = super::with_repository(app, repository_id, |repo| {
                session.persist(&review_records(app)?, repo)
            });
        }
    };
}

pub(crate) fn review_records(
    app: &tauri::AppHandle,
) -> Result<proposal_store::ReviewStore, String> {
    proposal_store::ReviewStore::open(
        app.path()
            .app_data_dir()
            .map_err(|_| "Review storage unavailable")?
            .join("review-records-v2"),
    )
    .map_err(|e| e.to_string())
}
fn ensure_review(
    app: &tauri::AppHandle,
    slot: &mut Option<crate::review_state::ReviewSession>,
    repo: &repository_core::Repository,
    repository_id: &str,
    review_id: &str,
) -> Result<(), String> {
    let store = review_records(app)?;
    let records = super::proposals::review_receipts(app, repo)?;
    if !slot
        .as_ref()
        .is_some_and(|s| s.matches(repository_id, review_id))
    {
        let saved: crate::review_state::ReviewSession =
            store.load(repo, review_id).map_err(|e| e.to_string())?;
        if saved.id() != review_id {
            return Err("Review identity changed".into());
        }
        *slot = Some(
            saved.restore(&repo.project_key(), repository_id, |candidate| {
                records.iter().any(|r| {
                    r.proposal_id == candidate.id
                        && r.origin.review == candidate.origin.review
                        && r.kind == "apply"
                        && r.status == "completed"
                        && r.base_hash == candidate.base_hash
                        && r.replacement_hash == candidate.replacement_hash
                        && r.diff_hash == candidate.diff_hash
                })
            })?,
        );
    }
    let session = slot.as_mut().ok_or("Review unavailable")?;
    session.reconcile_receipts(
        &records
            .iter()
            .map(|r| {
                (
                    r.kind.clone(),
                    r.status.clone(),
                    r.proposal_id.clone(),
                    r.base_hash.clone(),
                    r.replacement_hash.clone(),
                    r.diff_hash.clone(),
                    r.origin.review.clone(),
                )
            })
            .collect::<Vec<_>>(),
    )?;
    let mapping = repo.load_drafting().ok();
    for snapshot in session.request.snapshots.clone() {
        let mapped = snapshot.scene_id.as_ref().is_none_or(|id| {
            mapping.as_ref().is_some_and(|m| {
                !m.recovery_required
                    && m.scenes
                        .iter()
                        .any(|s| &s.id == id && s.path == snapshot.path)
            })
        });
        let current = repo
            .read(&snapshot.path)
            .ok()
            .filter(|d| !d.generated_compatibility && mapped);
        session.source_state(&snapshot.path, current.as_ref().map(|d| d.text.as_str()));
    }
    Ok(())
}
async fn request_review_workflow(
    app: tauri::AppHandle,
    host: State<'_, QuestionHost>,
    mut request: drafting_questions::review::ReviewRequest,
    connection: QuestionConnection,
) -> Result<crate::review_state::ReviewResult, NativeError> {
    request.validate()?;
    let auth = host.auth(&app)?;
    if !matches_connection(&auth.status()?, &connection) {
        return Err(QuestionError::stale_connection().into());
    }
    let permit = host
        .questions
        .reserve(&request.question_request()?, &connection.account_id)?;
    if host.review_active.swap(true, Ordering::SeqCst) {
        return Err(NativeError::revision(
            "Another review batch is still settling",
        ));
    }
    struct Active<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for Active<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst)
        }
    }
    let _active = Active(&host.review_active);
    let capture_repository = request.repository_id.clone();
    let(defs,coverage,remaining)=super::with_repository(&app,&capture_repository,|repo|{
  let mut slot=host.review.lock().map_err(|_|"Review unavailable")?;
  if let Some(id)=request.workflow.as_ref().and_then(|o|o.review_id.as_ref()){
   ensure_review(&app,&mut slot,repo,&request.repository_id,id)?;
   let session=slot.as_mut().ok_or("Review unavailable")?;
   let mut old=session.request.clone();old.request_id=request.request_id.clone();old.workflow.as_mut().unwrap().review_id=Some(id.clone());
   if serde_json::to_value(&old).map_err(|_|"Invalid review")?!=serde_json::to_value(&request).map_err(|_|"Invalid review")?||!session.connection_matches(&connection.account_id,&connection.model,connection.generation){return Err("Continue requires the same captured scope, reviewer definitions, account and model".into())}
   session.set_request_id(request.request_id.clone());session.bind_batch_generation(connection.generation);
  }else{
   let mapping=repo.load_drafting().map_err(|e|e.to_string())?;
   if mapping.recovery_required{return Err("Resolve manuscript structure recovery before reviewing".into())}
   for snapshot in request.snapshots.iter_mut().chain(request.workflow.as_mut().unwrap().context.iter_mut()) {let actual=mapping.scenes.iter().find(|s|s.path==snapshot.path).map(|s|s.id.clone());if snapshot.scene_id.is_some()&&snapshot.scene_id!=actual{return Err("Selected scene mapping changed".into())}snapshot.scene_id=actual;}
   for snapshot in request.snapshots.iter().chain(request.workflow.as_ref().unwrap().context.iter()) {let current=repo.read(&snapshot.path).map_err(|e|e.to_string())?;if current.generated_compatibility||(current.content_hash!=snapshot.source_hash&&current.text!=snapshot.source){return Err("A selected source/context changed; capture the review again".into())}}
   let mut session=crate::review_state::ReviewSession::workflow(request.clone(),repo.project_key(),connection.model.clone(),connection.account_id.clone(),connection.generation)?;session.persist(&review_records(&app)?,repo)?;*slot=Some(session);
  }
  let session=slot.as_ref().ok_or("Review unavailable")?;Ok((session.definitions(),session.coverage(),session.remaining_findings()))
 }).map_err(NativeError::revision)?;
    if remaining == 0 {
        return Err(NativeError::revision("The retained finding limit is reached. Start a smaller explicit review; no call was sent."));
    }
    let credentials = auth.credentials(connection.generation).await?;
    if credentials.account_id != connection.account_id
        || credentials.model != connection.model
        || !matches_connection(&auth.status()?, &connection)
    {
        return Err(QuestionError::stale_connection().into());
    }
    let config = Configuration::new(&credentials.access_token, &credentials.model)?
        .with_account(&credentials.account_id)?
        .with_cancellation(credentials.cancelled);
    let progress =
        |call: &drafting_questions::review_workflow::CallResult| -> Result<(), QuestionError> {
            if !auth.is_current(connection.generation)
                || !selected_revision_session(
                    &app.state::<super::BrowserState>(),
                    &request.repository_id,
                )
            {
                return Err(QuestionError::stale_connection());
            }
            super::with_repository(&app, &request.repository_id, |repo| {
                let store = review_records(&app)?;
                let saved: Vec<crate::review_state::ReviewSession> =
                    store.list(repo).map_err(|e| e.to_string())?;
                let mut tombstones = saved
                    .iter()
                    .flat_map(|r| r.tombstones())
                    .collect::<std::collections::HashSet<_>>();
                for receipt in super::proposals::review_receipts(&app, repo)? {
                    if receipt.kind == "reject" && receipt.status == "rejected" {
                        if let Some(a) = receipt.origin.review {
                            tombstones.insert(a.fingerprint);
                        }
                    }
                }
                let mut slot = host.review.lock().map_err(|_| "Review unavailable")?;
                let id = slot
                    .as_ref()
                    .filter(|r| r.request.request_id == request.request_id)
                    .ok_or("Review changed")?
                    .id()
                    .to_owned();
                ensure_review(&app, &mut slot, repo, &request.repository_id, &id)?;
                let session = review_session(&mut slot, &request.repository_id, &id)?;
                session.ingest(
                    drafting_questions::review_workflow::Batch {
                        calls: vec![call.clone()],
                        cancelled: false,
                        limit_reached: false,
                    },
                    &tombstones,
                )?;
                session.persist(&store, repo)
            })
            .map_err(|_| QuestionError::review_persistence())
        };
    let batch = host
        .questions
        .review_batch_reserved(
            request.clone(),
            config,
            permit,
            coverage,
            defs,
            remaining,
            progress,
        )
        .await?;
    if !auth.is_current(connection.generation)
        || !selected_revision_session(&app.state::<super::BrowserState>(), &request.repository_id)
    {
        return Err(QuestionError::stale_connection().into());
    }
    super::with_repository(&app, &request.repository_id, |repo| {
        let store = review_records(&app)?;
        let saved: Vec<crate::review_state::ReviewSession> =
            store.list(repo).map_err(|e| e.to_string())?;
        let mut tombstones = saved
            .iter()
            .flat_map(|r| r.tombstones())
            .collect::<std::collections::HashSet<_>>();
        for receipt in super::proposals::review_receipts(&app, repo)? {
            if receipt.kind == "reject" && receipt.status == "rejected" {
                if let Some(a) = receipt.origin.review {
                    tombstones.insert(a.fingerprint);
                }
            }
        }
        let mut slot = host.review.lock().map_err(|_| "Review unavailable")?;
        let session = slot
            .as_mut()
            .filter(|r| r.request.request_id == request.request_id)
            .ok_or("Review scope changed")?;
        session.ingest(batch, &tombstones)?;
        session.persist(&store, repo)?;
        Ok(session.view())
    })
    .map_err(NativeError::revision)
}
#[tauri::command]
pub(crate) fn list_reviews(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
) -> Result<Vec<crate::review_state::ReviewResult>, String> {
    super::check_window(&window)?;
    let host = app.state::<QuestionHost>();
    super::with_repository(&app, &repository_id, |repo| {
        let saved: Vec<crate::review_state::ReviewSession> = review_records(&app)?
            .list(repo)
            .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for r in saved {
            let id = r.id().to_owned();
            let mut slot = None;
            ensure_review(&app, &mut slot, repo, &repository_id, &id)?;
            let mut r = slot.unwrap();
            r.request.repository_id = repository_id.clone();
            result.push(r.view());
        }
        let _ = &host;
        Ok(result)
    })
}
#[tauri::command]
pub(crate) fn choose_review_edit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    review_id: String,
    edit_id: String,
) -> Result<crate::review_state::ReviewResult, String> {
    super::check_window(&window)?;
    let host = app.state::<QuestionHost>();
    if host.review_active.load(Ordering::SeqCst) {
        return Err("Wait for the active reviewer batch before choosing alternatives".into());
    }
    let mut slot = host.review.lock().map_err(|_| "Review unavailable")?;
    super::with_repository(&app, &repository_id, |repo| {
        ensure_review(&app, &mut slot, repo, &repository_id, &review_id)?;
        let r = review_session(&mut slot, &repository_id, &review_id)?;
        r.choose(&edit_id)?;
        r.persist(&review_records(&app)?, repo)?;
        Ok(r.view())
    })
}
#[tauri::command]
pub(crate) async fn approve_review_edit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    review_id: String,
    edit_id: String,
) -> Result<Option<super::proposals::authority::Outcome>, String> {
    let p = prepare_review_edit(
        app.clone(),
        window.clone(),
        repository_id.clone(),
        review_id,
        edit_id,
    )
    .await?;
    let review = super::proposals::review_proposal(
        app.clone(),
        window.clone(),
        repository_id.clone(),
        p.proposal_id,
    )
    .await?;
    let binding = super::proposals::authority::Binding {
        review_id: review.id,
        proposal_id: review.proposal_id,
        base_hash: review.base_hash,
        replacement_hash: review.replacement_hash,
        diff_hash: review.diff_hash,
    };
    super::proposals::apply_proposal_review(app, window, repository_id, binding).await
}
pub(crate) fn guard_review_proposal(
    app: &tauri::AppHandle,
    repository_id: &str,
    origin: &proposal_store::ProposalOrigin,
) -> Result<Option<u64>, String> {
    let Some(a) = &origin.review else {
        return Ok(None);
    };
    let host = app.state::<QuestionHost>();
    if host.review_active.load(Ordering::SeqCst) {
        return Err("Wait for the active reviewer batch to settle".into());
    }
    let mut slot = host.review.lock().map_err(|_| "Review unavailable")?;
    super::with_repository(app, repository_id, |repo| {
        ensure_review(app, &mut slot, repo, repository_id, &a.review_id)?;
        let r = review_session(&mut slot, repository_id, &a.review_id)?;
        let saved: crate::review_state::ReviewSession = review_records(app)?
            .load(repo, &a.review_id)
            .map_err(|e| e.to_string())?;
        if r.revision_data() != saved.revision_data() {
            return Err(
                "The review changed in another window or process; refresh its decisions".into(),
            );
        }
        r.validate_binding(a)?;
        Ok(Some(r.revision_data().1))
    })
}

#[tauri::command]
pub(crate) fn review_definitions(
    window: tauri::WebviewWindow,
) -> Result<Vec<drafting_questions::review_workflow::ReviewerDefinition>, String> {
    super::check_window(&window)?;
    Ok(drafting_questions::review_workflow::definitions())
}
#[tauri::command]
pub(crate) fn preview_review(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: drafting_questions::review::ReviewRequest,
) -> Result<Vec<drafting_questions::review_workflow::Coverage>, String> {
    super::check_window(&window)?;
    request.validate().map_err(|e| e.to_string())?;
    super::with_repository(&app, &request.repository_id, |repo| {
        for s in request.snapshots.iter().chain(
            request
                .workflow
                .as_ref()
                .ok_or("Choose a reviewer")?
                .context
                .iter(),
        ) {
            let current = repo.read(&s.path).map_err(|e| e.to_string())?;
            if current.generated_compatibility
                || (current.content_hash != s.source_hash && current.text != s.source)
            {
                return Err("Selected source changed; capture again".into());
            }
        }
        drafting_questions::review_workflow::plan(&request).map_err(|e| e.to_string())
    })
}
#[tauri::command]
pub(crate) async fn continue_review(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host: State<'_, QuestionHost>,
    repository_id: String,
    review_id: String,
    request_id: String,
    connection: QuestionConnection,
) -> Result<crate::review_state::ReviewResult, NativeError> {
    main_window(&window)?;
    let request = super::with_repository(&app, &repository_id, |repo| {
        let mut slot = host.review.lock().map_err(|_| "Review unavailable")?;
        ensure_review(&app, &mut slot, repo, &repository_id, &review_id)?;
        let mut request = review_session(&mut slot, &repository_id, &review_id)?
            .request
            .clone();
        request.request_id = request_id;
        request
            .workflow
            .as_mut()
            .ok_or("This review cannot continue")?
            .review_id = Some(review_id);
        Ok(request)
    })
    .map_err(NativeError::revision)?;
    request_review_workflow(app, host, request, connection).await
}
