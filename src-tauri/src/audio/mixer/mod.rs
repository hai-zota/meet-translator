//! Smart Audio Mixer & Ducking Module
//!
//! Combines original audio (Mic/System) with translated audio (TTS)
//! using intelligent ducking to ensure clarity.
//!
//! Components:
//! - loudness_analyzer: LUFS measurement (EBU R128)
//! - vad_processor: Voice Activity Detection (Silero VAD via ONNX)
//! - ducking_engine: Dynamic ducking state machine (Attack/Hold/Release)
//! - smart_mixer: Main orchestrator combining all components

pub mod ducking_engine;
pub mod loudness_analyzer;
pub mod smart_mixer;
pub mod vad_processor;

pub use ducking_engine::DuckingEngine;
pub use loudness_analyzer::LoufsAnalyzer;
pub use smart_mixer::SmartMixer;
pub use vad_processor::VadProcessor;

/// Mixer statistics for frontend polling
#[derive(Debug, Clone, serde::Serialize)]
pub struct MixerStats {
    pub original_lufs: Option<f32>,
    pub translated_lufs: Option<f32>,
    pub ducking_gain: f32,
    pub is_speech: bool,
}
