# Source scenes, assembled chapters, and proposed revisions

Source scenes are the editable Markdown files. A manifest's chapter `source` may
name its first scene; that scene stays editable unless explicitly declared as a
generated output in `sources`. The chapter reading action is distinct from
opening that entry scene. An assembled chapter is a reading
view built from the current scene snapshots in manifest order. Its exported file
is never a save target. “Assembled” describes the file relationship, not whether
an author or a model wrote the prose.

Opening a mapped chapter reads its source scenes, strips their frontmatter for
the reading view, and retains an offset map into each original scene. This works
even when the exported chapter is stale or absent. Repeated passages resolve by
position, never text search. Raw CRLF and Unicode are preserved when the source is
opened and saved; offsets in the reading view use CodeMirror's normalized UTF-16.

Select a passage and choose **Revise source passage** (or Cmd/Ctrl+Alt+Enter).
Studio opens the source scene, verifies its full text and saved hash still match
the displayed snapshot, selects the same passage, and opens Questions in revision
mode. Nothing is sent or saved by navigation. The author can edit the source
directly, or explicitly request a proposed revision and use the existing exact
before/after review, native confirmation, receipt, and revert workflow.

Selections crossing scene boundaries require a narrower selection or an explicit
source-scene choice. Changed scenes open for inspection without a stale revision
target. Recovery failures remain visible and fail closed. Unmapped assembled
files remain readable, with an explanation to open their source scenes. Exported
chapter files are refreshed by the existing publishing build, not this view.

The reader supports keyboard selection, a focus indicator, an announced read-only
state, large labeled controls, and narrow reflow. Its editor is separate from the
source editor so save/recovery and temporary read-only changes cannot enable
chapter edits. Folder selection restores a temporary read-only setting only on
the editor that had that setting; a new source editor does not inherit it.

## Checkpoint

- Route: one bounded workhorse pass at ordinary implementation effort. Model
  switching was not enforced; the existing chat settings were retained.
- Scope: Studio document navigation, source mapping, terminology, and the native
  read-only error. No manuscript edits, AI sends, or publication.
- Evidence: 423 frontend tests pass, including repeated-text, CRLF/Unicode,
  stale-source, cross-scene, editable-source and save regression cases. 192 Rust core,
  proposal, MCP, questions, and auth tests pass; workspace Clippy passes.
- Rendered evidence: synthetic browser fixture at 1280×900 and 390×844;
  keyboard passage selection, opening the matching editable source, typed save,
  no horizontal document overflow, 19px source text, no page errors.
- Environment: Browser plugin unavailable; bundled Playwright used. Node 26 tests
  require NODE_OPTIONS=--no-experimental-webstorage to use jsdom localStorage.
- Native acceptance: production Tauri build and signature verification pass.
  The installed app opens a chapter whose entry file is also a source scene;
  keyboard selection opens its exact proposed-revision target. A synthetic source
  edit saved through the app was read back byte-for-byte with CRLF preserved;
  the exported chapter was unchanged. No model request was sent. An author-owned
  source scene was then opened and confirmed editable in the installed app,
  with no edits made to that manuscript.

- Final checks: 9 native question-host tests and 30 proposal-authority harness
  tests pass; authority-harness Clippy and workspace formatting pass. The
  installed app was verified with an editable author-owned source scene.
