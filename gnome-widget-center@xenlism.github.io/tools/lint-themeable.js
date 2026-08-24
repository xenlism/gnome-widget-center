#!/usr/bin/env node
/*
 * lint-themeable.js
 *
 * The "themeable"/"forceSettingsAware" R2/R3 metadata pair (and the
 * whole Force Settings GSettings system it used to gate) has been
 * removed. Every widget now always self-paints its own card via
 * applyLayeredCardStyle()/cardStyleCss() straight from its own
 * settings (see lib/widgetVisualKit.js, lib/cardLayers.js). The only
 * appearance value still shared globally is shadow-distance/
 * shadow-angle (lib/globalShadowHelper.js).
 *
 * This tool is now just a regression guard: it fails if any widget's
 * metadata.json still carries a "themeable" or "forceSettingsAware"
 * key, since either one reintroduces the old system's dead branches
 * (extension.js's __ignoreForce, widgetLoader.js's shouldIgnoreForce,
 * ThemeService.applyWidgetStyle) that this refactor deleted.
 *
 * Usage:
 *   node tools/lint-themeable.js
 *
 * Exit code 0 = clean, non-zero = one or more widgets still carry the
 * old keys (metadata.json path printed for each).
 */

const fs = require("fs");
const path = require("path");

const WIDGETS_DIR = path.join(__dirname, "..", "widgets");

function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
        return null;
    }
}

function main() {
    if (!fs.existsSync(WIDGETS_DIR)) {
        console.error(`lint-themeable: widgets directory not found at ${WIDGETS_DIR}`);
        return 1;
    }
    const entries = fs.readdirSync(WIDGETS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    const flagged = [];
    let checked = 0;
    for (const entry of entries) {
        // Top-level widget metadata.json, plus (if present) the
        // Architect Widget's child/metadata.json template - the latter
        // gets copied verbatim into every real Child a user creates via
        // "+ Add Widget" (see lib/architectWidgetKit.js's
        // createChildWidgetFromParent()), so a stale key there is just
        // as live a bug as one in the parent's own metadata.json. Two
        // such stale "themeable": true keys (_architect_template_/child
        // and geek-stat-clock/child) survived the original sweep
        // precisely because this loop only checked one level deep.
        const candidatePaths = [
            path.join(WIDGETS_DIR, entry.name, "metadata.json"),
            path.join(WIDGETS_DIR, entry.name, "child", "metadata.json"),
        ];
        for (const metadataPath of candidatePaths) {
            const metadata = readJson(metadataPath);
            if (!metadata) continue;
            checked++;
            if ("themeable" in metadata || "forceSettingsAware" in metadata) {
                flagged.push(metadataPath);
            }
        }
    }
    if (flagged.length === 0) {
        console.log(`lint-themeable: checked ${checked} widget(s), none carry a "themeable"/"forceSettingsAware" key.`);
        return 0;
    }
    console.error(`lint-themeable: ${flagged.length} widget(s) still carry the removed "themeable"/"forceSettingsAware" keys:\n`);
    for (const p of flagged) console.error(`  - ${p}`);
    console.error('\nRemove those keys - every widget now always self-paints its own card (see lib/cardLayers.js\'s applyLayeredCardStyle()).');
    return 1;
}

process.exit(main());
