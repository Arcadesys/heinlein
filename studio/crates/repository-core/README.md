# Read-only repository core (pass 1)

`repository-core` is a native-host library. It has no write, patch, approval, grant,
release, publishing, network, shell, Git mutation, or model-provider API. Selecting
a repository does not import, copy, or alter its manuscript files.

## API

- `Repository::open(absolute_path)` opens a host-selected root; `root()` and `name()`
  are host-only identity helpers, not renderer path-selection capabilities
- `list(relative_directory)` returns directory-first sorted `Entry` values; `""`
  denotes the root
- `read(relative_document)` returns exact UTF-8 text and byte count, raw frontmatter
  interior (JSON or YAML, without interpretation), and a compatibility-source flag
- `discover()` returns sorted repository-relative `scene-manifest.json` paths
- `manuscript(relative_manifest)` validates schema version 1, preserves volume,
  chapter and scene array order, and returns repository-relative paths

DTO field names serialize as camelCase. `Error` implements safe path-free Display
messages. No absolute repository path appears in document, listing, or manuscript
DTOs. The host must never expose `open` or `root` directly to renderer arguments.

The manifest reader supports the real Singularity Log `volumes[].chapters[].scenes`
structure and recognizes `sources[].path` as generated compatibility documents.
It requires referenced files/directories to exist and be accessible. Scene paths
must be inside their chapter; chapters must be inside their volume; duplicate
scene references fail closed. Schema versions other than 1 are rejected. Other
manifest fields are not interpreted. The compatibility flag reports the manifest's
classification, not a cryptographic freshness or release-approval claim.

## Safety and limits

macOS/Linux are the first supported platforms. Non-Unix opens fail explicitly.
Every component of an absolute selected root and subsequent relative opens is
walked through directory descriptors with `O_NOFOLLOW`. Symlinks, including links
inside the same repository, are rejected. Root choices containing OS aliases such
as macOS `/var` or `/tmp` need the real, non-symlink path (for example `/private/...`).
Subsequent access remains anchored to the opened root descriptor.

Absolute paths, `..`, `.`, empty path segments, backslashes, colons, control
characters and paths over 4096 bytes are rejected. Files with unrepresentable
names are skipped during enumeration. Hidden entries, common build/cache trees,
known secret directories/filenames and credential/key extensions are excluded.
This is a conservative filename filter, not a content-based secret scanner: a
secret stored in an ordinary permitted manuscript name is still ordinary text.
Regular UTF-8 text with an approved extension is required; NUL/control-byte binary
content, devices, sockets, FIFOs and oversized files are not read as documents.

Repository and ancestor `.gitignore` files are read using the same no-follow
handles, with a 64 KiB limit. Invalid, oversized or symlinked ignore files fail
closed. Global ignore files, `.git/info/exclude`, Git configuration and external
programs are never consulted. Outer exclusions take priority over nested
negations; hidden/secret exclusions can never be re-included. Ignore rules are
not a substitute for an operating-system permission boundary.

- File reads: 2 MiB, including a bounded read that catches concurrent growth
- Manifest reads: 8 MiB; ignore files: 64 KiB
- Directory enumeration: 4096 raw entries, including excluded entries
- Recursive discovery: 20,000 visible entries, maximum 32 path components
- Manifest tree: 10,000 volumes/chapters/scenes

Limits return explicit errors rather than partial trees. Native hosts should keep
a repository open if optional discovery exceeds a limit, show that warning, and
allow individual directory navigation. No file watcher or snapshot transaction is
claimed: externally edited regular files can change between list/read operations.
Descriptor traversal prevents symlink escapes but does not claim isolation from a
privileged process, mount replacement, or an attacker controlling the OS account.

## Validation

From `studio/`:

```
cargo test -p repository-core
cargo clippy -p repository-core --all-targets -- -D warnings
HEINLEIN_ARCHIVE_ROOT=/absolute/non-symlink/archive/root \
  cargo test -p repository-core --test read_only real_archive_acceptance -- --ignored
```

The optional archive test reads the private fixture in place and asserts 95 scenes,
frontmatter availability and source classification. The fixture is not bundled.
Synthetic tests cover raw CRLF/Unicode preservation, traversal, excluded paths,
nested ignores, symlinks, a concurrent symlink replacement, FIFO rejection,
binary/oversize reads, bounded listings/depth and manifest ordering/validation.
