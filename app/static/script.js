/* MailSized front-end (v6 – null-safe) */

// ---- small helpers ----
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);
const safeText = (id, text) => { const el = byId(id); if (el) el.textContent = text; };
const show = (el) => el && (el.style.display = '');
const hide = (el) => el && (el.style.display = 'none');

const fmtUSD = (n) => `$${n.toFixed(2)}`;

// ---- state ----
const STATE = {
  upload: null,      // { job_id, duration_sec, size_bytes, tier, price, max_length_min, max_size_mb }
  provider: 'gmail',
  priority: false,
  transcript: false,
  email: '',
};

// ---- DOM refs (created after DOM ready) ----
let uploadArea, fileInput, fileInfo, fileName, fileSize, fileDuration, removeFileBtn;
let errorBox, errorMsg, processBtn, postPaySection, progressPct, progressFill, progressNote, downloadSection, downloadLink;

// ---- init ----
window.addEventListener('DOMContentLoaded', () => {
  console.log('Mailsized script version: v6-progress');

  // map elements
  uploadArea      = byId('uploadArea');
  fileInput       = byId('fileInput');
  fileInfo        = byId('fileInfo');
  fileName        = byId('fileName');
  fileSize        = byId('fileSize');
  fileDuration    = byId('fileDuration');
  removeFileBtn   = byId('removeFile');
  errorBox        = byId('errorContainer');
  errorMsg        = byId('errorMessage');
  processBtn      = byId('processButton');
  postPaySection  = byId('postPaySection');
  progressPct     = byId('progressPct');
  progressFill    = byId('progressFill');
  progressNote    = byId('progressNote');
  downloadSection = byId('downloadSection');
  downloadLink    = byId('downloadLink');

  // provider selection
  $('#providerList')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-provider]');
    if (!card) return;
    $$('#providerList .provider-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    STATE.provider = card.dataset.provider;
    calcTotals();
  });

  // extras
  byId('priority')?.addEventListener('change', (e) => {
    STATE.priority = !!e.target.checked; calcTotals();
  });
  byId('transcript')?.addEventListener('change', (e) => {
    STATE.transcript = !!e.target.checked; calcTotals();
  });
  byId('userEmail')?.addEventListener('input', (e) => {
    STATE.email = (e.target.value || '').trim();
  });

  // upload interactions
  uploadArea?.addEventListener('click', () => fileInput?.click());
  uploadArea?.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea?.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea?.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) startUpload(f);
  });
  fileInput?.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) startUpload(f);
  });
  removeFileBtn?.addEventListener('click', () => resetUpload());

  // main action
  processBtn?.addEventListener('click', onPayAndCompress);

  // first totals
  calcTotals();
});

// ---- pricing calc (null-safe writes) ----
function calcTotals() {
  // base tier price comes from server estimation (STATE.upload?.price),
  // but while no upload yet, assume tier1 Gmail 1.99 so UI doesn't show blanks.
  const providerPrices = {
    gmail:   [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };

  let tier = 1;
  if (STATE.upload?.tier) tier = Number(STATE.upload.tier);

  const base = providerPrices[STATE.provider][tier - 1];
  const upsell = (STATE.priority ? 0.75 : 0) + (STATE.transcript ? 1.50 : 0);
  const subtotal = base + upsell;
  const tax = +(subtotal * 0.10).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);

  safeText('basePrice',       fmtUSD(base));
  safeText('priorityPrice',   fmtUSD(STATE.priority ? 0.75 : 0));
  safeText('transcriptPrice', fmtUSD(STATE.transcript ? 1.50 : 0));
  safeText('taxAmount',       fmtUSD(tax));
  safeText('totalAmount',     fmtUSD(total));
}

// ---- upload ----
async function startUpload(file) {
  hideError();

  // optimistic UI
  show(fileInfo);
  hide(uploadArea);
  fileName && (fileName.textContent = file.name);
  fileSize && (fileSize.textContent = `${(file.size/1024/1024).toFixed(1)} MB`);
  fileDuration && (fileDuration.textContent = ' · probing…');

  const fd = new FormData();
  fd.append('file', file);

  try {
    const res = await fetch('/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    const data = await res.json();

    STATE.upload = data;
    // update duration
    if (typeof data.duration_sec === 'number' && fileDuration) {
      const mins = Math.floor(data.duration_sec/60);
      const secs = Math.round(data.duration_sec%60);
      fileDuration.textContent = ` · ${mins}m ${secs}s`;
    }
    calcTotals();
  } catch (err) {
    console.error(err);
    showError('Upload failed');
    resetUpload(false);
  }
}

function resetUpload(showPicker = true) {
  STATE.upload = null;
  fileInput && (fileInput.value = '');
  hide(fileInfo);
  if (showPicker) show(uploadArea);
  calcTotals();
}

// ---- pay & compress ----
async function onPayAndCompress() {
  if (!STATE.upload?.job_id) {
    showError('Please upload a video first.');
    return;
  }
  const agreed = byId('agree')?.checked;
  if (!agreed) {
    showError('Please accept the Terms & Conditions.');
    return;
  }

  hideError();
  try {
    const fd = new FormData();
    fd.append('job_id', STATE.upload.job_id);
    fd.append('provider', STATE.provider);
    fd.append('priority', STATE.priority ? 'true' : 'false');
    fd.append('transcript', STATE.transcript ? 'true' : 'false');
    fd.append('email', STATE.email || '');

    const res = await fetch('/checkout', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Checkout failed (${res.status})`);
    const data = await res.json();
    if (!data.checkout_url) throw new Error('Missing checkout URL');

    // to Stripe
    window.location.href = data.checkout_url;
  } catch (err) {
    console.error(err);
    showError('Could not start payment.');
  }
}

// ---- post-payment (progress via SSE) ----
(function checkPaidOnLoad() {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('paid') || !q.get('job_id')) return;
  // show progress block
  show(postPaySection);
  subscribeProgress(q.get('job_id'));
})();

function subscribeProgress(jobId) {
  try {
    const es = new EventSource(`/events/${jobId}`);
    updateProgress(2, 'Working…'); // initial tick
    es.onmessage = (e) => {
      const payload = JSON.parse(e.data || '{}');
      if (payload.status) {
        // simple staged mapping -> percent
        const map = {
          queued: 2, processing: 10, compressing: 35,
          finalizing: 85, done: 100, error: 100
        };
        const pct = map[payload.status] ?? 2;
        updateProgress(pct, payload.status === 'done' ? 'Completed' :
                            payload.status === 'error' ? 'Failed' : 'Working…');

        if (payload.status === 'done' && payload.download_url) {
          show(downloadSection);
          if (downloadLink) downloadLink.href = payload.download_url;
          es.close();
        }
        if (payload.status === 'error') {
          showError('An error occurred during processing.');
          es.close();
        }
      }
    };
    es.onerror = () => {
      // Don’t spam errors; keep UI where it is. Render sometimes restarts dyno.
      console.warn('SSE connection temporary issue.');
    };
  } catch (e) {
    console.warn('SSE unsupported?', e);
  }
}

function updateProgress(pct, note='') {
  if (progressPct) progressPct.textContent = `${pct}%`;
  if (progressFill) progressFill.style.width = `${pct}%`;
  if (progressNote) progressNote.textContent = note;
}

// ---- errors ----
function showError(msg) {
  if (!errorBox || !errorMsg) return;
  errorMsg.textContent = msg;
  show(errorBox);
}
function hideError() {
  if (!errorBox || !errorMsg) return;
  errorMsg.textContent = '';
  hide(errorBox);
}
