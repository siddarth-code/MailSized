/* MailSized front-end – v6-progress
   - Upload -> price calc
   - Stripe checkout
   - After redirect ?paid=1&job_id=… → SSE progress with auto-reconnect
   - Polling fallback /status/<id> so UI never gets stuck at 2%
*/

(() => {
  console.log("Mailsized script version: v6-progress");

  // Elements
  const fileInput = document.getElementById("fileInput");
  const uploadArea = document.getElementById("uploadArea");
  const fileInfo = document.getElementById("fileInfo");
  const fileNameEl = document.getElementById("fileName");
  const fileSizeEl = document.getElementById("fileSize");
  const fileDurationEl = document.getElementById("fileDuration");
  const removeFileBtn = document.getElementById("removeFile");

  const providerBtns = document.querySelectorAll(".provider");
  const priorityChk = document.getElementById("priority");
  const transcriptChk = document.getElementById("transcript");
  const emailInput = document.getElementById("userEmail");
  const agreeChk = document.getElementById("agree");

  const errBox = document.getElementById("errorBox");
  const payBtn = document.getElementById("payBtn");

  const progressWrap = document.getElementById("progressWrap");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const downloadWrap = document.getElementById("downloadWrap");
  const downloadLink = document.getElementById("downloadLink");

  // Pricing
  const basePrice = document.getElementById("basePrice");
  const priorityPrice = document.getElementById("priorityPrice");
  const transcriptPrice = document.getElementById("transcriptPrice");
  const taxAmount = document.getElementById("taxAmount");
  const totalAmount = document.getElementById("totalAmount");

  const PROVIDER_PRICING = {
    gmail: [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other: [2.49, 3.99, 5.49],
  };

  let currentProvider = "gmail";
  let currentJob = null; // {id, tier}
  let optimisticTimer = null;
  let sse = null;
  let pollTimer = null;

  function dollars(n) { return `$${n.toFixed(2)}`; }
  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
    setTimeout(() => errBox.classList.add("hidden"), 5000);
  }
  function setProgress(pct, text) {
    const p = Math.max(0, Math.min(pct, 100));
    progressBar.style.width = `${p}%`;
    progressText.textContent = text || (p < 100 ? "Working…" : "Done");
  }

  // Drag/click upload area
  uploadArea.addEventListener("click", () => fileInput.click());
  uploadArea.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.classList.add("drag"); });
  ["dragleave", "drop"].forEach(ev => uploadArea.addEventListener(ev, () => uploadArea.classList.remove("drag")));
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) {
      fileInput.files = e.dataTransfer.files;
      handleUpload();
    }
  });
  fileInput.addEventListener("change", handleUpload);

  async function handleUpload() {
    errBox.classList.add("hidden");
    downloadWrap.classList.add("hidden");
    progressWrap.classList.add("hidden");
    progressBar.style.width = "0%";

    const f = fileInput.files?.[0];
    if (!f) return;

    // show file info immediately
    fileInfo.classList.remove("hidden");
    fileNameEl.textContent = f.name;
    fileSizeEl.textContent = `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
    fileDurationEl.textContent = "…";

    // POST /upload
    const fd = new FormData();
    fd.append("file", f);
    let resp;
    try {
      resp = await fetch("/upload", { method: "POST", body: fd });
    } catch (e) {
      showError("Upload failed (network).");
      return;
    }
    if (!resp.ok) {
      showError("Upload failed");
      return;
    }
    const data = await resp.json();
    currentJob = { id: data.job_id, tier: data.tier };
    // server probed duration, show it
    fileDurationEl.textContent = `${(data.duration_sec / 60).toFixed(1)} min`;

    // pricing paint
    recomputePrices();
  }

  // remove file
  removeFileBtn.addEventListener("click", (e) => {
    e.preventDefault();
    fileInput.value = "";
    fileInfo.classList.add("hidden");
    currentJob = null;
    recomputePrices();
  });

  // provider selection
  providerBtns.forEach(btn => btn.addEventListener("click", () => {
    providerBtns.forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    currentProvider = btn.dataset.provider;
    recomputePrices();
  }));
  [priorityChk, transcriptChk].forEach(el => el.addEventListener("change", recomputePrices));

  function recomputePrices() {
    if (!currentJob) {
      basePrice.textContent = "$0.00";
      priorityPrice.textContent = "$0.00";
      transcriptPrice.textContent = "$0.00";
      taxAmount.textContent = "$0.00";
      totalAmount.textContent = "$0.00";
      return;
    }
    const tier = Math.max(1, Math.min(3, currentJob.tier));
    const base = PROVIDER_PRICING[currentProvider][tier - 1];
    const ups1 = priorityChk.checked ? 0.75 : 0;
    const ups2 = transcriptChk.checked ? 1.50 : 0;
    const subtotal = base + ups1 + ups2;
    const tax = subtotal * 0.10;
    const total = subtotal + tax;

    basePrice.textContent = dollars(base);
    priorityPrice.textContent = dollars(ups1);
    transcriptPrice.textContent = dollars(ups2);
    taxAmount.textContent = dollars(tax);
    totalAmount.textContent = dollars(total);
  }

  // Stripe checkout (server returns a hosted session URL; we just redirect)
  payBtn.addEventListener("click", async () => {
    if (!currentJob) return showError("Please upload a video first.");
    if (!agreeChk.checked) return showError("Please agree to the Terms.");

    const fd = new FormData();
    fd.append("job_id", currentJob.id);
    fd.append("provider", currentProvider);
    fd.append("priority", String(priorityChk.checked));
    fd.append("transcript", String(transcriptChk.checked));
    fd.append("email", emailInput.value || "");

    let resp;
    try {
      resp = await fetch("/checkout", { method: "POST", body: fd });
    } catch {
      return showError("Could not start payment.");
    }
    if (!resp.ok) return showError("Could not start payment.");
    const data = await resp.json();
    window.location.href = data.checkout_url;
  });

  // When we come back from Stripe (?paid=1&job_id=XYZ) start progress tracking
  const url = new URL(window.location.href);
  if (url.searchParams.get("paid") === "1" && url.searchParams.get("job_id")) {
    const jid = url.searchParams.get("job_id");
    currentJob = { id: jid, tier: 1 }; // tier not needed now
    startProgress(jid);
  }

  function startProgress(jobId) {
    progressWrap.classList.remove("hidden");
    setProgress(2, "Working…");
    // optimistic progress (moves to 90–95% slowly)
    if (optimisticTimer) clearInterval(optimisticTimer);
    optimisticTimer = setInterval(() => {
      const cur = parseInt(progressBar.style.width || "2", 10);
      if (cur < 95) setProgress(cur + 1);
    }, 1500);

    // SSE with auto-reconnect
    startSSE(jobId);

    // polling fallback (always on, harmless if SSE delivers)
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch(`/status/${jobId}`);
        if (!r.ok) return;
        const s = await r.json();
        applyStatus(s);
      } catch {}
    }, 2000);
  }

  function startSSE(jobId) {
    try {
      if (sse) { try { sse.close(); } catch {} }
      sse = new EventSource(`/events/${jobId}`);
      sse.onmessage = (ev) => {
        try { applyStatus(JSON.parse(ev.data)); } catch {}
      };
      sse.onerror = () => {
        // Render Hobby occasionally drops idle SSE; reconnect after a short pause
        try { sse.close(); } catch {}
        setTimeout(() => startSSE(jobId), 1500);
      };
    } catch (e) {
      console.warn("SSE unavailable, relying on polling.");
    }
  }

  function applyStatus(payload) {
    if (!payload || !payload.status) return;
    // Use server-provided progress if present (overrides optimistic)
    if (typeof payload.progress === "number") setProgress(payload.progress);

    if (payload.status === "done" && payload.download_url) {
      if (optimisticTimer) clearInterval(optimisticTimer);
      if (pollTimer) clearInterval(pollTimer);
      try { if (sse) sse.close(); } catch {}
      setProgress(100, "Complete");
      downloadLink.href = payload.download_url;
      downloadWrap.classList.remove("hidden");
    }
    if (payload.status === "error") {
      if (optimisticTimer) clearInterval(optimisticTimer);
      if (pollTimer) clearInterval(pollTimer);
      try { if (sse) sse.close(); } catch {}
      showError("An error occurred during processing.");
    }
  }
})();
