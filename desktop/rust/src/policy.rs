//! Portable decisions, not claims of installed native hooks or media parity.
use url::Url;

pub const APP_ID: &str = "app.nimbo.desktop";
pub const HOSTED_URL: &str = "https://golive-ad118.web.app/";

#[derive(Debug, PartialEq, Eq)]
pub struct WindowConfig {
    pub title: &'static str,
    pub width: u32,
    pub height: u32,
    pub min_width: u32,
    pub min_height: u32,
    pub background: [u8; 3],
    pub menu: bool,
}
pub const MAIN_WINDOW: WindowConfig = WindowConfig {
    title: "Nimbo",
    width: 1280,
    height: 800,
    min_width: 850,
    min_height: 590,
    background: [0x0b, 0x10, 0x20],
    menu: false,
};

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    External,
    Deny,
}

#[derive(Debug)]
pub struct Config {
    start: Url,
}

// Reject ambiguous inputs before the WHATWG parser normalizes whitespace/credentials.
fn clean_url(raw: &str) -> Option<Url> {
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) || raw.contains('\\') {
        return None;
    }
    Url::parse(raw)
        .ok()
        .filter(|u| u.has_host() && u.username().is_empty() && u.password().is_none())
}

impl Config {
    pub fn release() -> Self {
        Self {
            start: Url::parse(HOSTED_URL).expect("constant URL"),
        }
    }
    /// Explicit isolated test configuration; the release executable never reads NIMBO_URL.
    pub fn for_test(raw: &str) -> Result<Self, &'static str> {
        let u = clean_url(raw).ok_or("invalid test URL")?;
        if u.scheme() != "http"
            || !matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            || u.port().is_none()
            || u.path() != "/"
            || u.query().is_some()
            || u.fragment().is_some()
        {
            return Err("test URL requires explicit loopback HTTP port and root path");
        }
        Ok(Self { start: u })
    }
    pub fn start_url(&self) -> &str {
        self.start.as_str()
    }
    pub fn navigation(&self, raw: &str) -> Navigation {
        let Some(u) = clean_url(raw) else {
            return Navigation::Deny;
        };
        if u.origin() == self.start.origin() {
            return Navigation::Allow;
        }
        // A different port/scheme on the app host is not an external-link escape hatch.
        if u.scheme() == "https" && u.host_str() != self.start.host_str() {
            Navigation::External
        } else {
            Navigation::Deny
        }
    }
    pub fn popup(&self, raw: &str) -> Navigation {
        if clean_url(raw).is_some_and(|u| u.scheme() == "https") {
            Navigation::External
        } else {
            Navigation::Deny
        }
    }
    pub fn authorize(&self, r: &NativeRequest<'_>, current_generation: u64) -> bool {
        r.window == "main"
            && self.navigation(r.source) == Navigation::Allow
            && r.frame_id.is_some_and(|id| id != 0)
            && r.frame_id == r.main_frame_id
            && r.parent_frame_id.is_none()
            && current_generation != 0
            && r.document_generation == current_generation
    }
    pub fn permission(&self, r: &NativeRequest<'_>, generation: u64, p: Permission) -> bool {
        self.authorize(r, generation)
            && matches!(
                p,
                Permission::Camera
                    | Permission::Microphone
                    | Permission::Fullscreen
                    | Permission::SanitizedClipboardWrite
            )
    }
    pub fn command(&self, r: &NativeRequest<'_>, generation: u64, command: &str) -> bool {
        self.authorize(r, generation) && command == "nimbo:capture:stop"
    }
}

/// Must be populated by native event/frame ownership, NEVER deserialized from a web message.
/// A source URI alone cannot prove that a request is from the main frame.
#[derive(Debug, Clone)]
pub struct NativeRequest<'a> {
    pub window: &'a str,
    pub source: &'a str,
    pub frame_id: Option<u32>,
    pub main_frame_id: Option<u32>,
    pub parent_frame_id: Option<u32>,
    pub document_generation: u64,
}
#[derive(Debug, Clone, Copy)]
pub enum Permission {
    Camera,
    Microphone,
    Fullscreen,
    SanitizedClipboardWrite,
    DisplayCapture,
    ClipboardRead,
    Other,
}
