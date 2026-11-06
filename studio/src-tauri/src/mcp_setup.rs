//! Fixed-argument Codex registration. No shell, auth changes or manuscript writes.
use serde::Serialize;
use std::os::unix::process::CommandExt;
use std::{
    ffi::OsString,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    pub available: bool,
    pub configured: bool,
    pub command: String,
}
pub(crate) struct Launch {
    pub studio: PathBuf,
    pub selection: PathBuf,
    pub codex: Option<PathBuf>,
}
fn stop(child: &mut std::process::Child) {
    if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
impl Launch {
    pub fn current(selection: PathBuf) -> Result<Self, String> {
        use std::os::unix::fs::PermissionsExt;
        let mut candidates = vec![
            PathBuf::from("/opt/homebrew/bin/codex"),
            PathBuf::from("/usr/local/bin/codex"),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            let root = PathBuf::from(home);
            if root.is_absolute() {
                candidates.extend([root.join(".local/bin/codex"), root.join(".cargo/bin/codex")]);
            }
        }
        let codex = candidates.into_iter().find(|path| {
            std::fs::metadata(path)
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        });
        let studio =
            std::env::current_exe().map_err(|_| "This app's MCP executable is unavailable")?;
        if !studio.is_absolute() || !selection.is_absolute() {
            return Err("MCP setup paths are unavailable".into());
        }
        Ok(Self {
            studio,
            selection,
            codex,
        })
    }
    fn server_args(&self) -> Vec<OsString> {
        vec![
            self.studio.as_os_str().into(),
            "--heinlein-mcp".into(),
            self.selection.as_os_str().into(),
        ]
    }
    pub fn info(&self) -> Info {
        let mut command = vec!["codex mcp add heinlein --".into()];
        command.extend(
            self.server_args()
                .iter()
                .map(|s| quote(&s.to_string_lossy())),
        );
        Info {
            available: self.codex.is_some(),
            configured: self.configured(),
            command: command.join(" "),
        }
    }
    fn matches(&self, bytes: &[u8]) -> bool {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            return false;
        };
        if value.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
            return false;
        }
        let transport = value.get("transport").unwrap_or(&value);
        transport.get("command").and_then(|v| v.as_str()) == self.studio.to_str()
            && transport
                .get("args")
                .and_then(|v| v.as_array())
                .is_some_and(|args| {
                    args.iter()
                        .map(|v| v.as_str())
                        .eq([Some("--heinlein-mcp"), self.selection.to_str()])
                })
            && transport
                .get("type")
                .and_then(|v| v.as_str())
                .is_none_or(|kind| kind == "stdio")
    }
    pub fn configured(&self) -> bool {
        self.run(&[
            "mcp".into(),
            "get".into(),
            "heinlein".into(),
            "--json".into(),
        ])
        .is_ok_and(|bytes| self.matches(&bytes))
    }
    pub fn connect(&self) -> Result<(), String> {
        if self.configured() {
            return Ok(());
        }
        let mut args = vec!["mcp".into(), "add".into(), "heinlein".into(), "--".into()];
        args.extend(self.server_args());
        self.run(&args).map_err(|_|"Codex setup did not complete. Check the connection before retrying; project access was not changed.")?;
        if !self.configured() {
            return Err(
                "Codex setup could not be verified. Check its Heinlein connection before retrying."
                    .into(),
            );
        }
        Ok(())
    }
    // Output may contain a client's environment settings: keep it bounded in an
    // unlinked private temporary file, never log or return it, and discard it.
    fn run(&self, args: &[OsString]) -> Result<Vec<u8>, ()> {
        let mut output = tempfile::tempfile().map_err(|_| ())?;
        let mut child = Command::new(self.codex.as_ref().ok_or(())?)
            .args(args)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output.try_clone().map_err(|_| ())?))
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ())?;
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let size = match output.metadata() {
                Ok(m) => m.len(),
                Err(_) => {
                    stop(&mut child);
                    return Err(());
                }
            };
            if size > 65536 || Instant::now() >= deadline {
                stop(&mut child);
                return Err(());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err(());
                    }
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => {
                    stop(&mut child);
                    return Err(());
                }
            }
        }
        output.seek(SeekFrom::Start(0)).map_err(|_| ())?;
        let mut bytes = vec![];
        output.take(65537).read_to_end(&mut bytes).map_err(|_| ())?;
        if bytes.len() > 65536 {
            return Err(());
        }
        Ok(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn launch() -> Launch {
        Launch {
            studio: PathBuf::from("/Applications/Writer's Studio.app/Contents/MacOS/studio"),
            selection: PathBuf::from("/private/saved selection"),
            codex: None,
        }
    }
    #[test]
    fn setup_requires_the_exact_enabled_stdio_command_and_profile() {
        let l = launch();
        let valid = json!({"enabled":true,"transport":{"type":"stdio","command":l.studio,"args":["--heinlein-mcp",l.selection],"env":{"private":"never surfaced"}}});
        assert!(l.matches(&serde_json::to_vec(&valid).unwrap()));
        let mut wrong = valid.clone();
        wrong["enabled"] = json!(false);
        assert!(!l.matches(&serde_json::to_vec(&wrong).unwrap()));
        let mut wrong = valid.clone();
        wrong["transport"]["args"] = json!(["--heinlein-mcp", "/another/profile"]);
        assert!(!l.matches(&serde_json::to_vec(&wrong).unwrap()));
        let mut wrong = valid;
        wrong["transport"]["args"] = json!(["--heinlein-mcp", l.selection, "extra"]);
        assert!(!l.matches(&serde_json::to_vec(&wrong).unwrap()));
        assert!(!l.matches(b"invalid"));
    }
    #[test]
    fn copy_command_quotes_paths_and_contains_no_configuration_secrets() {
        let info = launch().info();
        assert!(!info.available);
        assert!(!info.configured);
        assert!(info.command.contains("Writer'\\''s Studio.app"));
        assert!(info.command.contains("'/private/saved selection'"));
        assert!(!serde_json::to_string(&info)
            .unwrap()
            .contains("never surfaced"));
    }
    #[test]
    fn fake_codex_setup_is_verified_without_using_real_configuration() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("synthetic-config.json");
        let script = tmp.path().join("fake-codex");
        let mut l = launch();
        l.codex = Some(script.clone());
        let expected = json!({"enabled":true,"transport":{"type":"stdio","command":l.studio,"args":["--heinlein-mcp",l.selection]}});
        let body = format!(
            "#!/bin/sh\nif [ \"$2\" = get ]; then cat {}; else printf '%s' {} > {}; fi\n",
            quote(config.to_str().unwrap()),
            quote(&expected.to_string()),
            quote(config.to_str().unwrap())
        );
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(!l.configured());
        l.connect().unwrap();
        assert!(l.configured());
        std::fs::write(&script, "#!/bin/sh\nexit 1\n").unwrap();
        assert!(l.connect().is_err());
    }
    #[test]
    fn client_output_is_bounded_and_never_becomes_ui_status_text() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("fake-codex");
        std::fs::write(&path, "#!/bin/sh\nexec /usr/bin/head -c 70000 /dev/zero\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut l = launch();
        l.codex = Some(path);
        assert!(l.run(&["mcp".into()]).is_err());
        assert!(!l.info().configured);
    }
}
