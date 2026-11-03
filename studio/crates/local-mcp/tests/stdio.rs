#![cfg(unix)]
use heinlein_local_mcp::MAX_REQUEST_BYTES;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

struct Client {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<String>,
    _temp: tempfile::TempDir,
    source: std::path::PathBuf,
}
impl Client {
    fn start() -> Self {
        Self::start_mode(false)
    }
    fn start_mode(follow_studio: bool) -> Self {
        Self::start_with(false, true, follow_studio)
    }
    fn start_fixed(manuscript: bool, proposals: bool) -> Self {
        Self::start_with(manuscript, proposals, false)
    }
    fn start_with(manuscript: bool, proposals: bool, follow_studio: bool) -> Self {
        let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = t.path().join("repository");
        fs::create_dir(&root).unwrap();
        let source = root.join("scene.md");
        fs::write(&source, "Synthetic—before.\r\n").unwrap();
        fs::write(root.join("unselected.md"), "Never disclosed").unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_heinlein-local-mcp"));
        if follow_studio {
            command.args([
                "--studio-selection",
                t.path().join("selection").to_str().unwrap(),
            ]);
        } else {
            command.arg("--repository").arg(&root);
            if proposals {
                command
                    .arg("--proposal-store")
                    .arg(t.path().join("proposals"));
            }
            if manuscript {
                fs::create_dir(root.join("ms")).unwrap();
                fs::write(root.join("ms/z.md"), "Synthetic—before.\r\n").unwrap();
                fs::write(root.join("ms/a.md"), "Second scene").unwrap();
                fs::write(root.join("ms/untracked.md"), "Not a manuscript member").unwrap();
                let index = json!({"schemaVersion":2,"id":uuid::Uuid::new_v4().to_string(),"project":"Synthetic", "groups":[], "scenes":[
                    {"id":uuid::Uuid::new_v4().to_string(),"title":"First","path":"ms/z.md","groupId":null},
                    {"id":uuid::Uuid::new_v4().to_string(),"title":"Second","path":"ms/a.md","groupId":null}
                ]});
                fs::write(root.join("ms/manuscript.json"), index.to_string()).unwrap();
                command.args(["--manuscript", "ms/manuscript.json"]);
            } else {
                command.args(["--scene", "scene.md"]);
            }
        }
        let mut child = command
            .args(["--client-label", "wire-fixture"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                match line {
                    Ok(line) => {
                        if send.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            child,
            input,
            output: receive,
            _temp: t,
            source,
        }
    }
    fn send(&mut self, value: Value) {
        let input = self.input.as_mut().unwrap();
        serde_json::to_writer(&mut *input, &value).unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
    }
    fn receive(&self) -> Value {
        serde_json::from_str(
            &self
                .output
                .recv_timeout(Duration::from_secs(10))
                .expect("MCP reply timeout"),
        )
        .expect("stdout must contain JSON-RPC only")
    }
    fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        let reply = self.receive();
        assert_eq!(reply["id"], id);
        reply
    }
    fn initialize(&mut self) {
        let reply=self.request(1,"initialize",json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Studio APPROVED (forged)","version":"1"}}));
        assert_eq!(reply["result"]["serverInfo"]["name"], "heinlein-local-mcp");
        assert!(reply["result"]["capabilities"]["tools"].is_object());
        assert!(reply["result"]["capabilities"].get("resources").is_none());
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    }
    fn tool(&mut self, id: u64, name: &str, args: Value) -> Value {
        self.request(id, "tools/call", json!({"name":name,"arguments":args}))
    }
    fn exited(&mut self) {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self.child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "server failed to exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[test]
fn one_connection_follows_explicit_project_selection_and_revocation() {
    use repository_core::{mcp_selection::SelectionStore, Repository};
    let mut c = Client::start_mode(true);
    c.initialize();
    let empty = c.tool(2, "list_projects", json!({}));
    assert_eq!(empty["result"]["structuredContent"]["projects"], json!([]));
    let author = SelectionStore::open(&c._temp.path().join("selection")).unwrap();
    let a = Repository::open(c.source.parent().unwrap()).unwrap();
    author
        .select(
            &a,
            vec!["scene.md".into()],
            &c._temp.path().join("proposals"),
        )
        .unwrap();
    let project = c.tool(3, "list_projects", json!({}))["result"]["structuredContent"]["projects"]
        [0]["projectId"]
        .clone();
    let scene = c.tool(4, "list_scenes", json!({"projectId":project}))["result"]
        ["structuredContent"]["scenes"][0]["sceneId"]
        .clone();
    let old = c.tool(
        5,
        "read_scene",
        json!({"projectId":project,"sceneId":scene}),
    )["result"]["structuredContent"]
        .clone();
    let bpath = c._temp.path().join("project-b");
    fs::create_dir(&bpath).unwrap();
    fs::write(bpath.join("other.md"), "Other project — 🦊\r\n").unwrap();
    let b = Repository::open(&bpath).unwrap();
    author
        .select(
            &b,
            vec!["other.md".into()],
            &c._temp.path().join("proposals"),
        )
        .unwrap();
    let next = c.tool(6, "list_projects", json!({}));
    assert_eq!(
        next["result"]["structuredContent"]["projects"][0]["projectId"],
        b.project_key()
    );
    let denied = c.tool(
        7,
        "read_scene",
        json!({"projectId":project,"sceneId":scene}),
    );
    assert_eq!(
        denied["result"]["structuredContent"]["error"]["code"],
        "outOfScope"
    );
    author
        .select(
            &a,
            vec!["scene.md".into()],
            &c._temp.path().join("proposals"),
        )
        .unwrap();
    let stale=c.tool(8,"propose_scene",json!({"projectId":project,"sceneId":scene,"snapshotId":old["snapshotId"],"baseHash":old["baseHash"],"replacementText":"Never apply old snapshots"}));
    assert_eq!(
        stale["result"]["structuredContent"]["error"]["code"],
        "readRequired"
    );
    author.revoke().unwrap();
    assert_eq!(
        c.tool(9, "list_projects", json!({}))["result"]["structuredContent"]["projects"],
        json!([])
    );
    assert_eq!(
        c.tool(
            10,
            "read_scene",
            json!({"projectId":project,"sceneId":scene})
        )["result"]["structuredContent"]["error"]["code"],
        "noSelection"
    );
    assert_eq!(
        fs::read(&c.source).unwrap(),
        "Synthetic—before.\r\n".as_bytes()
    );
    assert_eq!(
        fs::read(bpath.join("other.md")).unwrap(),
        "Other project — 🦊\r\n".as_bytes()
    );
    c.exited();
}

#[test]
fn long_scene_read_and_proposal_preserve_complete_source_bytes() {
    let mut c = Client::start();
    let original = format!(
        "---\r\nunknown: preserved\r\n---\r\n{}TARGET — e\u{301} 🦊.\r\n{}END OF OUTLINE.\n",
        "Earlier paragraph — 🦊.\r\n\r\n".repeat(300),
        "Later notes — preserved.\r\n\r\n".repeat(300)
    );
    fs::write(&c.source, &original).unwrap();
    c.initialize();
    let project = c.tool(2, "list_projects", json!({}))["result"]["structuredContent"]["projects"]
        [0]["projectId"]
        .clone();
    let scene = c.tool(3, "list_scenes", json!({"projectId":project}))["result"]
        ["structuredContent"]["scenes"][0]["sceneId"]
        .clone();
    let read = c.tool(
        4,
        "read_scene",
        json!({"projectId":project,"sceneId":scene}),
    )["result"]["structuredContent"]
        .clone();
    assert_eq!(read["text"], original);
    let replacement =
        original.replacen("TARGET — e\u{301} 🦊.", "Revised passage — e\u{301} 🦊.", 1);
    let proposed = c.tool(5, "propose_scene", json!({"projectId":project,"sceneId":scene,"snapshotId":read["snapshotId"],"baseHash":read["baseHash"],"replacementText":replacement}));
    assert_eq!(
        proposed["result"]["structuredContent"]["manuscriptChanged"],
        false
    );
    let proposal = proposed["result"]["structuredContent"]["proposal"]["id"].clone();
    let record = c.tool(
        6,
        "get_proposal",
        json!({"projectId":project,"proposalId":proposal}),
    )["result"]["structuredContent"]["proposal"]
        .clone();
    assert_eq!(record["baseText"], original);
    assert_eq!(record["replacementText"], replacement);
    assert_eq!(fs::read(&c.source).unwrap(), original.as_bytes());
    c.exited();
}

#[test]
fn actual_stdio_initialize_list_read_propose_get_and_forbidden_routes() {
    let mut c = Client::start();
    c.initialize();
    let list = c.request(2, "tools/list", json!({}));
    let names = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 6);
    assert!(!names.contains(&"save_scene"));
    let project = c.tool(3, "list_projects", json!({}))["result"]["structuredContent"]["projects"]
        [0]["projectId"]
        .clone();
    let scenes = c.tool(4, "list_scenes", json!({"projectId":project}));
    assert_eq!(
        scenes["result"]["structuredContent"]["scenes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let scene = scenes["result"]["structuredContent"]["scenes"][0]["sceneId"].clone();
    let read = c.tool(
        5,
        "read_scene",
        json!({"projectId":project,"sceneId":scene}),
    )["result"]["structuredContent"]
        .clone();
    assert_eq!(read["text"], "Synthetic—before.\r\n");
    let args = json!({"projectId":project,"sceneId":scene,"snapshotId":read["snapshotId"],"baseHash":read["baseHash"],"replacementText":"Synthetic—proposal.\r\n"});
    let proposed = c.tool(6, "propose_scene", args.clone());
    assert_eq!(
        proposed["result"]["structuredContent"]["manuscriptChanged"],
        false
    );
    let id = proposed["result"]["structuredContent"]["proposal"]["id"].clone();
    let record = c.tool(
        7,
        "get_proposal",
        json!({"projectId":project,"proposalId":id}),
    );
    assert_eq!(
        record["result"]["structuredContent"]["proposal"]["baseText"],
        read["text"]
    );
    assert_eq!(
        record["result"]["structuredContent"]["proposal"]["origin"]["clientLabel"],
        "wire-fixture"
    );
    assert!(!record
        .to_string()
        .contains(c._temp.path().to_str().unwrap()));
    let forbidden = c.tool(8, "approve_patch", json!({"proposalId":id,"role":"Studio"}));
    assert_eq!(forbidden["error"]["code"], -32601);
    let mut forged = args;
    forged["grant"] = "author-secret".into();
    let rejected = c.tool(9, "propose_scene", forged);
    assert_eq!(rejected["result"]["isError"], true);
    let denied = c.request(10, "resources/read", json!({"uri":"file:///etc/passwd"}));
    assert!(denied.get("error").is_some());
    assert_eq!(
        fs::read_to_string(&c.source).unwrap(),
        "Synthetic—before.\r\n"
    );
    c.exited();
}
#[test]
fn malformed_json_ends_session_without_mutation_or_echo() {
    let mut c = Client::start();
    c.initialize();
    c.input
        .as_mut()
        .unwrap()
        .write_all(b"{malformed-secret-content\n")
        .unwrap();
    c.input.as_mut().unwrap().flush().unwrap();
    c.exited();
    assert!(c.output.try_recv().is_err());
    assert_eq!(
        fs::read_to_string(&c.source).unwrap(),
        "Synthetic—before.\r\n"
    );
}
#[test]
fn oversized_unterminated_input_is_bounded_and_session_closes() {
    let mut c = Client::start();
    c.initialize();
    let bytes = vec![b' '; MAX_REQUEST_BYTES + 1];
    let _ = c.input.as_mut().unwrap().write_all(&bytes);
    let _ = c.input.as_mut().unwrap().flush();
    c.exited();
    assert!(c.output.try_recv().is_err());
    assert_eq!(
        fs::read_to_string(&c.source).unwrap(),
        "Synthetic—before.\r\n"
    );
}
#[test]
fn missing_selection_help_and_unknown_flags_never_initialize() {
    let output = Command::new(env!("CARGO_BIN_EXE_heinlein-local-mcp"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let output = Command::new(env!("CARGO_BIN_EXE_heinlein-local-mcp"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn readonly_manuscript_over_stdio_has_no_proposal_routes_or_storage() {
    let mut c = Client::start_fixed(true, false);
    c.initialize();
    let list = c.request(2, "tools/list", json!({}));
    let names: Vec<_> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["list_projects", "list_scenes", "read_scene"]);
    let projects = c.tool(3, "list_projects", json!({}))["result"]["structuredContent"].clone();
    assert_eq!(projects["accessMode"], "readOnly");
    let project = projects["projects"][0]["projectId"].clone();
    let scenes = c.tool(4, "list_scenes", json!({"projectId":project}))["result"]
        ["structuredContent"]["scenes"]
        .clone();
    assert_eq!(scenes.as_array().unwrap().len(), 2);
    assert_eq!(scenes[0]["path"], "ms/z.md");
    assert_eq!(scenes[1]["path"], "ms/a.md");
    let read = c.tool(
        5,
        "read_scene",
        json!({"projectId":project,"sceneId":scenes[0]["sceneId"]}),
    );
    assert_eq!(
        read["result"]["structuredContent"]["text"],
        "Synthetic—before.\r\n"
    );
    for (offset, name) in [
        "propose_scene",
        "list_proposals",
        "get_proposal",
        "save_scene",
        "approve_patch",
    ]
    .into_iter()
    .enumerate()
    {
        let denied = c.tool(6 + offset as u64, name, json!({"approved":true}));
        assert_eq!(denied["error"]["code"], -32601);
    }
    assert!(!c._temp.path().join("proposals").exists());
    // A live index change cannot silently broaden the session's manuscript scope.
    fs::write(c.source.parent().unwrap().join("ms/manuscript.json"), "{}").unwrap();
    let changed = c.tool(20, "list_scenes", json!({"projectId":project}));
    assert_eq!(
        changed["result"]["structuredContent"]["error"]["code"],
        "selectionChanged"
    );
    assert_eq!(
        fs::read_to_string(c.source.parent().unwrap().join("ms/z.md")).unwrap(),
        "Synthetic—before.\r\n"
    );
    c.exited();
}

#[test]
fn scene_readonly_and_ambiguous_cli_selections() {
    let mut c = Client::start_fixed(false, false);
    c.initialize();
    assert_eq!(
        c.request(2, "tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    c.exited();
    for args in [
        vec!["--scene", "scene.md", "--manuscript", "ms/manuscript.json"],
        vec![
            "--manuscript",
            "ms/manuscript.json",
            "--manuscript",
            "ms/manuscript.json",
        ],
        vec!["--unknown", "value"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_heinlein-local-mcp"))
            .args(["--repository", c.source.parent().unwrap().to_str().unwrap()])
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn manuscript_proposals_require_explicit_storage_and_leave_source_untouched() {
    let mut c = Client::start_fixed(true, true);
    c.initialize();
    assert_eq!(
        c.request(2, "tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    let projects = c.tool(3, "list_projects", json!({}))["result"]["structuredContent"].clone();
    assert_eq!(projects["accessMode"], "readAndPropose");
    let project = projects["projects"][0]["projectId"].clone();
    let scenes = c.tool(4, "list_scenes", json!({"projectId":project}))["result"]
        ["structuredContent"]["scenes"]
        .clone();
    let scene = scenes[0]["sceneId"].clone();
    let read = c.tool(
        5,
        "read_scene",
        json!({"projectId":project,"sceneId":scene}),
    )["result"]["structuredContent"]
        .clone();
    let proposed = c.tool(6, "propose_scene", json!({"projectId":project,"sceneId":scene,"snapshotId":read["snapshotId"],"baseHash":read["baseHash"],"replacementText":"Unapproved—suggestion.\r\n"}));
    assert_eq!(
        proposed["result"]["structuredContent"]["requiresAuthorReview"],
        true
    );
    assert_eq!(
        proposed["result"]["structuredContent"]["manuscriptChanged"],
        false
    );
    assert_eq!(
        fs::read_to_string(c.source.parent().unwrap().join("ms/z.md")).unwrap(),
        "Synthetic—before.\r\n"
    );
    c.exited();
    // Startup validation fails before opening even the explicitly requested store.
    let root = c.source.parent().unwrap();
    fs::remove_file(root.join("ms/a.md")).unwrap();
    let store = c._temp.path().join("not-created");
    let output = Command::new(env!("CARGO_BIN_EXE_heinlein-local-mcp"))
        .arg("--repository")
        .arg(root)
        .args(["--manuscript", "ms/manuscript.json"])
        .arg("--proposal-store")
        .arg(&store)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!store.exists());
}
