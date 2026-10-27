import sys
from src.logger import get_logger
from src.exception import CustomException

logger = get_logger(__name__)

SYSTEM_PROMPT = (
    "You are Nova, an ultra-fast, intelligent, and friendly AI voice companion. "
    "Language handling: If the user speaks in Hindi or Hinglish, reply in warm, natural conversational Hinglish. "
    "If the user speaks in English, reply in English. "
    "CRITICAL FOR LOW LATENCY: Keep every response short and direct (1 to 2 sentences, maximum 20-25 words). "
    "Never use markdown formatting, asterisks, bullet points, numbered lists, or emojis because your response is converted directly to speech."
)


class ConversationService:

    def __init__(self):
        try:
            self.messages = [
                {
                    "role": "system",
                    "content": SYSTEM_PROMPT
                }
            ]
            logger.info("Conversation service initialized successfully with low-latency multilingual prompt.")

        except Exception as e:
            logger.error("Failed to initialize Conversation service")
            raise CustomException(e, sys)

    def add_message(self, role, content):
        try:
            self.messages.append({
                "role": role,
                "content": content
            })
            # Sliding window: keep system prompt + last 10 messages for speed and low token count
            if len(self.messages) > 11:
                self.messages = [self.messages[0]] + self.messages[-10:]
            logger.info(f"{role} message added to conversation.")
        except Exception as e:
            logger.error("Error during adding message to conversation.")
            raise CustomException(e, sys)

    def get_messages(self):
        try:
            return self.messages
        except Exception as e:
            logger.error("Error during getting messages from conversation.")
            raise CustomException(e, sys)

    def clear(self):
        self.messages = [
            {
                "role": "system",
                "content": SYSTEM_PROMPT
            }
        ]
        logger.info("Conversation history reset.")