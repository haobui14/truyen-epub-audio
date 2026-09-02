# TruyệnAudio private Android releases

The first release-signed install intentionally cannot update a debug-signed
install. Before the one-time migration, let account progress finish syncing.
Then uninstall the debug app, install the signed release APK, sign in, and
download offline books again. Every later APK signed by this same key updates
in place.

## Create and protect the permanent key

Run this once on a trusted machine (outside the repository):

```sh
keytool -genkeypair -v -keystore truyenaudio-release.jks \
  -alias truyenaudio -keyalg RSA -keysize 4096 -validity 10000
```

Back up the keystore and passwords in two secure locations. Losing the key
means Android will reject updates to `com.truyenaudio.app` and another
uninstall/reinstall will be required. Never commit the keystore.

Configure these GitHub Actions secrets:

- `ANDROID_KEYSTORE_B64`: base64 of the complete `.jks` file
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `RCLONE_CONF_B64` (optional Drive publishing)

The workflow derives `versionName` from `frontend/package.json` and computes
`versionCode` as `major × 1,000,000 + minor × 1,000 + patch`. It publishes an
immutable versioned APK, a stable latest APK, and JSON metadata containing the
checksum, commit, version code, and release note.

After publishing, set the backend `ANDROID_LATEST_VERSION`,
`ANDROID_VERSION_CODE`, `ANDROID_DOWNLOAD_URL`, and `ANDROID_APK_SHA256` values.
Set `ANDROID_MIN_SUPPORTED_VERSION` only when older builds must stop being
dismissible. Verify the downloaded APK against `sha256` in `release.json`.
