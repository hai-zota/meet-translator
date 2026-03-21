# Bidirectional Translation: Design Decisions & Options

## Decision Matrix

### Option 1: Cloud-based Soniox (⭐ RECOMMENDED)

**Architecture:**
- Both streams send to Soniox cloud API
- Pros: Fast transcription, high accuracy, automatic speaker diarization
- Cons: Requires internet, cost = ~$0.12/hour

```
Stream A (System) ──→ Soniox Session 1 ──→ Transcription A ──→ Display (+ Optional TTS)
Stream B (Mic)    ──→ Soniox Session 2 ──→ Transcription B ──→ Display + TTS + Inject
```

**Checklist:**
- ✅ Implement: Start here, most straightforward
- ✅ Timeline: 5-7 days
- ✅ Cost: Acceptable for users who need quality
- ✅ Accuracy: 95%+

### Option 2: Local MLX (Python) + Cloud Soniox

**Architecture:**
- Stream A: Local MLX transcription (offline, free)
- Stream B: Soniox for user input (higher priority)
- Pros: Reduce Soniox cost 50%, Stream A offline capable
- Cons: Complex setup, MLX slower (10s vs 2s)

```
Stream A (System) ──→ Local MLX ──→ Transcription A ──→ Display (+ Optional TTS)
Stream B (Mic)    ──→ Soniox    ──→ Transcription B ──→ Display + TTS + Inject
```

**Checklist:**
- ⚠️ Implement: Advanced, after Option 1 working
- ⏱️ Timeline: +3-5 days additional
- 💰 Cost: 50% Soniox savings
- 🎯 Accuracy: 85-90% (MLX slightly lower)

### Option 3: Hybrid - Cloud STT + Local Translate

**Architecture:**
- Soniox for STT only (transcription)
- Local LibreTranslate / Ollama / LanguageTool for translation
- Pros: Minimal API cost, keep data local after transcription
- Cons: Translation quality varies, requires fine-tuning

```
Stream A ──→ Soniox (STT) ──→ Local Translate ──→ Transcription A ──→ Display (+ Optional TTS)
Stream B ──→ Soniox (STT) ──→ Local Translate ──→ Transcription B ──→ Display + TTS + Inject
```

**Checklist:**
- 🔴 Don't implement: Soniox already does STT+translation, redundant
- ⏱️ Timeline: Not recommended

### Option 4: On-device Whisper + Ollama (🔴 NOT RECOMMENDED)

**Architecture:**
- 100% local, no API required
- Pros: Privacy, zero cost, offline
- Cons: Very slow (~30s per 10s audio chunk), requires beefy machine

```
Stream A ──→ Whisper ──→ Ollama (Local LLM) ──→ Transcription A ──→ Display (+ Optional TTS)
Stream B ──→ Whisper ──→ Ollama (Local LLM) ──→ Transcription B ──→ Display + TTS + Inject
```

**Checklist:**
- 🔴 Verdict: Too slow for real-time meetings
- ⏱️ Not viable for v0.1

---

## Audio Injection Mechanism Comparison

### Mechanism A: Virtual Audio Device (⭐ RECOMMENDED)

**How it works:**
1. User installs BlackHole (macOS) or VB-Cable (Windows)
2. Set virtual device as Zoom/Teams input in app settings
3. App writes TTS audio to virtual device
4. Zoom/Teams hears the audio as a real microphone input

**Implementation:**
```
[TTS Audio in mp3/aac]
    ↓ (Decode)
[PCM s16le 16kHz]
    ↓ (Core Audio Write)
[BlackHole Virtual Device]
    ↓ (Zoom Input Selection)
[Meeting Participants] 🎉
```

**Pros:**
- ✅ Works with ANY meeting app (Zoom, Teams, Meet, Discord, etc)
- ✅ Audio quality pristine
- ✅ One-time setup, then automatic
- ✅ Reliable & tested by thousands

**Cons:**
- ❌ Requires user to install virtual device (~3 min setup)
- ❌ Need to manually select BlackHole in Zoom/Teams once

**Setup Guide for User:**

**macOS:**
```bash
# Install BlackHole
brew install blackhole-2ch

# Verify installation
system_profiler SPAudioDataType | grep BlackHole
```

**In Zoom/Teams/Meet:**
1. Settings → Audio → Microphone → Select "BlackHole 2ch"
2. Open My Translator app
3. Enable "Inject to Meeting" checkbox
4. Speak into microphone → Your translated voice comes through ✓

**Implementation Cost:** Low (use Core Audio API)

---

### Mechanism B: App-Specific Integration (❌ NOT RECOMMENDED)

Example: Zoom SDK, Teams API, Meet API

**Pros:**
- Direct API integration, no virtual device needed
- Potentially lower latency
- More control

**Cons:**
- ❌ Each app has different API (Zoom SDK, Teams SDK, etc)
- ❌ Requires extensive implementation per app
- ❌ APIs often have approval, rate limiting, deprecation
- ❌ Non-meeting apps (Discord, Slack, etc) unsupported

**Verdict:** Too much maintenance burden for little gain

---

### Mechanism C: Audio Interceptor (🔴 NOPE)

On macOS, can't intercept audio at system level for security reasons. Not possible.

---

## Language Pair Strategy

### Single Language Pair (Simplest)

```
System Audio: English → Vietnamese
User Mic:     English → Vietnamese
```

**Implementation:** 5 days
**Complexity:** Low
**UX:** User picks once in settings

### Multiple Language Pairs (Better UX)

```
System Audio: English → Vietnamese
User Mic:     English → Vietnamese

(But user can change anytime without restart)
```

**Implementation:** 6 days (+1 day for async settings update)
**Complexity:** Medium
**UX:** Dynamic language selection, update on-the-fly

### Arbitrary Language Pairs (Power User)

```
System Audio: English → French
User Mic:     Chinese → Spanish
```

**Implementation:** 7 days (+1 day for independent config)
**Complexity:** Medium-High
**UX:** Full flexibility, potentially confusing

**Recommendation:** Go with Option 2 (Multiple Language Pairs)

---

## Session Management Strategy

### Strategy A: One Soniox Session (Tight Integration)

```
Single WebSocket Connection
├─ Context: "speaker=system, language=en→vi"
├─ Send System Audio ┐
│                    ├─→ [Soniox Engine]
├─ Send User Audio   ┤   (interleaved)
│                    │
└─→ Receive mixed transcription
```

**Pros:**
- Minimal WebSocket connections (1 vs 2)
- Potentially cheaper
- Server maintains global context

**Cons:**
- ✅ Soniox doesn't support this well
- ✅ Transcriptions may be mixed up
- ✅ Can't request language change mid-stream

**Verdict:** Don't use

---

### Strategy B: Two Soniox Sessions (Separate Pipelines) ⭐ RECOMMENDED

```
Session 1: System Audio Stream    Session 2: Microphone Stream
├─ WebSocket 1                    ├─ WebSocket 2
├─ Language: en→vi                ├─ Language: en→vi
├─ Context: "speaker=other"       ├─ Context: "speaker=user"
└─ Output: Display A + Optional TTS  └─ Output: Display B + TTS + Inject
```

**Pros:**
- ✅ Complete isolation between streams
- ✅ Independent language config
- ✅ Can pause one stream, keep other running
- ✅ Clear error handling per stream

**Cons:**
- ❌ 2x Soniox API cost (actually ~$0.06/hr each, total $0.12/hr)
- ❌ 2x WebSocket connections

**Cost Analysis:**
- Soniox: $0.12/hr = $1/day = $30/month (for 8h/day usage)
- Acceptable for professional users

**Verdict:** Recommended approach

---

### Strategy C: Session Pool (Future Optimization)

```
Pool of N sessions, reuse least-recently-used
Reduces overhead for streaming connections
```

**Verdict:** Overkill for v1.0, consider for v2.0

---

## TTS Provider Selection

### Stream A (System Audio - Display + Optional TTS)

TTS cho Stream A là tùy chọn, mặc định tắt để tiết kiệm chi phí. Khi cần có thể bật:

| Provider | Quality | Cost | Implementation |
|----------|---------|------|-----------------|
| Edge TTS | High | Free | Rust proxy ✓ |
| Google | Excellent | $0.016/1k chars | REST API |
| ElevenLabs | Premium | $0.30/1k chars | WebSocket |

**Recommendation:** Keep Stream A TTS as optional toggle (default OFF, user-controlled)

---

### Stream B (User Microphone - TTS + Injection)

Must have TTS to speak to other participants.

| Provider | Quality | Cost | Implementation | Injection |
|----------|---------|------|---|---|
| Edge TTS | High | Free | ✓ Rust proxy | ✓ PCM |
| Google | Excellent | $0.016/1k chars | REST | ✓ MP3 |
| ElevenLabs | Premium | $0.30/1k chars | ✓ WebSocket | ✓ MP3 |

**Recommendation:** Edge TTS (free, good quality, easy injection)

**Cost Breakdown (per hour of meeting):**
- Soniox STT: $0.12/hr
- Edge TTS injection: Free (~$0 additional)
- **Total: $0.12/hr ≈ $1/day**

---

## Latency Budget

For real-time meetings, latency critical.

### Acceptable Latency: 2-3 seconds

Breakdown:
```
Audio Capture (50ms)
  ↓
Buffer/Accumulate (100ms)
  ↓
Send to Soniox (50ms)
  ↓
Soniox Processing (800-1000ms) ← Dominant
  ↓
Receive Result (50ms)
  ↓
TTS Generation (300-500ms)
  ↓
Inject to Meeting (50ms)
─────────────────────────────
Total: ~1.5-2.5 seconds ✓ Acceptable
```

### If Latency Exceeds 3s:

**Optimizations:**
1. Send smaller audio buffers (50ms instead of 100ms) = +50ms speedup
2. Switch to faster TTS (Edge vs ElevenLabs) = +100-200ms speedup
3. Use local Whisper + fast local LLM (not viable, too slow)
4. Add latency monitoring dashboard (debug only)

**Not recommended:**
- ❌ Reduce audio buffer too much (causes choppy transcription)
- ❌ Skip Soniox buffering (causes connection issues)

---

## Error Recovery Strategy

### Stream A Error → Stream B Continues

```
System Audio Capture Fails
├─ Log error
├─ Display toast: "System audio lost"
├─ Stop Stream A processing
└─ Continue Stream B (user can still speak)
```

**User Experience:** Minor - just see one stream paused

### Stream B Error → Stream A Continues

```
Microphone Capture Fails
├─ Log error
├─ Display error, disable injection
├─ Continue Stream A
└─ Let user manually restart Stream B
```

**User Experience:** User can still hear/read translations, can't inject

### Both Streams Error → Stop App

```
if (streamA.error && streamB.error) {
    stop_app();
    show_error("Meeting translation stopped. Please restart.");
}
```

**User Experience:** Bad - need to restart

**Implementation:**
```javascript
async _handleStreamError(streamId, error) {
    if (streamId === 'a') {
        this.streamA.error = error;
        if (this.streamB.status === 'running') {
            // Continue
        } else {
            // Stop app
        }
    }
    // Similar for Stream B
}
```

---

## Testing Strategy for Bidirectional

### Unit Tests
- [ ] Dual capture initialization
- [ ] Language pair switching
- [ ] Audio buffer accumulation
- [ ] Virtual device detection

### Integration Tests
- [ ] System audio + microphone simultaneously
- [ ] Soniox transcription (2 sessions)
- [ ] TTS generation
- [ ] Audio injection to virtual device

### End-to-End Tests
- [ ] Open Zoom meeting (actual meeting, 2 participants)
- [ ] User A: English speaker
- [ ] User B (with app): English speaker (in app), speaks Vietnamese via microphone
- [ ] Verify: User A hears Vietnamese translation of User B ✓

**Testing Checklist:**
- [ ] Zoom mock setup (easy test without 2nd person)
- [ ] Teams mock setup
- [ ] Google Meet mock setup
- [ ] Real Zoom meeting with friend (final validation)

---

## Rollout Plan

### v0.5 Release
- Single mode (existing) works perfectly
- Dual mode added as **experimental**
- Docs added: `bidirectional_translation_guide.md`

### v0.6 Release (1 month later)
- Fix bugs from v0.5 feedback
- Dual mode now **stable**
- Add Settings UI for dual mode
- Add recording export for dual transcripts

### v0.7+ Releases
- Support for 70+ language pairs simultaneously
- Profile system (save different meeting profiles)
- Local MLX option for Stream A
- Cross-platform Windows support

---

## FAQ

**Q: Why not just use meeting app's built-in captions?**
A: Most meeting apps (Zoom, Teams) have basic auto-captions only in English. This app provides real-time translation to ANY language.

**Q: Can I use this with Slack/Discord?**
A: Yes! Any app that accepts audio input. Set Slack/Discord mic input = BlackHole, then use dual mode.

**Q: Will this work on Linux/Windows?**
A: macOS in v0.5. Linux (PulseAudio) and Windows (VB-Cable) support coming in v0.6+.

**Q: Can I change languages mid-meeting?**
A: Yes! Drop-down in UI, dynamic update (no restart needed).

**Q: How much does it cost?**
A: ~$0.12/hour for Soniox API. That's ~$1/day if using 8h/day.

**Q: Can I use multiple translation pairs simultaneously?**
A: Yes in v0.5 design. Both streams can have different source/target languages.

**Q: What if internet cuts out during meeting?**
A: App stops translating (needs internet for Soniox). Display frozen, user must manually set up again. Future: local fallback mode.

---

## Next Steps

1. **Start with Option 1** (Cloud Soniox) — most straightforward
2. **Follow Quick Start guide** — copy-paste code, ~5-7 days
3. **Test with LocalHost Zoom** — use recorder app as mock
4. **Real meeting test** — 2-person Zoom call
5. **Iterate based on feedback** — latency, window positioning, UX polish
6. **Then consider** Option 2 (Local MLX for Stream A) — if cost becomes issue

Good luck! 🚀
