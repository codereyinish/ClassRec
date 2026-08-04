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
from fastapi import Depends, HTTPException, Request
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DBSession

from database import get_db
from logger import logger
from models import User

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
        #
        # A token naming a key that is not in our set raises rather than
        # returning None, and it is a different exception from the ones jwt.decode
        # raises. Uncaught it would surface as a 500 on a request that is simply
        # unauthenticated — which is exactly what a forged kid produces.
        try:
            signing_key = _jwks.get_signing_key_from_jwt(token).key
        except PyJWKClientError as e:
            raise AuthError(f"unknown signing key: {e}")

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


# ======= FROM A TOKEN TO A ROW =======

def _bearer_token(request: Request) -> str:
    """Pull the token out of `Authorization: Bearer <token>`."""
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return token.strip()


def get_or_create_user(db: DBSession, clerk_user_id: str) -> User:
    """The row for this Clerk account, made on first sight.

    Clerk creates the account, so we only learn of someone when they first make a
    request — there is no sign-up hook to write a row from. That makes this
    get-or-create rather than a lookup, and it is where a new user's defaults
    (free plan, zero usage) come from.
    """
    user = db.execute(
        select(User).where(User.clerk_user_id == clerk_user_id)
    ).scalar_one_or_none()
    if user is not None:
        return user

    user = User(clerk_user_id=clerk_user_id)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Two requests from the same new user can arrive together — the browser
        # fires several on load. Both find nothing, both insert, one loses on the
        # unique index. Losing that race is not an error: re-read and carry on.
        db.rollback()
        user = db.execute(
            select(User).where(User.clerk_user_id == clerk_user_id)
        ).scalar_one()
        return user
    db.refresh(user)
    logger.info(f"[auth] first sight of {clerk_user_id} -> user id={user.id}")
    return user


def current_user_optional(request: Request, db: DBSession = Depends(get_db)) -> User | None:
    """The user, or None if this request is anonymous.

    Anonymous use is allowed — a visitor can record before signing in — so a
    missing or bad token is not an error here. Routes that require an account use
    current_user instead.
    """
    token = _bearer_token(request)
    if not token:
        return None
    try:
        return get_or_create_user(db, clerk_user_id_from_token(token))
    except AuthError as e:
        logger.debug(f"[auth] anonymous: {e}")
        return None


def current_user(request: Request, db: DBSession = Depends(get_db)) -> User:
    """The user, or 401. For routes that must belong to someone."""
    token = _bearer_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in to continue")
    try:
        return get_or_create_user(db, clerk_user_id_from_token(token))
    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
