use heinlein_local_mcp::{LocalMcp, Selection};
use std::path::PathBuf;

const USAGE: &str = "Usage: heinlein-local-mcp --studio-selection PRIVATE_ABSOLUTE_DIRECTORY [--client-label LABEL]\nOr: heinlein-local-mcp --repository ABSOLUTE_PATH (--manuscript RELATIVE_INDEX | --scene RELATIVE_MARKDOWN [--scene RELATIVE_MARKDOWN ...]) [--proposal-store PRIVATE_ABSOLUTE_PATH] [--client-label LABEL]\nLocal stdio only. Read-only by default. Optional proposal storage enables suggestions for native Studio review, never manuscript writes or approval. Index: ms/manuscript.json or scene-manifest.json. Restart after index changes. This command does not install client configuration or credentials.";

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        // Never print tool arguments, manuscripts, selected absolute paths, or credentials.
        eprintln!("heinlein-local-mcp: {message}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut repository = None;
    let mut store = None;
    let mut label = None;
    let mut scenes = Vec::new();
    let mut studio_selection = None;
    let mut manuscript = None;
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            eprintln!("{USAGE}");
            return Ok(());
        }
        let value = args.next().ok_or(USAGE)?;
        match arg.as_str() {
            "--repository" if repository.is_none() => repository = Some(PathBuf::from(value)),
            "--proposal-store" if store.is_none() => store = Some(PathBuf::from(value)),
            "--scene" => scenes.push(value),
            "--manuscript" if manuscript.is_none() => manuscript = Some(value),
            "--client-label" if label.is_none() => label = Some(value),
            "--studio-selection" if studio_selection.is_none() => {
                studio_selection = Some(PathBuf::from(value))
            }
            _ => return Err(USAGE.into()),
        }
    }
    let client_label = label.unwrap_or_else(|| "unspecified".into());
    let server = if let Some(directory) = studio_selection {
        if repository.is_some() || store.is_some() || !scenes.is_empty() || manuscript.is_some() {
            return Err(USAGE.into());
        }
        #[cfg(unix)]
        {
            LocalMcp::follow_studio(&directory, client_label)?
        }
        #[cfg(not(unix))]
        {
            let _ = (directory, client_label);
            return Err("Studio selection is unsupported on this platform".into());
        }
    } else {
        let selection = match manuscript {
            Some(path) if scenes.is_empty() => Selection::Manuscript(path),
            None if !scenes.is_empty() => Selection::Scenes(scenes),
            _ => return Err(USAGE.into()),
        };
        LocalMcp::open_selected(
            &repository.ok_or(USAGE)?,
            selection,
            store.as_deref(),
            client_label,
        )?
    };
    heinlein_local_mcp::serve_stdio(server).await
}
