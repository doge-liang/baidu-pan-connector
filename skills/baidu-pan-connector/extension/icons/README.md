# Extension icon source

The extension icon is derived from `lucide:cloud-sync`, selected and retrieved through
`iconify-mcp-server@1.0.4` using the Iconify MCP `search_icons` and `get_icon` tools.

- Icon set: [Lucide](https://github.com/lucide-icons/lucide)
- Icon name: `cloud-sync`
- Source coordinates: Iconify `24 × 24` SVG body
- License: ISC; see `LICENSE-lucide.txt`

`icon-source.svg` adds the Connector blue background and scales the original path data.
The PNG files referenced by `manifest.json` are rendered from that SVG and downsampled
with Lanczos filtering.

The status panel toggle buttons use the Iconify MCP results `lucide:chevron-down` and
`lucide:chevron-up` as dependency-free inline SVG paths in `content.js`.
