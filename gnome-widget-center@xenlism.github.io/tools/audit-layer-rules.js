#!/usr/bin/env node
/**
 * audit-layer-rules.js
 *
 * Checks all widgets against the 7 Widget Layer Rules documented in
 * CLAUDE.md. Exits 0 if clean, 1 if any violation found.
 *
 * Usage:
 *   node tools/audit-layer-rules.js
 *
 * Rules checked (static heuristic — not a full JS parse):
 *   R1  _content must have a Clutter.BindConstraint
 *   R4  _content must have clip_to_allocation
 *   R5  _content must not carry set_style() or style_class directly
 *   R7  insertChildAboveSafely() first arg must not be _content
 *
 * R2 (every widget always self-paints its own card via
 * applyLayeredCardStyle()) and R6 (8-char hex colours) are architectural
 * and verified by the existing tools/lint-themeable.js and the
 * config.json loading pipeline — not repeated here.
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const WIDGETS_DIR = path.join(__dirname, "..", "widgets");
const SKIP = new Set(["_template", "README.txt"]);

function auditWidget(id, dir) {
    const wjs = path.join(dir, "widget.js");
    if (!fs.existsSync(wjs)) return [];

    const src = fs.readFileSync(wjs, "utf8");
    if (!src.includes("this._content")) return [];   // no content layer — skip

    const issues = [];

    // Widgets built on lib/cardLayers.js's createLayeredCard() get R1/R4
    // for free: layers.content (the actual Content Layer) is always
    // constructed with clip_to_allocation: true and sized by the root's
    // Clutter.BinLayout — see lib/cardLayers.js. `this._content` in these
    // widgets is each widget's OWN locally-named child wrapper (padding,
    // layout box, etc.), not the Content Layer itself, so checking it for
    // a BindConstraint/clip_to_allocation is checking the wrong actor
    // entirely. Only widgets NOT using createLayeredCard() (a plain root
    // actor manually paired with a `this._content` sized via
    // BindConstraint) need those two checks run against `this._content`.
    const usesLayeredCard = src.includes("createLayeredCard(");

    if (!usesLayeredCard) {
        // R1 — BindConstraint keeps _content at blocksize
        if (!src.includes("BindConstraint")) {
            issues.push(
                "R1: _content has no Clutter.BindConstraint — content size may not " +
                "match the allocated blocksize. Add:\n" +
                "      this._content.add_constraint(new Clutter.BindConstraint({\n" +
                "          source: this._actor,\n" +
                "          coordinate: Clutter.BindCoordinate.SIZE,\n" +
                "      }));"
            );
        }

        // R4 — content must clip children
        if (!src.includes("clip_to_allocation")) {
            issues.push(
                "R4: _content has no clip_to_allocation — widget children can " +
                "overflow the card boundary. Add clip_to_allocation: true to " +
                "the _content constructor."
            );
        }
    }

    // R5 — content is a pure clip wrapper, no style. For createLayeredCard()
    // widgets this means layers.content specifically (the real Content
    // Layer) — a widget's own `this._content` wrapper is a normal child
    // and is allowed padding/layout styling, same as any other actor
    // inside the card. For legacy (non-layered) widgets, `this._content`
    // IS the Content Layer, so it's checked directly instead.
    const r5Target = usesLayeredCard ? "this\\._layers\\.content" : "this\\._content";
    const r5SetStyle = new RegExp(`${r5Target}\\s*\\.\\s*set_style\\s*\\(`);
    const r5StyleClass = new RegExp(`${r5Target}\\s*\\.\\s*style_class\\s*=`);
    if (r5SetStyle.test(src)) {
        issues.push(
            (usesLayeredCard
                ? "R5: this._layers.content.set_style() — the Content Layer must not carry visual style. Move card style to layers.card."
                : "R5: this._content.set_style() — content layer must not carry visual style. Move card style to a this._background child.")
        );
    }
    if (r5StyleClass.test(src)) {
        issues.push(
            (usesLayeredCard
                ? "R5: this._layers.content.style_class set directly — move to a child."
                : "R5: this._content.style_class set directly — move to a child.")
        );
    }

    // R7 — tooltip must not be parented inside _content (would be clipped)
    if (/insertChildAboveSafely\s*\(\s*this\._content\s*,/.test(src)) {
        issues.push(
            "R7: insertChildAboveSafely(this._content, ...) — tooltip is " +
            "parented inside the clipped content layer and cannot overflow " +
            "the card boundary. Change to this._actor as the parent and " +
            "recompute coordinates relative to this._actor.get_transformed_position()."
        );
    }

    return issues;
}

function main() {
    if (!fs.existsSync(WIDGETS_DIR)) {
        console.error(`audit-layer-rules: widgets/ not found at ${WIDGETS_DIR}`);
        process.exit(1);
    }

    const entries = fs.readdirSync(WIDGETS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && !SKIP.has(e.name));

    let totalIssues = 0;

    for (const entry of entries) {
        const dir    = path.join(WIDGETS_DIR, entry.name);
        const issues = auditWidget(entry.name, dir);
        if (issues.length === 0) continue;
        totalIssues += issues.length;
        console.error(`\n=== ${entry.name} ===`);
        for (const issue of issues) console.error(`  • ${issue}`);
    }

    if (totalIssues === 0) {
        console.log(
            `audit-layer-rules: checked ${entries.length} widget(s), ` +
            "all conform to R1 / R4 / R5 / R7."
        );
        process.exit(0);
    }

    console.error(
        `\naudit-layer-rules: ${totalIssues} violation(s) across ` +
        `${entries.length} widget(s).`
    );
    process.exit(1);
}

main();
