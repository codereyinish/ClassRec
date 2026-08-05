# Scaling Guide for ClassRec

A reference for when the server gets slow or crashes under load.
Each level builds on the previous. Start from Level 1 and only go further if needed.

---

## Current State (Level 0)

```
All users → 1 server → 1 Whisper model (sequential)
```

**Problem:** Whisper blocks the async event loop. Users wait in line.
**When it breaks:** 3+ concurrent users sending audio chunks simultaneously.

---

## Level 1: Fix the Async Blocking (do this first)

**Problem:** `transcribe_chunk` calls Whisper synchronously inside an async function.
This freezes the entire event loop while Whisper runs.

**Fix:** Offload Whisper to a thread pool so other users aren't blocked.

```python
# src/main.py

import asyncio
from functools import partial

# BEFORE (blocks everyone):
asyncio.create_task(transcribe_chunk(...))

# AFTER (non-blocking):
loop = asyncio.get_event_loop()
await loop.run_in_executor(None, partial(transcribe_chunk_sync, ...))
```

**Why it works:** `run_in_executor` moves the blocking work to a separate thread.
The event loop stays free to handle other users while Whisper runs in the background.

**Interview answer:** "Whisper is a CPU-bound blocking task. Running it directly in
an async function blocks the event loop. We offload it to a ThreadPoolExecutor."

---

## Level 2: Multiple Uvicorn Workers (same server, more throughput)

**Problem:** Even with the async fix, one Python process = one GIL = limited CPU parallelism.

**Fix:** Run multiple worker processes. Each gets its own Whisper model.

```bash
# Instead of:
uvicorn src.main:app --host 0.0.0.0 --port 8000

# Run 4 workers:
uvicorn src.main:app --host 0.0.0.0 --port 8000 --workers 4
```

**RAM cost:** Each worker loads all models (~1GB) → 4 workers = ~4GB RAM.
**Throughput:** 4 users can be processed truly in parallel.
**When to do this:** Server CPU is maxed out but you have RAM to spare.

**Interview answer:** "We scale vertically first — multiple workers on one machine
using Uvicorn's --workers flag. Each worker is an independent Python process
with its own model copy, bypassing the GIL."

### What breaks the moment you add the second worker

Each worker is a separate process with **separate memory**. Anything held in a
Python variable stops being shared, silently — nothing errors, the limit simply
stops applying.

Audit before switching this on:

| state | lives in | survives workers |
|---|---|---|
| a WebSocket's own counters | that connection | yes — a socket stays in one worker |
| the Clerk JWKS key cache | each worker's memory | yes — each fetches its own, harmless |
| `users.live_seconds` | the database | yes — one row, every worker sees it |
| an in-memory count of open sockets | one worker's memory | **no — 5 per worker becomes 20** |

The rule: **a per-user limit kept in process memory is wrong as soon as there is
more than one process.** Shared limits need shared storage.

### Redis — when it earns its place

Not needed yet, and worth being clear about why. A local SQLite write is ~0.2ms,
in the same range as a Redis round trip, so this is not about speed. What Redis
provides that a database does not:

- **TTL** — keys that delete themselves, which is how a crashed worker's
  "socket still open" entry disappears without a cleanup job.
- **Atomic counters** — `INCR` in one operation, no transaction to reason about.
- **Write concurrency** — SQLite locks the whole file for a write, so ten workers
  writing means nine waiting. This is the real ceiling here, not latency.
- **Pub/sub** — one worker telling the others something immediately. A database
  can only be polled, which is what a flush interval already is.
- **Disposability** — losing it loses counters, not lectures.

**Adopt it when:** several workers need to share ephemeral state that changes
often — concurrent-session limits, per-IP rate limiting, or pushing "this user
hit their limit" to a worker holding their other socket.

**Not for:** anything durable. Lectures, voices and usage totals stay in the
database.

---

## Where the delay comes from

Measured on an 8-core Mac, one 10-second chunk:

```
local models (VAD, segmentation, ECAPA)   0.28s
Modal round trip, warm                    1.74s
```

What a user sees is a sawtooth, not a fixed lag. Every word in a chunk appears
at once, so just after an update the transcript is ~2s behind live speech, then
drifts until the next chunk lands 10 seconds later.

```
floor  ~2s     processing: Modal + local + any queueing
drift  ~10s    CHUNK_DURATION - how far it falls behind before catching up
```

The floor is the number a user judges by, because they compare the transcript to
the words they just heard. Queueing raises it directly: a chunk waiting behind
two others adds ~3.4s, and the transcript then never gets closer than five
seconds behind.

**Capacity follows from that.** One T4 container serves one chunk at a time, so
about three concurrent recordings keeps it near half busy and the floor low.
Past four, queueing raises the floor faster than it raises throughput.

```
3 recordings -> 1 container        12 recordings -> 4 containers
```

**The server is not what scales.** One core serves roughly 35 concurrent
recordings, since each needs 0.28s once every 10 seconds, and memory stays near
1GB regardless because the pipeline semaphore caps concurrent inference at two.
Capacity is bought in Modal containers, not droplet size.

**If the lag needs to come down**, CHUNK_DURATION is the lever - it owns two
thirds of the delay. The cost is accuracy, since Whisper gets less context.

---

## Level 3: Multiple Servers + Load Balancer (horizontal scaling)

**Problem:** One server has a RAM/CPU ceiling. Can't add more workers indefinitely.

**Architecture:**
```
Users → Nginx Load Balancer → Server 1 (4 workers)
                            → Server 2 (4 workers)
                            → Server 3 (4 workers)
```

**Nginx config snippet (load balancer):**
```nginx
upstream classsrec_backend {
    least_conn;  # send to server with fewest active connections
    server server1_ip:8000;
    server server2_ip:8000;
    server server3_ip:8000;
}

server {
    listen 80;
    location / {
        proxy_pass http://classsrec_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;    # needed for WebSocket
        proxy_set_header Connection "upgrade";     # needed for WebSocket
    }
}
```

**WebSocket problem:** Load balancers break WebSockets by default because
a user's connection must stay on the same server for the whole session.
Fix: use `ip_hash` in Nginx so each user always goes to the same server.

```nginx
upstream classsrec_backend {
    ip_hash;  # same user always hits same server
    server server1_ip:8000;
    server server2_ip:8000;
}
```

**When to do this:** You've maxed out vertical scaling on one machine.

---

## Level 4: Job Queue — Industry Standard for ML (know this for interviews)

**Problem:** Whisper is slow. Users shouldn't wait synchronously.
Real companies (OpenAI, Deepgram, AssemblyAI) decouple audio intake from processing.

**Architecture:**
```
User sends audio
      ↓
API Server (lightweight FastAPI) — just accepts audio, returns job_id immediately
      ↓
Redis Queue (job sitting here)
      ↓
Worker machines (just run Whisper, pull jobs from queue)
      ↓
Result stored → WebSocket pushes result back to user
```

**Tools:**
- **Redis** — the queue (fast in-memory store)
- **Celery** — Python library that manages workers pulling from Redis
- **WebSocket or polling** — how user gets the result back

**Celery snippet:**
```python
# tasks.py
from celery import Celery

celery_app = Celery('classsrec', broker='redis://localhost:6379/0')

@celery_app.task
def transcribe_audio_task(pcm_bytes: bytes, session_config: dict):
    # runs on a worker machine, not the API server
    result = run_full_pipeline(pcm_bytes, session_config)
    return result

# In your FastAPI route:
task = transcribe_audio_task.delay(pcm_bytes, config)
# returns immediately, user gets task.id
# worker processes in background
```

**Why this is the industry standard:**
- API server stays fast regardless of how slow Whisper is
- Workers can be on different machines, scaled independently
- Worker crashes don't affect the API server
- Easy to add more workers during peak load (auto-scaling)

**Interview answer:** "For ML workloads, we decouple ingestion from inference using
a task queue (Celery + Redis). The API server just enqueues jobs and returns
immediately. Workers pull jobs and process them. This lets us scale inference
horizontally without touching the API layer."

---

## When to move to each level

| Symptom | Fix |
|---|---|
| Users experience lag with 2-3 concurrent users | Level 1 (fix async blocking) |
| CPU maxed out on server | Level 2 (multiple workers) |
| Server RAM maxed out | Upgrade Droplet size OR Level 3 |
| Need 10+ concurrent users reliably | Level 3 (multiple servers) |
| Need 100+ concurrent users | Level 4 (job queue) |

---

## Monitoring — how to know when you're in trouble

```bash
# On your Droplet, watch live resource usage:
htop

# Check memory specifically:
free -h

# Check if your app is running:
systemctl status classsrec

# Check app logs:
journalctl -u classsrec -f
```

Your app already has a `/health` endpoint that shows memory usage.
Check it regularly: `curl http://your_server_ip/health`
