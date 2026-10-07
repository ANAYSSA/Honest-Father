<p align="center">
  <img src="https://raw.githubusercontent.com/ANAYSSA/Honest-Father/8732eb477a24aa01cc789ac0df77f20a94a19433/src/assets/logo.png" alt="Honest Father" width="160" height="160" />
</p>

<h1 align="center">Honest Father</h1>

An open-source desktop AI assistant for mock interviews, exam preparation, and learning. Honest Father is a fork of [Cheating Daddy](https://github.com/sohzm/cheating-daddy) by [sohzm](https://github.com/sohzm) and its contributors, distributed under GPL-3.0.

## Downloads

Download packages from [Honest Father Releases](https://github.com/ANAYSSA/Honest-Father/releases/latest).

| Computer                                      | Download                                                           |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Mac with Apple Silicon (M1/M2/M3/M4 or newer) | `Honest-Father-<version>-macos-arm64.dmg` or `.zip`                |
| Windows x64                                   | `Honest-Father-<version>-windows-x64-Setup.exe` or portable `.zip` |

For macOS, open the DMG and drag **Honest Father** to Applications. On Windows, run the installer or extract the portable ZIP and launch `HonestFather.exe`.

Requires macOS 13 or later, or 64-bit Windows 10/11.

Published macOS builds use the same project signing certificate across versions, so updates can retain their privacy authorization. They are not Developer ID signed or notarized, so macOS may require approval under **System Settings → Privacy & Security**. Windows builds are unsigned and may show SmartScreen. Each platform includes a `SHA256SUMS.txt` file for verifying downloads. Linux packaging is outside the scope of this fork's release workflow.

## What changed in 0.11.1

- Answers and History now render Markdown and mathematical notation locally: Θ, Ω, powers, logarithms, fractions and displayed equations. Fonts are bundled; rendering makes no network requests.
- New **Test Visibility** page: **Blind mode — answers only**, separate text and answer-frame opacity from **0–100%**, and optional bold question numbers and answer letters. Blind mode hides waiting text, status, navigation and input controls; the window is empty until an answer arrives.
- **Command + Shift + , / Ctrl + Shift + ,** opens readable visibility settings even when the answer is invisible or the window is hidden. **Return to session** keeps capture and answers running. Existing show/hide and Review-marker shortcuts are preserved.
- History includes **Copy answer**, model labels for newly recorded answers/sessions, and **Clear history** with confirmation. Copy preserves the original response. Clearing history preserves API keys, account sign-in and preferences. Older records without model metadata say **Model not recorded**.
- Test Review markers, provider choices and the persistent macOS signing identity are unchanged.

## What changed in 0.11.0

- Choose **Gemini API** or **ChatGPT account** before **Start Session**. Groq controls are removed from Home; the existing Test Review provider path is preserved.
- **Continue with ChatGPT** opens official account authorization in the system browser. Choose Google there to use your Gmail account. Eligible Plus/Pro accounts can use their ChatGPT plan; no separate OpenAI API key is required. You can sign out or connect another account.
- The model picker uses the account’s live catalog. GPT-5.6 Instant is preferred if it is actually listed; otherwise an available fast model is selected. Supported GPT-6 models expose a separate **Pro** mode, which is slower. Model access depends on the account.
- ChatGPT starts with screenshots and text. Gemini voice transcription is optional and off by default, so a saved Gemini key does not delay ChatGPT startup. Responses stream immediately as text arrives, with a cached model catalog, bounded text context, and no re-upload of old screenshots.
- Duplicate requests are blocked while a reply is in flight. Closing a session aborts the request; interrupted streams are never silently replayed. Temporary pre-stream service failures have one bounded retry. Response time depends on the model, network, and provider load; 4–5 seconds is not guaranteed.
- ChatGPT tokens are encrypted using the operating system’s credential protection and remain in the main process. Sign-in verifies PKCE, state, nonce and ID-token signature; renewal is serialized. A single running instance prevents rotating-token and shortcut conflicts.
- Test Review, its mark appearance and shortcuts, and the persistent macOS signing identity are unchanged.

## What changed in 0.10.8

- Fixed Test Review rejecting an unchanged question layout after a successful AI reply, which left the answer marker hidden. Frame matching keeps the checks that hide changed or off-screen questions.
- Gemini screenshot requests now use Electron’s system-aware networking, including model discovery and streaming replies, with bounded timeouts and cancellation. Temporary failures retain safe diagnostic codes without logging keys or screenshot contents.
- **Command + \\ / Ctrl + \\** shows or hides the app window in both modes. **Command + Shift + \\ / Ctrl + Shift + \\** independently toggles Test Review marks or stored notices. Both shortcuts can be customized.
- **Customize → Appearance** now includes saved marker color and opacity (10–100%). Changes apply to existing marks immediately without revealing hidden ones.
- macOS activation no longer unexpectedly restores the main window during Test Review.
- Review instructions explicitly request only the chosen correct option, with one choice by default unless the question allows multiple selections. AI answers still require verification.
- Local scroll tracking and the question cache continue to work without additional AI calls or browser integration. The persistent macOS signing identity is unchanged.

## What changed in 0.10.7

- Test Review now reads fresh, cursor-free snapshots of the selected display. Snapshot, post-answer validation, and local scroll tracking share the same native pixel source, without relying on a hidden video element.
- Local frames keep one pixel per display point, so integer scroll movements do not introduce scaling differences. Only the JPEG sent to AI is resized by the image-quality setting; cache hits skip JPEG encoding and upload entirely. Local frames are bounded to 16 megapixels.
- Capture requests are serialized through native completion, with bounded deadlines and session/display checks. Late or changed frames cannot reveal stale answer marks.
- macOS annotation windows keep the full display bounds when shown, including areas near the menu bar and Dock. Bounds are checked again after the window opens.
- Answer controls are located from their visible shape and size, including round, square, and styled controls. Uncertain locations are rejected; AI answers still need verification.
- The browser is unchanged: ordinary screen capture and a separate annotation window require no extension or injected script. Scroll tracking and cached answers stay local and use no extra AI calls.
- The macOS signing certificate, existing interface, and keyboard shortcuts are preserved.

## What changed in 0.10.5

- Gemini now checks the API project's model catalogue before screenshot and Live requests. Automatic selection uses an available model; supported custom selections remain in use. Normal screenshot sessions and Test Review share the same model resolver.
- The catalogue is cached in memory, including concurrent request deduplication. An explicit unavailable-model failure before any response can try one different catalogue-supported model. Authentication and quota failures do not trigger model rotation or repeated uploads.
- Test Review errors and progress notices no longer reveal an overlay or restore the hidden main window. **Command + \\** / **Ctrl + \\** shows or hides a stored notice; errors cannot bring back stale answer marks.
- New Gemini settings default to `auto`. Existing selected models are checked against the catalogue without deleting keys or preferences.

## Capture signing improved in 0.10.4

- Published macOS apps now use a persistent, certificate-bound signing identity. Updates signed with this certificate can retain Screen Recording authorization instead of becoming a new ad-hoc identity on each build.
- One-time migration: fully quit old copies, remove the old Honest Father entry from Screen & System Audio Recording, then add and authorize the newly installed 0.10.4 app. Future releases must keep the same signing certificate.
- Capture diagnostics preserve the original source/request failure instead of hiding every failure behind permission advice.

## Capture improvements in 0.10.3

- Screen capture starts at the display’s native proportions. Optional low frame rates are applied after the stream opens; unsupported rate settings no longer prevent capture.
- macOS capture failures retain the original screen-source error and check the running app’s permission status. A failed source is no longer mislabeled as invalid capture parameters or always treated as a disabled permission.
- Native media negotiation is now tested in Electron on both platforms, including ordinary and Test Review starts, cancellation, and macOS source rejection.

## Test Review introduced in 0.10.2

- Added **Start Test Review** beside **Start Session**. It analyzes a multiple-choice practice question and circles the proposed correct radio button or checkbox directly on screen.
- **Command + Enter** / **Ctrl + Enter** captures a new question. The show/hide shortcut toggles the marks in Test Review.
- Scroll tracking compares local screen snapshots and moves the existing marks without provider requests. Marks disappear when the complete question is off screen or no longer matches, and can return when you scroll back.
- A session-only cache remembers up to three questions, bounded to 32 MiB of captured image data, so repeated captures can reuse a matching answer without uploading another screenshot.
- Review responses use a strict JSON format and validated control coordinates. Uncertain, malformed, late, or disconnected-display results are rejected. AI answers can still be wrong; verify them as part of your practice.

## Earlier improvements

- Screen capture selects a display automatically without the macOS system screen picker.
- The macOS application stays out of the Dock, including during startup. Show/hide and Quit keyboard shortcuts remain available.

- Renamed the app, installers, settings directory, help links, and update checks to **Honest Father**.
- Updated the Google GenAI SDK and Gemini Live setup. Live and screenshot models default to `auto`; explicit model IDs can still be entered in the app.
- Added clearer API error messages, bounded retries, and session recovery for temporary connection failures. Permission, model, and quota failures need action on the API project rather than repeated reconnection.
- Added a configurable global **Quit application** shortcut that ends capture, shuts down child processes, and exits the app.
- Added a screen-only shortcut flow: **Command + Enter** on macOS or **Ctrl + Enter** on Windows starts from Home and immediately analyzes a screenshot. Press it again for the next screenshot. This flow does not need a Live/audio connection.
- Added reproducible macOS Apple Silicon and Windows x64 builds. The macOS audio helper is compiled from included Swift source for Apple Silicon.

## Setup and practice

1. Choose **AI for Start Session → Gemini API** or **ChatGPT account** on Home.
2. For Gemini, enter a key from [Google AI Studio](https://aistudio.google.com/apikey) under **Transcription**. Keep the Live and screenshot model settings on `auto`, or choose supported model IDs.
3. For ChatGPT, open **ChatGPT account → Continue with ChatGPT** and finish sign-in in the official browser page. Choose **Continue with Google** there for Gmail. Allow use of your eligible ChatGPT plan, then choose an available model. Manage the app’s allowance in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). This uses the [official open-source app sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source).
4. Select a practice profile, language, and useful context such as study notes or a job description.
5. From Home, press **Command + Enter** on macOS or **Ctrl + Enter** on Windows. Allow Screen Recording when prompted; the app starts a screen-only session and analyzes the first screenshot immediately.
6. Press the same shortcut for the next screenshot. **Start Session** opens the assistant without automatically submitting a screenshot. ChatGPT starts screen-only by default; enable **Use Gemini for voice transcription** and add a Gemini key if you also want spoken questions. Gemini normal sessions use the Live connection for speech.

ChatGPT account inference supports text and images; its current sign-in route does not support audio transcription. Pro mode trades speed for deeper reasoning. Streamed answers, cached model discovery, and bounded request context reduce waiting and repeated traffic, but network availability and a fixed response time cannot be guaranteed. Account tokens are encrypted locally with the OS credential store, never returned to the renderer, and revoked on sign-out when the network is available. A failed remote revocation is reported so the app can also be disconnected in ChatGPT Settings.

For multiple-choice practice, choose **Start Test Review**. The app hides its text window, captures the first question, and marks the proposed correct control. Press **Command + Enter** / **Ctrl + Enter** for a new question. **Command + \\** / **Ctrl + \\** shows or hides the app window, including during Test Review. **Command + Shift + \\** / **Ctrl + Shift + \\** independently shows or hides the review marks or a stored notice. Errors remain hidden until you show the notice with that shortcut.

Under **Customize → Appearance**, choose **Review Marker Color** and **Review Marker Opacity** (10–100%). Changes apply immediately and are saved for later sessions. The appearance controls preserve the current marker visibility.

Test Review only annotates; it does not select or submit answers. Local scroll tracking requires the complete question and its choices to remain visible and uses no API requests. If the question cannot be matched, the marks stay hidden; scroll back or capture the new question. Show the app window to end the session or change settings; the Quit application shortcut remains available on both platforms.

Test Review needs Gemini with an image-capable model; existing installations retain their previously configured review provider. Selecting ChatGPT changes only the normal session. It does not open a Live/audio connection, and the Local AI mode currently does not support these visual annotations. Cached questions are kept only in memory until the review session ends; they are not added to History.

Google and OpenAI enforce usage limits per project, model, account, or app allowance. Existing Groq-based review sessions retain Groq limits. The app cannot increase these quotas. Check the provider's dashboard if a quota error appears; changing a model only helps when that model is available and has its own remaining allowance. The app no longer assumes a fixed daily screenshot quota.

**Local AI** uses `llama.cpp` and `whisper.cpp` on your computer. The runtime and selected models are downloaded on first use; after downloading, sessions can run without external AI API calls. This fork currently downloads those optional runtimes from the upstream v0.7.0 release, with checksum verification.

## Keyboard shortcuts

All global shortcuts are configurable under **Customize → Keyboard Shortcuts**. The table shows defaults; settings display your active saved combinations.

| Action                                     | macOS                 | Windows            |
| ------------------------------------------ | --------------------- | ------------------ |
| Analyze screenshot (also starts from Home) | `Command + Enter`     | `Ctrl + Enter`     |
| Quit application                           | `Command + Shift + Q` | `Ctrl + Shift + Q` |
| Move window                                | `Option + Arrow`      | `Ctrl + Arrow`     |
| Toggle click-through                       | `Command + M`         | `Ctrl + M`         |
| Show/hide app window                       | `Command + \`         | `Ctrl + \`         |
| Show/hide Review marks or notice           | `Command + Shift + \` | `Ctrl + Shift + \` |
| Open Test Visibility settings              | `Command + Shift + ,` | `Ctrl + Shift + ,` |
| Send a typed message                       | `Enter`               | `Enter`            |

If another application or the OS already uses a shortcut, choose a different combination in settings.

## Development

Use Node.js 24 LTS and npm 10.9 or newer. On macOS, install the Xcode Command Line Tools (`xcode-select --install`) to compile the system audio helper.

```sh
npm ci
npm test
npm run test:smoke
npm start
```

The smoke check launches Electron with isolated temporary settings and verifies the app and transparent review overlay. It does not capture your screen or call an AI provider. Live API sessions require your own key and permissions and are not exercised in CI.

Build on the target OS:

```sh
# On Apple Silicon macOS
npm run make -- --platform=darwin --arch=arm64

# On Windows x64
npm run make -- --platform=win32 --arch=x64
```

Packages are written to `out/make`. The [build workflow](.github/workflows/build.yml) tests both platforms and uploads Windows assets to a draft release on a version tag. Publish the release after both Windows and signed Mac assets are verified. Its ad-hoc Mac build is a CI test artifact and is never uploaded to a public release. Mac releases are built on the release signer's Mac with `HONEST_FATHER_RELEASE_SIGNING=1 npm run make -- --platform=darwin --arch=arm64`, then checked with `node scripts/verify-mac-signing-stability.js`. Run `node scripts/collect-artifacts.js darwin arm64` and `node scripts/publish-macos.js v<version> <successful-build-run-id>` to upload the signed Mac files. The private signing key stays in the local macOS keychain; only its public certificate is checked into the repository. Packaging dependency versions are pinned in `package-lock.json`.

For slow outbound connections, the optional [Mac publication workflow](.github/workflows/publish-macos-keyless.yml) restores the already signed app from the successful CI artifact and public per-file binary patches. It requires a SHA-256-pinned manifest of every target file, permission mode, and symlink, and verifies the persistent certificate before and after creating ZIP/DMG containers. It never signs code or receives the private key. Keep the release draft until both platform downloads have been verified.

## Capture and storage

- **macOS:** ScreenCaptureKit system audio with a compiled `SystemAudioDump` helper; screen and microphone permissions are required for their respective capture modes. The helper outputs 24 kHz, signed 16-bit stereo PCM, which the app downmixes to mono before sending to AI.
- **Windows:** screen capture with system loopback audio and optional microphone capture.
- Preferences, credentials, history, and downloaded models live in `honest-father-config` under your OS's application data directory. This is separate from the upstream app's data; enter your key again when first opening the fork.
- External AI modes send captured content to the configured provider. Local AI mode keeps inference on the computer after runtime/model downloads.

## License and credits

Honest Father retains the upstream [GPL-3.0 license](LICENSE), Git history, and attribution to [sohzm and all Cheating Daddy contributors](https://github.com/sohzm/cheating-daddy/graphs/contributors). **User-provided Honest Father artwork** is used for the application icon, converted to PNG, ICNS, and ICO without changing its artwork.

The macOS audio helper is adapted from [sohzm/systemAudioDump](https://github.com/sohzm/systemAudioDump), originally by Mohammed Yasin Mulla, at commit `19caa4f6c0661c03a10d1f08c79a11f0b00f251a`. Its MIT license is retained in [native/SystemAudioDump/LICENSE](native/SystemAudioDump/LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Honest Father changes keep logs out of PCM stdout, avoid duplicated converter input, use a fixed stereo format, support compilation for Apple Silicon, and report capture failure through the process exit status.
