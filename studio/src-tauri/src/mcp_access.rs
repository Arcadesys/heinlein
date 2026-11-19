//! Explicit native author selection for a reusable local MCP connection.
use repository_core::mcp_selection::{SelectionStore, State as SelectionState};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Status,
    UseProject {
        repository_id: String,
    },
    Setup {
        client: super::mcp_setup::Client,
    },
    /// Earlier Studio builds sent this before Claude clients existed.
    SetupCodex,
    UseSource {
        repository_id: String,
        path: String,
    },
    Revoke,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct View {
    project_key: Option<String>,
    scenes: Vec<String>,
    project_wide: bool,
    project_name: Option<String>,
    setups: Vec<super::mcp_setup::Info>,
}
fn store(app: &tauri::AppHandle) -> Result<SelectionStore, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "MCP selection unavailable")?
        .join("mcp-selection-v1");
    SelectionStore::open(&path).map_err(|_| "MCP selection storage is unavailable or unsafe".into())
}
fn view(
    state: Option<SelectionState>,
    setups: Vec<super::mcp_setup::Info>,
) -> Result<View, String> {
    let selection = state.and_then(|s| s.selection);
    let Some(selection) = selection else {
        return Ok(View {
            project_key: None,
            scenes: vec![],
            project_wide: false,
            project_name: None,
            setups,
        });
    };
    let repo = selection.repository().map_err(|_| {
        "The allowed MCP project moved or is unavailable; disconnect access before choosing another"
    })?;
    Ok(View {
        project_key: Some(repo.project_key()),
        scenes: selection
            .sources()
            .map_err(|_| "Project sources are unavailable or exceed the supported limits")?,
        project_wide: selection.project_wide,
        project_name: Some(repo.name()),
        setups,
    })
}
fn setup(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    store: &SelectionStore,
    launch: &super::mcp_setup::Launch,
    client: super::mcp_setup::Client,
) -> Result<View, String> {
    use super::mcp_setup::Client;
    let name = client.name();
    let info = launch.info(client);
    if !info.configured {
        if !info.available {
            return Err(match client {
                Client::Codex => "Codex was not found. Install its CLI or copy the setup command.",
                Client::ClaudeCode => {
                    "Claude Code was not found. Install it or copy the setup command."
                }
                Client::ClaudeDesktop => {
                    "Claude Desktop was not found. Install and open it once, or copy the setup text."
                }
            }
            .into());
        }
        let (changes, next) = match client {
            Client::Codex => ("only Codex's Heinlein MCP entry", "Start a new Codex chat after setup."),
            Client::ClaudeCode => (
                "only Claude Code's user-level Heinlein MCP entry",
                "Start a new Claude Code session after setup.",
            ),
            Client::ClaudeDesktop => (
                "only the Heinlein entry in Claude Desktop's settings file, keeping a backup of the previous file",
                "Quit and reopen Claude Desktop after setup.",
            ),
        };
        let message = format!("Set up {name} to use Heinlein? This updates {changes}, replacing any previous configuration for that entry. It does not allow project access or change your writing. {next}");
        if !app
            .dialog()
            .message(message)
            .title(format!("Connect {name} to Heinlein"))
            .buttons(MessageDialogButtons::OkCancel)
            .parent(window)
            .blocking_show()
        {
            return view(
                store.load().map_err(|_| "MCP selection unavailable")?,
                launch.infos(),
            );
        }
        super::check_window(window)?;
        launch.connect(client)?;
    }
    view(
        store.load().map_err(|_| "MCP selection unavailable")?,
        launch.infos(),
    )
}
#[tauri::command]
pub(crate) async fn mcp_access_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<View, String> {
    super::check_window(&window)?;
    tauri::async_runtime::spawn_blocking(move||{
        let store=store(&app)?;
        let selection_dir=app.path().app_data_dir().map_err(|_|"MCP selection unavailable")?.join("mcp-selection-v1");
        let launch=super::mcp_setup::Launch::current(selection_dir)?;
        match request{
            Request::Status=>view(store.load().map_err(|_|"MCP selection needs recovery; original data preserved")?,launch.infos()),
            Request::Revoke=>view(Some(store.revoke().map_err(|_|"MCP access could not be disconnected; retry when current tools finish")?),launch.infos()),
            Request::Setup{client}=>setup(&app,&window,&store,&launch,client),
            Request::SetupCodex=>setup(&app,&window,&store,&launch,super::mcp_setup::Client::Codex),
            Request::UseProject{repository_id}=>{
                let state=app.state::<super::BrowserState>();
                let _selection=state.selection_gate.try_lock().map_err(|_|"Finish the current project change first")?;
                if state.quitting.load(Ordering::SeqCst) {return Err("Heinlein is closing".into());}
                let data=app.path().app_data_dir().map_err(|_|"MCP selection unavailable")?;
                super::with_repository(&app,&repository_id,|repo|{
                    let sources=repo.mcp_project_sources().map_err(|_|"Project sources are unavailable or exceed the supported limits")?;
                    let previous=store.load().map_err(|_|"MCP selection needs recovery; original data preserved")?;
                    let expected=previous.as_ref().map(|s|s.generation.as_str());
                    let message=format!("Allow the connected MCP client to read saved Markdown in {} and suggest revisions?\n\nThis includes {} current source files, references, and new saved Markdown added to this project. Hidden files, ignored files, generated copies and symbolic links stay excluded. The client may send this text to its model provider.\n\nThis replaces access to another project. It does not expose unsaved writing or allow saves, approval or publishing. You review proposals in Heinlein before applying them.",repo.name(),sources.len());
                    if !app.dialog().message(message).title("Allow this project").buttons(MessageDialogButtons::OkCancel).parent(&window).blocking_show() {return view(store.load().map_err(|_|"MCP selection unavailable")?,launch.infos());}
                    super::check_window(&window)?;
                    if state.quitting.load(Ordering::SeqCst) {return Err("Heinlein is closing".into());}
                    view(Some(store.select_project_checked(repo,&data.join("pending-proposals-v1"),expected).map_err(|_|"Project access changed or could not be saved; check the connection before retrying")?),launch.infos())
                })
            }
            Request::UseSource{repository_id,path}=>{
                let state=app.state::<super::BrowserState>();
                let _selection=state.selection_gate.try_lock().map_err(|_|"Finish the current project change first")?;
                if state.quitting.load(Ordering::SeqCst)||state.unsaved_changes.load(Ordering::SeqCst){return Err("Save your writing and resolve recovery before allowing MCP access".into());}
                let data=app.path().app_data_dir().map_err(|_|"MCP selection unavailable")?;
                super::with_repository(&app,&repository_id,|repo|{
                    let source=repo.read(&path).map_err(|_|"Open an existing source Markdown file first")?;
                    if source.generated_compatibility||!matches!(std::path::Path::new(&path).extension().and_then(|s|s.to_str()).map(str::to_ascii_lowercase).as_deref(),Some("md"|"markdown")){return Err("Only source Markdown files can be allowed".into());}
                    let previous=store.load().map_err(|_|"MCP selection needs recovery; original data preserved")?;
                    let expected_generation=previous.as_ref().map(|s|s.generation.clone());
                    let mut paths=previous.and_then(|s|s.selection).filter(|s|s.repository==repo.root()).map(|s|s.scenes).unwrap_or_default();
                    if !paths.contains(&path){paths.push(path.clone());}
                    if paths.len()>128{return Err("At most 128 source files can be allowed at once".into());}
                    let message=format!("Allow the connected local MCP client to read these saved source files and propose revisions?\n\n{}\n\n{}\n\nThe client can send this text to its configured model provider. This replaces any other project's MCP selection. It does not allow manuscript saves, approval, publishing, or unsaved-buffer reads.",repo.name(),paths.join("\n"));
                    if !app.dialog().message(message).title("Heinlein: allow MCP source access").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).parent(&window).blocking_show(){return view(store.load().map_err(|_|"MCP selection unavailable")?,launch.infos());}
                    super::check_window(&window)?;
                    if state.quitting.load(Ordering::SeqCst)||state.unsaved_changes.load(Ordering::SeqCst){return Err("Writing changed; save and choose MCP access again".into());}
                    view(Some(store.select_checked(repo,paths,&data.join("pending-proposals-v1"),expected_generation.as_deref()).map_err(|_|"MCP selection changed or could not be saved; inspect the connection before retrying")?),launch.infos())
                })
            }
        }
    }).await.map_err(|_|"MCP connection operation unavailable")?
}
