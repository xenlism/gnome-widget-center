// This file is never actually imported. A widget whose metadata.json has a
// "parent" field (as this template's does, once createChildWidgetFromParent()
// stamps it in) is loaded by resolving that parent ID to its current install
// path at load time - see lib/shell/widgetRuntimeLoader.js's loadModule() -
// not by reading this file. That's what makes a spawned child portable:
// copy/export this folder anywhere with a widget of the same parent ID
// installed (built-in or otherwise) and it still loads, since nothing here
// is a machine-specific path.
//
// This file exists only because metadata.json's "entry" field must name a
// real file (required-field validation in lib/widgetLoader.js's discover()),
// and to make it obvious to anyone poking around a spawned child's folder
// where its actual code lives.
export default null;
