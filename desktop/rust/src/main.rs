fn main() -> std::process::ExitCode {
    #[cfg(windows)]
    if let Err(error) = nimbo_desktop::shell::windows::probe() {
        eprintln!("Nimbo native API probe failed: {error}");
        return std::process::ExitCode::FAILURE;
    }
    #[cfg(not(windows))]
    println!("Nimbo checkpoint-2 policy probe: native host requires Windows x64.");
    let config = nimbo_desktop::policy::Config::release();
    println!("Configured release site: {}", config.start_url());
    eprintln!(
        "RETURN: capture source -> real MediaStream is not implemented/proven; remote navigation disabled. Electron distribution is unchanged."
    );
    std::process::ExitCode::from(2)
}
