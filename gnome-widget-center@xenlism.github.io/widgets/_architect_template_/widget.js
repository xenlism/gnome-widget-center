import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import {ModalDialog} from "resource:///org/gnome/shell/ui/modalDialog.js";
import {createLayeredCard, applyLayeredCardStyle} from "../../lib/cardLayers.js";
import {configJsonDefaults} from "../../lib/widgetConfigDefaults.js";
import {readTextFile} from "../../lib/fsUtils.js";
import {createChildWidgetFromParent} from "../../lib/architectWidgetKit.js";

export default class ArchitectTemplateWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._metadata = JSON.parse(readTextFile(GLib.build_filenamev([api.path.me, "metadata.json"])));

        if (this._metadata.parent) this._addChild = undefined;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "architect-template-widget-root"
        });
        this._actor = this._layers.root;

        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._layers.content.add_child(this._content);

        this._label = new St.Label({
            style_class: "architect-template-widget-label",
            text: "Architect widget",
        });
        this._content.add_child(this._label);

        this._render();
        return this._actor;
    }

    enable() {
        this._render();
    }

    disable() {}

    onSettingsChanged() {
        this._render();
    }

    _render() {
        if (!this._actor) return;
        applyLayeredCardStyle(this._layers, this._settings);
        this._label.set_text(this._settings.labelText ?? "Architect widget");
    }

    async _addChild() {
        const name = await this._promptChildName();
        if (!name) return;
        try {
            const {id} = createChildWidgetFromParent(this._api, this._metadata, name, {
                configOverrides: {},
            });
            this._logger.info(`created child "${id}"`);
        } catch (e) {
            this._logger.error(`failed to create child: ${e.message}`);
        }
    }

    _promptChildName() {
        return new Promise(resolve => {
            const dialog = new ModalDialog({styleClass: "architect-template-widget-dialog"});
            const entry = new St.Entry({
                style_class: "architect-template-widget-name-entry",
                hint_text: "Child name",
                can_focus: true,
            });
            dialog.contentLayout.add_child(entry);
            let resolved = false;
            const finish = value => {
                if (resolved) return;
                resolved = true;
                dialog.close();
                resolve(value);
            };
            dialog.setButtons([
                {label: "Cancel", action: () => finish(null), key: Clutter.KEY_Escape},
                {label: "Add", action: () => finish(entry.get_text()?.trim() || null), default: true},
            ]);
            entry.clutter_text.connect("activate", () => finish(entry.get_text()?.trim() || null));
            dialog.open();
        });
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
        };
    }
}
