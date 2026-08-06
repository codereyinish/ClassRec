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

**RAM cost:** measured, not estimated — Python and its libraries are 277MB, the
models add 293MB on top, so a worker sits at ~570MB with everything loaded. Four
workers is ~2.3GB before any recording starts.

**On the current droplet (2 vCPU, 4GB):** two workers fit, four is tight. But see
"Where the delay comes from" below — the server is not the constraint on this
workload, so extra workers buy very little.
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

## Why the pipeline gate is where it is

`_pipeline_semaphore` has two slots. A chunk must hold one to run the local
models, and gives it back when it finishes:

```python
async with _pipeline_semaphore:      # take a slot
    ...VAD, segmentation, ECAPA...   # ~0.3s
                                     # give it back
```

Each chunk does two things in order: wait for Modal (1.7s), then compute
locally (0.3s). Only the second needs a slot.

With ONE container, Modal serves one request at a time, so replies arrive 1.7s
apart and the local work never overlaps — a second slot is never used:

```
0.0s   A B C D all sent, all waiting                   0 / 2 slots
1.7s   A's reply, computes 0.3s                        1 / 2
3.4s   B's reply, computes                             1 / 2
5.1s   C's reply, computes                             1 / 2
6.8s   D's reply, computes                             1 / 2
```

Contention only appears once several containers deliver replies close together.
With four containers all four replies land near 1.7s, the first two take slots
and the rest wait a fraction of a second. That is the case the two slots exist
for, and it is why the number tracks cores rather than customers.

The gate used to be taken before the Modal call and released after the local
work, so a chunk held a slot for the full 2s — 1.7s of which was spent waiting
on a remote GPU, using no CPU. Chunks could not even reach Modal in parallel,
because reaching it required a slot.

How much that cost depends on how many containers Modal is allowed to run:

```
                        old gate    new gate
1 container              8.0s        7.1s     Modal serialises anyway
4 containers             8.0s        2.4s     the wait actually overlaps
```

So moving the gate is only worth what container capacity lets it be worth. With
max_containers unset, Modal scales out and the gain is real; capped at one, the
old placement would barely have mattered. Worth knowing before reading a
throughput claim from either change on its own.

The lesson generalises: **a lock should cover the resource it protects and
nothing else.** This one protects CPU and memory, so it has no business
spanning a network call.

---

## What each resource costs as users grow

Measured: 0.28s of local model work per chunk, 1.74s for the Modal round trip,
one chunk per recording every 10 seconds.

| concurrent recordings | server load | containers needed |
|---|---|---|
| 3   | compute 4%, ~1GB   | 1  |
| 10  | compute 15%, ~1GB  | 4  |
| 67  | compute 100%       | 22 |
| 100 | compute 143% - needs 4 vCPU and Semaphore(4) | ~33 |

Compute capacity is `permits / 0.28s`, so two permits serve about seven chunks a
second, which is roughly 67 recordings. That is the first point where the droplet
becomes the constraint rather than the containers.

Memory stays near 1GB at every row. The models are loaded once, concurrent
inference is capped by the semaphore, and a connection's buffers are about 1.3MB
— so users add almost nothing.

```
droplet   $24 -> $48 once, at around 67 recordings
Modal     linear with users, forever
```

The server is a fixed cost that barely moves. Transcription is the variable cost
and the real one.

**Sizing the cores.** Compute demand is chunks per second times 0.28s, plus about
0.15 of a core for the event loop at that packet rate:

```
100 recordings -> 10 chunks/sec -> 2.8 core-seconds per second
                                +  0.15 for the loop
                                =  ~3 cores minimum
```

Run four, not three. Three would sit at ~98% and queues grow at that
utilisation, the same reason a container takes three recordings rather than five.
Four is ~73% and comfortable.

Still one worker. Four cores, `Semaphore(4)`, one process — the model work
releases the GIL, so threads already use all four and a second worker would only
duplicate 570MB of models for a second GIL that is not the constraint.

---

## How the containers scale, and what that costs

The capacity table above says a hundred recordings needs about thirty-three T4
containers. That reads like something to go and build. It is not — nobody adds
containers. The rest of this section is how that number comes about on its own,
and where the money goes.

**Nothing in this repo starts a container.** `modal_whisper.py` declares one
function with `gpu="T4"`, and Modal runs as many copies of it as there are
requests in flight. Ten overlapping requests is ten containers, and when the
requests stop the containers stop. The scaling is a consequence of the traffic,
not a setting anyone turns up.

**One request at a time, per container.** The function sets no concurrency, so
the default holds: a container serves a single request and is unavailable until
it answers. Two requests that overlap in time cannot share one — they need two.

Which raises the obvious question: if a container takes one request at a time,
how does it serve three recordings? Because those requests do not overlap. Each
recording sends one chunk every five seconds and each request takes 1.74s:

```
5.0 / 1.74 = 2.9 requests fit end to end inside one recording's chunk interval
```

Three recordings land in each other's gaps. A fourth is where requests start
arriving while the container is still busy, and Modal starts a second one for the
overflow. So the container count tracks *simultaneous* requests, not users, and
the 5-second chunk interval is what keeps those two numbers so far apart.

**This is the normal technique, not a shortcut.** Scaling on requests in flight
is what Lambda, Cloud Run and every serverless GPU platform do. The alternative
— Kubernetes watching CPU and adding replicas past a threshold — reacts in
minutes rather than seconds and reads the wrong signal for inference, where a
single request occupies the whole GPU and CPU load says nothing about whether
the device is free.

**What it costs.** Billing is per container-second, from start to shutdown, and
shutdown is `scaledown_window` after the last request — currently 300s. For a
live lecture that idle tail never happens: chunks arrive every five seconds, so
the container stays busy for the whole lecture and shuts down once after it. The
useful shape is therefore

```
one recording-hour  ~  1/3 of a container-hour
```

times Modal's current T4 per-second rate, which should be read off their pricing
page rather than trusted from a number written here.

**Cold starts are what you pay to avoid.** A container that has just started
loads Whisper before it can answer, so the first chunk after a quiet period is
slow. `min_containers` removes that by keeping one alive permanently — bought at
24 hours of billing a day, whether anyone records or not. Worth it once traffic
is steady enough that the container would mostly be up anyway.

### The four levers

| lever | what it decides | today |
|---|---|---|
| `max_containers` | the ceiling — and therefore the worst case bill | unset, unbounded |
| `min_containers` | how many stay warm, so no one waits for a cold start | unset, none warm |
| `scaledown_window` | how long an idle container is kept before shutdown | 300s |
| concurrency | requests one container will take at once | 1 (default) |

`max_containers` is the one that matters first. Unset, a traffic spike scales
until the credit card notices. Set, requests past the ceiling queue instead —
latency rises and nothing breaks, which is the failure worth having.

### The server side does not work this way

The droplet has no autoscaler. Growth there is a resize: 2 vCPU carries about 67
concurrent recordings, and 4 vCPU carries a hundred. That is a reboot, once,
followed by raising `Semaphore` to match the new core count.

Going wider instead of bigger — several droplets behind a load balancer — is a
different problem from scaling the containers, because WebSockets are not
stateless:

- the load balancer has to support them; connection-level, not per request
- a socket lives on the instance that accepted it for the whole lecture, so
  adding an instance only helps recordings that have not started yet
- an instance cannot be removed while sockets are open on it, so deploys need a
  drain window measured in lecture lengths
- anything per-user held in process — `_open_sockets` is the one here — has to
  move to shared storage first

None of which is worth doing while one machine covers a hundred simultaneous
lectures.

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
