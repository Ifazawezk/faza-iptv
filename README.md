# Faza IPTV

A free, open-source IPTV player for **Windows, macOS, Linux, Android** and **any phone browser**.
Bring your own playlist: an **Xtream Codes** login (server + username + password) or an **M3U / M3U8** link or file.

![Faza IPTV](docs/screenshot.png)

## Features

- **Xtream Codes**: Live TV, Movies and Series (seasons and episodes), account status and expiry date, and a **Now / Next TV guide**
- **M3U playlists** from a link or a file (`get.php?username=…` links are detected as Xtream automatically)
- Channel groups, fast search across thousands of channels, **favorites** and **recently watched**
- Plays **HLS (.m3u8)**, **MPEG-TS (.ts)**, MP4 and MKV, and falls back automatically between formats
- Keyboard: <kbd>↑</kbd>/<kbd>↓</kbd> change channel · <kbd>F</kbd> fullscreen · <kbd>M</kbd> mute · <kbd>/</kbd> search
- Phone-friendly layout that can be installed to the home screen
- Everything stays on your device. No account, no tracking, no ads.

> **No channels are included.** This app is only a player. Use it with playlists and subscriptions you are legally allowed to watch.
> To try it, the *Add* dialog has buttons for free public channels from the [iptv-org](https://github.com/iptv-org/iptv) project.

## Download

Go to **[Releases](../../releases/latest)** and pick your file:

| Device | File |
|---|---|
| Windows (installer) | `Faza-IPTV-Setup-x.y.z.exe` |
| Windows (no install) | `Faza-IPTV-Portable-x.y.z.exe` |
| macOS | `Faza-IPTV-x.y.z-mac.dmg` (first launch: right-click › Open) |
| Linux | `Faza-IPTV-x.y.z-linux.AppImage` |
| Android | `Faza-IPTV-x.y.z-android.apk` (allow "install unknown apps") |
| iPhone / iPad | use *Phone mode* below |

Windows may show "Windows protected your PC" because the app isn't code-signed. Click **More info › Run anyway**.

## Phone mode (iPhone, iPad and any phone on your Wi-Fi)

Run the player on a computer and watch on your phone over the same Wi-Fi:

1. Install [Node.js](https://nodejs.org) on the computer and download this project (*Code › Download ZIP*).
2. Double-click **`Start for phones (same Wi-Fi).bat`** (on Mac/Linux: `node server.js --lan`).
3. The window shows an address like `http://192.168.1.20:8686`. Open it in your phone's browser.
4. Tap **Share › Add to Home Screen** (iPhone) or **⋮ › Install app** (Android).

Allow "Private networks" if the Windows firewall asks.

## Run from source

```bash
npm start            # browser version at http://localhost:8686 (no npm install needed)
npm run phone        # same, but reachable from phones on your Wi-Fi
npm install          # once, then:
npm run desktop      # desktop app (Electron)
npm run dist         # build installers into dist/
bash android/build.sh  # Android APK (needs Java 17 + Android SDK)
```

Pushing a tag like `v1.0.1` makes GitHub Actions build every app and publish a release automatically.

## How it works

Browsers block most IPTV streams (plain `http://` and no CORS headers), so the app runs in one of two modes:

- **Server mode** (`server.js`, zero dependencies): a tiny local server serves the UI and relays playlists and streams. It rewrites HLS playlists so every segment goes through it as well.
- **Direct mode** (desktop and Android apps): the UI is loaded from local files inside an app shell that is allowed to reach any server, so no relay is needed.

Playback uses [hls.js](https://github.com/video-dev/hls.js) and [mpegts.js](https://github.com/xqq/mpegts.js) (both Apache-2.0, bundled in `public/vendor`), or the native player on Safari / iPhone.

## Troubleshooting

- **Picture but no sound**: the channel probably uses AC-3/E-AC-3 audio, which browsers can't decode. Use **Copy link** and open it in VLC.
- **HTTP 403 / 458**: the subscription expired or too many devices are connected at once.
- **A channel won't load**: it may be offline. Try *Try again* or the next channel.

## License

[MIT](LICENSE). Free to use, change and share.
