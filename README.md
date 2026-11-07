<h1 align="center">qmd2pdf</h1>

<p align="center">
  <img src="./icon.png" alt="qmd2pdf extension icon" width="128">
</p>

This VS Code extension renders the active `.qmd` file to PDF and displays it
in a VS Code editor beside the document. Each saved QMD or changed project
YAML/Lua configuration triggers a fresh `quarto render`; the preview updates
when the new PDF is ready. The preview has page navigation, selectable PDF
text, and zoom controls. It renders all pages and starts the PDF.js worker
while Quarto is rendering, reducing PDF viewer startup work. Use the toolbar or Ctrl/Cmd
plus the mouse wheel to zoom; use Page Up/Down to move between pages. When a
new render replaces the PDF, the preview keeps your current page and relative
scroll position within that page, both horizontal and vertical scroll
positions, and your zoom level.
While Quarto renders, the preview shows a live log overlay. It closes when
rendering succeeds and remains open with the error output if rendering fails.

## Requirements

- [Quarto](https://quarto.org/docs/get-started/) installed and available as
  `quarto` on `PATH`.
- A saved `.qmd` file.

## Use

Open a `.qmd` file and select **qmd2pdf: Start Live Preview** from the
Command Palette or use the play button in the editor title. The preview opens
beside the document. Use **qmd2pdf: Stop Live Preview** or close the
preview tab to stop it.

Use **Save PDF As...** in the preview toolbar to save the latest rendered PDF
to a location selected in the native save dialog.

Each preview gets a temporary isolated copy of the Quarto project. qmd2pdf
copies saved QMD changes and project configuration changes into that copy,
then runs `quarto render <file.qmd>` there. Generated files stay in the
temporary copy, leaving the original project untouched. Unsaved edits do not
trigger a render. Project settings, Lua filters, and other project files are
copied too; common generated and dependency directories are excluded. The
temporary copy is removed when the preview closes.

Project-local `_quarto.yaml` (or `_quarto.yml`) and `filter.lua` are preserved
and used when present. The extension supplies its global YAML or Lua filter
only when that corresponding project file is missing. On first use, editable
copies of the bundled defaults are created in the extension's global storage. Run
**qmd2pdf: Open Preview Config Files** from the Command Palette to open both files
for editing. Changes to the project-local YAML or Lua filter are watched and
trigger a new render.
Alternatively, set **qmd2pdf: Config Directory** in VS Code Settings
to a directory containing your own `_quarto.yaml` and `filter.lua`.
Existing global config files are migrated from the previous extension on
first use.

## Development

Run `npm install` and `npm run compile`, then press F5 in VS Code to launch an
Extension Development Host. The preview UI is maintained in `webview/` and
copied into the extension build during compilation.

To create a local installable `.vsix` package, run `npm install` and
`npm run package`. Install the resulting `.vsix` from
VS Code's Extensions view using **Install from VSIX...**.

> Vibed with copilot