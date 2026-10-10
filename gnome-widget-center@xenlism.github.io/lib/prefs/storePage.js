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

    // --- Repositories + tier badge (needs the signed manifest, so it is filled in after the page shows) ----
    const repoGroup = new Adw.PreferencesGroup({ title: tr("store.repo.title", "Repositories") });
    page.add(repoGroup);
    for (const repo of cfg.repos) {
        const row = new Adw.ActionRow({ title: repo.name ?? repo.id, subtitle: repo.url });
        const spinner = new Gtk.Spinner({ spinning: true, valign: Gtk.Align.CENTER });
        row.add_suffix(spinner);
        repoGroup.add(row);
        (async () => {
            try {
                const { manifest } = await new clientMod.StoreClient(repo, { intervalHours: cfg.checkIntervalHours, channel: cfg.channel }).getManifest();
                const b = tierBadge(integrity.effectiveTier(repo, manifest));      // never manifest.tier alone
                row.remove(spinner);
                row.add_suffix(new Gtk.Label({ label: b.text, css_classes: [ "caption", b.style ], valign: Gtk.Align.CENTER, tooltip_text: b.tooltip }));
            } catch (e) {
                row.remove(spinner);
                row.subtitle = `${repo.url}\n${tr("store.repo.unverified", "Could not verify this repository")}: ${e.message}`;
            }
        })();
    }

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
