import { XtileBaseWidget } from "../xtile/widget.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

export default class XtileFirefoxWidget extends XtileBaseWidget {
    getDefaultSettings() {
        return { ...configJsonDefaults(import.meta.url) };
    }
}
