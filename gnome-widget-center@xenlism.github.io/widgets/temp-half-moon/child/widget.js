// Never imported: a Child (metadata.json has "parent") loads its Parent's widget.js, resolved by
// widget ID at load time (lib/shell/widgetRuntimeLoader.js). This file only exists because
// metadata.json's "entry" must name a real file.
export default null;
