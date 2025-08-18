/* app/static/script.js */
/* MailSized script • v7.4
   - bulletproof pricing updates (all paths & browsers)
   - shows live total on Pay button
   - robust upload progress + SSE (unchanged)
   - GA/Ads init (unchanged)
*/

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- tiny utils ---------- */
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
const T1_MAX = 500*BYTES_MB;
const T2_MAX = 1024*BYTES_MB;

function tierFromSize(bytes){
  if(bytes <= T1_MAX) return 1;
  if(bytes <= T2_MAX) return 2;
  return 3;
}

const PRICE_MATRIX = {
  gmail:   [1.99, 2.99, 4.49],  // keep in sync with your backend/index table
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

/* ---------- PRICING CORE: ALWAYS SAFE ---------- */
function getCurrentPricing(){
  // Provider guard
  const provider = (state.provider || "gmail").toLowerCase();
  const table = PRICE_MATRIX[provider] || PRICE_MATRIX.gmail;

  // Tier guard
  const tier = state.uploadId ? tierFromSize(Number(state.sizeBytes)||0) : 1;
  const base = Number(table[tier-1] || table[0] || 1.99);

  // Extras
  const pri  = !!$("priority")?.checked ? UPSALE.priority : 0;
  const tra  = !!$("transcript")?.checked ? UPSALE.transcript : 0;

  // Totals
  const subtotal = base + pri + tra;
  const tax = +(subtotal * 0.10).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);

  return { provider, tier, base, pri, tra, tax, total };
}

function updatePricingUI(){
  const { base, pri, tra, tax, total, provider, tier } = getCurrentPricing();

  setTextSafe($("basePrice"),       `$${base.toFixed(2)}`);
  setTextSafe($("priorityPrice"),   `$${pri.toFixed(2)}`);
  setTextSafe($("transcriptPrice"), `$${tra.toFixed(2)}`);
  setTextSafe($("taxAmount"),       `$${tax.toFixed(2)}`);
  setTextSafe($("totalAmount"),     `$${total.toFixed(2)}`);

  // Also reflect price on the Pay button if present
  const btn = $("processButton");
  if (btn) {
    const label = "Pay & Compress";
    // Don’t duplicate the amount if user navigates around
    const clean = btn.textContent.replace(/\s*\(\$[0-9.]+\)\s*$/,'');
    btn.textContent = `${clean} ($${total.toFixed(2)})`;
  }

  // Optional: visually hint at active provider card
  try{
    const list = $("providerList") || qs(".providers");
    if(list){
      qsa("[data-provider]", list).forEach(n=>{
        n.classList.toggle("selected", (n.getAttribute("data-provider")||"").toLowerCase()===provider);
      });
    }
  }catch{}
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
    setStep(0); updatePricingUI();
  });
}

/* progress helpers (IDs must match index.html) */
function setUploadProgress(pct, note="Uploading…"){
  const box = $("uploadProgress");
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

  const fd = new FormData();
  fd.append("file", file);
  const emailVal = $("userEmail")?.value?.trim();
  if(emailVal) fd.append("email", emailVal);

  let heartbeat;
  const uploadRes = await new Promise((resolve, reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");

    const totalFallback = file?.size || 0;

    xhr.upload.addEventListener("progress", (e)=>{
      let loaded = e.loaded || 0;
      let total  = e.lengthComputable ? (e.total || totalFallback) : totalFallback;
      if(total <= 0) total = loaded || 1;
      const pct = (loaded / total) * 100;
      setUploadProgress(pct);
    });

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
  updatePricingUI();   // <— ensure totals reflect actual file size tier
}

/* ---------- provider & extras ---------- */
function wireProviders(){
  const list = $("providerList") || qs(".providers");
  if(!list) return;
  list.addEventListener("click",(e)=>{
    const btn = e.target.closest("[data-provider]"); if(!btn) return;
    state.provider = (btn.getAttribute("data-provider")||"gmail").toLowerCase();
    updatePricingUI();
  });
  $("priority")?.addEventListener("change", updatePricingUI);
  $("transcript")?.addEventListener("change", updatePricingUI);
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

    // sanity: one more refresh of button total
    updatePricingUI();

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
  const emailNote = $("emailNote");
  if(!url || !dlLink || !dlSection) return;
  dlLink.href = url;
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

/* ---------- GA (external; CSP safe) ---------- */
function initGA(){
  const gaId = $("pageRoot")?.getAttribute("data-ga-id"); // if you add this later
  if(!gaId) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function(){ window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', gaId);
}

/* ---------- AdSense (CSP safe; adblock resilient) ---------- */
function initAds(){
  const client = $("pageRoot")?.getAttribute("data-adsense-client");
  if(!client) return;

  if(document.querySelector('script[data-adsbygoogle]')) return;

  const s = document.createElement("script");
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
  s.async = true;
  s.crossOrigin = "anonymous";
  s.setAttribute("data-adsbygoogle", "1");

  s.addEventListener("load", ()=>{
    qsa(".ad-slot[data-ad-slot]").forEach((host)=>{
      host.innerHTML = "";
      const ins = document.createElement("ins");
      ins.className = "adsbygoogle";
      ins.style.display = "block";
      ins.setAttribute("data-ad-client", client);
      ins.setAttribute("data-ad-slot", host.getAttribute("data-ad-slot") || "");
      ins.setAttribute("data-full-width-responsive", "true");
      host.appendChild(ins);
      try{ (window.adsbygoogle = window.adsbygoogle || []).push({}); }catch{}
    });
  });
  s.addEventListener("error", ()=>{});

  document.head.appendChild(s);
}

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", ()=>{
  wireUpload();
  wireProviders();
  wireCheckout();
  updatePricingUI();  // <- compute immediately on load
  resumeIfPaid();

  initGA();
  initAds();
});