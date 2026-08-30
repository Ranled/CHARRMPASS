/**
 * CHARRMPASS - Registration Page Logic
 * Multi-step form with camera/upload, validation, and Supabase submission
 */

if (typeof initSupabase === 'function') {
    initSupabase();
} else {
    console.warn('supabase-config.js not loaded. Operating in fallback mode.');
}

if (typeof showToast !== 'function') {
    window.showToast = function(msg, type = 'info') {
        alert(msg);
    };
}

let currentStep = 1;
const totalSteps = 4;
let cameraStream = null;
let cameraTarget = null;

// Photo data store
const photoData = {
    profile: null,
    license: null,
    idFront: null,
    idBack: null,
    motorcycle: null
};

// =====================
// STEPPER NAVIGATION
// =====================
function updateStepper() {
    const steps = document.querySelectorAll('.stepper-step');
    steps.forEach(step => {
        const stepNum = parseInt(step.dataset.step);
        step.classList.remove('active', 'completed');
        if (stepNum === currentStep) step.classList.add('active');
        if (stepNum < currentStep) step.classList.add('completed');
    });

    // Show/hide form steps
    document.querySelectorAll('.form-step').forEach(s => s.classList.add('hidden'));
    const activeStep = document.querySelector(`.form-step[data-step="${currentStep}"]`);
    if (activeStep) {
        activeStep.classList.remove('hidden');
        activeStep.classList.add('animate-slide-up');
    }

    // Buttons
    document.getElementById('btnPrevStep').classList.toggle('hidden', currentStep === 1);
    document.getElementById('btnNextStep').classList.toggle('hidden', currentStep === totalSteps);
    document.getElementById('btnSubmit').classList.toggle('hidden', currentStep !== totalSteps);

    // Build review on step 4
    if (currentStep === totalSteps) buildReview();
    
    lucide.createIcons();
}

function validateCurrentStep() {
    if (currentStep === 1) {
        const fields = ['regFullName', 'regAge', 'regSex', 'regAddress', 'regRole'];
        for (const id of fields) {
            const el = document.getElementById(id);
            if (!el.value.trim()) {
                el.focus();
                el.classList.add('border-red-400');
                setTimeout(() => el.classList.remove('border-red-400'), 2000);
                showToast('Please fill in all required fields.', 'warning');
                return false;
            }
        }
    }
    if (currentStep === 2) {
        if (!photoData.profile) {
            showToast('Please upload or take your profile picture first.', 'warning');
            return false;
        }
        if (!photoData.idFront) {
            showToast('Please upload the front of your ID card first.', 'warning');
            return false;
        }
        if (!photoData.idBack) {
            showToast('Please upload the back of your ID card first.', 'warning');
            return false;
        }
    }
    if (currentStep === 3) {
        const fields = ['regVehType', 'regVehModel', 'regPlate', 'regVehColor'];
        for (const id of fields) {
            const el = document.getElementById(id);
            if (!el.value.trim()) {
                el.focus();
                el.classList.add('border-red-400');
                setTimeout(() => el.classList.remove('border-red-400'), 2000);
                showToast('Please fill in all required vehicle fields.', 'warning');
                return false;
            }
        }
    }
    return true;
}

document.getElementById('btnNextStep').addEventListener('click', () => {
    if (!validateCurrentStep()) return;
    if (currentStep < totalSteps) {
        currentStep++;
        updateStepper();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
});

document.getElementById('btnPrevStep').addEventListener('click', () => {
    if (currentStep > 1) {
        currentStep--;
        updateStepper();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
});

// =====================
// CAMERA FUNCTIONALITY
// =====================
function openCamera(target) {
    cameraTarget = target;
    const modal = document.getElementById('cameraModal');
    const video = document.getElementById('cameraVideo');
    
    modal.classList.remove('hidden');
    
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } })
        .then(stream => {
            cameraStream = stream;
            video.srcObject = stream;
        })
        .catch(err => {
            console.error('Camera error:', err);
            showToast('Could not access camera. Please use upload instead.', 'error');
            closeCamera();
        });
}

function closeCamera() {
    const modal = document.getElementById('cameraModal');
    const video = document.getElementById('cameraVideo');
    
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    video.srcObject = null;
    modal.classList.add('hidden');
}

function capturePhoto() {
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    
    const MAX = 600;
    let w = video.videoWidth || 640;
    let h = video.videoHeight || 480;
    if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
    }
    
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    
    // Compress to smaller size for DB storage
    const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
    photoData[cameraTarget] = dataUrl;
    
    updatePhotoPreview(cameraTarget, dataUrl);
    closeCamera();
    showToast('Photo captured successfully!', 'success');
}

// =====================
// FILE UPLOAD
// =====================
function handleFileUpload(input, target) {
    const file = input.files[0];
    if (!file) return;
    
    if (file.size > 5 * 1024 * 1024) {
        showToast('File too large. Maximum 5MB allowed.', 'error');
        return;
    }
    
    // Resize image before storing
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX = 400;
            let w = img.width, h = img.height;
            if (w > MAX || h > MAX) {
                if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
                else { w = Math.round(w * MAX / h); h = MAX; }
            }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const compressed = canvas.toDataURL('image/jpeg', 0.5);
            photoData[target] = compressed;
            updatePhotoPreview(target, compressed);
            showToast('Photo uploaded successfully!', 'success');
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function updatePhotoPreview(target, dataUrl) {
    const previewMap = {
        profile: 'profilePhotoPreview',
        license: 'licensePreview',
        idFront: 'idFrontPreview',
        idBack: 'idBackPreview',
        motorcycle: 'motorcyclePreview'
    };
    
    const container = document.getElementById(previewMap[target]);
    if (!container) return;
    
    if (target === 'idFront' || target === 'idBack' || target === 'motorcycle') {
        container.innerHTML = `<img src="${dataUrl}" alt="${target}" class="w-full h-40 object-cover rounded-lg">`;
        container.parentElement.classList.add('has-image');
    } else {
        container.innerHTML = `<img src="${dataUrl}" alt="${target}" class="w-full h-full object-cover">`;
    }
    
    lucide.createIcons();
}

// =====================
// MOTORCYCLE TOGGLE
// =====================
function toggleMotorcyclePhoto() {
    const type = document.getElementById('regVehType').value;
    const section = document.getElementById('motorcyclePhotoSection');
    section.classList.toggle('hidden', type !== 'Motorcycle');
}

// =====================
// BUILD REVIEW
// =====================
function buildReview() {
    const data = {
        'Full Name': document.getElementById('regFullName').value,
        'Age': document.getElementById('regAge').value,
        'Sex': document.getElementById('regSex').value,
        'Address': document.getElementById('regAddress').value,
        'Role': document.getElementById('regRole').value,
        'Program': document.getElementById('regProgram').value || '--',
        'Section': document.getElementById('regSection').value || '--',
        'Vehicle Type': document.getElementById('regVehType').value,
        'Vehicle Model': document.getElementById('regVehModel').value,
        'Plate Number': document.getElementById('regPlate').value,
        'Vehicle Color': document.getElementById('regVehColor').value,
    };

    const reviewContent = document.getElementById('reviewContent');
    
    let html = `
        <div class="flex items-start gap-5 p-4 bg-white/60 rounded-2xl border border-slate-100">
            <img src="${photoData.profile || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(data['Full Name'])}" alt="Profile" class="w-20 h-20 rounded-2xl object-cover border-2 border-white shadow-md">
            <div>
                <div class="text-xl font-display font-bold text-slate-800">${data['Full Name']}</div>
                <div class="flex items-center gap-2 mt-1">
                    <span class="px-2.5 py-0.5 rounded text-xs font-bold bg-charm-dark text-white uppercase">${data['Role']}</span>
                    <span class="text-sm text-slate-500">${data['Program']} • ${data['Section']}</span>
                </div>
                <div class="text-xs text-slate-400 mt-1">${data['Age']} years old • ${data['Sex']}</div>
            </div>
        </div>
        
        <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
    `;
    
    const vehicleFields = ['Vehicle Type', 'Vehicle Model', 'Plate Number', 'Vehicle Color'];
    vehicleFields.forEach(key => {
        html += `
            <div class="p-3 bg-white/60 rounded-xl border border-slate-100">
                <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">${key}</div>
                <div class="text-sm font-bold text-slate-800 mt-1">${data[key]}</div>
            </div>
        `;
    });
    
    html += '</div>';
    
    // Document thumbnails
    html += '<div class="mt-4"><div class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">Uploaded Documents</div><div class="flex gap-3 flex-wrap">';
    
    const docs = { 'Profile': photoData.profile, 'ID Front': photoData.idFront, 'ID Back': photoData.idBack };
    for (const [label, img] of Object.entries(docs)) {
        if (img) {
            html += `<div class="text-center"><img src="${img}" alt="${label}" class="w-16 h-16 rounded-lg object-cover border border-slate-200 shadow-sm"><div class="text-[10px] font-bold text-slate-400 mt-1">${label}</div></div>`;
        } else {
            html += `<div class="text-center"><div class="w-16 h-16 rounded-lg bg-slate-100 border border-dashed border-slate-300 flex items-center justify-center text-slate-300"><i data-lucide="image-off" class="w-6 h-6"></i></div><div class="text-[10px] font-bold text-slate-400 mt-1">${label} (skipped)</div></div>`;
        }
    }
    html += '</div></div>';
    
    reviewContent.innerHTML = html;
    lucide.createIcons();
}

// =====================
// FORM SUBMISSION
// =====================
document.getElementById('registrationForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const btnSubmit = document.getElementById('btnSubmit');
    const origText = btnSubmit.innerHTML;
    btnSubmit.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Submitting...';
    btnSubmit.disabled = true;
    lucide.createIcons();

    try {
        if (isConnected) {
            // ── STEP 1: Insert into USERS ─────────────────────────────────────
            const { data: newUser, error: userErr } = await supabaseClient
                .from('users')
                .insert([{
                    full_name:             document.getElementById('regFullName').value.trim(),
                    age:                   parseInt(document.getElementById('regAge').value),
                    sex:                   document.getElementById('regSex').value,
                    address:               document.getElementById('regAddress').value.trim(),
                    role:                  document.getElementById('regRole').value,
                    program:               document.getElementById('regProgram').value.trim() || null,
                    section:               document.getElementById('regSection').value.trim() || null,
                    profile_image:         photoData.profile  || null,
                    id_front_image:        photoData.idFront  || null,
                    id_back_image:         photoData.idBack   || null,
                    drivers_license_image: photoData.license  || null,
                }])
                .select()
                .single();
            if (userErr) throw new Error('User insert failed: ' + userErr.message);

            const userId = newUser.id;

            // ── STEP 2: Insert into VEHICLES ──────────────────────────────────
            const { data: newVehicle, error: vehErr } = await supabaseClient
                .from('vehicles')
                .insert([{
                    user_id:          userId,
                    vehicle_type:     document.getElementById('regVehType').value,
                    vehicle_model:    document.getElementById('regVehModel').value.trim(),
                    plate_number:     document.getElementById('regPlate').value.toUpperCase().trim(),
                    vehicle_color:    document.getElementById('regVehColor').value.trim(),
                    motorcycle_image: photoData.motorcycle || null,
                }])
                .select()
                .single();
            if (vehErr) {
                // Roll back user if vehicle insert fails (duplicate plate, etc.)
                await supabaseClient.from('users').delete().eq('id', userId);
                throw new Error('Vehicle insert failed: ' + vehErr.message);
            }

            const vehicleId = newVehicle.id;

            // ── STEP 3: Insert into RFID_CARDS (no UID yet — admin assigns) ──
            const { error: cardErr } = await supabaseClient
                .from('rfid_cards')
                .insert([{
                    rfid_uid:             'UNASSIGNED_' + Date.now(), // placeholder; admin replaces
                    vehicle_id:           vehicleId,
                    user_id:              userId,
                    authorization_status: 'PENDING',
                }]);
            if (cardErr) throw new Error('RFID card insert failed: ' + cardErr.message);

            console.log('✅ Registration saved (user, vehicle, rfid_card):', userId, vehicleId);
            showToast('Registration submitted! Awaiting admin approval.', 'success');

        } else {
            // Demo mode — save flat record to localStorage
            const registrations = JSON.parse(localStorage.getItem('charrmpass_registrations') || '[]');
            const demo = {
                id:                    'local_' + Date.now(),
                created_at:            new Date().toISOString(),
                full_name:             document.getElementById('regFullName').value.trim(),
                age:                   parseInt(document.getElementById('regAge').value),
                sex:                   document.getElementById('regSex').value,
                address:               document.getElementById('regAddress').value.trim(),
                role:                  document.getElementById('regRole').value,
                program:               document.getElementById('regProgram').value.trim() || null,
                section:               document.getElementById('regSection').value.trim() || null,
                vehicle_type:          document.getElementById('regVehType').value,
                vehicle_model:         document.getElementById('regVehModel').value.trim(),
                plate_number:          document.getElementById('regPlate').value.toUpperCase().trim(),
                vehicle_color:         document.getElementById('regVehColor').value.trim(),
                profile_image:         photoData.profile  || null,
                authorization_status:  'PENDING',
            };
            registrations.push(demo);
            localStorage.setItem('charrmpass_registrations', JSON.stringify(registrations));
            showToast('Registration saved locally (Demo Mode).', 'info');
        }

        // Show success screen
        document.getElementById('registrationForm').classList.add('hidden');
        document.getElementById('formStepper').classList.add('hidden');
        document.getElementById('successMessage').classList.remove('hidden');
        
    } catch (err) {
        console.error('Registration error:', err);
        let errMsg = err.message || err.details || 'Registration failed. Please try again.';
        if (errMsg.includes('vehicles_plate_number_key') || errMsg.toLowerCase().includes('duplicate key')) {
            errMsg = 'This license plate is already registered in the system.';
        } else if (errMsg.includes('violates foreign key')) {
            errMsg = 'Database relationship error. Please check your inputs.';
        }
        showToast(errMsg, 'error');
        btnSubmit.innerHTML = origText;
        btnSubmit.disabled = false;
        lucide.createIcons();
    }
});

// Init
updateStepper();
