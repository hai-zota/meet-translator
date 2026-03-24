use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

const BLACKHOLE_2CH_NAME: &str = "BlackHole 2ch";
#[cfg(target_os = "macos")]
const BLACKHOLE_DOWNLOAD_PAGE_URL: &str = "https://github.com/ExistentialAudio/BlackHole/releases/latest";
#[cfg(target_os = "macos")]
const BLACKHOLE_BREW_CASK: &str = "blackhole-2ch";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlackHoleSetupStatus {
    pub supported: bool,
    pub installed: bool,
    pub device_name: String,
    pub message: String,
    pub install_url: Option<String>,
}

#[tauri::command]
pub fn get_blackhole_setup_status() -> Result<BlackHoleSetupStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let installed = has_output_device_named(BLACKHOLE_2CH_NAME)?;
        let cask_installed = is_blackhole_cask_installed();
        let message = if installed {
            "BlackHole 2ch is installed and ready for Stream B inject.".to_string()
        } else if cask_installed {
            "BlackHole is installed via Homebrew, but the audio device is not visible yet. Restart audio apps (or reboot), then click Recheck BlackHole."
                .to_string()
        } else {
            "BlackHole 2ch is not installed yet. Run one-click setup to download and install it.".to_string()
        };

        return Ok(BlackHoleSetupStatus {
            supported: true,
            installed,
            device_name: BLACKHOLE_2CH_NAME.to_string(),
            message,
            install_url: Some(BLACKHOLE_DOWNLOAD_PAGE_URL.to_string()),
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(BlackHoleSetupStatus {
            supported: false,
            installed: false,
            device_name: BLACKHOLE_2CH_NAME.to_string(),
            message: "BlackHole one-click setup is currently available only on macOS.".to_string(),
            install_url: None,
        })
    }
}

#[tauri::command]
pub async fn install_blackhole() -> Result<BlackHoleSetupStatus, String> {
    #[cfg(target_os = "macos")]
    {
        if has_output_device_named(BLACKHOLE_2CH_NAME)? {
            return get_blackhole_setup_status();
        }

        install_blackhole_with_brew()?;

        // Install runs in Terminal.app — return info state so JS shows guidance.
        return Ok(BlackHoleSetupStatus {
            supported: true,
            installed: false,
            device_name: BLACKHOLE_2CH_NAME.to_string(),
            message: "A Terminal window has opened. Enter your password when prompted. After it shows ✅, click Recheck BlackHole here.".to_string(),
            install_url: Some(BLACKHOLE_DOWNLOAD_PAGE_URL.to_string()),
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("BlackHole one-click setup is only supported on macOS.".to_string())
    }
}

fn has_output_device_named(device_name: &str) -> Result<bool, String> {
    let host = cpal::default_host();
    let devices = host
        .output_devices()
        .map_err(|e| format!("Failed to enumerate output devices: {}", e))?;

    for device in devices {
        if device
            .name()
            .map(|name| name == device_name)
            .unwrap_or(false)
        {
            return Ok(true);
        }
    }

    Ok(false)
}

#[cfg(target_os = "macos")]
fn find_brew_path() -> Result<String, String> {
    for path in &["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        if std::path::Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }
    Err(format!(
        "Homebrew is not installed. Install Homebrew from https://brew.sh, then retry, or install BlackHole manually from {}",
        BLACKHOLE_DOWNLOAD_PAGE_URL
    ))
}

#[cfg(target_os = "macos")]
fn blackhole_driver_path_exists() -> bool {
    std::path::Path::new("/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver").exists()
}

#[cfg(target_os = "macos")]
fn install_blackhole_with_brew() -> Result<(), String> {
    let brew_path = find_brew_path()?;

    // If brew cask is receipted but the actual HAL driver is missing, the previous
    // install ran without admin privileges. Remove the stale receipt so brew can
    // run a clean install this time.
    let cask_receipted = std::process::Command::new(&brew_path)
        .args(["list", "--cask", BLACKHOLE_BREW_CASK])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if cask_receipted && !blackhole_driver_path_exists() {
        let _ = std::process::Command::new(&brew_path)
            .args(["uninstall", "--cask", "--force", BLACKHOLE_BREW_CASK])
            .output();
    }

    // brew install --cask runs `sudo installer` internally, which needs a TTY
    // for password input. Open Terminal.app so the user can authenticate there.
    // After a successful install, automatically restart coreaudiod so the new
    // HAL driver is loaded without requiring a reboot.
    let done_msg = "\\u2705 BlackHole installed and audio restarted! Close this window and click Recheck BlackHole in the app.";
    let fail_msg = format!("\\u274C Install failed. Try again or visit {}", BLACKHOLE_DOWNLOAD_PAGE_URL);
    let cmd = format!(
        "{} install --cask {} && sudo killall coreaudiod && echo '{}' || echo '{}'",
        brew_path, BLACKHOLE_BREW_CASK, done_msg, fail_msg
    );
    // Escape double-quotes for AppleScript string literal
    let cmd_escaped = cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let applescript = format!(
        "tell application \"Terminal\"\n    activate\n    do script \"{}\"\nend tell",
        cmd_escaped
    );

    let result = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&applescript)
        .output()
        .map_err(|e| format!("Failed to open Terminal: {}", e))?;

    if result.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&result.stderr).trim().to_string();
        Err(format!("Failed to open Terminal for install: {}", err))
    }
}

#[cfg(target_os = "macos")]
fn is_blackhole_cask_installed() -> bool {
    blackhole_driver_path_exists()
}