/*
 * HourglassPost: a static, server-less disposable inbox.
 *
 * Mail provider: Guerrilla Mail's free public JSON API (https://www.guerrillamail.com/GuerrillaMailAPI.html).
 * It needs no key and allows cross-origin requests from any site, so this page works on GitHub Pages.
 * (mail.tm was checked first, but its API only allows requests from mail.tm's own websites (CORS),
 * and its terms forbid proxying, so it can't be used from a page hosted elsewhere.)
 *
 * Privacy: the session token (sid_token) is kept only in sessionStorage, so it's forgotten when
 * the tab closes. No cookies are sent (we pass the token as a parameter), and there's no tracking.
 */
(function () {
  "use strict";

  var API = "https://api.guerrillamail.com/ajax.php";
  var POLL_MS = 10000;          // auto-refresh about every 10 seconds
  var MAX_BACKOFF_MS = 120000;  // after errors, wait up to 2 minutes between tries
  var REQUEST_TIMEOUT_MS = 15000;
  var ADDRESS_LIFETIME_S = 3600; // Guerrilla Mail keeps mail for about 60 minutes
  var STORE_KEY = "hourglasspost-session";
  var THEME_KEY = "hourglasspost-theme";

  // ---------- small helpers ----------
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    address: $("address"), copyBtn: $("copy-btn"), copyLabel: $("copy-label"), newBtn: $("new-btn"),
    meta: $("address-meta"), alert: $("alert"), inbox: $("inbox"), listPanel: $("list-panel"),
    list: $("message-list"), count: $("count"), empty: $("empty-state"), emptyTitle: $("empty-title"),
    emptyText: $("empty-text"), skeletons: $("skeletons"), progress: $("progress"),
    refreshBtn: $("refresh-btn"), refreshStatus: $("refresh-status"), reader: $("reader"),
    readerSubject: $("reader-subject"), readerFrom: $("reader-from"), readerDate: $("reader-date"),
    readerLoading: $("reader-loading"), readerFrame: $("reader-frame"), readerText: $("reader-text"),
    viewHtml: $("view-html"), viewText: $("view-text"), deleteBtn: $("delete-btn"), backBtn: $("back-btn"),
    themeToggle: $("theme-toggle"), toast: $("toast")
  };

  /** Storage that never throws (sandboxed iframes and some privacy modes block it). */
  function safeStorage(kind) {
    var mem = {};
    var store = null;
    try { store = window[kind]; var k = "__t"; store.setItem(k, k); store.removeItem(k); } catch (e) { store = null; }
    return {
      get: function (key) { try { return store ? store.getItem(key) : (key in mem ? mem[key] : null); } catch (e) { return null; } },
      set: function (key, val) { try { if (store) store.setItem(key, val); else mem[key] = val; } catch (e) { mem[key] = val; } },
      remove: function (key) { try { if (store) store.removeItem(key); } catch (e) { /* ignore */ } delete mem[key]; }
    };
  }
  var session = safeStorage("sessionStorage");
  var prefs = safeStorage("localStorage");

  /** Guerrilla Mail returns subjects and excerpts HTML-escaped; decode to plain text safely (nothing is executed). */
  function decodeEntities(s) {
    if (!s) return "";
    var doc = new DOMParser().parseFromString("<!doctype html><body>" + String(s), "text/html");
    return doc.body.textContent || "";
  }

  /** Turn an HTML email into readable plain text (DOMParser never runs scripts or loads images). */
  function htmlToText(html) {
    var prepared = String(html || "")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote|pre)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ");
    var doc = new DOMParser().parseFromString(prepared, "text/html");
    doc.querySelectorAll("script,style,head,title").forEach(function (n) { n.remove(); });
    doc.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (/^https?:/i.test(href) && a.textContent.trim() !== href) a.append(" (" + href + ")");
    });
    return (doc.body ? doc.body.textContent : "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function localPart(addr) { return String(addr || "").split("@")[0].toLowerCase(); }

  function randomUsername() {
    var letters = "abcdefghijkmnpqrstuvwxyz", chars = letters + "23456789";
    var bytes = new Uint8Array(10);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var out = letters[bytes[0] % letters.length];
    for (var i = 1; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  function formatTime(unix, fallback) {
    var n = Number(unix);
    if (!n) return fallback || "";
    var d = new Date(n * 1000), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  var toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove("is-visible"); }, 2600);
  }

  // ---------- errors and the API ----------
  function ApiError(kind, message) { this.kind = kind; this.message = message; }
  ApiError.prototype = Object.create(Error.prototype);

  function friendlyError(err) {
    if (err && err.kind === "rate") return "The mail service is getting too many requests right now. We'll slow down and try again automatically.";
    if (err && err.kind === "timeout") return "The mail service is taking too long to answer. We'll keep trying.";
    if (err && err.kind === "server") return "The mail service is having trouble (" + err.message + "). We'll try again shortly.";
    if (err && err.kind === "offline") return "You seem to be offline. We'll reconnect when your internet is back.";
    if (err && err.kind === "network") return "Can't reach the mail service. Check your connection or any blocker extension. We'll keep trying.";
    if (err && err.kind === "bad") return "The mail service sent an unexpected answer. Please try again.";
    return "Something went wrong: " + ((err && err.message) || "unknown error");
  }

  var state = { sid: "", address: "", ts: 0, messages: [], seen: {}, deleted: {}, selectedId: null,
    view: "html", current: null, failures: 0, pollTimer: null, inflight: null, firstLoad: true, expired: false };

  function api(fn, params, method) {
    var q = new URLSearchParams();
    q.set("f", fn);
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (Array.isArray(v)) v.forEach(function (x) { q.append(k + "[]", String(x)); });
      else if (v !== undefined && v !== null) q.set(k, String(v));
    });
    if (state.sid) q.set("sid_token", state.sid);
    q.set("agent", (navigator.userAgent || "HourglassPost").slice(0, 160));

    if (!navigator.onLine) return Promise.reject(new ApiError("offline", "offline"));
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    var opts = { method: method || "GET", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: ctrl ? ctrl.signal : undefined };
    var url = API;
    if (opts.method === "GET") url += "?" + q.toString();
    else opts.body = q; // sent as application/x-www-form-urlencoded (a "simple" request: no CORS preflight)

    return fetch(url, opts).then(function (res) {
      if (res.status === 429) throw new ApiError("rate", "429");
      if (!res.ok) throw new ApiError("server", "HTTP " + res.status);
      return res.text();
    }, function (e) {
      if (e && e.name === "AbortError") throw new ApiError("timeout", "timeout");
      throw new ApiError(navigator.onLine ? "network" : "offline", String(e && e.message));
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { throw new ApiError("bad", "not JSON"); }
      if (!data || typeof data !== "object") throw new ApiError("bad", "empty answer");
      if (data.sid_token) { state.sid = data.sid_token; saveSession(); }
      return data;
    }).finally(function () { clearTimeout(timer); });
  }

  function saveSession() {
    if (!state.sid) return;
    session.set(STORE_KEY, JSON.stringify({ sid: state.sid, address: state.address, ts: state.ts }));
  }

  // ---------- UI state ----------
  function showAlert(message, retry) {
    el.alert.innerHTML = "";
    var p = document.createElement("p");
    p.textContent = message;
    el.alert.append(p);
    if (retry) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "btn btn--ghost btn--sm"; b.textContent = "Try again now";
      b.addEventListener("click", retry);
      el.alert.append(b);
    }
    el.alert.hidden = false;
  }
  function hideAlert() { el.alert.hidden = true; el.alert.textContent = ""; }

  function setBusy(busy) {
    el.progress.hidden = !busy;
    el.refreshBtn.classList.toggle("spinning", busy);
    el.listPanel.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function setAddress(address, ts) {
    state.address = address || "";
    state.ts = Number(ts) || Math.floor(Date.now() / 1000);
    state.expired = false;
    el.address.value = state.address;
    el.copyBtn.disabled = !state.address;
    el.newBtn.disabled = false;
    el.refreshBtn.disabled = !state.address;
    updateMeta();
    saveSession();
  }

  function updateMeta() {
    if (!state.address) return;
    var left = ADDRESS_LIFETIME_S - (Math.floor(Date.now() / 1000) - state.ts);
    if (left <= 0) {
      el.meta.textContent = "This address has expired. Click “New address” to get a fresh one.";
      if (!state.expired) { state.expired = true; stopPolling(); el.refreshStatus.textContent = "Paused (address expired)"; }
      return;
    }
    var mins = Math.max(1, Math.round(left / 60));
    el.meta.textContent = "Mail is kept for about an hour · this address expires in ~" + mins + " min";
  }

  function renderList() {
    var msgs = state.messages;
    el.count.textContent = String(msgs.length);
    el.count.setAttribute("aria-label", msgs.length + (msgs.length === 1 ? " message" : " messages"));
    el.skeletons.hidden = !state.firstLoad;
    el.empty.hidden = state.firstLoad || msgs.length > 0;
    el.list.innerHTML = "";
    msgs.forEach(function (m) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "message" + (Number(m.mail_read) ? "" : " is-unread") + (m._new ? " is-new" : "");
      btn.dataset.id = String(m.mail_id);
      if (String(m.mail_id) === String(state.selectedId)) btn.setAttribute("aria-current", "true");
      var from = decodeEntities(m.mail_from) || "Unknown sender";
      var subject = decodeEntities(m.mail_subject) || "(no subject)";
      var avatar = document.createElement("span"); avatar.className = "message__avatar"; avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = (from.replace(/[^A-Za-z0-9]/g, "")[0] || "?");
      var fromEl = document.createElement("span"); fromEl.className = "message__from"; fromEl.textContent = from;
      var timeEl = document.createElement("span"); timeEl.className = "message__time"; timeEl.textContent = formatTime(m.mail_timestamp, m.mail_date);
      var subjEl = document.createElement("span"); subjEl.className = "message__subject"; subjEl.textContent = subject;
      var exEl = document.createElement("span"); exEl.className = "message__excerpt"; exEl.textContent = decodeEntities(m.mail_excerpt).replace(/\s+/g, " ").trim();
      btn.setAttribute("aria-label", (Number(m.mail_read) ? "" : "Unread. ") + "From " + from + ". " + subject + ". " + timeEl.textContent);
      btn.append(avatar, fromEl, timeEl, subjEl, exEl);
      btn.addEventListener("click", function () { openMessage(m.mail_id); });
      li.append(btn);
      el.list.append(li);
      m._new = false;
    });
  }

  // ---------- polling ----------
  function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }
  function schedule(ms) {
    stopPolling();
    if (state.expired) return;
    state.pollTimer = setTimeout(function () { refresh(false); }, ms);
  }

  function refresh(manual) {
    if (!state.address) return Promise.resolve();
    if (state.inflight) return state.inflight;
    if (document.hidden && !manual) { stopPolling(); el.refreshStatus.textContent = "Paused while this tab is hidden"; return Promise.resolve(); }
    updateMeta();
    if (state.expired && !manual) return Promise.resolve();
    setBusy(true);
    state.inflight = api("check_email", { seq: 0 }).then(function (data) {
      // If the provider started a new session (ours timed out), get our address back.
      // (Compare only the part before "@": the same inbox can be reported under an alias domain.)
      if (data.email && state.address && localPart(data.email) !== localPart(state.address)) {
        return restoreAddress().then(function () { return api("check_email", { seq: 0 }); });
      }
      return data;
    }).then(function (data) {
      var list = Array.isArray(data.list) ? data.list : [];
      var fresh = [];
      list = list.filter(function (m) { return m && m.mail_id !== undefined && !state.deleted[m.mail_id]; });
      list.forEach(function (m) {
        if (!state.seen[m.mail_id]) { state.seen[m.mail_id] = true; if (!state.firstLoad) { m._new = true; fresh.push(m); } }
        var old = state.messages.find(function (x) { return String(x.mail_id) === String(m.mail_id); });
        if (old && Number(old.mail_read)) m.mail_read = 1;
      });
      list.sort(function (a, b) { return Number(b.mail_id) - Number(a.mail_id); });
      state.messages = list;
      state.firstLoad = false;
      state.failures = 0;
      hideAlert();
      renderList();
      if (fresh.length) toast(fresh.length === 1 ? "New email from " + decodeEntities(fresh[0].mail_from) : fresh.length + " new emails");
      el.refreshStatus.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      el.refreshStatus.title = "Checks for new mail automatically every 10 seconds";
      schedule(POLL_MS);
    }).catch(function (err) {
      state.failures++;
      var wait = Math.min(POLL_MS * Math.pow(2, state.failures), MAX_BACKOFF_MS);
      if (state.firstLoad) { state.firstLoad = false; renderList(); el.emptyTitle.textContent = "Inbox not loaded yet"; el.emptyText.textContent = "We'll keep trying in the background."; }
      showAlert(friendlyError(err), function () { state.failures = 0; refresh(true); });
      el.refreshStatus.textContent = "Retrying in " + Math.round(wait / 1000) + " s";
      schedule(wait);
    }).finally(function () { state.inflight = null; setBusy(false); });
    return state.inflight;
  }

  // ---------- address lifecycle ----------
  function restoreAddress() {
    var user = state.address.split("@")[0];
    return api("set_email_user", { email_user: user, lang: "en" }, "POST").then(function (data) {
      if (!data.email_addr) throw new ApiError("bad", "no address");
      setAddress(data.email_addr, data.email_timestamp || state.ts);
    });
  }

  function createAddress() {
    el.newBtn.disabled = true; el.copyBtn.disabled = true; el.refreshBtn.disabled = true;
    el.address.value = ""; el.address.placeholder = "Creating your address…";
    el.meta.textContent = "Creating a fresh address…";
    closeReader(false);
    stopPolling();
    var old = state.address;
    state.messages = []; state.seen = {}; state.deleted = {}; state.firstLoad = true; state.failures = 0;
    renderList();
    el.emptyTitle.textContent = "Waiting for email…";
    el.emptyText.textContent = "New messages appear here automatically. Keep this tab open.";

    var start = state.sid ? Promise.resolve() : api("get_email_address", { lang: "en" });
    return start.then(function () {
      if (old) return api("forget_me", { email_addr: old }, "POST").catch(function () { /* not important */ });
    }).then(function () {
      // Our own random name, so every click gives a brand-new address.
      return api("set_email_user", { email_user: randomUsername(), lang: "en" }, "POST");
    }).then(function (data) {
      if (!data.email_addr) throw new ApiError("bad", "no address");
      setAddress(data.email_addr, data.email_timestamp);
      hideAlert();
      return refresh(true);
    }).catch(function (err) {
      el.newBtn.disabled = false;
      el.address.placeholder = "No address yet";
      el.meta.textContent = "Couldn't create an address.";
      state.firstLoad = false; renderList();
      el.emptyTitle.textContent = "No inbox yet";
      el.emptyText.textContent = "Press “Try again now” or “New address”.";
      showAlert(friendlyError(err), function () { createAddress(); });
    });
  }

  function init() {
    var saved = null;
    try { saved = JSON.parse(session.get(STORE_KEY) || "null"); } catch (e) { saved = null; }
    renderList();
    if (saved && saved.sid && saved.address && Date.now() / 1000 - Number(saved.ts) < ADDRESS_LIFETIME_S) {
      state.sid = saved.sid;
      state.address = saved.address; state.ts = Number(saved.ts);
      el.meta.textContent = "Reconnecting to your address…";
      api("get_email_address", { lang: "en" }).then(function (data) {
        if (data.email_addr && localPart(data.email_addr) === localPart(saved.address)) setAddress(data.email_addr, data.email_timestamp || saved.ts);
        else return restoreAddress();
      }).then(function () { return refresh(true); }).catch(function () { state.sid = ""; state.address = ""; createAddress(); });
    } else {
      session.remove(STORE_KEY);
      createAddress();
    }
  }

  // ---------- reader ----------
  function emailDocument(html) {
    // Scripts can't run: the iframe sandbox has no allow-scripts. This CSP also blocks remote images,
    // tracking pixels, fonts and forms, so opening an email doesn't tell the sender anything.
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; form-action \'none\'">' +
      '<base target="_blank"><style>html{color-scheme:light}body{margin:16px;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#141824;overflow-wrap:anywhere}' +
      'img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:14px/1.55 ui-monospace,Menlo,Consolas,monospace}table{max-width:100%}</style></head><body>' +
      html + "</body></html>";
  }

  /**
   * Put the email into a brand-new sandboxed iframe each time. A reused iframe that started inside
   * a hidden panel can stay unpainted in Chrome, and a fresh frame also guarantees nothing from the
   * previous email survives. The sandbox has no allow-scripts and no allow-same-origin.
   */
  function mountFrame(doc) {
    var old = el.readerFrame;
    var frame = document.createElement("iframe");
    frame.id = "reader-frame";
    frame.className = "reader__frame";
    frame.title = "Message content";
    frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.hidden = old.hidden;
    frame.srcdoc = doc;
    old.replaceWith(frame);
    el.readerFrame = frame;
  }

  function setView(view) {
    state.view = view;
    el.viewHtml.setAttribute("aria-pressed", String(view === "html"));
    el.viewText.setAttribute("aria-pressed", String(view === "text"));
    var hasMsg = !!state.current;
    el.readerFrame.hidden = !hasMsg || view !== "html";
    el.readerText.hidden = !hasMsg || view !== "text";
  }

  function openMessage(id) {
    state.selectedId = id;
    state.current = null;
    el.inbox.classList.add("has-reader");
    el.reader.hidden = false;
    el.readerSubject.textContent = "Loading…";
    el.readerFrom.textContent = ""; el.readerDate.textContent = "";
    el.readerLoading.hidden = false;
    el.readerFrame.hidden = true; el.readerText.hidden = true;
    mountFrame("");
    renderList();
    el.readerSubject.focus();

    api("fetch_email", { email_id: id }).then(function (m) {
      if (String(state.selectedId) !== String(id)) return; // the user opened another one meanwhile
      if (!m || m.mail_id === undefined) throw new ApiError("bad", "message not found");
      state.current = m;
      el.readerLoading.hidden = true;
      el.readerSubject.textContent = decodeEntities(m.mail_subject) || "(no subject)";
      el.readerFrom.textContent = "From: " + (decodeEntities(m.mail_from) || "Unknown sender");
      el.readerDate.textContent = "· " + formatTime(m.mail_timestamp, m.mail_date);
      var body = String(m.mail_body || "");
      var text = htmlToText(body);
      el.readerText.textContent = text || "(This message has no text.)";
      var hasHtml = /<[a-z][\s\S]*>/i.test(body);
      el.viewHtml.disabled = !hasHtml;
      // Show the iframe BEFORE loading it: a document loaded into a display:none iframe can stay unpainted.
      setView(hasHtml && state.view === "html" ? "html" : "text");
      if (hasHtml) mountFrame(emailDocument(body));
      var item = state.messages.find(function (x) { return String(x.mail_id) === String(id); });
      if (item) { item.mail_read = 1; renderList(); }
    }).catch(function (err) {
      el.readerLoading.hidden = true;
      el.readerSubject.textContent = "Couldn't open this message";
      el.readerText.textContent = friendlyError(err);
      el.readerText.hidden = false;
    });
  }

  function closeReader(focusList) {
    var id = state.selectedId;
    state.selectedId = null; state.current = null;
    el.reader.hidden = true;
    el.inbox.classList.remove("has-reader");
    mountFrame("");
    renderList();
    if (focusList) {
      var btn = id !== null && el.list.querySelector('[data-id="' + String(id).replace(/[^0-9A-Za-z_-]/g, "") + '"]');
      (btn || el.inbox).focus();
    }
  }

  function deleteCurrent() {
    var id = state.selectedId;
    if (id === null) return;
    el.deleteBtn.disabled = true;
    api("del_email", { email_ids: [id] }, "POST").then(function () {
      state.deleted[id] = true;
      state.messages = state.messages.filter(function (m) { return String(m.mail_id) !== String(id); });
      closeReader(false);
      el.inbox.focus();
      toast("Message deleted");
    }).catch(function (err) { showAlert(friendlyError(err)); })
      .finally(function () { el.deleteBtn.disabled = false; });
  }

  // ---------- copy ----------
  function copyAddress() {
    var value = el.address.value;
    if (!value) return;
    var done = function () {
      el.copyLabel.textContent = "Copied!";
      toast("Address copied to clipboard");
      setTimeout(function () { el.copyLabel.textContent = "Copy"; }, 1800);
    };
    var fallback = function () {
      el.address.focus(); el.address.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      if (ok) done(); else toast("Press Ctrl+C (or ⌘C) to copy the selected address");
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(value).then(done, fallback);
    else fallback();
  }

  // ---------- theme ----------
  function currentTheme() {
    var t = document.documentElement.dataset.theme;
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function syncThemeButton() {
    var next = currentTheme() === "dark" ? "light" : "dark";
    el.themeToggle.setAttribute("aria-label", "Switch to " + next + " mode");
    el.themeToggle.title = "Switch to " + next + " mode";
  }

  // ---------- wire up ----------
  el.copyBtn.addEventListener("click", copyAddress);
  el.address.addEventListener("focus", function () { el.address.select(); });
  el.newBtn.addEventListener("click", function () { createAddress().then(function () { if (state.address) toast("New address ready"); }); });
  el.refreshBtn.addEventListener("click", function () { state.failures = 0; refresh(true); });
  el.backBtn.addEventListener("click", function () { closeReader(true); });
  el.deleteBtn.addEventListener("click", deleteCurrent);
  el.viewHtml.addEventListener("click", function () { setView("html"); });
  el.viewText.addEventListener("click", function () { setView("text"); });
  el.themeToggle.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    prefs.set(THEME_KEY, next);
    syncThemeButton();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !el.reader.hidden) closeReader(true); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && state.address && !state.expired) refresh(false); });
  window.addEventListener("online", function () { state.failures = 0; refresh(true); });
  setInterval(updateMeta, 30000);

  syncThemeButton();
  init();
})();
