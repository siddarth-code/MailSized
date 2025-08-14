/* MailSized client – upload → checkout → progress → download */

(() => {
  const $ = (id) => document.getElementById(id);

  // Elements required
  const fileInput = $("fileInput");
  const uploadArea = $("uploadArea");
  const fileInfo = $("fileInfo");
  const fileNameEl = $("fileName");
  const fileSizeEl = $("fileSize");
  const fileDurationEl = $("fileDuration");
  const processBtn = $("processButton");
  const errorBox = $("errorContainer");
  const errorMsg = $("errorMessage");
  const providerList = document.getElementById("providerList") || document;
  const priorityChk = $("priority");
  const transcriptChk = $("transcript");
  const emailInput = $("userEmail");
  const agreeChk = $("agree");

  const basePriceEl = $("basePrice");
  const priorityPriceEl = $("priorityPrice");
  const transcriptPriceEl = $("transcriptPrice");
  const taxAmountEl = $("taxAmount");
  const totalAmountEl = $("totalAmount");

  const postPaySection = $("postPaySection");
  const progressFill = $("progressFill");
  const progressPct = $("progressPct");
  const progressNote = $("progressNote");
  const downloadSection = $("downloadSection");
  const downloadLink = $("downloadLink");

  let currentJob = null; // { job_id, provider, tier, price, ... }

  // Provider cards: click handling
  providerList.addEventListener("click", (e) => {
    const card = e.target.closest("[data-provider]");
    if (!card) return;
    document.querySelectorAll(".provider-card").forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
    calcTotals(); // price update only
  });

  // Upload area behaviors
  uploadArea.addEventListener("click", () => fileInput.click());
  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("drag");
  });
  uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("drag"));
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("drag");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      fileInput.files = e.dataTransfer.files;
      doUpload();
    }
  });
  fileInput.addEventListener("change", doUpload);

  $("removeFile")?.addEventListener("click", () => {
    fileInput.value = "";
    fileInfo.style.display = "none";
    uploadArea.style.display = "flex";
    currentJob = null;
    setProgress(0, "Waiting for upload…");
  });

  priorityChk?.addEventListener("change", calcTotals);
  transcriptChk?.addEventListener("change", calcTotals);

  function showError(msg) {
    errorMsg.textContent = msg;
    errorBox.style.display = "block";
  }
  function hideError() {
    errorBox.style.display = "none";
    errorMsg.textContent = "";
  }

  function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function selectedProvider() {
    const sel = document.querySelector(".provider-card.selected");
    return sel ? sel.getAttribute("data-provider") : "gmail";
  }

  function pricesForProvider(provider, tier) {
    const map = {
      gmail: [1.99, 2.99, 4.99],
      outlook: [2.19, 3.29, 4.99],
      other: [2.49, 3.99, 5.49],
    };
    const arr = map[provider] || map.gmail;
    return arr[Math.max(1, Math.min(3, tier)) - 1];
  }

  function calcTotals() {
    if (!currentJob) return;

    const provider = selectedProvider();
    const base = pricesForProvider(provider, currentJob.tier);

    const priority = priorityChk?.checked ? 0.75 : 0.0;
    const transcript = transcriptChk?.checked ? 1.5 : 0.0;

    const subtotal = base + priority + transcript;
    const tax = +(subtotal * 0.1).toFixed(2);
    const total = +(subtotal + tax).toFixed(2);

    // Guard against missing spans (won’t crash)
    if (basePriceEl) basePriceEl.textContent = `$${base.toFixed(2)}`;
    if (priorityPriceEl) priorityPriceEl.textContent = `$${priority.toFixed(2)}`;
    if (transcriptPriceEl) transcriptPriceEl.textContent = `$${transcript.toFixed(2)}`;
    if (taxAmountEl) taxAmountEl.textContent = `$${tax.toFixed(2)}`;
    if (totalAmountEl) totalAmountEl.textContent = `$${total.toFixed(2)}`;
  }

  async function doUpload() {
    hideError();
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    // Show file info immediately
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = humanSize(file.size);
    fileDurationEl.textContent = "";
    uploadArea.style.display = "none";
    fileInfo.style.display = "flex";
    setProgress(2, "Uploading…");

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch("/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload failed");

      currentJob = data; // job_id, tier, price, duration_sec…
      // Fill duration meta (human)
      const mins = Math.floor((data.duration_sec || 0) / 60);
      const secs = Math.floor((data.duration_sec || 0) % 60);
      fileDurationEl.textContent = ` • ${mins}:${secs.toString().padStart(2, "0")} min`;

      setProgress(5, "Uploaded");
      calcTotals();
    } catch (err) {
      showError(err.message || "Upload failed");
      setProgress(0, "Waiting for upload…");
    }
  }

  function setProgress(pct, note) {
    if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (progressPct) progressPct.textContent = `${Math.max(0, Math.min(100, Math.floor(pct)))}%`;
    if (progressNote && note) progressNote.textContent = note;
  }

  processBtn.addEventListener("click", async () => {
    hideError();
    if (!currentJob) return showError("Please upload a video first.");
    if (!agreeChk?.checked) return showError("Please accept Terms & Conditions.");
    processBtn.disabled = true;

    // Stripe checkout (server creates session)
    try {
      const fd = new FormData();
      fd.append("job_id", currentJob.job_id);
      fd.append("provider", selectedProvider());
      fd.append("priority", priorityChk?.checked ? "true" : "false");
      fd.append("transcript", transcriptChk?.checked ? "true" : "false");
      fd.append("email", (emailInput?.value || "").trim());

      const res = await fetch("/checkout", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Payment init failed");

      window.location.href = data.checkout_url; // Stripe hosted
    } catch (e) {
      processBtn.disabled = false;
      showError(e.message || "Payment failed");
    }
  });

  // After Stripe redirect back:
  const qs = new URLSearchParams(window.location.search);
  if (qs.get("paid") === "1" && qs.get("job_id")) {
    // Show progress block & connect SSE
    postPaySection.style.display = "block";
    setProgress(8, "Queued…");
    const jobId = qs.get("job_id");
    const es = new EventSource(`/events/${jobId}`);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (typeof msg.percent === "number") {
          setProgress(msg.percent, msg.note || "");
        }
        if (msg.status === "done" && msg.download_url) {
          setProgress(100, "Done");
          downloadSection.style.display = "block";
          downloadLink.href = msg.download_url;
          es.close();
        }
        if (msg.status === "error") {
          showError("Compression failed. Please try another clip.");
          es.close();
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      // keep the UI informative even if SSE hiccups
      progressNote.textContent = "Working… (connection will auto‑recover)";
    };
  }
})();
