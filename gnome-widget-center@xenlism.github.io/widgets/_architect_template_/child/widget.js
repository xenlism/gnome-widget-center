// widgets/_architect_template_/child/widget.js
//
// This file is what actually gets copied to a new Child Widget's own
// directory (~/.local/share/gnome-widget-center/widgets/<child-id>/)
// when someone clicks "+ Add Widget" on the Architect Widget this
// template belongs to. At copy time, lib/architectWidgetKit.js's
// createChildWidgetFromParent() replaces the {{PARENT_ENTRY_URI}}
// placeholder below with an absolute file:// URI to the Architect's
// OWN widget.js — that's the one generated edit; nothing else in this
// file is touched.
//
// DEFAULT PATTERN — config-only, no new code per Child:
//
// The Parent's widget.js already contains every behavior a Child of
// this Architect can have. A Child is a differently-CONFIGURED
// instance of that same class, not a new subclass — like
// `const jass = new Car(); jass.color = "#xxxxxx"`, not
// `class Jass extends Car {}`. All per-Child difference lives in this
// Child's own config.json (see the sibling config.json in this
// template), which the loader hands to the same Parent class as
// `this._settings` when it builds this Child's instance.
//
// This is the same pattern already used throughout this codebase's
// own widgets/circles-*/ family — e.g. circles-cpu and circles-mem are
// ~198 lines each, identical except for a label string and which
// metric-getter function gets called. An Architect Widget author
// SHOULD write that kind of "branch on a config value" logic once in
// the Parent, then let every Child just be a different config.json.
export { default } from "{{PARENT_ENTRY_URI}}";

// OVERRIDE PATTERN — only if a specific Child genuinely needs code the
// Parent doesn't have (not just a different config value). Delete the
// re-export line above and use this instead:
//
//   import ParentWidget from "{{PARENT_ENTRY_URI}}";
//
//   export default class extends ParentWidget {
//       _render() {
//           super._render();
//           // Child-specific behavior here.
//       }
//   }
//
// Prefer the config-only pattern above whenever the difference can be
// expressed as data — it's what keeps a whole family of Children (all
// XTile-* app launchers, all circles-* stat readouts, etc.) as ONE
// piece of real code to maintain instead of one copy per Child.
