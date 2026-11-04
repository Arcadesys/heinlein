//! Author-defined review agents. One JSON file per reviewer in the app data dir, shared by all projects.
use drafting_questions::review_workflow::{set_custom_reviewers, CustomReviewer, CUSTOM_PREFIX};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_REVIEWERS: usize = 50;

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "Reviewer storage unavailable")?
        .join("custom-reviewers"))
}

fn read_all(dir: &std::path::Path) -> Vec<CustomReviewer> {
    let mut list: Vec<CustomReviewer> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|text| serde_json::from_str::<CustomReviewer>(&text).ok())
        .filter(|r| r.validate().is_ok())
        .collect();
    list.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    list.dedup_by(|a, b| a.id == b.id);
    list
}

/// Reload from disk into the process-wide definition list.
pub(crate) fn refresh(app: &tauri::AppHandle) -> Result<Vec<CustomReviewer>, String> {
    let list = read_all(&dir(app)?);
    set_custom_reviewers(&list);
    Ok(list)
}

#[tauri::command]
pub(crate) fn list_custom_reviewers(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<CustomReviewer>, String> {
    super::check_window(&window)?;
    refresh(&app)
}

#[tauri::command]
pub(crate) fn save_custom_reviewer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    reviewer: CustomReviewer,
) -> Result<CustomReviewer, String> {
    super::check_window(&window)?;
    let root = dir(&app)?;
    let reviewer = save_at(&root, reviewer)?;
    refresh(&app)?;
    Ok(reviewer)
}

fn save_at(root: &Path, mut reviewer: CustomReviewer) -> Result<CustomReviewer, String> {
    let existing = read_all(root);
    let previous = existing.iter().find(|r| r.id == reviewer.id);
    if reviewer.id.is_empty() {
        if existing.len() >= MAX_REVIEWERS {
            return Err("You can keep up to 50 custom reviewers.".into());
        }
        reviewer.id = format!(
            "{CUSTOM_PREFIX}{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        );
        reviewer.version = 1;
    } else if let Some(old) = previous {
        let changed = old.display_name != reviewer.display_name
            || old.instructions != reviewer.instructions
            || old.output != reviewer.output;
        reviewer.version = if changed {
            old.version + 1
        } else {
            old.version
        };
    } else {
        return Err("That reviewer no longer exists.".into());
    }
    reviewer.display_name = reviewer.display_name.trim().to_string();
    reviewer.description = reviewer.description.trim().to_string();
    reviewer.validate().map_err(|e| e.to_string())?;
    fs::create_dir_all(root).map_err(|_| "Could not save the reviewer.")?;
    let body = serde_json::to_vec_pretty(&reviewer).map_err(|_| "Could not save the reviewer.")?;
    let tmp = root.join(format!("{}.tmp", reviewer.id));
    fs::write(&tmp, body)
        .and_then(|_| fs::rename(&tmp, root.join(format!("{}.json", reviewer.id))))
        .map_err(|_| "Could not save the reviewer.")?;
    Ok(reviewer)
}

#[tauri::command]
pub(crate) fn delete_custom_reviewer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Vec<CustomReviewer>, String> {
    super::check_window(&window)?;
    if !id.starts_with(CUSTOM_PREFIX)
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err("Reviewer id is invalid.".into());
    }
    match fs::remove_file(dir(&app)?.join(format!("{id}.json"))) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not delete the reviewer.".into()),
    }
    refresh(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reviewer_survives_reopen_and_edits_advance_only_its_version() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("reviewers");
        let reviewer = CustomReviewer {
            id: String::new(),
            version: 1,
            display_name: "Emotional punch".into(),
            description: String::new(),
            instructions: "Point to rushed emotional turns.".into(),
            output: "notes".into(),
        };
        let saved = save_at(&root, reviewer).unwrap();
        assert!(saved.id.starts_with(CUSTOM_PREFIX));
        assert_eq!(read_all(&root), vec![saved.clone()]);
        let unchanged = save_at(&root, saved.clone()).unwrap();
        assert_eq!(unchanged.version, 1);
        let mut edited = saved.clone();
        edited.instructions = "Point to rushed emotional turns and undercut beats.".into();
        let edited = save_at(&root, edited).unwrap();
        assert_eq!(edited.version, 2);
        assert_eq!(edited.id, saved.id);
        assert_eq!(read_all(&root), vec![edited.clone()]);
        fs::write(root.join("malformed.json"), b"{bad").unwrap();
        assert_eq!(read_all(&root), vec![edited]);
        let mut invalid = saved.clone();
        invalid.instructions.clear();
        assert!(save_at(&root, invalid).is_err());
        assert_eq!(read_all(&root)[0].version, 2);
        fs::remove_file(root.join(format!("{}.json", saved.id))).unwrap();
        assert!(read_all(&root).is_empty());
    }
}
