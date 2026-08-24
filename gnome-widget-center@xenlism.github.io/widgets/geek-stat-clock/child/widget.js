// widgets/geek-stat-clock/child/widget.js
//
// Copied verbatim to each new Child's own directory when someone clicks
// "+ Add Widget" on the Geek Stat Clock Architect Widget. At copy time,
// lib/architectWidgetKit.js's createChildWidgetFromParent() replaces
// {{PARENT_ENTRY_URI}} below with an absolute file:// URI to the
// Parent's own widget.js - the one generated edit; nothing else here is
// touched.
//
// Config-only pattern (see widgets/_architect_template_/child/widget.js
// for the full rationale): a Child is a differently-CONFIGURED instance
// of the exact same GeekStatClockWidget class, never a new subclass.
// Every per-Child difference - which source each of the 3 lines shows,
// their fonts/colors/shadows, and the block-type/size chosen in the Add
// Widget dialog - lives entirely in this Child's own config.json /
// metadata.json, both written by createChildWidgetFromParent() and the
// Parent's own _patchChildBlockType() at creation time.
export { default } from "{{PARENT_ENTRY_URI}}";
