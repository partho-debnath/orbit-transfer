import asyncio
import uuid
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Request, HTTPException
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import json

app = FastAPI()

# Store active connections: {client_id: {"websocket": WebSocket, "name": str}}
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, Dict] = {}

    async def connect(self, websocket: WebSocket, client_id: str, name: str):
        await websocket.accept()
        self.active_connections[client_id] = {"websocket": websocket, "name": name}
        await self.broadcast_users()

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
        
    async def broadcast_users(self):
        users = [{"id": cid, "name": info["name"]} for cid, info in self.active_connections.items()]
        message = json.dumps({"type": "user_list", "users": users})
        for connection in self.active_connections.values():
            await connection["websocket"].send_text(message)

    async def send_personal_message(self, message: str, client_id: str):
        if client_id in self.active_connections:
            await self.active_connections[client_id]["websocket"].send_text(message)

manager = ConnectionManager()

# Store pending transfers: {transfer_id: {"queue": asyncio.Queue, "filename": str, "size": int}}
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
            
            elif message["type"] == "transfer_request":
                # Sender asking to send to receiver
                receiver_id = message["target_id"]
                transfer_id = str(uuid.uuid4())
                transfers[transfer_id] = {
                    "queue": asyncio.Queue(maxsize=10), # Buffer a few chunks
                    "filename": message["filename"],
                    "size": message["size"],
                    "sender_id": client_id,
                    "receiver_id": receiver_id,
                    "accepted": asyncio.Event()
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
                    transfers[transfer_id]["accepted"].set()
                    # Notify sender that they can start uploading
                    sender_id = transfers[transfer_id]["sender_id"]
                    await manager.send_personal_message(json.dumps({
                        "type": "transfer_approved",
                        "transfer_id": transfer_id
                    }), sender_id)

    except WebSocketDisconnect:
        manager.disconnect(client_id)
        await manager.broadcast_users()

@app.post("/upload/{transfer_id}")
async def upload_file(transfer_id: str, request: Request):
    if transfer_id not in transfers:
        raise HTTPException(status_code=404, detail="Transfer not found")
    
    transfer = transfers[transfer_id]
    await transfer["accepted"].wait() # Wait for receiver to be ready
    
    async for chunk in request.stream():
        await transfer["queue"].put(chunk)
    
    await transfer["queue"].put(None) # Signal end of stream
    return {"status": "success"}

@app.get("/download/{transfer_id}")
async def download_file(transfer_id: str):
    if transfer_id not in transfers:
        raise HTTPException(status_code=404, detail="Transfer not found")
    
    transfer = transfers[transfer_id]
    
    async def iter_file():
        while True:
            chunk = await transfer["queue"].get()
            if chunk is None:
                break
            yield chunk
        # Clean up after download finished
        if transfer_id in transfers:
            del transfers[transfer_id]

    return StreamingResponse(
        iter_file(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename={transfer['filename']}"}
    )

@app.get("/")
async def get_index():
    with open("static/index.html", "r") as f:
        return HTMLResponse(content=f.read(), status_code=200)

app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
