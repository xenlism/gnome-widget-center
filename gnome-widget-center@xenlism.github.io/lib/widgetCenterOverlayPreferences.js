// lib/widgetCenterOverlayPreferences.js
//
// Native St/Clutter reimplementation of the extension's real Preferences
// window content, for the Widget Center Overlay's "Preferences" tab
// (lib/widgetCenterOverlay.js). Runs inside the GNOME Shell process, where
// GTK4/libadwaita widgets (Adw.PreferencesPage, Gtk.ColorDialogButton, ...)
// can't be hosted — see widgetCenterOverlay.js's own header for why. Every
// row here is built from plain St actors instead.
//
// Reuses the SAME service classes the real Preferences window uses
// (SettingsService for GSettings-backed host flags, ThemeService for the
// theme.json-backed appearance settings) rather than re-implementing
// storage — both are just thin wrappers around a file/schema on disk, so
// instantiating a second copy here reads/writes the exact same state, no
// extra plumbing needed. Same pattern lib/prefsPageBuilders.js's own
// _buildAppearanceCategory() already uses (`new ThemeService()` locally,
// not injected).
//
// Deliberately excludes "Backup & Restore" and "Import / Export" — both
// depend on Gtk.FileChooserNative to pick a save/open path, which needs a
// real GTK window (see lib/prefsDialogs.js's chooseFile()) and doesn't
// work reliably from inside this St overlay. Those two stay real-Preferences
// -window-only; nothing about them changed there. Every other category
// (General/Appearance/Desktop/Interactions/Advanced/About) is reproduced
// here in full.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {SettingsService} from './settingsService.js';
import {ThemeService} from './themeService.js';
import {SUPPORTED_LOCALES} from '../i18n/index.js';

// --- small row-building helpers (St has no Adw.SwitchRow/SpinRow
// equivalent, so these stand in for them) ---------------------------------

function _section(title, description) {
    const box = new St.BoxLayout({vertical: true, style_class: 'wc-pref-section'});
    box.add_child(new St.Label({text: title, style_class: 'wc-pref-section-title'}));
    if (description) {
        const desc = new St.Label({text: description, style_class: 'wc-pref-section-desc'});
        desc.clutter_text.line_wrap = true;
        box.add_child(desc);
    }
    return box;
}

function _row(title, subtitle, control) {
    const row = new St.BoxLayout({style_class: 'wc-pref-row', x_expand: true});
    const textBox = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'wc-pref-row-text'});
    textBox.add_child(new St.Label({text: title, style_class: 'wc-pref-row-title'}));
    if (subtitle) {
        const sub = new St.Label({text: subtitle, style_class: 'wc-pref-row-subtitle'});
        sub.clutter_text.line_wrap = true;
        textBox.add_child(sub);
    }
    row.add_child(textBox);
    control.y_align = Clutter.ActorAlign.CENTER;
    row.add_child(control);
    return row;
}

/** St.Button with toggle_mode:true is a real checkbox/switch (native
 * `checked` property + `:checked` CSS pseudo-class) - no custom
 * state-machine needed. */
function _toggle(initial, sensitive, onChange) {
    const btn = new St.Button({
        style_class: 'wc-pref-switch',
        toggle_mode: true,
        checked: !!initial,
        can_focus: true,
        reactive: sensitive,
        opacity: sensitive ? 255 : 120,
    });
    btn.add_child(new St.Widget({style_class: 'wc-pref-switch-knob'}));
    if (sensitive) {
        btn.connect('notify::checked', () => onChange(btn.checked));
    }
    return btn;
}

/** St.Slider is a real St widget (0..1 range internally) - min/max/step
 * are mapped on top of that here. */
function _slider(min, max, step, value, format, sensitive, onChange) {
    const box = new St.BoxLayout({style_class: 'wc-pref-slider-box', x_expand: true});
    const clamped = Math.min(max, Math.max(min, value));
    const normalized = max > min ? (clamped - min) / (max - min) : 0;
    const slider = new St.Slider(normalized);
    slider.x_expand = true;
    slider.reactive = sensitive;
    slider.opacity = sensitive ? 255 : 120;
    const valueLabel = new St.Label({style_class: 'wc-pref-slider-value', text: format(clamped)});
    if (sensitive) {
        slider.connect('notify::value', () => {
            let raw = min + slider.value * (max - min);
            raw = Math.round(raw / step) * step;
            // avoid floating-point noise like 0.30000000000000004 on
            // fractional steps (e.g. shadow opacity's step of 0.05)
            raw = Math.round(raw * 1000) / 1000;
            valueLabel.set_text(format(raw));
            onChange(raw);
        });
    }
    box.add_child(slider);
    box.add_child(valueLabel);
    return box;
}

/** Plain hex-text St.Entry + a live preview swatch - St has no native
 * color-picker dialog (that needs GTK), so a validated hex field is the
 * simplest honest equivalent. */
function _colorEntry(initialHex, sensitive, onChange) {
    const box = new St.BoxLayout({style_class: 'wc-pref-color-box'});
    const swatch = new St.Widget({
        style_class: 'wc-pref-color-swatch',
        style: `background-color: ${initialHex};`,
    });
    const entry = new St.Entry({
        style_class: 'wc-pref-color-entry',
        text: initialHex ?? '#000000',
        can_focus: sensitive,
        reactive: sensitive,
        opacity: sensitive ? 255 : 120,
    });
    if (sensitive) {
        entry.clutter_text.connect('text-changed', () => {
            const value = entry.get_text();
            if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
                swatch.set_style(`background-color: ${value};`);
                onChange(value);
            }
        });
    }
    box.add_child(swatch);
    box.add_child(entry);
    return box;
}

function _statusPlaceholder(title, description) {
    const box = new St.BoxLayout({vertical: true, style_class: 'wc-pref-status', x_expand: true});
    box.add_child(new St.Icon({icon_name: 'view-more-symbolic', icon_size: 40, style_class: 'wc-pref-status-icon'}));
    box.add_child(new St.Label({text: title, style_class: 'wc-pref-status-title'}));
    const desc = new St.Label({text: description, style_class: 'wc-pref-status-desc'});
    desc.clutter_text.line_wrap = true;
    box.add_child(desc);
    return box;
}

/** Simplest honest equivalent of a dropdown in plain St: a button that
 * shows the current choice and cycles to the next one on each click.
 * `options` is [{value, label}, ...]. */
function _cycleButton(options, initialValue, sensitive, onChange) {
    let index = Math.max(0, options.findIndex(o => o.value === initialValue));
    const button = new St.Button({style_class: 'wc-pref-cycle-button', can_focus: sensitive, reactive: sensitive, opacity: sensitive ? 255 : 120});
    const label = new St.Label({text: options[index]?.label ?? ''});
    button.set_child(label);
    if (sensitive) {
        button.connect('clicked', () => {
            index = (index + 1) % options.length;
            label.set_text(options[index].label);
            onChange(options[index].value);
        });
    }
    return button;
}

function _textEntryRow(title, subtitle, initialText, sensitive, onCommit) {
    const entry = new St.Entry({
        style_class: 'wc-pref-color-entry',
        text: initialText ?? '',
        can_focus: sensitive,
        reactive: sensitive,
        opacity: sensitive ? 255 : 120,
    });
    if (sensitive) {
        entry.clutter_text.connect('text-changed', () => onCommit(entry.get_text().trim()));
    }
    return _row(title, subtitle, entry);
}

// --- category builders -----------------------------------------------

function _buildGeneralCategory(settings) {
    const box = new St.BoxLayout({vertical: true, style_class: 'wc-pref-category'});
    box.add_child(_section('Language',
        'Overrides the system locale for this extension\'s own UI text and any widget ' +
        'that ships translations - only where a widget actually has that language ' +
        'available, otherwise it falls back to the system locale as before. See ' +
        'WIDGET_API.md \u00a75\'s api.hostLanguage.'));

    const ready = settings.isReady;
    const localeNames = {en: 'English', zh: '中文', es: 'Español', th: 'ไทย', de: 'Deutsch', ja: '日本語'};
    const options = [{value: '', label: 'System default'}, ...SUPPORTED_LOCALES.map(c => ({value: c, label: localeNames[c] ?? c}))];
    const current = ready ? (settings.getGlobalValue('language') || '') : '';

    box.add_child(_row('UI language', 'Applies immediately, no restart needed.',
        _cycleButton(options, current, ready, v => {
            try {
                settings.setGlobalValue('language', v);
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save language', e);
            }
        })));

    return box;
}

function _buildInteractionsCategory(settings) {
    const box = new St.BoxLayout({vertical: true, style_class: 'wc-pref-category'});
    const ready = settings.isReady;

    // --- Magnetic snapping ---
    box.add_child(_section('Magnetic snapping',
        'Pulls a dragged widget toward screen edges and other widgets\' edges.'));

    box.add_child(_row('Enable snapping', null,
        _toggle(ready ? !!settings.getGlobalValue('snap-enabled') : true, ready, v => {
            try {
                settings.setGlobalValue('snap-enabled', v);
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save snap-enabled', e);
            }
        })));

    box.add_child(_row('Snap distance', 'How close (px) an edge must get before it\'s pulled the rest of the way.',
        _slider(0, 128, 1, ready ? settings.getGlobalValue('snap-distance') : 16, v => `${Math.round(v)} px`, ready, v => {
            try {
                settings.setGlobalValue('snap-distance', Math.round(v));
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save snap-distance', e);
            }
        })));

    box.add_child(_row('Guide line color', null,
        _colorEntry(ready ? (settings.getGlobalValue('guide-color') || '#F5A623E6') : '#F5A623E6', ready, v => {
            try {
                settings.setGlobalValue('guide-color', v);
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save guide-color', e);
            }
        })));

    // --- Fixed grid snap (opt-in, separate from and layered on top of
    // the magnetic snapping above - NOT the pre-2026-07-28 default grid) ---
    box.add_child(_section('Fixed grid snap',
        'Off by default. Rounds a dragged widget\'s position to the nearest grid cell, ' +
        'applied after magnetic snapping above.'));

    box.add_child(_row('Snap to grid', null,
        _toggle(ready ? !!settings.getGlobalValue('grid-snap-enabled') : false, ready, v => {
            try {
                settings.setGlobalValue('grid-snap-enabled', v);
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save grid-snap-enabled', e);
            }
        })));

    box.add_child(_row('Grid size', 'Cell size in px. Only applies while Snap to grid above is on.',
        _slider(4, 128, 1, ready ? settings.getGlobalValue('grid-size') : 16, v => `${Math.round(v)} px`, ready, v => {
            try {
                settings.setGlobalValue('grid-size', Math.round(v));
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save grid-size', e);
            }
        })));

    // --- Shortcut ---
    box.add_child(_section('Keyboard shortcut', 'Opens/closes this overlay.'));

    const currentAccel = ready ? (settings.getGlobalValue('widget-center-overlay-keybinding')?.[0] ?? '') : '<Super>F12';
    box.add_child(_textEntryRow('Shortcut', 'GTK accelerator syntax, e.g. <Super>F12 , or leave empty to disable.',
        currentAccel, ready, text => {
            try {
                settings.setGlobalValue('widget-center-overlay-keybinding', text.length > 0 ? [text] : []);
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save widget-center-overlay-keybinding', e);
            }
        }));

    return box;
}

/** Mirrors lib/prefsPageBuilders.js's _buildAppearanceCategory() field for
 * field (background / corner radius / drop shadow, incl. the "Force"
 * switches) - same ThemeService, same theme.json, same keys. */
function _buildAppearanceCategory() {
    const theme = new ThemeService();
    theme.init();
    const current = theme.getGlobalTheme();

    const box = new St.BoxLayout({vertical: true, style_class: 'wc-pref-category'});

    // --- Background ---
    box.add_child(_section('Widget background',
        'Applies to any widget that opts in via metadata.json\'s "themeable": true, ' +
        'plus every widget\'s Edit Mode card.'));

    const bgState = {...current.background};
    const saveBackground = () => theme.setGlobalTheme({background: bgState});

    box.add_child(_row('Transparent', 'When on, the background color below is fully see-through.',
        _toggle(bgState.transparent, true, v => { bgState.transparent = v; saveBackground(); })));
    box.add_child(_row('Background color', null,
        _colorEntry(current.background.color ?? '#1e1e2e', true, v => { bgState.color = v; saveBackground(); })));
    box.add_child(_row('Background blur', '0–64 px',
        _slider(0, 64, 1, current.background.blur ?? 0, v => `${Math.round(v)} px`, true,
            v => { bgState.blur = Math.round(v); saveBackground(); })));
    box.add_child(_row('Force this background on every widget',
        'Overrides any background color/transparency a widget sets for itself in its own Appearance settings.',
        _toggle(bgState.force, true, v => { bgState.force = v; saveBackground(); })));

    // --- Corner radius ---
    box.add_child(_section('Widget corner radius', 'Same opt-in rule as the background above.'));

    const radiusState = {...current.cornerRadius};
    const saveRadius = () => theme.setGlobalTheme({cornerRadius: radiusState});

    box.add_child(_row('Corner radius', '0–64 px',
        _slider(0, 64, 1, current.cornerRadius.value ?? 12, v => `${Math.round(v)} px`, true,
            v => { radiusState.value = Math.round(v); saveRadius(); })));
    box.add_child(_row('Force this corner radius on every widget',
        'Overrides any corner radius a widget sets for itself in its own Appearance settings.',
        _toggle(radiusState.force, true, v => { radiusState.force = v; saveRadius(); })));

    // --- Drop shadow ---
    box.add_child(_section('Widget drop shadow', 'Same opt-in rule as the background above.'));

    const shadowState = {...current.dropShadow};
    const saveShadow = () => theme.setGlobalTheme({dropShadow: shadowState});

    box.add_child(_row('Enabled', null,
        _toggle(shadowState.enabled, true, v => { shadowState.enabled = v; saveShadow(); })));
    box.add_child(_row('Transparent', 'Overrides Enabled above — a fully transparent shadow is drawn as none at all.',
        _toggle(shadowState.transparent, true, v => { shadowState.transparent = v; saveShadow(); })));
    box.add_child(_row('Shadow color', null,
        _colorEntry(current.dropShadow.color ?? '#000000', true, v => { shadowState.color = v; saveShadow(); })));
    box.add_child(_row('Opacity', '0.0–1.0',
        _slider(0, 1, 0.05, current.dropShadow.opacity ?? 0.45, v => v.toFixed(2), true,
            v => { shadowState.opacity = v; saveShadow(); })));
    box.add_child(_row('Offset X', 'px',
        _slider(-64, 64, 1, current.dropShadow.offsetX ?? 0, v => `${Math.round(v)} px`, true,
            v => { shadowState.offsetX = Math.round(v); saveShadow(); })));
    box.add_child(_row('Offset Y', 'px',
        _slider(-64, 64, 1, current.dropShadow.offsetY ?? 4, v => `${Math.round(v)} px`, true,
            v => { shadowState.offsetY = Math.round(v); saveShadow(); })));
    box.add_child(_row('Blur radius', 'px',
        _slider(0, 128, 1, current.dropShadow.blurRadius ?? 12, v => `${Math.round(v)} px`, true,
            v => { shadowState.blurRadius = Math.round(v); saveShadow(); })));
    box.add_child(_row('Spread', 'px',
        _slider(-64, 64, 1, current.dropShadow.spread ?? 0, v => `${Math.round(v)} px`, true,
            v => { shadowState.spread = Math.round(v); saveShadow(); })));
    box.add_child(_row('Force this drop shadow on every widget',
        'Overrides any drop shadow a widget sets for itself in its own Appearance settings.',
        _toggle(shadowState.force, true, v => { shadowState.force = v; saveShadow(); })));

    return box;
}

/** Mirrors lib/prefsPageBuilders.js's _buildDesktopCategory() - the three
 * LayoutEngine GSettings keys (task 14, 2026-07-28's grid removal). */
function _buildDesktopCategory(settings) {
    const box = new St.BoxLayout({vertical: true, style_class: 'wc-pref-category'});
    box.add_child(_section('Widget placement', 'Applies while dragging widgets in Edit Mode.'));

    const ready = settings.isReady;

    box.add_child(_row('Prevent widgets from overlapping',
        'When off, widgets can be dropped on top of each other.',
        _toggle(ready ? !!settings.getGlobalValue('prevent-widget-overlap') : true, ready, v => {
            try {
                settings.setGlobalValue('prevent-widget-overlap', v);
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save prevent-widget-overlap', e);
            }
        })));

    box.add_child(_row('Screen edge margin',
        'Minimum distance (px) a widget must keep from every edge of the screen.',
        _slider(0, 256, 1, ready ? settings.getGlobalValue('edge-margin') : 32, v => `${Math.round(v)} px`, ready, v => {
            try {
                settings.setGlobalValue('edge-margin', Math.round(v));
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save edge-margin', e);
            }
        })));

    box.add_child(_row('Spacing between widgets',
        'Minimum gap (px) kept between widgets while overlap prevention above is on.',
        _slider(0, 256, 1, ready ? settings.getGlobalValue('widget-spacing') : 16, v => `${Math.round(v)} px`, ready, v => {
            try {
                settings.setGlobalValue('widget-spacing', Math.round(v));
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save widget-spacing', e);
            }
        })));

    if (!ready) {
        const warn = new St.Label({text: 'Settings unavailable — could not resolve the extension\'s GSettings schema.', style_class: 'wc-pref-warning'});
        warn.clutter_text.line_wrap = true;
        box.add_child(warn);
    }

    return box;
}

/** Mirrors lib/prefsPageBuilders.js's _buildAdvancedCategory(). */
function _buildAdvancedCategory(settings) {
    const box = new St.BoxLayout({vertical: true, style_class: 'wc-pref-category'});
    box.add_child(_section('Development', 'For debugging the extension itself — safe to leave off otherwise.'));

    const ready = settings.isReady;
    box.add_child(_row('Development Mode',
        'Hot-reloads widgets on file change, and logs internal debug output to the ' +
        'system journal — view with: journalctl -f -o cat | grep widget-center',
        _toggle(ready ? !!settings.getGlobalValue('dev-mode') : false, ready, v => {
            try {
                settings.setGlobalValue('dev-mode', v);
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not save dev-mode', e);
            }
        })));

    return box;
}

/** Mirrors lib/prefsPageBuilders.js's _buildAboutCategory(). `metadata` is
 * the extension's own metadata.json (same shape as everywhere else in
 * this codebase - extensionObject.metadata). */
function _buildAboutCategory(metadata) {
    const box = new St.BoxLayout({vertical: true, style_class: 'wc-pref-category'});

    box.add_child(_statusPlaceholder(metadata?.name ?? 'GNOME Widget Center', metadata?.description ?? ''));

    box.add_child(_row('Version', null,
        new St.Label({text: String(metadata?.version ?? '—'), style_class: 'wc-pref-dim-label'})));

    if (metadata?.url) {
        const linkButton = new St.Button({style_class: 'wc-pref-link-row', reactive: true, can_focus: true});
        linkButton.set_child(_row('Source code', metadata.url, new St.Icon({icon_name: 'adw-external-link-symbolic', icon_size: 16})));
        linkButton.connect('clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(metadata.url, null);
            } catch (e) {
                console.error('[widget-center] overlay prefs: could not open source URL', e);
            }
        });
        box.add_child(linkButton);
    }

    return box;
}

/**
 * Builds the overlay's full "Preferences" tab content: every category from
 * the real Preferences window except Backup & Restore / Import-Export
 * (see this file's header), stacked in one scrollable column.
 * @param {Extension} extensionObject - same `this` widgetCenterOverlay.js
 *   already holds as `this._extension` (needed for SettingsService's
 *   getSettings() resolution).
 * @returns {St.Widget} ready to drop into an St.ScrollView.
 */
export function buildOverlayPreferencesContent(extensionObject) {
    const settings = new SettingsService(extensionObject);
    try {
        settings.init();
    } catch (e) {
        console.error('[widget-center] overlay prefs: SettingsService.init() failed', e);
    }

    const column = new St.BoxLayout({vertical: true, style_class: 'wc-pref-column', x_expand: true});

    const categories = [
        ['General', () => _buildGeneralCategory(settings)],
        ['Appearance', () => _buildAppearanceCategory()],
        ['Desktop', () => _buildDesktopCategory(settings)],
        ['Interactions', () => _buildInteractionsCategory(settings)],
        ['Advanced', () => _buildAdvancedCategory(settings)],
        ['About', () => _buildAboutCategory(extensionObject?.metadata)],
    ];

    for (const [label, build] of categories) {
        const heading = new St.Label({text: label, style_class: 'wc-pref-category-heading'});
        column.add_child(heading);
        try {
            column.add_child(build());
        } catch (e) {
            console.error(`[widget-center] overlay prefs: failed building "${label}" category`, e);
            const err = new St.Label({text: `Could not load ${label}.`, style_class: 'wc-pref-warning'});
            column.add_child(err);
        }
    }

    return column;
}
