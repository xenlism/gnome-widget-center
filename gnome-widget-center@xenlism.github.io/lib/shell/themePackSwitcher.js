import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { ThemePackRegistry } from "../themePackRegistry.js";

import { importGwctDocument } from "../exportService.js";

const REQUEST_KEY = "theme-pack-apply-request";

const ACTIVE_KEY = "active-theme-pack";

// Replaces the whole desktop with a theme pack: unload every widget, write the
// pack, load the pack's own widgets. Requests run one at a time, newest wins.
export class ThemePackSwitcher {
    constructor({extensionPath, loader, layer, storage, themeService, settings, logger, unloadAllWidgets, placeEntry, launchPrefs = null}) {
        this._extensionPath = extensionPath;
        this._loader = loader;
        this._layer = layer;
        this._storage = storage;
        this._themeService = themeService;
        this._settings = settings;
        this._logger = logger;
        this._unloadAllWidgets = unloadAllWidgets;
        this._placeEntry = placeEntry;
        this._launchPrefs = launchPrefs;
        this._askedMissing = new Set();
        this._requestHandlerId = null;
        this._queue = Promise.resolve();
        this._latestRequest = 0;
        this._running = 0;
    }

    get busy() {
        return this._running > 0;
    }

    enable() {
        this._requestHandlerId = this._settings.onChanged(REQUEST_KEY, value => {
            const id = String(value).split("|")[0];
            if (id)
                this._request(id);
        });
    }

    destroy() {
        this._settings.disconnect(this._requestHandlerId);
        this._requestHandlerId = null;
        this._latestRequest++;
        this._loader = null;
        this._layer = null;
        this._storage = null;
        this._themeService = null;
        this._settings = null;
        this._unloadAllWidgets = null;
        this._placeEntry = null;
        this._launchPrefs = null;
    }

    _request(id) {
        const requestNumber = ++this._latestRequest;
        const run = async () => {
            if (requestNumber !== this._latestRequest)
                return;
            this._running++;
            try {
                await this._switchTo(id);
            } catch (e) {
                this._logger.error(`theme pack "${id}" failed to apply`, e);
            } finally {
                // GSettings change notifications arrive after the writes above; stay "busy" until they have been
                // delivered, or the auto-enable policy re-disables the widgets the pack just switched on
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { resolve(); return GLib.SOURCE_REMOVE; }));
                this._running--;
            }
        };
        this._queue = this._queue.then(run);
    }

    async _findPack(id) {
        const registry = new ThemePackRegistry([
            {path: GLib.build_filenamev([this._extensionPath, "themepacks"]), source: "bundled"},
            {path: GLib.build_filenamev([GLib.get_user_config_dir(), "gnome-widget-center", "themepacks"]), source: "user"},
        ]);
        const entries = await registry.discover();
        return entries.find(entry => entry.id === id) ?? null;
    }

    _disabledIds() {
        return new Set(this._settings.getGlobalValue("disabled-widgets"));
    }

    async _switchTo(id) {
        const pack = await this._findPack(id);
        if (!this._loader)
            return;
        if (!pack) {
            Main.notify("GNOME Widget Center", `Theme pack "${id}" was not found.`);
            return;
        }

        const name = pack.manifest.name ?? id;
        let report = null;
        try {
            this._unloadAllWidgets();
            const discovered = new Map((await this._loader.discover()).map(w => [w.id, w]));
            if (!this._loader)
                return;
            this._markKnown(discovered);
            report = this._writePack(pack, discovered);
            const started = await this._loader.loadAll(this._disabledIds());
            if (!this._loader)
                return;
            for (const entry of started)
                this._placeEntry(entry);
            this._settings.setGlobalValue(ACTIVE_KEY, id);
        } catch (e) {
            this._logger.error(`theme pack "${id}" failed to apply`, e);
            Main.notify("GNOME Widget Center", `Theme "${name}" could not be applied: ${e.message}`);
            await this._restoreEnabledWidgets();
            return;
        }

        Main.notify("GNOME Widget Center", this._summary(name, report));
        this._offerMissingWidgets(id, name, report);
    }

    // Widgets the pack uses that are not installed: hand them to the prefs app, which looks them up in the user's enabled
    // repositories and asks for consent once (installing code needs a dialog, so it cannot happen silently in the shell).
    // Asked once per pack + set of missing ids per session, so a widget no store has cannot cause a loop.
    _offerMissingWidgets(id, name, report) {
        const ids = (report?.missingWidgets ?? []).map(w => w.id).filter(Boolean);
        if (!ids.length || !this._launchPrefs) return;
        const key = `${id}|${[...ids].sort().join(",")}`;
        if (this._askedMissing.has(key)) return;
        this._askedMissing.add(key);
        try {
            // --open takes every argument after it, so these flags only work because none of them is --open
            this._launchPrefs([`--install-widgets=${ids.join(",")}`, `--apply-theme=${id}`, `--theme-name=${name}`]);
        } catch (e) {
            this._logger.error("could not open the prefs app to install missing widgets", e);
        }
    }

    // Widgets the host has not "seen" yet (just installed from the store) would be switched off by applyAutoEnablePolicy
    // the next time it runs, undoing the pack's own enabled list. Mark everything found right now as known first.
    _markKnown(discovered) {
        try {
            const known = new Set(this._settings.getGlobalValue("known-widget-ids"));
            let changed = false;
            for (const widgetId of discovered.keys()) {
                if (known.has(widgetId)) continue;
                known.add(widgetId);
                changed = true;
            }
            if (changed) this._settings.setGlobalValue("known-widget-ids", Array.from(known));
        } catch (e) {
            this._logger.error("theme pack: could not update known-widget-ids", e);
        }
    }

    _writePack(pack, discovered) {
        if (pack.document) {
            return importGwctDocument(pack.document, {
                storage: this._storage,
                theme: this._themeService,
                settings: this._settings,
                discoveredWidgetsById: discovered,
            });
        }
        const packIds = new Set(pack.manifest.widgets);
        const disabled = [...discovered.keys()].filter(widgetId => !packIds.has(widgetId));
        this._settings.setGlobalValue("disabled-widgets", disabled);
        return null;
    }

    async _restoreEnabledWidgets() {
        if (!this._loader || this._loader.instances.length > 0)
            return;
        const restored = await this._loader.loadAll(this._disabledIds());
        if (!this._loader)
            return;
        for (const entry of restored)
            this._placeEntry(entry);
    }

    _summary(name, report) {
        let message = `Theme "${name}" applied.`;
        if (!report)
            return message;
        if (report.missingWidgets.length > 0)
            message += ` Not installed: ${report.missingWidgets.map(w => w.name).join(", ")}.`;
        if (report.dependencyWarnings.length > 0)
            message += ` Missing tools: ${[...new Set(report.dependencyWarnings.map(d => d.bin))].join(", ")}.`;
        return message;
    }
}
