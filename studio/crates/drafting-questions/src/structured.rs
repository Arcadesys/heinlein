//! Shared provider contract. Source locations are resolved locally, never generated.
use crate::{review::ReviewRole, QuestionError, MAX_ANSWER_BYTES};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const INSTRUCTIONS: &str = "Return only the shared schemaVersion 2 JSON object. Put the direct answer or assessment in answer. Include only justified strengths and findings; either array may be empty. Each finding has text, evidence copied verbatim from supplied source, and editIds linking any edits that address it; use an empty editIds array for advice without a text patch. Each edit has a unique short alphanumeric id, sceneIndex, exact original, replacement, concise reason, and role (proofreader or editor). Copy original verbatim and include enough surrounding source that it occurs exactly once in its scene. Heinlein calculates offsets; never emit offsets. For insertions include an existing anchor in both original and replacement. Return empty edits when no change is warranted. No Markdown fences or full rewritten passage. Suggestions are advisory, never approval or permission to apply. schemaVersion must be 2.";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assessment: Option<crate::review::ReadingAssessment>,
    pub answer: String,
    pub strengths: Vec<String>,
    pub findings: Vec<Finding>,
    pub edits: Vec<Edit>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Finding {
    pub text: String,
    pub evidence: String,
    pub edit_ids: Vec<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub id: String,
    pub scene_index: usize,
    pub original: String,
    pub replacement: String,
    pub reason: String,
    pub role: ReviewRole,
}
fn invalid() -> QuestionError {
    QuestionError::invalid_response()
}
fn valid_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty()
        && text.len() <= max
        && !text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

/// Also checks overlapping occurrences, e.g. "aa" in "aaa".
pub fn locate(source: &str, original: &str) -> Result<(usize, usize), QuestionError> {
    if original.is_empty() {
        return Err(invalid());
    }
    let from = source.find(original).ok_or_else(invalid)?;
    let next = from
        + source[from..]
            .chars()
            .next()
            .ok_or_else(invalid)?
            .len_utf8();
    if source[next..].contains(original) {
        return Err(invalid());
    }
    Ok((from, from + original.len()))
}
impl Response {
    pub fn parse(text: &str) -> Result<Self, QuestionError> {
        if text.len() > MAX_ANSWER_BYTES {
            return Err(QuestionError::response_too_large());
        }
        let result: Self = serde_json::from_str(text).map_err(|_| invalid())?;
        if result.schema_version != 2
            || !valid_text(&result.answer, 2000)
            || result.strengths.len() > 32
            || result.findings.len() > 32
            || result.edits.len() > 32
            || result.strengths.iter().any(|s| !valid_text(s, 2000))
        {
            return Err(invalid());
        }
        if let Some(assessment) = &result.assessment {
            assessment.validate()?;
        }
        let mut ids = HashSet::new();
        for edit in &result.edits {
            if !crate::valid_id(&edit.id)
                || !ids.insert(&edit.id)
                || edit.scene_index >= 16
                || !valid_text(&edit.original, 4000)
                || edit.original == edit.replacement
                || edit.replacement.len() > 4000
                || !valid_text(&edit.reason, 1000)
                || edit.original.contains('—')
                || edit.replacement.contains('—')
                || edit
                    .replacement
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(invalid());
            }
        }
        for finding in &result.findings {
            let mut linked = HashSet::new();
            if !valid_text(&finding.text, 2000)
                || !valid_text(&finding.evidence, 2000)
                || finding.edit_ids.len() > 32
                || finding
                    .edit_ids
                    .iter()
                    .any(|id| !ids.contains(id) || !linked.insert(id))
            {
                return Err(invalid());
            }
        }
        Ok(result)
    }
    pub fn validate_sources(&self, sources: &[&str]) -> Result<Vec<(usize, usize)>, QuestionError> {
        if self
            .findings
            .iter()
            .any(|f| !sources.iter().any(|s| s.contains(&f.evidence)))
        {
            return Err(invalid());
        }
        self.edits
            .iter()
            .map(|e| locate(sources.get(e.scene_index).ok_or_else(invalid)?, &e.original))
            .collect()
    }
}

pub fn format() -> serde_json::Value {
    serde_json::json!({"type":"json_schema","name":"heinlein_advice_v2","strict":true,"schema":{
        "type":"object","additionalProperties":false,
        "required":["schemaVersion","answer","strengths","findings","edits"],
        "properties":{
            "schemaVersion":{"type":"integer","enum":[2]},
            "answer":{"type":"string","minLength":1,"maxLength":2000},
            "strengths":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}},
            "findings":{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,
                "required":["text","evidence","editIds"],"properties":{
                    "text":{"type":"string","minLength":1,"maxLength":2000},
                    "evidence":{"type":"string","minLength":1,"maxLength":2000},
                    "editIds":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":64}}
                }}},
            "edits":{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,
                "required":["id","sceneIndex","original","replacement","reason","role"],"properties":{
                    "id":{"type":"string","maxLength":64},"sceneIndex":{"type":"integer","minimum":0,"maximum":15},
                    "original":{"type":"string","minLength":1,"maxLength":4000},"replacement":{"type":"string","maxLength":4000},
                    "reason":{"type":"string","minLength":1,"maxLength":1000},"role":{"type":"string","enum":["proofreader","editor"]}
                }}}
        }
    }})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn advice() -> Value {
        json!({"schemaVersion":2,"assessment":{"strengths":"The rain gives the scene a distinct sound.","improvements":"A stronger verb could make the sound more immediate."},"answer":"Clear scene.","strengths":[],"findings":[{"text":"Use a stronger verb.","evidence":"Rain tapped.","editIds":["e1"]}],"edits":[{"id":"e1","sceneIndex":0,"original":"Rain tapped.","replacement":"Rain drummed.","reason":"More immediate.","role":"editor"}]})
    }
    fn envelope(value: &Value) -> Vec<u8> {
        let mut response = crate::tests::answer_value();
        response["output"][0]["content"][0]["text"] = json!(value.to_string());
        serde_json::to_vec(&response).unwrap()
    }
    #[test]
    fn review_requires_both_assessments_without_forcing_findings_or_edits() {
        let ask: Value = serde_json::from_slice(
            &crate::request_body(&crate::tests::request("ask"), "model").unwrap(),
        )
        .unwrap();
        let review: Value = serde_json::from_slice(
            &crate::review::request_body(&review_request("Rain tapped."), "model").unwrap(),
        )
        .unwrap();
        assert!(ask["text"]["format"]["schema"]["properties"]
            .get("assessment")
            .is_none());
        assert!(review["text"]["format"]["schema"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("assessment")));
        assert_eq!(
            review["text"]["format"]["schema"]["properties"]["assessment"]["required"],
            json!(["strengths", "improvements"])
        );
        assert!(
            ask["text"]["format"]["schema"]["properties"]["edits"]["items"]["properties"]
                .get("fromUtf8")
                .is_none()
        );
        assert!(ask["text"]["format"]["schema"]["properties"]["findings"]
            .get("minItems")
            .is_none());
        for count in [0, 1, 2, 4, 32] {
            let mut value = advice();
            value["findings"] = json!(vec![
                json!({"text":"The rain sets the mood.","evidence":"Rain tapped.","editIds":[]});
                count
            ]);
            value["edits"] = json!([]);
            assert!(crate::review::parse_review(
                &review_request("Rain tapped."),
                &envelope(&value)
            )
            .is_ok());
        }
    }
    fn review_request(source: &str) -> crate::review::ReviewRequest {
        crate::review::ReviewRequest {
            request_id: "review".into(),
            repository_id: "local".into(),
            scope: crate::review::ReviewScope::Scene,
            snapshots: vec![crate::review::ReviewSnapshot {
                path: "scene.md".into(),
                source: source.into(),
                source_hash: "hash".into(),
                scene_id: None,
            }],
            workflow: None,
        }
    }
    #[test]
    fn review_rejects_missing_or_empty_assessments_but_ask_does_not_require_them() {
        let mut value = advice();
        value.as_object_mut().unwrap().remove("assessment");
        assert!(Response::parse(&value.to_string()).is_ok());
        assert!(
            crate::review::parse_review(&review_request("Rain tapped."), &envelope(&value))
                .is_err()
        );
        for invalid in [
            json!(null),
            json!({"strengths":" ", "improvements":"Clear."}),
            json!({"strengths":"Clear.", "improvements":""}),
            json!({"strengths":"Clear.", "improvements":"x".repeat(2001)}),
        ] {
            value["assessment"] = invalid;
            assert!(crate::review::parse_review(
                &review_request("Rain tapped."),
                &envelope(&value)
            )
            .is_err());
        }
    }
    #[test]
    fn computes_byte_offsets_and_retains_grounded_feedback() {
        let source = "É🦊\r\nRain tapped.\r\n";
        let (_, serialized) =
            crate::review::parse_review(&review_request(source), &envelope(&advice())).unwrap();
        let result: crate::review::ReviewOutput = serde_json::from_str(&serialized).unwrap();
        assert_eq!(result.edits[0].from_utf8, source.find("Rain").unwrap());
        assert_eq!(
            result.edits[0].to_utf8,
            source.find("Rain").unwrap() + "Rain tapped.".len()
        );
        assert_eq!(result.reading_feedback.unwrap().improvements.len(), 1);
        assert!(serialized.contains("evidence"));
        let mut request = crate::tests::request("ask");
        request.context = source.into();
        let answer = crate::parse_question_response(&request, &envelope(&advice())).unwrap();
        assert_eq!(
            Response::parse(&answer.text).unwrap().findings[0].evidence,
            "Rain tapped."
        );
    }
    #[test]
    fn rejects_ambiguous_missing_overlapping_and_unsafe_targets() {
        for source in [
            "Rain tapped. Rain tapped.",
            "Nothing matching.",
            "---\nRain tapped.\n---\nBody",
        ] {
            assert!(
                crate::review::parse_review(&review_request(source), &envelope(&advice())).is_err()
            );
        }
        assert!(locate("aaa", "aa").is_err());
        assert_eq!(locate("É🦊\r\nRain", "Rain").unwrap(), (8, 12));
        let mut value = advice();
        value["edits"].as_array_mut().unwrap().push(json!({"id":"e2","sceneIndex":0,"original":"tapped.","replacement":"fell.","reason":"A verb.","role":"editor"}));
        assert!(
            crate::review::parse_review(&review_request("Rain tapped."), &envelope(&value))
                .is_err()
        );
    }
    #[test]
    fn workflow_offsets_respect_editable_ranges_and_context_stays_read_only() {
        use crate::review_workflow::{EditableRange, Options};
        let mut request = review_request("É🦊\r\nRain tapped.");
        request.snapshots[0].source_hash = "a".repeat(64);
        request.workflow = Some(Options {
            consolidate: false,
            reviewers: vec!["contextual".into()],
            context: vec![crate::review::ReviewSnapshot {
                path: "context.md".into(),
                source: "Private context quotation.".into(),
                source_hash: "b".repeat(64),
                scene_id: None,
            }],
            context_note: String::new(),
            full_context_order: None,
            ranges: vec![EditableRange {
                path: "scene.md".into(),
                from_utf8: 8,
                to_utf8: 20,
            }],
            review_id: None,
        });
        let mut value = advice();
        value["findings"][0]["evidence"] = json!("Private context quotation.");
        let (_, saved) = crate::review::parse_review(&request, &envelope(&value)).unwrap();
        let output: crate::review::ReviewOutput = serde_json::from_str(&saved).unwrap();
        assert_eq!(output.edits[0].from_utf8, 8);
        let body: Value = serde_json::from_slice(
            &crate::review::workflow_body(&request, "model", "Contextual review").unwrap(),
        )
        .unwrap();
        assert_eq!(body["text"]["format"], crate::review::review_format());
        request.workflow.as_mut().unwrap().ranges[0].from_utf8 = 9;
        assert!(crate::review::parse_review(&request, &envelope(&value)).is_err());
        request.workflow.as_mut().unwrap().ranges[0].from_utf8 = 8;
        value["edits"][0]["sceneIndex"] = json!(1);
        value["edits"][0]["original"] = json!("Private context quotation.");
        assert!(crate::review::parse_review(&request, &envelope(&value)).is_err());
    }
    #[test]
    fn rejects_schema_errors_bad_links_and_ungrounded_evidence() {
        for (field, bad) in [("fromUtf8", json!(0)), ("tools", json!([]))] {
            let mut value = advice();
            value["edits"][0][field] = bad;
            assert!(Response::parse(&value.to_string()).is_err());
        }
        let mut value = advice();
        value["findings"][0]["editIds"] = json!(["missing"]);
        assert!(Response::parse(&value.to_string()).is_err());
        let mut value = advice();
        value["findings"][0]["evidence"] = json!("Invented quotation");
        assert!(
            crate::review::parse_review(&review_request("Rain tapped."), &envelope(&value))
                .is_err()
        );
        let duplicate = advice().to_string().replacen(
            "\"schemaVersion\":2",
            "\"schemaVersion\":2,\"schemaVersion\":2",
            1,
        );
        assert!(Response::parse(&duplicate).is_err());
        let mut request = crate::tests::request("ask");
        request.context = "Rain tapped.".into();
        let mut response: Value = serde_json::from_slice(&envelope(&advice())).unwrap();
        response["status"] = json!("incomplete");
        assert!(
            crate::parse_question_response(&request, &serde_json::to_vec(&response).unwrap())
                .is_err()
        );
        assert!(crate::parse_question_response(&request, &crate::tests::answer_bytes()).is_err());
    }
}
