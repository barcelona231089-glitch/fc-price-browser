import os
import math
from functools import lru_cache
from typing import Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request

APP_VERSION = "1.0.0"
DEVICE = os.getenv("WORLD_MAX_DEVICE", "auto").strip().lower()
if DEVICE == "auto":
    try:
        import torch
        DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        DEVICE = "cpu"
ENABLE_CHRONOS2 = os.getenv("ENABLE_CHRONOS2", "1").lower() in {"1", "true", "yes", "on"}
ENABLE_TIMESFM3_SHADOW = os.getenv("ENABLE_TIMESFM3_SHADOW", "0").lower() in {"1", "true", "yes", "on"}
ALLOW_TIMESFM3_NONCOMMERCIAL = os.getenv("ALLOW_TIMESFM3_NONCOMMERCIAL", "0").lower() in {"1", "true", "yes", "on"}
WORKER_TOKEN = os.getenv("WORLD_MAX_ML_WORKER_TOKEN", "").strip()

app = FastAPI(title="FC World-Max Forecast Worker", version=APP_VERSION)

runtime = {
    "chronos2_loaded": False,
    "timesfm3_loaded": False,
    "chronos2_error": None,
    "timesfm3_error": None,
}
@lru_cache(maxsize=1)
def chronos_pipeline():
    if not ENABLE_CHRONOS2:
        return None
    try:
        from chronos import Chronos2Pipeline
        pipe = Chronos2Pipeline.from_pretrained("amazon/chronos-2", device_map=DEVICE)
        runtime["chronos2_loaded"] = True
        runtime["chronos2_error"] = None
        return pipe
    except Exception as exc:
        runtime["chronos2_error"] = str(exc)
        return None


@lru_cache(maxsize=1)
def timesfm3_pipeline():
    if not ENABLE_TIMESFM3_SHADOW or not ALLOW_TIMESFM3_NONCOMMERCIAL:
        return None
    try:
        from timesfm3 import TimesFM3Evaluator, ModelConfig
        cfg = ModelConfig(
            checkpoint_path="google/timesfm-3.0-pytorch",
            per_core_batch_size=16,
            device=DEVICE,
        )
        pipe = TimesFM3Evaluator(cfg)
        runtime["timesfm3_loaded"] = True
        runtime["timesfm3_error"] = None
        return pipe
    except Exception as exc:
        runtime["timesfm3_error"] = str(exc)
        return None


def clean_series(item: dict[str, Any]) -> tuple[np.ndarray, list[pd.Timestamp]]:
    points = item.get("series") or []
    values, stamps = [], []
    for point in points:
        try:
            price = float(point["price"])
            stamp = pd.Timestamp(point["at"])
            if stamp.tzinfo is None:
                stamp = stamp.tz_localize("UTC")
            else:
                stamp = stamp.tz_convert("UTC")
            stamp = stamp.tz_localize(None)
            if math.isfinite(price) and price > 0:
                values.append(price)
                stamps.append(stamp)
        except Exception:
            continue
    if len(values) < 32:
        raise ValueError("INSUFFICIENT_REAL_SERIES")
    return np.asarray(values, dtype=np.float32), stamps


def requested_steps(item: dict[str, Any], horizons: list[int]) -> dict[int, int]:
    step_minutes = max(1, int(item.get("stepMinutes") or 60))
    return {int(h): max(1, int(round(int(h) / step_minutes))) for h in horizons}


def chronos_forecasts(item: dict[str, Any], horizons: list[int], quantiles: list[float]) -> list[dict[str, Any]]:
    pipe = chronos_pipeline()
    if pipe is None:
        return []

    values, stamps = clean_series(item)
    steps = requested_steps(item, horizons)
    prediction_length = max(steps.values())

    context = pd.DataFrame({
        "id": str(item["eaId"]),
        "timestamp": stamps,
        "target": values.astype(float),
    })
    pred = pipe.predict_df(
        context,
        prediction_length=prediction_length,
        quantile_levels=quantiles,
        id_column="id",
        timestamp_column="timestamp",
        target="target",
    ).sort_values("timestamp").reset_index(drop=True)

    out = []
    for horizon_minutes, step in steps.items():
        row = pred.iloc[min(step - 1, len(pred) - 1)]
        p50 = float(row["0.5"] if "0.5" in row else row["predictions"])
        out.append({
            "model": "chronos2",
            "horizonMinutes": horizon_minutes,
            "p10": float(row["0.1"]) if "0.1" in row else None,
            "p50": p50,
            "p90": float(row["0.9"]) if "0.9" in row else None,
            "metadata": {"checkpoint": "amazon/chronos-2", "realObservedSeriesOnly": True},
        })
    return out
def timesfm3_forecasts(item: dict[str, Any], horizons: list[int]) -> list[dict[str, Any]]:
    pipe = timesfm3_pipeline()
    if pipe is None:
        return []

    values, _ = clean_series(item)
    steps = requested_steps(item, horizons)
    prediction_length = max(steps.values())

    result = list(pipe.predict_batch(
        [values],
        horizon=prediction_length,
        return_quantiles=True,
        use_symmetric_averaging=False,
    ))[0]

    forecast = np.asarray(result.forecast)
    q = np.asarray(result.quantiles)
    out = []
    for horizon_minutes, step in steps.items():
        idx = min(step - 1, forecast.shape[-1] - 1)
        out.append({
            "model": "timesfm3",
            "horizonMinutes": horizon_minutes,
            "p10": float(q[idx, 0]),
            "p50": float(forecast[idx]),
            "p90": float(q[idx, 8]),
            "metadata": {
                "checkpoint": "google/timesfm-3.0-pytorch",
                "shadowOnly": True,
                "realObservedSeriesOnly": True,
            },
        })
    return out
def require_token(request: Request) -> None:
    if not WORKER_TOKEN:
        return
    supplied = request.headers.get("authorization", "")
    if supplied != f"Bearer {WORKER_TOKEN}":
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")


@app.on_event("startup")
def warm_models_on_startup():
    # Warm the production-safe Chronos model without inventing any price series.
    # Forecast requests then spend their timeout budget on inference, not model loading.
    if ENABLE_CHRONOS2:
        chronos_pipeline()


@app.get("/health")
def health():
    return {
        "ok": True,
        "version": APP_VERSION,
        "device": DEVICE,
        "chronos2": {
            "enabled": ENABLE_CHRONOS2,
            "loaded": runtime["chronos2_loaded"],
            "error": runtime["chronos2_error"],
        },
        "timesfm3": {
            "enabled": ENABLE_TIMESFM3_SHADOW and ALLOW_TIMESFM3_NONCOMMERCIAL,
            "shadow_only": True,
            "loaded": runtime["timesfm3_loaded"],
            "error": runtime["timesfm3_error"],
        },
    }
@app.post("/v1/forecast/batch")
def forecast_batch(payload: dict[str, Any], request: Request):
    require_token(request)
    items = payload.get("items") or []
    horizons = [int(x) for x in (payload.get("horizonsMinutes") or [60, 360, 1440])]
    quantiles = [float(x) for x in (payload.get("quantiles") or [0.1, 0.5, 0.9])]
    requested = {str(x).lower() for x in (payload.get("requestedModels") or [])}

    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="NO_ITEMS")

    response_items = []
    for item in items:
        ea_id = str(item.get("eaId") or "")
        forecasts = []
        try:
            if "chronos2" in requested and ENABLE_CHRONOS2:
                forecasts.extend(chronos_forecasts(item, horizons, quantiles))
        except Exception as exc:
            runtime["chronos2_error"] = str(exc)

        try:
            if "timesfm3" in requested and ENABLE_TIMESFM3_SHADOW and ALLOW_TIMESFM3_NONCOMMERCIAL:
                forecasts.extend(timesfm3_forecasts(item, horizons))
        except Exception as exc:
            runtime["timesfm3_error"] = str(exc)

        response_items.append({
            "eaId": ea_id,
            "forecasts": forecasts,
        })
    if not any(x["forecasts"] for x in response_items):
        raise HTTPException(status_code=503, detail="NO_MODEL_AVAILABLE")

    return {
        "ok": True,
        "version": APP_VERSION,
        "items": response_items,
        "policy": {
            "realObservedSeriesOnly": True,
            "noSyntheticPrices": True,
            "timesfm3ResearchShadowOnly": True,
        },
    }

