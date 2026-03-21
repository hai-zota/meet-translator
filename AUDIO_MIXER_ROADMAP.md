# Smart Audio Mixer & Ducking — Lộ trình Triển khai Chi tiết

**Mục tiêu:** Xây dựng Virtual Mixer để hòa trộn Giọng Gốc (Original) + Giọng Dịch (Translated) với Dynamic Ducking.
**Timeline:** 2 tuần (MVP basic ducking)
**Phương pháp:** Phased development — làm → test → integrate → validate

---

## 📊 Kiến trúc Tổng quan

```
┌─────────────────────────────────────────────────────────────┐
│                    CURRENT AUDIO FLOW                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Mic Input ──┐                                              │
│              ├─→ [Capture] ──→ [Soniox STT] ──→ Transcript  │
│  Sys Audio ──┘                                              │
│                                                              │
│  Translated Text ──→ [TTS Provider] ──→ [AudioPlayer] ──→ ▶ │
│                    (ElevenLabs/Edge/Google)                 │
│                                                              │
│  Both mix at speaker level (NO ACTIVE MIXING)               │
│                                                              │
└─────────────────────────────────────────────────────────────┘


┌──────────────────────────────────────────────────────────────┐
│              PROPOSED ARCHITECTURE (WITH MIXER)              │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Mic + Sys Audio ──┐                                         │
│                    ├─→ [Capture] ──→ [Audio Analyzer] ──┐   │
│                    │                   ├─→ LUFS         │   │
│                    │                   └─→ VAD          │   │
│                    │                                    │   │
│  Translated Text ──→ [TTS Provider] ──┐                │   │
│                       ├─→ [AudioPlayer]│                │   │
│                       │                 ↓               │   │
│                       │              [SmartMixer]       │   │
│                       │              - Input A (Orig)   │   │
│                       │              - Input B (Trans)  │   │
│                       │              - Ducking Engine   │   │
│                       │              - Gain Controller  │   │
│                       │                   ↓             │   │
│                       └─────────────→ ▶ [Blackhole]     │   │
│                                                         │   │
└─────────────────────────────────────────────────────────────┘

CRITICAL DECISION:
  - SmartMixer location: RUST BACKEND (latency-critical)
  - Audio Analyzer: RUST BACKEND + IPC signals to Frontend
  - Settings UI: FRONTEND (src/index.html + app.js)
```

---

## 🎯 Phase-by-Phase Breakdown

### **PHASE 1: Setup & Dependencies (Day 1-2)**

**Objective:** Chuẩn bị project structure, thêm Rust dependencies.

**Tasks:**
1. Update `Cargo.toml` với deps:
   - `ebur128` — LUFS loudness measurement
   - `ort` (onnxruntime-rs) — Silero VAD
   - `ringbuf` — Threadsafe circular buffer for audio

2. Create Rust modules:
   ```
   src-tauri/src/
   ├── audio/
   │   ├── mod.rs (existing)
   │   ├── mixer/ (NEW)
   │   │   ├── mod.rs
   │   │   ├── loudness_analyzer.rs (LUFS measurement)
   │   │   ├── vad_processor.rs (Voice Activity Detection)
   │   │   ├── ducking_engine.rs (Dynamic ducking logic)
   │   │   └── smart_mixer.rs (Main orchestrator)
   │   └── ... (existing: microphone.rs, system_audio.rs)
   ```

3. Initialize settings schema for mixer config:
   ```rust
   // In settings.rs, add:
   pub struct MixerSettings {
       pub enabled: bool,
       pub ducking_level: f32,        // 0.0 - 0.5 (default 0.2 = 20%)
       pub vad_sensitivity: String,   // "low" | "medium" | "high"
       pub detection_threshold: f32,  // -40 LUFS default
   }
   ```

**Test Plan:**
- ✅ `cargo build` succeeds (no compile errors)
- ✅ `cargo check` passes lint
- ✅ Verify Cargo.lock updated with new deps

**Deliverables:**
- `Cargo.toml` updated
- `src-tauri/src/audio/mixer/` scaffold created
- `src-tauri/src/settings.rs` schema updated

---

### **PHASE 2: LUFS Analyzer Module (Day 2-3)**

**Objective:** Build loudness measurement pipeline using `ebur128` crate.

**Task Breakdown:**

#### 2A: Create `loudness_analyzer.rs`
```rust
// Key struct:
pub struct LoufsAnalyzer {
    analyzer: ebur128::EBU_R128,
    window_ms: u32,  // 100-300ms
    sample_rate: u32,
}

impl LoufsAnalyzer {
    pub fn new(sample_rate: u32, window_ms: u32) -> Self { ... }
    pub fn push_samples(&mut self, pcm_s16: &[i16]) -> Option<f32> {
        // Returns LUFS if window complete, else None
    }
}
```

#### 2B: Unit tests for LUFS measurement
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_silence_lufs() {
        // Silence should be near -inf or very negative
    }

    #[test]
    fn test_full_scale_lufs() {
        // Full scale sine wave should be ~-3 LUFS
    }

    #[test]
    fn test_realistic_speech_lufs() {
        // Generate 1kHz tone @ 50% amplitude, should be around -20 LUFS
    }
}
```

**Test Plan (Integration):**
- Create test audio file (48kHz stereo sine wave)
- Feed through analyzer in 100ms chunks
- Verify LUFS measurement converges to expected value
- Benchmark: analyzer should process 1s audio in <5ms

**Deliverables:**
- `src-tauri/src/audio/mixer/loudness_analyzer.rs` (complete)
- Unit tests passing

---

### **PHASE 3: VAD (Voice Activity Detection) Integration (Day 3-4)**

**Objective:** Integrate Silero VAD to detect speech vs. silence/noise.

**Tasks:**

#### 3A: Download Silero VAD ONNX model
```bash
cd src-tauri/assets/
wget https://github.com/snakers4/silero-vad/releases/download/v5.0/silero_vad.onnx
```

#### 3B: Create `vad_processor.rs`
```rust
pub struct VadProcessor {
    session: Session,  // onnxruntime session
    sensitivity: f32,  // 0.0 (conservative) to 1.0 (aggressive)
}

impl VadProcessor {
    pub fn new(model_path: &str, sensitivity: &str) -> Result<Self> {
        // Load .onnx model
        // sensitivity: "low" (0.7), "medium" (0.5), "high" (0.3)
    }

    pub fn process_frame(&mut self, pcm_f32: &[f32]) -> bool {
        // Returns: is_speech (true/false)
    }
}
```

#### 3C: Integration tests with mock audio
```rust
#[test]
fn test_vad_detects_speech() {
    // Generate 1kHz tone (simulating speech), expect True
}

#[test]
fn test_vad_ignores_silence() {
    // Generate silence, expect False
}

#[test]
fn test_vad_ignores_keyboard() {
    // Generate bursts (simulating keyboard), expect False with "high" sensitivity
}
```

**Test Plan:**
- ✅ ONNX model loads without error
- ✅ VAD processes 512-sample frames in <1ms
- ✅ Integration: feed 5s audio clip (speech + silence) → check detection accuracy
- ✅ Benchmark: 1000 frames processed in <1 second

**Deliverables:**
- `src-tauri/assets/silero_vad.onnx` (downloaded)
- `src-tauri/src/audio/mixer/vad_processor.rs` (complete)
- Integration tests passing

---

### **PHASE 4: Ducking Engine Core Logic (Day 4-5)**

**Objective:** Implement state machine for Dynamic Ducking (Attack/Hold/Release).

**Architecture:**
```rust
pub struct DuckingEngine {
    state: DuckingState,  // Waiting | Ducking | Releasing

    // Parameters
    attack_time_ms: u32,      // 200ms default
    hold_time_ms: u32,        // while translated is active
    release_time_ms: u32,     // 500ms default
    ducking_level: f32,       // target gain: 0.2 (20%)
    detection_threshold: f32, // -40 LUFS

    // Runtime state
    current_gain: f32,        // 0.0 - 1.0 interpolated
    transition_start_ms: u64,
    last_signal_time_ms: u64,
}

enum DuckingState {
    Waiting,    // Original @ 100%
    Ducking,    // Attacking/Holding @ 20%
    Releasing,  // Fading back to 100%
}

impl DuckingEngine {
    pub fn process(&mut self,
        original_loudness: f32,  // LUFS from analyzer
        translated_active: bool, // from VAD
        dt_ms: u32,
    ) -> f32 {
        // Returns final gain for original stream
    }
}
```

**State Transitions:**
```
Waiting ─(translated LUFS > -40)──→ Ducking(Attack)
  ↑                                      ↓
  └──(release_time > 500ms)── Releasing(Fade in)

Attack:  original_gain: 100% → 20% over 200ms
Hold:    original_gain: stay 20% while translated active
Release: original_gain: 20% → 100% over 500ms
```

**Task Breakdown:**

#### 4A: Implement state machine (`ducking_engine.rs`)
```rust
impl DuckingEngine {
    pub fn process(&mut self, original_lufs: f32, translated_active: bool, dt_ms: u32) -> f32 {
        // 1. Check if translated has > -40 LUFS signal
        if translated_active && original_lufs > self.detection_threshold {
            self._enter_ducking_state();
        }

        // 2. Update timing
        self.last_signal_time_ms += dt_ms as u64;

        // 3. Apply gain interpolation based on state
        match self.state {
            DuckingState::Waiting => {
                self.current_gain = 1.0; // 100%
            }
            DuckingState::Ducking => {
                let elapsed = (current_time - self.transition_start_ms) as f32;
                if elapsed < self.attack_time_ms as f32 {
                    // Attack phase: interpolate 1.0 → ducking_level
                    self.current_gain = self._interpolate_exponential(
                        1.0,
                        self.ducking_level,
                        elapsed / self.attack_time_ms as f32
                    );
                } else {
                    // Hold phase
                    self.current_gain = self.ducking_level;
                }
            }
            DuckingState::Releasing => {
                // Similar: interpolate ducking_level → 1.0 over release_time
            }
        }

        self.current_gain
    }

    fn _interpolate_exponential(&self, from: f32, to: f32, t: f32) -> f32 {
        // t ∈ [0, 1]
        // Exponential easing for smoother fade
        let eased_t = t * t; // t^2 easing
        from + (to - from) * eased_t
    }
}
```

#### 4B: Unit tests for state transitions
```rust
#[test]
fn test_waiting_to_ducking() {
    let mut engine = DuckingEngine::new();

    // Initially waiting
    assert_eq!(engine.state, DuckingState::Waiting);
    assert_eq!(engine.process(-60.0, false, 16), 1.0); // no signal

    // Translated becomes active
    let gain1 = engine.process(-30.0, true, 16);  // signal > -40
    assert!(gain1 < 1.0); // started attacking

    // After 200ms, should reach ducking level
    for _ in 0..13 { engine.process(-30.0, true, 16); }
    let gain_final = engine.process(-30.0, true, 16);
    assert!(gain_final <= 0.21); // ~20%
}

#[test]
fn test_ducking_to_release() {
    // Simulate: ducked for 500ms, then translated stops
    // Should release over 500ms
}

#[test]
fn test_hold_phase() {
    // While translated_active=true, gain should stay constant
}
```

**Test Plan (Integration):**
- Create mock data:
  - Original loudness: -20 LUFS (constant)
  - Translated loudness: -60 → -30 → -60 (pulse)
- Feed through engine in 16ms steps
- Verify gain envelope:
  - T=0-200ms: smooth attack from 1.0 → 0.2
  - T=200-700ms: hold @ 0.2 (while translated > -40)
  - T=700-1200ms: smooth release from 0.2 → 1.0

**Deliverables:**
- `src-tauri/src/audio/mixer/ducking_engine.rs` (complete)
- Unit + integration tests passing
- Benchmark: 1000 process calls in <10ms

---

### **PHASE 5: SmartMixer Orchestrator & IPC Bridge (Day 5-6)**

**Objective:** Integrate all components (LUFS + VAD + Ducking) into unified mixer module.

**Architecture:**
```rust
pub struct SmartMixer {
    original_analyzer: LoufsAnalyzer,
    translated_analyzer: LoufsAnalyzer,
    vad: VadProcessor,
    ducking: DuckingEngine,
    settings: Arc<Mutex<MixerSettings>>,

    // Ring buffers for thread-safe audio queuing
    original_buffer: RingBuf,   // from Mic/Sys capture
    translated_buffer: RingBuf, // from TTS playback
}

impl SmartMixer {
    pub fn process_chunk(
        &mut self,
        original_pcm: &[i16],
        translated_pcm: &[i16],
    ) -> (Vec<i16>, MixerStats) {
        // 1. Analyze loudness
        let orig_lufs = self.original_analyzer.push_samples(original_pcm)?;
        let trans_lufs = self.translated_analyzer.push_samples(translated_pcm)?;

        // 2. Detect voice
        let orig_is_speech = self.vad.process_frame(&to_f32(original_pcm));

        // 3. Calculate ducking gain
        let ducking_gain = self.ducking.process(
            orig_lufs.unwrap_or(-100.0),
            trans_lufs.unwrap_or(-100.0) > -40.0,
            16, // dt_ms for 16kHz
        );

        // 4. Apply gain to original stream
        let attenuated = self._apply_gain(original_pcm, ducking_gain);

        // 5. Mix: A * ducking_gain + B * 1.0
        let mixed = self._mix_streams(&attenuated, translated_pcm);

        // 6. Return with stats for frontend
        (mixed, MixerStats {
            original_lufs,
            translated_lufs,
            ducking_gain,
            is_speech: orig_is_speech,
        })
    }
}
```

**IPC Commands (New Tauri invocations):**
```rust
#[tauri::command]
pub fn mixer_update_settings(
    ducking_level: f32,
    vad_sensitivity: String,
    enabled: bool,
) -> Result<(), String> {
    // Update mixer settings in place
}

#[tauri::command]
pub fn mixer_get_stats() -> Result<MixerStats, String> {
    // Frontend polls for real-time LUFS/gain data
}
```

**Tasks:**

#### 5A: Implement `smart_mixer.rs`
- Orchestrate LUFS + VAD + Ducking
- Audio mixing logic (sum streams)
- Error handling + fallbacks

#### 5B: Register IPC commands in `commands/mod.rs`
```rust
// In mod.rs:
pub mod mixer;  // new

// In main.rs state setup:
let mixer = SmartMixer::new(...);
// Add to app state
```

#### 5C: Integration test (E2E mock audio)
```rust
#[test]
fn test_smart_mixer_e2e() {
    let mut mixer = SmartMixer::new(...);

    // Generate 2s test audio:
    // 0-500ms: Original speech only
    // 500-1500ms: Both original + translated
    // 1500-2000ms: Original speech only

    for frame in test_frames {
        let (mixed, stats) = mixer.process_chunk(&orig, &trans)?;

        // Verify mixing:
        // - RMS of mixed ≈ sqrt(orig^2 + trans^2) when no ducking
        // - RMS of mixed decreased during ducking phase
    }
}
```

**Test Plan:**
- ✅ Mixer initializes without panic
- ✅ LUFS stats exported correctly to IPC
- ✅ Ducking gain applied: 0.2 ≤ gain ≤ 1.0
- ✅ Mixed audio RMS within expected bounds
- ✅ Latency: fullprocess_chunk() < 5ms

**Deliverables:**
- `src-tauri/src/audio/mixer/mod.rs` (module exports)
- `src-tauri/src/audio/mixer/smart_mixer.rs` (complete)
- IPC bridge in `commands/mixer.rs`
- E2E integration tests passing

---

### **PHASE 6: Frontend Integration & Settings UI (Day 6-7)**

**Objective:** Add mixer control UI to Settings + quick preset buttons to footer.

**Tasks:**

#### 6A: Update HTML Settings panel (`src/index.html`)
Add new "Sound Engine" section:
```html
<div id="mixer-settings" class="settings-panel">
    <h3>Sound Engine (Smart Mixer)</h3>

    <!-- Toggle -->
    <label>
        <input type="checkbox" id="mixer-enabled" checked>
        Enable Smart Ducking
    </label>

    <!-- Ducking Level Slider (0% - 50%) -->
    <label>
        Ducking Level: <span id="ducking-level-display">20%</span>
        <input type="range" id="ducking-level" min="0" max="50" value="20">
    </label>

    <!-- VAD Sensitivity -->
    <label>
        Detection Sensitivity:
        <select id="vad-sensitivity">
            <option value="low">Low (Conservative)</option>
            <option value="medium" selected>Medium (Balanced)</option>
            <option value="high">High (Aggressive)</option>
        </select>
    </label>

    <!-- Live Stats Display -->
    <div id="mixer-stats" class="live-stats">
        <div>Original LUFS: <span id="stat-orig-lufs">--</span></div>
        <div>Translated LUFS: <span id="stat-trans-lufs">--</span></div>
        <div>Ducking Gain: <span id="stat-ducking-gain">100%</span></div>
    </div>
</div>
```

#### 6B: Add preset buttons to footer (`src/index.html`)
```html
<div id="mixer-presets" class="floating-controls mixer-presets">
    <button id="preset-natural" title="Natural Mode (80/20 mix)" class="preset-btn active">
        Natural Mode
    </button>
    <button id="preset-focus" title="Focus Mode (100% translated)" class="preset-btn">
        Focus Mode
    </button>
</div>
```

#### 6C: Update `src/js/app.js` to handle mixer settings
```javascript
async _loadMixerSettings() {
    const settings = settingsManager.get();
    document.getElementById('mixer-enabled').checked = settings.mixer.enabled ?? true;
    document.getElementById('ducking-level').value = (settings.mixer.ducking_level ?? 0.2) * 100;
    document.getElementById('vad-sensitivity').value = settings.mixer.vad_sensitivity ?? 'medium';
}

async _updateMixerSetting(key, value) {
    await invoke('mixer_update_settings', {
        ducking_level: parseFloat(document.getElementById('ducking-level').value) / 100,
        vad_sensitivity: document.getElementById('vad-sensitivity').value,
        enabled: document.getElementById('mixer-enabled').checked,
    });

    // Persist to settings
    settingsManager.setMixer({ ducking_level, vad_sensitivity });
}

async _pollMixerStats() {
    setInterval(async () => {
        if (!this.isRunning) return;
        try {
            const stats = await invoke('mixer_get_stats');
            document.getElementById('stat-orig-lufs').textContent = stats.original_lufs?.toFixed(1) ?? '--';
            document.getElementById('stat-trans-lufs').textContent = stats.translated_lufs?.toFixed(1) ?? '--';
            document.getElementById('stat-ducking-gain').textContent = (stats.ducking_gain * 100).toFixed(0) + '%';
        } catch (e) {
            console.warn('[Mixer] Stats poll failed:', e);
        }
    }, 200); // Poll every 200ms
}

_bindMixerPresets() {
    document.getElementById('preset-natural')?.addEventListener('click', () => {
        this._applyMixerPreset('natural'); // ducking_level=0.2, vad='medium'
    });
    document.getElementById('preset-focus')?.addEventListener('click', () => {
        this._applyMixerPreset('focus'); // ducking_level=0.0 (no ducking)
    });
}
```

#### 6D: Integration with existing `start()/stop()`
```javascript
async start() {
    // ... existing code ...

    // NEW: Initialize mixer after Soniox + TTS connected
    await invoke('mixer_start', {
        ducking_enabled: settingsManager.get().mixer.enabled,
        ducking_level: settingsManager.get().mixer.ducking_level,
        vad_sensitivity: settingsManager.get().mixer.vad_sensitivity,
    });

    this._pollMixerStats(); // Start polling stats
}

async stop() {
    // ... existing code ...

    // NEW: Stop mixer
    await invoke('mixer_stop');
}
```

**Test Plan (Manual):**
- ✅ Start app in "System Audio" mode
- ✅ See mixer settings panel in Settings
- ✅ Toggle "Enable Smart Ducking" → mixer starts/stops
- ✅ Move "Ducking Level" slider → see changes in stats display
- ✅ Change VAD sensitivity → test voice detection accuracy
- ✅ Click "Natural Mode" preset → ducking_level changes to 20%
- ✅ Click "Focus Mode" preset → ducking_level changes to 0%
- ✅ Stats update every ~200ms with live LUFS/gain values

**Deliverables:**
- `src/index.html` updated with mixer settings
- `src/js/app.js` updated with mixer integration
- Settings schema in localStorage includes `mixer.*` fields

---

### **PHASE 7: End-to-End Testing & Optimization (Day 7-14)**

**Objective:** Full integration test, performance benchmarking, edge case handling.

**Comprehensive Test Suite:**

#### 7A: Unit tests (Per module)
- ✅ `loudness_analyzer.rs`: LUFS accuracy
- ✅ `vad_processor.rs`: Speech detection F1-score > 0.95
- ✅ `ducking_engine.rs`: State transitions, gain curves
- ✅ `smart_mixer.rs`: Audio mixing RMS correctness

#### 7B: Integration tests (E2E)
```rust
#[test]
fn test_mixer_with_dual_streams() {
    // Real audio files:
    //   - english_male_speech.wav (16kHz, 5s)
    //   - vietnamese_female_speech.wav (16kHz, 5s)

    // Simulate:
    // T=0-2s: English only
    // T=2-4s: Both
    // T=4-5s: Vietnamese only

    // Verify:
    // - T=0-2s: mixed_rms ≈ english_rms
    // - T=2-4s: mixed_rms decreased (ducking active)
    // - T=4-5s: no signal from English stream
}

#[test]
fn test_mixer_latency() {
    // Feed 100 frames (6.4ms each @ 48kHz) through mixer
    // Measure total time, ensure < 5ms per frame
    // Latency budget: 20ms absolute max
}

#[test]
fn test_mixer_edge_cases() {
    // 1. Silence input → no crash, gain stays stable
    // 2. Clipping input → AGC limits, no overflow
    // 3. Network glitch → TTS provider drops → mixer degrades gracefully
    // 4. VAD false positive (keyboard noise) → no ducking applied
}
```

#### 7C: Functional tests (User scenarios)
**Test Case 1: Normal conversation**
- User on Zoom, speaking English
- Meeting participant speaks Vietnamese
- Ducking should activate, user hears Vietnamese clearly
- When participant stops, original audio returns smoothly

**Test Case 2: Fast alternation (cross-talk)**
- Both speakers overlap
- Expected: translated takes priority (higher gain)
- Ducking should respond quickly (<200ms)

**Test Case 3: Preset switching**
- Start in "Natural Mode" (20% ducking)
- User switches to "Focus Mode" (0% ducking)
- Both audio streams should be heard equally
- No audio glitch or pop

**Test Case 4: Settings persistence**
- Set mixer to: ducking_level=30%, vad_sensitivity="high"
- Close + reopen app
- Settings should restore identically

#### 7D: Performance benchmarking
```bash
# Run on actual macOS hardware
cargo build --release
cargo test --release -- --nocapture --test-threads=1

# Expected results:
# - loudness_analyzer: <1ms per 100ms chunk
# - vad_processor: <0.5ms per frame
# - ducking_engine: <0.1ms per process call
# - smart_mixer.process_chunk: <5ms total per 16ms audio chunk
```

#### 7E: Manual audio quality testing
- Record both original + mixed audio to file
- A/B test with real users:
  - Does ducking make translation intelligible? ✅
  - Are fades smooth (no clicking/popping)? ✅
  - Does "focus mode" work as expected? ✅

**Test Plan (Systematic):**
1. Run unit tests: `cargo test --lib`
2. Run integration tests: `cargo test --test mixer_e2e`
3. Manual functional tests (3-5 test cases)
4. Performance profiling: `cargo flamegraph` if bottleneck found
5. Real-user UAT (2-3 beta testers)

**Deliverables:**
- All tests passing
- Performance within spec (latency <5ms per frame)
- Comprehensive test report
- Bug fixes from integration phase

---

## 🚀 Implementation Timeline

| Phase | Task | Duration | Status |
|-------|------|----------|--------|
| 1 | Setup deps + project structure | Day 1-2 | ⏳ |
| 2 | LUFS Analyzer | Day 2-3 | ⏳ |
| 3 | VAD Integration | Day 3-4 | ⏳ |
| 4 | Ducking Engine | Day 4-5 | ⏳ |
| 5 | SmartMixer + IPC | Day 5-6 | ⏳ |
| 6 | Frontend UI + Settings | Day 6-7 | ⏳ |
| 7 | Testing + Optimization | Day 7-14 | ⏳ |

**Total: 2 weeks (14 days working time)**

---

## 🔍 Quality Gates (Stop Points)

Before moving to next phase, MUST pass:

1. **After Phase 1:** `cargo build` succeeds, no warnings
2. **After Phase 2:** LUFS tests passing, benchmark <5ms
3. **After Phase 3:** VAD loads model, processes frames <1ms
4. **After Phase 4:** State machine tests 100% passing
5. **After Phase 5:** IPC commands respond correctly, mixer processes audio
6. **After Phase 6:** Settings UI functional, preset buttons work
7. **After Phase 7:** All tests passing, UAT signed off

---

## 📋 Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| ONNX model download fails | Pre-bundle model in
`assets/`; fallback to simple rules-based VAD |
| Latency exceeds 20ms | Profile with `cargo flamegraph`; optimize hotpaths |
| Audio glitching on transitions | Use exponential easing; test extensively |
| Settings corruption | Version schema; migration path |
| Real-time sync issues | Use atomic flags + ringbuf for thread-safety |

---

## 📖 Next Step

**Ready to start Phase 1?** Answer:
1. Confirm Cargo.toml location (typically: `src-tauri/Cargo.toml`)
2. Confirm target macOS version (for ONNX runtime compatibility)
3. Should I begin with `cargo add` for new dependencies?
