//! Session-local targeted-edit lineage. Disk receipts never mint this state.
use drafting_questions::review::{ReviewEdit, ReviewOutput, ReviewRequest, ReviewScope};
use proposal_store::{diff_hash, text_hash, PendingProposal, ProposalOrigin};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditView {
    #[serde(flatten)]
    edit: ReviewEdit,
    status: String,
    proposal_id: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewResult {
    review_id: String,
    request_id: String,
    model: String,
    schema_version: u32,
    scope: ReviewScope,
    edits: Vec<EditView>,
}
pub(crate) struct ReviewSession {
    pub request: ReviewRequest,
    result: ReviewResult,
    expected: HashMap<String, String>,
    prepared: HashMap<String, PendingProposal>,
}
impl ReviewSession {
    pub fn new(
        request: ReviewRequest,
        output: ReviewOutput,
        model: String,
    ) -> Result<Self, String> {
        output.validate(&request).map_err(|e| e.to_string())?;
        let expected = request
            .snapshots
            .iter()
            .map(|s| (s.path.clone(), s.source.clone()))
            .collect();
        let result = ReviewResult {
            review_id: uuid::Uuid::new_v4().to_string(),
            request_id: request.request_id.clone(),
            model,
            schema_version: 1,
            scope: request.scope,
            edits: output
                .edits
                .into_iter()
                .map(|edit| EditView {
                    edit,
                    status: "pending".into(),
                    proposal_id: None,
                })
                .collect(),
        };
        Ok(Self {
            request,
            result,
            expected,
            prepared: HashMap::new(),
        })
    }
    pub fn matches(&self, repository_id: &str, review_id: &str) -> bool {
        self.request.repository_id == repository_id && self.result.review_id == review_id
    }
    pub fn view(&self) -> ReviewResult {
        self.result.clone()
    }
    pub fn expected(&self, path: &str) -> Result<&str, String> {
        self.expected
            .get(path)
            .map(String::as_str)
            .ok_or_else(|| "Unknown review scene".into())
    }
    fn index(&self, id: &str) -> Result<usize, String> {
        self.result
            .edits
            .iter()
            .position(|v| v.edit.id == id)
            .ok_or_else(|| "Unknown review edit".into())
    }
    pub fn candidate(&self, edit_id: &str, project_key: &str) -> Result<PendingProposal, String> {
        self.candidate_inner(edit_id, project_key, true)
    }
    pub fn rejection_candidate(
        &self,
        edit_id: &str,
        project_key: &str,
    ) -> Result<PendingProposal, String> {
        self.candidate_inner(edit_id, project_key, false)
    }
    fn candidate_inner(
        &self,
        edit_id: &str,
        project_key: &str,
        preparing: bool,
    ) -> Result<PendingProposal, String> {
        let index = self.index(edit_id)?;
        let item = &self.result.edits[index];
        if !matches!(item.status.as_str(), "pending" | "prepared") {
            return Err("This edit already has a decision".into());
        }
        if let Some(proposal) = self.prepared.get(edit_id) {
            return Ok(proposal.clone());
        }
        if preparing && self.result.edits.iter().any(|v| v.status == "prepared") {
            return Err("Finish or reject the currently prepared edit first".into());
        }
        let edit = &item.edit;
        let base = self.expected(&edit.path)?;
        // Only our accepted, non-overlapping original edits contribute offsets.
        // Arbitrary current disk text is never searched or used to rebase.
        let delta: isize = self
            .result
            .edits
            .iter()
            .filter(|v| {
                v.status == "accepted"
                    && v.edit.path == edit.path
                    && v.edit.to_utf8 <= edit.from_utf8
            })
            .map(|v| v.edit.replacement.len() as isize - v.edit.original.len() as isize)
            .sum();
        let from = edit
            .from_utf8
            .checked_add_signed(delta)
            .ok_or("Invalid review offset")?;
        let to = edit
            .to_utf8
            .checked_add_signed(delta)
            .ok_or("Invalid review offset")?;
        let replacement =
            drafting_questions::splice_revision(base, from, to, &edit.original, &edit.replacement)
                .map_err(|e| e.to_string())?;
        Ok(PendingProposal {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            project_key: project_key.into(),
            path: edit.path.clone(),
            base_hash: text_hash(base),
            replacement_hash: text_hash(&replacement),
            diff_hash: diff_hash(&edit.path, base, &replacement),
            base_text: base.into(),
            replacement_text: replacement,
            origin: ProposalOrigin::native_openai(
                self.result.model.clone(),
                self.result.request_id.clone(),
            ),
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        })
    }
    pub fn is_prepared(&self, edit_id: &str) -> bool {
        self.prepared.contains_key(edit_id)
    }
    pub fn prepared(&mut self, edit_id: &str, proposal: PendingProposal) -> Result<(), String> {
        let i = self.index(edit_id)?;
        self.result.edits[i].status = "prepared".into();
        self.result.edits[i].proposal_id = Some(proposal.id.clone());
        self.prepared.insert(edit_id.into(), proposal);
        Ok(())
    }
    pub fn rejected(&mut self, edit_id: &str, proposal_id: String) -> Result<(), String> {
        let i = self.index(edit_id)?;
        self.result.edits[i].status = "rejected".into();
        self.result.edits[i].proposal_id = Some(proposal_id);
        self.prepared.remove(edit_id);
        Ok(())
    }
    pub fn rejected_proposal(&mut self, repository_id: &str, proposal_id: &str) {
        if repository_id != self.request.repository_id {
            return;
        }
        let id = self
            .prepared
            .iter()
            .find(|(_, p)| p.id == proposal_id)
            .map(|(id, _)| id.clone());
        if let Some(id) = id {
            let _ = self.rejected(&id, proposal_id.into());
        }
    }
    /// Called only by the native authority after this process completes an apply.
    pub fn applied(
        &mut self,
        repository_id: &str,
        proposal_id: &str,
        base_hash: &str,
        replacement_hash: &str,
        diff: &str,
    ) {
        if repository_id != self.request.repository_id {
            return;
        }
        let Some((edit_id, p)) = self.prepared.iter().find(|(_, p)| p.id == proposal_id) else {
            return;
        };
        if p.base_hash != base_hash
            || p.replacement_hash != replacement_hash
            || p.diff_hash != diff
            || self.expected.get(&p.path) != Some(&p.base_text)
        {
            return;
        }
        let edit_id = edit_id.clone();
        self.expected
            .insert(p.path.clone(), p.replacement_text.clone());
        if let Ok(i) = self.index(&edit_id) {
            self.result.edits[i].status = "accepted".into();
        }
        self.prepared.remove(&edit_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use drafting_questions::review::{ReviewRole, ReviewSnapshot};
    fn session() -> ReviewSession {
        let request = ReviewRequest {
            request_id: "review-one".into(),
            repository_id: "repo".into(),
            scope: ReviewScope::Scene,
            snapshots: vec![ReviewSnapshot {
                path: "scenes/one.md".into(),
                source: "Bad cat and bad dog.".into(),
                source_hash: "a".repeat(64),
            }],
        };
        let edits = vec![
            ReviewEdit {
                id: "one".into(),
                path: "scenes/one.md".into(),
                from_utf8: 0,
                to_utf8: 3,
                original: "Bad".into(),
                replacement: "Good".into(),
                reason: "Example".into(),
                role: ReviewRole::Proofreader,
            },
            ReviewEdit {
                id: "two".into(),
                path: "scenes/one.md".into(),
                from_utf8: 12,
                to_utf8: 15,
                original: "bad".into(),
                replacement: "great".into(),
                reason: "Example".into(),
                role: ReviewRole::Editor,
            },
        ];
        ReviewSession::new(
            request,
            ReviewOutput {
                schema_version: 1,
                edits,
            },
            "test-model".into(),
        )
        .unwrap()
    }
    fn accept(session: &mut ReviewSession, p: &PendingProposal) {
        session.applied(
            "repo",
            &p.id,
            &p.base_hash,
            &p.replacement_hash,
            &p.diff_hash,
        );
    }
    #[test]
    fn sequential_offsets_follow_only_native_confirmed_lineage() {
        let mut s = session();
        let first = s.candidate("one", &"b".repeat(64)).unwrap();
        s.prepared("one", first.clone()).unwrap();
        assert!(s.candidate("two", &"b".repeat(64)).is_err());
        s.applied(
            "other",
            &first.id,
            &first.base_hash,
            &first.replacement_hash,
            &first.diff_hash,
        );
        assert_eq!(s.expected("scenes/one.md").unwrap(), "Bad cat and bad dog.");
        s.applied(
            "repo",
            &first.id,
            &first.base_hash,
            &"c".repeat(64),
            &first.diff_hash,
        );
        assert_eq!(s.view().edits[0].status, "prepared");
        accept(&mut s, &first);
        let second = s.candidate("two", &"b".repeat(64)).unwrap();
        assert_eq!(second.base_text, "Good cat and bad dog.");
        assert_eq!(second.replacement_text, "Good cat and great dog.");
        assert_eq!(s.view().edits[0].status, "accepted");
        assert!(s.candidate("one", &"b".repeat(64)).is_err());
    }
    #[test]
    fn reverse_acceptance_preserves_original_coordinates() {
        let mut s = session();
        let p = s.candidate("two", &"b".repeat(64)).unwrap();
        s.prepared("two", p.clone()).unwrap();
        accept(&mut s, &p);
        let p = s.candidate("one", &"b".repeat(64)).unwrap();
        assert_eq!(p.replacement_text, "Good cat and great dog.");
    }
    #[test]
    fn rejects_are_terminal_and_never_advance_expected_source() {
        let mut s = session();
        let p = s.candidate("one", &"b".repeat(64)).unwrap();
        s.prepared("one", p.clone()).unwrap();
        assert_eq!(s.candidate("one", &"b".repeat(64)).unwrap(), p);
        s.rejected("one", p.id.clone()).unwrap();
        accept(&mut s, &p);
        assert_eq!(s.expected("scenes/one.md").unwrap(), "Bad cat and bad dog.");
        assert!(s.candidate("one", &"b".repeat(64)).is_err());
        assert!(s.matches("repo", &s.view().review_id));
        assert!(!s.matches("other", &s.view().review_id));
    }
    #[test]
    fn rejection_of_other_edit_remains_available_with_prepared_edit() {
        let mut s = session();
        let p = s.candidate("one", &"b".repeat(64)).unwrap();
        s.prepared("one", p.clone()).unwrap();
        assert!(s.is_prepared("one"));
        assert!(s.candidate("two", &"b".repeat(64)).is_err());
        let rejection = s.rejection_candidate("two", &"b".repeat(64)).unwrap();
        s.rejected("two", rejection.id).unwrap();
        assert_eq!(s.view().edits[0].status, "prepared");
        assert_eq!(s.view().edits[1].status, "rejected");
        assert_eq!(s.candidate("one", &"b".repeat(64)).unwrap(), p);
    }
    #[test]
    fn generic_native_rejection_clears_prepared_slot_without_advancing_source() {
        let mut s = session();
        let p = s.candidate("one", &"b".repeat(64)).unwrap();
        s.prepared("one", p.clone()).unwrap();
        s.rejected_proposal("other", &p.id);
        assert!(s.is_prepared("one"));
        s.rejected_proposal("repo", &p.id);
        assert!(!s.is_prepared("one"));
        assert_eq!(s.view().edits[0].status, "rejected");
        let next = s.candidate("two", &"b".repeat(64)).unwrap();
        assert_eq!(next.base_text, "Bad cat and bad dog.");
        assert!(s.rejection_candidate("one", &"b".repeat(64)).is_err());
    }
    #[test]
    fn seeded_targeted_edit_lifecycle_preserves_exact_unrelated_bytes() {
        for seed in 1u64..=256 {
            let mut s = session();
            let mut rng = seed ^ 0x454449544c494e45;
            let mut accepted = [false; 2];
            let mut terminal = [false; 2];
            for step in 0..64 {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                let index = ((rng >> 8) % 2) as usize;
                let id = ["one", "two"][index];
                match rng % 6 {
                    0 => {
                        if let Ok(p) = s.candidate(id, &"b".repeat(64)) {
                            s.prepared(id, p).unwrap();
                        }
                    }
                    1 => {
                        if let Some(p) = s.prepared.get(id).cloned() {
                            accept(&mut s, &p);
                            accepted[index] = true;
                            terminal[index] = true;
                        }
                    }
                    2 => {
                        if let Ok(p) = s.rejection_candidate(id, &"b".repeat(64)) {
                            s.rejected(id, p.id).unwrap();
                            terminal[index] = true;
                        }
                    }
                    3 => {
                        if let Some(p) = s.prepared.get(id).cloned() {
                            s.rejected_proposal("repo", &p.id);
                            terminal[index] = true;
                        }
                    }
                    4 => {
                        if let Some(p) = s.prepared.get(id).cloned() {
                            s.applied("repo", &p.id, &p.base_hash, &"0".repeat(64), &p.diff_hash);
                        }
                    }
                    _ => {
                        s.rejected_proposal("wrong-repository", "unrelated-proposal");
                    }
                }
                let expected = format!(
                    "{} cat and {} dog.",
                    if accepted[0] { "Good" } else { "Bad" },
                    if accepted[1] { "great" } else { "bad" }
                );
                assert_eq!(
                    s.expected("scenes/one.md").unwrap(),
                    expected,
                    "seed {seed} step {step}"
                );
                for (i, id) in ["one", "two"].iter().enumerate() {
                    if terminal[i] {
                        assert!(
                            s.candidate(id, &"b".repeat(64)).is_err(),
                            "seed {seed} step {step}: terminal edit reopened"
                        );
                    }
                }
            }
        }
    }
}
