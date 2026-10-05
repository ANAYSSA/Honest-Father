Honest Father is an open-source assistant for mock interviews, exam preparation, and learning, forked from Cheating Daddy.

- Updated Gemini Live integration, clearer API errors, bounded retries, and session recovery.
- Configurable Live and screenshot models, with project quota errors reported accurately.
- Command+Enter on macOS or Ctrl+Enter on Windows starts a screen-only session from Home and immediately analyzes a screenshot. Repeated presses analyze the next screenshot without a Live/audio connection. Start Session remains available for audio and Live sessions.
- Configurable shortcut to quit the application: Command+Shift+Q on macOS, Ctrl+Shift+Q on Windows.
- Honest Father branding and separate local settings.
- User-provided Honest Father artwork for the app icon, with the existing interface layout preserved.
- macOS Apple Silicon DMG/ZIP packages; Windows x64 installer and portable ZIP.
- macOS audio helper rebuilt from included Swift source for Apple Silicon.

Choose `macos-arm64` for Apple Silicon, or `windows-x64` for Windows. `*-SHA256SUMS.txt` files contain download checksums.

These builds are unsigned. macOS may require approval in System Settings → Privacy & Security, and Windows may display SmartScreen. Allow Screen Recording and Microphone permissions when using capture.

Google and Groq quotas are account-level limits; the application cannot increase them. Local AI mode can work without external AI API calls after the required runtime and models are downloaded.

Source and license: https://github.com/ANAYSSA/Honest-Father. Upstream: https://github.com/sohzm/cheating-daddy (GPL-3.0).
