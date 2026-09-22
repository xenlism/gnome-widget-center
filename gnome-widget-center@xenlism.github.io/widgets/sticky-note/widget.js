import St from "gi://St";
import Clutter from "gi://Clutter";
import Cairo from "cairo";

import { ModalDialog } from "resource:///org/gnome/shell/ui/modalDialog.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";
import { SHADOW_DEFAULTS, hexToRgba, toCssColor, parseFontDescription } from "../../lib/widgetVisualKit.js";

const FOLD_SIZE = 30;
const DOT_SIZE = 16;

// Classic macOS "Stickies" preset colors, cycled by clicking the corner dot.
const PRESET_COLORS = [
    "#FFFBBDFF", // yellow
    "#FFD9EBFF", // pink
    "#D7F2C2FF", // green
    "#C9E7FFFF", // blue
    "#E7D4F7FF", // purple
    "#E6E6E6FF"  // gray
];

function _markupEscape(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export default class StickyNoteWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._textLabel = null;
        this._dotButton = null;
        this._foldArea = null;
        this._foldRepaintId = null;
        this._bodyPressId = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "sticky-note-widget-root"
        });
        this._actor = this._layers.root;

        // Stack: paper content underneath, folded-corner overlay on top.
        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(this._stack);

        const outer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            style: "padding: 12px; spacing: 4px;"
        });
        this._stack.add_child(outer);

        // --- header: color-cycle dot, top right -------------------------
        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true
        });
        outer.add_child(header);

        const spacer = new St.Widget({ x_expand: true });
        header.add_child(spacer);

        this._dotButton = new St.Button({
            style_class: "sticky-note-color-dot",
            width: DOT_SIZE,
            height: DOT_SIZE,
            reactive: true,
            can_focus: true
        });
        this._dotButton.connect("clicked", () => this._onCycleColorClicked());
        header.add_child(this._dotButton);

        // --- body: click-to-edit text area -------------------------------
        this._body = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
            track_hover: false
        });
        this._bodyPressId = this._body.connect("button-press-event", (_actor, event) => {
            // Leave Super+drag (moving the widget) and non-primary clicks
            // alone - only a plain left click opens the editor.
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.MOD4_MASK) return Clutter.EVENT_PROPAGATE;
            this._onEditClicked();
            return Clutter.EVENT_STOP;
        });
        outer.add_child(this._body);

        this._textLabel = new St.Label({
            x_expand: true,
            y_expand: true
        });
        this._textLabel.clutter_text.line_wrap = true;
        this._textLabel.clutter_text.ellipsize = 0;
        this._body.add_child(this._textLabel);

        // --- folded-corner overlay, bottom right, fixed size -------------
        this._foldArea = new St.DrawingArea({
            width: FOLD_SIZE,
            height: FOLD_SIZE,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END
        });
        this._foldRepaintId = this._foldArea.connect("repaint", () => this._onFoldRepaint());
        this._stack.add_child(this._foldArea);

        this._render();
        return this._actor;
    }

    enable() {
        this._render();
    }

    disable() {
        if (this._foldRepaintId !== null && this._foldArea) {
            this._foldArea.disconnect(this._foldRepaintId);
            this._foldRepaintId = null;
        }
        if (this._bodyPressId !== null && this._body) {
            this._body.disconnect(this._bodyPressId);
            this._bodyPressId = null;
        }
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            noteText: ""
        };
    }

    onSettingsChanged() {
        this._render();
    }

    // --- interaction -------------------------------------------------------

    _onCycleColorClicked() {
        const current = (this._settings.paperColor ?? PRESET_COLORS[0]).toUpperCase();
        const idx = PRESET_COLORS.findIndex(c => c.toUpperCase() === current);
        const next = PRESET_COLORS[(idx + 1) % PRESET_COLORS.length];
        this._settings.paperColor = next;
        this._render();
    }

    _onEditClicked() {
        this._promptForNoteText(this._settings.noteText ?? "").then(text => {
            if (text !== null) {
                this._settings.noteText = text;
                this._render();
            }
        });
    }

    _promptForNoteText(currentText) {
        return new Promise(resolve => {
            const dialog = new ModalDialog({
                styleClass: "sticky-note-dialog"
            });
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: "sticky-note-dialog-box",
                style: "spacing: 8px; padding: 4px; width: 360px;"
            });

            const label = new St.Label({
                text: "Edit note",
                style: "font-weight: bold;"
            });
            box.add_child(label);

            const entry = new St.Entry({
                style_class: "sticky-note-dialog-entry",
                hint_text: "Write anything...",
                can_focus: true,
                text: currentText
            });
            // Multi-line: Enter inserts a newline instead of submitting -
            // only the "Save" button (or Escape to cancel) closes the dialog.
            entry.clutter_text.set_single_line_mode(false);
            entry.clutter_text.line_wrap = true;
            box.add_child(entry);

            dialog.contentLayout.add_child(box);

            let resolved = false;
            const finish = value => {
                if (resolved) return;
                resolved = true;
                dialog.close();
                resolve(value);
            };

            dialog.setButtons([
                { label: "Cancel", action: () => finish(null), key: Clutter.KEY_Escape },
                { label: "Save", action: () => finish(entry.get_text()), default: true }
            ]);

            dialog.open();
            global.stage.set_key_focus(entry);
        });
    }

    // --- rendering -----------------------------------------------------------

    _render() {
        if (!this._actor) return;

        const s = this._settings;
        const paperColor = s.paperColor ?? PRESET_COLORS[0];

        applyLayeredCardStyle(this._layers, s, {
            backgroundColorKey: "paperColor",
            backgroundColorFallback: PRESET_COLORS[0],
            cornerRadiusFallback: 3
        });

        if (this._dotButton) {
            this._dotButton.visible = s.showColorDot ?? true;
            const dotCss = toCssColor(paperColor, PRESET_COLORS[0]);
            this._dotButton.set_style(`background-color: ${dotCss}; border-radius: ${DOT_SIZE}px; border: 1px solid rgba(0, 0, 0, 0.25);`);
        }

        if (this._textLabel) {
            const hasText = !!(s.noteText && s.noteText.trim());
            const font = parseFontDescription(s.textFont ?? "Sans 15", "Sans", 15);
            const align = s.textAlign === "center" ? "center" : "left";
            const inkColor = toCssColor(s.textColor, "#3A3226FF");
            const placeholder = s.placeholderText || "Click to write a note...";

            this._textLabel.clutter_text.set_use_markup(true);
            if (hasText) {
                this._textLabel.clutter_text.set_markup(_markupEscape(s.noteText));
                this._textLabel.set_style(`color: ${inkColor}; font-family: ${font.family}; font-size: ${font.size}px; text-align: ${align};`);
            } else {
                this._textLabel.clutter_text.set_markup(_markupEscape(placeholder));
                const dim = toCssColor(_withAlpha(s.textColor, 0.45), inkColor);
                this._textLabel.set_style(`color: ${dim}; font-family: ${font.family}; font-size: ${font.size}px; font-style: italic; text-align: ${align};`);
            }
        }

        if (this._foldArea) {
            this._foldArea.visible = s.showFoldedCorner ?? true;
            if (this._foldArea.visible) this._foldArea.queue_repaint();
        }
    }

    _onFoldRepaint() {
        const cr = this._foldArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const paper = hexToRgba(this._settings.paperColor ?? PRESET_COLORS[0]);
        const darken = f => Math.max(0, Math.min(1, f));

        // Folded flap: a darker shade of the paper color, corner-to-corner.
        cr.moveTo(FOLD_SIZE - FOLD_SIZE * 0.82, FOLD_SIZE);
        cr.lineTo(FOLD_SIZE, FOLD_SIZE);
        cr.lineTo(FOLD_SIZE, FOLD_SIZE - FOLD_SIZE * 0.82);
        cr.closePath();
        cr.setSourceRGBA(darken(paper.r * 0.72), darken(paper.g * 0.72), darken(paper.b * 0.72), paper.a);
        cr.fill();

        // Crease highlight along the fold edge.
        cr.moveTo(FOLD_SIZE - FOLD_SIZE * 0.82, FOLD_SIZE);
        cr.lineTo(FOLD_SIZE, FOLD_SIZE - FOLD_SIZE * 0.82);
        cr.setLineWidth(1);
        cr.setSourceRGBA(1, 1, 1, 0.25);
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
