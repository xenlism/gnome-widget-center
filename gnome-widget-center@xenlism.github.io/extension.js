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
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {WidgetLoader} from './lib/widgetLoader.js';
import {WidgetLayer} from './lib/widgetLayer.js';
import {StorageService} from './lib/storageService.js';
import {SettingsService} from './lib/settingsService.js';
import {DragController} from './lib/dragController.js';
import {MonitorWatcher} from './lib/monitorWatcher.js';
import {DevWatcher} from './lib/devWatcher.js';
import {LayoutEngine} from './lib/layoutEngine.js';
import {WidgetEditMode} from './lib/widgetEditMode.js';
import {EditModeDragController} from './lib/editModeDragController.js';
import {BlockSizeManager} from './lib/blockSizeManager.js';
import {ThemeService} from './lib/themeService.js';
import {setForcedTheme, setForceSettingsHelper, applyCardOpacity} from './lib/widgetVisualKit.js';
import {applyCardBlur} from './lib/cardLayers.js';
import {ForceSettingsHelper} from './lib/forceSettingsHelper.js';
import {WidgetCenterOverlay} from './lib/widgetCenterOverlay.js';
import {ThemePackRegistry} from './lib/themePackRegistry.js';
import {createLogger} from './lib/logger.js';
import {importGwctDocument} from './lib/exportService.js';

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
        // 2026-08-04 bug fix: seed lib/widgetVisualKit.js's module-level
        // forced-theme state right away, not just on the first
        // theme.json change below - otherwise every widget that opens
        // with a Force switch already on would render un-forced once at
        // startup. See widgetVisualKit.js's setForcedTheme() doc comment
        // for the full story on why this exists.
        setForcedTheme(this._themeService.getGlobalTheme());
        // Cross-process live reload (2026-07-21): the Control Center's
        // Appearance page (prefs.js, separate process) writes theme.json
        // directly via ThemeService.setGlobalTheme()/setWidgetTheme() —
        // this picks that up in the Shell process without needing a
        // restart, same pattern as settingsWatcher.js for widgets/<id>.json.
        this._themeService.watch(() => {
            setForcedTheme(this._themeService.getGlobalTheme());
            this._reapplyTheme();
        });

        // Force Settings (2026-08-09, HANDOVER_FORCE_SETTINGS.md next-
        // steps item 2) — the NEWER single-GSettings-switch-per-property
        // mechanism (Background Color / Corner Radius / Background Blur /
        // Shadow) that widgetVisualKit.js's cardStyleCss()/blurCss()/
        // shadowBoxShadowCss() already know how to consult via
        // setForceSettingsHelper() (see that file — Addendum 3 wired the
        // consult-side in, this is the construct-and-call-it side).
        // Separate from ThemeService/ theme.json above, which still owns
        // Border/Opacity's OLDER per-property force flags unchanged — see
        // forceSettingsHelper.js's file header for the product decision.
        //
        // ForceSettingsHelper needs a raw Gio.Settings (get_boolean()/
        // get_int()/get_string()/connect('changed', ...)), not the
        // SettingsService wrapper built just below (whose only public
        // surface is getGlobalValue()/setGlobalValue() — see
        // HANDOVER_FORCE_SETTINGS.md's "API mismatch caught" note from the
        // Prefs UI pass for why that wrapper was deliberately not
        // widened). This calls Extension.getSettings() directly, exactly
        // like SettingsService.init() does one line further down for its
        // own copy — two independent Gio.Settings objects on the same
        // schema/backing dconf keys is the same pattern ThemeService/
        // SettingsService already use side by side, not a new one.
        try {
            const forceGSettings = this.getSettings('org.gnome.shell.extensions.widget-center');
            this._forceSettingsHelper = new ForceSettingsHelper(forceGSettings);
            // Seed it immediately, same "don't wait for the first change
            // signal" reasoning as setForcedTheme() above — a widget that
            // opens with a Force switch already on must render forced on
            // the very first paint, not just from the next GSettings change.
            setForceSettingsHelper(this._forceSettingsHelper);
            // 2026-08-09 (HANDOVER_FORCE_SETTINGS.md next-steps item 1):
            // also seed lib/themeService.js's own copy, so `themeable:
            // true` widgets (clock, calendar-minimal, etc. — routed
            // through ThemeService.applyWidgetStyle() instead of
            // widgetVisualKit.js's cardStyleCss()/blurCss()/
            // shadowBoxShadowCss(), see _reapplyTheme() below) resolve
            // Force identically to every other widget instead of having
            // no equivalent at all. Same instance, same "seed before
            // first paint" timing as the setForceSettingsHelper() call
            // just above — ThemeService is already constructed/init'd
            // earlier in this method, so this is safe to call now.
            this._themeService.setForceSettingsHelper(this._forceSettingsHelper);
            this._forceSettingsChangedId = this._forceSettingsHelper.watch(() => {
                this._reapplyTheme();
            });
        } catch (e) {
            // Same non-essential-degrade-gracefully treatment as
            // SettingsService below — a Force Settings failure should
            // never block widgets from rendering at all (they simply keep
            // using their own per-widget config.json values).
            console.error('[widget-center] ForceSettingsHelper setup failed', e);
            this._forceSettingsHelper = null;
        }

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
        // Layout Engine (task 14, renamed from GridEngine 2026-07-28 when
        // grid-snapping was removed — see lib/layoutEngine.js). Pure
        // geometry (no signals, no disk) - see its file header. Seeded
        // from GSettings up front so a value the user changed in a
        // previous session (or the schema's own defaults) takes effect
        // immediately, then kept live via onChanged() below so the
        // Control Center's "Desktop" category (prefs.js) takes effect on
        // the desktop without a shell restart, same pattern as
        // dev-mode/disabled-widgets. WidgetEditMode's Settings/Remove
        // callbacks are wired below, once `loader`/`this._settings` exist
        // (they're defined further down in this method), so they're
        // filled in via a small indirection here rather than restructuring
        // this method's existing top-to-bottom order.
        this._layout = new LayoutEngine(this._readLayoutSettings());
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
        this._editDrag = new EditModeDragController(this._layer, this._storage, this._layout, this._editMode, this._logger, this._settings);
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

            // Layout Engine (task 14) live sync — prefs.js's "Desktop"
            // category writes these three keys directly; both processes
            // watch the same dconf-backed keys, same pattern as
            // dev-mode/disabled-widgets above, so a change there takes
            // effect on the desktop immediately, no shell restart needed.
            this._preventOverlapChangedId = this._settings.onChanged('prevent-widget-overlap',
                value => { this._layout.preventOverlap = value; });
            this._edgeMarginChangedId = this._settings.onChanged('edge-margin',
                value => { this._layout.edgeMargin = value; });
            this._widgetSpacingChangedId = this._settings.onChanged('widget-spacing',
                value => {
                    this._layout.spacing = value;
                    // `this._loader` isn't assigned until just below (it's
                    // created a few lines further down in this same
                    // enable() call) - safe regardless, since this
                    // callback only ever actually runs later, in response
                    // to a real settings change, by which point enable()
                    // has long since finished and this._loader exists.
                    if (this._loader)
                        this._loader.shadowOverflowMargin = value;
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
        // shadowOverflowMargin (4th arg) is seeded from the same
        // `widget-spacing` GSetting LayoutEngine's own `spacing` just was
        // above - a widget's drop-shadow is allowed to bleed past its
        // block-type footprint, but never past the gap already
        // guaranteed between neighboring widgets, so it can never bleed
        // into one - see widgetLoader.js's constructor doc and
        // WIDGET_API.md §9.3. Kept live via the same onChanged('widget-
        // spacing', ...) listener below that already updates
        // `this._layout.spacing`.
        const loader = new WidgetLoader(
            [bundledWidgetsPath, userWidgetsPath], this._storage, console,
            this._settings?.isReady ? this._settings.getGlobalValue('widget-spacing') : 0,
            this._settings
        );
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
            this._languageChangedId = this._settings.onChanged('language',
                lang => loader.notifyHostLanguageChanged(lang ?? ''));
            // 2026-08-10 fix (theme apply doesn't load position): both the
            // overlay's Themes-tab switch AND the separate prefs process's
            // theme card switch (lib/prefsWindowController.js) now just
            // write this one key - see _applyActiveThemePack()'s own doc
            // comment for the full unload/reimport/reload sequence this
            // triggers, and why the old per-caller logic never actually
            // repositioned an already-running widget.
            this._activeThemePackChangedId = this._settings.onChanged('active-theme-pack',
                id => this._applyActiveThemePack(id).catch(e =>
                    console.error(`[widget-center] failed to apply theme pack "${id}"`, e)));
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

        // Widget Center Overlay (2026-08-04 merge - was a standalone,
        // opt-in add-on staged separately until now; see
        // lib/widgetCenterOverlay.js's own header). Tight-integration
        // form: passes this extension's already-built services through
        // so the overlay's Remove/Settings do exactly what Edit Mode's
        // own buttons do, instead of falling back to its built-in
        // discovery-only behavior. Gives: the overlay itself (Overview +
        // Themes + Preferences tabs), Super+F12 (customizable from either
        // Preferences copy — see widget-center-overlay-keybinding in the
        // gschema), and D-Bus toggling for the .desktop launcher.
        this._widgetCenterOverlay = new WidgetCenterOverlay(this, {
            widgetLoader: this._loader,
            logger: this._logger,
            onWidgetSettings: id => this._openWidgetSettings(id),
            onWidgetRemove: id => this._removeWidgetViaEditMode(id),
            onOpenPreferences: () => {
                this.openPreferences()?.catch(e =>
                    console.error("[widget-center] openPreferences() failed", e));
            },
            // onApplyThemePack removed 2026-08-10: the overlay's Themes tab
            // now only ever writes the `active-theme-pack` GSettings key
            // (lib/widgetCenterOverlay.js's `_loadThemePack()`) - the actual
            // apply (unload → reimport the pack's document → reload +
            // notify) happens once, uniformly, from this same process's own
            // `active-theme-pack` watcher above (`_applyActiveThemePack()`),
            // whether the key was set by this overlay or by the separate
            // prefs process's own theme card switch. Doing it here too, as
            // this callback used to, duplicated that work and - for a flat
            // .gwct pack with saved positions - never actually moved an
            // already-running widget, which is the bug this removal fixes.
        });
        this._widgetCenterOverlay.enable();
    }

    disable() {
        this._cancelLoad?.();
        this._cancelLoad = null;

        // Closes the overlay if it's currently open and destroys its
        // actors - done FIRST, before this._loader/this._editMode etc
        // below are torn down, since the overlay only reaches those
        // through the callbacks passed into its constructor and closing
        // it may still be mid-teardown referencing them otherwise.
        this._widgetCenterOverlay?.disable();
        this._widgetCenterOverlay = null;

        // Stop watching theme.json for external changes before anything
        // below tears down the actors _reapplyTheme() would otherwise
        // touch on a stray in-flight debounced callback. Clear its
        // ForceSettingsHelper reference (2026-08-09, HANDOVER_FORCE_
        // SETTINGS.md next-steps item 1) before nulling the instance
        // itself, same "stop consulting a helper whose Gio.Settings is
        // about to go away" reasoning as widgetVisualKit.js's own
        // setForceSettingsHelper(null) just below.
        this._themeService?.unwatch();
        this._themeService?.setForceSettingsHelper(null);
        this._themeService = null;
        setForcedTheme(null);

        // Force Settings — same ordering reasoning as ThemeService right
        // above: stop watching before anything _reapplyTheme() would touch
        // is torn down below, then clear the module-level helper reference
        // so widgetVisualKit.js falls back to its OLDER _forcedTheme path
        // (already null'd above) rather than calling into a helper whose
        // Gio.Settings is about to go away too.
        this._forceSettingsHelper?.unwatch(this._forceSettingsChangedId);
        this._forceSettingsChangedId = null;
        this._forceSettingsHelper = null;
        setForceSettingsHelper(null);

        if (this._settings && this._disabledChangedId != null)
            this._settings.disconnect(this._disabledChangedId);
        this._disabledChangedId = null;

        if (this._settings && this._languageChangedId != null)
            this._settings.disconnect(this._languageChangedId);
        this._languageChangedId = null;

        if (this._settings && this._activeThemePackChangedId != null)
            this._settings.disconnect(this._activeThemePackChangedId);
        this._activeThemePackChangedId = null;
        this._applyingThemePack = false;

        if (this._settings && this._devChangedId != null)
            this._settings.disconnect(this._devChangedId);
        this._devChangedId = null;

        if (this._settings && this._preventOverlapChangedId != null)
            this._settings.disconnect(this._preventOverlapChangedId);
        this._preventOverlapChangedId = null;
        if (this._settings && this._edgeMarginChangedId != null)
            this._settings.disconnect(this._edgeMarginChangedId);
        this._edgeMarginChangedId = null;
        if (this._settings && this._widgetSpacingChangedId != null)
            this._settings.disconnect(this._widgetSpacingChangedId);
        this._widgetSpacingChangedId = null;

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
        this._layout = null;

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
     * @private Reads the three LayoutEngine (task 14) GSettings keys up
     * front for the constructor call in enable() — falls back to
     * LayoutEngine's own built-in defaults (matching the schema's
     * `<default>` values) when SettingsService isn't ready, same
     * degrade-gracefully approach `initialDisabled`/`devModeOn` below
     * already use for their own GSettings reads.
     * @returns {{preventOverlap: boolean, edgeMargin: number, spacing: number}|{}}
     */
    _readLayoutSettings() {
        if (!this._settings?.isReady)
            return {};

        try {
            return {
                preventOverlap: this._settings.getGlobalValue('prevent-widget-overlap'),
                edgeMargin: this._settings.getGlobalValue('edge-margin'),
                spacing: this._settings.getGlobalValue('widget-spacing'),
            };
        } catch (e) {
            console.error('[widget-center] could not read layout settings, using defaults', e);
            return {};
        }
    }

    /**
     * @private Re-styles every currently-placed widget from the current
     * (just-reloaded) theme, plus every already-built Edit Mode back
     * card. Called by the `ThemeService.watch()` callback wired in
     * enable() — see there for why this exists (cross-process live
     * reload from the Control Center's Appearance page).
     *
     * Two different mechanisms cover two different sets of widgets here:
     *  - `themeable: true` widgets (a handful, e.g. calendar-minimal/
     *    clock, that don't paint their own background at all) get
     *    lib/themeService.js's applyWidgetStyle() as before - it fully
     *    owns their style.
     *  - EVERY OTHER widget (the ~50 that call
     *    lib/widgetVisualKit.js's cardStyleCss() from their own
     *    _render()) gets a plain `_render()` call instead. 2026-08-04 bug
     *    fix: previously nothing told these widgets a Force toggle had
     *    changed at all - cardStyleCss() is now Force-aware (see
     *    widgetVisualKit.js's setForcedTheme(), called right before this
     *    method runs), but a widget only picks that up the next time it
     *    happens to re-render on its own. This makes the change visible
     *    immediately instead of "eventually, next time something else
     *    triggers this widget's own re-render".
     */
    _reapplyTheme() {
        if (!this._themeService)
            return; // disable() already tore this down — nothing to reapply to

        if (this._loader) {
            for (const entry of this._loader.instances) {
                try {
                    if (entry.metadata['themeable'])
                        this._themeService.applyWidgetStyle(entry.actor, entry.id);
                    else
                        entry.instance._render?.();
                } catch (e) {
                    console.error(`[widget-center] Failed to reapply theme for "${entry.id}"`, e);
                }
                // Opacity/Blur - see _placeEntry()'s matching call for why
                // this runs unconditionally, outside the themeable branch
                // above: neither property is part of applyWidgetStyle()'s
                // or _render()'s own CSS output.
                this._applyCardEffects(entry);
            }
        }

        this._editMode?.reapplyTheme();
    }

    /**
     * @private Applies the two per-widget visual properties that are
     * NOT expressible as a `set_style()` CSS string - Opacity (a plain
     * Clutter.Actor property) and Blur (a real Clutter.BlurEffect, since
     * the CSS `-st-background-blur` declaration widgetVisualKit.js's
     * cardStyleCss()/applyWidgetStyle() still also emit does not
     * actually render in the target environment - see
     * HANDOVER_FORCE_SETTINGS.md Addendum 6/4). Both helpers are
     * already fully Force-aware on their own (widgetVisualKit.js's
     * opacityValue() for the older theme.json border/opacity mechanism,
     * cardLayers.js's applyCardBlur() for the newer GSettings 4-switch
     * model) - this method's only job is to actually call them, on
     * every widget's own root actor, which nothing did before this fix.
     * @param {object} entry - a WidgetLoader entry: {actor, settings, ...}
     */
    _applyCardEffects(entry) {
        if (!entry?.actor)
            return;

        // 2026-08-09 blur-isolation fix: a widget that has migrated to
        // lib/cardLayers.js's createLayeredCard() exposes its layers as
        // `this._layers` (convention: {root, background, content}) and
        // already calls applyLayeredCardStyle(this._layers, settings, ...)
        // from its own _render() - which applies BOTH blur and opacity
        // to `layers.background` only, never touching `layers.content`
        // (the widget's own labels/icons/drawing areas). If this method
        // ALSO applied blur/opacity to `entry.actor` (== `layers.root`,
        // the parent of both background AND content) that would still
        // blur/fade everything - a Clutter effect on a parent actor
        // paints its whole subtree, background and content alike - which
        // defeats the entire point of the background/content split.
        // Skip entirely for layered widgets; their own render path is
        // already the single source of truth for both properties.
        if (entry.instance?._layers)
            return;

        try {
            applyCardOpacity(entry.actor, entry.settings);
        } catch (e) {
            console.error(`[widget-center] Failed to apply opacity for "${entry.id}"`, e);
        }
        try {
            applyCardBlur(entry.actor, entry.settings);
        } catch (e) {
            console.error(`[widget-center] Failed to apply blur for "${entry.id}"`, e);
        }
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
        // span (metadata['block-type']) times BlockSizeManager.BLOCK_CELL_SIZE. Unlike
        // the old pixel min/max system this never reads the actor's
        // current size, so there's no ordering dependency on
        // addWidgetActor() below anymore — see blockSizeManager.js's doc
        // comment for why the old system needed that ordering and this
        // one doesn't.
        try {
            BlockSizeManager.applyBlockSize(entry.metadata, entry.actor);
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

        // Opacity/Blur (2026-08-09 bug fix, HANDOVER item 1): neither of
        // these is expressible as a `set_style()` CSS string - opacity is
        // a plain Clutter.Actor property, blur needs a real
        // Clutter.BlurEffect - so no widget.js call site or ThemeService
        // path was ever applying either one, even though
        // widgetVisualKit.js's opacityValue()/applyCardOpacity() and
        // cardLayers.js's applyCardBlur() were already fully
        // Force-aware and correct in isolation. Applied here, once,
        // centrally, on every widget's own root `entry.actor` -
        // regardless of `themeable` - since this is the one place in the
        // codebase that already has both the actor and its settings on
        // hand for every widget. See _reapplyTheme() for the matching
        // call that keeps this live when a Force switch changes.
        this._applyCardEffects(entry);

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
     * @private Task 12's "Settings" back-side action. Opens the widget
     * Settings window deep-linked straight to this widget's own settings
     * sub-page.
     *
     * History (2026-07-20 through 2026-07-30, in order): first, writing
     * `requested-widget-id` to GSettings and calling
     * `Extension.openPreferences()`; then a `.catch()` on
     * `Main.extensionManager.openExtensionPrefs()`'s own promise once
     * `openPreferences()`'s fire-and-forget call turned out to be
     * uncatchable; then a debounce to stop rapid repeat clicks from
     * spamming that rejection; then a live GSettings subscription in
     * prefs.js so an *already-open* Preferences window would actually
     * jump to the newly-requested widget instead of just failing quietly.
     * Every one of those was a workaround for the same underlying fact:
     * GNOME Shell, not this extension, decides whether
     * `openExtensionPrefs()` spawns a new process or does something else
     * when one's already running — see prefs.js's matching history for
     * the fixes that took there.
     *
     * 2026-07-30 ("แยกหน้าต่าง widget preference ออกมาอิสระจาก extension
     * preference เลย" — split the widget Settings window out to be fully
     * independent, not routed through extension-prefs at all): instead
     * launch widget-center-prefs-app.js directly — a plain standalone
     * `Adw.Application` with its own application-id (see that file's
     * header) — as a subprocess, passing the widget id as a
     * `--widget-id=` argument. No GSettings round-trip, no debounce, no
     * `Main.extensionManager` involved. If that app is already running,
     * GLib/GIO's own single-instance activation hands this new argv
     * straight to the existing process over D-Bus and this subprocess
     * just exits — the "Preferences already open" failure mode every
     * fix above was chasing can't happen anymore, because there's no
     * separate "open a NEW prefs window" step left to fail.
     * @param {string} widgetId
     */
    _openWidgetSettings(widgetId) {
        const scriptPath = GLib.build_filenamev([this.path, 'widget-center-prefs-app.js']);
        try {
            Gio.Subprocess.new(
                ['gjs', '-m', scriptPath, `--widget-id=${widgetId}`],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            console.error(`[widget-center] could not launch the widget Settings app for "${widgetId}"`, e);
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
            BlockSizeManager.applyBlockSize(newEntry.metadata, newEntry.actor);
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
        if (this._applyingThemePack)
            return; // _applyActiveThemePack() is already reconciling this exact write - see its own doc comment

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

    /** @private same bundled+user themepacks/ search paths
     * lib/widgetCenterOverlay.js's `_userThemepacksRoots()`/
     * `_discoverThemePacks()` and lib/prefsWindowController.js's
     * `_discoverThemePacks()` already use - a third, Shell-process-only
     * copy rather than a shared import, matching this codebase's
     * existing convention for cheap, stateless per-process discovery
     * helpers (e.g. each process has its own `_pathMtimeUnix()`/
     * `_resolveScreenshotPath()` already). */
    _discoverThemePackById(id) {
        const bundledPath = GLib.build_filenamev([this.path, 'themepacks']);
        const userPath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'gnome-widget-center', 'themepacks',
        ]);
        const registry = new ThemePackRegistry([
            {path: bundledPath, source: 'bundled'},
            {path: userPath, source: 'user'},
        ]);
        return registry.discover().find(entry => entry.id === id) ?? null;
    }

    /**
     * @private Reacts to a live change of the `active-theme-pack`
     * GSettings key - fired from either this same process (the Widget
     * Center overlay's Themes tab switch, lib/widgetCenterOverlay.js's
     * `_loadThemePack()`) or the separate prefs process (lib/
     * prefsWindowController.js's own theme card switch), the same
     * cross-process GSettings-watch pattern `_applyDisabledWidgets()`
     * above already uses for `disabled-widgets`.
     *
     * 2026-08-10 fix ("theme apply doesn't load position"): this used to
     * be the overlay's own `onApplyThemePack` callback, reachable ONLY
     * from the overlay (never from the separate prefs process's own
     * Apply button - the actual bug report this addresses), and even
     * there it only ever wrote the imported settings/position/
     * appearance to disk via importGwctDocument() - it never unloaded/
     * reloaded the already-running widget instances, so a widget
     * already placed on the desktop never picked up its new
     * theme-supplied position; only a widget freshly enabled by the
     * theme (which loadAll() naturally places at its now-current saved
     * position) ever looked right.
     *
     * Fixed by doing the full sequence every time, from the one place
     * both processes' UI now funnels through by simply setting this
     * key:
     *   1. unload every currently-running widget (WidgetLoader.
     *      unloadAll(), same call disable() itself uses, after
     *      detaching each actor from the layer first - same ordering
     *      disable() uses, see that method).
     *   2. write the theme pack's document to disk (importGwctDocument()
     *      - global appearance, host settings, and per-widget settings/
     *      position/theme, batched into layout.json/theme.json/
     *      widgets/<id>.json/disabled-widgets).
     *   3. reload from those now-updated files (loader.loadAll() + the
     *      same `_placeEntry()` every widget gets at startup) - this is
     *      the step that actually makes a widget's new position/
     *      appearance take effect, since loadAll()/_placeEntry() always
     *      reads a widget's CURRENT saved position/settings, never a
     *      stale in-memory copy an already-running instance might still
     *      be holding.
     *   4. a Shell notification, so switching a theme on gives feedback
     *      beyond the switch itself flipping (per user ask).
     *
     * A legacy folder-form pack (`theme.json` with no embedded `.gwct`
     * document - see themePackRegistry.js's file header) has no
     * position/settings/appearance to restore at all, only a widget id
     * list - falls back to the pre-existing "just enable these ids"
     * behavior for that case, same as this method's predecessor did.
     *
     * `this._applyingThemePack` guards `_applyDisabledWidgets()` against
     * redundantly reconciling the SAME `disabled-widgets` write this
     * method's own importGwctDocument()/loadAll() call already fully
     * accounts for - without it, the `changed::disabled-widgets` signal
     * importGwctDocument() fires as a side effect would race this
     * method's own in-flight unload/reload with a second, partially
     * overlapping one.
     * @param {string} id - the new `active-theme-pack` value; '' means
     *   "no active pack" (e.g. a card's switch turned off) - nothing to
     *   apply, the switch turning off never undoes what a theme placed.
     */
    async _applyActiveThemePack(id) {
        if (!id || !this._loader || !this._layer || !this._storage || !this._themeService)
            return; // '' (switched off), or enable()/disable() still mid-flight

        const entry = this._discoverThemePackById(id);
        if (!entry) {
            console.warn(`[widget-center] active theme pack "${id}" not found on disk`);
            return;
        }

        this._applyingThemePack = true;
        try {
            if (entry.document) {
                // Same per-widget detach sequence _applyDisabledWidgets()
                // uses right above, and for the same reason: DragController/
                // EditModeDragController/WidgetEditMode/DevWatcher each key
                // their own tracking by widget id and treat attach()/
                // watchWidget() as a no-op once that id is already present.
                // Without detaching here first, loadAll()/_placeEntry()
                // below re-attach()es these same ids against freshly
                // reloaded actors, but every one of those calls is silently
                // swallowed as "already attached" against the OLD entry -
                // which still points at the actor unloadAll() is about to
                // destroy() - so every widget touched by a theme apply
                // would silently lose Super+drag, right-click edit mode,
                // edit-mode drag, and dev-mode watching until the next full
                // disable()/enable().
                for (const loadedEntry of this._loader.instances) {
                    this._devWatcher?.unwatchWidget(loadedEntry.id);
                    this._drag?.detach(loadedEntry.id);
                    this._editDrag?.detach(loadedEntry.id);
                    this._editMode?.detach(loadedEntry.id);
                    this._layer.removeWidgetActor(loadedEntry.id);
                }
                this._loader.unloadAll();

                const discovered = new Map(this._loader.discover().map(w => [w.id, w]));
                importGwctDocument(entry.document, {
                    storage: this._storage,
                    theme: this._themeService,
                    settings: this._settings,
                    discoveredWidgetsById: discovered,
                });

                const disabled = this._settings?.isReady
                    ? new Set(this._settings.getGlobalValue('disabled-widgets'))
                    : new Set();
                const started = await this._loader.loadAll(disabled);
                for (const startedEntry of started)
                    this._placeEntry(startedEntry);
            } else {
                const current = this._settings?.isReady
                    ? new Set(this._settings.getGlobalValue('disabled-widgets'))
                    : new Set();
                for (const widgetId of entry.manifest?.widgets ?? [])
                    current.delete(widgetId);
                if (this._settings?.isReady)
                    this._settings.setGlobalValue('disabled-widgets', Array.from(current));
            }

            Main.notify('GNOME Widget Center', `Theme "${entry.manifest?.name ?? id}" applied.`);
        } finally {
            this._applyingThemePack = false;
        }
    }
}
