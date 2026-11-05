//! Presentation/review preparation only. Never called after author confirmation.
//! Merge exact, disjoint edits in original UTF-8 coordinates; never fuzzy-search
//! replacement text in the current manuscript. Ambiguous alignment stops review.
use std::ops::Range;

#[derive(Debug, PartialEq)]
struct Edit {
    range: Range<usize>,
    text: String,
}

fn tokens(text: &str) -> Vec<(usize, &str)> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut previous = None;
    for (i, ch) in text.char_indices() {
        let kind = if ch.is_alphanumeric() || ch == '_' {
            0
        } else if ch.is_whitespace() {
            1
        } else {
            2
        };
        if let Some(old) = previous {
            if old != kind || kind == 2 {
                result.push((start, &text[start..i]));
                start = i;
            }
        }
        previous = Some(kind);
    }
    if start < text.len() {
        result.push((start, &text[start..]));
    }
    result
}

fn edits(base: &str, changed: &str) -> Result<Vec<Edit>, &'static str> {
    let a = tokens(base);
    let b = tokens(changed);
    let (mut start, mut end_a, mut end_b) = (0, a.len(), b.len());
    while start < end_a && start < end_b && a[start].1 == b[start].1 {
        start += 1;
    }
    while end_a > start && end_b > start && a[end_a - 1].1 == b[end_b - 1].1 {
        end_a -= 1;
        end_b -= 1;
    }
    let (n, m) = (end_a - start, end_b - start);
    let width = m + 1;
    // An expensive/ambiguous merge is advisory failure, never a blanket replacement.
    if (n + 1)
        .checked_mul(width)
        .is_none_or(|cells| cells > 8_000_000)
    {
        return Err("Changes are too extensive to reconcile automatically");
    }
    let mut lengths = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lengths[i * width + j] = if a[start + i].1 == b[start + j].1 {
                1 + lengths[(i + 1) * width + j + 1]
            } else {
                lengths[(i + 1) * width + j].max(lengths[i * width + j + 1])
            };
        }
    }
    let offset = |i: usize| a.get(start + i).map_or(base.len(), |t| t.0);
    let mut result = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[start + i].1 == b[start + j].1 {
            i += 1;
            j += 1;
            continue;
        }
        let from = offset(i);
        let mut text = String::new();
        while i < n || j < m {
            if i < n && j < m && a[start + i].1 == b[start + j].1 {
                break;
            }
            let down = if i < n {
                lengths[(i + 1) * width + j]
            } else {
                0
            };
            let right = if j < m { lengths[i * width + j + 1] } else { 0 };
            if i < n
                && j < m
                && down == right
                && down > 0
                && b[start + j + 1..end_b]
                    .iter()
                    .any(|t| t.1 == a[start + i].1)
                && a[start + i + 1..end_a]
                    .iter()
                    .any(|t| t.1 == b[start + j].1)
            {
                return Err("Repeated or reordered text makes the change position ambiguous");
            }
            if i < n && (j == m || down >= right) {
                i += 1;
            } else {
                text.push_str(b[start + j].1);
                j += 1;
            }
        }
        result.push(Edit {
            range: from..offset(i),
            text,
        });
    }
    for edit in &result {
        // Prefix/suffix trimming can otherwise hide a movable deletion in a
        // repeated phrase ("a a" -> "a"). Do not guess which copy survived.
        let removed = &base[edit.range.clone()];
        let movable = if edit.text.is_empty() {
            removed
        } else if removed.is_empty() {
            &edit.text
        } else {
            continue;
        };
        let previous = base[..edit.range.start].chars().next_back();
        let next = base[edit.range.end..].chars().next();
        if movable
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() && Some(c) == previous)
            || movable
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric() && Some(c) == next)
        {
            return Err("Repeated text makes the change position ambiguous");
        }
    }
    Ok(result)
}

fn touches(a: &Range<usize>, b: &Range<usize>) -> bool {
    if a.is_empty() || b.is_empty() {
        // Insertion order at the same boundary is an author choice.
        a.start <= b.end && b.start <= a.end
    } else {
        a.start < b.end && b.start < a.end
    }
}

pub(super) fn reconcile(base: &str, proposed: &str, current: &str) -> Result<String, &'static str> {
    if current == base {
        return Ok(proposed.into());
    }
    if current == proposed {
        return Ok(current.into());
    }
    let pending = edits(base, proposed)?;
    let saved = edits(base, current)?;
    let mut remaining = Vec::new();
    for edit in pending {
        if saved.contains(&edit) {
            continue;
        }
        if saved.iter().any(|other| touches(&edit.range, &other.range)) {
            return Err(
                "This proposed passage also changed; reconcile the overlapping edits first",
            );
        }
        let shift: isize = saved
            .iter()
            .filter(|other| other.range.end <= edit.range.start)
            .map(|other| other.text.len() as isize - other.range.len() as isize)
            .sum();
        let from = edit
            .range
            .start
            .checked_add_signed(shift)
            .ok_or("Invalid change position")?;
        let to = edit
            .range
            .end
            .checked_add_signed(shift)
            .ok_or("Invalid change position")?;
        if current.get(from..to) != base.get(edit.range.clone()) {
            return Err("The proposed passage no longer matches");
        }
        remaining.push((from..to, edit.text));
    }
    let mut merged = current.to_owned();
    for (range, text) in remaining.into_iter().rev() {
        merged.replace_range(range, &text);
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_words_in_one_paragraph_survive_in_either_order() {
        let base = "Rain tapped the glass; fox waited.\r\n";
        let first = "Rain drummed the glass; fox waited.\r\n";
        let second = "Rain tapped the glass; 🦊 lingered.\r\n";
        let both = "Rain drummed the glass; 🦊 lingered.\r\n";
        assert_eq!(reconcile(base, second, first).unwrap(), both);
        assert_eq!(reconcile(base, first, second).unwrap(), both);
    }
    #[test]
    fn multiple_hunks_and_already_completed_hunks_preserve_other_changes() {
        let base = "# Vivian\n\nKat nodded.\n\nNate showing  his ass.\n";
        let proposal = "## Vivian\n\nKat nodded.\n\nNate showing his ass.\n";
        let current = "# Vivian\n\nKat explicitly gave permission.\n\nNate showing his ass.\n";
        assert_eq!(
            reconcile(base, proposal, current).unwrap(),
            "## Vivian\n\nKat explicitly gave permission.\n\nNate showing his ass.\n"
        );
    }
    #[test]
    fn insertions_and_deletions_shift_utf8_offsets_exactly() {
        let base = "First — 🦊.\nMiddle.\nLast.\n";
        let proposal = "First — 🦊.\nMiddle.\nLast word.\n";
        for current in [
            "First — 🦊.\nNew paragraph.\nMiddle.\nLast.\n",
            "Middle.\nLast.\n",
        ] {
            assert_eq!(
                reconcile(base, proposal, current).unwrap(),
                current.replace("Last.", "Last word.")
            );
        }
    }
    #[test]
    fn overlapping_replacements_and_insertions_stop() {
        assert!(reconcile("Rain tapped.", "Rain drummed.", "Rain pattered.").is_err());
        assert!(reconcile("A B", "A new B", "A other B").is_err());
    }
    #[test]
    fn repeated_reordered_alignment_stops() {
        assert!(edits("a b a c", "b a b c").is_err());
        assert!(reconcile("a a", "b a", "a").is_err());
    }
    #[test]
    fn identical_or_already_applied_changes_are_noops() {
        assert_eq!(reconcile("A", "B", "B").unwrap(), "B");
        assert_eq!(reconcile("", "— 🦊\r\n", "").unwrap(), "— 🦊\r\n");
    }
}
