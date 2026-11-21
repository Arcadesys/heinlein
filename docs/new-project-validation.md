# New local project flow validation

Date: 2026-11-05. Base: `a43bf08`.

## Change

The Projects screen previously combined starting and opening under “Start or open a
folder…”, which called only the existing-folder picker. It now has separate New
project and Open an existing folder actions. A new project gets a named local
folder, a manuscript index, and one empty First scene. Parent selection and final
confirmation are native. Names are bounded and validated. Publication reuses the
existing descriptor-bound, no-overwrite project writer. Current writing is saved
through the existing leave guards; it is not copied into the new project.

Cancel keeps the current writing and entered name. Repeated clicks cannot launch
parallel operations. Failures after creation warn that the folder may already
exist and direct the author to inspect/open it before retrying. Folder-open errors
no longer describe a failed save when no save was attempted.

The screenshot's original filesystem failure is not reproduced: the chosen path
and exact steps were not available. This change repairs the ambiguous creation
flow and error reporting; it does not claim a proven cause for that I/O failure.

## Passed

- Canonical `python3 tools/validate.py renderer`: 1,255 tests and production web
  build. The final focus-restoration adjustment was additionally checked by all
  seven Projects unit tests and the browser suite below.
- `cargo test -p heinlein-studio --bin heinlein-studio`: 172 passed, two existing
  ignored tests (explicit real-converter test and subprocess helper).
- `cargo test -p repository-core --test standalone_placement`: four passed.
- `cargo fmt --all -- --check`.
- `cargo clippy --locked --workspace --all-targets -- -D warnings`.
- `npm run test:browser:full -- projects.pw.ts`: 16 cases passed on final code,
  covering desktop and narrow layouts, keyboard access, contrast, project
  switching, collision, cancel, focus restoration, and prior-writing preservation.
- Focused code review and `git diff --check`.

The first raw renderer attempt used Node 26's experimental Web Storage and failed
before tests could access jsdom storage. The canonical validator's documented flag
resolved this. Chromium initially could not start under the shell sandbox; reruns
used isolated test profiles with the approved local test launch. A narrow keyboard
case failed in an intermediate run; the entire 16-case suite passed on the final
frozen code.

## Limits

All data-writing tests used disposable synthetic folders. No manuscript, existing
project folder, application profile, or installed app was changed. Nothing was
pushed, merged, packaged, or installed. The new native picker/confirmation path was
compiled and its creation logic tested, but not driven end to end in a live native
app. This is a reviewed local patch, not an installed-app verification.
