//! Bundled-main-window routes only. MCP has no access to this module or dialogs.
pub(crate) mod authority;
use super::{check_window, recovery_store, with_repository, BrowserState};
use authority::{Authority, Binding, Listing, Outcome, ReceiptStore, Review};
use proposal_store::ProposalStore;
use std::sync::atomic::Ordering;
use tauri::Manager;
#[cfg(not(all(feature = "revision-native-acceptance", target_os = "macos")))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
pub(crate) struct ProposalHost {
    pub authority: Authority,
    epoch: u64,
}
pub(crate) fn stores(app: &tauri::AppHandle) -> Result<(ProposalStore, ReceiptStore), String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok((
        ProposalStore::open(path.join("pending-proposals-v1")).map_err(|e| e.to_string())?,
        ReceiptStore::open(path.join("proposal-receipts-v1"))?,
    ))
}
#[tauri::command]
pub(crate) async fn list_proposals(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
) -> Result<Listing, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let host = state
            .proposals
            .lock()
            .map_err(|_| "Proposal review unavailable")?;
        let (store, receipts) = stores(&app)?;
        with_repository(&app, &repository_id, |repo| {
            host.authority.list(repo, &repository_id, &store, &receipts)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn review_proposal(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    proposal_id: String,
) -> Result<Review, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder or manuscript operation is in progress")?;
        let _mutation = state.mutation_gate.author_operation()?;
        let mut host = state
            .proposals
            .lock()
            .map_err(|_| "Proposal review unavailable")?;
        let (store, receipts) = stores(&app)?;
        let recovery = recovery_store(&app)?;
        let epoch = state.mutation_gate.generation();
        let review = with_repository(&app, &repository_id, |repo| {
            host.authority.review(
                repo,
                &repository_id,
                &store,
                &receipts,
                &recovery,
                &proposal_id,
                state.unsaved_changes.load(Ordering::SeqCst),
            )
        })?;
        if epoch != state.mutation_gate.generation() {
            host.authority.invalidate();
            return Err("Editor changed during review; save and review again".into());
        }
        host.epoch = epoch;
        Ok(review)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn review_proposal_revert(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    receipt_id: String,
) -> Result<Review, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder or manuscript operation is in progress")?;
        let _mutation = state.mutation_gate.author_operation()?;
        let mut host = state
            .proposals
            .lock()
            .map_err(|_| "Proposal review unavailable")?;
        let recovery = recovery_store(&app)?;
        let epoch = state.mutation_gate.generation();
        let review = with_repository(&app, &repository_id, |repo| {
            host.authority.review_revert(
                repo,
                &repository_id,
                &recovery,
                &receipt_id,
                state.unsaved_changes.load(Ordering::SeqCst),
            )
        })?;
        if epoch != state.mutation_gate.generation() {
            host.authority.invalidate();
            return Err("Editor changed during review; save and review again".into());
        }
        host.epoch = epoch;
        Ok(review)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn apply_proposal_review(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    binding: Binding,
) -> Result<Option<Outcome>, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let _selection = state
            .selection_gate
            .try_lock()
            .map_err(|_| "Another folder or manuscript operation is in progress")?;
        let review = {
            let mut host = state
                .proposals
                .lock()
                .map_err(|_| "Proposal review unavailable")?;
            if host.epoch != state.mutation_gate.generation() {
                host.authority.invalidate();
                return Err("Editor changed since review; save and review again".into());
            }
            with_repository(&app, &repository_id, |repo| {
                host.authority.confirmation(
                    repo,
                    &repository_id,
                    &binding,
                    state.unsaved_changes.load(Ordering::SeqCst),
                )
            })?
        };
        if review.kind == "apply" {
            super::questions::guard_review_proposal(&app, &repository_id, &review.origin)?;
        }
        // A renderer request alone is not author approval. Dialog content comes
        // only from the retained plan. No authority lock is held while it is open:
        // real dirty notifications can invalidate the plan during confirmation.
        #[cfg(all(feature = "revision-native-acceptance", target_os = "macos"))]
        let confirmed = crate::revision_native_acceptance::confirm_review(&app, &review)?;
        #[cfg(not(all(feature = "revision-native-acceptance", target_os = "macos")))]
        let confirmed = app
            .dialog()
            .message(review.confirmation_message())
            .title(if review.kind == "revert" {
                "Heinlein: confirm guarded revert"
            } else {
                "Heinlein: confirm reviewed proposal"
            })
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if !confirmed {
            state
                .proposals
                .lock()
                .map_err(|_| "Proposal review unavailable")?
                .authority
                .cancel(&repository_id, &binding.review_id);
            return Ok(None);
        }
        let review_revision = if review.kind == "apply" {
            super::questions::guard_review_proposal(&app, &repository_id, &review.origin)?
        } else {
            None
        }; // Guarded revert uses its own live receipt/expected-source authority.

        let _mutation = state.mutation_gate.author_operation()?;
        let mut host = state
            .proposals
            .lock()
            .map_err(|_| "Proposal review unavailable")?;
        if host.epoch != state.mutation_gate.generation() {
            host.authority.invalidate();
            return Err("Editor changed during native confirmation; review again".into());
        }
        let (_, receipts) = stores(&app)?;
        let recovery = recovery_store(&app)?;
        // Check the live plan, its monotonic TTL, dirty state, recovery and source
        // again after the native author action. Never refresh its reviewed bytes.
        let epoch = host.epoch;
        let outcome = with_repository(&app, &repository_id, |repo| {
            let mut apply = || {
                host.authority.apply_confirmed(
                    repo,
                    &repository_id,
                    &receipts,
                    &recovery,
                    &binding,
                    || {
                        state.unsaved_changes.load(Ordering::SeqCst)
                            || epoch != state.mutation_gate.generation()
                    },
                )
            };
            if let (Some(revision), Some(attribution)) =
                (review_revision, review.origin.review.as_ref())
            {
                super::questions::review_records(&app)?.with_revision(
                    repo,
                    &attribution.review_id,
                    revision,
                    apply,
                )
            } else {
                apply()
            }
        })?;
        drop(host);
        super::questions::record_review_apply(&app, &repository_id, &outcome.receipt);
        Ok(Some(outcome))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn cancel_proposal_review(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    repository_id: String,
    review_id: String,
) -> Result<(), String> {
    check_window(&window)?;
    state
        .proposals
        .lock()
        .map_err(|_| "Proposal review unavailable")?
        .authority
        .cancel(&repository_id, &review_id);
    Ok(())
}

/// Native main-window dismissal. It does not open an approval path or write source.
#[tauri::command]
pub(crate) async fn reject_proposal(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    proposal_id: String,
) -> Result<authority::Receipt, String> {
    check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrowserState>();
        let mut host = state
            .proposals
            .lock()
            .map_err(|_| "Proposal review unavailable")?;
        let (store, receipts) = stores(&app)?;
        let receipt = with_repository(&app, &repository_id, |repo| {
            host.authority.reject(repo, &store, &receipts, &proposal_id)
        })?;
        drop(host);
        super::questions::record_review_rejection(&app, &repository_id, &receipt);
        Ok(receipt)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn review_receipts(
    app: &tauri::AppHandle,
    repo: &repository_core::Repository,
) -> Result<Vec<authority::Receipt>, String> {
    let (_, receipts) = stores(app)?;
    receipts.with_lock(repo, || receipts.read_all(repo))
}
