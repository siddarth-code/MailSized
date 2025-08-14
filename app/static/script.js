/* MailSized script – v6.1 */

(function () {
  const $ = (sel) => document.querySelector(sel);

  // --- Elements we only need once ---
  const uploadArea = $("#uploadArea");
  const fileInput = $("#fileInput");
  const fileInfo = $("#fileInfo");
  const fileNameEl = $("#fileName");
  const fileSizeEl = $("#fileSize");
  const fileDurationEl = $("#fileDuration");
  const removeFileBtn = $("#removeFile");

  const providerList = $("#providerList") || document; // app index has this wrapper
  const checkboxPriority = $("#priority");
  const checkboxTranscript = $("#transcript");
  const emailInput = $("#userEmail");
  const agreeCb = $("#agree");
  const processBtn = $("#processButton");

  const errorBox = $("#errorContainer");
  const errorMsg = $("#errorMessage");

  const postPaySection = $("#postPaySection");
  const progressFill = $("#progressFill");
  const progressPct = $("#progressPct");
  const progressNote = $("#progressNote");
  const downloadSection = $("#downloadSection");
  const downloadLink = $("#downloadLink");

  let currentJob = null;      // { job_id, size_bytes, duration_sec, tier, price }
  let chosenProvider = "gmail";

  // --- Helpers ---
  function fmtMoney(n) { return `$${n.toFixed(2)}`; }
  function showErr(msg) {
    if (errorBox && errorMsg) {
      errorMsg.textContent = msg || "An error occurred.";
      errorBox.style.display = "block";
    }
  }
  function hideErr() {
    if (errorBox) errorBox.style.display = "none";
  }

  // --- Pricing calc with guards ---
  function calcTotals() {
    // pull elements fresh each time; if any missing, just stop gracefully
    const baseEl        = $("#basePrice");
    const priorityEl    = $("#priorityPrice");
    const transcriptEl  = $("#transcriptPrice");
    const taxEl         = $("#taxAmount");
    const totalEl       = $("#totalAmount");
    if (!baseEl || !priorityEl || !transcriptEl || !taxEl || !totalEl) return;

    // base by provider & tier (server sent Gmail price in upload response; we remap here)
    if (!currentJob) {
      baseEl.textContent = "$0.00";
      priorityEl.textContent = "$0.00";
      transcriptEl.textContent = "$0.00";
      taxEl.textContent = "$0.00";
      totalEl.textContent = "$0.00";
      return;
    }

    const PROVIDER_PRICING = {
      gmail:   [1.99, 2.99, 4.99],
      outlook: [2.19, 3.29, 4.99],
      other:   [2.49, 3.99, 5.49],
    };
    const tier = Number(currentJob.tier || 1);
    const base = PROVIDER_PRICING[chosenProvider][tier - 1];

    const upsPriority   = checkboxPriority && checkboxPriority.checked ? 0.75 : 0;
    const upsTranscript = checkboxTranscript && checkboxTranscript.checked ? 1.50 : 0;

    const sub = base + upsPriority + upsTranscript;
    const tax = +(sub * 0.10).toFixed(2);
    const total = sub + tax;

    baseEl.textContent       = fmtMoney(base);
    priorityEl.textContent   = fmtMoney(upsPriority);
    transcriptEl.textContent = fmtMoney(upsTranscript);
    taxEl.textContent        = fmtMoney(tax);
    totalEl.textContent      = fmtMoney(total);
  }

  function setStepActive(stepNum) {
    for (let i = 1; i <= 4; i++) {
      const el = document.getElementById(`step${i}`);
      if (el) el.classList.toggle("active", i === stepNum);
    }
  }

  // --- Upload handling ---
  async function doUpload(file) {
    hideErr();
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error("Upload failed");
    const data = await res.json();
    currentJob = data;
    setStepActive(2);
    calcTotals();
  }

  function wireUpload() {
    if (uploadArea) {
      uploadArea.addEventListener("click", () => fileInput && fileInput.click());
      uploadArea.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.classList.add("dragover"); });
      uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
      uploadArea.addEventListener("drop", (e) => {
        e.preventDefault();
        uploadArea.classList.remove("dragover");
        const f = e.dataTransfer.files?.[0];
        if (f) handlePickedFile(f);
      });
    }
    if (fileInput) {
      fileInput.addEventListener("change", () => {
        const f = fileInput.files?.[0];
        if (f) handlePickedFile(f);
      });
    }
    if (removeFileBtn) {
      removeFileBtn.addEventListener("click", () => {
        if (fileInput) fileInput.value = "";
        fileInfo && (fileInfo.style.display = "none");
        currentJob = null;
        calcTotals();
      });
    }
  }

  function handlePickedFile(file) {
    // show basic info immediately
    if (fileInfo) fileInfo.style.display = "flex";
    if (fileNameEl) fileNameEl.textContent = file.name;
    if (fileSizeEl)  fileSizeEl.textContent = `${(file.size / (1024*1024)).toFixed(1)} MB`;
    if (fileDurationEl) fileDurationEl.textContent = ""; // server probes duration

    doUpload(file).catch((e) => showErr(e.message));
  }

  // --- Provider / extras listeners ---
  function wireOptions() {
    (providerList || document).addEventListener("click", (e) => {
      const card = e.target.closest?.(".provider-card");
      if (!card) return;
      document.querySelectorAll(".provider-card").forEach((el) => el.classList.remove("selected"));
      card.classList.add("selected");
      chosenProvider = card.getAttribute("data-provider") || "gmail";
      calcTotals();
    });
    checkboxPriority && checkboxPriority.addEventListener("change", calcTotals);
    checkboxTranscript && checkboxTranscript.addEventListener("change", calcTotals);
  }

  // --- Checkout + progress ---
  async function startCheckout() {
    hideErr();
    if (!currentJob) return showErr("Please upload a video first.");
    if (!agreeCb?.checked) return showErr("Please accept the Terms & Conditions.");

    const fd = new FormData();
    fd.append("job_id", currentJob.job_id);
    fd.append("provider", chosenProvider);
    fd.append("priority", checkboxPriority?.checked ? "true" : "false");
    fd.append("transcript", checkboxTranscript?.checked ? "true" : "false");
    fd.append("email", (emailInput?.value || "").trim());

    const res = await fetch("/checkout", { method: "POST", body: fd });
    if (!res.ok) throw new Error("Could not start payment.");
    const data = await res.json();

    // redirect to Stripe
    window.location.href = data.checkout_url;
  }

  function wireCheckout() {
    processBtn && processBtn.addEventListener("click", () => {
      startCheckout().catch((e) => showErr(e.message));
    });

    // Paid return flow ?paid=1&job_id=...
    const u = new URL(window.location.href);
    if (u.searchParams.get("paid") === "1") {
      const jid = u.searchParams.get("job_id");
      if (jid && postPaySection) {
        setStepActive(3);
        postPaySection.style.display = "block";
        listenProgress(jid);
      }
    }
  }

  function listenProgress(jobId) {
    try {
      const es = new EventSource(`/events/${jobId}`);
      es.onmessage = (ev) => {
        let data = {};
        try { data = JSON.parse(ev.data); } catch {}
        if (data.status) {
          // Fake a simple progress “step bar” based on status transitions
          let pct = 2;
          if (data.status === "processing") pct = 15;
          if (data.status === "compressing") pct = 40;
          if (data.status === "finalizing") pct = 75;
          if (data.status === "done") pct = 100;

          if (progressFill) progressFill.style.width = `${pct}%`;
          if (progressPct)  progressPct.textContent = `${pct}%`;
          if (progressNote) progressNote.textContent = (data.status === "done") ? "Complete" : "Working…";

          if (data.status === "done" && data.download_url && downloadSection && downloadLink) {
            setStepActive(4);
            downloadSection.style.display = "block";
            downloadLink.href = data.download_url;
            es.close();
          }
        }
      };
      es.onerror = () => {/* leave SSE alone; server will end when done */};
    } catch {
      // ignore
    }
  }

  // --- Boot ---
  document.addEventListener("DOMContentLoaded", () => {
    wireUpload();
    wireOptions();
    wireCheckout();
    calcTotals(); // safe now
    console.log("Mailsized script version: v6.1");
  });
})();
