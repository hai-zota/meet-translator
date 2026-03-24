use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn sanitize_api_key(raw: &str) -> String {
    let mut value = raw.trim().trim_matches('"').trim_matches('\'').to_string();
    if let Some(stripped) = value.strip_prefix("xi-api-key:") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("Xi-Api-Key:") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("authorization:") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("Authorization:") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("Bearer ") {
        value = stripped.trim().to_string();
    }
    if let Some(stripped) = value.strip_prefix("bearer ") {
        value = stripped.trim().to_string();
    }
    value
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct LastVoiceRecording {
    pub audio_base64: String,
    pub mime_type: String,
    pub filename: String,
}

impl Default for LastVoiceRecording {
    fn default() -> Self {
        Self {
            audio_base64: String::new(),
            mime_type: "audio/webm".to_string(),
            filename: "voice-sample.webm".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
struct LastVoiceRecordingMeta {
    mime_type: String,
    filename: String,
}

impl Default for LastVoiceRecordingMeta {
    fn default() -> Self {
        Self {
            mime_type: "audio/webm".to_string(),
            filename: "voice-sample.webm".to_string(),
        }
    }
}

fn app_data_dir() -> Result<PathBuf, String> {
    let mut path = dirs::config_dir().ok_or_else(|| "Cannot resolve config dir".to_string())?;
    path.push("com.personal.translator");
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    Ok(path)
}

fn last_recording_audio_path() -> Result<PathBuf, String> {
    let mut path = app_data_dir()?;
    path.push("last_voice_clone_audio.bin");
    Ok(path)
}

fn last_recording_meta_path() -> Result<PathBuf, String> {
    let mut path = app_data_dir()?;
    path.push("last_voice_clone_meta.json");
    Ok(path)
}

fn extract_error_message(status: reqwest::StatusCode, body: &str) -> String {
    if body.trim().is_empty() {
        return format!("HTTP {} {}", status.as_u16(), status.canonical_reason().unwrap_or(""));
    }

    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if let Some(detail) = json.get("detail") {
            if let Some(s) = detail.as_str() {
                return s.to_string();
            }
            if let Some(arr) = detail.as_array() {
                if let Some(first) = arr.first() {
                    if let Some(s) = first.as_str() {
                        return s.to_string();
                    }
                    if let Some(msg) = first.get("message").and_then(|v| v.as_str()) {
                        return msg.to_string();
                    }
                    if let Some(msg) = first.get("msg").and_then(|v| v.as_str()) {
                        return msg.to_string();
                    }
                }
            }
            if let Some(msg) = detail.get("message").and_then(|v| v.as_str()) {
                return msg.to_string();
            }
            if let Some(msg) = detail.get("msg").and_then(|v| v.as_str()) {
                return msg.to_string();
            }
        }

        if let Some(msg) = json.get("message").and_then(|v| v.as_str()) {
            return msg.to_string();
        }
        if let Some(msg) = json.get("error").and_then(|v| v.as_str()) {
            return msg.to_string();
        }

        return json.to_string();
    }

    body.to_string()
}

fn build_voice_form(
    voice_name: &str,
    audio_bytes: &[u8],
    mime_type: &str,
    filename: &str,
) -> Result<reqwest::multipart::Form, String> {
    let part = reqwest::multipart::Part::bytes(audio_bytes.to_vec())
        .file_name(filename.to_string())
        .mime_str(mime_type)
        .map_err(|e| format!("Invalid mime type: {}", e))?;

    Ok(reqwest::multipart::Form::new()
        .text("name", voice_name.to_string())
        .text(
            "description",
            "Created from Meet Translator voice clone tab".to_string(),
        )
        .part("files", part))
}

#[tauri::command]
pub async fn elevenlabs_create_voice(
    api_key: String,
    voice_name: String,
    audio_base64: String,
    mime_type: Option<String>,
    filename: Option<String>,
) -> Result<Value, String> {
    let api_key = sanitize_api_key(&api_key);
    if api_key.is_empty() {
        return Err("Missing ElevenLabs API key".to_string());
    }
    if voice_name.trim().is_empty() {
        return Err("Missing voice name".to_string());
    }

    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64)
        .map_err(|e| format!("Invalid audio base64: {}", e))?;

    let mime_type = mime_type
        .unwrap_or_else(|| "audio/webm".to_string())
        .trim()
        .to_string();
    let filename = filename
        .unwrap_or_else(|| "voice-sample.webm".to_string())
        .trim()
        .to_string();

    let client = reqwest::Client::new();
    let url = "https://api.elevenlabs.io/v1/voices/add";

    let form_xi = build_voice_form(&voice_name, &audio_bytes, &mime_type, &filename)?;
    let mut response = client
        .post(url)
        .header("xi-api-key", &api_key)
        .multipart(form_xi)
        .send()
        .await
        .map_err(|e| format!("Network error (xi-api-key): {}", e))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let form_bearer = build_voice_form(&voice_name, &audio_bytes, &mime_type, &filename)?;
        response = client
            .post(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .multipart(form_bearer)
            .send()
            .await
            .map_err(|e| format!("Network error (bearer): {}", e))?;
    }

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read ElevenLabs response: {}", e))?;

    if !status.is_success() {
        let message = extract_error_message(status, &body);
        return Err(format!("HTTP {}: {}", status.as_u16(), message));
    }

    serde_json::from_str::<Value>(&body)
        .map_err(|e| format!("Invalid ElevenLabs JSON response: {}", e))
}

#[tauri::command]
pub fn elevenlabs_save_last_recording(
    audio_base64: String,
    mime_type: Option<String>,
    filename: Option<String>,
) -> Result<(), String> {
    if audio_base64.trim().is_empty() {
        return Err("Empty audio_base64".to_string());
    }

    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64)
        .map_err(|e| format!("Invalid audio base64: {}", e))?;

    let audio_path = last_recording_audio_path()?;
    fs::write(&audio_path, audio_bytes)
        .map_err(|e| format!("Failed to write audio recording: {}", e))?;

    let meta = LastVoiceRecordingMeta {
        mime_type: mime_type
            .unwrap_or_else(|| "audio/webm".to_string())
            .trim()
            .to_string(),
        filename: filename
            .unwrap_or_else(|| "voice-sample.webm".to_string())
            .trim()
            .to_string(),
    };

    let meta_json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("Failed to serialize recording metadata: {}", e))?;
    let meta_path = last_recording_meta_path()?;
    fs::write(&meta_path, meta_json)
        .map_err(|e| format!("Failed to write recording metadata: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn elevenlabs_get_last_recording() -> Result<Option<LastVoiceRecording>, String> {
    let audio_path = last_recording_audio_path()?;
    if !audio_path.exists() {
        return Ok(None);
    }

    let audio_bytes = fs::read(&audio_path)
        .map_err(|e| format!("Failed to read last recording: {}", e))?;
    if audio_bytes.is_empty() {
        return Ok(None);
    }

    let meta_path = last_recording_meta_path()?;
    let meta = if meta_path.exists() {
        fs::read_to_string(&meta_path)
            .ok()
            .and_then(|content| serde_json::from_str::<LastVoiceRecordingMeta>(&content).ok())
            .unwrap_or_default()
    } else {
        LastVoiceRecordingMeta::default()
    };

    let audio_base64 = base64::engine::general_purpose::STANDARD.encode(audio_bytes);

    Ok(Some(LastVoiceRecording {
        audio_base64,
        mime_type: meta.mime_type,
        filename: meta.filename,
    }))
}
