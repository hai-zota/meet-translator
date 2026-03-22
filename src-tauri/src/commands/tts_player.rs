/// Tauri commands for TTS audio playback via Rust background thread.

use crate::audio::tts_player::TtsPlayerState;
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
    player.stop();
    Ok(())
}
