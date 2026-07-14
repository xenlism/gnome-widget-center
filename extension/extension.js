// extension/extension.js
//
// Host extension entry point. Wires together (per docs/ARCHITECTURE.md §4):
//   WidgetLoader (discover/load widget modules + call buildActor())
//     -> WidgetLayer (places each real actor in the scene graph)
//     -> WidgetSettings (per-widget JSON settings, backs api.settings)
//   StorageService (layout.json positions, widgets/*.json settings)
//     <-> WidgetLayer, WidgetSettings, DragController
//   DragController (Super+drag -> WidgetLayer in-memory move, single
//     StorageService write on drop)
//   SettingsService (host-level GSettings, e.g. disabled-widgets)
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

        this._layer = new WidgetLayer(this._storage);
        this._layer.init();

        // Super+drag repositioning (task 04) - shares the same layer (for
        // real-time in-memory moves) and storage (for the single
        // persisted write on drop) as everything else, no new services.
        this._drag = new DragController(this._layer, this._storage);

        // --- widget discovery/loading ----------------------------------
        const bundledWidgetsPath = GLib.build_filenamev([this.path, 'widgets']);
        const userWidgetsPath = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'gnome-widget-center', 'widgets',
        ]);

        // Passing this._storage backs api.settings with the real
        // per-widget JSON store (task 03) instead of the old stub `{}`.
        const loader = new WidgetLoader([bundledWidgetsPath, userWidgetsPath], this._storage);
        this._loader = loader;

        let cancelled = false;
        this._cancelLoad = () => { cancelled = true; };

        loader.loadAll()
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

                for (const entry of started) {
                    const fallback = entry.metadata['default-position'] ?? {x: 40, y: 40};
                    const position = this._layer.getSavedPosition(entry.id, fallback);
                    try {
                        this._layer.addWidgetActor(entry.id, entry.actor, position);
                        // metadata.json uses "monitor" (docs/WIDGET_API.md
                        // §2 example) while saved layout entries use
                        // "monitorIndex" (storageService.js) - accept
                        // either so a widget's very first placement
                        // (before it's ever been dragged) still gets a
                        // sane monitorIndex instead of always 0.
                        const monitorIndex = position.monitorIndex ?? position.monitor ?? 0;
                        this._drag.attach(entry.id, entry.actor, monitorIndex);
                    } catch (e) {
                        console.error(`[widget-center] "${entry.id}" could not be placed in the layer`, e);
                    }
                }
            })
            .catch(e => console.error('[widget-center] loadAll() failed', e));
    }

    disable() {
        this._cancelLoad?.();
        this._cancelLoad = null;

        // Disconnect all drag signals BEFORE anything below destroys the
        // actors they're attached to.
        this._drag?.destroy();
        this._drag = null;

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
}
