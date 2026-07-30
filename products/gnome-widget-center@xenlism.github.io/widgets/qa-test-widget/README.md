# qa-test-widget

Not a real desktop widget — this exists purely so the force/appearance
system, `.gwct` theme export/import, and `.gwcbak` backup/restore have
something concrete to test against. See `/checklist.md` at the repo
root for the manual test plan that uses it, and `/testsuite/` for the
automated tests.

Safe to disable or delete once you're done testing — nothing else in
the extension depends on it.

What it's deliberately shaped to exercise:

- `themeable: true` — so it participates in the global "Force" switches.
- `metadata.json`'s `dependencies.system` — one entry (`bash`) that will
  always resolve, one (`gwc-qa-nonexistent-binary`) that never will, so
  both the "satisfied" and "missing" dependency-check paths are visible
  in one widget.
- `config.json` fields covering every way `lib/secretFields.js` decides
  something is a secret: an explicit `fieldType: "password"`, an
  explicit `format: "email"`, a plain `text` field whose NAME alone
  looks like a credential (`accountUsername`), and a secret nested two
  levels down inside a `list` of `object`s (`accounts[].accessToken`) —
  plus a couple of ordinary fields that must survive export untouched.
- An "All Field Types" tab (`field-types`) — one field per `fieldType`
  config.json supports (switch, checkbox, dropdown, radio, spinbutton,
  slider, colorpicker, fontpicker, iconpicker, filepicker,
  folderpicker), plus a plain (non-object) `list` of strings to exercise
  the "+" add control below the list separately from the nested-object
  list above. `autocomplete` isn't included here since it needs its own
  `autocomplete.js` hook (see weather-minimal/weather-dark for a real
  example) rather than a static default.
