    const pdfModuleUri = document.body.dataset.pdfModule;
    const pdfWorkerUri = document.body.dataset.pdfWorker;
    const pdfAssetUri = document.body.dataset.pdfAssets;
    const pdfjsLib = await import(pdfModuleUri);
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
    const renderOverlay = document.getElementById("render-overlay");
    const renderTitle = document.getElementById("render-title");
    const renderMessage = document.getElementById("render-message");
    const renderLog = document.getElementById("render-log");
    const renderSpinner = document.getElementById("render-spinner");
    const renderCloseButton = document.getElementById("render-close");
    let documentVersion = 0;
    let renderVersion = 0;
    let hasPdf = false;
    let pdfDocument;
    let loadingTask;
    let zoomPercent = 100;
    let activePage = 1;
    let pendingScrollAnchor;
    const pageViews = new Map();
    const renderTasks = new Map();
    const renderingPages = new Map();
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUri;
    const pdfWorker = new pdfjsLib.PDFWorker({ name: "qmd2pdf" });
    const pdfWorkerReady = pdfWorker.promise;
    pdfWorkerReady.catch(() => {});

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

    function captureScrollAnchor() {
      if (!pdfDocument) return undefined;
      const containerRect = pages.getBoundingClientRect();
      const viewportOffset = Math.min(24, pages.clientHeight / 4);
      const anchorY = containerRect.top + viewportOffset;
      let closestPage;
      let closestDistance = Infinity;

      for (const [pageNumber, view] of pageViews) {
        const rect = view.element.getBoundingClientRect();
        const distance = anchorY < rect.top
          ? rect.top - anchorY
          : anchorY > rect.bottom
            ? anchorY - rect.bottom
            : 0;
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPage = { pageNumber, rect };
        }
        if (distance === 0) break;
      }

      if (!closestPage || closestPage.rect.height <= 0) return undefined;
      return {
        pageNumber: closestPage.pageNumber,
        pageFraction: Math.max(0, Math.min(
          1,
          (anchorY - closestPage.rect.top) / closestPage.rect.height,
        )),
        viewportOffset,
        horizontalFraction: pages.scrollLeft / Math.max(1, pages.scrollWidth - pages.clientWidth),
        zoomPercent,
      };
    }

    function restoreScrollAnchor(pdf) {
      if (!pendingScrollAnchor || pdf !== pdfDocument) return;
      const anchor = pendingScrollAnchor;
      pendingScrollAnchor = undefined;
      const pageNumber = Math.min(anchor.pageNumber, pdf.numPages);
      const view = pageViews.get(pageNumber);
      if (!view) return;

      const containerRect = pages.getBoundingClientRect();
      const pageRect = view.element.getBoundingClientRect();
      const pageTop = pages.scrollTop + pageRect.top - containerRect.top;
      const targetScrollTop = pageTop + pageRect.height * anchor.pageFraction - anchor.viewportOffset;
      const previousScrollBehavior = pages.style.scrollBehavior;
      pages.style.scrollBehavior = "auto";
      pages.scrollTop = Math.max(0, targetScrollTop);
      const maxScrollLeft = Math.max(0, pages.scrollWidth - pages.clientWidth);
      pages.scrollLeft = maxScrollLeft * anchor.horizontalFraction;
      window.requestAnimationFrame(() => {
        pages.style.scrollBehavior = previousScrollBehavior;
      });

      activePage = pageNumber;
      updatePageControls();
    }

    function goToPage(pageNumber) {
      if (!pdfDocument) return;
      activePage = Math.max(1, Math.min(pdfDocument.numPages, Math.trunc(pageNumber) || 1));
      createPageView(activePage, pdfDocument);
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
      if (pdfDocument) void renderAllPages(pdfDocument);
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
          if (pageNumber === 1) {
            status.textContent = "PDF displayed";
          }
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

    function createPageView(pageNumber, pdf) {
      if (pageViews.has(pageNumber) || pdf !== pdfDocument) return;
      const element = document.createElement("section");
      element.className = "page";
      element.dataset.page = String(pageNumber);
      element.setAttribute("aria-label", "Page " + pageNumber);
      const canvas = document.createElement("canvas");
      const textLayer = document.createElement("div");
      textLayer.className = "text-layer";
      element.append(canvas, textLayer);
      pages.append(element);
      pageViews.set(pageNumber, { element, canvas, textLayer, renderedZoom: 0 });
    }

    async function renderAllPages(pdf) {
      if (pdf !== pdfDocument) return;
      const currentVersion = renderVersion;
      const pageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
      await Promise.all(pageNumbers.map((pageNumber) => renderPage(pageNumber)));
      if (pdf === pdfDocument && currentVersion === renderVersion) {
        restoreScrollAnchor(pdf);
        status.textContent = "PDF displayed (" + pdf.numPages + (pdf.numPages === 1 ? " page)." : " pages).");
      }
    }

    async function showPdf(url) {
      if (!pendingScrollAnchor) {
        pendingScrollAnchor = captureScrollAnchor();
      }
      const currentVersion = ++documentVersion;
      renderVersion++;
      const previousLoadingTask = loadingTask;
      loadingTask = undefined;
      for (const task of renderTasks.values()) task.cancel();
      renderTasks.clear();
      renderingPages.clear();
      for (const view of pageViews.values()) {
        view.textLayerRenderer?.cancel();
      }
      pdfDocument = undefined;
      pageViews.clear();
      pages.replaceChildren();
      pageNumberInput.disabled = true;
      previousPageButton.disabled = true;
      nextPageButton.disabled = true;
      zoomSelect.disabled = true;
      zoomOutButton.disabled = true;
      zoomInButton.disabled = true;
      status.textContent = "Loading PDF...";
      try {
        await previousLoadingTask?.destroy();
        if (currentVersion !== documentVersion) return;
        await pdfWorkerReady;
        if (currentVersion !== documentVersion) return;
        loadingTask = pdfjsLib.getDocument({
          url,
          worker: pdfWorker,
          cMapUrl: pdfAssetUri + "cmaps/",
          cMapPacked: true,
          standardFontDataUrl: pdfAssetUri + "standard_fonts/",
          wasmUrl: pdfAssetUri + "wasm/",
        });
        const pdf = await loadingTask.promise;
        if (currentVersion !== documentVersion) {
          await pdf.destroy();
          return;
        }
        pdfDocument = pdf;
        hasPdf = true;
        activePage = 1;
        pages.replaceChildren();
        pageViews.clear();
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          createPageView(pageNumber, pdf);
        }
        pageNumberInput.disabled = false;
        zoomSelect.disabled = false;
        zoomPercent = pendingScrollAnchor?.zoomPercent ?? zoomPercent;
        updateZoomButtons();
        updatePageControls();
        saveButton.disabled = false;
        status.textContent = "Rendering PDF pages...";
        void renderAllPages(pdf);
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
    window.addEventListener("unload", () => {
      void loadingTask?.destroy();
      pdfWorker.destroy();
    });

    saveButton.addEventListener("click", () => {
      saveButton.disabled = true;
      status.textContent = "Choose where to save the PDF...";
      vscode.postMessage({ type: "savePdf" });
    });
    renderCloseButton.addEventListener("click", () => {
      renderOverlay.hidden = true;
    });
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "loadPdf") {
        showPdf(message.url);
      } else if (message.type === "renderStatus") {
        status.textContent = message.message;
      } else if (message.type === "renderStarted") {
        renderTitle.textContent = "Rendering PDF";
        renderMessage.textContent = message.message || "Quarto is rendering the document...";
        renderLog.textContent = "";
        renderSpinner.hidden = false;
        renderCloseButton.hidden = true;
        renderOverlay.hidden = false;
        renderOverlay.setAttribute("aria-busy", "true");
      } else if (message.type === "renderLog") {
        if (typeof message.text === "string") {
          renderLog.textContent = (renderLog.textContent + message.text).slice(-20000);
          renderLog.scrollTop = renderLog.scrollHeight;
        }
      } else if (message.type === "renderComplete") {
        renderOverlay.hidden = true;
        renderOverlay.setAttribute("aria-busy", "false");
      } else if (message.type === "renderError") {
        saveButton.disabled = !hasPdf;
        status.textContent = message.message;
        renderTitle.textContent = "PDF render failed";
        renderMessage.textContent = message.message || "Quarto could not render this document.";
        if (typeof message.log === "string" && message.log) {
          renderLog.textContent = message.log.slice(-20000);
        } else if (!renderLog.textContent) {
          renderLog.textContent = message.message || "No output was provided.";
        }
        renderLog.scrollTop = renderLog.scrollHeight;
        renderSpinner.hidden = true;
        renderCloseButton.hidden = false;
        renderOverlay.hidden = false;
        renderOverlay.setAttribute("aria-busy", "false");
      } else if (message.type === "savePdfResult") {
        saveButton.disabled = false;
        status.textContent = message.message;
      }
    });
    vscode.postMessage({ type: "ready" });
