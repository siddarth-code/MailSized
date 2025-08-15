/* app/static/script.js */
/* MailSized script • v7.2 (robust upload progress + instant download reveal + provider-aware pricing) */

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- formatters ---------- */
function fmtBytes(n){
  if(!Number.isFinite(n)) return "0 B";
  if(n < 1024) return `${n} B`;
  if(n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if(n < 1024*1024*1024) return `${(n/(1024*1024)).toFixed(1)} MB`;
  return `${(n/(1024*1024*1024)).toFixed(2)} GB`;
}
function fmtDuration(sec){
  if(!Number.isFinite(sec)||sec<=0) return "0:00 min";
  const m=Math.floor(sec/60), s=Math.floor(sec%60);
  return `${m}:${String(s).padStart(2,"0")} min`;
}
function setTextSafe(el, txt){ if(el) el.textContent = txt; }
function setStep(active){
  const steps = [$("step1"),$("step2"),$("step3"),$("step4")].filter(Boolean);
  steps.forEach((n,i)=> n.classList.toggle("active", i<=active));
}

/* ---------- pricing (provider + size tiers) ---------- */
const BYTES_MB = 1024*1024;
const T1_MAX = 500*BYTES_MB;      // 0–500 MB
const T2_MAX = 1024*BYTES_MB;     // 501 MB–1 GB
// 1.01–2 GB => tier 3 (backend caps 2 GB)

function tierFromSize(bytes){
  if(bytes <= T1_MAX) return 1;
  if(bytes <= T2_MAX) return 2;
  return 3;
}

const PRICE_MATRIX = {
  gmail:   [1.99, 2.99, 4.99],
  outlook: [2.19, 3.29, 4.99],
  other:   [2.49, 3.99, 5.49],
};
const UPSALE = { priority: 0.75, transcript: 1.50 };

/* ---------- global state ---------- */
const state = {
  file: null,
  uploadId: null,
  durationSec: 0,
  sizeBytes: 0,
  provider: "gmail",
  tier: 1,
};

/* ---------- totals ---------- */
function calcTotals(){
  const baseEl = $("basePrice");
  const priEl  = $("priorityPrice");
  const traEl  = $("transcriptPrice");
  const taxEl  = $("taxAmount");
  const totEl  = $("totalAmount");

  const provider = state.provider || "gmail";
  const tier = state.uploadId ? tierFromSize(state.sizeBytes) : 1;
  state.tier = tier;

  const base = PRICE_MATRIX[provider][tier-1];
  const pri  = $("priority")?.checked ? UPSALE.priority : 0;
  const tra  = $("transcript")?.checked ? UPSALE.transcript : 0;

  const subtotal = base + pri + tra;
  const tax = +(subtotal * 0.10).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);

  setTextSafe(baseEl, `$${base.toFixed(2)}`);
  setTextSafe(priEl,  `$${pri.toFixed(2)}`);
  setTextSafe(traEl,  `$${tra.toFixed(2)}`);
  setTextSafe(taxEl,  `$${tax.toFixed(2)}`);
  setTextSafe(totEl,  `$${total.toFixed(2)}`);
}

/* ---------- upload wiring ---------- */
function wireUpload(){
  const uploadArea = $("uploadArea");
  const fileInput = $("fileInput");
  const fileInfo  = $("fileInfo");
  if(!uploadArea || !fileInput) return;

  const openPicker = () => fileInput.click();
  ["click","keypress"].forEach(evt=>{
    uploadArea.addEventListener(evt,(e)=>{
      if(e.type==="keypress" && e.key!=="Enter" && e.key!==" ") return;
      openPicker();
    });
  });

  uploadArea.addEventListener("dragover", (e)=>{e.preventDefault(); uploadArea.classList.add("dragover");});
  uploadArea.addEventListener("dragleave",()=> uploadArea.classList.remove("dragover"));
  uploadArea.addEventListener("drop",(e)=>{
    e.preventDefault(); uploadArea.classList.remove("dragover");
    if(e.dataTransfer?.files?.[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change",()=>{ if(fileInput.files?.[0]) handleFile(fileInput.files[0]); });

  $("removeFile")?.addEventListener("click", ()=>{
    state.file=null; state.uploadId=null; fileInput.value="";
    if(fileInfo) fileInfo.style.display="none";
    const up = $("uploadProgress"); if(up) up.style.display="none";
    setStep(0); calcTotals();
  });
}

/* progress helpers (IDs must match index.html) */
function setUploadProgress(pct, note="Uploading…"){
  const box = $("uploadProgress");
  // IDs must mirror index.html (uploadFill/uploadPct)
  const fill = $("uploadFill");
  const pctEl= $("uploadPct");
  const noteEl= $("uploadNote");
  if(box) box.style.display="";
  const clamped = Math.max(0, Math.min(100, Math.floor(pct)));
  if(fill) fill.style.width = `${clamped}%`;
  if(pctEl) pctEl.textContent = `${clamped}%`;
  if(noteEl){ noteEl.style.display=""; noteEl.textContent = note; }
}

async function handleFile(file){
  state.file = file;

  setTextSafe($("fileName"), file.name);
  setTextSafe($("fileSize"), fmtBytes(file.size));
  setTextSafe($("fileDuration"), "probing…");
  if($("fileInfo")) $("fileInfo").style.display="";

  // Build form
  const fd = new FormData();
  fd.append("file", file);
  const emailVal = $("userEmail")?.value?.trim();
  if(emailVal) fd.append("email", emailVal);

  // Use XHR for upload progress with robust fallback for non-computable totals
  let heartbeat; // ensures the bar never appears stuck
  const uploadRes = await new Promise((resolve, reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");

    const totalFallback = file?.size || 0;

    xhr.upload.addEventListener("progress", (e)=>{
      let loaded = e.loaded || 0;
      let total  = e.lengthComputable ? (e.total || totalFallback) : totalFallback;
      if(total <= 0) total = loaded || 1;     // last resort
      const pct = (loaded / total) * 100;
      setUploadProgress(pct);
    });

    // A gentle heartbeat in case some environments emit sparse progress events
    heartbeat = setInterval(()=>{
      const pctText = $("uploadPct")?.textContent || "0%";
      const current = parseInt(pctText, 10) || 0;
      if(current < 95) setUploadProgress(current + 1);
    }, 500);

    xhr.onload = ()=>{
      clearInterval(heartbeat);
      resolve({ ok: (xhr.status>=200 && xhr.status<300), text: xhr.responseText });
    };
    xhr.onerror = ()=>{
      clearInterval(heartbeat);
      reject(new Error("Network error"));
    };

    xhr.send(fd);
    setUploadProgress(0);
  }).catch(()=>({ok:false,text:""}));

  if(!uploadRes.ok){
    return showError(`Upload failed: ${uploadRes.text || "server error"}`);
  }

  let data={};
  try{ data = JSON.parse(uploadRes.text || "{}"); }catch{ return showError("Upload: invalid JSON."); }
  if(!data?.ok) return showError(data?.detail || "Upload rejected.");

  state.uploadId   = data.upload_id;
  state.durationSec= Number(data.duration_sec || 0);
  state.sizeBytes  = Number(data.size_bytes || 0);

  setUploadProgress(100, "Upload complete");
  setTextSafe($("fileDuration"), fmtDuration(state.durationSec));

  setStep(1);
  calcTotals();
}

/* ---------- provider & extras ---------- */
function wireProviders(){
  const list = $("providerList") || qs(".providers");
  if(!list) return;
  list.addEventListener("click",(e)=>{
    const btn = e.target.closest("[data-provider]"); if(!btn) return;
    qsa("[data-provider]", list).forEach(n=> n.classList.remove("selected"));
    btn.classList.add("selected");
    state.provider = (btn.getAttribute("data-provider")||"gmail").toLowerCase();
    calcTotals();
  });
  $("priority")?.addEventListener("change", calcTotals);
  $("transcript")?.addEventListener("change", calcTotals);
}

/* ---------- checkout ---------- */
function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v||""); }

function wireCheckout(){
  const btn = $("processButton");
  if(!btn) return;

  btn.addEventListener("click", async ()=>{
    hideError();

    if(!state.file || !state.uploadId){
      return showError("Please upload a video first.");
    }
    const email = $("userEmail")?.value?.trim();
    if(!validEmail(email)){
      $("userEmail")?.focus();
      return showError("Please enter a valid email. It’s required to receive your download link.");
    }
    if(!$("agree")?.checked){
      return showError("Please accept the Terms & Conditions.");
    }

    const payload = {
      upload_id: state.uploadId,
      provider: state.provider,
      priority: !!$("priority")?.checked,
      transcript: !!$("transcript")?.checked,
      email
    };

    let res;
    try{
      res = await fetch("/checkout", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(payload)
      });
    }catch{
      return showError("Could not start checkout. Please try again.");
    }

    let data={};
    try{ data = await res.json(); }catch{ return showError("Unexpected server response."); }

    const url = data?.url || data?.checkout_url;
    if(!url) return showError("Checkout could not be created. Please try again.");

    setStep(1);
    window.location.href = url;
  });
}

/* ---------- resume & SSE ---------- */
function resumeIfPaid(){
  const root = $("pageRoot");
  const dsPaid = root?.getAttribute("data-paid")==="1";
  const dsJob  = root?.getAttribute("data-job-id") || "";

  const url = new URL(window.location.href);
  const paid  = url.searchParams.get("paid")==="1" || dsPaid;
  const jobId = url.searchParams.get("job_id") || dsJob;

  if(!paid || !jobId) return;

  const post = $("postPaySection");
  if(post) post.style.display = "";
  setStep(2);
  startSSE(jobId);
}

function revealDownload(url){
  const dlSection = $("downloadSection");
  const dlLink = $("downloadLink");
  const emailNote = $("emailNote"); // id MUST be all lowercase in HTML
  if(!url || !dlLink || !dlSection) return;
  dlLink.href = url;
  // Explicitly override CSS rule (#downloadSection {display:none})
  dlSection.style.display = "block";
  if(emailNote) emailNote.style.display = "";
  setStep(3);
  setTextSafe($("progressNote"), "Complete");
}

function startSSE(jobId){
  const pctEl = $("progressPct");
  const fillEl= $("progressFill");
  const noteEl= $("progressNote");

  try{
    const es = new EventSource(`/events/${encodeURIComponent(jobId)}`);
    es.onmessage = async (evt)=>{
      let data={}; try{ data = JSON.parse(evt.data||"{}"); }catch{}

      const p = Number(data.progress||0);
      if(pctEl) pctEl.textContent = `${Math.floor(p)}%`;
      if(fillEl) fillEl.style.width = `${Math.floor(p)}%`;
      if(noteEl) noteEl.textContent = data.message || "Working…";

      if(data.download_url){
        revealDownload(data.download_url);
        es.close();
        return;
      }

      if(data.status==="done"){
        try{
          const r = await fetch(`/download/${encodeURIComponent(jobId)}`);
          const j = await r.json();
          if(j?.url) revealDownload(j.url);
          else showError("Finished, but no download URL yet. Try refreshing.");
        }catch{
          showError("Finished, but couldn’t fetch the download URL.");
        }finally{
          es.close();
        }
      }else if(data.status==="error"){
        es.close();
        showError(data.message || "Compression failed.");
        if(noteEl) noteEl.textContent = "Error";
      }
    };
    es.onerror = ()=>{/* heartbeats keep it alive */};
  }catch{/* noop */}
}

/* ---------- errors ---------- */
function showError(msg){
  const box = $("errorContainer");
  const msgEl= $("errorMessage");
  if(msgEl) msgEl.textContent = String(msg||"Something went wrong.");
  if(box) box.style.display = "";
}
function hideError(){
  const box = $("errorContainer");
  if(box) box.style.display = "none";
}

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", ()=>{
  wireUpload();
  wireProviders();
  wireCheckout();
  calcTotals();
  resumeIfPaid();
});
