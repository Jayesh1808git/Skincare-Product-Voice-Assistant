import logging
import time
from starlette.requests import Request
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from app.services.agent import ask_aria
from app.services.orders import get_order_details
from app.services.policies import check_cancellation, check_cod
from app.api.sarvam_voice import router as sarvam_voice_router


class ChatMessage(BaseModel):
    role: str
    text: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=3000)
    history: list[ChatMessage] = Field(default_factory=list)
    language_code: str = "en-IN"


app = FastAPI(title="Aura Skincare Voice Agent API")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("aura.performance")


@app.middleware("http")
async def log_request_latency(request: Request, call_next):
    start = time.perf_counter()
    status_code = 500

    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        duration_ms = (time.perf_counter() - start) * 1000
        logger.info(
            "latency operation=http_request method=%s path=%s "
            "duration_ms=%.2f status_code=%s",
            request.method,
            request.url.path,
            duration_ms,
            status_code,
        )

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sarvam_voice_router)


@app.get("/")
def health_check():
    return {"status": "ok", "service": "Aura Skincare API"}


@app.post("/chat")
def chat_with_aria(request: ChatRequest):
    # The frontend sends assistant-role turns; do not filter them out.
    history = [
        {"role": item.role, "text": item.text}
        for item in request.history
        if item.role in ("user", "assistant")
    ]
    language_code = "hi-IN" if request.language_code.strip().lower() == "hi-in" else "en-IN"
    return ask_aria(request.message, history, language_code=language_code)


@app.get("/orders/{order_id}")
def order_lookup(order_id: str):
    order = get_order_details(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found. Please verify the order ID.")
    return order


@app.get("/orders/{order_id}/cancellation")
def cancellation_check(order_id: str):
    order = get_order_details(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return check_cancellation(order)


@app.get("/orders/{order_id}/cod")
def cod_check(order_id: str):
    order = get_order_details(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return check_cod(order["value"])
