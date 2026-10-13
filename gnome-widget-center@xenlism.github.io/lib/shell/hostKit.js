// hostKit.js - the kit a widget gets as `api.host.kit` (widget API 3), instead of importing "../../lib/<file>.js".
//
// A widget that imports the host's files by path only works when it sits exactly two folders below lib/, and it may load a
// second copy of each module (different URI = separate state). The kit is ONE instance per shell process, shared by every
// widget, bundled or store-installed. See HANDOVER-host-kit.md.
//
// Static imports on purpose: widgetRuntimeLoader.js / extension.js already load nearly all of these, and a widget constructor
// is synchronous so the kit cannot be loaded lazily.
import * as config from "../widgetConfigDefaults.js";
import * as layers from "./cardLayers.js";
import * as visual from "../widgetVisualKit.js";
import * as metrics from "../systemMetricsApi.js";
import * as tooltip from "./widgetTooltip.js";
import * as fs from "../fsUtils.js";
import * as utils from "../utils.js";
import * as gauge from "./halfCircleGaugeKit.js";
import * as media from "../mediaApi.js";
import * as calendarEvents from "../systemCalendarEvents.js";
import * as calendarGrid from "../calendarGridKit.js";
import * as architect from "../architectWidgetKit.js";
import * as iconAccent from "../iconAccentColor.js";
import * as cryptoMarkets from "../cryptoMarketsKit.js";
import * as stockMarkets from "../stockMarketsKit.js";

// Bump when an export is REMOVED or changes meaning. Adding an export does not change it: widgets feature-detect names.
export const HOST_KIT_VERSION = 1;

// A module namespace object cannot be frozen, so each namespace is a frozen plain copy.
const ns = (...modules) => Object.freeze(Object.assign({}, ...modules));

export const HOST_KIT = Object.freeze({
    version: HOST_KIT_VERSION,
    config: ns(config),
    layers: ns(layers),
    visual: ns(visual),
    metrics: ns(metrics),
    tooltip: ns(tooltip),
    fs: ns(fs),
    utils: ns(utils),
    gauge: ns(gauge),
    media: ns(media),
    calendar: ns(calendarEvents, calendarGrid),
    architect: ns(architect),
    iconAccent: ns(iconAccent),
    cryptoMarkets: ns(cryptoMarkets),
    stockMarkets: ns(stockMarkets),
});
