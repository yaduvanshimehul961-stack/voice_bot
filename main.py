import sys
import time
import base64
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from voice_bot.service.voice_service import VoiceService
from voice_bot.service.llm_service import LLMService
from voice_bot.service.conversation import ConversationService
from src.logger import get_logger
from src.exception import CustomException

logger = get_logger(__name__)
BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Nova Voice AI Assistant")

app.mount(
    "/static",
    StaticFiles(directory=BASE_DIR / "static"),
    name="static"
)

templates = Jinja2Templates(directory=BASE_DIR / "templates")

voice_service = VoiceService()
llm_service = LLMService()
conversation_service = ConversationService()

STOP_COMMANDS = {
    "stop",
    "stop listening",
    "stop now",
    "please stop",
    "okay stop",
    "ok stop",
    "shut up",
    "cancel",
    "khatam",
    "ruko",
    "chup"
}


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    try:
        return templates.TemplateResponse(
            request=request,
            name="index.html"
        )
    except Exception as e:
        logger.error("Error loading home page.")
        raise CustomException(e, sys)


@app.post("/reset")
async def reset_conversation():
    try:
        conversation_service.clear()
        logger.info("Reset conversation called.")
        return JSONResponse(content={"status": "ok", "message": "Conversation reset"})
    except Exception as e:
        logger.error("Error resetting conversation.")
        raise CustomException(e, sys)


@app.post("/chat")
async def chat(
    audio_file: UploadFile = File(...)
):
    req_start = time.perf_counter()
    try:
        logger.info("--> Received audio upload request.")

        audio_data = await audio_file.read()

        if not audio_data or len(audio_data) < 100:
            logger.warning("Empty or too small audio file received.")
            return JSONResponse(
                status_code=400,
                content={
                    "user_text": "",
                    "response_text": "",
                    "audio": None,
                    "stopped": False,
                    "message": "No audio received.",
                    "latency": {"stt_ms": 0, "llm_ms": 0, "tts_ms": 0, "total_ms": 0}
                }
            )

        filename = audio_file.filename or "recording.webm"
        content_type = audio_file.content_type or "audio/webm"

        logger.info(f"Audio received: {len(audio_data)} bytes, type: {content_type}")

        # 1. Speech-to-Text (STT)
        t_stt_start = time.perf_counter()
        user_text = voice_service.speech_to_text(
            audio_data,
            filename=filename,
            content_type=content_type
        )
        stt_ms = int((time.perf_counter() - t_stt_start) * 1000)

        if not user_text:
            logger.warning("STT returned empty text (silence / no speech detected).")
            return JSONResponse(
                content={
                    "user_text": "",
                    "response_text": "Aapki aawaz theek se nahi sunayi di. Kripya thoda paas aakar dobara boliye.",
                    "audio": None,
                    "stopped": False,
                    "use_browser_tts": False,
                    "no_speech": True,
                    "latency": {
                        "stt_ms": stt_ms,
                        "llm_ms": 0,
                        "tts_ms": 0,
                        "total_ms": int((time.perf_counter() - req_start) * 1000)
                    }
                }
            )

        user_text = user_text.strip()
        logger.info(f"User transcription: '{user_text}' (STT took {stt_ms}ms)")

        normalized_text = user_text.lower().strip().replace(".", "").replace("!", "")

        if normalized_text in STOP_COMMANDS:
            logger.info("Stop command matched.")
            conversation_service.add_message("user", user_text)
            return JSONResponse(
                content={
                    "user_text": user_text,
                    "response_text": "Thik hai, main ruk gaya. Jab bhi baat karni ho mic par click karein.",
                    "audio": None,
                    "stopped": True,
                    "latency": {
                        "stt_ms": stt_ms,
                        "llm_ms": 0,
                        "tts_ms": 0,
                        "total_ms": int((time.perf_counter() - req_start) * 1000)
                    }
                }
            )

        conversation_service.add_message("user", user_text)
        messages = conversation_service.get_messages()

        # 2. LLM Generation
        t_llm_start = time.perf_counter()
        response_text = llm_service.generate_response(messages)
        llm_ms = int((time.perf_counter() - t_llm_start) * 1000)

        logger.info(f"AI response: '{response_text}' (LLM took {llm_ms}ms)")
        conversation_service.add_message("assistant", response_text)

        # 3. Text-to-Speech (TTS)
        t_tts_start = time.perf_counter()
        audio_response = voice_service.text_to_speech(response_text)
        tts_ms = int((time.perf_counter() - t_tts_start) * 1000)

        audio_base64 = None
        use_browser_tts = False

        if audio_response is not None:
            if isinstance(audio_response, bytes):
                audio_bytes = audio_response
            else:
                audio_bytes = b"".join(audio_response)
            audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
        else:
            use_browser_tts = True
            logger.info("ElevenLabs audio not returned. Enabling browser Web Speech API fallback.")

        total_ms = int((time.perf_counter() - req_start) * 1000)
        logger.info(f"Round-trip: Total={total_ms}ms | STT={stt_ms}ms | LLM={llm_ms}ms | TTS={tts_ms}ms")

        return JSONResponse(
            content={
                "user_text": user_text,
                "response_text": response_text,
                "audio": audio_base64,
                "use_browser_tts": use_browser_tts,
                "stopped": False,
                "latency": {
                    "stt_ms": stt_ms,
                    "llm_ms": llm_ms,
                    "tts_ms": tts_ms,
                    "total_ms": total_ms
                }
            }
        )

    except Exception as e:
        logger.error(f"Error during chat processing: {e}")
        raise CustomException(e, sys)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)