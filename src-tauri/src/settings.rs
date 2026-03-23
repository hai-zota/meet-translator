use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Translation term: source → target mapping for Soniox
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

/// Custom context for Soniox — provides domain-specific hints
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    pub domain: Option<String>,
    pub translation_terms: Vec<TranslationTerm>,
}

/// Smart Audio Mixer & Ducking configuration
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct MixerSettings {
    /// Enable smart ducking
    pub enabled: bool,
    /// Ducking level: 0.0 - 0.5 (how much to reduce original volume)
    /// 0.2 = 20% (original becomes 20% volume when translated is playing)
    pub ducking_level: f32,
    /// VAD sensitivity: "low" | "medium" | "high"
    pub vad_sensitivity: String,
    /// Detection threshold in LUFS (-40.0 typical)
    pub detection_threshold: f32,
}

impl Default for MixerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ducking_level: 0.2,
            vad_sensitivity: "medium".to_string(),
            detection_threshold: -40.0,
        }
    }
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Soniox API key
    pub soniox_api_key: String,
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Overlay opacity: 0.0 - 1.0
    pub overlay_opacity: f64,
    /// Font size in px
    pub font_size: u32,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Whether to show original text alongside translation
    pub show_original: bool,
    /// Transcript color for Stream A in dual mode (hex)
    pub stream_a_color: String,
    /// Transcript color for Stream B in dual mode (hex)
    pub stream_b_color: String,
    /// Translation mode: "soniox" (cloud API) or "local" (MLX models)
    pub translation_mode: String,
    /// Optional custom context for better transcription
    pub custom_context: Option<CustomContext>,
    /// ElevenLabs API key for TTS narration
    pub elevenlabs_api_key: String,
    /// Whether TTS narration is enabled
    pub tts_enabled: bool,
    /// TTS provider: "edge" | "elevenlabs" | "google"
    pub tts_provider: String,
    /// ElevenLabs voice ID
    pub tts_voice_id: String,
    /// TTS speed multiplier (Web Speech)
    pub tts_speed: f64,
    /// Edge TTS voice name
    pub edge_tts_voice: String,
    /// Edge TTS speed percentage
    pub edge_tts_speed: i32,
    /// Auto-read new translations aloud
    pub tts_auto_read: bool,
    /// Google Cloud TTS API key
    pub google_tts_api_key: String,
    /// Google TTS voice name
    pub google_tts_voice: String,
    /// Google TTS speaking rate
    pub google_tts_speed: f64,
    /// Whether dual mode (two streams) is enabled
    pub dual_mode_enabled: bool,
    /// Stream A (system audio) source language
    pub stream_a_language_source: String,
    /// Stream A target language
    pub stream_a_language_target: String,
    /// Stream A TTS enabled (plays to local speaker, default OFF)
    pub stream_a_tts_enabled: bool,
    /// Stream A translated-audio local playback volume (0.0 - 2.0)
    pub stream_a_translated_volume: f64,
    /// Stream B (microphone) source language
    pub stream_b_language_source: String,
    /// Stream B target language
    pub stream_b_language_target: String,
    /// Stream B TTS enabled
    pub stream_b_tts_enabled: bool,
    /// Stream B inject translation into virtual audio device (e.g. BlackHole)
    pub stream_b_inject_enabled: bool,
    /// Stream B mix original mic into injected output
    pub stream_b_mix_original_enabled: bool,
    /// Stream B original mic volume in injected mix (0.0 - 2.0)
    pub stream_b_original_volume: f64,
    /// Stream B translated audio volume in injected mix (0.0 - 2.0)
    pub stream_b_translated_volume: f64,
    /// Stream B Edge TTS voice (used for direct inject path)
    pub stream_b_edge_tts_voice: String,
    /// Stream B Edge TTS speed percentage (used for direct inject path)
    pub stream_b_edge_tts_speed: i32,
    /// Smart Audio Mixer & Ducking settings
    pub mixer: MixerSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            soniox_api_key: String::new(),
            source_language: "auto".to_string(),
            target_language: "vi".to_string(),
            audio_source: "system".to_string(),
            overlay_opacity: 0.85,
            font_size: 16,
            max_lines: 5,
            show_original: true,
            stream_a_color: "#00a2ff".to_string(),
            stream_b_color: "#4ce87d".to_string(),
            translation_mode: "soniox".to_string(),
            custom_context: None,
            elevenlabs_api_key: String::new(),
            tts_enabled: false,
            tts_provider: "edge".to_string(),
            tts_voice_id: "21m00Tcm4TlvDq8ikWAM".to_string(),
            tts_speed: 1.2,
            edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            edge_tts_speed: 50,
            tts_auto_read: true,
            google_tts_api_key: String::new(),
            google_tts_voice: "vi-VN-Chirp3-HD-Aoede".to_string(),
            google_tts_speed: 1.0,
            dual_mode_enabled: false,
            stream_a_language_source: "auto".to_string(),
            stream_a_language_target: "vi".to_string(),
            stream_a_tts_enabled: false,
            stream_a_translated_volume: 1.0,
            stream_b_language_source: "auto".to_string(),
            stream_b_language_target: "en".to_string(),
            stream_b_tts_enabled: true,
            stream_b_inject_enabled: false,
            stream_b_mix_original_enabled: false,
            stream_b_original_volume: 1.0,
            stream_b_translated_volume: 1.0,
            stream_b_edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            stream_b_edge_tts_speed: 50,
            mixer: MixerSettings::default(),
        }
    }
}

/// Get the settings file path
/// ~/Library/Application Support/com.personal.translator/settings.json
fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.translator");
    path.push("settings.json");
    path
}

impl Settings {
    /// Load settings from disk, or return defaults
    pub fn load() -> Self {
        let path = settings_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    /// Save settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

        Ok(())
    }
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);
