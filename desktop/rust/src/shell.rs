//! Release startup remains closed: installing denial handlers is not capture parity.
#[derive(Debug, PartialEq, Eq)]
pub enum StartupError {
    MissingNativeGuards,
    CaptureNotProven,
}
#[derive(Debug)]
pub struct Startup {
    permissions: bool,
    screen_capture: bool,
    navigation: bool,
}
impl Startup {
    pub fn new(permissions: bool, screen_capture: bool, navigation: bool) -> Self {
        Self {
            permissions,
            screen_capture,
            navigation,
        }
    }
    pub fn release_navigation(&self) -> Result<(), StartupError> {
        if !(self.permissions && self.screen_capture && self.navigation) {
            return Err(StartupError::MissingNativeGuards);
        }
        // Deliberately no public switch to turn unverified media into a production launch.
        Err(StartupError::CaptureNotProven)
    }
}

#[cfg(windows)]
pub mod windows;
