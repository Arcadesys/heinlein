//! Durable repository chat history, separate from manuscript/proposal authority.
use crate::{check_window, BrowserState};
use drafting_questions::{QuestionAnswer, QuestionError, QuestionRequest};
use repository_core::{ChatEvent, ChatThread, ChatTranscript, Repository};
use serde::Deserialize;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn repository(app: &tauri::AppHandle, id: &str) -> Result<Arc<Repository>, String> {
    let state = app.state::<BrowserState>();
    let selected = state
        .selected
        .lock()
        .map_err(|_| "Repository unavailable")?;
    let selected = selected.as_ref().ok_or("Open a repository first")?;
    if selected.id != id {
        return Err("Repository changed; reopen the chat".into());
    }
    Ok(Arc::clone(&selected.repo))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChatTarget {
    pub repository_id: String,
    pub thread_id: String,
    pub source_path: String,
}
pub(crate) struct ChatRecording {
    repo: Arc<Repository>,
    thread_id: String,
    request_id: String,
}
impl ChatRecording {
    pub fn begin(
        app: &tauri::AppHandle,
        target: ChatTarget,
        request: &QuestionRequest,
        model: &str,
    ) -> Result<Self, String> {
        if target.source_path.len() > 4096 {
            return Err("Invalid chat source label".into());
        }
        let recording = Self {
            repo: repository(app, &target.repository_id)?,
            thread_id: target.thread_id,
            request_id: request.request_id.clone(),
        };
        recording.append("question", serde_json::json!({"question":request.question,"context":request.context,"history":request.history,"model":model,"sourcePath":target.source_path}))?;
        Ok(recording)
    }
    fn append(&self, kind: &str, data: serde_json::Value) -> Result<(), String> {
        self.repo.append_chat_event(&self.thread_id, &ChatEvent {schema_version:1, request_id:self.request_id.clone(), kind:kind.into(), created_at:now(), data})
            .map_err(|_| "Chat could not be saved in .heinlein/chats/. Existing records were preserved. Check repository access and disk space; no request is retried automatically.".into())
    }
    pub fn finish(&self, answer: &Result<QuestionAnswer, QuestionError>) -> Result<(), String> {
        match answer {
            Ok(answer) => self.append(
                "answer",
                serde_json::to_value(answer).map_err(|_| "Chat answer serialization failed")?,
            ),
            Err(error) => self.append(
                "error",
                serde_json::to_value(error).map_err(|_| "Chat error serialization failed")?,
            ),
        }
    }
}
#[tauri::command]
pub(crate) async fn list_chat_threads(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
) -> Result<Vec<ChatThread>, String> {
    check_window(&window)?;
    let repo = repository(&app, &repository_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        repo.chat_threads().map_err(|_| {
            "Saved chats could not be read. Existing files were preserved.".to_string()
        })
    })
    .await
    .map_err(|_| "Chat reader unavailable")?
}
#[tauri::command]
pub(crate) async fn read_chat_thread(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    thread_id: String,
) -> Result<ChatTranscript, String> {
    check_window(&window)?;
    let repo = repository(&app, &repository_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        repo.chat_transcript(&thread_id).map_err(|_| {
            "This saved chat could not be read. Existing files were preserved.".to_string()
        })
    })
    .await
    .map_err(|_| "Chat reader unavailable")?
}
#[tauri::command]
pub(crate) async fn create_chat_thread(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    repository_id: String,
    title: String,
) -> Result<ChatThread, String> {
    check_window(&window)?;
    let repo = repository(&app, &repository_id)?;
    let thread = ChatThread {
        schema_version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        title: title.trim().chars().take(100).collect(),
        created_at: now(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        repo.create_chat(&thread)
            .map_err(|_| "A chat thread could not be created. No question was sent.".to_string())?;
        Ok(thread)
    })
    .await
    .map_err(|_| "Chat writer unavailable")?
}
