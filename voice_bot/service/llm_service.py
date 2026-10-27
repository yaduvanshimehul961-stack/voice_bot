import os
import re
import sys
from dotenv import load_dotenv
from groq import Groq
from src.logger import get_logger
from src.exception import CustomException

logger = get_logger(__name__)
load_dotenv()


class LLMService:

    def __init__(self):
        try:
            api_key = os.getenv("GROQ_API_KEY")

            if not api_key:
                raise ValueError("GROQ_API_KEY is not set in the environment variables.")

            self.client = Groq(api_key=api_key)

            # Use valid, blazing-fast Groq model
            self.model = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")

            logger.info(f"Groq LLM client initialized. Model: {self.model}")

        except Exception as e:
            logger.error("Failed to initialize Groq client")
            raise CustomException(e, sys)

    def generate_response(self, messages):
        """
        Ultra-low latency LLM generation using Groq Llama 3.1 (~80-120ms TTFT).
        """
        try:
            logger.info(f"Generating LLM response using model: {self.model}")

            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0.6,
                max_tokens=100,
            )

            raw_text = response.choices[0].message.content or ""

            # Remove markdown asterisks, hashes, brackets, etc.
            clean_text = re.sub(r"[*_#`~\[\]()]+", "", raw_text)
            clean_text = re.sub(r"\s+", " ", clean_text).strip()

            logger.info(f"Groq response generated: '{clean_text}' ({len(clean_text.split())} words)")
            return clean_text

        except Exception as e:
            logger.error(f"Error generating response from Groq ({self.model}): {e}")
            # Try fallback to llama-3.3-70b-versatile if model name had any issue
            try:
                logger.info("Retrying with fallback model llama-3.3-70b-versatile...")
                fallback_resp = self.client.chat.completions.create(
                    model="llama-3.3-70b-versatile",
                    messages=messages,
                    temperature=0.6,
                    max_tokens=100
                )
                raw_text = fallback_resp.choices[0].message.content or ""
                clean_text = re.sub(r"[*_#`~\[\]()]+", "", raw_text)
                return re.sub(r"\s+", " ", clean_text).strip()
            except Exception as fe:
                logger.error(f"Fallback LLM also failed: {fe}")
                raise CustomException(e, sys)