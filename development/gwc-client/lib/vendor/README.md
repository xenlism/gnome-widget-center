# vendor/

`noble-ed25519.js` is `@noble/ed25519@3.2.0` `index.js`, copied **unmodified** from the npm tarball
(https://registry.npmjs.org/@noble/ed25519/-/ed25519-3.2.0.tgz). MIT, see `noble-ed25519.LICENSE`.

    sha256(noble-ed25519.js) = a4f631d1876b5d9e43a86cd71194ca27b5e1451edf4ba4db9a418f40a475569a

To update: download the new tarball, replace the file, update the version + hash above, re-run
`node --test tests/` and re-check that the library still needs no globals other than `BigInt`/`Uint8Array`.
SHA-512 is injected by the caller (`ed.hashes.sha512`), so no WebCrypto is needed inside GJS.
