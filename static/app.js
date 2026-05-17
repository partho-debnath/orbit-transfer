// ── Identity ──────────────────────────────────────────────────────────────────
const clientId = localStorage.getItem('orbit_client_id') || Math.random().toString(36).substring(2, 11);
localStorage.setItem('orbit_client_id', clientId);

let userName = localStorage.getItem('orbit_user_name') || `User_${Math.floor(Math.random() * 1000)}`;
document.getElementById('username').value = userName;

// ── State ─────────────────────────────────────────────────────────────────────
let selectedTargetId = null;
let selectedGroupId  = null;
let ws               = null;
let groupData        = {};
let allUsers         = [];
let currentlyManagingGroupId = null;
let incomingTransfers = [];
let confirmationResolver = null;

let pendingRequestFiles = new Map(); // filename+size → File
let pendingFiles        = new Map(); // transfer_id → File (+ _ui key)

// ── WebRTC Config ─────────────────────────────────────────────────────────────
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
];
const CHUNK_SIZE       = 16 * 1024;      // 16 KB — reliable across all browsers
const BUFFER_HIGH      = 4 * 1024 * 1024; // 4 MB — pause sending
const BUFFER_LOW       = 512 * 1024;      // 512 KB — resume sending
const STALL_TIMEOUT_MS = 20_000;          // 20 s with no new bytes = stall

const peerConnections      = {}; // pcKey → RTCPeerConnection
const pendingIceCandidates = {}; // pcKey → [RTCIceCandidateInit]
const receiveState         = {}; // pcKey → { meta, chunks, bytesReceived, stallTimer }
let   lastProgress         = {}; // transferId → { time, bytes }
let   wakeLock             = null;
const isMobile             = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

function makePcKey(transferId, peerId) { return `${transferId}__${peerId}`; }

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${encodeURIComponent(clientId)}/${encodeURIComponent(userName)}`);

    // One-time warning for mobile on HTTP (only shown once per session)
    if (window.location.protocol === 'http:' && isMobile && window.location.hostname !== 'localhost'
        && !sessionStorage.getItem('orbit_http_warned')) {
        sessionStorage.setItem('orbit_http_warned', '1');
        setTimeout(() => {
            showTransferError('⚠️ Mobile on HTTP', 'File transfer may fail. Open the app over HTTPS for best results on mobile.');
        }, 1200);
    }

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'user_list') {
            updateUserList(data.users);

        } else if (data.type === 'transfer_initiated') {
            const key  = data.filename + data.size;
            const file = pendingRequestFiles.get(key);
            const uiId = pendingRequestFiles.get(key + '_ui');
            if (file) {
                pendingFiles.set(data.transfer_id, file);
                if (uiId) pendingFiles.set(data.transfer_id + '_ui', uiId);
                pendingRequestFiles.delete(key);
                pendingRequestFiles.delete(key + '_ui');
            }

        } else if (data.type === 'transfer_approved') {
            const file = pendingFiles.get(data.transfer_id);
            if (file) {
                const waitId = pendingFiles.get(data.transfer_id + '_ui');
                if (waitId) { const c = document.getElementById(`transfer-${waitId}`); if (c) c.remove(); }
                initiateWebRTCTransfer(data.transfer_id, data.receiver_id, file);
            }

        } else if (data.type === 'transfer_declined') {
            const waitId = pendingFiles.get(data.transfer_id + '_ui');
            if (waitId) { const c = document.getElementById(`transfer-${waitId}`); if (c) c.remove(); }
            showTransferError('Transfer Declined', 'The receiver declined the file.');

        } else if (data.type === 'transfer_error') {
            showTransferError(data.filename, data.reason);

        } else if (data.type === 'incoming_transfer') {
            handleIncomingTransfer(data);

        } else if (data.type === 'group_list') {
            updateGroupList(data.groups);

        } else if (data.type === 'group_invite') {
            handleGroupInvite(data);

        } else if (data.type === 'webrtc_offer') {
            handleWebRTCOffer(data);

        } else if (data.type === 'webrtc_answer') {
            handleWebRTCAnswer(data);

        } else if (data.type === 'webrtc_ice_candidate') {
            handleWebRTCIceCandidate(data);
        }
    };

    ws.onclose = () => setTimeout(connect, 2000);
}

// ── WebRTC Sender ─────────────────────────────────────────────────────────────
async function initiateWebRTCTransfer(transferId, receiverId, file) {
    const pcKey = makePcKey(transferId, receiverId);
    const pc    = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections[pcKey] = pc;

    const dc = pc.createDataChannel('orbit', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW; // fires onbufferedamountlow

    dc.onopen = async () => {
        showTransferStatus(transferId, 'uploading', `Sending ${file.name}...`, 0, file.size);
        try {
            await sendFileViaDataChannel(dc, file, transferId);
        } catch (err) {
            console.error('[DC] send error', err);
            showTransferStatus(transferId, 'error', `Send failed: ${file.name}`);
        } finally {
            closePeerConnection(pcKey);
        }
    };

    dc.onerror = () => {
        showTransferStatus(transferId, 'error', `Send failed: ${file.name}`);
        closePeerConnection(pcKey);
    };

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({
            type: 'webrtc_ice_candidate', transfer_id: transferId,
            target_id: receiverId, candidate: candidate.toJSON()
        }));
    };

    // Recover from mid-transfer ICE drops
    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === 'failed') {
            try { pc.restartIce(); } catch (_) {}
            setTimeout(() => {
                if (pc.iceConnectionState === 'failed') {
                    showTransferStatus(transferId, 'error', `Connection lost: ${file.name}`);
                    closePeerConnection(pcKey);
                    releaseWakeLock();
                }
            }, 5000);
        } else if (s === 'disconnected') {
            setTimeout(() => {
                if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                    showTransferStatus(transferId, 'error', `Connection lost: ${file.name}`);
                    closePeerConnection(pcKey);
                }
            }, 8000);
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    requestWakeLock();
    showTransferStatus(transferId, 'receiving', `Negotiating orbit...`, 0, file.size);
    ws.send(JSON.stringify({
        type: 'webrtc_offer', transfer_id: transferId, target_id: receiverId,
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
    }));
}

async function sendFileViaDataChannel(dc, file, transferId) {
    dc.send(JSON.stringify({ type: 'file_meta', filename: file.name, size: file.size }));
    lastProgress[transferId] = { time: Date.now(), bytes: 0 };

    let bytesSent     = 0;
    let paused        = false;
    let resumeResolve = null;

    // Event-driven resume: fires when bufferedAmount drops below BUFFER_LOW
    dc.onbufferedamountlow = () => {
        if (paused && resumeResolve) {
            paused = false;
            const r = resumeResolve; resumeResolve = null; r();
        }
    };

    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        if (dc.readyState !== 'open') throw new Error('DataChannel closed');

        // Pause sending if the send buffer is too full (event-driven, no polling)
        if (dc.bufferedAmount > BUFFER_HIGH) {
            paused = true;
            await new Promise(res => { resumeResolve = res; });
        }

        if (dc.readyState !== 'open') throw new Error('DataChannel closed');

        const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        dc.send(chunk);
        bytesSent += chunk.byteLength;
        updateTransferProgress(transferId, bytesSent, file.size);
    }

    // Wait for the send buffer to fully drain before signalling done
    if (dc.bufferedAmount > 0) {
        await new Promise(res => {
            const timer = setInterval(() => {
                if (dc.bufferedAmount === 0 || dc.readyState !== 'open') {
                    clearInterval(timer); res();
                }
            }, 50);
        });
    }

    if (dc.readyState === 'open') dc.send(JSON.stringify({ type: 'file_done' }));
    showTransferStatus(transferId, 'done', `Sent ${file.name}`, 100, file.size);
    releaseWakeLock();
}

// ── WebRTC Receiver ───────────────────────────────────────────────────────────
async function handleWebRTCOffer(data) {
    const { transfer_id, sender_id, sdp } = data;
    const pcKey = makePcKey(transfer_id, sender_id);
    const pc    = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections[pcKey] = pc;

    requestWakeLock();
    showTransferStatus(transfer_id, 'receiving', 'Establishing orbit...', 0);

    pc.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = 'arraybuffer';
        setupReceiveDataChannel(dc, transfer_id, sender_id);
    };

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({
            type: 'webrtc_ice_candidate', transfer_id: transfer_id,
            target_id: sender_id, candidate: candidate.toJSON()
        }));
    };

    // Recover on receiver side too
    pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === 'failed') {
            try { pc.restartIce(); } catch (_) {}
            setTimeout(() => {
                if (pc.iceConnectionState === 'failed') {
                    const st = receiveState[pcKey];
                    const name = st?.meta?.filename || 'file';
                    clearTimeout(st?.stallTimer);
                    showTransferStatus(transfer_id, 'error', `Connection lost: ${name}`);
                    delete receiveState[pcKey];
                    closePeerConnection(pcKey);
                }
            }, 5000);
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    // Flush candidates that arrived before setRemoteDescription
    for (const c of (pendingIceCandidates[pcKey] || []))
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    delete pendingIceCandidates[pcKey];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({
        type: 'webrtc_answer', transfer_id: transfer_id, target_id: sender_id,
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
    }));
}

async function handleWebRTCAnswer(data) {
    const { transfer_id, sender_id, sdp } = data;
    const pcKey = makePcKey(transfer_id, sender_id);
    const pc    = peerConnections[pcKey];
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    for (const c of (pendingIceCandidates[pcKey] || []))
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    delete pendingIceCandidates[pcKey];
}

async function handleWebRTCIceCandidate(data) {
    const { transfer_id, sender_id, candidate } = data;
    const pcKey = makePcKey(transfer_id, sender_id);
    const pc    = peerConnections[pcKey];
    if (!pc || !pc.remoteDescription) {
        // Queue until remote description is ready
        (pendingIceCandidates[pcKey] = pendingIceCandidates[pcKey] || []).push(candidate);
        return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
}

function setupReceiveDataChannel(dc, transferId, senderId) {
    const pcKey = makePcKey(transferId, senderId);
    receiveState[pcKey] = { chunks: [], bytesReceived: 0, meta: null, stallTimer: null };

    // Restart the stall watchdog on every received message
    function resetStallTimer() {
        const st = receiveState[pcKey];
        if (!st) return;
        clearTimeout(st.stallTimer);
        st.stallTimer = setTimeout(() => {
            const name = receiveState[pcKey]?.meta?.filename || 'file';
            showTransferStatus(transferId, 'error', `Transfer stalled: ${name}`);
            delete receiveState[pcKey];
            closePeerConnection(pcKey);
        }, STALL_TIMEOUT_MS);
    }
    resetStallTimer(); // arm it immediately

    dc.onmessage = (event) => {
        const state = receiveState[pcKey];
        if (!state) return;
        resetStallTimer(); // heartbeat — any message resets the watchdog

        if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);

            if (msg.type === 'file_meta') {
                state.meta          = msg;
                state.chunks        = [];
                state.bytesReceived = 0;
                lastProgress[transferId] = { time: Date.now(), bytes: 0 };
                showTransferStatus(transferId, 'receiving', `Receiving ${msg.filename}...`, 0, msg.size);

            } else if (msg.type === 'file_done') {
                clearTimeout(state.stallTimer);
                const blob = new Blob(state.chunks, { type: 'application/octet-stream' });
                const url  = URL.createObjectURL(blob);

                if (!isMobile) {
                    // Desktop: auto-download via a hidden link in a new tab (safe, won't navigate away)
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = state.meta.filename;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    document.body.appendChild(a);
                    try { a.click(); } catch(e) { console.warn('Auto-download blocked', e); }
                    document.body.removeChild(a);
                }
                // Mobile: NEVER auto-click — it navigates the tab away from the app.
                // User must tap the "Save to Device" button that appears below.

                showTransferStatus(transferId, 'done', `Received ${state.meta.filename}`, 100, state.meta.size, url, state.meta.filename);
                releaseWakeLock();
                delete receiveState[pcKey];
                closePeerConnection(pcKey);
            }

        } else {
            // Binary chunk
            state.chunks.push(event.data);
            state.bytesReceived += event.data.byteLength;
            if (!state.meta) return;
            updateTransferProgress(transferId, state.bytesReceived, state.meta.size);
        }
    };

    dc.onclose = () => {
        const st = receiveState[pcKey];
        if (st) clearTimeout(st.stallTimer);
        delete receiveState[pcKey];
        closePeerConnection(pcKey);
    };

    dc.onerror = () => {
        const st = receiveState[pcKey];
        if (st) {
            clearTimeout(st.stallTimer);
            showTransferStatus(transferId, 'error', `Receive error: ${st.meta?.filename || 'file'}`);
        }
        delete receiveState[pcKey];
        closePeerConnection(pcKey);
        releaseWakeLock();
    };
}

function closePeerConnection(pcKey) {
    const pc = peerConnections[pcKey];
    if (pc) { try { pc.close(); } catch (_) {} delete peerConnections[pcKey]; }
    delete pendingIceCandidates[pcKey];
}

// Shared progress updater for both sender and receiver
function updateTransferProgress(transferId, bytesDone, total) {
    const progress = Math.round((bytesDone / total) * 100);
    const pb     = document.getElementById(`pb-${transferId}`);
    const pct    = document.getElementById(`percent-${transferId}`);
    const sizeEl = document.getElementById(`size-${transferId}`);
    const rateEl = document.getElementById(`rate-${transferId}`);
    if (!pb) return;
    pb.style.width = `${progress}%`;
    if (pct)    pct.innerText    = `${progress}%`;
    if (sizeEl) sizeEl.innerText = `${formatBytes(bytesDone)} / ${formatBytes(total)}`;
    const now  = Date.now();
    const last = lastProgress[transferId];
    if (last) {
        const dt = (now - last.time) / 1000;
        const db = bytesDone - last.bytes;
        if (dt >= 0.3 && db > 0) {
            const kbps = (db / 1024) / dt;
            if (rateEl) rateEl.innerText = kbps > 1024 ? `${(kbps/1024).toFixed(2)} MB/s` : `${kbps.toFixed(1)} KB/s`;
            lastProgress[transferId] = { time: now, bytes: bytesDone };
        }
    }
}

// ── Incoming Transfer Handling ────────────────────────────────────────────────
function handleIncomingTransfer(data) {
    if (data.is_group) {
        ws.send(JSON.stringify({ type: 'transfer_accept', transfer_id: data.transfer_id }));
        showTransferStatus(data.transfer_id, 'receiving', `Receiving ${data.filename}...`, 0, data.size);
        return;
    }
    incomingTransfers.push(data);
    renderNotifications();
}

function acceptTransfer(transferId, filename, size) {
    incomingTransfers = incomingTransfers.filter(t => t.transfer_id !== transferId);
    renderNotifications();
    ws.send(JSON.stringify({ type: 'transfer_accept', transfer_id: transferId }));
    showTransferStatus(transferId, 'receiving', `Waiting for ${filename}...`, 0, size);
}

function declineTransfer(transferId) {
    incomingTransfers = incomingTransfers.filter(t => t.transfer_id !== transferId);
    renderNotifications();
    ws.send(JSON.stringify({ type: 'transfer_decline', transfer_id: transferId }));
}

function acceptAllFromSender(senderName) {
    const toAccept = incomingTransfers.filter(t => t.sender_name === senderName);
    incomingTransfers = incomingTransfers.filter(t => t.sender_name !== senderName);
    renderNotifications();
    toAccept.forEach(t => acceptTransfer(t.transfer_id, t.filename, t.size));
}

function declineAllFromSender(senderName) {
    const toDecline = incomingTransfers.filter(t => t.sender_name === senderName);
    incomingTransfers = incomingTransfers.filter(t => t.sender_name !== senderName);
    renderNotifications();
    toDecline.forEach(t => ws.send(JSON.stringify({ type: 'transfer_decline', transfer_id: t.transfer_id })));
}

// ── File Drop / Select ────────────────────────────────────────────────────────
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.onclick  = () => fileInput.click();
fileInput.onchange = (e) => {
    if (e.target.files.length > 0) {
        const targetId = selectedGroupId ? `group-${selectedGroupId}` : selectedTargetId;
        Array.from(e.target.files).forEach(f => handleFile(targetId, f));
        e.target.value = '';
    }
};
dropZone.ondragover  = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
dropZone.ondragleave = ()  => dropZone.classList.remove('dragover');
dropZone.ondrop = (e) => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        const targetId = selectedGroupId ? `group-${selectedGroupId}` : selectedTargetId;
        Array.from(e.dataTransfer.files).forEach(f => handleFile(targetId, f));
    }
};

function handleFile(targetId, file) {
    if (!targetId) return;
    const key = file.name + file.size;
    pendingRequestFiles.set(key, file);
    ws.send(JSON.stringify({
        type: 'transfer_request',
        target_id: targetId.startsWith('group-') ? null : targetId,
        group_id:  targetId.startsWith('group-') ? targetId.replace('group-', '') : null,
        filename: file.name, size: file.size
    }));
    const tempId = `wait-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    showTransferStatus(tempId, 'waiting', `Waiting for approval: ${file.name}...`);
    pendingRequestFiles.set(key + '_ui', tempId);
}

// ── User List UI ──────────────────────────────────────────────────────────────
function updateUserList(users) {
    allUsers = users;
    const list = document.getElementById('user-list');
    list.innerHTML = '';
    users.filter(u => u.id !== clientId).forEach(user => {
        const li = document.createElement('li');
        li.className = `user-item ${selectedTargetId === user.id ? 'active' : ''}`;
        li.innerHTML = `
            <div class="user-avatar"><i class="fas fa-laptop"></i></div>
            <div class="user-info">
                <div class="user-name">${user.name}</div>
                <div style="font-size:0.7rem;color:var(--text-muted);">Available for peer orbit</div>
            </div>
            <i class="fas fa-chevron-right" style="font-size:0.8rem;opacity:0.5;"></i>
        `;
        li.onclick = () => selectUser(user);
        list.appendChild(li);
    });
}

function selectUser(user) {
    selectedTargetId = user.id; selectedGroupId = null;
    document.getElementById('target-name').innerText = user.name;
    document.getElementById('no-target').style.display    = 'none';
    document.getElementById('transfer-zone').style.display = 'flex';
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    event.currentTarget.classList.add('active');
}

// ── Group Icon Helpers ───────────────────────────────────────────────────────
const GROUP_ICONS = [
    { icon: 'fa-rocket',          bg: 'rgba(129,140,248,0.22)', color: '#818cf8' },
    { icon: 'fa-user-astronaut',  bg: 'rgba(34,211,238,0.22)',  color: '#22d3ee' },
    { icon: 'fa-satellite',       bg: 'rgba(167,139,250,0.22)', color: '#a78bfa' },
    { icon: 'fa-meteor',          bg: 'rgba(251,146,60,0.22)',  color: '#fb923c' },
    { icon: 'fa-shuttle-space',    bg: 'rgba(99,102,241,0.22)',  color: '#818cf8' },
    { icon: 'fa-earth-americas',  bg: 'rgba(34,197,94,0.22)',   color: '#22c55e' },
    { icon: 'fa-moon',            bg: 'rgba(226,232,240,0.2)',  color: '#f8fafc' },
    { icon: 'fa-star',            bg: 'rgba(250,204,21,0.22)',  color: '#facc15' },
    { icon: 'fa-satellite-dish',  bg: 'rgba(14,165,233,0.22)',  color: '#0ea5e9' },
    { icon: 'fa-atom',            bg: 'rgba(244,114,182,0.22)', color: '#f472b6' },
    { icon: 'fa-sun',             bg: 'rgba(249,115,22,0.22)',  color: '#f97316' },
    { icon: 'fa-hand-spock',      bg: 'rgba(52,211,153,0.22)',  color: '#34d399' },
    { icon: 'fa-circle-nodes',    bg: 'rgba(129,140,248,0.22)', color: '#818cf8' },
    { icon: 'fa-user-secret',     bg: 'rgba(71,85,105,0.25)',  color: '#94a3b8' }, 
    { icon: 'fa-bolt-lightning',  bg: 'rgba(253,224,71,0.22)',  color: '#fde047' }, 
    { icon: 'fa-burst',           bg: 'rgba(239,68,68,0.22)',   color: '#ef4444' }, 
];

function getGroupVisual(groupId) {
    // Hash the group ID to a stable index so the same group always gets the same icon
    let hash = 0;
    for (let i = 0; i < groupId.length; i++) {
        hash = (hash * 31 + groupId.charCodeAt(i)) >>> 0;
    }
    return GROUP_ICONS[hash % GROUP_ICONS.length];
}

// ── Group List UI ─────────────────────────────────────────────────────────────
function updateGroupList(groups) {
    const list = document.getElementById('group-list');
    list.innerHTML = '';
    groups.forEach(group => {
        groupData[group.id] = group;
        const li = document.createElement('li');
        li.className = `user-item ${selectedGroupId === group.id ? 'active' : ''}`;
        const isCreator = group.creator_id === clientId;
        const gv = getGroupVisual(group.id);
        li.innerHTML = `
            <div class="user-avatar" style="background:${gv.bg};color:${gv.color};box-shadow:0 0 15px ${gv.color}33;">
                <i class="fa-solid ${gv.icon}"></i>
            </div>
            <div class="user-info">
                <div class="user-name">${group.name}</div>
                <div style="font-size:0.7rem;color:var(--text-muted);">
                    ${group.members.length} members ${group.pending && group.pending.length > 0 ? `(${group.pending.length} pending)` : ''}
                </div>
            </div>
            <div style="display:flex;gap:8px;">
                ${isCreator ? `<button onclick="event.stopPropagation();addMemberPrompt('${group.id}')" title="Manage Members" class="btn-icon" style="background:rgba(16,185,129,0.1);color:var(--accent);"><i class="fas fa-cog"></i></button>` : ''}
                ${isCreator ? `<button onclick="event.stopPropagation();deleteGroup('${group.id}')" title="Delete Group" class="btn-icon" style="background:rgba(244,63,94,0.1);color:var(--danger);"><i class="fas fa-trash-alt"></i></button>` : ''}
            </div>
        `;
        li.onclick = (e) => selectGroup(group, e);
        list.appendChild(li);
    });
    if (currentlyManagingGroupId && document.getElementById('member-modal').style.display === 'flex')
        renderModalContent(currentlyManagingGroupId);
}

function selectGroup(group, event) {
    selectedGroupId = group.id; selectedTargetId = null;
    document.getElementById('target-name').innerText = `Group: ${group.name}`;
    document.getElementById('no-target').style.display    = 'none';
    document.getElementById('transfer-zone').style.display = 'flex';
    document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    if (event) event.currentTarget.classList.add('active');
}

// ── Group Modals ──────────────────────────────────────────────────────────────
document.getElementById('btn-create-group').onclick = () => openCreateGroupModal();

function openCreateGroupModal() {
    const modal = document.getElementById('create-group-modal');
    const input = document.getElementById('group-name-input');
    input.value = ''; modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('show'));
    setTimeout(() => input.focus(), 50);
}
function closeCreateGroupModal() {
    const modal = document.getElementById('create-group-modal');
    modal.classList.remove('show');
    setTimeout(() => { if (!modal.classList.contains('show')) modal.style.display = 'none'; }, 260);
}
function submitCreateGroup() {
    const input = document.getElementById('group-name-input');
    const name  = input.value.trim();
    if (!name) { input.focus(); return; }
    ws.send(JSON.stringify({ type: 'create_group', name }));
    closeCreateGroupModal();
}
function openConfirmationModal({ title='Confirm Action', message='Are you sure?', confirmText='Confirm', danger=false } = {}) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').innerText   = title;
    document.getElementById('confirm-modal-message').innerText = message;
    const btn = document.getElementById('confirm-modal-confirm');
    btn.innerText = confirmText;
    btn.classList.toggle('btn-danger-solid', Boolean(danger));
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('show'));
    return new Promise(resolve => { confirmationResolver = resolve; });
}
function closeConfirmationModal(confirmed = false) {
    const modal = document.getElementById('confirm-modal');
    modal.classList.remove('show');
    setTimeout(() => { if (!modal.classList.contains('show')) modal.style.display = 'none'; }, 260);
    if (confirmationResolver) { const r = confirmationResolver; confirmationResolver = null; r(confirmed); }
}

document.getElementById('group-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitCreateGroup(); } });
document.getElementById('create-group-modal').addEventListener('click', e => { if (e.target.id === 'create-group-modal') closeCreateGroupModal(); });
document.getElementById('member-modal').addEventListener('click', e => { if (e.target.id === 'member-modal') hideModal(); });
document.getElementById('confirm-modal').addEventListener('click', e => { if (e.target.id === 'confirm-modal') closeConfirmationModal(false); });
document.getElementById('confirm-modal-close').addEventListener('click', () => closeConfirmationModal(false));
document.getElementById('confirm-modal-cancel').addEventListener('click', () => closeConfirmationModal(false));
document.getElementById('confirm-modal-confirm').addEventListener('click', () => closeConfirmationModal(true));

document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('confirm-modal').style.display === 'flex') closeConfirmationModal(false);
    else if (document.getElementById('create-group-modal').style.display === 'flex') closeCreateGroupModal();
    else if (document.getElementById('member-modal').style.display === 'flex') hideModal();
});

async function deleteGroup(groupId) {
    const confirmed = await openConfirmationModal({
        title: 'Delete Orbit Group?', message: 'This will permanently delete this group for everyone in it.',
        confirmText: 'Delete Group', danger: true
    });
    if (!confirmed) return;
    ws.send(JSON.stringify({ type: 'delete_group', group_id: groupId }));
    if (selectedGroupId === groupId) {
        selectedGroupId = null;
        document.getElementById('no-target').style.display    = 'flex';
        document.getElementById('transfer-zone').style.display = 'none';
    }
}
async function confirmMemberRemoval() {
    return openConfirmationModal({ title:'Remove Member?', message:'This member will be removed from the group immediately.', confirmText:'Remove Member', danger:true });
}
function actionForRowMarkup(isCreator, groupId, mid, isPending=false) {
    if (!isCreator) return '';
    const safeG = String(groupId).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const safeM = String(mid).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const tint  = isPending ? 'background:rgba(255,255,255,0.05);color:var(--text-muted);' : 'background:rgba(244,63,94,0.1);color:var(--danger);';
    const title = isPending ? 'Cancel Invite' : 'Remove Member';
    const icon  = isPending ? 'fas fa-times'  : 'fas fa-user-minus';
    return `<button class="btn-icon" style="${tint}" onclick="removeMember('${safeG}','${safeM}')" title="${title}"><i class="${icon}"></i></button>`;
}
function addMemberPrompt(groupId) {
    currentlyManagingGroupId = groupId; renderModalContent(groupId);
    const modal = document.getElementById('member-modal');
    modal.style.display = 'flex'; requestAnimationFrame(() => modal.classList.add('show'));
}
function renderModalContent(groupId) {
    const list  = document.getElementById('modal-user-list');
    list.innerHTML = '';
    const group = groupData[groupId]; const isCreator = group.creator_id === clientId;
    const currentMembers = new Set(group.members);
    const createLabel = text => {
        const h4 = document.createElement('h4');
        h4.style = 'font-size:0.7rem;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;font-weight:800;letter-spacing:0.05em;';
        h4.innerText = text; return h4;
    };
    list.appendChild(createLabel('Active Orbiters'));
    if (group.members.length === 0) {
        list.innerHTML += '<p style="padding:12px;color:var(--text-muted);font-size:0.85rem;background:rgba(255,255,255,0.02);border-radius:12px;margin-bottom:20px;">No active members in this orbit.</p>';
    } else {
        const memberList = document.createElement('div'); memberList.style = 'margin-bottom:24px;';
        group.members.forEach(mid => {
            const user = allUsers.find(u => u.id === mid) || { name:`Orbiter (${mid.substring(0,4)})`, id:mid };
            const div = document.createElement('div'); div.className = 'modal-user-item';
            div.style = 'display:flex;justify-content:space-between;align-items:center;padding:12px;background:rgba(255,255,255,0.03);border-radius:12px;margin-bottom:8px;border:1px solid transparent;transition:all 0.2s;';
            div.innerHTML = `<div style="display:flex;align-items:center;gap:10px;"><div style="width:32px;height:32px;border-radius:8px;background:var(--primary-glow);display:flex;align-items:center;justify-content:center;color:var(--primary);font-size:0.8rem;"><i class="fas fa-user-check"></i></div><span style="font-weight:500;">${user.name}</span></div>${actionForRowMarkup(isCreator,groupId,mid,false)}`;
            memberList.appendChild(div);
        });
        list.appendChild(memberList);
    }
    if (group.pending && group.pending.length > 0) {
        list.appendChild(createLabel('Pending Broadcasts'));
        const pendingList = document.createElement('div'); pendingList.style = 'margin-bottom:24px;';
        group.pending.forEach(mid => {
            const user = allUsers.find(u => u.id === mid) || { name:`Orbiter (${mid.substring(0,4)})`, id:mid };
            const div = document.createElement('div'); div.className = 'modal-user-item';
            div.style = 'display:flex;justify-content:space-between;align-items:center;padding:12px;background:rgba(255,255,255,0.02);border-radius:12px;margin-bottom:8px;opacity:0.7;';
            div.innerHTML = `<div style="display:flex;align-items:center;gap:10px;"><div style="width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:0.8rem;"><i class="fas fa-satellite-dish"></i></div><span style="font-weight:500;">${user.name}</span></div>${actionForRowMarkup(isCreator,groupId,mid,true)}`;
            pendingList.appendChild(div);
        });
        list.appendChild(pendingList);
    }
    list.appendChild(createLabel('Invite To Local Orbit'));
    const pendingSet   = new Set(group.pending || []);
    const available    = allUsers.filter(u => u.id !== clientId && !currentMembers.has(u.id) && !pendingSet.has(u.id));
    if (available.length === 0) {
        list.innerHTML += '<p style="padding:12px;color:var(--text-muted);font-size:0.85rem;background:rgba(255,255,255,0.02);border-radius:12px;">No other peers online for orbit.</p>';
    } else {
        available.forEach(user => {
            const div = document.createElement('div'); div.className = 'modal-user-item';
            div.style = 'display:flex;justify-content:space-between;align-items:center;padding:12px;background:rgba(255,255,255,0.03);border-radius:12px;margin-bottom:8px;border:1px solid transparent;transition:all 0.2s;';
            div.innerHTML = `<div style="display:flex;align-items:center;gap:10px;"><div style="width:32px;height:32px;border-radius:8px;background:rgba(129,140,248,0.1);display:flex;align-items:center;justify-content:center;color:var(--primary);font-size:0.8rem;"><i class="fas fa-plus"></i></div><span style="font-weight:500;">${user.name}</span></div><button class="btn-primary" style="padding:6px 12px;border-radius:8px;background:var(--primary);color:white;border:none;cursor:pointer;font-size:0.75rem;font-weight:700;" onclick="addMember('${groupId}','${user.id}')">INVITE</button>`;
            list.appendChild(div);
        });
    }
}
function addMember(groupId, memberId) { ws.send(JSON.stringify({ type:'add_member', group_id:groupId, member_id:memberId })); }
async function removeMember(groupId, memberId) {
    if (!(await confirmMemberRemoval())) return;
    ws.send(JSON.stringify({ type:'remove_member', group_id:groupId, member_id:memberId }));
}
function hideModal() {
    const modal = document.getElementById('member-modal');
    modal.classList.remove('show');
    setTimeout(() => { if (!modal.classList.contains('show')) modal.style.display = 'none'; }, 260);
    currentlyManagingGroupId = null;
}

// ── Invite notification ───────────────────────────────────────────────────────
function handleGroupInvite(data) {
    const container = document.getElementById('notifications-container');
    const div = document.createElement('div'); div.className = 'notification'; div.id = `invite-${data.group_id}`;
    div.innerHTML = `<div class="notification-header"><div class="notification-icon"><i class="fas fa-envelope-open-text"></i></div><div style="flex:1;"><p class="notification-title">Group Invitation</p><p class="notification-subtitle"><strong>${data.creator_name}</strong> invited you to <strong>${data.group_name}</strong></p><div class="btn-group"><button class="btn-accept" onclick="acceptGroupInvite('${data.group_id}')">Join Group</button><button class="btn-decline" onclick="this.closest('.notification').remove()"><i class="fas fa-times"></i></button></div></div></div>`;
    container.appendChild(div);
}
function acceptGroupInvite(groupId) {
    ws.send(JSON.stringify({ type:'group_invite_accept', group_id:groupId }));
    const card = document.getElementById(`invite-${groupId}`); if (card) card.remove();
}

// ── Notifications ─────────────────────────────────────────────────────────────
function renderNotifications() {
    const container = document.getElementById('notifications-container');
    container.querySelectorAll('.notification:not([id^="invite-"])').forEach(n => n.remove());
    const grouped = incomingTransfers.reduce((acc, t) => { (acc[t.sender_name] = acc[t.sender_name] || []).push(t); return acc; }, {});
    Object.entries(grouped).forEach(([senderName, transfers]) => {
        const div = document.createElement('div'); div.className = 'notification';
        if (transfers.length > 1) {
            const totalSize = transfers.reduce((s, t) => s + t.size, 0);
            const listH = transfers.length >= 10 ? '340px' : transfers.length >= 6 ? '260px' : '160px';
            div.innerHTML = `<div class="notification-header"><div class="notification-icon"><i class="fas fa-boxes"></i></div><div style="flex:1;overflow:hidden;"><p class="notification-title">Batch Orbit Request</p><p class="notification-subtitle"><strong>${senderName}</strong> is sending <strong>${transfers.length} files</strong> (${formatBytes(totalSize)})</p><div class="file-list-compact" style="max-height:${listH};">${transfers.map(t => `<div class="file-item-compact"><div class="file-name-compact" title="${t.filename}">${t.filename}</div><div style="display:flex;align-items:center;gap:8px;"><span style="opacity:0.5;font-size:0.7rem;">${formatBytes(t.size)}</span><button class="btn-icon" style="width:24px;height:24px;font-size:0.7rem;background:rgba(129,140,248,0.1);color:var(--primary);" onclick="acceptTransfer('${t.transfer_id}','${t.filename}',${t.size})"><i class="fas fa-check"></i></button></div></div>`).join('')}</div><div class="btn-group"><button class="btn-accept" onclick="acceptAllFromSender('${senderName}')">Accept All</button><button class="btn-decline" onclick="declineAllFromSender('${senderName}')"><i class="fas fa-times"></i></button></div></div></div>`;
        } else {
            const t = transfers[0];
            div.innerHTML = `<div class="notification-header"><div class="notification-icon"><i class="fas fa-file-export"></i></div><div style="flex:1;overflow:hidden;"><p class="notification-title">Incoming Orbit</p><p class="notification-subtitle"><strong>${senderName}</strong> wants to send:</p><p style="font-weight:600;margin:8px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.filename}</p><p style="font-size:0.75rem;color:var(--text-muted);">${formatBytes(t.size)}</p><div class="btn-group"><button class="btn-accept" onclick="acceptTransfer('${t.transfer_id}','${t.filename}',${t.size})">Accept</button><button class="btn-decline" onclick="declineTransfer('${t.transfer_id}')"><i class="fas fa-times"></i></button></div></div></div>`;
        }
        container.appendChild(div);
    });
}

function showTransferError(filename, reason) {
    const container = document.getElementById('notifications-container');
    const div = document.createElement('div'); div.className = 'notification';
    div.style.cssText = 'border-color:var(--danger);box-shadow:0 10px 30px rgba(244,63,94,0.15);';
    div.innerHTML = `<div class="notification-header"><div class="notification-icon" style="background:rgba(244,63,94,0.15);color:var(--danger);"><i class="fas fa-wifi"></i></div><div style="flex:1;"><p class="notification-title" style="color:var(--danger);">Transfer Blocked</p><p class="notification-subtitle"><strong>${filename}</strong></p><p style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">${reason}</p></div><button class="btn-icon" style="background:rgba(244,63,94,0.1);color:var(--danger);" onclick="this.closest('.notification').remove()"><i class="fas fa-times"></i></button></div>`;
    container.appendChild(div);
    setTimeout(() => { div.style.transition='all 0.4s ease-out'; div.style.opacity='0'; div.style.transform='translateX(40px)'; setTimeout(()=>div.remove(),400); }, 6000);
}

// Wake Lock implementation
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try { if (!wakeLock) wakeLock = await navigator.wakeLock.request('screen'); }
        catch (err) { console.error(`${err.name}, ${err.message}`); }
    }
}
function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// ── Transfer Status Cards ─────────────────────────────────────────────────────
function showTransferStatus(transferId, status, text, progress=null, totalSize=0, blobUrl=null, filename=null) {
    const container = document.getElementById('status-container');
    let card = document.getElementById(`transfer-${transferId}`);
    const isDone = status === 'done', isErr = status === 'error';
    const color = isDone ? 'var(--accent)' : isErr ? 'var(--danger)' : 'var(--primary)';
    const displaySize = totalSize > 0 ? `0 / ${formatBytes(totalSize)}` : '0 / 0';
    if (!card) {
        card = document.createElement('div'); card.id = `transfer-${transferId}`; card.className = 'transfer-card';
        card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><div style="display:flex;align-items:center;gap:8px;"><div id="light-${transferId}" style="width:8px;height:8px;border-radius:50%;background:${color};"></div><p id="status-text-${transferId}" style="font-weight:700;font-size:0.9rem;letter-spacing:0.02em;">${isDone?'COMPLETED':isErr?'ERROR':'ORBITING'}</p></div><span id="rate-${transferId}" style="font-size:0.75rem;font-weight:600;color:var(--primary);">${isDone||isErr?'':'0 KB/s'}</span></div><p id="label-${transferId}" style="font-size:0.85rem;color:var(--text-main);margin-bottom:12px;font-weight:500;">${text}</p><div class="progress-container"><div class="progress-bar" id="pb-${transferId}" style="width:${progress||0}%"></div></div><div style="display:flex;justify-content:space-between;font-size:0.7rem;color:var(--text-muted);margin-top:8px;font-weight:600;"><span id="percent-${transferId}">${progress||0}%</span><span id="size-${transferId}">${displaySize}</span></div>`;
        container.appendChild(card);
    } else {
        const light = document.getElementById(`light-${transferId}`);
        const statusText = document.getElementById(`status-text-${transferId}`);
        const label = document.getElementById(`label-${transferId}`);
        const pb    = document.getElementById(`pb-${transferId}`);
        const pct   = document.getElementById(`percent-${transferId}`);
        if (light)      light.style.background = color;
        if (statusText) statusText.innerText = isDone ? 'COMPLETED' : isErr ? 'ERROR' : 'ORBITING';
        if (label)      label.innerText = text;
        if (pb)         pb.style.width  = `${progress||0}%`;
        if (pct)        pct.innerText   = `${progress||0}%`;
    }
    if (isDone || isErr) {
        card.style.borderColor = isDone ? 'var(--accent)' : 'var(--danger)';
        card.style.boxShadow   = isDone ? '0 10px 30px rgba(16,185,129,0.2)' : '0 10px 30px rgba(244,63,94,0.15)';
        const rate = document.getElementById(`rate-${transferId}`); if (rate) rate.innerText = '';
        
        if (isDone && blobUrl) {
            // Add manual download button for mobile compatibility
            const btnWrap = document.createElement('div');
            btnWrap.style = 'margin-top:15px; display:flex; gap:8px;';
            btnWrap.innerHTML = `
                <a href="${blobUrl}" download="${filename}" class="btn-accept" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px; width:100%; justify-content:center; padding:10px; font-size:0.8rem;">
                    <i class="fas fa-download"></i> Save to Device
                </a>
            `;
            // Remove existing manual buttons if updating
            const existingBtn = card.querySelector('.manual-save-btn');
            if (existingBtn) existingBtn.remove();
            btnWrap.className = 'manual-save-btn';
            card.appendChild(btnWrap);
        }

        const delay = (isDone && isMobile) ? 30000 : 6000; // Keep longer on mobile if done
        setTimeout(() => { 
            card.style.transition='all 0.5s ease-out'; card.style.opacity='0'; card.style.transform='translateX(50px)'; 
            setTimeout(()=> {
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                card.remove();
            },500); 
        }, delay);
    }
}

function formatBytes(bytes, decimals=2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k=1024, dm=decimals<0?0:decimals, sizes=['Bytes','KB','MB','GB','TB'];
    const i=Math.floor(Math.log(bytes)/Math.log(k));
    return parseFloat((bytes/Math.pow(k,i)).toFixed(dm))+' '+sizes[i];
}

// ── Name Change ───────────────────────────────────────────────────────────────
document.getElementById('username').onchange = (e) => {
    userName = e.target.value; localStorage.setItem('orbit_user_name', userName);
    ws.send(JSON.stringify({ type:'change_name', name:userName }));
};

connect();

// ── Background Animation ──────────────────────────────────────────────────────
class OrbitAnimation {
    constructor() {
        this.canvas=document.getElementById('bg-canvas'); this.ctx=this.canvas.getContext('2d');
        this.stars=[]; this.shootingStars=[]; this.rings=[];
        this.mouse={x:-1000,y:-1000};
        this.resize(); this.init(); this.animate();
        window.addEventListener('resize',()=>this.resize());
        window.addEventListener('mousemove',e=>{this.mouse.x=e.clientX;this.mouse.y=e.clientY;});
    }
    resize(){this.canvas.width=window.innerWidth;this.canvas.height=window.innerHeight;}
    init(){
        for(let i=0;i<250;i++) this.stars.push({x:Math.random()*this.canvas.width,y:Math.random()*this.canvas.height,size:Math.random()*2,opacity:Math.random(),speed:0.005+Math.random()*0.01});
        for(let i=0;i<3;i++) this.rings.push({radius:200+i*150,angle:Math.random()*Math.PI*2,speed:0.0002+Math.random()*0.0005,width:1.5,color:`rgba(129,140,248,${0.2+Math.random()*0.2})`});
    }
    drawStars(){
        this.stars.forEach(s=>{
            s.opacity+=s.speed; if(s.opacity>1||s.opacity<0)s.speed=-s.speed;
            let dx=this.mouse.x-s.x,dy=this.mouse.y-s.y,dist=Math.sqrt(dx*dx+dy*dy),sx=0,sy=0;
            if(dist<150){let f=(150-dist)/150;sx=(dx/dist)*f*-20;sy=(dy/dist)*f*-20;}
            this.ctx.beginPath();this.ctx.arc(s.x+sx,s.y+sy,s.size,0,Math.PI*2);
            this.ctx.fillStyle=`rgba(255,255,255,${Math.abs(s.opacity)})`;this.ctx.fill();
        });
    }
    drawRings(){
        const cx=this.canvas.width/2,cy=this.canvas.height/2;
        this.rings.forEach(r=>{
            r.angle+=r.speed;
            this.ctx.beginPath();this.ctx.ellipse(cx,cy,r.radius,r.radius*0.6,r.angle,0,Math.PI*2);
            this.ctx.strokeStyle=r.color;this.ctx.lineWidth=r.width;this.ctx.stroke();
            const nx=cx+Math.cos(r.angle*2)*r.radius,ny=cy+Math.sin(r.angle*2)*(r.radius*0.6);
            this.ctx.beginPath();this.ctx.arc(nx,ny,6,0,Math.PI*2);
            this.ctx.fillStyle='#818cf8';this.ctx.shadowBlur=15;this.ctx.shadowColor='#818cf8';
            this.ctx.fill();this.ctx.shadowBlur=0;
        });
    }
    createShootingStar(){
        if(Math.random()<0.01&&this.shootingStars.length<3)
            this.shootingStars.push({x:Math.random()*this.canvas.width,y:Math.random()*this.canvas.height*0.5,len:100+Math.random()*150,speed:10+Math.random()*15,opacity:1});
    }
    drawShootingStars(){
        this.shootingStars.forEach((s,i)=>{
            s.x-=s.speed;s.y+=s.speed*0.5;s.opacity-=0.02;
            if(s.opacity<=0){this.shootingStars.splice(i,1);return;}
            const g=this.ctx.createLinearGradient(s.x,s.y,s.x+s.len,s.y-s.len*0.5);
            g.addColorStop(0,`rgba(255,255,255,${s.opacity})`);g.addColorStop(1,'rgba(255,255,255,0)');
            this.ctx.beginPath();this.ctx.moveTo(s.x,s.y);this.ctx.lineTo(s.x+s.len,s.y-s.len*0.5);
            this.ctx.strokeStyle=g;this.ctx.lineWidth=2;this.ctx.stroke();
        });
    }
    animate(){
        this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
        this.drawStars();this.drawRings();this.createShootingStar();this.drawShootingStars();
        requestAnimationFrame(()=>this.animate());
    }
}
new OrbitAnimation();
