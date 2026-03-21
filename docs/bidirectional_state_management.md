# State Management for Dual Mode

## State Machine Diagram

```
┌──────────────┐
│   IDLE       │ (App not running)
│ ┌──────────┐ │
│ │ Stop all │ │
│ │ capture  │ │
│ └──────────┘ │
└───────┬──────┘
        │ user clicks START
        ▼
┌──────────────┐
│   STARTING   │ (Setup phase)
│ ┌──────────┐ │
│ │ Load     │ │
│ │ device   │ │
│ │ config   │ │
│ └──────────┘ │
└──┬────────┬──┘
   │ Dual?  │ Single?
   ▼        ▼
┌────────────────────────┐
│   DUAL_CAPTURE_ACTIVE  │
│ ┌────────────────────┐ │
│ │ System audio ↔ IPC │ │
│ │ Microphone ↔ IPC   │ │
│ │ Both running       │ │
│ └────────────────────┘ │
└──┬──────────────────┬──┘
   │                  │
   │ [Dual Pipeline]  │
   │                  │
   ▼                  ▼
┌────────────────┐  ┌────────────────┐
│ STREAM_A       │  │ STREAM_B       │
│ Processing     │  │ Processing     │
│               │  │               │
│ System audio  │  │ Microphone    │
│  ↓             │  │  ↓             │
│ Soniox Lang   │  │ Soniox Lang   │
│  ↓             │  │  ↓             │
│ Transcript    │  │ Transcript    │
│  ↓             │  │  ↓             │
│ Display A     │  │ Display B     │
│ + Optional TTS│  │ + TTS         │
│               │  │ + Inject      │
└────────────────┘  └────────────────┘
   │                  │
   └──────────┬───────┘
              │ user clicks STOP
              ▼
          ┌──────────────┐
          │  STOPPING    │
          │ ┌──────────┐ │
          │ │ Stop all │ │
          │ │ capture  │ │
          │ │ Pipeline │ │
          │ └──────────┘ │
          └──────┬───────┘
                 ▼
              [IDLE]
```

## AppState Class

```javascript
class AppState {
    constructor() {
        this.mode = 'single';           // 'single' | 'dual'
        this.status = 'idle';           // 'idle' | 'starting' | 'running' | 'stopping'

        // Dual mode state
        this.streamA = {
            status: 'idle',             // 'idle' | 'capturing' | 'processing' | 'error'
            audioSource: 'system',
            sourceLanguage: 'en',
            targetLanguage: 'vi',
            ttsEnabled: false,          // Optional TTS, default off
            chunks: 0,
            lastError: null,
        };

        this.streamB = {
            status: 'idle',
            audioSource: 'microphone',
            sourceLanguage: 'en',
            targetLanguage: 'vi',
            chunks: 0,
            lastError: null,
            ttsEnabled: true,
            injectEnabled: false,
            outputDevice: 'BlackHole',
        };

        // Shared state
        this.translationMode = 'soniox'; // 'soniox' | 'local'
        this.transcriptA = [];
        this.transcriptB = [];
    }

    setState(path, value) {
        // Usage: this.state.setState('streamA.status', 'capturing')
        const keys = path.split('.');
        let obj = this;

        for (let i = 0; i < keys.length - 1; i++) {
            obj = obj[keys[i]];
        }

        const lastKey = keys[keys.length - 1];
        obj[lastKey] = value;

        console.log(`[State] ${path} = ${value}`);
        this._onStateChange(path, value);
    }

    _onStateChange(path, value) {
        // Trigger UI updates based on state change
        if (path === 'streamA.status' || path === 'streamB.status') {
            this._updateStreamIndicators();
        }
        if (path === 'status') {
            this._updateControlButtons();
        }
    }

    _updateStreamIndicators() {
        // Update visual indicators (color, spinner, etc)
        const audioIndicator = document.querySelector('.audio-indicator-a');
        if (this.streamA.status === 'capturing') {
            audioIndicator.classList.add('active');
        } else {
            audioIndicator.classList.remove('active');
        }
    }
}
```

## Data Flow: Stream A (System Audio)

```
System Audio Device
        │
        │ [16-bit PCM, 16kHz]
        ▼
┌──────────────────┐
│  ScreenCaptureKit│  (macOS only)
│  (Rust backend)  │
└──────┬───────────┘
       │ [send chunk every 100ms]
       ▼
┌──────────────────┐
│ Tauri IPC        │  channel_system.send(chunk)
│ channel_system   │
└──────┬───────────┘
       │ [Vec<u8>]
       ▼
┌──────────────────────────────┐
│ Frontend: app.js             │
│ _processStreamA(chunk)       │
└──────┬───────────────────────┘
       │
       ├─→ Accumulate frames
       ├─→ When buffer full (500ms):
       │   └─→ _translateAudio(buffer)
       │
       ▼
┌──────────────────────────────┐
│ Soniox WebSocket Client      │
│ (sonioxClient.js)            │
└──────┬───────────────────────┘
       │ [send audio bytes]
       ▼
┌───────────────────────────────┐
│ Soniox Cloud Service          │  ← External API
│ STT: Audio → Text (en)        │
│ Translation: en → vi          │
└──────┬────────────────────────┘
       │ [transcription + translation]
       ▼
┌──────────────────────────────┐
│ Update Transcript UI          │
│ transcriptUIStreamA.add()     │
└──────┬───────────────────────┘
       │
    ├─ Optional PATH 2: TTS playback (if streamA.ttsEnabled)
    │  └─→ generateTTS(translated_text, targetLanguage)
    │
    ▼
┌──────────────────────────────┐
│ Display in Stream A Panel    │
│ "[14:23] Speaker: ..."       │
│ "Translation: ..."           │
└──────────────────────────────┘
```

## Data Flow: Stream B (Microphone + Injection)

```
Microphone Device
        │
        │ [16-bit PCM, 16kHz]
        ▼
┌──────────────────┐
│  cpal library    │  (Rust backend)
│  (Microphone)    │
└──────┬───────────┘
       │ [send chunk every 100ms]
       ▼
┌──────────────────┐
│ Tauri IPC        │  channel_mic.send(chunk)
│ channel_mic      │
└──────┬───────────┘
       │ [Vec<u8>]
       ▼
┌──────────────────────────────┐
│ Frontend: app.js             │
│ _processStreamB(chunk)       │
└──────┬───────────────────────┘
       │
       ├─→ Accumulate frames
       ├─→ When buffer full (500ms):
       │   └─→ _translateAudio(buffer)
       │
       ▼
┌──────────────────────────────┐
│ Soniox WebSocket Client      │
│ (sonioxClient.js)            │
└──────┬───────────────────────┘
       │ [send audio bytes]
       ▼
┌───────────────────────────────┐
│ Soniox Cloud Service          │  ← External API
│ STT: Audio → Text (en)        │
│ Translation: en → vi          │
└──────┬────────────────────────┘
       │ [transcription + translation]
       ▼
┌──────────────────────────────┐
│ Split to 2 paths:            │
└──────┬───────────────────────┘
       │
       ├─ PATH 1: Display
       │  ├─→ Update Transcript UI
       │  └─→ transcriptUIStreamB.add()
       │
       └─ PATH 2: TTS + Injection
          │
          ├─ IF ttsEnabled:
          │  ├─→ generateTTS(translated_text, 'vi')
          │  │   ├─→ Edge TTS / Google TTS / ElevenLabs
          │  │   └─→ Get audio bytes (mp3, wav, etc)
          │  │
          │  └─→ IF injectEnabled:
          │      ├─→ Convert TTS audio to PCM (s16le, 16kHz)
          │      ├─→ invoke('inject_audio_to_device', {
          │      │     device: 'BlackHole',
          │      │     audio_data: pcmBytes
          │      │   })
          │      │
          │      └─→ Backend (Rust):
          │          ├─→ Open virtual device 'BlackHole'
          │          ├─→ Write audio stream
          │          └─→ Audio routed to Zoom input ✓
```

## Error Handling State

```javascript
// Handle various error scenarios
class ErrorState {
    ERRORS = {
        DEVICE_NOT_FOUND: {
            code: 1001,
            message: 'Virtual device not found',
            action: 'Ask user to install BlackHole',
            recovery: 'retry_with_default_device',
        },
        PERMISSION_DENIED: {
            code: 1002,
            message: 'Microphone/Screen permission denied',
            action: 'Open System Preferences',
            recovery: 'retry_after_permission',
        },
        SONIOX_CONNECTION_FAILED: {
            code: 2001,
            message: 'Cannot connect to Soniox',
            action: 'Check API key, network',
            recovery: 'retry_with_exponential_backoff',
        },
        STREAM_ERROR: {
            code: 2002,
            message: 'Stream processing error',
            action: 'Restart stream',
            recovery: 'restart_single_stream',
        },
    };

    handle(error, streamId) {
        // If Stream A fails: Continue Stream B
        // If Stream B fails: Continue Stream A
        // If both fail: Stop app

        if (streamId === 'stream_a') {
            console.error('❌ Stream A error:', error);
            this.appState.streamA.status = 'error';
            this.appState.streamA.lastError = error;
            // Keep Stream B running
            if (this.appState.streamB.status !== 'running') {
                this._stopApp();
            }
        } else if (streamId === 'stream_b') {
            console.error('❌ Stream B error:', error);
            this.appState.streamB.status = 'error';
            this.appState.streamB.lastError = error;
            // Keep Stream A running
            if (this.appState.streamA.status !== 'running') {
                this._stopApp();
            }
        }
    }
}
```

## Configuration Persistence

```javascript
// src/js/settings.js

class SettingsManager {
    async load() {
        const settings = await this._loadFromFile();

        return {
            // Single mode
            language_source: 'en',
            language_target: 'vi',
            translation_mode: 'soniox',
            tts_provider: 'edge',

            // Dual mode
            dual_mode_enabled: false,
            stream_a_source: 'system',
            stream_a_language_source: 'en',
            stream_a_language_target: 'vi',
            stream_a_tts_enabled: false, // available toggle, default off

            stream_b_source: 'microphone',
            stream_b_language_source: 'en',
            stream_b_language_target: 'vi',
            stream_b_tts_enabled: true,
            stream_b_inject_enabled: false,
            stream_b_output_device: 'BlackHole',

            // User preferences
            ui_theme: 'light',
            ui_font_size: 14,
            window_opacity: 0.9,
        };
    }

    async save(settings) {
        // Save to Tauri storage
        await invoke('save_settings', { settings });
    }
}
```

## Performance Monitoring

```javascript
class PerformanceMonitor {
    constructor() {
        this.metrics = {
            streamA: {
                chunksReceived: 0,
                chunksProcessed: 0,
                avgLatency: 0, // ms from capture to display
                errorCount: 0,
            },
            streamB: {
                chunksReceived: 0,
                chunksProcessed: 0,
                avgLatency: 0,
                errorCount: 0,
            },
            tts: {
                requestsCount: 0,
                avgGenerationTime: 0, // ms
                failureCount: 0,
            },
            injection: {
                successCount: 0,
                failureCount: 0,
                avgLatency: 0,
            },
        };
    }

    recordStreamChunkReceived(streamId) {
        this.metrics[streamId].chunksReceived++;
    }

    recordStreamLatency(streamId, latencyMs) {
        const m = this.metrics[streamId];
        m.avgLatency = (m.avgLatency + latencyMs) / 2;
    }

    recordTTSGeneration(timeMs, success = true) {
        this.metrics.tts.avgGenerationTime =
            (this.metrics.tts.avgGenerationTime + timeMs) / 2;
        if (!success) this.metrics.tts.failureCount++;
    }

    getReport() {
        return {
            timestamp: new Date().toISOString(),
            uptime: Date.now() - this.startTime,
            metrics: this.metrics,
            health: this._computeHealth(),
        };
    }

    _computeHealth() {
        // Green / Yellow / Red based on error rates
        const errorRate = (this.metrics.tts.failureCount
                          + this.metrics.injection.failureCount)
                         / (this.metrics.tts.requestsCount + 1);

        if (errorRate < 0.01) return 'green';
        if (errorRate < 0.05) return 'yellow';
        return 'red';
    }
}
```

## Testing State Transitions

```javascript
// src/test/state.test.js

describe('Dual Mode State Machine', () => {
    let appState;

    beforeEach(() => {
        appState = new AppState();
    });

    test('Transition: IDLE → STARTING → DUAL_CAPTURE_ACTIVE', async () => {
        expect(appState.status).toBe('idle');

        appState.setState('status', 'starting');
        expect(appState.status).toBe('starting');

        appState.setState('streamA.status', 'capturing');
        appState.setState('streamB.status', 'capturing');
        appState.setState('status', 'running');

        expect(appState.status).toBe('running');
        expect(appState.streamA.status).toBe('capturing');
        expect(appState.streamB.status).toBe('capturing');
    });

    test('Stream A error should not stop Stream B', async () => {
        appState.streamA.status = 'capturing';
        appState.streamB.status = 'capturing';
        appState.status = 'running';

        // Simulate Stream A error
        appState.streamA.status = 'error';
        appState.streamA.lastError = { code: 'SONIOX_TIMEOUT' };

        // Stream B should continue
        expect(appState.streamB.status).toBe('capturing');
        expect(appState.status).toBe('running');
    });

    test('Both streams error should stop app', async () => {
        appState.streamA.status = 'error';
        appState.streamB.status = 'error';

        // App should stop
        appState.setState('status', 'stopping');
        expect(appState.status).toBe('stopping');
    });

    test('Unidirectional → Bidirectional mode switch', async () => {
        appState.mode = 'single';
        appState.streamA.status = 'idle';
        appState.streamB.status = 'idle';

        // Switch to dual
        appState.mode = 'dual';
        appState.streamA.audioSource = 'system';
        appState.streamB.audioSource = 'microphone';

        expect(appState.mode).toBe('dual');
        expect(appState.streamA.audioSource).toBe('system');
        expect(appState.streamB.audioSource).toBe('microphone');
    });
});
```

## Debug Console Commands

```javascript
// Type in browser console to debug

// Show current state
window.app.appState.getReport()

// Manually trigger stream processing
await window.app._processStreamA(audioChunk)

// Test TTS injection
await window.app._injectAudioToDevice('Xin chào', 'vi')

// List virtual devices
const devices = await window.__TAURI__.core.invoke('list_virtual_devices');
console.log(devices);

// Volume/Level monitoring (Stream B)
window.monitorStreamB = setInterval(() => {
    const level = calculateAudioLevel(window.app.streamBBuffer);
    console.log('📊 Stream B Level:', level.toFixed(2), 'dB');
}, 1000);
clearInterval(window.monitorStreamB); // to stop
```

## Debugging Checklist

- [ ] State transitions logged correctly
- [ ] Stream A captures independently
- [ ] Stream B captures independently
- [ ] Translation API calls successful
- [ ] TTS generation working
- [ ] Audio injection to virtual device working
- [ ] Error in one stream doesn't kill other stream
- [ ] UI updates reflect state changes
- [ ] Settings saved/loaded correctly
- [ ] Performance metrics reasonable (<500ms latency)
