"""
Kokoro TTS Server — runs on Mac Mini
Provides a REST API at http://localhost:8880/tts
"""
import io
import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from kokoro import KPipeline

app = FastAPI(title="Kokoro TTS Server")

# Initialize pipeline with American English voice
# Available voices: af_heart, af_bella, af_nicole, af_sarah, af_sky,
#                   am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis
pipeline = KPipeline(lang_code='a')  # 'a' = American English

class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0

@app.post("/tts")
async def text_to_speech(req: TTSRequest):
    """Generate speech from text. Returns WAV audio."""
    generator = pipeline(req.text, voice=req.voice, speed=req.speed)
    
    # Collect all audio chunks
    all_audio = []
    sample_rate = 24000
    for _, _, audio in generator:
        all_audio.append(audio)
    
    if not all_audio:
        return {"error": "No audio generated"}
    
    import numpy as np
    combined = np.concatenate(all_audio)
    
    # Write to WAV buffer
    buf = io.BytesIO()
    sf.write(buf, combined, sample_rate, format='WAV')
    buf.seek(0)
    
    return StreamingResponse(buf, media_type="audio/wav", headers={
        "Content-Disposition": "inline; filename=speech.wav"
    })

@app.get("/voices")
async def list_voices():
    """List available voices."""
    return {
        "voices": [
            {"id": "af_heart", "name": "Heart (Female)", "lang": "en-US"},
            {"id": "af_bella", "name": "Bella (Female)", "lang": "en-US"},
            {"id": "af_nicole", "name": "Nicole (Female)", "lang": "en-US"},
            {"id": "af_sarah", "name": "Sarah (Female)", "lang": "en-US"},
            {"id": "af_sky", "name": "Sky (Female)", "lang": "en-US"},
            {"id": "am_adam", "name": "Adam (Male)", "lang": "en-US"},
            {"id": "am_michael", "name": "Michael (Male)", "lang": "en-US"},
            {"id": "bf_emma", "name": "Emma (Female)", "lang": "en-GB"},
            {"id": "bf_isabella", "name": "Isabella (Female)", "lang": "en-GB"},
            {"id": "bm_george", "name": "George (Male)", "lang": "en-GB"},
            {"id": "bm_lewis", "name": "Lewis (Male)", "lang": "en-GB"},
        ]
    }

@app.get("/health")
async def health():
    return {"status": "ok", "engine": "kokoro", "version": "0.9.4"}

if __name__ == "__main__":
    import uvicorn
    print("🔊 Starting Kokoro TTS Server on port 8880...")
    uvicorn.run(app, host="0.0.0.0", port=8880)
