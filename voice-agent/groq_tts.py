"""Groq text to speech for LiveKit Agents.

Groq serves an OpenAI-shaped /audio/speech endpoint, with two differences that
matter here. It rejects the `stream_format` field that the OpenAI plugin always
sends, answering "unknown field `stream_format` in request body", and it never
replies with an SSE stream, it hands back the audio bytes directly. So this
subclass makes the same call without that field and pushes the bytes through.

Everything else, including the client, the options and the audio decoding, is
the stock OpenAI plugin.
"""

from __future__ import annotations

import httpx
import openai as openai_sdk

from livekit.agents import (
    APIConnectionError,
    APIConnectOptions,
    APIStatusError,
    APITimeoutError,
    tts,
)
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
from livekit.plugins.openai import tts as openai_tts


class GroqTTS(openai_tts.TTS):
    """openai.TTS with the one field Groq will not accept removed."""

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> tts.ChunkedStream:
        return _GroqChunkedStream(tts=self, input_text=text, conn_options=conn_options)


class _GroqChunkedStream(openai_tts.ChunkedStream):
    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        groq_stream = self._tts._client.audio.speech.with_streaming_response.create(
            input=self.input_text,
            model=self._opts.model,
            voice=self._opts.voice,
            response_format=self._opts.response_format,  # type: ignore
            speed=self._opts.speed,
            timeout=httpx.Timeout(30, connect=self._conn_options.timeout),
        )

        try:
            async with groq_stream as stream:
                media_type = stream.headers.get("content-type", "").split(";")[0].strip().lower()
                # Groq declares what it actually sent, fall back to what we asked for.
                mime_type = (
                    media_type
                    if media_type in openai_tts.DECODABLE_CONTENT_TYPES
                    else f"audio/{self._opts.response_format}"
                )
                output_emitter.initialize(
                    request_id=stream.request_id or "",
                    sample_rate=openai_tts.SAMPLE_RATE,
                    num_channels=openai_tts.NUM_CHANNELS,
                    mime_type=mime_type,
                )

                async for chunk in stream.iter_bytes():
                    output_emitter.push(chunk)

                output_emitter.flush()

        except openai_sdk.APITimeoutError:
            raise APITimeoutError() from None
        except openai_sdk.APIStatusError as e:
            raise APIStatusError(
                e.message, status_code=e.status_code, request_id=e.request_id, body=e.body
            ) from None
        except Exception as e:
            raise APIConnectionError() from e
