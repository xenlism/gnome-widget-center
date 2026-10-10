// storeBrowsePage.js - the "Store" TAB of the prefs window: browse the widgets / theme packs of the enabled repositories
// and install them. The store SETTINGS (release channel, repositories, rollback) are not here: they live in
// Preferences > Store (storePage.js).
//
// Installing goes through store/openUri.js handleOpen() - the same consent dialog, signature and hash checks as a
// gwc:// link, so this page adds no trust logic of its own. Store modules are imported lazily so a failure there leaves a
// status page instead of breaking the prefs window.
import Adw from "gi://Adw";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

const KINDS = [
    { id: "widgets", key: "store.kind.widgets", fallback: "Widgets", param: "w" },
    { id: "themepacks", key: "store.kind.themepacks", fallback: "Theme packs", param: "t" },
];

const MAX_ROWS = 300;

const esc = s => GLib.markup_escape_text(String(s ?? ""), -1);      // store text is untrusted and ActionRow parses markup

function statusPage(icon, title, description) {
    return new Adw.StatusPage({ icon_name: icon, title, description: description ?? "", vexpand: true, margin_top: 24 });
}

/**
 * @param window  the Adw.PreferencesWindow (parent of the install dialogs, toast target)
 * @param tr      (key, fallback) => string
 * @param o.onOpenSettings  called by the "Store settings" button (jumps to Preferences > Store)
 * @returns Adw.PreferencesPage (not yet added to the window)
 */
export function buildStoreBrowsePage(window, tr, { onOpenSettings = null, onInstalled = null } = {}) {
    const page = new Adw.PreferencesPage({ title: tr("tab.store.label", "Store"), icon_name: "folder-download-symbolic" });
    const group = new Adw.PreferencesGroup;
    page.add(group);
    const clamp = new Adw.Clamp({ maximum_size: 800, tightening_threshold: 600 });
    const container = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, hexpand: true, vexpand: true });
    clamp.set_child(container);
    group.add(clamp);

    let mods = null;                    // lazily imported store modules
    let kind = "widgets";
    let query = "";
    let registry = null;
    let loadToken = 0;
    const cache = {};                   // kind -> { entries: [{ repo, item }], errors: [{ repo, error }] }

    // --- toolbar --------------------------------------------------------------------------------
    const toolbar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    const kindBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, css_classes: [ "linked" ] });
    let firstToggle = null;
    const toggles = {};
    for (const k of KINDS) {
        const b = new Gtk.ToggleButton({ label: tr(k.key, k.fallback), active: k.id === kind });
        if (firstToggle) b.set_group(firstToggle); else firstToggle = b;
        b.connect("toggled", () => {
            if (!b.active || kind === k.id) return;
            kind = k.id;
            load(false);
        });
        toggles[k.id] = b;
        kindBox.append(b);
    }
    toolbar.append(kindBox);
    const search = new Gtk.SearchEntry({ hexpand: true, placeholder_text: tr("store.search.placeholder", "Search the store…") });
    search.connect("search-changed", () => { query = search.text.trim().toLowerCase(); render(); });
    toolbar.append(search);
    const refreshBtn = new Gtk.Button({ icon_name: "view-refresh-symbolic", valign: Gtk.Align.CENTER, tooltip_text: tr("store.refresh", "Refresh") });
    refreshBtn.connect("clicked", () => load(true));
    toolbar.append(refreshBtn);
    if (onOpenSettings) {
        const settingsBtn = new Gtk.Button({ icon_name: "emblem-system-symbolic", valign: Gtk.Align.CENTER, tooltip_text: tr("store.settings.open", "Store settings") });
        settingsBtn.connect("clicked", () => onOpenSettings());
        toolbar.append(settingsBtn);
    }
    container.append(toolbar);

    // --- results --------------------------------------------------------------------------------
    const scroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true, min_content_height: 420, hscrollbar_policy: Gtk.PolicyType.NEVER });
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
    scroll.set_child(body);
    container.append(scroll);

    const setBody = widget => {
        let c = body.get_first_child();
        while (c) { const n = c.get_next_sibling(); body.remove(c); c = n; }
        body.append(widget);
    };

    function installedState(item) {
        const live = registry?.get(kind, item.id)?.v ?? null;
        if (!live) return { label: tr("store.install", "Install"), sensitive: true, style: "suggested-action" };
        const c = mods.semver.cmpVersion(item.v, live);
        if (c === 1) return { label: tr("store.update", "Update"), sensitive: true, style: "suggested-action", note: `v${live} → v${item.v}` };
        return { label: tr("store.installed", "Installed"), sensitive: false, style: null, note: `v${live}` };
    }

    function buildRow({ repo, item }, multiRepo) {
        const st = installedState(item);
        const meta = [ item.a, `v${item.v}`, item.c, multiRepo ? (repo.name ?? repo.id) : null, item.ch === "beta" ? tr("store.beta", "beta") : null ].filter(Boolean).join(" · ");
        const row = new Adw.ActionRow({
            title: esc(item.n ?? item.id),
            subtitle: `${esc(meta)}${item.d ? `\n${esc(item.d)}` : ""}`,
            subtitle_lines: 3,
            title_lines: 1,
        });
        const btn = new Gtk.Button({ label: st.label, valign: Gtk.Align.CENTER, sensitive: st.sensitive });
        if (st.style) btn.add_css_class(st.style);
        if (st.note) btn.tooltip_text = st.note;
        btn.connect("clicked", async () => {
            const k = KINDS.find(x => x.id === kind);
            const link = `gwc://install?repo=${encodeURIComponent(repo.url)}&${k.param}=${encodeURIComponent(item.id)}`;
            btn.sensitive = false;
            try {
                await mods.openUri.handleOpen(window, link, { registry, onInstalled: () => { render(); onInstalled?.(); } });
            } catch (e) {
                logError(e, "[widget-center] prefs: store install failed");
                window.add_toast(new Adw.Toast({ title: e.message }));
            } finally {
                registry = await mods.InstallRegistry.load().catch(() => registry);
                render();
            }
        });
        row.add_suffix(btn);
        return row;
    }

    function render() {
        if (!mods) return;
        const data = cache[kind];
        if (!data) return;
        const all = data.entries;
        const hits = all
            .filter(({ item }) => !query || [ item.n, item.id, item.a, item.d, item.c ].some(f => String(f ?? "").toLowerCase().includes(query)))
            .sort((a, b) => String(a.item.n ?? a.item.id).localeCompare(String(b.item.n ?? b.item.id)));
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
        for (const { repo, error } of data.errors) {
            box.append(new Adw.ActionRow({
                title: esc(repo.name ?? repo.id),
                subtitle: esc(`${tr("store.repo.unverified", "Could not verify this repository")}: ${error.message}`),
                css_classes: [ "error" ],
            }));
        }
        if (!hits.length) {
            box.append(all.length
                ? statusPage("edit-find-symbolic", tr("store.nomatch.title", "No matches"), tr("store.nomatch.description", "Nothing in the store matches your search."))
                : data.errors.length
                    ? statusPage("network-error-symbolic", tr("store.unreachable.title", "Store unavailable"), tr("store.unreachable.description", "The store could not be reached or verified."))
                    : statusPage("folder-download-symbolic", tr("store.empty.title", "Nothing here yet"), tr("store.empty.description", "This store has no items of this kind in your release channel.")));
            setBody(box);
            return;
        }
        const multiRepo = new Set(hits.map(h => h.repo.id)).size > 1;
        const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: [ "boxed-list" ] });
        for (const h of hits.slice(0, MAX_ROWS)) list.append(buildRow(h, multiRepo));
        box.append(list);
        if (hits.length > MAX_ROWS) box.append(new Gtk.Label({ label: tr("store.more", "Refine your search to see more."), css_classes: [ "dim-label" ] }));
        setBody(box);
    }

    async function load(force) {
        const token = ++loadToken;
        if (!mods) {
            try {
                const [ repoConfig, storeClient, installRegistry, semver, openUri ] = await Promise.all([
                    import("../store/repoConfig.js"), import("../store/storeClient.js"), import("../store/installRegistry.js"),
                    import("../store/semver.js"), import("../store/openUri.js"),
                ]);
                mods = { repoConfig, StoreClient: storeClient.StoreClient, InstallRegistry: installRegistry.InstallRegistry, semver, openUri };
            } catch (e) {
                logError(e, "[widget-center] prefs: store modules unavailable");
                setBody(statusPage("dialog-warning-symbolic", tr("store.modules.title", "Store unavailable"), tr("store.modules.description", "The store modules could not be loaded.")));
                return;
            }
        }
        if (!force && cache[kind]) { render(); return; }
        const spinner = new Gtk.Spinner({ spinning: true, width_request: 32, height_request: 32, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, margin_top: 48 });
        setBody(spinner);
        const wanted = kind;
        let cfg;
        try {
            cfg = await mods.repoConfig.loadRepoConfig();
            registry = await mods.InstallRegistry.load();
        } catch (e) {
            logError(e, "[widget-center] prefs: store config failed");
            setBody(statusPage("dialog-warning-symbolic", tr("store.modules.title", "Store unavailable"), e.message));
            return;
        }
        const repos = cfg.repos.filter(r => r.enabled !== false);
        const entries = [], errors = [];
        await Promise.all(repos.map(async repo => {
            try {
                const client = new mods.StoreClient(repo, { intervalHours: cfg.checkIntervalHours, channel: cfg.channel });
                if (force) await client.getManifest({ force: true });
                for (const item of await client.getAllItems(wanted)) entries.push({ repo, item });
            } catch (e) {
                logError(e, `[widget-center] prefs: store repo "${repo.id}" failed`);
                errors.push({ repo, error: e });
            }
        }));
        if (token !== loadToken) return;                // the user switched kind / refreshed meanwhile
        cache[wanted] = { entries, errors };
        render();
    }

    load(false).catch(e => logError(e, "[widget-center] prefs: store page failed"));
    return page;
}
