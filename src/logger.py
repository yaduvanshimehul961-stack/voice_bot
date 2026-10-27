import logging
import os
import sys


def get_logger(name):
    logger = logging.getLogger(name)

    if not logger.handlers:
        logger.setLevel(logging.INFO)

        formatter = logging.Formatter(
            "[%(asctime)s] %(lineno)d %(name)s - %(levelname)s - %(message)s"
        )

        # 1. Standard Console Handler (Guaranteed to work on Vercel, AWS, and Local)
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        logger.addHandler(console_handler)

        # 2. File Handler (Only enabled locally, completely disabled on Vercel/Serverless)
        is_serverless = (
            "VERCEL" in os.environ
            or "AWS_LAMBDA_FUNCTION_NAME" in os.environ
            or os.path.exists("/var/task")
        )

        if not is_serverless:
            try:
                from datetime import datetime
                log_dir = "logs"
                os.makedirs(log_dir, exist_ok=True)
                log_file = os.path.join(
                    log_dir,
                    f"{datetime.now().strftime('%Y-%m-%d')}.log"
                )
                file_handler = logging.FileHandler(log_file, encoding="utf-8")
                file_handler.setFormatter(formatter)
                logger.addHandler(file_handler)
            except Exception:
                pass

    return logger