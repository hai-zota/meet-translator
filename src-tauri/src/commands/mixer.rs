//! Tauri IPC commands for the Smart Audio Mixer
//!
//! Exposes 4 commands to the frontend:
//! - mixer_process_chunk   — process two PCM streams, return ducked+mixed output
//! - mixer_update_settings — reconfigure ducking level / VAD sensitivity / enabled
//! - mixer_get_stats       — read last stats snapshot (LUFS, gain, speech flag)
//! - mixer_reset           — reset internal state machine / noise floor

use crate::audio::{mixer::{MixerStats, SmartMixer}, TARGET_SAMPLE_RATE};
use crate::settings::SettingsState;
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

/// Managed state — one SmartMixer instance per app session
pub struct MixerState {
    pub mixer: Mutex<SmartMixer>,
    pub last_stats: Mutex<Option<MixerStats>>,
}

impl MixerState {
    pub fn new(mixer: SmartMixer) -> Self {
        Self {
            mixer: Mutex::new(mixer),
            last_stats: Mutex::new(None),
        }
    }
}

/// Output returned by `mixer_process_chunk`
#[derive(Debug, Serialize)]
pub struct MixerOutput {
    /// Raw PCM bytes — s16le mixed output (attenuated original + translated)
    pub mixed_pcm: Vec<u8>,
    pub stats: MixerStats,
}

// ============================================================
//  IPC Commands
// ============================================================

/// Process two raw PCM streams (s16le bytes) through the SmartMixer.
///
/// - `original_pcm_bytes`  — bytes from system audio / microphone
/// - `translated_pcm_bytes` — bytes from TTS output
///
/// Returns attenuated-original + translated mixed PCM plus telemetry stats.
#[tauri::command]
pub fn mixer_process_chunk(
    original_pcm_bytes: Vec<u8>,
    translated_pcm_bytes: Vec<u8>,
    mixer_state: State<'_, MixerState>,
) -> Result<MixerOutput, String> {
    let original_pcm = bytes_to_i16(&original_pcm_bytes);
    let translated_pcm = bytes_to_i16(&translated_pcm_bytes);

    let mut mixer = mixer_state
        .mixer
        .lock()
        .map_err(|e| format!("Mixer lock error: {}", e))?;

    let (mixed_i16, stats) = mixer.process_chunk(&original_pcm, &translated_pcm)?;

    // Persist stats for `mixer_get_stats` polling
    if let Ok(mut last) = mixer_state.last_stats.lock() {
        *last = Some(stats.clone());
    }

    Ok(MixerOutput {
        mixed_pcm: i16_to_bytes(&mixed_i16),
        stats,
    })
}

/// Update mixer configuration at runtime.
///
/// Changes take effect immediately on the next `mixer_process_chunk` call.
#[tauri::command]
pub fn mixer_update_settings(
    enabled: bool,
    ducking_level: f32,
    vad_sensitivity: String,
    mixer_state: State<'_, MixerState>,
    settings_state: State<'_, SettingsState>,
) -> Result<(), String> {
    // Validate ducking_level range
    if !(0.0..=1.0).contains(&ducking_level) {
        return Err(format!(
            "ducking_level must be in [0.0, 1.0], got {}",
            ducking_level
        ));
    }

    // Validate vad_sensitivity
    if !["low", "medium", "high"].contains(&vad_sensitivity.as_str()) {
        return Err(format!(
            "vad_sensitivity must be 'low', 'medium', or 'high', got '{}'",
            vad_sensitivity
        ));
    }

    // Apply to live mixer
    let mut mixer = mixer_state
        .mixer
        .lock()
        .map_err(|e| format!("Mixer lock error: {}", e))?;

    mixer.set_enabled(enabled);
    mixer.update_settings(ducking_level, &vad_sensitivity)?;

    // Persist to settings on disk
    let mut settings = settings_state
        .0
        .lock()
        .map_err(|e| format!("Settings lock error: {}", e))?;

    settings.mixer.enabled = enabled;
    settings.mixer.ducking_level = ducking_level;
    settings.mixer.vad_sensitivity = vad_sensitivity;
    settings.save()?;

    Ok(())
}

/// Get the last stats snapshot produced by `mixer_process_chunk`.
///
/// Returns `null` if no chunk has been processed yet.
#[tauri::command]
pub fn mixer_get_stats(mixer_state: State<'_, MixerState>) -> Result<Option<MixerStats>, String> {
    let last = mixer_state
        .last_stats
        .lock()
        .map_err(|e| format!("Stats lock error: {}", e))?;
    Ok(last.clone())
}

/// Reset the mixer's internal state (VAD noise floor, ducking FSM).
///
/// Useful when switching audio sources or after a long pause.
#[tauri::command]
pub fn mixer_reset(
    mixer_state: State<'_, MixerState>,
    settings_state: State<'_, SettingsState>,
) -> Result<(), String> {
    let settings = settings_state
        .0
        .lock()
        .map_err(|e| format!("Settings lock error: {}", e))?;

    let new_mixer = SmartMixer::new(
        TARGET_SAMPLE_RATE,
        settings.mixer.ducking_level,
        &settings.mixer.vad_sensitivity,
    )?;

    let mut mixer = mixer_state
        .mixer
        .lock()
        .map_err(|e| format!("Mixer lock error: {}", e))?;

    *mixer = new_mixer;

    // Clear stale stats
    if let Ok(mut last) = mixer_state.last_stats.lock() {
        *last = None;
    }

    Ok(())
}

// ============================================================
//  Helpers
// ============================================================

/// Convert raw s16le bytes → Vec<i16> (little-endian)
fn bytes_to_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

/// Convert Vec<i16> → raw s16le bytes (little-endian)
fn i16_to_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|&s| s.to_le_bytes()).collect()
}

// ============================================================
//  Unit tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bytes_to_i16_roundtrip() {
        let original = vec![100i16, -200, 1000, -32768, 32767, 0];
        let bytes = i16_to_bytes(&original);
        let recovered = bytes_to_i16(&bytes);
        assert_eq!(original, recovered);
    }

    #[test]
    fn test_bytes_to_i16_empty() {
        let result = bytes_to_i16(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_bytes_to_i16_truncates_odd_byte() {
        // Odd number of bytes — last byte should be ignored
        let bytes = vec![0x01, 0x00, 0x99]; // only first 2 bytes used
        let result = bytes_to_i16(&bytes);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], 1);
    }

    #[test]
    fn test_i16_to_bytes_little_endian() {
        // 256 in s16le = [0x00, 0x01]
        let samples = vec![256i16];
        let bytes = i16_to_bytes(&samples);
        assert_eq!(bytes, vec![0x00, 0x01]);
    }

    #[test]
    fn test_i16_to_bytes_negative() {
        // -1 in s16le = [0xFF, 0xFF]
        let samples = vec![-1i16];
        let bytes = i16_to_bytes(&samples);
        assert_eq!(bytes, vec![0xFF, 0xFF]);
    }
}
