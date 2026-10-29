## Kokon 0.11.2

A faster Mac engine on macOS 26 and on M3, M4 and M5 Macs, a progress card that keeps its place, and fixes you reported.

- **Mac engine 0.1.1 (experimental)**: on macOS 26 the signal that lets the CPU's matrix unit and the Neural Engine start reached the CPU late, so they ran after the GPU instead of beside it. The engine now measures this at every start (about 50 ms) and waits for the GPU only where it helps: on an M5 Pro a 1024 × 1024 image went from 49 to 40 s and an edit from 52 to 43 s (found and fixed by @CesareDavidePace in [#46](https://github.com/GabrieleLozupone/kokon/pull/46)). On M3, M4 and M5 Macs the attention kernel now uses the path that was faster in every report in [Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43): 8–18 % per step. M1 and M2 Macs on macOS 27 run as before. Turn it on in Settings → Performance → Kokon's Mac engine.
- **The progress card keeps its place**: looking at another version while an image is being made and then coming back no longer restarts the card. The percentage and the Prompt+ text go on from where they are, on the desktop and on a phone.
- **Settings ask before closing**: closing Settings with unsaved changes asks whether to save them (Save, Discard, Cancel).
- **Setup**: the Install / Start / Done buttons stay in view at the foot of the window, and the files waiting to download show their names (they were squashed into thin, clipped rows).
- **Visible selection on Linux** ([#41](https://github.com/GabrieleLozupone/kokon/issues/41)): the 0.11.1 fix did not reach WebKitGTK, which ignored the selection colour; selected text is now visible in the dark theme on Linux.
- **Android full screen**: leaving full screen in the browser on an Android phone left part of the project view stale until a reload.

**Updating**: the app updates itself; your images, settings and models are kept. If you chose **Later** for the Q4_K_M image model in 0.11.1, What's new offers it again.

On macOS, if the first launch only says **The application "Kokon" can't be opened**, with just an OK button and no *Open Anyway* in System Settings, run `xattr -dr com.apple.quarantine /Applications/Kokon.app` in Terminal, then open Kokon. Details in the [README](https://github.com/GabrieleLozupone/kokon#macos-says-kokon-cannot-be-opened).

### Installing on Linux

```bash
sudo apt install ./Kokon_0.11.2_amd64.deb      # Ubuntu 22.04+, Debian 12+, Mint 21+
sudo dnf install ./Kokon-0.11.2-1.x86_64.rpm   # Fedora 40+
```

NVIDIA cards need the proprietary driver (the CUDA runtime comes with Kokon). AMD and Intel cards use Mesa's Vulkan driver.

### Known issue

AMD RX 6000 (RDNA2) cards: turn flash attention off in Settings → Performance (about 5x faster steps on an RX 6700 XT). Letting the engine choose per card needs a new engine and comes in a later update.

### Thanks

- @CesareDavidePace, for finding the late signal on macOS 26 and the fix in #46.
- @abria, @ianscrivener, @nico9902 and @Riddhidutta2023, for their Mac reports in Discussion #43: the macOS 26 finding and the attention change come from your numbers.
- @Tiauma, for testing the Linux selection again (#41).
- DOSorDIE4CsP on Reddit, for the Android full-screen report.

### Downloads

| File | SHA-256 |
|---|---|
| `Kokon_0.11.2_x64-setup.exe` (Windows) | `802669d6c2cb8efdbc9de7ef6f8d43cdfce85187a79273f4381c23dfd3380b45` |
| `Kokon_0.11.2_aarch64.dmg` (Mac, macOS 15+) | `2dfc3d798d76dcfe400bd04d399597ab78cc822f1c883a54b8e51b2db41b9442` |
| `Kokon_0.11.2_amd64.deb` (Ubuntu, Debian, Mint) | `81c6e991c6e2afbe402e59914c7a919c8c7f4efa8842713b4c752afc70f15cda` |
| `Kokon-0.11.2-1.x86_64.rpm` (Fedora) | `26109b866d274e82181991caf1c9c9188bb495a9c973072d9e330f22e9e38311` |
