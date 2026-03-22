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
            this._render();
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
        this._render();
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
        this._render();
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
        this._render();
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
        this._render();
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
        this._render();
    }

    /**
     * Update provisional (in-progress) text
     */
    setProvisional(text, speaker) {
        this._removeListening();
        this.provisionalText = text;
        this.provisionalSpeaker = speaker || null;
        this._render();
    }

    /**
     * Clear provisional text
     */
    clearProvisional() {
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this._render();
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
        let html = '';
        let lastRenderedSpeaker = null;

        for (const seg of this.segments) {
            if (seg.speaker && seg.speaker !== lastRenderedSpeaker) {
                html += `<span class="speaker-label">Speaker ${seg.speaker}:</span> `;
                lastRenderedSpeaker = seg.speaker;
            }

            if (seg.status === 'translated' && seg.translation) {
                html += `<div class="seg-block">`;
                html += `<div class="seg-translated">${this._esc(seg.translation)}</div>`;
                html += `</div>`;
            }
            // Skip 'original' segments in single mode — wait for translation
        }

        if (this.provisionalText) {
            if (this.provisionalSpeaker && this.provisionalSpeaker !== lastRenderedSpeaker) {
                html += `<span class="speaker-label">Speaker ${this.provisionalSpeaker}:</span> `;
            }
            html += `<div class="seg-block"><div class="seg-provisional">${this._esc(this.provisionalText)}</div></div>`;
        }

        this.contentEl.innerHTML = html;
        this._smartScroll(this.container.parentElement || this.container);
    }

    _renderDual() {
        // Save scroll state before re-render
        const oldSrcPanel = this.contentEl.querySelector('.panel-source');
        const oldTgtPanel = this.contentEl.querySelector('.panel-translation');
        const srcScrollState = oldSrcPanel ? this._getScrollState(oldSrcPanel) : { nearBottom: true, scrollTop: 0 };
        const tgtScrollState = oldTgtPanel ? this._getScrollState(oldTgtPanel) : { nearBottom: true, scrollTop: 0 };

        const isDualBidir = this.segmentsA.length > 0 || this.segmentsB.length > 0
            || this.provisionalA.text || this.provisionalB.text;

        let srcHtml = '';
        let tgtHtml = '';

        if (isDualBidir) {
            // Bidirectional mode: left = Stream A translations, right = Stream B translations
            srcHtml += `<div class="panel-label stream-a-label">🔊 Stream A</div>`;
            tgtHtml += `<div class="panel-label stream-b-label">🎤 Stream B</div>`;

            for (const seg of this.segmentsA) {
                if (seg.status === 'translated' && seg.translation) {
                    srcHtml += `<div class="seg-text">${this._esc(seg.translation)}</div>`;
                } else if (seg.status === 'original') {
                    srcHtml += `<div class="seg-text pending">...</div>`;
                }
            }
            if (this.provisionalA.text) {
                srcHtml += `<div class="seg-text pending">${this._esc(this.provisionalA.text)}</div>`;
            }

            for (const seg of this.segmentsB) {
                if (seg.status === 'translated' && seg.translation) {
                    tgtHtml += `<div class="seg-text">${this._esc(seg.translation)}</div>`;
                } else if (seg.status === 'original') {
                    tgtHtml += `<div class="seg-text pending">...</div>`;
                }
            }
            if (this.provisionalB.text) {
                tgtHtml += `<div class="seg-text pending">${this._esc(this.provisionalB.text)}</div>`;
            }
        } else {
            // Single-stream view: left = original, right = translation
            let lastSpeaker = null;
            for (const seg of this.segments) {
                let speakerHtml = '';
                if (seg.speaker && seg.speaker !== lastSpeaker) {
                    speakerHtml = `<div class="speaker-label">Speaker ${seg.speaker}:</div>`;
                    lastSpeaker = seg.speaker;
                }
                if (seg.status === 'translated' && seg.translation) {
                    srcHtml += speakerHtml;
                    srcHtml += `<div class="seg-text">${this._esc(seg.original || '')}</div>`;
                    tgtHtml += speakerHtml ? '<div class="speaker-label">&nbsp;</div>' : '';
                    tgtHtml += `<div class="seg-text">${this._esc(seg.translation)}</div>`;
                } else if (seg.status === 'original' && seg.original) {
                    srcHtml += speakerHtml;
                    srcHtml += `<div class="seg-text pending">${this._esc(seg.original)}</div>`;
                    tgtHtml += speakerHtml ? '<div class="speaker-label">&nbsp;</div>' : '';
                    tgtHtml += `<div class="seg-text pending">...</div>`;
                }
            }
            if (this.provisionalText) {
                srcHtml += `<div class="seg-text pending">${this._esc(this.provisionalText)}</div>`;
                tgtHtml += `<div class="seg-text pending">...</div>`;
            }
        }

        this.contentEl.innerHTML = `
            <div class="panel-source">${srcHtml}</div>
            <div class="panel-translation">${tgtHtml}</div>
        `;

        // Restore scroll: auto-scroll if was near bottom, otherwise keep position
        const srcPanel = this.contentEl.querySelector('.panel-source');
        const tgtPanel = this.contentEl.querySelector('.panel-translation');
        if (srcPanel) {
            if (srcScrollState.nearBottom) srcPanel.scrollTop = srcPanel.scrollHeight;
            else srcPanel.scrollTop = srcScrollState.scrollTop;
        }
        if (tgtPanel) {
            if (tgtScrollState.nearBottom) tgtPanel.scrollTop = tgtPanel.scrollHeight;
            else tgtPanel.scrollTop = tgtScrollState.scrollTop;
        }
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
        const STALE_MS = 10000;
        const MAX_PENDING = 3;

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
