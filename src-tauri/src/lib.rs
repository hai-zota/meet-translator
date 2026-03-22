mod audio;
mod commands;
mod settings;

use audio::microphone::MicCapture;
use audio::mixer::SmartMixer;
use audio::{SystemAudioCapture, TARGET_SAMPLE_RATE};
use audio::tts_player::{TtsPlayer, TtsPlayerState};
use commands::audio::AudioState;
use commands::local_pipeline::LocalPipelineState;
use commands::mixer::MixerState;
use settings::{Settings, SettingsState};
use std::sync::Mutex;

#[tauri::command]
fn get_platform_info() -> String {
    format!(
        r#"{{"os":"{}","arch":"{}","version":"0.3.0"}}"#,
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load settings from disk (or defaults)
    let initial_settings = Settings::load();

    // Build SmartMixer from persisted settings
    let mixer = SmartMixer::new(
        TARGET_SAMPLE_RATE,
        initial_settings.mixer.ducking_level,
        &initial_settings.mixer.vad_sensitivity,
    )
    .unwrap_or_else(|_| SmartMixer::new(TARGET_SAMPLE_RATE, 0.2, "medium").expect("default mixer"));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .manage(SettingsState(Mutex::new(initial_settings)))
        .manage(MixerState::new(mixer))
        .manage(AudioState {
            system_audio: Mutex::new(SystemAudioCapture::new()),
            microphone: Mutex::new(MicCapture::new()),
            active_receiver: Mutex::new(None),
            active_dual_forwarder: Mutex::new(None),
        })
        .manage(LocalPipelineState {
            process: Mutex::new(None),
        })
        .manage(TtsPlayerState {
            player: Mutex::new(TtsPlayer::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::audio::start_capture,
            commands::audio::start_dual_capture,
            commands::audio::stop_capture,
            commands::audio::check_permissions,
            commands::audio::list_output_devices,
            commands::audio::inject_audio_to_device,
            commands::audio::inject_pcm_to_device,
            commands::transcript::save_transcript,
            commands::transcript::open_transcript_dir,
            commands::local_pipeline::start_local_pipeline,
            commands::local_pipeline::send_audio_to_pipeline,
            commands::local_pipeline::stop_local_pipeline,
            commands::local_pipeline::check_mlx_setup,
            commands::local_pipeline::run_mlx_setup,
            commands::edge_tts::edge_tts_speak,
            commands::mixer::mixer_process_chunk,
            commands::mixer::mixer_update_settings,
            commands::mixer::mixer_get_stats,
            commands::mixer::mixer_reset,
            commands::tts_player::play_tts_audio,
            commands::tts_player::stop_tts_audio,
            get_platform_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
