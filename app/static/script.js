/* MailSized script – v6.2 (redirect + totals guards) */
(function () {
  const $  = (sel) => document.querySelector(sel);

  // Core elements
  const uploadArea    = $("#uploadArea");
  const fileInput     = $("#fileInput");
  const fileInfo      = $("#fileInfo");
  const fileNameEl    = $("#fileName");
  const fileSizeEl    = $("#fileSize");
  const fileDurationEl= $("#fileDuration");
  const removeFileBtn = $("#removeFile");

  const providersWrap = $("#providerList") || document; // in some templates it's document
  const agreeCb       = $("#agree");
  const userEmail     = $("#userEmail");
  const processBtn    = $("#processButton");

  const errorBox      = $("#errorContainer");
  const errorMsg      = $("#errorMessage");

  // Totals (defensive lookups)
  const basePriceEl       = $("#basePrice");
  const priorityPriceEl   = $("#priorityPrice");
  const transcriptPriceEl = $("#transcriptPrice");
  const taxAmountEl       = $("#taxAmount");
  const totalAmountEl     = $("#totalAmount");

  const checkboxPriority  = $("#priority");
  const checkboxTranscript= $("#transcript");

  // Progress (post-payment)
  const postPaySection = $("#postPaySection");
  const progressFill   = $("#progressFill");
  const progressPct    = $("#progressPct");
  const progressNote   = $("#progressNote");
  const downloadSection= $("#downloadSection");
  const downloadLink   = $("#downloadLink");

  // Local state
  let chosenProvider = "gmail";
  let uploaded = null;  // { job_id, size_bytes, duration_sec, tier, price_cents }
  let isPaying = false;

  // Util
  const money = (n) => `$${(n || 0).toFixed(2)}`;
  const showErr = (m) => {
    if (!errorBox || !errorMsg) return;
    errorMsg.textContent = m || "An error occurred.";
    errorBox.style.display = "block";
  };
  const hideErr = () => { if (errorBox) errorBox.style.display = "none"; };

  // Pricing calc (simple: use label text already in your table; keep JS amounts for sidebar summary only)
  function calcTotals() {
    try {
      // Base price from displayed tier (read from active provider's small label)
      const activeCard = document.querySelector(".provider-card.selected .provider-price");
      // Fallback: flat $1.99 if not present
      const base = activeCard ? parseFloat((activeCard.textContent.match(/\$([\d.]+)/) || [0, "1.99"])[1]) : 1.99;

      const pr = checkboxPriority && checkboxPriority.checked ? 0.75 : 0;
      const tr = checkboxTranscript && checkboxTranscript.checked ? 1.50 : 0;
      const subtotal = base + pr + tr;
      const tax = subtotal * 0.10;
      const total = subtotal + tax;

      // Guard every node
      if (basePriceEl)       basePriceEl.textContent       = money(base);
      if (priorityPriceEl)   priorityPriceEl.textContent   = money(pr);
      if (transcriptPriceEl) transcriptPriceEl.textContent = money(tr);
      if (taxAmountEl)       taxAmountEl.textContent       = money(tax);
      if (totalAmountEl)     totalAmountEl.textContent     = money(total);

      // Also stash cents for checkout
      return Math.round(total * 100);
    } catch (e) {
      // If anything goes wrong, keep UI usable and don’t throw
      return 299; // safe fallback
    }
  }

  function humanSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    const u = ["B","KB","MB","GB"];
    let i=0, v=bytes;
    while (v >= 1024 && i < u.length-1) { v/=1024; i++; }
    return `${v.toFixed(1)} ${u[i]}`;
  }

  function setStep(activeIdx) {
    for (let i=1;i<=4;i++){
      const el = document.getElementById(`step${i}`);
      if (el) el.classList.toggle("active", i===activeIdx);
    }
  }

  // Upload UI
  function showFile(file) {
    if (!fileInfo || !fileNameEl || !fileSizeEl) return;
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = humanSize(file.size);
    fileDurationEl && (fileDurationEl.textContent = "");
    fileInfo.style.display = "flex";
  }
  function clearFile() {
    if (fileInput) fileInput.value = "";
    if (fileInfo)  fileInfo.style.display = "none";
    uploaded = null;
    hideErr();
    setStep(1);
    // Re-enable button in case an earlier failure disabled it
    if (processBtn){ processBtn.disabled = false; processBtn.textContent = "Pay & Compress"; }
  }

  // ---------- Event wiring ----------
  if (uploadArea && fileInput) {
    uploadArea.addEventListener("click", () => fileInput.click());
    uploadArea.addEventListener("dragover", (e)=>{ e.preventDefault(); uploadArea.classList.add("dragover"); });
    uploadArea.addEventListener("dragleave", ()=> uploadArea.classList.remove("dragover"));
    uploadArea.addEventListener("drop", (e)=>{
      e.preventDefault();
      uploadArea.classList.remove("dragover");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        const f = e.dataTransfer.files[0];
        showFile(f);
      }
    });
    fileInput.addEventListener("change", (e)=>{
      const f = e.target.files && e.target.files[0];
      if (f) showFile(f);
    });
  }

  removeFileBtn && removeFileBtn.addEventListener("click", clearFile);

  providersWrap && providersWrap.addEventListener("click", (e)=>{
    const card = e.target.closest(".provider-card");
    if (!card) return;
    document.querySelectorAll(".provider-card").forEach(c=>c.classList.remove("selected"));
    card.classList.add("selected");
    chosenProvider = card.dataset.provider || "gmail";
    calcTotals();
  });

  checkboxPriority && checkboxPriority.addEventListener("change", calcTotals);
  checkboxTranscript && checkboxTranscript.addEventListener("change", calcTotals);

  // ---------- Upload then checkout ----------
  async function uploadFile() {
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      showErr("Please choose a video file first.");
      return null;
    }
    hideErr();
    setStep(1);

    const form = new FormData();
    form.append("file", fileInput.files[0]);
    form.append("provider", chosenProvider);

    if (userEmail && userEmail.value) form.append("email", userEmail.value);

    const res = await fetch("/upload", { method: "POST", body: form });
    if (!res.ok) {
      const txt = await res.text().catch(()=> "");
      showErr(txt || "Upload failed.");
      return null;
    }
    // Expect JSON
    let data;
    try { data = await res.json(); }
    catch { showErr("Upload response was not JSON."); return null; }

    // Minimal shape: { job_id, price_cents }
    if (!data || !data.job_id) {
      showErr("Upload response missing job id.");
      return null;
    }
    return data; // keep whole payload (duration, tier, etc.)
  }

  async function goToCheckout(uploadMeta) {
    // Compute final price the same way we show it
    const price_cents = calcTotals();

    const body = {
      job_id: uploadMeta.job_id,
      price_cents,
      email: (userEmail && userEmail.value) || null,
    };

    const res = await fetch("/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // We deliberately avoid alert() here; it blocks navigation in some browsers.
    if (!res.ok) {
      const txt = await res.text().catch(()=> "");
      showErr(txt || "Could not start payment.");
      return;
    }

    // Parse JSON safely
    let payload = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try { payload = await res.json(); } catch { /* fall back below */ }
    } else {
      try { payload = JSON.parse(await res.text()); } catch { /* ignore */ }
    }

    const url = payload && payload.url;
    if (!url) {
      showErr("Payment link missing. Please try again.");
      return;
    }

    // Navigate
    window.location.assign(url);
  }

  async function onPayClick() {
    if (isPaying) return;           // avoid double‑submit
    if (!agreeCb || !agreeCb.checked) {
      showErr("Please agree to the Terms & Conditions.");
      return;
    }

    isPaying = true;
    hideErr();
    setStep(2);
    if (processBtn) { processBtn.disabled = true; processBtn.textContent = "Starting…"; }

    try {
      const meta = await uploadFile();
      if (!meta) throw new Error("upload_failed");
      uploaded = meta;

      // No blocking alerts — go straight to Stripe
      await goToCheckout(meta);
    } catch (e) {
      // Show a friendly error and restore button
      showErr("Could not start payment.");
      if (processBtn){ processBtn.disabled = false; processBtn.textContent = "Pay & Compress"; }
      isPaying = false;
    }
  }

  // Attach click ONCE
  if (processBtn) {
    processBtn.addEventListener("click", onPayClick, { once: false });
  }

  // Initial totals
  calcTotals();

  // If we land on /?paid=1&job_id=... start progress polling
  (function resumeProgressIfNeeded() {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("paid") === "1" && sp.get("job_id")) {
      const job_id = sp.get("job_id");
      setStep(3);
      if (postPaySection) postPaySection.style.display = "block";

      const es = new EventSource(`/events/${job_id}`);
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          const p = Math.max(0, Math.min(100, data.progress || 0));
          if (progressFill) progressFill.style.width = `${p}%`;
          if (progressPct)  progressPct.textContent = `${p}%`;
          if (progressNote) progressNote.textContent = data.note || "Working…";

          if (data.status === "done" && data.download_url) {
            setStep(4);
            if (downloadSection) downloadSection.style.display = "block";
            if (downloadLink) { downloadLink.href = data.download_url; downloadLink.removeAttribute("disabled"); }
            es.close();
          }

          if (data.status === "error") {
            showErr(data.error || "Compression failed.");
            es.close();
          }
        } catch { /* ignore single bad event */ }
      };
      es.onerror = () => { /* keep it quiet; Render may recycle */ };
    }
  })();
})();
