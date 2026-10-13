// prefsAppearanceCategory.js - Preferences > Appearance: colour scheme, card settings, fonts and theme defaults.
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gdk from "gi://Gdk";
import Pango from "gi://Pango";
import { ThemeService } from "../themeService.js";
import { applyColorSchemeToWidgets, applyCardSettingsToWidgets, applyFontSettingsToWidgets } from "../exportService.js";
import { COLOR_SCHEME_ROLES, DEFAULT_COLOR_SCHEME, schemeKey } from "../colorScheme.js";
import { FONT_ROLES, DEFAULT_FONT_SETTINGS, fontKey } from "../fontScheme.js";
import { CARD_SETTING_SPECS, CARD_SETTING_IDS, DEFAULT_CARD_SETTINGS } from "../cardDefaults.js";
import { SHADOW_ANGLE_STEPS } from "../globalShadowHelper.js";

function rgbaToHex8(rgba) {
    const toHex = c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
    return `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}${toHex(rgba.alpha)}`;
}

export const PrefsAppearanceMixin = Base => class extends Base {
    _buildColorSchemeGroup(storage, discoveredWidgets, sharedTheme) {
        const ROLE_TITLES = {
            "card-background": "Card background", "card-border": "Card border", "card-shadow": "Card shadow",
            "text-1": "Text 1 (primary)", "text-2": "Text 2 (secondary)",
            "ring-1": "Ring 1", "ring-2": "Ring 2", "ring-3": "Ring 3", "ring-4": "Ring 4",
            "accent": "Accent"
        };
        const group = new Adw.PreferencesGroup({
            title: this._tr("appearance.scheme.title", "Card Color Scheme"),
            description: this._tr("appearance.scheme.description", "Shared palette saved into theme packs (.gwct). Widgets you add later start with these colors. Widgets already on the desktop keep their own colors unless you press \"Apply to all widgets\".")
        });
        const theme = sharedTheme ?? new ThemeService;
        theme.init();
        const scheme = { ...DEFAULT_COLOR_SCHEME, ...theme.getColorScheme() ?? {} };
        for (const role of COLOR_SCHEME_ROLES) {
            const key = schemeKey(role);
            const row = new Adw.ActionRow({
                title: this._tr(`appearance.scheme.${role}`, ROLE_TITLES[role] ?? role)
            });
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({ with_alpha: true }),
                valign: Gtk.Align.CENTER
            });
            const rgba = new Gdk.RGBA;
            rgba.parse(scheme[key]);
            button.set_rgba(rgba);
            button.connect("notify::rgba", () => {
                try {
                    scheme[key] = rgbaToHex8(button.rgba);
                    theme.setColorScheme(scheme);
                } catch (e) {
                    logError(e, `could not save color scheme ${key}`);
                }
            });
            row.add_suffix(button);
            row.activatable_widget = button;
            group.add(row);
        }
        const applyRow = new Adw.ActionRow({
            title: this._tr("appearance.scheme.apply.title", "Apply to all widgets"),
            subtitle: this._tr("appearance.scheme.apply.subtitle", "Overwrites the matching colors of every widget that supports the scheme.")
        });
        const applyButton = new Gtk.Button({ label: this._tr("appearance.scheme.apply.button", "Apply"), valign: Gtk.Align.CENTER });
        applyButton.connect("clicked", () => {
            try {
                theme.setColorScheme(scheme);
                const changed = applyColorSchemeToWidgets(scheme, { storage: storage, discoveredWidgets: discoveredWidgets });
                applyButton.label = this._tr("appearance.scheme.apply.done", "Applied to {count}").replace("{count}", changed.length);
            } catch (e) {
                logError(e, "could not apply color scheme");
            }
        });
        applyRow.add_suffix(applyButton);
        group.add(applyRow);
        const clearRow = new Adw.ActionRow({
            title: this._tr("appearance.scheme.clear.title", "Stop using a color scheme"),
            subtitle: this._tr("appearance.scheme.clear.subtitle", "New widgets go back to their own default colors. Existing widgets are not changed.")
        });
        const clearButton = new Gtk.Button({ label: this._tr("appearance.scheme.clear.button", "Clear"), valign: Gtk.Align.CENTER });
        clearButton.connect("clicked", () => {
            try {
                theme.setColorScheme(null);
                clearButton.label = this._tr("appearance.scheme.clear.done", "Cleared");
            } catch (e) {
                logError(e, "could not clear color scheme");
            }
        });
        clearRow.add_suffix(clearButton);
        group.add(clearRow);
        return group;
    }

    _buildCardSettingsGroup(storage, discoveredWidgets, sharedTheme) {
        const ROW_TITLES = {
            "card-background-color": "Background color",
            "card-opacity": "Opacity (%)",
            "card-corner-radius-enabled": "Round card corners",
            "card-corner-radius": "Corner radius (px)",
            "card-border-enabled": "Enable border",
            "card-border-color": "Border color",
            "card-border-width": "Border width (px)",
            "card-shadow-enabled": "Enable shadow",
            "card-shadow-color": "Shadow color",
            "card-shadow-opacity": "Shadow transparency (%)",
            "card-shadow-blur": "Shadow blur (px)",
            "card-shadow-angle": "Shadow angle (°)",
            "card-shadow-distance": "Shadow distance (px)",
            "card-blur-enabled": "Enable background blur",
            "card-blur-radius": "Blur radius (px)"
        };
        const group = new Adw.PreferencesGroup({
            title: this._tr("appearance.card.title", "Card Settings"),
            description: this._tr("appearance.card.description", "Every card setting (background, corners, border, shadow, blur, opacity) saved into theme packs (.gwct). A widget you open for the first time starts with these values, so you don't have to set them one by one. Widgets already on the desktop keep their own settings unless you press \"Apply to all widgets\".")
        });
        const theme = sharedTheme ?? new ThemeService;
        theme.init();
        const values = { ...DEFAULT_CARD_SETTINGS, ...theme.getCardSettings() ?? {} };
        const save = id => {
            try {
                theme.setCardSettings(values);
            } catch (e) {
                logError(e, `could not save card setting ${id}`);
            }
        };
        for (const id of CARD_SETTING_IDS) {
            const spec = CARD_SETTING_SPECS[id];
            const title = this._tr(`appearance.card.${id}`, ROW_TITLES[id] ?? id);
            if (spec.type === "bool") {
                const row = new Adw.SwitchRow({ title: title, active: !!values[id] });
                row.connect("notify::active", () => {
                    values[id] = row.active;
                    save(id);
                });
                group.add(row);
            } else if (spec.type === "number") {
                const row = new Adw.SpinRow({
                    title: title,
                    adjustment: new Gtk.Adjustment({
                        lower: spec.min,
                        upper: spec.max,
                        step_increment: 1,
                        value: values[id]
                    })
                });
                row.connect("notify::value", () => {
                    values[id] = Math.round(row.value);
                    save(id);
                });
                group.add(row);
            } else {
                const row = new Adw.ActionRow({ title: title });
                const button = new Gtk.ColorDialogButton({
                    dialog: new Gtk.ColorDialog({ with_alpha: true }),
                    valign: Gtk.Align.CENTER
                });
                const rgba = new Gdk.RGBA;
                rgba.parse(values[id]);
                button.set_rgba(rgba);
                button.connect("notify::rgba", () => {
                    values[id] = rgbaToHex8(button.rgba);
                    save(id);
                });
                row.add_suffix(button);
                row.activatable_widget = button;
                group.add(row);
            }
        }
        const applyRow = new Adw.ActionRow({
            title: this._tr("appearance.card.apply.title", "Apply to all widgets"),
            subtitle: this._tr("appearance.card.apply.subtitle", "Overwrites the matching card settings of every widget that has them. Colors from the Card Color Scheme are applied separately.")
        });
        const applyButton = new Gtk.Button({ label: this._tr("appearance.card.apply.button", "Apply"), valign: Gtk.Align.CENTER });
        applyButton.connect("clicked", () => {
            try {
                theme.setCardSettings(values);
                const changed = applyCardSettingsToWidgets(values, { storage: storage, discoveredWidgets: discoveredWidgets });
                applyButton.label = this._tr("appearance.card.apply.done", "Applied to {count}").replace("{count}", changed.length);
            } catch (e) {
                logError(e, "could not apply card settings");
            }
        });
        applyRow.add_suffix(applyButton);
        group.add(applyRow);
        const clearRow = new Adw.ActionRow({
            title: this._tr("appearance.card.clear.title", "Stop using card settings"),
            subtitle: this._tr("appearance.card.clear.subtitle", "New widgets go back to their own default card look. Existing widgets are not changed.")
        });
        const clearButton = new Gtk.Button({ label: this._tr("appearance.card.clear.button", "Clear"), valign: Gtk.Align.CENTER });
        clearButton.connect("clicked", () => {
            try {
                theme.setCardSettings(null);
                clearButton.label = this._tr("appearance.card.clear.done", "Cleared");
            } catch (e) {
                logError(e, "could not clear card settings");
            }
        });
        clearRow.add_suffix(clearButton);
        group.add(clearRow);
        return group;
    }

    _buildFontSettingsGroup(storage, discoveredWidgets, sharedTheme) {
        const ROLE_TITLES = { "text-1": "Text 1 font (primary)", "text-2": "Text 2 font (secondary)" };
        const group = new Adw.PreferencesGroup({
            title: this._tr("appearance.font.title", "Text Fonts"),
            description: this._tr("appearance.font.description", "Font face and size for the shared text roles, saved into theme packs (.gwct). Widgets you add later start with these fonts. Widgets already on the desktop keep their own fonts unless you press \"Apply to all widgets\".")
        });
        const theme = sharedTheme ?? new ThemeService;
        theme.init();
        const values = { ...DEFAULT_FONT_SETTINGS, ...theme.getFontSettings() ?? {} };
        for (const role of FONT_ROLES) {
            const key = fontKey(role);
            const row = new Adw.ActionRow({ title: this._tr(`appearance.font.${role}`, ROLE_TITLES[role] ?? role) });
            const button = new Gtk.FontDialogButton({ dialog: new Gtk.FontDialog, valign: Gtk.Align.CENTER });
            try {
                button.set_font_desc(Pango.FontDescription.from_string(values[key]));
            } catch (e) {
                button.set_font_desc(Pango.FontDescription.from_string(DEFAULT_FONT_SETTINGS[key]));
            }
            button.connect("notify::font-desc", () => {
                try {
                    const desc = button.get_font_desc();
                    if (!desc) return;
                    values[key] = desc.to_string();
                    theme.setFontSettings(values);
                } catch (e) {
                    logError(e, `could not save font setting ${key}`);
                }
            });
            row.add_suffix(button);
            row.activatable_widget = button;
            group.add(row);
        }
        const applyRow = new Adw.ActionRow({
            title: this._tr("appearance.font.apply.title", "Apply to all widgets"),
            subtitle: this._tr("appearance.font.apply.subtitle", "Overwrites the matching font (face and size) of every widget that supports text roles.")
        });
        const applyButton = new Gtk.Button({ label: this._tr("appearance.font.apply.button", "Apply"), valign: Gtk.Align.CENTER });
        applyButton.connect("clicked", () => {
            try {
                theme.setFontSettings(values);
                const changed = applyFontSettingsToWidgets(values, { storage: storage, discoveredWidgets: discoveredWidgets });
                applyButton.label = this._tr("appearance.font.apply.done", "Applied to {count}").replace("{count}", changed.length);
            } catch (e) {
                logError(e, "could not apply font settings");
            }
        });
        applyRow.add_suffix(applyButton);
        group.add(applyRow);
        const clearRow = new Adw.ActionRow({
            title: this._tr("appearance.font.clear.title", "Stop using text fonts"),
            subtitle: this._tr("appearance.font.clear.subtitle", "New widgets go back to their own default fonts. Existing widgets are not changed.")
        });
        const clearButton = new Gtk.Button({ label: this._tr("appearance.font.clear.button", "Clear"), valign: Gtk.Align.CENTER });
        clearButton.connect("clicked", () => {
            try {
                theme.setFontSettings(null);
                clearButton.label = this._tr("appearance.font.clear.done", "Cleared");
            } catch (e) {
                logError(e, "could not clear font settings");
            }
        });
        clearRow.add_suffix(clearButton);
        group.add(clearRow);
        return group;
    }

    _buildThemeDefaultsGroup(theme, storage, discoveredWidgets) {
        const group = new Adw.PreferencesGroup({
            title: this._tr("appearance.defaults.title", "Theme Defaults"),
            description: this._tr("appearance.defaults.description", "Card settings, color scheme and text fonts below are saved together into theme packs (.gwct). Widgets you add later start with these values.")
        });
        const applyRow = new Adw.ActionRow({
            title: this._tr("appearance.defaults.apply.title", "Apply all to widgets"),
            subtitle: this._tr("appearance.defaults.apply.subtitle", "Overwrites card settings, colors and fonts of every widget that supports them.")
        });
        const applyButton = new Gtk.Button({ label: this._tr("appearance.defaults.apply.button", "Apply all"), valign: Gtk.Align.CENTER });
        applyButton.connect("clicked", () => {
            try {
                const ctx = { storage: storage, discoveredWidgets: discoveredWidgets };
                const card = { ...DEFAULT_CARD_SETTINGS, ...theme.getCardSettings() ?? {} };
                const scheme = { ...DEFAULT_COLOR_SCHEME, ...theme.getColorScheme() ?? {} };
                const fonts = { ...DEFAULT_FONT_SETTINGS, ...theme.getFontSettings() ?? {} };
                theme.setGlobalTheme({ cardSettings: card, colorScheme: scheme, fontSettings: fonts });
                const changed = new Set([
                    ...applyCardSettingsToWidgets(card, ctx),
                    ...applyColorSchemeToWidgets(scheme, ctx),
                    ...applyFontSettingsToWidgets(fonts, ctx)
                ]);
                applyButton.label = this._tr("appearance.defaults.apply.done", "Applied to {count}").replace("{count}", changed.size);
            } catch (e) {
                logError(e, "could not apply theme defaults");
            }
        });
        applyRow.add_suffix(applyButton);
        group.add(applyRow);
        const clearRow = new Adw.ActionRow({
            title: this._tr("appearance.defaults.clear.title", "Stop using theme defaults"),
            subtitle: this._tr("appearance.defaults.clear.subtitle", "New widgets go back to their own defaults. Existing widgets are not changed. Reopen Preferences to see the reset values.")
        });
        const clearButton = new Gtk.Button({ label: this._tr("appearance.defaults.clear.button", "Clear all"), valign: Gtk.Align.CENTER });
        clearButton.connect("clicked", () => {
            try {
                theme.setGlobalTheme({ cardSettings: null, colorScheme: null, fontSettings: null });
                clearButton.label = this._tr("appearance.defaults.clear.done", "Cleared");
            } catch (e) {
                logError(e, "could not clear theme defaults");
            }
        });
        clearRow.add_suffix(clearButton);
        group.add(clearRow);
        return group;
    }

    _buildAppearanceCategory(settings, storage, discoveredWidgets) {
        const ready = settings?.isReady;
        const page = new Adw.PreferencesPage;
        // One ThemeService for the whole Theme Defaults section: separate
        // instances each cache theme.json and would overwrite each other's
        // blocks (card settings / color scheme / fonts) on save.
        const defaultsTheme = new ThemeService;
        defaultsTheme.init();
        page.add(this._buildThemeDefaultsGroup(defaultsTheme, storage, discoveredWidgets));
        page.add(this._buildCardSettingsGroup(storage, discoveredWidgets, defaultsTheme));
        page.add(this._buildColorSchemeGroup(storage, discoveredWidgets, defaultsTheme));
        page.add(this._buildFontSettingsGroup(storage, discoveredWidgets, defaultsTheme));

        const shadowGroup = new Adw.PreferencesGroup({
            title: this._tr("appearance.shadow.title", "Global Shadow"),
            description: this._tr("appearance.shadow.description", "Distance and angle apply to every widget's drop shadow. Each widget still sets its own shadow color, opacity, and blur in its own Appearance settings.")
        });
        page.add(shadowGroup);

        const shadowDistanceRow = new Adw.SpinRow({
            title: this._tr("appearance.shadow.distance.title", "Shadow distance"),
            subtitle: this._tr("appearance.shadow.distance.subtitle", "0–30 px."),
            sensitive: ready,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 30,
                step_increment: 1,
                value: ready ? settings.getGlobalValue("shadow-distance") : 4
            })
        });
        shadowGroup.add(shadowDistanceRow);
        shadowDistanceRow.connect("notify::value", () => {
            if (!ready) return;
            settings.setGlobalValue("shadow-distance", Math.round(shadowDistanceRow.value));
        });

        const shadowAngleRow = new Adw.ComboRow({
            title: this._tr("appearance.shadow.angle.title", "Shadow angle"),
            subtitle: this._tr("appearance.shadow.angle.subtitle", "Direction the shadow falls, in 45° steps."),
            sensitive: ready,
            model: Gtk.StringList.new(SHADOW_ANGLE_STEPS.map(a => `${a}°`))
        });
        const shadowAngleIndex = SHADOW_ANGLE_STEPS.indexOf(ready ? settings.getGlobalValue("shadow-angle") : 90);
        shadowAngleRow.selected = shadowAngleIndex >= 0 ? shadowAngleIndex : SHADOW_ANGLE_STEPS.indexOf(90);
        shadowGroup.add(shadowAngleRow);
        shadowAngleRow.connect("notify::selected", () => {
            if (!ready) return;
            settings.setGlobalValue("shadow-angle", SHADOW_ANGLE_STEPS[shadowAngleRow.selected] ?? 90);
        });

        return page;
    }
};
