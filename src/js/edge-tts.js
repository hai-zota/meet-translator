/**
 * Edge TTS via Rust - Frontend module
 * Calls Rust backend to proxy Edge TTS WebSocket (avoids browser header limitations).
 * Returns base64 MP3 audio, played via audioPlayer.
 */

const { invoke } = window.__TAURI__.core;

class EdgeTTSRust {
    constructor() {
        this.voice = 'vi-VN-HoaiMyNeural';
        this.speed = 20; // percentage: +20% default
        this.isConnected = false;
        this._queue = [];
        this._isSpeaking = false;
        this._generation = 0; // Incremented on connect/disconnect to discard stale invoke results
        this._metaQueue = [];

        // Same callback interface as other TTS providers
        this.onAudioChunk = null;
        this.onError = null;
        this.onStatusChange = null;
    }

    configure({ voice, speed }) {
        if (voice) this.voice = voice;
        if (speed !== undefined) this.speed = speed;
    }

    connect() {
        this._generation += 1;
        this._isSpeaking = false;
        this.isConnected = true;
        this._setStatus('connected');
        console.log('[Edge TTS] Ready via Rust proxy');
    }

    speak(text, options = null) {
        if (!text?.trim()) return;
        this._queue.push(text.trim());
        this._metaQueue.push(options || null);
        if (!this._isSpeaking) {
            this._processQueue();
        }
    }

    async _processQueue() {
        const gen = this._generation; // Capture generation; changes on connect/disconnect
        if (this._queue.length === 0) {
            this._isSpeaking = false;
            return;
        }

        this._isSpeaking = true;
        const text = this._queue.shift();
        const meta = this._metaQueue.shift() || null;
        const startTime = performance.now();

        try {
            const base64Audio = await invoke('edge_tts_speak', {
                text: text,
                voice: this.voice,
                rate: this.speed,
            });

            // Discard result if disconnect/reconnect happened while we were awaiting
            if (gen !== this._generation) return;

            const elapsed = performance.now() - startTime;
            console.log(`[Edge TTS] Audio received in ${elapsed.toFixed(0)}ms`);

            if (this.onAudioChunk) {
                this.onAudioChunk(base64Audio, true, meta);
            }
        } catch (err) {
            if (gen !== this._generation) return; // Stale - discard silently
            console.error('[Edge TTS] Error:', err);
            this.onError?.(`Edge TTS: ${err}`);
        }

        // Process next in queue only if still in the same session
        if (gen === this._generation) {
            this._processQueue();
        }
    }

    disconnect() {
        this._generation += 1;
        this._queue = [];
        this._metaQueue = [];
        this._isSpeaking = false;
        this.isConnected = false;
        this._setStatus('disconnected');
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

export const edgeTTSRust = new EdgeTTSRust();
