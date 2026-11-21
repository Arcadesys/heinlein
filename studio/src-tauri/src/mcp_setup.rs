//! Fixed-argument MCP client registration for Codex, Claude Code and Claude
//! Desktop. No shell, auth changes or manuscript writes.
use serde::{Deserialize, Serialize};
use std::os::unix::process::CommandExt;
use std::{
    ffi::OsString,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
/// An MCP client that Heinlein can register itself with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Client {
    Codex,
    ClaudeCode,
    ClaudeDesktop,
}
impl Client {
    pub const ALL: [Client; 3] = [Client::Codex, Client::ClaudeCode, Client::ClaudeDesktop];
    pub fn name(self) -> &'static str {
        match self {
            Client::Codex => "Codex",
            Client::ClaudeCode => "Claude Code",
            Client::ClaudeDesktop => "Claude Desktop",
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    pub client: Client,
    pub available: bool,
    pub configured: bool,
    pub command: String,
}
pub(crate) struct Launch {
    pub studio: PathBuf,
    pub selection: PathBuf,
    pub home: Option<PathBuf>,
    pub codex: Option<PathBuf>,
    pub claude: Option<PathBuf>,
}
const SERVER: &str = "heinlein";
/// Claude Code keeps user-scoped servers in `~/.claude.json` alongside other
/// state, so the file can be large; reads stay bounded.
const CONFIG_LIMIT: u64 = 32 * 1024 * 1024;
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
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}
fn find(home: Option<&Path>, name: &str, extra: &[&str]) -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
    ];
    if let Some(root) = home {
        candidates.extend([
            root.join(".local/bin").join(name),
            root.join(".cargo/bin").join(name),
        ]);
        candidates.extend(extra.iter().map(|path| root.join(path)));
    }
    candidates.into_iter().find(|path| executable(path))
}
/// Read a JSON config file without following it past the size limit.
/// `Ok(None)` means the file does not exist.
fn read_json(path: &Path) -> Result<Option<serde_json::Value>, ()> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let mut bytes = vec![];
    file.take(CONFIG_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err(());
    }
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Some(serde_json::json!({})));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| ())
}
impl Launch {
    pub fn current(selection: PathBuf) -> Result<Self, String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|root| root.is_absolute());
        let codex = find(home.as_deref(), "codex", &[]);
        let claude = find(home.as_deref(), "claude", &[".claude/local/claude"]);
        let studio =
            std::env::current_exe().map_err(|_| "This app's MCP executable is unavailable")?;
        if !studio.is_absolute() || !selection.is_absolute() {
            return Err("MCP setup paths are unavailable".into());
        }
        Ok(Self {
            studio,
            selection,
            home,
            codex,
            claude,
        })
    }
    fn server_args(&self) -> Vec<OsString> {
        vec![
            self.studio.as_os_str().into(),
            "--heinlein-mcp".into(),
            self.selection.as_os_str().into(),
        ]
    }
    fn shell_command(&self, prefix: &str) -> String {
        let mut command = vec![prefix.to_string()];
        command.extend(
            self.server_args()
                .iter()
                .map(|s| quote(&s.to_string_lossy())),
        );
        command.join(" ")
    }
    /// The stdio server entry that Claude Desktop and Claude Code store.
    fn server_entry(&self) -> Result<serde_json::Value, String> {
        let (Some(studio), Some(selection)) = (self.studio.to_str(), self.selection.to_str())
        else {
            return Err("MCP setup paths cannot be written as configuration text".into());
        };
        Ok(serde_json::json!({
            "command": studio,
            "args": ["--heinlein-mcp", selection],
        }))
    }
    fn claude_code_config(&self) -> Option<PathBuf> {
        self.home.as_ref().map(|root| root.join(".claude.json"))
    }
    fn desktop_dir(&self) -> Option<PathBuf> {
        self.home
            .as_ref()
            .map(|root| root.join("Library/Application Support/Claude"))
    }
    fn desktop_config(&self) -> Option<PathBuf> {
        self.desktop_dir()
            .map(|dir| dir.join("claude_desktop_config.json"))
    }
    pub fn infos(&self) -> Vec<Info> {
        Client::ALL
            .iter()
            .map(|client| self.info(*client))
            .collect()
    }
    pub fn info(&self, client: Client) -> Info {
        let (available, command) = match client {
            Client::Codex => (
                self.codex.is_some(),
                self.shell_command("codex mcp add heinlein --"),
            ),
            Client::ClaudeCode => (
                self.claude.is_some(),
                self.shell_command("claude mcp add --scope user heinlein --"),
            ),
            Client::ClaudeDesktop => (
                self.desktop_dir().is_some_and(|dir| dir.is_dir()),
                self.server_entry()
                    .map(|entry| {
                        serde_json::to_string_pretty(
                            &serde_json::json!({"mcpServers": {SERVER: entry}}),
                        )
                        .unwrap_or_default()
                    })
                    .unwrap_or_default(),
            ),
        };
        Info {
            client,
            available,
            configured: self.configured(client),
            command,
        }
    }
    fn matches_value(&self, value: &serde_json::Value) -> bool {
        if value.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
            return false;
        }
        let transport = value.get("transport").unwrap_or(value);
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
    fn matches(&self, bytes: &[u8]) -> bool {
        serde_json::from_slice::<serde_json::Value>(bytes)
            .is_ok_and(|value| self.matches_value(&value))
    }
    fn file_entry_matches(&self, path: Option<PathBuf>) -> bool {
        path.and_then(|path| read_json(&path).ok().flatten())
            .and_then(|config| config.get("mcpServers")?.get(SERVER).cloned())
            .is_some_and(|entry| self.matches_value(&entry))
    }
    pub fn configured(&self, client: Client) -> bool {
        match client {
            Client::Codex => self
                .run(
                    self.codex.as_deref(),
                    &["mcp".into(), "get".into(), SERVER.into(), "--json".into()],
                )
                .is_ok_and(|bytes| self.matches(&bytes)),
            // `claude mcp get` prints text only; read the user-scope entry
            // that `claude mcp add --scope user` writes instead.
            Client::ClaudeCode => self.file_entry_matches(self.claude_code_config()),
            Client::ClaudeDesktop => self.file_entry_matches(self.desktop_config()),
        }
    }
    pub fn connect(&self, client: Client) -> Result<(), String> {
        if self.configured(client) {
            return Ok(());
        }
        let name = client.name();
        match client {
            Client::Codex => {
                let mut args = vec!["mcp".into(), "add".into(), SERVER.into(), "--".into()];
                args.extend(self.server_args());
                self.run(self.codex.as_deref(), &args).map_err(|_| {
                    format!("{name} setup did not complete. Check the connection before retrying; project access was not changed.")
                })?;
            }
            Client::ClaudeCode => {
                // `claude mcp add` refuses to overwrite an existing entry, so a
                // stale Heinlein entry is removed first. Failure here only means
                // there was nothing to remove.
                let _ = self.run(
                    self.claude.as_deref(),
                    &[
                        "mcp".into(),
                        "remove".into(),
                        "--scope".into(),
                        "user".into(),
                        SERVER.into(),
                    ],
                );
                let mut args = vec![
                    "mcp".into(),
                    "add".into(),
                    "--scope".into(),
                    "user".into(),
                    SERVER.into(),
                    "--".into(),
                ];
                args.extend(self.server_args());
                self.run(self.claude.as_deref(), &args).map_err(|_| {
                    format!("{name} setup did not complete. Check the connection before retrying; project access was not changed.")
                })?;
            }
            Client::ClaudeDesktop => self.write_desktop_entry()?,
        }
        if !self.configured(client) {
            return Err(format!(
                "{name} setup could not be verified. Check its Heinlein connection before retrying."
            ));
        }
        Ok(())
    }
    /// Add or replace only `mcpServers.heinlein` in Claude Desktop's config.
    /// Every other key is preserved. The previous file is kept as a backup and
    /// the new one replaces it atomically. An unreadable file is never touched.
    fn write_desktop_entry(&self) -> Result<(), String> {
        const UNREADABLE: &str = "Claude Desktop's settings file could not be read, so it was not changed. Use the manual setup below.";
        let (Some(dir), Some(path)) = (self.desktop_dir(), self.desktop_config()) else {
            return Err("Claude Desktop was not found on this Mac.".into());
        };
        if !dir.is_dir() {
            return Err("Claude Desktop was not found on this Mac.".into());
        }
        let existing = read_json(&path).map_err(|_| UNREADABLE)?;
        let mut config = existing.clone().unwrap_or_else(|| serde_json::json!({}));
        let root = config.as_object_mut().ok_or(UNREADABLE)?;
        let servers = root
            .entry("mcpServers")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or(UNREADABLE)?;
        servers.insert(SERVER.into(), self.server_entry()?);
        let mut bytes = serde_json::to_vec_pretty(&config).map_err(|_| UNREADABLE)?;
        bytes.push(b'\n');
        const FAILED: &str =
            "Claude Desktop's settings could not be saved. Its previous settings were not changed.";
        if existing.is_some() {
            std::fs::copy(
                &path,
                dir.join("claude_desktop_config.json.heinlein-backup"),
            )
            .map_err(|_| FAILED)?;
        }
        let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(|_| FAILED)?;
        if let Ok(meta) = std::fs::metadata(&path) {
            let _ = temp.as_file().set_permissions(meta.permissions());
        }
        temp.write_all(&bytes).map_err(|_| FAILED)?;
        temp.as_file().sync_all().map_err(|_| FAILED)?;
        temp.persist(&path).map_err(|_| FAILED)?;
        if let Ok(handle) = std::fs::File::open(&dir) {
            let _ = handle.sync_all();
        }
        Ok(())
    }
    // Output may contain a client's environment settings: keep it bounded in an
    // unlinked private temporary file, never log or return it, and discard it.
    fn run(&self, program: Option<&Path>, args: &[OsString]) -> Result<Vec<u8>, ()> {
        let mut output = tempfile::tempfile().map_err(|_| ())?;
        let mut child = Command::new(program.ok_or(())?)
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
    use std::os::unix::fs::PermissionsExt;
    fn launch() -> Launch {
        Launch {
            studio: PathBuf::from("/Applications/Writer's Studio.app/Contents/MacOS/studio"),
            selection: PathBuf::from("/private/saved selection"),
            home: None,
            codex: None,
            claude: None,
        }
    }
    fn script(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
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
        let l = launch();
        let info = l.info(Client::Codex);
        assert!(!info.available);
        assert!(!info.configured);
        assert!(info.command.contains("Writer'\\''s Studio.app"));
        assert!(info.command.contains("'/private/saved selection'"));
        assert!(!serde_json::to_string(&info)
            .unwrap()
            .contains("never surfaced"));
        let claude = l.info(Client::ClaudeCode);
        assert!(claude
            .command
            .starts_with("claude mcp add --scope user heinlein -- '/Applications/Writer'\\''s"));
        let desktop: serde_json::Value =
            serde_json::from_str(&l.info(Client::ClaudeDesktop).command).unwrap();
        assert!(l.matches_value(&desktop["mcpServers"]["heinlein"]));
        assert_eq!(
            serde_json::to_value(l.infos().iter().map(|i| i.client).collect::<Vec<_>>()).unwrap(),
            json!(["codex", "claudeCode", "claudeDesktop"])
        );
    }
    #[test]
    fn fake_codex_setup_is_verified_without_using_real_configuration() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("synthetic-config.json");
        let fake = tmp.path().join("fake-codex");
        let mut l = launch();
        l.codex = Some(fake.clone());
        let expected = json!({"enabled":true,"transport":{"type":"stdio","command":l.studio,"args":["--heinlein-mcp",l.selection]}});
        script(
            &fake,
            &format!(
                "#!/bin/sh\nif [ \"$2\" = get ]; then cat {}; else printf '%s' {} > {}; fi\n",
                quote(config.to_str().unwrap()),
                quote(&expected.to_string()),
                quote(config.to_str().unwrap())
            ),
        );
        assert!(!l.configured(Client::Codex));
        l.connect(Client::Codex).unwrap();
        assert!(l.configured(Client::Codex));
        script(&fake, "#!/bin/sh\nexit 1\n");
        assert!(l.connect(Client::Codex).is_err());
    }
    #[test]
    fn fake_claude_code_setup_replaces_a_stale_entry_and_verifies_user_config() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let config = home.join(".claude.json");
        let log = tmp.path().join("calls");
        let fake = tmp.path().join("fake-claude");
        let mut l = launch();
        l.home = Some(home);
        l.claude = Some(fake.clone());
        // A stale entry pointing at an old app location, plus unrelated state.
        std::fs::write(
            &config,
            json!({"projects":{"/x":{}},"mcpServers":{"heinlein":{"type":"stdio","command":"/old/studio","args":["--heinlein-mcp","/old"]}}}).to_string(),
        )
        .unwrap();
        let fresh = json!({"projects":{"/x":{}},"mcpServers":{"heinlein":{"type":"stdio","command":l.studio,"args":["--heinlein-mcp",l.selection],"env":{}}}});
        script(
            &fake,
            &format!(
                "#!/bin/sh\necho \"$@\" >> {log}\nif [ \"$2\" = add ]; then printf '%s' {fresh} > {config}; fi\n",
                log = quote(log.to_str().unwrap()),
                fresh = quote(&fresh.to_string()),
                config = quote(config.to_str().unwrap())
            ),
        );
        assert!(!l.configured(Client::ClaudeCode));
        assert!(l.info(Client::ClaudeCode).available);
        l.connect(Client::ClaudeCode).unwrap();
        assert!(l.configured(Client::ClaudeCode));
        let calls = std::fs::read_to_string(&log).unwrap();
        let mut lines = calls.lines();
        assert_eq!(lines.next(), Some("mcp remove --scope user heinlein"));
        assert!(lines
            .next()
            .unwrap()
            .starts_with("mcp add --scope user heinlein -- /Applications/Writer's Studio.app"));
        // Already configured: no further client calls.
        l.connect(Client::ClaudeCode).unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), calls);
    }
    #[test]
    fn claude_code_setup_that_writes_nothing_is_not_reported_as_configured() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("fake-claude");
        script(&fake, "#!/bin/sh\nexit 0\n");
        let mut l = launch();
        l.home = Some(tmp.path().to_path_buf());
        l.claude = Some(fake);
        assert!(l
            .connect(Client::ClaudeCode)
            .unwrap_err()
            .contains("could not be verified"));
    }
    #[test]
    fn claude_desktop_entry_is_merged_preserving_other_settings_with_a_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Library/Application Support/Claude");
        let mut l = launch();
        l.home = Some(tmp.path().to_path_buf());
        // Not installed: unavailable and refuses to create anything.
        assert!(!l.info(Client::ClaudeDesktop).available);
        assert!(l.connect(Client::ClaudeDesktop).is_err());
        assert!(!dir.exists());
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("claude_desktop_config.json");
        let original = json!({"theme":"dark","mcpServers":{"other":{"command":"/bin/other","args":[]},"heinlein":{"command":"/old","args":[]}}});
        std::fs::write(&path, original.to_string()).unwrap();
        assert!(l.info(Client::ClaudeDesktop).available);
        assert!(!l.configured(Client::ClaudeDesktop));
        l.connect(Client::ClaudeDesktop).unwrap();
        assert!(l.configured(Client::ClaudeDesktop));
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["theme"], "dark");
        assert_eq!(
            saved["mcpServers"]["other"],
            original["mcpServers"]["other"]
        );
        assert!(l.matches_value(&saved["mcpServers"]["heinlein"]));
        let backup: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.join("claude_desktop_config.json.heinlein-backup")).unwrap(),
        )
        .unwrap();
        assert_eq!(backup, original);
        // Idempotent: a second connect leaves the file byte-for-byte unchanged.
        let before = std::fs::read(&path).unwrap();
        l.connect(Client::ClaudeDesktop).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    #[test]
    fn claude_desktop_creates_a_missing_config_and_never_rewrites_an_invalid_one() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Library/Application Support/Claude");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("claude_desktop_config.json");
        let mut l = launch();
        l.home = Some(tmp.path().to_path_buf());
        l.connect(Client::ClaudeDesktop).unwrap();
        assert!(l.configured(Client::ClaudeDesktop));
        assert!(!dir
            .join("claude_desktop_config.json.heinlein-backup")
            .exists());
        for invalid in ["{\"mcpServers\": ", "[1,2]", "{\"mcpServers\": []}"] {
            std::fs::write(&path, invalid).unwrap();
            assert!(l.connect(Client::ClaudeDesktop).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
        }
    }
    #[test]
    fn client_output_is_bounded_and_never_becomes_ui_status_text() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("fake-codex");
        script(&path, "#!/bin/sh\nexec /usr/bin/head -c 70000 /dev/zero\n");
        let mut l = launch();
        l.codex = Some(path);
        assert!(l.run(l.codex.as_deref(), &["mcp".into()]).is_err());
        assert!(!l.info(Client::Codex).configured);
    }
}
