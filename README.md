# Lyricpad

A minimal lyrics editor for Windows, with a rhyme dictionary docked right next to your text.

Write on the left, look up rhymes on the right. Select a word, right-click, **Look up rhymes**, done. No accounts, no cloud, no "AI co-writer". Just you and a blank page.

![Lyricpad in dark mode](docs/screenshot-dark.png)

## Features

- **Plain text files**: New, Open, Save and Save As (`.txt`, `.md`, `.lrc`). Warns you before you lose unsaved changes. Drag a file onto the window to open it.
- **Light and dark theme.**
- **Left or centered text**, because some lyrics just look better centered.
- **Side-by-side rhymes panel** with [rimar.io](https://rimar.io) (Spanish) or [RhymeZone](https://www.rhymezone.com) (English). You can also plug in any other rhyme site with a custom search URL.
- **Right-click → Look up rhymes** on any word. If you select a whole line, it uses the last word, since that's the one that rhymes.
- **English and Spanish UI.**
- Line and word count, adjustable font size, and it remembers your theme, layout and window size.

## Download

Grab the latest `Lyricpad-win-x64.zip` from [Releases](../../releases), unzip it anywhere and run `Lyricpad.exe`.

The app isn't code-signed, so Windows SmartScreen will probably complain the first time. Click **More info → Run anyway**.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New / Open / Save | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` |
| Save As | `Ctrl+Shift+S` |
| Look up rhymes for selection | `Ctrl+R` |
| Toggle rhymes panel | `Ctrl+Shift+R` |
| Toggle dark theme | `Ctrl+T` |
| Align left / center | `Ctrl+L` / `Ctrl+E` |
| Font size bigger / smaller / reset | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Full screen | `F11` |

## Custom rhyme service

In **View → Rhyme service → Custom…**, paste any search URL and put `{word}` where the word goes. For example:

```
https://www.rhymezone.com/r/rhyme.cgi?Word={word}&typeofrhyme=perfect
```

## Building from source

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start           # run in development
npm run build:win   # package for Windows x64 into dist/
```

Pushing a tag like `v1.0.1` builds the Windows package on GitHub Actions and attaches it to a release automatically.

## Español

Lyricpad es un editor de letras minimalista para Windows con un diccionario de rimas al lado del texto. Seleccionas una palabra, clic derecho, **Consultar rimas**, y listo. La interfaz está en inglés y en español: el idioma se cambia en **Ver → Idioma**.

## License

[MIT](LICENSE). Lyricpad only embeds the rhyme websites; their content belongs to their respective owners.
