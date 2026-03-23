/**
 * App — main application controller
 * Wires together: settings, UI, Soniox client, and audio capture
 */

import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { SonioxClient, sonioxClient } from './soniox.js';
import { elevenLabsTTS } from './elevenlabs-tts.js';
import { googleTTS } from './google-tts.js';
import { edgeTTSRust } from './edge-tts.js';
import { audioPlayer } from './audio-player.js';
import { updater } from './updater.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false; // Guard against re-entry
        this.currentSource = 'system'; // 'system' | 'microphone' | 'dual'
        this.translationMode = 'soniox'; // 'soniox' | 'local'
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow();
        this.localPipelineChannel = null;
        this.localPipelineReady = false;
        this.recordingStartTime = null;
        this.ttsEnabled = false;  // TTS runtime toggle
        this._initialSettingsApplied = false;
        this.isPinned = true;     // Always-on-top state
        this.isCompact = false;   // Compact mode (hide control bar)
        this.dualModeEnabled = false; // Dual-stream mode runtime toggle
        // Mixer stats polling removed
        this.dualConfig = {
            streamA: {
                sourceLanguage: 'auto',
                targetLanguage: 'vi',
                ttsEnabled: true,
                translatedVolume: 1.0,
                edgeVoice: 'vi-VN-HoaiMyNeural',
                edgeSpeed: 20,
                googleVoice: 'vi-VN-Chirp3-HD-Aoede',
                elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
            },
            streamB: {
                sourceLanguage: 'auto',
                targetLanguage: 'en',
                ttsEnabled: true,
                injectEnabled: false,
                mixOriginalEnabled: false,
                originalVolume: 0.5,
                translatedVolume: 1.0,
                edgeVoice: 'vi-VN-HoaiMyNeural',
                edgeSpeed: 50,
                googleVoice: 'vi-VN-Chirp3-HD-Aoede',
                elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
            },
        };
        // Soniox clients for dual mode (instantiated during _startDualCapture)
        this.sonioxClientA = null;
        this.sonioxClientB = null;
        // Tauri channels for dual mode (kept to avoid GC drop)
        this._dualChannelA = null;
        this._dualChannelB = null;
        this.injectDeviceName = 'BlackHole 2ch';
        this._lastInjectErrorTs = 0;
        this._injectFailureCount = 0;
        this._injectUsedLegacyFallback = false;
        this._injectTextQueue = [];
        this._isInjectingText = false;
        this._originalInjectQueue = [];
        this._translatedInjectQueue = [];
        this._isPumpRunning = false;
        this._recentOriginalPcm = [];
        this._recentOriginalMaxBytes = 32000; // ~1s at 16kHz mono s16le
        this._ttsTextQueue = [];      // Decoupled TTS text queue
        this._ttsQueuePumping = false; // Whether TTS pump loop is active
        this._ttsPumpToken = 0;       // Invalidate stale pump loops across mode switches
        this._ttsPumpHeartbeat = 0;   // Last observed pump activity timestamp
        this._runId = 0; // Incremented on each start/stop to invalidate stale callbacks
        this._dualStreamStates = { A: 'idle', B: 'idle' };
        this._dualStreamErrorHistory = { A: [], B: [] };
        this._lastStreamErrorToastTs = { A: 0, B: 0 };
        this._lastSonioxTransientToastTs = 0;
    }

    async init() {
        // Load settings
        await settingsManager.load();

        // Init transcript UI
        const transcriptContainer = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(transcriptContainer);

        // Check platform — hide Local MLX on non-Apple-Silicon
        await this._checkPlatformSupport();

        // Apply saved settings to UI
        this._applySettings(settingsManager.get());
        this._syncQuickLocaleControls(settingsManager.get());

        // Bind event listeners
        this._bindEvents();

        // Bind keyboard shortcuts
        this._bindKeyboardShortcuts();

        // Subscribe to settings changes
        settingsManager.onChange((settings) => this._applySettings(settings));

        // Init audio player for TTS
        audioPlayer.init();

        // Wire TTS audio callbacks for providers that use audioPlayer.
        // Hot path: direct enqueue for single-mode (no async overhead)
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onAudioChunk = (base64Audio, isFinal, meta) => {
                if (meta) {
                    this._handleTtsAudioChunk(base64Audio, meta).catch((err) => {
                        console.error('[TTS] Failed to route audio chunk:', err);
                    });
                    return;
                }
                // Direct enqueue for single-mode: no .catch() overhead
                audioPlayer.enqueue(base64Audio);
            };
        }
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onError = (error) => {
                console.error('[TTS]', error);
                this._showToast(error, 'error');
            };
        }

        // Window position restore disabled — causes issues on Retina displays
        // await this._restoreWindowPosition();

        // Check for updates (non-blocking)
        this._checkForUpdates();

        console.log('🌐 My Translator v0.5.0 initialized');
    }

    async _checkPlatformSupport() {
        try {
            // Check if we're on macOS Apple Silicon
            const arch = await invoke('get_platform_info');
            const info = JSON.parse(arch);
            this.isAppleSilicon = (info.os === 'macos' && info.arch === 'aarch64');
        } catch {
            // Fallback: check via navigator
            this.isAppleSilicon = navigator.platform === 'MacIntel' &&
                navigator.userAgent.includes('Mac OS X');
        }

        if (!this.isAppleSilicon) {
            // Hide Local MLX option
            const select = document.getElementById('select-translation-mode');
            const localOption = select?.querySelector('option[value="local"]');
            if (localOption) localOption.remove();

            // Force soniox mode if user had local selected
            const settings = settingsManager.get();
            if (settings.translation_mode === 'local') {
                settings.translation_mode = 'soniox';
                settingsManager.save(settings);
            }
        }
    }

    // ─── Event Binding ──────────────────────────────────────

    _bindEvents() {
        // Settings button
        document.getElementById('btn-settings').addEventListener('click', () => {
            this._showView('settings');
        });

        // Back from settings
        document.getElementById('btn-back').addEventListener('click', () => {
            this._showView('overlay');
        });

        // Close button (overlay)
        document.getElementById('btn-close').addEventListener('click', async () => {
            if (this.transcriptUI.hasSegments()) {
                await this._saveTranscriptFile();
            }
            await this._saveWindowPosition();
            await this.stop();
            await this.appWindow.close();
        });

        // Minimize button
        document.getElementById('btn-minimize').addEventListener('click', async () => {
            await this._saveWindowPosition();
            await this.appWindow.minimize();
        });

        // Pin/Unpin button
        document.getElementById('btn-pin').addEventListener('click', () => {
            this._togglePin();
        });

        // Compact mode button
        document.getElementById('btn-compact').addEventListener('click', () => {
            this._toggleCompact();
        });

        // View mode toggle (dual panel)
        document.getElementById('btn-view-mode').addEventListener('click', () => {
            this._toggleViewMode();
        });

        // Font size quick controls
        document.getElementById('btn-font-up').addEventListener('click', () => this._adjustFontSize(4));
        document.getElementById('btn-font-down').addEventListener('click', () => this._adjustFontSize(-4));
        document.getElementById('btn-center-window')?.addEventListener('click', () => {
            this._centerWindow();
        });

        // Footer quick locale/voice controls
        this._bindQuickLocaleControls();

        // Color dot controls
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                const color = dot.dataset.color;
                this.transcriptUI.configure({ fontColor: color });
            });
        });

        // Start/Stop button
        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.isStarting) return; // Prevent re-entry
            try {
                if (this.isRunning) {
                    await this.stop();
                } else {
                    this.isStarting = true;
                    await this.start();
                }
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                this._showToast(`Error: ${err}`, 'error');
                this.isRunning = false;
                this._updateStartButton();
                this._updateStatus('error');
                this.transcriptUI.clear();
                this.transcriptUI.showPlaceholder();
            } finally {
                this.isStarting = false;
            }
        });

        // Source buttons
        document.getElementById('btn-source-system').addEventListener('click', () => {
            this._setSource('system');
        });

        document.getElementById('btn-source-mic').addEventListener('click', () => {
            this._setSource('microphone');
        });

        // Clear button — save transcript file then clear
        document.getElementById('btn-clear').addEventListener('click', async () => {
            if (this.transcriptUI.hasSegments()) {
                await this._saveTranscriptFile();
            }
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.recordingStartTime = null;
        });

        // Copy transcript button
        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                this._showToast('Copied to clipboard', 'success');
            } else {
                this._showToast('Nothing to copy', 'info');
            }
        });

        // Open saved transcripts folder
        document.getElementById('btn-open-transcripts').addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                this._showToast('Failed to open folder: ' + err, 'error');
            }
        });

        // Settings form elements
        this._bindSettingsForm();

        // Manual drag for settings view
        // data-tauri-drag-region doesn't work well when parent contains buttons
        // Using Tauri's recommended appWindow.startDragging() approach instead
        document.getElementById('settings-view')?.addEventListener('mousedown', (e) => {
            const interactive = e.target.closest('button, input, select, label, a, textarea, .settings-section, .settings-actions');
            if (!interactive && e.buttons === 1) {
                e.preventDefault();
                this.appWindow.startDragging();
            }
        });

        // Toggle API key visibility
        document.getElementById('btn-toggle-key').addEventListener('click', () => {
            const input = document.getElementById('input-api-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Translation mode toggle
        document.getElementById('select-translation-mode').addEventListener('change', (e) => {
            this._updateModeUI(e.target.value);
        });

        // Soniox link
        document.getElementById('link-soniox').addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://console.soniox.com/signup/');
        });

        // ElevenLabs link
        document.getElementById('link-elevenlabs')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://elevenlabs.io/app/sign-up');
        });

        // Save settings — both top and bottom buttons
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            this._saveSettingsFromForm();
        });
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => {
            this._saveSettingsFromForm();
        });

        // Slider live updates
        document.getElementById('range-opacity').addEventListener('input', (e) => {
            document.getElementById('opacity-value').textContent = `${e.target.value}%`;
        });

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = `${e.target.value}px`;
        });

        document.getElementById('range-max-lines').addEventListener('input', (e) => {
            document.getElementById('max-lines-value').textContent = e.target.value;
        });

        // Toggle ElevenLabs API key visibility
        document.getElementById('btn-toggle-elevenlabs-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-elevenlabs-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-tts-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Settings tab switching
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                const tabTargets = (tab.dataset.tab || '')
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean);
                tabTargets.forEach((targetId) => {
                    document.getElementById(targetId)?.classList.add('active');
                });
            });
        });

        // TTS enable/disable toggle in settings — show/hide detail
        document.getElementById('check-tts-enabled')?.addEventListener('change', (e) => {
            const detail = document.getElementById('tts-settings-detail');
            if (detail) detail.style.display = e.target.checked ? '' : 'none';
        });

        // TTS provider toggle — show/hide relevant settings panels
        document.getElementById('select-tts-provider')?.addEventListener('change', (e) => {
            const nextProvider = e.target.value;
            this._updateTTSProviderUI(nextProvider);

            // Apply provider-sensitive filtering with the live selection immediately,
            // not the last persisted settings value.
            const nextSettings = {
                ...settingsManager.get(),
                tts_provider: nextProvider,
            };
            this._syncTranslationVoiceOptions(nextSettings);
            this._syncQuickLocaleControls(nextSettings);
        });

        // Translation target language changes should auto-select/filter voices.
        document.getElementById('select-stream-a-target')?.addEventListener('change', () => {
            const settings = settingsManager.get();
            settings.stream_a_language_target = document.getElementById('select-stream-a-target')?.value || settings.stream_a_language_target || 'vi';
            settings.target_language = settings.stream_a_language_target;
            this._syncTranslationVoiceOptions(settings);
            this._syncDefaultVoiceForStream(settings, 'A', this.currentSource === 'dual' ? 'A' : 'single');
            this._syncQuickLocaleControls(settings);
        });
        document.getElementById('select-stream-b-target')?.addEventListener('change', () => {
            const settings = settingsManager.get();
            settings.stream_b_language_target = document.getElementById('select-stream-b-target')?.value || settings.stream_b_language_target || 'en';
            this._syncTranslationVoiceOptions(settings);
            this._syncDefaultVoiceForStream(settings, 'B', 'B');
            this._syncQuickLocaleControls(settings);
        });

        document.getElementById('check-stream-b-inject')?.addEventListener('change', () => {
            this._syncInjectMixerControls();
        });
        document.getElementById('check-stream-b-mix-original')?.addEventListener('change', () => {
            this._syncInjectMixerControls();
        });

        // TTS speed slider — show value
        document.getElementById('range-tts-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tts-speed-value');
            if (label) label.textContent = e.target.value + 'x';
        });

        // Stream B inject voice speed slider
        document.getElementById('range-stream-b-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('stream-b-edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        // Stream A TTS voice speed slider
        document.getElementById('range-stream-a-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('stream-a-edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        document.getElementById('range-stream-a-google-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('stream-a-google-speed-value');
            const v = parseFloat(e.target.value);
            if (label) label.textContent = `${v.toFixed(1)}x`;
        });

        document.getElementById('range-stream-b-google-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('stream-b-google-speed-value');
            const v = parseFloat(e.target.value);
            if (label) label.textContent = `${v.toFixed(1)}x`;
        });

        document.getElementById('range-stream-a-translated-volume')?.addEventListener('input', (e) => {
            const label = document.getElementById('stream-a-translated-volume-value');
            const v = parseInt(e.target.value, 10);
            if (label) label.textContent = `${v}%`;
        });

        document.getElementById('range-stream-b-original-volume')?.addEventListener('input', (e) => {
            const label = document.getElementById('stream-b-original-volume-value');
            const v = parseInt(e.target.value, 10);
            if (label) label.textContent = `${v}%`;
        });

        document.getElementById('range-stream-b-translated-volume')?.addEventListener('input', (e) => {
            const label = document.getElementById('stream-b-translated-volume-value');
            const v = parseInt(e.target.value, 10);
            if (label) label.textContent = `${v}%`;
        });

        // Ducking level slider
        document.getElementById('range-ducking-level')?.addEventListener('input', (e) => {
            const label = document.getElementById('ducking-level-value');
            if (label) label.textContent = `${e.target.value}%`;
        });

        // Add translation term row
        document.getElementById('btn-add-term')?.addEventListener('click', () => {
            this._addTermRow('', '');
        });

        // TTS toggle button in overlay
        document.getElementById('btn-tts').addEventListener('click', () => {
            this._toggleTTS();
        });

        // Dual Mode toggle button in overlay
        document.getElementById('btn-dual-mode').addEventListener('click', () => {
            this._toggleDualMode();
        });

        // Wire Soniox callbacks
        sonioxClient.onOriginal = (text, speaker) => {
            this.transcriptUI.addOriginal(text, speaker);
        };

        sonioxClient.onTranslation = (text) => {
            this.transcriptUI.addTranslation(text);
            this._speakIfEnabled(text);
        };

        sonioxClient.onProvisional = (text, speaker) => {
            if (text) {
                this.transcriptUI.setProvisional(text, speaker);
            } else {
                this.transcriptUI.clearProvisional();
            }
        };

        sonioxClient.onStatusChange = (status) => {
            this._updateStatus(status);
        };

        sonioxClient.onError = (error) => {
            const msg = String(error || 'Unknown error');
            const isTransient = /reconnecting \(\d+\/\d+\)|request timeout|connection lost unexpectedly|connection closed/i.test(msg);
            if (isTransient) {
                const now = Date.now();
                if (now - this._lastSonioxTransientToastTs < 4500) return;
                this._lastSonioxTransientToastTs = now;
                this._showToast(msg, 'info');
                return;
            }
            this._showToast(msg, 'error');
        };
    }

    _bindSettingsForm() {
        // These are handled in _populateSettingsForm and _saveSettingsFromForm
    }

    _bindQuickLocaleControls() {
        const quickMyLang = document.getElementById('quick-my-language');
        const quickMyVoice = document.getElementById('quick-my-voice');
        const quickMeetingLang = document.getElementById('quick-meeting-language');
        const quickMeetingVoice = document.getElementById('quick-meeting-voice');

        if (quickMyLang) {
            quickMyLang.addEventListener('change', async (e) => {
                try {
                    const settings = settingsManager.get();
                    const value = e.target.value;
                    const voiceStream = this.currentSource === 'dual' ? 'A' : 'single';
                    if (this.currentSource === 'dual') {
                        settings.stream_a_language_target = value;
                    } else {
                        settings.target_language = value;
                        settings.stream_a_language_target = value;
                    }

                    const streamATarget = document.getElementById('select-stream-a-target');
                    const singleTarget = document.getElementById('select-target-lang');
                    if (streamATarget) streamATarget.value = settings.stream_a_language_target;
                    if (singleTarget) singleTarget.value = settings.target_language || settings.stream_a_language_target;

                    this._syncTranslationVoiceOptions(settings);
                    const voiceChanged = this._syncDefaultVoiceForStream(settings, 'A', voiceStream);
                    this._syncQuickLocaleControls(settings);

                    await settingsManager.save(settings);
                    await this._applyQuickRealtimeChanges({
                        languageChanged: true,
                        voiceChanged,
                        stream: voiceStream,
                    });
                } catch (err) {
                    console.error('[QuickControls] Failed to save My Language:', err);
                }
            });
        }

        if (quickMyVoice) {
            quickMyVoice.addEventListener('change', async (e) => {
                try {
                    const settings = settingsManager.get();
                    this._setQuickVoiceInSettings(settings, this.currentSource === 'dual' ? 'A' : 'single', e.target.value);
                    await settingsManager.save(settings);
                    await this._applyQuickRealtimeChanges({
                        languageChanged: false,
                        voiceChanged: true,
                        stream: this.currentSource === 'dual' ? 'A' : 'single',
                    });
                } catch (err) {
                    console.error('[QuickControls] Failed to save My Voice:', err);
                }
            });
        }

        if (quickMeetingLang) {
            quickMeetingLang.addEventListener('change', async (e) => {
                try {
                    const settings = settingsManager.get();
                    settings.stream_b_language_target = e.target.value;

                    const streamBTarget = document.getElementById('select-stream-b-target');
                    if (streamBTarget) streamBTarget.value = settings.stream_b_language_target;

                    this._syncTranslationVoiceOptions(settings);
                    const voiceChanged = this._syncDefaultVoiceForStream(settings, 'B', 'B');
                    this._syncQuickLocaleControls(settings);

                    await settingsManager.save(settings);
                    await this._applyQuickRealtimeChanges({
                        languageChanged: true,
                        voiceChanged,
                        stream: 'B',
                    });
                } catch (err) {
                    console.error('[QuickControls] Failed to save Meeting Language:', err);
                }
            });
        }

        if (quickMeetingVoice) {
            quickMeetingVoice.addEventListener('change', async (e) => {
                try {
                    const settings = settingsManager.get();
                    this._setQuickVoiceInSettings(settings, 'B', e.target.value);
                    await settingsManager.save(settings);
                    await this._applyQuickRealtimeChanges({
                        languageChanged: false,
                        voiceChanged: true,
                        stream: 'B',
                    });
                } catch (err) {
                    console.error('[QuickControls] Failed to save Meeting Voice:', err);
                }
            });
        }

        this._syncQuickLocaleControls(settingsManager.get());
    }

    _setOptionsFromSource(targetSelect, sourceSelect) {
        if (!targetSelect || !sourceSelect) return;
        targetSelect.innerHTML = sourceSelect.innerHTML;
    }

    _languageFlag(langCode) {
        const map = {
            auto: '🌐',
            vi: '🇻🇳',
            en: '🇺🇸',
            ja: '🇯🇵',
            ko: '🇰🇷',
            zh: '🇨🇳',
            fr: '🇫🇷',
            de: '🇩🇪',
            es: '🇪🇸',
            th: '🇹🇭',
            id: '🇮🇩',
        };
        return map[langCode] || '🌐';
    }

    _decorateQuickLanguageOptions(selectEl) {
        if (!selectEl) return;
        Array.from(selectEl.options).forEach((opt) => {
            const flag = this._languageFlag(opt.value);
            const name = (opt.dataset.langName || opt.textContent || '').replace(/^\S+\s+/, '');
            if (!opt.dataset.langName) {
                opt.dataset.langName = name || opt.textContent || '';
            }
            opt.textContent = `${flag} ${opt.dataset.langName}`;
        });
    }

    _renderQuickLanguageCollapsed(selectEl) {
        if (!selectEl) return;
        // Keep full "flag + language" labels in collapsed state.
        // Width control and truncation are handled by CSS to avoid overflow.
        this._decorateQuickLanguageOptions(selectEl);
    }

    _bindQuickLanguageSelectBehavior(selectEl) {
        if (!selectEl || selectEl.dataset.boundQuickLang === '1') return;
        selectEl.dataset.boundQuickLang = '1';

        const restoreLabels = () => {
            this._decorateQuickLanguageOptions(selectEl);
        };
        const collapseToFlag = () => {
            this._renderQuickLanguageCollapsed(selectEl);
        };

        selectEl.addEventListener('mousedown', restoreLabels);
        selectEl.addEventListener('focus', restoreLabels);
        selectEl.addEventListener('change', collapseToFlag);
        selectEl.addEventListener('blur', collapseToFlag);
    }

    _setQuickVoiceInSettings(settings, stream, voiceValue) {
        const provider = settings.tts_provider || 'edge';
        if (provider === 'google') {
            if (stream === 'A') settings.stream_a_google_tts_voice = voiceValue;
            else if (stream === 'B') settings.stream_b_google_tts_voice = voiceValue;
            else {
                settings.google_tts_voice = voiceValue;
                settings.stream_a_google_tts_voice = voiceValue;
            }
        } else if (provider === 'elevenlabs') {
            if (stream === 'A') settings.stream_a_elevenlabs_voice_id = voiceValue;
            else if (stream === 'B') settings.stream_b_elevenlabs_voice_id = voiceValue;
            else {
                settings.tts_voice_id = voiceValue;
                settings.stream_a_elevenlabs_voice_id = voiceValue;
            }
        } else {
            if (stream === 'A') settings.stream_a_edge_tts_voice = voiceValue;
            else if (stream === 'B') settings.stream_b_edge_tts_voice = voiceValue;
            else {
                settings.edge_tts_voice = voiceValue;
                settings.stream_a_edge_tts_voice = voiceValue;
            }
        }
    }

    _getQuickVoiceFromSettings(settings, stream) {
        const provider = settings.tts_provider || 'edge';
        if (provider === 'google') {
            if (stream === 'A') return settings.stream_a_google_tts_voice || settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            if (stream === 'B') return settings.stream_b_google_tts_voice || settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            return settings.stream_a_google_tts_voice || settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        }
        if (provider === 'elevenlabs') {
            if (stream === 'A') return settings.stream_a_elevenlabs_voice_id || settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
            if (stream === 'B') return settings.stream_b_elevenlabs_voice_id || settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
            return settings.stream_a_elevenlabs_voice_id || settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
        }
        if (stream === 'A') return settings.stream_a_edge_tts_voice || settings.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        if (stream === 'B') return settings.stream_b_edge_tts_voice || settings.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        return settings.stream_a_edge_tts_voice || settings.edge_tts_voice || 'vi-VN-HoaiMyNeural';
    }

    _voicePrefixesForLanguage(provider, targetLanguage) {
        if (!targetLanguage) return [];
        if (provider === 'edge') {
            const map = {
                vi: ['vi-VN-'],
                en: ['en-US-'],
                ja: ['ja-JP-'],
                ko: ['ko-KR-'],
                zh: ['zh-CN-'],
                fr: ['fr-FR-'],
                de: ['de-DE-'],
                es: ['es-ES-'],
                th: ['th-TH-'],
                id: ['id-ID-'],
            };
            return map[targetLanguage] || [];
        }
        if (provider === 'google') {
            const map = {
                vi: ['vi-VN-'],
                en: ['en-US-'],
                ja: ['ja-JP-'],
                ko: ['ko-KR-'],
                zh: ['cmn-CN-', 'zh-CN-'],
                fr: ['fr-FR-'],
                de: ['de-DE-'],
                es: ['es-ES-'],
                th: ['th-TH-'],
                id: ['id-ID-'],
            };
            return map[targetLanguage] || [];
        }
        return [];
    }

    _voiceSelectForProvider(provider, stream) {
        const suffix = stream === 'B' ? 'b' : 'a';
        if (provider === 'google') {
            return document.getElementById(`select-stream-${suffix}-google-voice`);
        }
        if (provider === 'elevenlabs') {
            return document.getElementById(`select-stream-${suffix}-elevenlabs-voice`);
        }
        return document.getElementById(`select-stream-${suffix}-edge-voice`);
    }

    _firstVisibleVoiceValue(selectEl) {
        if (!selectEl) return null;
        const visible = Array.from(selectEl.options || []).find((opt) => !opt.hidden && !opt.disabled);
        return visible?.value || null;
    }

    _syncDefaultVoiceForStream(settings, stream, settingsStream) {
        const provider = settings?.tts_provider || 'edge';
        const targetLanguage = stream === 'B'
            ? (settings?.stream_b_language_target || 'en')
            : (settings?.stream_a_language_target || settings?.target_language || 'vi');

        const selectEl = this._voiceSelectForProvider(provider, stream);
        if (!selectEl) return false;

        this._filterVoiceSelectByLanguage(selectEl, provider, targetLanguage);

        const firstVisible = this._firstVisibleVoiceValue(selectEl);
        if (!firstVisible) return false;

        const selectedValid = Array.from(selectEl.options || []).some(
            (opt) => opt.value === selectEl.value && !opt.hidden && !opt.disabled
        );
        const nextVoice = selectedValid ? selectEl.value : firstVisible;
        const prevVoice = this._getQuickVoiceFromSettings(settings, settingsStream);
        selectEl.value = nextVoice;
        this._setQuickVoiceInSettings(settings, settingsStream, nextVoice);
        return prevVoice !== nextVoice;
    }

    _filterVoiceSelectByLanguage(selectEl, provider, targetLanguage) {
        if (!selectEl) return;
        const prefixes = this._voicePrefixesForLanguage(provider, targetLanguage);
        const options = Array.from(selectEl.options || []);

        // ElevenLabs voices are not language-coded in this UI; keep all visible.
        if (provider === 'elevenlabs') {
            options.forEach((opt) => {
                opt.hidden = false;
                opt.disabled = false;
            });
            return;
        }

        // If there is no language-code mapping, do not restrict voice choices.
        if (prefixes.length === 0) {
            options.forEach((opt) => {
                opt.hidden = false;
                opt.disabled = false;
            });
            return;
        }

        let firstVisibleValue = null;
        options.forEach((opt) => {
            const visible = prefixes.some((prefix) => (opt.value || '').startsWith(prefix));
            opt.hidden = !visible;
            opt.disabled = !visible;
            if (visible && firstVisibleValue === null) {
                firstVisibleValue = opt.value;
            }
        });

        // If no voice matches this language in current curated list, fallback to all voices.
        if (firstVisibleValue === null) {
            options.forEach((opt) => {
                opt.hidden = false;
                opt.disabled = false;
            });
            firstVisibleValue = options[0]?.value || null;
        }

        const selectedVisible = options.some((opt) => opt.value === selectEl.value && !opt.hidden && !opt.disabled);
        if (!selectedVisible && firstVisibleValue) {
            selectEl.value = firstVisibleValue;
        }
    }

    _syncTranslationVoiceOptions(settings) {
        const provider = settings?.tts_provider || settingsManager.get().tts_provider || 'edge';
        const langA = settings?.stream_a_language_target
            || settings?.target_language
            || document.getElementById('select-stream-a-target')?.value
            || 'vi';
        const langB = settings?.stream_b_language_target
            || document.getElementById('select-stream-b-target')?.value
            || 'en';

        this._filterVoiceSelectByLanguage(document.getElementById('select-stream-a-edge-voice'), 'edge', langA);
        this._filterVoiceSelectByLanguage(document.getElementById('select-stream-b-edge-voice'), 'edge', langB);
        this._filterVoiceSelectByLanguage(document.getElementById('select-stream-a-google-voice'), 'google', langA);
        this._filterVoiceSelectByLanguage(document.getElementById('select-stream-b-google-voice'), 'google', langB);
        this._filterVoiceSelectByLanguage(document.getElementById('select-stream-a-elevenlabs-voice'), provider, langA);
        this._filterVoiceSelectByLanguage(document.getElementById('select-stream-b-elevenlabs-voice'), provider, langB);
    }

    _syncQuickLocaleControls(settings) {
        const quickMyLang = document.getElementById('quick-my-language');
        const quickMyVoice = document.getElementById('quick-my-voice');
        const quickMeetingLang = document.getElementById('quick-meeting-language');
        const quickMeetingVoice = document.getElementById('quick-meeting-voice');
        const quickMeetingRow = document.getElementById('quick-meeting-row');

        const sourceTarget = document.getElementById('select-target-lang');
        const streamATarget = document.getElementById('select-stream-a-target');
        const streamBTarget = document.getElementById('select-stream-b-target');

        const provider = settings.tts_provider || 'edge';
        const getVoiceSource = (stream) => {
            if (provider === 'google') {
                return document.getElementById(stream === 'B' ? 'select-stream-b-google-voice' : 'select-stream-a-google-voice');
            }
            if (provider === 'elevenlabs') {
                return document.getElementById(stream === 'B' ? 'select-stream-b-elevenlabs-voice' : 'select-stream-a-elevenlabs-voice');
            }
            return document.getElementById(stream === 'B' ? 'select-stream-b-edge-voice' : 'select-stream-a-edge-voice');
        };

        if (quickMyLang) {
            const quickSourceTarget = this.currentSource === 'dual' ? streamATarget : (sourceTarget || streamATarget);
            this._setOptionsFromSource(quickMyLang, quickSourceTarget);
            this._decorateQuickLanguageOptions(quickMyLang);
            this._bindQuickLanguageSelectBehavior(quickMyLang);
            quickMyLang.value = this.currentSource === 'dual'
                ? (settings.stream_a_language_target || 'vi')
                : (settings.target_language || settings.stream_a_language_target || 'vi');
            this._renderQuickLanguageCollapsed(quickMyLang);
        }

        if (quickMyVoice) {
            this._setOptionsFromSource(quickMyVoice, getVoiceSource(this.currentSource === 'dual' ? 'A' : 'A'));
            quickMyVoice.value = this._getQuickVoiceFromSettings(settings, this.currentSource === 'dual' ? 'A' : 'single');
        }

        if (quickMeetingRow) quickMeetingRow.style.display = this.currentSource === 'dual' ? '' : 'none';

        if (this.currentSource === 'dual') {
            if (quickMeetingLang) {
                this._setOptionsFromSource(quickMeetingLang, streamBTarget);
                this._decorateQuickLanguageOptions(quickMeetingLang);
                this._bindQuickLanguageSelectBehavior(quickMeetingLang);
                quickMeetingLang.value = settings.stream_b_language_target || 'en';
                this._renderQuickLanguageCollapsed(quickMeetingLang);
            }
            if (quickMeetingVoice) {
                this._setOptionsFromSource(quickMeetingVoice, getVoiceSource('B'));
                quickMeetingVoice.value = this._getQuickVoiceFromSettings(settings, 'B');
            }
        }
    }

    async _applyQuickRealtimeChanges({ languageChanged = false, voiceChanged = false, stream = 'single' } = {}) {
        const settings = settingsManager.get();

        if (voiceChanged && this.ttsEnabled) {
            const tts = this._getActiveTTS();
            const routeStream = (stream === 'A' || stream === 'B') ? stream : null;
            this._configureTTS(tts, settings, routeStream);

            // ElevenLabs voice is part of WS URL; reconnect to apply immediately.
            if ((settings.tts_provider || 'edge') === 'elevenlabs') {
                tts.disconnect?.();
                tts.connect?.();
            }
        }

        if (!languageChanged || !this.isRunning || this.translationMode === 'local') {
            return;
        }

        if (this.currentSource === 'dual') {
            if ((stream === 'A' || stream === 'single') && this.sonioxClientA) {
                this.sonioxClientA.connect({
                    apiKey: settings.soniox_api_key,
                    sourceLanguage: this.dualConfig.streamA.sourceLanguage,
                    targetLanguage: this.dualConfig.streamA.targetLanguage,
                    customContext: settings.custom_context,
                });
            }
            if ((stream === 'B' || stream === 'single') && this.sonioxClientB) {
                this.sonioxClientB.connect({
                    apiKey: settings.soniox_api_key,
                    sourceLanguage: this.dualConfig.streamB.sourceLanguage,
                    targetLanguage: this.dualConfig.streamB.targetLanguage,
                    customContext: settings.custom_context,
                });
            }
            this._showToast('Updated translation language in realtime', 'info');
            return;
        }

        sonioxClient.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: settings.source_language,
            targetLanguage: settings.target_language,
            customContext: settings.custom_context,
        });
        this._showToast('Updated translation language in realtime', 'info');
    }

    async _applySettingsRealtimeAfterSave(prev, next) {
        if (!this.isRunning) return;

        const prevSource = prev.audio_source === 'both' ? 'dual' : (prev.audio_source || 'system');
        const nextSource = next.audio_source === 'both' ? 'dual' : (next.audio_source || 'system');
        const modeChanged = (prev.translation_mode || 'soniox') !== (next.translation_mode || 'soniox');
        const sourceChanged = prevSource !== nextSource;

        // Capture mode/source change requires full restart to switch pipelines safely.
        if (modeChanged || sourceChanged) {
            this.currentSource = nextSource;
            this.dualModeEnabled = nextSource === 'dual';
            this.transcriptUI.configure({ viewMode: nextSource === 'dual' ? 'dual' : 'single' });
            document.getElementById('btn-view-mode')?.classList.toggle('active', nextSource === 'dual');
            this._updateSourceButtons();

            await this.stop();
            await this.start();
            return;
        }

        const contextChanged = JSON.stringify(prev.custom_context || null) !== JSON.stringify(next.custom_context || null);
        const singleLangChanged =
            prev.source_language !== next.source_language ||
            prev.target_language !== next.target_language;
        const dualLangAChanged =
            prev.stream_a_language_source !== next.stream_a_language_source ||
            prev.stream_a_language_target !== next.stream_a_language_target;
        const dualLangBChanged =
            prev.stream_b_language_source !== next.stream_b_language_source ||
            prev.stream_b_language_target !== next.stream_b_language_target;

        // Reconnect Soniox stream(s) immediately when language/context changes.
        if ((next.translation_mode || 'soniox') !== 'local') {
            if (nextSource === 'dual') {
                if ((dualLangAChanged || contextChanged) && this.sonioxClientA) {
                    this.sonioxClientA.connect({
                        apiKey: next.soniox_api_key,
                        sourceLanguage: next.stream_a_language_source || 'auto',
                        targetLanguage: next.stream_a_language_target || 'vi',
                        customContext: next.custom_context,
                    });
                }
                if ((dualLangBChanged || contextChanged) && this.sonioxClientB) {
                    this.sonioxClientB.connect({
                        apiKey: next.soniox_api_key,
                        sourceLanguage: next.stream_b_language_source || 'auto',
                        targetLanguage: next.stream_b_language_target || 'en',
                        customContext: next.custom_context,
                    });
                }
            } else if (singleLangChanged || contextChanged) {
                sonioxClient.connect({
                    apiKey: next.soniox_api_key,
                    sourceLanguage: next.source_language || 'auto',
                    targetLanguage: next.target_language || 'vi',
                    customContext: next.custom_context,
                });
            }
        }

        const ttsChanged =
            prev.tts_provider !== next.tts_provider ||
            prev.edge_tts_voice !== next.edge_tts_voice ||
            prev.edge_tts_speed !== next.edge_tts_speed ||
            prev.google_tts_voice !== next.google_tts_voice ||
            prev.google_tts_speed !== next.google_tts_speed ||
            prev.tts_voice_id !== next.tts_voice_id ||
            prev.elevenlabs_api_key !== next.elevenlabs_api_key ||
            prev.google_tts_api_key !== next.google_tts_api_key ||
            prev.stream_a_edge_tts_voice !== next.stream_a_edge_tts_voice ||
            prev.stream_a_edge_tts_speed !== next.stream_a_edge_tts_speed ||
            prev.stream_a_google_tts_voice !== next.stream_a_google_tts_voice ||
            prev.stream_a_google_tts_speed !== next.stream_a_google_tts_speed ||
            prev.stream_a_elevenlabs_voice_id !== next.stream_a_elevenlabs_voice_id ||
            prev.stream_b_edge_tts_voice !== next.stream_b_edge_tts_voice ||
            prev.stream_b_edge_tts_speed !== next.stream_b_edge_tts_speed ||
            prev.stream_b_google_tts_voice !== next.stream_b_google_tts_voice ||
            prev.stream_b_google_tts_speed !== next.stream_b_google_tts_speed ||
            prev.stream_b_elevenlabs_voice_id !== next.stream_b_elevenlabs_voice_id;

        // Apply TTS provider/voice changes immediately for ongoing narration.
        if (ttsChanged && this.ttsEnabled) {
            elevenLabsTTS.disconnect();
            edgeTTSRust.disconnect();
            googleTTS.disconnect();

            const tts = this._getActiveTTS();
            this._configureTTS(tts, next, nextSource === 'dual' ? 'A' : null);
            tts.connect?.();
            audioPlayer.resume();
        }

        // Apply mixer settings changes immediately
        const mixerChanged = JSON.stringify(prev.mixer) !== JSON.stringify(next.mixer);
        if (mixerChanged && next.mixer) {
            try {
                await invoke('mixer_update_settings', {
                    enabled: next.mixer.enabled !== false,
                    duckingLevel: next.mixer.ducking_level ?? 0.2,
                    vadSensitivity: next.mixer.vad_sensitivity || 'medium',
                });
            } catch (e) {
                console.warn('[Mixer] Failed to update settings:', e);
            }
        }
    }

    // ─── Keyboard Shortcuts ─────────────────────────────────

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ignore when typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Cmd/Ctrl + Enter: Start/Stop
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.isStarting) return;
                (async () => {
                    try {
                        if (this.isRunning) {
                            await this.stop();
                        } else {
                            this.isStarting = true;
                            await this.start();
                        }
                    } catch (err) {
                        console.error('[App] Keyboard start/stop error:', err);
                        this._showToast(`Error: ${err}`, 'error');
                        this.isRunning = false;
                        this._updateStartButton();
                        this._updateStatus('error');
                    } finally {
                        this.isStarting = false;
                    }
                })();
            }

            // Escape: Go back to overlay / close settings
            if (e.key === 'Escape') {
                e.preventDefault();
                const settingsVisible = document.getElementById('settings-view').classList.contains('active');
                if (settingsVisible) {
                    this._showView('overlay');
                }
            }

            // Cmd/Ctrl + ,: Open settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            // Cmd/Ctrl + 1: Switch to System Audio
            if ((e.metaKey || e.ctrlKey) && e.key === '1') {
                e.preventDefault();
                this._setSource('system');
            }

            // Cmd/Ctrl + 2: Switch to Microphone
            if ((e.metaKey || e.ctrlKey) && e.key === '2') {
                e.preventDefault();
                this._setSource('microphone');
            }

            // Cmd/Ctrl + T: Toggle TTS
            if ((e.metaKey || e.ctrlKey) && e.key === 't') {
                e.preventDefault();
                this._toggleTTS();
            }

            // Cmd/Ctrl + M: Minimize
            if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                e.preventDefault();
                this._saveWindowPosition();
                this.appWindow.minimize();
            }

            // Cmd/Ctrl + P: Toggle Pin
            if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
                e.preventDefault();
                this._togglePin();
            }

            // Cmd/Ctrl + D: Toggle Compact
            if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
                e.preventDefault();
                this._toggleCompact();
            }

            // Cmd/Ctrl + B: Switch to Dual Conversation mode
            if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
                e.preventDefault();
                this._setSource('dual');
            }
        });
    }

    // ─── Views ──────────────────────────────────────────────

    _showView(view) {
        document.getElementById('overlay-view').classList.toggle('active', view === 'overlay');
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');

        if (view === 'settings') {
            this._populateSettingsForm();
        }
    }

    // ─── Settings Form ─────────────────────────────────────

    _populateSettingsForm() {
        const s = settingsManager.get();

        document.getElementById('input-api-key').value = s.soniox_api_key || '';
        const singleSource = document.getElementById('select-source-lang');
        if (singleSource) singleSource.value = s.source_language || 'auto';
        const singleTarget = document.getElementById('select-target-lang');
        if (singleTarget) singleTarget.value = s.target_language || 'vi';
        document.getElementById('select-translation-mode').value = s.translation_mode || 'soniox';
        this._updateModeUI(s.translation_mode || 'soniox');

        // Display
        const opacityPercent = Math.round((s.overlay_opacity || 0.85) * 100);
        document.getElementById('range-opacity').value = opacityPercent;
        document.getElementById('opacity-value').textContent = `${opacityPercent}%`;

        document.getElementById('range-font-size').value = s.font_size || 16;
        document.getElementById('font-size-value').textContent = `${s.font_size || 16}px`;

        document.getElementById('range-max-lines').value = s.max_lines || 5;
        document.getElementById('max-lines-value').textContent = s.max_lines || 5;

        document.getElementById('check-show-original').checked = s.show_original !== false;

        // Custom context
        const ctx = s.custom_context;
        document.getElementById('input-context-domain').value = ctx?.domain || '';
        // Load translation terms as rows
        const termsList = document.getElementById('translation-terms-list');
        if (termsList) {
            termsList.innerHTML = '';
            const terms = ctx?.translation_terms || [];
            terms.forEach(t => this._addTermRow(t.source, t.target));
        }

        // TTS settings
        document.getElementById('input-elevenlabs-key').value = s.elevenlabs_api_key || '';
        // Google TTS settings
        const googleKeyInput = document.getElementById('input-google-tts-key');
        if (googleKeyInput) googleKeyInput.value = s.google_tts_api_key || '';

        // TTS provider
        const providerSelect = document.getElementById('select-tts-provider');
        if (providerSelect) {
            providerSelect.value = s.tts_provider || 'edge';
            this._updateTTSProviderUI(providerSelect.value);
        }

        // Dual mode settings
        const selStreamASrc = document.getElementById('select-stream-a-source');
        if (selStreamASrc) selStreamASrc.value = s.stream_a_language_source || 'auto';
        const selStreamATgt = document.getElementById('select-stream-a-target');
        if (selStreamATgt) selStreamATgt.value = s.stream_a_language_target || 'vi';
        const checkStreamATts = document.getElementById('check-stream-a-tts');
        if (checkStreamATts) {
            checkStreamATts.checked = this.ttsEnabled;
            checkStreamATts.disabled = true;
            checkStreamATts.title = 'Controlled by Header TTS toggle';
        }
        const streamATranslatedVolume = Number.isFinite(s.stream_a_translated_volume)
            ? s.stream_a_translated_volume
            : 1.0;
        const streamAVolumeSlider = document.getElementById('range-stream-a-translated-volume');
        const streamAVolumeLabel = document.getElementById('stream-a-translated-volume-value');
        if (streamAVolumeSlider) streamAVolumeSlider.value = Math.round(streamATranslatedVolume * 100);
        if (streamAVolumeLabel) streamAVolumeLabel.textContent = `${Math.round(streamATranslatedVolume * 100)}%`;
        const selStreamBSrc = document.getElementById('select-stream-b-source');
        if (selStreamBSrc) selStreamBSrc.value = s.stream_b_language_source || 'auto';
        const selStreamBTgt = document.getElementById('select-stream-b-target');
        if (selStreamBTgt) selStreamBTgt.value = s.stream_b_language_target || 'en';
        const checkStreamBTts = document.getElementById('check-stream-b-tts');
        if (checkStreamBTts) checkStreamBTts.checked = s.stream_b_tts_enabled !== false;
        const checkStreamBInject = document.getElementById('check-stream-b-inject');
        if (checkStreamBInject) checkStreamBInject.checked = s.stream_b_inject_enabled || false;
        const checkStreamBMixOriginal = document.getElementById('check-stream-b-mix-original');
        if (checkStreamBMixOriginal) checkStreamBMixOriginal.checked = s.stream_b_mix_original_enabled || false;
        const streamBOriginalVolume = Number.isFinite(s.stream_b_original_volume)
            ? s.stream_b_original_volume
            : 0.5;
        const streamBOriginalSlider = document.getElementById('range-stream-b-original-volume');
        const streamBOriginalLabel = document.getElementById('stream-b-original-volume-value');
        if (streamBOriginalSlider) streamBOriginalSlider.value = Math.round(streamBOriginalVolume * 100);
        if (streamBOriginalLabel) streamBOriginalLabel.textContent = `${Math.round(streamBOriginalVolume * 100)}%`;
        const streamBTranslatedVolume = Number.isFinite(s.stream_b_translated_volume)
            ? s.stream_b_translated_volume
            : 1.0;
        const streamBTranslatedSlider = document.getElementById('range-stream-b-translated-volume');
        const streamBTranslatedLabel = document.getElementById('stream-b-translated-volume-value');
        if (streamBTranslatedSlider) streamBTranslatedSlider.value = Math.round(streamBTranslatedVolume * 100);
        if (streamBTranslatedLabel) streamBTranslatedLabel.textContent = `${Math.round(streamBTranslatedVolume * 100)}%`;
        const streamBVoice = document.getElementById('select-stream-b-edge-voice');
        if (streamBVoice) streamBVoice.value = s.stream_b_edge_tts_voice || s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const streamBSpeedSlider = document.getElementById('range-stream-b-edge-speed');
        const streamBSpeedLabel = document.getElementById('stream-b-edge-speed-value');
        const streamBSpeed = s.stream_b_edge_tts_speed !== undefined
            ? s.stream_b_edge_tts_speed
            : (s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20);
        if (streamBSpeedSlider) streamBSpeedSlider.value = streamBSpeed;
        if (streamBSpeedLabel) streamBSpeedLabel.textContent = (streamBSpeed >= 0 ? '+' : '') + streamBSpeed + '%';

        // Stream A per-provider voices
        const streamAEdgeVoice = document.getElementById('select-stream-a-edge-voice');
        if (streamAEdgeVoice) streamAEdgeVoice.value = s.stream_a_edge_tts_voice || s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const streamASpeedSlider = document.getElementById('range-stream-a-edge-speed');
        const streamASpeedLabel = document.getElementById('stream-a-edge-speed-value');
        const streamASpeed = s.stream_a_edge_tts_speed !== undefined
            ? s.stream_a_edge_tts_speed
            : (s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20);
        if (streamASpeedSlider) streamASpeedSlider.value = streamASpeed;
        if (streamASpeedLabel) streamASpeedLabel.textContent = (streamASpeed >= 0 ? '+' : '') + streamASpeed + '%';
        const streamAGoogleVoice = document.getElementById('select-stream-a-google-voice');
        if (streamAGoogleVoice) streamAGoogleVoice.value = s.stream_a_google_tts_voice || s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        const streamAGoogleSpeedSlider = document.getElementById('range-stream-a-google-speed');
        const streamAGoogleSpeedLabel = document.getElementById('stream-a-google-speed-value');
        const streamAGoogleSpeed = s.stream_a_google_tts_speed !== undefined
            ? s.stream_a_google_tts_speed
            : (s.google_tts_speed !== undefined ? s.google_tts_speed : 1.0);
        if (streamAGoogleSpeedSlider) streamAGoogleSpeedSlider.value = streamAGoogleSpeed;
        if (streamAGoogleSpeedLabel) streamAGoogleSpeedLabel.textContent = `${Number(streamAGoogleSpeed).toFixed(1)}x`;
        const streamAElevenLabsVoice = document.getElementById('select-stream-a-elevenlabs-voice');
        if (streamAElevenLabsVoice) streamAElevenLabsVoice.value = s.stream_a_elevenlabs_voice_id || s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';

        // Stream B additional voices (google + elevenlabs)
        const streamBGoogleVoice = document.getElementById('select-stream-b-google-voice');
        if (streamBGoogleVoice) streamBGoogleVoice.value = s.stream_b_google_tts_voice || s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        const streamBGoogleSpeedSlider = document.getElementById('range-stream-b-google-speed');
        const streamBGoogleSpeedLabel = document.getElementById('stream-b-google-speed-value');
        const streamBGoogleSpeed = s.stream_b_google_tts_speed !== undefined
            ? s.stream_b_google_tts_speed
            : (s.google_tts_speed !== undefined ? s.google_tts_speed : 1.0);
        if (streamBGoogleSpeedSlider) streamBGoogleSpeedSlider.value = streamBGoogleSpeed;
        if (streamBGoogleSpeedLabel) streamBGoogleSpeedLabel.textContent = `${Number(streamBGoogleSpeed).toFixed(1)}x`;
        const streamBElevenLabsVoice = document.getElementById('select-stream-b-elevenlabs-voice');
        if (streamBElevenLabsVoice) streamBElevenLabsVoice.value = s.stream_b_elevenlabs_voice_id || s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
        this._syncTranslationVoiceOptions(s);
        // Mixer settings
        const mixerCfg = s.mixer || {};
        const mixerEnabled = document.getElementById('check-mixer-enabled');
        if (mixerEnabled) mixerEnabled.checked = mixerCfg.enabled !== false;
        const duckingSlider = document.getElementById('range-ducking-level');
        const duckingLabel = document.getElementById('ducking-level-value');
        const duckingPct = Math.round((mixerCfg.ducking_level ?? 0.2) * 100);
        if (duckingSlider) duckingSlider.value = duckingPct;
        if (duckingLabel) duckingLabel.textContent = `${duckingPct}%`;
        const vadSelect = document.getElementById('select-vad-sensitivity');
        if (vadSelect) vadSelect.value = mixerCfg.vad_sensitivity || 'medium';
        this._syncInjectMixerControls();
    }

    _syncInjectMixerControls() {
        const checkInject = document.getElementById('check-stream-b-inject');
        const checkMixOriginal = document.getElementById('check-stream-b-mix-original');

        const injectEnabled = checkInject?.checked === true;
        if (checkMixOriginal) {
            if (!injectEnabled) {
                checkMixOriginal.checked = false;
            }
            checkMixOriginal.disabled = !injectEnabled;
        }

        const mixOriginalEnabled = checkMixOriginal?.checked === true;

        const mixerEnabled = document.getElementById('check-mixer-enabled');
        const duckingSlider = document.getElementById('range-ducking-level');
        const vadSelect = document.getElementById('select-vad-sensitivity');
        const mixerStats = document.getElementById('mixer-stats-section');

        if (mixerEnabled) {
            if (!mixOriginalEnabled) mixerEnabled.checked = false;
            mixerEnabled.disabled = !mixOriginalEnabled;
        }
        if (duckingSlider) duckingSlider.disabled = !mixOriginalEnabled;
        if (vadSelect) vadSelect.disabled = !mixOriginalEnabled;
        if (mixerStats) mixerStats.style.opacity = mixOriginalEnabled ? '1' : '0.5';
    }

    async _saveSettingsFromForm() {
        const prevSettings = settingsManager.get();
        const settings = {
            soniox_api_key: document.getElementById('input-api-key').value.trim(),
            source_language: document.getElementById('select-stream-a-source')?.value || document.getElementById('select-source-lang')?.value || 'auto',
            target_language: document.getElementById('select-stream-a-target')?.value || document.getElementById('select-target-lang')?.value || 'vi',
            translation_mode: document.getElementById('select-translation-mode').value,
            // Audio source is controlled from overlay buttons, not settings.
            audio_source: this.currentSource,
            overlay_opacity: parseInt(document.getElementById('range-opacity').value) / 100,
            font_size: parseInt(document.getElementById('range-font-size').value),
            max_lines: parseInt(document.getElementById('range-max-lines').value),
            show_original: document.getElementById('check-show-original').checked,
            custom_context: null,
        };

        // Parse custom context
        const domain = document.getElementById('input-context-domain').value.trim();
        const translationTerms = [];
        document.querySelectorAll('#translation-terms-list .term-row').forEach(row => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) translationTerms.push({ source, target });
        });

        if (domain || translationTerms.length > 0) {
            settings.custom_context = {
                domain: domain || null,
                translation_terms: translationTerms,
            };
        }

        // TTS settings
        settings.tts_provider = document.getElementById('select-tts-provider')?.value || 'edge';
        settings.elevenlabs_api_key = document.getElementById('input-elevenlabs-key').value.trim();
        settings.tts_voice_id = document.getElementById('select-stream-a-elevenlabs-voice')?.value
            || prevSettings.stream_a_elevenlabs_voice_id
            || prevSettings.tts_voice_id
            || '21m00Tcm4TlvDq8ikWAM';
        settings.edge_tts_voice = document.getElementById('select-stream-a-edge-voice')?.value
            || prevSettings.stream_a_edge_tts_voice
            || prevSettings.edge_tts_voice
            || 'vi-VN-HoaiMyNeural';
        settings.edge_tts_speed = prevSettings.edge_tts_speed !== undefined ? prevSettings.edge_tts_speed : 20;
        settings.tts_speed = parseFloat(document.getElementById('range-tts-speed')?.value || 1.2);
        settings.google_tts_api_key = document.getElementById('input-google-tts-key')?.value.trim() || '';
        settings.google_tts_voice = document.getElementById('select-stream-a-google-voice')?.value
            || prevSettings.stream_a_google_tts_voice
            || prevSettings.google_tts_voice
            || 'vi-VN-Chirp3-HD-Aoede';
        settings.google_tts_speed = parseFloat(
            document.getElementById('range-stream-a-google-speed')?.value
            ?? prevSettings.stream_a_google_tts_speed
            ?? prevSettings.google_tts_speed
            ?? 1.0
        );
        settings.tts_enabled = this.ttsEnabled;

        // Dual mode settings
        settings.audio_source = settings.audio_source === 'both' ? 'dual' : settings.audio_source;
        settings.dual_mode_enabled = this.currentSource === 'dual';
        settings.stream_a_language_source = document.getElementById('select-stream-a-source')?.value || 'auto';
        settings.stream_a_language_target = document.getElementById('select-stream-a-target')?.value || 'vi';
        settings.stream_a_tts_enabled = this.ttsEnabled;
        settings.stream_a_translated_volume = parseInt(
            document.getElementById('range-stream-a-translated-volume')?.value || 100,
            10
        ) / 100;
        settings.stream_b_language_source = document.getElementById('select-stream-b-source')?.value || 'auto';
        settings.stream_b_language_target = document.getElementById('select-stream-b-target')?.value || 'en';
        settings.stream_b_tts_enabled = document.getElementById('check-stream-b-tts')?.checked !== false;
        settings.stream_b_inject_enabled = document.getElementById('check-stream-b-inject')?.checked || false;
        settings.stream_b_mix_original_enabled = settings.stream_b_inject_enabled && (document.getElementById('check-stream-b-mix-original')?.checked || false);
        settings.stream_b_original_volume = parseInt(
            document.getElementById('range-stream-b-original-volume')?.value || 100,
            10
        ) / 100;
        settings.stream_b_translated_volume = parseInt(
            document.getElementById('range-stream-b-translated-volume')?.value || 100,
            10
        ) / 100;
        settings.stream_b_edge_tts_voice = document.getElementById('select-stream-b-edge-voice')?.value
            || settings.edge_tts_voice
            || 'vi-VN-HoaiMyNeural';
        settings.stream_b_edge_tts_speed = parseInt(
            document.getElementById('range-stream-b-edge-speed')?.value
            || settings.edge_tts_speed
            || 20
        );
        settings.stream_a_edge_tts_voice = document.getElementById('select-stream-a-edge-voice')?.value
            || settings.edge_tts_voice
            || 'vi-VN-HoaiMyNeural';
        settings.stream_a_edge_tts_speed = parseInt(
            document.getElementById('range-stream-a-edge-speed')?.value
            ?? settings.edge_tts_speed
            ?? 20
        );
        settings.stream_a_google_tts_voice = document.getElementById('select-stream-a-google-voice')?.value
            || settings.google_tts_voice
            || 'vi-VN-Chirp3-HD-Aoede';
        settings.stream_a_google_tts_speed = parseFloat(
            document.getElementById('range-stream-a-google-speed')?.value
            ?? settings.google_tts_speed
            ?? 1.0
        );
        settings.stream_a_elevenlabs_voice_id = document.getElementById('select-stream-a-elevenlabs-voice')?.value
            || settings.tts_voice_id
            || '21m00Tcm4TlvDq8ikWAM';
        settings.stream_b_google_tts_voice = document.getElementById('select-stream-b-google-voice')?.value
            || settings.google_tts_voice
            || 'vi-VN-Chirp3-HD-Aoede';
        settings.stream_b_google_tts_speed = parseFloat(
            document.getElementById('range-stream-b-google-speed')?.value
            ?? settings.google_tts_speed
            ?? 1.0
        );
        settings.stream_b_elevenlabs_voice_id = document.getElementById('select-stream-b-elevenlabs-voice')?.value
            || settings.tts_voice_id
            || '21m00Tcm4TlvDq8ikWAM';


        // Mixer settings
        const duckingPctVal = parseInt(document.getElementById('range-ducking-level')?.value ?? 20);
        const mixerCanEnable = settings.stream_b_mix_original_enabled;
        settings.mixer = {
            enabled: mixerCanEnable && (document.getElementById('check-mixer-enabled')?.checked !== false),
            ducking_level: duckingPctVal / 100,
            vad_sensitivity: document.getElementById('select-vad-sensitivity')?.value || 'medium',
            detection_threshold: (prevSettings.mixer || {}).detection_threshold ?? -40.0,
        };

        const nextSettings = { ...prevSettings, ...settings };

        try {
            await settingsManager.save(settings);
            await this._applySettingsRealtimeAfterSave(prevSettings, nextSettings);
            this._showToast('Settings saved', 'success');
            this._showView('overlay');
        } catch (err) {
            this._showToast(`Failed to save: ${err}`, 'error');
        }
    }

    // ─── Apply Settings ────────────────────────────────────

    _applySettings(settings) {
        // Update overlay opacity
        const overlayView = document.getElementById('overlay-view');
        overlayView.style.opacity = settings.overlay_opacity || 0.85;

        // Update transcript UI
        if (this.transcriptUI) {
            this.transcriptUI.configure({
                maxLines: settings.max_lines || 5,
                showOriginal: settings.show_original !== false,
                fontSize: settings.font_size || 16,
            });
        }

        // Update current source button states
        this.currentSource = settings.audio_source === 'both' ? 'dual' : (settings.audio_source || 'system');
        this._updateSourceButtons();

        // Restore persisted global TTS toggle on first settings application.
        if (!this._initialSettingsApplied) {
            this.ttsEnabled = settings.tts_enabled === true;
            this._initialSettingsApplied = true;
        }
        this._updateTTSButton();

        // Sync dualConfig from persisted settings
        this.dualConfig = {
            streamA: {
                sourceLanguage: settings.stream_a_language_source || 'auto',
                targetLanguage: settings.stream_a_language_target || 'vi',
                // Stream A follows the header/global TTS toggle.
                ttsEnabled: this.ttsEnabled,
                translatedVolume: Number.isFinite(settings.stream_a_translated_volume)
                    ? settings.stream_a_translated_volume
                    : 1.0,
                edgeVoice: settings.stream_a_edge_tts_voice || settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                edgeSpeed: settings.stream_a_edge_tts_speed !== undefined
                    ? settings.stream_a_edge_tts_speed
                    : (settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20),
                googleVoice: settings.stream_a_google_tts_voice || settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede',
                googleSpeed: settings.stream_a_google_tts_speed !== undefined
                    ? settings.stream_a_google_tts_speed
                    : (settings.google_tts_speed !== undefined ? settings.google_tts_speed : 1.0),
                elevenLabsVoiceId: settings.stream_a_elevenlabs_voice_id || settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            },
            streamB: {
                sourceLanguage: settings.stream_b_language_source || 'auto',
                targetLanguage: settings.stream_b_language_target || 'en',
                ttsEnabled: settings.stream_b_tts_enabled !== false,
                injectEnabled: settings.stream_b_inject_enabled || false,
                mixOriginalEnabled: settings.stream_b_mix_original_enabled || false,
                originalVolume: Number.isFinite(settings.stream_b_original_volume)
                    ? settings.stream_b_original_volume
                    : 0.5,
                translatedVolume: Number.isFinite(settings.stream_b_translated_volume)
                    ? settings.stream_b_translated_volume
                    : 1.0,
                edgeVoice: settings.stream_b_edge_tts_voice || settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                edgeSpeed: settings.stream_b_edge_tts_speed !== undefined
                    ? settings.stream_b_edge_tts_speed
                    : (settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20),
                googleVoice: settings.stream_b_google_tts_voice || settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede',
                googleSpeed: settings.stream_b_google_tts_speed !== undefined
                    ? settings.stream_b_google_tts_speed
                    : (settings.google_tts_speed !== undefined ? settings.google_tts_speed : 1.0),
                elevenLabsVoiceId: settings.stream_b_elevenlabs_voice_id || settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            },
        };

        // Dual mode button reflects saved setting
        this.dualModeEnabled = this.currentSource === 'dual' || settings.dual_mode_enabled || false;
        this._updateDualModeButton();

        if (!this.isRunning) {
            // Mixer stats removed
        }
    }

    // ─── TTS Control ──────────────────────────────────────

    _toggleTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';

        // Check API key for premium providers
        if (provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('Add ElevenLabs API key in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            this._showToast('Add Google TTS API key in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }

        this.ttsEnabled = !this.ttsEnabled;
        this._updateTTSButton();

        // Persist global single-stream toggle so system/microphone stay consistent.
        settingsManager.save({ tts_enabled: this.ttsEnabled }).catch((err) => {
            console.warn('[Settings] Failed to persist tts_enabled:', err);
        });

        const tts = this._getActiveTTS();
        const keepDualStreamBTts =
            this.isRunning &&
            this.currentSource === 'dual' &&
            this.dualConfig?.streamB?.ttsEnabled;

        if (this.ttsEnabled) {
            this._configureTTS(tts, settings);
            if (this.isRunning) {
                tts.connect();
                audioPlayer.resume();
            }
            const label = { edge: 'Edge TTS (Free)', google: 'Google Chirp 3 HD', elevenlabs: 'ElevenLabs' }[provider] || provider;
            this._showToast(`TTS narration ON 🔊 (${label})`, 'success');
        } else {
            if (keepDualStreamBTts) {
                // Header TTS controls single mode + Stream A only; keep Stream B alive in dual mode.
                this._configureTTS(tts, settings, 'B');
                tts.connect?.();
                audioPlayer.resume();
                this._showToast('TTS OFF for Single/Stream A; Stream B remains ON', 'success');
            } else {
                tts.disconnect();
                audioPlayer.stop();
                this._showToast('TTS narration OFF 🔇', 'success');
            }
        }
    }

    _getActiveTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';
        if (provider === 'elevenlabs') return elevenLabsTTS;
        if (provider === 'google') return googleTTS;
        return edgeTTSRust;
    }

    _configureTTS(tts, settings, stream = null) {
        const provider = settings.tts_provider || 'edge';
        const cfg = stream === 'A' ? this.dualConfig.streamA
                  : stream === 'B' ? this.dualConfig.streamB
                  : null;
        if (provider === 'elevenlabs') {
            tts.configure({
                apiKey: settings.elevenlabs_api_key,
                voiceId: cfg?.elevenLabsVoiceId || settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            });
        } else if (provider === 'google') {
            const voice = cfg?.googleVoice || settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            const langCode = voice.replace(/-Chirp3.*/, '');
            tts.configure({
                apiKey: settings.google_tts_api_key,
                voice: voice,
                languageCode: langCode,
                speakingRate: cfg?.googleSpeed || settings.google_tts_speed || 1.0,
            });
        } else {
            tts.configure({
                voice: cfg?.edgeVoice || settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                speed: cfg?.edgeSpeed !== undefined ? cfg.edgeSpeed
                     : (settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20),
            });
        }
    }

    _addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'term-row';
        row.innerHTML = `<input type="text" class="term-source" value="${source}" placeholder="Source" />` +
            `<input type="text" class="term-target" value="${target}" placeholder="Target" />` +
            `<button type="button" class="btn-remove-term" title="Remove">×</button>`;
        row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _updateTTSProviderUI(provider) {
        const ed = document.getElementById('tts-edge-settings');
        const go = document.getElementById('tts-google-settings');
        const el = document.getElementById('tts-elevenlabs-settings');
        if (ed) ed.style.display = provider === 'edge' ? '' : 'none';
        if (go) go.style.display = provider === 'google' ? '' : 'none';
        if (el) el.style.display = provider === 'elevenlabs' ? '' : 'none';
        // Per-stream voice sections
        for (const s of ['a', 'b']) {
            const sEdge = document.getElementById(`stream-${s}-tts-voice-edge`);
            const sGoogle = document.getElementById(`stream-${s}-tts-voice-google`);
            const sEl = document.getElementById(`stream-${s}-tts-voice-elevenlabs`);
            if (sEdge) sEdge.style.display = provider === 'edge' ? '' : 'none';
            if (sGoogle) sGoogle.style.display = provider === 'google' ? '' : 'none';
            if (sEl) sEl.style.display = provider === 'elevenlabs' ? '' : 'none';
        }
        // Update hint text
        const hint = document.getElementById('tts-provider-hint');
        if (hint) {
            const hints = {
                edge: 'Free, natural voices — no API key needed',
                google: 'Near-human quality — requires Google Cloud API key (1M chars/month free)',
                elevenlabs: 'Premium quality — requires ElevenLabs API key',
            };
            hint.textContent = hints[provider] || '';
        }
    }

    _updateTTSButton() {
        const btn = document.getElementById('btn-tts');
        const iconOff = document.getElementById('icon-tts-off');
        const iconOn = document.getElementById('icon-tts-on');

        if (btn) btn.classList.toggle('active', this.ttsEnabled);
        if (iconOff) iconOff.style.display = this.ttsEnabled ? 'none' : 'block';
        if (iconOn) iconOn.style.display = this.ttsEnabled ? 'block' : 'none';

        const checkStreamATts = document.getElementById('check-stream-a-tts');
        if (checkStreamATts) {
            checkStreamATts.checked = this.ttsEnabled;
            checkStreamATts.disabled = true;
            checkStreamATts.title = 'Controlled by Header TTS toggle';
        }
    }

    _speakIfEnabled(text) {
        if (!this.ttsEnabled || !text?.trim()) return;
        const stream = this.currentSource === 'dual' ? null : 'single';
        this._enqueueTtsText(text.trim(), { stream: stream || 'single', inject: false, playLocal: true });
    }

    _speakWithRouting(text, options = {}) {
        if (!text?.trim()) return;
        const stream = options?.stream;
        const resolvedOptions = (stream === 'B')
            ? { ...options, bypassGlobalToggle: true }
            : options;
        this._enqueueTtsText(text.trim(), resolvedOptions);
    }

    /**
     * Push translated text into the TTS queue. Does NOT call TTS directly.
     * The independent pump loop will process it later.
     */
    _enqueueTtsText(text, options) {
        this._ttsTextQueue.push({ text, options });
        // Cap queue to prevent unbounded growth
        if (this._ttsTextQueue.length > 30) {
            this._ttsTextQueue.splice(0, this._ttsTextQueue.length - 20);
        }
        this._scheduleTtsPump();
    }

    /**
     * Schedule the TTS pump on the next event-loop turn, fully decoupled
     * from the Soniox/translation callback chain.
     */
    _scheduleTtsPump() {
        const now = Date.now();
        // Recover from stale pump state after source switching/restart races.
        if (
            this._ttsQueuePumping &&
            this._ttsPumpHeartbeat > 0 &&
            (now - this._ttsPumpHeartbeat) > 3000
        ) {
            console.warn('[TTS] Pump appears stalled; resetting queue pump state');
            this._resetTtsQueueState({ clearQueue: false });
        }

        if (this._ttsQueuePumping) return;
        this._ttsQueuePumping = true;
        this._ttsPumpHeartbeat = now;
        const token = this._ttsPumpToken;
        setTimeout(() => this._runTtsPump(token), 0);
    }

    /**
     * Async pump: processes TTS queue items one by one.
     * Runs independently of audio capture and Soniox callbacks.
     */
    async _runTtsPump(token) {
        if (token !== this._ttsPumpToken) return;

        try {
            while (this._ttsTextQueue.length > 0 && this.isRunning) {
                if (token !== this._ttsPumpToken) break;
                const { text, options } = this._ttsTextQueue.shift();
                if (!this.ttsEnabled && !(options?.bypassGlobalToggle)) continue;

                this._ttsPumpHeartbeat = Date.now();

                const tts = this._getActiveTTS();
                const settings = settingsManager.get();
                const stream = options?.stream;
                this._configureTTS(tts, settings, (stream === 'A' || stream === 'B') ? stream : null);

                if (!tts.isConnected) {
                    tts.connect?.();
                }

                tts.speak(text, options);

                // Yield to event loop between items so audio callbacks are never starved
                await new Promise(r => setTimeout(r, 0));
            }
        } finally {
            if (token !== this._ttsPumpToken) return;
            this._ttsQueuePumping = false;
            this._ttsPumpHeartbeat = 0;
            // If new items arrived while we were processing, restart
            if (this._ttsTextQueue.length > 0 && this.isRunning) {
                this._scheduleTtsPump();
            }
        }
    }

    _resetTtsQueueState({ clearQueue = false } = {}) {
        this._ttsPumpToken += 1;
        this._ttsQueuePumping = false;
        this._ttsPumpHeartbeat = 0;
        if (clearQueue) {
            this._ttsTextQueue = [];
        }
    }

    async _handleTtsAudioChunk(base64Audio, meta) {
        if (!base64Audio) return;

        const route = meta || {};
        const inject = route.inject === true;
        const playLocal = route.playLocal !== false;
        const stream = route.stream || 'single';

        if (playLocal) {
            let gain = 1.0;
            if (stream === 'A') {
                gain = this._clampVolume(this.dualConfig.streamA.translatedVolume, 1.0);
            }
            await audioPlayer.enqueue(base64Audio, gain);
        }

        if (inject) {
            await this._injectAudioChunk(
                base64Audio,
                stream,
                this._clampVolume(this.dualConfig.streamB.translatedVolume, 1.0)
            );
        }
    }

    _clampVolume(value, fallback = 1.0) {
        if (!Number.isFinite(value)) return fallback;
        return Math.max(0, Math.min(2, value));
    }

    _scalePcm16Bytes(pcmData, gain) {
        const clampedGain = this._clampVolume(gain, 1.0);
        if (Math.abs(clampedGain - 1.0) < 0.0001) {
            return Array.isArray(pcmData) ? pcmData : Array.from(new Uint8Array(pcmData));
        }

        const bytes = Array.isArray(pcmData) ? new Uint8Array(pcmData) : new Uint8Array(pcmData);
        const samples = new Int16Array(bytes.buffer.slice(0));
        for (let i = 0; i < samples.length; i++) {
            const scaled = Math.round(samples[i] * clampedGain);
            samples[i] = Math.max(-32768, Math.min(32767, scaled));
        }
        return Array.from(new Uint8Array(samples.buffer));
    }

    async _injectPcmBytesNow(pcmData, stream, volume = 1.0, channel = 'translated') {
        const scaledPcm = this._scalePcm16Bytes(pcmData, volume);
        if (!scaledPcm || scaledPcm.length < 2) return;
        if (scaledPcm.length % 2 !== 0) {
            scaledPcm.pop();
            if (scaledPcm.length < 2) return;
        }

        // Send in fixed windows to avoid large IPC payload spikes on long translated chunks.
        const INJECT_CHUNK_BYTES = 6400; // ~200ms @ 16kHz mono s16le
        const command = channel === 'original'
            ? 'inject_original_pcm_to_device'
            : 'inject_translated_pcm_to_device';
        for (let offset = 0; offset < scaledPcm.length; offset += INJECT_CHUNK_BYTES) {
            const chunk = scaledPcm.slice(offset, offset + INJECT_CHUNK_BYTES);
            if (chunk.length < 2) continue;
            await invoke(command, {
                deviceName: this.injectDeviceName,
                pcmData: chunk,
                sampleRate: 16000,
            });
        }
        this._injectFailureCount = 0;
        this._injectUsedLegacyFallback = false;
    }

    // Mix secondary PCM into primary at secondaryGain. Returns new byte array (s16le).
    _mixPcm16Bytes(primaryBytes, secondaryBytes, secondaryGain) {
        const toI16 = (arr) => {
            const b = Array.isArray(arr) ? new Uint8Array(arr) : new Uint8Array(arr);
            return new Int16Array(b.buffer.slice(0));
        };
        const pSamples = toI16(primaryBytes);
        const sSamples = toI16(secondaryBytes);
        const out = new Int16Array(pSamples.length);
        for (let i = 0; i < pSamples.length; i++) {
            const s = i < sSamples.length ? Math.round(sSamples[i] * secondaryGain) : 0;
            out[i] = Math.max(-32768, Math.min(32767, pSamples[i] + s));
        }
        return Array.from(new Uint8Array(out.buffer));
    }

    // Consume up to targetBytes from original inject queue and keep leftover bytes for next cycle.
    _dequeueOriginalBytes(targetBytes) {
        const out = [];
        let remaining = Math.max(0, targetBytes || 0);

        while (remaining > 0 && this._originalInjectQueue.length > 0) {
            const head = this._originalInjectQueue[0];
            const headBytes = head?.pcmData || [];
            if (!headBytes.length) {
                this._originalInjectQueue.shift();
                continue;
            }

            if (headBytes.length <= remaining) {
                Array.prototype.push.apply(out, headBytes);
                remaining -= headBytes.length;
                this._originalInjectQueue.shift();
            } else {
                Array.prototype.push.apply(out, headBytes.slice(0, remaining));
                head.pcmData = headBytes.slice(remaining);
                remaining = 0;
            }
        }

        return out;
    }

    _appendRecentOriginalPcm(pcmData) {
        const bytes = Array.isArray(pcmData) ? pcmData : Array.from(new Uint8Array(pcmData));
        if (!bytes.length) return;

        Array.prototype.push.apply(this._recentOriginalPcm, bytes);
        const overflow = this._recentOriginalPcm.length - this._recentOriginalMaxBytes;
        if (overflow > 0) {
            this._recentOriginalPcm.splice(0, overflow);
        }
    }

    _getRecentOriginalWindow(targetBytes) {
        const n = Math.max(0, targetBytes || 0);
        if (n === 0 || this._recentOriginalPcm.length === 0) return [];
        if (this._recentOriginalPcm.length <= n) return this._recentOriginalPcm.slice();
        return this._recentOriginalPcm.slice(this._recentOriginalPcm.length - n);
    }

    _enqueuePcmInject(pcmData, stream, volume = 1.0, priority = 'translated') {
        const item = {
            pcmData: Array.isArray(pcmData) ? pcmData : Array.from(new Uint8Array(pcmData)),
            stream,
            volume,
        };
        if (priority === 'original') {
            this._originalInjectQueue.push(item);
            // Keep a bit more headroom for continuous mic stream bursts.
            if (this._originalInjectQueue.length > 24) {
                this._originalInjectQueue.splice(0, this._originalInjectQueue.length - 24);
            }
        } else {
            this._translatedInjectQueue.push(item);
            if (this._translatedInjectQueue.length > 3) {
                this._translatedInjectQueue.splice(0, this._translatedInjectQueue.length - 3);
            }
        }
        this._runInjectPump();
    }

    async _runInjectPump() {
        if (this._isPumpRunning) return;
        this._isPumpRunning = true;

        try {
            const ORIGINAL_ONLY_WINDOW_BYTES = 6400; // ~200ms at 16kHz mono s16le

            while (this.isRunning) {
                let didWork = false;

                // 1) Always push original channel continuously when available.
                if (this._originalInjectQueue.length > 0) {
                    const origBytes = this._dequeueOriginalBytes(ORIGINAL_ONLY_WINDOW_BYTES);
                    if (origBytes.length > 0) {
                        const stream = this._originalInjectQueue[0]?.stream || 'B';
                        const volume = this._clampVolume(this.dualConfig.streamB.originalVolume, 1.0);
                        await this._injectPcmBytesNow(origBytes, stream, volume, 'original');
                        didWork = true;
                    }
                }

                // 2) Push one translated segment independently; Rust mixer handles ducking/mix.
                if (this._translatedInjectQueue.length > 0) {
                    const item = this._translatedInjectQueue.shift();
                    const translatedVolume = this._clampVolume(item.volume, 1.0);
                    const translatedScaled = Math.abs(translatedVolume - 1.0) < 0.0001
                        ? item.pcmData
                        : this._scalePcm16Bytes(item.pcmData, translatedVolume);
                    await this._injectPcmBytesNow(translatedScaled, item.stream, 1.0, 'translated');
                    didWork = true;
                }

                if (!didWork) {
                    break;
                }
            }
        } catch (err) {
            this._injectFailureCount += 1;
            const now = Date.now();
            if (now - this._lastInjectErrorTs > 5000) {
                this._lastInjectErrorTs = now;
                this._showToast(`Inject failed: ${err}`, 'error');
            }
            // Keep inject enabled; transient errors should not permanently silence output.
        } finally {
            this._isPumpRunning = false;
            if (this.isRunning && (this._translatedInjectQueue.length > 0 || this._originalInjectQueue.length > 0)) {
                this._runInjectPump();
            }
        }
    }

    async _injectAudioChunk(base64Audio, stream, volume = 1.0) {
        try {
            const pcmData = await this._decodeBase64ToPcm16Mono(base64Audio, 16000);
            this._enqueuePcmInject(pcmData, stream, volume, 'translated');
        } catch (err) {
            // Backward-compatible fallback: old afplay-based inject path.
            try {
                console.warn('[Inject] Direct PCM device injection failed, fallback to afplay:', err);
                await invoke('inject_audio_to_device', {
                    deviceName: this.injectDeviceName,
                    base64Audio,
                });
                this._injectFailureCount = 0;
                if (!this._injectUsedLegacyFallback) {
                    this._injectUsedLegacyFallback = true;
                    this._showToast('Direct inject failed; using legacy fallback (system output)', 'info');
                }
                return;
            } catch (_fallbackErr) {
                // Continue with normal error handling below.
                console.error('[Inject] Legacy fallback also failed:', _fallbackErr);
            }

            this._injectFailureCount += 1;
            const now = Date.now();
            if (now - this._lastInjectErrorTs > 5000) {
                this._lastInjectErrorTs = now;
                this._showToast(`Stream ${stream} inject failed: ${err}`, 'error');
            }

            // Keep inject enabled; transient decode/device errors should not disable Stream B routing.
        }
    }

    _enqueueInjectText(text) {
        if (!text?.trim()) return;
        this._injectTextQueue.push(text.trim());
        if (!this._isInjectingText) {
            this._processInjectTextQueue();
        }
    }

    // Synthesize text using the active TTS provider from general settings.
    // stream='A' or 'B' selects per-stream voice; otherwise uses global voice.
    async _ttsGetBase64(text, stream = 'B') {
        const s = settingsManager.get();
        const provider = s.tts_provider || 'edge';
        const cfg = stream === 'A' ? this.dualConfig.streamA
                  : stream === 'B' ? this.dualConfig.streamB
                  : null;

        if (provider === 'google' && s.google_tts_api_key) {
            const voice = cfg?.googleVoice || s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            const langCode = voice.replace(/-Chirp3.*$/, '').replace(/-[A-Z][a-z]+.*$/, (m) => m.split('-').slice(0, 2).join('-'));
            const res = await fetch(
                `https://texttospeech.googleapis.com/v1/text:synthesize?key=${s.google_tts_api_key}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        input: { text },
                        voice: { languageCode: langCode, name: voice },
                        audioConfig: { audioEncoding: 'MP3', speakingRate: cfg?.googleSpeed || s.google_tts_speed || 1.0 },
                    }),
                }
            );
            if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
            const data = await res.json();
            return data.audioContent;
        }

        if (provider === 'elevenlabs' && s.elevenlabs_api_key) {
            const voiceId = cfg?.elevenLabsVoiceId || s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
            const res = await fetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'xi-api-key': s.elevenlabs_api_key,
                    },
                    body: JSON.stringify({
                        text,
                        model_id: 'eleven_flash_v2_5',
                        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
                    }),
                }
            );
            if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
        }

        // Default: Edge TTS
        const voice = cfg?.edgeVoice || s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const rate = cfg?.edgeSpeed !== undefined ? cfg.edgeSpeed
                   : (s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20);
        return await invoke('edge_tts_speak', { text, voice, rate });
    }

    async _processInjectTextQueue() {
        if (this._isInjectingText) return;
        this._isInjectingText = true;

        try {
            while (this._injectTextQueue.length > 0 && this.isRunning) {
                const text = this._injectTextQueue.shift();
                const base64Audio = await this._ttsGetBase64(text, 'B');
                await this._injectAudioChunk(
                    base64Audio,
                    'B',
                    this._clampVolume(this.dualConfig.streamB.translatedVolume, 1.0)
                );
            }
        } catch (err) {
            console.error('[Inject] Direct translated-text injection failed:', err);
            this._showToast(`Direct inject failed: ${err}`, 'error');
        } finally {
            this._isInjectingText = false;
        }
    }

    async _decodeBase64ToPcm16Mono(base64Audio, targetSampleRate = 16000) {
        if (!base64Audio) throw new Error('Empty TTS audio');

        // Ensure we have an AudioContext available for decoding.
        audioPlayer.init();
        await audioPlayer.resume();

        const binary = atob(base64Audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        const arrayBuffer = bytes.buffer.slice(0);
        const audioBuffer = await audioPlayer.audioContext.decodeAudioData(arrayBuffer);

        const srcRate = audioBuffer.sampleRate;
        const channels = audioBuffer.numberOfChannels;
        const srcLength = audioBuffer.length;
        const ratio = srcRate / targetSampleRate;
        const outLength = Math.max(1, Math.floor(srcLength / ratio));

        const chData = [];
        for (let c = 0; c < channels; c++) {
            chData.push(audioBuffer.getChannelData(c));
        }

        const pcm = new Int16Array(outLength);
        for (let i = 0; i < outLength; i++) {
            const srcIdx = Math.min(srcLength - 1, Math.floor(i * ratio));
            let mixed = 0;
            for (let c = 0; c < channels; c++) {
                mixed += chData[c][srcIdx];
            }
            mixed /= channels;
            const clamped = Math.max(-1, Math.min(1, mixed));
            pcm[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
        }

        return Array.from(new Uint8Array(pcm.buffer));
    }

    _isRunActive(runId) {
        return this.isRunning && this._runId === runId;
    }

    _recordDualStreamError(stream) {
        const now = Date.now();
        const arr = this._dualStreamErrorHistory[stream] || [];
        arr.push(now);
        this._dualStreamErrorHistory[stream] = arr.filter((ts) => now - ts < 20000);
    }

    _updateDualStreamStatus(stream, status, runId) {
        if (!this._isRunActive(runId)) return;

        this._dualStreamStates[stream] = status;

        // Stream A remains the primary status indicator for the global badge.
        if (stream === 'A') {
            this._updateStatus(status);
        }

        if (status === 'connected') {
            this._dualStreamErrorHistory[stream] = [];
        }

        if (status === 'error') {
            this._handleDualStreamError(stream, 'Connection error', runId);
        }
    }

    _handleDualStreamError(stream, error, runId) {
        if (!this._isRunActive(runId)) return;

        this._dualStreamStates[stream] = 'error';
        this._recordDualStreamError(stream);

        const now = Date.now();
        const lastTs = this._lastStreamErrorToastTs[stream] || 0;
        if (now - lastTs > 4000) {
            this._lastStreamErrorToastTs[stream] = now;
            this._showToast(`Stream ${stream}: ${error}`, 'error');
        }

        const errA = (this._dualStreamErrorHistory.A || []).length;
        const errB = (this._dualStreamErrorHistory.B || []).length;

        // If both streams are failing repeatedly in a short window, stop safely.
        if (errA >= 2 && errB >= 2 && this.isRunning) {
            this._showToast('Both streams unstable. Stopping capture safely.', 'error');
            this.stop();
        }
    }

    // ─── Source Control ────────────────────────────────────

    _setSource(source) {
        if (!['system', 'microphone', 'dual'].includes(source)) return;
        const wasRunning = this.isRunning;
        const sourceLabel = source === 'system'
            ? 'System Audio'
            : (source === 'microphone' ? 'Microphone' : 'Dual Conversation');

        // Persist so that _applySettings (triggered by any future save) restores the correct source.
        const settingsSource = source === 'dual' ? 'both' : source;
        settingsManager.save({ audio_source: settingsSource }).catch((err) => {
            console.warn('[Settings] Failed to persist audio_source:', err);
        });

        // If currently running, restart with new source
        if (wasRunning) {
            this.stop().then(() => {
                this._resetTtsQueueState({ clearQueue: true });
                this.currentSource = source;
                this.dualModeEnabled = source === 'dual';
                this.transcriptUI.configure({ viewMode: source === 'dual' ? 'dual' : 'single' });
                document.getElementById('btn-view-mode')?.classList.toggle('active', source === 'dual');
                this._updateSourceButtons();
                this._showToast(`Switched to ${sourceLabel}`, 'success');
                this.start();
            });
        } else {
            this.currentSource = source;
            this.dualModeEnabled = source === 'dual';
            this.transcriptUI.configure({ viewMode: source === 'dual' ? 'dual' : 'single' });
            document.getElementById('btn-view-mode')?.classList.toggle('active', source === 'dual');
            this._updateSourceButtons();
            this._showToast(`Source: ${sourceLabel}`, 'success');
        }
    }

    _updateSourceButtons() {
        document.getElementById('btn-source-system').classList.toggle('active',
            this.currentSource === 'system');
        document.getElementById('btn-source-mic').classList.toggle('active',
            this.currentSource === 'microphone');
        document.getElementById('btn-dual-mode')?.classList.toggle('active',
            this.currentSource === 'dual');
        this._syncQuickLocaleControls(settingsManager.get());
    }

    _updateModeUI(mode) {
        const hintSoniox = document.getElementById('hint-mode-soniox');
        const hintLocal = document.getElementById('hint-mode-local');

        if (hintSoniox) hintSoniox.style.display = mode === 'soniox' ? '' : 'none';
        if (hintLocal) hintLocal.style.display = mode === 'local' ? '' : 'none';
    }

    // ─── Start/Stop ────────────────────────────────────────

    async start() {
        const settings = settingsManager.get();
        this.translationMode = settings.translation_mode || 'soniox';
        console.log('[App] start() called, translation_mode:', this.translationMode, 'settings:', JSON.stringify(settings));

        // Always check Soniox API key (required for all modes)
        if (!settings.soniox_api_key) {
            this._showToast('Soniox API key is required. Add it in Settings.', 'error');
            this._showView('settings');
            return;
        }

        // Check ElevenLabs key only if TTS is enabled AND provider is elevenlabs
        if (this.ttsEnabled && settings.tts_provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('TTS is ON but ElevenLabs API key is missing. Add it in Settings or disable TTS.', 'error');
            this._showView('settings');
            return;
        }

        this.isRunning = true;
        this._runId += 1;
        const runId = this._runId;
        this._dualStreamStates = { A: 'idle', B: 'idle' };
        this._dualStreamErrorHistory = { A: [], B: [] };
        this._updateStartButton();
        if (!this.recordingStartTime) this.recordingStartTime = Date.now();

        // Clear transcript only if nothing is showing
        if (!this.transcriptUI.hasContent()) {
            this.transcriptUI.showListening();
        } else {
            this.transcriptUI.clearProvisional();
        }

        if (this.translationMode === 'local') {
            await this._startLocalMode(settings, runId);
        } else if (this.currentSource === 'dual') {
            await this._startDualCapture(settings, runId);
        } else {
            await this._startSonioxMode(settings, runId);
        }

        // Start TTS if enabled
        if (this.ttsEnabled) {
            const tts = this._getActiveTTS();
            this._configureTTS(tts, settings);
            tts.connect();
            audioPlayer.resume();
        }
    }

    async _startSonioxMode(settings, runId) {
        // Connect to Soniox
        console.log('[App] Connecting to Soniox...');
        this._updateStatus('connecting');
        sonioxClient.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: settings.source_language,
            targetLanguage: settings.target_language,
            customContext: settings.custom_context,
        });

        // Start audio capture — Rust batches audio every 200ms, JS just forwards
        try {
            let audioChunkCount = 0;

            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                if (!this._isRunActive(runId)) return;
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Audio] Batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                // Forward batched audio to Soniox
                const bytes = new Uint8Array(pcmData);
                sonioxClient.sendAudio(bytes.buffer);
            };

            console.log('[App] Starting audio capture, source:', this.currentSource);
            await invoke('start_capture', {
                source: this.currentSource,
                channel: channel,
            });
            console.log('[App] Audio capture started successfully');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            this._showToast(`Audio error: ${err}`, 'error');
            await this.stop();
        }
    }

    async _startLocalMode(settings, runId) {
        console.log('[App] Starting Local mode (MLX models)...');
        this._updateStatus('connecting');

        // Step 0: Check audio permission FIRST (before loading models)
        try {
            await invoke('start_capture', {
                source: this.currentSource,
                channel: new window.__TAURI__.core.Channel(), // dummy channel for permission check
            });
            await invoke('stop_capture');
        } catch (err) {
            console.error('[App] Audio permission check failed:', err);
            this._showToast(`Audio permission required: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            return;
        }

        // Step 1: Check if MLX setup is complete
        try {
            const checkResult = await invoke('check_mlx_setup');
            const status = JSON.parse(checkResult);
            if (!status.ready) {
                this._showToast('Setting up MLX models (one-time, ~5GB)...', 'success');
                this.transcriptUI.showStatusMessage('Downloading MLX models (one-time setup)...');
                await this._runMlxSetup();
            }
        } catch (err) {
            console.warn('[App] MLX check failed (proceeding anyway):', err);
        }

        console.log('[App] MLX check passed, starting pipeline...');

        // Step 1: Start pipeline FIRST (independent of audio)
        try {
            this._showToast('Starting local pipeline...', 'success');

            this.localPipelineChannel = new window.__TAURI__.core.Channel();
            this.localPipelineReady = false;

            this.localPipelineChannel.onmessage = (msg) => {
                if (!this._isRunActive(runId)) return;
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    console.warn('[Local] JSON parse failed:', typeof msg, msg);
                    return;
                }
                try {
                    this._handleLocalPipelineResult(data);
                } catch (e) {
                    console.error('[Local] Handler error for type:', data?.type, e);
                }
            };

            const sourceLangMap = {
                'auto': 'auto', 'ja': 'Japanese', 'en': 'English',
                'zh': 'Chinese', 'ko': 'Korean', 'vi': 'Vietnamese',
            };
            const sourceLang = sourceLangMap[settings.source_language] || 'Japanese';

            await invoke('start_local_pipeline', {
                sourceLang: sourceLang,
                targetLang: settings.target_language || 'vi',
                channel: this.localPipelineChannel,
            });
            console.log('[App] Local pipeline spawned');
        } catch (err) {
            console.error('Failed to start pipeline:', err);
            this._showToast(`Pipeline error: ${err}`, 'error');
            await this.stop();
            return;
        }

        // Step 2: Start audio capture
        try {
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;

            audioChannel.onmessage = async (pcmData) => {
                if (!this._isRunActive(runId)) return;
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Local] Audio batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                try {
                    await invoke('send_audio_to_pipeline', { data: Array.from(new Uint8Array(pcmData)) });
                } catch (e) {
                    // Pipeline may not be ready yet
                }
            };

            await invoke('start_capture', {
                source: this.currentSource,
                channel: audioChannel,
            });
            console.log('[App] Audio capture started');
        } catch (err) {
            console.error('Audio capture failed (pipeline still running):', err);
            this._showToast(`Audio: ${err}. Pipeline still loading...`, 'error');
        }
    }

    _handleLocalPipelineResult(data) {
        switch (data.type) {
            case 'ready':
                this.localPipelineReady = true;
                this._updateStatus('connected');
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.showListening();
                this._showToast('Local models ready!', 'success');
                break;
            case 'result':
                // Chase effect: show original first (gray), then translation (white)
                if (data.original) {
                    this.transcriptUI.addOriginal(data.original);
                }
                // Small delay for visual "chase" effect
                setTimeout(() => {
                if (data.translated) {
                    this.transcriptUI.addTranslation(data.translated);
                    this._speakIfEnabled(data.translated);
                }
                }, 80);
                break;
            case 'status':
                const msg = data.message || 'Loading...';
                // Status bar: show compact message (strip [pipeline] prefix)
                const statusText = document.getElementById('status-text');
                if (statusText) {
                    const compact = msg.replace(/^\[pipeline\]\s*/, '');
                    statusText.textContent = compact;
                }
                // Transcript area: only show loading/starting messages, not debug logs
                if (!msg.startsWith('[pipeline]')) {
                    this.transcriptUI.showStatusMessage(msg);
                }
                break;
            case 'done':
                this._updateStatus('disconnected');
                break;
        }
    }

    async _runMlxSetup() {
        const modal = document.getElementById('setup-modal');
        const progressFill = document.getElementById('setup-progress-fill');
        const progressPct = document.getElementById('setup-progress-pct');
        const statusText = document.getElementById('setup-status-text');
        const cancelBtn = document.getElementById('btn-cancel-setup');

        // Step mapping: step name → total progress weight
        const stepWeights = { check: 5, venv: 10, packages: 35, models: 50 };
        let totalProgress = 0;

        const updateStep = (stepName, icon, isActive) => {
            const stepEl = document.getElementById(`step-${stepName}`);
            if (!stepEl) return;
            stepEl.querySelector('.step-icon').textContent = icon;
            stepEl.classList.toggle('active', isActive);
            stepEl.classList.toggle('done', icon === '✅');
        };

        const updateProgress = (pct) => {
            totalProgress = Math.min(100, pct);
            progressFill.style.width = totalProgress + '%';
            progressPct.textContent = Math.round(totalProgress) + '%';
        };

        // Show modal
        modal.style.display = 'flex';

        return new Promise((resolve, reject) => {
            const channel = new window.__TAURI__.core.Channel();

            // Cancel handler
            const onCancel = () => {
                modal.style.display = 'none';
                reject(new Error('Setup cancelled'));
            };
            cancelBtn.addEventListener('click', onCancel, { once: true });

            channel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    return;
                }

                switch (data.type) {
                    case 'progress':
                        statusText.textContent = data.message || 'Working...';

                        // Update step indicators
                        if (data.step) {
                            // Mark previous steps as done
                            const steps = ['check', 'venv', 'packages', 'models'];
                            const currentIdx = steps.indexOf(data.step);
                            steps.forEach((s, i) => {
                                if (i < currentIdx) updateStep(s, '✅', false);
                                else if (i === currentIdx) updateStep(s, '🔄', true);
                            });

                            if (data.done) {
                                updateStep(data.step, '✅', false);
                            }

                            // Calculate overall progress
                            let pct = 0;
                            steps.forEach((s, i) => {
                                if (i < currentIdx) pct += stepWeights[s];
                                else if (i === currentIdx) {
                                    pct += (data.progress || 0) / 100 * stepWeights[s];
                                }
                            });
                            updateProgress(pct);
                        }
                        break;

                    case 'complete':
                        updateProgress(100);
                        statusText.textContent = '✅ ' + (data.message || 'Setup complete!');
                        ['check', 'venv', 'packages', 'models'].forEach(s => updateStep(s, '✅', false));

                        // Close modal after brief delay
                        setTimeout(() => {
                            modal.style.display = 'none';
                            resolve();
                        }, 1000);
                        break;

                    case 'error':
                        statusText.textContent = '❌ ' + (data.message || 'Setup failed');
                        cancelBtn.textContent = 'Close';
                        cancelBtn.removeEventListener('click', onCancel);
                        cancelBtn.addEventListener('click', () => {
                            modal.style.display = 'none';
                            reject(new Error(data.message));
                        }, { once: true });
                        break;

                    case 'log':
                        console.log('[MLX Setup]', data.message);
                        break;
                }
            };

            invoke('run_mlx_setup', { channel })
                .catch(err => {
                    statusText.textContent = '❌ ' + err;
                    modal.style.display = 'none';
                    reject(err);
                });
        });
    }

    async stop() {
        // Invalidate all pending callbacks from previous run immediately.
        this._runId += 1;
        this.isRunning = false;
        this._dualStreamStates = { A: 'idle', B: 'idle' };
        this._updateStartButton();

        // stop_capture covers both single and dual Rust-side captures
        try {
            await invoke('stop_capture');
        } catch (err) {
            console.error('Failed to stop audio capture:', err);
        }

        try {
            await invoke('stop_inject_audio');
        } catch (err) {
            console.error('Failed to stop inject audio:', err);
        }

        if (this.translationMode === 'local') {
            // Stop local pipeline
            try {
                await invoke('stop_local_pipeline');
            } catch (err) {
                console.error('Failed to stop local pipeline:', err);
            }
            this.localPipelineReady = false;
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
        } else if (this.currentSource === 'dual') {
            // Disconnect both Soniox sessions
            this.sonioxClientA?.disconnect();
            this.sonioxClientB?.disconnect();
            this.sonioxClientA = null;
            this.sonioxClientB = null;
            this._dualChannelA = null;
            this._dualChannelB = null;
            this._updateStatus('disconnected');
        } else {
            // Single stream — disconnect shared Soniox client
            sonioxClient.disconnect();
        }

        // Keep transcript visible — don't clear
        this.transcriptUI.clearProvisional();

        // Stop TTS
        elevenLabsTTS.disconnect();
        edgeTTSRust.disconnect();
        googleTTS.disconnect();

        this._originalInjectQueue = [];
        this._translatedInjectQueue = [];
        this._isPumpRunning = false;
        this._recentOriginalPcm = [];
        this._resetTtsQueueState({ clearQueue: true });

        audioPlayer.stop();

        // Auto-save on stop (safety net)
        if (this.transcriptUI.hasSegments()) {
            await this._saveTranscriptFile();
        }
    }

    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');

        btn.classList.toggle('recording', this.isRunning);
        iconPlay.style.display = this.isRunning ? 'none' : 'block';
        iconStop.style.display = this.isRunning ? 'block' : 'none';
    }

    // ─── Transcript Persistence ───────────────────────────────

    _formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}m ${sec}s`;
    }

    async _saveTranscriptFile() {
        const duration = this.recordingStartTime
            ? this._formatDuration(Date.now() - this.recordingStartTime)
            : 'unknown';

        const sourceLang = document.getElementById('select-source-lang')?.value || 'auto';
        const targetLang = document.getElementById('select-target-lang')?.value || 'vi';

        const content = this.transcriptUI.getFormattedContent({
            model: this.translationMode === 'soniox' ? 'Soniox Cloud API' : 'Local MLX Whisper',
            sourceLang,
            targetLang,
            duration,
            audioSource: this.currentSource,
        });

        if (!content) return;

        try {
            const path = await invoke('save_transcript', { content });
            const filename = path.split('/').pop();
            this._showToast(`Saved: ${filename}`, 'success');
        } catch (err) {
            console.error('Failed to save transcript:', err);
            this._showToast('Failed to save transcript', 'error');
        }
    }

    // ─── Status ────────────────────────────────────────────

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');

        dot.className = 'status-dot';

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = 'Connecting...';
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = 'Listening';
                break;
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = 'Ready';
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Error';
                break;
        }
    }

    // ─── Window Position ───────────────────────────────────

    async _saveWindowPosition() {
        try {
            const factor = await this.appWindow.scaleFactor();
            const pos = await this.appWindow.outerPosition();
            const size = await this.appWindow.innerSize();
            // Save logical coordinates (physical / scaleFactor)
            localStorage.setItem('window_state', JSON.stringify({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                width: Math.round(size.width / factor),
                height: Math.round(size.height / factor),
            }));
        } catch (err) {
            console.error('Failed to save window position:', err);
        }
    }

    async _restoreWindowPosition() {
        try {
            const saved = localStorage.getItem('window_state');
            if (!saved) return;

            const state = JSON.parse(saved);
            const { LogicalPosition, LogicalSize } = window.__TAURI__.window;

            // Validate — don't restore if position seems off-screen
            if (state.x < -100 || state.y < -100 || state.x > 5000 || state.y > 3000) {
                console.warn('Saved window position looks off-screen, skipping restore');
                localStorage.removeItem('window_state');
                return;
            }

            if (state.width && state.height && state.width >= 300 && state.height >= 100) {
                await this.appWindow.setSize(new LogicalSize(state.width, state.height));
            }
            if (state.x !== undefined && state.y !== undefined) {
                await this.appWindow.setPosition(new LogicalPosition(state.x, state.y));
            }
        } catch (err) {
            console.error('Failed to restore window position:', err);
            localStorage.removeItem('window_state');
        }
    }

    async _centerWindow() {
        try {
            await this.appWindow.center();
            await this._saveWindowPosition();
            this._showToast('Window centered', 'success');
        } catch (err) {
            console.error('Failed to center window:', err);
            this._showToast(`Failed to center window: ${err}`, 'error');
        }
    }

    // ─── Pin / Unpin (Always on Top) ────────────────────

    async _togglePin() {
        this.isPinned = !this.isPinned;
        await this.appWindow.setAlwaysOnTop(this.isPinned);
        const btn = document.getElementById('btn-pin');
        if (btn) btn.classList.toggle('active', this.isPinned);
        this._showToast(this.isPinned ? 'Pinned on top' : 'Unpinned — window can go behind other apps', 'success');
    }

    // ─── Compact Mode ───────────────────────────────

    _toggleCompact() {
        this.isCompact = !this.isCompact;
        const dragRegion = document.getElementById('drag-region');
        const overlay = document.getElementById('overlay-view');

        if (this.isCompact) {
            dragRegion.classList.add('compact-hidden');
            overlay.classList.add('compact-mode');
        } else {
            dragRegion.classList.remove('compact-hidden');
            overlay.classList.remove('compact-mode');
        }
    }

    _toggleViewMode() {
        const isDual = this.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.transcriptUI.configure({ viewMode: newMode });
        const btn = document.getElementById('btn-view-mode');
        if (btn) btn.classList.toggle('active', newMode === 'dual');
    }

    // ─── Dual Mode Control ──────────────────────────────────

    _toggleDualMode() {
        this._setSource('dual');
    }

    _updateDualModeButton() {
        const btn = document.getElementById('btn-dual-mode');
        if (btn) btn.classList.toggle('active', this.currentSource === 'dual');
    }

    /**
     * Start dual-stream capture: Stream A = system audio, Stream B = microphone.
     * Each stream has its own Soniox WebSocket session and independent callbacks.
     */
    async _startDualCapture(settings, runId) {
        console.log('[App] _startDualCapture() starting...');
        this._updateStatus('connecting');

        const cfgA = this.dualConfig.streamA;
        const cfgB = this.dualConfig.streamB;

        // Header TTS controls Stream A; Stream B keeps its own toggle.
        if (this.ttsEnabled || cfgB.ttsEnabled) {
            const tts = this._getActiveTTS();
            this._configureTTS(tts, settings);
            tts.connect?.();
            audioPlayer.resume();
        }

        // Create two independent Soniox clients
        this.sonioxClientA = new SonioxClient();
        this.sonioxClientB = new SonioxClient();

        // Wire Stream A callbacks
        this.sonioxClientA.onOriginal = (text, speaker) =>
            this._isRunActive(runId) && this.transcriptUI.addOriginalForStream('A', text, speaker);
        this.sonioxClientA.onTranslation = (text) => {
            if (!this._isRunActive(runId)) return;
            this.transcriptUI.addTranslationForStream('A', text);
            if (this.ttsEnabled && text?.trim()) {
                this._speakWithRouting(text, { stream: 'A', inject: false, playLocal: true });
            }
        };
        this.sonioxClientA.onProvisional = (text, speaker) =>
            this._isRunActive(runId) && this.transcriptUI.setProvisionalForStream('A', text || '', speaker);
        this.sonioxClientA.onStatusChange = (status) => this._updateDualStreamStatus('A', status, runId);
        this.sonioxClientA.onError = (err) => this._handleDualStreamError('A', err, runId);

        // Wire Stream B callbacks
        this.sonioxClientB.onOriginal = (text, speaker) =>
            this._isRunActive(runId) && this.transcriptUI.addOriginalForStream('B', text, speaker);
        this.sonioxClientB.onTranslation = (text) => {
            if (!this._isRunActive(runId)) return;
            const liveCfgB = this.dualConfig.streamB;
            this.transcriptUI.addTranslationForStream('B', text);
            console.log('[DualB] translation received, tts=', liveCfgB.ttsEnabled, 'inject=', liveCfgB.injectEnabled);
            if (liveCfgB.ttsEnabled && text?.trim()) {
                this._speakWithRouting(text, {
                    stream: 'B',
                    inject: false,
                    playLocal: true,
                });
            }

            if (liveCfgB.injectEnabled && text?.trim()) {
                this._enqueueInjectText(text);
            }
        };
        this.sonioxClientB.onProvisional = (text, speaker) =>
            this._isRunActive(runId) && this.transcriptUI.setProvisionalForStream('B', text || '', speaker);
        this.sonioxClientB.onStatusChange = (status) => this._updateDualStreamStatus('B', status, runId);
        this.sonioxClientB.onError = (err) => this._handleDualStreamError('B', err, runId);

        // Connect both Soniox sessions
        this.sonioxClientA.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: cfgA.sourceLanguage,
            targetLanguage: cfgA.targetLanguage,
            customContext: settings.custom_context,
        });
        this.sonioxClientB.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: cfgB.sourceLanguage,
            targetLanguage: cfgB.targetLanguage,
            customContext: settings.custom_context,
        });

        // Create two Tauri channels
        const channelA = new window.__TAURI__.core.Channel();
        const channelB = new window.__TAURI__.core.Channel();
        this._dualChannelA = channelA;
        this._dualChannelB = channelB;

        let audioCountA = 0;
        let audioCountB = 0;

        channelA.onmessage = (pcmData) => {
            if (!this._isRunActive(runId)) return;
            audioCountA++;
            if (audioCountA <= 3 || audioCountA % 50 === 0)
                console.log(`[DualA] Batch #${audioCountA}, size:`, pcmData?.length || 0);
            this.sonioxClientA.sendAudio(new Uint8Array(pcmData).buffer);
        };

        channelB.onmessage = (pcmData) => {
            if (!this._isRunActive(runId)) return;
            const liveCfgB = this.dualConfig.streamB;
            audioCountB++;
            if (audioCountB <= 3 || audioCountB % 50 === 0)
                console.log(`[DualB] Batch #${audioCountB}, size:`, pcmData?.length || 0);
            const bytes = new Uint8Array(pcmData);
            this.sonioxClientB.sendAudio(bytes.buffer);
            this._appendRecentOriginalPcm(bytes);

            if (liveCfgB.injectEnabled && liveCfgB.mixOriginalEnabled) {
                this._enqueuePcmInject(
                    bytes,
                    'B',
                    this._clampVolume(liveCfgB.originalVolume, 1.0),
                    'original'
                );
            }
        };

        // Start dual capture on the Rust side
        try {
            await invoke('start_dual_capture', {
                channelA,
                channelB,
            });
            console.log('[App] Dual capture started — Stream A: system audio, Stream B: microphone');
        } catch (err) {
            console.error('[App] start_dual_capture failed:', err);
            this._showToast(`Dual capture error: ${err}`, 'error');
            this.sonioxClientA.disconnect();
            this.sonioxClientB.disconnect();
            await this.stop();
        }
    }

    _adjustFontSize(delta) {
        const current = this.transcriptUI.fontSize || 16;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.transcriptUI.configure({ fontSize: newSize });

        // Update display
        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;

        // Sync with settings slider
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
    }

    // ─── Toast ─────────────────────────────────────────────

    async _checkForUpdates() {
        updater.onUpdateFound = (version, notes) => {
            // Silent mode: do not show in-app update CTA/toast.
            console.log(`[Updater] Update v${version} found (notification suppressed)`);
        };
        // Delay check slightly so app finishes loading first
        setTimeout(() => updater.checkForUpdates(), 3000);
    }

    _showToast(message, type = 'success') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-remove (longer for errors)
        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
