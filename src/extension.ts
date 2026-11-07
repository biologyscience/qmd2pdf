import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { syncProjectConfigFiles } from "./project-config";

interface PreviewSession {
  process?: ChildProcess;
  panel: vscode.WebviewPanel;
  stopping: boolean;
  workspaceDirectory: string;
  stagedFile: string;
  stagedPdf: string;
  savingPdf: boolean;
  renderStatus: string;
  sourceFile: string;
  relativeFile: string;
  hasRenderedPdf: boolean;
  configWatchers: vscode.Disposable[];
  configSyncTimer?: NodeJS.Timeout;
  renderTimer?: NodeJS.Timeout;
  sourceRoot: string;
  extensionConfig?: PreviewConfigPaths;
  syncQueue: Promise<void>;
  renderQueue: Promise<void>;
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

  let workspaceDirectory: string;
  try {
    workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "qmd2pdf-preview-"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`qmd2pdf: could not create an isolated render folder: ${message}`);
    return;
  }

  const pdfjsDirectory = vscode.Uri.file(path.join(context.extensionUri.fsPath, "dist", "pdfjs"));
  const webviewDirectory = vscode.Uri.file(path.join(context.extensionUri.fsPath, "dist", "webview"));
  const panel = vscode.window.createWebviewPanel(
    "qmd2pdf",
    `qmd2pdf: ${path.basename(file)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(workspaceDirectory), pdfjsDirectory, webviewDirectory],
    },
  );

  const session: PreviewSession = {
    panel,
    stopping: false,
    workspaceDirectory,
    stagedFile: "",
    stagedPdf: "",
    savingPdf: false,
    renderStatus: "Preparing isolated project copy...",
    sourceFile: file,
    relativeFile: "",
    hasRenderedPdf: false,
    configWatchers: [],
    sourceRoot: "",
    syncQueue: Promise.resolve(),
    renderQueue: Promise.resolve(),
  };
  previews.set(file, session);

  panel.onDidDispose(() => {
    if (previews.get(file) === session) {
      previews.delete(file);
    }
    session.stopping = true;
    disposeConfigWatchers(session);
    if (session.renderTimer) {
      clearTimeout(session.renderTimer);
      session.renderTimer = undefined;
    }
    if (session.process) {
      session.process.kill();
    }
    void cleanupWorkspace(session);
  });

  try {
    const configPaths = await ensureConfigFiles(context);
    const sourceRoot = await findProjectRoot(path.dirname(file));
    session.sourceRoot = sourceRoot;
    session.extensionConfig = configPaths;
    await fs.cp(sourceRoot, session.workspaceDirectory, {
      recursive: true,
      filter: (source) => shouldCopyProjectPath(sourceRoot, source),
    });

    const relativeFile = path.relative(sourceRoot, file);
    session.relativeFile = relativeFile;
    await syncProjectConfigFiles(sourceRoot, session.workspaceDirectory, configPaths);
    watchProjectConfigFiles(session);
    const stagedFile = path.join(session.workspaceDirectory, relativeFile);
    await fs.mkdir(path.dirname(stagedFile), { recursive: true });
    session.stagedFile = stagedFile;
    session.stagedPdf = path.join(
      path.dirname(stagedFile),
      `${path.basename(stagedFile, path.extname(stagedFile))}.pdf`,
    );
    session.syncQueue = session.syncQueue.then(() => fs.writeFile(stagedFile, document.getText(), "utf8"));
    await session.syncQueue;

    if (session.stopping) {
      await cleanupWorkspace(session);
      return;
    }

    panel.webview.html = await loadPreviewHtml(panel.webview, context.extensionUri.fsPath);

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isRecord(message)) {
        return;
      }
      if (message.type === "savePdf") {
        await saveRenderedPdf(session, file);
      } else if (message.type === "ready") {
        session.panel.webview.postMessage({ type: "renderStatus", message: session.renderStatus });
        if (session.hasRenderedPdf) {
          postRenderedPdf(session);
        }
      }
    });

    requestRender(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(message);
    previews.delete(file);
    disposeConfigWatchers(session);
    showFailure(session, `Could not prepare an isolated project copy: ${message}`);
    void vscode.window.showErrorMessage(`qmd2pdf: could not prepare an isolated project copy: ${message}`);
    void cleanupWorkspace(session);
  }

  panel.reveal(vscode.ViewColumn.Beside);
}

function renderDocument(session: PreviewSession): Promise<void> {
  if (session.stopping) {
    return Promise.resolve();
  }

  session.renderStatus = "Rendering PDF...";
  session.panel.webview.postMessage({ type: "renderStatus", message: session.renderStatus });
  session.panel.webview.postMessage({ type: "renderStarted", message: session.renderStatus });
  return new Promise((resolve) => {
    const child = spawn("quarto", ["render", session.relativeFile], {
      cwd: session.workspaceDirectory,
      windowsHide: true,
    });
    session.process = child;
    let output = "";
    let settled = false;
    const append = (chunk: Buffer | string) => {
      const text = chunk.toString();
      output = (output + text).slice(-12000);
      outputChannel.append(text);
      session.panel.webview.postMessage({ type: "renderLog", text });
    };

    const finish = (error?: Error, code?: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (session.process === child) {
        session.process = undefined;
      }

      if (session.stopping) {
        resolve();
        return;
      }

      if (error || code !== 0) {
        const detail = error?.message || output.trim() || `Quarto exited with code ${String(code)}.`;
        outputChannel.appendLine(`Quarto render failed: ${detail}`);
        session.renderStatus = `Render failed: ${detail}`;
        session.panel.webview.postMessage({
          type: "renderError",
          message: session.renderStatus,
          log: output,
        });
        void vscode.window.showErrorMessage("qmd2pdf: PDF render failed. See the render log in the preview.");
        resolve();
        return;
      }

      void fs.access(session.stagedPdf).then(() => {
        if (session.stopping) {
          resolve();
          return;
        }
        session.hasRenderedPdf = true;
        session.renderStatus = "PDF updated.";
        postRenderedPdf(session);
        session.panel.webview.postMessage({ type: "renderStatus", message: session.renderStatus });
        session.panel.webview.postMessage({ type: "renderComplete" });
        resolve();
      }).catch((accessError: unknown) => {
        const message = accessError instanceof Error ? accessError.message : String(accessError);
        session.renderStatus = `Quarto finished, but the expected PDF was not found: ${message}`;
        session.panel.webview.postMessage({
          type: "renderError",
          message: session.renderStatus,
          log: output,
        });
        void vscode.window.showErrorMessage("qmd2pdf: render completed without producing the expected PDF.");
        resolve();
      });
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code));
  });
}

function requestRender(session: PreviewSession): void {
  if (session.stopping) {
    return;
  }
  if (session.renderTimer) {
    clearTimeout(session.renderTimer);
  }
  session.renderTimer = setTimeout(() => {
    session.renderTimer = undefined;
    session.renderQueue = session.renderQueue
      .then(async () => {
        await session.syncQueue;
        await renderDocument(session);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Could not render QMD: ${message}`);
        session.renderStatus = `Render failed: ${message}`;
        session.panel.webview.postMessage({ type: "renderError", message: session.renderStatus });
        void vscode.window.showErrorMessage(`qmd2pdf: could not render PDF: ${message}`);
    });
  }, 150);
}

function postRenderedPdf(session: PreviewSession): void {
  const pdfUri = session.panel.webview.asWebviewUri(vscode.Uri.file(session.stagedPdf));
  session.panel.webview.postMessage({
    type: "loadPdf",
    url: pdfUri.with({ query: `v=${Date.now()}` }).toString(),
  });
}

async function loadPreviewHtml(webview: vscode.Webview, extensionPath: string): Promise<string> {
  const webviewDirectory = path.join(extensionPath, "dist", "webview");
  const stylesheetUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDirectory, "preview.css")));
  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDirectory, "preview.js")));
  const pdfjsDirectory = path.join(extensionPath, "dist", "pdfjs");
  const pdfModuleUri = webview.asWebviewUri(vscode.Uri.file(path.join(pdfjsDirectory, "pdf.mjs")));
  const pdfWorkerUri = webview.asWebviewUri(vscode.Uri.file(path.join(pdfjsDirectory, "pdf.worker.mjs")));
  const pdfAssetUri = webview.asWebviewUri(vscode.Uri.file(pdfjsDirectory)).toString().replace(/\/$/, "") + "/";
  const nonce = randomBytes(16).toString("base64");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; img-src data: blob:; font-src ${webview.cspSource} data:; connect-src ${webview.cspSource};`;
  const html = await fs.readFile(path.join(webviewDirectory, "preview.html"), "utf8");
  const replacements: Record<string, string> = {
    "{{csp}}": csp,
    "{{cssUri}}": stylesheetUri.toString(),
    "{{nonce}}": nonce,
    "{{scriptUri}}": scriptUri.toString(),
    "{{pdfModuleUri}}": pdfModuleUri.toString(),
    "{{pdfWorkerUri}}": pdfWorkerUri.toString(),
    "{{pdfAssetUri}}": pdfAssetUri,
  };
  return html.replace(/{{[A-Za-z]+}}/g, (placeholder) => {
    const value = replacements[placeholder];
    if (!value) {
      throw new Error(`Missing preview HTML value for ${placeholder}.`);
    }
    return escapeHtml(value);
  });
}

async function saveRenderedPdf(session: PreviewSession, sourceFile: string): Promise<void> {
  if (!session.hasRenderedPdf) {
    session.panel.webview.postMessage({
      type: "savePdfResult",
      message: "The PDF is not ready yet. Wait for rendering to finish, then try again.",
    });
    return;
  }
  if (session.savingPdf) {
    return;
  }
  session.savingPdf = true;
  try {
    await fs.access(session.stagedPdf);
  } catch (error) {
    session.savingPdf = false;
    if (!isMissingPath(error)) {
      reportSaveError(session, error);
      return;
    }
    session.panel.webview.postMessage({
      type: "savePdfResult",
      message: "The PDF is not ready yet. Wait for rendering to finish, then try again.",
    });
    return;
  }

  try {
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(path.dirname(sourceFile), `${path.basename(sourceFile, path.extname(sourceFile))}.pdf`),
      ),
      filters: { "PDF files": ["pdf"] },
      saveLabel: "Save PDF",
      title: "Save Rendered PDF",
    });
    if (!destination) {
      session.panel.webview.postMessage({ type: "savePdfResult", message: "Save canceled." });
      return;
    }

    await vscode.workspace.fs.copy(vscode.Uri.file(session.stagedPdf), destination, { overwrite: true });
    session.panel.webview.postMessage({
      type: "savePdfResult",
      message: `Saved PDF to ${path.basename(destination.path)}.`,
    });
  } catch (error) {
    reportSaveError(session, error);
  } finally {
    session.savingPdf = false;
  }
}

function reportSaveError(session: PreviewSession, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  outputChannel.appendLine(`Could not save rendered PDF: ${message}`);
  session.panel.webview.postMessage({
    type: "savePdfResult",
    message: `Could not save PDF: ${message}`,
  });
  void vscode.window.showErrorMessage(`qmd2pdf: could not save rendered PDF: ${message}`);
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

  disposeConfigWatchers(session);
  for (const [file, preview] of previews) {
    if (preview === session) {
      previews.delete(file);
      break;
    }
  }
  session.process?.kill();
  session.panel.dispose();
}

function watchProjectConfigFiles(session: PreviewSession): void {
  const projectUri = vscode.Uri.file(session.sourceRoot);
  for (const fileName of ["_quarto.yaml", "_quarto.yml", "filter.lua"]) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(projectUri, fileName),
      false,
      false,
      false,
    );
    session.configWatchers.push(watcher);
    session.configWatchers.push(
      watcher.onDidChange(() => scheduleProjectConfigSync(session)),
      watcher.onDidCreate(() => scheduleProjectConfigSync(session)),
      watcher.onDidDelete(() => scheduleProjectConfigSync(session)),
    );
  }
}

function scheduleProjectConfigSync(session: PreviewSession): void {
  if (session.stopping || !session.extensionConfig) {
    return;
  }
  if (session.configSyncTimer) {
    clearTimeout(session.configSyncTimer);
  }
  session.configSyncTimer = setTimeout(() => {
    session.configSyncTimer = undefined;
    session.syncQueue = session.syncQueue
      .then(async () => {
        if (session.stopping || !session.extensionConfig) {
          return;
        }
        const configChanged = await syncProjectConfigFiles(
          session.sourceRoot,
          session.workspaceDirectory,
          session.extensionConfig,
        );
        if (configChanged && !session.stopping) {
          requestRender(session);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Could not sync changed project config files: ${message}`);
        void vscode.window.showErrorMessage(`qmd2pdf: could not sync changed YAML/Lua config: ${message}`);
      });
  }, 100);
}

function disposeConfigWatchers(session: PreviewSession): void {
  if (session.configSyncTimer) {
    clearTimeout(session.configSyncTimer);
    session.configSyncTimer = undefined;
  }
  for (const watcher of session.configWatchers) {
    watcher.dispose();
  }
  session.configWatchers = [];
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
      requestRender(session);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`Could not sync the saved QMD to its preview copy: ${message}`);
      void vscode.window.showErrorMessage(`qmd2pdf: could not sync the saved document: ${message}`);
    });
}

function cleanupWorkspace(session: PreviewSession): Promise<void> {
  if (!session.cleanupPromise) {
    session.cleanupPromise = Promise.all([session.syncQueue, session.renderQueue]).then(async () => {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

export function deactivate(): void {
  for (const session of previews.values()) {
    session.stopping = true;
    session.process?.kill();
    session.panel.dispose();
  }
  previews.clear();
}
