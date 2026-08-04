/**
 * lib/widget-center-overlay-integration-example.js
 *
 * How extension.js would wire up lib/widgetCenterOverlay.js, WHEN you're
 * ready to merge it in. Kept as a separate, inert file — same convention as
 * prefs/integration-example.js — instead of editing extension.js directly,
 * so this addition stays a small reviewable diff against whatever
 * extension.js has changed to by the time you merge, instead of a rewrite.
 *
 * Everything the overlay needs is optional (see WidgetCenterOverlay's own
 * constructor doc) — the minimal version is just:
 *
 *   import {WidgetCenterOverlay} from './lib/widgetCenterOverlay.js';
 *
 *   // inside enable(), anywhere after `this` has .path/.getSettings():
 *   this._widgetCenterOverlay = new WidgetCenterOverlay(this);
 *   this._widgetCenterOverlay.enable();
 *
 *   // inside disable():
 *   this._widgetCenterOverlay?.disable();
 *   this._widgetCenterOverlay = null;
 *
 * That alone gives you: Super+F12 (customizable from the overlay's own
 * Settings tab), the Overview + Themes + Settings tabs, and D-Bus toggling
 * for the .desktop launcher — reading widgets/themepacks straight off disk.
 *
 * For tighter integration (recommended once this extension's own enable()
 * already has `this._loader`, `this._storage`, `this._editMode` etc built),
 * pass them through so Remove/Settings do exactly what Edit Mode's own
 * buttons do instead of the built-in fallback:
 *
 *   this._widgetCenterOverlay = new WidgetCenterOverlay(this, {
 *       widgetLoader: this._loader,
 *       logger: this._logger,
 *       onWidgetSettings: id => this._openWidgetSettings(id),
 *       onWidgetRemove: id => this._removeWidgetViaEditMode(id),
 *       onOpenPreferences: () => this.openPreferences(),
 *       onApplyThemePack: (manifest, enabled) => {
 *           this._logger.debug('widget-center-overlay',
 *               `theme pack "${manifest.id}" ${enabled ? 'applied' : 'removed'}`);
 *       },
 *   });
 *   this._widgetCenterOverlay.enable();
 *
 * Placement in enable(): after `this._settings` exists (the overlay reads/
 * writes the same GSettings schema for disabled-widgets and its own
 * keybinding key) — anywhere after that point is fine, order relative to
 * WidgetLoader/WidgetLayer/EditMode doesn't matter since the overlay only
 * calls into them through the callbacks above, never directly.
 *
 * Placement in disable(): call widgetCenterOverlay.disable() BEFORE tearing
 * down whatever services you passed in above (this._loader etc), since
 * disable() also closes the overlay if it's open, and closing it destroys
 * actors that may reference those services during teardown.
 */
export const WIDGET_CENTER_OVERLAY_INTEGRATION_NOTE = true;
