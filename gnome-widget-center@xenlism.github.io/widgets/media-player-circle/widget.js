// widgets/media-player-circle/widget.js
//
// 1x1 card: album cover centered inside a circular progress ring that
// tracks playback position, with Play/Previous/Next controls hidden
// until the pointer hovers the widget. Talks to whatever MPRIS2 player
// is running via lib/mediaApi.js's MprisMediaService (WIDGET_API.md
// §9.1) - signal-driven updates only, no DBus polling.
//
// The ring itself still updates smoothly between MPRIS signals: MPRIS's
// Position property does not emit PropertiesChanged as it counts up, so
// on every real state update (property change or Seeked signal) this
// widget records a local monotonic timestamp + position, and a plain
// 1s GLib.timeout_add_seconds() *redraws from that local extrapolation*
// while playing - it never re-queries DBus itself, so it stays within
// the "no polling" rule in WIDGET_API.md §9.1 (that rule is about not
// re-asking the service for state, not about local UI animation). The
// timer only runs while a player is attached and playing, and is fully
// torn down in disable() like every other timer/signal this widget owns.
//
// Cover click: raises the attached player if one exists, otherwise
// launches the app configured in config.json's desktopFilePath field
// (Gio.DesktopAppInfo, same pattern as widgets/clock-modern/widget.js's
// _launchApp()). The Play button falls back to the same launch behavior
// on its very first click when no player is attached yet.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';
import {MprisMediaService} from '../../lib/mediaApi.js';
// Standardized on lib/widgetVisualKit.js (2026-08-03) - see the identical
// note in media-player-square/widget.js for why this replaced a local
// per-file copy of these helpers.
import {
    SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor,
} from '../../lib/widgetVisualKit.js';

// 1x1 block-type is 176px, not 160px - see the identical note in
// media-player-square/widget.js. Scaled by 176/160 = 1.1.
const SIZE = 176;
const RING_SIZE = 163;
const RING_THICKNESS = 6;
const COVER_SIZE = 114;

/** @private splits a combined Pango font-description string into the
 * family/size pieces St's set_style() needs - see
 * widgets/clock-modern/widget.js's _parseFontDescription(). */
function _parseFontDescription(fontStr, fallbackFamily, fallbackSize) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr);
        const rawSize = desc.get_size();
        const size = rawSize > 0 ? Math.round(rawSize / Pango.SCALE) : fallbackSize;
        desc.unset_fields(Pango.FontMask.SIZE);
        const family = desc.to_string().trim();
        return {family: family || fallbackFamily, size};
    } catch (e) {
        return {family: fallbackFamily, size: fallbackSize};
    }
}

export default class MediaPlayerCircleWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._media = new MprisMediaService(api.logger);
        this._state = null;

        this._fraction = 0;
        this._baseMonotonicUs = 0;
        this._basePositionMs = 0;

        this._tickTimerId = null;
        this._ringRepaintId = null;
        this._hoverId = null;
    }

    buildActor() {
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: SIZE,
            height: SIZE,
            reactive: true,
            clip_to_allocation: true,
        });

        this._ringArea = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._actor.add_child(this._ringArea);
        this._ringRepaintId = this._ringArea.connect('repaint', () => this._onRingRepaint());

        // --- Cover, centered inside the ring ---
        this._coverStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: COVER_SIZE,
            height: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'background-color: rgba(255,255,255,0.06); border-radius: 999px;',
            clip_to_allocation: true,
        });
        this._actor.add_child(this._coverStack);

        this._fallbackArea = new St.DrawingArea({width: COVER_SIZE, height: COVER_SIZE});
        this._coverStack.add_child(this._fallbackArea);
        this._fallbackRepaintId = this._fallbackArea.connect('repaint', () => this._onFallbackRepaint());

        this._fallbackIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 40,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.9);',
        });
        this._coverStack.add_child(this._fallbackIcon);

        // Album art layer - painted via CSS background-image/cover
        // instead of St.Icon (see media-player-square's identical fix for
        // the full "why" comment). The border-radius here is set to
        // 999px (full round) since this widget's cover is circular - an
        // actor's own background is clipped to its own border-radius, so
        // this is what actually makes the art appear as a circle instead
        // of a square poking out past the round frame.
        this._artIcon = new St.Widget({
            width: COVER_SIZE,
            height: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `border-radius: 999px; background-size: cover; background-position: center;`,
            visible: false,
        });
        this._coverStack.add_child(this._artIcon);

        // --- Track info, overlaid near the bottom of the cover ---
        this._titleLabel = new St.Label({text: 'No media playing'});
        this._artistLabel = new St.Label({text: ''});
        for (const label of [this._titleLabel, this._artistLabel])
            label.clutter_text.set_ellipsize(3 /* Pango.EllipsizeMode.END */);

        this._textBox = new St.BoxLayout({
            vertical: true,
            width: SIZE - 24,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._textBox.set_style('padding-bottom: 14px;');
        this._textBox.add_child(this._titleLabel);
        this._textBox.add_child(this._artistLabel);
        this._actor.add_child(this._textBox);

        // --- Whole-widget click target for launch/focus ---
        this._coverButton = new St.Button({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            style: 'background-color: transparent;',
        });
        this._coverButton.connect('clicked', () => this._onCoverClicked());
        this._actor.add_child(this._coverButton);

        // --- Hover-revealed controls (on top of everything else) ---
        this._prevButton = this._makeButton('media-skip-backward-symbolic', () => this._media.previous());
        this._playPauseButton = this._makeButton('media-playback-start-symbolic', () => this._onPlayClicked());
        this._nextButton = this._makeButton('media-skip-forward-symbolic', () => this._media.next());

        this._controls = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._controls.set_style('spacing: 8px;');
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);
        this._actor.add_child(this._controls);

        // See media-player-square's identical comment: track_hover is the
        // robust way to do this with overlapping reactive children,
        // rather than hand-rolled enter/leave pairs.
        this._actor.set_track_hover(true);
        this._hoverId = this._actor.connect('notify::hover', () => {
            this._controls.visible = this._actor.hover;
        });

        this._render();
        this._renderState(null);
        return this._actor;
    }

    enable() {
        this._media.start(state => this._renderState(state));
    }

    disable() {
        this._media.stop();
        this._stopTicker();

        if (this._ringRepaintId !== null && this._ringArea) {
            this._ringArea.disconnect(this._ringRepaintId);
            this._ringRepaintId = null;
        }
        if (this._fallbackRepaintId !== null && this._fallbackArea) {
            this._fallbackArea.disconnect(this._fallbackRepaintId);
            this._fallbackRepaintId = null;
        }
        if (this._hoverId !== null && this._actor) {
            this._actor.disconnect(this._hoverId);
            this._hoverId = null;
        }
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            backgroundColor: '#000000F5',
            ringColor: '#F5A623FF',
            infoFont: 'Sans Bold 11',
            infoColor: '#FFFFFFFF',
            buttonColor: '#FFFFFFFF',
            desktopFilePath: '',
        };
    }

    onSettingsChanged() {
        this._render();
    }

    /** @private */
    _makeButton(iconName, onClicked) {
        const button = new St.Button({
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.connect('clicked', onClicked);
        return button;
    }

    /** @private */
    _onPlayClicked() {
        if (!this._state) {
            this._onCoverClicked();
            return;
        }
        this._media.playPause();
    }

    /** @private */
    _onCoverClicked() {
        if (this._state) {
            this._media.raise();
            return;
        }
        this._launchApp();
    }

    /** @private */
    _launchApp() {
        const path = this._settings.desktopFilePath ?? '';
        if (!path)
            return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (appInfo)
                appInfo.launch([], null);
            else
                this._api.logger.info(`media-player-circle: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`media-player-circle: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        // Always fully round (999px) regardless of any cornerRadius
        // setting - this widget doesn't expose one, so cardStyleCss's
        // fallback is what actually applies here.
        this._actor.set_style(_cardStyleCss(this._settings, {cornerRadiusFallback: 999}));

        const infoColor = _toCssColor(this._settings.infoColor, '#FFFFFFFF');
        const infoFont = _parseFontDescription(this._settings.infoFont ?? 'Sans Bold 11', 'Sans Bold', 11);
        this._titleLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${infoFont.size}px; ` +
            `font-weight: bold; text-align: center;`
        );
        this._artistLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${Math.max(8, infoFont.size - 2)}px; ` +
            `opacity: 0.85; text-align: center;`
        );

        const buttonColor = _toCssColor(this._settings.buttonColor, '#FFFFFFFF');
        for (const button of [this._prevButton, this._playPauseButton, this._nextButton]) {
            button.set_style(
                `background-color: rgba(0,0,0,0.45); border-radius: 999px; padding: 7px; color: ${buttonColor};`
            );
            button.child.set_style(`color: ${buttonColor};`);
        }

        if (this._ringArea)
            this._ringArea.queue_repaint();
        if (this._fallbackArea)
            this._fallbackArea.queue_repaint();
    }

    /**
     * @private
     * @param {import('../../lib/mediaApi.js').MediaState|null} state
     */
    _renderState(state) {
        this._state = state;

        if (!state) {
            this._titleLabel.set_text('');
            this._artistLabel.set_text('');
            this._textBox.hide();
            this._playPauseButton.child.icon_name = 'media-playback-start-symbolic';
            this._showFallbackArt();
            this._fraction = 0;
            this._stopTicker();
            if (this._ringArea)
                this._ringArea.queue_repaint();
            return;
        }

        this._textBox.show();
        this._titleLabel.set_text(state.title);
        this._artistLabel.set_text(state.artist);
        this._playPauseButton.child.icon_name = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        if (state.artUrl.length > 0) {
            try {
                const file = state.artUrl.startsWith('file://')
                    ? Gio.File.new_for_uri(state.artUrl)
                    : Gio.File.new_for_path(state.artUrl);
                this._artIcon.set_style(
                    `border-radius: 999px; background-size: cover; background-position: center; ` +
                    `background-image: url("${file.get_uri()}");`
                );
                this._showArt();
            } catch (e) {
                this._showFallbackArt();
            }
        } else {
            this._showFallbackArt();
        }

        // Re-sync the local extrapolation base to this real reading, then
        // let the ticker (or this single repaint, if paused) take it from
        // here - see the file header for why this isn't DBus polling.
        this._baseMonotonicUs = GLib.get_monotonic_time();
        this._basePositionMs = state.positionMs;
        this._updateFraction(state.lengthMs);

        if (state.status === 'Playing')
            this._startTicker();
        else
            this._stopTicker();
    }

    /** @private */
    _startTicker() {
        if (this._tickTimerId !== null)
            return;
        this._tickTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateFraction(this._state?.lengthMs ?? 0);
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** @private */
    _stopTicker() {
        if (this._tickTimerId !== null) {
            GLib.source_remove(this._tickTimerId);
            this._tickTimerId = null;
        }
    }

    /** @private recomputes _fraction from the local monotonic-clock
     * extrapolation and repaints the ring. Never touches DBus. */
    _updateFraction(lengthMs) {
        const elapsedMs = (GLib.get_monotonic_time() - this._baseMonotonicUs) / 1000;
        const positionMs = this._basePositionMs + elapsedMs;
        this._fraction = lengthMs > 0 ? Math.max(0, Math.min(1, positionMs / lengthMs)) : 0;
        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private */
    _showArt() {
        this._artIcon.show();
        this._fallbackArea.hide();
        this._fallbackIcon.hide();
    }

    /** @private */
    _showFallbackArt() {
        this._artIcon.hide();
        this._fallbackArea.show();
        this._fallbackIcon.show();
    }

    /** @private StDrawingArea::repaint handler for the progress ring -
     * base track plus a progress arc, same technique as
     * widgets/circles-disk/widget.js's _onRepaint(). */
    _onRingRepaint() {
        const cr = this._ringArea.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const baseColor = _hexToRgba('#FFFFFF26');
        const ringColor = _hexToRgba(this._settings.ringColor ?? '#F5A623FF');

        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - RING_THICKNESS) / 2 - 2;
        const startAngle = -Math.PI / 2;
        const fraction = Math.max(0, Math.min(1, this._fraction));
        const endAngle = startAngle + fraction * 2 * Math.PI;

        cr.setLineWidth(RING_THICKNESS);
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

    /** @private StDrawingArea::repaint handler for the circular
     * orange-gradient fallback shown when there's no artwork. */
    _onFallbackRepaint() {
        const cr = this._fallbackArea.get_context();
        const w = COVER_SIZE;
        const h = COVER_SIZE;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const start = _hexToRgba('#FF8A00FF');
        const end = _hexToRgba('#B3260AFF');
        const gradient = new Cairo.LinearGradient(0, 0, w, h);
        gradient.addColorStopRGBA(0, start.r, start.g, start.b, start.a);
        gradient.addColorStopRGBA(1, end.r, end.g, end.b, end.a);

        cr.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, 2 * Math.PI);
        cr.setSource(gradient);
        cr.fill();

        cr.$dispose();
    }
}
