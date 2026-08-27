import os

from dotenv import load_dotenv

from livekit import agents
from livekit.agents import AgentSession, Agent, RoomInputOptions
from livekit.plugins import (
    noise_cancellation,
    openai,
    silero,
)
from groq_tts import GroqTTS
from prompts import AGENT_INSTRUCTION, SESSION_INSTRUCTION
from tools import (
    get_business_summary,
    get_invoice_status,
    get_order_status,
    get_order_summary,
    list_orders,
    list_overdue_invoices,
    list_unattended_orders,
    list_unpaid_invoices,
    mark_order_fulfilled,
    send_mpesa_prompt,
    send_mpesa_prompt_for_order,
    send_payment_reminder,
)

load_dotenv()

# Groq speaks the OpenAI API dialect, so the OpenAI plugin drives it
# once it is pointed at Groq's base URL.
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GROQ_API_KEY = os.getenv("GROQ_API_KEY")


class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=AGENT_INSTRUCTION,
            tools=[
                list_overdue_invoices,
                list_unpaid_invoices,
                list_unattended_orders,
                list_orders,
                get_invoice_status,
                get_order_status,
                get_order_summary,
                mark_order_fulfilled,
                send_payment_reminder,
                send_mpesa_prompt,
                send_mpesa_prompt_for_order,
                get_business_summary,
            ],
        )


def prewarm(proc: agents.JobProcess):
    # Load the VAD model once per worker process instead of once per call.
    # The default threshold of 0.5 treats room hum and the agent's own voice
    # coming back through the speakers as speech, so the turn never ends.
    proc.userdata["vad"] = silero.VAD.load(
        activation_threshold=float(os.getenv("VAD_THRESHOLD", "0.6")),
        min_silence_duration=0.6,
    )


async def entrypoint(ctx: agents.JobContext):
    session = AgentSession(
        # Ears: Whisper on Groq. Batch transcription, not the realtime
        # websocket, which Groq does not serve.
        stt=openai.STT(
            model=os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo"),
            language="en",
            use_realtime=False,
            api_key=GROQ_API_KEY,
            base_url=GROQ_BASE_URL,
        ),
        # Brain: gpt-oss-120b is a reasoning model, so keep the effort low
        # or Friday thinks for a second before every sentence.
        llm=openai.LLM(
            model=os.getenv("GROQ_LLM_MODEL", "openai/gpt-oss-120b"),
            temperature=0.8,
            reasoning_effort="low",
            api_key=GROQ_API_KEY,
            base_url=GROQ_BASE_URL,
        ),
        # Voice: Orpheus on Groq. Voices are troy, hannah and austin.
        tts=GroqTTS(
            model=os.getenv("GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english"),
            voice=os.getenv("GROQ_TTS_VOICE", "hannah"),
            response_format="wav",
            api_key=GROQ_API_KEY,
            base_url=GROQ_BASE_URL,
        ),
        vad=ctx.proc.userdata["vad"],
    )

    await session.start(
        room=ctx.room,
        agent=Assistant(),
        room_input_options=RoomInputOptions(
            # LiveKit Cloud enhanced noise cancellation
            # - If self-hosting, omit this parameter
            # - For telephony applications, use `BVCTelephony` for best results
            noise_cancellation=noise_cancellation.BVC(),
        ),
    )

    await ctx.connect()

    await session.generate_reply(
        instructions=SESSION_INSTRUCTION,
    )


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm)
    )
