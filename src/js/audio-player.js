/**
 * AudioPlayer — delegates all audio playback to a Rust background thread.
 *
 * The JS main thread does ZERO decoding or playback work.
 * Base64 MP3 is sent to Rust via invoke(), where a dedicated thread
 * decodes and plays it using rodio. This ensures audio-capture
 * channel.onmessage callbacks are never starved.
 */

const { invoke } = window.__TAURI__.core;

class AudioPlayer {
    constructor() {
        this.audioContext = null; // kept for decodeBase64ToPcm16Mono compatibility
        this._enabled = true;
    }

    init() {
        if (this.audioContext) return;
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    async resume() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    /**
     * Send base64 audio to Rust for playback.
     * Returns immediately — all work happens on a Rust thread.
     */
    enqueue(base64Audio) {
        if (!this._enabled || !base64Audio) return;

        // Fire-and-forget: invoke returns a Promise but we don't await it
        invoke('play_tts_audio', { base64Audio }).catch((err) => {
            console.warn('[AudioPlayer] Rust playback error:', err);
        });
    }

    stop() {
        invoke('stop_tts_audio').catch(() => {});

        // Reset AudioContext for decode compatibility
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(() => {});
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    setEnabled(enabled) {
        this._enabled = enabled;
        if (!enabled) this.stop();
    }

    get isActive() {
        return false; // playback state is in Rust now
    }

    get enabled() {
        return this._enabled;
    }
}

export const audioPlayer = new AudioPlayer();
