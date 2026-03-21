/**
 * Auto-updater module
 * Checks for updates on app launch using Tauri updater plugin
 * Uses window.__TAURI__ globals (no bundler needed)
 */

class Updater {
    constructor() {
        this.onUpdateFound = null; // callback(version, notes)
    }

    /**
     * Check if updater plugin is available
     */
    _getCheck() {
        try {
            return window.__TAURI__?.updater?.check;
        } catch {
            return null;
        }
    }

    /**
     * Check for updates silently on app launch
     * Shows a non-intrusive notification if update found
     */
    async checkForUpdates() {
        const check = this._getCheck();
        if (!check) {
            console.log('[Updater] Skipped — plugin not available');
            return;
        }

        try {
            console.log('[Updater] Checking for updates...');
            const update = await check();

            if (update) {
                console.log(`[Updater] Update found: v${update.version}`);
                if (this.onUpdateFound) {
                    this.onUpdateFound(update.version, update.body || '');
                }
            } else {
                console.log('[Updater] App is up to date');
            }
        } catch (err) {
            // Silently fail — don't interrupt user
            console.warn('[Updater] Check failed:', err.message || err);
        }
    }

}

export const updater = new Updater();
