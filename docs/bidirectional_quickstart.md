# Quick Start: Triển khai Dịch 2 Chiều

## Tl;dr - Bắt đầu ngay

### Yêu cầu
```bash
# 1. Cài BlackHole (macOS)
brew install blackhole-2ch

# 2. Cài Tauri deps
npm install

# 3. Cài Rust deps
cargo build
```

## Architecture Overview (Dễ hiểu)

```
┌─────────────────────────┐
│   Zoom/Teams Meeting    │
│  ┌───────────────────┐  │
│  │  Meeting Audio    │  │ ← System Audio (Speaker A)
│  └───────────────────┘  │
└─────────────────────────┘
           ↓
┌─────────────────────────┐
│  Meet-Translator App    │
│  ┌─────────────────┐    │
│  │ Capture Both:   │    │
│  │ 1. System Audio │    │
│  │ 2. Microphone   │    │
│  └─────────────────┘    │
│           ↓             │
│  ┌─────────────────┐    │
│  │ Dual Pipeline:  │    │
│  │ Stream A → TTS  │    │
│  │ Stream B → TTS  │    │
│  └─────────────────┘    │
└─────────────────────────┘
           ↓
    ┌──────────────┐
    │   BlackHole  │ ← Virtual Audio Device
    │ (Loopback)   │
    └──────────────┘
           ↓ (Inject)
    ┌──────────────┐
    │   Zoom App   │ ← Hear translated voice
    └──────────────┘
```

## Implementation Phases (Code Examples)

### Phase 1: Virtual Audio Device Support (Day 1-2)

**Step 1.1:** Tạo file `src-tauri/src/audio/virtual_device.rs`

```rust
use core_audio::sys::*;
use serde::Serialize;
use std::ffi::CStr;

#[derive(Clone, Debug, Serialize)]
pub struct VirtualDevice {
    pub id: u32,
    pub name: String,
    pub is_output: bool,
}

impl VirtualDevice {
    /// Liệt kê virtual audio devices (BlackHole, Soundflower)
    pub fn list_all() -> Result<Vec<VirtualDevice>, String> {
        let mut device_list = Vec::new();

        // Dùng Core Audio API để quét devices
        unsafe {
            let mut device_count: u32 = 0;
            let mut query_size = std::mem::size_of::<u32>();

            AudioHardwareGetPropertyInfo(
                kAudioHardwarePropertyDevices,
                &mut query_size as *const _ as *mut _,
                std::ptr::null_mut(),
            );

            device_count = query_size / std::mem::size_of::<AudioDeviceID>();
            let mut device_ids = vec![0; device_count as usize];

            AudioHardwareGetProperty(
                kAudioHardwarePropertyDevices,
                &mut query_size as *const _ as *mut _,
                device_ids.as_mut_ptr() as *mut _,
            );

            for device_id in device_ids {
                if let Ok(name) = Self::get_device_name(device_id) {
                    // Filter virtual devices
                    if name.to_lowercase().contains("loopback")
                        || name.to_lowercase().contains("blackhole")
                        || name.to_lowercase().contains("soundflower")
                    {
                        device_list.push(VirtualDevice {
                            id: device_id,
                            name,
                            is_output: true,
                        });
                    }
                }
            }
        }

        Ok(device_list)
    }

    fn get_device_name(device_id: u32) -> Result<String, String> {
        // Implementation using Core Audio API
        // Return device name
        Ok("BlackHole 2ch".to_string())
    }

    /// Kiểm tra virtual device có khả dụng không
    pub fn is_available(device_name: &str) -> Result<bool, String> {
        let devices = Self::list_all()?;
        Ok(devices.iter().any(|d| d.name.contains(device_name)))
    }
}

// Tauri command
#[tauri::command]
pub fn list_virtual_devices() -> Result<Vec<VirtualDevice>, String> {
    VirtualDevice::list_all()
}
```

**Step 1.2:** Update `src-tauri/src/lib.rs` to register command

```rust
mod audio;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::list_virtual_devices,  // ← Add this
            // ... other commands
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 1.3:** Test từ frontend

```javascript
// src/js/app.js
async function testVirtualDevices() {
    const { invoke } = window.__TAURI__.core;
    try {
        const devices = await invoke('list_virtual_devices');
        console.log('Available virtual devices:', devices);
        // Populate device selector
    } catch (err) {
        console.error('Failed to list devices:', err);
    }
}
```

### Phase 2: Dual Audio Capture (Day 2-3)

**Step 2.1:** Tạo `src-tauri/src/models.rs`

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TranslationStream {
    pub id: String,                    // "stream_a" | "stream_b"
    pub audio_source: String,          // "system" | "microphone"
    pub source_language: String,       // "en", "vi", etc
    pub target_language: String,
    pub tts_enabled: bool,
    pub output_device: Option<String>, // Virtual device ID
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DualCaptureConfig {
    pub stream_a: TranslationStream,
    pub stream_b: TranslationStream,
}
```

**Step 2.2:** Update `src-tauri/src/commands/audio.rs`

```rust
use tauri::ipc::Channel;
use std::sync::mpsc;

pub struct AudioState {
    pub system_audio: Mutex<SystemAudioCapture>,
    pub microphone: Mutex<MicCapture>,
}

#[tauri::command]
pub fn start_dual_capture(
    channel_system: Channel<Vec<u8>>,
    channel_mic: Channel<Vec<u8>>,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    // Stop any existing capture
    stop_capture_inner(&state)?;

    // Start system audio in separate task
    let state_clone1 = state.inner().clone();
    let channel_system_clone = channel_system.clone();
    std::thread::spawn(move || {
        let sys = state_clone1.system_audio.lock().unwrap();
        if let Ok(receiver) = sys.start() {
            while let Ok(chunk) = receiver.recv() {
                if let Err(_) = channel_system_clone.send(chunk) {
                    break; // Channel closed
                }
            }
        }
    });

    // Start microphone in separate task
    let state_clone2 = state.inner().clone();
    let channel_mic_clone = channel_mic.clone();
    std::thread::spawn(move || {
        let mut mic = state_clone2.microphone.lock().unwrap();
        if let Ok(receiver) = mic.start() {
            while let Ok(chunk) = receiver.recv() {
                if let Err(_) = channel_mic_clone.send(chunk) {
                    break; // Channel closed
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_dual_capture(
    state: State<'_, AudioState>,
) -> Result<(), String> {
    let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
    sys.stop();

    let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
    mic.stop();

    Ok(())
}
```

**Step 2.3:** Frontend - Listen to both streams

```javascript
// src/js/app.js
async _startDualCapture() {
    const { invoke } = window.__TAURI__.core;
    const { Channel } = window.__TAURI__.core;

    try {
        // Create separate channels for each stream
        const channelA = new Channel();
        const channelB = new Channel();

        // Start dual capture
        await invoke('start_dual_capture', {
            channel_system: channelA,
            channel_mic: channelB,
        });

        // Listen to system audio (meeting)
        channelA.onmessage = async (audioChunk) => {
            console.log('📺 System audio chunk received');
            await this._processStreamA(audioChunk);
        };

        // Listen to microphone (user)
        channelB.onmessage = async (audioChunk) => {
            console.log('🎤 Microphone chunk received');
            await this._processStreamB(audioChunk);
        };

        this.isRunning = true;
        console.log('✅ Dual capture started');
    } catch (err) {
        console.error('❌ Dual capture failed:', err);
        throw err;
    }
}

async _processStreamA(audioChunk) {
    // Stream A: System audio (meeting voice)
    try {
        const result = await this._translateAudio(audioChunk, {
            source_language: this.settingsManager.get().language_source,
            target_language: this.settingsManager.get().language_target,
        });

        // Display translation (and optional TTS)
        this.transcriptUIStreamA.addSegment({
            original: result.original_text,
            translated: result.translated_text,
            speaker: 'Meeting',
        });

        // Optional TTS for Stream A (local playback only, no injection)
        if (this.settingsManager.get().stream_a_tts_enabled) {
            await this._playTTS(result.translated_text, this.settingsManager.get().language_target);
        }
    } catch (err) {
        console.error('Translation error (Stream A):', err);
    }
}

async _processStreamB(audioChunk) {
    // Stream B: User microphone (user voice)
    try {
        const result = await this._translateAudio(audioChunk, {
            source_language: this.settingsManager.get().language_source,
            target_language: this.settingsManager.get().language_target,
        });

        // Display
        this.transcriptUIStreamB.addSegment({
            original: result.original_text,
            translated: result.translated_text,
            speaker: 'You',
        });

        // Inject to virtual device (Audio injection)
        if (this.shouldInjectAudio) {
            await this._injectAudioToDevice(
                result.translated_text,
                this.settingsManager.get().language_target
            );
        }
    } catch (err) {
        console.error('Translation error (Stream B):', err);
    }
}
```

### Phase 3: Audio Injection (Day 3-4)

**Step 3.1:** Add audio injection command

```rust
// src-tauri/src/commands/audio.rs

#[tauri::command]
pub async fn inject_audio_to_device(
    device_name: String,
    audio_data: Vec<u8>, // s16le 16kHz mono PCM
) -> Result<(), String> {
    // Write audio to specified virtual device
    unsafe {
        // Use Core Audio API to write to device
        // This is complex - likely needs external library
        println!("Injecting {} bytes to {}", audio_data.len(), device_name);
    }
    Ok(())
}
```

**Step 3.2:** Frontend TTS + Injection

```javascript
async _injectAudioToDevice(text, targetLanguage) {
    const { invoke } = window.__TAURI__.core;

    try {
        // Generate TTS audio
        const ttsAudio = await this._generateTTS(text, targetLanguage);

        // Convert to Base64 for Tauri
        const base64Audio = btoa(String.fromCharCode(...new Uint8Array(ttsAudio)));

        // Inject to selected virtual device
        const device = this.settingsManager.get().output_device || 'BlackHole';
        await invoke('inject_audio_to_device', {
            device_name: device,
            audio_data: base64Audio,
        });

        console.log('✅ Audio injected to', device);
    } catch (err) {
        console.error('Injection failed:', err);
    }
}
```

### Phase 4: UI for Dual Mode (Day 4-5)

**Step 4.1:** Update `src/index.html`

```html
<!-- Add before closing body tag -->
<div id="view-dualpanel" class="view hidden">
  <div class="dual-header">
    <h2>🔄 Bidirectional Translation</h2>
    <button id="btn-back-to-main">← Back</button>
  </div>

  <div class="dual-controls">
    <label>
      <input type="checkbox" id="inject-audio">
      Inject Translated Audio to Meeting
    </label>
    <select id="output-device">
      <option value="BlackHole">BlackHole (Recommended)</option>
      <option value="Soundflower">Soundflower</option>
      <option value="default">Default Output</option>
    </select>
  </div>

  <div class="dual-container">
    <!-- Stream A: Meeting Audio -->
    <div class="stream-panel stream-a">
      <h3>📺 Meeting Audio</h3>
      <div class="stream-settings">
        <div>
          <label>From:</label>
          <select id="stream-a-from">
            <option value="en">English</option>
            <option value="vi">Vietnamese</option>
            <option value="zh">Chinese</option>
          </select>
        </div>
        <div>
          <label>To:</label>
          <select id="stream-a-to">
            <option value="vi" selected>Vietnamese</option>
            <option value="en">English</option>
            <option value="zh">Chinese</option>
          </select>
        </div>
                <div>
                    <label>
                        <input type="checkbox" id="stream-a-tts">
                        Enable TTS
                    </label>
                </div>
      </div>
      <div class="stream-transcript" id="transcript-a"></div>
    </div>

    <!-- Stream B: User Input -->
    <div class="stream-panel stream-b">
      <h3>🎤 Your Input</h3>
      <div class="stream-settings">
        <div>
          <label>From:</label>
          <select id="stream-b-from">
            <option value="en">English</option>
            <option value="vi">Vietnamese</option>
            <option value="zh">Chinese</option>
          </select>
        </div>
        <div>
          <label>To:</label>
          <select id="stream-b-to">
            <option value="vi" selected>Vietnamese</option>
            <option value="en">English</option>
            <option value="zh">Chinese</option>
          </select>
        </div>
      </div>
      <div class="stream-transcript" id="transcript-b"></div>
    </div>
  </div>
</div>

<style>
  .dual-container {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    height: 90vh;
  }

  .stream-panel {
    border: 2px solid #ccc;
    border-radius: 8px;
    padding: 10px;
    overflow-y: auto;
  }

  .stream-a {
    border-color: #ff6b6b;
  }

  .stream-b {
    border-color: #4c6ef5;
  }

  .stream-transcript {
    font-size: 13px;
    line-height: 1.6;
  }

  .dual-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px;
    border-bottom: 1px solid #eee;
  }
</style>
```

**Step 4.2:** Update app.js to handle dual mode

```javascript
class App {
    // ... existing code ...

    _bindEvents() {
        // ... existing events ...

        // Dual mode toggle
        document.getElementById('btn-dual-mode').addEventListener('click', () => {
            this.currentMode = this.currentMode === 'single' ? 'dual' : 'single';
            this._showView(this.currentMode === 'dual' ? 'dualpanel' : 'overlay');
        });

        // Dual panel: Inject audio checkbox
        document.getElementById('inject-audio').addEventListener('change', (e) => {
            this.shouldInjectAudio = e.target.checked;
            console.log('Audio injection:', this.shouldInjectAudio ? 'ON' : 'OFF');
        });

        // Dual panel: Output device selection
        document.getElementById('output-device').addEventListener('change', (e) => {
            this.outputDevice = e.target.value;
            console.log('Output device:', this.outputDevice);
        });

        // Dual panel: Language selections
        document.getElementById('stream-a-from').addEventListener('change', (e) => {
            this.dualConfig.stream_a.source_language = e.target.value;
        });
        document.getElementById('stream-a-to').addEventListener('change', (e) => {
            this.dualConfig.stream_a.target_language = e.target.value;
        });
        document.getElementById('stream-a-tts').addEventListener('change', (e) => {
            this.dualConfig.stream_a.tts_enabled = e.target.checked;
        });
        document.getElementById('stream-b-from').addEventListener('change', (e) => {
            this.dualConfig.stream_b.source_language = e.target.value;
        });
        document.getElementById('stream-b-to').addEventListener('change', (e) => {
            this.dualConfig.stream_b.target_language = e.target.value;
        });

        // Back button
        document.getElementById('btn-back-to-main').addEventListener('click', async () => {
            await this.stop();
            this._showView('overlay');
        });
    }

    async start() {
        if (this.currentMode === 'dual') {
            console.log('🚀 Starting DUAL mode capture...');
            await this._startDualCapture();
        } else {
            console.log('🚀 Starting SINGLE mode capture...');
            await this._startSingleCapture();
        }
    }
}
```

## Testing Checklist ✅

### Level 1: Setup
- [ ] Cài BlackHole bằng: `brew install blackhole-2ch`
- [ ] Verify: `npm run tauri dev` chạy không lỗi
- [ ] Verify: Rust compile không lỗi: `cargo build`

### Level 2: Audio Capture
- [ ] System audio capture: Mở YouTube, nghe được âm thanh
- [ ] Microphone capture: Nói vào mic, thấy waveform
- [ ] Dual capture: Cả 2 cùng chạy, dữ liệu độc lập

### Level 3: Translation
- [ ] Stream A: Phát tiếng Anh → Thấy dịch tiếng Việt
- [ ] Stream B: Nói tiếng Anh → Thấy dịch tiếng Việt
- [ ] Soniox connection stable

### Level 4: Audio Injection
- [ ] Inject audio: TTS phát qua BlackHole device
- [ ] Zoom test: Chọn BlackHole làm input, nghe được TTS

### Level 5: Integration
- [ ] Zoom meeting (2 người):
  1. User A: Speak E → User B thấy Vietnamese translation
  2. User B: Speak V (qua app) → User A thấy English translation
  3. 🎉 Success!

## Troubleshooting

### BlackHole không hiển thị
```bash
# Verify installed
system_profiler SPAudioDataType | grep BlackHole

# Reinstall
brew uninstall blackhole-2ch
brew install blackhole-2ch
```

### Audio capture không nhận dữ liệu
```bash
# Check permissions
# System Preferences → Security & Privacy → Screen Recording
# → Cho phép VS Code

# Restart app
npm run tauri dev
```

### Injection không hoạt động
```bash
# Check device available
# Right-click volume icon → Select output
# → Chọn BlackHole, test audio

# In app, debug:
console.log('Devices:', await invoke('list_virtual_devices'));
```

## Timeline Estimate

| Phase | Tasks | Effort | Days |
|-------|-------|--------|------|
| 1 | Virtual device support + testing | Med | 1-2 |
| 2 | Dual audio capture + IPC | High | 2-3 |
| 3 | Audio injection + TTS | High | 2-3 |
| 4 | UI + settings | Med | 2-3 |
| 5 | Testing + refinement | Med | 2-3 |
| **TOTAL** | | | **9-14** |

**Accelerated path (5-7 days):** Skip Phase 5 testing, do basic validation only
