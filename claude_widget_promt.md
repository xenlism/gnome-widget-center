# Example Prompts — GNOME Widget Center Widget Creation

Two example prompts for creating new widgets for `gnome-widget-center`, following `WIDGET_API.md`.

---

## Example 1: `github-repo-stats`

Create a new widget called **"github-repo-stats"** for gnome-widget-center, following `WIDGET_API.md`.

This widget fetches repo data from the GitHub REST API (default: `xenlism/gnome-widget-center`) and displays ⭐ stars / 🍴 forks / 🐛 open issues / latest release tag.

### File structure (`widgets/github-repo-stats/`):
- `metadata.json`, `widget.js`, `config.json`, `icon.svg`

### 1. `metadata.json`
- `id`: `"github-repo-stats"`, `block-type`: `"2x1"`
- No need to declare dependencies (uses Soup, which is a `gi://` binding, not a system binary)

### 2. `widget.js` — implement the full §3 lifecycle (constructor / buildActor / enable / disable / getDefaultSettings / onSettingsChanged)
- Fetch data using libsoup3, following the exact pattern already used in `widgets/weather-dark/widget.js`:
  ```js
  import Soup from "gi://Soup?version=3.0";
  _getHttpSession() { ... new Soup.Session ... }
  async _fetchJson(url) {
      const message = Soup.Message.new("GET", url);
      const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
      if (message.get_status() !== Soup.Status.OK) throw new Error(...);
      return JSON.parse(new TextDecoder("utf-8").decode(bytes.get_data()));
  }
  ```
- Endpoint: `https://api.github.com/repos/{owner}/{repo}`
  - If a token is present in settings, add header `Authorization: Bearer <token>` and `User-Agent` (the GitHub API always requires a `User-Agent`).
  - Latest release: fetch separately from `https://api.github.com/repos/{owner}/{repo}/releases/latest` (a separate call, may 404 if the repo has never published a release — must be caught and that row simply hidden, not thrown, so it doesn't break the widget).
- Auto-refresh every N minutes based on `settings.refreshInterval` using `GLib.timeout_add`; cancel it in `disable()`.
- Must handle 3 states: **loading** (before the first data arrives), **error** (network failure / 403 rate-limit / 404 repo not found — show a short message, do not throw and break `buildActor()`), and **loaded**.
- `buildActor()` must return a placeholder immediately and update it later, per §3 ("Must NEVER throw, even with empty settings... return a placeholder and update it later").
- Remember: the unauthenticated GitHub API is limited to 60 requests/hour per IP — so the default `refreshInterval` should be at least 15 minutes, and debounce so `onSettingsChanged` doesn't fire a fetch on every keystroke while the user types into the owner/repo field.

### 3. `config.json`
- `repoPath`: `fieldType` `"text"`, label `"Repository (owner/name)"`, default `"xenlism/gnome-widget-center"`, with a pattern validating the `owner/repo` format
- `githubToken`: `fieldType` `"password"`, id must contain the word `"token"` (e.g. `"githubToken"`) — **important**: `lib/secretFields.js` automatically redacts any field whose id/label contains the word token/password/secret/apikey when exporting to a `.gwct` theme pack, so name the field this way to prevent the token from leaking into exported files.
- `refreshInterval`: `fieldType` `"spinbutton"`, `dataType` `"integer"`, min 5, max 1440, suffix `"min"`, default 15
- `showStars` / `showForks` / `showIssues` / `showLatestRelease`: `fieldType` `"switch"`, all 4, default `true`
- Use `visibleIf` to bind sub-fields if needed, e.g. if a field should only appear in a special case.

### 4. Write error handling so the widget "can never crash badly enough to break the desktop," per the mandatory rule in §3 — every point that can throw (fetch failure, JSON parse failure, rate limit) must have try/catch and switch the actor to an error state instead.

**After writing the code, run `node --check` on every created file, then summarize which `config.json` fields will be automatically redacted when exporting a theme.**

---

## Example 2: `daily-quote`

Create a new widget called **"daily-quote"** for gnome-widget-center, following `WIDGET_API.md`.

### Desired file structure (`widgets/daily-quote/`):
- `metadata.json`
- `widget.js`
- `config.json`
- `icon.svg` (if feasible)

### Details:

**1. `metadata.json`**
- `id`: `"daily-quote"`, `name`: `"Daily Quote"`
- `block-type`: `"2x1"` (see the cols×rows table in `WIDGET_API.md` §2)
- No dependencies needed

**2. `widget.js`**
- Display a single short quote line from a list of quotes hardcoded in the file (no network access needed).
- Pick a new random quote every N minutes according to `settings.refreshInterval` (using `GLib.timeout_add`).
- Must disconnect/remove all timers in `disable()`, per the "Must-follow rules" in §3.
- Draw the card background + shadow using `cardStyleCss()` / `applyLayeredCardStyle()` from `lib/widgetVisualKit.js`, `lib/cardLayers.js` (see the pattern in `widgets/weather-dark/widget.js`).
- Do NOT import Gtk in `widget.js` (it runs in the Shell process).

**3. `config.json`** (tabs → groups → fields per §6.4)
- `fontSize`: `fieldType` `"spinbutton"`, `dataType` `"integer"`, min 12, max 48, default 18
- `textColor`: `fieldType` `"colorpicker"`
- `backgroundColor`: `fieldType` `"colorpicker"`, `alpha: true`
- `refreshInterval`: `fieldType` `"spinbutton"`, `dataType` `"integer"`, min 1, max 1440, suffix `"min"`, default 30
- `autoRotate`: `fieldType` `"switch"`, `dataType` `"boolean"`, default `true` (when off, keep showing the current quote instead of auto-rotating)

**4.** `getDefaultSettings()` in `widget.js` must match every field in `config.json` exactly (see the "Orphaned defaults extractor" bug example in `SKILL.md` for a case of exactly this kind of mistake to avoid).

**After writing the code, run `node --check` on every created file.**
