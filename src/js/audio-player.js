/**
 * AudioPlayer — queue-based audio playback using Web Audio API
 * Handles base64 MP3 chunks from ElevenLabs TTS and plays them seamlessly.
 */

class AudioPlayer {
    constructor() {
        this.audioContext = null;
        this._queue = [];           // Queue of { buffer, gain }
        this._isPlaying = false;
        this._nextStartTime = 0;
        this._enabled = true;
        this._currentSource = null; // Currently playing AudioBufferSourceNode
        this._maxQueueSize = 10;    // Max buffers in queue before dropping old ones
        // Callback fired when playback state changes: (isPlaying: boolean) => void
        this.onPlayStateChange = null;
    }

    /**
     * Initialize AudioContext. Must be called after user gesture.
     */
    init() {
        if (this.audioContext) return;
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('[AudioPlayer] Initialized, state:', this.audioContext.state);
    }

    /**
     * Ensure AudioContext is running (handle autoplay policy)
     */
    async resume() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
            console.log('[AudioPlayer] Resumed from suspended state');
        }
    }

    /**
     * Enqueue a base64-encoded audio chunk for playback.
     * @param {string} base64Audio - base64-encoded MP3 data
     * @param {number} gain - linear gain multiplier (0.0 - 2.0)
     */
    async enqueue(base64Audio, gain = 1.0) {
        if (!this._enabled || !this.audioContext || !base64Audio) return;

        // Ensure context is running
        await this.resume();

        // Decode base64 → binary
        const binaryStr = atob(base64Audio);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }

        try {
            // Decode MP3 → AudioBuffer
            const audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer.slice(0));

            // Backlog management: if queue is too large, drop oldest
            if (this._queue.length >= this._maxQueueSize) {
                const dropped = this._queue.length - this._maxQueueSize + 1;
                this._queue.splice(0, dropped);
                console.warn(`[AudioPlayer] Dropped ${dropped} stale audio buffer(s)`);
            }

            this._queue.push({
                buffer: audioBuffer,
                gain: Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1.0,
            });
            this._scheduleNext();
        } catch (e) {
            // Small/empty chunks may fail to decode — that's OK
            if (bytes.length > 100) {
                console.warn('[AudioPlayer] Decode failed for chunk of size:', bytes.length, e.message);
            }
        }
    }

    /**
     * Schedule the next buffer in the queue for seamless playback
     */
    _scheduleNext() {
        if (this._queue.length === 0 || !this.audioContext) {
            this._isPlaying = false;
            return;
        }

        if (this._isPlaying && this._nextStartTime > this.audioContext.currentTime + 0.1) {
            // Already have audio scheduled ahead — wait for onended
            return;
        }

        const item = this._queue.shift();
        const buffer = item.buffer;
        const gainValue = item.gain;
        const source = this.audioContext.createBufferSource();
        const gainNode = this.audioContext.createGain();
        source.buffer = buffer;
        gainNode.gain.value = gainValue;
        source.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        // Schedule seamlessly after previous chunk
        const currentTime = this.audioContext.currentTime;
        const startTime = Math.max(currentTime, this._nextStartTime);

        const wasPlaying = this._isPlaying;
        source.start(startTime);
        this._nextStartTime = startTime + buffer.duration;
        this._currentSource = source;
        this._isPlaying = true;
        if (!wasPlaying) this.onPlayStateChange?.(true);

        source.onended = () => {
            if (this._queue.length > 0) {
                this._scheduleNext();
            } else {
                this._isPlaying = false;
                this._currentSource = null;
                this.onPlayStateChange?.(false);
            }
        };
    }

    /**
     * Stop all playback and clear the queue
     */
    stop() {
        this._queue = [];
        this._isPlaying = false;
        this._nextStartTime = 0;

        if (this._currentSource) {
            try {
                this._currentSource.stop();
            } catch (e) {
                // Already stopped
            }
            this._currentSource = null;
        }

        // Reset AudioContext timing
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(() => {});
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        this.onPlayStateChange?.(false);
    }

    /**
     * Enable/disable playback
     */
    setEnabled(enabled) {
        this._enabled = enabled;
        if (!enabled) {
            this.stop();
        }
    }

    /**
     * Check if currently playing or has queued audio
     */
    get isActive() {
        return this._isPlaying || this._queue.length > 0;
    }

    get enabled() {
        return this._enabled;
    }
}

export const audioPlayer = new AudioPlayer();
