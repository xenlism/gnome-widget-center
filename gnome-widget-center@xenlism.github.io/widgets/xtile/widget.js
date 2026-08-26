// widgets/xtile/widget.js
//
// Architect widget for the Xtile family (XTile Architecture - see
// widgets/_architect_template_/README.md for the generic pattern this
// follows). Behaves exactly like widgets/xtile-firefox/widget.js's
// XtileBaseWidget - same rendering, same click-to-launch - it just
// also grows an "Add Widget" icon in its edit-mode toolbar (because it
// defines _addChild(), see the constructor) that spawns real,
// independently-configured Child tiles instead of requiring someone to
// hand-edit a .desktop path in Settings.
//
// _addChild() flow (this is the part that's specific to Xtile, not
// generic architect plumbing - see lib/architectWidgetKit.js for that):
//   1. _promptNameAndApp() - one GNOME Shell ModalDialog with a SINGLE
//      field: the tile name. That same text is what's searched, live,
//      via lib/utils.js's findAppInfoByQuery() (same fuzzy search -
//      display name, generic name, exec, keywords - GNOME Shell's own
//      app search uses) - whatever you type both names the tile AND
//      picks the app. No separate app-search box, and no file-browse
//      dialog either, since the search is enough to find any installed
//      app; the Child's own Settings (copied from widgets/xtile-
//      firefox's "app" field - dataType "list"/format "app") still
//      offers a "+" browse-for-.desktop-file button afterward, for the
//      rare case of an app that isn't showing up in search or isn't in
//      the standard applications directories.
//   2. createChildWidgetFromParent() copies child/, stamps id/parent,
//      and merges configOverrides = { app: [desktopPath], labelText:
//      name } into the copied child/config.json's field defaults - so
//      the new Child shows up already configured, no extra step.

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";

import { ModalDialog } from "resource:///org/gnome/shell/ui/modalDialog.js";

import { XtileBaseWidget } from "../xtile-firefox/widget.js";
import { readTextFile } from "../../lib/fsUtils.js";
import { createChildWidgetFromParent } from "../../lib/architectWidgetKit.js";
import { findAppInfoByQuery } from "../../lib/utils.js";

export default class XtileArchitectWidget extends XtileBaseWidget {
    constructor(api) {
        super(api);
        this._metadata = JSON.parse(readTextFile(GLib.build_filenamev([ api.path.me, "metadata.json" ])));

        // Only the top-level Architect offers "Add Widget" - a
        // generated Child runs this exact same class (config-only
        // pattern, see child/widget.js) but must not be able to spawn
        // grandchildren of its own. See
        // widgets/_architect_template_/README.md for why this check
        // is on "parent", not on some separate flag.
        if (this._metadata.parent) this._addChild = undefined;
    }

    // Deliberately does NOT do what Xtile Firefox/Chrome/Terminal/etc.
    // each do (return configJsonDefaults(import.meta.url) - see
    // widgets/xtile-firefox/widget.js's file header for why THEY need
    // that). This class is different: it's reused *verbatim* by every
    // generated Child (config-only Architect pattern - see
    // lib/architectWidgetKit.js and widgets/xtile/child/widget.js's
    // re-export). import.meta.url in a method body is resolved once,
    // per *file*, at class-definition time - so it would always point
    // back to THIS file (the Parent's own widgets/xtile/widget.js) no
    // matter which Child instance called it, silently overwriting
    // every Child's own "app" (and everything else) with the Parent's
    // empty config.json defaults, since WidgetLoader._applyDefaults()
    // applies instance.getDefaultSettings() LAST (lib/widgetLoader.js).
    // The loader already merges the correct, per-instance config.json
    // defaults from widgetInfo.path on its own, for Parent and every
    // Child alike - this override just needs to add nothing on top.
    getDefaultSettings() {
        return {};
    }

    async _addChild() {
        const result = await this._promptNameAndApp();
        if (!result) return;
        const { name, appInfo } = result;
        const desktopPath = appInfo.get_filename();
        if (!desktopPath) {
            this._api.logger.info("xtile: selected app has no .desktop file path, cannot create tile");
            return;
        }
        try {
            const { id } = createChildWidgetFromParent(this._api, this._metadata, name, {
                name,
                configOverrides: {
                    app: [ desktopPath ],
                    labelText: name
                }
            });
            this._api.logger.info(`xtile: created child "${id}" for ${desktopPath}`);
        } catch (e) {
            this._api.logger.error(`xtile: failed to create child: ${e.message}`);
        }
    }

    // One dialog, one field: the tile name doubles as the app search
    // query. It resolves live (every keystroke) against
    // findAppInfoByQuery() - same as GNOME Shell's own overview search
    // - so there's no separate "search" box, no file-browse step, and
    // no second field to fill in for the common case where the tile's
    // name and the app you're looking for are the same thing. Confirm
    // is wired to both Enter-in-the-field and the dialog's own "Add"
    // button.
    _promptNameAndApp() {
        return new Promise(resolve => {
            const dialog = new ModalDialog({
                styleClass: "xtile-architect-dialog"
            });
            const box = new St.BoxLayout({
                vertical: true,
                style_class: "xtile-architect-dialog-box"
            });

            const nameEntry = new St.Entry({
                style_class: "xtile-architect-name-entry",
                hint_text: "App name (e.g. \u201cDiscord\u201d)",
                can_focus: true
            });
            box.add_child(nameEntry);

            const resultLabel = new St.Label({
                style_class: "xtile-architect-app-result",
                text: ""
            });
            box.add_child(resultLabel);

            dialog.contentLayout.add_child(box);

            let matchedAppInfo = null;
            const updateMatch = () => {
                const query = nameEntry.get_text();
                matchedAppInfo = findAppInfoByQuery(query);
                if (matchedAppInfo) {
                    const displayName = matchedAppInfo.get_display_name() || matchedAppInfo.get_name() || query.trim();
                    resultLabel.set_text(`Found: ${displayName}`);
                } else {
                    resultLabel.set_text(query.trim() ? "No matching app" : "");
                }
            };
            nameEntry.clutter_text.connect("text-changed", updateMatch);

            let resolved = false;
            const finish = value => {
                if (resolved) return;
                resolved = true;
                dialog.close();
                resolve(value);
            };

            const confirm = () => {
                const name = nameEntry.get_text()?.trim();
                if (!name || !matchedAppInfo) return;
                finish({
                    name,
                    appInfo: matchedAppInfo
                });
            };

            dialog.setButtons([ {
                label: "Cancel",
                action: () => finish(null),
                key: Clutter.KEY_Escape
            }, {
                label: "Add",
                action: confirm,
                default: true
            } ]);

            nameEntry.clutter_text.connect("activate", confirm);

            dialog.open();
            global.stage.set_key_focus(nameEntry);
        });
    }
}
