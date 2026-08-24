// widgets/xtile-inkscape/widget.js
//
// XtileInkscape tile of the Xtile series. All real behavior (layout,
// click-to-launch, icon-accent card color) lives in XtileBaseWidget
// (widgets/xtile-firefox/widget.js) - this file only points
// getDefaultSettings() at THIS widget's own config.json (required
// because import.meta.url is per-file, see the base class's header
// comment) and changes nothing else. Which app this tile launches,
// its icon size, its label, its accent strength - all of that is
// xtile-inkscape/config.json, never this file.

import { XtileBaseWidget } from "../xtile-firefox/widget.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

export default class XtileInkscapeWidget extends XtileBaseWidget {
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url)
        };
    }
}
