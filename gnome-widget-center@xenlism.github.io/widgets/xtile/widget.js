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

        if (this._metadata.parent) this._addChild = undefined;
    }

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
