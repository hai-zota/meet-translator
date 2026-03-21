/**
 * Settings Manager — handles loading/saving settings via Tauri IPC
 */

const { invoke } = window.__TAURI__.core;

// Default settings shape
const DEFAULT_SETTINGS = {
  soniox_api_key: '',
  source_language: 'auto',
  target_language: 'vi',
  audio_source: 'system',
  overlay_opacity: 0.85,
  font_size: 16,
  max_lines: 5,
  show_original: true,
  translation_mode: 'soniox',
  soniox_max_endpoint_delay_ms: 1200,
  custom_context: null,
  elevenlabs_api_key: '',
  tts_enabled: false,
  tts_provider: 'edge',
  tts_voice_id: '21m00Tcm4TlvDq8ikWAM',
  tts_speed: 1.2,
  edge_tts_voice: 'vi-VN-HoaiMyNeural',
  edge_tts_speed: 50,
  tts_auto_read: true,
  // Dual mode
  dual_mode_enabled: false,
  stream_a_language_source: 'auto',
  stream_a_language_target: 'vi',
  stream_a_tts_enabled: false,
  stream_a_translated_volume: 1.0,
  stream_b_language_source: 'auto',
  stream_b_language_target: 'en',
  stream_b_tts_enabled: true,
  stream_b_inject_enabled: false,
  stream_b_mix_original_enabled: false,
  stream_b_original_volume: 1.0,
  stream_b_translated_volume: 1.0,
  stream_b_edge_tts_voice: 'vi-VN-HoaiMyNeural',
  stream_b_edge_tts_speed: 50,
  // Smart Audio Mixer & Ducking
  mixer: {
    enabled: true,
    ducking_level: 0.2,
    vad_sensitivity: 'medium',
    detection_threshold: -40.0,
  },
};

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._listeners = [];
  }

  /**
   * Load settings from Rust backend
   */
  async load() {
    try {
      const settings = await invoke('get_settings');
      this.settings = { ...DEFAULT_SETTINGS, ...settings };
    } catch (err) {
      console.error('Failed to load settings:', err);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this._notify();
    return this.settings;
  }

  /**
   * Save settings to Rust backend
   */
  async save(newSettings) {
    try {
      const merged = { ...this.settings, ...newSettings };
      await invoke('save_settings', { newSettings: merged });
      this.settings = merged;
      this._notify();
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      throw err;
    }
  }

  /**
   * Get current settings (cached)
   */
  get() {
    return { ...this.settings };
  }

  /**
   * Subscribe to settings changes
   */
  onChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notify() {
    const settings = this.get();
    this._listeners.forEach(cb => cb(settings));
  }
}

// Singleton
export const settingsManager = new SettingsManager();
