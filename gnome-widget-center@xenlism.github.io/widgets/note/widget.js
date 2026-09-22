import St from "gi://St";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import Cairo from "cairo";

import { ModalDialog } from "resource:///org/gnome/shell/ui/modalDialog.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";
import { SHADOW_DEFAULTS, hexToRgba, toCssColor, parseFontDescription } from "../../lib/widgetVisualKit.js";

// Folder/file-preview style note: a colored header band with rounded top
// corners sitting above a title, a free-form multi-line note body and a
// date, like the "Customized Filtration - 1 photo - 2/28/25" reference
// card. The note body follows the same "state lives outside config.json,
// edited by clicking the card" pattern sticky-note's noteText uses -
// config.json only carries its style (font/color/placeholder), never the
// text itself, so the settings panel can't leave it stuck in a hidden
// state the way an earlier show/hide switch did.
const HEADER_HEIGHT = 54;
const DIVIDER_HEIGHT = 9;
const CONTENT_PADDING = 16;
const DEFAULT_RADIUS = 22;
const DEFAULT_HEADER_TOP = "#FFD65AFF";
const DEFAULT_HEADER_BOTTOM = "#FFAE00FF";
const DEFAULT_CARD_COLOR = "#F6F6F6FF";

function _formatDateShort(date) {
    const mm = date.getMonth() + 1;
    const dd = date.getDate();
    const yy = String(date.getFullYear()).slice(-2);
    return `${mm}/${dd}/${yy}`;
}

export default class NoteWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._headerArea = null;
        this._dividerArea = null;
        this._titleLabel = null;
        this._noteLabel = null;
        this._dateLabel = null;
        this._headerRepaintId = null;
        this._dividerRepaintId = null;
        this._contentPressId = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "note-widget-root"
        });
        this._actor = this._layers.root;

        const outer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(outer);

        // --- header: colored band, rounded top corners, flat bottom ------
        this._headerArea = new St.DrawingArea({
            x_expand: true,
            y_expand: false,
            height: HEADER_HEIGHT
        });
        this._headerRepaintId = this._headerArea.connect("repaint", () => this._onHeaderRepaint());
        outer.add_child(this._headerArea);

        // --- dashed divider, tear-off perforation look --------------------
        this._dividerArea = new St.DrawingArea({
            x_expand: true,
            y_expand: false,
            height: DIVIDER_HEIGHT
        });
        this._dividerRepaintId = this._dividerArea.connect("repaint", () => this._onDividerRepaint());
        outer.add_child(this._dividerArea);

        // --- body: click-to-edit title / note / date -----------------------
        this._content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
            track_hover: false,
            style: `padding: ${CONTENT_PADDING}px; spacing: 3px;`
        });
        this._contentPressId = this._content.connect("button-press-event", (_actor, event) => {
            // Same guard every other clickable bundled widget uses: only a
            // plain left click opens the editor, so Super+drag (move) and
            // right-click (Edit Mode) still reach the root actor.
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.MOD4_MASK) return Clutter.EVENT_PROPAGATE;
            this._onEditClicked();
            return Clutter.EVENT_STOP;
        });
        outer.add_child(this._content);

        this._titleLabel = new St.Label({ x_expand: true });
        this._titleLabel.clutter_text.line_wrap = true;
        this._titleLabel.clutter_text.ellipsize = 0;
        this._content.add_child(this._titleLabel);

        // Fills the remaining space between title and date and always
        // wraps - it's a free-form note, not a one-line label, so it
        // should read like a small paragraph, not clip after one line.
        this._noteLabel = new St.Label({ x_expand: true, y_expand: true });
        this._noteLabel.clutter_text.line_wrap = true;
        this._noteLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._noteLabel.clutter_text.ellipsize = 0;
        this._noteLabel.clutter_text.y_align = Clutter.ActorAlign.START;
        this._content.add_child(this._noteLabel);

        this._dateLabel = new St.Label({ x_expand: true });
        this._content.add_child(this._dateLabel);

        this._render();
        return this._actor;
    }

    enable() {
        this._render();
    }

    disable() {
        if (this._headerRepaintId !== null && this._headerArea) {
            this._headerArea.disconnect(this._headerRepaintId);
            this._headerRepaintId = null;
        }
        if (this._dividerRepaintId !== null && this._dividerArea) {
            this._dividerArea.disconnect(this._dividerRepaintId);
            this._dividerRepaintId = null;
        }
        if (this._contentPressId !== null && this._content) {
            this._content.disconnect(this._contentPressId);
            this._contentPressId = null;
        }
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            title: "Customized Filtration",
            noteText: ""
        };
    }

    onSettingsChanged() {
        this._render();
    }

    // --- interaction -------------------------------------------------------

    _onEditClicked() {
        this._promptForNoteFields(this._settings.title ?? "", this._settings.noteText ?? "").then(result => {
            if (result !== null) {
                this._settings.title = result.title;
                this._settings.noteText = result.noteText;
                this._render();
            }
        });
    }

    _promptForNoteFields(currentTitle, currentNoteText) {
        return new Promise(resolve => {
            const dialog = new ModalDialog({
                styleClass: "note-widget-dialog"
            });
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: "note-widget-dialog-box",
                style: "spacing: 8px; padding: 4px; width: 480px;"
            });

            box.add_child(new St.Label({
                text: "Edit note",
                style: "font-weight: bold;"
            }));

            box.add_child(new St.Label({
                text: "Title",
                style: "font-size: 12px; opacity: 0.7;"
            }));
            const titleEntry = new St.Entry({
                style_class: "note-widget-dialog-entry",
                hint_text: "Note title...",
                can_focus: true,
                text: currentTitle,
                x_expand: true
            });
            box.add_child(titleEntry);

            box.add_child(new St.Label({
                text: "Note",
                style: "font-size: 12px; opacity: 0.7;"
            }));
            const noteEntry = new St.Entry({
                style_class: "note-widget-dialog-entry",
                hint_text: "Write anything...",
                can_focus: true,
                text: currentNoteText,
                x_expand: true,
                y_expand: true,
                style: "min-height: 140px; border-radius: 8px;"
            });
            // Multi-line: single_line_mode off + activatable off means
            // Enter inserts a newline instead of submitting - only Save
            // (or Escape to cancel) closes the dialog, same pattern
            // sticky-note's edit-note entry uses.
            const noteClutterText = noteEntry.clutter_text;
            noteClutterText.set_single_line_mode(false);
            noteClutterText.activatable = false;
            noteClutterText.line_wrap = true;
            noteClutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            noteClutterText.y_align = Clutter.ActorAlign.START;
            noteClutterText.reactive = true;
            noteClutterText.can_focus = true;
            box.add_child(noteEntry);

            dialog.contentLayout.add_child(box);

            // A second entry in a ModalDialog isn't always reliably
            // click-focusable through St.Entry's own handling alone -
            // grab focus explicitly on press so clicking either field
            // always moves the cursor into it.
            titleEntry.connect("button-press-event", () => {
                titleEntry.grab_key_focus();
                return Clutter.EVENT_PROPAGATE;
            });
            noteEntry.connect("button-press-event", () => {
                noteEntry.grab_key_focus();
                return Clutter.EVENT_PROPAGATE;
            });

            let resolved = false;
            const finish = value => {
                if (resolved) return;
                resolved = true;
                dialog.close();
                resolve(value);
            };

            dialog.setButtons([
                { label: "Cancel", action: () => finish(null), key: Clutter.KEY_Escape },
                {
                    label: "Save",
                    action: () => finish({
                        title: titleEntry.get_text(),
                        noteText: noteEntry.get_text()
                    }),
                    default: true
                }
            ]);

            dialog.open();
            global.stage.set_key_focus(titleEntry);
        });
    }

    // --- rendering -----------------------------------------------------------

    _render() {
        if (!this._actor) return;

        const s = this._settings;

        applyLayeredCardStyle(this._layers, s, {
            backgroundColorKey: "cardColor",
            backgroundColorFallback: DEFAULT_CARD_COLOR,
            cornerRadiusFallback: DEFAULT_RADIUS
        });

        if (this._headerArea) this._headerArea.queue_repaint();

        if (this._dividerArea) {
            this._dividerArea.visible = s.showDivider ?? true;
            if (this._dividerArea.visible) this._dividerArea.queue_repaint();
        }

        if (this._titleLabel) {
            const font = parseFontDescription(s.titleFont ?? "Sans Bold 15", "Sans Bold", 15);
            const color = toCssColor(s.titleColor, "#242424FF");
            this._titleLabel.text = s.title || "Untitled";
            this._titleLabel.set_style(`color: ${color}; font-family: ${font.family}; font-size: ${font.size}px; font-weight: bold;`);
        }

        if (this._noteLabel) {
            const hasText = !!(s.noteText && s.noteText.trim());
            const font = parseFontDescription(s.noteFont ?? "Sans 12", "Sans", 12);
            const placeholder = s.placeholderText || "Add a note...";

            if (hasText) {
                const color = toCssColor(s.noteColor, "#5A5A5AFF");
                this._noteLabel.text = s.noteText;
                this._noteLabel.set_style(`color: ${color}; font-family: ${font.family}; font-size: ${font.size}px;`);
            } else {
                const dim = toCssColor(_withAlpha(s.noteColor, 0.55), "#5A5A5AFF");
                this._noteLabel.text = placeholder;
                this._noteLabel.set_style(`color: ${dim}; font-family: ${font.family}; font-size: ${font.size}px; font-style: italic;`);
            }
        }

        if (this._dateLabel) {
            const font = parseFontDescription(s.dateFont ?? "Sans 11", "Sans", 11);
            const color = toCssColor(s.dateColor, "#8A8A8AFF");
            const dateStr = (s.autoDate ?? false) ? _formatDateShort(new Date()) : (s.dateText ?? "");
            this._dateLabel.text = dateStr;
            this._dateLabel.set_style(`color: ${color}; font-family: ${font.family}; font-size: ${font.size}px;`);
        }
    }

    _onHeaderRepaint() {
        const cr = this._headerArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const box = this._headerArea.get_allocation_box();
        const w = box.get_width();
        const h = box.get_height();
        if (w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }

        const s = this._settings;
        const radius = Math.max(0, Math.min(s.cornerRadius ?? DEFAULT_RADIUS, w / 2, h));
        const top = hexToRgba(s.headerColorTop ?? DEFAULT_HEADER_TOP);
        const bottom = hexToRgba(s.headerColorBottom ?? DEFAULT_HEADER_BOTTOM);

        // Rounded-top, flat-bottom path so the band's top corners line up
        // with the card's own corner radius and the straight bottom edge
        // sits flush against the divider/body below.
        cr.moveTo(0, h);
        cr.lineTo(0, radius);
        cr.arc(radius, radius, radius, Math.PI, Math.PI * 1.5);
        cr.lineTo(w - radius, 0);
        cr.arc(w - radius, radius, radius, Math.PI * 1.5, Math.PI * 2);
        cr.lineTo(w, h);
        cr.closePath();

        const gradient = new Cairo.LinearGradient(0, 0, 0, h);
        gradient.addColorStopRGBA(0, top.r, top.g, top.b, top.a);
        gradient.addColorStopRGBA(1, bottom.r, bottom.g, bottom.b, bottom.a);
        cr.setSource(gradient);
        cr.fill();

        cr.$dispose();
    }

    _onDividerRepaint() {
        const cr = this._dividerArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const box = this._dividerArea.get_allocation_box();
        const w = box.get_width();
        const h = box.get_height();
        if (w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }

        const margin = Math.max(4, w * 0.06);
        const y = h / 2;
        cr.moveTo(margin, y);
        cr.lineTo(w - margin, y);
        cr.setDash([2, 3], 0);
        cr.setLineWidth(1);
        cr.setSourceRGBA(0, 0, 0, 0.14);
        cr.stroke();

        cr.$dispose();
    }
}

function _withAlpha(hex, alpha01) {
    const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec((hex ?? "").trim());
    if (!m) return hex;
    const a = Math.round(Math.min(1, Math.max(0, alpha01)) * 255).toString(16).padStart(2, "0");
    return `#${m[1]}${a}`;
}
