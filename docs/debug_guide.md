# Debug Guide — My Translator on macOS

Hướng dẫn debug ứng dụng Tauri (Rust backend + HTML/JS frontend) trên VS Code trên macOS.

---

## 1. Prerequisites — Cài Đặt

### 1.1 Xcode & LLDB (for Rust debugging)
```bash
xcode-select --install  # Nếu chưa có
```

### 1.2 Homebrew Dependencies
```bash
brew install rust node
```

### 1.3 Verify Installation
```bash
rustc --version      # Rust 1.70+
cargo --version      # Cargo
node --version       # Node 18+
```

---

## 2. VS Code Extensions (Bắt Buộc)

Mở **Extensions** (⌘ Shift X) và cài:

| Extension | ID | Mục đích |
|-----------|-----|---------|
| Tauri | `tauri-apps.tauri-vscode` | LSP + command pallette cho Tauri |
| Rust Analyzer | `rust-lang.rust-analyzer` | Intellisense + debugging cho Rust |
| CodeLLDB | `vadimcn.vscode-lldb` | GUI debugger cho Rust (LLDB) |
| Chrome Debugger | `msjsdiag.debugger-for-chrome` | Debug frontend JS trong Chrome inspector |

> Hoặc cài tất cả một lần qua terminal:
```bash
code --install-extension tauri-apps.tauri-vscode
code --install-extension rust-lang.rust-analyzer
code --install-extension vadimcn.vscode-lldb
code --install-extension msjsdiag.debugger-for-chrome
```

---

## 3. Setup Project

### 3.1 Navigate to Project
```bash
cd /Users/x4hai/source/meet-translator
```

### 3.2 Install Dependencies
```bash
npm install
```

### 3.3 Rust Setup (one-time)
```bash
rustup target add aarch64-apple-darwin   # Apple Silicon
# hoặc
rustup target add x86_64-apple-darwin    # Intel
```

---

## 4. Quick Start — Chạy Dev Mode

### 4.1 Terminal Approach (Đơn Giản)

**Terminal 1 — Backend + Frontend Bundle**
```bash
npm run tauri dev
```

Lệnh này sẽ:
- Compile Rust backend
- Watch + rebuild frontend (HTML/JS)
- Launch WebView window
- Show DevTools automatically

**Trên Terminal 1, bạn sẽ thấy:**
```
Built target(s) in 12.34s
App started successfully
Listening on 127.0.0.1:8080
App window exited with code: 0
```

---

## 5. Debug Rust Backend (Trong VS Code)

### 5.1 Một-Click Debug (Recommended)

1. Mở **VS Code**
2. Vào **Run & Debug** (⌘ Shift D)
3. Click dropdown → **Tauri App (Debug)**
4. Press **F5** hoặc click ▶

Ứng dụng sẽ start trong debug mode:
- Rust breakpoints được active
- Console sẽ in logs từ backend
- Nhấn Ctrl-C khi xong

### 5.2 Debug Breakpoint

Trong file Rust (ví dụ `src-tauri/src/commands/audio.rs`):

```rust
#[tauri::command]
pub fn start_capture(
    source: String,
    channel: Channel<Vec<u8>>,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    println!("DEBUG: start_capture called with {}", source);
    // ← Click cột bên trái để set breakpoint
```

Khi chương trình chạy đến breakpoint → VS Code pause tại đó.

---

## 6. Debug Frontend (HTML/JS)

### 6.1 DevTools mở Tự Động

Khi chạy `npm run tauri dev`:
- Cửa sổ ứng dụng sẽ mở
- DevTools panel nằm bên cạnh hoặc dưới
- Mở DevTools: **⌘ Option I**

### 6.2 Inspect Network & API Calls

**Network Tab**:
- Xem request/response giữa JS và Rust command
- Ví dụ: Invoke `invoke('start_capture', ...)` → xem kết quả

**Console Tab**:
- Gõ `settingsManager.get()` để xem settings hiện tại
- `sonioxClient.isConnected` để check Soniox status

### 6.3 JavaScript Breakpoint

Trong [src/js/app.js](../../src/js/app.js):

```javascript
async start() {
    console.log('🎯 Starting app');  // ← VS Code DevTools console

    try {
        // Bấm F12 → Nguồn → tìm app.js → set breakpoint
        sonioxClient.connect(config);
```

Khi chạy:
1. Mở DevTools (⌘ Option I)
2. Vào tab **Sources**
3. Tìm `app.js` → click dòng số để set breakpoint
4. Reload (⌘ R) → pause tại breakpoint

---

## 7. Debug Soniox WebSocket

Để xem WebSocket frames giữa app và Soniox:

### 7.1 Network Inspector

1. DevTools → **Network** tab
2. Filter bằng `ws` (WebSocket)
3. Click `wss://stt-rt.soniox.com` connection
4. Xem **Messages** tab:

```json
{
  "api_key": "soniox_...",
  "model": "stt-rt-v4",
  "audio_format": "pcm_s16le"
}
```

### 7.2 Console Logging

Edit [src/js/soniox.js](../../src/js/soniox.js) để add more logging:

```javascript
_handleResponse(data) {
    console.log('[Soniox Response]', data);  // ← Xem dữ liệu

    if (data.tokens) {
        console.log(`Got ${data.tokens.length} tokens`);
    }
}
```

---

## 8. Debug Local Mode (MLX Pipeline)

### 8.1 Check Python Sidecar

Monitor Python process:
```bash
ps aux | grep local_pipeline.py
```

### 8.2 View Pipeline Logs

Xem logs từ Python sidecar:
```bash
tail -f /tmp/personal_translator_pipeline.log
```

### 8.3 Debug Python Code (Optional)

Edit [scripts/local_pipeline.py](../../scripts/local_pipeline.py):

```python
def emit(data):
    """Send JSON to stdout."""
    print(json.dumps(data, ensure_ascii=False), flush=True)
    print(f"[DEBUG] Emitted: {data}", file=sys.stderr, flush=True)  # ← Add
```

Logs sẽ muncul ở console Tauri dev.

---

## 9. Debug Audio Issues

### 9.1 Check System → Mic Permission

Terminal:
```bash
# Check Screen Recording permission
tccutil status screencapture

# Check Microphone permission
tccutil status microphone
```

### 9.2 Test Audio Capture

Tạo debug file `src-tauri/tests/test_audio.rs`:

```rust
#[test]
fn test_microphone_capture() {
    use my_translator::audio::microphone::MicCapture;
    let mut mic = MicCapture::new();
    let receiver = mic.start().expect("Failed to start");

    println!("Listening for 2 seconds...");
    std::thread::sleep(std::time::Duration::from_secs(2));

    while let Ok(chunk) = receiver.try_recv() {
        println!("Got chunk: {} bytes", chunk.len());
    }
}
```

Chạy:
```bash
cd src-tauri
cargo test test_microphone_capture -- --nocapture
```

---

## 10. Common Debugging Tips

### 10.1 Clear Cache & Rebuild

```bash
# Xóa build artifacts cũ
cargo clean

# Rebuild từ đầu
npm run tauri dev
```

### 10.2 Inspect State từ DevTools Console

```javascript
// Kiểm tra app state từ DevTools
window.app  // Access app singleton (nếu export global)

// Hoặc gọi Tauri command
window.__TAURI__.core.invoke('get_settings').then(s => console.log(s))
```

### 10.3 Print Rust Logs ở Frontend Console

Trong Rust, dùng `println!` hoặc `eprintln!`:

```rust
#[tauri::command]
fn get_platform_info() -> String {
    println!("🎯 Platform info requested");  // ← Sẽ muncul ở terminal
    format!(r#"{{"os":"{}","arch":"{}"}}"#, std::env::consts::OS, std::env::consts::ARCH)
}
```

### 10.4 Pause on Error

DevTools → **Sources** → **Pause on exceptions** button
→ DevTools sẽ pause nếu JS error xảy ra

---

## 11. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| F5 | Start debugging (hoặc Click ▶ nếu đã select config) |
| F10 | Step over (Rust/JS) |
| F11 | Step into |
| Shift F11 | Step out |
| ⌘ Option I | Open DevTools |
| ⌘ Option U | View Page Source |
| ⌘ Option J | Toggle Console |
| ⌘ R | Reload app |
| Ctrl C | Stop terminal |

---

## 12. Troubleshooting

### "Failed to bind to port 8080"
```bash
# Kill process sử dụng port 8080
lsof -ti:8080 | xargs kill -9

npm run tauri dev
```

### "CodeLLDB not working"
- Verify installed: `code --list-extensions | grep lldb`
- Reinstall: `code --install-extension vadimcn.vscode-lldb --force`

### "Rust-Analyzer not finding symbols"
- VS Code → Cmd+Shift+P → "Rust Analyzer: Restart server"

### Permission denied for Screen Recording
```bash
# Reset permissions
tccutil reset screencapture com.tauri.dev.my-translator
# Reload app → should prompt again
```

### App crashes on startup
Check `src-tauri/target/release/bundle/macos/My Translator.app/Contents/MacOS/` logs:
```bash
cat ~/Library/Logs/my-translator/panic.log
```

---

## 13. Full Debug Workflow

### Scenario: Fix a Soniox connection bug

**Step 1:** Start debugging
```bash
cd /Users/x4hai/source/meet-translator
npm run tauri dev
```

**Step 2:** Open VS Code DevTools
- Press ⌘ Option I
- Go to **Sources** tab

**Step 3:** Set breakpoint in `soniox.js`
- Find [src/js/soniox.js](../../src/js/soniox.js)
- Navigate to `_handleResponse` method
- Click line number to set breakpoint

**Step 4:** Trigger the bug
- Click Start button in app (or ⌘ Enter)
- DevTools pauses at breakpoint

**Step 5:** Inspect state
- Hover over variables
- Step through with F10/F11
- Check Console for logs

**Step 6:** Hot reload
- Edit source file (both Rust/JS)
- Tauri will auto-reload WebView
- No restart needed usually

**Step 7:** Fix & verify
- Make changes
- Run ✅ Test
- Commit fix

---

## 14. Remote Debugging (Advanced)

### Debug on a different Mac (via network)

1. **On dev Mac:**
   ```bash
   # Start app with debug symbols
   npm run tauri dev -- --debug
   ```

2. **On remote Mac:**
   ```bash
   # Connect to 192.168.x.x:9222 Chrome DevTools port
   # (requires special setup)
   ```

> Recommended: Use SSH + VSCode Remote SSH extension instead.

---

## References

- 📚 [Tauri Debugging Docs](https://tauri.app/v1/guides/debugging/)
- 🦀 [Rust LLDB Guide](https://rust-lang.github.io/rustup/)
- 🔍 [Chrome DevTools](https://developer.chrome.com/docs/devtools/)
