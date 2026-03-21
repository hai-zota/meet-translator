# 🔄 Bidirectional Translation Feature - Implementation Roadmap

> Translate both directions in real-time meetings: Capture meeting audio + user microphone, translate both to target language, inject user's translation back into the meeting.

## 📚 Documentation Structure

### 1️⃣ **For Decision Makers** → Start here if unsure about architecture

**File:** [bidirectional_design_decisions.md](bidirectional_design_decisions.md)

- Should I use Soniox or local MLX?
- Virtual device vs API injection?
- What's the cost & latency?
- How to handle errors?

**Read time:** 15 min | **Sections:** 10

---

### 2️⃣ **For Architects & Designers** → Understanding the full system

**File:** [bidirectional_translation_guide.md](bidirectional_translation_guide.md)

- Complete architecture diagrams
- 5 implementation phases
- Technical challenges & solutions
- File structure & dependencies
- Step-by-step implementation checklist

**Read time:** 45 min | **Sections:** 8 | **Code examples:** None (high-level design)

---

### 3️⃣ **For Coders** → Copy-paste ready implementation

**File:** [bidirectional_quickstart.md](bidirectional_quickstart.md)

- Setup BlackHole/virtual device
- Phase 1-5 code with examples
- Testing checklist
- Troubleshooting
- Timeline estimate (5-7 days for Phase 1)

**Read time:** 60 min | **Sections:** 8 | **Code examples:** 30+ (Rust + JavaScript)

---

### 4️⃣ **For State Machine Experts** → Deep dive into app state

**File:** [bidirectional_state_management.md](bidirectional_state_management.md)

- State machine diagram (IDLE → RUNNING → ERROR handling)
- AppState class with dual stream management
- Data flow diagrams (Stream A and Stream B)
- Error recovery strategies
- Performance monitoring
- Testing & debugging console commands

**Read time:** 30 min | **Sections:** 8 | **Code examples:** 20+ (JavaScript classes)

---

## 🎯 Quick Start Paths

### Path A: "I want to understand the architecture first"
1. Read: [bidirectional_design_decisions.md](bidirectional_design_decisions.md) (Decision Matrix + Cost Analysis)
2. Read: [bidirectional_translation_guide.md](bidirectional_translation_guide.md) (Architecture section)
3. Start coding: [bidirectional_quickstart.md](bidirectional_quickstart.md)

**Total time:** ~1.5 hours before coding starts

### Path B: "Just show me the code"
1. Quick skim: [bidirectional_quickstart.md](bidirectional_quickstart.md) - tl;dr section
2. Copy Phase 1-2 code
3. Reference: [bidirectional_state_management.md](bidirectional_state_management.md) for state management

**Total time:** ~30 min before coding starts

### Path C: "I need to fix a production bug in dual mode"
1. Look up: [bidirectional_state_management.md](bidirectional_state_management.md) - State Machine or Error Handling
2. Debug console commands: Section 8 of state management guide
3. Check: [bidirectional_design_decisions.md](bidirectional_design_decisions.md) - Error Recovery Strategy

**Total time:** ~10 min to find solution

---

## 📊 Document Mapping by Questions

| Question | Document | Section |
|----------|----------|---------|
| "Should I use Soniox or MLX?" | Design Decisions | Decision Matrix |
| "How do I inject audio to Zoom?" | Design Decisions | Audio Injection Mechanisms |
| "What's the project timeline?" | Quick Start | Timeline Estimate |
| "Show me the architecture diagram" | Translation Guide | Section 1 (Tổng quan kiến trúc mới) |
| "How do I set up BlackHole?" | Quick Start | Phase 1 / Testing Checklist |
| "What's the exact code for dual capture?" | Quick Start | Phase 2 Implementation |
| "How do I handle Stream A error?" | State Management | Error Handling State |
| "What's the data flow for Stream B?" | State Management | Data Flow: Stream B |
| "I need performance monitoring" | State Management | Performance Monitoring section |
| "How do I test this locally?" | State Management | Testing State Transitions |
| "What are the implementation phases?" | Translation Guide | Section 3 (5 Phases) |
| "Cost breakdown for Soniox + TTS?" | Design Decisions | TTS Provider Selection |
| "Expected latency for meetings?" | Design Decisions | Latency Budget |

---

## 🚀 Implementation Timeline

### Quick Version (5-7 days, Phase 1 only)
- Virtual device support ✓
- Dual audio capture ✓
- Basic UI
- **Limitation:** Translation via Soniox only (no local MLX)

### Standard Version (9-14 days, Phases 1-4)
- All of above +
- Dual translation pipeline ✓
- TTS + audio injection ✓
- Full settings UI ✓
- **Feature complete for first release**

### Premium Version (14-21 days, Phases 1-5)
- All of above +
- Comprehensive testing ✓
- Edge case handling ✓
- Performance optimization ✓
- **Production ready**

---

## 📋 Pre-Implementation Checklist

Before you start coding, make sure:

- [ ] Rust toolchain installed: `rustc --version`
- [ ] Node.js 18+: `node --version`
- [ ] BlackHole 2.0 installed (macOS): `brew install blackhole-2ch`
- [ ] Soniox API key ready
- [ ] VS Code + extensions installed (Tauri, Rust-Analyzer, CodeLLDB)
- [ ] Read Design Decisions document (30 min)
- [ ] Read Quick Start Phase 1 (15 min)

---

## 📞 Document Cross-References

**If reading Design Decisions:**
- → Architecture details? Jump to [Translation Guide - Section 1](bidirectional_translation_guide.md#1-tổng-quan-kiến-trúc-mới)
- → Code examples? Jump to [Quick Start - Phase 1](bidirectional_quickstart.md#phase-1-virtual-audio-device-support-day-1-2)
- → State machine? Jump to [State Management - State Machine Diagram](bidirectional_state_management.md#state-machine-diagram)

**If reading Translation Guide:**
- → Copy code? Jump to [Quick Start](bidirectional_quickstart.md)
- → Decision rationale? Jump to [Design Decisions](bidirectional_design_decisions.md)
- → Debug state? Jump to [State Management](bidirectional_state_management.md)

**If reading Quick Start:**
- → Why this architecture? Jump to [Design Decisions - Decision Matrix](bidirectional_design_decisions.md#decision-matrix)
- → Full implementation guide? Jump to [Translation Guide - Phases](bidirectional_translation_guide.md#3-các-bước-triển-khai-chi-tiết)
- → Test & debug? Jump to [State Management - Testing](bidirectional_state_management.md#testing-state-transitions)

**If reading State Management:**
- → General questions? Jump to [Design Decisions - FAQ](bidirectional_design_decisions.md#faq)
- → Code patterns? Jump to [Quick Start - Phase 1-4](bidirectional_quickstart.md#phase-1-virtual-audio-device-support-day-1-2)
- → Architecture overview? Jump to [Translation Guide](bidirectional_translation_guide.md)

---

## 🎓 Learning Curve

**Day 1:** Architecture understanding
- Morning: Read Design Decisions (45 min)
- Afternoon: Read Translation Guide high-level (30 min)
- Evening: Skim Quick Start code examples (20 min)

**Day 2:** Deep dive into implementation
- Morning: Full Quick Start reading (60 min)
- Afternoon: State Management study (30 min)
- Evening: Plan Phase 1 tasks (30 min)

**Day 3+:** Coding begins
- Phase 1: Virtual device support (1-2 days)
- Phase 2: Dual capture (2-3 days)
- Phase 3+: Complex features (3+ days)

---

## 🔧 Technology Stack

**Frontend:**
- JavaScript (vanilla)
- Tauri IPC channels
- Web Audio API (audio calculations)

**Backend:**
- Rust
- Core Audio (macOS)
- tokio (async runtime)
- Tauri commands

**External APIs:**
- Soniox WebSocket (STT + Translation)
- Edge TTS / Google Cloud TTS / ElevenLabs (optional TTS)
- Virtual Audio Device (system API)

**Virtual Audio Device:**
- macOS: BlackHole (free) or Soundflower (deprecated but works)
- Windows: VB-Audio Virtual Cable (free)
- Linux: PulseAudio loopback (built-in)

---

## 📈 Success Criteria

### Phase 1 Success
- [ ] Virtual devices detected and listed
- [ ] Test audio passed to virtual device without errors

### Phase 2 Success
- [ ] System audio captured simultaneously with microphone
- [ ] Both streams send independent data via IPC

### Phase 3 Success
- [ ] Stream A translates/displays correctly and supports optional TTS toggle
- [ ] Stream B translates, generates TTS, and injects to virtual device
- [ ] Latency acceptable (<3 seconds)

### Phase 4 Success
- [ ] UI shows both streams side-by-side
- [ ] User can select languages independently
- [ ] Settings persist across restarts

### Phase 5 Success
- [ ] All edge cases handled (device disconnect, API timeout, etc)
- [ ] Performance monitoring shows healthy metrics
- [ ] Zero crashes during 1-hour test run

---

## 🐛 Common Pitfalls to Avoid

1. **Mixing audio formats** - Ensure all audio normalized to s16le 16kHz
2. **Session reuse** - Use 2 separate Soniox sessions (not 1 shared)
3. **Audio buffer timing** - Buffer 100-500ms before sending to API (not frame-by-frame)
4. **Error in one stream killing both** - Implement independent error handling
5. **Virtual device not available** - Graceful fallback if BlackHole not installed
6. **UI not updating with state** - Use proper state management pattern
7. **TTS blocking main thread** - Async/await all TTS calls
8. **Forgotten channel cleanup** - Properly close IPC channels on stop

---

## 🤝 Contributing Back

After implementing, consider:
- Sharing your Rust `virtual_device.rs` implementation
- Posting latency benchmarks (compare Soniox vs local MLX)
- Windows/Linux ports if you make them
- Optimizations discovered during testing

---

## 📞 Support

- ❓ Architecture questions? → Read [Design Decisions](bidirectional_design_decisions.md)
- 💻 Code stuck? → Search [Quick Start code examples](bidirectional_quickstart.md)
- 🐛 Debugging? → Check [State Management - Console Commands](bidirectional_state_management.md#debug-console-commands)
- 📊 Performance issues? → Review [Design Decisions - Latency Budget](bidirectional_design_decisions.md#latency-budget)

---

## 📖 Full Document List

1. [bidirectional_design_decisions.md](bidirectional_design_decisions.md) - Architecture options, cost analysis, decision matrix
2. [bidirectional_translation_guide.md](bidirectional_translation_guide.md) - Complete technical specifications, 5 phases
3. [bidirectional_quickstart.md](bidirectional_quickstart.md) - Code examples, copy-paste ready
4. [bidirectional_state_management.md](bidirectional_state_management.md) - State machine, data flows, error handling
5. **This file** - Roadmap and navigation guide

---

**Last updated:** 2026-03-20
**Status:** ✅ Ready for implementation
**Estimated effort:** 5-21 days (depending on scope)
**Difficulty:** Medium-High (Rust + JavaScript + audio engineering)

Good luck! 🚀
