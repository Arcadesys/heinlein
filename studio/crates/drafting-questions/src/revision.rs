//! Byte-exact local splicing. This module has no provider or filesystem access.
use crate::{QuestionError, MAX_ANSWER_BYTES, MAX_CONTEXT_BYTES};

fn boundary(source: &str, offset: usize) -> bool {
    source.is_char_boundary(offset)
        && !(offset > 0
            && source.as_bytes().get(offset - 1) == Some(&b'\r')
            && source.as_bytes().get(offset) == Some(&b'\n'))
}

// Preserve a leading YAML block byte-for-byte, including its original newlines.
// An unterminated block is ambiguous, so no automatic revision is proposed.
fn frontmatter_end(source: &str) -> Result<usize, QuestionError> {
    let bom = usize::from(source.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
    let (first, size) = raw_line(&source[bom..]);
    if first != "---" {
        return Ok(0);
    }
    let mut offset = bom + size;
    while offset < source.len() {
        let (line, size) = raw_line(&source[offset..]);
        offset += size;
        if line == "---" {
            return Ok(offset);
        }
    }
    Err(QuestionError::invalid_revision())
}

fn raw_line(source: &str) -> (&str, usize) {
    let end = source.find(['\r', '\n']).unwrap_or(source.len());
    let newline = if source.as_bytes().get(end) == Some(&b'\r')
        && source.as_bytes().get(end + 1) == Some(&b'\n')
    {
        2
    } else {
        usize::from(end < source.len())
    };
    (&source[..end], end + newline)
}

pub fn validate_revision_selection(
    source: &str,
    from: usize,
    to: usize,
    selected: &str,
) -> Result<(), QuestionError> {
    if from >= to
        || to > source.len()
        || !boundary(source, from)
        || !boundary(source, to)
        || selected.is_empty()
        || selected.len() > MAX_CONTEXT_BYTES
        || source.get(from..to) != Some(selected)
        || from < frontmatter_end(source)?
    {
        return Err(QuestionError::invalid_revision());
    }
    Ok(())
}

pub fn splice_revision(
    source: &str,
    from: usize,
    to: usize,
    selected: &str,
    replacement: &str,
) -> Result<String, QuestionError> {
    validate_revision_selection(source, from, to, selected)?;
    if replacement.len() > MAX_ANSWER_BYTES
        || replacement == selected
        || replacement
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(QuestionError::invalid_revision());
    }
    let before = &source[..from];
    let after = &source[to..];
    // Do not accidentally combine separate newline characters into one CRLF.
    let joins_crlf = if replacement.is_empty() {
        before.ends_with('\r') && after.starts_with('\n')
    } else {
        (before.ends_with('\r') && replacement.starts_with('\n'))
            || (replacement.ends_with('\r') && after.starts_with('\n'))
    };
    if joins_crlf {
        return Err(QuestionError::invalid_revision());
    }
    let next = format!("{before}{replacement}{after}");
    let old_frontmatter = frontmatter_end(source)?;
    let new_frontmatter = frontmatter_end(&next)?;
    if old_frontmatter != new_frontmatter || source[..old_frontmatter] != next[..new_frontmatter] {
        return Err(QuestionError::invalid_revision());
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_raw_unicode_crlf_and_frontmatter() {
        let source = "---\r\nid: fox\r\n---\r\nÉlan—🦊\r\nAfter\r\n";
        let from = source.find("Élan").unwrap();
        let selected = "Élan—🦊";
        assert_eq!(
            splice_revision(source, from, from + selected.len(), selected, "Still—🦊").unwrap(),
            "---\r\nid: fox\r\n---\r\nStill—🦊\r\nAfter\r\n"
        );
    }

    #[test]
    fn rejects_stale_or_split_ranges_and_empty_targets() {
        let source = "é🦊\r\nx";
        for (from, to, selected) in [
            (1, 2, "é"),
            (2, 5, "🦊"),
            (0, 7, "é🦊\r"),
            (7, 8, "\n"),
            (0, 2, "e"),
            (0, 0, ""),
            (0, 99, "x"),
        ] {
            assert!(validate_revision_selection(source, from, to, selected).is_err());
        }
        assert!(validate_revision_selection(source, 0, 6, "é🦊").is_ok());
    }

    #[test]
    fn rejects_yaml_overlap_creation_or_unterminated_header() {
        let source = "---\nname: x\n---\nBody";
        assert!(validate_revision_selection(source, 4, 8, "name").is_err());
        assert!(splice_revision("Body", 0, 4, "Body", "---\nname: x\n---\nBody").is_err());
        assert!(validate_revision_selection("---\nunclosed\nBody", 13, 17, "Body").is_err());
        let source = "\u{feff}---\r\nx: y\r\n---\r\nBody";
        assert!(validate_revision_selection(source, 0, 3, "\u{feff}").is_err());
        let source = "---\rid: fox\r---\rBody";
        assert!(validate_revision_selection(source, 4, 11, "id: fox").is_err());
        assert_eq!(
            splice_revision(source, 16, 20, "Body", "Prose").unwrap(),
            "---\rid: fox\r---\rProse"
        );
    }

    #[test]
    fn rejects_new_crlf_joins_but_allows_literal_deletion() {
        assert!(splice_revision("A\rB\nC", 2, 3, "B", "").is_err());
        assert!(splice_revision("A\rB", 2, 3, "B", "\nC").is_err());
        assert!(splice_revision("AB\nC", 1, 2, "B", "C\r").is_err());
        assert_eq!(splice_revision("A fox.", 2, 5, "fox", "").unwrap(), "A .");
        assert!(splice_revision("fox", 0, 3, "fox", "fox").is_err());
        assert!(splice_revision("fox", 0, 3, "fox", "\0").is_err());
    }
}
