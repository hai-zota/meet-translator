/// TTS Audio Player — plays MP3 audio on a dedicated background thread.
///
/// All decoding and playback runs completely outside the JS main thread,
/// so audio-capture forwarding and Soniox communication are never blocked.

use base64::Engine as _;
use rodio::{Decoder, OutputStream, Sink};
use std::io::Cursor;
use std::sync::mpsc;
use std::sync::Mutex;

pub enum TtsCommand {
    Play(Vec<u8>), // raw MP3 bytes
    Stop,
    Shutdown,
}

pub struct TtsPlayer {
    tx: mpsc::Sender<TtsCommand>,
}

impl TtsPlayer {
    /// Spawn a background thread that owns the audio output stream.
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<TtsCommand>();

        std::thread::Builder::new()
            .name("tts-player".into())
            .spawn(move || {
                // Create output stream on this thread (owns the audio device)
                let (_stream, stream_handle) = match OutputStream::try_default() {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[TtsPlayer] Failed to open audio output: {}", e);
                        return;
                    }
                };

                let sink = match Sink::try_new(&stream_handle) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[TtsPlayer] Failed to create sink: {}", e);
                        return;
                    }
                };

                loop {
                    match rx.recv() {
                        Ok(TtsCommand::Play(mp3_bytes)) => {
                            let cursor = Cursor::new(mp3_bytes);
                            match Decoder::new(cursor) {
                                Ok(source) => {
                                    sink.append(source);
                                    // Non-blocking: sink plays in background
                                }
                                Err(e) => {
                                    eprintln!("[TtsPlayer] MP3 decode error: {}", e);
                                }
                            }
                        }
                        Ok(TtsCommand::Stop) => {
                            sink.clear();
                        }
                        Ok(TtsCommand::Shutdown) | Err(_) => {
                            sink.clear();
                            break;
                        }
                    }
                }
            })
            .expect("spawn tts-player thread");

        Self { tx }
    }

    pub fn play_base64(&self, base64_audio: &str) -> Result<(), String> {
        let mp3_bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_audio)
            .map_err(|e| format!("base64 decode error: {}", e))?;

        if mp3_bytes.is_empty() {
            return Err("Empty audio data".into());
        }

        self.tx
            .send(TtsCommand::Play(mp3_bytes))
            .map_err(|_| "TTS player thread stopped".to_string())
    }

    pub fn stop(&self) {
        let _ = self.tx.send(TtsCommand::Stop);
    }
}

impl Drop for TtsPlayer {
    fn drop(&mut self) {
        let _ = self.tx.send(TtsCommand::Shutdown);
    }
}

/// Managed state for Tauri
pub struct TtsPlayerState {
    pub player: Mutex<TtsPlayer>,
}
