import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Cairo from "cairo";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

const RING_SIZE = 118;

const BUTTON_SIZE = 32;

// Phase ids, in the order a work session moves through them.
const PHASE_WORK = "work";

const PHASE_SHORT_BREAK = "short";

const PHASE_LONG_BREAK = "long";

function _nowEpoch() {
    return Math.floor(GLib.get_real_time() / 1e6);
}

function _formatClock(totalSeconds) {
    const clamped = Math.max(0, Math.round(totalSeconds));
    const minutes = Math.floor(clamped / 60);
    const seconds = clamped % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default class PomodoroTimerWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "pomodoro-timer-root"
        });
        this._actor = this._layers.root;
        const outerBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        outerBox.set_style("padding: 10px; spacing: 6px;");
        this._layers.content.add_child(outerBox);
        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: RING_SIZE,
            height: RING_SIZE,
            x_align: Clutter.ActorAlign.CENTER
        });
        outerBox.add_child(this._stack);
        this._ringArea = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE
        });
        this._stack.add_child(this._ringArea);
        this._repaintId = this._ringArea.connect("repaint", () => this._onRepaint());
        this._textBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        this._timeLabel = new St.Label({
            text: "25:00",
            x_align: Clutter.ActorAlign.CENTER
        });
        this._phaseLabel = new St.Label({
            text: "WORK",
            x_align: Clutter.ActorAlign.CENTER
        });
        this._textBox.add_child(this._timeLabel);
        this._textBox.add_child(this._phaseLabel);
        this._stack.add_child(this._textBox);
        this._controlButton = new St.Button({
            style_class: "pomodoro-timer-button",
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: "media-playback-start-symbolic",
                icon_size: 14
            })
        });
        this._controlButton.connect("clicked", () => this._onToggleClicked());
        outerBox.add_child(this._controlButton);
        this._normalizeState();
        this._render();
        return this._actor;
    }
    enable() {
        if (this._settings.pomodoroRunning) this._startTicker();
        this._render();
    }
    disable() {
        this._stopTicker();
        if (this._repaintId !== null && this._ringArea) {
            this._ringArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS
        };
    }
    onSettingsChanged() {
        this._render();
    }
    // --- state helpers -----------------------------------------------
    _normalizeState() {
        if (!this._settings.pomodoroPhase) this._settings.pomodoroPhase = PHASE_WORK;
        if (typeof this._settings.pomodoroRunning !== "boolean") this._settings.pomodoroRunning = false;
        if (!Number.isFinite(this._settings.pomodoroCompletedWork)) this._settings.pomodoroCompletedWork = 0;
        if (!Number.isFinite(this._settings.pomodoroRemainingSeconds)) {
            this._settings.pomodoroRemainingSeconds = this._durationForPhase(this._settings.pomodoroPhase);
        }
        // If the widget was running and the shell was asleep/restarted long
        // enough for the phase to already be over, resolve that one
        // transition now (rather than looping through every phase that
        // might have elapsed while nothing was watching).
        if (this._settings.pomodoroRunning && Number.isFinite(this._settings.pomodoroPhaseEndEpoch)) {
            if (this._computeRemaining() <= 0) this._advancePhase();
        }
    }
    _durationForPhase(phase) {
        const minutes = phase === PHASE_WORK ? this._settings.workMinutes ?? 25 : phase === PHASE_SHORT_BREAK ? this._settings.shortBreakMinutes ?? 5 : this._settings.longBreakMinutes ?? 15;
        return Math.max(1, Math.round(minutes)) * 60;
    }
    _computeRemaining() {
        if (this._settings.pomodoroRunning && Number.isFinite(this._settings.pomodoroPhaseEndEpoch)) {
            return Math.max(0, this._settings.pomodoroPhaseEndEpoch - _nowEpoch());
        }
        return Math.max(0, this._settings.pomodoroRemainingSeconds ?? this._durationForPhase(this._settings.pomodoroPhase));
    }
    _startTicker() {
        this._stopTicker();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._computeRemaining() <= 0) this._advancePhase(); else this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopTicker() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    _onToggleClicked() {
        if (this._settings.pomodoroRunning) {
            this._settings.pomodoroRemainingSeconds = this._computeRemaining();
            this._settings.pomodoroRunning = false;
            this._settings.pomodoroPhaseEndEpoch = null;
            this._stopTicker();
        } else {
            const remaining = Math.max(1, this._computeRemaining());
            this._settings.pomodoroPhaseEndEpoch = _nowEpoch() + remaining;
            this._settings.pomodoroRunning = true;
            this._startTicker();
        }
        this._render();
    }
    _advancePhase() {
        const currentPhase = this._settings.pomodoroPhase ?? PHASE_WORK;
        let nextPhase;
        if (currentPhase === PHASE_WORK) {
            const completed = (this._settings.pomodoroCompletedWork ?? 0) + 1;
            this._settings.pomodoroCompletedWork = completed;
            const everyN = Math.max(2, Math.round(this._settings.sessionsBeforeLongBreak ?? 4));
            nextPhase = completed % everyN === 0 ? PHASE_LONG_BREAK : PHASE_SHORT_BREAK;
        } else {
            nextPhase = PHASE_WORK;
        }
        this._settings.pomodoroPhase = nextPhase;
        const duration = this._durationForPhase(nextPhase);
        const autoStart = this._settings.autoStartNextPhase ?? true;
        this._settings.pomodoroRemainingSeconds = duration;
        if (autoStart) {
            this._settings.pomodoroPhaseEndEpoch = _nowEpoch() + duration;
            this._settings.pomodoroRunning = true;
            this._startTicker();
        } else {
            this._settings.pomodoroPhaseEndEpoch = null;
            this._settings.pomodoroRunning = false;
            this._stopTicker();
        }
        if (this._settings.notifyOnPhaseEnd ?? true) this._notifyPhase(nextPhase);
        this._render();
    }
    _notifyPhase(nextPhase) {
        try {
            const label = nextPhase === PHASE_WORK ? this._settings.phaseLabelWork ?? "WORK" : nextPhase === PHASE_SHORT_BREAK ? this._settings.phaseLabelShortBreak ?? "SHORT BREAK" : this._settings.phaseLabelLongBreak ?? "LONG BREAK";
            Main.notify?.("Pomodoro Timer", `Time for: ${label}`);
        } catch (e) {
            this._api.logger.warn?.(`pomodoro-timer: notification failed: ${e.message}`);
        }
    }
    _phaseLabelText() {
        const phase = this._settings.pomodoroPhase ?? PHASE_WORK;
        if (phase === PHASE_WORK) return this._settings.phaseLabelWork ?? "WORK";
        if (phase === PHASE_SHORT_BREAK) return this._settings.phaseLabelShortBreak ?? "SHORT BREAK";
        return this._settings.phaseLabelLongBreak ?? "LONG BREAK";
    }
    // Returns a raw "#RRGGBBAA" hex string (for Cairo drawing via
    // _hexToRgba) - NOT a CSS color. Callers that need a CSS string should
    // wrap the result with _toCssColor(...) themselves.
    _currentRingColorHex() {
        const phase = this._settings.pomodoroPhase ?? PHASE_WORK;
        if (!(this._settings.colorByProgress ?? true)) {
            const value = phase === PHASE_WORK ? this._settings.workFixedColor : this._settings.breakFixedColor;
            return typeof value === "string" && value ? value : phase === PHASE_WORK ? "#E01B24FF" : "#33D17AFF";
        }
        const total = this._durationForPhase(phase);
        const fraction = total > 0 ? this._computeRemaining() / total : 0;
        const percent = fraction * 100;
        const pick = (value, fallback) => typeof value === "string" && value ? value : fallback;
        if (percent <= 20) return pick(this._settings.ringColorLow, "#E01B24FF");
        if (percent < 50) return pick(this._settings.ringColorMid, "#F5C211FF");
        return pick(this._settings.ringColorHigh, "#33D17AFF");
    }
    // --- rendering ------------------------------------------------------
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#232838F5",
            cornerRadiusFallback: 18
        }, false);
        if (this._timeLabel) {
            const font = _parseFontDescription(this._settings.timeFont ?? "Sans Bold 24", "Sans Bold", 24);
            const timeColor = _toCssColor(this._settings.timeColor, "#FFFFFFFF");
            this._timeLabel.set_text(_formatClock(this._computeRemaining()));
            this._timeLabel.set_style(`color: ${timeColor}; font-family: ${font.family}; font-size: ${font.size}px; font-weight: bold; text-align: center;`);
        }
        if (this._phaseLabel) {
            this._phaseLabel.visible = this._settings.showPhaseLabel ?? true;
            const font = _parseFontDescription(this._settings.phaseLabelFont ?? "Sans Bold 9", "Sans Bold", 9);
            const labelColor = _toCssColor(this._settings.phaseLabelColor, "#FFFFFFB3");
            this._phaseLabel.set_text(this._phaseLabelText());
            this._phaseLabel.set_style(`color: ${labelColor}; font-family: ${font.family}; font-size: ${font.size}px; letter-spacing: 1px; text-align: center;`);
        }
        if (this._controlButton) {
            this._controlButton.visible = this._settings.showControlButton ?? true;
            const buttonColor = _toCssColor(this._settings.buttonColor, "#FFFFFF1A");
            const borderColor = _toCssColor(this._settings.buttonBorderColor, "#FFFFFF59");
            this._controlButton.set_style(`background-color: ${buttonColor}; border: 1px solid ${borderColor}; border-radius: ${BUTTON_SIZE}px;`);
            const iconColor = _toCssColor(this._settings.buttonIconColor, "#FFFFFFFF");
            const icon = this._controlButton.child;
            if (icon) {
                icon.icon_name = this._settings.pomodoroRunning ? "media-playback-pause-symbolic" : "media-playback-start-symbolic";
                icon.set_style(`color: ${iconColor};`);
            }
        }
        if (this._ringArea) this._ringArea.queue_repaint();
    }
    _onRepaint() {
        const cr = this._ringArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? "#FFFFFF26");
        const ringColor = _hexToRgba(this._currentRingColorHex());
        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - thickness) / 2 - 2;
        const startAngle = -Math.PI / 2;
        const phase = this._settings.pomodoroPhase ?? PHASE_WORK;
        const total = this._durationForPhase(phase);
        const fraction = Math.max(0, Math.min(1, total > 0 ? this._computeRemaining() / total : 0));
        const endAngle = startAngle + fraction * 2 * Math.PI;
        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();
        if (fraction > 0) {
            cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();
        }
        cr.$dispose();
    }
}
