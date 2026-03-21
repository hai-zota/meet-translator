/**
 * Transcript UI — continuous paragraph flow display with speaker diarization
 *
 * Design: All text flows as one continuous paragraph.
 * - Translated text: white (primary color)
 * - Original text (pending translation): cyan/accent color
 * - Provisional text (being recognized): dimmed
 * - Speaker labels: shown when speaker changes (e.g. "Speaker 1:")
 */

export class TranscriptUI {
    constructor(container) {
        this.container = container;
        this.contentEl = null;
        this.maxChars = 1200;
        this.fontSize = 16;
        this.viewMode = 'single'; // 'single' or 'dual'

        // Segments: each has { original, translation, status, speaker }
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.currentSpeaker = null; // Track current speaker to detect changes

        // Per-stream segment stores for dual bidirectional mode
        this.segmentsA = []; // Stream A — system audio
        this.segmentsB = []; // Stream B — microphone
        this.provisionalA = { text: '', speaker: null };
        this.provisionalB = { text: '', speaker: null };

        // Debounce render to avoid DOM thrashing when translations arrive rapidly
        this._renderScheduled = false;
        this._renderTimer = null;
        this._renderRafId = null;
        this._renderDebounceMs = 16; // ~1 frame at 60fps

        // DOM node references for incremental patching (avoid full rebuilds)
        this._segmentElements = new Map(); // segment object → { el, lastStatus, lastText }
        this._segmentElementsA = new Map(); // Stream A segments
        this._segmentElementsB = new Map(); // Stream B segments
        this._lastRenderedSpeaker = null;
        this._provisionalElement = null;
        // Cache for _renderSingle incremental optimization
        this._lastStableHtml = '';
        this._lastProvHtml = '';
        this._lastStableHtml = '';
        this._lastProvHtml = '';
    }

    /**
     * Update display settings
     */
    configure({ maxLines, showOriginal, fontSize, fontColor, viewMode }) {
        if (maxLines !== undefined) this.maxChars = maxLines * 160;
        if (fontSize !== undefined) {
            this.fontSize = fontSize;
            this.container.style.setProperty('--transcript-font-size', `${fontSize}px`);
        }
        if (fontColor !== undefined) {
            this.fontColor = fontColor;
            this.container.style.setProperty('--transcript-font-color', fontColor);
        }
        if (viewMode !== undefined) {
            this.viewMode = viewMode;
            const overlay = document.getElementById('overlay-view');
            if (overlay) {
                overlay.classList.toggle('dual-view', viewMode === 'dual');
            }
            this._scheduleRender();
        }
    }

    // ─── Per-stream API (dual bidirectional mode) ──────────

    /**
     * Add finalized original text for a specific stream ('A' or 'B').
     * Use this instead of addOriginal() when in dual mode.
     */
    addOriginalForStream(stream, text, speaker) {
        this._removeListening();
        const arr = stream === 'A' ? this.segmentsA : this.segmentsB;
        arr.push({
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            createdAt: Date.now(),
        });
        this._cleanupStaleOriginalsForStream(stream);
        this._scheduleRender();
    }

    /**
     * Apply translation to the oldest untranslated segment in a specific stream.
     */
    addTranslationForStream(stream, text) {
        const arr = stream === 'A' ? this.segmentsA : this.segmentsB;
        const seg = arr.find(s => s.status === 'original');
        if (seg) {
            seg.translation = text;
            seg.status = 'translated';
        } else {
            arr.push({ original: '', translation: text, status: 'translated', speaker: null });
        }
        this._scheduleRender({ immediate: true });
    }

    /**
     * Update provisional (in-progress) text for a specific stream.
     */
    setProvisionalForStream(stream, text, speaker) {
        this._removeListening();
        if (stream === 'A') {
            this.provisionalA = { text, speaker: speaker || null };
        } else {
            this.provisionalB = { text, speaker: speaker || null };
        }
        this._scheduleRender();
    }

    // ─── Single-stream API ────────────────────────────────

    /**
     * Add finalized original text (pending translation)
     */
    addOriginal(text, speaker) {
        this._removeListening();
        this.segments.push({
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            createdAt: Date.now(),
        });
        if (speaker) this.currentSpeaker = speaker;
        this._cleanupStaleOriginals();
        this._scheduleRender();
    }

    /**
     * Apply translation to the oldest untranslated segment
     */
    addTranslation(text) {
        const seg = this.segments.find(s => s.status === 'original');
        if (seg) {
            seg.translation = text;
            seg.status = 'translated';
        } else {
            this.segments.push({
                original: '',
                translation: text,
                status: 'translated',
                speaker: null,
            });
        }
        this._scheduleRender({ immediate: true });
    }

    /**
     * Update provisional (in-progress) text
     */
    setProvisional(text, speaker) {
        this._removeListening();
        this.provisionalText = text;
        this.provisionalSpeaker = speaker || null;
        this._scheduleRender();
    }

    /**
     * Clear provisional text
     */
    clearProvisional() {
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this._scheduleRender();
    }

    /**
     * Check if there is any content to display
     */
    hasContent() {
        return this.segments.length > 0 || this.provisionalText ||
            !!this.container.querySelector('.listening-indicator');
    }

    /**
     * Show placeholder state
     */
    showPlaceholder() {
        clearTimeout(this._renderTimer);
        if (this._renderRafId !== null) {
            cancelAnimationFrame(this._renderRafId);
            this._renderRafId = null;
        }
        this._renderScheduled = false;

        this.container.innerHTML = `
      <div class="transcript-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        <p>Press ▶ to start translating</p>
        <p class="shortcut-hint">⌘ Enter</p>
      </div>
    `;
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.currentSpeaker = null;
        this.contentEl = null;

        // Clear DOM tracking
        this._segmentElements.clear();
        this._provisionalElement = null;
        this._lastStableHtml = '';
        this._lastProvHtml = '';
    }

    /**
     * Show listening state
     */
    showListening() {
        // Remove existing indicators first (prevent duplicates)
        this.container.querySelectorAll('.listening-indicator').forEach(el => el.remove());

        const placeholder = this.container.querySelector('.transcript-placeholder');
        if (placeholder) placeholder.remove();

        this._ensureContent();

        const indicator = document.createElement('div');
        indicator.className = 'listening-indicator';
        indicator.innerHTML = `
            <div class="listening-waves">
                <span></span><span></span><span></span><span></span><span></span>
            </div>
            <p>Listening...</p>
        `;
        this.contentEl.appendChild(indicator);
    }

    /**
     * Show status message in transcript area (e.g. loading model)
     */
    showStatusMessage(message) {
        this._ensureContent();
        let statusEl = this.contentEl.querySelector('.pipeline-status');
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.className = 'pipeline-status';
            statusEl.style.cssText = 'text-align:center; padding:8px; color:rgba(255,255,255,0.5); font-size:13px;';
            this.contentEl.appendChild(statusEl);
        }
        statusEl.textContent = message;
    }

    /**
     * Remove status message
     */
    removeStatusMessage() {
        if (this.contentEl) {
            const statusEl = this.contentEl.querySelector('.pipeline-status');
            if (statusEl) statusEl.remove();
        }
    }

    /**
     * Get transcript as plain text for copying
     */
    getPlainText() {
        let lines = [];
        // Single-stream mode
        for (const seg of this.segments) {
            if (seg.original) lines.push(seg.original);
            if (seg.translation) lines.push(seg.translation);
            if (seg.original || seg.translation) lines.push('');
        }
        if (this.provisionalText) lines.push(this.provisionalText);
        // Dual-stream mode
        if (this.segmentsA.length > 0 || this.segmentsB.length > 0) {
            lines.push('--- Stream A (System Audio) ---');
            for (const seg of this.segmentsA) {
                if (seg.translation) lines.push(seg.translation);
            }
            lines.push('');
            lines.push('--- Stream B (Microphone) ---');
            for (const seg of this.segmentsB) {
                if (seg.translation) lines.push(seg.translation);
            }
        }
        return lines.join('\n').trim();
    }

    /**
     * Get formatted content for saving to file (markdown with metadata)
     */
    getFormattedContent(metadata = {}) {
        const isDual = this.segmentsA.length > 0 || this.segmentsB.length > 0;
        if (this.segments.length === 0 && !isDual) return null;

        const lines = [];

        // Metadata header
        lines.push('---');
        lines.push(`date: ${new Date().toISOString()}`);
        if (metadata.model) lines.push(`model: ${metadata.model}`);
        if (isDual) {
            lines.push('mode: dual_bidirectional');
        } else {
            if (metadata.sourceLang) lines.push(`source_language: ${metadata.sourceLang}`);
            if (metadata.targetLang) lines.push(`target_language: ${metadata.targetLang}`);
        }
        if (metadata.duration) lines.push(`recording_duration: ${metadata.duration}`);
        lines.push(`segments: ${this.segments.length + this.segmentsA.length + this.segmentsB.length}`);
        lines.push('---');
        lines.push('');

        if (isDual) {
            lines.push('## Stream A — System Audio');
            lines.push('');
            for (const seg of this.segmentsA) {
                if (seg.speaker) lines.push(`**Speaker ${seg.speaker}:**`);
                if (seg.original) lines.push(`> ${seg.original}`);
                if (seg.translation) lines.push(seg.translation);
                lines.push('');
            }
            lines.push('## Stream B — Microphone');
            lines.push('');
            for (const seg of this.segmentsB) {
                if (seg.speaker) lines.push(`**Speaker ${seg.speaker}:**`);
                if (seg.original) lines.push(`> ${seg.original}`);
                if (seg.translation) lines.push(seg.translation);
                lines.push('');
            }
        } else {
            for (const seg of this.segments) {
                if (seg.speaker) lines.push(`**Speaker ${seg.speaker}:**`);
                if (seg.original) lines.push(`> ${seg.original}`);
                if (seg.translation) lines.push(seg.translation);
                lines.push('');
            }
        }

        return lines.join('\n').trim();
    }

    /**
     * Check if there are segments to save
     */
    hasSegments() {
        return this.segments.length > 0 || this.segmentsA.length > 0 || this.segmentsB.length > 0;
    }

    /**
     * Clear all
     */
    clear() {
        clearTimeout(this._renderTimer);
        if (this._renderRafId !== null) {
            cancelAnimationFrame(this._renderRafId);
            this._renderRafId = null;
        }
        this._renderScheduled = false;

        this.container.innerHTML = '';
        this.segments = [];
        this.segmentsA = [];
        this.segmentsB = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalA = { text: '', speaker: null };
        this.provisionalB = { text: '', speaker: null };
        this.currentSpeaker = null;
        this.contentEl = null;

        // Clear DOM tracking maps
        this._segmentElements.clear();
        this._segmentElementsA.clear();
        this._segmentElementsB.clear();
        this._provisionalElement = null;
        this._lastRenderedSpeaker = null;
    }

    // ─── Internal ──────────────────────────────────────────

    _ensureContent() {
        if (!this.contentEl) {
            this.container.innerHTML = '';
            this.contentEl = document.createElement('div');
            this.contentEl.className = 'transcript-flow';
            this.container.appendChild(this.contentEl);
        }
    }

    _removeListening() {
        const indicator = this.container.querySelector('.listening-indicator');
        if (indicator) indicator.remove();
    }

    /**
     * Schedule render, debouncing rapid calls to avoid DOM thrashing
     * This is critical when translations arrive at 2-3/sec with TTS enabled
     */
    _scheduleRender(options = {}) {
        const { immediate = false } = options;
        if (immediate) {
            clearTimeout(this._renderTimer);
            this._renderScheduled = false;
            if (this._renderRafId !== null) {
                return;
            }
            this._renderRafId = requestAnimationFrame(() => {
                this._renderRafId = null;
                this._render();
            });
            return;
        }

        if (this._renderRafId !== null) {
            return; // An immediate frame render is already queued
        }

        if (this._renderScheduled) {
            return; // Already scheduled, batch with pending render
        }
        this._renderScheduled = true;
        clearTimeout(this._renderTimer);
        this._renderTimer = setTimeout(() => {
            this._renderScheduled = false;
            this._render();
        }, this._renderDebounceMs);
    }

    // ─── Incremental DOM Patching Helpers ───────────────

    /**
     * Create a DOM element for a segment's translated text
     */
    _createSegmentElement(seg) {
        const block = document.createElement('div');
        block.className = 'seg-block';
        const div = document.createElement('div');
        div.className = 'seg-translated';
        div.textContent = seg.translation || '';
        block.appendChild(div);
        return block;
    }

    /**
     * Update existing segment element if status/text changed
     */
    _updateSegmentIfNeeded(seg, stored) {
        const needsUpdate = stored.lastStatus !== seg.status || stored.lastText !== (seg.translation || seg.original);
        if (!needsUpdate) return false;

        stored.lastStatus = seg.status;
        stored.lastText = seg.translation || seg.original;

        if (seg.status === 'translated' && seg.translation) {
            stored.el.innerHTML = `<div class="seg-translated">${this._esc(seg.translation)}</div>`;
        } else if (seg.status === 'original' && seg.original) {
            stored.el.innerHTML = `<div class="seg-text pending">${this._esc(seg.original)}</div>`;
        }
        return true;
    }

    /**
     * Create a dual-panel segment pair (source + translation)
     */
    _createDualSegmentPair(seg, showSpeaker = false, speakerLabel = '') {
        const srcDiv = document.createElement('div');
        const tgtDiv = document.createElement('div');

        if (showSpeaker && speakerLabel) {
            const srcLabel = document.createElement('div');
            srcLabel.className = 'speaker-label';
            srcLabel.textContent = speakerLabel;
            srcDiv.appendChild(srcLabel);

            const tgtLabel = document.createElement('div');
            tgtLabel.className = 'speaker-label';
            tgtLabel.innerHTML = '&nbsp;';
            tgtDiv.appendChild(tgtLabel);
        }

        if (seg.status === 'translated' && seg.translation) {
            const srcText = document.createElement('div');
            srcText.className = 'seg-text';
            srcText.textContent = seg.original || '';

            const tgtText = document.createElement('div');
            tgtText.className = 'seg-text';
            tgtText.textContent = seg.translation;

            srcDiv.appendChild(srcText);
            tgtDiv.appendChild(tgtText);
        } else if (seg.status === 'original') {
            const srcText = document.createElement('div');
            srcText.className = 'seg-text pending';
            srcText.textContent = seg.original;

            const tgtText = document.createElement('div');
            tgtText.className = 'seg-text pending';
            tgtText.textContent = '...';

            srcDiv.appendChild(srcText);
            tgtDiv.appendChild(tgtText);
        }

        return { srcDiv, tgtDiv };
    }

    /**
     * Cleanup DOM tracking for removed segments
     */
    _cleanupRemovedSegments(arr, tracking) {
        const retained = new Set(arr);
        for (const seg of tracking.keys()) {
            if (!retained.has(seg)) {
                const stored = tracking.get(seg);
                if (stored.el && stored.el.parentElement) {
                    stored.el.remove();
                }
                tracking.delete(seg);
            }
        }
    }

    _render() {
        this._ensureContent();
        this._trimSegments();

        if (this.viewMode === 'dual') {
            this._renderDual();
        } else {
            this._renderSingle();
        }
    }

    _renderSingle() {
        // Split stable content (confirmed translations) from provisional text.
        // This avoids rebuilding all DOM when only provisional text changes (high-frequency).
        let stableEl = this.contentEl.querySelector(':scope > .seg-stable');
        let provEl = this.contentEl.querySelector(':scope > .seg-provisional-wrap');
        if (!stableEl || !provEl) {
            // First render — build the two-div structure fresh.
            this.contentEl.innerHTML = '<div class="seg-stable"></div><div class="seg-provisional-wrap"></div>';
            stableEl = this.contentEl.querySelector('.seg-stable');
            provEl = this.contentEl.querySelector('.seg-provisional-wrap');
            this._lastStableHtml = '';
            this._lastProvHtml = '';
        }

        // Build stable HTML from confirmed translated segments.
        let stableHtml = '';
        let lastRenderedSpeaker = null;
        let mergedText = '';

        const appendMergedBlock = () => {
            const text = mergedText.trim();
            if (!text) return;
            stableHtml += `<div class="seg-block"><div class="seg-translated">${this._esc(text)}</div></div>`;
            mergedText = '';
        };

        for (const seg of this.segments) {
            if (seg.speaker && seg.speaker !== lastRenderedSpeaker) {
                appendMergedBlock();
                stableHtml += `<span class="speaker-label">Speaker ${seg.speaker}:</span> `;
                lastRenderedSpeaker = seg.speaker;
            }
            if (seg.status === 'translated' && seg.translation) {
                const t = seg.translation.trim();
                if (!t) continue;
                if (!mergedText) {
                    mergedText = t;
                } else if (/^[,.;:!?)]/.test(t)) {
                    mergedText += t;
                } else {
                    mergedText += ` ${t}`;
                }
            }
            // Skip 'original' segments — wait for translation
        }
        appendMergedBlock();

        // Only touch stable DOM when content actually changes.
        if (stableHtml !== this._lastStableHtml) {
            stableEl.innerHTML = stableHtml;
            this._lastStableHtml = stableHtml;
        }

        // Build provisional HTML (high-frequency, small update).
        let provHtml = '';
        if (this.provisionalText) {
            if (this.provisionalSpeaker && this.provisionalSpeaker !== lastRenderedSpeaker) {
                provHtml += `<span class="speaker-label">Speaker ${this.provisionalSpeaker}:</span> `;
            }
            provHtml += `<div class="seg-block"><div class="seg-provisional">${this._esc(this.provisionalText)}</div></div>`;
        }

        // Only touch provisional DOM when content actually changes.
        if (provHtml !== this._lastProvHtml) {
            provEl.innerHTML = provHtml;
            this._lastProvHtml = provHtml;
        }

        this._smartScroll(this.container.parentElement || this.container);
    }

    _renderDual() {
        const srcPanel = this.contentEl.querySelector('.panel-source');
        const tgtPanel = this.contentEl.querySelector('.panel-translation');

        // Initialize panels if needed
        if (!srcPanel || !tgtPanel) {
            this.contentEl.innerHTML = `
                <div class="panel-source"></div>
                <div class="panel-translation"></div>
            `;
        }

        const srcPanel2 = this.contentEl.querySelector('.panel-source');
        const tgtPanel2 = this.contentEl.querySelector('.panel-translation');

        const isDualBidir = this.segmentsA.length > 0 || this.segmentsB.length > 0
            || this.provisionalA.text || this.provisionalB.text;

        if (isDualBidir) {
            // Bidirectional mode: incremental patching for both streams
            this._patchDualBidirPanels(srcPanel2, tgtPanel2);
        } else {
            // Single-stream view: source + translation side-by-side
            this._patchDualSinglePanels(srcPanel2, tgtPanel2);
        }

        // Preserve scroll position
        const srcScrollState = this._getScrollState(srcPanel2);
        const tgtScrollState = this._getScrollState(tgtPanel2);
        if (srcScrollState.nearBottom) srcPanel2.scrollTop = srcPanel2.scrollHeight;
        if (tgtScrollState.nearBottom) tgtPanel2.scrollTop = tgtPanel2.scrollHeight;
    }

    /**
     * Incrementally patch dual bidirectional panels (Stream A left, Stream B right)
     */
    _patchDualBidirPanels(srcPanel, tgtPanel) {
        // Cleanup any removed segments
        this._cleanupRemovedSegments(this.segmentsA, this._segmentElementsA);
        this._cleanupRemovedSegments(this.segmentsB, this._segmentElementsB);

        // Add label headers if needed
        if (!srcPanel.firstChild || srcPanel.firstChild.className !== 'panel-label') {
            srcPanel.innerHTML = '<div class="panel-label stream-a-label">🔊 Stream A</div>';
            tgtPanel.innerHTML = '<div class="panel-label stream-b-label">🎤 Stream B</div>';
        }

        // Incrementally add/update Stream A segments
        for (const seg of this.segmentsA) {
            let stored = this._segmentElementsA.get(seg);
            if (!stored) {
                const div = document.createElement('div');
                if (seg.status === 'translated' && seg.translation) {
                    div.className = 'seg-text';
                    div.textContent = seg.translation;
                } else if (seg.status === 'original') {
                    div.className = 'seg-text pending';
                    div.textContent = '...';
                }
                srcPanel.appendChild(div);
                stored = { el: div, lastStatus: seg.status, lastText: seg.translation };
                this._segmentElementsA.set(seg, stored);
            }
        }

        // Incrementally add/update Stream B segments
        for (const seg of this.segmentsB) {
            let stored = this._segmentElementsB.get(seg);
            if (!stored) {
                const div = document.createElement('div');
                if (seg.status === 'translated' && seg.translation) {
                    div.className = 'seg-text';
                    div.textContent = seg.translation;
                } else if (seg.status === 'original') {
                    div.className = 'seg-text pending';
                    div.textContent = '...';
                }
                tgtPanel.appendChild(div);
                stored = { el: div, lastStatus: seg.status, lastText: seg.translation };
                this._segmentElementsB.set(seg, stored);
            }
        }

        // Handle provisional text for Stream A
        if (this.provisionalA.text) {
            const lastChild = srcPanel.lastChild;
            if (!lastChild || lastChild.className !== 'seg-text pending' || lastChild.textContent !== this.provisionalA.text) {
                const div = document.createElement('div');
                div.className = 'seg-text pending';
                div.textContent = this.provisionalA.text;
                srcPanel.appendChild(div);
            }
        } else {
            // Remove stale provisional if exists
            const lastSrc = srcPanel.lastChild;
            if (lastSrc && lastSrc.className === 'seg-text pending' && !this.segmentsA.includes(this._findSegmentByElement(lastSrc, this._segmentElementsA))) {
                if (lastSrc.parentElement) lastSrc.remove();
            }
        }

        // Handle provisional text for Stream B
        if (this.provisionalB.text) {
            const lastChild = tgtPanel.lastChild;
            if (!lastChild || lastChild.className !== 'seg-text pending' || lastChild.textContent !== this.provisionalB.text) {
                const div = document.createElement('div');
                div.className = 'seg-text pending';
                div.textContent = this.provisionalB.text;
                tgtPanel.appendChild(div);
            }
        } else {
            // Remove stale provisional if exists
            const lastTgt = tgtPanel.lastChild;
            if (lastTgt && lastTgt.className === 'seg-text pending' && !this.segmentsB.includes(this._findSegmentByElement(lastTgt, this._segmentElementsB))) {
                if (lastTgt.parentElement) lastTgt.remove();
            }
        }
    }

    /**
     * Incrementally patch dual single-stream panels (source left, translation right)
     */
    _patchDualSinglePanels(srcPanel, tgtPanel) {
        this._cleanupRemovedSegments(this.segments, this._segmentElements);

        let lastSpeaker = null;
        for (const seg of this.segments) {
            let stored = this._segmentElements.get(seg);
            if (seg.status === 'translated' && seg.translation) {
                if (!stored) {
                    let showSpeaker = false;
                    let speakerLabel = '';
                    if (seg.speaker && seg.speaker !== lastSpeaker) {
                        showSpeaker = true;
                        speakerLabel = `Speaker ${seg.speaker}:`;
                        lastSpeaker = seg.speaker;
                    }

                    const { srcDiv, tgtDiv } = this._createDualSegmentPair(seg, showSpeaker, speakerLabel);
                    srcPanel.appendChild(srcDiv);
                    tgtPanel.appendChild(tgtDiv);

                    stored = { srcEl: srcDiv, tgtEl: tgtDiv, lastStatus: seg.status, lastText: seg.translation };
                    this._segmentElements.set(seg, stored);
                }
            } else if (seg.status === 'original' && seg.original) {
                if (!stored) {
                    let showSpeaker = false;
                    let speakerLabel = '';
                    if (seg.speaker && seg.speaker !== lastSpeaker) {
                        showSpeaker = true;
                        speakerLabel = `Speaker ${seg.speaker}:`;
                        lastSpeaker = seg.speaker;
                    }

                    const { srcDiv, tgtDiv } = this._createDualSegmentPair(seg, showSpeaker, speakerLabel);
                    srcPanel.appendChild(srcDiv);
                    tgtPanel.appendChild(tgtDiv);

                    stored = { srcEl: srcDiv, tgtEl: tgtDiv, lastStatus: seg.status, lastText: seg.original };
                    this._segmentElements.set(seg, stored);
                }
            }
        }

        // Handle provisional text
        if (this.provisionalText) {
            const srcDiv = document.createElement('div');
            srcDiv.className = 'seg-text pending';
            srcDiv.textContent = this.provisionalText;

            const tgtDiv = document.createElement('div');
            tgtDiv.className = 'seg-text pending';
            tgtDiv.textContent = '...';

            if (!this._provisionalElement) {
                srcPanel.appendChild(srcDiv);
                tgtPanel.appendChild(tgtDiv);
                this._provisionalElement = { srcEl: srcDiv, tgtEl: tgtDiv };
            }
        } else {
            if (this._provisionalElement) {
                if (this._provisionalElement.srcEl?.parentElement) this._provisionalElement.srcEl.remove();
                if (this._provisionalElement.tgtEl?.parentElement) this._provisionalElement.tgtEl.remove();
                this._provisionalElement = null;
            }
        }
    }

    /**
     * Find segment by element ref (helper for cleanup)
     */
    _findSegmentByElement(el, tracking) {
        for (const [seg, stored] of tracking.entries()) {
            if (stored.el === el || stored.srcEl === el || stored.tgtEl === el) {
                return seg;
            }
        }
        return null;
    }

    _getScrollState(el) {
        return {
            nearBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < 100,
            scrollTop: el.scrollTop
        };
    }

    _smartScroll(el) {
        const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
        if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }

    _trimSegments() {
        // Single-stream
        let totalLen = 0;
        for (const seg of this.segments) {
            totalLen += (seg.translation || seg.original || '').length;
        }
        while (totalLen > this.maxChars && this.segments.length > 2) {
            const removed = this.segments.shift();
            totalLen -= (removed.translation || removed.original || '').length;
        }
        // Stream A
        let lenA = 0;
        for (const seg of this.segmentsA) lenA += (seg.translation || seg.original || '').length;
        while (lenA > this.maxChars && this.segmentsA.length > 2) {
            const removed = this.segmentsA.shift();
            lenA -= (removed.translation || removed.original || '').length;
        }
        // Stream B
        let lenB = 0;
        for (const seg of this.segmentsB) lenB += (seg.translation || seg.original || '').length;
        while (lenB > this.maxChars && this.segmentsB.length > 2) {
            const removed = this.segmentsB.shift();
            lenB -= (removed.translation || removed.original || '').length;
        }
    }

    /**
     * Remove stale original segments that never received translation.
     * - Originals older than 10s are removed
     * - Max 3 pending originals allowed (oldest dropped)
     */
    _cleanupStaleOriginals() {
        this._cleanupStaleArr(this.segments);
    }

    _cleanupStaleOriginalsForStream(stream) {
        this._cleanupStaleArr(stream === 'A' ? this.segmentsA : this.segmentsB);
    }

    _cleanupStaleArr(arr) {
        const now = Date.now();
        const STALE_MS = 120000;
        const MAX_PENDING = 50;

        // Remove originals older than STALE_MS
        const kept = arr.filter(seg =>
            !(seg.status === 'original' && (now - seg.createdAt) > STALE_MS)
        );
        arr.length = 0;
        arr.push(...kept);

        // If still too many pending originals, drop oldest
        let pending = arr.filter(s => s.status === 'original');
        while (pending.length > MAX_PENDING) {
            const oldest = pending.shift();
            const idx = arr.indexOf(oldest);
            if (idx !== -1) arr.splice(idx, 1);
        }
    }

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
