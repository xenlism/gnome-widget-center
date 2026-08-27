# GNOME Widget Center

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-4A86CF?logo=gnome&logoColor=white)](https://www.gnome.org/)
[![Language](https://img.shields.io/badge/Language-GJS%20%2F%20JavaScript-yellow)](https://gjs.guide/)
[![Toolkit](https://img.shields.io/badge/Toolkit-GTK%204-blue)](https://www.gtk.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/xenlism)

**GNOME Widget Center** is a flexible GNOME Shell extension for building a desktop that is useful, personal, and easy to share. Add widgets to the desktop, arrange them visually, tune their appearance, and package the whole setup as a reusable theme.

> **Status:** Preview / alpha release. The current package declares support for **GNOME Shell 50**. Please report issues you find and keep a backup of an important setup before upgrading.

![Desktop](assets/desktop.png)

## What you can do

- Add, enable, disable, and configure desktop widgets from one Control Center.
- Arrange widgets in **Edit Mode** with drag-and-drop, snapping/grid helpers, and multi-monitor support.
- Create a consistent desktop style with per-widget backgrounds, borders, shadows, blur, opacity, and corner radius.
- Save, import, export, and share complete desktop **Theme Packs**.
- Back up and restore widget configurations, including password-protected backups.
- Install your own widgets without modifying the extension itself.
- Use the built-in, localized interface.

## Widgets and Widget-Architect

GNOME Widget Center supports ordinary **Widgets** and **Widget-Architects**.

### Widgets

Widgets are ready-to-use desktop components: clocks, calendars, weather, system monitors, media controls, launchers, shortcuts, and more. Each widget exposes settings appropriate to its job, so a simple clock can stay simple while a system monitor can offer richer controls.

### Widget-Architects

A Widget-Architect is a widget that can create its own child widgets. It is ideal when you want several instances based on the same design but with different settings—for example, a launcher tile for each app, or several information cards with different data or styles.

1. Add the Architect widget to the desktop.
2. Enter **Edit Mode** and select/right-click the Architect widget.
3. Click **+ Add Widget** in its edit toolbar.
4. Give the new child its settings. It is an independent widget instance, while still using the Architect's shared design.

The `+ Add Widget` action appears only on the Architect parent, so child widgets cannot recursively create more children by accident.

## Make every widget yours

Most themeable widgets offer visual controls that can be combined freely:

| Setting | What it changes | Ideas to try |
| --- | --- | --- |
| **Background color** | The card's fill color. The alpha channel controls transparency. | Use a translucent dark card over a wallpaper, or a solid accent card for a launcher. |
| **Corner radius** | How rounded the card's corners are. | Use a large radius for soft, modern cards; turn it off for sharp dashboard panels. |
| **Shadow** | A drop shadow behind the widget, with adjustable color, opacity, blur, distance, and global direction. | Add a subtle dark shadow to separate transparent cards from a busy wallpaper. |
| **Background blur** | Softens the content behind a translucent card. | Pair it with a transparent background for a glass-like look. |
| **Border color and width** | Draws an outline around the card. | Use a low-opacity border to define a card without making it feel heavy. |
| **Opacity** | Fades the whole widget, including its text and icons. | Reduce it for background information; keep controls at full opacity for legibility. |

> **Blur note:** Background blur depends on GNOME Shell and the graphics/compositor environment. A GNOME limitation/bug can make blur unavailable or inconsistent on some systems. Other appearance settings continue to work normally.

There is no single “correct” style. Combine a transparent background, blur, gentle shadow, and rounded corners for a glassmorphism layout—or choose opaque backgrounds, square corners, and borders for a crisp information dashboard. Visual settings are per widget, so clocks, launchers, and monitors can each have their own character.

## Theme Packs: share a whole desktop setup

A Theme Pack captures more than colors: it makes a widget layout and its configuration portable. Export a setup to share it with someone else, keep versioned desktop looks, or move your setup to another machine. Importing a pack restores the saved appearance and widget configuration in one place.

Press **Win + Delete** to capture your desktop while preparing a Theme Pack. The screenshot is automatically attached to the export flow, making shared packs easier to preview and recognize.

## User files and folders

GNOME Widget Center keeps your content separate from the extension. This makes upgrades safer and makes it easy to back up or share your work.

| Folder | Purpose |
| --- | --- |
| `~/.config/gnome-widget-center/themepacks` | Your downloaded and exported Theme Packs. |
| `~/.config/gnome-widget-center/widgets` | Your per-widget configuration and settings. |
| `~/.local/share/gnome-widget-center/widgets` | Your installed user widgets, including Architect-created child widgets. |

## Build widgets with less boilerplate

GNOME Widget Center is designed to make widget development approachable. A widget can describe its preferences declaratively in `config.json`; the Control Center reads that file and generates the settings interface for you. For common settings—text, colors, fonts, switches, numeric controls, dropdowns, and more—you can create a usable preference UI without writing a custom preferences window.

Start with the included templates:

- [`development/widget-templates/template`](development/widget-templates/template) for a normal widget.
- [`development/widget-templates/architect-template`](development/widget-templates/architect-template) for a Widget-Architect that creates configurable child widgets.

Read [Creating Widgets](docs/CREATING_WIDGETS.md) and the [Widget API reference](gnome-widget-center@xenlism.github.io/WIDGET_API.md) for the development workflow and available APIs.

## Install

1. Extract the release archive and open a terminal in the extracted folder.
2. Run:

   ```bash
   chmod +x install.sh
   ./install.sh
   ```

   The installer reads the extension UUID from `gnome-widget-center@xenlism.github.io/metadata.json`, installs it under `~/.local/share/gnome-shell/extensions/`, recompiles the bundled schema, and attempts to enable it. An existing installation is moved to a timestamped backup folder first.

3. If it is not enabled automatically, open **Extensions** and enable **GNOME Widget Center**. On Wayland, log out and back in if the extension does not appear immediately.

To update, extract a newer archive and run `./install.sh` again.

## Screenshots

### Edit Mode

![Edit Mode](assets/editmode.png)

[▶ Watch the Edit Mode video](assets/editmode.mp4)

## Support development

If GNOME Widget Center makes your desktop better, please consider supporting its continued development. Contributions help fund maintenance, bug fixes, documentation, and new widgets.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor_on_GitHub-GitHub_Sponsors-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/xenlism)

- [GitHub Sponsors](https://github.com/sponsors/xenlism)
- [Ko-fi](https://ko-fi.com/xenlism)
- [USDT (TRC20) QR Code](assets/usdt.jpg)

## Development status

See [development/PROJECT_STATUS.md](development/PROJECT_STATUS.md) for the current verification boundary.

## License

GPL-3.0. See [LICENSE](LICENSE).

## Agent Team

| Agent | Role |
| --- | --- |
| **Nox ChatGPT** | Planning, code review, and project documentation. |
| **Keal Claude** | Coding and implementation. |
| **Veda Z.ai GLM 5.2** | New ideas and alternative solutions. |
