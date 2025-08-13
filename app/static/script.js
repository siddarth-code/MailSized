/* MailSized front-end – v6.2
   - Robust /checkout POST + inline error handling
   - Live SSE progress (percent + bar)
   - Provider pricing wired to tiers (≤500MB / ≤1GB / ≤2GB)
*/

console.log("MailSized script version: v6.2");

document.addEventListener("DOMContentLoaded", () => {
  // ---- Elements
  const uploadArea = document.getElementById("uploadArea");
  const fileInput = document.getElementById("fileInput");
  const fileInfo = document.getElementById("fileInfo");
  const fileName = document.getElementById("fileName");
  const fileSize = document.getElementById("fileSize");
  const fileDuration = document.getElementById("fileDuration");
  const removeFile = document.getElementById("removeFile");

  const providerCards = document.querySelectorAll(".provider-card");
  const priorityCheckbox = document.getElementById("priority");
  const transcriptCheckbox = document.getElementById("transcript");
  const userEmail = document.getElementById("userEmail");
  const agreeCheckbox = document.getElementById("agree");

  const basePrice = document.getElementById("basePrice");
  const priorityPrice = document.getElementById("priorityPrice");
  const transcriptPrice = document.getElementById("transcriptPrice");
  const taxAmount = document.getElementById("taxAmount");
  const totalAmount = document.getElementById("totalAmount");

  const processButton = document.getElementById("processButton");
  const errorContainer = document.getElementById("errorContainer");
  const errorMessage = document.getElementById("errorMessage");

  const livePanel = document.getElementById("livePanel");
  const liveStatus = document.getElementById("liveStatus");
  const livePct = document.getElementById("livePct");
  const liveBar = document.getElementById("liveBar");
  const downloadSection = document.getElementById("downloadSection");
  const downloadLink = document.getElementById("downloadLink");

  // ---- State
  let selectedProvider = "gmail";
  let UPLOAD_DATA = null; // server response after /upload

  // ---- Pricing
  const PROVIDER_PRICING = {
    gmail:   [1.99, 2.99, 4.49],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };

  // Utility
  const fmtMoney = (n) => `$${Number(n).toFixed(2)}`;
  const showError = (msg) => {
    errorMessage.textContent = msg;
    errorContainer.style.display = "block";
    errorContainer.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const hideError = () => (errorContainer.style.display = "none");

  // ---- Step header helpers
  function setStepActive(idx) {
    [1, 2, 3, 4].forEach((i) => {
      document.getElementById(`step${i}`).classList.toggle("active", i === idx);
    });
  }

  // ---- Pricing calc
  function currentTier() {
    if (!UPLOAD_DATA) return 1;
    return Number(UPLOAD_DATA.tier || 1); // 1..3
  }

  function calculateTotal() {
    const tier = currentTier();
    const base =
      selectedProvider === "outlook"
        ? PROVIDER_PRICING.outlook[tier - 1]
        : selectedProvider === "other"
        ? PROVIDER_PRICING.other[tier - 1]
        : PROVIDER_PRICING.gmail[tier - 1];

    const pr = priorityCheckbox.checked ? 0.75 : 0;
    const tr = transcriptCheckbox.checked ? 1.50 : 0;
    const sub = base + pr + tr;
    const tax = sub * 0.1;
    const tot = sub + tax;

    basePrice.textContent = fmtMoney(base);
    priorityPrice.textContent = fmtMoney(pr);
    transcriptPrice.textContent = fmtMoney(tr);
    taxAmount.textContent = fmtMoney(tax);
    totalAmount.textContent = fmtMoney(tot);
  }

  // ---- Provider selection
  providerCards.forEach((card) => {
    card.addEventListener("click", () => {
      providerCards.forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedProvider = card.dataset.provider;
      calculateTotal();
    });
  });

  priorityCheckbox.addEventListener("change", calculateTotal);
  transcriptCheckbox.addEventListener("change", calculateTotal);

  // ---- Upload interactions
  uploadArea.addEventListener("click", () => fileInput.click());

  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });

  uploadArea.addEventListener("dragleave", () => {
    uploadArea.classList.remove("dragover");
  });

  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    if (e.dataTransfer.files.length) {
      handleLocalFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) handleLocalFile(e.target.files[0]);
  });

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(1)} GB`;
  }

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs} min`;
  }

  async function handleLocalFile(file) {
    hideError();

    if (!file.type.startsWith("video/")) {
      showError("Please upload a video file (MP4, MOV, AVI, MKV).");
      return;
    }
    if (file.size > 2 * 1024 * 1024 * 1024) {
      showError("File size exceeds maximum limit of 2GB.");
      return;
    }

    // optimistic UI
    fileInfo.style.display = "flex";
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    fileDuration.textContent = "Checking duration…";

    // upload to server
    setStepActive(1);
    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch("/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Upload failed (${res.status})`);
      }
      const data = await res.json();
      UPLOAD_DATA = data;

      // update meta
      fileDuration.textContent = formatDuration(data.duration_sec || 0);
      calculateTotal();

      // Move wizard to Payment
      setStepActive(2);
    } catch (err) {
      fileInfo.style.display = "none";
      showError(err.message || "Upload failed.");
    }
  }

  removeFile.addEventListener("click", () => {
    fileInput.value = "";
    fileInfo.style.display = "none";
    UPLOAD_DATA = null;
    calculateTotal();
    setStepActive(1);
  });

  // ---- Start Checkout
  processButton.addEventListener("click", async () => {
    hideError();

    if (!UPLOAD_DATA) {
      showError("Please upload a video file.");
      return;
    }
    if (!agreeCheckbox.checked) {
      showError("You must agree to the Terms & Conditions.");
      return;
    }

    // visual loading
    processButton.disabled = true;
    const original = processButton.innerHTML;
    processButton.innerHTML = '<span class="loading"></span> Starting checkout…';

    const body = new URLSearchParams({
      job_id: UPLOAD_DATA.job_id,
      provider: selectedProvider,
      priority: String(!!priorityCheckbox.checked),
      transcript: String(!!transcriptCheckbox.checked),
      email: (userEmail.value || "").trim(),
    });

    try {
      const res = await fetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Could not start payment (HTTP ${res.status}).`);
      }

      const { checkout_url } = await res.json();
      // hand over to Stripe
      window.location.href = checkout_url;
    } catch (err) {
      showError(err.message || "Could not start payment.");
      processButton.disabled = false;
      processButton.innerHTML = original;
    }
  });

  // ---- After Stripe: handle ?paid=1&job_id=...
  const qp = new URLSearchParams(window.location.search);
  if (qp.get("paid") === "1" && qp.get("job_id")) {
    const jid = qp.get("job_id");
    setStepActive(3);
    livePanel.style.display = "block";
    liveStatus.textContent = "Queued…";
    livePct.textContent = "0%";
    liveBar.style.width = "0%";

    // Listen for SSE progress
    const es = new EventSource(`/events/${jid}`);
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.progress !== undefined) {
          const p = Math.max(0, Math.min(100, Number(payload.progress)));
          livePct.textContent = `${p}%`;
          liveBar.style.width = `${p}%`;
        }
        if (payload.status) {
          liveStatus.textContent =
            payload.status === "processing" ? "Processing…" :
            payload.status === "compressing" ? "Compressing…" :
            payload.status === "finalizing" ? "Finalizing…" :
            payload.status === "done" ? "Done!" :
            payload.status === "error" ? "Error" : payload.status;
        }
        if (payload.download_url) {
          setStepActive(4);
          downloadSection.style.display = "block";
          downloadLink.href = payload.download_url;
          // stop listening
          es.close();
        }
      } catch (_) {}
    };
    es.onerror = () => {
      // Keep UI but indicate server stream problem
      liveStatus.textContent = "Working… (connection hiccup)";
    };
  }

  // initial totals
  calculateTotal();
});
