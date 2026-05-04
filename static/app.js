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
let currentlyManagingGroupId = null;
let pendingFiles = new Map(); // Key: transfer_id
let pendingRequestFiles = new Map(); // Key: filename+size (temp)
let incomingTransfers = []; // List of pending incoming transfer objects

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${encodeURIComponent(clientId)}/${encodeURIComponent(userName)}`);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("WS Message:", data);

        if (data.type === 'user_list') {
            updateUserList(data.users);
        } else if (data.type === 'transfer_initiated') {
            const key = data.filename + data.size;
            const file = pendingRequestFiles.get(key);
            const uiId = pendingRequestFiles.get(key + "_ui");
            if (file) {
                pendingFiles.set(data.transfer_id, file);
                if (uiId) pendingFiles.set(data.transfer_id + "_ui", uiId);
                pendingRequestFiles.delete(key);
                pendingRequestFiles.delete(key + "_ui");
            }
        } else if (data.type === 'transfer_approved') {
            const file = pendingFiles.get(data.transfer_id);
            if (file) {
                startUpload(data.transfer_id, file);
                // We keep it in the map until upload starts
            }
        } else if (data.type === 'incoming_transfer') {
            handleIncomingTransfer(data);
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
            <div class="user-avatar">
                <i class="fas fa-laptop"></i>
            </div>
            <div class="user-info">
                <div class="user-name">${user.name}</div>
                <div style="font-size: 0.7rem; color: var(--text-muted);">Available for peer orbit</div>
            </div>
            <i class="fas fa-chevron-right" style="font-size: 0.8rem; opacity: 0.5;"></i>
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
            <div class="user-avatar" style="background: rgba(129, 140, 248, 0.15); color: var(--primary);">
                <i class="fas fa-users-viewfinder"></i>
            </div>
            <div class="user-info">
                <div class="user-name">${group.name}</div>
                <div style="font-size: 0.7rem; color: var(--text-muted);">
                    ${group.members.length} members ${group.pending && group.pending.length > 0 ? `(${group.pending.length} pending)` : ''}
                </div>
            </div>
            <div style="display:flex; gap: 8px;">
                ${isCreator ? '<button onclick="event.stopPropagation(); addMemberPrompt(\'' + group.id + '\')" title="Manage Members" class="btn-icon" style="background:rgba(16, 185, 129, 0.1); color:var(--accent);"><i class="fas fa-cog"></i></button>' : ''}
                ${isCreator ? '<button onclick="event.stopPropagation(); deleteGroup(\'' + group.id + '\')" title="Delete Group" class="btn-icon" style="background:rgba(244, 63, 94, 0.1); color:var(--danger);"><i class="fas fa-trash-alt"></i></button>' : ''}
            </div>
        `;
        li.onclick = (e) => selectGroup(group, e);
        list.appendChild(li);
    });

    // If modal is open for a group that just got updated, refresh the modal content
    if (currentlyManagingGroupId && document.getElementById('member-modal').style.display === 'flex') {
        renderModalContent(currentlyManagingGroupId);
    }
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
    currentlyManagingGroupId = groupId;
    renderModalContent(groupId);
    document.getElementById('member-modal').style.display = 'flex';
}

function renderModalContent(groupId) {
    const list = document.getElementById('modal-user-list');
    list.innerHTML = '';

    const group = groupData[groupId];
    const isCreator = group.creator_id === clientId;
    const currentMembers = new Set(group.members);

    // Helper for labels
    const createLabel = (text) => {
        const h4 = document.createElement('h4');
        h4.style = "font-size: 0.7rem; color: var(--text-muted); margin-bottom: 12px; text-transform: uppercase; font-weight: 800; letter-spacing: 0.05em;";
        h4.innerText = text;
        return h4;
    };

    // Show Current Members section
    list.appendChild(createLabel("Active Orbiters"));

    if (group.members.length === 0) {
        list.innerHTML += '<p style="padding: 12px; color: var(--text-muted); font-size: 0.85rem; background: rgba(255,255,255,0.02); border-radius: 12px; margin-bottom: 20px;">No active members in this orbit.</p>';
    } else {
        const memberList = document.createElement('div');
        memberList.style = "margin-bottom: 24px;";
        group.members.forEach(mid => {
            const user = allUsers.find(u => u.id === mid) || { name: `Orbiter (${mid.substring(0, 4)})`, id: mid };
            const div = document.createElement('div');
            div.className = 'modal-user-item';
            div.style = "display: flex; justify-content: space-between; align-items: center; padding: 12px; background: rgba(255,255,255,0.03); border-radius: 12px; margin-bottom: 8px; border: 1px solid transparent; transition: all 0.2s;";
            div.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 32px; height: 32px; border-radius: 8px; background: var(--primary-glow); display: flex; align-items: center; justify-content: center; color: var(--primary); font-size: 0.8rem;">
                        <i class="fas fa-user-check"></i>
                    </div>
                    <span style="font-weight: 500;">${user.name}</span>
                </div>
                ${isCreator ? `<button class="btn-icon" style="background: rgba(244, 63, 94, 0.1); color: var(--danger);" onclick="removeMember('${groupId}', '${mid}')" title="Remove Member"><i class="fas fa-user-minus"></i></button>` : ''}
            `;
            memberList.appendChild(div);
        });
        list.appendChild(memberList);
    }

    // Show Pending section
    if (group.pending && group.pending.length > 0) {
        list.appendChild(createLabel("Pending Broadcasts"));
        const pendingList = document.createElement('div');
        pendingList.style = "margin-bottom: 24px;";
        group.pending.forEach(mid => {
            const user = allUsers.find(u => u.id === mid) || { name: `Orbiter (${mid.substring(0, 4)})`, id: mid };
            const div = document.createElement('div');
            div.className = 'modal-user-item';
            div.style = "display: flex; justify-content: space-between; align-items: center; padding: 12px; background: rgba(255,255,255,0.02); border-radius: 12px; margin-bottom: 8px; opacity: 0.7;";
            div.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 0.8rem;">
                        <i class="fas fa-satellite-dish"></i>
                    </div>
                    <span style="font-weight: 500;">${user.name}</span>
                </div>
                ${isCreator ? `<button class="btn-icon" style="background: rgba(255,255,255,0.05); color: var(--text-muted);" onclick="removeMember('${groupId}', '${mid}')" title="Cancel Invite"><i class="fas fa-times"></i></button>` : ''}
            `;
            pendingList.appendChild(div);
        });
        list.appendChild(pendingList);
    }

    // Invite section logic
    list.appendChild(createLabel("Invite To Local Orbit"));

    const pendingMembers = new Set(group.pending || []);
    const availableUsers = allUsers.filter(u => u.id !== clientId && !currentMembers.has(u.id) && !pendingMembers.has(u.id));

    if (availableUsers.length === 0) {
        list.innerHTML += '<p style="padding: 12px; color: var(--text-muted); font-size: 0.85rem; background: rgba(255,255,255,0.02); border-radius: 12px;">No other peers online for orbit.</p>';
    } else {
        availableUsers.forEach(user => {
            const div = document.createElement('div');
            div.className = 'modal-user-item';
            div.style = "display: flex; justify-content: space-between; align-items: center; padding: 12px; background: rgba(255,255,255,0.03); border-radius: 12px; margin-bottom: 8px; border: 1px solid transparent; transition: all 0.2s;";
            div.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(129, 140, 248, 0.1); display: flex; align-items: center; justify-content: center; color: var(--primary); font-size: 0.8rem;">
                        <i class="fas fa-plus"></i>
                    </div>
                    <span style="font-weight: 500;">${user.name}</span>
                </div>
                <button class="btn-primary" style="padding: 6px 12px; border-radius: 8px; background: var(--primary); color: white; border: none; cursor: pointer; font-size: 0.75rem; font-weight: 700;" onclick="addMember('${groupId}', '${user.id}')">INVITE</button>
            `;
            list.appendChild(div);
        });
    }
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
    currentlyManagingGroupId = null;
}

function handleGroupInvite(data) {
    console.log("Processing group invite:", data);
    const container = document.getElementById('notifications-container');
    const div = document.createElement('div');
    div.className = 'notification';
    div.id = `invite-${data.group_id}`;
    div.innerHTML = `
        <div class="notification-header">
            <div class="notification-icon">
                <i class="fas fa-envelope-open-text"></i>
            </div>
            <div style="flex: 1;">
                <p class="notification-title">Group Invitation</p>
                <p class="notification-subtitle"><strong>${data.creator_name}</strong> invited you to <strong>${data.group_name}</strong></p>
                <div class="btn-group">
                    <button class="btn-accept" onclick="acceptGroupInvite('${data.group_id}')">Join Group</button>
                    <button class="btn-decline" onclick="this.closest('.notification').remove()"><i class="fas fa-times"></i></button>
                </div>
            </div>
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

dropZone.onclick = () => fileInput.click();

fileInput.onchange = (e) => {
    if (e.target.files.length > 0) {
        const targetId = selectedGroupId ? `group-${selectedGroupId}` : selectedTargetId;
        Array.from(e.target.files).forEach(file => handleFile(targetId, file));
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
        const targetId = selectedGroupId ? `group-${selectedGroupId}` : selectedTargetId;
        Array.from(e.dataTransfer.files).forEach(file => handleFile(targetId, file));
    }
};

function handleFile(targetId, file) {
    if (!targetId) return;
    
    // Store temporarily until we get transfer_initiated with a real transfer_id
    pendingRequestFiles.set(file.name + file.size, file);

    ws.send(JSON.stringify({
        type: 'transfer_request',
        target_id: targetId.startsWith('group-') ? null : targetId,
        group_id: targetId.startsWith('group-') ? targetId.replace('group-', '') : null,
        filename: file.name,
        size: file.size
    }));

    // Generate a temporary ID for the "Waiting" UI card
    const tempId = `wait-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    showTransferStatus(tempId, 'waiting', `Waiting for approval for ${file.name}...`);
    
    // Associate temp UI with this file request
    pendingRequestFiles.set(file.name + file.size + "_ui", tempId);
}

async function startUpload(transferId, file) {
    transferRoles[transferId] = 'sender';
    
    // Remove the waiting/request cards
    const waitId = pendingFiles.get(transferId + "_ui");
    if (waitId) {
        const card = document.getElementById(`transfer-${waitId}`);
        if (card) card.remove();
    }

    showTransferStatus(transferId, 'uploading', `Sending ${file.name}...`, 0, file.size);

    const formData = new FormData();
    // We don't use conventional FormData because we want to stream from the body directly
    // but browser support for fetch streaming body is getting better.
    // However, using a chunked reader with fetch is more reliable.

    try {
        const response = await fetch(`/upload/${transferId}`, {
            method: 'POST',
            body: file, // This streams the file in Fetch API
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
    let isGroupMember = false;
    if (data.is_group) {
        const groupName = data.sender_name.replace("Group: ", "");
        const group = Object.values(groupData).find(g => g.name === groupName);
        if (group && group.members.includes(clientId)) {
            isGroupMember = true;
        }
    }

    if (isGroupMember) {
        setTimeout(() => {
            triggerDownload(data.transfer_id, data.filename, data.size);
        }, 500);
        return;
    }

    incomingTransfers.push(data);
    renderNotifications();
}

function renderNotifications() {
    const container = document.getElementById('notifications-container');
    container.innerHTML = '';
    
    const grouped = incomingTransfers.reduce((acc, t) => {
        if (!acc[t.sender_name]) acc[t.sender_name] = [];
        acc[t.sender_name].push(t);
        return acc;
    }, {});

    Object.entries(grouped).forEach(([senderName, transfers]) => {
        const div = document.createElement('div');
        div.className = 'notification';
        
        if (transfers.length > 1) {
            const totalSize = transfers.reduce((s, t) => s + t.size, 0);
            div.innerHTML = `
                <div class="notification-header">
                    <div class="notification-icon">
                        <i class="fas fa-boxes"></i>
                    </div>
                    <div style="flex: 1; overflow: hidden;">
                        <p class="notification-title">Batch Orbit Request</p>
                        <p class="notification-subtitle"><strong>${senderName}</strong> is sending <strong>${transfers.length} files</strong> (${formatBytes(totalSize)})</p>
                        
                        <div class="file-list-compact">
                            ${transfers.map(t => `
                                <div class="file-item-compact">
                                    <div class="file-name-compact" title="${t.filename}">
                                        ${t.filename}
                                    </div>
                                    <div style="display: flex; align-items: center; gap: 8px;">
                                        <span style="opacity: 0.5; font-size: 0.7rem;">${formatBytes(t.size)}</span>
                                        <button class="btn-icon" style="width: 24px; height: 24px; font-size: 0.7rem; background: rgba(129, 140, 248, 0.1); color: var(--primary);" 
                                                onclick="acceptTransfer('${t.transfer_id}', '${t.filename}', ${t.size})" title="Accept this file">
                                            <i class="fas fa-check"></i>
                                        </button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                        
                        <div class="btn-group">
                            <button class="btn-accept" onclick="acceptAllFromSender('${senderName}')">Accept All</button>
                            <button class="btn-decline" onclick="declineAllFromSender('${senderName}')"><i class="fas fa-times"></i></button>
                        </div>
                    </div>
                </div>
            `;
        } else {
            const t = transfers[0];
            div.innerHTML = `
                <div class="notification-header">
                    <div class="notification-icon">
                        <i class="fas fa-file-export"></i>
                    </div>
                    <div style="flex: 1; overflow: hidden;">
                        <p class="notification-title">Incoming Orbit</p>
                        <p class="notification-subtitle"><strong>${senderName}</strong> wants to send:</p>
                        <p style="font-weight: 600; margin: 8px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${t.filename}</p>
                        <p style="font-size: 0.75rem; color: var(--text-muted);">${formatBytes(t.size)}</p>
                        
                        <div class="btn-group">
                            <button class="btn-accept" onclick="acceptTransfer('${t.transfer_id}', '${t.filename}', ${t.size})">Accept</button>
                            <button class="btn-decline" onclick="declineTransfer('${t.transfer_id}')"><i class="fas fa-times"></i></button>
                        </div>
                    </div>
                </div>
            `;
        }
        container.appendChild(div);
    });
}

function acceptTransfer(transferId, filename, size) {
    incomingTransfers = incomingTransfers.filter(t => t.transfer_id !== transferId);
    renderNotifications();
    triggerDownload(transferId, filename, size);
}

function declineTransfer(transferId) {
    incomingTransfers = incomingTransfers.filter(t => t.transfer_id !== transferId);
    renderNotifications();
}

function acceptAllFromSender(senderName) {
    const toAccept = incomingTransfers.filter(t => t.sender_name === senderName);
    incomingTransfers = incomingTransfers.filter(t => t.sender_name !== senderName);
    renderNotifications();
    
    // Staggered trigger to ensure clean browser behavior
    toAccept.forEach((t, i) => {
        setTimeout(() => triggerDownload(t.transfer_id, t.filename, t.size), i * 300);
    });
}

function declineAllFromSender(senderName) {
    incomingTransfers = incomingTransfers.filter(t => t.sender_name !== senderName);
    renderNotifications();
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
        const role = transferRoles[data.transfer_id];
        const msg = role === 'sender' ? 'File transfer complete' : 'File download complete';
        showTransferStatus(data.transfer_id, 'done', msg, 100, data.total_size);
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
    const isDone = status === 'done';

    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <div style="width: 8px; height: 8px; border-radius: 50%; background: ${isDone ? 'var(--accent)' : 'var(--primary)'}; border-glow: 0 0 8px ${isDone ? 'var(--accent)' : 'var(--primary)'}"></div>
                <p style="font-weight: 700; font-size: 0.9rem; letter-spacing: 0.02em;">${isDone ? 'COMPLETED' : 'ORBITING'}</p>
            </div>
            <span id="rate-${transferId}" style="font-size: 0.75rem; font-weight: 600; color: var(--primary);">${isDone ? '' : '0 KB/s'}</span>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-main); margin-bottom: 12px; font-weight: 500;">${text}</p>
        <div class="progress-container">
            <div class="progress-bar" id="pb-${transferId}" style="width: ${progress || 0}%"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: var(--text-muted); margin-top: 8px; font-weight: 600;">
            <span id="percent-${transferId}">${progress || 0}%</span>
            <span id="size-${transferId}">${displaySize}</span>
        </div>
    `;

    if (isDone) {
        card.style.borderColor = 'var(--accent)';
        card.style.boxShadow = '0 10px 30px rgba(16, 185, 129, 0.2)';
        setTimeout(() => {
            card.style.transition = 'all 0.5s ease-out';
            card.style.opacity = '0';
            card.style.transform = 'translateX(50px)';
            setTimeout(() => card.remove(), 500);
        }, 4000);
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
