# Terminal File Tree Options on macOS

As of **February 28, 2026**, **iTerm2 does not provide a built-in visual file tree/file explorer pane**.

## iTerm2 Status

- iTerm2 includes tools like Command History and Recent Directories, but not a native sidebar file tree.
- Docs:
  - https://iterm2.com/documentation-one-page.html
  - https://iterm2.com/documentation-shell-integration.html

## Recommended Alternatives

1. **Warp** (best direct replacement for built-in tree UI)
   - Includes a native File Tree / Project Explorer sidebar.
   - Docs: https://docs.warp.dev/code/code-editor/file-tree

2. **Wave Terminal**
   - Includes file/preview widgets with directory browsing inside the workspace UI.
   - Docs:
     - https://docs.waveterm.dev/widgets
     - https://raw.githubusercontent.com/wavetermdev/waveterm/main/docs/docs/widgets.mdx

3. **Electerm**
   - Terminal app with built-in file manager functionality.
   - Docs: https://electerm.github.io/electerm/

## Keep iTerm2 and Add In-Terminal File Tree

If you want to keep iTerm2, use a TUI file manager:

- **Yazi** (modern, fast): `brew install yazi` then run `yazi`
  - https://formulae.brew.sh/formula/yazi
  - https://yazi-rs.github.io/docs/quick-start/
- **Ranger** (classic): `brew install ranger` then run `ranger`
  - https://formulae.brew.sh/formula/ranger

## Quick Recommendation

- If you want a built-in GUI-like file tree sidebar in the terminal app, choose **Warp**.
- If you want to keep iTerm2, install **Yazi** and launch it when you need visual navigation.
