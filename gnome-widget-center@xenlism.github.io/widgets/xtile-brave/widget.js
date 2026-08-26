// widgets/xtile/child/widget.js
//
// Config-only Child (see widgets/_architect_template_/README.md and
// child/widget.js for the full rationale). Every Xtile Child created
// via the "Add Widget" flow is the exact same XtileBaseWidget behavior
// as the Parent (../widget.js, which itself just re-exports the base
// class already defined in widgets/xtile-firefox/widget.js) - the only
// thing that differs per Child is its own config.json's "app" field,
// set at creation time by XtileArchitectWidget._addChild().
export { default } from "file:///home/xenatt/.local/share/gnome-shell/extensions/gnome-widget-center@xenlism.github.io/widgets/xtile/widget.js";
