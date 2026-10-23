//! Verified targeted-edit lineage. Persisted records never mint native apply authority.
use drafting_questions::review::{ReviewEdit, ReviewOutput, ReviewRequest, ReviewScope};
use proposal_store::{diff_hash, text_hash, PendingProposal, ProposalOrigin};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditView {
    #[serde(flatten)]
    edit: ReviewEdit,
    status: String,
    proposal_id: Option<String>,
    #[serde(default)]
    fingerprint: String,
    #[serde(default)]
    comments: Vec<String>,
    #[serde(default)]
    provenance: Vec<Provenance>,
    #[serde(default)]
    patch: String,
    #[serde(default)]
    patch_hash: String,
    #[serde(default)]
    conflict_group: Option<String>,
    #[serde(default)]
    selected: bool,
    #[serde(default)]
    source_stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    location: Option<DisplayLocation>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisplayLocation {
    line: usize,
    column: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewResult {
    review_id: String,
    request_id: String,
    model: String,
    schema_version: u32,
    scope: ReviewScope,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    project_key: Option<String>,
    edits: Vec<EditView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workflow: Option<WorkflowView>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewSession {
    schema_version: u32,
    pub revision: u64,
    project_key: String,
    ledger: Vec<ApplyEvent>,
    choices: HashMap<String, (String, Vec<String>)>,
    pub request: ReviewRequest,
    result: ReviewResult,
    #[serde(skip)]
    expected: HashMap<String, String>,
    #[serde(skip)]
    prepared: HashMap<String, PendingProposal>,
}
// Validated native receipt data, not persisted approval authority.
type ReviewReceiptEvidence = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<proposal_store::ReviewAttribution>,
);
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
            revision: 0,
            project_key: None,
            workflow: None,
            edits: output
                .edits
                .into_iter()
                .map(|edit| EditView {
                    edit,
                    status: "pending".into(),
                    proposal_id: None,
                    fingerprint: String::new(),
                    comments: vec![],
                    provenance: vec![],
                    patch: String::new(),
                    patch_hash: String::new(),
                    conflict_group: None,
                    selected: false,
                    source_stale: false,
                    location: None,
                })
                .collect(),
        };
        Ok(Self {
            schema_version: 1,
            revision: 0,
            project_key: String::new(),
            ledger: vec![],
            choices: HashMap::new(),
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
        let mut view = self.result.clone();
        view.revision = self.revision;
        for item in &mut view.edits {
            // Display only: authority always uses baseline UTF-8 byte coordinates.
            item.location = self
                .request
                .snapshots
                .iter()
                .find(|s| s.path == item.edit.path)
                .and_then(|s| s.source.get(..item.edit.from_utf8))
                .map(|prefix| DisplayLocation {
                    line: prefix.bytes().filter(|b| *b == b'\n').count() + 1,
                    column: prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1,
                });
        }
        view
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
        if preparing {
            self.check_choice(edit_id)?;
        }
        if let Some(proposal) = self.prepared.get(edit_id) {
            return Ok(proposal.clone());
        }
        if preparing
            && self
                .result
                .edits
                .iter()
                .any(|v| v.status == "prepared" && v.edit.id != edit_id)
        {
            return Err("Finish or reject the currently prepared edit first".into());
        }
        if preparing {
            self.check_choice(edit_id)?;
            if item.source_stale {
                return Err("This source changed outside the verified review lineage. Request a fresh review for this source.".into());
            }
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
        let mut origin = ProposalOrigin::native_openai(
            self.result.model.clone(),
            item.provenance
                .first()
                .map(|p| p.request_id.clone())
                .unwrap_or_else(|| self.result.request_id.clone()),
        );
        if self.result.schema_version == 2 {
            origin.review = Some(proposal_store::ReviewAttribution {
                review_id: self.result.review_id.clone(),
                finding_id: edit_id.into(),
                fingerprint: item.fingerprint.clone(),
                scene_id: self
                    .request
                    .snapshots
                    .iter()
                    .find(|s| s.path == edit.path)
                    .and_then(|s| s.scene_id.clone()),
                competing: self.competing(edit_id),
            });
        }
        Ok(PendingProposal {
            schema_version: 1,
            id: item
                .proposal_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            project_key: project_key.into(),
            path: edit.path.clone(),
            base_hash: text_hash(base),
            replacement_hash: text_hash(&replacement),
            diff_hash: diff_hash(&edit.path, base, &replacement),
            base_text: base.into(),
            replacement_text: replacement,
            origin,
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
        if let Some(w) = &mut self.result.workflow {
            w.decisions.push(Decision {
                finding_id: edit_id.into(),
                kind: "rejected".into(),
                competing: vec![],
                proposal_id: Some(proposal_id.clone()),
            });
        }
        self.result.edits[i].status = "rejected".into();
        self.result.edits[i].proposal_id = Some(proposal_id);
        self.prepared.remove(edit_id);
        if self.result.schema_version == 2 {
            self.regroup();
        }
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
        let p = p.clone();
        let competing = self.competing(&edit_id);
        if let Some(w) = &mut self.result.workflow {
            w.decisions.push(Decision {
                finding_id: edit_id.clone(),
                kind: "approved".into(),
                competing,
                proposal_id: Some(proposal_id.into()),
            });
        }
        self.expected
            .insert(p.path.clone(), p.replacement_text.clone());
        if let Ok(i) = self.index(&edit_id) {
            self.result.edits[i].status = "accepted".into();
        }
        if self.result.schema_version == 2 {
            self.ledger.push(ApplyEvent {
                finding_id: edit_id.clone(),
                proposal_id: p.id.clone(),
                base_hash: base_hash.into(),
                replacement_hash: replacement_hash.into(),
                diff_hash: diff.into(),
            });
            if let Ok(i) = self.index(&edit_id) {
                if let Some(group) = self.result.edits[i].conflict_group.clone() {
                    for item in &mut self.result.edits {
                        if item.conflict_group.as_deref() == Some(&group)
                            && item.edit.id != edit_id
                            && matches!(item.status.as_str(), "pending" | "prepared")
                        {
                            item.status = "supersededByAuthorChoice".into();
                        }
                    }
                }
            }
        }
        self.prepared.remove(&edit_id);
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Provenance {
    pub account_id: String,
    pub account_generation: u64,
    pub instance_id: String,
    pub definition_id: String,
    pub definition_version: u32,
    pub display_name: String,
    pub request_id: String,
    #[serde(default)]
    pub provider_response_id: Option<String>,
    pub model: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefinitionSnapshot {
    instance_id: String,
    definition: drafting_questions::review_workflow::ReviewerDefinition,
    hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceView {
    id: String,
    path: String,
    source_hash: String,
    read_only: bool,
    order: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Decision {
    finding_id: String,
    kind: String,
    competing: Vec<String>,
    proposal_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyEvent {
    finding_id: String,
    proposal_id: String,
    base_hash: String,
    replacement_hash: String,
    diff_hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowView {
    definitions: Vec<DefinitionSnapshot>,
    coverage: Vec<drafting_questions::review_workflow::Coverage>,
    sources: Vec<SourceView>,
    decisions: Vec<Decision>,
    account_id: String,
    account_generation: u64,
    context_notice: String,
}
impl ReviewSession {
    pub fn workflow(
        request: ReviewRequest,
        project_key: String,
        model: String,
        account_id: String,
        account_generation: u64,
    ) -> Result<Self, String> {
        let coverage =
            drafting_questions::review_workflow::plan(&request).map_err(|e| e.to_string())?;
        let definitions = drafting_questions::review_workflow::definitions();
        let options = request.workflow.as_ref().ok_or("Review options missing")?;
        let definitions = options
            .reviewers
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let definition = definitions
                    .iter()
                    .find(|d| &d.id == id)
                    .ok_or("Reviewer definition is unavailable")?
                    .clone();
                Ok(DefinitionSnapshot {
                    instance_id: format!("reviewer-{}", i + 1),
                    hash: text_hash(&serde_json::to_string(&definition).unwrap()),
                    definition,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let sources = request
            .snapshots
            .iter()
            .map(|s| (s, false))
            .chain(options.context.iter().map(|s| (s, true)))
            .enumerate()
            .map(|(order, (s, read_only))| SourceView {
                id: text_hash(&format!(
                    "{}:{}:{}",
                    project_key,
                    s.path,
                    text_hash(&s.source)
                )),
                path: s.path.clone(),
                source_hash: text_hash(&s.source),
                read_only,
                order,
            })
            .collect();
        let expected = request
            .snapshots
            .iter()
            .map(|s| (s.path.clone(), s.source.clone()))
            .collect();
        let context_notice = "Each call sees one editable core, bounded neighboring prose and an explicit window of the selected read-only context. It does not see the whole work at once. At most eight calls run per explicit batch; incomplete coverage is not a complete review.".into();
        let result = ReviewResult {
            review_id: uuid::Uuid::new_v4().to_string(),
            request_id: request.request_id.clone(),
            model,
            schema_version: 2,
            scope: request.scope,
            revision: 0,
            project_key: Some(project_key.clone()),
            edits: vec![],
            workflow: Some(WorkflowView {
                definitions,
                coverage,
                sources,
                decisions: vec![],
                account_id,
                account_generation,
                context_notice,
            }),
        };
        Ok(Self {
            schema_version: 2,
            revision: 0,
            project_key,
            ledger: vec![],
            choices: HashMap::new(),
            request,
            result,
            expected,
            prepared: HashMap::new(),
        })
    }
    pub fn id(&self) -> &str {
        &self.result.review_id
    }
    pub fn definitions(&self) -> Vec<drafting_questions::review_workflow::ReviewerDefinition> {
        self.result
            .workflow
            .as_ref()
            .map(|v| v.definitions.iter().map(|d| d.definition.clone()).collect())
            .unwrap_or_default()
    }
    pub fn remaining_findings(&self) -> usize {
        1024usize.saturating_sub(self.result.edits.len())
    }
    pub fn coverage(&self) -> Vec<drafting_questions::review_workflow::Coverage> {
        self.result
            .workflow
            .as_ref()
            .map(|v| v.coverage.clone())
            .unwrap_or_default()
    }
    pub fn connection_matches(&self, account: &str, model: &str, _generation: u64) -> bool {
        self.result
            .workflow
            .as_ref()
            .is_some_and(|v| v.account_id == account)
            && self.result.model == model
    }
    pub fn bind_batch_generation(&mut self, generation: u64) {
        if let Some(w) = &mut self.result.workflow {
            w.account_generation = generation;
        }
    }
    pub fn set_request_id(&mut self, id: String) {
        self.request.request_id = id.clone();
        self.result.request_id = id;
    }
    fn fingerprint(&self, e: &ReviewEdit) -> String {
        text_hash(
            &serde_json::to_string(&(
                self.project_key.as_str(),
                e.path.as_str(),
                self.request
                    .snapshots
                    .iter()
                    .find(|s| s.path == e.path)
                    .map(|s| text_hash(&s.source)),
                e.from_utf8,
                e.to_utf8,
                &e.original,
                &e.replacement,
            ))
            .unwrap(),
        )
    }
    pub fn ingest(
        &mut self,
        batch: drafting_questions::review_workflow::Batch,
        tombstones: &std::collections::HashSet<String>,
    ) -> Result<(), String> {
        for call in batch.calls {
            let workflow = self
                .result
                .workflow
                .as_mut()
                .ok_or("Not a consolidated review")?;
            let index = workflow
                .coverage
                .iter()
                .position(|c| c.id == call.coverage.id)
                .ok_or("Unknown chunk")?;
            if !matches!(
                workflow.coverage[index].status.as_str(),
                "queued" | "notRun"
            ) && !(workflow.coverage[index].status == "running"
                && workflow.coverage[index].request_id == call.coverage.request_id)
            {
                continue;
            }
            let captured = &workflow.coverage[index];
            if captured.source_index != call.coverage.source_index
                || captured.from_utf8 != call.coverage.from_utf8
                || captured.to_utf8 != call.coverage.to_utf8
                || captured.reviewer != call.coverage.reviewer
                || captured.window_from != call.coverage.window_from
                || captured.window_to != call.coverage.window_to
                || captured.context_ranges != call.coverage.context_ranges
            {
                return Err("Chunk coverage changed".into());
            }
            let definition = workflow
                .definitions
                .get(call.coverage.reviewer)
                .ok_or("Reviewer changed")?
                .clone();
            workflow.coverage[index] = call.coverage.clone();
            if call.coverage.status != "completed" {
                continue;
            }
            if call.model != self.result.model {
                return Err("The provider model differs from the selected review model".into());
            }
            for mut edit in call.edits {
                let single = ReviewOutput {
                    schema_version: 1,
                    edits: vec![edit.clone()],
                };
                single.validate(&self.request).map_err(|e| e.to_string())?;
                let fingerprint = self.fingerprint(&edit);
                let provenance = Provenance {
                    provider_response_id: call.provider_response_id.clone(),
                    account_id: self.result.workflow.as_ref().unwrap().account_id.clone(),
                    account_generation: self.result.workflow.as_ref().unwrap().account_generation,
                    instance_id: definition.instance_id.clone(),
                    definition_id: definition.definition.id.clone(),
                    definition_version: definition.definition.version,
                    display_name: definition.definition.display_name.clone(),
                    request_id: call
                        .coverage
                        .request_id
                        .clone()
                        .ok_or("Missing call identity")?,
                    model: call.model.clone(),
                };
                if let Some(old) = self
                    .result
                    .edits
                    .iter_mut()
                    .find(|v| v.fingerprint == fingerprint)
                {
                    if !old.comments.contains(&edit.reason) {
                        old.comments.push(edit.reason.clone())
                    }
                    if !old.provenance.iter().any(|p| {
                        p.instance_id == provenance.instance_id
                            && p.request_id == provenance.request_id
                    }) {
                        old.provenance.push(provenance)
                    }
                    continue;
                }
                if self.result.edits.len() >= 1024 {
                    if let Some(w) = &mut self.result.workflow {
                        for c in &mut w.coverage {
                            if c.status == "queued" {
                                c.status = "notRun".into();
                                c.error = Some("findingLimit".into())
                            }
                        }
                    }
                    return Ok(());
                }
                edit.id = format!("finding-{}", &fingerprint[..32]);
                let patch=serde_json::to_string(&serde_json::json!({"path":edit.path,"fromUtf8":edit.from_utf8,"toUtf8":edit.to_utf8,"before":edit.original,"replacement":edit.replacement})).unwrap();
                let blocked = self
                    .result
                    .edits
                    .iter()
                    .any(|v| v.status == "accepted" && self.dependent(&v.edit, &edit));
                self.result.edits.push(EditView {
                    comments: vec![edit.reason.clone()],
                    edit,
                    status: if tombstones.contains(&fingerprint) {
                        "rejected"
                    } else if blocked {
                        "blockedByAppliedDecision"
                    } else {
                        "pending"
                    }
                    .into(),
                    proposal_id: None,
                    fingerprint,
                    provenance: vec![provenance],
                    patch_hash: text_hash(&patch),
                    patch,
                    conflict_group: None,
                    selected: false,
                    source_stale: false,
                    location: None,
                });
            }
        }
        if batch.limit_reached {
            if let Some(w) = &mut self.result.workflow {
                for c in &mut w.coverage {
                    if matches!(c.status.as_str(), "queued" | "notRun") {
                        c.status = "notRun".into();
                        c.error = Some("findingLimit".into());
                    }
                }
            }
        }
        if batch.cancelled {
            if let Some(w) = &mut self.result.workflow {
                for c in &mut w.coverage {
                    if c.status == "queued" {
                        c.status = "notRun".into()
                    }
                }
            }
        }
        self.regroup();
        Ok(())
    }
    fn members(&self, group: &str) -> Vec<String> {
        let mut ids = self
            .result
            .edits
            .iter()
            .filter(|e| {
                e.conflict_group.as_deref() == Some(group)
                    && matches!(e.status.as_str(), "pending" | "prepared")
            })
            .map(|e| e.edit.id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }
    fn dependent(&self, a: &ReviewEdit, b: &ReviewEdit) -> bool {
        if a.path != b.path {
            return false;
        }
        if drafting_questions::review_workflow::overlaps(
            a.from_utf8,
            a.to_utf8,
            b.from_utf8,
            b.to_utf8,
        ) {
            return true;
        }
        // Adjacent replacements may create a new protected newline/frontmatter
        // boundary together even though each patch is valid on the baseline.
        if a.to_utf8 != b.from_utf8 && b.to_utf8 != a.from_utf8 {
            return false;
        }
        let Some(source) = self.request.snapshots.iter().find(|s| s.path == a.path) else {
            return true;
        };
        for (first, second) in [(a, b), (b, a)] {
            let Ok(next) = drafting_questions::splice_revision(
                &source.source,
                first.from_utf8,
                first.to_utf8,
                &first.original,
                &first.replacement,
            ) else {
                return true;
            };
            let shift = if first.to_utf8 <= second.from_utf8 {
                first.replacement.len() as isize - first.original.len() as isize
            } else {
                0
            };
            let (Some(from), Some(to)) = (
                second.from_utf8.checked_add_signed(shift),
                second.to_utf8.checked_add_signed(shift),
            ) else {
                return true;
            };
            if drafting_questions::splice_revision(
                &next,
                from,
                to,
                &second.original,
                &second.replacement,
            )
            .is_err()
            {
                return true;
            }
        }
        false
    }
    fn regroup(&mut self) {
        let n = self.result.edits.len();
        let mut parent = (0..n).collect::<Vec<_>>();
        fn root(p: &[usize], mut n: usize) -> usize {
            while p[n] != n {
                n = p[n]
            }
            n
        }
        for i in 0..n {
            for j in 0..i {
                let (a, b) = (&self.result.edits[i], &self.result.edits[j]);
                if matches!(a.status.as_str(), "pending" | "prepared")
                    && matches!(b.status.as_str(), "pending" | "prepared")
                    && self.dependent(&a.edit, &b.edit)
                {
                    let ri = root(&parent, i);
                    let rj = root(&parent, j);
                    parent[ri] = rj;
                }
            }
        }
        for i in 0..n {
            if !matches!(self.result.edits[i].status.as_str(), "pending" | "prepared") {
                continue;
            }
            let r = root(&parent, i);
            let mut ids = (0..n)
                .filter(|j| root(&parent, *j) == r)
                .map(|j| self.result.edits[j].edit.id.clone())
                .collect::<Vec<_>>();
            ids.sort();
            let group = if ids.len() > 1 {
                Some(format!("conflict-{}", &text_hash(&ids.join(":"))[..24]))
            } else {
                None
            };
            self.result.edits[i].conflict_group = group;
            self.result.edits[i].selected = false;
        }
        for (group, (id, members)) in &self.choices {
            if &self.members(group) == members {
                if let Some(e) = self.result.edits.iter_mut().find(|e| &e.edit.id == id) {
                    e.selected = true;
                }
            }
        }
    }
    fn check_choice(&self, id: &str) -> Result<(), String> {
        let item = &self.result.edits[self.index(id)?];
        if let Some(group) = &item.conflict_group {
            let members = self.members(group);
            if !self
                .choices
                .get(group)
                .is_some_and(|(selected, old)| selected == id && old == &members)
            {
                return Err(
                    "Choose one conflict alternative first. Choosing does not apply it.".into(),
                );
            }
        }
        Ok(())
    }
    pub fn choose(&mut self, id: &str) -> Result<(), String> {
        let group = self.result.edits[self.index(id)?]
            .conflict_group
            .clone()
            .ok_or("This suggestion has no conflict alternatives")?;
        let members = self.members(&group);
        for member in &members {
            self.prepared.remove(member);
            if let Ok(i) = self.index(member) {
                if self.result.edits[i].status == "prepared" {
                    self.result.edits[i].status = "pending".into();
                    self.result.edits[i].proposal_id = None;
                }
            }
        }
        self.choices.insert(group, (id.into(), members.clone()));
        if let Some(w) = &mut self.result.workflow {
            w.decisions.push(Decision {
                finding_id: id.into(),
                kind: "selectedAlternativeNotApplied".into(),
                competing: members,
                proposal_id: None,
            });
        }
        self.regroup();
        Ok(())
    }
    pub fn competing(&self, id: &str) -> Vec<String> {
        self.index(id)
            .ok()
            .and_then(|i| self.result.edits[i].conflict_group.as_deref())
            .map(|g| self.members(g).into_iter().filter(|v| v != id).collect())
            .unwrap_or_default()
    }
    pub fn tombstones(&self) -> std::collections::HashSet<String> {
        self.result
            .edits
            .iter()
            .filter(|e| e.status == "rejected")
            .map(|e| e.fingerprint.clone())
            .collect()
    }
    pub fn persist(
        &mut self,
        store: &proposal_store::ReviewStore,
        repo: &repository_core::Repository,
    ) -> Result<(), String> {
        if self.result.schema_version != 2 {
            return Ok(());
        }
        if self.project_key != repo.project_key() {
            return Err("Review project changed".into());
        }
        let old = self.revision;
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or("Review revision limit reached")?;
        if let Err(e) = store.save(repo, self.id(), (old > 0).then_some(old), self) {
            self.revision = old;
            return Err(e.to_string());
        }
        Ok(())
    }
    pub fn restore(
        mut self,
        project: &str,
        repository_id: &str,
        verified: impl Fn(&PendingProposal) -> bool,
    ) -> Result<Self, String> {
        if self.schema_version != 2
            || self.project_key != project
            || self.result.schema_version != 2
            || self.revision == 0
            || self.result.edits.len() > 1024
        {
            return Err("Invalid consolidated review record".into());
        }
        self.request.validate().map_err(|e| e.to_string())?;
        if self.revision == u64::MAX
            || self.result.scope != self.request.scope
            || self.result.request_id != self.request.request_id
            || uuid::Uuid::parse_str(self.id()).is_err()
            || self.ledger.len() > 1024
            || self.choices.len() > 1024
        {
            return Err("Invalid review revision or identity".into());
        }
        let planned =
            drafting_questions::review_workflow::plan(&self.request).map_err(|e| e.to_string())?;
        if let Some(w) = &self.result.workflow {
            if w.coverage.len() != planned.len()
                || w.definitions.len() != self.request.workflow.as_ref().unwrap().reviewers.len()
            {
                return Err("Invalid coverage or reviewer count".into());
            }
            for (c, p) in w.coverage.iter().zip(planned.iter()) {
                if c.id != p.id
                    || c.source_index != p.source_index
                    || c.from_utf8 != p.from_utf8
                    || c.to_utf8 != p.to_utf8
                    || c.window_from != p.window_from
                    || c.window_to != p.window_to
                    || c.context_ranges != p.context_ranges
                    || c.reviewer != p.reviewer
                    || ![
                        "queued",
                        "running",
                        "completed",
                        "failed",
                        "cancelled",
                        "notRun",
                    ]
                    .contains(&c.status.as_str())
                {
                    return Err("Invalid stored coverage coordinates".into());
                }
            }
            for (i, d) in w.definitions.iter().enumerate() {
                if d.instance_id != format!("reviewer-{}", i + 1)
                    || d.definition.id != self.request.workflow.as_ref().unwrap().reviewers[i]
                    || d.definition.version == 0
                    || d.definition.display_name.len() > 128
                    || d.definition.id.len() > 64
                {
                    return Err("Invalid reviewer snapshot identity".into());
                }
            }
            let sources = self
                .request
                .snapshots
                .iter()
                .map(|s| (s, false))
                .chain(
                    self.request
                        .workflow
                        .as_ref()
                        .unwrap()
                        .context
                        .iter()
                        .map(|s| (s, true)),
                )
                .collect::<Vec<_>>();
            if w.sources.len() != sources.len() {
                return Err("Invalid captured source manifest".into());
            }
            for (order, (view, (source, read_only))) in w.sources.iter().zip(sources).enumerate() {
                if view.path != source.path
                    || view.source_hash != text_hash(&source.source)
                    || view.read_only != read_only
                    || view.order != order
                    || view.id
                        != text_hash(&format!(
                            "{}:{}:{}",
                            project,
                            source.path,
                            text_hash(&source.source)
                        ))
                {
                    return Err("Captured source manifest changed".into());
                }
            }
        }
        if let Some(w) = &self.result.workflow {
            for d in &w.definitions {
                if text_hash(&serde_json::to_string(&d.definition).map_err(|_| "Invalid reviewer")?)
                    != d.hash
                    || d.definition.instructions.len() > 4000
                {
                    return Err("Reviewer definition snapshot changed".into());
                }
            }
        } else {
            return Err("Review provenance missing".into());
        }
        self.request.repository_id = repository_id.into();
        self.expected = self
            .request
            .snapshots
            .iter()
            .map(|s| (s.path.clone(), s.source.clone()))
            .collect();
        self.prepared.clear();
        let mut ids = std::collections::HashSet::new();
        for item in &self.result.edits {
            if !ids.insert(&item.edit.id)
                || item.edit.id != format!("finding-{}", &self.fingerprint(&item.edit)[..32])
            {
                return Err("Stored finding identity changed".into());
            }
            ReviewOutput {
                schema_version: 1,
                edits: vec![item.edit.clone()],
            }
            .validate(&self.request)
            .map_err(|e| e.to_string())?;
        }
        let decisions = self.result.workflow.as_ref().map(|v| v.decisions.clone());
        let ledger = std::mem::take(&mut self.ledger);
        for e in &mut self.result.edits {
            if matches!(e.status.as_str(), "accepted" | "supersededByAuthorChoice") {
                e.status = "pending".into()
            }
        }
        for event in ledger {
            let item = self.index(&event.finding_id)?;
            self.result.edits[item].status = "pending".into();
            let p = self.candidate_inner(&event.finding_id, project, false)?;
            if !verified(&p)
                || p.id != event.proposal_id
                || p.base_hash != event.base_hash
                || p.replacement_hash != event.replacement_hash
                || p.diff_hash != event.diff_hash
            {
                return Err("Review lineage has an unexplained apply; preserve source and inspect its receipts".into());
            }
            self.prepared.insert(event.finding_id.clone(), p);
            self.applied(
                repository_id,
                &event.proposal_id,
                &event.base_hash,
                &event.replacement_hash,
                &event.diff_hash,
            );
        }
        if let (Some(w), Some(decisions)) = (&mut self.result.workflow, decisions) {
            w.decisions = decisions;
        }
        for e in &self.result.edits {
            let value = ReviewOutput {
                schema_version: 1,
                edits: vec![e.edit.clone()],
            };
            value.validate(&self.request).map_err(|e| e.to_string())?;
            if self.fingerprint(&e.edit)!=e.fingerprint||e.patch!=serde_json::to_string(&serde_json::json!({"path":e.edit.path,"fromUtf8":e.edit.from_utf8,"toUtf8":e.edit.to_utf8,"before":e.edit.original,"replacement":e.edit.replacement})).map_err(|_|"Invalid canonical patch")?||text_hash(&e.patch)!=e.patch_hash||!matches!(e.status.as_str(),"pending"|"prepared"|"accepted"|"rejected"|"supersededByAuthorChoice"|"blockedByAppliedDecision"){return Err("Invalid stored finding".into())}
        }
        self.regroup();
        Ok(self)
    }
    pub fn reconcile_receipts(&mut self, records: &[ReviewReceiptEvidence]) -> Result<(), String> {
        for (kind, status, id, base, replacement, diff, attribution) in records {
            let Some(a) = attribution else { continue };
            let Some(index) = self
                .result
                .edits
                .iter()
                .position(|e| e.fingerprint == a.fingerprint)
            else {
                continue;
            };
            if kind == "reject"
                && status == "rejected"
                && matches!(
                    self.result.edits[index].status.as_str(),
                    "pending" | "prepared"
                )
            {
                let id2 = self.result.edits[index].edit.id.clone();
                self.rejected(&id2, id.clone())?;
            } else if a.review_id == self.id()
                && kind == "apply"
                && status == "completed"
                && self.result.edits[index].status == "prepared"
                && self.result.edits[index].proposal_id.as_deref() == Some(id)
            {
                let finding = self.result.edits[index].edit.id.clone();
                let p = self.candidate_inner(&finding, &self.project_key, false)?;
                if p.origin.review.as_ref() == Some(a)
                    && p.base_hash == *base
                    && p.replacement_hash == *replacement
                    && p.diff_hash == *diff
                {
                    self.prepared.insert(finding, p);
                    let repository_id = self.request.repository_id.clone();
                    self.applied(&repository_id, id, base, replacement, diff);
                }
            }
        }
        Ok(())
    }
    pub fn validate_binding(&self, a: &proposal_store::ReviewAttribution) -> Result<(), String> {
        let item = &self.result.edits[self.index(&a.finding_id)?];
        if !matches!(item.status.as_str(), "pending" | "prepared") {
            return Err("This suggestion already has a durable decision".into());
        }
        if self.id() != a.review_id
            || self.result.edits[self.index(&a.finding_id)?].fingerprint != a.fingerprint
            || self.competing(&a.finding_id) != a.competing
        {
            return Err("Review conflict membership changed; inspect and choose again".into());
        }
        if self.result.edits[self.index(&a.finding_id)?].source_stale {
            return Err("Source or scene mapping changed outside the accepted lineage".into());
        }
        self.check_choice(&a.finding_id)
    }
    pub fn revision_data(&self) -> (String, u64) {
        (self.id().into(), self.revision)
    }
    pub fn source_state(&mut self, path: &str, text: Option<&str>) {
        let stale = self.expected.get(path).map(String::as_str) != text;
        for e in &mut self.result.edits {
            if e.edit.path == path {
                e.source_stale = stale;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use drafting_questions::review::{ReviewRole, ReviewSnapshot};
    fn session() -> ReviewSession {
        let request = ReviewRequest {
            workflow: None,
            request_id: "review-one".into(),
            repository_id: "repo".into(),
            scope: ReviewScope::Scene,
            snapshots: vec![ReviewSnapshot {
                path: "scenes/one.md".into(),
                source: "Bad cat and bad dog.".into(),
                source_hash: "a".repeat(64),
                scene_id: None,
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
    #[test]
    fn unicode_shift_and_repeated_passages_preserve_unrelated_cross_file_edits() {
        let seed = session();
        let mut request = seed.request.clone();
        request.scope = ReviewScope::Chapter;
        request.snapshots[0].source = "🐺 bad / bad / keep.\n".into();
        request.snapshots.push(ReviewSnapshot {
            path: "scenes/two.md".into(),
            source: "bad ending".into(),
            source_hash: "b".repeat(64),
            scene_id: None,
        });
        let mut first = seed.view().edits[0].edit.clone();
        first.from_utf8 = 5;
        first.to_utf8 = 8;
        first.original = "bad".into();
        first.replacement = "excellent".into();
        let mut second = first.clone();
        second.id = "two".into();
        second.from_utf8 = 11;
        second.to_utf8 = 14;
        second.replacement = "good".into();
        let mut third = first.clone();
        third.id = "three".into();
        third.path = "scenes/two.md".into();
        third.from_utf8 = 0;
        third.to_utf8 = 3;
        third.replacement = "clean".into();
        let mut s = ReviewSession::new(
            request,
            ReviewOutput {
                schema_version: 1,
                edits: vec![first, second, third],
            },
            "test-model".into(),
        )
        .unwrap();
        let first = s.candidate("one", &"b".repeat(64)).unwrap();
        s.prepared("one", first.clone()).unwrap();
        accept(&mut s, &first);
        let second = s.candidate("two", &"b".repeat(64)).unwrap();
        assert_eq!(second.replacement_text, "🐺 excellent / good / keep.\n");
        s.prepared("two", second.clone()).unwrap();
        accept(&mut s, &second);
        let third = s.candidate("three", &"b".repeat(64)).unwrap();
        assert_eq!(third.replacement_text, "clean ending");
        assert_eq!(
            s.expected("scenes/one.md").unwrap(),
            "🐺 excellent / good / keep.\n"
        );
    }

    fn workflow_session(reviewers: usize) -> ReviewSession {
        let seed = session();
        let mut request = seed.request.clone();
        request.workflow = Some(drafting_questions::review_workflow::Options {
            reviewers: vec!["contextual".into(); reviewers],
            context: vec![],
            context_note: String::new(),
            ranges: vec![],
            review_id: None,
        });
        ReviewSession::workflow(
            request,
            "b".repeat(64),
            "test-model".into(),
            "account".into(),
            1,
        )
        .unwrap()
    }
    fn call(
        s: &ReviewSession,
        index: usize,
        edits: Vec<ReviewEdit>,
    ) -> drafting_questions::review_workflow::Batch {
        let mut coverage = s.coverage()[index].clone();
        coverage.status = "completed".into();
        coverage.request_id = Some(format!("provider-call-{index}"));
        drafting_questions::review_workflow::Batch {
            calls: vec![drafting_questions::review_workflow::CallResult {
                provider_response_id: None,
                coverage,
                edits,
                model: "test-model".into(),
            }],
            cancelled: false,
            limit_reached: false,
        }
    }
    #[test]
    fn exact_duplicate_merges_provenance_but_late_and_regenerated_reject_stays_dismissed() {
        let mut s = workflow_session(2);
        let edit = session().view().edits[0].edit.clone();
        s.ingest(call(&s, 0, vec![edit.clone()]), &Default::default())
            .unwrap();
        let id = s.view().edits[0].edit.id.clone();
        s.rejected(&id, uuid::Uuid::new_v4().to_string()).unwrap();
        s.ingest(call(&s, 1, vec![edit.clone()]), &Default::default())
            .unwrap();
        assert_eq!(s.view().edits.len(), 1);
        assert_eq!(s.view().edits[0].provenance.len(), 2);
        assert_eq!(s.view().edits[0].status, "rejected");
        s.revision = 1;
        let copy: ReviewSession =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        let copy = copy
            .restore(&"b".repeat(64), "reopened", |_| false)
            .unwrap();
        assert_eq!(copy.view().edits[0].status, "rejected");
        let mut rerun = workflow_session(1);
        rerun
            .ingest(call(&rerun, 0, vec![edit]), &copy.tombstones())
            .unwrap();
        assert_eq!(rerun.view().edits[0].status, "rejected");
        assert!(rerun.candidate(&id, &"b".repeat(64)).is_err());
    }
    #[test]
    fn conflict_requires_explicit_choice_records_competitors_and_refuses_new_membership() {
        let mut s = workflow_session(2);
        let first = session().view().edits[0].edit.clone();
        let mut other = first.clone();
        other.id = "alternative".into();
        other.replacement = "Fine".into();
        s.ingest(call(&s, 0, vec![first.clone(), other]), &Default::default())
            .unwrap();
        let id = s.view().edits[0].edit.id.clone();
        assert!(s.candidate(&id, &"b".repeat(64)).is_err());
        s.choose(&id).unwrap();
        let p = s.candidate(&id, &"b".repeat(64)).unwrap();
        assert_eq!(p.origin.review.as_ref().unwrap().competing.len(), 1);
        s.prepared(&id, p.clone()).unwrap();
        let mut late = first;
        late.id = "late".into();
        late.replacement = "Bright".into();
        s.ingest(call(&s, 1, vec![late]), &Default::default())
            .unwrap();
        assert!(s.candidate(&id, &"b".repeat(64)).is_err());
        assert!(s
            .validate_binding(p.origin.review.as_ref().unwrap())
            .is_err());
        s.choose(&id).unwrap();
        let p = s.candidate(&id, &"b".repeat(64)).unwrap();
        s.validate_binding(p.origin.review.as_ref().unwrap())
            .unwrap();
        s.prepared(&id, p.clone()).unwrap();
        accept(&mut s, &p);
        assert_eq!(
            s.view()
                .edits
                .iter()
                .filter(|v| v.status == "supersededByAuthorChoice")
                .count(),
            2
        );
        assert_eq!(
            s.expected("scenes/one.md").unwrap(),
            "Good cat and bad dog."
        );
    }
    #[test]
    fn same_point_insertions_are_alternatives_without_a_default_winner() {
        let mut s = workflow_session(1);
        let mut a = session().view().edits[0].edit.clone();
        a.from_utf8 = 4;
        a.to_utf8 = 4;
        a.original.clear();
        a.replacement = "small ".into();
        let mut b = a.clone();
        b.id = "other".into();
        b.replacement = "large ".into();
        s.ingest(call(&s, 0, vec![a, b]), &Default::default())
            .unwrap();
        assert!(s
            .view()
            .edits
            .iter()
            .all(|e| e.conflict_group.is_some() && !e.selected));
        let id = s.view().edits[1].edit.id.clone();
        assert!(s.candidate(&id, &"b".repeat(64)).is_err());
        s.choose(&id).unwrap();
        let p = s.candidate(&id, &"b".repeat(64)).unwrap();
        assert_eq!(p.replacement_text, "Bad large cat and bad dog.");
    }
    #[test]
    fn restart_validated_receipt_chain_preserves_remaining_edits_and_refuses_forgery() {
        let mut s = workflow_session(1);
        let edits = session().view().edits.into_iter().map(|e| e.edit).collect();
        s.ingest(call(&s, 0, edits), &Default::default()).unwrap();
        let id = s.view().edits[0].edit.id.clone();
        let second = s.view().edits[1].edit.id.clone();
        let p = s.candidate(&id, &"b".repeat(64)).unwrap();
        s.prepared(&id, p.clone()).unwrap();
        accept(&mut s, &p);
        s.revision = 1;
        let json = serde_json::to_string(&s).unwrap();
        let restored: ReviewSession = serde_json::from_str(&json).unwrap();
        let restored = restored
            .restore(&"b".repeat(64), "reopened", |candidate| {
                candidate.id == p.id
                    && candidate.base_hash == p.base_hash
                    && candidate.replacement_hash == p.replacement_hash
                    && candidate.diff_hash == p.diff_hash
                    && candidate.origin.review == p.origin.review
            })
            .unwrap();
        assert_eq!(
            restored
                .candidate(&second, &"b".repeat(64))
                .unwrap()
                .replacement_text,
            "Good cat and great dog."
        );
        let forged: ReviewSession = serde_json::from_str(&json).unwrap();
        assert!(forged
            .restore(&"b".repeat(64), "reopened", |_| false)
            .is_err());
    }
    #[test]
    fn receipt_before_record_crash_reconciles_without_replaying_approval() {
        let mut s = workflow_session(1);
        let edit = session().view().edits[0].edit.clone();
        s.ingest(call(&s, 0, vec![edit]), &Default::default())
            .unwrap();
        let id = s.view().edits[0].edit.id.clone();
        let p = s.candidate(&id, &"b".repeat(64)).unwrap();
        s.prepared(&id, p.clone()).unwrap();
        s.revision = 1;
        let mut saved: ReviewSession =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        saved = saved.restore(&"b".repeat(64), "repo", |_| false).unwrap();
        saved
            .reconcile_receipts(&[(
                "apply".into(),
                "completed".into(),
                p.id.clone(),
                p.base_hash.clone(),
                p.replacement_hash.clone(),
                p.diff_hash.clone(),
                p.origin.review.clone(),
            )])
            .unwrap();
        assert_eq!(saved.view().edits[0].status, "accepted");
        assert!(saved.candidate(&id, &"b".repeat(64)).is_err());
    }
    #[test]
    fn adjacent_protected_boundary_is_an_explicit_conflict_and_external_edits_are_source_local() {
        let mut s = workflow_session(1);
        s.request.snapshots[0].source = "ab".into();
        s.request.snapshots[0].source_hash = text_hash("ab");
        s = ReviewSession::workflow(
            s.request,
            "b".repeat(64),
            "test-model".into(),
            "account".into(),
            1,
        )
        .unwrap();
        let edit = |id: &str, from, to, replacement: &str| ReviewEdit {
            id: id.into(),
            path: "scenes/one.md".into(),
            from_utf8: from,
            to_utf8: to,
            original: "ab"[from..to].into(),
            replacement: replacement.into(),
            reason: "Boundary".into(),
            role: drafting_questions::review::ReviewRole::Editor,
        };
        // Each edit alone is safe; together they would silently make CRLF.
        s.ingest(
            call(&s, 0, vec![edit("a", 0, 1, "\r"), edit("b", 1, 2, "\n")]),
            &Default::default(),
        )
        .unwrap();
        assert!(s
            .view()
            .edits
            .iter()
            .all(|e| e.conflict_group.is_some() && !e.selected));
        let ids = s
            .view()
            .edits
            .iter()
            .map(|e| e.edit.id.clone())
            .collect::<Vec<_>>();
        assert!(s.candidate(&ids[0], &"b".repeat(64)).is_err());
        s.source_state("another.md", Some("external"));
        assert!(s.view().edits.iter().all(|e| !e.source_stale));
        s.source_state("scenes/one.md", Some("external"));
        assert!(s.view().edits.iter().all(|e| e.source_stale));
    }
    #[test]
    fn restored_definition_snapshots_are_immutable_and_corrupt_coverage_or_hashes_refuse() {
        let mut s = workflow_session(1);
        s.revision = 1;
        let value = serde_json::to_value(&s).unwrap();
        for path in ["coverage", "definition"] {
            let mut changed = value.clone();
            if path == "coverage" {
                changed["result"]["workflow"]["coverage"][0]["windowTo"] = serde_json::json!(9999);
            } else {
                changed["result"]["workflow"]["definitions"][0]["definition"]["instructions"] =
                    serde_json::json!("Changed later");
            }
            let loaded: ReviewSession = serde_json::from_value(changed).unwrap();
            assert!(loaded.restore(&"b".repeat(64), "new", |_| false).is_err());
        }
        let loaded: ReviewSession = serde_json::from_value(value).unwrap();
        let loaded = loaded.restore(&"b".repeat(64), "new", |_| false).unwrap();
        assert_eq!(loaded.definitions(), s.definitions());
    }
}
