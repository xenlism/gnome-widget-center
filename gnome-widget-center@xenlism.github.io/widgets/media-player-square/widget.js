// widgets/media-player-square/widget.js
//
// 1x1 card: album cover fills the widget behind a visible padded frame,
// track info overlays the bottom of the cover on a dark scrim, and
// Play/Previous/Next controls are hidden until the pointer hovers the
// widget. Talks to whatever MPRIS2 player is running via
// lib/mediaApi.js's MprisMediaService (WIDGET_API.md §9.1) - signal-
// driven updates only, no DBus polling, full proxy/signal cleanup in
// disable(). Same shape as widgets/media-player, just a different layout
// on top of the same service.
//
// Cover click: raises the attached player if one exists, otherwise
// launches the app configured in config.json's desktopFilePath field
// (Gio.DesktopAppInfo, same pattern as widgets/clock-modern/widget.js's
// _launchApp()). The Play button falls back to the same launch behavior
// on its very first click when no player is attached yet, so a person
// who has never opened their player can still start it from here.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';
import {MprisMediaService} from '../../lib/mediaApi.js';

// --- Drop shadow (self-contained per-widget copy - see WIDGET_API.md
// section 9's "bundled widgets only" restriction on lib/ imports; every
// widget under widgets/ carries its own small copy of this instead of
// sharing one, since widgets must not reach into each other or into
// files outside their own folder) ---
const SHADOW_DEFAULTS = {
    shadowEnabled: false,
    shadowColor: '#000000',
    shadowOpacity: 30, // percent, 0-100
    shadowAngle: 90,   // degrees: 0 = right, 90 = down, 180 = left, 270 = up
    shadowDistance: 6, // px
    shadowBlur: 16,    // px
};

/** @private Builds a `box-shadow: ...;` CSS declaration (St supports the
 * standard CSS box-shadow syntax) from this widget's own shadow
 * settings, or '' when the shadow is off - always safe to splice
 * directly into a set_style() template literal. */
function _shadowBoxShadowCss(settings) {
    const s = settings ?? {};
    if (!(s.shadowEnabled ?? SHADOW_DEFAULTS.shadowEnabled))
        return '';

    const opacityPercent = Number.isFinite(s.shadowOpacity) ? s.shadowOpacity : SHADOW_DEFAULTS.shadowOpacity;
    const angleDeg = Number.isFinite(s.shadowAngle) ? s.shadowAngle : SHADOW_DEFAULTS.shadowAngle;
    const distance = Number.isFinite(s.shadowDistance) ? s.shadowDistance : SHADOW_DEFAULTS.shadowDistance;
    const blur = Number.isFinite(s.shadowBlur) ? Math.max(0, s.shadowBlur) : SHADOW_DEFAULTS.shadowBlur;

    const rad = (angleDeg * Math.PI) / 180;
    const offsetX = Math.round(Math.cos(rad) * distance * 100) / 100;
    const offsetY = Math.round(Math.sin(rad) * distance * 100) / 100;

    let hex = (s.shadowColor ?? SHADOW_DEFAULTS.shadowColor).trim().replace(/^#/, '');
    if (hex.length === 3)
        hex = hex.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(hex))
        hex = '000000';
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = Math.min(1, Math.max(0, opacityPercent / 100));

    return `box-shadow: ${offsetX}px ${offsetY}px ${blur}px 0px rgba(${r}, ${g}, ${b}, ${a});`;
}

const SIZE = 160;
const COVER_SIZE = 140;
const COVER_RADIUS = 16;

/** @private "#rrggbb" or "#rrggbbaa" -> {r,g,b,a} each 0..1, for Cairo. */
function _hexToRgba(hex) {
    const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex ?? '');
    if (!m)
        return {r: 1, g: 1, b: 1, a: 1};
    const h = m[1];
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {r, g, b, a};
}

/** @private 8-digit "#rrggbbaa" -> "rgba(r, g, b, a)" for St CSS, which
 * doesn't understand 8-digit hex on its own. Anything else passes
 * through unchanged. Same fix as lib/themeService.js's hexToRgba(). */
function _toCssColor(hex, fallback) {
    const value = typeof hex === 'string' ? hex : fallback;
    const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(value);
    if (!m)
        return value;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const a = Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** @private splits a combined Pango font-description string into the
 * family/size pieces St's set_style() needs separately - same pattern as
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

export default class MediaPlayerSquareWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._media = new MprisMediaService(api.logger);
        this._state = null;

        this._coverPressId = null;
        this._enterId = null;
        this._leaveId = null;
        this._repaintId = null;
    }

    buildActor() {
        this._actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: SIZE,
            height: SIZE,
            reactive: true,
            clip_to_allocation: true,
        });

        // --- Cover frame (padded inset, centered by BinLayout) ---
        this._coverStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: COVER_SIZE,
            height: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        this._actor.add_child(this._coverStack);

        this._fallbackArea = new St.DrawingArea({width: COVER_SIZE, height: COVER_SIZE});
        this._coverStack.add_child(this._fallbackArea);
        this._repaintId = this._fallbackArea.connect('repaint', () => this._onFallbackRepaint());

        this._fallbackIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 56,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.9);',
        });
        this._coverStack.add_child(this._fallbackIcon);

        this._artIcon = new St.Icon({
            icon_size: COVER_SIZE - 8,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._coverStack.add_child(this._artIcon);

        this._scrim = new St.Widget({
            width: COVER_SIZE,
            height: 58,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            style: 'background-color: rgba(0,0,0,0.55);',
        });
        this._coverStack.add_child(this._scrim);

        this._titleLabel = new St.Label({text: 'No media playing'});
        this._albumLabel = new St.Label({text: ''});
        this._artistLabel = new St.Label({text: ''});
        for (const label of [this._titleLabel, this._albumLabel, this._artistLabel])
            label.clutter_text.set_ellipsize(3 /* Pango.EllipsizeMode.END */);

        this._textBox = new St.BoxLayout({
            vertical: true,
            width: COVER_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this._textBox.set_style('padding: 8px;');
        this._textBox.add_child(this._titleLabel);
        this._textBox.add_child(this._albumLabel);
        this._textBox.add_child(this._artistLabel);
        this._coverStack.add_child(this._textBox);

        // --- Whole-widget click target for launch/focus (§8/§9.1) ---
        this._coverButton = new St.Button({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            style: 'background-color: transparent;',
        });
        this._coverButton.connect('clicked', () => this._onCoverClicked());
        this._actor.add_child(this._coverButton);

        // --- Hover-revealed controls (added last so they paint/hit-test
        // above the cover button). ---
        this._prevButton = this._makeButton('media-skip-backward-symbolic', () => this._media.previous());
        this._playPauseButton = this._makeButton('media-playback-start-symbolic', () => this._onPlayClicked());
        this._nextButton = this._makeButton('media-skip-forward-symbolic', () => this._media.next());

        this._controls = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._controls.set_style('spacing: 10px;');
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);
        this._actor.add_child(this._controls);

        this._enterId = this._actor.connect('enter-event', () => {
            this._controls.show();
            return Clutter.EVENT_PROPAGATE;
        });
        this._leaveId = this._actor.connect('leave-event', () => {
            this._controls.hide();
            return Clutter.EVENT_PROPAGATE;
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

        if (this._repaintId !== null && this._fallbackArea) {
            this._fallbackArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        if (this._enterId !== null && this._actor) {
            this._actor.disconnect(this._enterId);
            this._enterId = null;
        }
        if (this._leaveId !== null && this._actor) {
            this._actor.disconnect(this._leaveId);
            this._leaveId = null;
        }
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            backgroundColor: '#000000F5',
            cornerRadius: 18,
            infoFont: 'Sans Bold 13',
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
            child: new St.Icon({icon_name: iconName, icon_size: 18}),
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
                this._api.logger.info(`media-player-square: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`media-player-square: failed to launch ${path}: ${e}`);
        }
    }

    /** @private applies settings-driven colors/fonts; safe to call before
     * a player has ever been seen. */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#000000F5');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        this._actor.set_style(`background-color: ${backgroundColor}; border-radius: ${cornerRadius}px;` +
            _shadowBoxShadowCss(this._settings));
        this._coverStack.set_style(`background-color: rgba(255,255,255,0.05); border-radius: ${COVER_RADIUS}px;`);

        const infoColor = _toCssColor(this._settings.infoColor, '#FFFFFFFF');
        const infoFont = _parseFontDescription(this._settings.infoFont ?? 'Sans Bold 13', 'Sans Bold', 13);
        this._titleLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${infoFont.size}px; font-weight: bold;`
        );
        this._albumLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${Math.max(8, infoFont.size - 3)}px; opacity: 0.85;`
        );
        this._artistLabel.set_style(
            `color: ${infoColor}; font-family: ${infoFont.family}; font-size: ${Math.max(8, infoFont.size - 3)}px; opacity: 0.85;`
        );

        const buttonColor = _toCssColor(this._settings.buttonColor, '#FFFFFFFF');
        for (const button of [this._prevButton, this._playPauseButton, this._nextButton]) {
            button.set_style(
                `background-color: rgba(0,0,0,0.45); border-radius: 999px; padding: 8px; color: ${buttonColor};`
            );
            button.child.set_style(`color: ${buttonColor};`);
        }

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
            this._titleLabel.set_text('No media playing');
            this._albumLabel.set_text('');
            this._artistLabel.set_text('');
            this._playPauseButton.child.icon_name = 'media-playback-start-symbolic';
            this._showFallbackArt();
            return;
        }

        this._titleLabel.set_text(state.title);
        this._albumLabel.set_text(state.album);
        this._artistLabel.set_text(state.artist);
        this._playPauseButton.child.icon_name = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        if (state.artUrl.length > 0) {
            try {
                const file = state.artUrl.startsWith('file://')
                    ? Gio.File.new_for_uri(state.artUrl)
                    : Gio.File.new_for_path(state.artUrl);
                this._artIcon.gicon = new Gio.FileIcon({file});
                this._showArt();
            } catch (e) {
                this._showFallbackArt();
            }
        } else {
            this._showFallbackArt();
        }
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

    /** @private StDrawingArea::repaint handler - paints the rounded
     * orange-gradient placeholder used when the player reports no
     * artwork. Context is disposed before returning (GJS requirement). */
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

        const radius = COVER_RADIUS;
        cr.newSubPath();
        cr.arc(w - radius, radius, radius, -Math.PI / 2, 0);
        cr.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
        cr.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
        cr.arc(radius, radius, radius, Math.PI, 3 * Math.PI / 2);
        cr.closePath();

        cr.setSource(gradient);
        cr.fill();

        cr.$dispose();
    }
}
