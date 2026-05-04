import asyncio
import uuid
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Request, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import json

app = FastAPI(
    title="Orbit Transfer API",
    description="A high-performance local network file sharing API using WebSockets and streaming pipes.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Store active connections: {client_id: {"websocket": WebSocket, "name": str}}
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, Dict] = {}
        # groups: {group_id: {"name": str, "creator_id": str, "members": set(client_ids), "pending": set(client_ids)}}
        self.groups: Dict[str, Dict] = {}

    async def connect(self, websocket: WebSocket, client_id: str, name: str):
        await websocket.accept()
        self.active_connections[client_id] = {"websocket": websocket, "name": name}
        await self.broadcast_users()
        await self.send_user_groups(client_id)

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
        
    async def broadcast_users(self):
        users = [{"id": cid, "name": info["name"]} for cid, info in self.active_connections.items()]
        message = json.dumps({"type": "user_list", "users": users})
        to_remove = []
        for cid, info in list(self.active_connections.items()):
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
                    "id": gid, 
                    "name": ginfo["name"], 
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
transfers: Dict[str, Dict] = {}

@app.websocket("/ws/{client_id}/{name}")
async def websocket_endpoint(websocket: WebSocket, client_id: str, name: str):
    await manager.connect(websocket, client_id, name)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message["type"] == "change_name":
                manager.active_connections[client_id]["name"] = message["name"]
                await manager.broadcast_users()
            
            elif message["type"] == "create_group":
                group_id = str(uuid.uuid4())[:8]
                manager.groups[group_id] = {
                    "name": message["name"],
                    "creator_id": client_id,
                    "members": set(),
                    "pending": set()
                }
                await manager.send_user_groups(client_id)

            elif message["type"] == "add_member":
                group_id = message["group_id"]
                member_id = message["member_id"]
                if group_id in manager.groups and manager.groups[group_id]["creator_id"] == client_id:
                    manager.groups[group_id]["pending"].add(member_id)
                    await manager.broadcast_group_update(group_id)
                    # Send specific invite
                    await manager.send_personal_message(json.dumps({
                        "type": "group_invite",
                        "group_id": group_id,
                        "group_name": manager.groups[group_id]["name"],
                        "creator_name": manager.active_connections[client_id]["name"]
                    }), member_id)

            elif message["type"] == "group_invite_accept":
                group_id = message["group_id"]
                if group_id in manager.groups and client_id in manager.groups[group_id]["pending"]:
                    manager.groups[group_id]["pending"].remove(client_id)
                    manager.groups[group_id]["members"].add(client_id)
                    await manager.broadcast_group_update(group_id)

            elif message["type"] == "remove_member":
                group_id = message["group_id"]
                member_id = message["member_id"]
                if group_id in manager.groups and manager.groups[group_id]["creator_id"] == client_id:
                    if member_id in manager.groups[group_id]["members"]:
                        manager.groups[group_id]["members"].remove(member_id)
                        await manager.broadcast_group_update(group_id)

            elif message["type"] == "delete_group":
                group_id = message["group_id"]
                if group_id in manager.groups and manager.groups[group_id]["creator_id"] == client_id:
                    ginfo = manager.groups[group_id]
                    all_concerned = ginfo["members"] | {ginfo["creator_id"]}
                    del manager.groups[group_id]
                    for cid in all_concerned:
                        await manager.send_user_groups(cid)

            elif message["type"] == "group_transfer_request":
                group_id = message["group_id"]
                if group_id in manager.groups:
                    group = manager.groups[group_id]
                    transfer_id = str(uuid.uuid4())
                    member_ids = list(group["members"])
                    transfers[transfer_id] = {
                        "queues": {mid: asyncio.Queue(maxsize=10) for mid in member_ids},
                        "filename": message["filename"],
                        "size": message["size"],
                        "sender_id": client_id,
                        "receiver_ids": member_ids,
                        "accepted_count": 0,
                        "expected_count": len(member_ids),
                        "all_accepted": asyncio.Event(),
                        "is_group": True,
                        "auto_accept": True # New flag to allow immediate start if all are members
                    }
                    # If all receivers are already members, we can theoreticaly auto-start
                    # but the client must perform the 'accept' handshake for state tracking.
                    # We will mark it as all_accepted immediately because they are joined members? 
                    # No, the user said "can auto receive". 
                    # We will still send notification, but the client will auto-accept.
                    
                    notification = json.dumps({
                        "type": "incoming_transfer",
                        "transfer_id": transfer_id,
                        "sender_name": f"Group: {group['name']}",
                        "filename": message["filename"],
                        "size": message["size"],
                        "is_group": True
                    })
                    for mid in member_ids:
                        await manager.send_personal_message(notification, mid)

            elif message["type"] == "transfer_request":
                receiver_id = message["target_id"]
                transfer_id = str(uuid.uuid4())
                transfers[transfer_id] = {
                    "queue": asyncio.Queue(maxsize=10),
                    "filename": message["filename"],
                    "size": message["size"],
                    "sender_id": client_id,
                    "receiver_id": receiver_id,
                    "accepted": asyncio.Event(),
                    "is_group": False
                }
                notification = json.dumps({
                    "type": "incoming_transfer",
                    "transfer_id": transfer_id,
                    "sender_name": manager.active_connections[client_id]["name"],
                    "filename": message["filename"],
                    "size": message["size"]
                })
                await manager.send_personal_message(notification, receiver_id)
            
            elif message["type"] == "transfer_accept":
                transfer_id = message["transfer_id"]
                if transfer_id in transfers:
                    transfer = transfers[transfer_id]
                    if transfer.get("is_group"):
                        transfer["accepted_count"] += 1
                        if transfer["accepted_count"] == transfer["expected_count"]:
                            transfer["all_accepted"].set()
                            await manager.send_personal_message(json.dumps({
                                "type": "transfer_approved",
                                "transfer_id": transfer_id
                            }), transfer["sender_id"])
                    else:
                        transfer["accepted"].set()
                        await manager.send_personal_message(json.dumps({
                            "type": "transfer_approved",
                            "transfer_id": transfer_id
                        }), transfer["sender_id"])

    except WebSocketDisconnect:
        manager.disconnect(client_id)
        await manager.broadcast_users()

@app.post("/upload/{transfer_id}", tags=["File Transfer"])
async def upload_file(transfer_id: str, request: Request):
    if transfer_id not in transfers:
        raise HTTPException(status_code=404, detail="Transfer not found")
    
    transfer = transfers[transfer_id]
    if transfer.get("is_group"):
        await transfer["all_accepted"].wait()
    else:
        await transfer["accepted"].wait()
    
    async for chunk in request.stream():
        if transfer.get("is_group"):
            for mid, queue in transfer["queues"].items():
                await queue.put(chunk)
        else:
            await transfer["queue"].put(chunk)
    
    if transfer.get("is_group"):
        for queue in transfer["queues"].values():
            await queue.put(None)
    else:
        await transfer["queue"].put(None)
        
    return {"status": "success"}

@app.get("/download/{transfer_id}", tags=["File Transfer"])
async def download_file(transfer_id: str, client_id: str):
    if transfer_id not in transfers:
        raise HTTPException(status_code=404, detail="Transfer not found")
    
    transfer = transfers[transfer_id]
    
    async def iter_file():
        bytes_sent = 0
        last_report_time = asyncio.get_event_loop().time()
        
        queue = transfer["queues"][client_id] if transfer.get("is_group") else transfer["queue"]
        receiver_id = client_id if transfer.get("is_group") else transfer["receiver_id"]
        
        while True:
            chunk = await queue.get()
            if chunk is None:
                status_msg = json.dumps({"type": "transfer_status", "transfer_id": transfer_id, "status": "complete"})
                await manager.send_personal_message(status_msg, receiver_id)
                await manager.send_personal_message(status_msg, transfer["sender_id"])
                break
            
            bytes_sent += len(chunk)
            current_time = asyncio.get_event_loop().time()
            if current_time - last_report_time > 0.2:
                progress_msg = json.dumps({
                    "type": "transfer_status",
                    "transfer_id": transfer_id,
                    "status": "progress",
                    "bytes_sent": bytes_sent,
                    "total_size": transfer["size"],
                    "percentage": round((bytes_sent / transfer["size"]) * 100, 1)
                })
                await manager.send_personal_message(progress_msg, receiver_id)
                await manager.send_personal_message(progress_msg, transfer["sender_id"])
                last_report_time = current_time
            yield chunk
            
        if transfer.get("is_group"):
            if client_id in transfer["queues"]: del transfer["queues"][client_id]
            if not transfer["queues"]:
                if transfer_id in transfers: del transfers[transfer_id]
        else:
            if transfer_id in transfers: del transfers[transfer_id]

    return StreamingResponse(
        iter_file(),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{transfer["filename"]}"',
            "Content-Length": str(transfer["size"]),
            "X-Content-Type-Options": "nosniff"
        }
    )

@app.get("/")
async def get_index():
    with open("static/index.html", "r") as f:
        return HTMLResponse(content=f.read(), status_code=200)

app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
