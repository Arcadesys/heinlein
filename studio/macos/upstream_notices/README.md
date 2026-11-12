# Supplemental upstream originals

These files fill notice omissions in specific crates.io archives. `manifest.json`
records each package version, SPDX declaration, published `.cargo_vcs_info.json`
commit/path, exact-commit original `Cargo.toml` URL and digest, and upstream notice
URLs/digests. Original crate manifests were fetched at those commits and matched
byte-for-byte to the published `Cargo.toml.orig`; workspace-inherited versions and
licenses were checked against the same commit's root Cargo manifest. Shared
originals are stored once by SHA256. No copyright holders or grants were added.

The generator accepts these files only when installed package identity, license,
repository, VCS commit/path, original manifest and notice hashes still match. It
does not fetch network material at build time. New versions require fresh review.

The objc2 project's `LICENSE.md` is an explanatory document, not a full license
and copyright notice. Its exact original is included; those package review items
remain unresolved. Do not treat the presence of that document as clearance.

For selectors 0.38.0, the exact released `lib.rs` header explicitly points to MPL
2.0. Its verified header/digest and URL are recorded; the full original MPL 2.0
text was retrieved from Mozilla's official text URL. No new license was selected.

This inventory reduces missing-text gaps. It does not clear redistribution rights
or replace the remaining review items in the generated notices.
