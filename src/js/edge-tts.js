/**
 * Edge TTS via Rust — Frontend module
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
        this._logCounter = 0;
        this._maxQueueDepth = 0;
        this._queueDepthAlertThreshold = 5;

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
        this.isConnected = true;
        this._setStatus('connected');
        console.log('[Edge TTS] Ready via Rust proxy');
    }

    speak(text, meta = null) {
        if (!text?.trim()) return;
        this._queue.push({ text: text.trim(), meta });
        if (this._queue.length > this._maxQueueDepth) this._maxQueueDepth = this._queue.length;
        if (this._queue.length > this._queueDepthAlertThreshold) {
            console.warn(`[Edge TTS] Queue: ${this._queue.length} items (max: ${this._maxQueueDepth})`);
        }
        if (!this._isSpeaking) {
            this._processQueue();
        }
    }

    async _processQueue() {
        if (this._queue.length === 0) {
            this._isSpeaking = false;
            return;
        }

        this._isSpeaking = true;
        const entry = this._queue.shift();
        const text = entry?.text || '';
        const meta = entry?.meta || null;
        const startTime = performance.now();

        try {
            const base64Audio = await invoke('edge_tts_speak', {
                text: text,
                voice: this.voice,
                rate: this.speed,
            });

            const elapsed = performance.now() - startTime;
            this._logCounter++;
            if (elapsed >= 1800 || this._logCounter % 10 === 0) {
                console.log(`[Edge TTS] Audio received in ${elapsed.toFixed(0)}ms`);
            }

            if (this.onAudioChunk) {
                this.onAudioChunk(base64Audio, true, meta);
            }
        } catch (err) {
            console.error('[Edge TTS] Error:', err);
            this.onError?.(`Edge TTS: ${err}`);
        }

        // Process next in queue
        this._processQueue();
    }

    disconnect() {
        if (this._queue.length > 0) console.warn(`[Edge TTS] Disconnect: ${this._queue.length} items in queue`);
        this._queue = [];
        this._isSpeaking = false;
        this.isConnected = false;
        this._maxQueueDepth = 0;
        this._setStatus('disconnected');
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

export const edgeTTSRust = new EdgeTTSRust();
