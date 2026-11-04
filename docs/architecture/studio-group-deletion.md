# Group deletion

Every Library group's actions menu offers **Delete group…**. The confirmation
names the group and explains that its sheets and nested groups move up one level,
in the same order. **Cancel** receives initial focus, and Escape cancels.
**Delete group** removes only that group; it never deletes or moves sheet files.
An empty group uses the same confirmation.

Children occupy the removed group's former position among its parent's children.
Their own descendants retain their grouping. Sheet identities, classification,
paths and bytes stay exact. Legacy flat manuscript order is preserved.

Deletion changes only the manuscript index. The open editor, unsaved writing,
cursor and text geometry remain intact. It does not force a save or clear local
recovery. A changed index or file membership after preview blocks Apply.

**Undo last change** in project actions restores the exact original index during
the current session, without saving or replacing a dirty editor. Later index
changes block stale Undo. Transaction rollback and interrupted recovery use the
existing guarded journal. No author groups are deleted during automated tests.
