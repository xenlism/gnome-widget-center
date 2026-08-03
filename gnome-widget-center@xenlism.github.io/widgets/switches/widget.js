// widgets/switches/widget.js
//
// 1x1 card: two tall pill-shaped St.Button toggles side by side -
// "Volume" (mute/unmute the default audio output) and "Light" (Night
// Light on/off) - matching the reference mockup this was built from.
// Same root/content split as widgets/settings-control/widget.js (a
// plain St.Widget root + an St.Bin content bound to it via
// Clutter.BindConstraint, since lib/blockSizeManager.js's
// applyBlockSize() force-sets the root actor's size from metadata.json's
// block-type after buildActor() returns - see that widget's header for
// the full rationale) and the same "icon glyph stays white, the
// BUTTON's fill shows on/off state" visual language.
//
// State sources, both subscribed to via signals (never polled), per
// WIDGET_API.md §9.1's must-follow rules:
//
//   - Volume  -> Gvc.MixerControl (libgnome-volume-control), the same
//     GObject-introspected library GNOME Shell's own volume indicator
//     (js/ui/status/volume.js) is built on - available in the Shell
//     process the same way St/Clutter are. Mutes/unmutes the current
//     default output stream; follows it if the default sink changes.
//   - Light (Night Light) -> GSettings
//     org.gnome.settings-daemon.plugins.color's night-light-enabled key -
//     the same key GNOME Settings' own Night Light switch uses.
//
// Both are wrapped defensively: if Gvc isn't available, or the
// night-light schema doesn't exist (non-GNOME session, older Shell,
// sandboxed test environment), that one button is left inert (base-color
// fill, logs on click) rather than throwing - buildActor() itself never
// touches Gvc/GSettings, only enable() does.
//
// **Least-verified part of this widget** (flagged the same way this
// project's own HANDOVER.md flags its own riskiest assumptions): the
// exact Gvc.MixerControl signal sequence here (`state-changed` to
// Gvc.MixerControlState.READY, then `default-sink-changed`, then the
// stream's own `notify::is-muted`) matches js/ui/status/volume.js from
// memory but has NOT been run against a live gnome-shell process yet -
// if the default sink never resolves, that's the first thing to check.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, hexToRgba as _hexToRgba} from '../../lib/widgetVisualKit.js';

const BUTTON_WIDTH = 64;
const BUTTON_HEIGHT = 140;
const GAP = 12;
const PADDING = 14;
const ICON_SIZE = 26;

const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';

export default class SwitchesWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;

        this._baseColor = '#9a9996';
        this._highlightColor = '#3584e4';

        this._volumeIcon = null;
        this._volumeButton = null;
        this._lightIcon = null;
        this._lightButton = null;

        // Volume (Gvc) bookkeeping - all opened/torn down in enable()/disable().
        this._mixerControl = null;
        this._mixerStateId = null;
        this._defaultSinkChangedId = null;
        this._defaultSink = null;
        this._sinkMutedId = null;

        // Night Light (GSettings) bookkeeping.
        this._colorSettings = null;
        this._colorSignalId = null;
    }

    // Must never throw. Builds both pills in their "off" (base color)
    // state with generic icons - enable() fills in the real state right
    // after this actor is placed in the Widget Layer.
    buildActor() {
        this._baseColor = this._settings?.baseColor ?? '#9a9996';
        this._highlightColor = this._settings?.highlightColor ?? '#3584e4';
        const backgroundColor = this._settings?.backgroundColor ?? '#000000a9';
        const cornerRadius = this._settings?.cornerRadius ?? 18;

        // Plain root (see widgets/settings-control/widget.js's header for
        // why): lib/blockSizeManager.js's applyBlockSize() force-sets this
        // actor's size from metadata.json's block-type right after
        // buildActor() returns, so this._content is bound to whatever
        // that ends up being via a Clutter.BindConstraint rather than a
        // hardcoded pixel size.
        this._actor = new St.Widget({
            style_class: 'switches-widget-root',
            layout_manager: new Clutter.FixedLayout(),
        });

        this._content = new St.Bin({
            style_class: 'switches-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._actor.add_child(this._content);
        this._content.set_style(this._cardStyle(backgroundColor, cornerRadius) + `padding: ${PADDING}px;`);

        const row = new St.BoxLayout({vertical: false, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._content.set_child(row);

        this._volumeIcon = new St.Icon({icon_name: 'audio-volume-high-symbolic', icon_size: ICON_SIZE});
        this._volumeButton = this._makeButton(this._volumeIcon, () => this._toggleVolume());
        row.add_child(this._volumeButton);

        row.add_child(new St.Widget({width: GAP, height: 1}));

        this._lightIcon = new St.Icon({icon_name: 'night-light-symbolic', icon_size: ICON_SIZE});
        this._lightButton = this._makeButton(this._lightIcon, () => this._toggleNightLight());
        row.add_child(this._lightButton);

        // Placeholder state ("off") until enable() reads the real thing.
        this._setButtonState(this._volumeButton, false);
        this._setButtonState(this._lightButton, false);

        return this._actor;
    }

    enable() {
        this._connectVolume();
        this._connectNightLight();
    }

    disable() {
        // Volume (Gvc) - disconnect signals; Gvc.MixerControl has no
        // documented explicit teardown call beyond dropping the
        // reference, unlike a Gio.DBusProxy - see this file's header note.
        if (this._mixerControl) {
            try {
                if (this._mixerStateId !== null)
                    this._mixerControl.disconnect(this._mixerStateId);
                if (this._defaultSinkChangedId !== null)
                    this._mixerControl.disconnect(this._defaultSinkChangedId);
            } catch (e) {
                // control may already be in a torn-down state.
            }
        }
        if (this._defaultSink && this._sinkMutedId !== null) {
            try {
                this._defaultSink.disconnect(this._sinkMutedId);
            } catch (e) {
                // stream may already be gone.
            }
        }
        this._mixerStateId = null;
        this._defaultSinkChangedId = null;
        this._sinkMutedId = null;
        this._defaultSink = null;
        this._mixerControl = null;

        // Night Light (GSettings).
        if (this._colorSettings && this._colorSignalId !== null) {
            try {
                this._colorSettings.disconnect(this._colorSignalId);
            } catch (e) {
                // settings object may already be gone.
            }
        }
        this._colorSignalId = null;
        this._colorSettings = null;
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            backgroundColor: '#000000a9',
            cornerRadius: 18,
            baseColor: '#9a9996',
            highlightColor: '#3584e4',
        };
    }

    onSettingsChanged() {
        this._baseColor = this._settings.baseColor ?? '#9a9996';
        this._highlightColor = this._settings.highlightColor ?? '#3584e4';
        const backgroundColor = this._settings.backgroundColor ?? '#000000a9';
        const cornerRadius = this._settings.cornerRadius ?? 18;
        if (this._content)
            this._content.set_style(this._cardStyle(backgroundColor, cornerRadius) + `padding: ${PADDING}px;`);

        // Re-paint both buttons at their current on/off state with the
        // (possibly changed) base/highlight colors.
        this._refreshVolumeState();
        this._refreshNightLightState();
    }

    // ---- Volume (Gvc) -------------------------------------------------------

    /** @private */
    _connectVolume() {
        try {
            this._mixerControl = new Gvc.MixerControl({name: 'GNOME Widget Center — Switches'});
            this._mixerStateId = this._mixerControl.connect('state-changed', (control, state) => {
                if (state === Gvc.MixerControlState.READY)
                    this._onDefaultSinkChanged();
            });
            this._defaultSinkChangedId = this._mixerControl.connect('default-sink-changed', () => this._onDefaultSinkChanged());
            this._mixerControl.open();
        } catch (e) {
            this._api.logger.error(`switches: volume control unavailable: ${e}`);
            this._mixerControl = null;
        }
    }

    /** @private */
    _onDefaultSinkChanged() {
        if (!this._mixerControl)
            return;
        if (this._defaultSink && this._sinkMutedId !== null) {
            try {
                this._defaultSink.disconnect(this._sinkMutedId);
            } catch (e) {
                // previous stream may already be gone.
            }
            this._sinkMutedId = null;
        }
        const sink = this._mixerControl.get_default_sink();
        this._defaultSink = sink ?? null;
        if (this._defaultSink) {
            this._sinkMutedId = this._defaultSink.connect('notify::is-muted', () => this._refreshVolumeState());
        }
        this._refreshVolumeState();
    }

    /** @private */
    _refreshVolumeState() {
        if (!this._volumeIcon || !this._volumeButton)
            return;
        const muted = this._defaultSink ? this._defaultSink.is_muted : true;
        this._volumeIcon.icon_name = muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
        this._setButtonState(this._volumeButton, !muted);
    }

    /** @private */
    _toggleVolume() {
        if (!this._defaultSink) {
            this._api.logger.info('switches: volume toggle requested but no default sink is available yet');
            return;
        }
        this._defaultSink.change_is_muted(!this._defaultSink.is_muted);
    }

    // ---- Night Light (GSettings) --------------------------------------------

    /** @private */
    _connectNightLight() {
        try {
            this._colorSettings = new Gio.Settings({schema_id: COLOR_SCHEMA});
            this._colorSignalId = this._colorSettings.connect('changed::night-light-enabled', () => this._refreshNightLightState());
            this._refreshNightLightState();
        } catch (e) {
            this._api.logger.error(`switches: ${COLOR_SCHEMA} unavailable: ${e}`);
            this._colorSettings = null;
        }
    }

    /** @private */
    _refreshNightLightState() {
        if (!this._lightButton)
            return;
        const enabled = this._colorSettings ? this._colorSettings.get_boolean('night-light-enabled') : false;
        this._setButtonState(this._lightButton, enabled);
    }

    /** @private */
    _toggleNightLight() {
        if (!this._colorSettings) {
            this._api.logger.error(`switches: Night Light toggle requested but ${COLOR_SCHEMA} is unavailable`);
            return;
        }
        const enabled = this._colorSettings.get_boolean('night-light-enabled');
        this._colorSettings.set_boolean('night-light-enabled', !enabled);
    }

    // ---- Shared helpers -------------------------------------------------------

    /** @private one tall pill-shaped toggle button. Background fill is
     * set by _setButtonState() (depends on on/off state, not known yet
     * at construction). */
    _makeButton(icon, onClicked) {
        const button = new St.Button({
            style_class: 'switches-widget-button',
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.set_size(BUTTON_WIDTH, BUTTON_HEIGHT);
        button.connect('clicked', onClicked);
        return button;
    }

    /** @private the icon glyph itself always stays white (same
     * convention as widgets/settings-control) - it's the button's own
     * background that switches between base color (off) and highlight
     * color (on). */
    _setButtonState(button, isOn) {
        const child = button.get_child();
        if (child)
            child.set_style('color: #ffffff;');
        const hex = isOn ? this._highlightColor : this._baseColor;
        const {r, g, b, a} = _hexToRgba(hex);
        button.set_style(`background-color: rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a}); border-radius: ${BUTTON_WIDTH / 2}px;`);
    }

    /** @private builds the card's inline style string (same hex-alpha
     * rationale as widgets/settings-control/widget.js's identical
     * helper). */
    _cardStyle(hexColor, cornerRadius) {
        const {r, g, b, a} = _hexToRgba(hexColor);
        return `background-color: rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a}); border-radius: ${cornerRadius}px; ` +
            _shadowBoxShadowCss(this._settings);
    }
}
