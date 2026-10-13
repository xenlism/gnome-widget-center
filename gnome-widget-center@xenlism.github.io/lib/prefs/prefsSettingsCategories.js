// prefsSettingsCategories.js - Preferences > General, Interactions, Advanced and Desktop.
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gdk from "gi://Gdk";
import GLib from "gi://GLib";
import { showReportDialog, confirmOverwrite } from "./prefsDialogs.js";
import { saveCurrentSettingsAsWidgetDefaults } from "../devConfigDefaults.js";
import { rgbaToHex } from "../colorUtils.js";
import { listAvailableLocales } from "../../i18n/index.js";
import { isModifierKeyval } from "./prefsKeys.js";

export const PrefsSettingsCategoriesMixin = Base => class extends Base {
    _buildGeneralCategory(settings) {
        const page = new Adw.PreferencesPage;
        const ready = settings.isReady;
        const group = new Adw.PreferencesGroup({
            title: this._tr("general.language.title", "Language"),
            description: this._tr("general.language.description", "Overrides the system locale for this extension's own UI text and any widget that ships translations - only where a widget actually has that language available, otherwise it falls back to the system locale as before.")
        });
        page.add(group);
        const locales = listAvailableLocales(GLib.build_filenamev([ this.path, "i18n" ]));
        const codes = [ "", ...locales.map(l => l.code) ];
        const labels = [ this._tr("general.language.system_default", "System default"), ...locales.map(l => l.name) ];
        const row = new Adw.ComboRow({
            title: this._tr("general.language.row.title", "UI language"),
            subtitle: this._tr("general.language.row.subtitle", "Applies immediately, no restart needed."),
            model: Gtk.StringList.new(labels),
            selected: Math.max(0, codes.indexOf(ready ? settings.getGlobalValue("language") || "" : "")),
            sensitive: ready
        });
        row.connect("notify::selected", () => {
            if (!ready) {
                logError(new Error("SettingsService not ready — could not save language"));
                return;
            }
            try {
                settings.setGlobalValue("language", codes[row.selected] ?? "");
            } catch (e) {
                logError(e, "could not save language");
            }
        });
        group.add(row);
        const widgetsGroup = new Adw.PreferencesGroup({
            title: this._tr("general.widgets.title", "Widgets"),
            description: this._tr("general.widgets.description", "What happens the first time a widget you installed yourself — into ~/.local/share/gnome-widget-center/widgets/, or dropped in by a theme pack — is found. Widgets bundled with the extension always start off and wait for you to enable them from Overview, regardless of this setting.")
        });
        page.add(widgetsGroup);
        const autoEnableRow = new Adw.SwitchRow({
            title: this._tr("general.autoenable.title", "Load new widgets automatically"),
            subtitle: this._tr("general.autoenable.subtitle", "For widgets you install yourself. On: enabled the first time it's found (previous behavior). Off: it appears in Overview but stays off the desktop until you turn it on."),
            active: ready ? !!settings.getGlobalValue("auto-enable-new-widgets") : true,
            sensitive: ready
        });
        autoEnableRow.connect("notify::active", () => {
            if (!ready) {
                logError(new Error("SettingsService not ready — could not toggle auto-enable-new-widgets"));
                return;
            }
            try {
                settings.setGlobalValue("auto-enable-new-widgets", autoEnableRow.active);
            } catch (e) {
                logError(e, "could not toggle auto-enable-new-widgets");
            }
        });
        widgetsGroup.add(autoEnableRow);
        const shortcutGroup = new Adw.PreferencesGroup({
            title: this._tr("general.shortcut.title", "Keyboard shortcut"),
            description: this._tr("general.shortcut.description", "Opens/closes the Widget Center Overlay (lib/shell/widgetCenterOverlay.js). Also editable live from the overlay's own Preferences tab.")
        });
        page.add(shortcutGroup);
        const currentAccel = ready ? settings.getGlobalValue("widget-center-overlay-keybinding")?.[0] ?? "" : "<Super>F12";
        const shortcutRow = new Adw.ActionRow({
            title: this._tr("general.shortcut.row.title", "Shortcut"),
            subtitle: this._tr("general.shortcut.row.subtitle", "Click Record shortcut, then press the key combination."),
            sensitive: ready
        });
        const recordButton = new Gtk.Button({
            label: currentAccel || this._tr("general.shortcut.disabled", "Disabled"),
            valign: Gtk.Align.CENTER,
            sensitive: ready
        });
        let recording = false;
        recordButton.connect("clicked", () => {
            recording = true;
            recordButton.label = this._tr("general.shortcut.press", "Press shortcut…");
            recordButton.grab_focus();
        });
        const keyController = new Gtk.EventControllerKey;
        keyController.connect("key-pressed", (_controller, keyval, _keycode, state) => {
            if (!recording) return false;
            if (keyval === Gdk.KEY_Escape) {
                recording = false;
                recordButton.label = currentAccel || this._tr("general.shortcut.disabled", "Disabled");
                return true;
            }
            if (isModifierKeyval(keyval)) return true;
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (!Gtk.accelerator_valid(keyval, mask)) return true;
            const accel = Gtk.accelerator_name(keyval, mask);
            recording = false;
            recordButton.label = accel;
            try {
                settings.setGlobalValue("widget-center-overlay-keybinding", [ accel ]);
            } catch (e) {
                logError(e, "could not save widget-center-overlay-keybinding");
            }
            return true;
        });
        recordButton.add_controller(keyController);
        shortcutRow.add_suffix(recordButton);
        shortcutRow.activatable_widget = recordButton;
        shortcutGroup.add(shortcutRow);
        return page;
    }

    _buildInteractionsCategory(settings) {
        const page = new Adw.PreferencesPage;
        const ready = settings.isReady;
        const lockGroup = new Adw.PreferencesGroup({
            title: this._tr("interactions.lock.title", "Lock widgets"),
            description: this._tr("interactions.lock.description", "Disables entering Edit Mode from the desktop - right-clicking a widget no longer opens its toolbar. Use this page to turn it back off if you get locked out.")
        });
        page.add(lockGroup);
        const editModeLockedRow = new Adw.SwitchRow({
            title: this._tr("interactions.lock.editmode.title", "Disable Edit Mode"),
            subtitle: this._tr("interactions.lock.editmode.subtitle", "Right-click stops opening the Edit Mode toolbar on every widget."),
            active: ready ? !!settings.getGlobalValue("edit-mode-locked") : false,
            sensitive: ready
        });
        editModeLockedRow.connect("notify::active", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("edit-mode-locked", editModeLockedRow.active);
            } catch (e) {
                logError(e, "could not save edit-mode-locked");
            }
        });
        lockGroup.add(editModeLockedRow);
        const snapGroup = new Adw.PreferencesGroup({
            title: this._tr("interactions.snap.title", "Magnetic snapping"),
            description: this._tr("interactions.snap.description", "Pulls a dragged widget toward screen edges and other widgets' edges.")
        });
        page.add(snapGroup);
        const snapEnabledRow = new Adw.SwitchRow({
            title: this._tr("interactions.snap.enable.title", "Enable snapping"),
            active: ready ? !!settings.getGlobalValue("snap-enabled") : true,
            sensitive: ready
        });
        snapEnabledRow.connect("notify::active", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("snap-enabled", snapEnabledRow.active);
            } catch (e) {
                logError(e, "could not save snap-enabled");
            }
        });
        snapGroup.add(snapEnabledRow);
        const snapDistanceRow = new Adw.SpinRow({
            title: this._tr("interactions.snap.distance.title", "Snap distance"),
            subtitle: this._tr("interactions.snap.distance.subtitle", "How close (px) an edge must get before it's pulled the rest of the way."),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 128,
                step_increment: 1,
                value: ready ? settings.getGlobalValue("snap-distance") : 16
            }),
            sensitive: ready
        });
        snapDistanceRow.connect("notify::value", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("snap-distance", Math.round(snapDistanceRow.value));
            } catch (e) {
                logError(e, "could not save snap-distance");
            }
        });
        snapGroup.add(snapDistanceRow);
        const guideColorRow = new Adw.ActionRow({
            title: this._tr("interactions.snap.guidecolor.title", "Guide line color")
        });
        const guideColorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({
                with_alpha: true
            }),
            valign: Gtk.Align.CENTER,
            sensitive: ready
        });
        const initialGuideColor = new Gdk.RGBA;
        initialGuideColor.parse(ready ? settings.getGlobalValue("guide-color") || "#F5A623E6" : "#F5A623E6");
        guideColorButton.set_rgba(initialGuideColor);
        guideColorButton.connect("notify::rgba", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("guide-color", rgbaToHex(guideColorButton.rgba));
            } catch (e) {
                logError(e, "could not save guide-color");
            }
        });
        guideColorRow.add_suffix(guideColorButton);
        guideColorRow.activatable_widget = guideColorButton;
        snapGroup.add(guideColorRow);
        const gridGroup = new Adw.PreferencesGroup({
            title: this._tr("interactions.grid.title", "Fixed grid snap"),
            description: this._tr("interactions.grid.description", "Off by default. Rounds a dragged widget's position to the nearest grid cell, applied after magnetic snapping above.")
        });
        page.add(gridGroup);
        const gridEnabledRow = new Adw.SwitchRow({
            title: this._tr("interactions.grid.enable.title", "Snap to grid"),
            active: ready ? !!settings.getGlobalValue("grid-snap-enabled") : false,
            sensitive: ready
        });
        gridEnabledRow.connect("notify::active", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("grid-snap-enabled", gridEnabledRow.active);
            } catch (e) {
                logError(e, "could not save grid-snap-enabled");
            }
        });
        gridGroup.add(gridEnabledRow);
        const gridSizeRow = new Adw.SpinRow({
            title: this._tr("interactions.grid.size.title", "Grid size"),
            subtitle: this._tr("interactions.grid.size.subtitle", "Cell size in pixels. Only applies while Snap to grid above is on."),
            adjustment: new Gtk.Adjustment({
                lower: 4,
                upper: 128,
                step_increment: 1,
                value: ready ? settings.getGlobalValue("grid-size") : 16
            }),
            sensitive: ready
        });
        gridSizeRow.connect("notify::value", () => {
            if (!ready) return;
            try {
                settings.setGlobalValue("grid-size", Math.round(gridSizeRow.value));
            } catch (e) {
                logError(e, "could not save grid-size");
            }
        });
        gridGroup.add(gridSizeRow);
        return page;
    }

    _buildAdvancedCategory(window, settings, storage, discoveredWidgets) {
        const page = new Adw.PreferencesPage;
        const group = new Adw.PreferencesGroup({
            title: this._tr("advanced.dev.title", "Development"),
            description: this._tr("advanced.dev.description", "For debugging the extension itself — safe to leave off otherwise.")
        });
        page.add(group);
        const row = new Adw.SwitchRow({
            title: this._tr("advanced.dev.mode.title", "Development Mode"),
            subtitle: this._tr("advanced.dev.mode.subtitle", "Hot-reloads widgets on file change, and logs internal debug output (Edit Mode flips, drag start/stop, etc) to the system journal — view with: journalctl -f -o cat | grep widget-center"),
            active: settings.isReady ? !!settings.getGlobalValue("dev-mode") : false,
            sensitive: settings.isReady
        });
        row.connect("notify::active", () => {
            if (!settings.isReady) {
                logError(new Error("SettingsService not ready — could not toggle Development Mode"));
                return;
            }
            try {
                settings.setGlobalValue("dev-mode", row.active);
            } catch (e) {
                logError(e, "could not toggle Development Mode");
            }
        });
        group.add(row);
        const defaultsGroup = new Adw.PreferencesGroup({
            title: this._tr("advanced.defaults.title", "Widget defaults"),
            description: this._tr("advanced.defaults.description", "For widget authors — bakes the current live appearance/position of every widget into its own config.json/metadata.json, so that becomes the new out-of-the-box default. Writes directly to each widget's own folder on disk.")
        });
        page.add(defaultsGroup);
        const saveDefaultsRow = new Adw.ActionRow({
            title: this._tr("advanced.defaults.row.title", "Save current settings as defaults"),
            subtitle: this._tr("advanced.defaults.row.subtitle", "Applies to every installed widget in one go — see the confirmation dialog before anything is written.")
        });
        const saveDefaultsButton = new Gtk.Button({
            label: this._tr("advanced.defaults.button", "Save Defaults"),
            valign: Gtk.Align.CENTER,
            css_classes: [ "destructive-action" ]
        });
        saveDefaultsRow.add_suffix(saveDefaultsButton);
        saveDefaultsRow.activatable_widget = saveDefaultsButton;
        defaultsGroup.add(saveDefaultsRow);
        saveDefaultsButton.connect("clicked", async () => {
            const widgets = (discoveredWidgets ?? []).filter(w => w.hasConfigJson);
            if (widgets.length === 0) {
                showReportDialog(window, this._tr("advanced.defaults.nothing_heading", "Nothing to save"), this._tr("advanced.defaults.nothing_body", "No installed widget has a config.json with configurable fields."));
                return;
            }
            const confirmed = await confirmOverwrite(window, this._tr("advanced.defaults.confirm_heading", "Save current settings as defaults?"), this._tr("advanced.defaults.confirm_body", "This overwrites config.json (and metadata.json's default-position) for all {count} widget(s) with configurable appearance, using whatever they're currently set to right now on your desktop. This cannot be undone.").replace("{count}", widgets.length), this._tr("advanced.defaults.button", "Save Defaults"));
            if (!confirmed) return;
            let configUpdated = 0;
            let positionUpdated = 0;
            const errors = [];
            for (const widget of widgets) {
                try {
                    const currentValues = storage.getWidgetSettings(widget.id);
                    const rawPosition = storage.getWidgetPosition(widget.id);
                    const position = rawPosition ? {
                        x: rawPosition.x,
                        y: rawPosition.y,
                        monitor: rawPosition.monitorIndex ?? 0
                    } : null;
                    const result = await saveCurrentSettingsAsWidgetDefaults(widget.path, currentValues, position);
                    if (result.configUpdated) configUpdated++;
                    if (result.positionUpdated) positionUpdated++;
                    for (const err of result.errors) errors.push(`${widget.id}: ${err}`);
                } catch (e) {
                    errors.push(`${widget.id}: ${e.message}`);
                }
            }
            const lines = [ this._tr("advanced.defaults.report.processed", "Widgets processed: {count}").replace("{count}", widgets.length), this._tr("advanced.defaults.report.config_updated", "config.json updated: {count}").replace("{count}", configUpdated), this._tr("advanced.defaults.report.position_updated", "metadata.json position updated: {count}").replace("{count}", positionUpdated) ];
            if (errors.length > 0) {
                lines.push("", this._tr("advanced.defaults.report.errors", "Errors:"));
                for (const err of errors) lines.push(`  ${err}`);
            }
            showReportDialog(window, errors.length > 0 ? this._tr("advanced.defaults.result_errors_heading", "Saved with errors") : this._tr("advanced.defaults.result_heading", "Defaults saved"), lines.join("\n"));
        });
        return page;
    }

    _buildDesktopCategory(settings) {
        const page = new Adw.PreferencesPage;
        const group = new Adw.PreferencesGroup({
            title: this._tr("desktop.placement.title", "Widget placement"),
            description: this._tr("desktop.placement.description", "Applies while dragging widgets in Edit Mode.")
        });
        page.add(group);
        const overlapRow = new Adw.SwitchRow({
            title: this._tr("desktop.overlap.title", "Prevent widgets from overlapping"),
            subtitle: this._tr("desktop.overlap.subtitle", "When off, widgets can be dropped on top of each other."),
            active: settings.isReady ? !!settings.getGlobalValue("prevent-widget-overlap") : true,
            sensitive: settings.isReady
        });
        overlapRow.connect("notify::active", () => {
            if (!settings.isReady) {
                logError(new Error("SettingsService not ready — could not toggle widget overlap prevention"));
                return;
            }
            try {
                settings.setGlobalValue("prevent-widget-overlap", overlapRow.active);
            } catch (e) {
                logError(e, "could not toggle prevent-widget-overlap");
            }
        });
        group.add(overlapRow);
        const marginRow = new Adw.SpinRow({
            title: this._tr("desktop.margin.title", "Screen edge margin"),
            subtitle: this._tr("desktop.margin.subtitle", "Minimum distance (px) a widget must keep from every edge of the screen."),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 256,
                step_increment: 1,
                value: settings.isReady ? settings.getGlobalValue("edge-margin") : 32
            }),
            sensitive: settings.isReady
        });
        marginRow.connect("notify::value", () => {
            if (!settings.isReady) {
                logError(new Error("SettingsService not ready — could not save edge margin"));
                return;
            }
            try {
                settings.setGlobalValue("edge-margin", Math.round(marginRow.value));
            } catch (e) {
                logError(e, "could not save edge-margin");
            }
        });
        group.add(marginRow);
        const spacingRow = new Adw.SpinRow({
            title: this._tr("desktop.spacing.title", "Spacing between widgets"),
            subtitle: this._tr("desktop.spacing.subtitle", "Minimum gap (px) kept between widgets while overlap prevention above is on."),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 256,
                step_increment: 1,
                value: settings.isReady ? settings.getGlobalValue("widget-spacing") : 16
            }),
            sensitive: settings.isReady
        });
        spacingRow.connect("notify::value", () => {
            if (!settings.isReady) {
                logError(new Error("SettingsService not ready — could not save widget spacing"));
                return;
            }
            try {
                settings.setGlobalValue("widget-spacing", Math.round(spacingRow.value));
            } catch (e) {
                logError(e, "could not save widget-spacing");
            }
        });
        group.add(spacingRow);
        return page;
    }
};
