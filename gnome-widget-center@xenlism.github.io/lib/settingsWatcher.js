import Gio from "gi://Gio";

import GLib from "gi://GLib";

const DEBOUNCE_MS = 150;

const RELEVANT_EVENTS = new Set([ Gio.FileMonitorEvent.CHANGED, Gio.FileMonitorEvent.CHANGES_DONE_HINT, Gio.FileMonitorEvent.CREATED, Gio.FileMonitorEvent.RENAMED, Gio.FileMonitorEvent.MOVED_IN ]);

// Watches the *widgets directory* as a whole, not individual settings files.
// A per-file Gio.File.monitor_file() looked like the obvious approach, but
// every save goes through fsUtils.js's writeTextFile(), which uses
// Gio.FileCreateFlags.REPLACE_DESTINATION for atomic, crash-safe writes -
// write to a temp file, then rename() over the destination. That's correct
// for data safety, but it replaces the file's inode, and inotify (the usual
// backend under Gio.File.monitor_file()) watches by inode - so a per-file
// monitor goes silently dead after the very first save, and reports nothing
// for every save after that. Watching the containing directory instead (the
// same approach DevWatcher already uses for widget folders) sidesteps this
// entirely, since the directory's own inode never changes.
export class SettingsWatcher {
    constructor(storageService) {
        this._storageService = storageService;
        this._callbacks = new Map;
        this._debounceIds = new Map;
        this._dirMonitor = null;
        this._dirHandlerId = null;
    }
    _ensureDirMonitor() {
        if (this._dirMonitor) return true;
        const dirPath = this._storageService.getWidgetsDirPath();
        const dir = Gio.File.new_for_path(dirPath);
        try {
            this._dirMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            logError(e, "[settings-watcher] could not watch widgets directory");
            return false;
        }
        this._dirHandlerId = this._dirMonitor.connect("changed", (_monitor, file, otherFile, eventType) => {
            if (!RELEVANT_EVENTS.has(eventType)) return;
            // For a RENAMED event - exactly what happens when
            // fsUtils.js's writeTextFile() finishes its atomic write and
            // renames the temp file over the real one - `file` is the OLD
            // name (the temp file) and `other_file` is the NEW one (the
            // actual settings.json). Checking only `file`'s basename here
            // meant every save's rename event compared the temp file's
            // random name against "<id>.json" and never matched anything,
            // silently dropping every single save notification.
            const basenames = new Set([ file?.get_basename() ]);
            if (otherFile) basenames.add(otherFile.get_basename());
            for (const [widgetId, onExternalChange] of this._callbacks) {
                const expectedPath = this._storageService.getWidgetSettingsPath(widgetId);
                if (!basenames.has(GLib.path_get_basename(expectedPath))) continue;
                if (this._debounceIds.has(widgetId)) GLib.source_remove(this._debounceIds.get(widgetId));
                const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                    this._debounceIds.delete(widgetId);
                    onExternalChange();
                    return GLib.SOURCE_REMOVE;
                });
                this._debounceIds.set(widgetId, timeoutId);
            }
        });
        return true;
    }
    watch(widgetId, onExternalChange) {
        if (!this._ensureDirMonitor()) return;
        this._callbacks.set(widgetId, onExternalChange);
    }
    unwatch(widgetId) {
        this._callbacks.delete(widgetId);
        if (this._debounceIds.has(widgetId)) {
            GLib.source_remove(this._debounceIds.get(widgetId));
            this._debounceIds.delete(widgetId);
        }
    }
    unwatchAll() {
        for (const widgetId of Array.from(this._callbacks.keys())) this.unwatch(widgetId);
        if (this._dirMonitor) {
            this._dirMonitor.disconnect(this._dirHandlerId);
            this._dirMonitor.cancel();
            this._dirMonitor = null;
            this._dirHandlerId = null;
        }
    }
}
