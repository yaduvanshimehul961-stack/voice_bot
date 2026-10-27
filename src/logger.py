import logging
import os
import sys
from datetime import datetime


def get_logger(name):
    logger = logging.getLogger(name)

    if not logger.handlers:
        logger.setLevel(logging.INFO)

        formatter = logging.Formatter(
            "[%(asctime)s] %(lineno)d %(name)s - %(levelname)s - %(message)s"
        )

        # 1. Console Handler (Works everywhere: Local terminal & Vercel Functions Log)
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)

        # 2. File Handler (Protected for Serverless read-only environments like Vercel)
        try:
            is_serverless = (
                "VERCEL" in os.environ
                or "AWS_LAMBDA_FUNCTION_NAME" in os.environ
            )

            # On Vercel/Lambda only /tmp is writable; locally use "logs"
            log_dir = "/tmp/logs" if is_serverless else "logs"
            os.makedirs(log_dir, exist_ok=True)

            log_file = os.path.join(
                log_dir,
                f"{datetime.now().strftime('%Y-%m-%d')}.log"
            )

            file_handler = logging.FileHandler(log_file, encoding="utf-8")
            file_handler.setFormatter(formatter)
            logger.addHandler(file_handler)

        except (OSError, PermissionError):
            # If filesystem is read-only, gracefully continue with console logging
            pass

    return logger