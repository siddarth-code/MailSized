// v4 – hard cache-bust + instrumentation
window._mailsizedVersion = 'stripe-redirect-4';
console.log('MailSized script version:', window._mailsizedVersion);
alert('MailSized JS loaded: ' + window._mailsizedVersion);

document.addEventListener('DOMContentLoaded', function() {
  console.log('DOMContentLoaded fired.');

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
  const tierLabelEl = document.getElementById('tierLabel');

  // Stepper
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  const step4 = document.getElementById('step4');

  let selectedProvider = 'gmail';
  let jobId = null;
  let basePrice = 0.0;
  let eventSource = null;

  function resetSteps() { [step1,step2,step3,step4].forEach(s => s && s.classList.remove('active')); }
  function setActiveStep(n){ resetSteps(); if(step1&&n>=1)step1.classList.add('active'); if(step2&&n>=2)step2.classList.add('active'); if(step3&&n>=3)step3.classList.add('active'); if(step4&&n>=4)step4.classList.add('active'); }
  function showError(msg){ console.error('UI ERROR:', msg); if(errorMessage) errorMessage.textContent = msg||'Something went wrong'; if(errorContainer) errorContainer.style.display='block'; }
  function hideError(){ if(errorContainer) errorContainer.style.display='none'; if(errorMessage) errorMessage.textContent = ''; }
  function formatFileSize(b){ if(b<1024)return b+' bytes'; if(b<1048576)return (b/1024).toFixed(1)+' KB'; if(b<1073741824)return (b/1048576).toFixed(1)+' MB'; return (b/1073741824).toFixed(1)+' GB'; }
  function formatDuration(s){ const m=Math.floor(s/60), sec=Math.floor(s%60); return `${m}:${sec<10?'0':''}${sec} min`; }
  function updatePriceSummary(){
    const priorityCost = priorityCheckbox?.checked ? 0.75 : 0;
    const transcriptCost = transcriptCheckbox?.checked ? 1.50 : 0;
    const subtotal = basePrice + priorityCost + transcriptCost;
    const tax = subtotal * 0.10; // UI‑only
    const total = subtotal + tax;
    basePriceEl && (basePriceEl.textContent = `$${basePrice.toFixed(2)}`);
    priorityPriceEl && (priorityPriceEl.textContent = `$${priorityCost.toFixed(2)}`);
    transcriptPriceEl && (transcriptPriceEl.textContent = `$${transcriptCost.toFixed(2)}`);
    taxAmountEl && (taxAmountEl.textContent = `$${tax.toFixed(2)}`);
    totalAmountEl && (totalAmountEl.textContent = `$${total.toFixed(2)}`);
    console.log('Price summary updated:', { basePrice, priorityCost, transcriptCost, total });
  }
  function enablePayButton(enable){ if(processButton){ processButton.disabled = !enable; } }
  function getQueryParam(name){ return new URLSearchParams(window.location.search).get(name); }

  function startSSEForJob(id){
    console.log('Opening SSE for job:', id);
    if(eventSource) try{eventSource.close();}catch(e){}
    setActiveStep(3);
    eventSource = new EventSource(`/events/${id}`);
    eventSource.onmessage = function(ev){
      const payload = JSON.parse(ev.data);
      console.log('SSE:', payload);
      const s = payload.status;
      if (s === 'processing' || s === 'compressing' || s === 'finalizing') setActiveStep(3);
      else if (s === 'done'){
        setActiveStep(4);
        if (payload.download_url && downloadLink && downloadSection){
          downloadLink.href = payload.download_url;
          downloadSection.style.display = 'block';
        }
        processButton && (processButton.innerHTML = '<i class="fas fa-check"></i> Completed');
        processButton && (processButton.disabled = true);
        eventSource.close();
      } else if (s === 'error'){
        showError('An error occurred during processing');
        processButton && (processButton.innerHTML = '<i class="fas fa-times"></i> Error');
        processButton && (processButton.disabled = false);
        eventSource.close();
      }
    };
  }

  // Provider click
  providerCards.forEach(card=>{
    card.addEventListener('click', ()=>{
      providerCards.forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      selectedProvider = card.dataset.provider;
      console.log('Provider selected:', selectedProvider);
      updatePriceSummary();
    });
  });
  priorityCheckbox?.addEventListener('change', updatePriceSummary);
  transcriptCheckbox?.addEventListener('change', updatePriceSummary);

  // Upload interactions
  uploadArea?.addEventListener('click', ()=> fileInput?.click());
  uploadArea?.addEventListener('dragover', (e)=>{ e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea?.addEventListener('dragleave', ()=> uploadArea.classList.remove('dragover'));
  uploadArea?.addEventListener('drop', (e)=>{
    e.preventDefault(); uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput?.addEventListener('change', (e)=>{
    if (e.target.files.length) handleFile(e.target.files[0]);
  });
  removeFileBtn?.addEventListener('click', ()=>{
    if (fileInput) fileInput.value='';
    if (fileInfo) fileInfo.style.display='none';
    jobId=null; basePrice=0; updatePriceSummary(); setActiveStep(1);
  });

  async function handleFile(file){
    hideError();
    if (downloadSection) downloadSection.style.display='none';

    const allowed = ['video/mp4','video/quicktime','video/x-matroska','video/x-msvideo'];
    console.log('Selected file:', {name:file.name,size:file.size,type:file.type});
    if (!allowed.includes(file.type)){ showError('Please upload a video file (MP4, MOV, AVI, MKV)'); return; }
    const maxBytes = 2*1024*1024*1024; if (file.size>maxBytes){ showError('File size exceeds maximum limit of 2GB'); return; }

    fileNameEl && (fileNameEl.textContent = file.name);
    fileSizeEl && (fileSizeEl.textContent = formatFileSize(file.size));
    fileDurationEl && (fileDurationEl.textContent = '...');
    fileInfo && (fileInfo.style.display='flex');

    setActiveStep(1);
    enablePayButton(false);
    processButton && (processButton.innerHTML = '<span class="loading"></span> Uploading...');

    try{
      const formData = new FormData();
      formData.append('file', file);
      console.log('ABOUT TO POST /upload');
      const response = await fetch('/upload', { method:'POST', body: formData });
      console.log('UPLOAD RESP STATUS', response.status);
      if (!response.ok){
        let errMsg='Upload failed';
        try{ const err = await response.json(); errMsg = err.detail||errMsg; } catch{}
        throw new Error(errMsg);
      }
      const data = await response.json();
      console.log('UPLOAD_DATA', data);

      const fallbackByTier = {1:1.99, 2:2.99, 3:4.99};
      jobId = data.job_id;
      const parsedPrice = Number(data.price);
      basePrice = Number.isFinite(parsedPrice) ? parsedPrice : (fallbackByTier[data.tier]||0);

      if (fileSizeEl) fileSizeEl.textContent = formatFileSize(data.size_bytes ?? 0);
      if (fileDurationEl) fileDurationEl.textContent = formatDuration(data.duration_sec ?? 0);
      if (tierLabelEl) tierLabelEl.textContent = `Tier ${data.tier ?? '?'}`;
      updatePriceSummary();

      setActiveStep(2);
      enablePayButton(true);
      processButton && (processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress');
    }catch(err){
      console.error('UPLOAD ERROR', err);
      showError(err.message);
      enablePayButton(true);
      processButton && (processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress');
    }
  }

  processButton?.addEventListener('click', async ()=>{
    hideError();
    if (!fileInput?.files.length){ showError('Please upload a video file'); return; }
    if (!agreeCheckbox?.checked){ showError('You must agree to the Terms & Conditions'); return; }
    if (!jobId){ showError('File validation failed'); return; }

    enablePayButton(false);
    processButton && (processButton.innerHTML = '<span class="loading"></span> Redirecting to Stripe...');

    const formData = new FormData();
    formData.append('job_id', jobId);
    formData.append('provider', selectedProvider);
    formData.append('priority', !!priorityCheckbox?.checked);
    formData.append('transcript', !!transcriptCheckbox?.checked);
    formData.append('email', emailInput?.value || '');

    try{
      console.log('ABOUT TO POST /checkout');
      const resp = await fetch('/checkout', { method:'POST', body: formData });
      console.log('CHECKOUT RESP STATUS', resp.status);
      if (!resp.ok){
        let errMsg='Checkout failed';
        try{ const err = await resp.json(); errMsg = err.detail||errMsg; } catch{}
        throw new Error(errMsg);
      }
      const data = await resp.json();
      console.log('CHECKOUT_DATA', data);
      if (data.checkout_url){
        window.location.href = data.checkout_url;
      } else {
        showError('No checkout URL returned');
        enablePayButton(true);
        processButton && (processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress');
      }
    }catch(err){
      console.error('CHECKOUT ERROR', err);
      showError(err.message);
      enablePayButton(true);
      processButton && (processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress');
    }
  });

  // Resume after Stripe
  (function resumeIfPaid(){
    const paid = getQueryParam('paid');
    const jid = getQueryParam('job_id');
    console.log('resumeIfPaid()', {paid, jid});
    if (paid === '1' && jid){ setActiveStep(3); startSSEForJob(jid); }
  })();
});
