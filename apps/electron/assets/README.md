# Desktop assets

| File | Use |
|---|---|
| `AppIcon.icns` | macOS application icon (provenance in `AppIcon.provenance.txt`) |
| `tibotattle.ico` | Windows application icon, same artwork |
| `trayTemplate.png`, `trayTemplate@2x.png` | Tray icon, 22×22 and 44×44 |
| `AppIcon.provenance.txt` | Origin and rights for the application icon |

The tray images are macOS template images: black gauge glyph on a transparent
background, so macOS tints them for light and dark menu bars. Electron picks
the `@2x` file automatically on high-density displays. They were drawn
programmatically (an open ring with a needle and hub, 8×8 supersampled
coverage written as RGBA PNG) for this repository and are MIT-licensed with
the rest of the project. They contain no third-party artwork.

The application icon dates from the Codex edition and is kept unchanged.
