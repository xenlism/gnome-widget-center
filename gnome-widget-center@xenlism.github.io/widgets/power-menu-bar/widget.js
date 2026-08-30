import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS, BLUR_DEFAULTS, toCssColor as _toCssColor} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyLayeredCardStyle} from '../../lib/shell/cardLayers.js';
import {attachTooltip} from '../../lib/shell/widgetTooltip.js';
import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

const TOOLTIP_SHOW_DELAY_MS = 400;
const ICON_SIZE = 24;
const BUTTON_SIZE = 60;
const PADDING = 0;
const BUTTON_SPACING = 24;

export default class PowerMenuBarWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._tooltips = [];
        this._icons = [];
        this._buttons = [];
        this._sessionProxy = null;
        this._login1Proxy = null;
    }

    buildActor() {
        const iconColor = this._settings?.iconColor ?? '#2e2e2e';
        const buttonColor = this._settings?.buttonColor ?? '#FFFFFF1F';

        this._layers = createLayeredCard({
            contentStyleClass: 'power-menu-bar-widget-root',
            withTooltipLayer: true,
        });
        this._actor = this._layers.root;
        this._actor.reactive = true;

        applyLayeredCardStyle(this._layers, this._settings, {backgroundColorFallback: '#070000a5', cornerRadiusFallback: 18});

        this._content = new St.Bin({
            style_class: 'power-menu-bar-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._content.set_style(`padding: ${PADDING}px;`);
        this._layers.content.add_child(this._content);

        this._row = new St.BoxLayout({
            style_class: 'power-menu-bar-widget-row',
            style: `spacing: ${BUTTON_SPACING}px;`,
            vertical: false,
        });
        this._content.set_child(this._row);

        const actions = [
            {icon: 'media-playback-pause-symbolic', tooltip: 'Suspend', onClicked: () => this._suspend()},
            {icon: 'system-reboot-symbolic', tooltip: 'Restart', onClicked: () => this._restart()},
            {icon: 'system-shutdown-symbolic', tooltip: 'Power Off', onClicked: () => this._shutdown()},
            {icon: 'system-log-out-symbolic', tooltip: 'Log Out', onClicked: () => this._logout()},
        ];

        actions.forEach(({icon, tooltip, onClicked}) => {
            const button = this._makeButton(icon, iconColor, buttonColor, onClicked);
            this._row.add_child(button);
            this._tooltips.push(attachTooltip(button, this._layers, tooltip));
        });

        return this._actor;
    }

    enable() {
        try {
            this._sessionProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                'org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', null);
        } catch (e) {
            this._api.logger.error(`power-menu-bar: could not reach org.gnome.SessionManager: ${e.message}`);
        }

        try {
            this._login1Proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.login1', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', null);
        } catch (e) {
            this._api.logger.error(`power-menu-bar: could not reach org.freedesktop.login1: ${e.message}`);
        }
    }

    disable() {
        for (const tooltip of this._tooltips)
            tooltip.hide();
        this._sessionProxy = null;
        this._login1Proxy = null;
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

    onSettingsChanged(settings) {
        if (!this._actor)
            return;

        applyLayeredCardStyle(this._layers, settings, {backgroundColorFallback: '#070000a5', cornerRadiusFallback: 18});

        const iconColor = settings?.iconColor ?? '#2e2e2e';
        for (const icon of this._icons)
            icon.set_style(`color: ${iconColor};`);

        const buttonColor = settings?.buttonColor ?? '#FFFFFF1F';
        for (const button of this._buttons)
            button.set_style(this._buttonStyle(buttonColor));
    }

    _makeButton(iconName, iconColor, buttonColor, onClicked) {
        const icon = new St.Icon({icon_name: iconName, icon_size: ICON_SIZE});
        icon.set_style(`color: ${iconColor};`);
        this._icons.push(icon);

        const button = new St.Button({
            style_class: 'power-menu-bar-widget-button',
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.set_size(BUTTON_SIZE, BUTTON_SIZE);
        button.set_style(this._buttonStyle(buttonColor));
        this._buttons.push(button);
        button.connect('clicked', onClicked);
        return button;
    }

    _buttonStyle(buttonColor) {
        return `background-color: ${_toCssColor(buttonColor, '#FFFFFF1F')}; border-radius: ${BUTTON_SIZE / 2}px;`;
    }

    _suspend() {
        this._callLogin1('Suspend', new GLib.Variant('(b)', [true]));
    }

    _restart() {
        this._callSession('Reboot', null);
    }

    _shutdown() {
        this._callSession('Shutdown', null);
    }

    _logout() {
        this._callSession('Logout', new GLib.Variant('(u)', [0]));
    }

    _callSession(method, params) {
        if (!this._sessionProxy) {
            this._api.logger.error(`power-menu-bar: ${method} requested but SessionManager is unavailable`);
            return;
        }
        this._call(this._sessionProxy, method, params);
    }

    _callLogin1(method, params) {
        if (!this._login1Proxy) {
            this._api.logger.error(`power-menu-bar: ${method} requested but login1 is unavailable`);
            return;
        }
        this._call(this._login1Proxy, method, params);
    }

    _call(proxy, method, params) {
        try {
            proxy.call(method, params, Gio.DBusCallFlags.NONE, -1, null, (source, res) => {
                try {
                    source.call_finish(res);
                } catch (e) {
                    this._api.logger.error(`power-menu-bar: ${method} failed: ${e.message}`);
                }
            });
        } catch (e) {
            this._api.logger.error(`power-menu-bar: ${method} failed: ${e.message}`);
        }
    }
}
