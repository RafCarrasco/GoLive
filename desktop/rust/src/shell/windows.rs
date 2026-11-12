//! Windows-only diagnostic host and deny-all WebView2 guard skeleton.
//! No remote document or IPC dispatcher is created by the diagnostic executable.
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_STATE_DENY, GetAvailableCoreWebView2BrowserVersionString,
    ICoreWebView2, ICoreWebView2_17, ICoreWebView2_27, ICoreWebView2Controller,
    ICoreWebView2Environment12,
};
use webview2_com::{
    NavigationStartingEventHandler, PermissionRequestedEventHandler,
    ScreenCaptureStartingEventHandler, take_pwstr,
};
use windows::Win32::Foundation::E_POINTER;
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows::core::{HSTRING, Interface, PCWSTR, PWSTR, Result};

pub fn probe() -> Result<()> {
    // SAFETY: valid UTF-16 identity; version API allocates a CoTaskMem string freed by take_pwstr.
    unsafe {
        SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(crate::policy::APP_ID))?;
        let mut version = PWSTR::null();
        GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version)?;
        println!(
            "WebView2 installed version: {} (not interface/media proof)",
            take_pwstr(version)
        );
    }
    Ok(())
}

fn close_on_error(controller: &ICoreWebView2Controller, outcome: Result<()>) -> Result<()> {
    if let Err(error) = outcome {
        // SAFETY: callback runs on the owning WebView UI thread. No page may proceed on a failed deny.
        if let Err(close_error) = unsafe { controller.Close() } {
            eprintln!("WebView2 deny and close both failed: {error}; {close_error}");
            // A broken security barrier cannot leave the browser process running.
            std::process::abort();
        }
        return Err(error);
    }
    Ok(())
}

/// Caller must hold this guard until the controller is closed; it is not capture authorization.
pub struct DenyGuards {
    core: ICoreWebView2,
    screen: ICoreWebView2_27,
    controller: ICoreWebView2Controller,
    navigation: Option<i64>,
    permission: Option<i64>,
    capture: Option<i64>,
}

impl DenyGuards {
    /// Install before any navigation. Nothing is granted, including same-origin/subframe requests.
    ///
    /// # Safety
    /// Call only on the live controller's owning UI thread, before loading untrusted content.
    /// Do not attach permissive handlers alongside this guard. Close the controller before drop.
    pub unsafe fn install(controller: &ICoreWebView2Controller) -> Result<Self> {
        // SAFETY: caller guarantees live controller and UI-thread ownership.
        unsafe {
            let core = controller.CoreWebView2()?;
            // Required interface failure is propagated, not silently skipped.
            let screen = core.cast::<ICoreWebView2_27>()?;
            let mut guards = Self {
                core,
                screen,
                controller: controller.clone(),
                navigation: None,
                permission: None,
                capture: None,
            };
            let c = controller.clone();
            let mut token = 0;
            guards.core.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    close_on_error(
                        &c,
                        args.ok_or_else(|| windows::core::Error::from_hresult(E_POINTER))
                            .and_then(|a| a.SetCancel(true)),
                    )
                })),
                &mut token,
            )?;
            guards.navigation = Some(token);
            let c = controller.clone();
            guards.core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    close_on_error(
                        &c,
                        args.ok_or_else(|| windows::core::Error::from_hresult(E_POINTER))
                            .and_then(|a| a.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)),
                    )
                })),
                &mut token,
            )?;
            guards.permission = Some(token);
            let c = controller.clone();
            guards.screen.add_ScreenCaptureStarting(
                &ScreenCaptureStartingEventHandler::create(Box::new(move |_, args| {
                    close_on_error(
                        &c,
                        args.ok_or_else(|| windows::core::Error::from_hresult(E_POINTER))
                            .and_then(|a| a.SetCancel(true)),
                    )
                })),
                &mut token,
            )?;
            guards.capture = Some(token);
            Ok(guards)
        }
    }
}

impl Drop for DenyGuards {
    fn drop(&mut self) {
        // SAFETY: !Send COM objects retain owning-thread affinity. Close BEFORE removing guards,
        // also on partial registration failure, so rollback cannot expose an unguarded page.
        unsafe {
            if let Err(error) = self.controller.Close() {
                eprintln!("Cannot close guarded WebView2: {error}");
                std::process::abort();
            }
            for outcome in [
                self.capture
                    .map(|t| self.screen.remove_ScreenCaptureStarting(t)),
                self.permission
                    .map(|t| self.core.remove_PermissionRequested(t)),
                self.navigation
                    .map(|t| self.core.remove_NavigationStarting(t)),
            ]
            .into_iter()
            .flatten()
            {
                if let Err(error) = outcome {
                    eprintln!("Closed WebView2 handler removal failed: {error}");
                }
            }
        }
    }
}

/// Compile-checked candidate transport prerequisites only. Does not capture or share pixels.
/// # Safety
/// `core` must be live on its owning UI thread.
pub unsafe fn candidate_interfaces(
    core: &ICoreWebView2,
) -> Result<(ICoreWebView2Environment12, ICoreWebView2_17)> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    // SAFETY: caller guarantees live UI-thread interface; every QueryInterface/HRESULT is checked.
    unsafe {
        let environment = core.cast::<ICoreWebView2_2>()?.Environment()?.cast()?;
        let shared_buffer_core = core.cast()?;
        Ok((environment, shared_buffer_core))
    }
}
