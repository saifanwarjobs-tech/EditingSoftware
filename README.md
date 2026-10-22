# Auto Video Editor

Raw talking-head video upload karo, aur output mein milega: pauses/fillers hate hue, captions lage hue, tight pacing wali MP4.

```
upload -> transcribe (HyperFrames CLI / Whisper) -> cuts (rules + optional Claude)
       -> FFmpeg cut + captions burn-in -> audio cleanup (denoise + loudness) -> output.mp4 + captions.srt
```

## Abhi kya kaam karta hai (v0.1)
- Word-level transcription (`npx hyperframes transcribe`)
- Lambi pauses chhoti karna, fillers (umm, uh, हम्म...) hatana, 3 strengths (light/medium/aggressive)
- Optional smart cuts: repeat takes aur tangents Claude API se (conservative, max 40% limit)
- Cuts ke baad captions ka timing sahi remap hota hai, 30ms audio fades (click nahi aata)
- Audio cleanup: noise reduction, voice EQ, compressor, two-pass loudness normalisation (-14 LUFS for Reels/YouTube, -16 for podcasts). Video is copied, not re-encoded.
- Background music with auto-ducking: music bolte waqt dheemi, pauses mein wapas tez (sidechain compression), phir sab -14 LUFS par normalize
- Animated captions (FFmpeg/libass): `karaoke` (word-by-word highlight), `pop` (scale-in), `plain`
- Web upload page + JSON API + CLI. Zero npm dependencies.

## Abhi nahi hai (next steps)
- Sound effects, music auto-fade, beat-sync (voice cleanup, music + ducking done)
- HyperFrames-based designed captions (templates, emphasis words, behind-subject text); abhi captions libass se bante hain (`src/captions.js`)
- Zoom/emphasis, highlight clip selection, user accounts, persistent job queue

## Setup
Requirements: Node.js 22+, FFmpeg (libass ke saath), internet (pehli baar Whisper model download).

```bash
cp .env.example .env     # optional: ANTHROPIC_API_KEY daalo for smart cuts
npm test                 # unit + end-to-end test (FFmpeg chahiye)
npm start                # http://localhost:3000
```

CLI:
```bash
node src/cli.js my-video.mp4 --strength medium --lang hi
node src/cli.js my-video.mp4 --caption-style karaoke
node src/cli.js my-video.mp4 --smart --no-captions
node src/cli.js my-video.mp4 --lufs -16 --no-audio   # --no-audio skips cleanup
node src/cli.js my-video.mp4 --transcript transcript.json   # transcription skip
```

Docker:
```bash
docker build -t auto-video-editor . && docker run -p 3000:3000 --env-file .env auto-video-editor
```

## Music
`assets/music/` mein royalty-free tracks (mp3/wav/m4a/ogg) daalo; woh upload page ke dropdown mein dikhengi.
Sirf wahi music use karo jiska license commercial use allow kare (YouTube Audio Library, Pixabay Music, etc.).
CLI: `node src/cli.js video.mp4 --music assets/music/track.mp3 --music-volume 0.18`

## API
- `POST /api/jobs?filename=a.mp4&strength=medium&smart=1&captions=1&audio=1&lufs=-14&captionStyle=karaoke&music=track.mp3&musicVolume=0.18&lang=hi` : body = raw video bytes -> `{id}`
- `GET /api/music` -> `{tracks:[...]}`
- `GET /api/jobs/:id` -> `{status, stage, report}` (queued/processing/done/error)
- `GET /api/jobs/:id/video`, `GET /api/jobs/:id/captions`

## Production se pehle zaroor karo
- Login/auth aur rate limit lagao (abhi koi nahi hai, koi bhi upload kar sakta hai).
- Jobs memory mein hain; restart par status jaata hai. Redis/DB queue lagao.
- Rendering heavy hai: concurrency 1 hai, scale ke liye worker/Lambda/Cloud Run.
- Hindi captions ke liye `CAPTION_FONT=Noto Sans Devanagari` set karo, aur transcript review screen do.
- Uploaded videos ko storage (S3 etc.) mein rakho aur purani files delete karo.

## License
MIT (apna naam `LICENSE` mein daalo). HyperFrames Apache-2.0 hai, `NOTICE` dekho.
