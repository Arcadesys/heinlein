//! Studio also supplies the reusable stdio MCP executable. No GUI or auth startup.
use std::{ffi::OsString, path::PathBuf};
fn selection_argument(args: &[OsString]) -> Result<Option<PathBuf>, ()> {
    if args.first().is_none_or(|s| s != "--heinlein-mcp") {
        return Ok(None);
    }
    if args.len() != 2 {
        return Err(());
    }
    let path = PathBuf::from(&args[1]);
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(());
    }
    Ok(Some(path))
}
pub(crate) fn run_if_requested() -> bool {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let directory = match selection_argument(&args) {
        Ok(None) => return false,
        Ok(Some(directory)) => directory,
        Err(()) => {
            eprintln!("Use --heinlein-mcp with one absolute private selection directory");
            std::process::exit(64);
        }
    };
    let result = tauri::async_runtime::block_on(async {
        let server = heinlein_local_mcp::LocalMcp::follow_studio(&directory, "Codex".into())?;
        heinlein_local_mcp::serve_stdio(server).await
    });
    if result.is_err() {
        eprintln!("Heinlein MCP connection unavailable; check project access in Studio");
        std::process::exit(1);
    }
    true
}
#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }
    #[test]
    fn headless_entry_requires_an_explicit_exact_absolute_scope() {
        assert!(selection_argument(&args(&[])).unwrap().is_none());
        assert!(selection_argument(&args(&["scene.md"])).unwrap().is_none());
        assert!(selection_argument(&args(&["--heinlein-mcp"])).is_err());
        assert!(selection_argument(&args(&["--heinlein-mcp", "relative"])).is_err());
        assert!(selection_argument(&args(&["--heinlein-mcp", "/tmp/../outside"])).is_err());
        assert!(selection_argument(&args(&["--heinlein-mcp", "/tmp/private", "extra"])).is_err());
        assert_eq!(
            selection_argument(&args(&["--heinlein-mcp", "/tmp/private scope"])).unwrap(),
            Some(PathBuf::from("/tmp/private scope"))
        );
    }
}
