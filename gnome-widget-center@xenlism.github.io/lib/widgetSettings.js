import GLib from "gi://GLib";

const DEBOUNCE_MS = 300;

const CURRENT_SCHEMA_VERSION = 1;

const _pending = new Map;

const _liveTargets = new Map;

export class WidgetSettings {
    static load(widgetId, storageService) {
        const raw = storageService.getWidgetSettings(widgetId) ?? {};
        const target = {
            _schemaVersion: CURRENT_SCHEMA_VERSION,
            ...raw
        };
        _liveTargets.set(widgetId, target);
        const scheduleSave = () => {
            const existing = _pending.get(widgetId);
            if (existing) GLib.source_remove(existing.timeoutId);
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                _pending.delete(widgetId);
                storageService.saveWidgetSettings(widgetId, {
                    ...target
                });
                return GLib.SOURCE_REMOVE;
            });
            _pending.set(widgetId, {
                timeoutId: timeoutId,
                flush: () => {
                    GLib.source_remove(timeoutId);
                    _pending.delete(widgetId);
                    storageService.saveWidgetSettings(widgetId, {
                        ...target
                    });
                }
            });
        };
        return new Proxy(target, {
            set(obj, prop, value) {
                obj[prop] = value;
                scheduleSave();
                return true;
            },
            deleteProperty(obj, prop) {
                if (prop in obj) {
                    delete obj[prop];
                    scheduleSave();
                }
                return true;
            }
        });
    }
    static applyDefaults(settingsProxy, defaults = {}) {
        for (const [key, value] of Object.entries(defaults)) {
            if (!(key in settingsProxy)) settingsProxy[key] = value;
        }
    }
    static reloadFromDisk(widgetId, storageService) {
        const target = _liveTargets.get(widgetId);
        if (!target) return false;
        // getWidgetSettings() is cache-first (see storageService.js) so
        // repeated in-process reads don't hit disk every time - correct for
        // this process's own writes (saveWidgetSettings() keeps that cache
        // in sync), but wrong here: reloadFromDisk() only exists to pick up
        // a change made from *outside* this process - most commonly the
        // separate settings-window subprocess writing the same file - and
        // without invalidating first, this just handed back the same stale
        // in-memory value every time, so no external edit ever showed up
        // until the whole extension (and this cache with it) got torn down
        // and rebuilt via disable/enable.
        storageService.invalidateWidgetSettingsCache?.(widgetId);
        const raw = storageService.getWidgetSettings(widgetId) ?? {};
        const next = {
            _schemaVersion: target._schemaVersion ?? CURRENT_SCHEMA_VERSION,
            ...raw
        };
        let changed = false;
        for (const key of Object.keys(target)) {
            if (!(key in next)) {
                delete target[key];
                changed = true;
            }
        }
        for (const [key, value] of Object.entries(next)) {
            if (target[key] !== value) {
                target[key] = value;
                changed = true;
            }
        }
        return changed;
    }
    static release(widgetId) {
        _liveTargets.delete(widgetId);
    }
    static flush(widgetId) {
        _pending.get(widgetId)?.flush();
    }
    static flushAll() {
        for (const widgetId of Array.from(_pending.keys())) WidgetSettings.flush(widgetId);
    }
}