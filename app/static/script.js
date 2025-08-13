/* script.js — v7 (safe updates + reliable upload) */
console.log("Mailsized script version: v7-safe-upload");

document.addEventListener("DOMContentLoaded", () => {
  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const setText = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  const show = (el) => el && (el.style.display = "");
  const hide = (el) => el && (el.style.display = "none");
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;

  // ---------- Elements ----------
  const uploadArea = $("#uploadArea");
  const fileInput = $("#fileInput");
  const fileInfo = $("#fileInfo");
  const fileNameEl = $("#fileName");
  const fileSizeEl = $("#fileSize");
  const fileDurationEl = $("#fileDuration");
  const removeFileBtn = $("#removeFile");

  const providerCards = document.querySelectorAll(".provider-card");
  const agree = $("#agree");
  const priority = $("#priority");
  const transcript = $("#transcript");
  const emailInput = $("#userEmail");
  const processBtn = $("#processButton");

  const errorBox = $("#errorContainer");
  const errorMsg = $("#errorMessage");
  const downloadSection = $("#downloadSection");
  const downloadLink = $("#downloadLink");

  const step1 = $("#step1"), step2 = $("#step2"), step3 = $("#step3"), step4 = $("#step4");

  // bottom progress bar container (compression)
  const progressWrap = document.createElement("div");
  progressWrap.className = "progress-card";
  progressWrap.style.display = "none";
  progressWrap.innerHTML = `
    <div class="notice-title"><i class="fas fa-spinner fa-spin"></i> Compression in progress...</div>
    <div class="progress"><div class="progress-inner" id="progressInner" style="width:2%"></div></div>
    <div class="progress-note" id="progressNote">Working…</div>
  `;
  // Insert just above the Pay button
  processBtn.parentElement.insertBefore(progressWrap, processBtn);

  // ---------- State ----------
  let job = null; // { job_id, duration_sec, size_bytes, tier, price, max_length_min, max_size_mb }
  let provider = "gmail";

  // pricing table (from your app config)
  const PROVIDER_PRICING = {
    gmail: [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other: [2.49, 3.99, 5.49],
  };
  const UPSELLS = { priority: 0.75, transcript: 1.50 };

  // ---------- UI helpers ----------
  function setStep(activeIdx) {
    [step1, step2, step3, step4].forEach((el, idx) => {
      if (!el) return;
      if (idx === activeIdx - 1) el.classList.add("active");
      else el.classList.remove("active");
    });
  }

  function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function humanDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")} min`;
  }

  function showError(msg) {
    if (!errorBox || !errorMsg) return;
    errorMsg.textContent = msg || "An error occurred.";
    show(errorBox);
  }
  function clearError() { hide(errorBox); if (errorMsg) errorMsg.textContent = ""; }

  function calcTier(durationSec, sizeBytes) {
    const minutes = durationSec / 60;
    const mb = sizeBytes / (1024 * 1024);
    if (minutes <= 5 && mb <= 500) return 1;
    if (minutes <= 10 && mb <= 1024) return 2;
    return 3;
  }

  function refreshTotals() {
    if (!job) return;
    const tier = calcTier(job.duration_sec, job.size_bytes);
    const base = (PROVIDER_PRICING[provider] || PROVIDER_PRICING.gmail)[tier - 1];
    const upsell =
      (priority && priority.checked ? UPSELLS.priority : 0) +
      (transcript && transcript.checked ? UPSELLS.transcript : 0);
    const subtotal = base + upsell;
    const tax = subtotal * 0.10;
    const total = subtotal + tax;

    setText("basePrice", money(base));
    setText("priorityPrice", money(priority && priority.checked ? UPSELLS.priority : 0));
    setText("transcriptPrice", money(transcript && transcript.checked ? UPSELLS.transcript : 0));
    setText("taxAmount", money(tax));
    setText("totalAmount", money(total));
  }

  function setProvider(newProvider) {
    provider = newProvider;
    providerCards.forEach((c) => c.classList.toggle("selected", c.dataset.provider === provider));
    refreshTotals();
  }

  // ---------- Upload ----------
  function wireUploadArea() {
    uploadArea?.addEventListener("click", () => fileInput?.click());
    uploadArea?.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.classList.add("dragging"); });
    uploadArea?.addEventListener("dragleave", () => uploadArea.classList.remove("dragging"));
    uploadArea?.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadArea.classList.remove("dragging");
      if (e.dataTransfer?.files?.length) {
        fileInput.files = e.dataTransfer.files;
        handleFileChosen();
      }
    });
    fileInput?.addEventListener("change", handleFileChosen);
  }

  async function handleFileChosen() {
    clearError();
    downloadSection && hide(downloadSection);

    if (!fileInput?.files?.length) return;
    const file = fileInput.files[0];

    // Show file chip
    show(fileInfo);
    if (fileNameEl) fileNameEl.textContent = file.name;
    if (fileSizeEl) fileSizeEl.textContent = humanSize(file.size);

    // POST /upload
    setStep(1);
    processBtn?.setAttribute("disabled", "true");
    const fd = new FormData();
    fd.append("file", file);

    try {
      const resp = await fetch("/upload", { method: "POST", body: fd });
      if (!resp.ok) {
        showError("Upload failed.");
        processBtn?.removeAttribute("disabled");
        return;
      }
      const data = await resp.json();

      // fill job state
      job = data;
      if (fileDurationEl) fileDurationEl.textContent = humanDuration(data.duration_sec || 0);

      // Reset totals with detected tier
      refreshTotals();

      setStep(2);
      processBtn?.removeAttribute("disabled");
    } catch (err) {
      console.error(err);
      showError("Upload failed.");
      processBtn?.removeAttribute("disabled");
    }
  }

  removeFileBtn?.addEventListener("click", () => {
    if (fileInput) fileInput.value = "";
    hide(fileInfo);
    job = null;
    setText("basePrice", "$0.00");
    setText("priorityPrice", "$0.00");
    setText("transcriptPrice", "$0.00");
    setText("taxAmount", "$0.00");
    setText("totalAmount", "$0.00");
  });

  // ---------- Provider + extras ----------
  providerCards.forEach((card) => {
    card.addEventListener("click", () => setProvider(card.dataset.provider || "gmail"));
  });
  priority?.addEventListener("change", refreshTotals);
  transcript?.addEventListener("change", refreshTotals);

  // ---------- Pay & start compression ----------
  processBtn?.addEventListener("click", async () => {
    clearError();
    if (!job) return showError("Please upload a video first.");
    if (!agree?.checked) return showError("You must agree to the Terms & Conditions.");

    setStep(2);
    processBtn.setAttribute("disabled", "true");

    const body = new URLSearchParams({
      job_id: job.job_id,
      provider,
      priority: String(!!priority?.checked),
      transcript: String(!!transcript?.checked),
      email: (emailInput?.value || "").trim(),
    });

    try {
      const resp = await fetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!resp.ok) throw new Error("checkout failed");
      const data = await resp.json();
      // redirect to Stripe
      window.location.href = data.checkout_url;
    } catch (e) {
      console.error(e);
      showError("Could not start payment.");
      processBtn.removeAttribute("disabled");
    }
  });

  // ---------- On return from Stripe (start SSE + show progress) ----------
  (function onReturn() {
    const params = new URLSearchParams(window.location.search);
    const paid = params.get("paid");
    const jid = params.get("job_id");
    if (!paid || !jid) return;

    // Show progress UI (bottom card) and switch header to step 3
    progressWrap.style.display = "";
    setStep(3);

    const inner = $("#progressInner");
    const note = $("#progressNote");

    const es = new EventSource(`/events/${jid}`);
    es.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.status === "processing") {
          if (inner) inner.style.width = "10%";
          if (note) note.textContent = "Queued…";
        } else if (payload.status === "compressing") {
          if (inner) inner.style.width = "50%";
          if (note) note.textContent = "Compressing…";
        } else if (payload.status === "finalizing") {
          if (inner) inner.style.width = "85%";
          if (note) note.textContent = "Finalizing…";
        } else if (payload.status === "done") {
          if (inner) inner.style.width = "100%";
          if (note) note.textContent = "Done!";
          setStep(4);
          es.close();
          if (downloadLink && payload.download_url) {
            downloadLink.href = payload.download_url;
            show(downloadSection);
          }
        } else if (payload.status === "error") {
          es.close();
          showError("An error occurred during processing.");
        }
      } catch (e) {
        console.warn("event parse err", e);
      }
    };
    es.onerror = () => {
      // If Render restarts the dyno, SSE can 502. Don’t crash the UI.
      console.warn("SSE error; will retry status via lightweight ping.");
    };
  })();

  // ---------- Init ----------
  wireUploadArea();
  setProvider("gmail");
  clearError();
  // let the header stepper lay out after DOM paint to avoid clipping on some mobile widths
  requestAnimationFrame(() => {
    [step1, step2, step3, step4].forEach((el) => el && (el.style.minWidth = "auto"));
  });
});
