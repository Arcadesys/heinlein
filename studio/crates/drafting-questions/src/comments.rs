//! Inline author comments in CriticMarkup form: `{>>note<<}`.
//!
//! Comments are private author directives about the adjacent prose. A model
//! proposal may keep a comment whole or delete it whole, never reword, split or
//! add one. Every check here is purely textual and fails closed.

use std::collections::HashMap;

const OPEN: &str = "{>>";
const CLOSE: &str = "<<}";

/// The shared model instruction, as a macro so it can be `concat!`ed onto the
/// other instruction literals.
macro_rules! comment_instruction {
    () => {
        "Text wrapped in {>> and <<} is a private author comment about the adjacent prose. Treat it as an instruction from the author, never as manuscript prose. Never change a comment's words or add comments. When an edit fully addresses a comment, you may delete that whole comment, delimiters included, inside the same edit, and say so in the explanation."
    };
}

#[allow(dead_code)]
pub const COMMENT_INSTRUCTION: &str = comment_instruction!();

fn has_blank_line(body: &str) -> bool {
    body.split('\n')
        .skip(1)
        .collect::<Vec<_>>()
        .split_last()
        .is_some_and(|(_, inner)| inner.iter().any(|line| line.trim().is_empty()))
}

/// Byte ranges of complete comment spans, delimiters included. A span is the
/// shortest `{>>…<<}` whose body holds no other opener and no blank line.
fn spans(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(o) = text[i..].find(OPEN) {
        let body_start = i + o + OPEN.len();
        let Some(c) = text[body_start..].find(CLOSE) else {
            break;
        };
        let body = &text[body_start..body_start + c];
        if body.contains(OPEN) || has_blank_line(body) {
            // This opener is stray; a later opener may still pair with the closer.
            i = body_start;
            continue;
        }
        let end = body_start + c + CLOSE.len();
        out.push((i + o, end));
        i = end;
    }
    out
}

/// Complete `{>>…<<}` comment spans in source order, delimiters included.
pub fn comments(text: &str) -> Vec<&str> {
    spans(text).into_iter().map(|(a, b)| &text[a..b]).collect()
}

/// Count of `{>>` and `<<}` that are not part of a complete comment span.
pub fn stray_delimiters(text: &str) -> usize {
    let mut count = 0;
    let mut cursor = 0;
    let outside = |segment: &str| segment.matches(OPEN).count() + segment.matches(CLOSE).count();
    for (a, b) in spans(text) {
        count += outside(&text[cursor..a]);
        cursor = b;
    }
    count + outside(&text[cursor..])
}

/// True when `after` keeps each comment of `before` whole or drops it whole:
/// its comments are a sub-multiset of `before`'s (exact text) and it has no
/// more stray delimiters than `before`.
pub fn edit_preserves_comments(before: &str, after: &str) -> bool {
    let mut available: HashMap<&str, usize> = HashMap::new();
    for comment in comments(before) {
        *available.entry(comment).or_default() += 1;
    }
    for comment in comments(after) {
        match available.get_mut(comment) {
            Some(n) if *n > 0 => *n -= 1,
            _ => return false,
        }
    }
    stray_delimiters(after) <= stray_delimiters(before)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_complete_spans_without_crossing_blank_lines() {
        let text = "The world was new {>>wait, what / something more than this<<} and {>>two\nlines<<}.";
        assert_eq!(
            comments(text),
            vec!["{>>wait, what / something more than this<<}", "{>>two\nlines<<}"]
        );
        assert_eq!(stray_delimiters(text), 0);
        let split = "{>>first\n\nsecond<<}";
        assert!(comments(split).is_empty());
        assert_eq!(stray_delimiters(split), 2);
        let spaced_blank = "{>>first\n  \t\nsecond<<}";
        assert!(comments(spaced_blank).is_empty());
        let nested = "{>>a {>>b<<}";
        assert_eq!(comments(nested), vec!["{>>b<<}"]);
        assert_eq!(stray_delimiters(nested), 1);
        assert_eq!(comments("{>>x<<}{>>y<<}"), vec!["{>>x<<}", "{>>y<<}"]);
        assert_eq!(stray_delimiters("open {>> only"), 1);
        assert_eq!(stray_delimiters("close <<} only"), 1);
    }

    #[test]
    fn accepts_keeping_or_deleting_whole_comments() {
        let before = "The world was new {>>wait, what<<} and old {>>later<<}.";
        assert!(edit_preserves_comments(before, before));
        assert!(edit_preserves_comments(before, "The world was dawning and old {>>later<<}."));
        assert!(edit_preserves_comments(before, "The world was dawning and old."));
        assert!(edit_preserves_comments("plain", "plainer"));
    }

    #[test]
    fn rejects_reworded_added_split_or_duplicated_comments() {
        let before = "The world was new {>>wait, what<<}.";
        // Reworded.
        assert!(!edit_preserves_comments(before, "The world was new {>>wait<<}."));
        // Added.
        assert!(!edit_preserves_comments("The world was new.", "The world was new {>>hmm<<}."));
        assert!(!edit_preserves_comments(before, "The world {>>new<<} was new {>>wait, what<<}."));
        // Duplicated.
        assert!(!edit_preserves_comments(before, "{>>wait, what<<} {>>wait, what<<}"));
        // Split into two comments, or broken by a blank line.
        assert!(!edit_preserves_comments(before, "new {>>wait,<<} {>>what<<}."));
        assert!(!edit_preserves_comments(before, "new {>>wait,\n\nwhat<<}."));
        // Half-deleted, leaving a stray delimiter.
        assert!(!edit_preserves_comments(before, "The world was new {>>wait, what."));
        assert!(!edit_preserves_comments(before, "The world was new wait, what<<}."));
    }
}
