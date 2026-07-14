const PLUGIN_ID = "zotero-pdf-deduplicator@xuan.dev";
const CHROME_NAME = "zotero-pdf-deduplicator";
const TOOLS_MENU_ITEM_ID = "zotero-pdf-deduplicator-scan-existing";
const FILE_READY_RETRIES = 10;
const FILE_READY_RETRY_DELAY_MS = 500;
const METADATA_BATCH_SIZE = 50;
const METADATA_BATCH_YIELD_MS = 20;
const HASH_CHUNK_SIZE_BYTES = 1024 * 1024;
const HASH_CHUNK_TIMEOUT_MS = 30 * 1000;
const LOG_PREFIX = "[PDF Deduplicator]";
const {
  setTimeout: setTimer,
  clearTimeout: clearTimer,
} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

var chromeHandle = null;
var notifierID = null;
var deduplicator = null;

function install() {}

async function startup({ rootURI }) {
  registerChrome(rootURI);

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  deduplicator = new PDFDeduplicator();
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify(event, type, ids) {
        if (event === "add" && type === "item") {
          deduplicator?.enqueue(ids);
        }
      },
    },
    ["item"],
    PLUGIN_ID,
  );

  for (const win of Zotero.getMainWindows()) {
    installMainWindowUI(win);
  }

  Zotero.debug(
    `${LOG_PREFIX} Started. New PDF attachments are monitored; existing PDFs are scanned only on demand.`,
  );
}

function onMainWindowLoad({ window }) {
  installMainWindowUI(window);
}

function onMainWindowUnload({ window }) {
  uninstallMainWindowUI(window);
}

async function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }

  for (const win of Zotero.getMainWindows()) {
    uninstallMainWindowUI(win);
  }

  deduplicator?.shutdown();
  deduplicator = null;

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}

function registerChrome(rootURI) {
  const addonManagerStartup = Cc[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Ci.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(`${rootURI}manifest.json`);
  chromeHandle = addonManagerStartup.registerChrome(manifestURI, [
    ["content", CHROME_NAME, `${rootURI}content/`],
  ]);
}

function installMainWindowUI(win) {
  if (win.document.getElementById(TOOLS_MENU_ITEM_ID)) {
    return;
  }

  const toolsPopup = win.document.getElementById("menu_ToolsPopup");
  if (!toolsPopup) {
    return;
  }

  const menuItem = win.document.createXULElement("menuitem");
  menuItem.id = TOOLS_MENU_ITEM_ID;
  menuItem.setAttribute("label", "Scan Existing PDFs...");
  menuItem.addEventListener("command", () => {
    void deduplicator?.scanExistingPDFs().catch((error) => {
      deduplicator?.reportError(error, "Failed to scan existing PDFs");
      Services.prompt.alert(
        win,
        "PDF Scan Failed",
        "The scan failed. Details were written to the Zotero error report.",
      );
    });
  });

  const addonsMenuItem = win.document.getElementById("menu_addons");
  toolsPopup.insertBefore(menuItem, addonsMenuItem || null);
}

function uninstallMainWindowUI(win) {
  win.document.getElementById(TOOLS_MENU_ITEM_ID)?.remove();
}

class PDFDeduplicator {
  constructor() {
    this.pendingIDs = [];
    this.queuedIDs = new Set();
    this.processing = false;
    this.scanInProgress = false;
    this.scanPromise = null;
    this.stopped = false;
    this.fingerprintCache = new Map();
  }

  enqueue(ids) {
    for (const rawID of ids) {
      const id = Number(rawID);
      if (!Number.isInteger(id) || this.queuedIDs.has(id)) {
        continue;
      }
      this.queuedIDs.add(id);
      this.pendingIDs.push(id);
    }

    this.startQueueIfIdle();
  }

  startQueueIfIdle() {
    if (
      this.processing ||
      this.scanInProgress ||
      this.stopped ||
      !this.pendingIDs.length
    ) {
      return;
    }
    this.processing = true;
    Promise.resolve().then(() => this.processQueue());
  }

  shutdown() {
    this.stopped = true;
    this.pendingIDs.length = 0;
    this.queuedIDs.clear();
    this.fingerprintCache.clear();
  }

  async processQueue() {
    try {
      while (
        !this.stopped &&
        !this.scanInProgress &&
        this.pendingIDs.length
      ) {
        const id = this.pendingIDs.shift();
        try {
          await this.processItem(id);
        } catch (error) {
          this.reportError(error, `Failed to process item ${id}`);
        } finally {
          this.queuedIDs.delete(id);
        }
      }
    } finally {
      this.processing = false;
      this.startQueueIfIdle();
    }
  }

  async scanExistingPDFs() {
    if (this.scanInProgress) {
      Services.prompt.alert(
        Zotero.getMainWindow(),
        "PDF Scan in Progress",
        "Wait for the current scan to finish before starting another one.",
      );
      return this.scanPromise;
    }

    this.scanInProgress = true;
    this.scanPromise = (async () => {
      while (this.processing && !this.stopped) {
        await Zotero.Promise.delay(50);
      }
      if (this.stopped) {
        return { completed: false };
      }
      return this.performExistingPDFScan();
    })();

    try {
      return await this.scanPromise;
    } finally {
      this.scanInProgress = false;
      this.scanPromise = null;
      this.startQueueIfIdle();
    }
  }

  async performExistingPDFScan() {
    // Avoid loading every Zotero.Item and calling getFilePathAsync() here.
    // That API also updates attachment and parent-item state, which turns a
    // read-only scan into thousands of main-thread object/UI updates.
    const attachmentRows =
      (await Zotero.DB.queryAsync(
        `SELECT IA.itemID AS itemID,
                I.libraryID AS libraryID,
                I.key AS itemKey,
                IA.linkMode AS linkMode,
                IA.path AS attachmentPath,
                IA.storageHash AS contentIndexHash
         FROM itemAttachments IA
         JOIN items I ON I.itemID = IA.itemID
    LEFT JOIN deletedItems DI ON DI.itemID = IA.itemID
        WHERE IA.contentType = 'application/pdf'
          AND DI.itemID IS NULL
     ORDER BY I.libraryID ASC, IA.itemID ASC`,
      )) || [];
    const itemIDs = attachmentRows.map((row) => Number(row.itemID));
    const scannedIDs = new Set(itemIDs.map(Number));
    const prefilterGroups = new Map();
    let availableCount = 0;
    let unavailableCount = 0;
    let errorCount = 0;
    const progress = createScanProgress(attachmentRows.length);

    try {
      for (
        let batchStart = 0;
        batchStart < attachmentRows.length;
        batchStart += METADATA_BATCH_SIZE
      ) {
        if (this.stopped) {
          return { completed: false };
        }

        const batchRows = attachmentRows.slice(
          batchStart,
          batchStart + METADATA_BATCH_SIZE,
        );
        for (const row of batchRows) {
          const itemID = Number(row.itemID);
          let contentIndexHash = row.contentIndexHash?.toLowerCase() || null;
          let metadata = null;

          try {
            // storageHash is Zotero's saved MD5 for a synced stored file. It
            // is only a lossless prefilter: byte-identical PDFs necessarily
            // share it, and SHA-256 below remains the final decision.
            if (!contentIndexHash) {
              metadata = await getHistoricalFileMetadata(row);
              if (!metadata) {
                unavailableCount++;
                continue;
              }
              contentIndexHash = await hashFileInProcess(
                metadata.path,
                metadata.size,
                null,
                "MD5",
              );
            }
          } catch (error) {
            errorCount++;
            this.reportError(
              error,
              `Failed to index existing PDF item ${itemID}`,
            );
            continue;
          }

          availableCount++;
          const groupKey = `${row.libraryID}\u0000${contentIndexHash}`;
          const group = prefilterGroups.get(groupKey) || [];
          group.push({
            itemID,
            row,
            fileName: getAttachmentFileName(row, itemID),
            metadata,
          });
          prefilterGroups.set(groupKey, group);
        }

        const processedCount = Math.min(
          batchStart + batchRows.length,
          attachmentRows.length,
        );
        progress.update(
          attachmentRows.length
            ? (processedCount / attachmentRows.length) * 45
            : 45,
          `Indexing candidates ${processedCount}/${attachmentRows.length}`,
        );
        // Give Zotero a real event-loop window between filesystem batches.
        await Zotero.Promise.delay(METADATA_BATCH_YIELD_MS);
      }

      const candidateGroups = [...prefilterGroups.values()].filter(
        (group) => group.length > 1,
      );
      const hashCandidateCount = candidateGroups.reduce(
        (sum, group) => sum + group.length,
        0,
      );
      const duplicates = [];
      let hashedCount = 0;

      for (const group of candidateGroups) {
        const firstByHash = new Map();
        for (const entry of group) {
          if (this.stopped) {
            return { completed: false };
          }

          try {
            if (!entry.metadata) {
              entry.metadata = await getHistoricalFileMetadata(entry.row);
            }
            if (!entry.metadata) {
              unavailableCount++;
              continue;
            }
            const fileName = entry.fileName;
            progress.update(
              45 +
                (hashCandidateCount
                  ? (hashedCount / hashCandidateCount) * 55
                  : 0),
              `Hashing SHA-256 candidate ${hashedCount + 1}/${hashCandidateCount} · ${fileName}`,
            );
            const fingerprint = await this.getFingerprintForMetadata(
              entry.itemID,
              entry.metadata.size,
              entry.metadata,
              (bytesRead, totalBytes) => {
                const fileProgress = totalBytes
                  ? bytesRead / totalBytes
                  : 1;
                const overallProgress = hashCandidateCount
                  ? (hashedCount + fileProgress) / hashCandidateCount
                  : 1;
                progress.update(
                  45 + overallProgress * 55,
                  `Hashing SHA-256 candidate ${hashedCount + 1}/${hashCandidateCount} · ${Math.round(fileProgress * 100)}% · ${fileName}`,
                );
              },
            );
            if (!fingerprint) {
              continue;
            }

            const existing = firstByHash.get(fingerprint.hash);
            if (existing) {
              duplicates.push({
                duplicateID: entry.itemID,
                existingID: existing.itemID,
                fingerprint,
              });
            } else {
              firstByHash.set(fingerprint.hash, entry);
            }
          } catch (error) {
            errorCount++;
            this.reportError(
              error,
              `Failed to hash existing PDF item ${entry.itemID}`,
            );
          } finally {
            hashedCount++;
            const hashProgress = hashCandidateCount
              ? (hashedCount / hashCandidateCount) * 55
              : 55;
            progress.update(
              45 + hashProgress,
              `Hashing SHA-256 candidates ${hashedCount}/${hashCandidateCount}`,
            );
          }
        }
      }

      progress.close();
      this.removeScannedItemsFromQueue(scannedIDs);

      let deletedCount = 0;
      for (const duplicate of duplicates) {
        if (this.stopped) {
          return { completed: false };
        }

        const duplicateAttachment = await Zotero.Items.getAsync(
          duplicate.duplicateID,
        );
        const existingAttachment = await Zotero.Items.getAsync(
          duplicate.existingID,
        );
        if (
          !this.isCandidatePDF(duplicateAttachment) ||
          !this.isCandidatePDF(existingAttachment)
        ) {
          continue;
        }

        const decision = this.showDuplicateDialog(
          duplicateAttachment,
          existingAttachment,
          duplicate.fingerprint,
          { historical: true },
        );
        if (decision.confirmed) {
          const deleted = await this.moveDuplicateToTrash(
            duplicateAttachment,
            decision.deleteScope,
          );
          if (deleted) {
            deletedCount++;
          }
        }
      }

      const result = {
        completed: true,
        totalCount: attachmentRows.length,
        availableCount,
        unavailableCount,
        duplicateCount: duplicates.length,
        deletedCount,
        errorCount,
      };
      showScanSummary(result);
      Zotero.debug(
        `${LOG_PREFIX} Existing PDF scan completed: ${JSON.stringify(result)}`,
      );
      return result;
    } finally {
      progress.close();
    }
  }

  removeScannedItemsFromQueue(scannedIDs) {
    this.pendingIDs = this.pendingIDs.filter((id) => !scannedIDs.has(id));
    for (const id of scannedIDs) {
      this.queuedIDs.delete(id);
    }
  }

  async processItem(id) {
    const attachment = await Zotero.Items.getAsync(id);
    if (!this.isCandidatePDF(attachment)) {
      return;
    }

    const newFingerprint = await this.waitForFingerprint(attachment);
    if (!newFingerprint || this.stopped) {
      return;
    }

    const contentIndexHash = await this.getContentIndexHash(
      attachment.id,
      newFingerprint,
    );
    if (!contentIndexHash || this.stopped) {
      return;
    }

    const duplicate = await this.findEarlierDuplicate(
      attachment,
      newFingerprint,
      contentIndexHash,
    );
    if (!duplicate || this.stopped) {
      return;
    }

    const decision = this.showDuplicateDialog(
      attachment,
      duplicate,
      newFingerprint,
    );
    if (!decision.confirmed || this.stopped) {
      return;
    }

    await this.moveDuplicateToTrash(attachment, decision.deleteScope);
  }

  isCandidatePDF(item) {
    return Boolean(
      item &&
        item.isAttachment() &&
        item.isPDFAttachment() &&
        !item.deleted,
    );
  }

  async waitForFingerprint(attachment) {
    for (let attempt = 0; attempt < FILE_READY_RETRIES; attempt++) {
      const fingerprint = await this.getFingerprint(attachment);
      if (fingerprint) {
        return fingerprint;
      }
      await Zotero.Promise.delay(FILE_READY_RETRY_DELAY_MS);
    }
    return null;
  }

  async getAttachmentMetadata(attachment) {
    const path = await attachment.getFilePathAsync();
    if (!path) {
      return null;
    }

    let stat;
    try {
      stat = await IOUtils.stat(path);
    } catch (error) {
      if (error?.name === "NotFoundError") {
        return null;
      }
      throw error;
    }

    if (stat.type && stat.type !== "regular") {
      return null;
    }

    return {
      path,
      size: stat.size,
      lastModified: stat.lastModified,
      cacheKey: `${path}\u0000${stat.size}\u0000${stat.lastModified}`,
    };
  }

  async getFingerprint(
    attachment,
    expectedSize,
    knownMetadata,
    onHashProgress,
  ) {
    const metadata =
      knownMetadata || (await this.getAttachmentMetadata(attachment));
    if (!metadata) {
      return null;
    }

    return this.getFingerprintForMetadata(
      attachment.id,
      expectedSize,
      metadata,
      onHashProgress,
    );
  }

  async getFingerprintForMetadata(
    itemID,
    expectedSize,
    metadata,
    onHashProgress,
  ) {

    // File size is a cheap first-stage filter. Avoid reading and hashing every
    // PDF in a large library when nearly all candidates differ in size.
    if (expectedSize !== undefined && metadata.size !== expectedSize) {
      return null;
    }

    const cached = this.fingerprintCache.get(itemID);
    if (cached?.cacheKey === metadata.cacheKey) {
      return cached.fingerprint;
    }

    const fingerprint = {
      path: metadata.path,
      size: metadata.size,
      hash: await sha256File(
        metadata.path,
        metadata.size,
        onHashProgress,
      ),
    };
    this.fingerprintCache.set(itemID, {
      cacheKey: metadata.cacheKey,
      fingerprint,
    });
    return fingerprint;
  }

  async getContentIndexHash(itemID, fingerprint) {
    const storedHash = await Zotero.DB.valueQueryAsync(
      "SELECT storageHash FROM itemAttachments WHERE itemID = ?",
      [itemID],
    );
    if (storedHash) {
      return String(storedHash).toLowerCase();
    }
    return hashFileInProcess(
      fingerprint.path,
      fingerprint.size,
      null,
      "MD5",
    );
  }

  async findEarlierDuplicate(
    attachment,
    newFingerprint,
    contentIndexHash,
  ) {
    const candidateRows = await Zotero.DB.queryAsync(
      `SELECT IA.itemID AS itemID, IA.storageHash AS contentIndexHash
         FROM itemAttachments IA
         JOIN items I ON I.itemID = IA.itemID
    LEFT JOIN deletedItems DI ON DI.itemID = IA.itemID
        WHERE I.libraryID = ?
          AND IA.contentType = 'application/pdf'
          AND IA.itemID < ?
          AND DI.itemID IS NULL
          AND (IA.storageHash = ? OR IA.storageHash IS NULL OR IA.storageHash = '')
     ORDER BY IA.itemID ASC`,
      [attachment.libraryID, attachment.id, contentIndexHash],
    );

    for (const row of candidateRows) {
      if (this.stopped) {
        return null;
      }

      const candidate = await Zotero.Items.getAsync(Number(row.itemID));
      if (!this.isCandidatePDF(candidate)) {
        continue;
      }

      let candidateMetadata = null;
      if (!row.contentIndexHash) {
        candidateMetadata = await this.getAttachmentMetadata(candidate);
        if (!candidateMetadata) {
          continue;
        }
        const candidateContentIndexHash = await hashFileInProcess(
          candidateMetadata.path,
          candidateMetadata.size,
          null,
          "MD5",
        );
        if (candidateContentIndexHash !== contentIndexHash) {
          continue;
        }
      }

      const candidateFingerprint = await this.getFingerprint(
        candidate,
        newFingerprint.size,
        candidateMetadata,
      );
      if (
        candidateFingerprint &&
        candidateFingerprint.size === newFingerprint.size &&
        candidateFingerprint.hash === newFingerprint.hash
      ) {
        return candidate;
      }
    }

    return null;
  }

  showDuplicateDialog(
    newAttachment,
    existingAttachment,
    fingerprint,
    { historical = false } = {},
  ) {
    const parentWindow = Zotero.getMainWindow();
    const newParent = newAttachment.parentItem || null;
    const existingParent = existingAttachment.parentItem || null;
    const model = {
      result: {
        confirmed: false,
        deleteScope: "attachment",
      },
      newItem: describeAttachment(newAttachment, newParent),
      existingItem: describeAttachment(existingAttachment, existingParent),
      hash: fingerprint.hash,
      size: formatFileSize(fingerprint.size),
      canDeleteParent: Boolean(newParent),
      labels: historical
        ? {
            intro: "Two existing PDFs have identical file contents.",
            newBadge: "Added later",
            existingBadge: "Added earlier",
            attachmentScope: "Remove only the later PDF",
            attachmentScopeDetail:
              "Keep its parent item and other attachments (recommended)",
            fallbackQuestion:
              "Move the later PDF attachment to the trash?",
          }
        : {
            intro:
              "The new PDF has identical file contents to an existing attachment.",
            newBadge: "New",
            existingBadge: "Existing",
            attachmentScope: "Remove only the new PDF",
            attachmentScopeDetail:
              "Keep its parent item and other attachments (recommended)",
            fallbackQuestion: "Move the new PDF attachment to the trash?",
          },
    };
    // Explicitly expose the plain object across the chrome-window boundary.
    model.wrappedJSObject = model;

    if (!parentWindow) {
      const confirmed = Services.prompt.confirm(
        null,
        "Duplicate PDF Found",
        `${model.newItem.documentTitle}\nhas the same file contents as a PDF already in the library.\n\n${model.labels.fallbackQuestion}`,
      );
      return {
        confirmed,
        deleteScope: "attachment",
      };
    }

    parentWindow.openDialog(
      `chrome://${CHROME_NAME}/content/duplicate-dialog.xhtml`,
      `${CHROME_NAME}-duplicate-dialog`,
      "chrome,dialog,modal,centerscreen,resizable=no,width=680,height=610",
      model,
    );
    return model.result;
  }

  async moveDuplicateToTrash(attachment, deleteScope) {
    let target = attachment;
    if (deleteScope === "parent" && attachment.parentItem) {
      target = attachment.parentItem;
    }

    if (!target.isEditable()) {
      Services.prompt.alert(
        Zotero.getMainWindow(),
        "Unable to Remove Duplicate",
        "The library or item is not editable, so nothing was removed.",
      );
      return false;
    }

    await Zotero.Items.trashTx([target.id]);
    this.fingerprintCache.delete(attachment.id);
    Zotero.debug(
      `${LOG_PREFIX} Moved duplicate ${target.libraryKey} to the trash.`,
    );
    return true;
  }

  reportError(error, context) {
    const normalized =
      error instanceof Error ? error : new Error(`${context}: ${String(error)}`);
    Zotero.logError(normalized);
    Zotero.debug(`${LOG_PREFIX} ${context}: ${normalized.message}`, 1);
  }
}

function createScanProgress(totalCount) {
  const progressWindow = new Zotero.ProgressWindow({ closeOnClick: false });
  progressWindow.show();
  progressWindow.changeHeadline("PDF Deduplicator");
  const line = new progressWindow.ItemProgress(
    "attachmentPDF",
    `Preparing to scan ${totalCount} PDFs`,
  );
  line.setProgress(0);
  let closed = false;

  return {
    update(percent, text) {
      if (closed) {
        return;
      }
      line.setText(text);
      line.setProgress(Math.max(0, Math.min(100, Math.round(percent))));
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      progressWindow.close();
    },
  };
}

function showScanSummary(result) {
  const progressWindow = new Zotero.ProgressWindow();
  progressWindow.show();
  progressWindow.changeHeadline("PDF Scan Complete");
  let summary = `Scanned ${result.totalCount} PDFs`;
  summary += result.duplicateCount
    ? `; found ${result.duplicateCount} duplicate${result.duplicateCount === 1 ? "" : "s"}`
    : "; no duplicates found";
  if (result.deletedCount) {
    summary += `; moved ${result.deletedCount} to the trash`;
  }
  if (result.unavailableCount) {
    summary += `; skipped ${result.unavailableCount} unavailable attachment${result.unavailableCount === 1 ? "" : "s"}`;
  }
  if (result.errorCount) {
    summary += `; ${result.errorCount} failed`;
  }
  progressWindow.addDescription(`${summary}.`);
  progressWindow.startCloseTimer(6000);
}

function describeAttachment(attachment, parent) {
  const documentTitle =
    parent?.getDisplayTitle?.() ||
    attachment.getDisplayTitle?.() ||
    attachment.attachmentFilename ||
    "Untitled PDF";
  return {
    documentTitle,
    attachmentTitle:
      attachment.attachmentFilename ||
      attachment.getDisplayTitle?.() ||
      "Untitled PDF",
    libraryName:
      Zotero.Libraries.get(attachment.libraryID)?.name || "Unknown library",
    dateAdded: attachment.dateAdded || "",
  };
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "Unknown";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const digits = unitIndex === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

async function getHistoricalFileMetadata(row) {
  const path = resolveHistoricalAttachmentPath(row);
  if (!path) {
    return null;
  }
  try {
    return await getPathMetadata(path);
  } catch (error) {
    if (error?.name !== "NotFoundError") {
      throw error;
    }

    // Some attachment-renaming tools change the filename on disk without
    // updating itemAttachments.path. Recover the file only when the storage
    // directory contains exactly one PDF, so the scan never guesses.
    const fallbackPath = await findRenamedStoredPDF(row, path);
    return fallbackPath ? getPathMetadata(fallbackPath) : null;
  }
}

async function getPathMetadata(path) {
  const stat = await IOUtils.stat(path);
  if (stat.type && stat.type !== "regular") {
    return null;
  }
  return createFileMetadata(path, stat.size, stat.lastModified);
}

async function findRenamedStoredPDF(row, expectedPath) {
  const linkMode = Number(row.linkMode);
  if (
    !row.attachmentPath?.startsWith("storage:") ||
    (linkMode !== Zotero.Attachments.LINK_MODE_IMPORTED_FILE &&
      linkMode !== Zotero.Attachments.LINK_MODE_IMPORTED_URL)
  ) {
    return null;
  }

  const storageDirectory = PathUtils.parent(expectedPath);
  let children;
  try {
    children = await IOUtils.getChildren(storageDirectory);
  } catch (error) {
    if (error?.name === "NotFoundError") {
      return null;
    }
    throw error;
  }

  const pdfPaths = children.filter((childPath) =>
    childPath.toLowerCase().endsWith(".pdf"),
  );
  return pdfPaths.length === 1 ? pdfPaths[0] : null;
}

function createFileMetadata(path, size, lastModified) {
  return {
    path,
    size,
    lastModified,
    cacheKey: `${path}\u0000${size}\u0000${lastModified}`,
  };
}

function getAttachmentFileName(row, itemID) {
  const attachmentPath = row.attachmentPath || "";
  const withoutStoragePrefix = attachmentPath.startsWith("storage:")
    ? attachmentPath.slice("storage:".length)
    : attachmentPath;

  // PathUtils.filename() only accepts an absolute platform path. Zotero's
  // imported attachments are stored as values such as "storage:paper.pdf",
  // so passing the relative part to PathUtils throws
  // NS_ERROR_FILE_UNRECOGNIZED_PATH and aborts the entire historical scan.
  // This value is only used as a progress label; parse both possible path
  // separators directly and leave path resolution to
  // resolveHistoricalAttachmentPath().
  const pathSegments = withoutStoragePrefix.split(/[\\/]/);
  return pathSegments[pathSegments.length - 1] || `Item ${itemID}`;
}

function resolveHistoricalAttachmentPath(row) {
  const linkMode = Number(row.linkMode);
  const attachmentPath = row.attachmentPath;
  if (!attachmentPath || linkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
    return null;
  }

  if (
    linkMode === Zotero.Attachments.LINK_MODE_IMPORTED_FILE ||
    linkMode === Zotero.Attachments.LINK_MODE_IMPORTED_URL ||
    linkMode === Zotero.Attachments.LINK_MODE_EMBEDDED_IMAGE
  ) {
    if (!attachmentPath.startsWith("storage:")) {
      return null;
    }
    const relativePath = attachmentPath.slice("storage:".length);
    if (!relativePath || relativePath.startsWith(".zotero")) {
      return null;
    }
    const storageDirectory =
      Zotero.Attachments.getStorageDirectoryByLibraryAndKey(
        Number(row.libraryID),
        row.itemKey,
      ).path;
    return PathUtils.joinRelative(storageDirectory, relativePath);
  }

  if (linkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE) {
    if (attachmentPath.startsWith(Zotero.Attachments.BASE_PATH_PLACEHOLDER)) {
      return Zotero.Attachments.resolveRelativePath(attachmentPath) || null;
    }
    // Old macOS persistent descriptors require loading a full Zotero.Item.
    // Treat them as unavailable during a historical scan instead of falling
    // back to the main-thread-heavy path for the whole library.
    if (attachmentPath.startsWith("AAAA")) {
      return null;
    }
    return attachmentPath;
  }

  return null;
}

async function sha256File(path, size, onProgress) {
  return hashFileInProcess(path, size, onProgress, "SHA256");
}

async function hashFileInProcess(path, size, onProgress, algorithm) {
  const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash,
  );
  hasher.init(algorithm === "MD5" ? hasher.MD5 : hasher.SHA256);

  let offset = 0;
  while (offset < size) {
    const maxBytes = Math.min(HASH_CHUNK_SIZE_BYTES, size - offset);
    const bytes = await withTimeout(
      IOUtils.read(path, { offset, maxBytes }),
      HASH_CHUNK_TIMEOUT_MS,
      `Reading the PDF exceeded ${HASH_CHUNK_TIMEOUT_MS / 1000} seconds`,
    );

    if (!bytes.length) {
      throw new Error(`Unexpected end of file while reading PDF: ${path}`);
    }

    hasher.update(bytes, bytes.length);
    offset += bytes.length;
    onProgress?.(offset, size);

    // Keep Zotero responsive while hashing large files.
    await Zotero.Promise.delay(0);
  }

  onProgress?.(size, size);
  const binaryHash = hasher.finish(false);
  let hexHash = "";
  for (let index = 0; index < binaryHash.length; index++) {
    hexHash += binaryHash.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return hexHash;
}

async function withTimeout(promise, timeoutMs, message) {
  let timerID;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timerID = setTimer(() => {
      const error = new Error(message);
      error.name = "HashReadTimeoutError";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimer(timerID);
  }
}
