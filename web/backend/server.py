"""Jena Weather Forecast Client - Backend Server.

FastAPI + python-socketio server that:
- Serves the frontend static files
- Proxies predictions to the noted-serving model endpoint
- Provides real-time feedback via socket.io
"""

from pathlib import Path

import httpx
import socketio
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Model serving endpoint (noted-serving container)
SERVING_URL = "http://noted-serving:5522"

# Socket.IO server
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
app = FastAPI(title="Jena Weather Client")
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# Serve frontend static files
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/api/health")
async def health():
    """Check if the model serving endpoint is reachable."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{SERVING_URL}/health")
            return resp.json()
    except (httpx.HTTPError, OSError, ValueError, KeyError) as e:
        return {"status": "error", "detail": str(e)}


@app.get("/api/schema")
async def schema():
    """Get the model input/output schema."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{SERVING_URL}/schema")
            return resp.json()
    except (httpx.HTTPError, OSError, ValueError, KeyError) as e:
        return {"error": str(e)}


@sio.event
async def connect(sid, environ):
    print(f"Client connected: {sid}")
    await sio.emit("status", {"message": "Connected to server", "phase": "connected"}, to=sid)


@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")


@sio.event
async def load_model(sid, data):
    """Load a model by name, version, or alias."""
    model_name = data.get("model_name", "Jena Weather Forecaster")
    version = data.get("version")
    alias = data.get("alias")

    await sio.emit("status", {"message": f"Loading model {model_name}...", "phase": "loading"}, to=sid)

    try:
        payload = {"model_name": model_name}
        if version:
            payload["version"] = version
        if alias:
            payload["alias"] = alias

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{SERVING_URL}/load", json=payload)
            result = resp.json()

        if resp.status_code == 200:
            await sio.emit("model_loaded", result, to=sid)
            await sio.emit("status", {"message": f"Model {model_name} loaded", "phase": "ready"}, to=sid)
        else:
            await sio.emit("error", {"message": result.get("detail", "Failed to load model")}, to=sid)
            await sio.emit("status", {"message": "Load failed", "phase": "error"}, to=sid)
    except (httpx.HTTPError, OSError, ValueError, KeyError) as e:
        await sio.emit("error", {"message": str(e)}, to=sid)
        await sio.emit("status", {"message": "Load failed", "phase": "error"}, to=sid)


@sio.event
async def predict(sid, data):
    """Run prediction with real-time progress feedback."""
    await sio.emit("status", {"message": "Preparing input data...", "phase": "predicting"}, to=sid)

    try:
        input_data = data.get("data")
        if not input_data:
            await sio.emit("error", {"message": "No input data provided"}, to=sid)
            return

        await sio.emit("status", {"message": "Sending to model...", "phase": "predicting"}, to=sid)

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{SERVING_URL}/predict", json={"data": input_data})
            result = resp.json()

        if resp.status_code == 200:
            await sio.emit("prediction", result, to=sid)
            await sio.emit("status", {"message": "Prediction complete", "phase": "ready"}, to=sid)
        else:
            await sio.emit("error", {"message": result.get("detail", "Prediction failed")}, to=sid)
            await sio.emit("status", {"message": "Prediction failed", "phase": "error"}, to=sid)
    except (httpx.HTTPError, OSError, ValueError, KeyError) as e:
        await sio.emit("error", {"message": str(e)}, to=sid)
        await sio.emit("status", {"message": "Prediction failed", "phase": "error"}, to=sid)


if __name__ == "__main__":
    uvicorn.run(socket_app, host="0.0.0.0", port=3719)
