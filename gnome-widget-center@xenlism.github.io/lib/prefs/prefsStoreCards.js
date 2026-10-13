// prefsStoreCards.js - store items inside the Widgets and Themes tabs (there is no separate Store tab any more).
// A store item that is not installed yet gets a card shaped like the installed ones, with an Install button instead of the
// Settings / Share / enable controls; an installed item with a newer store version gets an Update button on its own card.
// Trust / verification is unchanged: installing goes through StoreCatalog.install() -> store/openUri.js handleOpen().
import Adw from "gi://Adw";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import Pango from "gi://Pango";

import { StoreCatalog } from "./storeCatalog.js";
import { escapeMarkup } from "./prefsUtils.js";

export const PrefsStoreCardsMixin = Base => class extends Base {
    _storeCatalogFor() {
        if (!this._storeCatalog) this._storeCatalog = new StoreCatalog((k, d) => this._tr(k, d));
        return this._storeCatalog;
    }

    /** a downloaded theme pack is applied straight away; the pages are rebuilt after the install handler has returned */
    _onStoreInstalled(window, kind, id) {
        if (kind === "themepacks" && id) this.requestThemePackApply(id);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this.refreshAfterInstall(window); return GLib.SOURCE_REMOVE; });
    }

    /**
     * Fills a Widgets / Themes tab with the store's items of `kind`. Called once the tab is built from the installed items, so the
     * installed cards show at once and the store cards follow when the (cached) catalogue arrives.
     * @param page       the tab (the work is dropped if the tab was rebuilt meanwhile)
     * @param container  the tab's vertical box (toolbar + scroller)
     * @param flow       the card FlowBox
     * @param localCards the installed cards (each carries _id and _controls)
     */
    _attachStore(window, kind, page, container, flow, localCards) {
        const catalog = this._storeCatalogFor();
        const isCurrent = () => (kind === "widgets" ? this._overviewPage : this._themesPage) === page;
        const toolbar = flow._toolbar;

        const refreshBtn = new Gtk.Button({ icon_name: "view-refresh-symbolic", valign: Gtk.Align.CENTER, tooltip_text: this._tr("store.refresh", "Refresh") });
        refreshBtn.connect("clicked", () => { catalog.invalidate(); this.refreshAfterInstall(window); });
        const settingsBtn = new Gtk.Button({ icon_name: "emblem-system-symbolic", valign: Gtk.Align.CENTER, tooltip_text: this._tr("store.settings.open", "Store settings") });
        settingsBtn.connect("clicked", () => this.showStoreSettings(window));
        const spinner = new Gtk.Spinner({ spinning: true, valign: Gtk.Align.CENTER });
        toolbar?.append(spinner);
        toolbar?.append(refreshBtn);
        toolbar?.append(settingsBtn);

        container.prepend(catalog.buildWithdrawnBox(window, kind, {
            // a withdrawn widget is added to disabled-widgets first, so the Shell unloads it before its folder is moved
            onDisable: (k, id) => {
                if (k !== "widgets" || !this._settings?.isReady) return;
                const current = new Set(this._settings.getGlobalValue("disabled-widgets") ?? []);
                current.add(id);
                this._settings.setGlobalValue("disabled-widgets", Array.from(current));
            },
            onChanged: () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this.refreshAfterInstall(window); return GLib.SOURCE_REMOVE; }),
        }));

        catalog.load(kind, window).then(({ entries, errors }) => {
            if (!isCurrent()) return;
            toolbar?.remove(spinner);
            this._renderStoreErrors(container, errors);
            const local = new Map(localCards.map(c => [c._id, c]));
            const multiRepo = new Set(entries.map(e => e.repo.id)).size > 1;
            let added = 0;
            for (const { repo, item } of entries) {
                const have = local.get(item.id);
                if (have) {
                    const st = catalog.stateOf(kind, item);
                    if (st.update) this._addUpdateButton(window, catalog, have, kind, repo, item, st);
                    continue;
                }
                flow.append(this._buildStoreCard(window, catalog, kind, repo, item, multiRepo));
                added++;
            }
            if (added && flow._emptyLabel) { try { flow.remove(flow._emptyLabel); } catch (_e) { /* already gone */ } flow._emptyLabel = null; }
            flow.invalidate_sort();
            flow.invalidate_filter();
        }).catch(e => {
            logError(e, "[widget-center] prefs: store unavailable");
            if (!isCurrent()) return;
            toolbar?.remove(spinner);
            this._renderStoreErrors(container, [ { repo: { id: "store", name: this._tr("store.modules.title", "Store unavailable") }, error: e } ]);
        });
    }

    _renderStoreErrors(container, errors) {
        if (!errors.length) return;
        const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: [ "boxed-list" ], margin_top: 12, margin_start: 24, margin_end: 24 });
        for (const { repo, error } of errors) {
            list.append(new Adw.ActionRow({
                title: escapeMarkup(repo.name ?? repo.id),
                subtitle: escapeMarkup(`${this._tr("store.repo.unverified", "Could not verify this repository")}: ${error.message}`),
                subtitle_lines: 3,
                css_classes: [ "error" ],
            }));
        }
        container.prepend(list);
    }

    _buildStoreCard(window, catalog, kind, repo, item, multiRepo) {
        const card = this._buildCardShell();
        card._id = item.id;
        card._source = "store";
        card._searchText = [ item.n, item.id, item.d, item.a, item.c ].filter(Boolean).join(" ").toLowerCase();
        card._sortKey = { name: String(item.n ?? item.id).toLowerCase(), size: 0, mtime: 0 };

        const banner = this._buildCardBanner(null, kind === "widgets");
        card.append(banner);
        catalog.coverPath(repo, item).then(path => {
            if (!path) return;
            const picture = new Gtk.Picture({ content_fit: Gtk.ContentFit.COVER, hexpand: true, vexpand: true });
            picture.set_filename(path);
            const old = banner.get_first_child();
            if (old) banner.remove(old);
            banner.append(picture);
        }).catch(e => logError(e, `[widget-center] prefs: store cover for "${item.id}" failed`));

        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 12, margin_bottom: 12, margin_start: 14, margin_end: 14 });
        card.append(body);
        body.append(new Gtk.Label({ label: item.n ?? item.id, xalign: 0, css_classes: [ "title-4" ], ellipsize: Pango.EllipsizeMode.END, single_line_mode: true }));
        if (item.d) body.append(new Gtk.Label({ label: item.d, xalign: 0, wrap: true, lines: 2, ellipsize: Pango.EllipsizeMode.END, css_classes: [ "dim-label", "caption" ] }));
        const meta = [ item.a ? this._tr("importexport.importpack.by_author", "by {author}").replace("{author}", item.a) : null, `v${item.v}`, item.c,
            multiRepo ? (repo.name ?? repo.id) : null, item.ch === "beta" ? this._tr("store.beta", "beta") : null ].filter(Boolean).join(" · ");
        body.append(new Gtk.Label({ label: meta, xalign: 0, css_classes: [ "dim-label", "caption" ] }));

        const controls = new Gtk.Box({ spacing: 8, margin_top: 8, margin_bottom: 14, margin_start: 14, margin_end: 14 });
        card.append(controls);
        controls.append(new Gtk.Box({ hexpand: true }));
        const btn = this._buildIconTextButton("folder-download-symbolic", this._tr("store.install", "Install"), [ "suggested-action" ]);
        this._wireStoreButton(window, catalog, btn, kind, repo, item);
        controls.append(btn);
        return card;
    }

    _addUpdateButton(window, catalog, card, kind, repo, item, st) {
        if (!card._controls || card._updateButton) return;
        const btn = this._buildIconTextButton("software-update-available-symbolic", this._tr("store.update", "Update"), [ "suggested-action" ]);
        btn.tooltip_text = `v${st.live} → v${item.v}`;
        this._wireStoreButton(window, catalog, btn, kind, repo, item);
        card._controls.prepend(btn);
        card._updateButton = btn;
    }

    _wireStoreButton(window, catalog, btn, kind, repo, item) {
        btn.connect("clicked", async () => {
            btn.sensitive = false;
            try {
                await catalog.install(window, kind, repo, item, (k, id) => this._onStoreInstalled(window, k, id));
            } catch (e) {
                logError(e, "[widget-center] prefs: store install failed");
                window.add_toast(new Adw.Toast({ title: e.message }));
            } finally {
                btn.sensitive = true;
            }
        });
    }
};
