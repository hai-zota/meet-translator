pub mod microphone;
pub mod mixer;

#[cfg(target_os = "macos")]
pub mod system_audio;

#[cfg(target_os = "windows")]
pub mod wasapi;

// Re-export SystemAudioCapture from the correct platform module
#[cfg(target_os = "macos")]
pub use system_audio::SystemAudioCapture;

#[cfg(target_os = "windows")]
pub use wasapi::SystemAudioCapture;

// Re-export mixer components (used in Phase 5 for IPC commands)
#[allow(unused_imports)]
pub use mixer::{DuckingEngine, LoufsAnalyzer, MixerStats, SmartMixer, VadProcessor};

/// Target audio format for Soniox: PCM s16le, 16kHz, mono
pub const TARGET_SAMPLE_RATE: u32 = 16000;
#[allow(dead_code)]
pub const TARGET_CHANNELS: u16 = 1;
