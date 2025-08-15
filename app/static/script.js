/* app/static/script.js */
/* MailSized script • v6.4 */

const $ = (id) => document.getElementById(id);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00 min";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")} min`;
}
function setTextSafe(el, text) { if (el) el.textContent = text; }
function setStep(activeIndex) {
  const ids = ["step1","step2","step3","step4"];
  ids.forEach((id, i) => {
    const n = $(id); if (!n) return;
    n.classList.toggle("active", i <= activeIndex);
  });
}

/* -------------------- state -------------------- */
const state = {
  file: null,
  uploadId: null,
  durationSec: 0,
  sizeBytes: 0,
  provider: "gmail",
  tier: 1,
  prices: { gmail:[1.99,2.99,4.99], outlook:[2.19,3.29,4.99], other:[2.49,3.99,5.49] },
  upsell: { priority: 0.75, transcript: 1.50 },
};

function tierFromDuration(sec){ if(!Number.isFinite(sec))return 1; const m=sec/60; return m<=5?1:m<=10?2:3; }
function calcTotals(){
  const provider = state.provider || "gmail";
  const prices = state.prices[provider] || state.prices.gmail;
  const tier = state.uploadId ? tierFromDuration(state.durationSec) : 1;
  state.tier = tier;

  const base = Number(prices[tier-1] ?? 0);
  const pri  = $("priority")?.checked ? state.upsell.priority : 0;
  const tra  = $("transcript")?.checked ? state.upsell.transcript : 0;
  const subtotal = base + Number(pri) + Number(tra);
  const tax = subtotal * 0.10;
  const total = subtotal + tax;

  setTextSafe($("basePrice"),       `$${base.toFixed(2)}`);
  setTextSafe($("priorityPrice"),   `$${Number(pri).toFixed(2)}`);
  setTextSafe($("transcriptPrice"), `$${Number(tra).toFixed(2)}`);
  setTextSafe($("taxAmount"),       `$${tax.toFixed(2)}`);
  setTextSafe($("totalAmount"),     `$${total.toFixed(2)}`);
}

/* -------------------- upload -------------------- */
function wireUpload(){
  const uploadArea = $("uploadArea");
  const fileInput = $("fileInput");
  const fileInfo  = $("fileInfo");
  if (!uploadArea || !fileInput) return;

  const openPicker = () => fileInput.click();
  ["click","keypress"].forEach(evt=>{
    uploadArea.addEventListener(evt,(e)=>{
      if (e.type==="keypress" && e.key!=="Enter" && e.key!==" ") return;
      openPicker();
    });
  });
  uploadArea.addEventListener("dragover",(e)=>{e.preventDefault();uploadArea.classList.add("dragover");});
  uploadArea.addEventListener("dragleave",()=>uploadArea.classList.remove("dragover"));
  uploadArea.addEventListener("drop",(e)=>{
    e.preventDefault(); uploadArea.classList.remove("dragover");
    if (e.dataTransfer?.files?.[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change",()=>{ if (fileInput.files?.[0]) handleFile(fileInput.files[0]); });

  $("removeFile")?.addEventListener("click",()=>{
    state.file=null; state.uploadId=null; fileInput.value="";
    if (fileInfo) fileInfo.style.display="none";
    setStep(0); calcTotals();
  });
}

async function handleFile(file){
  state.file = file;
  setTextSafe($("fileName"), file.name);
  setTextSafe($("fileSize"), fmtBytes(file.size));
  setTextSafe($("fileDuration"), "probing…");
  if ($("fileInfo")) $("fileInfo").style.display = "";

  // show simple upload progress (non-streaming)
  const upWrap=$("uploadProgress"), upFill=$("uploadFill"), upPct=$("uploadPct"), upNote=$("uploadNote");
  if (upWrap) upWrap.style.display="";
  if (upNote) upNote.style.display="";

  const fd = new FormData();
  fd.append("file", file);
  const emailVal = $("userEmail")?.value?.trim();
  if (emailVal) fd.append("email", emailVal);

  let res;
  try { res = await fetch("/upload",{ method:"POST", body:fd }); }
  catch { return showError("Upload failed. Check your network and try again."); }

  if (upFill) upFill.style.width = "100%";
  if (upPct) upPct.textContent = "100%";
  if (upNote) upNote.textContent = "Uploaded";

  if (!res.ok) {
    const t = await res.text();
    return showError(`Upload failed: ${t || res.status}`);
  }
  let data; try { data = await res.json(); } catch { return showError("Unexpected response from server (not JSON)."); }
  if (!data?.ok) return showError(data?.detail || "Upload rejected.");

  state.uploadId    = data.upload_id;
  state.durationSec = Number(data.duration_sec || 0);
  state.sizeBytes   = Number(data.size_bytes || 0);

  setTextSafe($("fileDuration"), fmtDuration(state.durationSec));
  setStep(1); calcTotals();
}

/* -------------------- providers & extras -------------------- */
function wireProviders(){
  const list = $("providerList");
  if (!list) return;
  list.addEventListener("click",(e)=>{
    const btn = e.target.closest("[data-provider]"); if (!btn) return;
    qsa("[data-provider]",list).forEach(n=>n.classList.remove("selected"));
    btn.classList.add("selected");
    state.provider = (btn.getAttribute("data-provider")||"gmail").toLowerCase();
    calcTotals();
  });
  $("priority")?.addEventListener("change", calcTotals);
  $("transcript")?.addEventListener("change", calcTotals);
}

/* -------------------- pay & compress -------------------- */
function isValidEmail(s){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || ""); }

function wireCheckout(){
  const btn = $("processButton");
  if (!btn) return;

  btn.addEventListener("click", async ()=>{
    hideError();

    if (!state.file || !state.uploadId) return showError("Please upload a video first.");
    const email = $("userEmail")?.value?.trim() || "";
    if (!isValidEmail(email)) return showError("Please enter a valid email. It is required to receive your download link.");
    if (!$("agree")?.checked) return showError("Please accept the Terms & Conditions.");

    const payload = {
      upload_id: state.uploadId,
      provider: state.provider,
      priority: !!$("priority")?.checked,
      transcript: !!$("transcript")?.checked,
      email,
    };

    let res;
    try {
      res = await fetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      return showError("Could not start checkout. Please try again.");
    }

    let data; try { data = await res.json(); } catch { return showError("Unexpected server response (not JSON)."); }
    const url = data?.url || data?.checkout_url;
    if (!url) return showError("Checkout could not be created. Please try again.");

    setStep(1);
    window.location.href = url;
  });
}

/* -------------------- post-payment progress -------------------- */
function resumeIfPaid(){
  const url = new URL(window.location.href);
  const paid = url.searchParams.get("paid") === "1" || document.body.getAttribute("data-paid")==="1";
  const jobId = url.searchParams.get("job_id") || document.body.getAttribute("data-job-id") || "";
  if (!paid || !jobId) return;

  const post = $("postPaySection"); if (post) post.style.display="";
  setStep(2);
  startSSE(jobId);
}

function startSSE(jobId){
  const pctEl=$("progressPct"), fillEl=$("progressFill"), noteEl=$("progressNote");
  const dlSection=$("downloadSection"), dlLink=$("downloadLink"), emailNote=$("emailNote");

  try{
    const es = new EventSource(`/events/${encodeURIComponent(jobId)}`);
    es.onmessage = async (evt)=>{
      let data={}; try{ data = JSON.parse(evt.data || "{}"); }catch{}

      const p = Number(data.progress || 0);
      setTextSafe(pctEl, `${Math.floor(p)}%`);
      if (fillEl) fillEl.style.width = `${Math.floor(p)}%`;
      setTextSafe(noteEl, data.message || "Working…");

      if (data.status === "done") {
        es.close();

        // Reveal the section immediately
        if (dlSection) dlSection.style.display = "";

        // Prefer SSE-provided URL; otherwise fetch it
        let url = data.download_url || "";
        if (!url) {
          try {
            const r = await fetch(`/download/${encodeURIComponent(jobId)}`);
            const j = await r.json();
            if (j?.url) url = j.url;
          } catch {}
        }

        if (url && dlLink) dlLink.href = url;
        if (emailNote) emailNote.style.display = "";

        setStep(3);
        setTextSafe(noteEl, "Complete");
      } else if (data.status === "error") {
        es.close();
        showError(data.message || "Compression failed.");
        setTextSafe(noteEl, "Error");
      }
    };
    es.onerror = ()=>{};
  }catch{}
}

/* -------------------- errors -------------------- */
function showError(msg){
  const box=$("errorContainer"), msgEl=$("errorMessage");
  if (msgEl) msgEl.textContent = String(msg || "Something went wrong.");
  if (box) box.style.display = "";
}
function hideError(){ const box=$("errorContainer"); if (box) box.style.display="none"; }

/* -------------------- boot -------------------- */
document.addEventListener("DOMContentLoaded",()=>{
  wireUpload();
  wireProviders();
  wireCheckout();
  calcTotals();
  resumeIfPaid();
});
