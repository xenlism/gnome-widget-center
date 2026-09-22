import St from "gi://St";
import Clutter from "gi://Clutter";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";
import { SHADOW_DEFAULTS, toCssColor, parseFontDescription } from "../../lib/widgetVisualKit.js";

const GRID_SPACING = 10;
const MAX_DIGITS = 12;

// [label, kind, colSpan] - kind is "digit" | "function" | "operator".
// Laid out left-to-right, top-to-bottom into a 4-column grid, same shape
// as the macOS/iOS Calculator app.
const BUTTON_ROWS = [
    [["AC", "function"], ["+/-", "function"], ["%", "function"], ["\u00f7", "operator"]],
    [["7", "digit"], ["8", "digit"], ["9", "digit"], ["\u00d7", "operator"]],
    [["4", "digit"], ["5", "digit"], ["6", "digit"], ["\u2212", "operator"]],
    [["1", "digit"], ["2", "digit"], ["3", "digit"], ["+", "operator"]],
    [["0", "digit", 2], [".", "digit"], ["=", "operator"]]
];

function _formatNumber(n) {
    if (!Number.isFinite(n)) return "Error";
    if (Number.isInteger(n) && Math.abs(n) < 1e12) return String(n);
    let s = n.toPrecision(10);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
}

function _compute(a, b, op) {
    switch (op) {
        case "+": return a + b;
        case "\u2212": return a - b;
        case "\u00d7": return a * b;
        case "\u00f7": return b === 0 ? NaN : a / b;
        default: return b;
    }
}

export default class CalculatorWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._displayLabel = null;
        this._resetEntry();
    }

    _resetEntry() {
        this._display = "0";
        this._pendingValue = null;
        this._pendingOp = null;
        this._justEvaluated = false;
        this._awaitingOperand = false;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "calculator-widget-root"
        });
        this._actor = this._layers.root;

        const outer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            style: `padding: 14px; spacing: ${GRID_SPACING}px;`
        });
        this._layers.content.add_child(outer);

        this._displayLabel = new St.Label({
            text: "0",
            x_expand: true,
            x_align: Clutter.ActorAlign.END
        });
        this._displayLabel.clutter_text.ellipsize = 0;
        outer.add_child(this._displayLabel);

        this._grid = new St.Widget({
            style_class: "calculator-widget-grid",
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.GridLayout({
                column_spacing: GRID_SPACING,
                row_spacing: GRID_SPACING,
                column_homogeneous: true,
                row_homogeneous: true
            })
        });
        outer.add_child(this._grid);

        this._buttons = [];
        const layout = this._grid.layout_manager;
        BUTTON_ROWS.forEach((row, rowIndex) => {
            let col = 0;
            for (const [label, kind, colSpan] of row) {
                const span = colSpan ?? 1;
                const button = this._makeButton(label, kind);
                layout.attach(button, col, rowIndex, span, 1);
                col += span;
            }
        });

        this._render();
        return this._actor;
    }

    enable() {
        this._render();
    }

    disable() {
        // Every button's "clicked" handler is torn down automatically when
        // its actor is destroyed with the widget; no timers/signals of our
        // own to clean up here.
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS
        };
    }

    onSettingsChanged() {
        this._render();
    }

    // --- button construction ------------------------------------------

    _makeButton(label, kind) {
        const icon = new St.Label({
            text: label,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        const button = new St.Button({
            style_class: `calculator-widget-button calculator-widget-button-${kind}`,
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            y_expand: true
        });
        button.connect("clicked", () => this._onButtonPressed(label, kind));
        this._buttons.push({ button, icon, label, kind });
        return button;
    }

    // --- calculator logic ------------------------------------------------

    _onButtonPressed(label, kind) {
        if (kind === "digit") {
            if (label === ".") this._pressDecimal();
            else this._pressDigit(label);
        } else if (kind === "function") {
            if (label === "AC") this._resetEntry();
            else if (label === "+/-") this._pressToggleSign();
            else if (label === "%") this._pressPercent();
        } else if (kind === "operator") {
            if (label === "=") this._pressEquals();
            else this._pressOperator(label);
        }
        this._render();
    }

    _pressDigit(d) {
        if (this._justEvaluated) {
            this._display = d;
            this._justEvaluated = false;
        } else if (this._awaitingOperand) {
            this._display = d;
            this._awaitingOperand = false;
        } else if (this._display === "0") {
            this._display = d;
        } else if (this._display.replace("-", "").replace(".", "").length < MAX_DIGITS) {
            this._display += d;
        }
    }

    _pressDecimal() {
        if (this._justEvaluated || this._awaitingOperand) {
            this._display = "0.";
            this._justEvaluated = false;
            this._awaitingOperand = false;
            return;
        }
        if (!this._display.includes(".")) this._display += ".";
    }

    _pressToggleSign() {
        if (this._display === "0") return;
        this._display = this._display.startsWith("-") ? this._display.slice(1) : `-${this._display}`;
    }

    _pressPercent() {
        const value = parseFloat(this._display) || 0;
        this._display = _formatNumber(value / 100);
    }

    _pressOperator(op) {
        const current = parseFloat(this._display) || 0;
        if (this._pendingOp !== null && this._awaitingOperand) {
            // Changing the operator right after picking one - just swap it.
            this._pendingOp = op;
            return;
        }
        if (this._pendingOp !== null) {
            this._pendingValue = _compute(this._pendingValue, current, this._pendingOp);
            this._display = _formatNumber(this._pendingValue);
        } else {
            this._pendingValue = current;
        }
        this._pendingOp = op;
        this._awaitingOperand = true;
        this._justEvaluated = false;
    }

    _pressEquals() {
        if (this._pendingOp === null) return;
        const current = parseFloat(this._display) || 0;
        const result = _compute(this._pendingValue, current, this._pendingOp);
        this._display = _formatNumber(result);
        this._pendingOp = null;
        this._pendingValue = null;
        this._awaitingOperand = false;
        this._justEvaluated = true;
    }

    // --- rendering ---------------------------------------------------------

    _render() {
        if (!this._actor) return;
        const s = this._settings;

        applyLayeredCardStyle(this._layers, s, {
            backgroundColorFallback: "#1C1C1EF5",
            cornerRadiusFallback: 20
        });

        if (this._displayLabel) {
            const displayColor = toCssColor(s.displayColor, "#FFFFFFFF");
            const font = parseFontDescription(s.displayFont ?? "Sans 34", "Sans", 34);
            this._displayLabel.set_text(this._display);
            this._displayLabel.set_style(`color: ${displayColor}; font-family: ${font.family}; font-size: ${font.size}px;`);
        }

        const digitColor = toCssColor(s.digitButtonColor, "#505050FF");
        const functionColor = toCssColor(s.functionButtonColor, "#A5A5A5FF");
        const operatorColor = toCssColor(s.operatorButtonColor, "#FF9F0AFF");
        const buttonTextColor = toCssColor(s.buttonTextColor, "#FFFFFFFF");
        const functionTextColor = toCssColor(s.functionTextColor, "#000000FF");

        for (const { button, icon, kind } of this._buttons) {
            const bg = kind === "operator" ? operatorColor : kind === "function" ? functionColor : digitColor;
            const fg = kind === "function" ? functionTextColor : buttonTextColor;
            button.set_style(`background-color: ${bg}; border-radius: 999px;`);
            icon.set_style(`color: ${fg}; font-size: 18px; font-weight: 500;`);
        }
    }
}
