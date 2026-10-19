const downloadQueue = [];
let isProcessing = false;
let isCancelled = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "cancelDownloads") {
    isCancelled = true;
    downloadQueue.length = 0; // Vaciar la cola pendiente
    console.log("⏹️ Cola de descargas cancelada por el usuario.");
    sendResponse({ canceled: true });
    return true;
  }

  if (message.action === "startDownloads") {
    isCancelled = false;
    const newFiles = message.files || [];
    downloadQueue.push(...newFiles);
    console.log(`📥 Agregados ${newFiles.length} archivos a la cola. Total pendientes: ${downloadQueue.length}`);

    processQueue();

    sendResponse({ started: true, queued: newFiles.length, total: downloadQueue.length });
    return true;
  }
});

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (downloadQueue.length > 0 && !isCancelled) {
    const item = downloadQueue.shift();
    if (!item) continue;

    try {
      await new Promise((resolve) => {
        chrome.downloads.download({
          url: item.downloadUrl,
          filename: item.filename,
          saveAs: false
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.warn(`Error al iniciar ${item.filename}:`, chrome.runtime.lastError.message);
          }
          // Pausa entre descargas para no saturar la conexión ni la API
          setTimeout(resolve, 800);
        });
      });
    } catch (err) {
      console.warn(`Fallo en archivo ${item.filename}:`, err);
    }
  }

  isProcessing = false;
  if (!isCancelled) {
    console.log("✅ Todas las colas de descarga se completaron con éxito.");
  }
}
  return true;
});
