Honest Father is an open-source assistant for mock interviews, exam preparation, and learning, forked from Cheating Daddy.

- Restored automatic display capture without the macOS system screen picker. macOS Screen Recording permission is still required.
- macOS builds run without a Dock icon, including during startup, while preserving window visibility and keyboard shortcuts.
- The API-mode heading now reads Honest Father ANAYSSA.
- Updated Gemini Live integration, clearer API errors, bounded retries, and session recovery.
- Configurable Live and screenshot models, with project quota errors reported accurately.
- Command+Enter on macOS or Ctrl+Enter on Windows starts a screen-only session from Home and immediately analyzes a screenshot. Repeated presses analyze the next screenshot without a Live/audio connection. Start Session remains available for audio and Live sessions.
- Configurable shortcut to quit the application: Command+Shift+Q on macOS, Ctrl+Shift+Q on Windows.
- Session cleanup and a bounded exit deadline prevent a stalled transport from keeping the application running after Quit.
- Honest Father branding and separate local settings.
- User-provided Honest Father artwork for the app icon, with the existing interface layout preserved.
- macOS Apple Silicon DMG/ZIP packages; Windows x64 installer and portable ZIP.
- macOS audio helper rebuilt from included Swift source for Apple Silicon.
- Fixed invalid macOS bundle signatures after renaming Electron: the final app, nested helpers/frameworks, and audio helper are re-signed and verified before release.

Choose `macos-arm64` for Apple Silicon, or `windows-x64` for Windows. `*-SHA256SUMS.txt` files contain download checksums.

macOS builds have a verified ad hoc signature, but are not Developer ID signed or notarized; approval in System Settings → Privacy & Security may still be required. Windows builds are unsigned and may display SmartScreen. Allow Screen Recording and Microphone permissions when using capture.

Google quotas apply to the API project; Groq quotas depend on the account and model. The application cannot increase provider quotas. Local AI mode can work without external AI API calls after the required runtime and models are downloaded.

Source and license: https://github.com/ANAYSSA/Honest-Father. Upstream: https://github.com/sohzm/cheating-daddy (GPL-3.0).
