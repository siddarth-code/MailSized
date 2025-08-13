/* MailSized script – v6-progress */
console.log("Mailsized script version: v6-progress");

/* ---------- Elements ---------- */
const uploadArea = document.getElementById("uploadArea");
const fileInput   = document.getElementById("fileInput");
const chooseBtn   = document.getElementById("chooseFileBtn");
const fileInfo    = document.getElementById("fileInfo");
const fileNameEl  = document.getElementById("fileName");
const fileSizeEl  = document.getElementById("fileSize");
const fileDurEl   = document.getElementById("fileDuration");
const removeFile  = document.getElementById("removeFile");

const providerCards = document.querySelectorAll(".provider-card");
const processButton = document.getElementById("processButton");

const errorContainer = document.getElementById("errorContainer");
const errorMessage   = document.getElementById("errorMessage");

const priorityCheckbox   = document.getElementById("priority");
const transcriptCheckbox = document.getElementById("transcript");
const agreeCheckbox      = document.getElementById("agree");
const emailInput         = document.getElementById("userEmail");

const basePriceEl      = document.getElementById("basePrice");
const priorityPriceEl  = document.getElementById("priorityPrice");
const transcriptPriceEl= document.getElementById("transcriptPrice");
const taxAmountEl      = document.getElementById("taxAmount");
const totalAmountEl    = document.getElementById("totalAmount");

const progressWrap   = document.getElementById("progressWrap");
const progressInner  = document.getElementById("progressInner");
const progressLabel  = document.getElementById("progressLabel");
const progressState  = document.getElementById("progressState");
const downloadSection= document.getElementById("downloadSection");
const downloadLink   = document.getElementById("downloadLink");

/* ---------- State ---------- */
let selectedProvider = "gmail";
let uploadMeta = null;  // { job_id, duration_sec, size_bytes, tier, price, ... }

/* ---------- Pricing ---------- */
const PROVIDER_PRICING = {
  gmail:   [1.99, 2.99, 4.49],
  outlook: [2.19, 3.29, 4.99],
  other:   [2.49, 3.99, 5.49],
};
const UPS = { priority: 0.75, transcript: 1.50 };

function calcTotals() {
  const tier = uploadMeta ? uploadMeta.tier : 1; // default to Tier 1 until upload known
  const base = PROVIDER_PRICING[selectedProvider][tier - 1];
  const p = priorityCheckbox.checked ? UPS.priority : 0;
  const t = transcriptCheckbox.checked ? UPS.transcript : 0;
  const sub = base + p + t;
  const tax = sub * 0.1;
  const total = sub + tax;
  basePriceEl.textContent = `$${base.toFixed(2)}`;
  priorityPriceEl.textContent = `$${p.toFixed(2)}`;
  transcriptPriceEl.textContent = `$${t.toFixed(2)}`;
  taxAmountEl.textContent = `$${tax.toFixed(2)}`;
  totalAmountEl.textContent = `$${total.toFixed(2)}`;
}

providerCards.forEach(card => {
  card.addEventListener("click", () => {
    providerCards.forEach(c => c.classList.remove("selected"));
    card.classList.add("selected");
    selectedProvider = card.dataset.provider;
    calcTotals();
  });
});
priorityCheckbox.addEventListener("change", calcTotals);
transcriptCheckbox.addEventListener("change", calcTotals);

/* ---------- Upload: robust triggers ---------- */
// Native path (label[for=fileInput]) already works;
// add JS fallback so clicking anywhere in the box opens file dialog.
if (uploadArea) {
  uploadArea.addEventListener("click", (e) => {
    // Ignore clicks on the remove button
    if (e.target.closest("#removeFile")) return;
    try { fileInput.click(); } catch {}
  });
}
if (chooseBtn) {
  chooseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    try { fileInput.click(); } catch {}
  });
}

// drag & drop
["dragover", "dragenter"].forEach(ev =>
  uploadArea.addEventListener(ev, e => { e.preventDefault(); uploadArea.classList.add("dragover"); })
);
["dragleave","drop"].forEach(ev =>
  uploadArea.addEventListener(ev, e => { e.preventDefault(); uploadArea.classList.remove("dragover"); })
);
uploadArea.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) handleFile(f);
});

fileInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});

function handleFile(file) {
  clearError();
  if (!file.type.startsWith("video/")) return showError("Please upload a video file (MP4, MOV, AVI, MKV)");
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = humanBytes(file.size);

  // Fake a quick duration hint for UI; server will give the real one
  fileDurEl.textContent = "";
  fileInfo.style.display = "flex";

  // Send to /upload
  const form = new FormData();
  form.append("file", file);
  processButton.disabled = true;
  processButton.innerHTML = '<span class="loading"></span> Uploading…';

  fetch("/upload", { method: "POST", body: form })
    .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
    .then(data => {
      uploadMeta = data;       // includes job_id, duration_sec, tier, etc.
      // Fill real duration
      fileDurEl.textContent = humanDuration(Math.round(data.duration_sec));
      stepActivate(2);
      calcTotals();
      processButton.disabled = false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    })
    .catch(err => {
      showError(err?.detail || "Upload failed");
      processButton.disabled = false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    });
}

removeFile.addEventListener("click", () => {
  if (fileInput) fileInput.value = "";
  fileInfo.style.display = "none";
  uploadMeta = null;
  calcTotals();
});

/* ---------- Pay & redirect to Stripe ---------- */
processButton.addEventListener("click", () => {
  clearError();
  if (!uploadMeta) return showError("Please upload a video first.");
  if (!agreeCheckbox.checked) return showError("You must agree to the Terms & Conditions.");
  const fd = new FormData();
  fd.append("job_id", uploadMeta.job_id);
  fd.append("provider", selectedProvider);
  fd.append("priority", String(priorityCheckbox.checked));
  fd.append("transcript", String(transcriptCheckbox.checked));
  fd.append("email", emailInput.value || "");

  processButton.disabled = true;
  processButton.innerHTML = '<span class="loading"></span> Creating checkout…';
  fetch("/checkout", { method: "POST", body: fd })
    .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
    .then(({ checkout_url }) => {
      stepActivate(2);
      window.location.href = checkout_url;
    })
    .catch(err => {
      showError(err?.detail || "Could not start payment.");
      processButton.disabled = false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    });
});

/* ---------- After Stripe: reconnect to job via ?paid=1&job_id=... ---------- */
(function resumeAfterPay() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("paid") !== "1") return;
  const jobId = p.get("job_id");
  if (!jobId) return;

  stepActivate(3);
  progressWrap.style.display = "block";
  downloadSection.style.display = "none";

  const ev = new EventSource(`/events/${jobId}`);
  ev.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (typeof data.progress === "number") {
      const pct = Math.max(0, Math.min(100, data.progress));
      progressInner.style.width = `${pct}%`;
      progressLabel.textContent = `${pct}%`;
    }
    if (data.status) {
      progressState.textContent = capitalize(data.status);
      if (data.status === "done" && data.download_url) {
        progressInner.style.width = "100%";
        progressLabel.textContent = "100%";
        stepActivate(4);
        downloadLink.href = data.download_url;
        downloadSection.style.display = "block";
        progressWrap.style.display = "none";
        ev.close();
      }
      if (data.status === "error") {
        showError("Compression failed. Please try again.");
        ev.close();
      }
    }
  };
  ev.onerror = () => {
    // keep UI informative if stream drops
    progressState.textContent = "Working…";
  };
})();

/* ---------- Utils ---------- */
function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes/1048576).toFixed(1)} MB`;
  return `${(bytes/1073741824).toFixed(1)} GB`;
}
function humanDuration(s) {
  const m = Math.floor(s/60); const ss = s%60;
  return `${m}:${ss<10?"0":""}${ss} min`;
}
function showError(msg) {
  errorMessage.textContent = msg;
  errorContainer.style.display = "block";
  errorContainer.scrollIntoView({ behavior: "smooth", block: "center" });
}
function clearError(){ errorContainer.style.display="none"; }

function stepActivate(n){
  for (let i=1;i<=4;i++){
    const el = document.getElementById(`step${i}`);
    if(!el) continue;
    el.classList.toggle("active", i===n);
  }
}
function capitalize(s){ return (s||"").slice(0,1).toUpperCase()+ (s||"").slice(1); }

/* Initial totals (Tier 1 defaults until upload tells us real tier) */
calcTotals();
