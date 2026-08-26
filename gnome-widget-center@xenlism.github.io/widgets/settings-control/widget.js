// widgets/settings-control/widget.js
//
// A compact 1x1 card with a 2x2 grid of icon-only TOGGLE buttons:
// Wi-Fi/Ethernet, Bluetooth, Do Not Disturb, Dark/Light mode. No text
// labels - each button shows a hover tooltip instead, via
// lib/widgetTooltip.js's attachTooltip(). The Bluetooth button's tooltip
// text is updated live via that helper's actor.setTooltip() when this
// widget falls back to an Airplane Mode toggle - see _enableAirplaneFallback().
//
// Root actor (this._actor) is a plain St.Widget with Clutter.FixedLayout,
// holding a single St.Bin child (this._content) that does the actual
// centering/painting - lib/blockSizeManager.js's applyBlockSize()
// force-sets the root actor to an exact cols*16 x rows*16px size from
// metadata.json's block-type (currently 11x11 cells = 176x176px)
// regardless of anything set here, so this._content is bound to that
// size via a Clutter.BindConstraint rather than a hardcoded pixel size -
// same fix as widgets/folder-widget-2x2's root/content split. This keeps
// the card's background/corner-radius filling the FULL allocated block
// and the button grid centered inside it, even if block-type's cell size
// ever changes again.
//
// Unlike power-menu's fire-and-forget actions, every button here reflects
// live system state. Rather than recoloring the icon glyph itself (icons
// stay a constant white, matching GNOME's own Quick Settings toggles),
// the BUTTON's background fill is what shows on/off state - a faint tint
// of iconOffColor when off, a much more opaque fill of iconOnColor when
// on, so the button visibly "lights up" when toggled. Each source below
// stays in sync if the setting is changed some other way (GNOME Settings
// app, another instance of this widget, an external nmcli/bluetoothctl
// command, etc.) - subscribed to via signals, never polled, per
// WIDGET_API.md §9.1's must-follow rules:
//
//   - Wi-Fi/Ethernet -> org.freedesktop.NetworkManager (system bus).
//     Icon glyph switches between wifi/wired/offline based on
//     PrimaryConnectionType; the click toggles WirelessEnabled.
//   - Bluetooth       -> org.bluez (system bus). Adapter is discovered
//     once via the root ObjectManager; click toggles the adapter's own
//     Powered property.
//   - Do Not Disturb  -> GSettings org.gnome.desktop.notifications'
//     show-banners key (DND active means show-banners is false - this is
//     the same key GNOME's own Quick Settings "Do Not Disturb" toggle
//     uses).
//   - Dark/Light mode -> GSettings org.gnome.desktop.interface's
//     color-scheme key ('prefer-dark' vs 'default').
//
// All four are wrapped defensively: a missing bus name, missing adapter,
// or missing schema (non-GNOME session, sandboxed test environment,
// older GNOME without a given key) leaves that one button inert (off
// fill, generic icon, logs on click) rather than throwing - buildActor()
// itself never touches DBus/GSettings at all, only enable() does.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, borderCss as _borderCss, BORDER_DEFAULTS, OPACITY_DEFAULTS, BLUR_DEFAULTS, applyCardOpacity, resolveCornerRadius} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyCardBlur} from '../../lib/cardLayers.js';
import {attachTooltip} from '../../lib/widgetTooltip.js';
import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

const ICON_SIZE = 24;
const BUTTON_SIZE = 60;
const GRID_SPACING = 8;
const PADDING = 0;

const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

export default class SettingsControlWidget {
    /**
     * @param {WidgetAPI} api - see WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._tooltips = [];

        // Re-styled on state change / onSettingsChanged - see _setToggleState().
        this._networkIcon = null;
        this._bluetoothIcon = null;
        this._dndIcon = null;
        this._themeIcon = null;
        this._networkButton = null;
        this._bluetoothButton = null;
        this._airplaneMode = false;
        this._dndButton = null;
        this._themeButton = null;

        // Cached appearance settings, refreshed in buildActor()/onSettingsChanged().
        this._iconOnColor = '#3584e4';
        this._iconOffColor = '#9a9996';

        // External resources opened in enable(), torn down in disable().
        this._nmProxy = null;
        this._nmSignalId = null;
        this._btAdapterPath = null;
        this._btProxy = null;
        this._btSignalId = null;
        this._notifSettings = null;
        this._notifSignalId = null;
        this._interfaceSettings = null;
        this._interfaceSignalId = null;
        this._rfkillSettings = null;
        this._rfkillSignalId = null;
    }

    // Must never throw. Builds the 2x2 grid with placeholder (off-color,
    // generic) icons - enable() fills in real state right after this
    // actor is placed in the Widget Layer.
    buildActor() {
        const backgroundColor = this._settings?.backgroundColor ?? '#070000a5';
        const cornerRadius = resolveCornerRadius(this._settings);
        this._iconOnColor = this._settings?.iconOnColor ?? '#3584e4';
        this._iconOffColor = this._settings?.iconOffColor ?? '#9a9996';

        // Plain (non-layout-managed-by-parent) root so tooltip labels can
        // be positioned as free-floating overlay children - same pattern
        // as widgets/power-menu/widget.js. Sizing itself is left entirely
        // to lib/blockSizeManager.js's applyBlockSize() (called by the
        // host right after buildActor() returns) - this._content below is
        // bound to whatever size that ends up setting, rather than this
        // widget assuming/hardcoding it.
        this._layers = createLayeredCard({
            contentStyleClass: 'settings-control-widget-root',
            withTooltipLayer: true,
        });
        this._actor = this._layers.root;
        this._actor.reactive = true;

        this._layers.card.set_style(this._cardStyle(backgroundColor, cornerRadius));
        applyCardOpacity(this._layers.card, this._settings);
        this._layers.cardBlur.set_style(this._cardBlurStyle(backgroundColor, cornerRadius));
        applyCardBlur(this._layers.cardBlur, this._settings);

        // this._content is a plain wrapper - padding lives here, never the
        // Content Layer itself (Rule 5).
        this._content = new St.Bin({
            style_class: 'settings-control-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._content.set_style(`padding: ${PADDING}px;`);
        this._layers.content.add_child(this._content);

        this._grid = new St.Widget({
            style_class: 'settings-control-widget-grid',
            layout_manager: new Clutter.GridLayout({
                column_spacing: GRID_SPACING,
                row_spacing: GRID_SPACING,
            }),
        });
        this._content.set_child(this._grid);

        const layout = this._grid.layout_manager;

        this._networkIcon = new St.Icon({icon_name: 'network-wireless-offline-symbolic', icon_size: ICON_SIZE});
        this._networkButton = this._makeButton(this._networkIcon, () => this._toggleNetwork());
        layout.attach(this._networkButton, 0, 0, 1, 1);
        this._tooltips.push(attachTooltip(this._networkButton, this._layers, 'Wi-Fi'));

        this._bluetoothIcon = new St.Icon({
            icon_name: 'bluetooth-symbolic',
            icon_size: ICON_SIZE
        });

        this._bluetoothButton = this._makeButton(
            this._bluetoothIcon,
            () => this._toggleBluetoothOrAirplane()
        );

        layout.attach(this._bluetoothButton, 1, 0, 1, 1);

        // Text is a getter, not a fixed string - _enableAirplaneFallback()
        // may flip this._airplaneMode to true after buildActor() has
        // already run, if no Bluetooth adapter is found. A single
        // attachTooltip() call (rather than re-attaching a second one on
        // fallback) keeps this to one set of enter/leave/click listeners
        // on the button.
        this._bluetoothTooltip = attachTooltip(
            this._bluetoothButton,
            this._layers,
            () => this._airplaneMode ? 'Airplane Mode' : 'Bluetooth'
        );

        this._tooltips.push(this._bluetoothTooltip);

        this._dndIcon = new St.Icon({icon_name: 'notifications-disabled-symbolic', icon_size: ICON_SIZE});
        this._dndButton = this._makeButton(this._dndIcon, () => this._toggleDnd());
        layout.attach(this._dndButton, 0, 1, 1, 1);
        this._tooltips.push(attachTooltip(this._dndButton, this._layers, 'Do Not Disturb'));

        // 'weather-clear-night-symbolic' isn't part of the GNOME48 Adwaita
        // icon set (see https://github.com/StorageB/icons/blob/main/GNOME48Adwaita/icons.md,
        // no 'weather' category at all) - night-light-symbolic is the
        // closest available stand-in and is what this widget uses.
        this._themeIcon = new St.Icon({icon_name: 'night-light-symbolic', icon_size: ICON_SIZE});
        this._themeButton = this._makeButton(this._themeIcon, () => this._toggleTheme());
        layout.attach(this._themeButton, 1, 1, 1, 1);
        this._tooltips.push(attachTooltip(this._themeButton, this._layers, 'Dark Mode'));

        // Placeholder state (all "off") until enable() reads the real
        // thing - buildActor() itself must stay side-effect-free.
        this._setToggleState(this._networkIcon, this._networkButton, false);
        this._setToggleState(this._bluetoothIcon, this._bluetoothButton, false);
        this._setToggleState(this._dndIcon, this._dndButton, false);
        this._setToggleState(this._themeIcon, this._themeButton, false);

        return this._actor;
    }

    enable() {
        this._enableNetwork();
        this._enableBluetooth();
        this._enableDnd();
        this._enableTheme();
    }

    // Undoes exactly what enable() started: every DBusProxy/GSettings
    // signal subscription. Unlike power-menu's hover-tooltip signals
    // (wired once in buildActor(), meant to live for the whole
    // instance), these four ARE real external subscriptions opened fresh
    // in enable(), so they're torn down here and re-subscribed on the
    // next enable() of a disable()/enable() cycle (e.g. screen lock).
    disable() {
        if (this._nmProxy && this._nmSignalId) {
            try {
                this._nmProxy.disconnect(this._nmSignalId);
            } catch (e) {
                // proxy may already be gone
            }
        }
        this._nmProxy = null;
        this._nmSignalId = null;

        if (this._btProxy && this._btSignalId) {
            try {
                this._btProxy.disconnect(this._btSignalId);
            } catch (e) {
                // proxy may already be gone
            }
        }
        this._btProxy = null;
        this._btSignalId = null;
        this._btAdapterPath = null;

        if (this._notifSettings && this._notifSignalId) {
            try {
                this._notifSettings.disconnect(this._notifSignalId);
            } catch (e) {
                // settings object may already be gone
            }
        }
        this._notifSettings = null;
        this._notifSignalId = null;

        if (this._interfaceSettings && this._interfaceSignalId) {
            try {
                this._interfaceSettings.disconnect(this._interfaceSignalId);
            } catch (e) {
                // settings object may already be gone
            }
        }
        this._interfaceSettings = null;
        this._interfaceSignalId = null;

        if (this._rfkillSettings && this._rfkillSignalId) {
            try {
                this._rfkillSettings.disconnect(this._rfkillSignalId);
            } catch (e) {
                // settings object may already be gone
            }
        }
        this._rfkillSettings = null;
        this._rfkillSignalId = null;

        for (const tooltip of this._tooltips)
            tooltip.hide();
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            ...BLUR_DEFAULTS,
        };
    }

    // Card background/corner-radius and both icon colors are all applied
    // once in buildActor()/enable() and never re-read on a timer, so
    // without this a Control Center edit wouldn't show up until the
    // widget reloads.
    onSettingsChanged(settings) {
        if (!this._actor)
            return;

        const backgroundColor = settings?.backgroundColor ?? '#070000a5';
        const cornerRadius = resolveCornerRadius(settings);
        this._layers.card.set_style(this._cardStyle(backgroundColor, cornerRadius));
        applyCardOpacity(this._layers.card, settings);
        this._layers.cardBlur.set_style(this._cardBlurStyle(backgroundColor, cornerRadius));
        applyCardBlur(this._layers.cardBlur, settings);

        this._iconOnColor = settings?.iconOnColor ?? '#3584e4';
        this._iconOffColor = settings?.iconOffColor ?? '#9a9996';

        // Re-apply each icon's color using its current (unchanged) on/off
        // state, now against the new color settings.
        this._renderNetwork();
        this._renderBluetooth();
        this._renderDnd();
        this._renderTheme();
    }


    /** @private */
    _enableNetwork() {
        try {
            this._nmProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
                'org.freedesktop.NetworkManager', null);
            this._nmSignalId = this._nmProxy.connect('g-properties-changed', () => this._renderNetwork());
        } catch (e) {
            this._api.logger.error(`settings-control: could not reach NetworkManager: ${e.message}`);
            this._nmProxy = null;
        }
        this._renderNetwork();
    }

    /** @private */
    _renderNetwork() {
        if (!this._networkIcon)
            return;

        const enabled = this._nmProxy?.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        const connType = this._nmProxy?.get_cached_property('PrimaryConnectionType')?.unpack() ?? '';

        let iconName = 'network-wireless-offline-symbolic';
        if (connType.includes('ethernet'))
            iconName = 'network-wired-symbolic';
        else if (enabled)
            iconName = 'network-wireless-symbolic';
        this._networkIcon.icon_name = iconName;

        this._setToggleState(this._networkIcon, this._networkButton, enabled);
    }

    /** @private */
    _toggleNetwork() {
        if (!this._nmProxy) {
            this._api.logger.error('settings-control: Wi-Fi toggle requested but NetworkManager is unavailable');
            return;
        }
        const enabled = this._nmProxy.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        this._setDBusProperty(
            Gio.BusType.SYSTEM, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled', GLib.Variant.new_boolean(!enabled)
        );
    }


    /** @private */
    _enableBluetooth() {
        try {
            const objectManager = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.bluez',
                '/',
                'org.freedesktop.DBus.ObjectManager',
                null
            );

            const [managedObjects] = objectManager.call_sync(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            ).deep_unpack();

            this._btAdapterPath = Object.keys(managedObjects)
                .find(path => 'org.bluez.Adapter1' in managedObjects[path]) ?? null;

            if (this._btAdapterPath) {
                this._btProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SYSTEM,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.bluez',
                    this._btAdapterPath,
                    'org.bluez.Adapter1',
                    null
                );

                this._btSignalId = this._btProxy.connect(
                    'g-properties-changed',
                    () => this._renderBluetooth()
                );

                this._airplaneMode = false;
            } else {
                this._enableAirplaneFallback();
            }

        } catch (e) {
            // Bluetooth/BlueZ ไม่มี → ใช้ Airplane Mode แทน
            this._btProxy = null;
            this._btAdapterPath = null;
            this._enableAirplaneFallback();
        }

        this._renderBluetooth();
    }
    _enableAirplaneFallback() {
    this._airplaneMode = true;

    // Subscribe once so external Airplane Mode changes (GNOME Quick
    // Settings, a hardware kill switch, etc.) update this icon live -
    // mirrors settings-control-bar's _enableAirplaneModeFallback().
    try {
        this._rfkillSettings = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.plugins.rfkill'
        });
        this._rfkillSignalId = this._rfkillSettings.connect(
            'changed::airplane-mode',
            () => this._renderBluetooth()
        );
    } catch (e) {
        this._api.logger.error(
            `settings-control: could not reach rfkill settings: ${e.message}`
        );
        this._rfkillSettings = null;
    }

    if (!this._bluetoothIcon || !this._bluetoothButton)
        return;

    this._bluetoothIcon.icon_name = 'airplane-mode-symbolic';

    this._setToggleState(
        this._bluetoothIcon,
        this._bluetoothButton,
        false
    );

    // this._airplaneMode is already true by this point, and the
    // tooltip getter passed to attachTooltip() in buildActor() already
    // checks it - so the very next hover shows "Airplane Mode" with no
    // need to hide/re-attach a second tooltip on the same button.
}

    /** @private */
    _renderBluetooth() {
        if (!this._bluetoothIcon)
            return;

        if (this._airplaneMode) {
            this._renderAirplaneMode();
            return;
        }

        const powered =
            this._btProxy
                ?.get_cached_property('Powered')
                ?.unpack() ?? false;

        this._bluetoothIcon.icon_name = 'bluetooth-symbolic';

        this._setToggleState(
            this._bluetoothIcon,
            this._bluetoothButton,
            powered
        );
    }
    _renderAirplaneMode() {
        const enabled = this._rfkillSettings?.get_boolean('airplane-mode') ?? false;

        this._bluetoothIcon.icon_name = 'airplane-mode-symbolic';

        this._setToggleState(
            this._bluetoothIcon,
            this._bluetoothButton,
            enabled
        );
    }
    /** @private */
    _toggleBluetoothOrAirplane() {
        if (this._airplaneMode) {
            this._toggleAirplaneMode();
            return;
        }

        this._toggleBluetooth();
    }
    _toggleAirplaneMode() {
        if (!this._rfkillSettings) {
            this._api.logger.error(
                'settings-control: Airplane Mode toggle requested but rfkill is unavailable'
            );
            return;
        }
        try {
            const current = this._rfkillSettings.get_boolean('airplane-mode');
            this._rfkillSettings.set_boolean('airplane-mode', !current);
            // No optimistic set_toggle_state needed here - the
            // changed::airplane-mode signal from _enableAirplaneFallback()
            // will call _renderBluetooth() and pick up the new value.
        } catch (e) {
            this._api.logger.error(
                `settings-control: Airplane Mode toggle failed: ${e.message}`
            );
        }
    }


    /** @private */
    _enableDnd() {
        try {
            this._notifSettings = new Gio.Settings({schema_id: NOTIFICATIONS_SCHEMA});
            this._notifSignalId = this._notifSettings.connect('changed::show-banners', () => this._renderDnd());
        } catch (e) {
            this._api.logger.error(`settings-control: could not reach ${NOTIFICATIONS_SCHEMA}: ${e.message}`);
            this._notifSettings = null;
        }
        this._renderDnd();
    }

    /** @private */
    _renderDnd() {
        if (!this._dndIcon)
            return;
        // Do Not Disturb is "on" when banners are turned off - same
        // inverted relationship GNOME's own Quick Settings toggle uses.
        const dndOn = this._notifSettings ? !this._notifSettings.get_boolean('show-banners') : false;
        this._setToggleState(this._dndIcon, this._dndButton, dndOn);
    }

    /** @private */
    _toggleDnd() {
        if (!this._notifSettings) {
            this._api.logger.error(`settings-control: Do Not Disturb toggle requested but ${NOTIFICATIONS_SCHEMA} is unavailable`);
            return;
        }
        const showBanners = this._notifSettings.get_boolean('show-banners');
        this._notifSettings.set_boolean('show-banners', !showBanners);
    }


    /** @private */
    _enableTheme() {
        try {
            this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
            this._interfaceSignalId = this._interfaceSettings.connect('changed::color-scheme', () => this._renderTheme());
        } catch (e) {
            this._api.logger.error(`settings-control: could not reach ${INTERFACE_SCHEMA}: ${e.message}`);
            this._interfaceSettings = null;
        }
        this._renderTheme();
    }

    /** @private */
    _renderTheme() {
        if (!this._themeIcon)
            return;
        const scheme = this._interfaceSettings?.get_string('color-scheme') ?? 'default';
        this._setToggleState(this._themeIcon, this._themeButton, scheme === 'prefer-dark');
    }

    /** @private */
    _toggleTheme() {
        if (!this._interfaceSettings) {
            this._api.logger.error(`settings-control: Dark Mode toggle requested but ${INTERFACE_SCHEMA} is unavailable`);
            return;
        }
        const scheme = this._interfaceSettings.get_string('color-scheme');
        this._interfaceSettings.set_string('color-scheme', scheme === 'prefer-dark' ? 'default' : 'prefer-dark');
    }

    // ---- Shared helpers -----------------------------------------------------

    /** @private */
    _makeButton(icon, onClicked) {
        const button = new St.Button({
            style_class: 'settings-control-widget-button',
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.set_size(BUTTON_SIZE, BUTTON_SIZE);
        // Background fill is set by _setToggleState() below, not here -
        // it depends on on/off state, which isn't known yet at construction.
        button.connect('clicked', onClicked);
        return button;
    }

    /**
     * @private styles one button + its icon according to on/off state.
     * The icon glyph itself stays a constant white (GNOME's own Quick
     * Settings toggles use this same convention) - it's the BUTTON's
     * background that "lights up": a faint tint of iconOffColor when
     * off, a much more opaque fill of iconOnColor when on.
     */
    _setToggleState(icon, button, isOn) {
        icon.set_style('color: #ffffff;');

        const hex = isOn ? this._iconOnColor : this._iconOffColor;
        const {r, g, b} = this._hexToRgba(hex);
        const alpha = isOn ? 0.9 : 0.12;
        button.set_style(`background-color: rgba(${r}, ${g}, ${b}, ${alpha}); border-radius: ${BUTTON_SIZE / 2}px;`);
    }

    /**
     * @private sets a single DBus property via org.freedesktop.DBus.Properties.Set
     * - used instead of relying on a proxy's own property setter since
     * neither proxy here was built with interface introspection info.
     */
    _setDBusProperty(busType, busName, objectPath, interfaceName, propertyName, variant) {
        try {
            const connection = busType === Gio.BusType.SYSTEM
                ? Gio.DBus.system
                : Gio.DBus.session;
            connection.call(
                busName, objectPath, 'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', [interfaceName, propertyName, variant]),
                null, Gio.DBusCallFlags.NONE, -1, null,
                (source, res) => {
                    try {
                        source.call_finish(res);
                    } catch (e) {
                        this._api.logger.error(`settings-control: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
                    }
                }
            );
        } catch (e) {
            this._api.logger.error(`settings-control: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
        }
    }

    /** @private builds the card's inline style string (see power-menu's identical helper for the hex-alpha rationale). */
    _cardStyle(hexColor, cornerRadius) {
        const {r, g, b, a} = this._hexToRgba(hexColor);
        return `background-color: rgba(${r}, ${g}, ${b}, ${a}); border-radius: ${cornerRadius}px; ` +
            _borderCss(this._settings) +
            _shadowBoxShadowCss(this._settings);
    }

    /** @private just background-color + border-radius, for the Blur Layer - border/shadow stay on `card` only, or they'd be drawn twice. */
    _cardBlurStyle(hexColor, cornerRadius) {
        const {r, g, b, a} = this._hexToRgba(hexColor);
        return `background-color: rgba(${r}, ${g}, ${b}, ${a}); border-radius: ${cornerRadius}px;`;
    }

    /** @private "#rrggbb" / "#rrggbbaa" (or 3/4-digit shorthand) -> {r, g, b} 0-255 each, {a} 0-1. */
    _hexToRgba(hex) {
        let value = String(hex).replace('#', '');
        if (value.length === 3 || value.length === 4)
            value = [...value].map(c => c + c).join('');
        const rgbNum = parseInt(value.slice(0, 6), 16);
        if (Number.isNaN(rgbNum))
            return {r: 255, g: 255, b: 255, a: 0.85}; // falls back to the default #070000a5

        const alphaByte = value.length >= 8 ? parseInt(value.slice(6, 8), 16) : 255;
        const a = Number.isNaN(alphaByte) ? 1 : Math.round((alphaByte / 255) * 1000) / 1000;
        return {r: (rgbNum >> 16) & 255, g: (rgbNum >> 8) & 255, b: rgbNum & 255, a};
    }
}
