# GWC Repo Maker

A GTK4 + libadwaita app (GJS) for **creating and maintaining a GNOME Widget Center store repository**.
Add widgets and theme packs from folders on your disk, sign them, build the site and publish it to GitHub Pages, all from one window.

> ภาษาไทย: [README.th.md](README.th.md)

It is a separate project from the extension and from the store template (`gwc-store`). It only needs the store's `tools/`, which are bundled in `backend/tools`.

---

## Contents
1. [What it does](#what-it-does)
2. [Installation](#installation)
3. [Usage](#usage)
4. [Signing keys (Ed25519)](#signing-keys-ed25519)
5. [Environment variables](#environment-variables)
6. [Troubleshooting](#troubleshooting)
7. [Uninstall](#uninstall)
8. [Development](#development)

---

## What it does
- **New / open repository** - browse to a folder (recent ones are remembered). A new repository gets the build tools, CI workflows and a signing key.
- **Sources** - browse to a folder that holds your widgets and theme packs (your extension folder with `widgets/` and `themepacks/`, or either folder itself). The app lists what it finds, marks each item *new*, *in repository* or *invalid*, and imports the ones you tick. Every item goes through the same checks as the build.
- **Signing keys** - create, import, copy, save the public key, back up the private key. Works without an open repository.
- **Authors and revocations** - decide who may sign widgets, and withdraw bad versions.
- **Store settings** - name, URL, mirrors, kind, signature policy.
- **Build and publish** - build with a live log and verify, then push to GitHub Pages.
- Thai / English UI by locale (force with `GWC_LANG=th|en`).

## Installation

### Requirements
| Part | Version | Used for |
| --- | --- | --- |
| gjs | >= 1.76 | runs the app |
| GTK | >= 4.10 | UI |
| libadwaita | >= 1.5 | UI |
| python3 | 3.9+ | build / signing tools |
| python `cryptography` | - | Ed25519 keys and signatures (required) |
| python `Pillow` | - | generated widget covers (optional) |
| git | - | lets the app run `git init` for new repositories (optional) |

### Arch Linux
```sh
sudo pacman -S --needed python python-cryptography python-pillow gjs gtk4 libadwaita git
./install.sh
```

### Debian / Ubuntu
```sh
sudo apt install gjs gir1.2-gtk-4.0 gir1.2-adw-1 python3 python3-cryptography python3-pil git
./install.sh
```

### Fedora
```sh
sudo dnf install gjs gtk4 libadwaita python3 python3-cryptography python3-pillow git
./install.sh
```

### What `install.sh` does
1. Checks for `cryptography`. If it is missing, it creates a virtualenv in `.venv` inside the app folder and installs the dependencies there (system pip is not used, so there is no `externally-managed-environment` error). The app picks up `.venv` automatically.
2. If a virtualenv cannot be created, it prints the package-manager commands to use instead.
3. Creates the launcher `~/.local/bin/gwc-repo-maker` and a desktop entry in `~/.local/share/applications`.

> `gjs`, GTK and libadwaita are system packages; the script does not install them. Use your package manager as shown above.
> If `~/.local/bin` is not in your `PATH`, add it, or run `bin/gwc-repo-maker` directly.

### Run without installing
```sh
bin/gwc-repo-maker                      # start the app
bin/gwc-repo-maker --repo ~/my-store    # open this repository right away
```

## Usage

### 1) Create a repository
Start page -> **New repository**, then fill in:
- **Store name** and **Store id** (a-z 0-9 -)
- **Public URL** - must start with `https://` and end with `/`, e.g. `https://USER.github.io/my-widget-store/`
- **Kind** - `official` or `community` (community requires an author signature on every widget)
- **Signing key id** - *Suggest* gives an unused id; a new key is generated under that id
- **Create inside folder** - *Browse...*

When it is done the app shows the key **fingerprint**. Give it to users who will add your store, and **back up the private key file**.

### 2) Add widgets and theme packs
- **Import from a folder:** **Sources** page -> *Browse...* -> choose the folder -> tick items -> *Import selected*
- **New widget:** **Widgets** page -> *New widget* (metadata, a starter `widget.js`, config and a cover)
- **Import a single file:** **Widgets** -> *Import...* (`.gwcw` or folder) / **Theme packs** -> *Import...* (`.gwct`)

**Big widgets:** a widget whose zip is over 4 MiB (or that unpacks to more than 16 MiB) is built as a *version 2* package automatically: a small `.gwcw` plus a raw `.gwcp` zip (up to 64 MiB, 128 MiB unpacked). Nothing to configure; **Publish** uploads both files. Very large uploads can take a while, and GitHub Pages sites are limited in total size, so keep heavy assets lean. Users need the current Widget Center to install a version 2 widget; older ones show a clear message for that one widget only.

The declared permissions of a widget are compared with what its code actually uses; a mismatch is reported as an error on the **Overview** page.

### 3) Sign as author (if needed)
The check-mark button on a widget row -> pick an author key. If you have none, a **Generate key** button creates one. The signature covers the exact content, version, entry file and permissions, so any later edit needs a new signature.

### 4) Add an author
**Authors & revocations** -> *Add author...*. In the public key field:
- *Browse...* picks a `.pub.json` (or a file holding the base64 key) and fills in the kid and key
- *Generate key* creates a new author key on this computer and fills in its public key

"Allowed ids" is comma separated, e.g. `me.clock, me.*`.

### 5) Settings and revocations
- **Settings:** press *Save settings*. Invalid values are rejected and nothing is changed.
- **Revoke:** withdraw one version (give its 32-hex hash) or every version (leave the hash empty). Users see it on their next check. Publish after changing.

### 6) Publish (no terminal, no git, no GitHub secret)
**Build & publish** page, group **Publish to GitHub**:
1. **Sign in with GitHub** once (a code is shown and copied, GitHub opens in your browser, you press *Authorize*). If the app has no client id, use **Use a token...** instead: the page opens GitHub's token form with the right permission (`public_repo`) already ticked.
2. Check the **repository name** (created as a public repository if it does not exist).
3. Press **Publish**. The app checks GitHub, sets the Public URL to the real Pages address, builds, **signs on this computer**, verifies, uploads the site to the `gh-pages` branch and turns on GitHub Pages. Then it shows your store address and the key fingerprint to give to users.

**Already have a GitHub Pages site?** Under *Where to publish* choose *A folder in my existing GitHub Pages site*, give the site's repository (`NAME` or `OWNER/NAME`, e.g. `you.github.io`) and a folder name (e.g. `gwc-store`). The store goes to `https://you.github.io/gwc-store/`. The app reads how that site is published (branch and folder), commits only into your folder on that branch, and never touches any other file or the Pages settings. It refuses a folder that already holds something that is not a store, and the folder name may not start with `.` or `_` (GitHub Pages ignores those). If the site is deployed by a GitHub Actions workflow, the files are committed but only go online if that workflow publishes the folder; the app warns you. Protected branches that refuse the commit are reported, not bypassed.

**Your own domain** (GitHub, repository of its own): fill *Your own domain*, e.g. `store.example.com`. The Public URL becomes `https://store.example.com/` and the app uploads the `CNAME` file GitHub Pages reads. The DNS record (a CNAME to `you.github.io`) and *Enforce HTTPS* in the repository's Settings > Pages are yours to do; until GitHub has verified the domain the address does not answer.

**My own web host** (private store, intranet, Cloudflare Pages, Netlify, S3, nginx, a NAS...): choose it and type the public address (`https://.../`, ending with `/`). The app checks what is online there, builds and signs here, and shows the folder to upload; no GitHub account is involved. If nothing is online yet it asks whether this is the first version (a wrong "first version" makes users' devices refuse your updates, so it asks instead of guessing), and if the address cannot be reached it stops before building. The next build continues from the live version and keeps the previous revision reachable. Choose this for anything that must not be on GitHub: the app signs a store whether it is public or not, but a store must be reachable over `https://` by the people who add it. GitHub Pages sites are public even when their repository is private, and the sign-in used here only has access to public repositories, so the app does not publish to private repositories.

**Community or official store, and names:** *Store kind* (official / community) and the store name are set when you create the repository and can be changed in *Settings*; the store id is fixed once created. The GitHub repository name, the folder and the address are independent of the store id and can be anything you choose.

The signing key never leaves this computer. Publishing again uploads only what changed and renews the signature. New repositories get a signature validity of 180 days (there is no weekly CI job renewing it); the page warns when fewer than 30 days remain: just press **Publish** again.

Your widget sources stay on your computer (back the folder up). Only the finished site is on GitHub.

The GitHub token is stored in `<key folder>/github.token` (mode 0600). **Sign out** deletes it; you can also revoke it at github.com/settings/applications.

**Sign in with GitHub** needs an OAuth App with *Device Flow* enabled (GitHub -> Settings -> Developer settings -> OAuth Apps). Put its client id in `backend/github_client_id.txt` (or `GWC_GH_CLIENT_ID`). Without it the app falls back to the token form.

**Advanced** (collapsed on the same page): preview build, manual signed build, and the GitHub Actions flow (push to `main`, `GWC_SIGNING_KEY` secret in the `store-publish` Environment, Pages source *GitHub Actions*, weekly signature renewal). Use one publishing method per repository, not both.

## Signing keys (Ed25519)
Menu -> **Signing keys...** (also on the start page; works without an open repository).

| Button | What it does |
| --- | --- |
| Create key... | Creates an author key, or the store signing key (when a repository is open) |
| Import... | Browse for an existing private key file (`.key`) and copy it into the key folder; never overwrites |
| Copy / Save public key | Send it to the store maintainer or put it in `authors.json` |
| Back up private key... | Copy the key file somewhere offline or encrypted |
| Open key folder | `~/.config/gwc-repo-maker/keys` |

- These are **Ed25519 keys, not PGP/OpenPGP keys**: Widget Center verifies Ed25519 signatures only, so a PGP key could not be used.
- A private key is a 32-byte seed stored with mode `0600` and **never inside a repository**. Anyone who has the file can sign as you.
- Share only the public key or its fingerprint.

## Environment variables
| Variable | Meaning |
| --- | --- |
| `GWC_LANG=th\|en` | force the UI language |
| `GWC_KEY_DIR` | key folder (default `~/.config/gwc-repo-maker/keys`) |
| `GWC_PYTHON` | force this Python interpreter (default `.venv/bin/python3` if present, else system `python3`) |
| `GWC_TOOLS` | use another `tools/` folder instead of `backend/tools` |
| `GWC_GH_CLIENT_ID` | GitHub OAuth App client id for *Sign in with GitHub* (else `backend/github_client_id.txt`) |
| `GWC_GH_API`, `GWC_GH_WEB` | GitHub API / web base URLs (GitHub Enterprise, or the fake server in tests) |

## Troubleshooting
| Symptom | Fix |
| --- | --- |
| `externally-managed-environment` from pip | run `./install.sh` (uses a venv), or install `python-cryptography` / `python3-cryptography` with your package manager |
| `ModuleNotFoundError: cryptography` | run `./install.sh` again, or see the row above |
| venv module missing (Debian/Ubuntu) | `sudo apt install python3-venv` |
| `Typelib ... Adw-1 not found` | install `gir1.2-adw-1` (Debian/Ubuntu) or `libadwaita` (Arch/Fedora) |
| `gwc-repo-maker: command not found` | add `~/.local/bin` to `PATH`, or run `bin/gwc-repo-maker` |
| signed build says `No private key for '...'` | the store's signing key is not on this computer; bring it in with *Import...* in the Signing keys dialog, or build a preview |
| some icons are missing | minimal icon theme; harmless |

## Uninstall
```sh
rm ~/.local/bin/gwc-repo-maker ~/.local/share/applications/io.github.xenlism.GwcRepoMaker.desktop
rm -rf .venv                               # if install.sh created one
# keys live in ~/.config/gwc-repo-maker/keys  (delete only after backing them up!)
```

## Development
All repository logic is in Python (`backend/tools/gwc_repo.py` prints JSON); the app is a thin front end.

Keep the bundled backend in step with gwc-store:
```sh
./sync-backend.sh /path/to/gwc-store
```
A repository that has its own `tools/` is always handled with its own copy (same version as its CI).

Tests:
```sh
# backend layer under real GJS
GWC_KEY_DIR=$(mktemp -d) gjs -m tests/backend.test.js
# UI: drives the Sources page, the form buttons (Browse / Generate key) and the key dialog (needs a display: xvfb-run)
GWC_KEY_DIR=$(mktemp -d) XDG_CONFIG_HOME=$(mktemp -d) GWC_LANG=en xvfb-run -a gjs -m tests/ui.test.js
# GitHub publishing: Python tests and the UI flow, both against a fake GitHub (tests/fake_github.py), no network
python3 -m unittest discover -s tests -p 'test_publish.py'   # includes the folder-in-existing-site mode
xvfb-run -a gjs -m tests/publish_ui.test.js
# page screenshots
bin/gwc-repo-maker --repo DIR --screenshots OUTDIR
```
Not covered: the real GitHub (only a fake of its API is tested), the GTK file chooser dialogs themselves (the tests replace the chooser with a fixed path).

## License
GPL-3.0, see `LICENSE`.
