// ===== CONSTANTS =====
const CLERK_PUBLISHABLE_KEY = "pk_test_ZXRoaWNhbC1tYWNhdy00OS5jbGVyay5hY2NvdW50cy5kZXYk";
const NUDGE_START_TIME = 10000;
const NUDGE_END_TIME = 8000;

// ===== WAIT FOR CLERK TO LOAD =====
window.addEventListener("load", async () => {
    await window.__clerk_loaded;
    const clerk = window.Clerk;

    if (!clerk) {
        console.error("Clerk failed to load");
        return;
    }

    await clerk.load();
    renderNav(clerk);
    startNudgeTimer(clerk);

    window.showUpgradeModal = () => _showUpgradeModal(clerk);
});


// ===== NAV: avatar or sign in button =====
function renderNav(clerk) {
    const mount = document.getElementById("clerk-auth-mount");
    if (!mount) return;

    if (clerk.user) {
        const name = clerk.user.firstName || clerk.user.emailAddresses[0].emailAddress;
        const email = clerk.user.emailAddresses[0].emailAddress;
        const letter = name.charAt(0).toUpperCase();

        mount.innerHTML = `
            <div id="user-avatar" style="
                width: 32px; height: 32px; border-radius: 50%;
                background: var(--accent); color: #0d0d11;
                display: flex; align-items: center; justify-content: center;
                font-family: 'DM Mono', monospace; font-size: 13px;
                font-weight: 500; cursor: pointer; user-select: none;
                position: relative; transition: box-shadow 0.2s;
            ">${letter}</div>

            <!-- DROPDOWN -->
            <div id="user-dropdown" style="
                display: none;
                position: absolute;
                top: 52px;
                right: 24px;
                width: 260px;
                background: #14141a;
                border: 1px solid rgba(255,255,255,0.07);
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 16px 48px rgba(0,0,0,0.6);
                z-index: 500;
                font-family: 'DM Mono', monospace;
            ">
                <!-- Profile section -->
                <div style="padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.06);">
                    <div style="display:flex; align-items:center; gap: 12px;">
                        <div style="
                            width: 38px; height: 38px; border-radius: 50%;
                            background: var(--accent); color: #0d0d11;
                            display: flex; align-items: center; justify-content: center;
                            font-size: 15px; font-weight: 500; flex-shrink: 0;
                        ">${letter}</div>
                        <div style="overflow: hidden;">
                            <div style="color: #f0ebe0; font-size: 13px; font-weight: 500;
                                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                ${name}
                            </div>
                            <div style="color: #7a7a8a; font-size: 11px; margin-top: 2px;
                                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                ${email}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Usage section -->
                <div style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);">
                    <div style="
                        display: inline-flex; align-items: center; gap: 6px;
                        background: rgba(232,160,32,0.1); border: 1px solid rgba(232,160,32,0.2);
                        border-radius: 20px; padding: 3px 10px;
                        color: #e8a020; font-size: 11px; letter-spacing: 0.05em;
                        text-transform: uppercase; margin-bottom: 10px;
                    ">● Free Plan</div>

                    <!-- Live usage bar -->
                    <div style="margin-bottom: 8px;">
                        <div style="display:flex; justify-content:space-between;
                            color: #7a7a8a; font-size: 11px; margin-bottom: 4px;">
                            <span>Live</span>
                            <span id="live-usage-text">-- / -- min</span>
                        </div>
                        <div style="height: 4px; background: #1c1c26; border-radius: 2px;">
                            <div id="live-usage-bar" style="
                                height: 100%; border-radius: 2px;
                                background: var(--accent); width: 0%;
                                transition: width 0.3s;
                            "></div>
                        </div>
                    </div>

                    <!-- Upload usage bar -->
                    <div>
                        <div style="display:flex; justify-content:space-between;
                            color: #7a7a8a; font-size: 11px; margin-bottom: 4px;">
                            <span>Upload</span>
                            <span id="upload-usage-text">-- / -- min</span>
                        </div>
                        <div style="height: 4px; background: #1c1c26; border-radius: 2px;">
                            <div id="upload-usage-bar" style="
                                height: 100%; border-radius: 2px;
                                background: var(--accent); width: 0%;
                                transition: width 0.3s;
                            "></div>
                        </div>
                    </div>
                </div>

                <!-- Actions -->
                <div style="padding: 8px;">
                    <button id="get-pro-btn" style="
                        width: 100%; padding: 9px 14px;
                        background: rgba(232,160,32,0.1);
                        border: 1px solid rgba(232,160,32,0.2);
                        border-radius: 7px; color: #e8a020;
                        font-family: 'DM Mono', monospace; font-size: 12px;
                        letter-spacing: 0.03em; cursor: pointer;
                        text-align: left; margin-bottom: 4px;
                        transition: background 0.2s;
                    ">⚡ Get Pro — unlimited access</button>

                    <button id="signout-btn" style="
                        width: 100%; padding: 9px 14px;
                        background: transparent; border: none;
                        border-radius: 7px; color: #7a7a8a;
                        font-family: 'DM Mono', monospace; font-size: 12px;
                        letter-spacing: 0.03em; cursor: pointer;
                        text-align: left; transition: color 0.2s;
                    ">← Sign out</button>
                </div>
            </div>
        `;

        // Populate usage bars from UsageTracker — limits come from tracker.js so they
        // automatically reflect member vs non-member and any future limit changes.
        const liveUsed    = UsageTracker.getLiveMinutes ? UsageTracker.getLiveMinutes() : 0;
        const uploadUsed  = UsageTracker.getUploadMinutes ? UsageTracker.getUploadMinutes() : 0;
        const liveLimit   = getLiveLimit();
        const uploadLimit = getUploadLimit();
        const livePercentage   = Math.min((liveUsed / liveLimit) * 100, 100);
        const uploadPercentage = Math.min((uploadUsed / uploadLimit) * 100, 100);

        document.getElementById("live-usage-text").textContent =
            `${liveUsed.toFixed(1)} / ${liveLimit} min`;
        document.getElementById("upload-usage-text").textContent =
            `${uploadUsed.toFixed(1)} / ${uploadLimit} min`;
        document.getElementById("live-usage-bar").style.width = `${livePercentage}%`;
        document.getElementById("upload-usage-bar").style.width = `${uploadPercentage}%`;

        function refreshUsage() {
            const liveUsed    = UsageTracker.getLiveMinutes ? UsageTracker.getLiveMinutes() : 0;
            const uploadUsed  = UsageTracker.getUploadMinutes ? UsageTracker.getUploadMinutes() : 0;
            const liveLimit   = getLiveLimit();
            const uploadLimit = getUploadLimit();
            document.getElementById("live-usage-text").textContent   = `${liveUsed.toFixed(1)} / ${liveLimit} min`;
            document.getElementById("upload-usage-text").textContent = `${uploadUsed.toFixed(1)} / ${uploadLimit} min`;
            document.getElementById("live-usage-bar").style.width    = `${Math.min((liveUsed / liveLimit) * 100, 100)}%`;
            document.getElementById("upload-usage-bar").style.width  = `${Math.min((uploadUsed / uploadLimit) * 100, 100)}%`;
        }

        // Toggle dropdown + refresh usage on open
        document.getElementById("user-avatar").addEventListener("click", (e) => {
            e.stopPropagation();
            const dd = document.getElementById("user-dropdown");
            const opening = dd.style.display === "none";
            dd.style.display = opening ? "block" : "none";
            if (opening) refreshUsage();
        });



        // Sign out
        document.getElementById("signout-btn").addEventListener("click", async () => {
            await clerk.signOut();
            window.location.reload();
        });

        // Get Pro. Records the ask and shows what came back, rather than an
        // alert() — a browser dialog is the one piece of this page the app's
        // own styling cannot reach, and the answer is worth reading.
        document.getElementById("get-pro-btn").addEventListener("click", async () => {
            document.getElementById("user-dropdown").style.display = "none";
            try {
                const t = await clerk.session.getToken();
                const r = await fetch("/upgrade-request", {
                    method: "POST",
                    headers: { Authorization: "Bearer " + t },
                });
                const d = await r.json();
                showWaitlistNote(r.ok ? d.message
                    : "Could not reach the server. Try again in a moment.");
            } catch {
                showWaitlistNote("Could not reach the server. Try again in a moment.");
            }
        });

    } else {
        mount.innerHTML = `
            <style>
                @keyframes glow-pulse {
                    0%, 100% { box-shadow: 0 0 8px rgba(232,160,32,0.2), inset 0 0 8px rgba(232,160,32,0.05); }
                    50%       { box-shadow: 0 0 18px rgba(232,160,32,0.5), inset 0 0 12px rgba(232,160,32,0.1); }
                }
            </style>
            <button id="clerk-login-btn" style="
                background: rgba(232,160,32,0.08);
                border: 1px solid rgba(232,160,32,0.5);
                color: #e8a020;
                font-family: 'DM Mono', monospace;
                font-size: 12px;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                padding: 7px 16px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
                animation: glow-pulse 2s ease-in-out infinite;
            ">Sign in</button>
        `;

        document.getElementById("clerk-login-btn").addEventListener("mouseenter", e => {
            e.target.style.color = "var(--text)";
            e.target.style.borderColor = "rgba(255,255,255,0.2)";
        });
        document.getElementById("clerk-login-btn").addEventListener("mouseleave", e => {
            e.target.style.color = "var(--text-muted)";
            e.target.style.borderColor = "var(--border)";
        });
        document.getElementById("clerk-login-btn").addEventListener("click", () => {
            showAuthModal(clerk);
        });
    }
}

// Close on outside click
    document.addEventListener("click", () => {
        const dd = document.getElementById("user-dropdown");
        if (dd) dd.style.display = "none";
    });

// ===== UPGRADE MODAL (called when free limit is hit) =====
function _showUpgradeModal(clerk) {
    if (clerk.user) {
        // Already signed in, just show limit message
        if (document.getElementById("clerk-modal-overlay")) return;
        const overlay = document.createElement("div");
        overlay.id = "clerk-modal-overlay";
        overlay.style.cssText = `
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.75);
            backdrop-filter: blur(10px);
            display: flex; align-items: center; justify-content: center;
            z-index: 1000;
        `;
        const modal = document.createElement("div");
        modal.style.cssText = `
            background: #14141a;
            border: 1px solid rgba(255,255,255,0.07);
            border-radius: 16px;
            padding: 40px 32px;
            width: 100%; max-width: 380px;
            text-align: center;
        `;
        modal.innerHTML = `
            <div style="font-size: 28px; margin-bottom: 12px;">⏱️</div>
            <h2 style="font-family: 'DM Serif Display', serif; font-size: 22px; color: #f0ebe0; margin-bottom: 10px;">Free limit reached</h2>
            <p style="color: #7a7a8a; font-size: 13px; line-height: 1.6; margin-bottom: 24px;">Paid plans coming soon — check back shortly.</p>
            <button onclick="document.getElementById('clerk-modal-overlay').remove()" style="
                background: #1c1c26; color: #7a7a8a;
                border: 1px solid rgba(255,255,255,0.07);
                border-radius: 7px; padding: 10px 24px;
                font-family: 'DM Mono', monospace; font-size: 13px; cursor: pointer;
            ">Close</button>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
        return;
    }

    // Not signed in — open Clerk's own modal with dark theme
    clerk.openSignIn({ appearance: clerkTheme() });
}

// ===== THE WAITLIST NOTE =====
/* What the Pro button says back. A note rather than a modal: nothing is being
   decided, so there is nothing to dismiss before carrying on.

   The colours are literals rather than var(--primary) and friends. auth.js is
   loaded by base.html too, and those pages do not declare the token block —
   var() with no fallback there resolves to nothing and the note comes out
   unstyled. These are the same values live.css and index.css use. */
function showWaitlistNote(text) {
    document.getElementById("waitlist-note")?.remove();

    const note = document.createElement("div");
    note.id = "waitlist-note";
    note.style.cssText = `
        position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(8px);
        z-index: 1200; max-width: min(420px, calc(100vw - 32px));
        display: flex; gap: 12px; align-items: flex-start;
        background: #FFFFFF; color: #281F3E;
        border: 1px solid #E2DEE7; border-left: 3px solid #6365EB;
        border-radius: 12px; padding: 14px 16px;
        font-family: 'DM Sans', system-ui, sans-serif; font-size: 14px; line-height: 1.55;
        box-shadow: 0 10px 34px rgba(40,31,62,.16);
        opacity: 0; transition: opacity .18s cubic-bezier(.2,.7,.3,1),
                                transform .18s cubic-bezier(.2,.7,.3,1);
        cursor: pointer;
    `;
    note.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="#6365EB" stroke-width="1.8"
              stroke-linecap="round" style="width:18px;height:18px;flex:none;margin-top:1px">
           <circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3 1.8"/>
         </svg>
         <span></span>`;
    // textContent, not innerHTML: the sentence comes from the server, and the
    // one place a server string becomes markup is the one place it should not.
    note.querySelector("span").textContent = text;

    document.body.appendChild(note);
    requestAnimationFrame(() => {
        note.style.opacity = "1";
        note.style.transform = "translateX(-50%) translateY(0)";
    });

    const close = () => {
        note.style.opacity = "0";
        note.style.transform = "translateX(-50%) translateY(8px)";
        setTimeout(() => note.remove(), 200);
    };
    note.addEventListener("click", close);
    // Long enough to read two sentences without hurrying, and dismissible before.
    setTimeout(close, 9000);
}

// ===== STANDARD AUTH MODAL (sign in button click) =====
function showAuthModal(clerk) {
    clerk.openSignIn({ appearance: clerkTheme() });
}

// ===== WHICH THEME =====
// Clerk's modal is drawn by Clerk, so page CSS cannot reach it — the only way in
// is this appearance object. base.html's pages are the dark amber ones and keep
// what they had; a page that asks for the light theme on <html> gets the indigo
// one, so the modal matches whatever opened it.
function clerkTheme() {
    return document.documentElement.dataset.clerkTheme === "light"
        ? clerkLightTheme()
        : clerkDarkTheme();
}

// ===== CLERK LIGHT THEME (redesigned pages) =====
// Same keys as the dark one below, in the app's own palette: Midnight Violet on
// a violet-tinted grey ramp, DM Sans throughout.
function clerkLightTheme() {
    return {
        variables: {
            colorBackground:        "#FFFFFF",
            colorInputBackground:   "#F4F3FA",
            colorInputText:         "#281F3E",
            colorText:              "#281F3E",
            colorTextSecondary:     "#8B8399",
            /* --lock-deep, not the --primary the page's own buttons use: an
               account panel should not read as another New session dialog. */
            colorPrimary:           "#4A3FBF",
            colorDanger:            "#DC0D0D",
            borderRadius:           "10px",
            fontFamily:             "'DM Sans', sans-serif",
        },
        elements: {
            card: {
                background: "#FFFFFF",
                border: "1px solid #E2DEE7",
                boxShadow: "0 24px 60px -20px rgba(40,31,62,.34)",
                borderRadius: "16px",
            },
            headerTitle: {
                fontFamily: "'DM Sans', sans-serif",
                fontWeight: "700",
                letterSpacing: "-.02em",
                color: "#281F3E",
            },
            headerSubtitle: {
                color: "#8B8399",
            },
            socialButtonsBlockButton: {
                background: "#FFFFFF",
                border: "1px solid #E2DEE7",
                color: "#281F3E",
            },
            socialButtonsBlockButton__google: {
                background: "#FFFFFF",
            },
            formButtonPrimary: {
                background: "#4A3FBF",
                color: "#FFFFFF",
                fontFamily: "'DM Sans', sans-serif",
                fontSize: "13.5px",
                fontWeight: "600",
                textTransform: "none",
            },
            footerActionLink: {
                color: "#4A3FBF",
            },
            dividerLine: {
                background: "#E2DEE7",
            },
            dividerText: {
                color: "#8B8399",
            },
        }
    };
}

// ===== CLERK DARK THEME =====
function clerkDarkTheme() {
    return {
        variables: {
            colorBackground:        "#14141a",
            colorInputBackground:   "#1c1c26",
            colorInputText:         "#f0ebe0",
            colorText:              "#f0ebe0",
            colorTextSecondary:     "#7a7a8a",
            colorPrimary:           "#e8a020",
            colorDanger:            "#e05252",
            borderRadius:           "8px",
            fontFamily:             "'DM Mono', monospace",
        },
        elements: {
            card: {
                background: "#14141a",
                border: "1px solid rgba(255,255,255,0.07)",
                boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
                borderRadius: "16px",
            },
            headerTitle: {
                fontFamily: "'DM Serif Display', serif",
                color: "#f0ebe0",
            },
            headerSubtitle: {
                color: "#7a7a8a",
            },
            socialButtonsBlockButton: {
                background: "#1c1c26",
                border: "1px solid rgba(255,255,255,0.07)",
                color: "#f0ebe0",
            },
            socialButtonsBlockButton__google: {
                background: "#1c1c26",
            },
            formButtonPrimary: {
                background: "#e8a020",
                color: "#0d0d11",
                fontFamily: "'DM Mono', monospace",
                fontSize: "13px",
            },
            footerActionLink: {
                color: "#e8a020",
            },
            dividerLine: {
                background: "rgba(255,255,255,0.07)",
            },
            dividerText: {
                color: "#7a7a8a",
            },
        }
    };
}

//=========15 SEC NUDGE (only on index.html && !signed in)
function startNudgeTimer(clerk){
    if(window.location.pathname !== "/") return;
    if(clerk.user) return;

    setTimeout(() => {
         // Don't show if they already signed in or nudge already showing
         if(clerk.user) return;
         if(document.getElementById("clerk-nudge")) return;

         const nudge = document.createElement("div")
         nudge.id = "clerk-nudge";
        nudge.style.cssText = `
            position: fixed;
            top: 68px;
            right: 24px;
            width: 300px;
            background: #14141a;
            border: 1px solid rgba(232,160,32,0.25);
            border-radius: 14px;
            padding: 20px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(232,160,32,0.05);
            z-index: 999;
            font-family: 'DM Mono', monospace;
            animation: nudge-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        `;

        nudge.innerHTML = `
            <style>
                @keyframes nudge-slide-in {
                    from { opacity: 0; transform: translateY(-8px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
            </style>

            <button id="nudge-close" style="
                position: absolute; top: 12px; right: 14px;
                background: transparent; border: none;
                color: #7a7a8a; font-size: 14px; cursor: pointer;
                line-height: 1;
            ">✕</button>

            <div style="font-size: 20px; margin-bottom: 8px;">🎓</div>

            <div style="color: #f0ebe0; font-size: 13px; font-weight: 500; margin-bottom: 6px;">
                Enjoying ClassRec?
            </div>
            <div style="color: #7a7a8a; font-size: 12px; line-height: 1.6; margin-bottom: 16px;">
                Sign up free and get unlimited transcription. No credit card needed.
            </div>

            <button id="nudge-cta" style="
                width: 100%;
                background: var(--accent);
                color: #0d0d11;
                border: none;
                border-radius: 7px;
                padding: 9px 0;
                font-family: 'DM Mono', monospace;
                font-size: 12px;
                font-weight: 500;
                letter-spacing: 0.04em;
                cursor: pointer;
                transition: all 0.2s;
            ">Become a Rec Member →</button>
        `;
        document.body.appendChild(nudge);

        document.getElementById("nudge-close").addEventListener("click", () => nudge.remove());
        document.getElementById("nudge-cta").addEventListener("click", () => {
            nudge.remove();
            showAuthModal(clerk);
        });

        // Auto dismiss after 8 seconds
        setTimeout(() => {
            if (document.getElementById("clerk-nudge")) nudge.remove();
        }, NUDGE_END_TIME);



    } , NUDGE_START_TIME)


}