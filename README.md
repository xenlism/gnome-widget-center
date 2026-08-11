# GNOME Widget Center

[![Language](https://img.shields.io/badge/Language-GJS%20%2F%20JavaScript-yellow)](https://gjs.guide/)
[![Toolkit](https://img.shields.io/badge/Toolkit-GTK%204-blue)](https://www.gtk.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

GNOME Widget Center is an alpha GNOME Shell extension that provides desktop
widgets, widget management, an edit mode, themes, and backup/restore tools.

> **Compatibility:** this package declares support for GNOME Shell **50**.
> It has not yet received complete clean-session testing on real GNOME Shell
> hardware, so treat it as a preview release.

## Features

- Bundled desktop widgets and support for user-installed widgets.
- A Control Center for enabling widgets and configuring their settings.
- Edit mode with drag-and-drop, grid helpers, and multi-monitor support.
- Themes plus import/export and password-protected backup/restore.
- Localized user interface resources.

## ❤️ Support Development

If GNOME Widget Center is useful to you, please consider supporting
development.

### Ko-fi

[![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/xenlism)

### PayPal

[PayPal QR Code](assets/paypal.jpg)

### USDT (TRC20)

[USDT TRC20 QR Code](assets/usdt.jpg)

Every contribution helps with maintenance, bug fixes, and new widgets.

## Install

1. Extract this archive and open a terminal in the extracted folder.
2. Run:

   ```bash
   chmod +x install.sh
   ./install.sh
   ```

   The script reads the UUID from
   `gnome-widget-center@xenlism.github.io/metadata.json`, installs the
   extension to `~/.local/share/gnome-shell/extensions/`, recompiles its
   bundled schema, and attempts to enable it. An existing installation is
   moved to a timestamped backup folder first.

3. If it is not enabled automatically, open the **Extensions** application
   and enable **GNOME Widget Center**. On Wayland, log out and back in when
   the extension does not appear immediately.

To update, extract the newer archive and run `./install.sh` again.

## Screenshots

### Desktop

![Desktop](assets/desktop.png)

### Edit Mode

![Edit Mode](assets/editmode.png)

[▶ Edit Mode video](assets/editmode.mp4)

## Development status

See [development/PROJECT_STATUS.md](development/PROJECT_STATUS.md) for the
current verification boundary. The widget API reference is included at
`gnome-widget-center@xenlism.github.io/WIDGET_API.md`.

## Create a widget

Read [docs/CREATING_WIDGETS.md](docs/CREATING_WIDGETS.md) to create a
third-party widget. [chatgpt.md](chatgpt.md) provides ready-to-use context
and a prompt template for creating widgets with ChatGPT.

## License

GPL-3.0. See [LICENSE](LICENSE).

## Agent Team

| Agent | Role |
| --- | --- |
| **Nox ChatGPT** | Planning, code review, and project documentation. |
| **Keal Claude** | Coding and implementation. |
| **Veda Z.ai GLM 5.2** | New ideas and alternative solutions. |
