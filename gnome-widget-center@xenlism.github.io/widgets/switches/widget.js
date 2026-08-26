import St from "gi://St";

import Clutter from "gi://Clutter";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import Gvc from "gi://Gvc";

import Cairo from "cairo";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, BORDER_DEFAULTS, OPACITY_DEFAULTS, BLUR_DEFAULTS, deferUntilMapped as _deferUntilMapped } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const BUTTON_WIDTH = 64;

const BUTTON_HEIGHT = 140;

const GAP = 12;

const PADDING = 14;

const ICON_SIZE = 22;

const ICON_HIT_HEIGHT = 34;

const DRAG_THRESHOLD = 4;

const BRIGHTNESS_BUS_NAME = "org.gnome.SettingsDaemon.Power";

const BRIGHTNESS_OBJECT_PATH = "/org/gnome/SettingsDaemon/Power";

const BRIGHTNESS_IFACE = "org.gnome.SettingsDaemon.Power.Screen";

class DragPill {
    constructor({iconName: iconName, hasIconToggle: hasIconToggle, onSetFraction: onSetFraction, onIconClicked: onIconClicked}) {
        this.fraction = 0;
        this._hasIconToggle = !!hasIconToggle;
        this._onSetFraction = onSetFraction;
        this._onIconClicked = onIconClicked ?? null;
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: BUTTON_WIDTH,
            height: BUTTON_HEIGHT,
            reactive: true,
            track_hover: true,
            can_focus: true
        });
        this.area = new St.DrawingArea({
            width: BUTTON_WIDTH,
            height: BUTTON_HEIGHT
        });
        this.actor.add_child(this.area);
        this.area.connect("repaint", () => this._onRepaint());
        this.icon = new St.Icon({
            icon_name: iconName,
            icon_size: ICON_SIZE,
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START
        });
        this.icon.set_style("color: #ffffff; margin-top: 10px;");
        this.actor.add_child(this.icon);
        this._baseColor = "#9a9996";
        this._highlightColor = "#3584e4";
        this._dragging = false;
        this._pressWasIcon = false;
        this._dragMoved = false;
        this._pressStageX = 0;
        this._pressStageY = 0;
        this._stageMotionId = null;
        this._stageReleaseId = null;
        this.actor.connect("button-press-event", (actor, event) => this._onPress(event));
        this.actor.connect("destroy", () => this._disconnectStage());
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
    get isDragging() {
        return this._dragging;
    }
    _onPress(event) {
        const [stageX, stageY] = event.get_coords();
        this._pressStageX = stageX;
        this._pressStageY = stageY;
        this._dragMoved = false;
        const [, , localY] = this.actor.transform_stage_point(stageX, stageY);
        this._pressWasIcon = this._hasIconToggle && localY <= ICON_HIT_HEIGHT;
        if (!this._pressWasIcon) this._applyLocalY(localY);
        this._dragging = true;
        this._stageMotionId = global.stage.connect("motion-event", (stage, ev) => this._onStageMotion(ev));
        this._stageReleaseId = global.stage.connect("button-release-event", (stage, ev) => this._onStageRelease(ev));
        return Clutter.EVENT_STOP;
    }
    _onStageMotion(event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;
        const [stageX, stageY] = event.get_coords();
        if (!this._dragMoved) {
            const movedPx = Math.hypot(stageX - this._pressStageX, stageY - this._pressStageY);
            if (movedPx > DRAG_THRESHOLD) this._dragMoved = true;
        }
        if (this._dragMoved) {
            const [, , localY] = this.actor.transform_stage_point(stageX, stageY);
            this._applyLocalY(localY);
        }
        return Clutter.EVENT_STOP;
    }
    _onStageRelease(event) {
        this._disconnectStage();
        this._dragging = false;
        if (!this._dragMoved && this._pressWasIcon && this._onIconClicked) this._onIconClicked();
        return Clutter.EVENT_STOP;
    }
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
    _applyLocalY(localY) {
        const clampedY = Math.max(0, Math.min(BUTTON_HEIGHT, localY));
        const fraction = 1 - clampedY / BUTTON_HEIGHT;
        this.setFraction(fraction);
        if (this._onSetFraction) this._onSetFraction(this.fraction);
    }
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
        if (fillHeight > .5) {
            const highlight = _hexToRgba(this._highlightColor);
            cr.setSourceRGBA(highlight.r, highlight.g, highlight.b, highlight.a);
            cr.rectangle(0, h - fillHeight, w, fillHeight);
            cr.fill();
        }
        cr.resetClip();
        cr.$dispose();
    }
    _pillPath(cr, w, h, radius) {
        cr.newPath();
        cr.arc(radius, radius, radius, Math.PI, 2 * Math.PI);
        cr.arc(w - radius, h - radius, radius, 0, Math.PI);
        cr.closePath();
    }
}

export default class SwitchesWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._volumePill = null;
        this._lightPill = null;
        this._mixerControl = null;
        this._mixerStateId = null;
        this._defaultSinkChangedId = null;
        this._defaultSink = null;
        this._sinkNotifyId = null;
        this._brightnessProxy = null;
        this._brightnessSignalId = null;
        this._brightnessScale = null;
        this._brightnessScaleSignalId = null;
        this._timerId = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "switches-widget-content",
        });
        this._actor = this._layers.root;
        // this._content is a plain wrapper - the Content Layer itself
        // (this._layers.content) carries no style of its own (Rule 5).
        this._content = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._layers.content.add_child(this._content);
        _deferUntilMapped(this._actor, () => {
            applyLayeredCardStyle(this._layers, this._settings, {
                backgroundColorFallback: "#FFFFFF00",
                cornerRadiusFallback: 18
            });
            this._content.set_style(`padding: ${PADDING}px;`);
        });
        const row = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._content.set_child(row);
        this._volumePill = new DragPill({
            iconName: "audio-volume-high-symbolic",
            hasIconToggle: true,
            onSetFraction: fraction => this._applyVolumeFraction(fraction),
            onIconClicked: () => this._toggleMute()
        });
        row.add_child(this._volumePill.actor);
        row.add_child(new St.Widget({
            width: GAP,
            height: 1
        }));
        this._lightPill = new DragPill({
            iconName: "display-brightness-symbolic",
            hasIconToggle: false,
            onSetFraction: fraction => this._applyBrightnessFraction(fraction)
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
        if (this._mixerControl) {
            try {
                if (this._mixerStateId !== null) this._mixerControl.disconnect(this._mixerStateId);
                if (this._defaultSinkChangedId !== null) this._mixerControl.disconnect(this._defaultSinkChangedId);
            } catch (e) {}
        }
        if (this._defaultSink && this._sinkNotifyId !== null) {
            try {
                this._defaultSink.disconnect(this._sinkNotifyId);
            } catch (e) {}
        }
        this._mixerStateId = null;
        this._defaultSinkChangedId = null;
        this._sinkNotifyId = null;
        this._defaultSink = null;
        this._mixerControl = null;
        if (this._brightnessProxy && this._brightnessSignalId !== null) {
            try {
                this._brightnessProxy.disconnect(this._brightnessSignalId);
            } catch (e) {}
        }
        this._brightnessProxy = null;
        this._brightnessSignalId = null;
        if (this._brightnessScale && this._brightnessScaleSignalId !== null) {
            try {
                this._brightnessScale.disconnect(this._brightnessScaleSignalId);
            } catch (e) {}
        }
        this._brightnessScale = null;
        this._brightnessScaleSignalId = null;
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
    onSettingsChanged() {
        if (this._layers?.card) applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFF00",
            cornerRadiusFallback: 18
        });
        this._applyColors();
        this._startTimer();
    }
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 3);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refreshVolumeState();
            this._refreshBrightnessState();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    _applyColors() {
        const baseColor = this._settings?.baseColor ?? "#9a9996";
        const highlightColor = this._settings?.highlightColor ?? "#3584e4";
        this._volumePill?.setColors(baseColor, highlightColor);
        this._lightPill?.setColors(baseColor, highlightColor);
    }
    _connectVolume() {
        try {
            this._mixerControl = new Gvc.MixerControl({
                name: "GNOME Widget Center — Switches"
            });
            this._mixerStateId = this._mixerControl.connect("state-changed", (control, state) => {
                if (state === Gvc.MixerControlState.READY) this._onDefaultSinkChanged();
            });
            this._defaultSinkChangedId = this._mixerControl.connect("default-sink-changed", () => this._onDefaultSinkChanged());
            this._mixerControl.open();
        } catch (e) {
            this._api.logger.error(`switches: volume control unavailable: ${e}`);
            this._mixerControl = null;
        }
    }
    _onDefaultSinkChanged() {
        if (!this._mixerControl) return;
        if (this._defaultSink && this._sinkNotifyId !== null) {
            try {
                this._defaultSink.disconnect(this._sinkNotifyId);
            } catch (e) {}
            this._sinkNotifyId = null;
        }
        const sink = this._mixerControl.get_default_sink();
        this._defaultSink = sink ?? null;
        if (this._defaultSink) {
            this._sinkNotifyId = this._defaultSink.connect("notify", () => this._refreshVolumeState());
        }
        this._refreshVolumeState();
    }
    _refreshVolumeState() {
        if (!this._volumePill || this._volumePill.isDragging) return;
        if (!this._defaultSink || !this._mixerControl) {
            this._volumePill.icon.icon_name = "audio-volume-muted-symbolic";
            this._volumePill.setFraction(0);
            return;
        }
        const muted = this._defaultSink.is_muted;
        const maxVol = this._mixerControl.get_vol_max_norm();
        const fraction = muted || maxVol <= 0 ? 0 : this._defaultSink.volume / maxVol;
        this._volumePill.icon.icon_name = muted || fraction <= .001 ? "audio-volume-muted-symbolic" : fraction < .5 ? "audio-volume-medium-symbolic" : "audio-volume-high-symbolic";
        this._volumePill.setFraction(fraction);
    }
    _applyVolumeFraction(fraction) {
        if (!this._defaultSink || !this._mixerControl) return;
        const maxVol = this._mixerControl.get_vol_max_norm();
        this._defaultSink.volume = Math.round(fraction * maxVol);
        this._defaultSink.push_volume();
        if (fraction <= .001) {
            if (!this._defaultSink.is_muted) this._defaultSink.change_is_muted(true);
        } else if (this._defaultSink.is_muted) {
            this._defaultSink.change_is_muted(false);
        }
    }
    _toggleMute() {
        if (!this._defaultSink) return;
        this._defaultSink.change_is_muted(!this._defaultSink.is_muted);
    }
    /** @private Prefers GNOME Shell's own Main.brightnessManager (the same
     * BrightnessScale machinery the hardware brightness keys use), since it
     * covers external/DisplayPort/HDMI monitor backlights too. Falls back
     * to the org.gnome.SettingsDaemon.Power.Screen DBus proxy (built-in
     * panel only) when brightnessManager isn't available - older GNOME
     * versions, or a session type where it never got instantiated. */
    _connectBrightness() {
        const globalScale = Main.brightnessManager?.scales?.find(s => !s.monitor);
        if (globalScale) {
            this._brightnessScale = globalScale;
            try {
                this._brightnessScaleSignalId = globalScale.connect("notify::value", () => this._refreshBrightnessState());
            } catch (e) {
                this._api.logger.error(`switches: could not watch brightness scale: ${e}`);
                this._brightnessScaleSignalId = null;
            }
            this._refreshBrightnessState();
            return;
        }
        try {
            this._brightnessProxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, BRIGHTNESS_BUS_NAME, BRIGHTNESS_OBJECT_PATH, BRIGHTNESS_IFACE, null);
            this._brightnessSignalId = this._brightnessProxy.connect("g-properties-changed", () => this._refreshBrightnessState());
        } catch (e) {
            this._api.logger.error(`switches: ${BRIGHTNESS_BUS_NAME} unavailable: ${e}`);
            this._brightnessProxy = null;
        }
        this._refreshBrightnessState();
    }
    _refreshBrightnessState() {
        if (!this._lightPill || this._lightPill.isDragging) return;
        if (this._brightnessScale) {
            this._lightPill.setFraction(this._brightnessScale.value ?? 0);
            return;
        }
        const percent = this._brightnessProxy?.get_cached_property("Brightness")?.unpack() ?? -1;
        if (percent < 0) {
            this._lightPill.setFraction(0);
            return;
        }
        this._lightPill.setFraction(percent / 100);
    }
    _applyBrightnessFraction(fraction) {
        if (this._brightnessScale) {
            try {
                this._brightnessScale.value = Math.max(0, Math.min(1, fraction));
            } catch (e) {
                this._api.logger.error(`switches: failed to set brightness scale: ${e}`);
            }
            return;
        }
        if (!this._brightnessProxy) {
            // The proxy can fail to connect once (e.g. gsd-power isn't up
            // yet right after login) and, without this, would stay null
            // for the widget's whole lifetime - silently doing nothing on
            // every future drag with no way to recover except toggling
            // the widget off/on. Retry lazily here instead.
            this._connectBrightness();
            if (!this._brightnessProxy) return;
        }
        const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
        try {
            Gio.DBus.session.call_sync(BRIGHTNESS_BUS_NAME, BRIGHTNESS_OBJECT_PATH, "org.freedesktop.DBus.Properties", "Set", new GLib.Variant("(ssv)", [ BRIGHTNESS_IFACE, "Brightness", new GLib.Variant("i", percent) ]), null, Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            this._api.logger.error(`switches: failed to set brightness: ${e}`);
        }
    }
}