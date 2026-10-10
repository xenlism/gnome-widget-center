# keys/ - trusted public keys of the official store

Put **public** keys here, one `.json` file per key (or one file holding an array):

```json
{ "kid": "gwc-2026-a", "pub": "<base64 ed25519 public key, 44 chars>" }
```

- `kid` and `pub` come from `tools/gwc_keygen.py`, or from the `kid` / `pub` fields of the store's `store.json.sig`.
- They are loaded when the extension starts (log out/in, or reload the shell on X11, after changing them).
- Keep the NEXT key here too, one release before you sign with it, so rotating never needs a flag day.
- **NEVER put a private key here.** Public keys are safe to publish; a private key lets anyone sign a fake store.
