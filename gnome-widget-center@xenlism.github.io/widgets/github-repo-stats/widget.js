import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import Soup from "gi://Soup?version=3.0";

import { SHADOW_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

const API_BASE = "https://api.github.com";

// Unauthenticated GitHub REST calls are capped at 60/hour per IP - the
// config.json min for refreshInterval is 5 minutes, but keep a hard
// floor here too in case settings ever end up with something smaller
// or non-numeric.
const MIN_REFRESH_MINUTES = 5;

// How long to wait, after the user stops typing in owner/repo (or the
// token field), before actually firing a fetch - see WIDGET_API.md §3
// and the brief for why: config.json's "text"/"password" fields save on
// every keystroke, and re-fetching on every one of those would burn
// through the unauthenticated rate limit almost immediately.
const SETTINGS_DEBOUNCE_MS = 800;

const REPO_PATH_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function _formatCount(n) {
    if (!Number.isFinite(n)) return "-";
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
    return `${n}`;
}

export default class GithubRepoStatsWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
        this._debounceId = null;
        this._httpSession = null;
        this._lastRepoPath = null;
        this._lastToken = null;
        // "loading" | "error" | "loaded"
        this._state = "loading";
        this._errorMessage = "";
        this._data = {
            stars: null,
            forks: null,
            issues: null,
            releaseTag: null
        };
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "github-repo-stats-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: "spacing: 6px;"
        });
        this._layers.content.add_child(this._content);
        this._repoLabel = new St.Label({
            style_class: "github-repo-stats-widget-repo"
        });
        this._repoLabel.clutter_text.set_line_wrap(false);
        this._statsRow = new St.BoxLayout({
            vertical: false,
            style: "spacing: 16px;"
        });
        this._starsLabel = new St.Label;
        this._forksLabel = new St.Label;
        this._issuesLabel = new St.Label;
        this._releaseLabel = new St.Label;
        for (const label of [ this._starsLabel, this._forksLabel, this._issuesLabel, this._releaseLabel ]) {
            label.clutter_text.set_line_wrap(false);
            this._statsRow.add_child(label);
        }
        this._statusLabel = new St.Label({
            style_class: "github-repo-stats-widget-status"
        });
        this._statusLabel.clutter_text.set_line_wrap(true);
        this._content.add_child(this._repoLabel);
        this._content.add_child(this._statsRow);
        this._content.add_child(this._statusLabel);
        // buildActor() must never throw and must never block on the
        // network (WIDGET_API.md §3) - render the placeholder/loading
        // state synchronously first, kick the actual fetch off async.
        this._render();
        this._refresh();
        return this._actor;
    }
    enable() {
        this._restartTimer();
    }
    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._debounceId !== null) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        this._httpSession = null;
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS
        };
    }
    onSettingsChanged() {
        this._render();
        const repoPath = this._settings.repoPath ?? "";
        const token = this._settings.githubToken ?? "";
        if (repoPath !== this._lastRepoPath || token !== this._lastToken) this._scheduleDebouncedRefresh(); else this._restartTimer();
    }
    _scheduleDebouncedRefresh() {
        if (this._debounceId !== null) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTINGS_DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }
    _restartTimer() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        const minutesRaw = this._settings.refreshInterval;
        const minutes = Number.isFinite(minutesRaw) && minutesRaw >= MIN_REFRESH_MINUTES ? minutesRaw : Math.max(MIN_REFRESH_MINUTES, 15);
        const seconds = Math.round(minutes * 60);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _getHttpSession() {
        if (!this._httpSession) this._httpSession = new Soup.Session;
        return this._httpSession;
    }
    async _fetchJson(url, token) {
        const session = this._getHttpSession();
        const message = Soup.Message.new("GET", url);
        if (!message) throw new Error(`invalid URL: ${url}`);
        // GitHub's REST API always requires a User-Agent, and rejects
        // requests without one.
        message.get_request_headers().append("User-Agent", "gnome-widget-center-github-repo-stats");
        if (token) message.get_request_headers().append("Authorization", `Bearer ${token}`);
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        const status = message.get_status();
        const text = new TextDecoder("utf-8").decode(bytes.get_data());
        if (status !== Soup.Status.OK) {
            const err = new Error(`HTTP ${status} for ${url}`);
            err.status = status;
            throw err;
        }
        return JSON.parse(text);
    }
    async _refresh() {
        const repoPath = (this._settings.repoPath ?? "").trim();
        const token = (this._settings.githubToken ?? "").trim();
        this._lastRepoPath = this._settings.repoPath ?? "";
        this._lastToken = this._settings.githubToken ?? "";
        if (!REPO_PATH_PATTERN.test(repoPath)) {
            this._state = "error";
            this._errorMessage = "Set a repository as owner/name";
            this._render();
            return;
        }
        this._state = "loading";
        this._render();
        try {
            const repo = await this._fetchJson(`${API_BASE}/repos/${repoPath}`, token);
            this._data.stars = repo.stargazers_count ?? null;
            this._data.forks = repo.forks_count ?? null;
            this._data.issues = repo.open_issues_count ?? null;
            // A separate call, on purpose (WIDGET_API.md brief): a repo
            // with no releases 404s here even though the repo itself
            // loaded fine, so this must never throw out of _refresh() -
            // just hide the release row.
            try {
                const release = await this._fetchJson(`${API_BASE}/repos/${repoPath}/releases/latest`, token);
                this._data.releaseTag = release.tag_name ?? null;
            } catch (releaseError) {
                this._data.releaseTag = null;
                this._api.logger.info(`github-repo-stats: no latest release for ${repoPath}: ${releaseError}`);
            }
            this._state = "loaded";
        } catch (e) {
            this._state = "error";
            if (e.status === 403) this._errorMessage = "Rate limited by GitHub - add a token or wait"; else if (e.status === 404) this._errorMessage = "Repository not found"; else this._errorMessage = "Couldn't reach GitHub";
            this._api.logger.info(`github-repo-stats: refresh failed for ${repoPath}: ${e}`);
        }
        this._render();
    }
    _render() {
        const cardColor = this._settings.cardColor ?? "#1c1f26ff";
        const cornerRadius = Number.isFinite(this._settings.cornerRadius) ? this._settings.cornerRadius : 18;
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorKey: "cardColor",
            backgroundColorFallback: cardColor,
            cornerRadiusFallback: cornerRadius
        }, false);
        this._content.set_style("padding: 16px 20px;");
        const repoPath = (this._settings.repoPath ?? "").trim() || "owner/repo";
        this._repoLabel.set_text(repoPath);
        this._repoLabel.set_style("color: #ffffff; font-size: 15px; font-weight: bold; font-family: Sans;");
        const showStars = this._settings.showStars ?? true;
        const showForks = this._settings.showForks ?? true;
        const showIssues = this._settings.showIssues ?? true;
        const showRelease = (this._settings.showLatestRelease ?? true) && !!this._data.releaseTag;
        const loaded = this._state === "loaded";
        this._starsLabel.set_text(`\u2b50 ${loaded ? _formatCount(this._data.stars) : "--"}`);
        this._forksLabel.set_text(`\ud83c\udf74 ${loaded ? _formatCount(this._data.forks) : "--"}`);
        this._issuesLabel.set_text(`\ud83d\udc1b ${loaded ? _formatCount(this._data.issues) : "--"}`);
        this._releaseLabel.set_text(`\ud83c\udff7\ufe0f ${this._data.releaseTag ?? ""}`);
        for (const [ label, visible ] of [ [ this._starsLabel, showStars ], [ this._forksLabel, showForks ], [ this._issuesLabel, showIssues ], [ this._releaseLabel, showRelease ] ]) {
            label.visible = visible;
            label.set_style("color: #e6e6e6; font-size: 13px; font-family: Sans;");
        }
        this._statsRow.visible = this._state !== "error";
        if (this._state === "loading") {
            this._statusLabel.set_text("Loading\u2026");
            this._statusLabel.visible = true;
        } else if (this._state === "error") {
            this._statusLabel.set_text(this._errorMessage);
            this._statusLabel.visible = true;
        } else {
            this._statusLabel.set_text("");
            this._statusLabel.visible = false;
        }
        this._statusLabel.set_style("color: #f2b544; font-size: 12px; font-family: Sans;");
    }
}
