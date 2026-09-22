import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";

import { ModalDialog } from "resource:///org/gnome/shell/ui/modalDialog.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";
import { SHADOW_DEFAULTS, toCssColor, parseFontDescription } from "../../lib/widgetVisualKit.js";

const CHECKBOX_SIZE = 18;
const DELETE_BUTTON_SIZE = 22;

function _nowEpoch() {
    return Math.floor(GLib.get_real_time() / 1e6);
}

function _newTaskId() {
    return `${_nowEpoch()}-${Math.floor(Math.random() * 1e6)}`;
}

function _markupEscape(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export default class TodoListWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._listBox = null;
        this._titleLabel = null;
        this._clearButton = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "todo-list-widget-root"
        });
        this._actor = this._layers.root;

        const outer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            style: "padding: 14px; spacing: 8px;"
        });
        this._layers.content.add_child(outer);

        // --- header: title + clear-completed + add ---------------------
        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style: "spacing: 6px;"
        });
        outer.add_child(header);

        this._titleLabel = new St.Label({
            text: "To-Do",
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        header.add_child(this._titleLabel);

        this._clearButton = new St.Button({
            style_class: "todo-list-icon-button",
            width: DELETE_BUTTON_SIZE,
            height: DELETE_BUTTON_SIZE,
            child: new St.Icon({
                icon_name: "edit-clear-all-symbolic",
                icon_size: 13
            })
        });
        this._clearButton.connect("clicked", () => this._onClearCompletedClicked());
        header.add_child(this._clearButton);

        this._addButton = new St.Button({
            style_class: "todo-list-icon-button",
            width: DELETE_BUTTON_SIZE,
            height: DELETE_BUTTON_SIZE,
            child: new St.Icon({
                icon_name: "list-add-symbolic",
                icon_size: 15
            })
        });
        this._addButton.connect("clicked", () => this._onAddClicked());
        header.add_child(this._addButton);

        // --- task list ---------------------------------------------------
        this._listBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            style: "spacing: 4px;"
        });
        outer.add_child(this._listBox);

        this._render();
        return this._actor;
    }

    enable() {
        this._render();
    }

    disable() {
        // No timers/signals started in enable() beyond widget-owned
        // St.Button "clicked" handlers, which are torn down automatically
        // when the actors are destroyed with the widget.
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            todoItems: []
        };
    }

    onSettingsChanged() {
        this._render();
    }

    // --- task helpers ----------------------------------------------------

    _items() {
        return Array.isArray(this._settings.todoItems) ? this._settings.todoItems : [];
    }

    _saveItems(items) {
        // Reassign (not mutate) so the settings store's change detection
        // picks up the update the same way every other bundled widget's
        // array/object settings do.
        this._settings.todoItems = items;
        this._render();
    }

    _addTask(text) {
        const trimmed = (text ?? "").trim();
        if (!trimmed) return;
        const items = [
            ...this._items(),
            { id: _newTaskId(), text: trimmed, done: false, createdAt: _nowEpoch() }
        ];
        this._saveItems(items);
    }

    _toggleTask(id) {
        const items = this._items().map(item => item.id === id ? { ...item, done: !item.done } : item);
        this._saveItems(items);
    }

    _deleteTask(id) {
        const items = this._items().filter(item => item.id !== id);
        this._saveItems(items);
    }

    _onClearCompletedClicked() {
        const items = this._items().filter(item => !item.done);
        this._saveItems(items);
    }

    _onAddClicked() {
        this._promptForTaskText().then(text => {
            if (text) this._addTask(text);
        });
    }

    _promptForTaskText() {
        return new Promise(resolve => {
            const dialog = new ModalDialog({
                styleClass: "todo-list-dialog"
            });
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: "todo-list-dialog-box",
                style: "spacing: 8px; padding: 4px;"
            });

            const label = new St.Label({
                text: "New task",
                style: "font-weight: bold;"
            });
            box.add_child(label);

            const entry = new St.Entry({
                style_class: "todo-list-dialog-entry",
                hint_text: "What needs doing?",
                can_focus: true
            });
            box.add_child(entry);

            dialog.contentLayout.add_child(box);

            let resolved = false;
            const finish = value => {
                if (resolved) return;
                resolved = true;
                dialog.close();
                resolve(value);
            };

            const confirm = () => finish(entry.get_text());

            dialog.setButtons([
                { label: "Cancel", action: () => finish(null), key: Clutter.KEY_Escape },
                { label: "Add", action: confirm, default: true }
            ]);

            entry.clutter_text.connect("activate", confirm);

            dialog.open();
            global.stage.set_key_focus(entry);
        });
    }

    // --- rendering ---------------------------------------------------------

    _render() {
        if (!this._actor) return;

        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#1E1E2EF0",
            cornerRadiusFallback: 18
        });

        const s = this._settings;
        const accent = toCssColor(s.accentColor, "#3584E4FF");

        if (this._titleLabel) {
            const font = parseFontDescription(s.titleFont ?? "Sans Bold 14", "Sans Bold", 14);
            const color = toCssColor(s.titleColor, "#FFFFFFFF");
            this._titleLabel.set_text(s.titleText || "To-Do");
            this._titleLabel.set_style(`color: ${color}; font-family: ${font.family}; font-size: ${font.size}px; font-weight: bold;`);
        }

        const items = this._items();
        const hasCompleted = items.some(item => item.done);
        if (this._clearButton) {
            this._clearButton.visible = hasCompleted;
            this._clearButton.set_style(`background-color: transparent; border-radius: ${DELETE_BUTTON_SIZE}px; color: ${accent};`);
            const icon = this._clearButton.child;
            if (icon) icon.set_style(`color: ${toCssColor(s.itemColor, "#FFFFFFFF")};`);
        }
        if (this._addButton) {
            this._addButton.set_style(`background-color: ${accent}; border-radius: ${DELETE_BUTTON_SIZE}px;`);
        }

        this._renderList(items);
    }

    _renderList(items) {
        if (!this._listBox) return;
        this._listBox.destroy_all_children();

        const s = this._settings;
        const maxVisible = Number.isFinite(s.maxVisibleItems) ? Math.max(1, s.maxVisibleItems) : 7;
        const autoSort = s.autoSortDone ?? true;

        const ordered = autoSort
            ? [...items].sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1))
            : items;

        if (ordered.length === 0) {
            const empty = new St.Label({
                text: "No tasks yet - tap + to add one.",
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });
            empty.set_style(`color: ${toCssColor(s.completedColor, "#FFFFFF66")}; font-size: 12px;`);
            this._listBox.add_child(empty);
            return;
        }

        const visible = ordered.slice(0, maxVisible);
        for (const item of visible) this._listBox.add_child(this._buildRow(item));

        const hiddenCount = ordered.length - visible.length;
        if (hiddenCount > 0) {
            const more = new St.Label({ text: `+${hiddenCount} more` });
            more.set_style(`color: ${toCssColor(s.completedColor, "#FFFFFF66")}; font-size: 11px; padding-top: 2px;`);
            this._listBox.add_child(more);
        }
    }

    _buildRow(item) {
        const s = this._settings;
        const accent = toCssColor(s.accentColor, "#3584E4FF");

        const row = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style: "spacing: 8px;"
        });

        const checkbox = new St.Button({
            style_class: "todo-list-checkbox",
            width: CHECKBOX_SIZE,
            height: CHECKBOX_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: "object-select-symbolic",
                icon_size: 12,
                visible: !!item.done
            })
        });
        checkbox.set_style(
            item.done
                ? `background-color: ${accent}; border-radius: 5px; border: 1.5px solid ${accent};`
                : `background-color: transparent; border-radius: 5px; border: 1.5px solid rgba(255, 255, 255, 0.55);`
        );
        checkbox.child.set_style("color: #FFFFFF;");
        checkbox.connect("clicked", () => this._toggleTask(item.id));
        row.add_child(checkbox);

        const font = parseFontDescription(s.itemFont ?? "Sans 13", "Sans", 13);
        const color = item.done ? toCssColor(s.completedColor, "#FFFFFF66") : toCssColor(s.itemColor, "#FFFFFFFF");
        const label = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        label.clutter_text.set_use_markup(true);
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = 0;
        const escaped = _markupEscape(item.text);
        label.clutter_text.set_markup(item.done ? `<s>${escaped}</s>` : escaped);
        label.set_style(`color: ${color}; font-family: ${font.family}; font-size: ${font.size}px;`);
        row.add_child(label);

        const remove = new St.Button({
            style_class: "todo-list-icon-button",
            width: DELETE_BUTTON_SIZE,
            height: DELETE_BUTTON_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: "user-trash-symbolic",
                icon_size: 13
            })
        });
        remove.set_style("background-color: transparent;");
        remove.child.set_style(`color: ${toCssColor(s.completedColor, "#FFFFFF88")};`);
        remove.connect("clicked", () => this._deleteTask(item.id));
        row.add_child(remove);

        return row;
    }
}
