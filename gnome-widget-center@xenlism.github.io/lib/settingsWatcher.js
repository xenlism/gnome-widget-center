import Gio from "gi://Gio";

import GLib from "gi://GLib";

const DEBOUNCE_MS = 150;

const RELEVANT_EVENTS = new Set([ Gio.FileMonitorEvent.CHANGED, Gio.FileMonitorEvent.CHANGES_DONE_HINT, Gio.FileMonitorEvent.CREATED, Gio.FileMonitorEvent.RENAMED, Gio.FileMonitorEvent.MOVED_IN ]);

export class SettingsWatcher {
    constructor(storageService) {
        this._storageService = storageService;
        this._watches = new Map;
    }
    watch(widgetId, onExternalChange) {
        this.unwatch(widgetId);
        const path = this._storageService.getWidgetSettingsPath(widgetId);
        const file = Gio.File.new_for_path(path);
        let monitor;
        try {
            monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            logError(e, `[settings-watcher] could not watch settings file for "${widgetId}"`);
            return;
        }
        const state = {
            monitor: monitor,
            handlerId: null,
            debounceId: null
        };
        state.handlerId = monitor.connect("changed", (_monitor, _file, _otherFile, eventType) => {
            if (!RELEVANT_EVENTS.has(eventType)) return;
            if (state.debounceId) GLib.source_remove(state.debounceId);
            state.debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                state.debounceId = null;
                onExternalChange();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._watches.set(widgetId, state);
    }
    unwatch(widgetId) {
        const state = this._watches.get(widgetId);
        if (!state) return;
        if (state.debounceId) GLib.source_remove(state.debounceId);
        state.monitor.disconnect(state.handlerId);
        state.monitor.cancel();
        this._watches.delete(widgetId);
    }
    unwatchAll() {
        for (const widgetId of Array.from(this._watches.keys())) this.unwatch(widgetId);
    }
}