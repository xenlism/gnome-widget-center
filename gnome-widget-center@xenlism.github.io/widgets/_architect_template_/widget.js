// widgets/_architect_template_/widget.js
//
// Starting point for a new ARCHITECT widget — a normal widget that can
// spawn Child Widgets from its own child/ template (see development
// docs: XTile Architecture). Copy this whole widgets/_architect_template_/
// folder, rename it, and edit metadata.json's "id"/"name" plus the
// style_class strings below, same as widgets/_template/.
//
// This is a WIDGET, not a special runtime — it uses the exact same
// createLayeredCard()/config.json/api contract as every other bundled
// widget (see widgets/_template/README.md and WIDGET_API.md). The only
// thing added here is one button that calls
// lib/architectWidgetKit.js's createChildWidgetFromParent().
//
// XTile Architecture §9-10 (Add Child flow):
//   + Add Widget button -> widget_add_child() -> Widget Preferences
//   (Child Name + settings) -> generate Child ID -> copy child/
//   template -> discovered/loaded as a normal widget.
//
// This scaffold's Add Widget flow is intentionally minimal (a single
// GNOME Shell ModalDialog with one name field) so the mechanics are
// easy to follow — swap in a richer prefs-style form if your Architect
// needs to collect more than a name before creating a Child (see the
// _promptChildName() comment below for where to extend it).
//
// createChildWidgetFromParent() calls api.host.rescan() itself once the
// Child's files are written (see lib/architectWidgetKit.js), so the new
// Child is discovered and placed in the running layer right away — no
// manual "Rescan widgets" needed. api.host.rescan() is best-effort: on
// an older host build without this hook it silently no-ops, and the
// Child still appears the next time the user rescans manually.

import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import {ModalDialog} from "resource:///org/gnome/shell/ui/modalDialog.js";
import {createLayeredCard} from "../../lib/cardLayers.js";
import {configJsonDefaults} from "../../lib/widgetConfigDefaults.js";
import {readTextFile} from "../../lib/fsUtils.js";
import {createChildWidgetFromParent} from "../../lib/architectWidgetKit.js";

export default class ArchitectTemplateWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        // Read once here rather than via a JSON module import — GJS's
        // ES module loader support for JSON import attributes isn't
        // relied on anywhere else in this codebase, so this sticks to
        // the same Gio-file-read + JSON.parse pattern widgetLoader.js
        // itself uses to read every widget's metadata.json.
        this._metadata = JSON.parse(readTextFile(GLib.build_filenamev([api.path.me, "metadata.json"])));
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

        // XTile Architecture §9: an action button, not an
        // Enable/Disable switch, for "add a Child".
        this._addButton = new St.Button({
            style_class: "architect-template-widget-add-button",
            reactive: true,
            can_focus: true,
            track_hover: true,
            label: "+ Add Widget",
        });
        this._addButton.connect("clicked", () => this._addChild());
        this._content.add_child(this._addButton);

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
        this._label.set_text(this._settings.labelText ?? "Architect widget");
    }

    // widget_add_child() from XTile Architecture §9. Prompts for a
    // Child Name, then delegates the mechanical work (id generation,
    // copying child/, wiring metadata.json's "parent" field) to the
    // generic kit — this method itself only decides WHAT to put in
    // configOverrides, which is the one part that's genuinely specific
    // to your Architect Widget.
    async _addChild() {
        const name = await this._promptChildName();
        if (!name) return;
        try {
            const {id} = createChildWidgetFromParent(this._api, this._metadata, name, {
                // TODO: replace with whatever per-Child data your
                // Architect actually needs to collect (this is the
                // "jass.color = '#xxxxxx'" part — everything the
                // Child needs, expressed as config.json field
                // overrides, not new code). Field ids must match
                // child/config.json's field ids.
                configOverrides: {},
            });
            this._logger.info(`created child "${id}"`);
        } catch (e) {
            this._logger.error(`failed to create child: ${e.message}`);
        }
    }

    // Minimal GNOME Shell modal prompt for the Child Name (the one
    // input XTile Architecture §9-10 requires before generating a
    // Child ID). Replace with a fuller form (extra St.Entry fields,
    // one per configOverrides key) if your Architect needs more than a
    // name up front — the shape returned just needs to end up as the
    // `options.configOverrides` object passed to
    // createChildWidgetFromParent() above.
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
