document.addEventListener('DOMContentLoaded', function() {
    // Elements
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const fileDuration = document.getElementById('fileDuration');
    const removeFile = document.getElementById('removeFile');
    const providerCards = document.querySelectorAll('.provider-card');
    const processButton = document.getElementById('processButton');
    const errorContainer = document.getElementById('errorContainer');
    const errorMessage = document.getElementById('errorMessage');
    const priorityCheckbox = document.getElementById('priority');
    const transcriptCheckbox = document.getElementById('transcript');
    const agreeCheckbox = document.getElementById('agree');
    
    // Initialize provider selection
    providerCards.forEach(card => {
        card.addEventListener('click', () => {
            providerCards.forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
        });
    });
    
    // File upload handling
    uploadArea.addEventListener('click', () => {
        fileInput.click();
    });
    
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });
    
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });
    
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        
        if (e.dataTransfer.files.length) {
            handleFile(e.dataTransfer.files[0]);
        }
    });
    
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFile(e.target.files[0]);
        }
    });
    
    async function handleFile(file) {
        // Reset error
        hideError();
        
        // Check if file is a video
        if (!file.type.startsWith('video/')) {
            showError('Please upload a video file (MP4, MOV, AVI, MKV)');
            return;
        }
        
        // Check file size (2GB max)
        const maxSizeGB = 2;
        const maxSizeBytes = maxSizeGB * 1024 * 1024 * 1024;
        if (file.size > maxSizeBytes) {
            showError(`File size exceeds maximum limit of ${maxSizeGB}GB`);
            return;
        }
        
        // Display file info
        fileName.textContent = file.name;
        fileSize.textContent = formatFileSize(file.size);
        
        // Validate with backend
        try {
            const formData = new FormData();
            formData.append('file', file);
            
            const response = await fetch('/validate-video', {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Validation failed');
            }
            
            const data = await response.json();
            fileDuration.textContent = data.duration_human;
            fileInfo.style.display = 'flex';
        } catch (error) {
            showError(error.message);
        }
    }
    
    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' bytes';
        else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        else if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        else return (bytes / 1073741824).toFixed(1) + ' GB';
    }
    
    removeFile.addEventListener('click', () => {
        fileInput.value = '';
        fileInfo.style.display = 'none';
    });
    
    // Process button handling
    processButton.addEventListener('click', async () => {
        // Reset error
        hideError();
        
        // Validation
        if (!fileInput.files.length) {
            showError('Please upload a video file');
            return;
        }
        
        if (!document.querySelector('.provider-card.selected')) {
            showError('Please select an email provider');
            return;
        }
        
        if (!agreeCheckbox.checked) {
            showError('You must agree to the Terms & Conditions');
            return;
        }
        
        // Get selected provider
        const selectedProvider = document.querySelector('.provider-card.selected').dataset.provider;
        
        // Show loading state
        processButton.innerHTML = '<span class="loading"></span> Processing...';
        processButton.disabled = true;
        
        try {
            // Create payment intent
            const paymentResponse = await fetch('/create-payment-intent', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    provider: selectedProvider,
                    priority: priorityCheckbox.checked,
                    transcript: transcriptCheckbox.checked,
                    duration: 180 // In production, use actual duration
                })
            });
            
            if (!paymentResponse.ok) {
                const error = await paymentResponse.json();
                throw new Error(error.detail || 'Payment processing failed');
            }
            
            const paymentData = await paymentResponse.json();
            
            // Process video (with payment intent)
            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            formData.append('payment_intent', paymentData.client_secret);
            
            const processResponse = await fetch('/process-video', {
                method: 'POST',
                body: formData
            });
            
            if (!processResponse.ok) {
                const error = await processResponse.json();
                throw new Error(error.detail || 'Video processing failed');
            }
            
            const processData = await processResponse.json();
            
            // Show success
            alert('Video compressed successfully! You will receive an email with the download link shortly.');
            
            // Redirect to download
            window.location.href = processData.download_url;
        } catch (error) {
            showError(error.message);
        } finally {
            // Reset button
            processButton.innerHTML = '<i class="fas fa-compress-alt"></i> Pay & Compress';
            processButton.disabled = false;
        }
    });
    
    // Error handling functions
    function showError(message) {
        errorMessage.textContent = message;
        errorContainer.classList.add('show');
        
        // Scroll to error
        errorContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    
    function hideError() {
        errorContainer.classList.remove('show');
    }
});