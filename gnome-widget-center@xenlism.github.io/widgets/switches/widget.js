// widgets/switches/widget.js
//
// 1x1 card: two tall pill-shaped VERTICAL DRAG SLIDERS side by side -
// "Volume" (drag to set the default audio output's volume; a discrete
// click on the icon at the top instead mutes/unmutes) and "Light"
// (drag to set screen brightness) - per the mockup + follow-up
// clarifications this was built from. This replaces an earlier
// toggle-button version of this same widget id ("switches"); if you
// still have that one installed, this widget.js/config.json pair
// simply overwrites it in place.
//
// Same root/content split as widgets/settings-control/widget.js (a
// plain St.Widget root + an St.Bin content bound to it via
// Clutter.BindConstraint, since lib/blockSizeManager.js's
// applyBlockSize() force-sets the root actor's size from metadata.json's
// block-type after buildActor() returns).
//
// Drag implementation: each pill is one reactive St.Widget. On
// `button-press-event` it temporarily connects to `global.stage`'s own
// `motion-event`/`button-release-event` for the duration of the drag -
// the standard trick for a custom Clutter drag control, since it keeps
// receiving move events even if the pointer strays outside the pill's
// own (fairly small) bounds mid-drag, then disconnects on release. This
// part has NOT been exercised on a live gnome-shell process - if
// dragging feels "sticky" or stops working when the pointer leaves the
// pill, this is the first place to check (see _beginDrag()/_onStageMotion()
// below).
//
// State sources:
//
//   - Volume  -> Gvc.MixerControl, same as the previous version of this
//     widget - see that rationale below in _connectVolume(). Setting the
//     level uses `stream.volume = fraction * control.get_vol_max_norm()`
//     followed by `stream.push_volume()`, mirroring GNOME Shell's own
//     volume slider (js/ui/status/volume.js), plus auto-mute at the
//     bottom of the drag / auto-unmute above it.
//   - Brightness -> org.gnome.SettingsDaemon.Power's Screen interface
//     (session bus), the same service GNOME's own brightness slider and
//     the Fn-key OSD use. Reading + subscribing uses a plain
//     Gio.DBusProxy; SETTING a remote property has to go through
//     org.freedesktop.DBus.Properties.Set explicitly (GDBusProxy has no
//     "just assign the property" shortcut in GJS), done here via
//     Gio.DBus.session.call_sync() directly. **This Brightness path is
//     the least-verified part of this widget** - the schema/property
//     names are right for a stock GNOME session, but org.gnome.SettingsDaemon.Power
//     not being present at all (non-GNOME session, or gnome-settings-daemon
//     not running) is handled defensively: the slider drags freely and
//     just silently doesn't reach anything.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Cairo from 'cairo';
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba} from '../../lib/widgetVisualKit.js';

const BUTTON_WIDTH = 64;
const BUTTON_HEIGHT = 140;
const GAP = 12;
const PADDING = 14;
const ICON_SIZE = 22;
const ICON_HIT_HEIGHT = 34; // top zone that counts as "clicked the icon" for the volume pill's mute toggle
const DRAG_THRESHOLD = 4; // px of stage movement before a press counts as a drag rather than a click

const BRIGHTNESS_BUS_NAME = 'org.gnome.SettingsDaemon.Power';
const BRIGHTNESS_OBJECT_PATH = '/org/gnome/SettingsDaemon/Power';
const BRIGHTNESS_IFACE = 'org.gnome.SettingsDaemon.Power.Screen';

/** One vertical drag-pill: background/fill painted in a DrawingArea,
 * an icon overlaid near the top, and stage-grab-based drag handling.
 * `onSetFraction(fraction)` is called continuously while dragging (and
 * once on a plain click-to-set); `onIconClicked()` (optional) fires
 * only for a non-dragged click that landed in the top ICON_HIT_HEIGHT
 * band. Purely a UI building block - knows nothing about volume or
 * brightness itself. */
class DragPill {
    constructor({iconName, hasIconToggle, onSetFraction, onIconClicked}) {
        this.fraction = 0;
        this._hasIconToggle = !!hasIconToggle;
        this._onSetFraction = onSetFraction;
        this._onIconClicked = onIconClicked ?? null;

        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: BUTTON_WIDTH,
            height: BUTTON_HEIGHT,
            reactive: true,
            track_hover: true,
            can_focus: true,
        });

        this.area = new St.DrawingArea({width: BUTTON_WIDTH, height: BUTTON_HEIGHT});
        this.actor.add_child(this.area);
        this.area.connect('repaint', () => this._onRepaint());

        this.icon = new St.Icon({
            icon_name: iconName,
            icon_size: ICON_SIZE,
            reactive: false, // let press/motion/release fall through to `actor` beneath it
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this.icon.set_style('color: #ffffff; margin-top: 10px;');
        this.actor.add_child(this.icon);

        this._baseColor = '#9a9996';
        this._highlightColor = '#3584e4';

        this._dragging = false;
        this._pressWasIcon = false;
        this._dragMoved = false;
        this._pressStageX = 0;
        this._pressStageY = 0;
        this._stageMotionId = null;
        this._stageReleaseId = null;

        this.actor.connect('button-press-event', (actor, event) => this._onPress(event));
        this.actor.connect('destroy', () => this._disconnectStage());
    }

    setColors(baseColor, highlightColor) {
        this._baseColor = baseColor;
        this._highlightColor = highlightColor;
        this.area.queue_repaint();
    }

    setFraction(fraction) {
        this.fraction = Math.max(0, Math.min(1, fraction));
        this.area.queue_repaint();
    }

    /** True while the user currently has this pill grabbed - external
     * refreshes should skip setFraction() while this is true, or they'd
     * fight the user's own drag. */
    get isDragging() {
        return this._dragging;
    }

    /** @private */
    _onPress(event) {
        const [stageX, stageY] = event.get_coords();
        this._pressStageX = stageX;
        this._pressStageY = stageY;
        this._dragMoved = false;

        const [, , localY] = this.actor.transform_stage_point(stageX, stageY);
        this._pressWasIcon = this._hasIconToggle && localY <= ICON_HIT_HEIGHT;

        if (!this._pressWasIcon)
            this._applyLocalY(localY);

        this._dragging = true;
        this._stageMotionId = global.stage.connect('motion-event', (stage, ev) => this._onStageMotion(ev));
        this._stageReleaseId = global.stage.connect('button-release-event', (stage, ev) => this._onStageRelease(ev));
        return Clutter.EVENT_STOP;
    }

    /** @private */
    _onStageMotion(event) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        const [stageX, stageY] = event.get_coords();
        if (!this._dragMoved) {
            const movedPx = Math.hypot(stageX - this._pressStageX, stageY - this._pressStageY);
            if (movedPx > DRAG_THRESHOLD)
                this._dragMoved = true;
        }
        if (this._dragMoved) {
            const [, , localY] = this.actor.transform_stage_point(stageX, stageY);
            this._applyLocalY(localY);
        }
        return Clutter.EVENT_STOP;
    }

    /** @private */
    _onStageRelease(event) {
        this._disconnectStage();
        this._dragging = false;

        if (!this._dragMoved && this._pressWasIcon && this._onIconClicked)
            this._onIconClicked();

        return Clutter.EVENT_STOP;
    }

    /** @private */
    _disconnectStage() {
        if (this._stageMotionId !== null) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = null;
        }
        if (this._stageReleaseId !== null) {
            global.stage.disconnect(this._stageReleaseId);
            this._stageReleaseId = null;
        }
    }

    /** @private bottom of the pill = 0%, top = 100%. */
    _applyLocalY(localY) {
        const clampedY = Math.max(0, Math.min(BUTTON_HEIGHT, localY));
        const fraction = 1 - clampedY / BUTTON_HEIGHT;
        this.setFraction(fraction);
        if (this._onSetFraction)
            this._onSetFraction(this.fraction);
    }

    /** @private draws the pill: base color everywhere, then the
     * highlight color clipped to a rounded-pill path, filled from the
     * bottom up to the current fraction. */
    _onRepaint() {
        const cr = this.area.get_context();
        const w = BUTTON_WIDTH;
        const h = BUTTON_HEIGHT;
        const radius = w / 2;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        this._pillPath(cr, w, h, radius);
        cr.clip();

        const base = _hexToRgba(this._baseColor);
        cr.setSourceRGBA(base.r, base.g, base.b, base.a);
        cr.paint();

        const fillHeight = h * this.fraction;
        if (fillHeight > 0.5) {
            const highlight = _hexToRgba(this._highlightColor);
            cr.setSourceRGBA(highlight.r, highlight.g, highlight.b, highlight.a);
            cr.rectangle(0, h - fillHeight, w, fillHeight);
            cr.fill();
        }

        cr.resetClip();
        cr.$dispose();
    }

    /** @private traces a vertical pill (two semicircle caps + straight sides). */
    _pillPath(cr, w, h, radius) {
        cr.newPath();
        cr.arc(radius, radius, radius, Math.PI, 2 * Math.PI);
        cr.arc(w - radius, h - radius, radius, 0, Math.PI);
        cr.closePath();
    }
}

export default class SwitchesWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;

        this._volumePill = null;
        this._lightPill = null;

        // Volume (Gvc) bookkeeping.
        this._mixerControl = null;
        this._mixerStateId = null;
        this._defaultSinkChangedId = null;
        this._defaultSink = null;
        this._sinkNotifyId = null;

        // Brightness (GDBus) bookkeeping.
        this._brightnessProxy = null;
        this._brightnessSignalId = null;

        // Periodic backstop refresh (see this file's header/enable() for why).
        this._timerId = null;
    }

    // Must never throw. Builds both pills at 0% - enable() fills in the
    // real state right after this actor is placed in the Widget Layer.
    buildActor() {
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
        this._content.set_style(_cardStyleCss(this._settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18}) + `padding: ${PADDING}px;`);

        const row = new St.BoxLayout({vertical: false, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._content.set_child(row);

        this._volumePill = new DragPill({
            iconName: 'audio-volume-high-symbolic',
            hasIconToggle: true,
            onSetFraction: fraction => this._applyVolumeFraction(fraction),
            onIconClicked: () => this._toggleMute(),
        });
        row.add_child(this._volumePill.actor);

        row.add_child(new St.Widget({width: GAP, height: 1}));

        this._lightPill = new DragPill({
            iconName: 'display-brightness-symbolic',
            hasIconToggle: false,
            onSetFraction: fraction => this._applyBrightnessFraction(fraction),
        });
        row.add_child(this._lightPill.actor);

        this._applyColors();
        return this._actor;
    }

    enable() {
        this._connectVolume();
        this._connectBrightness();
        this._startTimer();
    }

    disable() {
        this._stopTimer();

        // Volume (Gvc) - disconnect signals; Gvc.MixerControl has no
        // documented explicit teardown call beyond dropping the
        // reference, unlike a Gio.DBusProxy.
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
        if (this._defaultSink && this._sinkNotifyId !== null) {
            try {
                this._defaultSink.disconnect(this._sinkNotifyId);
            } catch (e) {
                // stream may already be gone.
            }
        }
        this._mixerStateId = null;
        this._defaultSinkChangedId = null;
        this._sinkNotifyId = null;
        this._defaultSink = null;
        this._mixerControl = null;

        // Brightness (GDBus).
        if (this._brightnessProxy && this._brightnessSignalId !== null) {
            try {
                this._brightnessProxy.disconnect(this._brightnessSignalId);
            } catch (e) {
                // proxy may already be gone.
            }
        }
        this._brightnessProxy = null;
        this._brightnessSignalId = null;
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,
            baseColor: '#9a9996',
            highlightColor: '#3584e4',
            refreshRateSeconds: 3,
        };
    }

    onSettingsChanged() {
        if (this._content)
            this._content.set_style(_cardStyleCss(this._settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18}) + `padding: ${PADDING}px;`);
        this._applyColors();
        this._startTimer(); // picks up a changed refreshRateSeconds too
    }

    /** @private (re)starts the periodic backstop refresh that re-reads
     * both volume and brightness even if their change signals were
     * missed - e.g. a level changed from another app, hardware keys, a
     * different widget, or `pactl`/`brightnessctl` from a terminal,
     * while this widget was between signal deliveries. Requested
     * explicitly so the sliders stay in sync with changes made
     * elsewhere, on top of (not instead of) the existing
     * `notify`/`g-properties-changed` signal handling. */
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 3);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refreshVolumeState();
            this._refreshBrightnessState();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** @private */
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    /** @private pushes the current baseColor/highlightColor settings
     * into both pills. */
    _applyColors() {
        const baseColor = this._settings?.baseColor ?? '#9a9996';
        const highlightColor = this._settings?.highlightColor ?? '#3584e4';
        this._volumePill?.setColors(baseColor, highlightColor);
        this._lightPill?.setColors(baseColor, highlightColor);
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
        if (this._defaultSink && this._sinkNotifyId !== null) {
            try {
                this._defaultSink.disconnect(this._sinkNotifyId);
            } catch (e) {
                // previous stream may already be gone.
            }
            this._sinkNotifyId = null;
        }
        const sink = this._mixerControl.get_default_sink();
        this._defaultSink = sink ?? null;
        if (this._defaultSink) {
            // Both mute state and level can change externally (another
            // app, hardware keys, pactl, ...) - refresh on either.
            this._sinkNotifyId = this._defaultSink.connect('notify', () => this._refreshVolumeState());
        }
        this._refreshVolumeState();
    }

    /** @private skipped while the pill is being actively dragged, so
     * the periodic timer/external signals don't fight the user's own
     * in-progress gesture (see _startTimer()'s doc comment). */
    _refreshVolumeState() {
        if (!this._volumePill || this._volumePill.isDragging)
            return;
        if (!this._defaultSink || !this._mixerControl) {
            this._volumePill.icon.icon_name = 'audio-volume-muted-symbolic';
            this._volumePill.setFraction(0);
            return;
        }
        const muted = this._defaultSink.is_muted;
        const maxVol = this._mixerControl.get_vol_max_norm();
        const fraction = muted || maxVol <= 0 ? 0 : this._defaultSink.volume / maxVol;

        this._volumePill.icon.icon_name = muted || fraction <= 0.001
            ? 'audio-volume-muted-symbolic'
            : fraction < 0.5 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
        this._volumePill.setFraction(fraction);
    }

    /** @private called continuously while dragging the volume pill. */
    _applyVolumeFraction(fraction) {
        if (!this._defaultSink || !this._mixerControl)
            return;
        const maxVol = this._mixerControl.get_vol_max_norm();
        this._defaultSink.volume = Math.round(fraction * maxVol);
        this._defaultSink.push_volume();
        if (fraction <= 0.001) {
            if (!this._defaultSink.is_muted)
                this._defaultSink.change_is_muted(true);
        } else if (this._defaultSink.is_muted) {
            this._defaultSink.change_is_muted(false);
        }
    }

    /** @private a plain (non-dragged) click on the volume pill's icon. */
    _toggleMute() {
        if (!this._defaultSink)
            return;
        this._defaultSink.change_is_muted(!this._defaultSink.is_muted);
    }

    // ---- Brightness (GDBus) --------------------------------------------------

    /** @private */
    _connectBrightness() {
        try {
            this._brightnessProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                BRIGHTNESS_BUS_NAME, BRIGHTNESS_OBJECT_PATH, BRIGHTNESS_IFACE, null
            );
            this._brightnessSignalId = this._brightnessProxy.connect('g-properties-changed', () => this._refreshBrightnessState());
        } catch (e) {
            this._api.logger.error(`switches: ${BRIGHTNESS_BUS_NAME} unavailable: ${e}`);
            this._brightnessProxy = null;
        }
        this._refreshBrightnessState();
    }

    /** @private skipped while the pill is being actively dragged - see
     * _refreshVolumeState()'s identical guard. */
    _refreshBrightnessState() {
        if (!this._lightPill || this._lightPill.isDragging)
            return;
        const percent = this._brightnessProxy?.get_cached_property('Brightness')?.unpack() ?? -1;
        if (percent < 0) {
            // No brightness service (desktop, non-GNOME session, ...) -
            // leave the pill at 0% rather than guessing.
            this._lightPill.setFraction(0);
            return;
        }
        this._lightPill.setFraction(percent / 100);
    }

    /** @private called continuously while dragging the brightness pill.
     * Setting a remote DBus property has no GDBusProxy shortcut in GJS,
     * so this goes through org.freedesktop.DBus.Properties.Set directly
     * rather than through `this._brightnessProxy`. */
    _applyBrightnessFraction(fraction) {
        if (!this._brightnessProxy)
            return;
        const percent = Math.round(fraction * 100);
        try {
            Gio.DBus.session.call_sync(
                BRIGHTNESS_BUS_NAME, BRIGHTNESS_OBJECT_PATH,
                'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', [BRIGHTNESS_IFACE, 'Brightness', new GLib.Variant('i', percent)]),
                null, Gio.DBusCallFlags.NONE, -1, null
            );
        } catch (e) {
            this._api.logger.error(`switches: failed to set brightness: ${e}`);
        }
    }

}
