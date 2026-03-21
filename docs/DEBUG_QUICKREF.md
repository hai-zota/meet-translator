# Quick Debug Reference

Cheat sheet nhanh để debug Tauri app trên macOS.

---

## 🚀 Start Development

```bash
# Terminal 1 — Run full dev mode (Rust + Frontend + DevTools)
npm run tauri dev

# Terminal 2 (optional) — Monitor Rust logs
tail -f ~/Library/Logs/my-translator/panic.log
```

---

## 🔍 Debug in VS Code

### Debug Rust Backend

1. **F5** → Select "Tauri App (Debug)" → ▶
2. Set breakpoint in `.rs` file (click line number left)
3. Run action in app
4. VS Code pauses → inspect variables
5. **F10** = step over, **F11** = step into

### Debug Frontend JavaScript

1. **⌘ Option I** → Open DevTools
2. **Sources** tab → Find `.js` file
3. Click line number to breakpoint
4. **⌘ R** Reload app
5. DevTools pauses → inspect variables, console

---

## 🛠️ Common Commands

| Task | Command | Keyboard |
|------|---------|----------|
| Build for release | `npm run tauri build` | — |
| Run clippy lint | `cargo clippy --all-targets` | — |
| Run Rust tests | `cargo test -p my-translator` | (Cmd+Shift+B) |
| Clean all build | `cargo clean` | (Cmd+Shift+T) → Clear DVR |
| View settings | `invok('get_settings')` at console | ⌘ Option J |
| Reset screen recording | `tccutil reset screencapture ...` | (Cmd+Shift+T) → Reset |
| Open crash log | `~/Library/Logs/my-translator/` | — |

---

## 📝 Common Breakpoint Patterns

### Track API Key Issues

`src-tauri/src/commands/settings.rs`:
```rust
#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Result<Settings, String> {
    let settings = state.0.lock()...;
    println!("DEBUG: API Key = {}", &settings.soniox_api_key[..10]); // Breakpoint here
    Ok(settings.clone())
}
```

### Track Audio Capture

`src-tauri/src/commands/audio.rs`:
```rust
pub fn start_capture(
    source: String,
    channel: Channel<Vec<u8>>,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    println!("💾 start_capture: source={}", source); // Breakpoint here
    // ...
}
```

### Track Frontend → Backend IPC

`src/js/app.js`:
```javascript
async start() {
    console.log('📡 Invoking start_capture...');
    const result = await invoke('start_capture', { source: this.currentSource });
    console.log('📡 Got result:', result); // Breakpoint
}
```

---

## 🐛 Quick Fixes

### App won't start
```bash
cargo clean
npm install
npm run tauri dev
```

### Port 8080 already in use
```bash
lsof -ti:8080 | xargs kill -9
npm run tauri dev
```

### Rust-Analyzer broken
- Cmd+Shift+P → "Rust Analyzer: Restart server"

### Permission denied (Screen Recording)
- Cmd+Shift+T → "Reset Screen Recording Permission"
- Relaunch app → accept permission again

### Can't find symbol
- Cmd+Shift+P → "Rust Analyzer: Reload Workspace"

---

## 📊 Inspect State from Console

```javascript
// DevTools Console (⌘ Option J)

// Settings
window.__TAURI__.core.invoke('get_settings').then(s => console.log(s))

// Check if connected to Soniox
window.sonioxClient?.isConnected

// Get platform info
window.__TAURI__.core.invoke('get_platform_info').then(p => console.log(p))

// Manual API call test
window.__TAURI__.core.invoke('check_permissions').then(p => console.log(p))
```

---

## 🎯 Workflow for Bug Fix

1. **Identify** → run `npm run tauri dev`
2. **Locate** → ⌘ Option I → DevTools or F5 → Rust breakpoint
3. **Inspect** → step through code, watch variables
4. **Edit** → make fix in `.ts`/`.rs` file
5. **Verify** → app auto-reloads, test fix
6. **Commit** → `git add . && git commit`

---

## 🔗 Related Files

- [Full Debug Guide](debug_guide.md)
- [Installation Guide](installation_guide.md)
- [VS Code launch.json](.vscode/launch.json)
- [VS Code settings.json](.vscode/settings.json)
- [VS Code tasks.json](.vscode/tasks.json)

---

Generated: 2026-03-20
