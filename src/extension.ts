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
  const panel = vscode.window.createWebviewPanel(
    "qmd2pdf",
    `qmd2pdf: ${path.basename(file)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(workspaceDirectory), pdfjsDirectory],
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

    const pdfModuleUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(pdfjsDirectory.fsPath, "pdf.mjs")));
    const pdfWorkerUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(pdfjsDirectory.fsPath, "pdf.worker.mjs")));
    const pdfAssetUri = `${panel.webview.asWebviewUri(pdfjsDirectory).toString().replace(/\/$/, "")}/`;
    panel.webview.html = pdfPreviewHtml(
      panel.webview,
      pdfModuleUri.toString(),
      pdfWorkerUri.toString(),
      pdfAssetUri,
    );

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
  return new Promise((resolve) => {
    const child = spawn("quarto", ["render", session.relativeFile], {
      cwd: session.workspaceDirectory,
      windowsHide: true,
    });
    session.process = child;
    let output = "";
    let settled = false;
    const append = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-12000);
      outputChannel.append(chunk.toString());
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
        });
        void vscode.window.showErrorMessage("qmd2pdf: PDF render failed. See the qmd2pdf output.");
        outputChannel.show(true);
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
        resolve();
      }).catch((accessError: unknown) => {
        const message = accessError instanceof Error ? accessError.message : String(accessError);
        session.renderStatus = `Quarto finished, but the expected PDF was not found: ${message}`;
        session.panel.webview.postMessage({
          type: "renderError",
          message: session.renderStatus,
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

function pdfPreviewHtml(
  webview: vscode.Webview,
  pdfModuleUri: string,
  pdfWorkerUri: string,
  pdfAssetUri: string,
): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src ${webview.cspSource} blob:; style-src ${webview.cspSource} 'unsafe-inline'; img-src data: blob:; font-src ${webview.cspSource} data:; connect-src ${webview.cspSource};">
  <title>qmd2pdf PDF Preview</title>
  <style>
    html, body { height: 100%; margin: 0; }
    body { display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    header { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    button, select, input { min-height: 28px; color: var(--vscode-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
    button { padding: 3px 9px; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { opacity: .6; cursor: wait; }
    select { padding: 2px 6px; }
    input { box-sizing: border-box; width: 52px; padding: 2px 5px; text-align: center; }
    .separator { height: 22px; border-left: 1px solid var(--vscode-panel-border); }
    #status { font-size: 12px; }
    #pages { flex: 1; overflow: auto; padding: 16px; scroll-behavior: smooth; }
    .page { position: relative; width: min(100%, 816px); aspect-ratio: 612 / 792; margin: 0 auto 16px; background: white; box-shadow: 0 1px 5px #0005; }
    .page canvas { display: block; }
    .text-layer { position: absolute; inset: 0; overflow: hidden; line-height: 1; transform-origin: 0 0; z-index: 1; }
    .text-layer span, .text-layer br { position: absolute; color: transparent; white-space: pre; transform-origin: 0 0; user-select: text; }
    .text-layer > :not(.markedContent), .text-layer .markedContent span:not(.markedContent) { font-size: calc(var(--total-scale-factor) * var(--font-height)); transform: rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)); }
    .text-layer ::selection { background: rgb(0 100 255 / 30%); color: transparent; }
  </style>
</head>
<body>
  <header>
    <button id="previous-page" type="button" aria-label="Previous page" disabled>‹</button>
    <input id="page-number" type="number" min="1" value="1" aria-label="Current page" disabled>
    <span id="page-count" aria-label="Total pages">/ —</span>
    <button id="next-page" type="button" aria-label="Next page" disabled>›</button>
    <span class="separator" aria-hidden="true"></span>
    <button id="zoom-out" type="button" aria-label="Zoom out" disabled>−</button>
    <select id="zoom-level" aria-label="Zoom level" disabled>
      <option value="50">50%</option><option value="75">75%</option>
      <option value="100" selected>Fit width</option><option value="125">125%</option>
      <option value="150">150%</option><option value="200">200%</option><option value="300">300%</option>
    </select>
    <button id="zoom-in" type="button" aria-label="Zoom in" disabled>+</button>
    <span class="separator" aria-hidden="true"></span>
    <button id="save-pdf" type="button" disabled>Save PDF As...</button>
    <span id="status" role="status" aria-live="polite">Waiting for the first render...</span>
  </header>
  <main id="pages" aria-label="PDF pages. Use Page Up and Page Down to navigate." tabindex="0"></main>
  <script type="module" nonce="${nonce}">
    import * as pdfjsLib from "${pdfModuleUri}";
    const vscode = acquireVsCodeApi();
    const saveButton = document.getElementById("save-pdf");
    const status = document.getElementById("status");
    const pages = document.getElementById("pages");
    const pageNumberInput = document.getElementById("page-number");
    const pageCount = document.getElementById("page-count");
    const previousPageButton = document.getElementById("previous-page");
    const nextPageButton = document.getElementById("next-page");
    const zoomSelect = document.getElementById("zoom-level");
    const zoomOutButton = document.getElementById("zoom-out");
    const zoomInButton = document.getElementById("zoom-in");
    let documentVersion = 0;
    let renderVersion = 0;
    let hasPdf = false;
    let pdfDocument;
    let loadingTask;
    let zoomPercent = 100;
    let activePage = 1;
    const pageViews = new Map();
    const renderTasks = new Map();
    const renderingPages = new Map();
    pdfjsLib.GlobalWorkerOptions.workerSrc = "${pdfWorkerUri}";

    function updatePageControls() {
      if (!pdfDocument) return;
      pageNumberInput.value = String(activePage);
      pageNumberInput.max = String(pdfDocument.numPages);
      pageCount.textContent = "/ " + pdfDocument.numPages;
      previousPageButton.disabled = activePage <= 1;
      nextPageButton.disabled = activePage >= pdfDocument.numPages;
    }

    function updateZoomButtons() {
      const zoomOptions = [...zoomSelect.options];
      const index = zoomOptions.findIndex((option) => Number(option.value) === zoomPercent);
      zoomSelect.value = String(zoomPercent);
      zoomOutButton.disabled = index <= 0;
      zoomInButton.disabled = index < 0 || index >= zoomOptions.length - 1;
    }

    function goToPage(pageNumber) {
      if (!pdfDocument) return;
      activePage = Math.max(1, Math.min(pdfDocument.numPages, Math.trunc(pageNumber) || 1));
      pageViews.get(activePage)?.element.scrollIntoView({ block: "start" });
      updatePageControls();
      renderPage(activePage);
    }

    function setZoom(value) {
      const options = [...zoomSelect.options].map((option) => Number(option.value));
      const nextZoom = Math.max(options[0], Math.min(options[options.length - 1], value));
      if (nextZoom === zoomPercent) return;
      zoomPercent = nextZoom;
      refreshVisiblePages();
      updateZoomButtons();
    }

    function refreshVisiblePages() {
      renderVersion++;
      for (const [pageNumber, task] of renderTasks) {
        task.cancel();
        renderTasks.delete(pageNumber);
      }
      for (const view of pageViews.values()) {
        view.renderedZoom = 0;
        view.textLayerRenderer?.cancel();
        view.textLayer.replaceChildren();
        view.canvas.width = 0;
        view.canvas.height = 0;
      }
      renderNearbyPages();
    }

    function renderNearbyPages() {
      const bounds = pages.getBoundingClientRect();
      const margin = Math.max(700, bounds.height);
      for (const [pageNumber, view] of pageViews) {
        const rect = view.element.getBoundingClientRect();
        if (rect.bottom >= bounds.top - margin && rect.top <= bounds.bottom + margin) {
          renderPage(pageNumber);
        }
      }
    }

    async function renderPage(pageNumber) {
      const view = pageViews.get(pageNumber);
      const doc = pdfDocument;
      const version = renderVersion;
      if (!view || !doc || renderingPages.has(pageNumber) || view.renderedZoom === zoomPercent) return;
      renderingPages.set(pageNumber, version);
      let renderTask;
      try {
        const page = await doc.getPage(pageNumber);
        if (doc !== pdfDocument || version !== renderVersion) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(200, pages.clientWidth - 48);
        const scale = (availableWidth / baseViewport.width) * (zoomPercent / 100);
        const viewport = page.getViewport({ scale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 3);
        view.element.style.width = Math.ceil(viewport.width) + "px";
        view.element.style.height = Math.ceil(viewport.height) + "px";
        view.element.style.aspectRatio = "auto";
        view.canvas.width = Math.ceil(viewport.width * outputScale);
        view.canvas.height = Math.ceil(viewport.height * outputScale);
        view.canvas.style.width = Math.ceil(viewport.width) + "px";
        view.canvas.style.height = Math.ceil(viewport.height) + "px";

        renderTask = page.render({
          canvas: view.canvas,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
        });
        renderTasks.set(pageNumber, renderTask);
        await renderTask.promise;
        if (doc === pdfDocument && version === renderVersion) {
          view.renderedZoom = zoomPercent;
          view.textLayer.style.setProperty("--total-scale-factor", String(scale * (96 / 72)));
          view.textLayerRenderer = new pdfjsLib.TextLayer({
            textContentSource: page.streamTextContent({ includeMarkedContent: true }),
            container: view.textLayer,
            viewport,
          });
          view.textLayerRenderer.render().catch((error) => {
            if (error?.name !== "AbortException") {
              status.textContent = "Could not load selectable text for page " + pageNumber + ".";
            }
          });
        }
      } catch (error) {
        if (error?.name !== "RenderingCancelledException") {
          status.textContent = "Could not render page " + pageNumber + ": " + (error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (renderTasks.get(pageNumber) === renderTask) {
          renderTasks.delete(pageNumber);
        }
        if (renderingPages.get(pageNumber) === version) {
          renderingPages.delete(pageNumber);
        }
        if (doc === pdfDocument && version !== renderVersion) {
          window.requestAnimationFrame(() => renderPage(pageNumber));
        }
      }
    }

    const pageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const page = Number(entry.target.dataset.page);
          renderPage(page);
        }
      }
    }, { root: pages, rootMargin: "900px 0px", threshold: [0, 0.25, 0.5, 0.75, 1] });

    async function showPdf(url) {
      const currentVersion = ++documentVersion;
      renderVersion++;
      loadingTask?.destroy();
      for (const task of renderTasks.values()) task.cancel();
      renderTasks.clear();
      renderingPages.clear();
      for (const view of pageViews.values()) {
        view.textLayerRenderer?.cancel();
      }
      pdfDocument = undefined;
      pageViews.clear();
      pageObserver.disconnect();
      pages.replaceChildren();
      pageNumberInput.disabled = true;
      previousPageButton.disabled = true;
      nextPageButton.disabled = true;
      zoomSelect.disabled = true;
      zoomOutButton.disabled = true;
      zoomInButton.disabled = true;
      status.textContent = "Loading rendered PDF...";
      try {
        loadingTask = pdfjsLib.getDocument({
          url,
          cMapUrl: "${pdfAssetUri}cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "${pdfAssetUri}standard_fonts/",
          wasmUrl: "${pdfAssetUri}wasm/",
        });
        const pdf = await loadingTask.promise;
        if (currentVersion !== documentVersion) {
          await pdf.destroy();
          return;
        }
        pdfDocument = pdf;
        hasPdf = true;
        activePage = 1;
        const elements = [];
        for (let page = 1; page <= pdf.numPages; page++) {
          const element = document.createElement("section");
          element.className = "page";
          element.dataset.page = String(page);
          element.setAttribute("aria-label", "Page " + page);
          const canvas = document.createElement("canvas");
          const textLayer = document.createElement("div");
          textLayer.className = "text-layer";
          element.append(canvas, textLayer);
          elements.push(element);
          pageViews.set(page, { element, canvas, textLayer, renderedZoom: 0 });
        }
        pages.replaceChildren(...elements);
        for (const element of elements) pageObserver.observe(element);
        pageNumberInput.disabled = false;
        zoomSelect.disabled = false;
        zoomPercent = 100;
        updateZoomButtons();
        updatePageControls();
        saveButton.disabled = false;
        status.textContent = "PDF ready";
        renderPage(1);
      } catch (error) {
        if (currentVersion !== documentVersion) return;
        saveButton.disabled = !hasPdf;
        status.textContent = "Could not display PDF: " + (error instanceof Error ? error.message : String(error));
      }
    }

    previousPageButton.addEventListener("click", () => goToPage(activePage - 1));
    nextPageButton.addEventListener("click", () => goToPage(activePage + 1));
    pageNumberInput.addEventListener("change", () => goToPage(Number(pageNumberInput.value)));
    zoomSelect.addEventListener("change", () => setZoom(Number(zoomSelect.value)));
    zoomOutButton.addEventListener("click", () => {
      const options = [...zoomSelect.options].map((option) => Number(option.value));
      setZoom(options[Math.max(0, options.indexOf(zoomPercent) - 1)]);
    });
    zoomInButton.addEventListener("click", () => {
      const options = [...zoomSelect.options].map((option) => Number(option.value));
      setZoom(options[Math.min(options.length - 1, options.indexOf(zoomPercent) + 1)]);
    });
    pages.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const options = [...zoomSelect.options].map((option) => Number(option.value));
        const index = options.indexOf(zoomPercent);
        setZoom(options[Math.max(0, Math.min(options.length - 1, index + (event.deltaY < 0 ? 1 : -1)))]);
      }
    }, { passive: false });
    pages.addEventListener("scroll", () => {
      window.requestAnimationFrame(() => {
        renderNearbyPages();
        const bounds = pages.getBoundingClientRect();
        const center = bounds.top + bounds.height / 2;
        let nearestPage;
        let nearestDistance = Infinity;
        for (const [page, view] of pageViews) {
          const rect = view.element.getBoundingClientRect();
          if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
          const distance = Math.abs((rect.top + rect.bottom) / 2 - center);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPage = page;
          }
        }
        if (nearestPage) {
          activePage = nearestPage;
          updatePageControls();
        }
      });
    }, { passive: true });
    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (pdfDocument) refreshVisiblePages();
      }, 120);
    });
    pages.addEventListener("keydown", (event) => {
      if (event.key === "PageDown" || event.key === "ArrowDown") {
        event.preventDefault();
        goToPage(activePage + 1);
      } else if (event.key === "PageUp" || event.key === "ArrowUp") {
        event.preventDefault();
        goToPage(activePage - 1);
      } else if (event.key === "+" || event.key === "=") {
        const options = [...zoomSelect.options].map((option) => Number(option.value));
        setZoom(options[Math.min(options.length - 1, options.indexOf(zoomPercent) + 1)]);
      } else if (event.key === "-") {
        const options = [...zoomSelect.options].map((option) => Number(option.value));
        setZoom(options[Math.max(0, options.indexOf(zoomPercent) - 1)]);
      }
    });

    saveButton.addEventListener("click", () => {
      saveButton.disabled = true;
      status.textContent = "Choose where to save the PDF...";
      vscode.postMessage({ type: "savePdf" });
    });
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "loadPdf") {
        showPdf(message.url);
      } else if (message.type === "renderStatus") {
        status.textContent = message.message;
      } else if (message.type === "renderError") {
        saveButton.disabled = !hasPdf;
        status.textContent = message.message;
      } else if (message.type === "savePdfResult") {
        saveButton.disabled = false;
        status.textContent = message.message;
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
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
