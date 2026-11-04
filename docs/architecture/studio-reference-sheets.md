# Reference sheets

Reference sheets appear in the same chapter/group list as regular sheets. A
visible **Reference** badge and an accessible name identify them; colour is an
additional cue. Their row menu offers **Make regular sheet**. Regular sheets
offer **Make reference sheet**. Both operations are local, undoable metadata
changes and preserve source text, paths, identities and the active editor buffer.

The optional `reference` boolean on schema-v2 scene records defaults to false.
Reference sheets remain editable and available as explicitly chosen AI context.
They are excluded from manuscript word totals, assembled chapter source lists
and new Studio publishing copies. Existing exported files and legacy manifests
are not rewritten.

Opening a project discovers unindexed Markdown files beneath `ms/**/reference/`
without writing an index. They are returned separately as `referenceSheets` and
merged into the navigator. The nearest unambiguous indexed sheet directory
determines their chapter/group; otherwise they appear at the project root. The
discovered identity is deterministic for the path. Changing classification or
explicitly organizing those rows adopts them into the index. An indexed regular
sheet in a reference folder stays regular on subsequent loads.

Native transactions validate revision and membership again before applying.
Classification and organization use the metadata-only path, including while
the editor contains unsaved text. Undo also leaves newer source bytes intact.

Synthetic checks cover restart persistence, discovery, adoption, undo, publishing
exclusion, dirty-buffer safety, keyboard focus, accessibility, 200% text, desktop
and narrow layouts, and unchanged editor geometry. Native VoiceOver and installed
release acceptance are separate checks.
