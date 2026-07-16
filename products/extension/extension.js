// products/extension/extension.js
//
// Host extension entry point. Wires together (per development/docs/ARCHITECTURE.md §4):
//   WidgetLoader (discover/load widget modules + call buildActor())
//     -> WidgetLayer (places each real actor in the scene graph)
//     -> WidgetSettings (per-widget JSON settings, backs api.settings)
//   StorageService (layout.json positions, widgets/*.json settings)
//     <-> WidgetLayer, WidgetSettings, DragController
//   DragController (Super+drag -> WidgetLayer in-memory move, single
//     StorageService write on drop)
//   SettingsService (host-level GSettings, e.g. disabled-widgets) <->
//     Control Center (products/extension/prefs.js, task 05) - both processes watch
//     the same GSettings key, so a toggle flipped in the (separate) prefs
//     process fires SettingsService.onChanged() here and
//     _applyDisabledWidgets() loads/unloads that one widget immediately,
//     no shell restart needed (see development/tasks/05-prefs-control-center.md).
//
// enable()/disable() must stay synchronous per the GNOME Shell extension
// API, but loading widgets involves async dynamic import()s. The pattern
// below handles the case where disable() is called before loadAll()'s
// promise has resolved (e.g. rapid toggle in the Extensions app, or the
// auto-disable-on-lock behavior confirmed in task 00) without leaking any
// widget instances - see the `cancelled` flag.

import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WidgetLoader} from './lib/widgetLoader.js';
import {WidgetLayer} from './lib/widgetLayer.js';
import {StorageService} from './lib/storageService.js';
import {SettingsService} from './lib/settingsService.js';
import {DragController} from './lib/dragController.js';
import {MonitorWatcher} from './lib/monitorWatcher.js';
import {DevWatcher} from './lib/devWatcher.js';

export default class WidgetCenterExtension extends Extension {
    enable() {
        // --- host-level services -------------------------------------
        this._storage = new StorageService();
        this._storage.init();

        this._settings = new SettingsService(this);
        try {
            this._settings.init();
        } catch (e) {
            // Host GSettings is non-essential for widgets to render — log
            // and continue rather than aborting enable() entirely.
            console.error('[widget-center] SettingsService.init() failed', e);
            this._settings = null;
        }

        // Multi-monitor support (task 07) — resolved BEFORE WidgetLayer.init()
        // so the layer can create its one-container-per-monitor set up
        // front with real geometry, instead of a single guess it has to
        // immediately reconcile away.
        this._monitors = new MonitorWatcher();
        this._layer = new WidgetLayer(this._storage);
        this._layer.init(this._monitors.getMonitors(), this._monitors.primaryIndex);
        this._monitors.connect((monitors, primaryIndex) =>
            this._layer.reconcileMonitors(monitors, primaryIndex));

        // Super+drag repositioning (task 04) - shares the same layer (for
        // real-time in-memory moves) and storage (for the single
        // persisted write on drop) as everything else, no new services.
        this._drag = new DragController(this._layer, this._storage);

        // Hot-reload dev mode (task 08) — created up front but only
        // actually watches anything once dev-mode is true (see start()
        // call below and the onChanged('dev-mode', ...) wiring), so it's
        // an inert object with zero file monitors in normal production use.
        this._devWatcher = new DevWatcher(id => this._reloadWidget(id));

        if (this._settings?.isReady) {
            this._devChangedId = this._settings.onChanged('dev-mode', enabled => {
                if (enabled)
                    this._devWatcher.start(this._loader?.instances.map(e => ({id: e.id, path: e.path})) ?? []);
                else
                    this._devWatcher.stop();
            });
        }

        // --- widget discovery/loading ----------------------------------
        const bundledWidgetsPath = GLib.build_filenamev([this.path, 'widgets']);
        const userWidgetsPath = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'gnome-widget-center', 'widgets',
        ]);

        // Passing this._storage backs api.settings with the real
        // per-widget JSON store (task 03) instead of the old stub `{}`.
        const loader = new WidgetLoader([bundledWidgetsPath, userWidgetsPath], this._storage);
        this._loader = loader;

        // task 05: Control Center toggles write widget ids in here
        // (disabled-widgets, see extension/schemas/*.gschema.xml). Read
        // once up front so a widget the user turned off stays off across
        // a shell restart, then watch for live changes below so toggling
        // the switch takes effect immediately without one.
        const initialDisabled = new Set(
            this._settings?.isReady ? this._settings.getGlobalValue('disabled-widgets') : []
        );

        if (this._settings?.isReady) {
            this._disabledChangedId = this._settings.onChanged('disabled-widgets',
                ids => this._applyDisabledWidgets(new Set(ids)));
        }

        let cancelled = false;
        this._cancelLoad = () => { cancelled = true; };

        loader.loadAll(initialDisabled)
            .then(started => {
                console.log(`[widget-center] loaded ${started.length} widget(s)`);
                for (const err of loader.errors)
                    console.warn(`[widget-center] "${err.id}" failed: ${err.reason}`);

                // disable() ran while loadAll() was still in flight - don't
                // leave the widgets it just started running.
                if (cancelled) {
                    loader.unloadAll();
                    return;
                }

                for (const entry of started)
                    this._placeEntry(entry);

                // dev-mode may already have been on from a previous
                // session (GSettings persists it) - pick that up now that
                // the initial widget list actually exists, rather than
                // waiting for a live toggle that may never come.
                const devModeOn = this._settings?.isReady && this._settings.getGlobalValue('dev-mode');
                if (devModeOn)
                    this._devWatcher.start(started.map(e => ({id: e.id, path: e.path})));
            })
            .catch(e => console.error('[widget-center] loadAll() failed', e));
    }

    disable() {
        this._cancelLoad?.();
        this._cancelLoad = null;

        if (this._settings && this._disabledChangedId != null)
            this._settings.disconnect(this._disabledChangedId);
        this._disabledChangedId = null;

        if (this._settings && this._devChangedId != null)
            this._settings.disconnect(this._devChangedId);
        this._devChangedId = null;

        // Stop all file monitors/pending debounced reloads (task 08)
        // before anything below starts destroying the actors/instances a
        // stray reload could otherwise race against.
        this._devWatcher?.stop();
        this._devWatcher = null;

        // Disconnect all drag signals BEFORE anything below destroys the
        // actors they're attached to.
        this._drag?.destroy();
        this._drag = null;

        // Stop watching for monitor hotplug/resolution changes before the
        // layer that reacts to them is torn down below.
        this._monitors?.destroy();
        this._monitors = null;

        // Detach actors from the layer BEFORE the loader destroys them, so
        // the layer never holds a reference to an already-destroyed actor.
        if (this._loader && this._layer) {
            for (const entry of this._loader.instances)
                this._layer.removeWidgetActor(entry.id);
        }

        this._loader?.unloadAll();
        this._loader = null;

        this._layer?.destroy();
        this._layer = null;

        this._storage = null;
        this._settings = null;
    }

    /**
     * @private Places a freshly-loaded widget entry into the layer and
     * wires up its drag handling — the placement half of loadAll()'s
     * `.then()` body, factored out so _applyDisabledWidgets() (re-enabling
     * a widget live) can reuse it instead of duplicating the logic.
     * @param {object} entry - a started entry from WidgetLoader.loadOne()
     */
    _placeEntry(entry) {
        const fallback = entry.metadata['default-position'] ?? {x: 40, y: 40};
        const position = this._layer.getSavedPosition(entry.id, fallback);
        try {
            this._layer.addWidgetActor(entry.id, entry.actor, position);
            // Task 07: WidgetLayer.addWidgetActor() itself resolves a
            // missing/no-longer-valid monitorIndex to the primary monitor
            // (see widgetLayer.js _resolveMonitorIndex()) - ask it what the
            // widget actually landed on rather than re-deriving that logic
            // here, so DragController always saves the real monitor.
            const monitorIndex = this._layer.getMonitorIndexFor(entry.id);
            this._drag.attach(entry.id, entry.actor, monitorIndex);
            // If dev-mode is already on (e.g. this widget was just
            // re-enabled via the Control Center after being toggled off),
            // start watching its folder too - otherwise it'd silently miss
            // hot-reload until the next full dev-mode toggle/shell restart.
            this._devWatcher?.watchWidget(entry.id, entry.path);
        } catch (e) {
            console.error(`[widget-center] "${entry.id}" could not be placed in the layer`, e);
        }
    }

    /**
     * @private Task 08 — the DevWatcher callback for a single widget's
     * folder settling after an edit. Delegates the actual module
     * reload to WidgetLoader.reloadWidget() (which only swaps in the new
     * instance/actor once it's confirmed to build successfully - see its
     * doc comment), then re-places the resulting actor in the Widget Layer
     * at the exact same spot the old one was at, and re-attaches drag
     * handling. If reloadWidget() returns null (import/build failed), the
     * old widget is still running untouched and there's nothing to
     * re-place - it already logged why.
     * @param {string} widgetId
     */
    async _reloadWidget(widgetId) {
        if (!this._loader || !this._layer)
            return; // enable()/disable() mid-flight

        const oldEntry = this._loader.instances.find(e => e.id === widgetId);
        if (!oldEntry)
            return;

        const position = {
            x: oldEntry.actor.get_x(),
            y: oldEntry.actor.get_y(),
            monitorIndex: this._layer.getMonitorIndexFor(widgetId),
        };

        const newEntry = await this._loader.reloadWidget(widgetId);
        if (!newEntry)
            return; // old instance/actor untouched and still running

        this._drag?.detach(widgetId);
        // The old actor was already destroyed by reloadWidget() itself
        // once the new one was confirmed working - this just clears the
        // layer's now-stale reference to it (removeWidgetActor() is
        // defensive about an already-destroyed actor, see widgetLayer.js).
        this._layer.removeWidgetActor(widgetId);

        try {
            this._layer.addWidgetActor(widgetId, newEntry.actor, position);
            this._drag?.attach(widgetId, newEntry.actor, position.monitorIndex);
        } catch (e) {
            console.error(`[widget-center] "${widgetId}" could not be re-placed after hot-reload`, e);
        }
    }

    /**
     * @private Reacts to a live change of the `disabled-widgets` GSettings
     * key (task 05 — the Control Center's per-widget switch rows write to
     * this same key from the separate prefs process). Turns newly-disabled
     * widgets off and newly-re-enabled ones back on without a shell
     * restart, per development/tasks/05-prefs-control-center.md acceptance criteria.
     * @param {Set<string>} disabledIds
     */
    _applyDisabledWidgets(disabledIds) {
        if (!this._loader || !this._layer)
            return; // enable()/disable() mid-flight - the in-progress pass already reads the current value directly

        const loadedIds = new Set(this._loader.instances.map(e => e.id));

        for (const id of loadedIds) {
            if (!disabledIds.has(id))
                continue;
            this._devWatcher?.unwatchWidget(id);
            this._drag?.detach(id);
            this._layer.removeWidgetActor(id);
            this._loader.unloadOne(id);
        }

        // Re-scan (rather than reusing a cached discover() result) so a
        // widget installed since the last scan is also picked up here,
        // matching the "Rescan widgets" behavior documented in
        // development/docs/WIDGET_API.md §1.
        const discovered = this._loader.discover();
        for (const widgetInfo of discovered) {
            if (disabledIds.has(widgetInfo.id) || loadedIds.has(widgetInfo.id))
                continue;

            this._loader.loadOne(widgetInfo)
                .then(entry => entry && this._placeEntry(entry))
                .catch(e => console.error(`[widget-center] "${widgetInfo.id}" failed to load`, e));
        }
    }
}
