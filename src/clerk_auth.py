"""
ClassRec — who is making this request?
=====================================

Clerk signs a short-lived token and the browser sends it with each request. This
module checks the signature and hands back the Clerk user id. Nothing here talks
to Clerk over the network per request: verification is a signature check against
public keys, which is what makes it cheap enough to do on every call.

The keys are fetched once and cached. PyJWKClient handles that, including
re-fetching when a token names a key id it has not seen — which is how key
rotation works without anything breaking.
"""

import base64
import os

import jwt
from jwt import PyJWKClient

from logger import logger

# The publishable key encodes the Clerk domain, so there is nothing extra to
# configure: pk_test_<base64 of "your-app.clerk.accounts.dev$">
CLERK_PUBLISHABLE_KEY = os.getenv(
    "CLERK_PUBLISHABLE_KEY",
    "pk_test_ZXRoaWNhbC1tYWNhdy00OS5jbGVyay5hY2NvdW50cy5kZXYk",
)


def _clerk_domain(publishable_key: str) -> str:
    """ethical-macaw-49.clerk.accounts.dev, decoded out of the publishable key."""
    body = publishable_key.split("_", 2)[-1]
    # base64 without padding is common in these keys; "==" is always safe to add
    return base64.b64decode(body + "==").decode().rstrip("$")


CLERK_DOMAIN = _clerk_domain(CLERK_PUBLISHABLE_KEY)
CLERK_ISSUER = f"https://{CLERK_DOMAIN}"
JWKS_URL = f"{CLERK_ISSUER}/.well-known/jwks.json"

# Cached across requests. lifespan is how long a fetched key set is reused before
# being refreshed; a token naming an unknown kid triggers a fetch regardless.
_jwks = PyJWKClient(JWKS_URL, cache_keys=True, lifespan=3600)


class AuthError(Exception):
    """The token was missing, expired, tampered with, or from somewhere else."""


def clerk_user_id_from_token(token: str) -> str:
    """Verify a Clerk session token and return its subject (the Clerk user id).

    Raises AuthError for anything that is not a valid, current token from our own
    Clerk instance. The caller decides whether that means 401 or anonymous.
    """
    if not token:
        raise AuthError("no token")

    try:
        # Reads the token's header to find which key signed it, then returns that
        # key — fetching the key set if this id has not been seen before.
        signing_key = _jwks.get_signing_key_from_jwt(token).key

        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            issuer=CLERK_ISSUER,       # a valid token from someone else's Clerk app is still invalid here
            options={"verify_aud": False},   # Clerk uses azp, not aud, for the origin
            leeway=10,                 # seconds, for clock drift between machines
        )
    except jwt.ExpiredSignatureError:
        raise AuthError("token expired")
    except jwt.InvalidTokenError as e:
        # covers a bad signature, wrong issuer, malformed token
        raise AuthError(f"invalid token: {e}")

    sub = claims.get("sub")
    if not sub:
        raise AuthError("token has no subject")
    return sub
