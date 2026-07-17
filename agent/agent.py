"""
Garely — LiveKit Agent with Deepgram STT + DeepSeek Post-Meeting Analysis

This agent:
1. Joins LiveKit rooms automatically via webhook
2. Subscribes to all audio tracks
3. Runs Deepgram Nova-3 multilingual STT (RU/UK/EN code-switching)
4. Publishes live transcription to room via data channel
5. Stores transcript segments via the Next.js API
6. On room end, sends full transcript to DeepSeek for summary/tasks/decisions
7. Fetches API keys from DB via settings API (hot-reload without restart)
"""

import asyncio
import inspect
import io
import json
import logging
import os
import re
import wave
from datetime import datetime

import httpx
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    JobProcess,
    WorkerOptions,
    cli,
    stt as stt_module,
)
from livekit.plugins.deepgram import STT

load_dotenv()

logger = logging.getLogger("eam-meet-agent")
logger.setLevel(logging.INFO)

# Config
APP_URL = os.getenv("APP_URL", "http://localhost:3000")
# Shared secret for the app's internal endpoints (webhooks + key sync).
INTERNAL_KEY = os.getenv("INTERNAL_API_SECRET") or os.getenv("NEXTAUTH_SECRET") or os.getenv("AUTH_SECRET") or ""

# Live in-meeting AI (running notes + action-item chips) ALWAYS uses the fast
# model, NOT the configured report model. A reasoning model (e.g. deepseek-v4-pro)
# spends the small live token budget on hidden reasoning and returns empty
# content, so live features silently break. The post-meeting report (generated in
# the Next.js app) still honours the configured DEEPSEEK_MODEL.
LIVE_MODEL = "deepseek-v4-flash"

# Initial keys from env (will be overridden by DB values)
_cached_keys: dict[str, str] = {
    "DEEPSEEK_API_KEY": os.getenv("DEEPSEEK_API_KEY", ""),
    "DEEPSEEK_BASE_URL": os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    "DEEPGRAM_API_KEY": os.getenv("DEEPGRAM_API_KEY", ""),
}
# Secrets whose presence gates the cache; an empty value means "not configured yet".
SECRET_KEYS = ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPGRAM_API_KEY")
# Workspace settings served to internal callers. Empty is a meaningful value for these
# (an admin clearing the glossary), so they are cached even when blank.
WS_KEYS = ("WS_LANGUAGE", "WS_GLOSSARY")
_keys_last_fetched: float = 0

# Per-speaker audio capture: the agent writes one WAV per participant into this
# shared volume so we can later detect each speaker's language and re-transcribe
# a single speaker. An empty/unwritable dir disables capture.
SPEAKER_AUDIO_DIR = os.getenv("SPEAKER_AUDIO_DIR", "/speaker-audio") or ""
if SPEAKER_AUDIO_DIR:
    try:
        os.makedirs(SPEAKER_AUDIO_DIR, exist_ok=True)
    except Exception as _e:
        logger.warning(f"speaker-audio dir unavailable ({SPEAKER_AUDIO_DIR}): {_e}")
        SPEAKER_AUDIO_DIR = ""
MIN_TRACK_SEC = 3.0  # discard speaker tracks shorter than this
LANG_DETECT_MIN_CONF = 0.70      # store spokenLanguage only at/above this confidence
LANG_PRIOR_OVERRIDE_CONF = 0.85  # below this, trust the UI prior for the uk↔ru pair


async def fetch_api_keys() -> dict[str, str]:
    """Fetch latest API keys from the app's settings API."""
    global _cached_keys, _keys_last_fetched
    import time

    # Cache for 60 seconds to avoid hammering the API. Only the SECRET keys are checked for
    # presence here — WS_* are workspace settings that are legitimately empty, and including
    # them would make all() false forever and re-fetch on every call.
    now = time.time()
    if now - _keys_last_fetched < 60 and all(_cached_keys[k] for k in SECRET_KEYS if k in _cached_keys):
        return _cached_keys

    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{APP_URL}/api/settings/keys", headers={"x-internal-key": INTERNAL_KEY}, timeout=10)
            if res.status_code == 200:
                data = res.json()
                for key_name, key_data in data.items():
                    if not isinstance(key_data, dict):
                        continue
                    val = key_data.get("value")
                    # Cache empty values for workspace settings only: clearing the glossary
                    # must actually clear it, but an empty secret must not clobber the env
                    # fallback.
                    if val or (key_name in WS_KEYS and val is not None):
                        _cached_keys[key_name] = val or ""
                _keys_last_fetched = now
                logger.info("API keys refreshed from DB")
            else:
                logger.warning(f"Failed to fetch keys: {res.status_code}")
    except Exception as e:
        logger.warning(f"Could not fetch API keys from DB, using cached/env: {e}")

    return _cached_keys


def prewarm(proc: JobProcess):
    """Pre-warm: initialize Deepgram STT plugin."""
    dgram_key = os.getenv("DEEPGRAM_API_KEY", "")
    proc.userdata["stt"] = STT(
        api_key=dgram_key,
        language=os.getenv("DEEPGRAM_LANGUAGE", "multi"),
        model=os.getenv("DEEPGRAM_MODEL", "nova-3"),
        smart_format=True,
        no_delay=True,
        endpointing_ms=500,
        interim_results=True,
        punctuate=True,
    )


def _glossary_terms(keys: dict[str, str]) -> list[str]:
    """Workspace glossary → term list. One per line; capped to Deepgram's keywords limit."""
    raw = keys.get("WS_GLOSSARY", "") or ""
    seen: set[str] = set()
    out: list[str] = []
    for line in raw.splitlines():
        t = line.strip()[:60]
        if not t or t.lower() in seen:
            continue
        seen.add(t.lower())
        out.append(t)
        if len(out) >= 100:
            break
    return out


def _boost_kwargs(model: str, terms: list[str]) -> dict:
    """Deepgram term boosting, shaped for the model generation AND the plugin's kwarg type.

    `keyterm` (nova-3) and `keywords` (nova-2 and older) are NOT aliases — each model rejects
    the other's parameter. Measured on real calls: nova-2 + keywords recovers a product name
    the ASR otherwise mangles, with no side effects; nova-3 + keyterm recovers it too but
    silently deletes unrelated domain words, which is why nova-2 stays the prod default.

    CRUCIAL: the two kwargs take DIFFERENT value shapes in the plugin — `keyterm` wants
    plain strings (list[str]) but `keywords` wants (term, intensifier) TUPLES
    (list[tuple[str, float]]). Passing strings to `keywords` raises at STT construction and
    kills live transcription, so the value is built to match the accepted parameter's type.
    Intensifier 1.0 = Deepgram's default weight (what the REST eval used).

    The installed plugin version is not pinned, so the kwarg is only passed when this build
    actually accepts it — an unknown plugin degrades to today's behaviour, never raises.
    """
    if not terms:
        return {}
    try:
        accepted = inspect.signature(STT.__init__).parameters
    except (TypeError, ValueError):
        return {}
    if model.startswith("nova-3"):
        if "keyterm" in accepted:
            return {"keyterm": terms}
        if "keyterms" in accepted:
            return {"keyterms": terms}
        logger.warning("deepgram plugin accepts no keyterm param — glossary skipped")
        return {}
    if "keywords" in accepted:
        return {"keywords": [(t, 1.0) for t in terms]}
    logger.warning("deepgram plugin accepts no keywords param — glossary skipped")
    return {}


def participant_language(participant: rtc.RemoteParticipant) -> str | None:
    """Read a participant's transcription language from their LiveKit token
    metadata ({"lang": "uk"}). The app sets this to the user's learned
    spokenLanguage, falling back to their UI-language prior. Returns None for
    guests / no metadata (caller then uses the workspace default)."""
    raw = (getattr(participant, "metadata", "") or "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
        lang = data.get("lang")
        if isinstance(lang, str) and lang.strip():
            return lang.strip()
    except Exception:
        pass
    return None


def _open_audio_stream(participant: rtc.RemoteParticipant) -> rtc.AudioStream:
    """Subscribe to a participant's mic. Prefer 16 kHz mono (smaller WAVs, ideal
    for Deepgram); fall back to SDK defaults if those kwargs aren't supported."""
    try:
        return rtc.AudioStream.from_participant(
            participant=participant,
            track_source=rtc.TrackSource.SOURCE_MICROPHONE,
            sample_rate=16000,
            num_channels=1,
        )
    except TypeError:
        return rtc.AudioStream.from_participant(
            participant=participant,
            track_source=rtc.TrackSource.SOURCE_MICROPHONE,
        )


async def create_stt_for_language(lang: str | None) -> STT | None:
    """Create a Deepgram STT bound to a specific language (one per participant).

    `lang` comes from the participant's token metadata. When absent we fall back
    to the workspace language (WS_LANGUAGE), then DEEPGRAM_LANGUAGE."""
    keys = await fetch_api_keys()
    dgram_key = keys.get("DEEPGRAM_API_KEY", "")
    if not dgram_key:
        return None
    resolved = (lang or keys.get("WS_LANGUAGE") or keys.get("DEEPGRAM_LANGUAGE", "multi")).strip()
    model = keys.get("DEEPGRAM_MODEL", "nova-3")
    # 'multi' (code-switching) is only supported on nova-3. If an admin set
    # nova-2 + multi, bump the model so the stream doesn't error.
    if resolved == "multi" and not model.startswith("nova-3"):
        model = "nova-3"
    return STT(
        api_key=dgram_key,
        language=resolved,
        model=model,
        smart_format=True,
        no_delay=True,
        endpointing_ms=500,
        interim_results=True,
        punctuate=True,
        **_boost_kwargs(model, _glossary_terms(keys)),
    )


async def create_stt_with_latest_key() -> STT | None:
    """STT in the workspace/default language (used as a fallback)."""
    return await create_stt_for_language(None)


async def report_screen_segment(meeting_id: str, room_name: str, track_sid: str, action: str):
    """Tell the app a screen-share video track started/stopped so it can record it as a
    passthrough TrackEgress segment (B2-lite "screen-audio" recording). Server-side this
    is a no-op unless a screen-audio recording is currently active for the meeting."""
    if not meeting_id or not track_sid:
        return
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{APP_URL}/api/webhooks/recording-screen",
                json={"meetingId": meeting_id, "roomName": room_name, "trackId": track_sid, "action": action},
                headers={"x-internal-key": INTERNAL_KEY},
                timeout=10,
            )
        logger.info(f"screen-share {action}: track={track_sid}")
    except Exception as e:
        logger.warning(f"report_screen_segment {action} failed: {e}")


async def entrypoint(ctx: JobContext):
    """Main agent entrypoint — runs per room."""
    logger.info(f"Agent joining room: {ctx.room.name}")

    room_name = ctx.room.name
    meeting_id = await get_meeting_id(room_name)
    if not meeting_id:
        logger.warning(f"Could not find meeting for room {room_name}")
        return

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    # Try to get latest Deepgram key, fall back to prewarm STT
    fresh_stt = await create_stt_with_latest_key()
    stt: STT = fresh_stt if fresh_stt else ctx.proc.userdata["stt"]

    transcript_segments: list[dict] = []
    speaker_recordings: dict[str, dict] = {}
    segment_counter = 0
    last_ai_notes_count = 0  # Track when we last sent AI notes

    async def maybe_send_live_ai_notes():
        """Periodically generate and broadcast live AI notes every ~20 segments."""
        nonlocal last_ai_notes_count
        current_count = len(transcript_segments)
        # Only trigger if we have enough new segments (at least 20 since last update)
        if current_count < 10 or current_count - last_ai_notes_count < 20:
            return
        last_ai_notes_count = current_count
        try:
            keys = await fetch_api_keys()
            deepseek_key = keys.get("DEEPSEEK_API_KEY", "")
            deepseek_base = keys.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
            lang_name = "Ukrainian" if keys.get("WS_LANGUAGE", "en") == "uk" else "English"
            if not deepseek_key:
                return

            recent = transcript_segments[-60:]  # Last ~60 segments for context
            text = "\n".join(
                f"[{s.get('language', '??').upper()}] {s['speakerName']}: {s['content']}"
                for s in recent
            )

            async with httpx.AsyncClient() as client:
                res = await client.post(
                    f"{deepseek_base}/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {deepseek_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": LIVE_MODEL,
                        "messages": [
                            {"role": "system", "content": "You are a live meeting analyst. Respond with valid JSON only. Be concise."},
                            {"role": "user", "content": f"Analyze this partial meeting transcript. Respond in {lang_name}.\n\n{text}\n\nJSON format:\n{{\"summary\": \"1-2 sentence summary of the current discussion\", \"decisions\": [\"decision\"], \"action_items\": [\"task\"]}}"},
                        ],
                        "response_format": {"type": "json_object"},
                        "temperature": 0.3,
                        # Generous headroom: a configured reasoning model spends
                        # part of the budget on hidden reasoning before the JSON.
                        "max_tokens": 2500,
                    },
                    timeout=30,
                )
                if res.status_code == 200:
                    data = res.json()
                    content = data["choices"][0]["message"]["content"]
                    notes = json.loads(content)
                    await ctx.room.local_participant.publish_data(
                        json.dumps({
                            "type": "ai-notes",
                            "summary": notes.get("summary", ""),
                            "decisions": notes.get("decisions", []),
                            "action_items": notes.get("action_items", []),
                        }),
                        topic="ai-notes",
                    )
                    logger.info("Live AI notes broadcast")
        except Exception as e:
            logger.warning(f"Failed to generate live AI notes: {e}")

    async def detect_action_item(text: str, speaker: str):
        """Check if a transcript segment contains an action item and broadcast it."""
        action_keywords = [
            "треба", "потрібно", "зроби", "зробити", "зробимо",
            "давай", "до п'ятниці", "до завтра", "до кінця тижня",
            "need to", "should", "will do", "let's do", "make sure",
            "must", "deadline", "action item", "таск", "задача",
            "відповідальний", "візьми на себе", "доручаю",
        ]
        lower_text = text.lower()
        if not any(kw in lower_text for kw in action_keywords):
            return
        if len(text) < 15:
            return

        try:
            keys = await fetch_api_keys()
            deepseek_key = keys.get("DEEPSEEK_API_KEY", "")
            deepseek_base = keys.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
            lang_name = "Ukrainian" if keys.get("WS_LANGUAGE", "en") == "uk" else "English"
            if not deepseek_key:
                return

            async with httpx.AsyncClient() as client:
                res = await client.post(
                    f"{deepseek_base}/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {deepseek_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": LIVE_MODEL,
                        "messages": [
                            {"role": "system", "content": "You detect action items from meeting speech. Return JSON. If the text does NOT contain an action item, return {\"is_action\": false}. If it does, return {\"is_action\": true, \"title\": \"concise task in " + lang_name + "\", \"assignee\": \"name or null\"}."},
                            {"role": "user", "content": f"Speaker: {speaker}\nText: {text}"},
                        ],
                        "response_format": {"type": "json_object"},
                        "temperature": 0.2,
                        # Headroom for reasoning models (else content comes back empty).
                        "max_tokens": 1200,
                    },
                    timeout=15,
                )
                if res.status_code == 200:
                    data = res.json()
                    result = json.loads(data["choices"][0]["message"]["content"])
                    if result.get("is_action"):
                        await ctx.room.local_participant.publish_data(
                            json.dumps({
                                "type": "action-detected",
                                "title": result.get("title", text[:80]),
                                "assignee": result.get("assignee"),
                            }),
                            topic="action-items",
                        )
                        logger.info(f"Action item detected: {result.get('title')}")
        except Exception as e:
            logger.warning(f"Action item detection failed: {e}")

    async def process_participant(participant: rtc.RemoteParticipant):
        nonlocal segment_counter

        lang = participant_language(participant)
        logger.info(
            f"Processing audio for: {participant.identity} ({participant.name}) "
            f"lang={lang or 'fallback'}"
        )

        audio_stream = _open_audio_stream(participant)

        # Each participant gets their own STT bound to their language.
        participant_stt = await create_stt_for_language(lang)
        if participant_stt is None:
            participant_stt = stt  # fall back to the prewarmed/default STT
        stt_stream = participant_stt.stream()

        # Per-speaker audio capture (WAV) for post-meeting language detection and
        # single-speaker re-transcription.
        rec: dict = {"wav": None, "path": None, "frames": 0, "sr": 0}
        if SPEAKER_AUDIO_DIR:
            safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", participant.identity)[:60]
            rec["path"] = os.path.join(SPEAKER_AUDIO_DIR, f"{meeting_id}__{safe_id}.wav")

        async def feed_audio():
            try:
                async for event in audio_stream:
                    if isinstance(event, rtc.AudioFrameEvent):
                        frame = event.frame
                        stt_stream.push_frame(frame)
                        if rec["path"]:
                            try:
                                if rec["wav"] is None:
                                    rec["sr"] = frame.sample_rate
                                    w = wave.open(rec["path"], "wb")
                                    w.setnchannels(frame.num_channels)
                                    w.setsampwidth(2)  # int16 PCM
                                    w.setframerate(frame.sample_rate)
                                    rec["wav"] = w
                                rec["wav"].writeframes(bytes(frame.data))
                                rec["frames"] += frame.samples_per_channel
                            except Exception as e:
                                logger.warning(f"speaker-audio write failed for {participant.identity}: {e}")
                                rec["path"] = None  # stop trying for this participant
            except Exception as e:
                logger.error(f"Audio stream error for {participant.identity}: {e}")

        async def process_results():
            nonlocal segment_counter
            try:
                async for event in stt_stream:
                    ev_type = event.type

                    if ev_type == stt_module.SpeechEventType.INTERIM_TRANSCRIPT:
                        if event.alternatives:
                            alt = event.alternatives[0]
                            interim_text = alt.text.strip()
                            if interim_text:
                                lang = str(getattr(alt, "language", "uk") or "uk")
                                try:
                                    await ctx.room.local_participant.publish_data(
                                        json.dumps({
                                            "type": "transcription",
                                            "speaker": participant.name or participant.identity,
                                            "text": interim_text,
                                            "language": lang,
                                            "isFinal": False,
                                        }),
                                        topic="transcription",
                                    )
                                except Exception:
                                    pass

                    elif ev_type == stt_module.SpeechEventType.FINAL_TRANSCRIPT:
                        if not event.alternatives:
                            continue
                        alt = event.alternatives[0]
                        text = alt.text.strip()
                        if not text:
                            continue

                        language = str(getattr(alt, "language", "uk") or "uk")
                        start_time = getattr(alt, "start_time", segment_counter * 5.0)
                        end_time = getattr(alt, "end_time", segment_counter * 5.0 + 4.0)
                        confidence = getattr(alt, "confidence", 0.95)

                        segment = {
                            "speakerName": participant.name or participant.identity,
                            "speakerId": participant.identity if not participant.identity.startswith("guest-") else None,
                            "content": text,
                            "language": language,
                            "startTime": start_time,
                            "endTime": end_time,
                            "confidence": confidence,
                        }

                        transcript_segments.append(segment)
                        segment_counter += 1

                        logger.info(f"[{language.upper()}] {participant.name}: {text}")

                        try:
                            await ctx.room.local_participant.publish_data(
                                json.dumps({
                                    "type": "transcription",
                                    "speaker": participant.name or participant.identity,
                                    "text": text,
                                    "language": language,
                                    "timestamp": start_time,
                                    "isFinal": True,
                                }),
                                topic="transcription",
                            )
                        except Exception as pub_err:
                            logger.warning(f"Failed to publish transcription: {pub_err}")

                        await store_segment(meeting_id, segment)

                        # Trigger live AI features (non-blocking)
                        asyncio.create_task(maybe_send_live_ai_notes())
                        asyncio.create_task(detect_action_item(text, participant.name or participant.identity))

            except Exception as e:
                logger.error(f"STT stream error for {participant.identity}: {e}")
                import traceback
                logger.error(traceback.format_exc())

        feed_task = asyncio.create_task(feed_audio())
        process_task = asyncio.create_task(process_results())

        try:
            await asyncio.gather(feed_task, process_task)
        except Exception as e:
            logger.error(f"Error processing {participant.identity}: {e}")
        finally:
            # Close the WAV first (sync — always runs, even on cancellation) and
            # stash its info; the room-end handler detects/registers each track.
            if rec["wav"] is not None:
                try:
                    rec["wav"].close()
                except Exception:
                    pass
                dur = rec["frames"] / rec["sr"] if rec["sr"] else 0.0
                speaker_recordings[participant.identity] = {
                    "identity": participant.identity,
                    "speakerId": participant.identity if not participant.identity.startswith("guest-") else None,
                    "speakerName": participant.name or participant.identity,
                    "path": rec["path"],
                    "durationSec": dur,
                    "priorLang": lang,
                }
            await stt_stream.aclose()

    participant_tasks: dict[str, asyncio.Task] = {}

    @ctx.room.on("participant_connected")
    def on_participant_connected(participant: rtc.RemoteParticipant):
        if participant.identity not in participant_tasks:
            task = asyncio.create_task(process_participant(participant))
            participant_tasks[participant.identity] = task

    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(participant: rtc.RemoteParticipant):
        task = participant_tasks.pop(participant.identity, None)
        if task:
            task.cancel()

    # Screen-share lifecycle → drive the B2-lite screen recording (TrackEgress segment).
    @ctx.room.on("track_published")
    def on_track_published(pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
        try:
            if pub.source == rtc.TrackSource.SOURCE_SCREENSHARE:
                asyncio.create_task(report_screen_segment(meeting_id, room_name, pub.sid, "start"))
        except Exception as e:
            logger.warning(f"track_published handler error: {e}")

    @ctx.room.on("track_unpublished")
    def on_track_unpublished(pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
        try:
            if pub.source == rtc.TrackSource.SOURCE_SCREENSHARE:
                asyncio.create_task(report_screen_segment(meeting_id, room_name, pub.sid, "stop"))
        except Exception as e:
            logger.warning(f"track_unpublished handler error: {e}")

    for participant in ctx.room.remote_participants.values():
        if participant.identity not in participant_tasks:
            task = asyncio.create_task(process_participant(participant))
            participant_tasks[participant.identity] = task

    disconnect_event = asyncio.Event()

    @ctx.room.on("disconnected")
    def on_disconnected():
        disconnect_event.set()

    await disconnect_event.wait()

    logger.info(f"Room ended. Total segments: {len(transcript_segments)}")

    # Generate the AI report FIRST — it's the critical output, and the framework
    # only allows a limited shutdown window after the room disconnects. Doing it
    # before the (slower-to-be-cancelled) per-track work ensures the report is
    # never starved.
    if transcript_segments:
        await generate_report(meeting_id, transcript_segments)

    # Then finalize per-speaker tracks: close WAVs, detect language, register.
    for task in participant_tasks.values():
        task.cancel()
    await asyncio.gather(*participant_tasks.values(), return_exceptions=True)

    for info in speaker_recordings.values():
        await finalize_speaker_track(meeting_id, info)


async def get_meeting_id(room_name: str) -> str | None:
    """Look up meeting ID by LiveKit room name."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(
                f"{APP_URL}/api/meetings",
                params={"livekitRoom": room_name},
                headers={"x-internal-key": INTERNAL_KEY},
                timeout=10,
            )
            if res.status_code == 200:
                meetings = res.json()
                if meetings and len(meetings) > 0:
                    return meetings[0]["id"]
    except Exception as e:
        logger.error(f"Failed to get meeting ID: {e}")
    return None


async def store_segment(meeting_id: str, segment: dict):
    """Store a transcript segment via the app API, retrying transient failures."""
    payload = {"meetingId": meeting_id, **segment}
    headers = {"x-internal-key": INTERNAL_KEY}
    for attempt in range(3):
        try:
            async with httpx.AsyncClient() as client:
                res = await client.post(
                    f"{APP_URL}/api/webhooks/transcript",
                    json=payload,
                    headers=headers,
                    timeout=10,
                )
            if res.status_code < 500:
                return  # 2xx ok, or a 4xx that retrying won't fix
            logger.warning(f"store_segment HTTP {res.status_code} (attempt {attempt + 1})")
        except Exception as e:
            logger.error(f"Failed to store segment (attempt {attempt + 1}): {e}")
        await asyncio.sleep(1.5 * (attempt + 1))
    logger.error("store_segment: giving up after 3 attempts")


async def register_speaker_track(meeting_id: str, info: dict):
    """Register a captured per-speaker audio file as a SpeakerTrack row."""
    path = info.get("path") or ""
    try:
        file_size = os.path.getsize(path) if path and os.path.exists(path) else None
    except Exception:
        file_size = None
    payload = {
        "meetingId": meeting_id,
        "participantIdentity": info.get("identity"),
        "speakerId": info.get("speakerId"),
        "speakerName": info.get("speakerName"),
        "fileName": os.path.basename(path) if path else None,
        "filePath": path,
        "fileSize": file_size,
        "durationSec": info.get("durationSec", 0.0),
        "detectedLanguage": info.get("detectedLanguage"),
        "detectConfidence": info.get("detectConfidence"),
    }
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{APP_URL}/api/webhooks/speaker-track",
                json=payload,
                headers={"x-internal-key": INTERNAL_KEY},
                timeout=15,
            )
            if res.status_code >= 300:
                logger.warning(f"speaker-track register HTTP {res.status_code}: {res.text[:200]}")
            else:
                logger.info(
                    f"Registered speaker track for {info.get('identity')} "
                    f"({info.get('durationSec', 0):.0f}s, lang={info.get('detectedLanguage')})"
                )
    except Exception as e:
        logger.warning(f"Failed to register speaker track: {e}")


async def finalize_speaker_track(meeting_id: str, info: dict):
    """Close-out a captured speaker track: drop tiny clips, detect the speaker's
    language (seeding spokenLanguage for known users), then register the track."""
    path = info.get("path")
    if not path or not os.path.exists(path):
        return
    if info.get("durationSec", 0.0) < MIN_TRACK_SEC:
        try:
            os.remove(path)
        except Exception:
            pass
        return
    await detect_and_seed_language(meeting_id, info)
    await register_speaker_track(meeting_id, info)


def _read_wav_sample(path: str, max_seconds: int = 60) -> bytes | None:
    """Return a valid WAV byte string containing up to max_seconds of audio."""
    try:
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            ch = w.getnchannels()
            sw = w.getsampwidth()
            n = min(w.getnframes(), int(sr * max_seconds))
            if n <= 0:
                return None
            frames = w.readframes(n)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as out:
            out.setnchannels(ch)
            out.setsampwidth(sw)
            out.setframerate(sr)
            out.writeframes(frames)
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"wav sample read failed ({path}): {e}")
        return None


def _parse_detected_language(data: dict) -> tuple[str | None, float]:
    """Pull detected_language + confidence from a Deepgram pre-recorded result."""
    try:
        ch = data["results"]["channels"][0]
        lang = ch.get("detected_language")
        conf = ch.get("language_confidence")
        if isinstance(lang, str) and lang:
            return lang, float(conf) if conf is not None else 0.0
    except Exception:
        pass
    return None, 0.0


def _apply_language_prior(detected: str, conf: float, prior: str | None) -> str:
    """Break the easily-confused uk↔ru pair using the user's UI-language prior."""
    if not prior or prior == detected:
        return detected
    confusable = {"uk", "ru"}
    if detected in confusable and prior in confusable and conf < LANG_PRIOR_OVERRIDE_CONF:
        return prior
    return detected


async def detect_and_seed_language(meeting_id: str, info: dict):
    """Detect the speaker's language from their WAV (Deepgram detect_language),
    apply the UI-language prior, store it on `info`, and seed spokenLanguage for
    known users when confident."""
    path = info.get("path")
    if not path or not os.path.exists(path):
        return
    keys = await fetch_api_keys()
    dgram_key = keys.get("DEEPGRAM_API_KEY", "")
    if not dgram_key:
        return
    prior = info.get("priorLang")
    try:
        sample = _read_wav_sample(path, max_seconds=60)
        if not sample:
            return
        async with httpx.AsyncClient() as client:
            res = await client.post(
                "https://api.deepgram.com/v1/listen",
                params={"detect_language": "true", "model": "nova-2"},
                headers={
                    "Authorization": f"Token {dgram_key}",
                    "Content-Type": "audio/wav",
                },
                content=sample,
                timeout=60,
            )
        if res.status_code != 200:
            logger.warning(f"detect_language HTTP {res.status_code}: {res.text[:200]}")
            return
        detected, conf = _parse_detected_language(res.json())
        if not detected:
            return
        final_lang = _apply_language_prior(detected, conf, prior)
        info["detectedLanguage"] = final_lang
        info["detectConfidence"] = conf
        logger.info(
            f"Detected language for {info.get('identity')}: {detected} "
            f"(conf={conf:.2f}, prior={prior}) → {final_lang}"
        )
        sid = info.get("speakerId")
        if sid and final_lang and (conf >= LANG_DETECT_MIN_CONF or final_lang == prior):
            await seed_spoken_language(sid, final_lang, conf)
    except Exception as e:
        logger.warning(f"Language detection failed for {info.get('identity')}: {e}")


async def seed_spoken_language(user_id: str, lang: str, conf: float, source: str = "detected"):
    """Persist a user's spoken language so future meetings start in it."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{APP_URL}/api/webhooks/spoken-language",
                json={"userId": user_id, "language": lang, "confidence": conf, "source": source},
                headers={"x-internal-key": INTERNAL_KEY},
                timeout=15,
            )
            if res.status_code >= 300:
                logger.warning(f"spoken-language seed HTTP {res.status_code}: {res.text[:200]}")
    except Exception as e:
        logger.warning(f"Failed to seed spokenLanguage: {e}")


async def generate_report(meeting_id: str, segments: list[dict]):
    """Trigger server-side report generation. The Next.js app does the DeepSeek
    work (summary + extended topic-structured report with transcript citations),
    free of the agent's shutdown-window time pressure and token-budget limits.
    Returns immediately; the app generates in the background."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{APP_URL}/api/webhooks/generate-report",
                json={"meetingId": meeting_id},
                headers={"x-internal-key": INTERNAL_KEY},
                timeout=20,
            )
        logger.info(f"Triggered server-side report generation: HTTP {res.status_code}")
    except Exception as e:
        logger.error(f"Failed to trigger report generation: {e}")


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            # The shutdown window after a room disconnects must be long enough to
            # finish the post-meeting DeepSeek report + per-speaker language
            # detection (default is only 10s, which truncated report generation).
            shutdown_process_timeout=120,
            api_key=os.getenv("LIVEKIT_API_KEY", ""),
            api_secret=os.getenv("LIVEKIT_API_SECRET", ""),
            ws_url=os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
        )
    )
