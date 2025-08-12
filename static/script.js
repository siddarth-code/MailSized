// MailSized client (provider-aware pricing + Stripe resume)
window._mailsizedVersion = 'p7p9-provider-fix-1';
console.log('MailSized script version:', window._mailsizedVersion);

document.addEventListener('DOMContentLoaded', function () {
  // --- Elements
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

  // Pricing UI
  const basePriceEl = document.getElementById('basePrice');
  const priorityPriceEl = document.getElementById('priorityPrice');
  const transcriptPriceEl = document.getElementById('transcriptPrice');
  const taxAmountEl = document.getElementById('taxAmount');
  const totalAmountEl = document.getElementById('totalAmount');

  // Stepper
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  const step4 = document.getElementById('step4');

  // --- State
  const PROVIDER_PRICING = {
    gmail:   [1.99, 2.99, 4.49],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };
  let selectedProvider = 'gmail';
  let jobId = null;
  let tier = null;        // 1 | 2 | 3 from /upload
  let basePrice = 0.00;   // computed from provider + tier
  let eventSource = null;

  // --- Helpers
  function resetSteps(){ [step1,step2,step3,step4].forEach(s=>s.classList.remove('active')); }
  function setActiveStep(n){ resetSteps(); if(n>=1)step1.classList.add('active'); if(n>=2)step2.classList.add('active'); if(n>=3)step3.classList.add('active'); if(n>=4)step4.classList.add('active'); }
  function showError(msg){ errorMessage.textContent = msg || 'Something went wrong'; errorContainer.style.display = 'block'; }
  function hideError(){ errorContainer.style.display = 'none'; errorMessage.textContent = ''; }
  function formatFileSize(bytes){ if(bytes<1024)return bytes+' bytes'; if(bytes<1048576)return (bytes/1024).toFixed(1)+' KB'; if(bytes<1073741824)return (bytes/1048576).toFixed(1)+' MB'; return (bytes/1073741824).toFixed(1)+' GB'; }
  function formatDuration(seconds){ const m=Math.floor(seconds/60); const s=Math.floor(seconds%60); return `${m}:${s<10?'0':''}${s} min`; }
  function getQueryParam(name){ return new URLSearchParams(window.location.search).get(name); }

  function computeBaseFromProvider(){
    if(!tier) return 0;
    const arr = PROVIDER_PRICING[selectedProvider] || PROVIDER_PRICING.gmail;
    return Number(arr[tier - 1] || 0);
  }

  function updatePriceSummary(){
    basePrice = computeBaseFromProvider();
    const upsPriority = priorityCheckbox.checked ? 0.75 : 0;
    const upsTranscript = transcriptCheckbox.checked ? 1.50 : 0;
    const subtotal = basePrice + upsPriority + upsTranscript;
    const tax = subtotal * 0.10;
    const total = subtotal + tax;

    basePriceEl.textContent = `$${basePrice.toFixed(2)}`;
    priorityPriceEl.textContent = `$${upsPriority.toFixed(2)}`;
    transcriptPriceEl.textContent = `$${upsTranscript.toFixed(2)}`;
    taxAmountEl.textContent = `$${tax.toFixed(2)}`;
    totalAmountEl.textContent = `$${total.toFixed(2)}`;
  }

  function startSSE(id){
    if(eventSource) try{eventSource.close();}catch(_){}
    setActiveStep(3);
    eventSource = new EventSource(`/events/${id}`);
    eventSource.onmessage = (ev)=>{
      const data = JSON.parse(ev.data||'{}');
      if(['processing','compressing','finalizing'].includes(data.status)) setActiveStep(3);
      if(data.status==='done'){
        setActiveStep(4);
        if(data.download_url){
          downloadLink.href = data.download_url;
          downloadSection.style.display = 'block';
        }
        processButton.innerHTML = '<i class="fas fa-check"></i> Completed';
        processButton.disabled = true;
        eventSource.close();
      }
      if(data.status==='error'){
        showError('An error occurred during processing');
        processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
        processButton.disabled = false;
        eventSource.close();
      }
    };
  }

  // --- Provider selection
  providerCards.forEach(card=>{
    card.addEventListener('click', ()=>{
      providerCards.forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      selectedProvider = card.dataset.provider;
      updatePriceSummary(); // recompute base from provider + tier
    });
  });
  priorityCheckbox.addEventListener('change', updatePriceSummary);
  transcriptCheckbox.addEventListener('change', updatePriceSummary);

  // --- Upload interactions
  uploadArea.addEventListener('click', ()=>fileInput.click());
  uploadArea.addEventListener('dragover', e=>{ e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', ()=>uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', e=>{
    e.preventDefault(); uploadArea.classList.remove('dragover');
    if(e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e=>{ if(e.target.files.length) handleFile(e.target.files[0]); });
  removeFileBtn.addEventListener('click', ()=>{
    fileInput.value=''; fileInfo.style.display='none';
    jobId=null; tier=null; basePrice=0; updatePriceSummary(); setActiveStep(1);
  });

  async function handleFile(file){
    hideError(); downloadSection.style.display='none';

    if(!file.type.startsWith('video/')){ showError('Please upload a video file (MP4, MOV, AVI, MKV)'); return; }
    if(file.size > 2*1024*1024*1024){ showError('File size exceeds maximum limit of 2GB'); return; }

    // Show immediate info
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatFileSize(file.size);
    fileDurationEl.textContent = '...';
    fileInfo.style.display = 'flex';

    setActiveStep(1);
    processButton.disabled = true;
    processButton.innerHTML = '<span class="loading"></span> Uploading...';

    try{
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch('/upload',{method:'POST', body:fd});
      if(!res.ok){ let msg='Upload failed'; try{ const e=await res.json(); msg=e.detail||msg; }catch{} throw new Error(msg); }
      const data = await res.json();
      // Save job + tier
      jobId = data.job_id;
      tier = Number(data.tier);
      // Update file info with server probe
      fileSizeEl.textContent = formatFileSize(data.size_bytes);
      fileDurationEl.textContent = formatDuration(data.duration_sec);
      // Compute new base from provider+tier and refresh panel
      updatePriceSummary();
      setActiveStep(2);
      processButton.disabled = false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }catch(err){
      console.error(err);
      showError(err.message);
      processButton.disabled=false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  }

  // --- Pay & Compress (Stripe)
  processButton.addEventListener('click', async ()=>{
    hideError();
    if(!fileInput.files.length){ showError('Please upload a video file'); return; }
    if(!agreeCheckbox.checked){ showError('You must agree to the Terms & Conditions'); return; }
    if(!jobId || !tier){ showError('File validation failed'); return; }

    processButton.disabled = true;
    processButton.innerHTML = '<span class="loading"></span> Redirecting to Stripe...';

    try{
      const fd = new FormData();
      fd.append('job_id', jobId);
      fd.append('provider', selectedProvider);
      fd.append('priority', String(priorityCheckbox.checked));
      fd.append('transcript', String(transcriptCheckbox.checked));
      fd.append('email', emailInput.value || '');

      const resp = await fetch('/checkout', { method:'POST', body: fd });
      if(!resp.ok){ let msg='Checkout failed'; try{ const e=await resp.json(); msg=e.detail||msg;}catch{} throw new Error(msg); }
      const data = await resp.json();
      if(data.checkout_url) window.location.href = data.checkout_url;
      else { showError('No checkout URL returned'); processButton.disabled=false; processButton.innerHTML='<i class="fas fa-credit-card"></i> Pay & Compress'; }
    }catch(err){
      console.error(err);
      showError(err.message);
      processButton.disabled=false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  });

  // --- Return from Stripe: auto‑resume if paid
  (function resumeIfPaid(){
    const paid = getQueryParam('paid');
    const jid  = getQueryParam('job_id');
    if(paid === '1' && jid){
      jobId = jid;
      setActiveStep(3);
      startSSE(jid);
    }
  })();
});
