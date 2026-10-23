//! Native-only managed GitHub workspaces. No Git CLI, helpers, hooks or source logs.
pub mod api;
pub mod auth;
pub mod incoming;
pub mod journal;
pub mod operations;
pub mod registry;
pub mod transport;
use serde::{Deserialize, Serialize};
use std::fmt;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Unavailable,
    Auth,
    StoreLocked,
    StoreDenied,
    StoreCancelled,
    StoreUnavailable,
    StoreInvalid,
    RotationNotSaved,
    Reconnect,
    Account,
    Permission,
    Sso,
    Network,
    RateLimit,
    InvalidUrl,
    InvalidRef,
    UnsafeTree,
    Limit,
    Storage,
    Busy,
    Missing,
    Changed,
    Recovery,
    Conflict,
    Unsupported,
    Uncertain,
    Canceled,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Unavailable => "GitHub connection is unavailable until this app has a public GitHub App client ID.",
            Self::Auth => "GitHub no longer authorizes this connection. Reconnect GitHub when you are ready. Local copies and writing are unchanged.",
            Self::StoreLocked => "The secure credential store is locked or cannot show its access prompt. Unlock it, allow access in macOS, then retry the saved GitHub connection. Nothing was deleted.",
            Self::StoreDenied => "Access to the saved GitHub credential was denied. Allow access in macOS, then retry. Do not sign out to fix a Keychain permission problem.",
            Self::StoreCancelled => "Secure credential access was cancelled. Your saved connection is retained. Retry when you are ready to allow access.",
            Self::StoreUnavailable => "The secure credential store is unavailable. Your connection was not reset. Unlock or restore the OS store, then retry the saved connection.",
            Self::StoreInvalid => "The saved connection could not be read safely. It has not been replaced or deleted. Restore secure-store access before reconnecting.",
            Self::RotationNotSaved => "GitHub renewed the connection, but the secure store could not save it. Keep Heinlein open, allow secure-store access, then retry the saved connection. No stored credential was deleted.",
            Self::Reconnect => "GitHub renewal has expired or was revoked. Reconnect GitHub explicitly; local copies and writing remain available.",
            Self::Account => "Confirm the GitHub account for this project. Accounts are never substituted automatically.",
            Self::Permission => "This GitHub App and account need write access to the selected repository. Your local writing is unchanged.",
            Self::Sso => "This organization requires GitHub SSO authorization. Complete that authorization on GitHub, then refresh the repository list. Local writing is unchanged.",
            Self::Network => "GitHub could not be reached. Local writing remains available; nothing is queued for automatic sharing.",
            Self::RateLimit => "GitHub has limited requests. Wait, then explicitly check again.",
            Self::InvalidUrl => "Use an existing github.com repository URL without credentials, extra paths or query parameters.",
            Self::InvalidRef => "This repository branch name is unsupported.",
            Self::UnsafeTree => "This repository contains unsafe paths, links, submodules or LFS content. Open a separate local folder instead.",
            Self::Limit => "This repository exceeds the managed-project size limit. Use a smaller writing repository or a local folder.",
            Self::Storage => "Managed project storage is unavailable. No new project or version was confirmed.",
            Self::Busy => "Another Heinlein instance is using this project. Close it there before trying again.",
            Self::Missing => "The managed copy is missing. Heinlein will not clone over local drafts; preserve recovery files and locate the copy.",
            Self::Changed => "The project, account, branch or files changed. Review a fresh preview before continuing.",
            Self::Recovery => "An interrupted operation or recovery draft needs review before this project can change.",
            Self::Conflict => "Choose a result for every conflicting passage or manuscript change before applying.",
            Self::Unsupported => "This change needs a separate Git workflow. Heinlein will preserve your writing and will not guess.",
            Self::Uncertain => "GitHub may have received this operation. Check its result before sending again; no automatic retry will occur.",
            Self::Canceled => "Canceled. No sharing was requested.",
        };
        f.write_str(message)
    }
}
impl std::error::Error for Error {}
impl From<git2::Error> for Error {
    fn from(_: git2::Error) -> Self {
        Self::Storage
    }
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::Storage
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::Storage
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoInfo {
    pub id: u64,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub default_branch: String,
    pub installation_id: u64,
}
impl RepoInfo {
    pub fn url(&self) -> String {
        format!("https://github.com/{}/{}", self.owner, self.name)
    }
    pub fn clone_url(&self) -> String {
        format!("{}.git", self.url())
    }
    pub fn validate(&self) -> Result<()> {
        let pair = locator(&self.url())?;
        if self.id == 0
            || self.installation_id == 0
            || pair != (self.owner.clone(), self.name.clone())
        {
            return Err(Error::InvalidUrl);
        }
        transport::valid_ref(&self.default_branch)
    }
}
pub fn locator(input: &str) -> Result<(String, String)> {
    let url = url::Url::parse(input).map_err(|_| Error::InvalidUrl)?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidUrl);
    }
    let parts = url
        .path()
        .trim_end_matches('/')
        .split('/')
        .filter(|x| !x.is_empty())
        .collect::<Vec<_>>();
    if parts.len() != 2 {
        return Err(Error::InvalidUrl);
    }
    let name = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
    if [parts[0], name].iter().any(|s| {
        s.is_empty()
            || s.starts_with('-')
            || *s == "."
            || *s == ".."
            || !s
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    }) {
        return Err(Error::InvalidUrl);
    }
    Ok((parts[0].into(), name.into()))
}
pub fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
pub fn uuid_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| Error::Changed)
}
