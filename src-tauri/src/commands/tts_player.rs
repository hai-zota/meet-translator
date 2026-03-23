/// Tauri commands for TTS audio playback via Rust background thread.

use crate::audio::tts_player::{TtsPlayer, TtsPlayerState};
use tauri::State;

#[tauri::command]
pub fn play_tts_audio(base64_audio: String, state: State<'_, TtsPlayerState>) -> Result<(), String> {
    let player = state
        .player
        .lock()
        .map_err(|_| "lock error".to_string())?;
    player.play_base64(&base64_audio)
}

#[tauri::command]
pub fn stop_tts_audio(state: State<'_, TtsPlayerState>) -> Result<(), String> {
    let player = state
        .player
        .lock()
        .map_err(|_| "lock error".to_string())?;
    // Drop old TtsPlayer (sends Shutdown to background thread → thread exits),
    // then spawn a fresh player with a new OutputStream. This is necessary on macOS
    // where switching audio input (system ↔ mic) can silently invalidate the CoreAudio
    // output session, causing playback to produce no sound without any error.
    drop(player);
    let mut guard = state
        .player
        .lock()
        .map_err(|_| "lock error".to_string())?;
    *guard = TtsPlayer::new();
    Ok(())
}
