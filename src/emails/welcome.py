"""Welcome email, sent once when a user is first seen.

Plain text and HTML of the same message. Kept as a template rather than a string
in the sending code so the copy can be edited without touching delivery.
"""

SUBJECT = "Welcome to ClassRec"

TEXT = """Hi {first_name},

Your account is ready.

ClassRec listens to a lecture, transcribes it as it happens, and keeps the
recording lined up with the words — so you can click any sentence later and hear
exactly how it was said.

On the free plan you have:
  · {live_limit} minutes of live recording
  · {upload_limit} minutes of uploaded audio

Two things worth trying in your first lecture:

  1. Turn on Lock Mode and hold the microphone for ten seconds while your
     professor is talking. ClassRec learns their voice and keeps only them —
     the room, the chatter and the person behind you drop out.

  2. Set an alert for "exam" or "assignment". You get told the moment it is
     mentioned, instead of finding it three weeks later.

Start recording: {app_url}

— ClassRec
"""

HTML = """\
<div style="font-family:'DM Sans',-apple-system,Segoe UI,sans-serif;font-size:15px;
            line-height:1.65;color:#281F3E;max-width:520px">
  <p>Hi {first_name},</p>

  <p>Your account is ready.</p>

  <p>ClassRec listens to a lecture, transcribes it as it happens, and keeps the
     recording lined up with the words — so you can click any sentence later and
     hear exactly how it was said.</p>

  <p style="margin-bottom:6px"><strong>On the free plan you have</strong></p>
  <ul style="margin-top:0;padding-left:20px;color:#5A5269">
    <li>{live_limit} minutes of live recording</li>
    <li>{upload_limit} minutes of uploaded audio</li>
  </ul>

  <p style="margin-bottom:6px"><strong>Two things worth trying in your first lecture</strong></p>
  <ol style="margin-top:0;padding-left:20px;color:#5A5269">
    <li style="margin-bottom:8px">Turn on Lock Mode and hold the microphone for ten
        seconds while your professor is talking. ClassRec learns their voice and
        keeps only them — the room, the chatter and the person behind you drop out.</li>
    <li>Set an alert for “exam” or “assignment”. You get told the moment it is
        mentioned, instead of finding it three weeks later.</li>
  </ol>

  <p style="margin-top:26px">
    <a href="{app_url}" style="background:#6365EB;color:#fff;text-decoration:none;
       padding:11px 20px;border-radius:10px;font-weight:600;display:inline-block">
      Start recording
    </a>
  </p>

  <p style="color:#8B8399;font-size:13px;margin-top:28px">— ClassRec</p>
</div>
"""


def render(first_name: str, live_limit: int, upload_limit: int, app_url: str) -> dict:
    """Fill the template. Returns {subject, text, html} ready to hand to a sender."""
    fields = dict(first_name=first_name or "there", live_limit=live_limit,
                  upload_limit=upload_limit, app_url=app_url)
    return {
        "subject": SUBJECT,
        "text": TEXT.format(**fields),
        "html": HTML.format(**fields),
    }
