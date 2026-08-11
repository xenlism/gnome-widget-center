# ChatGPT instructions for GNOME Widget Center widgets

Use this file as context when asking ChatGPT to create or modify a widget.

## Project facts

- The extension folder is `gnome-widget-center@xenlism.github.io/`.
- New third-party widgets belong in
  `~/.local/share/gnome-widget-center/widgets/<widget-id>/`.
- Read `docs/CREATING_WIDGETS.md` and
  `gnome-widget-center@xenlism.github.io/WIDGET_API.md` before writing code.
- The widget folder name must equal `metadata.json`'s `id`.
- `widget.js` runs in GNOME Shell and may import `gi://St`, `gi://Clutter`,
  `gi://Gio`, and `gi://GLib`. It must not import `Gtk` or `Adw`.
- `prefs.js`, when used, runs in a separate GTK/Libadwaita process and must
  not import `St`, `Clutter`, `Meta`, or `Shell`.
- Prefer `config.json` for normal preferences. Use `prefs.js` only when a
  generated settings page cannot express the required UI.

## Required quality rules

1. Create or edit only the requested widget folder. Do not edit the host
   extension's `extension.js`, `prefs.js`, schemas, or other widgets.
2. Produce valid JSON with unique field ids. `metadata.json` must use
   `api-version: 1` and a supported fixed `block-type`.
3. Export one default widget class from `widget.js`.
4. `buildActor()` must return an `St`/Clutter actor and must be safe with
   default settings.
5. Store every timer id, signal id, and external resource on the instance;
   disconnect or remove all of them in `disable()`.
6. Use `api.settings` only for this widget's settings. Implement
   `onSettingsChanged()` when a preference changes state that is not redrawn
   automatically.
7. Use inline `style` / `set_style()` for Shell presentation. A widget-local
   `stylesheet.css` is not automatically loaded by the host.
8. Do not access files outside `api.path.me`, spawn destructive commands, or
   assume a network connection.

## Prompt template

```
Create a GNOME Widget Center widget named <id>.

Requirements:
- Purpose: <what it displays or does>
- Block type: <one supported value>
- Settings: <list of user-configurable fields>
- Design: <colours/layout/accessibility needs>

Follow chatgpt.md and docs/CREATING_WIDGETS.md. Create only files inside
<id>/. Return metadata.json, widget.js, and config.json (or explain why a
custom prefs.js is required). Ensure disable() cleans up every timer, signal,
and resource. Do not modify the host extension.
```

## Expected response from ChatGPT

For each change, state the files created or edited, how to install the widget,
and any dependency or GNOME-version assumption. Flag anything that needs
real GNOME Shell testing instead of claiming it is verified.
