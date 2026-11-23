# Photo Stories Desktop

A simple, local-first desktop app for telling the stories behind a few special photos. Pick a photo, talk about it, name the people in it, and the app keeps the story with a copy of the photo. At any time, export everything as a Library of Congress BagIt archive that includes a page you can open in any web browser.

No account, no server, no internet needed (after a one-time download of the speech model). Your own photos are never changed: the app works on copies.

Part of the [A Reflection of You](https://github.com/AReflectionOfYou) collection. Storage, import, export, the schema and the archive viewer come from [PhotoStoriesCore](https://github.com/AReflectionOfYou/PhotoStoriesCore), shared by every version of Photo Stories, so archives from the desktop app, the mobile app and the shared online collection are interchangeable.

## Status

Version 0.1.1. Built and tested on macOS (Apple silicon; macOS 11 or later); Windows and Linux builds are made and tested in CI. Installers are on the [Releases page](https://github.com/AReflectionOfYou/PhotoStoriesDesktop/releases). They are not yet code-signed, so the first time you open the app your computer warns you:

- **Mac:** open Photo Stories once and close the warning with **Done** (not Move to Trash). Then open **System Settings → Privacy & Security**, scroll down to Security, click **Open Anyway** next to "Photo Stories", confirm, and choose **Open Anyway** again. You only do this once. If the warning says the app "is damaged and can't be opened", move it to Applications and run once in Terminal: `xattr -dr com.apple.quarantine "/Applications/Photo Stories.app"`
- **Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**.

## What it does

1. **Project:** choose or create a project folder. Copies, stories and exports live there.
2. **Your photos:** choose a folder and see its thumbnails (JPEG, PNG, WebP, TIFF, GIF, BMP; HEIC on a Mac).
3. **Copy:** choosing a photo copies it into the project (full size, or resized if you prefer). The original is only read.
4. **Edit the copy:** rotate, crop, brightness, contrast, auto-enhance. Edits are always re-applied from the as-copied photo, and **Reset** returns to it.
5. **Record:** talk about the photo. Whisper (small model by default, medium optional) transcribes on this computer as you speak. Pause, record more, or edit the text by hand. Names already in the project help Whisper spell them. The speech model (about 490 MB) downloads in the background the first time the app opens, so it's usually ready before you record, and it's loaded as soon as you open a photo, so recording starts at once.
6. **Faces:** faces are found on this computer (MediaPipe BlazeFace; boxes only, never identity). Name each box by typing or saying the name; earlier names are suggested. Add a missed box, or mark a box "Not a face".
7. **Clean up:** the transcript becomes a short story in your own words, with a suggested title, people, place and date to review. Without an API key, a light local cleanup is used. With your own Anthropic or OpenAI key, that service does it, with the same instructions either way. Only the transcript text is sent, never the photo.
8. **Save:** writes the sidecar (`photo.json`, with the Dublin Core mapping) and fills in missing metadata inside the copy (title, story, date, place, people, face regions). If the photo already holds a different value, you're shown both and choose.
9. **Export:** one BagIt zip with the photos, sidecars, thumbnails, recordings, a readme and `START HERE.html`. It is checked before it's finished.
10. **Import:** bring in an earlier archive (from any version of Photo Stories). You see what's new, what's already here (matched by checksum: skip, replace or keep both) and which names look alike (merge or keep separate) before anything is written.

## Planned for later

- **Cloud transcription (optional).** Let people who have an OpenAI API key send recordings to OpenAI's transcription service instead of using the local model. It would skip the one-time model download and the short model-loading pause, at the cost of sending the recorded voice off the computer, needing internet every time, per-minute charges to their key, and text appearing in chunks rather than live. Local transcription stays the default; Anthropic's API has no speech-to-text, so a Claude key wouldn't help here.

## Building

You need Node.js 22+, Rust (via [rustup](https://rustup.rs)), and CMake (for whisper.cpp). On Linux, also the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) plus `libasound2-dev` and `libdbus-1-dev`.

```sh
npm install
npm run tauri dev               # run the app
npm run tauri build             # make an installer for this computer
npm test && npm run typecheck   # front-end tests
cd src-tauri && cargo test      # Rust tests
```

The speech-recognition test needs the model and a spoken sample:

```sh
say -o story.wav --data-format=LEI16@22050 "This is the red house on Elm Street."
PS_MODEL=~/Library/Application\ Support/io.github.areflectionofyou.photostories/models/ggml-small.bin PS_WAV=story.wav cargo test -- --include-ignored
```

`dev/harness.html` runs the real front end and the real core library in an ordinary browser, with the Rust side replaced by an in-memory stand-in (`npx vite`, then open `/dev/harness.html`). It's for screenshots and end-to-end checks; it is not part of the app.

## Layout

| Path | What it is |
|---|---|
| `src/` | The window: Preact + TypeScript. `lib/tauri-adapter.ts` connects photostories-core to the Rust file commands; `lib/cleanup.ts` holds the cleanup providers. |
| `src-tauri/src/` | Rust: file access, thumbnails and decoding, microphone capture with local Whisper transcription, the model download, and API keys in the system keychain. |
| `public/models/` | The face detector's models (Apache 2.0, from Google's MediaPipe). |
| `tests/` | Front-end tests. |

## Privacy

Photos, recordings and transcripts stay on this computer. The only network use is the one-time speech model download (from the whisper.cpp project on Hugging Face) sending a transcript's text for cleanup, only if you add your own API key, and looking up a place name from a photo's map coordinates, only when you click **Find the place name** or turn that on in Settings. For that lookup, only the coordinates are sent to [OpenStreetMap](https://nominatim.openstreetmap.org), never the photo. API keys are kept in the system keychain.

## License

Code is under the [MIT License](LICENSE). Documents, written content, images, audio, and video are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see [LICENSE-CONTENT](LICENSE-CONTENT). © 2026 Michael A. Heroux. The bundled MediaPipe face models are © Google, under the Apache License 2.0.

## Image policy

No photos or likenesses of any real person, living or dead, appear in this repo or on anything built from it. All images are created together with Claude, so Michael A. Heroux owns them and they are licensed CC BY 4.0. The only exception is Michael himself: his standard professional portrait and an occasional informal photo. Any other exception needs Michael's explicit approval for that specific case. Future contributors, including AI coding sessions, must follow this policy. Photos that people use with the app stay on their own computers and are not part of this repo.
