# Scene navigator drawer

A third independent drawer follows the file browser and manuscript outline.
It lists the first nonblank line after each standalone `---` break in the open
source scene or assembled chapter. It excludes opening YAML frontmatter,
separators inside backtick/tilde fences, and four-space indented code. It does not
add an entry for prose before the first break, or an empty trailing break.

Entries retain normalized UTF-16 positions from the current CodeMirror document.
Repeated labels remain distinct. Activation selects that exact first line,
scrolls it into view, and returns keyboard focus to the editor. This also works
in the read-only assembled-chapter reader. It never edits, saves, or sends text.

Unsaved edits refresh entries after a 120ms debounce without moving focus. An
entry from an outdated document snapshot refuses navigation and refreshes the
list. Document switches clear the previous entries. The list is bounded to 500
entries; labels longer than 240 characters are abbreviated.

Collapse state shares the existing local convenience preference under the
independent `scenes` key. The command palette offers Show/Hide scene navigator.
Controls expose expanded state, their controlled body, passage numbers, current
location, visible focus, and targets at least 44px high. At narrow widths, three
collapsed drawers reserve a gutter for the source; shorter viewports can scroll
the drawer stack.

## Checkpoint

- Route: bounded workhorse implementation in the existing context; no delegation
  or model override.
- Evidence: 432 frontend tests pass; frontend and production Tauri builds pass.
  Rendered synthetic fixture verified at 1280×900 and 390×844: keyboard passage
  navigation, revision target mapping, live first-line updates, editable source
  save, no horizontal overflow, and no page errors.
- Browser plugin unavailable; rendered checks use bundled Playwright. The
  author's running desktop window is left intact; this change is prepared for
  delivery through a follow-up PR.
