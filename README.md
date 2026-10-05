# Honest Father

An open-source desktop AI assistant for mock interviews, exam preparation, and learning. Honest Father is a fork of [Cheating Daddy](https://github.com/sohzm/cheating-daddy) by [sohzm](https://github.com/sohzm) and its contributors, distributed under GPL-3.0.

## Downloads

Download packages from [Honest Father Releases](https://github.com/ANAYSSA/Honest-Father/releases/latest).

| Computer                                      | Download                                                           |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Mac with Apple Silicon (M1/M2/M3/M4 or newer) | `Honest-Father-<version>-macos-arm64.dmg` or `.zip`                |
| Windows x64                                   | `Honest-Father-<version>-windows-x64-Setup.exe` or portable `.zip` |

For macOS, open the DMG and drag **Honest Father** to Applications. On Windows, run the installer or extract the portable ZIP and launch `HonestFather.exe`.

Requires macOS 13 or later, or 64-bit Windows 10/11.

macOS builds have an ad hoc signature verified after packaging. They are not Developer ID signed or notarized, so macOS may require approval under **System Settings → Privacy & Security**. Windows builds are unsigned and may show SmartScreen. Each platform includes a `SHA256SUMS.txt` file for verifying downloads. Linux packaging is outside the scope of this fork's release workflow.

## What changed in 0.9.5

- Screen capture selects a display automatically without the macOS system screen picker.
- The macOS application stays out of the Dock, including during startup. Show/hide and Quit keyboard shortcuts remain available.

- Renamed the app, installers, settings directory, help links, and update checks to **Honest Father**.
- Updated the Google GenAI SDK and Gemini Live setup. The default Live model is `gemini-3.8-live`, and the screenshot model is `gemini-3.1-flash-lite`; both can be changed in the app.
- Added clearer API error messages, bounded retries, and session recovery for temporary connection failures. Permission, model, and quota failures need action on the API project rather than repeated reconnection.
- Added a configurable global **Quit application** shortcut that ends capture, shuts down child processes, and exits the app.
- Added a screen-only shortcut flow: **Command + Enter** on macOS or **Ctrl + Enter** on Windows starts from Home and immediately analyzes a screenshot. Press it again for the next screenshot. This flow does not need a Live/audio connection.
- Added reproducible macOS Apple Silicon and Windows x64 builds. The macOS audio helper is compiled from included Swift source for Apple Silicon.

## Setup and practice

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Enter the key under **Transcription** in the app. The screenshot model is used directly for screen-only practice; the Live model is only needed when starting an audio session.
3. Optionally enter a [Groq API key](https://console.groq.com/keys) for answer generation. Without it, Gemini answers questions and analyzes screenshots.
4. Select a practice profile, language, and any useful context such as a resume, job description, or study notes.
5. From Home, press **Command + Enter** on macOS or **Ctrl + Enter** on Windows. Allow screen sharing or Screen Recording access when prompted; the app starts a screen-only session and analyzes the first screenshot immediately.
6. Press the same shortcut during the session to analyze the next screenshot. Use mock interview questions or study material, then review saved conversations in History.

For spoken practice, **Start Session** starts audio capture and the Live connection. Confirm the Live model is available to your API project and allow the relevant microphone/system audio permissions. Screen-only practice avoids the Live connection and audio capture entirely.

Google and Groq enforce quotas per API project, model, and account tier. The app cannot increase these quotas. Check the provider's dashboard if a quota error appears; changing a model only helps when that model is available and has its own remaining allowance. The app no longer assumes a fixed daily screenshot quota.

**Local AI** uses `llama.cpp` and `whisper.cpp` on your computer. The runtime and selected models are downloaded on first use; after downloading, sessions can run without external AI API calls. This fork currently downloads those optional runtimes from the upstream v0.7.0 release, with checksum verification.

## Keyboard shortcuts

All global shortcuts are configurable under **Customize → Keyboard Shortcuts**.

| Action                                     | macOS                 | Windows            |
| ------------------------------------------ | --------------------- | ------------------ |
| Analyze screenshot (also starts from Home) | `Command + Enter`     | `Ctrl + Enter`     |
| Quit application                           | `Command + Shift + Q` | `Ctrl + Shift + Q` |
| Move window                                | `Option + Arrow`      | `Ctrl + Arrow`     |
| Toggle click-through                       | `Command + M`         | `Ctrl + M`         |
| Show/hide window                           | `Command + \\`        | `Ctrl + \\`        |
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

The smoke check launches Electron with isolated temporary settings and verifies that the app renders. Live API sessions require your own key and permissions and are not exercised in CI.

Build on the target OS:

```sh
# On Apple Silicon macOS
npm run make -- --platform=darwin --arch=arm64

# On Windows x64
npm run make -- --platform=win32 --arch=x64
```

Packages are written to `out/make`. The [build workflow](.github/workflows/build.yml) produces both variants and verifies startup. Manual workflow runs keep downloads as workflow artifacts; pushing a `v<version>` tag also publishes a GitHub Release with installers, portable archives, and checksums. Packaging dependency versions are pinned in `package-lock.json`.

## Capture and storage

- **macOS:** ScreenCaptureKit system audio with a compiled `SystemAudioDump` helper; screen and microphone permissions are required for their respective capture modes. The helper outputs 24 kHz, signed 16-bit stereo PCM, which the app downmixes to mono before sending to AI.
- **Windows:** screen capture with system loopback audio and optional microphone capture.
- Preferences, credentials, history, and downloaded models live in `honest-father-config` under your OS's application data directory. This is separate from the upstream app's data; enter your key again when first opening the fork.
- External AI modes send captured content to the configured provider. Local AI mode keeps inference on the computer after runtime/model downloads.

## License and credits

Honest Father retains the upstream [GPL-3.0 license](LICENSE), Git history, and attribution to [sohzm and all Cheating Daddy contributors](https://github.com/sohzm/cheating-daddy/graphs/contributors). **User-provided Honest Father artwork** is used for the application icon, converted to PNG, ICNS, and ICO without changing its artwork.

The macOS audio helper is adapted from [sohzm/systemAudioDump](https://github.com/sohzm/systemAudioDump), originally by Mohammed Yasin Mulla, at commit `19caa4f6c0661c03a10d1f08c79a11f0b00f251a`. Its MIT license is retained in [native/SystemAudioDump/LICENSE](native/SystemAudioDump/LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Honest Father changes keep logs out of PCM stdout, avoid duplicated converter input, use a fixed stereo format, support compilation for Apple Silicon, and report capture failure through the process exit status.
