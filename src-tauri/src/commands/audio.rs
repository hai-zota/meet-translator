use crate::audio::inject_player::{InjectPlayer, InjectPlayerState};
use crate::audio::microphone::MicCapture;
use crate::audio::SystemAudioCapture;
use base64::Engine as _;
use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{ipc::Channel, State};

/// State for tracking active audio captures
pub struct AudioState {
    pub system_audio: Mutex<SystemAudioCapture>,
    pub microphone: Mutex<MicCapture>,
    /// Active forwarder for single-stream mode
    pub active_receiver: Mutex<Option<AudioForwarder>>,
    /// Active forwarder for dual-stream mode
    pub active_dual_forwarder: Mutex<Option<DualForwarder>>,
}

/// Forwards audio from a receiver to a Tauri IPC channel (single-stream)
pub struct AudioForwarder {
    stop_flag: Arc<AtomicBool>,
}

impl AudioForwarder {
    fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }
}

/// Forwards audio from two receivers to two Tauri IPC channels (dual-stream)
pub struct DualForwarder {
    stop_flag_a: Arc<AtomicBool>,
    stop_flag_b: Arc<AtomicBool>,
}

impl DualForwarder {
    fn stop(&self) {
        self.stop_flag_a.store(true, Ordering::SeqCst);
        self.stop_flag_b.store(true, Ordering::SeqCst);
    }
}

/// Shared helper: batch-forward audio from an mpsc receiver to a Tauri channel.
/// Flushes buffered PCM every 200 ms. Exits when stop_flag is set or receiver
/// disconnects.
fn forward_audio_to_channel(
    receiver: mpsc::Receiver<Vec<u8>>,
    channel: Channel<Vec<u8>>,
    stop_flag: Arc<AtomicBool>,
) {
    let mut buffer: Vec<u8> = Vec::with_capacity(32000); // ~1 s at 16 kHz s16le
    let batch_interval = std::time::Duration::from_millis(200);
    let mut last_flush = std::time::Instant::now();

    loop {
        if stop_flag.load(Ordering::SeqCst) {
            if !buffer.is_empty() {
                let _ = channel.send(buffer);
            }
            break;
        }

        match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
            Ok(data) => buffer.extend_from_slice(&data),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if !buffer.is_empty() {
                    let _ = channel.send(buffer);
                }
                break;
            }
        }

        if last_flush.elapsed() >= batch_interval && !buffer.is_empty() {
            if channel.send(buffer.clone()).is_err() {
                break; // frontend closed the channel
            }
            buffer.clear();
            last_flush = std::time::Instant::now();
        }
    }
}

#[derive(Serialize, Clone)]
pub struct PermissionStatus {
    pub screen_recording: String,
    pub microphone: String,
}

/// Start single-stream audio capture and forward data to the frontend via IPC channel.
#[tauri::command]
pub fn start_capture(
    source: String,
    channel: Channel<Vec<u8>>,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    // Stop any existing capture first
    stop_capture_inner(&state);

    let receiver: mpsc::Receiver<Vec<u8>> = match source.as_str() {
        "system" => {
            let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
            sys.start()?
        }
        "microphone" => {
            let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
            mic.start()?
        }
        _ => return Err(format!("Unknown source: {}", source)),
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_clone = stop_flag.clone();
    std::thread::spawn(move || forward_audio_to_channel(receiver, channel, stop_clone));

    *state.active_receiver.lock().map_err(|e| e.to_string())? = Some(AudioForwarder { stop_flag });
    Ok(())
}

/// Start dual-stream capture: Stream A = system audio, Stream B = microphone.
/// Two independent channels are forwarded to the frontend simultaneously.
#[tauri::command]
pub fn start_dual_capture(
    channel_a: Channel<Vec<u8>>,
    channel_b: Channel<Vec<u8>>,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    // Stop any existing single or dual capture first
    stop_capture_inner(&state);

    // Start system audio → channel A
    let receiver_a = {
        let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
        sys.start()
            .map_err(|e| format!("Stream A (system audio): {}", e))?
    };

    // Start microphone → channel B
    let receiver_b = {
        let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
        mic.start()
            .map_err(|e| format!("Stream B (microphone): {}", e))?
    };

    let stop_flag_a = Arc::new(AtomicBool::new(false));
    let stop_flag_b = Arc::new(AtomicBool::new(false));

    let stop_a = stop_flag_a.clone();
    std::thread::spawn(move || forward_audio_to_channel(receiver_a, channel_a, stop_a));

    let stop_b = stop_flag_b.clone();
    std::thread::spawn(move || forward_audio_to_channel(receiver_b, channel_b, stop_b));

    *state
        .active_dual_forwarder
        .lock()
        .map_err(|e| e.to_string())? = Some(DualForwarder {
        stop_flag_a,
        stop_flag_b,
    });
    Ok(())
}

/// Stop audio capture
#[tauri::command]
pub fn stop_capture(state: State<'_, AudioState>) -> Result<(), String> {
    stop_capture_inner(&state);
    Ok(())
}

fn stop_capture_inner(state: &AudioState) {
    // Stop single-stream forwarder
    if let Ok(mut active) = state.active_receiver.lock() {
        if let Some(forwarder) = active.take() {
            forwarder.stop();
        }
    }

    // Stop dual-stream forwarder
    if let Ok(mut active) = state.active_dual_forwarder.lock() {
        if let Some(forwarder) = active.take() {
            forwarder.stop();
        }
    }

    // Stop audio captures
    if let Ok(sys) = state.system_audio.lock() {
        sys.stop();
    }
    if let Ok(mut mic) = state.microphone.lock() {
        mic.stop();
    }
}

/// Check audio capture permissions
#[tauri::command]
pub fn check_permissions() -> PermissionStatus {
    // Note: Actual permission checking on macOS requires Objective-C interop
    // For now, we return "unknown" and permissions will be prompted on first use
    PermissionStatus {
        screen_recording: "unknown".to_string(),
        microphone: "unknown".to_string(),
    }
}

#[tauri::command]
pub fn list_output_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let mut names: Vec<String> = Vec::new();
    let devices = host
        .output_devices()
        .map_err(|e| format!("Failed to enumerate output devices: {}", e))?;

    for d in devices {
        names.push(d.name().unwrap_or_else(|_| "<unknown>".to_string()));
    }
    Ok(names)
}

/// Inject synthesized audio into a virtual output path.
/// Current macOS implementation plays the chunk through `afplay`; if the user
/// routes system output to BlackHole, this reaches meeting apps that listen on
/// that virtual device.
#[tauri::command]
pub async fn inject_audio_to_device(
    device_name: String,
    base64_audio: String,
) -> Result<(), String> {
    const MAX_AUDIO_BYTES: usize = 2 * 1024 * 1024; // 2 MB

    if base64_audio.trim().is_empty() {
        return Err("Empty audio payload".to_string());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_audio)
        .map_err(|e| format!("Invalid base64 audio payload: {}", e))?;

    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "Audio payload too large: {} bytes (max {})",
            bytes.len(),
            MAX_AUDIO_BYTES
        ));
    }

    #[cfg(target_os = "macos")]
    {
        use std::fs;
        use std::process::Command;

        // NOTE: afplay does not let us choose a specific device directly.
        // device_name is kept for forward compatibility and diagnostics.
        println!(
            "[inject_audio_to_device] macOS playback via afplay, target device hint: {}",
            device_name
        );

        let file_name = format!("tts_inject_{}.mp3", uuid::Uuid::new_v4());
        let file_path = std::env::temp_dir().join(file_name);

        fs::write(&file_path, bytes).map_err(|e| format!("Failed to write temp audio: {}", e))?;

        let mut child = Command::new("afplay")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to launch afplay: {}", e))?;

        std::thread::spawn(move || {
            let _ = child.wait();
            let _ = fs::remove_file(&file_path);
        });

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (device_name, bytes);
        Err("Audio injection is currently supported on macOS only".to_string())
    }
}

#[tauri::command]
pub async fn inject_pcm_to_device(
    device_name: String,
    pcm_data: Vec<u8>,
    sample_rate: u32,
    state: State<'_, InjectPlayerState>,
) -> Result<(), String> {
    // Backward-compatible path: treat generic inject as translated channel.
    let mut guard = state.player.lock().map_err(|_| "lock error".to_string())?;
    match guard.play_translated_pcm(device_name.clone(), pcm_data.clone(), sample_rate) {
        Ok(()) => Ok(()),
        Err(err) if err.contains("thread stopped") => {
            *guard = InjectPlayer::new();
            guard.play_translated_pcm(device_name, pcm_data, sample_rate)
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn inject_original_pcm_to_device(
    device_name: String,
    pcm_data: Vec<u8>,
    sample_rate: u32,
    state: State<'_, InjectPlayerState>,
) -> Result<(), String> {
    let mut guard = state.player.lock().map_err(|_| "lock error".to_string())?;
    match guard.play_original_pcm(device_name.clone(), pcm_data.clone(), sample_rate) {
        Ok(()) => Ok(()),
        Err(err) if err.contains("thread stopped") => {
            *guard = InjectPlayer::new();
            guard.play_original_pcm(device_name, pcm_data, sample_rate)
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn inject_translated_pcm_to_device(
    device_name: String,
    pcm_data: Vec<u8>,
    sample_rate: u32,
    state: State<'_, InjectPlayerState>,
) -> Result<(), String> {
    let mut guard = state.player.lock().map_err(|_| "lock error".to_string())?;
    match guard.play_translated_pcm(device_name.clone(), pcm_data.clone(), sample_rate) {
        Ok(()) => Ok(()),
        Err(err) if err.contains("thread stopped") => {
            *guard = InjectPlayer::new();
            guard.play_translated_pcm(device_name, pcm_data, sample_rate)
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub fn stop_inject_audio(state: State<'_, InjectPlayerState>) -> Result<(), String> {
    let player = state.player.lock().map_err(|_| "lock error".to_string())?;
    drop(player);
    let mut guard = state.player.lock().map_err(|_| "lock error".to_string())?;
    *guard = InjectPlayer::new();
    Ok(())
}
