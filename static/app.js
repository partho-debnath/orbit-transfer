const clientId = localStorage.getItem('orbit_client_id') || Math.random().toString(36).substring(2, 11);
localStorage.setItem('orbit_client_id', clientId);

let userName = localStorage.getItem('orbit_user_name') || `User_${Math.floor(Math.random() * 1000)}`;
document.getElementById('username').value = userName;

let selectedTargetId = null;
let selectedGroupId = null;
let ws = null;
let transferRoles = {};
let groupData = {};
let allUsers = [];

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${encodeURIComponent(clientId)}/${encodeURIComponent(userName)}`);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("WS Message:", data);

        if (data.type === 'user_list') {
            updateUserList(data.users);
        } else if (data.type === 'incoming_transfer') {
            handleIncomingTransfer(data);
        } else if (data.type === 'transfer_approved') {
            startUpload(data.transfer_id);
        } else if (data.type === 'transfer_status') {
            updateDownloadProgress(data);
        } else if (data.type === 'group_list') {
            updateGroupList(data.groups);
        } else if (data.type === 'group_invite') {
            console.log("Processing group invite:", data);
            handleGroupInvite(data);
        }
    };

    ws.onclose = () => {
        setTimeout(connect, 2000); // Reconnect
    };
}

function updateUserList(users) {
    allUsers = users;
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
    selectedGroupId = null;
    document.getElementById('target-name').innerText = user.name;
    document.getElementById('no-target').style.display = 'none';
    document.getElementById('transfer-zone').style.display = 'block';

    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    event.currentTarget.classList.add('active');
}

function updateGroupList(groups) {
    const list = document.getElementById('group-list');
    list.innerHTML = '';
    groups.forEach(group => {
        groupData[group.id] = group;
        const li = document.createElement('li');
        li.className = `user-item ${selectedGroupId === group.id ? 'active' : ''}`;

        const isCreator = group.creator_id === clientId;
        li.innerHTML = `
            <div style="display: flex; flex-direction: column;">
                <span><i class="fas fa-layer-group"></i> ${group.name}</span>
                <small style="font-size: 0.65rem; color: var(--text-muted);">${group.members.length} members</small>
            </div>
            <div style="display:flex; gap: 8px;">
                ${isCreator ? '<button onclick="event.stopPropagation(); addMemberPrompt(\'' + group.id + '\')" title="Manage Members" style="background:none; border:none; color:var(--accent); cursor:pointer;"><i class="fas fa-user-gear"></i></button>' : ''}
                ${isCreator ? '<button onclick="event.stopPropagation(); deleteGroup(\'' + group.id + '\')" title="Delete Group" style="background:none; border:none; color:var(--danger); cursor:pointer;"><i class="fas fa-trash"></i></button>' : ''}
            </div>
        `;
        li.onclick = (e) => selectGroup(group, e);
        list.appendChild(li);
    });
}

function selectGroup(group, event) {
    selectedGroupId = group.id;
    selectedTargetId = null;
    document.getElementById('target-name').innerText = `Group: ${group.name}`;
    document.getElementById('no-target').style.display = 'none';
    document.getElementById('transfer-zone').style.display = 'block';

    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    if (event) event.currentTarget.classList.add('active');
}

document.getElementById('btn-create-group').onclick = () => {
    const name = prompt("Enter Group Name:");
    if (name) {
        ws.send(JSON.stringify({ type: 'create_group', name: name }));
    }
};

function deleteGroup(groupId) {
    if (confirm("Are you sure you want to delete this group?")) {
        ws.send(JSON.stringify({ type: 'delete_group', group_id: groupId }));
        if (selectedGroupId === groupId) {
            selectedGroupId = null;
            document.getElementById('no-target').style.display = 'flex';
            document.getElementById('transfer-zone').style.display = 'none';
        }
    }
}

function addMemberPrompt(groupId) {
    const modal = document.getElementById('member-modal');
    const list = document.getElementById('modal-user-list');
    list.innerHTML = '';

    const group = groupData[groupId];
    const isCreator = group.creator_id === clientId;
    const currentMembers = new Set(group.members);

    // Show Current Members section
    const membersHeading = document.createElement('h4');
    membersHeading.style = "font-size: 0.75rem; color: var(--text-muted); margin-bottom: 10px; text-transform: uppercase;";
    membersHeading.innerText = "Current Members";
    list.appendChild(membersHeading);

    if (group.members.length === 0) {
        list.innerHTML += '<p style="padding: 10px; color: var(--text-muted); font-size: 0.8rem;">No members yet</p>';
    } else {
        group.members.forEach(mid => {
            const user = allUsers.find(u => u.id === mid) || { name: `Offline User (${mid.substring(0, 4)})`, id: mid };
            const div = document.createElement('div');
            div.className = 'modal-user-item';
            div.innerHTML = `
                <span>${user.name}</span>
                ${isCreator ? `<button class="btn" style="background:var(--danger); color:white; padding: 2px 8px; font-size:0.7rem;" onclick="removeMember('${groupId}', '${mid}')">Remove</button>` : ''}
            `;
            list.appendChild(div);
        });
    }

    // Show Invite section
    const inviteHeading = document.createElement('h4');
    inviteHeading.style = "font-size: 0.75rem; color: var(--text-muted); margin: 20px 0 10px 0; text-transform: uppercase;";
    inviteHeading.innerText = "Invite Online Users";
    list.appendChild(inviteHeading);

    const availableUsers = allUsers.filter(u => u.id !== clientId && !currentMembers.has(u.id));

    if (availableUsers.length === 0) {
        const p = document.createElement('p');
        p.style = "padding: 10px; color: var(--text-muted); font-size: 0.8rem;";
        p.innerText = "No other users online";
        list.appendChild(p);
    } else {
        availableUsers.forEach(user => {
            const div = document.createElement('div');
            div.className = 'modal-user-item';
            div.innerHTML = `
                <span>${user.name}</span>
                <button class="btn btn-primary" style="padding: 4px 10px; font-size: 0.75rem;" onclick="addMember('${groupId}', '${user.id}')">Add</button>
            `;
            list.appendChild(div);
        });
    }

    modal.style.display = 'flex';
}

function addMember(groupId, memberId) {
    ws.send(JSON.stringify({ type: 'add_member', group_id: groupId, member_id: memberId }));
}

function removeMember(groupId, memberId) {
    if (confirm("Remove this member?")) {
        ws.send(JSON.stringify({ type: 'remove_member', group_id: groupId, member_id: memberId }));
    }
}

function hideModal() {
    document.getElementById('member-modal').style.display = 'none';
}

function handleGroupInvite(data) {
    console.log("Received Group Invite:", data);
    const container = document.getElementById('notifications-container');
    const div = document.createElement('div');
    div.className = 'notification';
    div.id = `invite-${data.group_id}`;
    div.innerHTML = `
        <p><strong>${data.creator_name}</strong> invited you to join:</p>
        <p style="font-size: 1.1rem; margin: 10px 0;">Group: ${data.group_name}</p>
        <div style="display: flex; gap: 10px; margin-top: 15px;">
            <button class="btn btn-primary" onclick="acceptGroupInvite('${data.group_id}')">Join</button>
            <button class="btn" onclick="this.parentElement.parentElement.remove()">Ignore</button>
        </div>
    `;
    container.appendChild(div);
}

function acceptGroupInvite(groupId) {
    console.log("Accepting Group Invite:", groupId);
    ws.send(JSON.stringify({ type: 'group_invite_accept', group_id: groupId }));
    const inviteCard = document.getElementById(`invite-${groupId}`);
    if (inviteCard) inviteCard.remove();
}

// Name Change
document.getElementById('username').onchange = (e) => {
    userName = e.target.value;
    localStorage.setItem('orbit_user_name', userName);
    ws.send(JSON.stringify({ type: 'change_name', name: userName }));
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
    if (!selectedTargetId && !selectedGroupId) return;
    pendingFile = file;

    if (selectedGroupId) {
        ws.send(JSON.stringify({
            type: 'group_transfer_request',
            group_id: selectedGroupId,
            filename: file.name,
            size: file.size
        }));
    } else {
        ws.send(JSON.stringify({
            type: 'transfer_request',
            target_id: selectedTargetId,
            filename: file.name,
            size: file.size
        }));
    }

    showTransferStatus('request', 'waiting', `Asking receivers to accept...`);
}

async function startUpload(transferId) {
    if (!pendingFile) return;

    transferRoles[transferId] = 'sender';
    // Clear the request card
    const requestCard = document.getElementById('transfer-request');
    if (requestCard) requestCard.remove();

    showTransferStatus(transferId, 'uploading', `Sending ${pendingFile.name}...`, 0, pendingFile.size);

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
            const msg = transferRoles[transferId] === 'sender' ? 'File transfer complete' : 'File download complete';
            showTransferStatus(transferId, 'done', msg);
        }
    } catch (err) {
        console.error("Upload failed", err);
        showTransferStatus(transferId, 'error', 'Upload failed');
    }
}

function handleIncomingTransfer(data) {
    // Check if we are a member of this group to auto-accept
    let isGroupMember = false;
    if (data.is_group) {
        // Find group by name (sent as "Group: Name")
        const groupName = data.sender_name.replace("Group: ", "");
        const group = Object.values(groupData).find(g => g.name === groupName);
        if (group && group.members.includes(clientId)) {
            isGroupMember = true;
        }
    }

    if (isGroupMember) {
        console.log("Auto-accepting group transfer...");
        // Use a small delay to ensure UI is ready
        setTimeout(() => {
            triggerDownload(data.transfer_id, data.filename, data.size);
        }, 500);
        return;
    }

    const container = document.getElementById('notifications-container');
    const div = document.createElement('div');
    div.className = 'notification';
    div.innerHTML = `
        <p><strong>${data.sender_name}</strong> wants to send you:</p>
        <p style="font-size: 1.1rem; margin: 10px 0;">${data.filename} (${formatBytes(data.size)})</p>
        <div style="display: flex; gap: 10px; margin-top: 15px;">
            <button class="btn btn-primary" onclick="acceptTransfer('${data.transfer_id}', this, ${data.size})">Accept</button>
            <button class="btn" style="background: var(--danger); color: white;" onclick="this.parentElement.parentElement.remove()">Decline</button>
        </div>
    `;
    container.appendChild(div);
}

function acceptTransfer(transferId, btn, size, filename) {
    btn.parentElement.parentElement.remove(); // Remove notification
    triggerDownload(transferId, filename, size);
}

function triggerDownload(transferId, filename, size) {
    ws.send(JSON.stringify({
        type: 'transfer_accept',
        transfer_id: transferId
    }));

    transferRoles[transferId] = 'receiver';
    showTransferStatus(transferId, 'receiving', `Receiving ${filename}...`, 0, size);

    lastProgress[transferId] = { time: Date.now(), bytes: 0 };

    const a = document.createElement('a');
    a.href = `/download/${transferId}?client_id=${clientId}`;
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
            const role = transferRoles[data.transfer_id];
            const msg = role === 'sender' ? 'File transfer complete' : 'File download complete';
            el.innerHTML = `<p style="color: var(--accent)"><i class="fas fa-check-circle"></i> ${msg}!</p>`;
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
        if (!lastProgress[data.transfer_id]) {
            lastProgress[data.transfer_id] = { time: now, bytes: data.bytes_sent };
        }

        const last = lastProgress[data.transfer_id];
        const deltaBytes = data.bytes_sent - last.bytes;
        const deltaTime = (now - last.time) / 1000;

        if (deltaTime >= 0.5 && deltaBytes > 0) {
            const kbps = (deltaBytes / 1024) / deltaTime;
            rate.innerText = kbps > 1024 ? `${(kbps / 1024).toFixed(2)} MB/s` : `${kbps.toFixed(1)} KB/s`;
            lastProgress[data.transfer_id] = { time: now, bytes: data.bytes_sent };
        }
    }
}

function showTransferStatus(transferId, status, text, progress = null, totalSize = 0) {
    const container = document.getElementById('status-container');
    let card = document.getElementById(`transfer-${transferId}`);

    if (!card) {
        card = document.createElement('div');
        card.id = `transfer-${transferId}`;
        card.className = 'transfer-card';
        container.appendChild(card);
    }

    const displaySize = totalSize > 0 ? `0 / ${formatBytes(totalSize)}` : '0 / 0';

    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start;">
            <p style="font-weight: 600;">${status === 'done' ? 'Success' : 'Transfer Progress'}</p>
            <span id="rate-${transferId}" style="font-size: 0.8rem;">0 KB/s</span>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin: 8px 0;">${text}</p>
        <div class="progress-container"><div class="progress-bar" id="pb-${transferId}" style="width: ${progress || 0}%"></div></div>
        <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-top: 5px;">
            <span id="percent-${transferId}">${progress || 0}%</span>
            <span id="size-${transferId}">${displaySize}</span>
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
