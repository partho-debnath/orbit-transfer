import asyncio
import uuid
import ipaddress
from typing import Dict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import json

def get_client_subnet(ip: str) -> str:
    try:
        network = ipaddress.ip_network(f"{ip}/24", strict=False)
        return str(network.network_address)
    except Exception:
        return ip

app = FastAPI(title="Orbit Transfer", version="2.0.0")

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, Dict] = {}
        self.groups: Dict[str, Dict] = {}

    async def connect(self, websocket: WebSocket, client_id: str, name: str, client_ip: str):
        await websocket.accept()
        subnet = get_client_subnet(client_ip)
        self.active_connections[client_id] = {
            "websocket": websocket, "name": name,
            "subnet": subnet, "ip": client_ip
        }
        await self.broadcast_users(subnet)
        await self.send_user_groups(client_id)

    def disconnect(self, client_id: str):
        subnet = None
        if client_id in self.active_connections:
            subnet = self.active_connections[client_id].get("subnet")
            del self.active_connections[client_id]
        return subnet

    async def broadcast_users(self, subnet: str):
        subnet_clients = {cid: info for cid, info in self.active_connections.items() if info["subnet"] == subnet}
        users = [{"id": cid, "name": info["name"]} for cid, info in subnet_clients.items()]
        message = json.dumps({"type": "user_list", "users": users})
        to_remove = []
        for cid, info in list(subnet_clients.items()):
            try:
                await info["websocket"].send_text(message)
            except:
                to_remove.append(cid)
        for cid in to_remove:
            self.disconnect(cid)

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
        await self.send_personal_message(json.dumps({"type": "group_list", "groups": user_groups}), client_id)

    async def broadcast_group_update(self, group_id: str):
        ginfo = self.groups.get(group_id)
        if not ginfo: return
        all_concerned = ginfo["members"] | {ginfo["creator_id"]} | ginfo.get("pending", set())
        for cid in all_concerned:
            await self.send_user_groups(cid)

    async def send_personal_message(self, message: str, client_id: str):
        if client_id in self.active_connections:
            try:
                await self.active_connections[client_id]["websocket"].send_text(message)
            except:
                self.disconnect(client_id)

manager = ConnectionManager()
# Lightweight registry: transfer_id → { sender_id, filename, size }
pending_transfers: Dict[str, Dict] = {}

@app.websocket("/ws/{client_id}/{name}")
async def websocket_endpoint(websocket: WebSocket, client_id: str, name: str):
    client_ip = websocket.client.host if websocket.client else "127.0.0.1"
    if client_ip in ("127.0.0.1", "::1"):
        client_ip = "127.0.0.1"

    await manager.connect(websocket, client_id, name, client_ip)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            if msg["type"] == "change_name":
                if client_id in manager.active_connections:
                    manager.active_connections[client_id]["name"] = msg["name"]
                    subnet = manager.active_connections[client_id]["subnet"]
                    await manager.broadcast_users(subnet)

            elif msg["type"] == "create_group":
                group_id = str(uuid.uuid4())[:8]
                manager.groups[group_id] = {
                    "name": msg["name"], "creator_id": client_id,
                    "members": set(), "pending": set(),
                    "subnet": manager.active_connections[client_id]["subnet"]
                }
                await manager.send_user_groups(client_id)

            elif msg["type"] == "add_member":
                group_id = msg["group_id"]
                member_id = msg["member_id"]
                if group_id in manager.groups and manager.groups[group_id]["creator_id"] == client_id:
                    member_info = manager.active_connections.get(member_id)
                    sender_subnet = manager.active_connections[client_id]["subnet"]
                    if member_info and member_info["subnet"] == sender_subnet:
                        manager.groups[group_id]["pending"].add(member_id)
                        await manager.broadcast_group_update(group_id)
                        await manager.send_personal_message(json.dumps({
                            "type": "group_invite", "group_id": group_id,
                            "group_name": manager.groups[group_id]["name"],
                            "creator_name": manager.active_connections[client_id]["name"]
                        }), member_id)

            elif msg["type"] == "group_invite_accept":
                group_id = msg["group_id"]
                if group_id in manager.groups and client_id in manager.groups[group_id]["pending"]:
                    manager.groups[group_id]["pending"].remove(client_id)
                    manager.groups[group_id]["members"].add(client_id)
                    await manager.broadcast_group_update(group_id)

            elif msg["type"] == "remove_member":
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

            elif msg["type"] == "delete_group":
                group_id = msg["group_id"]
                if group_id in manager.groups and manager.groups[group_id]["creator_id"] == client_id:
                    ginfo = manager.groups[group_id]
                    all_concerned = ginfo["members"] | {ginfo["creator_id"]}
                    del manager.groups[group_id]
                    for cid in all_concerned:
                        await manager.send_user_groups(cid)

            elif msg["type"] == "transfer_request":
                group_id = msg.get("group_id")
                receiver_id = msg.get("target_id")
                transfer_id = str(uuid.uuid4())
                filename = msg["filename"]
                size = msg["size"]

                if group_id and group_id in manager.groups:
                    group = manager.groups[group_id]
                    participants = group["members"] | {group["creator_id"]}
                    member_ids = list(participants - {client_id})
                    pending_transfers[transfer_id] = {
                        "sender_id": client_id, "filename": filename, "size": size, "group_id": group_id
                    }
                    notification = json.dumps({
                        "type": "incoming_transfer", "transfer_id": transfer_id,
                        "group_id": group_id, "sender_id": client_id,
                        "sender_name": f"Group: {group['name']}",
                        "filename": filename, "size": size, "is_group": True
                    })
                    for mid in member_ids:
                        await manager.send_personal_message(notification, mid)

                elif receiver_id:
                    receiver_info = manager.active_connections.get(receiver_id)
                    sender_subnet = manager.active_connections[client_id]["subnet"]
                    if receiver_info and receiver_info["subnet"] == sender_subnet:
                        pending_transfers[transfer_id] = {
                            "sender_id": client_id, "filename": filename, "size": size
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
                            "reason": "Target user is not on your local network."
                        }), client_id)
                        continue

                await manager.send_personal_message(json.dumps({
                    "type": "transfer_initiated", "transfer_id": transfer_id,
                    "filename": filename, "size": size
                }), client_id)

            elif msg["type"] == "transfer_accept":
                transfer_id = msg["transfer_id"]
                if transfer_id in pending_transfers:
                    transfer = pending_transfers[transfer_id]
                    await manager.send_personal_message(json.dumps({
                        "type": "transfer_approved",
                        "transfer_id": transfer_id,
                        "receiver_id": client_id
                    }), transfer["sender_id"])

            elif msg["type"] == "transfer_decline":
                transfer_id = msg["transfer_id"]
                if transfer_id in pending_transfers:
                    transfer = pending_transfers[transfer_id]
                    await manager.send_personal_message(json.dumps({
                        "type": "transfer_declined",
                        "transfer_id": transfer_id, "receiver_id": client_id
                    }), transfer["sender_id"])
                    pending_transfers.pop(transfer_id, None)

            # ── WebRTC Signaling: just forward with sender_id injected ──
            elif msg["type"] in ("webrtc_offer", "webrtc_answer", "webrtc_ice_candidate"):
                target_id = msg.get("target_id")
                if target_id and target_id in manager.active_connections:
                    forward = dict(msg)
                    forward["sender_id"] = client_id
                    forward.pop("target_id", None)
                    await manager.send_personal_message(json.dumps(forward), target_id)

    except WebSocketDisconnect:
        subnet = manager.disconnect(client_id)
        if subnet:
            await manager.broadcast_users(subnet)

@app.get("/")
async def get_index():
    with open("static/index.html", "r") as f:
        return HTMLResponse(content=f.read(), status_code=200)

app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
