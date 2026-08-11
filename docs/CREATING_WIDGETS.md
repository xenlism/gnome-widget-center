# Creating widgets

This guide explains how to build a widget for GNOME Widget Center without
changing the extension itself. The authoritative API reference is
[`../gnome-widget-center@xenlism.github.io/WIDGET_API.md`](../gnome-widget-center@xenlism.github.io/WIDGET_API.md).

## 1. Start from the template

Copy the bundled template to your personal widget directory, then choose a
unique, lower-case folder name:

```bash
mkdir -p ~/.local/share/gnome-widget-center/widgets
cp -a gnome-widget-center@xenlism.github.io/widgets/_template \
  ~/.local/share/gnome-widget-center/widgets/my-widget
```

Edit the copied files; never edit the installed extension or another
widget's folder. Open GNOME Widget Center's Control Center and rescan or
restart GNOME Shell after adding a widget.

## 2. Required files

```
my-widget/
├── metadata.json  # required: identity and launch information
├── widget.js      # required: desktop widget implementation
├── config.json    # recommended: generated preferences UI
├── prefs.js       # optional: custom GTK/Libadwaita preferences UI
└── assets/        # optional: images or other files read by widget.js
```

Use **one** preferences approach: `config.json` is the recommended default;
use `prefs.js` when you need custom GTK widgets or behaviour. Do not use the
template's legacy `settings.js` for a new widget.

## 3. Define `metadata.json`

The `id` must exactly match the folder name and must be unique. Select one of
the supported fixed `block-type` values: `barx1`, `barx2`, `barx3`, `barx4`,
`1x1`, `2x1`, `2x2`, `3x1`, `3x2`, `3x3`, `4x1`, `4x2`, `4x3`, or `4x4`.

```json
{
  "id": "my-widget",
  "name": "My Widget",
  "description": "A short description shown in the Control Center.",
  "version": "1.0.0",
  "author": "Your name",
  "api-version": 1,
  "entry": "widget.js",
  "block-type": "1x1",
  "default-position": { "x": 40, "y": 40, "monitor": 0 }
}
```

Set `themeable` to `true` only when the widget wants GNOME Widget Center to
apply its shared appearance theme. A widget that paints its own complete card
should leave it out.

## 4. Implement `widget.js`

`widget.js` runs inside GNOME Shell. It must export one default class that
builds an `St` actor and cleans up every timer, signal, or D-Bus object it
creates.

```js
import GLib from 'gi://GLib';
import St from 'gi://St';

export default class MyWidget {
    constructor(api) {
        this._api = api;
        this._timeoutId = null;
    }

    buildActor() {
        this._label = new St.Label({ text: 'Hello' });
        this._actor = new St.BoxLayout({
            style: 'padding: 12px; border-radius: 12px; background: #1e1e1e;',
            child: this._label,
        });
        return this._actor;
    }

    enable() {
        const refresh = () => {
            this._label.text = new Date().toLocaleTimeString();
            return GLib.SOURCE_CONTINUE;
        };
        refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, refresh);
    }

    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._actor?.destroy();
        this._actor = null;
    }

    getDefaultSettings() {
        return { showSeconds: true };
    }

    onSettingsChanged() {
        // Re-render or restart timers when preferences change.
    }
}
```

Do not import `Gtk`, `Adw`, or other preferences-only libraries here. Use
`api.settings` for the widget's stored settings, `api.logger` for logs,
`api.path.me` for files inside the widget folder, and `api.position` for
position changes.

## 5. Add preferences with `config.json`

This creates a preferences page automatically:

```json
{
  "version": "1.0",
  "tabs": [
    {
      "id": "general",
      "label": "General",
      "groups": [
        {
          "id": "display",
          "label": "Display",
          "fields": [
            {
              "id": "showSeconds",
              "label": "Show seconds",
              "dataType": "boolean",
              "fieldType": "switch",
              "default": true
            }
          ]
        }
      ]
    }
  ]
}
```

Useful field types include `text`, `textarea`, `switch`, `checkbox`,
`dropdown`, `spinbutton`, `slider`, `colorpicker`, `fontpicker`,
`filepicker`, and `folderpicker`. Every field id must be unique within its
group. Use `visibleIf` or `enabledIf` for simple conditional controls.

## 6. Test before sharing

1. Validate each JSON file with a JSON parser.
2. Check that the folder name and `metadata.json` `id` match.
3. Enable the widget in the Control Center and inspect `journalctl` if it
   does not load.
4. Change every preference and confirm that `onSettingsChanged()` updates
   long-running state such as timers.
5. Disable and re-enable the extension; it must not leave timers, signals,
   or actors behind.

For complex examples, study the widgets already bundled in
`gnome-widget-center@xenlism.github.io/widgets/`.
