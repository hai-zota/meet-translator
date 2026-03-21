# Hướng dẫn triển khai dịch 2 chiều (Bidirectional Translation)

## 1. Tổng quan kiến trúc mới

### Luồng hiện tại (Unidirectional - 1 chiều)
```
System Audio / Microphone → Capture → Soniox/Local → TTS → Output
```

### Luồng mới (Bidirectional - 2 chiều)
```
┌─────────────────────────────────────────────────────────────┐
│                                                               │
│  MEETING APP (Zoom, Teams, Meet, etc.)                       │
│  ├─ System Audio (Language A) → Stream 1                      │
│  └─ Virtual Output ← Injected Audio (Language B)              │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                          │                    ▲
                          │                    │
                    Capture (ScreenCaptureKit) │ Inject (?)
                          │                    │
                          ▼                    │
┌──────────────────────────────────────────────┴────────────────┐
│                  Meet-Translator App                          │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Simultaneous Dual Pipelines                             │ │
│  │  ┌────────────────────┐       ┌────────────────────┐    │ │
│  │  │  Stream A:         │       │  Stream B:         │    │ │
│  │  │  System Audio      │       │  Microphone Input  │    │ │
│  │  │  (Meeting)         │       │  (User)            │    │ │
│  │  ├────────────────────┤       ├────────────────────┤    │ │
│  │  │  STT: Soniox/MLX   │       │  STT: Soniox/MLX   │    │ │
│  │  │  Source: Lang A    │       │  Source: Lang A    │    │ │
│  │  │  Target: Lang B    │       │  Target: Lang B    │    │ │
│  │  ├────────────────────┤       ├────────────────────┤    │ │
│  │  │  Display: A → B tr │       │  Display: User tr  │    │ │
│  │  │  TTS: Optional     │       │  TTS: Lang B       │    │ │
│  │  │  Output: Local Spk │       │  Output: Virtual   │    │ │
│  │  └────────────────────┘       │  Device            │    │ │
│  │                               └────────────────────┘    │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

## 2. Các thay đổi cần thiết

### A. Backend (Rust) - src-tauri/src/

#### 1. Mô hình dữ liệu mới: `TranslationStream`

**File: `src-tauri/src/models.rs` (TẠO MỚI)**

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TranslationStream {
    pub id: String,                    // "stream_a" hoặc "stream_b"
    pub name: String,                  // "Meeting Audio" hoặc "User Input"
    pub audio_source: String,          // "system" | "microphone"
    pub source_language: String,       // "en" | "vi" | ...
    pub target_language: String,       // "en" | "vi" | ...
    pub tts_enabled: bool,             // Có phát TTS không
    pub output_device: Option<String>, // Virtual device ID (cho Stream B)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BidirectionalConfig {
    pub stream_a: TranslationStream,
    pub stream_b: TranslationStream,
    pub dual_mode_enabled: bool,
}
```

#### 2. Cấu trúc capture mới

**File: `src-tauri/src/commands/audio.rs` (THAY ĐỔI)**

```rust
pub struct AudioState {
    pub system_audio: Mutex<SystemAudioCapture>,
    pub microphone: Mutex<MicCapture>,
    pub dual_capture_active: Mutex<Option<DualAudioCapture>>,
}

pub struct DualAudioCapture {
    pub system_receiver: mpsc::Receiver<Vec<u8>>,
    pub mic_receiver: mpsc::Receiver<Vec<u8>>,
    pub system_forwarder: AudioForwarder,
    pub mic_forwarder: AudioForwarder,
}

#[tauri::command]
pub fn start_dual_capture(
    channel_system: Channel<Vec<u8>>,    // Dòng 1: System audio
    channel_mic: Channel<Vec<u8>>,        // Dòng 2: Microphone
    state: State<'_, AudioState>,
) -> Result<(), String> {
    // Khởi động cả 2 capture cùng lúc
    // Mỗi capture chạy trong 1 tokio::spawn riêng
    // Gửi dữ liệu về frontend qua các channel riêng
}

#[tauri::command]
pub fn stop_dual_capture(
    state: State<'_, AudioState>,
) -> Result<(), String> {
    // Dừng cả 2 capture
}
```

#### 3. Virtual audio device management

**File: `src-tauri/src/audio/virtual_device.rs` (TẠO MỚI)**

```rust
use core_audio::sys::*;

pub struct VirtualAudioDevice {
    pub device_id: AudioDeviceID,
    pub name: String,
}

impl VirtualAudioDevice {
    /// Liệt kê tất cả virtual audio devices
    pub fn list_devices() -> Result<Vec<VirtualAudioDevice>, String> {
        // Quét qua Core Audio để tìm Soundflower, BlackHole v.v.
        // Return danh sách virtual devices khả dụng
    }

    /// Lấy default virtual output device
    pub fn get_default() -> Result<VirtualAudioDevice, String> {
        // Tìm thiết bị ưu tiên (ví dụ: BlackHole, Soundflower)
    }

    /// Ghi audio data đến virtual device
    pub fn write_audio(&self, audio_data: Vec<u8>) -> Result<(), String> {
        // Sử dụng Core Audio API để ghi audio
        // Format: s16le 16kHz mono
    }
}
```

#### 4. Dual pipeline handler

**File: `src-tauri/src/commands/dual_pipeline.rs` (TẠO MỚI)**

```rust
use crate::models::{TranslationStream, BidirectionalConfig};

pub struct DualTranslationPipeline {
    config: BidirectionalConfig,
    system_buffer: Mutex<Vec<u8>>,
    mic_buffer: Mutex<Vec<u8>>,
}

impl DualTranslationPipeline {
    pub fn new(config: BidirectionalConfig) -> Self { ... }

    /// Xử lý audio chunk từ system
    pub async fn process_system_audio(&self, chunk: Vec<u8>) {
        // Đọc config Stream A
        // Gửi đến Soniox/MLX theo stream_a.target_language
        // Phát TTS nếu stream_a.tts_enabled
    }

    /// Xử lý audio chunk từ microphone
    pub async fn process_mic_audio(&self, chunk: Vec<u8>) {
        // Đọc config Stream B
        // Gửi đến Soniox/MLX theo stream_b.target_language
        // Phát TTS và ghi vào virtual device nếu stream_b.output_device được set
    }
}

#[tauri::command]
pub async fn configure_bidirectional(
    config: BidirectionalConfig,
    state: State<'_, DualTranslationPipeline>,
) -> Result<(), String> {
    // Cập nhật config, không cần restart capture
}
```

### B. Frontend (JavaScript) - src/js/

#### 1. UI thay đổi

**File: `src/index.html` (THAY ĐỔI)**

- Thêm tab "Dual Mode" cạnh tab hiện tại
- Dual Mode hiển thị 2 panels song song:
  - **Left panel**: Meeting audio (System) → Dịch sang Language B
  - **Right panel**: User input (Microphone) → Dịch sang Language B → Inject to meeting

```html
<div id="view-dualpanel" class="view hidden">
  <div class="dual-header">
    <button id="btn-dual-config">⚙️ Config</button>
    <button id="btn-view-mono">Single</button>
  </div>

  <div class="dual-container">
    <!-- Stream A: Meeting Audio -->
    <div class="stream-panel stream-a">
      <div class="stream-label">Meeting Audio</div>
      <div class="stream-settings">
        <select id="lang-a-source">
          <option value="en">English (Source)</option>
          <option value="vi">Vietnamese</option>
          <!-- ... -->
        </select>
        <select id="lang-a-target">
          <option value="vi">Vietnamese (Target)</option>
          <option value="en">English</option>
        </select>
                <label>
                    <input type="checkbox" id="stream-a-tts"> Enable TTS
                </label>
      </div>
      <div class="stream-content" id="transcript-a"></div>
    </div>

    <!-- Stream B: User Input -->
    <div class="stream-panel stream-b">
      <div class="stream-label">Your Input</div>
      <div class="stream-settings">
        <select id="lang-b-source">
          <option value="en">English (Source)</option>
          <option value="vi">Vietnamese</option>
        </select>
        <select id="lang-b-target">
          <option value="vi">Vietnamese (Target)</option>
          <option value="en">English</option>
        </select>
        <select id="output-device">
          <option value="default">Default Output</option>
          <option value="blackhole">BlackHole Virtual</option>
          <option value="soundflower">Soundflower Virtual</option>
        </select>
        <label>
          <input type="checkbox" id="inject-audio"> Inject to Meeting
        </label>
      </div>
      <div class="stream-content" id="transcript-b"></div>
    </div>
  </div>
</div>
```

#### 2. App controller mở rộng

**File: `src/js/app.js` (THAY ĐỔI)**

```javascript
class App {
    constructor() {
        this.isRunning = false;
        this.currentMode = 'single'; // 'single' | 'dual'
        this.currentSource = 'system';

        // Dual mode state
        this.dualConfig = {
            stream_a: {
                id: 'stream_a',
                name: 'Meeting Audio',
                audio_source: 'system',
                source_language: 'en',
                target_language: 'vi',
                tts_enabled: false, // default off, user can enable
            },
            stream_b: {
                id: 'stream_b',
                name: 'User Input',
                audio_source: 'microphone',
                source_language: 'en',
                target_language: 'vi',
                tts_enabled: true,
                output_device: 'blackhole', // Virtual device
            },
            dual_mode_enabled: false,
        };

        this.transcriptUIStreamA = null;
        this.transcriptUIStreamB = null;
        this.audioStreamA = null;
        this.audioStreamB = null;
    }

    async start() {
        if (this.currentMode === 'dual') {
            await this._startDualCapture();
        } else {
            await this._startSingleCapture();
        }
    }

    async _startDualCapture() {
        try {
            const { invoke } = window.__TAURI__.core;

            // Tạo 2 channels riêng cho 2 streams
            const channelSystemAudio = new window.__TAURI__.core.Channel();
            const channelMicAudio = new window.__TAURI__.core.Channel();

            // Bắt đầu dual capture
            await invoke('start_dual_capture', {
                channel_system: channelSystemAudio,
                channel_mic: channelMicAudio,
            });

            // Lắng nghe audio từ system (meeting)
            channelSystemAudio.onmessage = async (audioChunk) => {
                await this._processStreamAudio(audioChunk);
            };

            // Lắng nghe audio từ microphone (user)
            channelMicAudio.onmessage = async (audioChunk) => {
                await this._processStreamBudio(audioChunk);
            };

            this.isRunning = true;
            this._updateStatus('running');
        } catch (err) {
            console.error('[Dual Capture]', err);
            this._showToast(`Dual capture failed: ${err}`, 'error');
        }
    }

    async _processStreamAudio(audioChunk) {
        // Gửi meeting audio đến translator
        const result = await this._translateAudio(
            audioChunk,
            this.dualConfig.stream_a
        );

        // Hiển thị transcript
        this.transcriptUIStreamA.addSegment({
            original: result.transcription_a,
            translated: result.translation_a,
            speaker: 'Other',
        });

        // Optional: phát TTS nếu stream_a.tts_enabled
        if (this.dualConfig.stream_a.tts_enabled) {
            await this._playTTS(result.translation_a, 'stream_a');
        }
    }

    async _processStreamBudio(audioChunk) {
        // Gửi user microphone audio đến translator
        const result = await this._translateAudio(
            audioChunk,
            this.dualConfig.stream_b
        );

        // Hiển thị transcript
        this.transcriptUIStreamB.addSegment({
            original: result.transcription_b,
            translated: result.translation_b,
            speaker: 'You',
        });

        // Phát TTS nếu enable
        if (this.dualConfig.stream_b.tts_enabled) {
            const ttsAudio = await this._getTTSAudio(
                result.translation_b,
                this.dualConfig.stream_b.target_language
            );

            // Inject vào virtual device nếu enable
            if (this.dualConfig.stream_b.output_device !== 'none') {
                await invoke('inject_audio_to_device', {
                    device: this.dualConfig.stream_b.output_device,
                    audio_data: ttsAudio,
                });
            }
        }
    }

    async _translateAudio(audioChunk, streamConfig) {
        // Gửi đến Soniox/Local pipeline
        // Trả về: { transcription, translation }
        const { invoke } = window.__TAURI__.core;

        return await invoke('translate_audio_chunk', {
            audio_data: audioChunk,
            source_language: streamConfig.source_language,
            target_language: streamConfig.target_language,
            translation_mode: this.translationMode,
        });
    }
}
```

#### 3. Dual Transcript UI

**File: `src/js/dual-transcript-ui.js` (TẠO MỚI)**

```javascript
export class DualTranscriptUI {
    constructor(containerA, containerB) {
        this.containerA = containerA;
        this.containerB = containerB;
        this.segmentsA = [];
        this.segmentsB = [];
    }

    addSegmentA(segment) {
        this.segmentsA.push(segment);
        this._renderStreamA();
    }

    addSegmentB(segment) {
        this.segmentsB.push(segment);
        this._renderStreamB();
    }

    _renderStreamA() {
        // Render meeting audio transcript
        // Format: "[Other] Original → Dịch"
    }

    _renderStreamB() {
        // Render user input transcript
        // Format: "[You] Original → Dịch [TTS ✓] [Inject ✓]"
    }

    clear() {
        this.segmentsA = [];
        this.segmentsB = [];
    }
}
```

### C. Settings mở rộng

**File: `src-tauri/src/settings.rs` (THAY ĐỔI)**

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    // ... hiện tại settings ...

    // Bidirectional mode
    pub dual_mode_enabled: bool,
    pub stream_a_language_source: String,
    pub stream_a_language_target: String,
    pub stream_b_language_source: String,
    pub stream_b_language_target: String,
    pub stream_b_tts_enabled: bool,
    pub stream_b_output_device: Option<String>, // Virtual device
}
```

## 3. Các bước triển khai chi tiết

### Phase 1: Setup Virtual Audio Device (1-2 ngày)

**Mục tiêu:** User có thể chọn virtual audio device để inject translated audio

1. ✅ Cài đặt yêu cầu:
   - macOS: Cài BlackHole 2.0 hoặc Soundflower (hướng user)
   - Windows: VB-Audio Virtual Cable
   - Linux: PulseAudio loopback

2. ✅ Triển khai:
   - Tạo `audio/virtual_device.rs`
   - Implement `list_devices()` dùng Core Audio APIs
   - Command Tauri: `list_virtual_devices()`
   - Command Tauri: `test_virtual_device(device_id)` (phát test audio)

3. ✅ Testing:
   - Kiểm tra danh sách devices
   - Kiểm tra ghi audio vào device

### Phase 2: Dual Audio Capture (2-3 ngày)

**Mục tiêu:** Capture cả system audio và microphone cùng lúc

1. ✅ Refactor audio capture:
   - Tạo cấu trúc `DualAudioCapture`
   - Spawn 2 tokio tasks (1 cho system, 1 cho mic)
   - Mỗi task gửi dữ liệu qua channel riêng

2. ✅ Tauri commands:
   - `start_dual_capture(channel_system, channel_mic)` → Result<(), String>
   - `stop_dual_capture()` → Result<(), String>

3. ✅ Testing:
   - Phát âm thanh hệ thống, kiểm tra dữ liệu nhận được
   - Nói vào microphone, kiểm tra dữ liệu nhận được
   - Đảm bảo 2 streams độc lập

### Phase 3: Dual Translation Pipeline (2-3 ngày)

**Mục tiêu:** Xử lý 2 audio streams với những cấu hình khác nhau

1. ✅ Backend logic:
   - Tạo `DualTranslationPipeline` struct
   - Implement `process_system_audio()`
   - Implement `process_mic_audio()`
   - Hỗ trợ dynamic config updates

2. ✅ Soniox/Local integration:
   - Cải tiến `sonioxClient.js` để hỗ trợ 2 sessions (hoặc reuse 1 session)
   - Cải tiến `local_pipeline.rs` để xử lý 2 parallel requests

3. ✅ TTS & Output injection:
   - Tauri command: `inject_audio_to_device(device, audio_data)`
   - Hỗ trợ 3 TTS providers cho stream B

4. ✅ Testing:
   - Dịch meeting audio (stream A) sang tiếng Việt
   - Dịch user input (stream B) sang tiếng Việt
   - Phát TTS của stream B vào virtual device

### Phase 4: UI & Settings (2 ngày)

**Mục tiêu:** Cho phép user chọn dual mode và cấu hình từng stream

1. ✅ Frontend changes:
   - Thêm tab "Dual Mode"
    - Thêm controls cho stream A: source lang, target lang, TTS toggle (optional)
   - Thêm controls cho stream B: source lang, target lang, TTS toggle, device select, inject toggle

2. ✅ Settings persistence:
   - Lưu dual mode config vào `settings.json`
   - Load config khi khởi động app

3. ✅ UI/UX:
   - Dual panel layout (2 side-by-side transcript)
   - Visual indicators cho status (capturing, translating, injecting)
   - Color coding: Red cho Meeting audio, Blue cho User input

### Phase 5: Testing & Refinement (2-3 ngày)

**Mục tiêu:** Đảm bảo mọi thứ hoạt động stable trên macOS

1. ✅ Edge cases:
   - Xử lý khi user chọn microphone là cả 2 stream (error handling)
   - Xử lý thay đổi virtual device khi running
   - Xử lý Soniox connection loss đột ngột

2. ✅ Performance:
   - Monitor memory usage (2 pipelines chạy)
   - Monitor CPU usage
   - Optimize audio data passing

3. ✅ Known issues documentation:
   - Virtual device setup (dùng [Loopback Audio](https://mac.averagemanuals.com/apps/loopback-audio.html) hoặc BlackHole)
   - Permissions (Screen Recording, Microphone)
   - Audio device conflicts

## 4. Technical Challenges & Solutions

### Challenge 1: Audio Injection vào Meeting App

**Problem:** Khó inject audio vào Zoom, Teams, Meet app

**Solutions (sắp xếp theo độ khó):**

#### Solution A: Virtual Audio Device (⭐ Recommended)
- User cài BlackHole hoặc Soundflower (free)
- App ghi TTS audio vào virtual device
- User set virtual device làm input mic trong Zoom/Teams/Meet
- ✅ Pros: Đơn giản, hoạt động trên mọi meeting app
- ❌ Cons: Phức tạp setup ban đầu

#### Solution B: App-Specific APIs
- Zoom: [Zoom SDK](https://github.com/zoom/zoom-sdk-macos)
- Teams: [Teams API](https://learn.microsoft.com/en-us/graph/api/resources/chat?view=graph-rest-1.0)
- Meet: No official API
- ✅ Pros: Không cần virtual device
- ❌ Cons: Khác nhau với từng app, maintenance overhead

#### Solution C: Screen Recording + Audio Injection
- Intercept meeting app audio output
- Không khả thi trên macOS (security)

**→ Chọn Solution A: Virtual Audio Device**

### Challenge 2: Soniox Session Management

**Problem:** 2 streams → 2 Soniox sessions, mỗi session có overhead

**Solutions:**

#### A. Mỗi stream 1 session riêng
```
Stream A: Session 1 (Meeting audio)
Stream B: Session 2 (Microphone)
```
- Pros: Độc lập hoàn toàn
- Cons: 2x cost, latency

#### B. Chia sẻ 1 session
```
Stream A + B → 1 Session (interleaved)
```
- Pros: Tiết kiệm cost
- Cons: Transcript có thể bị lẫn lộn

#### C. Tối ưu hóa: Update "context" nhưng keep session
```
Session Start
├─ Stream A audio + update context (speaker="Meeting")
├─ Stream B audio + update context (speaker="User")
└─ Soniox tách biệt transcription
```
- Pros: 1 session, context clear
- Cons: Cần Soniox support update_context

**→ Recommend:** Solution A (mỗi stream 1 session) để đơn giản

### Challenge 3: Audio Format Consistency

**Problem:** System audio, mic audio, TTS output có format khác nhau

**Solution:**

```rust
// Unified format after capture: s16le, 16kHz, mono
pub struct AudioNormalizer {
    pub fn normalize_system_audio(raw: Vec<u8>) -> Vec<u8> { ... }
    pub fn normalize_mic_audio(raw: Vec<u8>) -> Vec<u8> { ... }
    pub fn normalize_tts_output(raw: Vec<u8>) -> Vec<u8> { ... }
}
```

## 5. Step-by-step Implementation Checklist

### Prerequisites
- [ ] User cài BlackHole 2.0 trên macOS (hướng dẫn setup)
- [ ] Rust toolchain up-to-date
- [ ] Soniox API key valid

### Backend Changes
- [ ] Create `src-tauri/src/models.rs` with `TranslationStream`, `BidirectionalConfig`
- [ ] Create `src-tauri/src/audio/virtual_device.rs`
- [ ] Update `src-tauri/src/commands/audio.rs` with dual capture
- [ ] Create `src-tauri/src/commands/dual_pipeline.rs`
- [ ] Add Tauri commands: `start_dual_capture`, `stop_dual_capture`, `inject_audio_to_device`
- [ ] Update `settings.rs` with bidirectional config
- [ ] Test dual audio capture on macOS

### Frontend Changes
- [ ] Add dual mode tab to `index.html`
- [ ] Create `src/js/dual-transcript-ui.js`
- [ ] Update `src/js/app.js` with dual mode logic
- [ ] Update `src/js/settings.js` for bidirectional config UI
- [ ] Implement virtual device selector in settings

### Testing
- [ ] Test system audio capture (meeting app voice)
- [ ] Test microphone capture (user voice)
- [ ] Test translation of both streams
- [ ] Test TTS injection to virtual device
- [ ] Test UI rendering of dual transcripts
- [ ] End-to-end test: Zoom meeting → real-time translation → injection

## 6. Example: Tích hợp Zoom Meeting

### Setup
1. User cài BlackHole trên macOS
2. Mở meet-translator, bật Dual Mode
3. Stream A: System audio → English → Vietnamese (display + optional TTS)
4. Stream B: Microphone → English → Vietnamese (TTS + inject)
5. Mở Zoom meeting
6. Set Zoom input mic → BlackHole (virtual device)

### Experience
- User nói tiếng Anh vào mic: "Which language do you prefer?"
- meet-translator dịch: "Bạn thích ngôn ngữ nào?"
- TTS phát tiếng Việt vào Zoom → Người nghe thấy bằng tiếng Việt 🎉
- Meeting audio phát tiếng Anh: "Let me explain the details"
- meet-translator dịch: "Hãy để tôi giải thích chi tiết"
- User thấy translation trong app và có thể bật TTS cho Stream A (không injection)

## 7. Known Limitations & Future Work

### v0.5 Limitations
- ❌ Windows loopback audio capture (complex, future)
- ❌ Linux virtual device support (PulseAudio, future)
- ❌ Dynamic language switching without restart (future)
- ❌ Speaker diarization cho 2 streams (complex)
- ❌ Recording export cho dual streams (future)

### Future Enhancements
- Recording mode: Lưu cả 2 streams + translations vào file
- Voice profiles: Separate speakers trong 1 stream (AI-based)
- Custom pronunciation: Allow user define custom words
- Translation memory: Reuse previous translations
- Meeting transcription API: Direct integration (Zoom, Teams, Meet)

## 8. References

- [BlackHole Audio](https://github.com/ExistentialAudio/BlackHole)
- [macOS Core Audio](https://developer.apple.com/documentation/coreaudio)
- [Tauri IPC Channels](https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html)
- [Soniox WebSocket API](https://docs.soniox.com/)
- [Tauri Commands](https://docs.rs/tauri/latest/tauri/attr.command.html)
