use futures::{future, StreamExt};
use heinlein_local_mcp::{LocalMcp, MAX_REQUEST_BYTES};
use rmcp::{
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::async_rw::JsonRpcMessageCodec,
    RoleServer, ServiceExt,
};
use std::path::PathBuf;
use tokio_util::codec::{FramedRead, FramedWrite};

const USAGE: &str = "Usage: heinlein-local-mcp --studio-selection PRIVATE_ABSOLUTE_DIRECTORY [--client-label LABEL]\nOr: heinlein-local-mcp --repository ABSOLUTE_PATH --proposal-store PRIVATE_ABSOLUTE_PATH --scene RELATIVE_MARKDOWN [--scene RELATIVE_MARKDOWN ...] [--client-label LABEL]\nLocal stdio only. Reads and proposals only; no manuscript writes or approval. This command does not install client configuration or credentials.";

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
            "--client-label" if label.is_none() => label = Some(value),
            "--studio-selection" if studio_selection.is_none() => {
                studio_selection = Some(PathBuf::from(value))
            }
            _ => return Err(USAGE.into()),
        }
    }
    let client_label = label.unwrap_or_else(|| "unspecified".into());
    let server = if let Some(directory) = studio_selection {
        if repository.is_some() || store.is_some() || !scenes.is_empty() {
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
        LocalMcp::open(
            &repository.ok_or(USAGE)?,
            scenes,
            &store.ok_or(USAGE)?,
            client_label,
        )?
    };
    // The SDK's ordinary stdio reader is unbounded. Its official codec lets this
    // adapter bound JSON lines before parsing and close on malformed/oversized input.
    let input = FramedRead::new(
        tokio::io::stdin(),
        JsonRpcMessageCodec::<RxJsonRpcMessage<RoleServer>>::new_with_max_length(MAX_REQUEST_BYTES),
    )
    .take_while(|message| future::ready(message.is_ok()))
    .map(Result::unwrap);
    let output = FramedWrite::new(
        tokio::io::stdout(),
        JsonRpcMessageCodec::<TxJsonRpcMessage<RoleServer>>::default(),
    );
    server
        .serve((output, input))
        .await
        .map_err(|_| "MCP initialization failed")?
        .waiting()
        .await
        .map_err(|_| "MCP session ended unexpectedly")?;
    Ok(())
}
