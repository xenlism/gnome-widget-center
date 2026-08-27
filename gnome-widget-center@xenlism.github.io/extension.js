import GLib from "gi://GLib";

import Gio from "gi://Gio";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { WidgetRuntimeLoader } from "./lib/shell/widgetRuntimeLoader.js";

import { WidgetLayer } from "./lib/shell/widgetLayer.js";

import { StorageService } from "./lib/storageService.js";

import { SettingsService } from "./lib/settingsService.js";

import { DragController } from "./lib/shell/dragController.js";

import { MonitorWatcher } from "./lib/monitorWatcher.js";

import { DevWatcher } from "./lib/devWatcher.js";

import { LayoutEngine } from "./lib/layoutEngine.js";

import { WidgetEditMode } from "./lib/shell/widgetEditMode.js";

import { EditModeDragController } from "./lib/shell/editModeDragController.js";

import { BlockSizeManager } from "./lib/blockSizeManager.js";

import { ThemeService } from "./lib/themeService.js";

import { setGlobalShadowHelper, applyCardOpacity } from "./lib/widgetVisualKit.js";

import { applyCardBlur } from "./lib/shell/cardLayers.js";

import { GlobalShadowHelper } from "./lib/globalShadowHelper.js";

import { WidgetCenterOverlay } from "./lib/shell/widgetCenterOverlay.js";

import { ThemePackRegistry } from "./lib/themePackRegistry.js";

import { createLogger } from "./lib/logger.js";

import { importGwctDocument } from "./lib/exportService.js";

import { GlobalScreenshotKeybinding } from "./lib/shell/globalScreenshotKeybinding.js";

import { applyAutoEnablePolicy } from "./lib/autoEnablePolicy.js";

export default class WidgetCenterExtension extends Extension {
    enable() {
        this._storage = new StorageService;
        this._storage.init();
        this._themeService = new ThemeService;
        this._themeService.init();
        this._themeService.watch(() => this._reapplyTheme());
        try {
            const shadowGSettings = this.getSettings("org.gnome.shell.extensions.widget-center");
            this._globalShadowHelper = new GlobalShadowHelper(shadowGSettings);
            setGlobalShadowHelper(this._globalShadowHelper);
            this._globalShadowChangedId = this._globalShadowHelper.watch(() => {
                this._nudgeShadowAngle();
            });
        } catch (e) {
            console.error("[widget-center] GlobalShadowHelper setup failed", e);
            this._globalShadowHelper = null;
        }
        this._settings = new SettingsService(this);
        try {
            this._settings.init();
        } catch (e) {
            console.error("[widget-center] SettingsService.init() failed", e);
            this._settings = null;
        }
        this._logger = createLogger(this._settings);
        this._monitors = new MonitorWatcher;
        this._layer = new WidgetLayer(this._storage);
        this._layer.init(this._monitors.getMonitors(), this._monitors.primaryIndex);
        this._monitors.watch((monitors, primaryIndex) => this._layer.reconcileMonitors(monitors, primaryIndex));
        this._drag = new DragController(this._layer, this._storage);
        this._layout = new LayoutEngine(this._readLayoutSettings());
        this._editMode = new WidgetEditMode(this._storage, {
            onSettings: id => {
                this._logger.debug("edit-mode", `onSettings("${id}")`);
                this._openWidgetSettings(id);
            },
            onRemove: id => {
                this._logger.debug("edit-mode", `onRemove("${id}")`);
                this._removeWidgetViaEditMode(id);
            },
            onReset: id => {
                this._logger.debug("edit-mode", `onReset("${id}")`);
                this._resetWidgetViaEditMode(id);
            },
            onUninstall: (id, isUserInstalled) => {
                this._logger.debug("edit-mode", `onUninstall("${id}", isUserInstalled=${isUserInstalled})`);
                this._uninstallWidget(id, isUserInstalled);
            },
            onAddChild: id => {
                this._logger.debug("edit-mode", `onAddChild("${id}")`);
                this._addChildViaEditMode(id);
            },
            onBackActorReady: (id, toolbarActor, dragArea) => {
                this._logger.debug("edit-mode", `onBackActorReady("${id}")`);
                this._editDrag?.armDragHandle(id, toolbarActor, dragArea);
            }
        }, this._logger, this._themeService);
        this._editDrag = new EditModeDragController(this._layer, this._storage, this._layout, this._editMode, this._logger, this._settings);
        this._editDrag.setOthersProvider((monitorIndex, excludeId) => this._othersOnMonitor(monitorIndex, excludeId));
        this._devWatcher = new DevWatcher(id => this._reloadWidget(id));
        if (this._settings?.isReady) {
            this._devChangedId = this._settings.onChanged("dev-mode", enabled => {
                this._logger?.log(`Development Mode ${enabled ? "ON" : "OFF"}`);
                if (enabled) this._devWatcher.start(this._loader?.instances.map(e => ({
                    id: e.id,
                    path: e.path
                })) ?? []); else this._devWatcher.stop();
            });
            this._preventOverlapChangedId = this._settings.onChanged("prevent-widget-overlap", value => {
                this._layout.preventOverlap = value;
            });
            this._edgeMarginChangedId = this._settings.onChanged("edge-margin", value => {
                this._layout.edgeMargin = value;
            });
            this._widgetSpacingChangedId = this._settings.onChanged("widget-spacing", value => {
                this._layout.spacing = value;
                if (this._loader) this._loader.shadowOverflowMargin = value;
            });
        }
        const bundledWidgetsPath = GLib.build_filenamev([ this.path, "widgets" ]);
        const userWidgetsPath = GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "widgets" ]);
        this._userWidgetsPath = userWidgetsPath;
        const loader = new WidgetRuntimeLoader([ bundledWidgetsPath, userWidgetsPath ], this._storage, this._logger, this._settings?.isReady ? this._settings.getGlobalValue("widget-spacing") : 0, this._settings, this._themeService, () => this._loadNewlyDiscoveredWidgets().catch(e => this._logger?.error("rescan-triggered _loadNewlyDiscoveredWidgets failed", e)));
        this._loader = loader;
        let cancelled = false;
        this._cancelLoad = () => {
            cancelled = true;
        };
        // discover() reads each widget's metadata.json asynchronously
        // (EGO-X-004), so the auto-enable policy, the resulting
        // "disabled-widgets" read, and loadAll() all have to wait for it -
        // they must run in this order and are guarded by `cancelled` in case
        // disable() runs before this resolves.
        loader.discover().then(discovered => {
            if (cancelled) return null;
            if (this._settings?.isReady) applyAutoEnablePolicy(this._settings, discovered, userWidgetsPath, this._logger);
            const initialDisabled = new Set(this._settings?.isReady ? this._settings.getGlobalValue("disabled-widgets") : []);
            if (this._settings?.isReady) {
                this._disabledChangedId = this._settings.onChanged("disabled-widgets", ids => this._applyDisabledWidgets(new Set(ids)));
                this._languageChangedId = this._settings.onChanged("language", lang => loader.notifyHostLanguageChanged(lang ?? ""));
                this._activeThemePackChangedId = this._settings.onChanged("active-theme-pack", id => this._applyActiveThemePack(id).catch(e => this._logger?.error(`failed to apply theme pack "${id}"`, e)));
            }
            return loader.loadAll(initialDisabled);
        }).then(started => {
            if (cancelled || started === null) return;
            this._logger.log(`[widget-center] loaded ${started.length} widget(s)`);
            for (const err of loader.errors) this._logger?.warn(`"${err.id}" failed: ${err.reason}`);
            if (cancelled) {
                loader.unloadAll();
                return;
            }
            for (const entry of started) this._placeEntry(entry);
            const devModeOn = this._settings?.isReady && this._settings.getGlobalValue("dev-mode");
            if (devModeOn) this._devWatcher.start(started.map(e => ({
                id: e.id,
                path: e.path
            })));
        }).catch(e => this._logger?.error("enable() widget discovery/load sequence failed", e));
        this._widgetCenterOverlay = new WidgetCenterOverlay(this, {
            widgetLoader: this._loader,
            logger: this._logger,
            onWidgetSettings: id => this._openWidgetSettings(id),
            onWidgetRemove: id => this._removeWidgetViaEditMode(id),
            onWidgetUninstall: id => this._uninstallWidget(id, true)
        });
        this._widgetCenterOverlay.enable();
        try {
            const keybindingGSettings = this.getSettings("org.gnome.shell.extensions.widget-center");
            this._globalScreenshotKeybinding = new GlobalScreenshotKeybinding(this, keybindingGSettings, this._logger);
            this._globalScreenshotKeybinding.enable();
        } catch (e) {
            this._logger?.error("could not set up the global screenshot keybinding", e);
            this._globalScreenshotKeybinding = null;
        }
    }
    disable() {
        this._cancelLoad?.();
        this._cancelLoad = null;
        this._globalScreenshotKeybinding?.disable();
        this._globalScreenshotKeybinding = null;
        this._widgetCenterOverlay?.disable();
        this._widgetCenterOverlay = null;
        this._themeService?.unwatch();
        this._themeService = null;
        this._globalShadowHelper?.unwatch(this._globalShadowChangedId);
        this._globalShadowChangedId = null;
        this._globalShadowHelper = null;
        setGlobalShadowHelper(null);
        if (this._settings && this._disabledChangedId != null) this._settings.disconnect(this._disabledChangedId);
        this._disabledChangedId = null;
        if (this._settings && this._languageChangedId != null) this._settings.disconnect(this._languageChangedId);
        this._languageChangedId = null;
        if (this._settings && this._activeThemePackChangedId != null) this._settings.disconnect(this._activeThemePackChangedId);
        this._activeThemePackChangedId = null;
        this._applyingThemePack = false;
        if (this._settings && this._devChangedId != null) this._settings.disconnect(this._devChangedId);
        this._devChangedId = null;
        if (this._settings && this._preventOverlapChangedId != null) this._settings.disconnect(this._preventOverlapChangedId);
        this._preventOverlapChangedId = null;
        if (this._settings && this._edgeMarginChangedId != null) this._settings.disconnect(this._edgeMarginChangedId);
        this._edgeMarginChangedId = null;
        if (this._settings && this._widgetSpacingChangedId != null) this._settings.disconnect(this._widgetSpacingChangedId);
        this._widgetSpacingChangedId = null;
        this._devWatcher?.stop();
        this._devWatcher = null;
        this._drag?.destroy();
        this._drag = null;
        this._editDrag?.destroy();
        this._editDrag = null;
        this._editMode?.destroy();
        this._editMode = null;
        this._layout = null;
        this._monitors?.destroy();
        this._monitors = null;
        if (this._loader && this._layer) {
            for (const entry of this._loader.instances) this._layer.removeWidgetActor(entry.id);
        }
        this._loader?.unloadAll();
        this._loader = null;
        this._layer?.destroy();
        this._layer = null;
        this._storage = null;
        this._settings = null;
        this._userWidgetsPath = null;
    }
    _readLayoutSettings() {
        if (!this._settings?.isReady) return {};
        try {
            return {
                preventOverlap: this._settings.getGlobalValue("prevent-widget-overlap"),
                edgeMargin: this._settings.getGlobalValue("edge-margin"),
                spacing: this._settings.getGlobalValue("widget-spacing")
            };
        } catch (e) {
            this._logger?.error("could not read layout settings, using defaults", e);
            return {};
        }
    }
    _reapplyTheme() {
        this._editMode?.reapplyTheme();
    }
    _nudgeShadowAngle() {
        if (!this._loader) return;
        for (const entry of this._loader.instances) {
            try {
                entry.instance?._render?.();
            } catch (e) {
                this._logger?.error(`Failed to nudge shadow angle for "${entry.id}"`, e);
            }
        }
    }
    _applyCardEffects(entry) {
        if (!entry?.actor) return;
        if (entry.instance?._layers) return;
        try {
            applyCardOpacity(entry.actor, entry.settings);
        } catch (e) {
            this._logger?.error(`Failed to apply opacity for "${entry.id}"`, e);
        }
        try {
            applyCardBlur(entry.actor, entry.settings);
        } catch (e) {
            this._logger?.error(`Failed to apply blur for "${entry.id}"`, e);
        }
    }
    _placeEntry(entry) {
        const fallback = entry.metadata["default-position"] ?? {
            x: 40,
            y: 40
        };
        const position = this._layer.getSavedPosition(entry.id, fallback);
        try {
            BlockSizeManager.applyBlockSize(entry.metadata, entry.actor);
        } catch (e) {
            this._logger?.error(`Failed to apply block size for "${entry.id}"`, e);
        }
        this._applyCardEffects(entry);
        try {
            this._layer.addWidgetActor(entry.id, entry.actor, position);
            const monitorIndex = this._layer.getMonitorIndexFor(entry.id);
            this._drag.attach(entry.id, entry.actor, monitorIndex);
            const isUserInstalled = this._userWidgetsPath != null && entry.path.startsWith(this._userWidgetsPath);
            this._editMode.attach(entry.id, entry.actor, {
                isUserInstalled: isUserInstalled,
                hasAddChild: typeof entry.instance?._addChild === "function"
            });
            this._editDrag.attach(entry.id, entry.actor, monitorIndex);
            this._devWatcher?.watchWidget(entry.id, entry.path);
        } catch (e) {
            this._logger?.error(`"${entry.id}" could not be placed in the layer`, e);
        }
    }
    _openWidgetSettings(widgetId) {
        const scriptPath = GLib.build_filenamev([ this.path, "widget-center-prefs-app.js" ]);
        try {
            Gio.Subprocess.new([ "gjs", "-m", scriptPath, `--widget-id=${widgetId}` ], Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._logger?.error(`could not launch the widget Settings app for "${widgetId}"`, e);
        }
    }
    async _addChildViaEditMode(widgetId) {
        const entry = this._loader?.instances.find(e => e.id === widgetId);
        if (typeof entry?.instance?._addChild !== "function") {
            this._logger?.warn(`"${widgetId}" has no _addChild() - cannot add a widget from edit mode`);
            return;
        }
        try {
            await entry.instance._addChild();
        } catch (e) {
            this._logger?.error(`"${widgetId}" _addChild() failed`, e);
        }
    }
    async _resetWidgetViaEditMode(widgetId) {
        if (!this._loader || !this._layer) return;
        const oldEntry = this._loader.instances.find(e => e.id === widgetId);
        if (!oldEntry) {
            this._editMode?.detach(widgetId);
            return;
        }
        this._drag?.detach(widgetId);
        this._editDrag?.detach(widgetId);
        this._editMode?.detach(widgetId);
        this._layer.removeWidgetActor(widgetId);
        const newEntry = await this._loader.reloadWidget(widgetId);
        if (!newEntry) {
            this._logger?.error(`"${widgetId}" could not be reloaded after Reset`);
            return;
        }

        const fallback = newEntry.metadata["default-position"] ?? {
            x: 40,
            y: 40
        };
        const position = this._layer.getSavedPosition(widgetId, fallback);
        try {
            BlockSizeManager.applyBlockSize(newEntry.metadata, newEntry.actor);
        } catch (e) {
            this._logger?.error(`Failed to apply block size for "${widgetId}" after Reset`, e);
        }
        try {
            this._layer.addWidgetActor(widgetId, newEntry.actor, position);
            this._drag?.attach(widgetId, newEntry.actor, position.monitorIndex);
            const isUserInstalled = this._userWidgetsPath != null && newEntry.path.startsWith(this._userWidgetsPath);
            this._editMode?.attach(widgetId, newEntry.actor, {
                isUserInstalled: isUserInstalled,
                hasAddChild: typeof newEntry.instance?._addChild === "function"
            });
            this._editDrag?.attach(widgetId, newEntry.actor, position.monitorIndex);
        } catch (e) {
            this._logger?.error(`"${widgetId}" could not be re-placed after Reset`, e);
        }
    }
    _removeWidgetViaEditMode(widgetId) {
        if (!this._settings?.isReady) {
            this._logger?.warn(`"${widgetId}" could not be removed — SettingsService unavailable`);
            return;
        }
        try {
            const current = new Set(this._settings.getGlobalValue("disabled-widgets"));
            current.add(widgetId);
            this._settings.setGlobalValue("disabled-widgets", Array.from(current));
        } catch (e) {
            this._logger?.error(`"${widgetId}" could not be removed via disabled-widgets`, e);
        }
    }
    _uninstallWidget(widgetId, isUserInstalled) {
        if (!isUserInstalled) {
            this._logger?.warn(`refusing to uninstall bundled widget "${widgetId}"`);
            return;
        }
        const entry = this._loader?.instances.find(e => e.id === widgetId);
        const widgetPath = entry?.path;
        this._removeWidgetViaEditMode(widgetId);
        try {
            this._storage?.resetWidgetSettings(widgetId);
            this._storage?.removeWidgetLayoutEntry(widgetId);
        } catch (e) {
            this._logger?.error(`failed to clear config for "${widgetId}"`, e);
        }
        if (!widgetPath || !this._userWidgetsPath || !widgetPath.startsWith(this._userWidgetsPath)) {
            this._logger?.warn(`"${widgetId}" has no known user-installed path — skipping file move`);
            return;
        }
        try {
            const uninstallRoot = GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "uninstalled" ]);
            const rootDir = Gio.File.new_for_path(uninstallRoot);
            if (!rootDir.query_exists(null)) rootDir.make_directory_with_parents(null);
            let destPath = GLib.build_filenamev([ uninstallRoot, widgetId ]);
            let dest = Gio.File.new_for_path(destPath);
            if (dest.query_exists(null)) {
                destPath = GLib.build_filenamev([ uninstallRoot, `${widgetId}-${Date.now()}` ]);
                dest = Gio.File.new_for_path(destPath);
            }
            const source = Gio.File.new_for_path(widgetPath);
            source.move(dest, Gio.FileCopyFlags.NONE, null, null);
        } catch (e) {
            this._logger?.error(`failed to move files for "${widgetId}" to uninstalled/`, e);
        }
    }
    _deleteRecursively(file) {
        const info = file.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const children = file.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
            let child;
            while ((child = children.next_file(null)) !== null) this._deleteRecursively(file.get_child(child.get_name()));
            children.close(null);
        }
        file.delete(null);
    }
    _othersOnMonitor(monitorIndex, excludeId) {
        if (!this._loader || !this._layer) return [];
        return this._loader.instances.filter(e => e.id !== excludeId && this._layer.getMonitorIndexFor(e.id) === monitorIndex).map(e => {
            const [x, y] = e.actor.get_position();
            const [width, height] = e.actor.get_size();
            return {
                id: e.id,
                x: x,
                y: y,
                width: width,
                height: height
            };
        });
    }
    async _reloadWidget(widgetId) {
        if (!this._loader || !this._layer) return;
        const oldEntry = this._loader.instances.find(e => e.id === widgetId);
        if (!oldEntry) return;
        const position = {
            x: oldEntry.actor.get_x(),
            y: oldEntry.actor.get_y(),
            monitorIndex: this._layer.getMonitorIndexFor(widgetId)
        };

        this._drag?.detach(widgetId);
        this._editDrag?.detach(widgetId);
        this._editMode?.detach(widgetId);
        this._layer.removeWidgetActor(widgetId);

        const newEntry = await this._loader.reloadWidget(widgetId);
        if (!newEntry) return;

        try {
            this._layer.addWidgetActor(widgetId, newEntry.actor, position);
            this._drag?.attach(widgetId, newEntry.actor, position.monitorIndex);
            const isUserInstalled = this._userWidgetsPath != null && newEntry.path.startsWith(this._userWidgetsPath);
            this._editMode?.attach(widgetId, newEntry.actor, {
                isUserInstalled: isUserInstalled,
                hasAddChild: typeof newEntry.instance?._addChild === "function"
            });
            this._editDrag?.attach(widgetId, newEntry.actor, position.monitorIndex);
        } catch (e) {
            this._logger?.error(`"${widgetId}" could not be re-placed after hot-reload`, e);
        }
    }
    _applyDisabledWidgets(disabledIds) {
        if (!this._loader || !this._layer) return;
        if (this._applyingThemePack) return;
        const loadedIds = new Set(this._loader.instances.map(e => e.id));
        for (const id of loadedIds) {
            if (!disabledIds.has(id)) continue;
            this._devWatcher?.unwatchWidget(id);
            this._drag?.detach(id);
            this._editDrag?.detach(id);
            this._editMode?.detach(id);
            this._layer.removeWidgetActor(id);
            this._loader.unloadOne(id);
        }
        this._loadNewlyDiscoveredWidgets(disabledIds).catch(e => this._logger?.error("_loadNewlyDiscoveredWidgets failed", e));
    }
    async _loadNewlyDiscoveredWidgets(disabledIds = null) {
        if (!this._loader || !this._layer) return;
        if (this._applyingThemePack) return;
        const discovered = await this._loader.discover();
        if (!this._loader || !this._layer) return;
        let disabled = disabledIds ?? new Set(this._settings?.isReady ? this._settings.getGlobalValue("disabled-widgets") : []);
        if (this._settings?.isReady) {
            const reconciled = applyAutoEnablePolicy(this._settings, discovered, this._userWidgetsPath, this._logger);
            disabled = disabledIds ? new Set([ ...disabledIds, ...reconciled ]) : reconciled;
        }
        const loadedIds = new Set(this._loader.instances.map(e => e.id));
        for (const widgetInfo of discovered) {
            if (disabled.has(widgetInfo.id) || loadedIds.has(widgetInfo.id)) continue;
            this._loader.loadOne(widgetInfo).then(entry => entry && this._placeEntry(entry)).catch(e => this._logger?.error(`"${widgetInfo.id}" failed to load`, e));
        }
    }
    async _discoverThemePackById(id) {
        const bundledPath = GLib.build_filenamev([ this.path, "themepacks" ]);
        const userPath = GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks" ]);
        const registry = new ThemePackRegistry([ {
            path: bundledPath,
            source: "bundled"
        }, {
            path: userPath,
            source: "user"
        } ]);
        const entries = await registry.discover();
        return entries.find(entry => entry.id === id) ?? null;
    }
    async _applyActiveThemePack(id) {
        if (!id || !this._loader || !this._layer || !this._storage || !this._themeService) return;
        const entry = await this._discoverThemePackById(id);
        if (!this._loader || !this._layer || !this._storage || !this._themeService) return;
        if (!entry) {
            this._logger?.warn(`active theme pack "${id}" not found on disk`);
            return;
        }
        this._applyingThemePack = true;
        try {
            if (entry.document) {
                for (const loadedEntry of this._loader.instances) {
                    this._devWatcher?.unwatchWidget(loadedEntry.id);
                    this._drag?.detach(loadedEntry.id);
                    this._editDrag?.detach(loadedEntry.id);
                    this._editMode?.detach(loadedEntry.id);
                    this._layer.removeWidgetActor(loadedEntry.id);
                }
                this._loader.unloadAll();
                const discovered = new Map((await this._loader.discover()).map(w => [ w.id, w ]));
                importGwctDocument(entry.document, {
                    storage: this._storage,
                    theme: this._themeService,
                    settings: this._settings,
                    discoveredWidgetsById: discovered
                });
                const disabled = this._settings?.isReady ? new Set(this._settings.getGlobalValue("disabled-widgets")) : new Set;
                const started = await this._loader.loadAll(disabled);
                for (const startedEntry of started) this._placeEntry(startedEntry);
            } else {
                const current = this._settings?.isReady ? new Set(this._settings.getGlobalValue("disabled-widgets")) : new Set;
                for (const widgetId of entry.manifest?.widgets ?? []) current.delete(widgetId);
                if (this._settings?.isReady) this._settings.setGlobalValue("disabled-widgets", Array.from(current));
            }
            Main.notify("GNOME Widget Center", `Theme "${entry.manifest?.name ?? id}" applied.`);
        } finally {
            this._applyingThemePack = false;
        }
    }
}