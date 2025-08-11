// Client‑side logic for the MailSized frontend.
//
// Flow summary:
// 1) User uploads file -> /upload returns {job_id, price, tier, duration_sec, size_bytes}
//    -> update Base price & UI, enable Pay
// 2) User clicks Pay -> POST /checkout -> get {checkout_url} -> redirect to Stripe
// 3) Stripe redirects back with ?paid=1&job_id=... -> connect to /events/{job_id}, show stepper updates
// 4) On 'done' -> show Download link; email is sent in parallel by backend

document.addEventListener('DOMContentLoaded', function() {
  // --- Element references ---
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileNameEl = document.getElementById('fileName');
  const fileSizeEl = document.getElementById('fileSize');
  const fileDurationEl = document.getElementById('fileDuration');
  const removeFileBtn = document.getElementById('removeFile');

  const providerCards = document.querySelectorAll('.provider-card');
  const priorityCheckbox = document.getElementById('priority');
  const transcriptCheckbox = document.getElementById('transcript');
  const agreeCheckbox = document.getElementById('agree');
  const emailInput = document.getElementById('userEmail');
  const processButton = document.getElementById('processButton');

  const errorContainer = document.getElementById('errorContainer');
  const errorMessage = document.getElementById('errorMessage');

  const downloadSection = document.getElementById('downloadSection');
  const downloadLink = document.getElementById('downloadLink');

  // Pricing elements
  const basePriceEl = document.getElementById('basePrice');
  const priorityPriceEl = document.getElementById('priorityPrice');
  const transcriptPriceEl = document.getElementById('transcriptPrice');
  const taxAmountEl = document.getElementById('taxAmount');
  const totalAmountEl = document.getElementById('totalAmount');
  const tierLabelEl = document.getElementById('tierLabel'); // optional in your HTML

  // Stepper elements
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  const step4 = document.getElementById('step4');

  // --- State ---
  let selectedProvider = 'gmail';
  let jobId = null;
  let basePrice = 0.0;
  let eventSource = null;

  // --- Helpers ---
  function resetSteps() {
    step1.classList.remove('active');
    step2.classList.remove('active');
    step3.classList.remove('active');
    step4.classList.remove('active');
  }
  function setActiveStep(step) {
    resetSteps();
    if (step >= 1) step1.classList.add('active');
    if (step >= 2) step2.classList.add('active');
    if (step >= 3) step3.classList.add('active');
    if (step >= 4) step4.classList.add('active');
  }
  function showError(msg) {
    errorMessage.textContent = msg || 'Something went wrong';
    errorContainer.style.display = 'block';
  }
  function hideError() {
    errorContainer.style.display = 'none';
    errorMessage.textContent = '';
  }
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    else if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    else return (bytes / 1073741824).toFixed(1) + ' GB';
  }
  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs} min`;
  }
  function updatePriceSummary() {
    const priorityCost = priorityCheckbox.checked ? 0.75 : 0;
    const transcriptCost = transcriptCheckbox.checked ? 1.50 : 0;
    const subtotal = basePrice + priorityCost + transcriptCost;

    // If you don’t want tax in UI, set tax to 0 or hide the row.
    const tax = subtotal * 0.10;
    const total = subtotal + tax;

    if (basePriceEl) basePriceEl.textContent = `$${basePrice.toFixed(2)}`;
    if (priorityPriceEl) priorityPriceEl.textContent = `$${priorityCost.toFixed(2)}`;
    if (transcriptPriceEl) transcriptPriceEl.textContent = `$${transcriptCost.toFixed(2)}`;
    if (taxAmountEl) taxAmountEl.textContent = `$${tax.toFixed(2)}`;
    if (totalAmountEl) totalAmountEl.textContent = `$${total.toFixed(2)}`;
  }
  function enablePayButton(enable) {
    processButton.disabled = !enable;
  }
  function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }
  function startSSEForJob(id) {
    // Close prior stream if any
    if (eventSource) try { eventSource.close(); } catch(e) {}
    setActiveStep(3); // Payment done, now processing → compression → finalizing
    eventSource = new EventSource(`/events/${id}`);
    eventSource.onmessage = function(ev) {
      const payload = JSON.parse(ev.data);
      const status = payload.status;
      if (status === 'processing' || status === 'compressing' || status === 'finalizing') {
        setActiveStep(3);
      } else if (status === 'done') {
        setActiveStep(4);
        if (payload.download_url) {
          downloadLink.href = payload.download_url;
          downloadSection.style.display = 'block';
        }
        processButton.innerHTML = '<i class="fas fa-check"></i> Completed';
        processButton.disabled = true;
        eventSource.close();
      } else if (status === 'error') {
        showError('An error occurred during processing');
        processButton.innerHTML = '<i class="fas fa-times"></i> Error';
        processButton.disabled = false;
        eventSource.close();
      }
    };
  }

  // --- Provider selection ---
  providerCards.forEach(card => {
    card.addEventListener('click', () => {
      providerCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedProvider = card.dataset.provider;
      updatePriceSummary();
    });
  });
  priorityCheckbox.addEventListener('change', updatePriceSummary);
  transcriptCheckbox.addEventListener('change', updatePriceSummary);

  // --- Upload interactions ---
  uploadArea.addEventListener('click', () => fileInput.click());
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });
  removeFileBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInfo.style.display = 'none';
    jobId = null;
    basePrice = 0;
    updatePriceSummary();
    setActiveStep(1);
  });

  async function handleFile(file) {
    hideError();
    downloadSection.style.display = 'none';

    // Quick client validation
    const allowed = ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo'];
    if (!allowed.includes(file.type)) {
      showError('Please upload a video file (MP4, MOV, AVI, MKV)');
      return;
    }
    const maxBytes = 2 * 1024 * 1024 * 1024; // 2GB
    if (file.size > maxBytes) {
      showError('File size exceeds maximum limit of 2GB');
      return;
    }

    // Show name/size immediately
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatFileSize(file.size);
    fileDurationEl.textContent = '...';
    fileInfo.style.display = 'flex';

    // Begin upload for probing
    setActiveStep(1);
    enablePayButton(false);
    processButton.innerHTML = '<span class="loading"></span> Uploading...';

    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/upload', { method: 'POST', body: formData });
      if (!response.ok) {
        let errMsg = 'Upload failed';
        try { const err = await response.json(); errMsg = err.detail || errMsg; } catch {}
        throw new Error(errMsg);
      }
      const data = await response.json();

      // Save job + pricing from server
      jobId = data.job_id;
      basePrice = Number(data.price) || 0;

      // Update UI with probed size/duration + base price + tier label
      fileSizeEl.textContent = formatFileSize(data.size_bytes);
      fileDurationEl.textContent = formatDuration(data.duration_sec);
      if (tierLabelEl) tierLabelEl.textContent = `Tier ${data.tier}`;
      updatePriceSummary();

      setActiveStep(2);
      enablePayButton(true);
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    } catch (err) {
      console.error(err);
      showError(err.message);
      enablePayButton(true);
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  }

  // --- Pay & Compress (Stripe redirect) ---
  processButton.addEventListener('click', async () => {
    hideError();
    if (!fileInput.files.length) {
      showError('Please upload a video file');
      return;
    }
    if (!agreeCheckbox.checked) {
      showError('You must agree to the Terms & Conditions');
      return;
    }
    if (!jobId) {
      showError('File validation failed');
      return;
    }

    enablePayButton(false);
    processButton.innerHTML = '<span class="loading"></span> Redirecting to Stripe...';

    const formData = new FormData();
    formData.append('job_id', jobId);
    formData.append('provider', selectedProvider);
    formData.append('priority', priorityCheckbox.checked);
    formData.append('transcript', transcriptCheckbox.checked);
    formData.append('email', emailInput.value || '');

    try {
      const resp = await fetch('/checkout', { method: 'POST', body: formData });
      if (!resp.ok) {
        let errMsg = 'Checkout failed';
        try { const err = await resp.json(); errMsg = err.detail || errMsg; } catch {}
        throw new Error(errMsg);
      }
      const data = await resp.json();
      if (data.checkout_url) {
        window.location.href = data.checkout_url; // go to Stripe Checkout
      } else {
        showError('No checkout URL returned');
        enablePayButton(true);
        processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
      }
    } catch (err) {
      console.error(err);
      showError(err.message);
      enablePayButton(true);
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  });

  // --- Return from Stripe: auto‑resume job ---
  // If Stripe sent us back with ?paid=1&job_id=..., attach to SSE and advance stepper
  (function resumeIfPaid() {
    const paid = getQueryParam('paid');
    const jid  = getQueryParam('job_id');
    if (paid === '1' && jid) {
      jobId = jid;
      setActiveStep(3);
      startSSEForJob(jid);
    }
  })();
});
