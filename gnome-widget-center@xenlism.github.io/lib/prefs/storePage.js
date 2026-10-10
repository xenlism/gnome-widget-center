// storePage.js - STORE SETTINGS, shown in the prefs window under Preferences > Store: release channel, update-check
// interval, repositories with their tier badge, rollback. (Browsing / installing is the "Store" tab: storeBrowsePage.js.)
// Wording/rules: lib/store/prefsModel.js (pure, unit-tested). The page itself is only widget plumbing.
// Store modules are imported lazily so a failure there leaves a status page instead of breaking prefs.
import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { CHANNELS, channelNote, channelRow, rollbackConfirm, rollbackState, tierBadge, withChannel } from "../store/prefsModel.js";

const KINDS = [ [ "widgets", "Widgets" ], [ "themepacks", "Theme packs" ] ];

/** ids that have a kept previous version on disk. Widgets keep a folder <id>/, theme packs a file <id>.gwct; dotfiles are swap leftovers. */
function keptIds(kind, prevRoot) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(prevRoot).enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
        for (let i = en.next_file(null); i; i = en.next_file(null)) {
            const n = i.get_name(), dir = i.get_file_type() === Gio.FileType.DIRECTORY;
            if (n.startsWith(".")) continue;
            if (kind === "widgets" && dir) out.push(n);
            if (kind === "themepacks" && !dir && n.endsWith(".gwct")) out.push(n.slice(0, -5));
        }
    } catch (_e) { /* no prev dir yet: nothing to roll back */ }
    return out.sort();
}

function placeholder(page, tr, reason) {
    const g = new Adw.PreferencesGroup;
    page.add(g);
    g.add(new Adw.StatusPage({
        icon_name: "dialog-warning-symbolic",
        title: tr("store.modules.title", "Store unavailable"),
        description: tr("store.modules.description", "The store modules could not be loaded.") + (reason ? `\n\n(${reason})` : ""),
        vexpand: true,
    }));
}

export async function buildStoreSettings(page, window, tr) {
    let repoConfig, integrity, rollback, registryMod, fmt, clientMod;
    try {
        [ repoConfig, integrity, rollback, registryMod, fmt, clientMod ] = await Promise.all([
            import("../store/repoConfig.js"), import("../store/integrity.js"), import("../store/rollback.js"),
            import("../store/installRegistry.js"), import("../store/gwcFormat.js"), import("../store/storeClient.js"),
        ]);
    } catch (e) {
        logError(e, "[widget-center] prefs: store modules unavailable");
        placeholder(page, tr, "store modules failed to load");
        return;
    }

    let cfg = await repoConfig.loadRepoConfig();

    // --- Channel ---------------------------------------------------------------------------------
    const channelGroup = new Adw.PreferencesGroup({ title: tr("store.channel.group", "Releases") });
    page.add(channelGroup);
    const channelRowW = new Adw.ComboRow({
        title: tr("store.channel.title", "Release channel"),
        subtitle: CHANNELS[channelRow(cfg)].hint,
        model: Gtk.StringList.new(CHANNELS.map(c => c.label)),
        selected: channelRow(cfg),
    });
    channelRowW.connect("notify::selected", async () => {
        const next = CHANNELS[channelRowW.selected].id;
        if (next === cfg.channel) return;
        const note = channelNote(cfg.channel, next);
        cfg = withChannel(cfg, next);
        try { await repoConfig.saveRepoConfig(cfg); }
        catch (e) { logError(e, "[widget-center] prefs: saving channel failed"); window.add_toast(new Adw.Toast({ title: e.message })); }
        channelRowW.subtitle = note ?? CHANNELS[channelRowW.selected].hint;
    });
    channelGroup.add(channelRowW);

    const intervalRow = new Adw.SpinRow({
        title: tr("store.interval.title", "Check for updates every (hours)"),
        subtitle: tr("store.interval.subtitle", "How long the store catalogue is kept before it is checked again."),
        adjustment: new Gtk.Adjustment({ lower: 1, upper: 168, step_increment: 1, page_increment: 6, value: cfg.checkIntervalHours ?? 12 }),
    });
    let intervalTimer = 0;
    intervalRow.connect("notify::value", () => {
        if (intervalTimer) GLib.source_remove(intervalTimer);
        intervalTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {      // debounce: one write per burst of clicks
            intervalTimer = 0;
            cfg = { ...cfg, checkIntervalHours: Math.round(intervalRow.value) };
            repoConfig.saveRepoConfig(cfg).catch(e => { logError(e, "[widget-center] prefs: saving check interval failed"); window.add_toast(new Adw.Toast({ title: e.message })); });
            return GLib.SOURCE_REMOVE;
        });
    });
    intervalRow.connect("destroy", () => { if (intervalTimer) { GLib.source_remove(intervalTimer); intervalTimer = 0; } });
    channelGroup.add(intervalRow);

    // --- Repositories: any number of them; add, edit (name + address), enable/disable, remove ------------------
    const repoGroup = new Adw.PreferencesGroup({
        title: tr("store.repo.title", "Repositories"),
        description: tr("store.repo.description", "Widgets and theme packs from every enabled repository appear in the Store tab. Each repository is verified with its own signing key."),
    });
    page.add(repoGroup);
    const addBtn = new Gtk.Button({ icon_name: "list-add-symbolic", valign: Gtk.Align.CENTER, css_classes: [ "flat" ], tooltip_text: tr("store.repo.add", "Add repository") });
    repoGroup.set_header_suffix(addBtn);

    const toast = title => window.add_toast(new Adw.Toast({ title }));
    const persist = async next => {
        try { await repoConfig.saveRepoConfig(next); cfg = next; return true; }
        catch (e) { logError(e, "[widget-center] prefs: saving repositories failed"); toast(e.message); return false; }
    };

    /** Name + address form. Returns { name, url } or null (cancelled). Re-asks, keeping what was typed, until the address parses. */
    async function askRepo({ heading, okLabel, repo = null }) {
        let name = repo?.name ?? "", url = repo?.url ?? "", error = "";
        for (;;) {
            const nameRow = new Adw.EntryRow({ title: tr("store.repo.name", "Name (optional)"), text: name });
            const urlRow = new Adw.EntryRow({ title: tr("store.repo.url", "Repository URL (https://…)"), text: url, input_purpose: Gtk.InputPurpose.URL });
            const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: [ "boxed-list" ] });
            list.append(urlRow); list.append(nameRow);
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
            box.append(list);
            if (error) box.append(new Gtk.Label({ label: error, wrap: true, xalign: 0, css_classes: [ "error" ] }));
            const d = new Adw.AlertDialog({ heading, body: tr("store.repo.form.body", "Only add repositories from authors you trust: widgets are code that runs with your user's permissions.") });
            d.set_extra_child(box);
            d.add_response("cancel", tr("dialog.cancel", "Cancel"));
            d.add_response("ok", okLabel);
            d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED);
            d.set_default_response("ok");
            urlRow.connect("entry-activated", () => d.response("ok"));
            nameRow.connect("entry-activated", () => d.response("ok"));
            const res = await new Promise(resolve => d.choose(window, null, (_d, r) => resolve(d.choose_finish(r))));
            name = nameRow.text.trim(); url = urlRow.text.trim();
            if (res !== "ok") return null;
            try { repoConfig.normalizeRepoUrl(url); return { name, url }; }
            catch (e) { error = e.message || tr("store.repo.url.invalid", "Repo URL must be https://"); }
        }
    }

    /** Fetch the key a non-official address signs with and make the user confirm its fingerprint. Returns [{kid,pub}] or null. */
    async function trustKey(url, { okLabel = tr("store.repo.trust.ok", "Trust and add"), replacing = false } = {}) {
        let probe;
        try { probe = await new clientMod.StoreClient({ url }).probeKey(); }
        catch (e) { toast(`${tr("store.repo.keyfail", "Cannot read this store's key")}: ${e.message}`); return null; }
        const d = new Adw.AlertDialog({
            heading: tr("store.repo.trust.heading", "Trust this store?"),
            body: `${url}\n\n${tr("store.repo.trust.body", "It signs its catalogue with key")} “${probe.kid}”:\n\n${probe.fingerprint}\n\n`
                + (replacing ? tr("store.repo.key.replace", "This replaces the key you trusted before.") + "\n\n" : "")
                + tr("store.repo.trust.warn", "Only continue if you got this fingerprint from the store's owner by another route (their website, a README you trust). Widgets are code and run with your user's permissions."),
        });
        d.add_response("cancel", tr("dialog.cancel", "Cancel"));
        d.add_response("ok", okLabel);
        d.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE);
        d.set_default_response("cancel");
        const res = await new Promise(resolve => d.choose(window, null, (_d, r) => resolve(d.choose_finish(r))));
        return res === "ok" ? [ { kid: probe.kid, pub: probe.pub } ] : null;
    }

    async function onAdd() {
        const input = await askRepo({ heading: tr("store.repo.add", "Add repository"), okLabel: tr("store.repo.add.ok", "Add") });
        if (!input) return;
        try {
            const url = repoConfig.canonicalRepoUrl(input.url);
            if (repoConfig.findRepoByUrl(cfg, url)) { toast(tr("store.repo.duplicate", "Repo already in list")); return; }
            const keys = url === repoConfig.OFFICIAL_REPO.url ? [] : await trustKey(url);
            if (!keys) return;
            if (await persist(repoConfig.addRepo(JSON.parse(JSON.stringify(cfg)), { url, name: input.name, keys }))) renderRepos();
        } catch (e) { toast(e.message); }
    }

    async function onEdit(repo) {
        const input = await askRepo({ heading: tr("store.repo.edit", "Edit repository"), okLabel: tr("store.repo.edit.ok", "Save"), repo });
        if (!input) return;
        try {
            const url = repoConfig.canonicalRepoUrl(input.url);
            const moved = url !== repoConfig.canonicalRepoUrl(repo.url);
            let keys;
            if (moved && url !== repoConfig.OFFICIAL_REPO.url) { keys = await trustKey(url); if (!keys) return; }     // a new address = a new key to trust
            if (await persist(repoConfig.updateRepo(JSON.parse(JSON.stringify(cfg)), repo.id, { url, name: input.name, keys }))) renderRepos();
        } catch (e) { toast(e.message); }
    }

    /** Fetch the key this repo signs with, show its fingerprint, and pin it on confirmation. */
    async function onImportKey(repo) {
        const keys = await trustKey(repo.url, { okLabel: tr("store.repo.key.ok", "Trust and import"), replacing: !!repo.keys?.length });
        if (!keys) return;
        try { if (await persist(repoConfig.setRepoKeys(JSON.parse(JSON.stringify(cfg)), repo.id, keys))) { toast(tr("store.repo.key.done", "Key imported")); renderRepos(); } }
        catch (e) { toast(e.message); }
    }

    async function onRemove(repo) {
        const d = new Adw.AlertDialog({
            heading: tr("store.repo.remove.heading", "Remove this repository?"),
            body: `${repo.name ?? repo.id}\n${repo.url}\n\n${tr("store.repo.remove.body", "Items you already installed from it stay installed.")}`,
        });
        d.add_response("cancel", tr("dialog.cancel", "Cancel"));
        d.add_response("ok", tr("store.repo.remove", "Remove"));
        d.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE);
        d.set_default_response("cancel");
        const res = await new Promise(resolve => d.choose(window, null, (_d, r) => resolve(d.choose_finish(r))));
        if (res === "ok" && await persist(repoConfig.removeRepo(JSON.parse(JSON.stringify(cfg)), repo.id))) renderRepos();
    }

    async function onReset(repo) {
        try { if (await persist(repoConfig.resetToOfficial(JSON.parse(JSON.stringify(cfg)), repo.id))) renderRepos(); }
        catch (e) { toast(e.message); }
    }

    addBtn.connect("clicked", () => onAdd().catch(e => logError(e, "[widget-center] prefs: add repo failed")));

    let repoRows = [];
    let renderToken = 0;
    function renderRepos() {
        const token = ++renderToken;
        for (const r of repoRows) repoGroup.remove(r);
        repoRows = [];
        for (const repo of cfg.repos) {
            const row = new Adw.ActionRow({ title: GLib.markup_escape_text(repo.name ?? repo.id, -1), subtitle: GLib.markup_escape_text(repo.url, -1) });
            const spinner = new Gtk.Spinner({ spinning: true, valign: Gtk.Align.CENTER });
            row.add_suffix(spinner);
            const sw = new Gtk.Switch({ active: repo.enabled !== false, valign: Gtk.Align.CENTER, tooltip_text: tr("store.repo.enabled", "Enabled") });
            sw.connect("notify::active", () => { persist(repoConfig.setRepoEnabled(JSON.parse(JSON.stringify(cfg)), repo.id, sw.active)).then(ok => { if (!ok) sw.active = !sw.active; }); });
            const edit = new Gtk.Button({ icon_name: "document-edit-symbolic", valign: Gtk.Align.CENTER, css_classes: [ "flat" ], tooltip_text: tr("store.repo.edit", "Edit repository") });
            edit.connect("clicked", () => onEdit(repo).catch(e => logError(e, "[widget-center] prefs: edit repo failed")));
            row.add_suffix(edit);
            const keyBtn = new Gtk.Button({ icon_name: "dialog-password-symbolic", valign: Gtk.Align.CENTER, css_classes: [ "flat" ], tooltip_text: tr("store.repo.key.import", "Import signing key from this repository…") });
            keyBtn.connect("clicked", () => onImportKey(repo).catch(e => logError(e, "[widget-center] prefs: import key failed")));
            row.add_suffix(keyBtn);
            if (!repo.official && repoConfig.canonicalRepoUrl(repo.url) !== repoConfig.OFFICIAL_REPO.url && repo.id === repoConfig.OFFICIAL_REPO.id) {
                const reset = new Gtk.Button({ icon_name: "edit-undo-symbolic", valign: Gtk.Align.CENTER, css_classes: [ "flat" ], tooltip_text: tr("store.repo.reset", "Reset to the default address") });
                reset.connect("clicked", () => onReset(repo).catch(e => logError(e, "[widget-center] prefs: reset repo failed")));
                row.add_suffix(reset);
            }
            if (!repo.official) {
                const del = new Gtk.Button({ icon_name: "user-trash-symbolic", valign: Gtk.Align.CENTER, css_classes: [ "flat" ], tooltip_text: tr("store.repo.remove", "Remove") });
                del.connect("clicked", () => onRemove(repo).catch(e => logError(e, "[widget-center] prefs: remove repo failed")));
                row.add_suffix(del);
            }
            row.add_suffix(sw);
            repoGroup.add(row);
            repoRows.push(row);
            if (repo.enabled === false) { row.remove(spinner); continue; }
            (async () => {                                   // tier badge needs the signed manifest: filled in after the page shows
                try {
                    const { manifest } = await new clientMod.StoreClient(repo, { intervalHours: cfg.checkIntervalHours, channel: cfg.channel }).getManifest();
                    if (token !== renderToken) return;
                    const b = tierBadge(integrity.effectiveTier(repo, manifest));      // never manifest.tier alone
                    row.remove(spinner);
                    row.add_prefix(new Gtk.Label({ label: b.text, css_classes: [ "caption", b.style ], valign: Gtk.Align.CENTER, tooltip_text: b.tooltip }));
                } catch (e) {
                    if (token !== renderToken) return;
                    row.remove(spinner);
                    row.subtitle = `${GLib.markup_escape_text(repo.url, -1)}\n${GLib.markup_escape_text(`${tr("store.repo.unverified", "Could not verify this repository")}: ${e.message}`, -1)}`;
                }
            })();
        }
    }
    renderRepos();

    // --- Rollback --------------------------------------------------------------------------------
    let registry = null;
    try { registry = await registryMod.InstallRegistry.load(); }
    catch (e) { logError(e, "[widget-center] prefs: install registry failed"); }

    for (const [ kind, label ] of KINDS) {
        const ids = keptIds(kind, fmt.prevRootFor(kind));
        if (!ids.length) continue;
        const group = new Adw.PreferencesGroup({
            title: tr(`store.rollback.${kind}`, `Roll back: ${label}`),
            description: tr("store.rollback.note", "Takes effect after the item is reloaded (or after you log in again)."),
        });
        page.add(group);
        for (const id of ids) {
            const row = new Adw.ActionRow({ title: id });
            const btn = new Gtk.Button({ valign: Gtk.Align.CENTER });
            const refresh = () => {
                const live = registry?.get(kind, id)?.v ?? null;
                const st = rollbackState({ kind, live, kept: rollback.canRollback(kind, id), recorded: registry?.prevOf(kind, id) ?? null });
                btn.label = st.label; btn.tooltip_text = st.tooltip; btn.sensitive = st.available && !!registry;
                row.subtitle = live ? `v${live}` : "";
                return { st, live };
            };
            refresh();
            btn.connect("clicked", () => {
                const { st, live } = refresh();
                const c = rollbackConfirm({ kind, name: id, live, version: st.version });
                const d = new Adw.AlertDialog({ heading: c.heading, body: c.body });
                d.add_response("cancel", tr("dialog.cancel", "Cancel"));
                d.add_response("ok", c.confirm);
                d.set_default_response("cancel");
                d.choose(window, null, (_d, res) => {
                    if (d.choose_finish(res) !== "ok") return;
                    rollback.rollbackInstalled(registry, kind, id)
                        .catch(e => { logError(e, "[widget-center] prefs: rollback failed"); window.add_toast(new Adw.Toast({ title: e.message })); })
                        .finally(refresh);
                });
            });
            row.add_suffix(btn);
            group.add(row);
        }
    }
}
