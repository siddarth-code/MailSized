/* MailSized front-end
 * - Robust upload picker + drag/drop
 * - Provider pricing + extras
 * - Upload → Stripe → SSE progress → Download
 */

console.log('MailSized script version: v6-progress');

// ----------------------------
// Elements & constants
// ----------------------------
const uploadArea       = document.getElementById('uploadArea');
const fileInput        = document.getElementById('fileInput');
const browseBtn        = document.getElementById('browseBtn');
const fileInfo         = document.getElementById('fileInfo');
const fileNameEl       = document.getElementById('fileName');
const fileSizeEl       = document.getElementById('fileSize');
const fileDurEl        = document.getElementById('fileDuration');
const removeFileBtn    = document.getElementById('removeFile');

const providerCards    = document.querySelectorAll('.provider-card');
const priorityCb       = document.getElementById('priority');
const transcriptCb     = document.getElementById('transcript');
const emailInput       = document.getElementById('userEmail');
const agreeCb          = document.getElementById('agree');
const processBtn       = document.getElementById('processButton');

const errorContainer   = document.getElementById('errorContainer');
const errorMessage     = document.getElementById('errorMessage');

const basePriceEl      = document.getElementById('basePrice');
const priorityPriceEl  = document.getElementById('priorityPrice');
const transcriptPriceEl= document.getElementById('transcriptPrice');
const taxAmountEl      = document.getElementById('taxAmount');
const totalAmountEl    = document.getElementById('totalAmount');

const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const step3 = document.getElementById('step3');
const step4 = document.getElementById('step4');

const progressWrap  = document.getElementById('progressWrap');
const progressInner = document.getElementById('progressInner');
const progressPct   = document.getElementById('progressPct');
const progressNote  = document.getElementById('progressNote');

const downloadSection = document.getElementById('downloadSection');
const downloadLink    = document.getElementById('downloadLink');

// Provider-based prices by tier (1 → index 0)
const PROVIDER_PRICING = {
  gmail:   [1.99, 2.99, 4.49],
  outlook: [2.19, 3.29, 4.99],
  other:   [2.49, 3.99, 5.49],
};

// Target sizes used by backend too (FYI)
const PROVIDER_TARGETS_MB = { gmail: 25, outlook: 20, other: 15 };

// App state
let SELECTED_PROVIDER = 'gmail';
let UPLOAD_DATA = null; // set after /upload returns (contains job_id, tier, size, duration)


// ----------------------------
// Helpers
// ----------------------------
function showError(msg) {
  errorMessage.textContent = msg || 'Something went wrong.';
  errorContainer.style.display = 'block';
  errorContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function hideError() {
  errorContainer.style.display = 'none';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' bytes';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs} min`;
}

function setStep(activeIdx) {
  [step1, step2, step3, step4].forEach((el, i) => {
    if (!el) return;
    if (i === activeIdx - 1) el.classList.add('active');
    else el.classList.remove('active');
  });
}

// Map server statuses to a perceived percentage
function statusToPct(status) {
  switch ((status || '').toLowerCase()) {
    case 'queued':      return 5;
    case 'processing':  return 25;
    case 'compressing': return 65;
    case 'finalizing':  return 90;
    case 'done':        return 100;
    default:            return 0;
  }
}


// ----------------------------
// Upload UI (robust)
// ----------------------------
(function setupUpload() {
  if (!uploadArea || !fileInput || !browseBtn) return;

  uploadArea.style.pointerEvents = 'auto';

  function openPicker() {
    try {
      fileInput.click();
    } catch {
      // iOS/Safari fallback
      fileInput.style.position = 'static';
      fileInput.style.opacity = '0.01';
      fileInput.style.width = '1px';
      fileInput.style.height = '1px';
      requestAnimationFrame(() => fileInput.click());
      setTimeout(() => {
        fileInput.style.position = 'absolute';
        fileInput.style.left = '-9999px';
      }, 0);
    }
  }

  uploadArea.addEventListener('click', (e) => {
    if (e.target === fileInput) return;
    openPicker();
  });
  browseBtn.addEventListener('click', openPicker);

  uploadArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); openPicker();
    }
  });

  ['dragenter','dragover'].forEach(evt =>
    uploadArea.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      uploadArea.classList.add('dragover');
    })
  );
  ['dragleave','drop'].forEach(evt =>
    uploadArea.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      if (evt === 'drop') {
        const files = e.dataTransfer?.files || [];
        if (files.length) handleLocalFile(files[0]);
      }
      uploadArea.classList.remove('dragover');
    })
  );

  fileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleLocalFile(f);
  });

  removeFileBtn?.addEventListener('click', () => {
    fileInput.value = '';
    fileInfo.style.display = 'none';
    processBtn.disabled = true;
    UPLOAD_DATA = null;
    setTotals(0); // reset prices to $0
  });
})();

function handleLocalFile(file) {
  hideError();
  // Type check
  if (!file.type || !file.type.startsWith('video/')) {
    showError('Please upload a video file (MP4, MOV, AVI, MKV)');
    return;
  }
  // Size check (2GB)
  const MAX = 2 * 1024 * 1024 * 1024;
  if (file.size > MAX) {
    showError('File size exceeds maximum limit of 2GB');
    return;
  }

  // UI preview
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatFileSize(file.size);
  fileDurEl.textContent = '';
  fileInfo.style.display = 'flex';
  setStep(1);

  // Optional quick duration probe (not required)
  try {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => {
      const secs = Math.max(0, v.duration || 0);
      fileDurEl.textContent = formatDuration(secs);
      URL.revokeObjectURL(url);
    };
  } catch {}

  // Send to /upload
  uploadToServer(file);
}

async function uploadToServer(file) {
  try {
    const fd = new FormData();
    fd.append('file', file);

    const res = await fetch('/upload', { method: 'POST', body: fd });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || 'Upload failed');
    }
    const data = await res.json();
    UPLOAD_DATA = data; // { job_id, duration_sec, size_bytes, tier, price, ... }

    // Enable Pay button & show prices for current provider/tier
    processBtn.disabled = false;
    calculateAndRenderTotals();

    // Move marker to step 2 (payment)
    setStep(2);
  } catch (err) {
    console.error(err);
    showError('Upload failed. Please try again.');
    processBtn.disabled = true;
  }
}


// ----------------------------
// Pricing summary
// ----------------------------
providerCards.forEach(card => {
  card.addEventListener('click', () => {
    providerCards.forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    SELECTED_PROVIDER = card.dataset.provider;
    calculateAndRenderTotals();
  });
});
priorityCb.addEventListener('change', calculateAndRenderTotals);
transcriptCb.addEventListener('change', calculateAndRenderTotals);
agreeCb.addEventListener('change', () => {
  // Only enable when we have an uploaded file + T&Cs checked
  processBtn.disabled = !(UPLOAD_DATA && agreeCb.checked);
});

function calculateAndRenderTotals() {
  // If no upload yet, show zeros but keep selection
  if (!UPLOAD_DATA) { setTotals(0, 0, 0, 0); return; }

  const tier = Number(UPLOAD_DATA.tier || 1);
  const base = PROVIDER_PRICING[SELECTED_PROVIDER][tier - 1];

  const priority = priorityCb.checked ? 0.75 : 0;
  const transcript = transcriptCb.checked ? 1.50 : 0;
  const subtotal = base + priority + transcript;
  const tax = subtotal * 0.10; // 10%
  const total = subtotal + tax;

  setTotals(base, priority, transcript, tax, total);

  // Enable Pay only when T&Cs checked
  processBtn.disabled = !agreeCb.checked;
}

function setTotals(base=0, priority=0, transcript=0, tax=0, total=null) {
  const t = total === null ? (base + priority + transcript + tax) : total;
  basePriceEl.textContent       = `$${Number(base).toFixed(2)}`;
  priorityPriceEl.textContent   = `$${Number(priority).toFixed(2)}`;
  transcriptPriceEl.textContent = `$${Number(transcript).toFixed(2)}`;
  taxAmountEl.textContent       = `$${Number(tax).toFixed(2)}`;
  totalAmountEl.textContent     = `$${Number(t).toFixed(2)}`;
}


// ----------------------------
// Pay & Checkout
// ----------------------------
processBtn.addEventListener('click', async () => {
  hideError();
  if (!UPLOAD_DATA) return showError('Please upload a video file first.');
  if (!agreeCb.checked) return showError('You must agree to the Terms & Conditions');

  processBtn.disabled = true;
  processBtn.innerHTML = '<span class="loading"></span> Redirecting to Stripe…';

  try {
    const fd = new FormData();
    fd.append('job_id', UPLOAD_DATA.job_id);
    fd.append('provider', SELECTED_PROVIDER);
    fd.append('priority', String(priorityCb.checked));
    fd.append('transcript', String(transcriptCb.checked));
    fd.append('email', (emailInput.value || '').trim());

    const res = await fetch('/checkout', { method: 'POST', body: fd });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || 'Checkout failed');
    }
    const data = await res.json();
    // Go to Stripe
    window.location.href = data.checkout_url;
  } catch (err) {
    console.error(err);
    processBtn.disabled = false;
    processBtn.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    showError('Something went wrong creating the checkout session.');
  }
});


// ----------------------------
// After Stripe → show progress via SSE
// ----------------------------
(function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const paid = params.get('paid');
  const jobId = params.get('job_id');
  if (paid !== '1' || !jobId) return;

  // Visually move to steps 3/4; show progress UI immediately
  setStep(3);
  progressWrap.style.display = 'block';
  processBtn.style.display = 'none'; // hide pay button

  // Start SSE
  const evt = new EventSource(`/events/${jobId}`);
  let lastPct = 0;

  evt.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      const pct = statusToPct(payload.status);
      lastPct = Math.max(lastPct, pct);
      progressInner.style.width = `${lastPct}%`;
      progressPct.textContent = `${lastPct}%`;

      switch (payload.status) {
        case 'queued':
          progressNote.textContent = 'Your job is queued…';
          break;
        case 'processing':
          progressNote.textContent = 'Analyzing your video…';
          break;
        case 'compressing':
          progressNote.textContent = 'Compressing with optimal settings…';
          break;
        case 'finalizing':
          progressNote.textContent = 'Finalizing and generating download link…';
          break;
        case 'done':
          evt.close();
          setStep(4);
          progressInner.style.width = '100%';
          progressPct.textContent = '100%';
          progressNote.textContent = 'Complete!';
          // Reveal download
          if (payload.download_url) {
            downloadSection.style.display = 'block';
            downloadLink.href = payload.download_url;
          }
          break;
        case 'error':
        default:
          evt.close();
          showError('An error occurred during processing.');
          break;
      }
    } catch {
      // ignore parse errors
    }
  };

  evt.onerror = () => {
    // If the SSE connection drops, keep the user informed
    progressNote.textContent = 'Still working… (connection will retry automatically)';
  };
})();
