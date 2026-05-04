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
    showTransferStatus('uploading', `Sending ${pendingFile.name}...`, 0);
    
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
        showTransferStatus('error', 'Upload failed');
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
    
    btn.parentElement.parentElement.innerHTML = `
        <p>Preparing download...</p>
        <div class="progress-container"><div class="progress-bar" id="pb-${transferId}" style="width: 0%"></div></div>
    `;
    
    // In a real stream, we'd have to monitor the download progress.
    // Browsers don't give direct progress on a standard window.location download.
    // So we'll trigger the download.
    window.location.href = `/download/${transferId}`;
}

function showTransferStatus(status, text, progress = null) {
    const container = document.getElementById('status-container');
    let card = document.getElementById('active-transfer-card');
    
    if (!card) {
        card = document.createElement('div');
        card.id = 'active-transfer-card';
        card.className = 'transfer-card';
        container.appendChild(card);
    }
    
    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start;">
            <p style="font-weight: 600;">${status === 'done' ? 'Success' : 'Transfer Status'}</p>
            <i class="fas fa-times" style="cursor: pointer;" onclick="this.parentElement.parentElement.remove()"></i>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin: 8px 0;">${text}</p>
        ${progress !== null ? `
            <div class="progress-container"><div class="progress-bar" style="width: ${progress}%"></div></div>
            <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 5px;">${progress}% complete</p>
        ` : ''}
        <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 5px;">Date: ${new Date().toLocaleString()}</p>
    `;
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
