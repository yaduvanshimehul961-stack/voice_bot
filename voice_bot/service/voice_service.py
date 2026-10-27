import os
import sys

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from groq import Groq

from src.logger import get_logger
from src.exception import CustomException

logger = get_logger(__name__)
load_dotenv()


class VoiceService:

    def __init__(self):
        try:
            # 1. Initialize Groq client for ultra-low latency STT (Whisper Large V3 Turbo: ~150-200ms)
            groq_api_key = os.getenv("GROQ_API_KEY")
            if groq_api_key:
                self.groq_client = Groq(api_key=groq_api_key)
                logger.info("Groq STT client initialized successfully.")
            else:
                self.groq_client = None
                logger.warning("GROQ_API_KEY not found. Fallback to ElevenLabs STT will be used.")

            # 2. Initialize ElevenLabs client for TTS
            api_key = os.getenv("ELEVENLABS_API_KEY")
            if not api_key:
                raise ValueError("ELEVENLABS_API_KEY is not set in the environment variables.")

            self.client = ElevenLabs(api_key=api_key)
            self.voice_id = os.getenv("ELEVENLABS_VOICE_ID")

            if not self.voice_id:
                raise ValueError("ELEVENLABS_VOICE_ID is not set in the environment variables.")

            logger.info("ElevenLabs client initialized successfully.")

        except Exception as e:
            logger.error("Failed to initialize VoiceService clients")
            raise CustomException(e, sys)

    def speech_to_text(
        self,
        audio_file,
        filename="recording.webm",
        content_type="audio/webm"
    ):
        """
        Ultra-fast STT conversion using Groq Whisper Turbo (~150-250ms).
        Supports English, Hindi, and Hinglish.
        """
        # Primary: Groq Whisper Turbo (Lowest Latency: ~150-250ms)
        if self.groq_client:
            try:
                logger.info(f"Starting STT conversion via Groq Whisper Turbo (audio size: {len(audio_file)} bytes).")
                # Passing ("recording.webm", audio_file) directly works seamlessly in Groq/OpenAI client
                file_tuple = ("recording.webm", audio_file)
                transcription = self.groq_client.audio.transcriptions.create(
                    file=file_tuple,
                    model="whisper-large-v3-turbo",
                    prompt="Hindi, Hinglish, English conversation",
                    response_format="json",
                    temperature=0.0
                )
                text = transcription.text if hasattr(transcription, "text") else getattr(transcription, "content", str(transcription))
                cleaned_text = (text or "").strip()
                logger.info(f"Groq Whisper STT transcribed: '{cleaned_text}'")
                return cleaned_text
            except Exception as ge:
                logger.warning(f"Groq Whisper STT encountered an error: {ge}. Trying fallback...")

        # Fallback: ElevenLabs STT
        if self.client:
            try:
                logger.info("Starting fallback STT conversion via ElevenLabs.")
                file_data = (filename, audio_file, "audio/webm")
                result = self.client.speech_to_text.convert(
                    file=file_data,
                    model_id="scribe_v2"
                )
                text = (result.text or "").strip() if hasattr(result, "text") else ""
                logger.info(f"ElevenLabs fallback STT transcribed: '{text}'")
                return text
            except Exception as e:
                logger.error(f"ElevenLabs fallback STT failed: {e}")

        return ""

    def text_to_speech(self, text):
        """
        Ultra-low latency TTS using ElevenLabs Flash v2.5.
        Gracefully returns None if quota is exceeded or an error occurs so browser TTS can take over.
        """
        try:
            logger.info(f"Starting text-to-speech conversion for: '{text}'")

            # ElevenLabs Flash v2.5 with minimum latency preset and lightweight MP3 format
            try:
                audio = self.client.text_to_speech.convert(
                    voice_id=self.voice_id,
                    model_id="eleven_flash_v2_5",
                    text=text,
                    output_format="mp3_22050_32",
                    optimize_streaming_latency=4
                )
            except TypeError:
                audio = self.client.text_to_speech.convert(
                    voice_id=self.voice_id,
                    model_id="eleven_flash_v2_5",
                    text=text
                )

            logger.info("ElevenLabs text-to-speech completed successfully.")
            return audio

        except Exception as e:
            logger.warning(f"ElevenLabs TTS failed ({e}). Returning None so browser fallback TTS can play speech.")
            return None