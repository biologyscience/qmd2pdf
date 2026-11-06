import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

interface PreviewSession {
  process?: ChildProcess;
  panel: vscode.WebviewPanel;
  output: string;
  stopping: boolean;
  workspaceDirectory: string;
  stagedFile: string;
  syncQueue: Promise<void>;
  cleanupPromise?: Promise<void>;
}

interface PreviewConfigPaths {
  quartoYaml: string;
  luaFilter: string;
}

const previews = new Map<string, PreviewSession>();
const excludedDirectories = new Set([
  ".git",
  ".quarto",
  ".vscode",
  ".venv",
  "node_modules",
  "site_libs",
  "_site",
]);
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("qmd2pdf");
  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand("qmd2pdf.startPreview", () => startPreview(context)),
    vscode.commands.registerCommand("qmd2pdf.stopPreview", stopPreview),
    vscode.commands.registerCommand("qmd2pdf.openConfigFiles", () => openConfigFiles(context)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const session = previews.get(document.fileName);
      if (session) {
        syncSavedDocument(session, document.getText());
      }
    }),
  );
}

async function startPreview(context: vscode.ExtensionContext): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.isUntitled || path.extname(document.fileName).toLowerCase() !== ".qmd") {
    void vscode.window.showErrorMessage("Open a saved .qmd file before starting its preview.");
    return;
  }

  const file = document.fileName;
  const existingSession = previews.get(file);
  if (existingSession) {
    existingSession.panel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "qmd2pdf",
    `qmd2pdf: ${path.basename(file)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [],
    },
  );
  panel.webview.html = loadingHtml(panel.webview);

  const session: PreviewSession = {
    panel,
    output: "",
    stopping: false,
    workspaceDirectory: "",
    stagedFile: "",
    syncQueue: Promise.resolve(),
  };
  previews.set(file, session);

  panel.onDidDispose(() => {
    if (previews.get(file) === session) {
      previews.delete(file);
    }
    session.stopping = true;
    if (session.process) {
      session.process.kill();
    }
  });

  try {
    const configPaths = await ensureConfigFiles(context);
    const sourceRoot = await findProjectRoot(path.dirname(file));
    session.workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "qmd2pdf-preview-"));
    await fs.cp(sourceRoot, session.workspaceDirectory, {
      recursive: true,
      filter: (source) => shouldCopyProjectPath(sourceRoot, source),
    });

    const relativeFile = path.relative(sourceRoot, file);
    await Promise.all([
      fs.copyFile(configPaths.quartoYaml, path.join(session.workspaceDirectory, "_quarto.yaml")),
      fs.copyFile(configPaths.luaFilter, path.join(session.workspaceDirectory, "filter.lua")),
    ]);
    const stagedFile = path.join(session.workspaceDirectory, relativeFile);
    await fs.mkdir(path.dirname(stagedFile), { recursive: true });
    session.stagedFile = stagedFile;
    session.syncQueue = session.syncQueue.then(() => fs.writeFile(stagedFile, document.getText(), "utf8"));
    await session.syncQueue;

    if (session.stopping) {
      await cleanupWorkspace(session);
      return;
    }

    const child = spawn("quarto", ["preview", relativeFile, "--no-browser"], {
      cwd: session.workspaceDirectory,
      windowsHide: true,
    });
    session.process = child;

    child.stdout?.on("data", (chunk: Buffer | string) => appendOutput(session, chunk.toString()));

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = stripAnsi(chunk.toString());
      appendOutput(session, text);
      outputChannel.append(text);
    });

    child.on("error", (error) => {
      outputChannel.appendLine(error.message);
      showFailure(session, `Could not start Quarto: ${error.message}`);
      void vscode.window.showErrorMessage(`qmd2pdf: ${error.message}`);
    });

    child.on("close", (code) => {
      if (session.stopping || panel.visible === false) {
        void cleanupWorkspace(session);
        return;
      }
      previews.delete(file);
      if (code !== 0) {
        const details = session.output.trim();
        const message = details
          ? `Quarto exited with code ${String(code)}.\n\n${details}`
          : `Quarto exited with code ${String(code)}.`;
        showFailure(session, message);
        void vscode.window.showErrorMessage("Quarto preview failed. See the qmd2pdf output.");
        outputChannel.show(true);
      } else {
        showFailure(session, "The Quarto preview process has ended.");
      }
      void cleanupWorkspace(session);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(message);
    previews.delete(file);
    showFailure(session, `Could not prepare an isolated project copy: ${message}`);
    void vscode.window.showErrorMessage(`qmd2pdf: could not prepare an isolated project copy: ${message}`);
    void cleanupWorkspace(session);
  }

  panel.reveal(vscode.ViewColumn.Beside);
}

async function showPreview(session: PreviewSession, previewUrl: string): Promise<void> {
  try {
    const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(previewUrl));
    if (session.stopping || session.panel.visible === false) {
      return;
    }

    const frameOrigin = new URL(externalUri.toString()).origin;
    const frameUrl = escapeHtml(externalUri.toString());
    session.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeHtml(frameOrigin)}; style-src 'unsafe-inline';">
  <title>qmd2pdf</title>
  <style>
    html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
    body { overflow: hidden; }
  </style>
</head>
<body>
  <iframe title="Quarto document preview" src="${frameUrl}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
</body>
</html>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showFailure(session, `Could not open the preview inside VS Code: ${message}`);
    void vscode.window.showErrorMessage(`qmd2pdf: ${message}`);
  }
}

function stopPreview(): void {
  const document = vscode.window.activeTextEditor?.document;
  const session = document && path.extname(document.fileName).toLowerCase() === ".qmd"
    ? previews.get(document.fileName)
    : [...previews.values()].find((preview) => preview.panel.active);
  if (!session) {
    void vscode.window.showInformationMessage("Focus the QMD file or its preview to stop the live preview.");
    return;
  }

  session.stopping = true;
  for (const [file, preview] of previews) {
    if (preview === session) {
      previews.delete(file);
      break;
    }
  }
  session.process?.kill();
  session.panel.dispose();
}

async function findProjectRoot(documentDirectory: string): Promise<string> {
  let directory = documentDirectory;
  while (true) {
    for (const configName of ["_quarto.yml", "_quarto.yaml"]) {
      try {
        const stat = await fs.stat(path.join(directory, configName));
        if (stat.isFile()) {
          return directory;
        }
      } catch (error) {
        if (!isMissingPath(error)) {
          throw error;
        }
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return documentDirectory;
    }
    directory = parent;
  }
}

async function ensureConfigFiles(context: vscode.ExtensionContext): Promise<PreviewConfigPaths> {
  const configuredDirectory = (
    vscode.workspace.getConfiguration("qmd2pdf").get<string>("configDirectory", "")
    || vscode.workspace.getConfiguration("qmdLivePreview").get<string>("configDirectory", "")
  ).trim();
  const configDirectory = configuredDirectory
    ? path.resolve(configuredDirectory)
    : path.join(context.globalStorageUri.fsPath, "config");

  await fs.mkdir(configDirectory, { recursive: true });

  const configPaths = {
    quartoYaml: path.join(configDirectory, "_quarto.yaml"),
    luaFilter: path.join(configDirectory, "filter.lua"),
  };
  const bundledDefaults = {
    quartoYaml: path.join(context.extensionUri.fsPath, "_quarto.yaml"),
    luaFilter: path.join(context.extensionUri.fsPath, "filter.lua"),
  };
  const previousConfigDirectory = configuredDirectory
    ? undefined
    : path.join(path.dirname(context.globalStorageUri.fsPath), "local.qmd-live-preview", "config");

  for (const key of ["quartoYaml", "luaFilter"] as const) {
    try {
      await fs.access(configPaths[key]);
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      let sourcePath = bundledDefaults[key];
      if (previousConfigDirectory) {
        const previousPath = path.join(previousConfigDirectory, path.basename(configPaths[key]));
        try {
          await fs.access(previousPath);
          sourcePath = previousPath;
        } catch (migrationError) {
          if (!isMissingPath(migrationError)) {
            throw migrationError;
          }
        }
      }
      await fs.copyFile(sourcePath, configPaths[key]);
    }
  }

  return configPaths;
}

async function openConfigFiles(context: vscode.ExtensionContext): Promise<void> {
  try {
    const configPaths = await ensureConfigFiles(context);
    const yamlDocument = await vscode.workspace.openTextDocument(configPaths.quartoYaml);
    await vscode.window.showTextDocument(yamlDocument, {
      preview: false,
      viewColumn: vscode.ViewColumn.Active,
    });

    const luaDocument = await vscode.workspace.openTextDocument(configPaths.luaFilter);
    await vscode.window.showTextDocument(luaDocument, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`qmd2pdf: could not open config files: ${message}`);
  }
}

function shouldCopyProjectPath(sourceRoot: string, sourcePath: string): boolean {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (relativePath === "") {
    return true;
  }

  const segments = relativePath.split(path.sep);
  if (segments.length === 1 && ["_quarto.yaml", "_quarto.yml", "filter.lua"].includes(segments[0].toLowerCase())) {
    return false;
  }
  return !segments.some((segment) => excludedDirectories.has(segment.toLowerCase()));
}

function syncSavedDocument(session: PreviewSession, contents: string): void {
  if (session.stopping || !session.stagedFile) {
    return;
  }

  session.syncQueue = session.syncQueue
    .then(async () => {
      if (session.stopping) {
        return;
      }
      const currentCopy = await fs.readFile(session.stagedFile, "utf8");
      if (currentCopy !== contents) {
        await fs.writeFile(session.stagedFile, contents, "utf8");
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`Could not sync the saved QMD to its preview copy: ${message}`);
      void vscode.window.showErrorMessage(`qmd2pdf: could not sync the saved document: ${message}`);
    });
}

function cleanupWorkspace(session: PreviewSession): Promise<void> {
  if (!session.cleanupPromise) {
    session.cleanupPromise = session.syncQueue.then(async () => {
      if (session.workspaceDirectory) {
        await fs.rm(session.workspaceDirectory, { recursive: true, force: true });
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`Could not remove the isolated QMD preview copy: ${message}`);
      void vscode.window.showErrorMessage(`qmd2pdf: could not remove its temporary project copy: ${message}`);
    });
  }
  return session.cleanupPromise;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function showFailure(session: PreviewSession, message: string): void {
  if (session.panel.visible === false) {
    return;
  }
  session.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>body { padding: 1rem; font-family: var(--vscode-font-family); color: var(--vscode-foreground); } pre { white-space: pre-wrap; }</style>
</head>
<body><h2>QMD preview failed</h2><pre>${escapeHtml(message)}</pre></body>
</html>`;
}

function loadingHtml(webview: vscode.Webview): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
  <style>body { padding: 1rem; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }</style>
</head>
<body><p>Starting Quarto live preview...</p></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function appendOutput(session: PreviewSession, value: string): void {
  const text = stripAnsi(value);
  session.output = (session.output + text).slice(-8000);
  const match = /Browse at\s+(https?:\/\/[^\s]+)/i.exec(session.output);
  if (match?.[1]) {
    session.output = session.output.slice(match.index + match[0].length);
    void showPreview(session, match[1].replace(/[),.]+$/, ""));
  }
}

export function deactivate(): void {
  for (const session of previews.values()) {
    session.stopping = true;
    session.process?.kill();
    session.panel.dispose();
  }
  previews.clear();
}
