document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const titleEl = document.querySelector('h1, [data-course-name], .onVhub');
        const courseName = titleEl ? titleEl.innerText.trim() : document.title.split("-")[0].trim();
        return courseName.replace(/[/\\?%*:|"<>]/g, "-").trim();
      }
    }, (results) => {
      if (results && results[0] && results[0].result) {
        const folderInput = document.getElementById("targetFolder");
        if (folderInput) folderInput.value = results[0].result;
      }
    });
  }

  const btnSettings = document.getElementById("btnOpenSettings");
  if (btnSettings) {
    btnSettings.addEventListener("click", () => {
      chrome.tabs.create({ url: "chrome://settings/downloads" });
    });
  }

  const btnCancel = document.getElementById("btnCancel");
  if (btnCancel) {
    btnCancel.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "cancelDownloads" }, () => {
        const status = document.getElementById("status");
        if (status) status.textContent = "⏹️ Descargas detenidas.";
      });
    });
  }
});

document.getElementById("btnDownload").addEventListener("click", async () => {
  const status = document.getElementById("status");
  const btn = document.getElementById("btnDownload");
  const targetFolder = (document.getElementById("targetFolder")?.value || "").trim();

  btn.disabled = true;
  status.textContent = "Extrayendo archivos de la profesora...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    status.textContent = "No se pudo acceder a la pestaña.";
    btn.disabled = false;
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractTeacherMaterials
  }, async (results) => {
    if (!results || !results[0] || !results[0].result) {
      status.textContent = "Error al leer los links de la página.";
      btn.disabled = false;
      return;
    }

    let { files } = results[0].result;

    if (files.length === 0) {
      status.textContent = "No se encontraron adjuntos. Despliega los temas o haz scroll hasta abajo.";
      btn.disabled = false;
      return;
    }

    // Prefijar la subcarpeta elegida por el usuario
    if (targetFolder) {
      files = files.map(f => ({
        ...f,
        filename: `${targetFolder}/${f.filename}`
      }));
    }

    status.textContent = `¡Encontrados ${files.length} archivos! Descargando en "${targetFolder || 'Descargas'}"...`;

    // Delegar descargas al Service Worker de fondo para que no se interrumpa
    chrome.runtime.sendMessage({ action: "startDownloads", files }, (res) => {
      status.textContent = `¡Iniciada la descarga de ${files.length} archivos en "${targetFolder || 'Descargas'}"! Puedes cerrar esta ventana.`;
      btn.disabled = false;
    });
  });
});

async function extractTeacherMaterials() {
  const authMatch = window.location.pathname.match(/\/u\/(\d+)/) || window.location.search.match(/authuser=(\d+)/);
  const authUser = authMatch ? authMatch[1] : "0";

  // 1. Detectar ID de la materia actual (sea /c/ o /w/ - Trabajo en clase)
  const courseMatch = window.location.pathname.match(/\/(?:c|w)\/([a-zA-Z0-9_-]+)/);
  const activeCourseId = courseMatch ? courseMatch[1] : null;

  let rootScope = document.body;
  if (activeCourseId) {
    const targetWiz = Array.from(document.querySelectorAll('c-wiz')).find(w => {
      const dp = w.getAttribute('data-p') || '';
      const s = window.getComputedStyle(w);
      return dp.includes(activeCourseId) && s.display !== 'none';
    });
    if (targetWiz) {
      rootScope = targetWiz;
    }
  }

  // 2. Desplegar automáticamente todas las tareas/tarjetas colapsadas del curso
  const taskButtons = Array.from(rootScope.querySelectorAll('li div[role="button"][aria-expanded="false"], .SFCE1b[aria-expanded="false"]'));
  if (taskButtons.length > 0) {
    taskButtons.forEach(b => {
      try { b.click(); } catch(e) {}
    });
    // Esperar a que la SPA de Google Classroom monte los elementos en el DOM
    await new Promise(r => setTimeout(r, 1500));
  }

  // 3. Extraer todos los enlaces de Drive y Docs dentro del contenedor de la materia activa
  const links = Array.from(rootScope.querySelectorAll('a[href*="/file/d/"], a[href*="docs.google.com"]'));
  const seenIds = new Set();
  const files = [];

  const fileRegex = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/;
  const docsRegex = /docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([a-zA-Z0-9_-]+)/;

  links.forEach(a => {
    const href = a.href || "";
    if (href.includes("/drive/folders/")) return;

    let title = a.innerText.replace(/\r?\n/g, " ").trim();
    if (!title || title.length < 3) {
      title = a.getAttribute("aria-label") || "";
    }
    title = title.replace(/\r?\n/g, " ").trim();
    if (title.endsWith("PDF")) title = title.slice(0, -3).trim();
    if (title.endsWith("Microsoft Word")) title = title.slice(0, -14).trim();
    if (title.endsWith("Video")) title = title.slice(0, -5).trim();
    if (title.endsWith("Presentaciones de Google")) title = title.slice(0, -24).trim();

    // Sanitizar nombre para el sistema de archivos (remover : / \ * ? " < > |)
    const sanitizeName = (raw, defaultId) => {
      if (!raw || raw.startsWith("http://") || raw.startsWith("https://")) {
        return `archivo_${defaultId}`;
      }
      return raw.replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, " ").trim();
    };

    // Archivos de Drive (PDF, PNG, MP4, etc.)
    const fileMatch = href.match(fileRegex);
    if (fileMatch) {
      const id = fileMatch[1];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        let filename = sanitizeName(title, id);
        if (!filename.includes(".")) filename += ".pdf";
        files.push({
          id,
          filename,
          downloadUrl: `https://drive.usercontent.google.com/download?id=${id}&export=download&authuser=${authUser}`
        });
      }
      return;
    }

    // Google Docs / Slides / Sheets
    const docMatch = href.match(docsRegex);
    if (docMatch) {
      const type = docMatch[1];
      const id = docMatch[2];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        let downloadUrl = "";
        let filename = sanitizeName(title, id);
        if (type === "document") {
          downloadUrl = `https://docs.google.com/document/u/${authUser}/d/${id}/export?format=pdf`;
          if (!filename.endsWith(".pdf")) filename += ".pdf";
        } else if (type === "presentation") {
          downloadUrl = `https://docs.google.com/presentation/u/${authUser}/d/${id}/export/pdf`;
          if (!filename.endsWith(".pdf")) filename += ".pdf";
        } else if (type === "spreadsheets") {
          downloadUrl = `https://docs.google.com/spreadsheets/u/${authUser}/d/${id}/export?format=xlsx`;
          if (!filename.endsWith(".xlsx")) filename += ".xlsx";
        }
        files.push({ id, filename, downloadUrl });
      }
    }
  });

  return { files };
}
