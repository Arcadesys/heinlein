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
        let t = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = t.path().join("repository");
        fs::create_dir(&root).unwrap();
        let source = root.join("scene.md");
        fs::write(&source, "Synthetic—before.\r\n").unwrap();
        fs::write(root.join("unselected.md"), "Never disclosed").unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_heinlein-local-mcp"))
            .args([
                "--repository",
                root.to_str().unwrap(),
                "--proposal-store",
                t.path().join("proposals").to_str().unwrap(),
                "--scene",
                "scene.md",
                "--client-label",
                "wire-fixture",
            ])
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
