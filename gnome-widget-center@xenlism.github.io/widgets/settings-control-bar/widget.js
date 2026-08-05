// widgets/settings-control-bar/widget.js
//
// A wide `barx2` card (23x5 grid cells = 368x80px): the same four
// icon-only TOGGLE buttons as widgets/settings-control (Wi-Fi/Ethernet,
// Bluetooth, Do Not Disturb, Dark/Light mode) - just laid out in a
// single evenly-spaced ROW instead of a 2x2 grid, to suit the
// short/wide bar shape. Same no-label-just-a-tooltip visual language as
// widgets/power-menu-bar - see that widget's _attachTooltip() for the
// pattern reused here.
//
// Root actor (this._actor) is a plain St.Widget with Clutter.FixedLayout,
// holding a single St.Bin child (this._content) that does the actual
// centering/painting - lib/blockSizeManager.js's applyBlockSize()
// force-sets the root actor to an exact cols*16 x rows*16px size from
// metadata.json's block-type (23x5 cells = 368x80px) regardless of
// anything set here, so this._content is bound to that size via a
// Clutter.BindConstraint rather than a hardcoded pixel size - same fix
// as widgets/settings-control and widgets/power-menu-bar.
//
// The four buttons sit in equal-width cells across the row (an St.Bin
// per button, x_expand: true, button centered inside), so they stay
// evenly spread across the full bar width rather than clumped - same
// layout widgets/power-menu-bar uses for its own four buttons.
//
// Unlike power-menu-bar's fire-and-forget actions, every button here
// reflects live system state. Rather than recoloring the icon glyph
// itself (icons stay a constant white, matching GNOME's own Quick
// Settings toggles), the BUTTON's background fill is what shows on/off
// state - a faint tint of iconOffColor when off, a much more opaque
// fill of iconOnColor when on, so the button visibly "lights up" when
// toggled. Each source below stays in sync if the setting is changed
// some other way (GNOME Settings app, another instance of this widget,
// an external nmcli/bluetoothctl command, etc.) - subscribed to via
// signals, never polled, per WIDGET_API.md §9.1's must-follow rules:
//
//   - Wi-Fi/Ethernet -> org.freedesktop.NetworkManager (system bus).
//     Icon glyph switches between wifi/wired/offline based on
//     PrimaryConnectionType; the click toggles WirelessEnabled.
//   - Bluetooth       -> org.bluez (system bus). Adapter is discovered
//     once via the root ObjectManager; click toggles the adapter's own
//     Powered property. If NO adapter is present (desktop, VM, adapter
//     disabled in firmware), this button/icon automatically falls back
//     to an Airplane Mode toggle instead of sitting permanently inert -
//     org.gnome.SettingsDaemon.Rfkill (session bus), the same DBus
//     service GNOME Shell's own Quick Settings "Airplane Mode" toggle
//     uses (js/ui/status/rfkill.js), toggling its AirplaneMode property.
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
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba} from '../../lib/widgetVisualKit.js';

const TOOLTIP_SHOW_DELAY_MS = 400;
const ICON_SIZE = 22;
const BUTTON_SIZE = 60;
const PADDING_X = 18;
const PADDING_Y = 10;

const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

// Airplane Mode fallback - only used when no Bluetooth adapter is found.
// Same DBus service GNOME Shell's own Quick Settings menu reads.
const RFKILL_BUS_NAME = 'org.gnome.SettingsDaemon.Rfkill';
const RFKILL_OBJECT_PATH = '/org/gnome/SettingsDaemon/Rfkill';
const RFKILL_IFACE = 'org.gnome.SettingsDaemon.Rfkill';

export default class SettingsControlBarWidget {
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

        // 'bluetooth' (default) or 'airplane' - which mode the second
        // button is currently in, decided fresh each enable() by
        // whether a Bluetooth adapter was found. See _enableBluetooth().
        this._btMode = 'bluetooth';
        this._bluetoothTooltipText = 'Bluetooth';
        this._rfkillProxy = null;
        this._rfkillSignalId = null;

        this._notifSettings = null;
        this._notifSignalId = null;
        this._interfaceSettings = null;
        this._interfaceSignalId = null;
    }

    // Must never throw. Builds the row with placeholder (off-color,
    // generic) icons - enable() fills in real state right after this
    // actor is placed in the Widget Layer.
    buildActor() {
        this._iconOnColor = this._settings?.iconOnColor ?? '#3584e4';
        this._iconOffColor = this._settings?.iconOffColor ?? '#9a9996';

        // Plain (non-layout-managed-by-parent) root so tooltip labels can
        // be positioned as free-floating overlay children - same pattern
        // as widgets/power-menu-bar/widget.js.
        this._actor = new St.Widget({
            style_class: 'settings-control-bar-widget-root',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
        });

        this._content = new St.Bin({
            style_class: 'settings-control-bar-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._actor.add_child(this._content);
        // FixedLayout otherwise allocates this child at its natural width,
        // which prevents the expanding cells below from spreading the icons
        // across the bar. Keep the painted card and row at the root's full
        // block allocation instead.
        const syncContentSize = () => {
            this._content.set_position(0, 0);
            this._content.set_size(this._actor.width, this._actor.height);
        };
        this._actor.connect('notify::width', syncContentSize);
        this._actor.connect('notify::height', syncContentSize);
        syncContentSize();
        this._content.set_style(
            _cardStyleCss(this._settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18}) +
            `padding: ${PADDING_Y}px ${PADDING_X}px;`
        );

        this._row = new St.BoxLayout({
            style_class: 'settings-control-bar-widget-row',
            vertical: false,
            x_expand: true,
            y_expand: true,
        });
        this._content.set_child(this._row);

        const addButton = (icon, button, tooltip) => {
            const cell = new St.Bin({
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                child: button,
            });
            this._row.add_child(cell);
            this._tooltips.push(this._attachTooltip(button, tooltip));
        };

        this._networkIcon = new St.Icon({icon_name: 'network-wireless-offline-symbolic', icon_size: ICON_SIZE});
        this._networkButton = this._makeButton(this._networkIcon, () => this._toggleNetwork());
        addButton(this._networkIcon, this._networkButton, 'Wi-Fi');

        this._bluetoothIcon = new St.Icon({icon_name: 'bluetooth-symbolic', icon_size: ICON_SIZE});
        this._bluetoothButton = this._makeButton(this._bluetoothIcon, () => this._toggleBluetooth());
        // Text is a getter, not a fixed string - enable() may switch
        // this._bluetoothTooltipText to 'Airplane Mode' after buildActor()
        // has already run, if no Bluetooth adapter is found.
        addButton(this._bluetoothIcon, this._bluetoothButton, () => this._bluetoothTooltipText);

        this._dndIcon = new St.Icon({icon_name: 'notifications-disabled-symbolic', icon_size: ICON_SIZE});
        this._dndButton = this._makeButton(this._dndIcon, () => this._toggleDnd());
        addButton(this._dndIcon, this._dndButton, 'Do Not Disturb');

        // 'weather-clear-night-symbolic' isn't part of the GNOME48 Adwaita
        // icon set (see https://github.com/StorageB/icons/blob/main/GNOME48Adwaita/icons.md,
        // no 'weather' category at all) - night-light-symbolic is the
        // closest available stand-in and is what this widget uses.
        this._themeIcon = new St.Icon({icon_name: 'night-light-symbolic', icon_size: ICON_SIZE});
        this._themeButton = this._makeButton(this._themeIcon, () => this._toggleTheme());
        addButton(this._themeIcon, this._themeButton, 'Dark Mode');

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
    // signal subscription. Unlike power-menu-bar's hover-tooltip signals
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

        if (this._rfkillProxy && this._rfkillSignalId) {
            try {
                this._rfkillProxy.disconnect(this._rfkillSignalId);
            } catch (e) {
                // proxy may already be gone
            }
        }
        this._rfkillProxy = null;
        this._rfkillSignalId = null;

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

        for (const tooltip of this._tooltips)
            tooltip.hide();
    }

    getDefaultSettings() {
        return {
            backgroundColor: '#FFFFFF00', // white @ 0.85 alpha ("d9")
            iconOnColor: '#3584e4',
            iconOffColor: '#9a9996',
            cornerRadius: 18,
            ...SHADOW_DEFAULTS,
        };
    }

    // Card background/corner-radius and both icon colors are all applied
    // once in buildActor()/enable() and never re-read on a timer, so
    // without this a Control Center edit wouldn't show up until the
    // widget reloads.
    onSettingsChanged(settings) {
        if (!this._actor)
            return;

        this._content.set_style(
            _cardStyleCss(settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18}) +
            `padding: ${PADDING_Y}px ${PADDING_X}px;`
        );

        this._iconOnColor = settings?.iconOnColor ?? '#3584e4';
        this._iconOffColor = settings?.iconOffColor ?? '#9a9996';

        // Re-apply each icon's color using its current (unchanged) on/off
        // state, now against the new color settings.
        this._renderNetwork();
        this._renderBluetooth();
        this._renderDnd();
        this._renderTheme();
    }

    // ---- Wi-Fi / Ethernet (org.freedesktop.NetworkManager) ----------------

    /** @private */
    _enableNetwork() {
        try {
            this._nmProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
                'org.freedesktop.NetworkManager', null);
            this._nmSignalId = this._nmProxy.connect('g-properties-changed', () => this._renderNetwork());
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach NetworkManager: ${e.message}`);
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
            this._api.logger.error('settings-control-bar: Wi-Fi toggle requested but NetworkManager is unavailable');
            return;
        }
        const enabled = this._nmProxy.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        this._setDBusProperty(
            Gio.BusType.SYSTEM, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled', GLib.Variant.new_boolean(!enabled)
        );
    }

    // ---- Bluetooth (org.bluez), falling back to Airplane Mode ------------
    // (org.gnome.SettingsDaemon.Rfkill) when no adapter is present --------

    /** @private discovers a Bluetooth adapter via BlueZ's root
     * ObjectManager. If none is found (desktop, VM, adapter disabled in
     * firmware), falls back to an Airplane Mode toggle in the same
     * button/icon slot via _enableAirplaneModeFallback() rather than
     * leaving this button permanently inert. */
    _enableBluetooth() {
        try {
            const objectManager = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', null);
            const [managedObjects] = objectManager.call_sync(
                'GetManagedObjects', null, Gio.DBusCallFlags.NONE, -1, null
            ).deep_unpack();

            this._btAdapterPath = Object.keys(managedObjects)
                .find(path => 'org.bluez.Adapter1' in managedObjects[path]) ?? null;
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach BlueZ: ${e.message}`);
            this._btAdapterPath = null;
        }

        if (this._btAdapterPath) {
            try {
                this._btProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                    'org.bluez', this._btAdapterPath, 'org.bluez.Adapter1', null);
                this._btSignalId = this._btProxy.connect('g-properties-changed', () => this._renderBluetooth());
                this._btMode = 'bluetooth';
                this._bluetoothTooltipText = 'Bluetooth';
            } catch (e) {
                this._api.logger.error(`settings-control-bar: could not reach BlueZ adapter: ${e.message}`);
                this._btProxy = null;
                this._btAdapterPath = null;
            }
        }

        if (!this._btAdapterPath) {
            this._api.logger.info('settings-control-bar: no Bluetooth adapter found, switching this button to Airplane Mode');
            this._enableAirplaneModeFallback();
        }

        this._renderBluetooth();
    }

    /** @private only called when no Bluetooth adapter was found. Same
     * DBus service (session bus) GNOME Shell's own Quick Settings
     * "Airplane Mode" toggle reads/writes. */
    _enableAirplaneModeFallback() {
        try {
            this._rfkillProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                RFKILL_BUS_NAME, RFKILL_OBJECT_PATH, RFKILL_IFACE, null);
            this._rfkillSignalId = this._rfkillProxy.connect('g-properties-changed', () => this._renderBluetooth());
            this._btMode = 'airplane';
            this._bluetoothTooltipText = 'Airplane Mode';
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach ${RFKILL_BUS_NAME}: ${e.message}`);
            this._rfkillProxy = null;
            // Neither Bluetooth nor rfkill available - leave the button
            // inert, same "missing service" convention as every other
            // toggle in this widget, but keep the Bluetooth label/icon
            // rather than claiming an Airplane Mode toggle that doesn't work.
            this._btMode = 'bluetooth';
            this._bluetoothTooltipText = 'Bluetooth';
        }
    }

    /** @private */
    _renderBluetooth() {
        if (!this._bluetoothIcon)
            return;

        if (this._btMode === 'airplane') {
            this._bluetoothIcon.icon_name = 'airplane-mode-symbolic';
            const airplaneOn = this._rfkillProxy?.get_cached_property('AirplaneMode')?.unpack() ?? false;
            // Airplane Mode "on" is the active/lit state here, same
            // on=lit convention as every other toggle in this row -
            // even though it's the opposite polarity from Bluetooth's
            // own Powered property (on = radio enabled).
            this._setToggleState(this._bluetoothIcon, this._bluetoothButton, airplaneOn);
            return;
        }

        this._bluetoothIcon.icon_name = 'bluetooth-symbolic';
        const powered = this._btProxy?.get_cached_property('Powered')?.unpack() ?? false;
        this._setToggleState(this._bluetoothIcon, this._bluetoothButton, powered);
    }

    /** @private */
    _toggleBluetooth() {
        if (this._btMode === 'airplane') {
            if (!this._rfkillProxy) {
                this._api.logger.error('settings-control-bar: Airplane Mode toggle requested but rfkill is unavailable');
                return;
            }
            const airplaneOn = this._rfkillProxy.get_cached_property('AirplaneMode')?.unpack() ?? false;
            this._setDBusProperty(
                Gio.BusType.SESSION, RFKILL_BUS_NAME, RFKILL_OBJECT_PATH,
                RFKILL_IFACE, 'AirplaneMode', GLib.Variant.new_boolean(!airplaneOn)
            );
            return;
        }

        if (!this._btProxy || !this._btAdapterPath) {
            this._api.logger.error('settings-control-bar: Bluetooth toggle requested but no adapter is available');
            return;
        }
        const powered = this._btProxy.get_cached_property('Powered')?.unpack() ?? false;
        this._setDBusProperty(
            Gio.BusType.SYSTEM, 'org.bluez', this._btAdapterPath,
            'org.bluez.Adapter1', 'Powered', GLib.Variant.new_boolean(!powered)
        );
    }

    // ---- Do Not Disturb (GSettings) -----------------------------------------

    /** @private */
    _enableDnd() {
        try {
            this._notifSettings = new Gio.Settings({schema_id: NOTIFICATIONS_SCHEMA});
            this._notifSignalId = this._notifSettings.connect('changed::show-banners', () => this._renderDnd());
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach ${NOTIFICATIONS_SCHEMA}: ${e.message}`);
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
            this._api.logger.error(`settings-control-bar: Do Not Disturb toggle requested but ${NOTIFICATIONS_SCHEMA} is unavailable`);
            return;
        }
        const showBanners = this._notifSettings.get_boolean('show-banners');
        this._notifSettings.set_boolean('show-banners', !showBanners);
    }

    // ---- Dark / Light mode (GSettings) -------------------------------------

    /** @private */
    _enableTheme() {
        try {
            this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
            this._interfaceSignalId = this._interfaceSettings.connect('changed::color-scheme', () => this._renderTheme());
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach ${INTERFACE_SCHEMA}: ${e.message}`);
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
            this._api.logger.error(`settings-control-bar: Dark Mode toggle requested but ${INTERFACE_SCHEMA} is unavailable`);
            return;
        }
        const scheme = this._interfaceSettings.get_string('color-scheme');
        this._interfaceSettings.set_string('color-scheme', scheme === 'prefer-dark' ? 'default' : 'prefer-dark');
    }

    // ---- Shared helpers -----------------------------------------------------

    /** @private */
    _makeButton(icon, onClicked) {
        const button = new St.Button({
            style_class: 'settings-control-bar-widget-button',
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
        const {r, g, b} = _hexToRgba(hex);
        const alpha = isOn ? 0.9 : 0.12;
        button.set_style(`background-color: rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha}); border-radius: ${BUTTON_SIZE / 2}px;`);
    }

    /**
     * @private hover-tooltip for a single row button - see
     * widgets/power-menu-bar/widget.js's _attachTooltip() for the
     * original this was copied from (kept local since widget.js can't
     * import another widget's file, and lib/widgetEditMode.js's own
     * version is private to that module). Position is computed via
     * get_transformed_position() (absolute/stage coordinates) rather
     * than summing each ancestor's own get_position() - robust
     * regardless of how many containers (row -> per-button cell ->
     * button) sit between the button and this._content. disable() only
     * ever calls the returned hide() - see disable()'s comment for why
     * the signal connections themselves stay live across a
     * disable()/enable() cycle.
     * @param {St.Button} button
     * @param {string|function(): string} textOrFn - a fixed label, or a
     *   getter called fresh on every hover (e.g. the Bluetooth/Airplane
     *   Mode button's label, which can change after enable() runs).
     */
    _attachTooltip(button, textOrFn) {
        let showTimeoutId = null;
        let tooltipLabel = null;

        const hide = () => {
            if (showTimeoutId != null) {
                GLib.source_remove(showTimeoutId);
                showTimeoutId = null;
            }
            tooltipLabel?.destroy();
            tooltipLabel = null;
        };

        const enterId = button.connect('enter-event', () => {
            showTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_SHOW_DELAY_MS, () => {
                showTimeoutId = null;
                const text = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
                tooltipLabel = new St.Label({
                    style_class: 'settings-control-bar-widget-tooltip',
                    text,
                });
                tooltipLabel.set_style(
                    'background-color: rgba(20, 20, 20, 0.95); color: #fff; ' +
                    'font-size: 12px; padding: 4px 8px; border-radius: 6px;'
                );
                // this._content is tooltipLabel's true parent-to-be - it's
                // also the direct parent of this._row, so this stays valid
                // however many per-button wrapper levels sit in between.
                this._content.insert_child_above(tooltipLabel, this._row);

                const [buttonAbsX, buttonAbsY] = button.get_transformed_position();
                const [contentAbsX, contentAbsY] = this._content.get_transformed_position();
                const buttonX = buttonAbsX - contentAbsX;
                const buttonY = buttonAbsY - contentAbsY;

                const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
                const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
                const [cardWidth, cardHeight] = this._actor.get_size();

                // Prefer just above the button, but the widget layer clips
                // each widget to its own allocated card - anything
                // positioned outside [0, cardWidth] x [0, cardHeight] is
                // simply invisible rather than floating over neighboring
                // widgets, so both axes are clamped to stay fully on-card.
                const idealX = buttonX + (button.width - labelWidth) / 2;
                const idealY = buttonY - labelHeight - 6;
                tooltipLabel.set_position(
                    Math.max(0, Math.min(idealX, cardWidth - labelWidth)),
                    Math.max(0, Math.min(idealY, cardHeight - labelHeight))
                );

                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = button.connect('leave-event', () => {
            hide();
            return Clutter.EVENT_PROPAGATE;
        });
        const clickedId = button.connect('clicked', hide);

        return {
            // Called from disable() - cancels any pending show timeout and
            // destroys an already-visible label, without touching the
            // signal connections themselves (see disable()'s comment).
            hide,
            // Not currently called anywhere (the widget's buttons live for
            // the whole instance), but kept for symmetry/completeness in
            // case a future change needs to fully tear a button down.
            destroy() {
                hide();
                try {
                    button.disconnect(enterId);
                    button.disconnect(leaveId);
                    button.disconnect(clickedId);
                } catch (e) {
                    // button may already be destroyed by the caller's own
                    // teardown - same defensive pattern as widgetEditMode.js.
                }
            },
        };
    }

    /**
     * @private issues a DBus Properties.Set call directly (rather than
     * going through a GDBusProxy's generated setter) since both the
     * NetworkManager and BlueZ adapter proxies here were built without
     * interface introspection info.
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
                        this._api.logger.error(`settings-control-bar: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
                    }
                }
            );
        } catch (e) {
            this._api.logger.error(`settings-control-bar: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
        }
    }
}
