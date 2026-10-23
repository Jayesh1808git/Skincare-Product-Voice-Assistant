import base64
import os
from app.core.metrics import measure_latency
import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

router = APIRouter(prefix="/voice", tags=["Sarvam Voice"])

SARVAM_BASE_URL = "https://api.sarvam.ai"


def get_sarvam_key() -> str:
    key = os.getenv("SARVAM_API_KEY", "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="SARVAM_API_KEY is missing from the backend environment.",
        )
    return key


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    voice_mode: str = Form("en-IN"),
):
    """
    Transcribe one short customer utterance using Sarvam Saaras v4.
    The browser sends one recording per turn; keep each recording under 30 sec.
    """
    api_key = get_sarvam_key()
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="No audio was received.")

    # MediaRecorder commonly reports "audio/webm;codecs=opus". Sarvam
    # accepts "audio/webm", but rejects the codec parameter in the MIME type.
    content_type = (file.content_type or "audio/webm").split(";", 1)[0].strip().lower()
    allowed_types = {
        "audio/webm", "video/webm", "audio/ogg", "audio/opus",
        "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3",
        "audio/mp4", "audio/x-m4a", "audio/aac", "audio/flac",
    }
    if content_type not in allowed_types:
        content_type = "audio/webm"
    filename = file.filename or "customer-utterance.webm"

    headers = {"api-subscription-key": api_key}
    files = {"file": (filename, audio, content_type)}
    normalized_mode = voice_mode.strip().lower()
    if normalized_mode not in {"en-in", "hi-in"}:
        normalized_mode = "en-in"

    data = {
        "model": "saaras:v4",
        "mode": "codemix" if normalized_mode == "hi-in" else "transcribe",
        "language_code": "hi-IN" if normalized_mode == "hi-in" else "en-IN",
        # Bias the recognizer toward order IDs and brand vocabulary.
        "keyterms": '["Aura Skincare", "order ID", "ORD-101", "ORD-102", "ORD-103", "Vitamin C Serum", "Hydrating Sunscreen", "Green Tea Face Wash"]',
    }

    try:
        with measure_latency("sarvam_stt"):
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(
                    f"{SARVAM_BASE_URL}/speech-to-text",
                    headers=headers,
                    files=files,
                    data=data,
                )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Sarvam transcription request failed: {exc}") from exc

    if response.is_error:
        # Do not expose credentials or request headers in errors.
        raise HTTPException(
            status_code=response.status_code if response.status_code < 500 else 502,
            detail=f"Sarvam STT error ({response.status_code}): {response.text[:500]}",
        )

    payload = response.json()
    transcript = (payload.get("transcript") or "").strip()
    if not transcript:
        print(f"Sarvam STT returned no transcript. Response: {payload}")
        raise HTTPException(status_code=422, detail="Sarvam could not detect clear speech. Please try again.")
    return {"transcript": transcript, "language_code": payload.get("language_code")}


@router.post("/speak")
async def synthesize_speech(payload: dict):
    """Convert Aria's response to MP3 using Sarvam Bulbul v3."""
    api_key = get_sarvam_key()
    text = str(payload.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required.")
    if len(text) > 2400:
        text = text[:2400]

    requested_language = str(payload.get("language_code", "en-IN")).strip()
    language_code = "hi-IN" if requested_language.lower() == "hi-in" else "en-IN"

    body = {
        "text": text,
        "model": "bulbul:v3",
        "language_code": language_code,
        "speaker": "simran",
        "pace": 1.0,
        "speech_sample_rate": 22050,
        "output_audio_codec": "mp3",
    }
    headers = {
        "api-subscription-key": api_key,
        "Content-Type": "application/json",
    }

    try:
        with measure_latency("sarvam_tts"):
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(
                    f"{SARVAM_BASE_URL}/text-to-speech",
                    headers=headers,
                    json=body,
                )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Sarvam speech request failed: {exc}") from exc

    if response.is_error:
        raise HTTPException(
            status_code=response.status_code if response.status_code < 500 else 502,
            detail=f"Sarvam TTS error ({response.status_code}): {response.text[:500]}",
        )

    payload = response.json()
    audios = payload.get("audios") or []
    if not audios:
        raise HTTPException(status_code=502, detail="Sarvam returned no audio.")
    try:
        audio_bytes = base64.b64decode(audios[0])
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="Sarvam returned invalid audio data.") from exc

    return Response(content=audio_bytes, media_type="audio/mpeg")
