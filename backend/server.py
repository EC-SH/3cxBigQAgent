"""BigQuery Agent HTTP API. Wraps the ADK agent in a FastAPI server."""

import os
import sys
import json
import time
import uuid
import warnings
import logging

# Suppress ADK warnings — same filters as the CLI
warnings.filterwarnings("ignore", message=r".*EXPERIMENTAL.*feature.*", category=UserWarning)
warnings.filterwarnings("ignore", message=r".*non-text parts.*", category=UserWarning)
warnings.filterwarnings("ignore", message=r".*GOOGLE_API_KEY.*GEMINI_API_KEY.*", category=UserWarning)
logging.getLogger("google.genai").setLevel(logging.ERROR)
logging.getLogger("google.adk").setLevel(logging.ERROR)

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from bigquery_agent.agent import create_bigquery_agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types


def log(level, msg, **ctx):
    """Structured JSON logging to stdout. Cloud Run picks it up."""
    entry = {"severity": level, "message": msg, "timestamp": time.time()}
    entry.update(ctx)
    print(json.dumps(entry), flush=True)


# --- Fail loud and early ---
if not os.environ.get("GOOGLE_API_KEY"):
    log("CRITICAL", "GOOGLE_API_KEY is not set. Refusing to start.")
    sys.exit(1)

# Remove duplicate key if both are set (same logic as CLI)
if os.environ.get("GOOGLE_API_KEY") and os.environ.get("GEMINI_API_KEY"):
    del os.environ["GEMINI_API_KEY"]


# --- Shared services — survive across requests on the same instance ---
agent = create_bigquery_agent()
session_service = InMemorySessionService()
runner = Runner(
    agent=agent,
    app_name="bigquery_agent",
    session_service=session_service,
)

app = FastAPI(title="BigQuery Agent API", docs_url=None, redoc_url=None)


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/chat")
async def chat(req: ChatRequest):
    request_id = uuid.uuid4().hex[:8]
    log("INFO", "chat_request", request_id=request_id, session_id=req.session_id)

    # Reuse session if the instance is still warm, otherwise create fresh
    session = None
    if req.session_id:
        try:
            session = await session_service.get_session(
                app_name="bigquery_agent",
                user_id="web_user",
                session_id=req.session_id,
            )
        except Exception:
            pass  # Session expired or instance restarted — that's fine, create new

    if not session:
        session = await session_service.create_session(
            app_name="bigquery_agent",
            user_id="web_user",
        )

    content = types.Content(
        role="user",
        parts=[types.Part(text=req.message)],
    )

    response_parts = []
    start = time.time()

    try:
        async for event in runner.run_async(
            user_id="web_user",
            session_id=session.id,
            new_message=content,
        ):
            if hasattr(event, "content") and event.content:
                for part in event.content.parts:
                    if hasattr(part, "text") and part.text:
                        response_parts.append(part.text)
    except Exception as e:
        log("ERROR", "agent_error", request_id=request_id, error=str(e))
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "session_id": session.id},
        )

    response_text = "".join(response_parts)
    duration = time.time() - start

    log(
        "INFO",
        "chat_response",
        request_id=request_id,
        session_id=session.id,
        duration_s=round(duration, 2),
        response_length=len(response_text),
    )

    return {"response": response_text, "session_id": session.id}
