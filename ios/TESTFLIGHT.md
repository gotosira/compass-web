# TestFlight: Compass iOS

## One-time setup
1. Install tools:
   - `brew install fastlane`
   - `xcode-select -s /Applications/Xcode.app/Contents/Developer`
2. In App Store Connect, create an API Key (Users and Access > Keys).
   - Download the `.p8` file. Copy its contents to clipboard and base64 encode:
     ```bash
     base64 -i AuthKey_XXXXXX.p8 | tr -d '\n'
     ```
3. Create `ios/fastlane/.env` with your values (see below).

Example `ios/fastlane/.env`:
```
ASC_KEY_ID=YOUR_KEY_ID
ASC_ISSUER_ID=YOUR_ISSUER_ID
ASC_KEY_CONTENT=BASE64_P8_CONTENT
TF_DISTRIBUTE_EXTERNAL=false
TF_GROUPS=Internal
TF_NOTIFY_TESTERS=false
TF_CHANGELOG=First beta build
APPLE_ID=you@example.com
APP_STORE_CONNECT_TEAM_ID=123456789
DEVELOPER_PORTAL_TEAM_ID=ABCDE12345
```

## Upload a build to TestFlight
```bash
cd "$(dirname "$0")"
# From repo root:
cd ios
fastlane beta
```
- Increments build number, archives, uploads, and waits for processing.

## Internal vs External testing
- Internal: team members, available immediately.
- External: set `TF_DISTRIBUTE_EXTERNAL=true` and provide tester groups; Apple performs Beta App Review.

## Troubleshooting
- Code signing: in Xcode, set Team on the `Compass` target and ensure Bundle ID matches `com.sira.Compass`.
- Processing stuck: check App Store Connect > TestFlight processing status; try again if Apple services are delayed.
- Location permission: heading requires real device sensors; Simulator won’t rotate.
