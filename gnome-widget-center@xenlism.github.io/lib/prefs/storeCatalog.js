// storeCatalog.js - the store data behind the Widgets and Themes tabs of the prefs window (it replaces the old Store tab).
// One instance per prefs window: it loads the enabled repositories once per kind, keeps the install registry, installs through
// store/openUri.js handleOpen() (same consent dialog, signature and hash checks as a gwc:// link - no trust logic of its own here)
// and renders the "withdrawn by the store" list. The cards themselves are built in prefsStoreCards.js.
// Store modules are imported lazily so a failure there only leaves the store cards out, never breaks the prefs window.
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";

import { escapeMarkup } from "./prefsUtils.js";

const PARAM = { widgets: "w", themepacks: "t" };

export class StoreCatalog {
    constructor(tr) {
        this._tr = tr;
        this._mods = null;
        this._registry = null;
        this._cache = {};                         // kind -> { entries: [{ repo, item }], errors: [{ repo, error }] }
        this._pending = {};                       // kind -> Promise (one fetch at a time per kind)
        this._clients = new Map();                // repo.id -> StoreClient (kept so a card can fetch its cover)
        this._forceKinds = new Set();             // kinds whose next load must bypass the manifest cache
        this._revokedChecked = false;
        this._boxes = new Set();
        this._window = null;
    }

    async _loadMods() {
        if (this._mods) return this._mods;
        const [ repoConfig, storeClient, installRegistry, semver, openUri, revocation ] = await Promise.all([
            import("../store/repoConfig.js"), import("../store/storeClient.js"), import("../store/installRegistry.js"),
            import("../store/semver.js"), import("../store/openUri.js"), import("../store/revocation.js"),
        ]);
        this._mods = { repoConfig, StoreClient: storeClient.StoreClient, InstallRegistry: installRegistry.InstallRegistry, semver, openUri, revocation };
        return this._mods;
    }

    /** Next load of every kind asks the stores again instead of using the cached manifest (Refresh button). */
    invalidate() {
        this._cache = {};
        this._forceKinds = new Set(Object.keys(PARAM));
        this._revokedChecked = false;
    }

    /** Re-read what is installed (after an install / uninstall) without touching the network. */
    async reloadRegistry() {
        if (!this._mods) return;
        this._registry = await this._mods.InstallRegistry.load().catch(() => this._registry);
    }

    /** @returns Promise<{ entries, errors }>; rejects when the store modules or the repo config cannot be loaded. */
    load(kind, window = null) {
        if (window) this._window = window;
        if (this._cache[kind]) return Promise.resolve(this._cache[kind]);
        if (this._pending[kind]) return this._pending[kind];
        const p = this._fetch(kind).finally(() => { if (this._pending[kind] === p) delete this._pending[kind]; });
        this._pending[kind] = p;
        return p;
    }

    async _fetch(kind) {
        const mods = await this._loadMods();
        const force = this._forceKinds.delete(kind);
        const cfg = await mods.repoConfig.loadRepoConfig();
        this._registry = await mods.InstallRegistry.load();
        const entries = [], errors = [];
        await Promise.all(cfg.repos.filter(r => r.enabled !== false).map(async repo => {
            try {
                const client = new mods.StoreClient(repo, { intervalHours: cfg.checkIntervalHours, channel: cfg.channel });
                this._clients.set(repo.id, client);
                if (force) await client.getManifest({ force: true });
                for (const item of await client.getAllItems(kind)) entries.push({ repo, item });
            } catch (e) {
                logError(e, `[widget-center] prefs: store repo "${repo.id}" failed`);
                errors.push({ repo, error: e });
            }
        }));
        this._cache[kind] = { entries, errors };
        this.checkWithdrawn();
        return this._cache[kind];
    }

    /** { live: installed version or null, update: a newer version is in the store } */
    stateOf(kind, item) {
        const live = this._registry?.get(kind, item.id)?.v ?? null;
        if (!live) return { live: null, update: false };
        return { live, update: this._mods.semver.cmpVersion(item.v, live) === 1 };
    }

    /** Hash-verified, cached cover path (or null). */
    coverPath(repo, item) {
        const client = this._clients.get(repo.id);
        return item.cv && client ? client.getCoverPath(item.cv) : Promise.resolve(null);
    }

    /** Runs the same consent + verification flow as a gwc://install link. onInstalled(kind, id) fires after a successful install. */
    async install(window, kind, repo, item, onInstalled) {
        const link = `gwc://install?repo=${encodeURIComponent(repo.url)}&${PARAM[kind]}=${encodeURIComponent(item.id)}`;
        try {
            await this._mods.openUri.handleOpen(window, link, { registry: this._registry, onInstalled });
        } finally {
            await this.reloadRegistry();
        }
    }

    // --- items installed from a store that has since withdrawn them --------------------------------
    async checkWithdrawn() {
        if (this._revokedChecked || !this._mods?.revocation) return;
        this._revokedChecked = true;
        let fresh = 0;
        for (const client of this._clients.values()) {
            try { fresh += (await this._mods.revocation.checkRevocations(client, this._registry)).fresh.length; }
            catch (e) { logError(e, "[widget-center] prefs: revocation check failed"); }
        }
        for (const b of [ ...this._boxes ]) { if (b.get_root()) b.refresh(); else this._boxes.delete(b); }
        if (fresh) this._window?.add_toast(new Adw.Toast({ title: this._tr("store.withdrawn.fresh", "The store withdrew something you installed") }));
    }

    /**
     * The "Withdrawn by the store" list for one kind (empty box when nothing was withdrawn).
     * @param o.onDisable  (kind, id) called BEFORE the item is quarantined (prefs: add a widget to disabled-widgets so the Shell unloads it)
     * @param o.onChanged  () called after an item was quarantined (prefs: rebuild the tabs)
     */
    buildWithdrawnBox(window, kind, { onDisable = null, onChanged = null } = {}) {
        const tr = this._tr;
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 12, margin_start: 24, margin_end: 24 });
        box.refresh = () => {
            let c = box.get_first_child();
            while (c) { const n = c.get_next_sibling(); box.remove(c); c = n; }
            const items = (this._registry?.revokedList?.() ?? []).filter(i => i.kind === kind);
            if (!items.length) return;
            box.append(new Gtk.Label({ label: tr("store.withdrawn.heading", "Withdrawn by the store"), xalign: 0, css_classes: [ "heading" ] }));
            const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: [ "boxed-list" ] });
            for (const { kind: k, id, reason } of items) {
                const row = new Adw.ActionRow({
                    title: escapeMarkup(id),
                    subtitle: escapeMarkup(String(reason ?? "").slice(0, 300) || tr("store.withdrawn.noreason", "The store gave no reason.")),
                    subtitle_lines: 3, title_lines: 1,
                });
                row.add_prefix(new Gtk.Image({ icon_name: "dialog-warning-symbolic", css_classes: [ "warning" ] }));
                const btn = new Gtk.Button({
                    label: tr("store.withdrawn.disable", "Disable"), valign: Gtk.Align.CENTER, css_classes: [ "destructive-action" ],
                    tooltip_text: tr("store.withdrawn.tooltip", "Stops it and moves it to quarantine. Nothing is deleted."),
                });
                btn.connect("clicked", async () => {
                    btn.sensitive = false;
                    try {
                        onDisable?.(k, id);                                   // the Shell unloads a widget before its files move
                        this._mods.revocation.quarantineRevoked(this._registry, { kind: k, id });
                        await this._registry.forget(k, id);
                        window.add_toast(new Adw.Toast({ title: tr("store.withdrawn.done", "Moved to quarantine") + `: ${id}` }));
                        box.refresh();
                        onChanged?.();
                    } catch (e) {
                        logError(e, `[widget-center] prefs: could not disable withdrawn "${id}"`);
                        window.add_toast(new Adw.Toast({ title: e.message }));
                        btn.sensitive = true;
                    }
                });
                row.add_suffix(btn);
                list.append(row);
            }
            box.append(list);
        };
        this._boxes.add(box);
        box.refresh();
        return box;
    }
}
