"""Jena Weather Forecast Client - Backend Server.

FastAPI + python-socketio server that:
- Serves the frontend static files
- Proxies predictions to the noted-serving model endpoint
- Provides real-time feedback via socket.io
"""

import json
from pathlib import Path

import httpx
import socketio
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Model serving endpoint (noted-serving container)
SERVING_URL = "http://noted-serving:5522"
# MLflow tracking server (used directly for model/version browsing)
MLFLOW_URL = "http://mlflow:5000"

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


@app.get("/api/models")
async def list_models():
    """List all registered models on the MLflow tracking server.

    Returns:
        {"models": [{"name": str}, ...]}
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{MLFLOW_URL}/api/2.0/mlflow/registered-models/search",
                params={"max_results": 1000},
            )
            resp.raise_for_status()
            data = resp.json()
        models = [{"name": m.get("name")} for m in data.get("registered_models", [])]
        models.sort(key=lambda m: (m["name"] or "").lower())
        return {"models": models}
    except (httpx.HTTPError, OSError, ValueError, KeyError) as e:
        return {"error": str(e), "models": []}


@app.get("/api/run_params/{run_id}")
async def get_run_params(run_id: str):
    """Return the MLflow run's params as a {key: value} dict.

    Used by the frontend to fetch model-specific serving metadata like
    `target_mean` / `target_std` (scaler stats) so predictions can be
    de-standardized into real units on the client. The notebook's cell
    116 logs these alongside the hyperparameters.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{MLFLOW_URL}/api/2.0/mlflow/runs/get",
                params={"run_id": run_id},
            )
            resp.raise_for_status()
            data = resp.json()
        run = data.get("run", {})
        params_list = run.get("data", {}).get("params", [])
        params = {p.get("key"): p.get("value") for p in params_list if p.get("key")}
        return {"params": params}
    except (httpx.HTTPError, OSError, ValueError, KeyError) as e:
        return {"error": str(e), "params": {}}


@app.get("/api/models/{name}/versions")
async def list_versions(name: str):
    """List all versions of a registered model with their aliases.

    MLflow exposes aliases at the registered-model level (not on each
    version), so we make two requests in parallel and merge:
      1. `registered-models/get?name=...` returns `{aliases: [{alias, version}]}`
      2. `model-versions/search?filter=...` returns the full version list

    Returns:
        {"versions": [{"version": str, "aliases": [str], "run_id": str,
                       "creation_timestamp": int}, ...]}
        Sorted by integer version descending (newest first).
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            rm_task = client.get(
                f"{MLFLOW_URL}/api/2.0/mlflow/registered-models/get",
                params={"name": name},
            )
            vs_task = client.get(
                f"{MLFLOW_URL}/api/2.0/mlflow/model-versions/search",
                params={"filter": f"name='{name}'", "max_results": 1000},
            )
            rm_resp, vs_resp = await rm_task, await vs_task
            rm_resp.raise_for_status()
            vs_resp.raise_for_status()
            rm_data = rm_resp.json()
            vs_data = vs_resp.json()

        # Build version -> [alias names] map from registered model payload.
        aliases_by_version: dict[str, list[str]] = {}
        for entry in rm_data.get("registered_model", {}).get("aliases", []) or []:
            v = entry.get("version")
            a = entry.get("alias")
            if v and a:
                aliases_by_version.setdefault(v, []).append(a)

        versions = []
        for v in vs_data.get("model_versions", []):
            ver = v.get("version")
            versions.append({
                "version": ver,
                "aliases": aliases_by_version.get(ver, []),
                "run_id": v.get("run_id"),
                "creation_timestamp": v.get("creation_timestamp"),
            })
        versions.sort(key=lambda x: int(x["version"] or 0), reverse=True)
        return {"versions": versions}
    except (httpx.HTTPError, OSError, ValueError, KeyError) as e:
        return {"error": str(e), "versions": []}


@sio.event
async def connect(sid, environ):
    print(f"Client connected: {sid}")
    await sio.emit("status", {"message": "Connected to server", "phase": "connected"}, to=sid)


@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")


@sio.event
async def load_model(sid, data):
    """Load a model by name, version, or alias.

    noted-serving's /load returns a streaming NDJSON response (one JSON
    event per line) ending with either `{"phase": "ready", "result": {...}}`
    or `{"phase": "error", "error": "..."}`. This handler consumes the
    stream, forwards progress events to the frontend as status updates,
    and emits `model_loaded` with the final health payload so the UI can
    show real values for model name, version, and load time.

    Frontend MUST send `model_name`; `version` is optional (defaults to
    whatever noted-serving picks when no version is supplied, but the
    Model Serving Client UI always resolves a version client-side).
    """
    model_name = data.get("model_name")
    if not model_name:
        await sio.emit("error", {"message": "model_name is required"}, to=sid)
        await sio.emit("status", {"message": "Load failed: no model name", "phase": "error"}, to=sid)
        return
    version = data.get("version")
    alias = data.get("alias")

    await sio.emit("status", {"message": f"Loading model {model_name}...", "phase": "loading"}, to=sid)

    try:
        payload = {"model_name": model_name}
        if version:
            payload["version"] = version
        if alias:
            payload["alias"] = alias

        # Read timeout bumped to 300s to cover cold model-load / uv install
        # cases in noted-serving. Connect/write/pool kept short.
        timeout = httpx.Timeout(connect=10.0, read=300.0, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{SERVING_URL}/load", json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    try:
                        err_body = json.loads(body.decode())
                        err_msg = err_body.get("detail", str(err_body))
                    except (ValueError, UnicodeDecodeError):
                        err_msg = body.decode("utf-8", errors="replace")[:500]
                    await sio.emit("error", {"message": f"Failed to load model: {err_msg}"}, to=sid)
                    await sio.emit("status", {"message": "Load failed", "phase": "error"}, to=sid)
                    return

                final_result = None
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        evt = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    phase = evt.get("phase", "")
                    if phase == "ready":
                        final_result = evt.get("result", {})
                        break
                    if phase == "error":
                        err_msg = evt.get("error", "Unknown error from serving")
                        await sio.emit("error", {"message": err_msg}, to=sid)
                        await sio.emit("status", {"message": "Load failed", "phase": "error"}, to=sid)
                        return
                    # Intermediate progress event - forward as status.
                    detail = evt.get("detail", "")
                    status_msg = f"{phase}: {detail}" if detail else phase
                    await sio.emit("status", {"message": status_msg, "phase": "loading"}, to=sid)

                if final_result is None:
                    await sio.emit("error", {"message": "Load stream ended without ready or error event"}, to=sid)
                    await sio.emit("status", {"message": "Load failed", "phase": "error"}, to=sid)
                    return

                await sio.emit("model_loaded", final_result, to=sid)
                await sio.emit("status", {"message": f"Model {model_name} loaded", "phase": "ready"}, to=sid)

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
