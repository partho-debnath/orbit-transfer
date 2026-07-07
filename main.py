import uuid
import os
import ipaddress
from typing import Dict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import json

# ── Cloud Mode ────────────────────────────────────────────────────────────────
# Set SUBNET_RESTRICT=true env var to enforce same-subnet-only visibility (local network mode).
# Default is False so cloud deployments work: all connected users can see each other.
SUBNET_RESTRICT = os.getenv("SUBNET_RESTRICT", "false").lower() == "true"

app = FastAPI(title="Orbit Transfer", version="3.0.0")

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, Dict] = {}
        self.groups: Dict[str, Dict] = {}

    async def connect(self, websocket: WebSocket, client_id: str, name: str, client_ip: str):
        await websocket.accept()
        self.active_connections[client_id] = {
            "websocket": websocket, "name": name, "ip": client_ip
        }
        await self.broadcast_users(client_id)
        await self.send_user_groups(client_id)

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
            return True
        return False

    async def broadcast_users(self, trigger_client_id: str):
        """Broadcast user list to all users (cloud mode) or same-subnet users (local mode)."""
        if SUBNET_RESTRICT:
            trigger_info = self.active_connections.get(trigger_client_id)
            if not trigger_info:
                return
            
            def get_network(ip_str: str) -> str:
                try:
                    ip = ipaddress.ip_address(ip_str)
                    if ip.version == 4:
                        return str(ipaddress.ip_network(f"{ip_str}/24", strict=False))
                    else:
                        return str(ipaddress.ip_network(f"{ip_str}/64", strict=False))
                except ValueError:
                    return ip_str # Fallback for invalid IPs
            
            trigger_subnet = get_network(trigger_info["ip"])
            clients = {
                cid: info for cid, info in self.active_connections.items()
                if get_network(info["ip"]) == trigger_subnet
            }
        else:
            clients = self.active_connections

        users = [{"id": cid, "name": info["name"]} for cid, info in clients.items()]
        message = json.dumps({"type": "user_list", "users": users})
        to_remove = []
        for cid, info in list(clients.items()):
            try:
                await info["websocket"].send_text(message)
            except Exception:
                to_remove.append(cid)
        for cid in to_remove:
            self.disconnect(cid)

    async def broadcast_all_users(self):
        """Re-broadcast user list to every connected client (used on disconnect)."""
        if not self.active_connections:
            return
        # Just pick one client to trigger a full broadcast
        for cid in self.active_connections:
            await self.broadcast_users(cid)
            break

    async def send_user_groups(self, client_id: str):
        user_groups = []
        for gid, ginfo in self.groups.items():
            if client_id == ginfo["creator_id"] or client_id in ginfo["members"]:
                user_groups.append({
                    "id": gid, "name": ginfo["name"],
                    "creator_id": ginfo["creator_id"],
                    "members": list(ginfo["members"]),
                    "pending": list(ginfo.get("pending", set()))
                })
        await self.send_personal_message(
            json.dumps({"type": "group_list", "groups": user_groups}), client_id
        )

    async def broadcast_group_update(self, group_id: str):
        ginfo = self.groups.get(group_id)
        if not ginfo:
            return
        all_concerned = ginfo["members"] | {ginfo["creator_id"]} | ginfo.get("pending", set())
        for cid in all_concerned:
            await self.send_user_groups(cid)

    async def send_personal_message(self, message: str, client_id: str):
        if client_id in self.active_connections:
            try:
                await self.active_connections[client_id]["websocket"].send_text(message)
            except Exception:
                self.disconnect(client_id)


manager = ConnectionManager()

# transfer_id → { sender_id, receiver_id, filename, size }
pending_transfers: Dict[str, Dict] = {}
# transfer_id → { sender_id, receiver_id } — active WebSocket relay sessions
relay_sessions: Dict[str, Dict] = {}


@app.websocket("/ws/{client_id}/{name}")
async def websocket_endpoint(websocket: WebSocket, client_id: str, name: str):
    # Respect X-Forwarded-For so it works behind nginx/caddy reverse proxies
    x_forwarded = websocket.headers.get("x-forwarded-for")
    if x_forwarded:
        client_ip = x_forwarded.split(",")[0].strip()
    else:
        client_ip = websocket.client.host if websocket.client else "127.0.0.1"

    await manager.connect(websocket, client_id, name, client_ip)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            mtype = msg.get("type", "")

            # ── Name change ───────────────────────────────────────────────────
            if mtype == "change_name":
                if client_id in manager.active_connections:
                    manager.active_connections[client_id]["name"] = msg["name"]
                    await manager.broadcast_users(client_id)

            # ── Group management ──────────────────────────────────────────────
            elif mtype == "create_group":
                group_id = str(uuid.uuid4())[:8]
                manager.groups[group_id] = {
                    "name": msg["name"], "creator_id": client_id,
                    "members": set(), "pending": set()
                }
                await manager.send_user_groups(client_id)

            elif mtype == "add_member":
                group_id = msg["group_id"]
                member_id = msg["member_id"]
                if group_id in manager.groups and manager.groups[group_id]["creator_id"] == client_id:
                    if member_id in manager.active_connections:
                        manager.groups[group_id]["pending"].add(member_id)
                        await manager.broadcast_group_update(group_id)
                        await manager.send_personal_message(json.dumps({
                            "type": "group_invite", "group_id": group_id,
                            "group_name": manager.groups[group_id]["name"],
                            "creator_name": manager.active_connections[client_id]["name"]
                        }), member_id)

            elif mtype == "group_invite_accept":
                group_id = msg["group_id"]
                if group_id in manager.groups and client_id in manager.groups[group_id]["pending"]:
                    manager.groups[group_id]["pending"].remove(client_id)
                    manager.groups[group_id]["members"].add(client_id)
                    await manager.broadcast_group_update(group_id)

            elif mtype == "remove_member":
                group_id = msg["group_id"]
                member_id = msg["member_id"]
                if group_id in manager.groups and manager.groups[group_id]["creator_id"] == client_id:
                    removed = False
                    if member_id in manager.groups[group_id]["members"]:
                        manager.groups[group_id]["members"].remove(member_id); removed = True
                    if member_id in manager.groups[group_id]["pending"]:
                        manager.groups[group_id]["pending"].remove(member_id); removed = True
                    if removed:
                        await manager.broadcast_group_update(group_id)

            elif mtype == "delete_group":
                group_id = msg["group_id"]
                if group_id in manager.groups and manager.groups[group_id]["creator_id"] == client_id:
                    ginfo = manager.groups[group_id]
                    all_concerned = ginfo["members"] | {ginfo["creator_id"]}
                    del manager.groups[group_id]
                    for cid in all_concerned:
                        await manager.send_user_groups(cid)

            # ── File transfer request ─────────────────────────────────────────
            elif mtype == "transfer_request":
                group_id   = msg.get("group_id")
                receiver_id = msg.get("target_id")
                transfer_id = str(uuid.uuid4())
                filename    = msg["filename"]
                size        = msg["size"]

                if group_id and group_id in manager.groups:
                    group = manager.groups[group_id]
                    participants = group["members"] | {group["creator_id"]}
                    member_ids = list(participants - {client_id})
                    pending_transfers[transfer_id] = {
                        "sender_id": client_id, "filename": filename,
                        "size": size, "group_id": group_id
                    }
                    notification = json.dumps({
                        "type": "incoming_transfer", "transfer_id": transfer_id,
                        "group_id": group_id, "sender_id": client_id,
                        "sender_name": f"Group: {group['name']}",
                        "filename": filename, "size": size, "is_group": True
                    })
                    for mid in member_ids:
                        await manager.send_personal_message(notification, mid)

                elif receiver_id and receiver_id in manager.active_connections:
                    pending_transfers[transfer_id] = {
                        "sender_id": client_id, "receiver_id": receiver_id,
                        "filename": filename, "size": size
                    }
                    await manager.send_personal_message(json.dumps({
                        "type": "incoming_transfer", "transfer_id": transfer_id,
                        "sender_id": client_id,
                        "sender_name": manager.active_connections[client_id]["name"],
                        "filename": filename, "size": size, "is_group": False
                    }), receiver_id)
                else:
                    await manager.send_personal_message(json.dumps({
                        "type": "transfer_error", "filename": filename,
                        "reason": "Target user is not connected."
                    }), client_id)
                    continue

                await manager.send_personal_message(json.dumps({
                    "type": "transfer_initiated", "transfer_id": transfer_id,
                    "filename": filename, "size": size
                }), client_id)

            elif mtype == "transfer_accept":
                transfer_id = msg["transfer_id"]
                if transfer_id in pending_transfers:
                    transfer = pending_transfers[transfer_id]
                    await manager.send_personal_message(json.dumps({
                        "type": "transfer_approved",
                        "transfer_id": transfer_id,
                        "receiver_id": client_id
                    }), transfer["sender_id"])

            elif mtype == "transfer_decline":
                transfer_id = msg["transfer_id"]
                if transfer_id in pending_transfers:
                    transfer = pending_transfers[transfer_id]
                    await manager.send_personal_message(json.dumps({
                        "type": "transfer_declined",
                        "transfer_id": transfer_id, "receiver_id": client_id
                    }), transfer["sender_id"])
                    pending_transfers.pop(transfer_id, None)

            # ── WebRTC Signaling ──────────────────────────────────────────────
            elif mtype in ("webrtc_offer", "webrtc_answer", "webrtc_ice_candidate"):
                target_id = msg.get("target_id")
                if target_id and target_id in manager.active_connections:
                    forward = dict(msg)
                    forward["sender_id"] = client_id
                    forward.pop("target_id", None)
                    await manager.send_personal_message(json.dumps(forward), target_id)

            # ── WebSocket Relay fallback (when WebRTC P2P fails) ──────────────
            elif mtype == "relay_start":
                # Sender signals it will relay file data through the server
                transfer_id = msg["transfer_id"]
                target_id   = msg.get("target_id")
                if target_id and target_id in manager.active_connections:
                    relay_sessions[transfer_id] = {
                        "sender_id": client_id, "receiver_id": target_id
                    }
                    await manager.send_personal_message(json.dumps({
                        "type": "relay_start",
                        "transfer_id": transfer_id,
                        "sender_id": client_id,
                        "filename": msg["filename"],
                        "size": msg["size"]
                    }), target_id)

            elif mtype == "relay_chunk":
                # Forward raw base64 chunk to receiver
                transfer_id = msg["transfer_id"]
                session = relay_sessions.get(transfer_id)
                if session and session["sender_id"] == client_id:
                    await manager.send_personal_message(json.dumps({
                        "type": "relay_chunk",
                        "transfer_id": transfer_id,
                        "data": msg["data"],
                        "seq": msg.get("seq", 0)
                    }), session["receiver_id"])

            elif mtype == "relay_done":
                transfer_id = msg["transfer_id"]
                session = relay_sessions.pop(transfer_id, None)
                if session and session["sender_id"] == client_id:
                    await manager.send_personal_message(json.dumps({
                        "type": "relay_done",
                        "transfer_id": transfer_id
                    }), session["receiver_id"])
                pending_transfers.pop(transfer_id, None)

    except WebSocketDisconnect:
        manager.disconnect(client_id)
        # Clean up any relay sessions this client was part of
        stale = [tid for tid, s in relay_sessions.items()
                 if s["sender_id"] == client_id or s["receiver_id"] == client_id]
        for tid in stale:
            relay_sessions.pop(tid, None)
        await manager.broadcast_all_users()


@app.get("/")
async def get_index():
    with open("static/index.html", "r") as f:
        return HTMLResponse(content=f.read(), status_code=200)


app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
