# Manual test checklist — force/appearance, .gwct, .gwcbak

Uses `widgets/qa-test-widget` (see its README.md). Enable it from the
Store/Overview page before starting. An automated suite covering the
same logic lives in `/testsuite/` — run with:

    cd testsuite && node --import ./register.mjs run-tests.mjs

That suite proves the underlying logic (secret redaction, dependency
checks, AES/PBKDF2 round-trips) against real file I/O and a real `tar`.
It can't click through GTK dialogs — that's what this checklist is for.

## 1. Force (background-color / corner-radius)

- [ ] Preferences → Appearance → set a background color, turn its
      **Force** switch on.
- [ ] Open qa-test-widget's own appearance settings — the background
      row should be disabled/greyed and show the global color, not
      whatever was there before.
- [ ] Turn Force off — qa-test-widget's own background row becomes
      editable again and keeps its own value.
- [ ] Repeat both steps for **corner radius**.
- [ ] Confirm the widget on the desktop visually reflects whichever is
      in effect (forced global vs per-widget).

## 2. Dependency checking (qa-test-widget)

- [ ] qa-test-widget declares one dependency that's always present
      (`bash`) and one that never exists
      (`gwc-qa-nonexistent-binary`) — see its metadata.json.
- [ ] Trigger a dependency check on it (via `.gwct` import or `.gwcbak`
      restore, below) and confirm the report shows `bash` as fine and
      `gwc-qa-nonexistent-binary` as missing, with a suggested install
      command.

## 3. `.gwct` export

- [ ] Set qa-test-widget's `apiKey`, `contactEmail`, `accountUsername`,
      and one `accounts[]` entry's `accessToken` to obviously-fake
      values, plus a `plainNote`.
- [ ] Preferences → Import / Export → **Export theme…** → save a
      `.gwct` file.
- [ ] Open the saved file in a text editor. Confirm:
  - [ ] `apiKey`, `contactEmail`, `accountUsername`, and every
        `accounts[].accessToken` are ABSENT.
  - [ ] `plainNote` and `displayLabel` ARE present, unchanged.
  - [ ] `accounts[].name` is present (only `accessToken` stripped).
  - [ ] No widget code/files are embedded — just JSON.
- [ ] The report dialog after export lists which fields were left out.

## 4. `.gwct` import

- [ ] Change the global background color and qa-test-widget's
      `displayLabel` to something different.
- [ ] Import / Export → **Import theme…** → pick the file from step 3.
- [ ] Confirm the background color and `displayLabel` revert to the
      exported values.
- [ ] Confirm the dependency-warning report mentions
      `gwc-qa-nonexistent-binary`.
- [ ] Rename/disable qa-test-widget's folder, then import the same
      `.gwct` again — confirm it's reported as "skipped, not installed
      here" rather than silently doing nothing or erroring.

## 5. `.gwcbak` backup

- [ ] Preferences → Backup & Restore → **Create backup…** → enter a
      password → save a `.gwcbak` file.
- [ ] Confirm the report shows the widget count and the file exists.
- [ ] Open the file in a hex viewer — first 7 bytes should read
      `GWCBAK2` (ASCII); the rest should look like random bytes, not
      readable JSON/tar (i.e. it's actually encrypted).

## 6. `.gwcbak` restore

- [ ] Restore the file from step 5 using the **wrong** password —
      confirm you get a clear "incorrect password" error, not a crash
      or a silent no-op.
- [ ] Restore it with the correct password. Confirm:
  - [ ] `apiKey`/`accessToken` values ARE restored this time (full
        backup keeps secrets, unlike `.gwct`).
  - [ ] Global appearance and gsettings (e.g. disabled-widgets,
        dev-mode) are restored.
  - [ ] If you deleted qa-test-widget's folder first, its files are
        recreated on disk (not just its settings).
  - [ ] The dependency-warning report again mentions
        `gwc-qa-nonexistent-binary`.

## 7. Edge cases / known gaps to watch for

- [ ] Very large `accounts[]` list or large widget folder — backup
      creation shouldn't hang the Preferences window indefinitely
      (it *will* block briefly — there's no progress bar yet, see
      CHANGES.md's "known limitations").
- [ ] Cancelling any file-picker or password dialog mid-flow should
      abort cleanly with no partial file left behind.
- [ ] Neither `.gwct` import nor `.gwcbak` restore currently ask
      "this will overwrite your current settings, continue?" before
      applying — confirm this is acceptable for your workflow, or flag
      it if you'd like a confirmation step added.

## 8. Weather Dark alignment (this session's bug report)

- [ ] Enable the `weather-dark` widget at a few different block sizes
      (if resizable) or just at its default size.
- [ ] Confirm the temperature/condition text + icon are vertically
      centered within the card, not pinned to the top.
- [ ] If you still see a specific error (not just a visual
      misalignment) — please paste the exact message/stack trace from
      `journalctl -f` or Looking Glass (`Alt+F2`, `lg`) if it recurs;
      static review found the alignment code correct but the root
      actor was missing `x_expand`/`y_expand`, which I've added — that
      may or may not have been the whole story.
