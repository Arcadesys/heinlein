# Local-first validation

Run from the repository root. Checks run serially and stop at the first failure;
the command prints the commit and dirty working-tree status before starting.

```sh
python3 tools/validate.py quick       # renderer tests, TypeScript/Vite build, browser smoke
python3 tools/validate.py studio      # renderer, boundaries, full browser, native lint/build
python3 tools/validate.py publishing  # Python publisher, pinned goldens, editorial hooks
python3 tools/validate.py full        # studio + publishing (before a release)
python3 tools/validate.py full --dry-run
```

Use `renderer`, `smoke`, `browser`, `boundaries`, or `native` for a focused rerun.
`native` is compilation/lint/fixture isolation; `studio` also runs the native
boundary tests. Do not describe a focused or quick run as full acceptance.
Inspect the final pytest skip summary: OS-specific skips are expected, missing
tools or other skipped coverage must be disclosed. Save stdout/stderr to a local
log when recording PR evidence, alongside the printed commit and dirty status.
Local results do not create GitHub statuses. Record their evidence with the PR.

## Before pushing

Run relevant local validation **before every push**, including PR update pushes:
use `studio` for Studio changes, `publishing` for publisher/editorial changes,
and `full` when both are affected. Use focused suites while iterating, then run
the relevant complete suite before sharing. A dry run only prints the plan.
If a check fails, fix it and rerun the affected validation before pushing; if
files change after validation, rerun checks covering those changes. Review the
printed commit/dirty status and record results with the PR. Pushing is a
separate authorized action; the validation runner never pushes automatically.
The automatic security-boundary workflow and explicit hosted platform comparisons
run after local validation, rather than being the first test of an unvalidated change.

## One-time prerequisites

Target macOS. Use Node 22 (matching the hosted workflows), Python 3.12, `uv`, and stable Rust
with `rustfmt` and `clippy`. The runner does not install tools or run `npm ci`:

```sh
uv sync --locked --extra dev
cd studio
npm ci
npx playwright install chromium
rustup component add rustfmt clippy
```

Native compilation requires Xcode command-line tools. Ubuntu validation is no
longer run. The local CLI remains usable on Linux for explicit diagnostics, but
passing macOS checks does not establish Linux support. `NODE_OPTIONS` is preserved and extended with
`--no-experimental-webstorage`, so Node 26's experimental global storage does not
replace jsdom's test storage. Native probes are only compiled/tested; this entry
point never launches their GUI/Keychain drivers or installs an app. The existing
macOS updater tests compile and ad-hoc sign temporary synthetic bundles only.

For simultaneous worktrees, choose a separate local browser port and diagnostic
directory. Existing test servers are never reused or stopped:

```sh
mkdir -p /tmp/heinlein-my-branch
HEINLEIN_BROWSER_PORT=15434 TMPDIR=/tmp/heinlein-my-branch python3 tools/validate.py browser
```

The default port remains 1434; the override accepts only integers 1024–65535.

Publishing additionally requires **exactly** the Pandoc version recorded in
`tests/golden/PANDOC_VERSION`, Chrome/Chromium for PDF smoke, and `pdftotext`
(Poppler). Put the pinned Pandoc binary first on `PATH`; a newer system version
does not qualify. The runner sets `HEINLEIN_REQUIRE_GOLDENS=1`, so missing or
mismatched Pandoc fails instead of silently skipping goldens. `UPDATE_GOLDEN=1`
is rejected. Missing PDF tools fail preflight as well. Fixtures are never
regenerated during validation.

## Hosted compute policy

The owner approved removing only these two browser requirements from `main`
after PR #111 finishes:

- `Full browser acceptance (ubuntu-latest)`
- `Full browser acceptance (macos-latest)`

The full browser suite now runs locally before every push. Its complete macOS
hosted workflow remains available through **Run workflow**, without reduced
coverage. GitHub no longer enforces browser results before merge; local acceptance
is a contributor obligation. No placeholder jobs, posted local statuses, or
persistent self-hosted runners are used. All unrelated branch protections stay
unchanged, including administrator enforcement, the `strict` setting,
and force-push/deletion restrictions.

The Studio workflow keeps one automatic macOS boundary-regression job for
Studio/updater/runner changes and merge-queue entries. It tests the existing
updater/signature boundaries, standalone provenance, synthetic Keychain retry,
core/MCP/auth/proposals/questions/GitHub crates, native question boundaries, and
both exact-source authority/lineage harnesses. It uses the same `boundaries`
command as local validation. These checks do not exercise a real user's vault.

The complete macOS Studio build job and publishing job now run through
**Actions → workflow → Run workflow** when cross-platform comparison is needed.
The native fallback job retains all its tests, lint, browser smoke, feature isolation,
and build steps. Mac-specific native/signature/isolation coverage must be run
locally on a Mac or through that manual job before a native release. Neither
workflow repeats automatically after merge. There are no dedicated security
scanner workflows in this repository; none have been removed or reconfigured.

For a PR touching Studio and publishing, automatic workload falls from **five
jobs to one** macOS boundary job. For renderer-only changes it falls from four
jobs to one. Publishing-only changes have no automatic hosted validation jobs.
All two/three post-merge validation jobs are removed. Two full browser runs, the
automatic Mac native build, two duplicate smoke runs, two native production
builds, and two workspace lint runs are replaced by local checks. These are
job/command counts, not measured billable-minute or dollar savings.

The repository-settings update must follow the owner's approved sequence: verify
PR #111 is merged, remove only the two named browser status requirements while
preserving every other protection, then publish this workflow migration after
local validation. Do not disable branch protection or bypass a merge restriction.

## macOS security coverage and build cost

The automatic boundary job runs the same test commands on macOS, including the
native question boundary tests and both exact-source harnesses. No security test
commands are removed. The two real synthetic-bundle signature/architecture and
atomic-exchange tests now run automatically; Ubuntu skipped them. These use
temporary synthetic bundles, not the installed app or the user's Keychain.

All Cargo invocations share one target directory, including isolated harnesses,
so compatible compiled dependencies are reused within the job and locally. The
job performs debug tests only: no npm/browser suite, clippy matrix, native release
build, or signing/install of the product is added. There is still one hosted
macOS job for relevant changes. macOS runner time can cost more per minute; the
change reduces duplicate work rather than asserting a measured billing saving.

Linux-specific runtime/compile coverage, including Secret Service and GTK/WebKit
integration, is intentionally no longer validated. macOS Keychain-oriented and
Unix boundary tests cannot establish Linux security equivalence. The synthetic
credential tests also do not replace signed-app/real-Keychain acceptance.
