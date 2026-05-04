const clientId = localStorage.getItem('orbit_client_id') || Math.random().toString(36).substring(2, 11);
localStorage.setItem('orbit_client_id', clientId);

let userName = localStorage.getItem('orbit_user_name') || `User_${Math.floor(Math.random() * 1000)}`;
document.getElementById('username').value = userName;

let selectedTargetId = null;
let ws = null;

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${encodeURIComponent(clientId)}/${encodeURIComponent(userName)}`);
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("WS Message:", data);
        
        if (data.type === 'user_list') {
            updateUserList(data.users);
        } else if (data.type === 'incoming_transfer') {
            showIncomingNotification(data);
        } else if (data.type === 'transfer_approved') {
            startUpload(data.transfer_id);
        } else if (data.type === 'transfer_status') {
            updateDownloadProgress(data);
        }
    };

    ws.onclose = () => {
        setTimeout(connect, 2000); // Reconnect
    };
}

function updateUserList(users) {
    const list = document.getElementById('user-list');
    list.innerHTML = '';
    users.filter(u => u.id !== clientId).forEach(user => {
        const li = document.createElement('li');
        li.className = `user-item ${selectedTargetId === user.id ? 'active' : ''}`;
        li.innerHTML = `
            <span>${user.name}</span>
            <i class="fas fa-chevron-right"></i>
        `;
        li.onclick = () => selectUser(user);
        list.appendChild(li);
    });
}

function selectUser(user) {
    selectedTargetId = user.id;
    document.getElementById('target-name').innerText = user.name;
    document.getElementById('no-target').style.display = 'none';
    document.getElementById('transfer-zone').style.display = 'block';
    
    // Update UI selection
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    event.currentTarget.classList.add('active');
}

// Name Change
document.getElementById('username').onchange = (e) => {
    userName = e.target.value;
    localStorage.setItem('orbit_user_name', userName);
    ws.send(JSON.stringify({type: 'change_name', name: userName}));
};

// File Handlers
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
let pendingFile = null;

dropZone.onclick = () => fileInput.click();

fileInput.onchange = (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
};

dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
};

dropZone.ondragleave = () => dropZone.classList.remove('dragover');

dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
};

function handleFile(file) {
    if (!selectedTargetId) return;
    pendingFile = file;
    
    ws.send(JSON.stringify({
        type: 'transfer_request',
        target_id: selectedTargetId,
        filename: file.name,
        size: file.size
    }));
    
    showTransferStatus('waiting', `Asking ${document.getElementById('target-name').innerText} to accept...`);
}

async function startUpload(transferId) {
    if (!pendingFile) return;
    
    const startTime = new Date();
    showTransferStatus(transferId, 'uploading', `Sending ${pendingFile.name}...`, 0);
    
    const formData = new FormData();
    // We don't use conventional FormData because we want to stream from the body directly
    // but browser support for fetch streaming body is getting better.
    // However, using a chunked reader with fetch is more reliable.

    try {
        const response = await fetch(`/upload/${transferId}`, {
            method: 'POST',
            body: pendingFile, // This streams the file in Fetch API
            duplex: 'half' // Required for streaming request bodies in Chrome
        });

        if (response.ok) {
            showTransferStatus('done', `Finished sending ${pendingFile.name}`);
        }
    } catch (err) {
        console.error("Upload failed", err);
        showTransferStatus(transferId, 'error', 'Upload failed');
    }
}

function showIncomingNotification(data) {
    const container = document.getElementById('notifications-container');
    const div = document.createElement('div');
    div.className = 'notification';
    div.innerHTML = `
        <p><strong>${data.sender_name}</strong> wants to send you:</p>
        <p style="font-size: 1.1rem; margin: 10px 0;">${data.filename} (${formatBytes(data.size)})</p>
        <div style="display: flex; gap: 10px; margin-top: 15px;">
            <button class="btn btn-primary" onclick="acceptTransfer('${data.transfer_id}', this)">Accept</button>
            <button class="btn" style="background: var(--danger); color: white;" onclick="this.parentElement.parentElement.remove()">Decline</button>
        </div>
    `;
    container.appendChild(div);
}

function acceptTransfer(transferId, btn) {
    ws.send(JSON.stringify({
        type: 'transfer_accept',
        transfer_id: transferId
    }));
    
    btn.parentElement.parentElement.id = `transfer-${transferId}`;
    btn.parentElement.parentElement.innerHTML = `
        <div style="display: flex; justify-content: space-between;">
            <p><strong>Receiving File...</strong></p>
            <span id="rate-${transferId}">0 KB/s</span>
        </div>
        <div class="progress-container" style="margin: 10px 0;">
            <div class="progress-bar" id="pb-${transferId}" style="width: 0%"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted);">
            <span id="percent-${transferId}">0%</span>
            <span id="size-${transferId}">0 / 0</span>
        </div>
    `;
    
    const a = document.createElement('a');
    a.href = `/download/${transferId}`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
}

let lastProgress = {};

function updateDownloadProgress(data) {
    if (data.status === 'complete') {
        const el = document.getElementById(`transfer-${data.transfer_id}`);
        if (el) {
            el.innerHTML = `<p style="color: var(--accent)"><i class="fas fa-check-circle"></i> Download Finished!</p>`;
            setTimeout(() => el.remove(), 5000);
        }
        return;
    }

    const pb = document.getElementById(`pb-${data.transfer_id}`);
    const percent = document.getElementById(`percent-${data.transfer_id}`);
    const size = document.getElementById(`size-${data.transfer_id}`);
    const rate = document.getElementById(`rate-${data.transfer_id}`);

    if (pb) {
        pb.style.width = `${data.percentage}%`;
        percent.innerText = `${data.percentage}%`;
        size.innerText = `${formatBytes(data.bytes_sent)} / ${formatBytes(data.total_size)}`;
        
        // Calculate rate
        const now = Date.now();
        const last = lastProgress[data.transfer_id] || { time: now, bytes: 0 };
        const deltaBytes = data.bytes_sent - last.bytes;
        const deltaTime = (now - last.time) / 1000;
        
        if (deltaTime >= 0.5) {
            const kbps = (deltaBytes / 1024) / deltaTime;
            rate.innerText = kbps > 1024 ? `${(kbps/1024).toFixed(2)} MB/s` : `${kbps.toFixed(1)} KB/s`;
            lastProgress[data.transfer_id] = { time: now, bytes: data.bytes_sent };
        }
    }
}

function showTransferStatus(transferId, status, text, progress = null) {
    const container = document.getElementById('status-container');
    let card = document.getElementById(`transfer-${transferId}`);
    
    if (!card) {
        card = document.createElement('div');
        card.id = `transfer-${transferId}`;
        card.className = 'transfer-card';
        container.appendChild(card);
    }
    
    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start;">
            <p style="font-weight: 600;">${status === 'done' ? 'Success' : 'Transfer Progress'}</p>
            <span id="rate-${transferId}" style="font-size: 0.8rem;">0 KB/s</span>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin: 8px 0;">${text}</p>
        <div class="progress-container"><div class="progress-bar" id="pb-${transferId}" style="width: ${progress || 0}%"></div></div>
        <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-top: 5px;">
            <span id="percent-${transferId}">${progress || 0}%</span>
            <span id="size-${transferId}">0 / 0</span>
        </div>
        <p style="font-size: 0.7rem; color: var(--text-muted); margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 5px;">Date: ${new Date().toLocaleTimeString()}</p>
    `;
    
    if (status === 'done') {
        setTimeout(() => card.remove(), 5000);
    }
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

connect();
