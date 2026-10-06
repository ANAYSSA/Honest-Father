<p align="center">
  <img src="https://raw.githubusercontent.com/ANAYSSA/Honest-Father/8732eb477a24aa01cc789ac0df77f20a94a19433/src/assets/logo.png" alt="Honest Father" width="160" height="160" />
</p>

<h1 align="center">Honest Father</h1>

Honest Father is an open-source assistant for mock interviews, exam preparation, and learning, forked from Cheating Daddy.

## New in 0.11.0

- Choose **Gemini API** or **ChatGPT account** before **Start Session**. Groq controls are removed from Home; the existing Test Review provider path is preserved.
- **Continue with ChatGPT** opens official account authorization in the system browser. Choose Google there to use your Gmail account. Eligible Plus/Pro accounts can use their ChatGPT plan; no separate OpenAI API key is required. You can sign out or connect another account.
- The model picker uses the account’s live catalog. GPT-5.6 Instant is preferred if it is actually listed; otherwise an available fast model is selected. Supported GPT-6 models expose a separate **Pro** mode, which is slower. Model access depends on the account.
- ChatGPT starts with screenshots and text. Gemini voice transcription is optional and off by default, so a saved Gemini key does not delay ChatGPT startup. Responses stream immediately as text arrives, with a cached model catalog, bounded text context, and no re-upload of old screenshots.
- Duplicate requests are blocked while a reply is in flight. Closing a session aborts the request; interrupted streams are never silently replayed. Temporary pre-stream service failures have one bounded retry. Response time depends on the model, network, and provider load; 4–5 seconds is not guaranteed.
- ChatGPT tokens are encrypted using the operating system’s credential protection and remain in the main process. Sign-in verifies PKCE, state, nonce and ID-token signature; renewal is serialized. A single running instance prevents rotating-token and shortcut conflicts.
- Test Review, its mark appearance and shortcuts, and the persistent macOS signing identity are unchanged.

## New in 0.10.8

- Fixed Test Review rejecting an unchanged question layout after a successful AI reply, which left the answer marker hidden. Frame matching keeps the checks that hide changed or off-screen questions.
- Gemini screenshot requests now use Electron’s system-aware networking, including model discovery and streaming replies, with bounded timeouts and cancellation. Temporary failures retain safe diagnostic codes without logging keys or screenshot contents.
- **Command + \\ / Ctrl + \\** shows or hides the app window in both modes. **Command + Shift + \\ / Ctrl + Shift + \\** independently toggles Test Review marks or stored notices. Both shortcuts can be customized.
- **Customize → Appearance** now includes saved marker color and opacity (10–100%). Changes apply to existing marks immediately without revealing hidden ones.
- macOS activation no longer unexpectedly restores the main window during Test Review.
- Review instructions explicitly request only the chosen correct option, with one choice by default unless the question allows multiple selections. AI answers still require verification.
- Local scroll tracking and the question cache continue to work without additional AI calls or browser integration. The persistent macOS signing identity is unchanged.

## New in 0.10.7

- Test Review now reads fresh, cursor-free snapshots of the selected display. Snapshot, post-answer validation, and local scroll tracking share the same native pixel source, without relying on a hidden video element.
- Local frames keep one pixel per display point, so integer scroll movements do not introduce scaling differences. Only the JPEG sent to AI is resized by the image-quality setting; cache hits skip JPEG encoding and upload entirely. Local frames are bounded to 16 megapixels.
- Capture requests are serialized through native completion, with bounded deadlines and session/display checks. Late or changed frames cannot reveal stale answer marks.
- macOS annotation windows keep the full display bounds when shown, including areas near the menu bar and Dock. Bounds are checked again after the window opens.
- Answer controls are located from their visible shape and size, including round, square, and styled controls. Uncertain locations are rejected; AI answers still need verification.
- The browser is unchanged: ordinary screen capture and a separate annotation window require no extension or injected script. Scroll tracking and cached answers stay local and use no extra AI calls.
- The macOS signing certificate, existing interface, and keyboard shortcuts are preserved.

## New in 0.10.5

- Gemini screenshot requests now check the model catalogue for your API project. Both normal screenshots and Test Review use the same resolver, and Live sessions check their own supported method.
- New model settings use `auto`. Existing supported custom IDs are preserved; unavailable selections can use an available catalogue model. No manual model change is required for the usual unavailable-model case.
- Model metadata is cached and concurrent catalogue requests are deduplicated. Only an explicit model mismatch before a response can try one alternative. Quota and authentication failures do not rotate models or repeatedly upload your screenshot.
- Errors and progress notices no longer pop up over your screen. **Command+Backslash / Ctrl+Backslash** shows or hides a stored Test Review notice; stale answer marks stay hidden during errors.
- The persistent macOS signing certificate from 0.10.4 is unchanged, so this update retains the same Screen Recording identity.

## Capture signing improved in 0.10.4

- Published macOS apps now use a persistent, certificate-bound signing identity. Updates signed with this certificate can retain Screen Recording authorization instead of becoming a new ad-hoc identity on each build.
- One-time migration: fully quit old copies, remove the old Honest Father entry from Screen & System Audio Recording, then add and authorize the newly installed 0.10.4 app. Future releases must keep the same signing certificate.
- Capture diagnostics preserve the original source/request failure instead of hiding every failure behind permission advice.

## Capture improvements in 0.10.3

- Screen capture starts at the display’s native proportions. Optional low frame rates are applied after the stream opens; unsupported rate settings no longer prevent capture.
- macOS capture failures retain the original screen-source error and check the running app’s permission status. A failed source is no longer mislabeled as invalid capture parameters or always treated as a disabled permission.
- Native media negotiation is now tested in Electron on both platforms, including ordinary and Test Review starts, cancellation, and macOS source rejection.

## Test Review introduced in 0.10.2

- Two start buttons: **Start Session** for the existing flow and **Start Test Review** for multiple-choice practice.
- Test Review circles the proposed correct radio button or checkbox on screen. Command+Enter / Ctrl+Enter captures a question; Command+Backslash / Ctrl+Backslash hides or shows its marks. It does not click or submit answers.
- Local scroll tracking moves the marks without further AI requests. Unmatched or off-screen questions hide the marks; scrolling back can restore them.
- Up to three questions are cached in memory during the session, with a 32 MiB image budget. Repeated matching captures reuse the answer without encoding or uploading another screenshot.
- Strict complete JSON, confidence and coordinate validation, fresh-frame checks, and display/session guards prevent malformed or stale results from being drawn.
- Test Review uses the configured Gemini or Groq vision provider without Live/audio. Local AI does not support this mode. AI can still make mistakes; verify proposed answers while studying.

## Included improvements

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

Published macOS builds use a verified persistent project certificate, but are not Developer ID signed or notarized; approval in System Settings → Privacy & Security may still be required. Windows builds are unsigned and may display SmartScreen. Allow Screen Recording and Microphone permissions when using capture.

Google quotas apply to the API project; Groq quotas depend on the account and model. The application cannot increase provider quotas. Local AI mode can work without external AI API calls after the required runtime and models are downloaded.

Source and license: https://github.com/ANAYSSA/Honest-Father. Upstream: https://github.com/sohzm/cheating-daddy (GPL-3.0).
