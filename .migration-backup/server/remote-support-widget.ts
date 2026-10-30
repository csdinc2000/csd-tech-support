/**
 * Canonical Remote Support widget, served same-origin by the app at
 * /remote-support (and /support). Embedded into the WordPress site via an
 * iframe — see the [csd_remote_support] shortcode in
 * wordpress-plugin/csd-forms.php — exactly like the intake form.
 *
 * Serving it from the app (rather than pasting raw HTML into WordPress) keeps
 * the redeem-code fetch SAME-ORIGIN, so no CORS configuration is needed. The
 * MeshCentral session it redirects to lives on remote.computersystemsdepot.com
 * (resolved server-side from MESHCENTRAL_URL); this page only collects the code.
 *
 * Bundled as a string (not read from disk) so it survives the esbuild bundle in
 * production without shipping extra static files.
 */

export const REMOTE_SUPPORT_WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Connect to a CSD Technician</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: transparent; }
    #csd-support {
      --csd-red: #c8102e; --csd-ink: #1a1a1a; --csd-muted: #6b7280; --csd-line: #e5e7eb;
      max-width: 460px; margin: 0 auto; padding: 28px;
      border: 1px solid var(--csd-line); border-radius: 14px; background: #fff;
      box-shadow: 0 6px 24px rgba(0,0,0,.06);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--csd-ink);
    }
    #csd-support h2 { margin: 0 0 4px; font-size: 1.35rem; }
    #csd-support .csd-sub { margin: 0 0 20px; color: var(--csd-muted); font-size: .95rem; }
    #csd-support label { display: block; font-weight: 600; font-size: .9rem; margin-bottom: 8px; }
    #csd-support .csd-code {
      width: 100%; font-size: 2rem; letter-spacing: .55em; text-align: center;
      padding: 14px 10px 14px 24px; border: 2px solid var(--csd-line); border-radius: 10px;
      font-variant-numeric: tabular-nums; transition: border-color .15s ease;
    }
    #csd-support .csd-code:focus { outline: none; border-color: var(--csd-red); }
    #csd-support .csd-code.csd-invalid { border-color: var(--csd-red); background: #fff5f5; }
    #csd-support button {
      width: 100%; margin-top: 16px; padding: 14px; font-size: 1rem; font-weight: 700;
      color: #fff; background: var(--csd-red); border: 0; border-radius: 10px; cursor: pointer;
      transition: opacity .15s ease;
    }
    #csd-support button:hover { opacity: .92; }
    #csd-support button:disabled { opacity: .5; cursor: not-allowed; }
    #csd-support .csd-msg { margin-top: 14px; font-size: .9rem; min-height: 1.2em; }
    #csd-support .csd-msg.err { color: var(--csd-red); }
    #csd-support .csd-notice {
      margin-top: 22px; padding: 14px 16px; background: #fff8e6; border: 1px solid #facc15;
      border-radius: 10px; font-size: .85rem; line-height: 1.5; color: #713f12;
    }
    #csd-support .csd-notice strong { display: block; margin-bottom: 2px; }
    #csd-support .csd-notice a { color: #713f12; font-weight: 700; }
    #csd-support .csd-secure { margin-top: 14px; text-align: center; font-size: .78rem; color: var(--csd-muted); }
  </style>
</head>
<body>
  <div id="csd-support" data-endpoint="/api/support/redeem-code">
    <h2>Connect to a CSD Technician</h2>
    <p class="csd-sub">Enter the 6-digit support code your technician gave you over the phone.</p>

    <form id="csd-support-form" novalidate>
      <label for="csd-code-input">Support Code</label>
      <input id="csd-code-input" class="csd-code" type="text" inputmode="numeric"
             autocomplete="one-time-code" maxlength="6" placeholder="------"
             aria-describedby="csd-support-msg" />
      <button type="submit" id="csd-support-btn" disabled>Start Secure Session</button>
      <p class="csd-msg" id="csd-support-msg" role="status" aria-live="polite"></p>
    </form>

    <div class="csd-notice" role="note">
      <strong>⚠️ Your safety comes first.</strong>
      Only enter a code given to you over the phone by a verified Computer Systems
      Depot technician. We will <em>never</em> ask for a code through a text, email,
      or pop-up. If you didn't call us, call
      <a href="tel:954-637-7300">954-637-7300</a> before entering anything.
    </div>
    <p class="csd-secure">🔒 Secure connection · Computer Systems Depot, Lauderhill FL · Since 1996</p>
  </div>

  <script>
  (function () {
    var root  = document.getElementById("csd-support");
    var form  = document.getElementById("csd-support-form");
    var input = document.getElementById("csd-code-input");
    var btn   = document.getElementById("csd-support-btn");
    var msg   = document.getElementById("csd-support-msg");
    var endpoint = root.getAttribute("data-endpoint");

    function setMsg(text, isError) {
      msg.textContent = text || "";
      msg.className = "csd-msg" + (isError ? " err" : "");
    }

    input.addEventListener("input", function () {
      input.value = input.value.replace(/\\D/g, "").slice(0, 6);
      input.classList.remove("csd-invalid");
      btn.disabled = input.value.length !== 6;
      setMsg("");
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var code = input.value;
      if (!/^\\d{6}$/.test(code)) {
        input.classList.add("csd-invalid");
        setMsg("Please enter the full 6-digit code.", true);
        return;
      }
      btn.disabled = true;
      setMsg("Verifying your code…", false);

      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ code: code })
      })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (data) {
          if (data && data.ok && data.redirectUrl) {
            setMsg("Connecting you now…", false);
            // Break out of the iframe so the MeshCentral session opens full-page.
            (window.top || window).location.assign(data.redirectUrl);
            return;
          }
          setMsg((data && data.message) || "That code wasn't recognized or has expired. Please call us at 954-637-7300.", true);
          input.classList.add("csd-invalid");
          btn.disabled = false;
        })
        .catch(function () {
          setMsg("We couldn't reach the support server. Please call 954-637-7300.", true);
          btn.disabled = false;
        });
    });
  })();
  </script>
</body>
</html>`;
