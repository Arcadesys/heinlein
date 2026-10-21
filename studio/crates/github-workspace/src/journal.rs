use crate::{registry::StateDir, uuid_id, Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub status: String,
    pub old_head: String,
    pub head: String,
    pub branch: String,
    pub remote_before: Option<String>,
    pub url: Option<String>,
    pub pr_number: Option<u64>,
    pub message: String,
}
impl Receipt {
    pub fn save(&self, dir: &StateDir) -> Result<()> {
        uuid_id(&self.id)?;
        uuid_id(&self.workspace_id)?;
        dir.write(&format!("op-{}.json", self.id), self)
    }
    pub fn load(dir: &StateDir, id: &str) -> Result<Option<Self>> {
        uuid_id(id)?;
        let record = dir.read::<Self>(&format!("op-{id}.json"))?;
        if let Some(r) = &record {
            if r.id != id
                || !["prepared", "succeeded", "failed", "unknown"].contains(&r.status.as_str())
            {
                return Err(Error::Storage);
            }
        }
        Ok(record)
    }
}

pub fn receipts(dir: &StateDir) -> Result<Vec<Receipt>> {
    dir.check()?;
    let mut result = Vec::new();
    for entry in std::fs::read_dir(dir.path())? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(id) = name
            .strip_prefix("op-")
            .and_then(|s| s.strip_suffix(".json"))
        {
            if let Some(r) = Receipt::load(dir, id)? {
                result.push(r)
            }
            if result.len() > 1024 {
                return Err(Error::Limit);
            }
        }
    }
    dir.check()?;
    Ok(result)
}
