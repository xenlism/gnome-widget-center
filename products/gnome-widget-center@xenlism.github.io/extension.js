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
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WidgetLoader} from './lib/widgetLoader.js';
import {WidgetLayer} from './lib/widgetLayer.js';
import {StorageService} from './lib/storageService.js';
import {SettingsService} from './lib/settingsService.js';
import {DragController} from './lib/dragController.js';
import {MonitorWatcher} from './lib/monitorWatcher.js';
import {DevWatcher} from './lib/devWatcher.js';
import {GridEngine} from './lib/gridEngine.js';
import {WidgetEditMode} from './lib/widgetEditMode.js';
import {EditModeDragController} from './lib/editModeDragController.js';
import {BlockSizeManager} from './lib/blockSizeManager.js';
import {ThemeService} from './lib/themeService.js';
import {createLogger} from './lib/logger.js';

export default class WidgetCenterExtension extends Extension {
    enable() {
        // --- host-level services -------------------------------------
        this._storage = new StorageService();
        this._storage.init();

        // Theme system (2026-07-21) — global background/drop-shadow +
        // per-widget theme/config/position, `theme.json` alongside
        // layout.json/widgets/*.json (see themeService.js's file header
        // for why it's a separate file). Loaded up front, same timing as
        // StorageService, since WidgetEditMode (below) needs it ready
        // the first time any widget is flipped.
        this._themeService = new ThemeService();
        this._themeService.init();
        // Cross-process live reload (2026-07-21): the Control Center's
        // Appearance page (prefs.js, separate process) writes theme.json
        // directly via ThemeService.setGlobalTheme()/setWidgetTheme() —
        // this picks that up in the Shell process without needing a
        // restart, same pattern as settingsWatcher.js for widgets/<id>.json.
        this._themeService.watch(() => this._reapplyTheme());

        this._settings = new SettingsService(this);
        try {
            this._settings.init();
        } catch (e) {
            // Host GSettings is non-essential for widgets to render — log
            // and continue rather than aborting enable() entirely.
            console.error('[widget-center] SettingsService.init() failed', e);
            this._settings = null;
        }

        // Development Mode debug logging (2026-07-19) — `logger.debug()`
        // only prints while the Control Center's "Development Mode"
        // switch (dev-mode GSettings key) is on; see lib/logger.js file
        // header. Created here, right after SettingsService, so
        // everything below (Edit Mode, its drag controller, widget
        // load/place/remove) can use it from the start.
        this._logger = createLogger(this._settings);

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

        // Widget Edit Mode (task 12) / Edit Mode Drag & Drop (task 13) /
        // Grid Engine (task 14). GridEngine is pure geometry (no signals,
        // no disk) - see its file header. WidgetEditMode's Settings/Remove
        // callbacks are wired below, once `loader`/`this._settings` exist
        // (they're defined further down in this method), so they're
        // filled in via a small indirection here rather than restructuring
        // this method's existing top-to-bottom order.
        this._grid = new GridEngine();
        this._editMode = new WidgetEditMode(this._storage, {
            onSettings: id => {
                this._logger.debug('edit-mode', `onSettings("${id}")`);
                this._openWidgetSettings(id);
            },
            onRemove: id => {
                this._logger.debug('edit-mode', `onRemove("${id}")`);
                this._removeWidgetViaEditMode(id);
            },
            onReset: id => {
                this._logger.debug('edit-mode', `onReset("${id}")`);
                this._resetWidgetViaEditMode(id);
            },
            onUninstall: (id, isUserInstalled) => {
                this._logger.debug('edit-mode', `onUninstall("${id}", isUserInstalled=${isUserInstalled})`);
                this._uninstallWidget(id, isUserInstalled);
            },
            // 2026-07-19 fix, refined 2026-07-21: dragging from Edit Mode
            // has to be armed on the dedicated DragHandle actor, not the
            // front one or the back card as a whole — see
            // editModeDragController.js's file header. `this._editDrag`
            // doesn't exist yet at this point in enable() (created right
            // below), but this callback only ever actually fires later,
            // on a widget's first flip, by which point it does.
            onBackActorReady: (id, toolbarActor, dragArea) => {
                this._logger.debug('edit-mode', `onBackActorReady("${id}")`);
                this._editDrag?.armDragHandle(id, toolbarActor, dragArea);
            },
        }, this._logger, this._themeService);
        this._editDrag = new EditModeDragController(this._layer, this._storage, this._grid, this._editMode, this._logger);
        this._editDrag.setOthersProvider((monitorIndex, excludeId) => this._othersOnMonitor(monitorIndex, excludeId));

        // Hot-reload dev mode (task 08) — created up front but only
        // actually watches anything once dev-mode is true (see start()
        // call below and the onChanged('dev-mode', ...) wiring), so it's
        // an inert object with zero file monitors in normal production use.
        this._devWatcher = new DevWatcher(id => this._reloadWidget(id));

        if (this._settings?.isReady) {
            this._devChangedId = this._settings.onChanged('dev-mode', enabled => {
                // Logged unconditionally (via console.log, not
                // logger.debug) - it's the ON/OFF transition of debug
                // logging itself, so it has to be visible even in the
                // instant right after being turned off.
                console.log(`[widget-center] Development Mode ${enabled ? 'ON' : 'OFF'}`);
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
        this._userWidgetsPath = userWidgetsPath;

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

        // Stop watching theme.json for external changes before anything
        // below tears down the actors _reapplyTheme() would otherwise
        // touch on a stray in-flight debounced callback.
        this._themeService?.unwatch();
        this._themeService = null;

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

        // Same ordering rule for task 12/13 — both hold signal
        // connections + (for edit mode) a back-side actor per widget that
        // must be torn down before removeWidgetActor()/unloadAll() below.
        this._editDrag?.destroy();
        this._editDrag = null;
        this._editMode?.destroy();
        this._editMode = null;
        this._grid = null;

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
        this._userWidgetsPath = null;
    }

    /**
     * @private Re-styles every currently-placed widget (that opted in via
     * `themeable: true`) plus every already-built Edit Mode back card,
     * from the current (just-reloaded) theme. Called by the
     * `ThemeService.watch()` callback wired in enable() — see there for
     * why this exists (cross-process live reload from the Control
     * Center's Appearance page).
     */
    _reapplyTheme() {
        if (!this._themeService)
            return; // disable() already tore this down — nothing to reapply to

        if (this._loader) {
            for (const entry of this._loader.instances) {
                if (!entry.metadata['themeable'])
                    continue;
                try {
                    this._themeService.applyWidgetStyle(entry.actor, entry.id);
                } catch (e) {
                    console.error(`[widget-center] Failed to reapply theme for "${entry.id}"`, e);
                }
            }
        }

        this._editMode?.reapplyTheme();
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

        // Task 14: block-type size system (2026-07-19) — sets the actor's
        // pixel size directly from its declared `cols x rows` grid-cell
        // span (metadata['block-type']) times GridEngine.cellSize. Unlike
        // the old pixel min/max system this never reads the actor's
        // current size, so there's no ordering dependency on
        // addWidgetActor() below anymore — see blockSizeManager.js's doc
        // comment for why the old system needed that ordering and this
        // one doesn't.
        try {
            BlockSizeManager.applyBlockSize(entry.metadata, entry.actor, this._grid.cellSize);
        } catch (e) {
            console.error(`[widget-center] Failed to apply block size for "${entry.id}"`, e);
        }

        // Theme system (2026-07-21): only widgets that explicitly opt in
        // via metadata.json's `"themeable": true` get styled from
        // theme.json's global/per-widget appearance settings — see
        // themeService.js's applyWidgetStyle() doc comment for why this
        // isn't unconditional for every widget.
        if (entry.metadata['themeable']) {
            try {
                this._themeService.applyWidgetStyle(entry.actor, entry.id);
            } catch (e) {
                console.error(`[widget-center] Failed to apply theme for "${entry.id}"`, e);
            }
        }

        try {
            this._layer.addWidgetActor(entry.id, entry.actor, position);

            // Task 07: WidgetLayer.addWidgetActor() itself resolves a
            // missing/no-longer-valid monitorIndex to the primary monitor
            // (see widgetLayer.js _resolveMonitorIndex()) - ask it what the
            // widget actually landed on rather than re-deriving that logic
            // here, so DragController always saves the real monitor.
            const monitorIndex = this._layer.getMonitorIndexFor(entry.id);
            this._drag.attach(entry.id, entry.actor, monitorIndex);

            // Task 12/13: a widget is only user-installed (and therefore
            // ever offered an Uninstall button) if its folder lives under
            // the user data dir rather than bundled inside this extension
            // - see WidgetEditMode.attach()'s isUserInstalled doc comment.
            const isUserInstalled = this._userWidgetsPath != null &&
                entry.path.startsWith(this._userWidgetsPath);
            this._editMode.attach(entry.id, entry.actor, {isUserInstalled});
            this._editDrag.attach(entry.id, entry.actor, monitorIndex);

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
     * @private Task 12's "Settings" back-side action. Opens the Control
     * Center (task 05) deep-linked straight to this widget's own settings
     * sub-page.
     *
     * 2026-07-20 fix ("click settings opens the extension prefs, not the
     * widget prefs"): `Extension.openPreferences()` takes no arguments in
     * the GNOME Shell 45+ API and prefs.js runs in a completely separate
     * GTK4 process (see prefs.js's file header) — there's no direct
     * function call across that boundary. The two processes DO already
     * share one channel: the extension's own GSettings schema (dconf),
     * which is exactly how `disabled-widgets`/`dev-mode` stay in sync
     * live between them. This reuses that same channel: write the
     * requested widget id to the (new) `requested-widget-id` key just
     * before calling `openPreferences()`, and prefs.js reads it back out
     * once its window is built, presenting that widget's settings
     * sub-page immediately instead of stopping at the top-level list —
     * see prefs.js's `fillPreferencesWindow()` for the other half of this.
     * @param {string} widgetId
     */
    _openWidgetSettings(widgetId) {
        try {
            if (this._settings?.isReady)
                this._settings.setGlobalValue('requested-widget-id', widgetId);
            else
                console.warn(`[widget-center] SettingsService unavailable — Settings will open the top-level list, not "${widgetId}"'s page`);
            this.openPreferences();
        } catch (e) {
            console.error(`[widget-center] could not open Control Center for "${widgetId}"`, e);
        }
    }

    /**
     * @private Task 12's "Reset" back-side action, actually applying the
     * reset (2026-07-20 fix — "click reset doesn't reload the widget").
     * By the time this runs, `WidgetEditMode` has already deleted the
     * widget's `widgets/<id>.json` settings file and its `layout.json`
     * position entry (see widgetEditMode.js's Reset button handler) — this
     * method's job is to make that visible immediately, rebuilding the
     * widget's live instance/actor exactly the way task 08's hot-reload
     * does (`_reloadWidget()`, just below) and re-placing it at its
     * now-defaulted position instead of wherever it happened to be sitting
     * before Reset was clicked. Detaching/rebuilding the WidgetEditMode
     * entry as part of this also naturally exits Edit Mode — a fresh
     * actor starts back in the NORMAL state, no separate `_exitEdit()`
     * call needed.
     * @param {string} widgetId
     */
    async _resetWidgetViaEditMode(widgetId) {
        if (!this._loader || !this._layer)
            return; // enable()/disable() mid-flight

        const oldEntry = this._loader.instances.find(e => e.id === widgetId);
        if (!oldEntry) {
            // Nothing to rebuild, but the back-side card is still showing
            // (flipped) — at least get out of Edit Mode cleanly.
            this._editMode?.detach(widgetId);
            return;
        }

        this._drag?.detach(widgetId);
        this._editDrag?.detach(widgetId);
        this._editMode?.detach(widgetId);
        this._layer.removeWidgetActor(widgetId);

        const newEntry = await this._loader.reloadWidget(widgetId);
        if (!newEntry) {
            console.error(`[widget-center] "${widgetId}" could not be reloaded after Reset`);
            return;
        }

        // layout.json's entry was just removed (WidgetEditMode's Reset
        // handler), so getSavedPosition() falls straight through to the
        // widget's own metadata.json `default-position` (or the
        // {x:40,y:40} fallback) — same defaulting `_placeEntry()` uses on
        // a normal first load, applied here immediately instead of
        // waiting for the next full reload.
        const fallback = newEntry.metadata['default-position'] ?? {x: 40, y: 40};
        const position = this._layer.getSavedPosition(widgetId, fallback);

        // 2026-07-22 fix — "widget shrinks after Reset": _placeEntry()
        // applies block-type size on every normal load, but this reset
        // path built newEntry.actor via reloadWidget() and skipped that
        // step entirely, so the actor kept whatever natural/unconstrained
        // size St computed from its own children instead of the
        // cols x rows x cellSize size declared in metadata.json. Own
        // try/catch, same as _placeEntry()'s, so a failure here never
        // blocks the actor from being re-placed below.
        try {
            BlockSizeManager.applyBlockSize(newEntry.metadata, newEntry.actor, this._grid.cellSize);
        } catch (e) {
            console.error(`[widget-center] Failed to apply block size for "${widgetId}" after Reset`, e);
        }

        try {
            this._layer.addWidgetActor(widgetId, newEntry.actor, position);
            this._drag?.attach(widgetId, newEntry.actor, position.monitorIndex);
            const isUserInstalled = this._userWidgetsPath != null &&
                newEntry.path.startsWith(this._userWidgetsPath);
            this._editMode?.attach(widgetId, newEntry.actor, {isUserInstalled});
            this._editDrag?.attach(widgetId, newEntry.actor, position.monitorIndex);
        } catch (e) {
            console.error(`[widget-center] "${widgetId}" could not be re-placed after Reset`, e);
        }
    }

    /**
     * @private Task 12's "Remove" back-side action. Deliberately reuses
     * the exact same mechanism as toggling a widget off in the Control
     * Center (task 05's disabled-widgets GSettings key) rather than a
     * separate code path - `_applyDisabledWidgets()` already handles
     * detaching drag/edit-mode signals and unloading the instance
     * whichever process flips that key, prefs.js's toggle row or this.
     * @param {string} widgetId
     */
    _removeWidgetViaEditMode(widgetId) {
        if (!this._settings?.isReady) {
            console.warn(`[widget-center] "${widgetId}" could not be removed — SettingsService unavailable`);
            return;
        }
        try {
            const current = new Set(this._settings.getGlobalValue('disabled-widgets'));
            current.add(widgetId);
            this._settings.setGlobalValue('disabled-widgets', Array.from(current));
        } catch (e) {
            console.error(`[widget-center] "${widgetId}" could not be removed via disabled-widgets`, e);
        }
    }

    /**
     * @private Task 12's "Uninstall" back-side action — only ever called
     * for user-installed widgets (bundled widgets never get an Uninstall
     * button at all, see _placeEntry()'s isUserInstalled check feeding
     * WidgetEditMode.attach()). Three steps, same order every time so a
     * failure partway through never leaves a broken widget still running:
     *   1. Disable it — same as "Remove" (adds it to disabled-widgets so
     *      it's unloaded/detached before its files disappear from under a
     *      running instance).
     *   2. Clear its config — same cleanup as "Reset"
     *      (resetWidgetSettings()/removeWidgetLayoutEntry()), so a future
     *      reinstall doesn't inherit stale settings/position.
     *   3. Move (NOT delete) its folder into an "uninstalled" archive dir
     *      sibling to the user widgets dir — 2026-07-22 change: this used
     *      to hard-delete the folder via _deleteRecursively(). Moving it
     *      instead means an accidental Uninstall click is recoverable
     *      (the folder can just be moved back) rather than a silent,
     *      permanent loss. _deleteRecursively() is kept below in case
     *      something else ever needs a real delete, just no longer called
     *      from here.
     * @param {string} widgetId
     * @param {boolean} isUserInstalled
     */
    _uninstallWidget(widgetId, isUserInstalled) {
        if (!isUserInstalled) {
            console.warn(`[widget-center] refusing to uninstall bundled widget "${widgetId}"`);
            return;
        }

        const entry = this._loader?.instances.find(e => e.id === widgetId);
        const widgetPath = entry?.path;

        this._removeWidgetViaEditMode(widgetId);

        try {
            this._storage?.resetWidgetSettings(widgetId);
            this._storage?.removeWidgetLayoutEntry(widgetId);
        } catch (e) {
            console.error(`[widget-center] failed to clear config for "${widgetId}"`, e);
        }

        if (!widgetPath || !this._userWidgetsPath || !widgetPath.startsWith(this._userWidgetsPath)) {
            console.warn(`[widget-center] "${widgetId}" has no known user-installed path — skipping file move`);
            return;
        }

        try {
            const uninstallRoot = GLib.build_filenamev(
                [GLib.get_user_data_dir(), 'gnome-widget-center', 'uninstalled']);
            const rootDir = Gio.File.new_for_path(uninstallRoot);
            if (!rootDir.query_exists(null))
                rootDir.make_directory_with_parents(null);

            let destPath = GLib.build_filenamev([uninstallRoot, widgetId]);
            let dest = Gio.File.new_for_path(destPath);
            // Same widget uninstalled more than once (reinstalled, then
            // uninstalled again) - don't clobber the earlier archive,
            // suffix with a timestamp instead of failing the move.
            if (dest.query_exists(null)) {
                destPath = GLib.build_filenamev([uninstallRoot, `${widgetId}-${Date.now()}`]);
                dest = Gio.File.new_for_path(destPath);
            }

            const source = Gio.File.new_for_path(widgetPath);
            source.move(dest, Gio.FileCopyFlags.NONE, null, null);
        } catch (e) {
            console.error(`[widget-center] failed to move files for "${widgetId}" to uninstalled/`, e);
        }
    }

    /** @private recursive Gio.File delete — GLib has no built-in
     * "rm -rf" for a directory tree, this is the standard
     * enumerate-children-then-delete-bottom-up pattern for it. */
    _deleteRecursively(file) {
        const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let child;
            while ((child = children.next_file(null)) !== null)
                this._deleteRecursively(file.get_child(child.get_name()));
            children.close(null);
        }
        file.delete(null);
    }

    /**
     * @private Collision-detection data source for EditModeDragController
     * (task 13) — every OTHER widget currently placed on the same
     * monitor, as plain rects. Reads live off `this._loader.instances`
     * (actual actor positions/sizes) rather than layout.json, so it
     * reflects mid-drag reality even before anything is persisted.
     * @param {number} monitorIndex
     * @param {string} excludeId
     * @returns {Array<{id:string,x:number,y:number,width:number,height:number}>}
     */
    _othersOnMonitor(monitorIndex, excludeId) {
        if (!this._loader || !this._layer)
            return [];

        return this._loader.instances
            .filter(e => e.id !== excludeId && this._layer.getMonitorIndexFor(e.id) === monitorIndex)
            .map(e => {
                const [x, y] = e.actor.get_position();
                const [width, height] = e.actor.get_size();
                return {id: e.id, x, y, width, height};
            });
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
        this._editDrag?.detach(widgetId);
        this._editMode?.detach(widgetId);
        // The old actor was already destroyed by reloadWidget() itself
        // once the new one was confirmed working - this just clears the
        // layer's now-stale reference to it (removeWidgetActor() is
        // defensive about an already-destroyed actor, see widgetLayer.js).
        this._layer.removeWidgetActor(widgetId);

        try {
            this._layer.addWidgetActor(widgetId, newEntry.actor, position);
            this._drag?.attach(widgetId, newEntry.actor, position.monitorIndex);
            const isUserInstalled = this._userWidgetsPath != null &&
                newEntry.path.startsWith(this._userWidgetsPath);
            this._editMode?.attach(widgetId, newEntry.actor, {isUserInstalled});
            this._editDrag?.attach(widgetId, newEntry.actor, position.monitorIndex);
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
            this._editDrag?.detach(id);
            this._editMode?.detach(id);
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
