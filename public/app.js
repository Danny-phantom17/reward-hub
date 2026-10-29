const app = document.getElementById("app");
const navActions = document.getElementById("navActions");
const bottomNav = document.getElementById("bottomNav");
let csrfToken = null;

function handleNavigationClick(event) {
  const link = event.target.closest("a[data-app-route]");
  if (!link || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go(link.getAttribute("href"));
}
navActions.addEventListener("click", handleNavigationClick);
bottomNav.addEventListener("click", handleNavigationClick);

async function api(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (!csrfToken && method !== "GET" && method !== "HEAD") {
    const csrfResponse = await fetch("/api/csrf");
    csrfToken = (await csrfResponse.json()).csrfToken;
  }
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}), ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.error?.includes("security token")) csrfToken = null;
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

async function getMe() {
  try { return await api("/api/me"); } catch { return null; }
}

function layout(content) {
  app.innerHTML = content;
}

async function refreshNav() {
  const me = await getMe();
  const dashboardPath = me?.role === "admin" ? "/admin" : me?.role === "advertiser" ? "/advertiser" : "/dashboard";
  const active = path => location.pathname === path ? ' aria-current="page"' : "";
  const link = (path, label, extra = "") => `<a class="nav-link ${extra}" data-app-route href="${path}"${active(path)}>${label}</a>`;
  const icon = {
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
    earn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 10 6-10 6z"/><circle cx="12" cy="12" r="10"/></svg>',
    recent: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18m-5 5h2"/><path d="M6 5V4a2 2 0 0 1 2-2h10"/></svg>',
    faq: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 4.6 1.3c-.8 1.1-2.2 1.3-2.2 3M12 17h.01"/></svg>',
    facts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5zM9 8h6M9 12h6M9 16h4"/></svg>'
  };
  const tab = (path, label, glyph, activePath = path) => {
    const target = new URL(path, location.origin);
    const isActive = location.pathname === activePath && (target.hash ? location.hash === target.hash : !location.hash);
    return `<a class="bottom-tab" data-app-route href="${path}"${isActive ? ' aria-current="page"' : ""}><span class="bottom-tab-icon">${icon[glyph]}</span><span class="bottom-tab-label">${label}</span></a>`;
  };
  const publicLinks = `${link("/", "Home")}${link("/faq", "FAQs")}${link("/policies", "Facts")}`;
  if (!me) {
    navActions.innerHTML = `<div class="nav-links">${publicLinks}${link("/login", "Recent")}${link("/login", "Dashboard")}</div><div class="nav-cta">${link("/login", "Earn", "nav-link-button nav-link-primary")}${link("/login", "Withdraw", "nav-link-button")}${link("/login", "Login", "nav-link-button")}${link("/register", "Create account", "nav-link-button nav-link-primary")}</div>`;
    bottomNav.innerHTML = `${tab("/", "Home", "home")}${tab("/faq", "FAQs", "faq")}${tab("/policies", "Facts", "facts")}${tab("/login", "Dashboard", "dashboard")}${tab("/register", "Join", "earn")}`;
    return;
  }
  const userLinks = me.role === "user"
    ? `${link("/transactions", "Recent")}${link("/dashboard", "Dashboard")}`
    : `${link(dashboardPath, me.role === "admin" ? "Admin" : "Business")}`;
  const userActions = `<div class="nav-cta">${me.role === "user" ? `${link("/dashboard#campaignsSection", "Earn", "nav-link-button nav-link-primary")}${link("/withdraw", "Withdraw", "nav-link-button")}` : link(dashboardPath, me.role === "admin" ? "Operations" : "Campaigns", "nav-link-button nav-link-primary")}</div>`;
  navActions.innerHTML = `<div class="nav-links">${publicLinks}${userLinks}</div>${userActions}<button class="btn secondary nav-logout" onclick="logout()">Logout</button>`;
  bottomNav.innerHTML = me.role === "user"
    ? `${tab("/", "Home", "home")}${tab("/dashboard#campaignsSection", "Earn", "earn", "/dashboard")}${tab("/transactions", "Recent", "recent")}${tab("/dashboard", "Dashboard", "dashboard")}${tab("/withdraw", "Withdraw", "wallet")}`
    : `${tab("/", "Home", "home")}${tab("/faq", "FAQs", "faq")}${tab("/policies", "Facts", "facts")}${tab(dashboardPath, me.role === "admin" ? "Admin" : "Workspace", "dashboard", dashboardPath)}${tab("/support", "Support", "recent")}`;
}

async function logout() {
  await api("/api/logout", { method:"POST" });
  csrfToken = null;
  go("/");
}

function go(path) {
  history.pushState({}, "", path);
  render().then(() => {
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

window.addEventListener("popstate", render);

async function home() {
  const settings = await api("/api/public/settings").catch(() => ({ coinRateRc: 10000, coinRateKobo: 100000, minimumWithdrawalRc: 20000, fundingConfigured: false }));
  const minimumKobo = Number(settings.minimumWithdrawalRc) * Number(settings.coinRateKobo) / Number(settings.coinRateRc);
  layout(`
    <section class="hero">
      <span class="eyebrow">Reward Hub · Sponsored activities</span>
      <h1>Spend time on<br>what matters.</h1>
      <p>Explore advertiser-funded campaigns, complete the stated requirements and earn Reward Coins. Rewards are reviewed before they become available to withdraw.</p>
      <div class="actions">
        <button class="btn" style="background:var(--lime);color:var(--green-dark)" onclick="go('/register')">Explore Reward Hub →</button>
        <button class="btn secondary" onclick="go('/login')">Sign in</button>
      </div>
    </section>
    <div class="stats">
      <div class="stat"><span class="muted">Conversion</span><strong>${Number(settings.coinRateRc).toLocaleString()} RC = ${nairaFromKobo(settings.coinRateKobo)}</strong><small>Coin rate is administrator-configurable</small></div>
      <div class="stat"><span class="muted">Minimum withdrawal</span><strong>${Number(settings.minimumWithdrawalRc).toLocaleString()} RC</strong><small>${nairaFromKobo(minimumKobo)} · after reward approval</small></div>
      <div class="stat"><span class="muted">Campaign funding</span><strong>${settings.fundingConfigured ? "Manual reconciliation" : "Not configured"}</strong><small>Unfunded campaigns do not earn rewards</small></div>
    </div>
    <div class="section-head"><div><span class="eyebrow">For participants</span><h2>Clear steps. Clear rewards.</h2></div></div>
    <section class="grid">
      <div class="card"><span class="badge">01 · Browse</span><h3>Choose a sponsored task</h3><p class="muted">Review the sponsor, requirements, estimated time, and RC reward before starting.</p></div>
      <div class="card"><span class="badge">02 · Complete</span><h3>Meet the task rules</h3><p class="muted">Submitted completions wait for review before the RC becomes available.</p></div>
      <div class="card"><span class="badge">03 · Withdraw</span><h3>Know the cash value</h3><p class="muted">${Number(settings.coinRateRc).toLocaleString()} RC converts to ${nairaFromKobo(settings.coinRateKobo)}. Approved RC must meet the ${Number(settings.minimumWithdrawalRc).toLocaleString()} RC threshold.</p></div>
    </section>
    <section class="panel" style="margin-top:26px"><div class="row"><div><span class="eyebrow">For advertisers</span><h2>Fund measurable campaigns</h2><p class="muted">Submit video visibility campaigns for review. Campaigns go live only after approval and verified full funding. Action objectives remain disabled until measurement integrations are available.</p></div><button class="btn secondary" onclick="go('/register?type=advertiser')">Create advertiser account</button></div></section>
    <p class="muted">Rewards are not guaranteed income. Video tasks use a server-enforced elapsed-time requirement and manual review; this does not prove a video was watched or an external action occurred. See <a href="/faq" onclick="event.preventDefault();go('/faq')" style="color:var(--green);text-decoration:underline">FAQs and policies</a>.</p>
  `);
}

function nairaFromKobo(kobo) {
  return `₦${Math.floor(Number(kobo || 0) / 100).toLocaleString("en-NG")}`;
}

function authPage(type) {
  const register = type === "register";
  layout(`
    <div class="form-card">
      <h2>${register ? "Create your account" : "Welcome back"}</h2>
      <p class="muted">${register ? "Join RewardHub and discover sponsored campaigns." : "Sign in to continue."}</p>
      <form id="authForm">
        ${register ? `<label>Name</label><input name="name" required>` : ""}
        ${register ? `<label>Account type</label><select name="accountType" id="accountType"><option value="user">I want to earn rewards</option><option value="advertiser">I represent a business</option></select><div id="businessField" hidden><label>Business name</label><input name="businessName" id="businessName" maxlength="150"></div>` : ""}
        <label>Email</label><input name="email" type="email" required>
        <label>Password</label><input name="password" type="password" minlength="${register ? 12 : 1}" required autocomplete="${register ? "new-password" : "current-password"}">
        <br><br><button class="btn">${register ? "Create account" : "Sign in"}</button>
        ${!register ? `<button type="button" class="btn secondary" style="margin-left:8px" onclick="go('/forgot-password')">Forgot password?</button>` : ""}
        <p id="msg"></p>
      </form>
    </div>
  `);
  document.getElementById("authForm").onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const result = await api(register ? "/api/register" : "/api/login", {
        method:"POST", body:JSON.stringify(body)
      });
      csrfToken = null;
      go(result.role === "admin" ? "/admin" : result.role === "advertiser" ? "/advertiser" : "/dashboard");
    } catch (err) {
      document.getElementById("msg").className = "error";
      document.getElementById("msg").textContent = err.message;
    }
  };
  if (register) {
    const accountType = document.getElementById("accountType");
    accountType.value = new URLSearchParams(location.search).get("type") === "advertiser" ? "advertiser" : "user";
    accountType.onchange = () => {
      const show = accountType.value === "advertiser";
      document.getElementById("businessField").hidden = !show;
      document.getElementById("businessName").required = show;
    };
    accountType.onchange();
  }
}

function forgotPasswordPage() {
  layout(`<div class="form-card"><h2>Recover your account</h2><p class="muted">Enter the email on your account and we’ll send a password reset link if it exists.</p><form id="forgotForm"><label>Email</label><input name="email" type="email" required autocomplete="email"><br><br><button class="btn">Send reset link</button><p id="msg" role="status"></p></form><button class="btn secondary" onclick="go('/login')">Back to sign in</button></div>`);
  document.getElementById("forgotForm").onsubmit = async event => {
    event.preventDefault();
    const msg = document.getElementById("msg");
    try {
      const result = await api("/api/password/forgot", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
      msg.className = "success";
      msg.textContent = result.message;
    } catch (error) { msg.className = "error"; msg.textContent = error.message; }
  };
}

function resetPasswordPage() {
  const token = new URLSearchParams(location.search).get("token") || "";
  layout(`<div class="form-card"><h2>Choose a new password</h2><p class="muted">Use at least 12 characters. Reset links expire after 30 minutes.</p><form id="resetForm"><label>New password</label><input name="password" type="password" minlength="12" maxlength="200" required autocomplete="new-password"><label>Confirm password</label><input name="confirmPassword" type="password" minlength="12" maxlength="200" required autocomplete="new-password"><br><br><button class="btn">Update password</button><p id="msg" role="status"></p></form></div>`);
  document.getElementById("resetForm").onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    const msg = document.getElementById("msg");
    if (values.password !== values.confirmPassword) { msg.className = "error"; msg.textContent = "The passwords do not match."; return; }
    try {
      const result = await api("/api/password/reset", { method: "POST", body: JSON.stringify({ token, password: values.password }) });
      msg.className = "success";
      msg.textContent = result.message;
      event.target.reset();
      setTimeout(() => go("/login"), 1500);
    } catch (error) { msg.className = "error"; msg.textContent = error.message; }
  };
}

async function dashboard() {
  const me = await getMe();
  if (!me) return go("/login");
  if (me.role !== "user") return go(me.role === "admin" ? "/admin" : "/advertiser");
  const [campaigns, transactions, withdrawals, notifications] = await Promise.all([
    api("/api/campaigns"), api("/api/transactions"), api("/api/withdrawals"), api("/api/notifications")
  ]);
  const settings = me.settings;
  const availableKobo = convertRcToKoboClient(me.available_rc, settings);
  const minimum = Number(settings.minimumWithdrawalRc);
  const remaining = Math.max(0, minimum - Number(me.available_rc));
  const progress = minimum ? Math.min(100, Math.floor(Number(me.available_rc) * 100 / minimum)) : 0;

  layout(`
    <span class="eyebrow">Your wallet · Reward Coins</span><h1>Welcome, ${escapeHtml(me.name.split(" ")[0])}</h1>
    <p class="muted">Approved rewards are available to withdraw. Submitted tasks remain pending until reviewed.</p>
    <div class="stats">
      <div class="stat"><span class="muted">Available</span><strong>${Number(me.available_rc).toLocaleString()} RC</strong><small>${nairaFromKobo(availableKobo)} cash equivalent</small></div>
      <div class="stat"><span class="muted">Pending review</span><strong>${Number(me.pending_rc).toLocaleString()} RC</strong><small>Not yet withdrawable</small></div>
      <div class="stat"><span class="muted">Minimum withdrawal</span><strong>${minimum.toLocaleString()} RC</strong><small>${nairaFromKobo(convertRcToKoboClient(minimum, settings))}</small></div>
      <div class="stat"><span class="muted">Approved tasks</span><strong>${transactions.filter(t => t.status === "approved").length}</strong><small>Rewards credited</small></div>
    </div>
    <div class="panel"><div class="row"><div><strong>Withdrawal eligibility</strong><p class="muted">${remaining ? `You need ${remaining.toLocaleString()} more RC before you can request a withdrawal.` : `You meet the ${minimum.toLocaleString()} RC minimum.`}</p></div>
      <button class="btn" ${remaining || !settings.bankPayoutConfigured ? "disabled" : ""} onclick="go('/withdraw')">Request withdrawal</button></div>
      <div class="progress" aria-label="Withdrawal threshold progress"><span style="width:${progress}%"></span></div>
      ${!settings.bankPayoutConfigured ? `<p class="metric-caption">Bank withdrawals are unavailable until secure bank-detail encryption is configured.</p>` : ""}
    </div>
    ${me.legacy_balance_kobo ? `<div class="notice warning"><strong>Legacy balance under reconciliation</strong><br>${nairaFromKobo(me.legacy_balance_kobo)} from the previous balance system is preserved for administrator review and is not included in your available RC.</div>` : ""}

    <div class="section-head" id="campaignsSection"><div><h2>Available sponsored tasks</h2><span class="muted">Only approved and fully funded campaigns appear here.</span></div></div>
    ${campaigns.length ? `<div class="grid">
      ${campaigns.map(c => `
        <div class="card campaign-card">
          <span class="badge">${escapeHtml(c.advertiser)}</span>
          <h3>${escapeHtml(c.title)}</h3>
          <p class="muted">${escapeHtml(c.description)}</p>
          <p class="metric-caption">Video visibility · About ${Number(c.duration_seconds)} sec · Review after completion</p>
          <div class="row">
            <strong>${Number(c.reward).toLocaleString()} RC</strong>
            ${c.completed
              ? `<span class="status ${escapeHtml(c.completion_status || "pending")}">${escapeHtml(c.completion_status || "Submitted")}</span>`
              : `<button class="btn" onclick="watch(${c.id})">Watch</button>`}
          </div>
        </div>
      `).join("")}
    </div>` : `<div class="panel empty"><h3>No sponsored tasks are available right now.</h3><p>New tasks appear when advertisers submit eligible campaigns and their funding is confirmed.</p></div>`}

    <div class="section-head"><div><h2>Reward history</h2><span class="muted">Task submissions and approved RC credits</span></div><button class="btn secondary" onclick="go('/transactions')">All transactions</button></div>
    <div class="table-wrap">
      ${transactions.length ? `<table><thead><tr><th>Campaign</th><th>Reward</th><th>Status</th><th>Reference</th><th>Date</th></tr></thead><tbody>
        ${transactions.map(t => `<tr><td>${escapeHtml(t.title)}</td><td>${t.status === "legacy_review" ? `Legacy · ${nairaFromKobo(t.legacy_amount_kobo)}` : `${Number(t.amount_rc).toLocaleString()} RC`}</td><td><span class="status ${escapeHtml(t.status)}">${t.status === "legacy_review" ? "Legacy review · not spendable" : escapeHtml(t.status)}</span>${t.rejection_reason ? `<br><span class="muted">${escapeHtml(t.rejection_reason)}</span>` : ""}</td><td>${escapeHtml(t.reference || "—")}</td><td>${escapeHtml(t.created_at)}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">No task reward records yet.</div>`}
    </div>
    <div class="section-head"><div><h2>Withdrawal requests</h2><span class="muted">Reserved: ${Number(withdrawals.reservedRc).toLocaleString()} RC</span></div><button class="btn secondary" onclick="go('/withdraw')">View wallet</button></div>
    <div class="table-wrap">
      ${withdrawals.rows.length ? `<table><thead><tr><th>Reference</th><th>Requested</th><th>Payout</th><th>Destination</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>
        ${withdrawals.rows.map(w => `<tr><td>${escapeHtml(w.reference || "Legacy request")}</td><td>${Number(w.amount_rc).toLocaleString()} RC</td><td>${nairaFromKobo(w.payout_kobo)}</td><td>${escapeHtml(w.bank_name || "Unrecorded")}<br><span class="muted">•••• ${escapeHtml(w.account_last4 || "—")}</span></td><td><span class="status ${escapeHtml(w.status)}">${escapeHtml(w.status.replaceAll("_", " "))}</span>${w.rejection_reason ? `<br><span class="muted">${escapeHtml(w.rejection_reason)}</span>` : ""}</td><td>${escapeHtml(w.created_at)}</td><td>${w.status === "pending_review" ? `<button class="btn secondary" onclick="cancelWithdrawal(${w.id})">Cancel</button>` : ""}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">No withdrawal requests yet.</div>`}
    </div>
    <div class="section-head"><h2>Recent notifications</h2></div>
    ${notifications.length ? notifications.slice(0,5).map(n => `<div class="notice ${n.read_at ? "" : "success-box"}"><strong>${escapeHtml(n.title)}</strong> · ${escapeHtml(n.message)} <span class="metric-caption">${escapeHtml(n.created_at)}</span></div>`).join("") : `<p class="muted">You do not have any notifications yet.</p>`}
    <div class="actions" style="margin-top:24px"><button class="btn secondary" onclick="go('/faq')">Reward and withdrawal FAQs</button><button class="btn secondary" onclick="go('/support')">Contact support</button></div>
  `);
}

function convertRcToKoboClient(rc, settings) {
  const amount = Math.max(0, Math.trunc(Number(rc) || 0));
  const rateKobo = Math.max(0, Number(settings?.coinRateKobo) || 0);
  const rateRc = Math.max(1, Number(settings?.coinRateRc) || 1);
  const result = (BigInt(amount) * BigInt(rateKobo)) / BigInt(rateRc);
  return Number(result <= BigInt(Number.MAX_SAFE_INTEGER) ? result : 0n);
}

async function watch(id) {
  const c = await api("/api/campaigns/" + id);
  layout(`
    <div class="card">
      <span class="badge">${escapeHtml(c.advertiser)}</span>
      <h1>${escapeHtml(c.title)}</h1>
      <p class="muted">${escapeHtml(c.description)}</p>
      <div class="notice"><strong>Eligibility</strong><br>${escapeHtml(c.qualifying_rules)}<br><span class="metric-caption">The platform checks elapsed time and a single attempt per account. This is not independent proof of external actions.</span></div>
      <div class="ad-video-wrap">
        <video id="adVideo" autoplay playsinline src="${escapeHtml(c.video_url)}"></video>
        <button id="adStartButton" class="ad-start-button" type="button" hidden>Start ad</button>
        <button id="adCloseButton" class="ad-close-button" type="button" aria-label="Finish this video and return to your dashboard" title="Finish video" hidden>×</button>
      </div>
      <div class="row" style="margin-top:18px">
        <span>Reward: <strong>${Number(c.reward).toLocaleString()} RC</strong></span>
        <span id="watchStatus" class="muted">Watch the campaign to completion.</span>
      </div>
      <br>
      <button id="claimBtn" class="btn" disabled>Complete campaign</button>
      ${c.destination_url ? `<a class="btn secondary" href="${escapeHtml(c.destination_url)}" target="_blank" rel="noopener">Visit ${escapeHtml(c.advertiser)}</a>` : ""}
    </div>
  `);

  const video = document.getElementById("adVideo");
  const startButton = document.getElementById("adStartButton");
  const claim = document.getElementById("claimBtn");
  const closeButton = document.getElementById("adCloseButton");
  let watchSession = null;
  let watched = 0;
  let completing = false;
  video.play().catch(() => { startButton.hidden = false; });
  video.addEventListener("playing", () => { startButton.hidden = true; });
  startButton.addEventListener("click", () => {
    video.play().catch(() => {
      document.getElementById("watchStatus").textContent = "This ad could not start. Reload and try again.";
      document.getElementById("watchStatus").className = "error";
    });
  });
  const openAdvertiser = () => {
    if (!c.destination_url) return;
    window.open(c.destination_url, "_blank", "noopener,noreferrer");
  };

  if (c.destination_url) {
    video.addEventListener("click", event => {
      // The ad has no playback controls; tapping anywhere on its video surface opens the sponsor.
      openAdvertiser();
    });
  }

  const updateCloseButton = () => {
    const hasDuration = Number.isFinite(video.duration) && video.duration > 0;
    closeButton.hidden = !(hasDuration && video.duration - video.currentTime <= 1);
  };
  video.addEventListener("timeupdate", updateCloseButton);
  video.addEventListener("durationchange", updateCloseButton);
  video.addEventListener("ended", updateCloseButton);
  closeButton.addEventListener("click", () => {
    video.pause();
    closeButton.hidden = true;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      watched = Math.max(watched, Math.floor(video.duration));
    }
    completeCampaign();
  });

  video.addEventListener("loadedmetadata", async () => {
    try {
      watchSession = await api("/api/campaigns/" + id + "/start", {
        method:"POST", body:JSON.stringify({})
      });
    } catch (err) {
      document.getElementById("watchStatus").textContent = err.message;
      document.getElementById("watchStatus").className = "error";
    }
  }, { once:true });
  video.addEventListener("timeupdate", () => {
    watched = Math.max(watched, Math.floor(video.currentTime));
    if (watchSession && video.currentTime >= watchSession.minimumWatchSeconds) {
      claim.disabled = false;
      document.getElementById("watchStatus").textContent = "Campaign requirement reached.";
      document.getElementById("watchStatus").className = "success";
    }
  });

  async function completeCampaign() {
    if (completing) return;
    completing = true;
    claim.disabled = true;
    try {
      if (!watchSession) throw new Error("The campaign session is not ready. Reload and try again.");
      await api("/api/campaigns/" + id + "/complete", {
        method:"POST", body:JSON.stringify({ watchedSeconds: watched, token: watchSession.token })
      });
      alert("Completion submitted. Your RC reward is pending administrator review and will not be available to withdraw until approved.");
      go("/dashboard");
    } catch (err) {
      alert(err.message);
      completing = false;
      claim.disabled = !(watchSession && video.currentTime >= watchSession.minimumWatchSeconds);
    }
  }
  claim.onclick = completeCampaign;
}

async function withdraw() {
  const me = await getMe();
  if (!me || me.role !== "user") return go("/login");
  const history = await api("/api/withdrawals");
  const settings = me.settings;
  const minimum = Number(settings.minimumWithdrawalRc);
  const available = Number(me.available_rc);
  const amountRc = Math.min(available, Math.max(minimum, available));
  const grossKobo = convertRcToKoboClient(amountRc, settings);
  const feeKobo = Number(settings.withdrawalFeeKobo);
  layout(`
    <span class="eyebrow">Wallet · Manual bank payouts</span><h1>Request a withdrawal</h1>
    <p class="muted">Your available RC is separate from pending rewards and legacy balances. Requests are reviewed by an administrator and paid manually to the bank details you provide.</p>
    <div class="stats">
      <div class="stat"><span class="muted">Available</span><strong>${available.toLocaleString()} RC</strong><small>${nairaFromKobo(convertRcToKoboClient(available, settings))}</small></div>
      <div class="stat"><span class="muted">Reserved</span><strong>${Number(history.reservedRc).toLocaleString()} RC</strong><small>Already requested</small></div>
      <div class="stat"><span class="muted">Conversion</span><strong>${Number(settings.coinRateRc).toLocaleString()} RC = ${nairaFromKobo(settings.coinRateKobo)}</strong><small>Saved with each request</small></div>
      <div class="stat"><span class="muted">Minimum</span><strong>${minimum.toLocaleString()} RC</strong><small>${nairaFromKobo(convertRcToKoboClient(minimum, settings))}</small></div>
    </div>
    ${available < minimum ? `<div class="notice warning">You need ${(minimum - available).toLocaleString()} more approved RC to reach the minimum withdrawal. Opening this page does not change your balance.</div>` : ""}
    ${!settings.bankPayoutConfigured ? `<div class="notice warning"><strong>Withdrawals are not configured.</strong><br>Your balance is unchanged. The platform must configure secure bank-detail encryption before it can collect account details or accept withdrawal requests.</div>` : available >= minimum ? `
      <div class="form-card" style="max-width:760px;margin:20px 0">
        <h2>Review your payout</h2><p class="muted">You can request a partial withdrawal at or above the minimum.</p>
        <form id="withdrawForm">
          <label>Amount in Reward Coins</label><input name="amountRc" id="withdrawAmount" type="number" step="1" min="${minimum}" max="${available}" value="${amountRc}" required>
          <div class="notice" id="conversionSummary">Gross: ${nairaFromKobo(grossKobo)} · Fee: ${nairaFromKobo(feeKobo)} · Expected payout: ${nairaFromKobo(grossKobo - feeKobo)}</div>
          <label>Bank name</label><input name="bankName" maxlength="100" autocomplete="organization" required>
          <label>Account number</label><input name="accountNumber" inputmode="numeric" autocomplete="off" pattern="[0-9]{10}" maxlength="10" minlength="10" required>
          <label>Account name</label><input name="accountName" maxlength="150" autocomplete="name" required>
          <p class="metric-caption">Account names are entered by you and are not verified automatically. A team member will check the destination during manual review. Only the last four account digits appear in ordinary history.</p>
          <div class="actions"><button class="btn" type="submit">Review and submit request</button><button class="btn secondary" type="button" onclick="go('/dashboard')">Cancel</button></div>
          <p id="msg" role="status"></p>
        </form>
      </div>` : `<div class="panel">No withdrawal request can be submitted yet.</div>`}
    <div class="section-head"><div><h2>Withdrawal history</h2><span class="muted">Pending requests reserve the requested RC until resolved.</span></div></div>
    <div class="table-wrap">${history.rows.length ? `<table><thead><tr><th>Reference</th><th>Amount</th><th>Fee</th><th>Payout</th><th>Destination</th><th>Status</th><th>Date</th></tr></thead><tbody>${history.rows.map(w => `<tr><td>${escapeHtml(w.reference || "Legacy review")}</td><td>${Number(w.amount_rc).toLocaleString()} RC</td><td>${nairaFromKobo(w.fee_kobo)}</td><td>${nairaFromKobo(w.payout_kobo)}</td><td>${escapeHtml(w.bank_name || "Not recorded")}<br><span class="muted">•••• ${escapeHtml(w.account_last4 || "—")}</span></td><td><span class="status ${escapeHtml(w.status)}">${escapeHtml(w.status.replaceAll("_", " "))}</span>${w.rejection_reason ? `<br>${escapeHtml(w.rejection_reason)}` : ""}</td><td>${escapeHtml(w.created_at)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No withdrawal requests have been submitted.</div>`}</div>
  `);
  const form = document.getElementById("withdrawForm");
  if (!form) return;
  const amount = document.getElementById("withdrawAmount");
  const updateSummary = () => {
    const gross = convertRcToKoboClient(Number(amount.value), settings);
    document.getElementById("conversionSummary").textContent = `Gross: ${nairaFromKobo(gross)} · Fee: ${nairaFromKobo(feeKobo)} · Expected payout: ${nairaFromKobo(Math.max(0, gross - feeKobo))}`;
  };
  amount.oninput = updateSummary;
  const idempotencyKey = crypto.randomUUID();
  form.onsubmit = async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    const gross = convertRcToKoboClient(Number(data.amountRc), settings);
    if (!confirm(`Submit ${Number(data.amountRc).toLocaleString()} RC for a ${nairaFromKobo(gross - feeKobo)} payout to ${data.bankName}, account ending ${data.accountNumber.slice(-4)}?`)) return;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api("/api/withdrawals", { method:"POST", headers:{"Idempotency-Key":idempotencyKey}, body:JSON.stringify(data) });
      layout(`<div class="panel"><span class="badge">Request pending review</span><h1>Withdrawal request submitted</h1><p>Your RC is reserved while the request is reviewed. Payouts are handled manually; this is not a payment confirmation.</p><div class="notice"><strong>Reference:</strong> ${escapeHtml(result.reference)}<br><strong>Requested:</strong> ${Number(result.amountRc).toLocaleString()} RC (${nairaFromKobo(result.grossKobo)})<br><strong>Fee:</strong> ${nairaFromKobo(result.feeKobo)}<br><strong>Expected payout:</strong> ${nairaFromKobo(result.payoutKobo)}<br><strong>Destination:</strong> ${escapeHtml(result.bankName)} · •••• ${escapeHtml(result.accountLast4)}<br><strong>Status:</strong> Pending review</div><div class="actions"><button class="btn" onclick="go('/dashboard')">Return to dashboard</button><button class="btn secondary" onclick="go('/transactions')">View transactions</button></div></div>`);
    } catch (error) {
      const message = document.getElementById("msg");
      message.className = "error"; message.textContent = error.message;
      button.disabled = false;
    }
  };
}

async function cancelWithdrawal(id) {
  if (!confirm("Cancel this request while it is still pending review? The reserved RC will return to your available balance.")) return;
  try { await api(`/api/withdrawals/${id}/cancel`, { method:"POST", body:JSON.stringify({}) }); await dashboard(); }
  catch (error) { alert(error.message); }
}

async function advertiserDashboard() {
  const me = await getMe();
  if (!me) return go("/login");
  if (me.role !== "advertiser") return go(me.role === "admin" ? "/admin" : "/dashboard");
  const [profile, campaigns, fundingInfo] = await Promise.all([
    api("/api/advertiser/profile"), api("/api/advertiser/campaigns"), api("/api/advertiser/funding-instructions").catch(error => ({ configured:false, error:error.message }))
  ]);
  const settings = me.settings;
  layout(`
    <span class="eyebrow">Business workspace · Advertiser</span><h1>${escapeHtml(profile.business_name)}</h1>
    <p class="muted">Campaigns remain private until approved and fully funded. Results show only activity the platform has recorded.</p>
    <div class="stats">
      <div class="stat"><span class="muted">Profile</span><strong class="status ${escapeHtml(profile.status)}">${escapeHtml(profile.status.replaceAll("_", " "))}</strong><small>Reviewed by platform administration</small></div>
      <div class="stat"><span class="muted">Campaigns</span><strong>${campaigns.length}</strong><small>${campaigns.filter(c => c.status === "active").length} active</small></div>
      <div class="stat"><span class="muted">Confirmed funding</span><strong>${nairaFromKobo(campaigns.reduce((sum,c) => sum + Number(c.funded_kobo),0))}</strong><small>Reconciled deposits</small></div>
      <div class="stat"><span class="muted">Recorded results</span><strong>${campaigns.reduce((sum,c) => sum + Number(c.approved_results),0)}</strong><small>Approved video completion records</small></div>
    </div>
    ${profile.status !== "approved" ? `<div class="notice ${profile.status === "rejected" ? "warning" : ""}"><strong>Advertiser profile ${escapeHtml(profile.status.replaceAll("_", " "))}.</strong> Campaign submission opens after your business profile is approved. ${profile.status === "rejected" ? "Contact support if you need clarification." : "No estimated review time is published."}</div>` : `
      <div class="form-card" style="max-width:none;margin:0 0 28px"><h2>Submit a video visibility campaign</h2>
        <p class="muted">Action campaigns are disabled until Reward Hub can verify those outcomes. Your requested reward pool is a configurable estimate and this campaign will not go live until review and full funding reconciliation.</p>
        <form id="advertiserCampaignForm"><div class="grid">
          <div><label>Campaign title</label><input name="title" maxlength="150" required></div>
          <div><label>Video file URL</label><input name="videoUrl" type="url" placeholder="https://…/campaign.mp4" required></div>
          <div><label>Advertiser link (optional)</label><input name="destinationUrl" type="url" placeholder="https://…" aria-describedby="advertiserDestinationHelp"><small id="advertiserDestinationHelp" class="muted">Add a full website, WhatsApp wa.me, or social link. Tapping the ad opens this link.</small></div>
          <div><label>Video duration (seconds)</label><input name="durationSeconds" type="number" min="1" max="86400" required></div>
          <div><label>Reward per qualifying completion (RC)</label><input name="rewardRc" type="number" min="1" required></div>
          <div><label>Total campaign budget (₦)</label><input name="budgetNgn" type="number" min="1" required></div>
          <div><label>Target results (optional)</label><input name="targetCompletions" type="number" min="0" placeholder="Estimate only"></div>
        </div><label>Campaign description</label><textarea name="description" maxlength="2000"></textarea>
        <div class="notice">Current coin rate: ${Number(settings.coinRateRc).toLocaleString()} RC = ${nairaFromKobo(settings.coinRateKobo)}. Reward pool estimate uses ${Number(settings.rewardAllocationBps || 5000)/100}% of budget and is saved with the campaign. Delivery is not guaranteed.</div>
        <button class="btn">Submit for review</button><p id="advertiserCampaignMessage" role="status"></p></form>
      </div>`}
    <div class="section-head"><div><h2>Your campaigns</h2><span class="muted">Budget, funding and measured results</span></div></div>
    ${campaigns.length ? `<div class="grid">${campaigns.map(c => {
      const due = Math.max(0, Number(c.advertiser_budget_kobo) - Number(c.funded_kobo));
      const rewardValueKobo = Math.floor(Number(c.committed_rc) * Number(c.reward_rate_kobo || settings.coinRateKobo) / Number(c.reward_rate_rc || settings.coinRateRc));
      return `<article class="card"><div class="row"><span class="badge">${escapeHtml(c.objective.replaceAll("_", " "))}</span><span class="status ${escapeHtml(c.status)}">${escapeHtml(c.status.replaceAll("_", " "))}</span></div><h3>${escapeHtml(c.title)}</h3><p class="muted">Approval: ${escapeHtml(c.approval_status.replaceAll("_", " "))} · Funding: ${escapeHtml(c.funding_status.replaceAll("_", " "))}</p><div class="stats"><div><span class="metric-caption">Budget requested</span><strong>${nairaFromKobo(c.advertiser_budget_kobo)}</strong></div><div><span class="metric-caption">Confirmed funding</span><strong>${nairaFromKobo(c.funded_kobo)}</strong></div><div><span class="metric-caption">Reward allocation</span><strong>${Number(c.reward_budget_rc).toLocaleString()} RC</strong></div><div><span class="metric-caption">Approved results</span><strong>${Number(c.approved_results)}</strong></div></div><p class="muted">Committed rewards: ${Number(c.committed_rc).toLocaleString()} RC (${nairaFromKobo(rewardValueKobo)}) · ${Number(c.pending_results)} pending review</p>${c.review_reason ? `<div class="notice warning">${escapeHtml(c.review_reason)}</div>` : ""}
      ${c.approval_status === "approved" && (c.status === "active" || c.status === "paused") ? `<div class="actions"><button class="btn secondary" onclick="setAdvertiserCampaign(${c.id}, ${c.status !== "active"})">${c.status === "active" ? "Pause campaign" : "Resume campaign"}</button></div>` : ""}
      ${c.approval_status === "approved" && due > 0 && fundingInfo.configured ? `<div class="panel"><strong>Funding instructions</strong><p>${escapeHtml(fundingInfo.instructions)}</p><p>Amount remaining: ${nairaFromKobo(due)}</p><form class="fundingForm" data-id="${c.id}"><label>Amount being reported (₦)</label><input name="amountNgn" type="number" min="1" max="${Math.floor(due/100)}" value="${Math.floor(due/100)}" required><label>Transfer reference</label><input name="paymentReference" maxlength="100" required><button class="btn secondary">Submit for reconciliation</button></form><p class="metric-caption">Your reference is a claim until reconciled against the platform's bank record. Never send money to instructions you cannot independently verify.</p></div>` : ""}
      ${c.approval_status === "approved" && due > 0 && !fundingInfo.configured ? `<div class="notice warning">Funding instructions are not configured. Do not transfer money. Contact support.</div>` : ""}</article>`;
    }).join("")}</div>` : `<div class="panel empty">No campaigns yet. Submit a campaign after profile approval.</div>`}
    <div class="actions" style="margin-top:25px"><button class="btn secondary" onclick="go('/faq')">Advertiser FAQs</button><button class="btn secondary" onclick="go('/support')">Contact support</button></div>
  `);
  const campaignForm = document.getElementById("advertiserCampaignForm");
  if (campaignForm) campaignForm.onsubmit = async event => {
    event.preventDefault(); if (!campaignForm.reportValidity()) return;
    const message = document.getElementById("advertiserCampaignMessage");
    try { await api("/api/advertiser/campaigns", { method:"POST", body:JSON.stringify(Object.fromEntries(new FormData(campaignForm))) }); message.className="success"; message.textContent="Campaign submitted for review."; await advertiserDashboard(); }
    catch (error) { message.className="error"; message.textContent=error.message; }
  };
  document.querySelectorAll(".fundingForm").forEach(form => form.onsubmit = async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    if (!confirm(`Submit payment reference ${values.paymentReference} for reconciliation? This will not mark the campaign funded.`)) return;
    try { await api(`/api/advertiser/campaigns/${form.dataset.id}/funding`, { method:"POST", body:JSON.stringify(values) }); await advertiserDashboard(); }
    catch (error) { alert(error.message); }
  });
}

async function setAdvertiserCampaign(id, active) {
  const verb = active ? "resume" : "pause";
  if (!confirm(`${verb[0].toUpperCase()}${verb.slice(1)} this campaign?`)) return;
  try {
    await api(`/api/advertiser/campaigns/${id}`, { method:"PATCH", body:JSON.stringify({ active }) });
    await advertiserDashboard();
  } catch (error) { alert(error.message); }
}

async function transactionsPage() {
  const me = await getMe();
  if (!me || me.role !== "user") return go("/login");
  const [rewards, withdrawals, ledger] = await Promise.all([api("/api/transactions"), api("/api/withdrawals"), api("/api/ledger")]);
  layout(`<span class="eyebrow">Your account</span><h1>Transaction history</h1><p class="muted">Persisted task and wallet records. Pending rewards are not included in the available balance.</p>
    <div class="section-head"><h2>Campaign completions</h2></div><div class="table-wrap">${rewards.length ? `<table><thead><tr><th>Reference</th><th>Campaign</th><th>Reward</th><th>Status</th><th>Reason</th><th>Date</th></tr></thead><tbody>${rewards.map(t=>`<tr><td>${escapeHtml(t.reference||"Legacy")}</td><td>${escapeHtml(t.title)}</td><td>${t.status === "legacy_review" ? `Legacy · ${nairaFromKobo(t.legacy_amount_kobo)}` : `${Number(t.amount_rc).toLocaleString()} RC`}</td><td>${t.status === "legacy_review" ? "Legacy review · not spendable" : escapeHtml(t.status)}</td><td>${escapeHtml(t.rejection_reason||"—")}</td><td>${escapeHtml(t.created_at)}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">No completion records.</div>`}</div>
    <div class="section-head"><h2>Withdrawals</h2></div><div class="table-wrap">${withdrawals.rows.length?`<table><thead><tr><th>Reference</th><th>RC reserved</th><th>Expected payout</th><th>Status</th><th>Payout reference</th><th>Date</th></tr></thead><tbody>${withdrawals.rows.map(w=>`<tr><td>${escapeHtml(w.reference||"Legacy")}</td><td>${Number(w.amount_rc).toLocaleString()} RC</td><td>${nairaFromKobo(w.payout_kobo)}</td><td>${escapeHtml(w.status.replaceAll("_"," "))}${w.rejection_reason?`<br>${escapeHtml(w.rejection_reason)}`:""}</td><td>${escapeHtml(w.payout_reference||"—")}</td><td>${escapeHtml(w.created_at)}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">No withdrawal requests.</div>`}</div>
    <div class="section-head"><h2>Wallet ledger</h2></div><div class="table-wrap">${ledger.length?`<table><thead><tr><th>Reference</th><th>Event</th><th>RC</th><th>NGN</th><th>Status</th><th>Description</th><th>Date</th></tr></thead><tbody>${ledger.map(e=>`<tr><td>${escapeHtml(e.reference)}</td><td>${escapeHtml(e.entry_type.replaceAll("_"," "))}</td><td>${Number(e.amount_rc).toLocaleString()}</td><td>${e.amount_kobo?nairaFromKobo(Math.abs(e.amount_kobo)):"—"}</td><td>${escapeHtml(e.status)}</td><td>${escapeHtml(e.description)}</td><td>${escapeHtml(e.created_at)}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">No posted wallet ledger entries.</div>`}</div>
    <div class="actions" style="margin-top:24px"><button class="btn secondary" onclick="go('/dashboard')">Return to dashboard</button><button class="btn secondary" onclick="go('/support')">Report an issue</button></div>`);
}

const faqGroups = [
  ["General", [["What is Reward Hub?","Reward Hub lists sponsored activities funded by advertisers. Users complete stated task requirements and may receive Reward Coins after review."],["Is income guaranteed?","No. Campaign availability changes and there is no guaranteed income."],["Why are there no tasks?","Tasks appear only after a campaign is approved, fully funded, and active. If none are listed, no eligible campaign is available."],["Is it free to join?","The user registration flow does not charge a sign-up fee. Advertisers have separate campaign budgets and terms."]]],
  ["Reward Coins", [["What is the conversion?","The current configured rate is 10,000 RC = ₦1,000. The administrator can change the rate for future withdrawal requests; each submitted request stores its own conversion rate."],["When are rewards withdrawable?","Task rewards are pending review first. Only administrator-approved rewards are added to the available RC balance."],["How is a video task checked?","The server enforces an elapsed-time threshold and one attempt per account. This does not independently prove playback or an external action, so reward submissions remain subject to manual review."]]],
  ["Withdrawals", [["What is the minimum?","The current minimum is 20,000 RC (₦2,000 at the current rate). The current setting is shown in your wallet."],["How long will it take?","There is no processing-time promise until an operating policy is finalized. The initial payout flow is manual administrator review."],["Are bank details verified automatically?","No. Account-name enquiry and automated bank verification are not configured. An administrator must manually verify details before payout."],["Are fees charged?","The current fee is shown before submission and saved with each request."]]],
  ["Tasks and advertisers", [["Are all campaign types available?","The MVP supports video visibility campaigns. Website visits, WhatsApp enquiries, installs and other action objectives are disabled until reliable measurement is integrated."],["When do campaigns go live?","An administrator must approve the campaign and reconcile full advertiser funding. Browser redirects or advertiser-entered references alone do not prove payment."],["Are video views verified?","The system records a single completion attempt and enforces elapsed time. It cannot prove the user watched attentively or completed an external action."]]],
  ["Account and support", [["How can I reset a password?","A self-service password reset flow is not yet configured. Contact support for account access help."],["What if a reward or payout is wrong?","Use the support form with the task or withdrawal reference. Rejected task completions include a review reason where available."]]]
];

function faqPage() {
  layout(`<span class="eyebrow">Help center</span><h1>Frequently asked questions</h1><p class="muted">Answers reflect the current MVP behavior. We do not promise unsupported verification or payout services.</p>${faqGroups.map(([group,items])=>`<section><div class="section-head"><h2>${escapeHtml(group)}</h2></div><div class="panel">${items.map(([q,a])=>`<article class="faq-item"><h3>${escapeHtml(q)}</h3><p class="muted">${escapeHtml(a)}</p></article>`).join("")}</div></section>`).join("")}<div class="actions"><button class="btn secondary" onclick="go('/support')">Contact support</button><button class="btn secondary" onclick="go('/')">Home</button></div>`);
}

function policiesPage() {
  layout(`<span class="eyebrow">Platform facts and policies</span><h1>How Reward Hub currently works</h1><p class="muted">A plain-language guide to rewards, campaigns, withdrawals, advertiser funding, privacy, and current platform limits.</p>
    <section class="grid"><article class="card"><h3>Rewards and task rules</h3><p class="muted">Campaigns are shown only after administrator approval and full funding reconciliation. Video completion currently checks elapsed time and duplicate attempts. Submitted rewards stay pending until reviewed. This is not proof of a genuine view or external action.</p></article><article class="card"><h3>Withdrawals</h3><p class="muted">The current minimum and conversion are displayed in the wallet. Requests reserve available RC, then follow pending review, approval, manual processing, and evidence-recorded payout states. No processing time is promised.</p></article><article class="card"><h3>Advertiser funding</h3><p class="muted">Advertiser-entered transfer references are claims, not proof of payment. An administrator must reconcile a deposit against the business's payment account before activation.</p></article><article class="card"><h3>Privacy and support</h3><p class="muted">Bank destination details are encrypted at rest and only returned to authorized administrators. Configure the encryption key before enabling withdrawal submissions. Final privacy, terms, refund, and advertiser policies still require business and legal review.</p></article></section><div class="actions" style="margin-top:24px"><button class="btn secondary" onclick="go('/faq')">FAQs</button><button class="btn secondary" onclick="go('/support')">Support</button></div>`);
}

async function supportPage() {
  const me = await getMe();
  if (!me) return go("/login");
  layout(`<span class="eyebrow">Help center</span><h1>Contact support</h1><p class="muted">Include a campaign, task, or withdrawal reference when it helps explain the issue. Do not include a full bank account number or password.</p><div class="form-card" style="max-width:700px;margin:20px 0"><form id="supportForm"><label>Topic</label><select name="category"><option value="account">Account</option><option value="reward">Reward</option><option value="withdrawal">Withdrawal</option><option value="campaign">Campaign</option><option value="other">Other</option></select><label>Subject</label><input name="subject" maxlength="150" required><label>Message</label><textarea name="message" minlength="10" maxlength="5000" required></textarea><button class="btn">Submit support request</button><p id="supportMessage" role="status"></p></form></div>`);
  document.getElementById("supportForm").onsubmit = async event => { event.preventDefault(); if(!event.target.reportValidity())return; const msg=document.getElementById("supportMessage"); try{const result=await api("/api/support",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});msg.className="success";msg.textContent=`Request ${result.reference} submitted. Support responses are not yet sent by email.`;event.target.reset();}catch(error){msg.className="error";msg.textContent=error.message;} };
}

async function admin() {
  const me = await getMe();
  if (!me || me.role !== "admin") return go("/login");

  const [s, campaigns, users, withdrawals, advertisers] = await Promise.all([
    api("/api/admin/summary"), api("/api/admin/campaigns"),
    api("/api/admin/users"), api("/api/admin/withdrawals"), api("/api/admin/advertisers")
  ]);

  layout(`
    <span class="eyebrow">Workspace · Administration</span><h1>Good morning, ${escapeHtml(me.name.split(" ")[0])}</h1>
    <p class="muted">A clear view of campaigns, partners, members and payouts.</p>
    <div class="stats">
      <div class="stat"><span class="muted">Community members</span><strong>${s.users}</strong><small>registered users</small></div>
      <div class="stat"><span class="muted">Advertisers</span><strong>${s.advertisers}</strong><small>brand partners</small></div>
      <div class="stat"><span class="muted">Campaigns</span><strong>${s.campaigns}</strong><small>${s.drafts} saved as drafts</small></div>
      <div class="stat"><span class="muted">Rewards issued</span><strong>₦${Number(s.rewards).toLocaleString()}</strong><small>${s.completedViews} completed views</small></div>
    </div>

    <div class="tabbar"><button class="selected" data-tab="campaigns">Campaigns</button><button data-tab="advertisers">Advertisers</button><button data-tab="users">Users</button><button data-tab="withdrawals">Withdrawals ${s.pendingWithdrawals ? `· ${s.pendingWithdrawals}` : ""}</button></div>

    <section id="panel-campaigns">
    <div class="form-card" style="max-width:none;margin:0 0 28px">
      <h2>Plan a campaign</h2><p class="muted">Save a campaign as a draft or publish it to the community now.</p>
      <form id="campaignForm">
        <div class="grid">
          <div><label>Campaign title</label><input name="title" required></div>
          <div><label>Advertiser</label><input name="advertiser" required></div>
          <div><label>Video URL</label><input name="videoUrl" placeholder="https://..." required></div>
          <div><label>Advertiser link (optional)</label><input name="destinationUrl" type="url" placeholder="https://…"><small class="muted">Website, WhatsApp wa.me, or social link. Tapping the ad opens this link.</small></div>
          <div><label>Video duration (seconds)</label><input name="durationSeconds" type="number" min="1" max="86400" required></div>
          <div><label>Reward per completion (₦)</label><input name="reward" type="number" min="1" required></div>
          <div><label>Campaign budget (₦)</label><input name="budget" type="number" min="1" required></div>
        </div>
        <label>Description</label><textarea name="description"></textarea>
        <div class="actions" style="margin-top:18px"><button class="btn secondary" type="button" onclick="submitCampaign('draft')">Save draft</button><button class="btn" type="button" onclick="submitCampaign('active')">Publish campaign</button></div>
        <p class="muted" id="campaignMessage"></p>
      </form>
    </div>

    <div class="section-head"><h2>Campaigns <span class="muted">(${campaigns.length})</span></h2><span class="muted">Manage delivery and saved work</span></div>
    <div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Reward</th><th>Budget</th><th>Views</th><th>Status</th><th></th></tr></thead><tbody>
      ${campaigns.map(c => `<tr>
        <td>${escapeHtml(c.title)}<br><span class="muted">${escapeHtml(c.advertiser)}</span></td>
        <td>₦${Number(c.reward).toLocaleString()}</td>
        <td>₦${Number(c.spent).toLocaleString()} / ₦${Number(c.budget).toLocaleString()}<br><span class="muted">${Math.max(0,Math.round((1-Number(c.spent)/Math.max(1,Number(c.budget)))*100))}% remaining</span></td>
        <td>${c.completed_views}</td>
        <td><span class="status ${escapeHtml(c.status || (c.active ? "active" : "paused"))}">${escapeHtml(c.status || (c.active ? "active" : "paused"))}</span></td>
        <td>${c.status === "draft" ? `<button class="btn" onclick="setCampaignStatus(${c.id},'active')">Publish</button>` : `<button class="btn secondary" onclick="setCampaignStatus(${c.id},'${c.active ? "paused" : "active"}')">${c.active ? "Pause" : "Activate"}</button>`}</td>
      </tr>`).join("")}
    </tbody></table></div></section>

    <section id="panel-advertisers" hidden><div class="section-head"><div><h2>Advertiser partners</h2><span class="muted">${advertisers.length} organizations across your campaigns</span></div></div><div class="grid">
      ${advertisers.length ? advertisers.map(a => `<article class="card"><span class="badge">${Number(a.active_campaigns)} active</span><h3>${escapeHtml(a.name)}</h3><p class="muted">${Number(a.campaigns)} campaigns · ${Number(a.completed_views)} completed views</p><div class="row"><span class="muted">Rewards delivered</span><strong>₦${Number(a.rewards).toLocaleString()}</strong></div></article>`).join("") : `<div class="card empty">Advertisers appear here when you create their first campaign.</div>`}
    </div></section>

    <section id="panel-users" hidden><div class="section-head"><div><h2>Community members</h2><span class="muted">${users.length} registered accounts</span></div><div class="toolbar"><input id="userSearch" placeholder="Search name or email"></div></div>
    <div class="table-wrap"><table id="usersTable"><thead><tr><th>Member</th><th>Role</th><th>Balance</th><th>Lifetime rewards</th><th>Campaigns</th><th>Joined</th></tr></thead><tbody>
      ${users.map(u => `<tr><td>${escapeHtml(u.name)}<br><span class="muted">${escapeHtml(u.email)}</span></td><td><span class="status">${escapeHtml(u.role)}</span></td><td>₦${Number(u.balance).toLocaleString()}</td><td>₦${Number(u.lifetime_rewards).toLocaleString()}</td><td>${Number(u.completed_campaigns)}</td><td>${escapeHtml(u.created_at)}</td></tr>`).join("")}
    </tbody></table></div></section>

    <section id="panel-withdrawals" hidden><div class="section-head"><div><h2>Withdrawal requests</h2><span class="muted">Review member payouts</span></div></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Amount</th><th>Method</th><th>Status</th><th></th></tr></thead><tbody>
      ${withdrawals.map(w => `<tr>
        <td>${escapeHtml(w.name)}<br><span class="muted">${escapeHtml(w.email)}</span></td>
        <td>₦${Number(w.amount).toLocaleString()}</td>
        <td>${escapeHtml(w.method)}<br>${escapeHtml(w.account_details)}</td>
        <td><span class="status ${escapeHtml(w.status)}">${escapeHtml(w.status)}</span></td>
        <td>${w.status === "pending" ? `<button class="btn" onclick="withdrawal(${w.id},'approved')">Approve</button> <button class="btn danger" onclick="withdrawal(${w.id},'rejected')">Reject</button>` : ""}</td>
      </tr>`).join("")}
    </tbody></table></div></section>
  `);

  document.getElementById("campaignForm").onsubmit = async e => {
    e.preventDefault();
    await submitCampaign("draft");
  };
  document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => {
    document.querySelectorAll("[data-tab]").forEach(item => item.classList.toggle("selected", item === button));
    document.querySelectorAll("[id^='panel-']").forEach(panel => panel.hidden = panel.id !== `panel-${button.dataset.tab}`);
  });
  document.getElementById("userSearch").oninput = event => {
    const q = event.target.value.toLowerCase();
    document.querySelectorAll("#usersTable tbody tr").forEach(row => row.hidden = !row.textContent.toLowerCase().includes(q));
  };
}

async function submitCampaign(status) {
  const form = document.getElementById("campaignForm");
  const message = document.getElementById("campaignMessage");
  if (!form.reportValidity()) return;
  try {
    await api("/api/admin/campaigns", { method:"POST", body:JSON.stringify({ ...Object.fromEntries(new FormData(form)), status }) });
    message.className = "success"; message.textContent = status === "draft" ? "Draft saved." : "Campaign published.";
    form.reset(); await admin();
  } catch (err) { message.className = "error"; message.textContent = err.message; }
}

async function toggleCampaign(id, active) {
  await api("/api/admin/campaigns/" + id, { method:"PATCH", body:JSON.stringify({ active: !active }) });
  admin();
}

async function setCampaignStatus(id, status) {
  await api("/api/admin/campaigns/" + id, { method:"PATCH", body:JSON.stringify({ status }) });
  await admin();
}

async function withdrawal(id, status) {
  await api("/api/admin/withdrawals/" + id, { method:"PATCH", body:JSON.stringify({ status }) });
  admin();
}

// The operational console replaces the original draft-only admin view above.
async function admin() {
  const me=await getMe(); if(!me||me.role!=="admin")return go("/login");
  const [s,campaigns,users,withdrawals,advertisers,tasks,fundings,settings,support,audit]=await Promise.all([
    api("/api/admin/summary"),api("/api/admin/campaigns"),api("/api/admin/users"),api("/api/admin/withdrawals"),api("/api/admin/advertisers"),api("/api/admin/task-reviews"),api("/api/admin/fundings"),api("/api/admin/settings"),api("/api/admin/support"),api("/api/admin/audit?limit=100")
  ]);
  const cfg=settings.settings;
  const campaignRows=campaigns.map(c=>`<tr><td><strong>${escapeHtml(c.title)}</strong><br>${escapeHtml(c.advertiser)}<br><span class="metric-caption">${Number(c.reward).toLocaleString()} RC each · ${escapeHtml(c.objective)}</span></td><td>${nairaFromKobo(c.advertiser_budget_kobo)}<br>${nairaFromKobo(c.funded_kobo)} confirmed</td><td>${Number(c.committed_rc).toLocaleString()} / ${Number(c.reward_budget_rc).toLocaleString()} RC</td><td>${Number(c.completed_views)} approved · ${Number(c.pending_views)} pending</td><td>${escapeHtml(c.approval_status.replaceAll("_"," "))}<br>${escapeHtml(c.funding_status.replaceAll("_"," "))}<br>${c.active?"Live":"Not live"}</td><td>${c.approval_status==="pending_review"?`<button class="btn" onclick="reviewCampaign(${c.id},'approved')">Approve</button> <button class="btn danger" onclick="reviewCampaign(${c.id},'rejected')">Reject</button>`:c.approval_status==="approved"&&c.funding_status==="confirmed"?`<button class="btn secondary" onclick="setCampaignStatus(${c.id},'${c.active?"paused":"active"}')">${c.active?"Pause":"Activate"}</button>`:""}</td></tr>`).join("");
  const advertiserRows=advertisers.map(a=>`<tr><td>${escapeHtml(a.name)}<br>${escapeHtml(a.contact_name)} · ${escapeHtml(a.email)}</td><td>${escapeHtml(a.status.replaceAll("_"," "))}</td><td>${Number(a.campaigns)} (${Number(a.active_campaigns)} live)<br>${Number(a.pending_campaigns)} awaiting review</td><td>${nairaFromKobo(a.requested_budget_kobo)} / ${nairaFromKobo(a.funded_kobo)}</td><td>${Number(a.approved_results)} approved</td><td>${a.status==="pending_review"?`<button class="btn" onclick="reviewAdvertiser(${a.id},'approved')">Approve</button> <button class="btn danger" onclick="reviewAdvertiser(${a.id},'rejected')">Reject</button>`:""}</td></tr>`).join("");
  const fundingRows=fundings.map(f=>`<tr><td>${escapeHtml(f.campaign_title)}<br>${escapeHtml(f.advertiser||"—")}</td><td>${nairaFromKobo(f.amount_kobo)}</td><td>${escapeHtml(f.advertiser_reference)}</td><td>${escapeHtml(f.status.replaceAll("_"," "))}<br>${escapeHtml(f.verification_note||"")}</td><td>${escapeHtml(f.submitted_by_name)} · ${escapeHtml(f.submitted_by_email)}</td><td>${f.status==="pending_review"?`<button class="btn" onclick="reconcileFunding(${f.id},${Math.floor(Number(f.amount_kobo)/100)})">Confirm</button> <button class="btn danger" onclick="reconcileFunding(${f.id},0)">Reject</button>`:""}</td></tr>`).join("");
  const taskRows=tasks.map(t=>`<tr><td>${escapeHtml(t.name)}<br>${escapeHtml(t.email)}</td><td>${escapeHtml(t.campaign_title)}</td><td>${escapeHtml(t.attempt_reference)}<br>${Number(t.watched_seconds)} sec elapsed</td><td>${Number(t.reward).toLocaleString()} / ${Number(t.reward_budget_rc).toLocaleString()} RC</td><td>${escapeHtml(t.created_at)}</td><td><button class="btn" onclick="reviewTask(${t.id},'approved')">Approve</button> <button class="btn danger" onclick="reviewTask(${t.id},'rejected')">Reject</button></td></tr>`).join("");
  const withdrawalRows=withdrawals.map(w=>`<tr><td>${escapeHtml(w.name)}<br>${escapeHtml(w.email)}<br>${escapeHtml(w.reference||"Legacy request")}</td><td>${Number(w.amount_rc).toLocaleString()} RC<br>${nairaFromKobo(w.gross_kobo)} gross<br>${nairaFromKobo(w.fee_kobo)} fee<br>${nairaFromKobo(w.payout_kobo)} payout</td><td>${escapeHtml(w.destination?.bankName||w.bank_name||"Unrecorded")}<br>${escapeHtml(w.destination?.accountName||"")}<br><strong>${w.destination?escapeHtml(w.destination.accountNumber):`•••• ${escapeHtml(w.account_last4||"—")}`}</strong></td><td>${escapeHtml(w.status.replaceAll("_"," "))}<br>${escapeHtml(w.rejection_reason||"")}</td><td>${escapeHtml(w.payout_reference||"")}<br>${escapeHtml(w.payout_evidence||"")}</td><td>${w.status==="pending_review"?`<button class="btn" onclick="updateWithdrawal(${w.id},'approved')">Approve</button> <button class="btn danger" onclick="updateWithdrawal(${w.id},'rejected')">Reject</button>`:w.status==="approved"?`<button class="btn" onclick="updateWithdrawal(${w.id},'processing')">Start payout</button> <button class="btn danger" onclick="updateWithdrawal(${w.id},'rejected')">Reject</button>`:w.status==="processing"?`<button class="btn" onclick="updateWithdrawal(${w.id},'paid')">Record paid</button> <button class="btn danger" onclick="updateWithdrawal(${w.id},'failed')">Record failed</button>`:w.status==="failed"?`<button class="btn" onclick="updateWithdrawal(${w.id},'processing')">Retry</button> <button class="btn danger" onclick="updateWithdrawal(${w.id},'rejected')">Release</button>`:w.legacy?"Legacy request—reconcile separately":""}</td></tr>`).join("");
  const userRows=users.map(u=>`<tr><td>${escapeHtml(u.name)}<br>${escapeHtml(u.email)}</td><td>${escapeHtml(u.role)}</td><td>${Number(u.available_rc).toLocaleString()}</td><td>${Number(u.pending_rc).toLocaleString()}</td><td>${u.legacy_balance_kobo?nairaFromKobo(u.legacy_balance_kobo):"—"}</td><td>${Number(u.lifetime_rewards_rc).toLocaleString()} RC · ${Number(u.completed_campaigns)} tasks</td><td>${escapeHtml(u.created_at)}</td></tr>`).join("");
  const supportRows=support.map(t=>`<tr><td>${escapeHtml(t.user_name)} · ${escapeHtml(t.user_email)}</td><td>${escapeHtml(t.category)}</td><td>${escapeHtml(t.subject)}<br>${escapeHtml(t.message)}</td><td>${escapeHtml(t.status)}</td><td>${escapeHtml(t.admin_response||"—")}</td><td>${t.status!=="resolved"?`<button class="btn secondary" onclick="resolveSupport(${t.id})">Respond / resolve</button>`:""}</td></tr>`).join("");
  layout(`<span class="eyebrow">Workspace · Administration</span><h1>Platform operations</h1><p class="muted">Review funding, advertiser campaigns, task rewards, withdrawals, and support.</p>
    <div class="stats"><div class="stat"><span class="muted">Registered users</span><strong>${Number(s.users)}</strong><small>${Number(s.activeUsers30d)} completed a task in 30 days</small></div><div class="stat"><span class="muted">Advertisers</span><strong>${Number(s.advertisers)}</strong><small>${Number(s.pendingAdvertisers)} pending review</small></div><div class="stat"><span class="muted">Active campaigns</span><strong>${Number(s.activeCampaigns)}</strong><small>${Number(s.pendingCampaigns)} pending review</small></div><div class="stat"><span class="muted">Confirmed advertiser funding</span><strong>${nairaFromKobo(s.confirmedFundingKobo)}</strong><small>Manually reconciled</small></div><div class="stat"><span class="muted">Task reviews</span><strong>${Number(s.pendingViews)}</strong><small>${Number(s.completedViews)} approved</small></div><div class="stat"><span class="muted">Withdrawal requests</span><strong>${Number(s.pendingWithdrawals)}</strong><small>${nairaFromKobo(s.reservedWithdrawalKobo)} reserved</small></div><div class="stat"><span class="muted">Payouts recorded paid</span><strong>${nairaFromKobo(s.paidWithdrawalsKobo)}</strong><small>Evidence logged</small></div><div class="stat"><span class="muted">Legacy balances held</span><strong>${nairaFromKobo(s.legacyBalanceKobo)}</strong><small>Needs reconciliation</small></div></div>
    <div class="notice warning">No payment-provider API is connected. Funding claims must be checked against the business account. Manual payouts happen outside the app; record them only after checking evidence.</div>
    <div class="tabbar">${[["campaigns","Campaigns"],["advertisers","Advertisers"],["funding","Funding"],["tasks","Task review"],["withdrawals","Withdrawals"],["users","Users"],["support","Support"],["settings","Settings"],["audit","Audit log"]].map(([key,label])=>`<button data-tab="${key}" class="${key==="campaigns"?"selected":""}">${label}</button>`).join("")}</div>
    <section id="panel-campaigns"><div class="section-head"><h2>Campaign review</h2><span class="muted">Approval and full confirmed funding are required for activation.</span></div><div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Requested / funded</th><th>Committed / allocation</th><th>Results</th><th>State</th><th>Actions</th></tr></thead><tbody>${campaignRows||`<tr><td colspan="6">No campaign records.</td></tr>`}</tbody></table></div><p class="metric-caption">Legacy sample campaigns remain inactive and unfunded. No demo campaigns are distributed to users.</p></section>
    <section id="panel-advertisers" hidden><div class="section-head"><h2>Advertiser accounts</h2></div><div class="table-wrap"><table><thead><tr><th>Business / contact</th><th>Status</th><th>Campaigns</th><th>Budget / funded</th><th>Results</th><th>Actions</th></tr></thead><tbody>${advertiserRows||`<tr><td colspan="6">No advertiser accounts.</td></tr>`}</tbody></table></div></section>
    <section id="panel-funding" hidden><div class="section-head"><h2>Funding reconciliation</h2><span class="muted">Verify deposits independently before confirming.</span></div><div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Claimed amount</th><th>Advertiser reference</th><th>Status / note</th><th>Submitted by</th><th>Actions</th></tr></thead><tbody>${fundingRows||`<tr><td colspan="6">No funding claims.</td></tr>`}</tbody></table></div></section>
    <section id="panel-tasks" hidden><div class="section-head"><h2>Pending reward review</h2><span class="muted">Manual review does not independently verify video playback.</span></div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Campaign</th><th>Attempt / elapsed</th><th>Reward / pool</th><th>Date</th><th>Actions</th></tr></thead><tbody>${taskRows||`<tr><td colspan="6">No reward reviews pending.</td></tr>`}</tbody></table></div></section>
    <section id="panel-withdrawals" hidden><div class="section-head"><h2>Withdrawal state machine</h2><span class="muted">Bank destination fields are visible to administrators only.</span></div><div class="table-wrap"><table><thead><tr><th>User / reference</th><th>Amounts</th><th>Destination</th><th>Status / reason</th><th>Payout record</th><th>Actions</th></tr></thead><tbody>${withdrawalRows||`<tr><td colspan="6">No withdrawal requests.</td></tr>`}</tbody></table></div></section>
    <section id="panel-users" hidden><div class="section-head"><div><h2>Users</h2><span class="muted">RC balances and prior cash balances are kept separate.</span></div><input id="userSearch" placeholder="Search name or email" style="max-width:280px"></div><div class="table-wrap"><table id="usersTable"><thead><tr><th>User</th><th>Role</th><th>Available RC</th><th>Pending RC</th><th>Legacy held</th><th>Approved rewards</th><th>Joined</th></tr></thead><tbody>${userRows}</tbody></table></div></section>
    <section id="panel-support" hidden><div class="section-head"><h2>Support requests</h2></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Topic</th><th>Request</th><th>Status</th><th>Response</th><th>Action</th></tr></thead><tbody>${supportRows||`<tr><td colspan="6">No support requests.</td></tr>`}</tbody></table></div></section>
    <section id="panel-settings" hidden><div class="section-head"><div><h2>Platform settings</h2><span class="muted">Proposed defaults; rate changes apply to future requests.</span></div></div><div class="panel"><form id="settingsForm"><div class="grid"><div><label>RC in conversion rate</label><input name="coinRateRc" type="number" min="1" value="${Number(cfg.coin_rate_rc)}" required></div><div><label>Kobo in conversion rate</label><input name="coinRateKobo" type="number" min="1" value="${Number(cfg.coin_rate_kobo)}" required></div><div><label>Minimum withdrawal RC</label><input name="minimumWithdrawalRc" type="number" min="1" value="${Number(cfg.minimum_withdrawal_rc)}" required></div><div><label>Withdrawal fee in kobo</label><input name="withdrawalFeeKobo" type="number" min="0" value="${Number(cfg.withdrawal_fee_kobo)}" required></div><div><label>Reward allocation estimate (%)</label><input name="rewardAllocationPercent" type="number" min="0.01" max="100" step="0.01" value="${Number(cfg.reward_allocation_bps)/100}" required></div><div><label>Variable cost estimate (%)</label><input name="variableCostPercent" type="number" min="0" max="100" step="0.01" value="${Number(cfg.variable_cost_bps)/100}" required></div></div><p class="metric-caption">Allocation and cost rates are planning estimates, not a promise of margin. Protect business approval before changing published settings.</p><button class="btn">Save settings</button><p id="settingsMessage" role="status"></p></form></div><div class="panel"><strong>Integration status</strong><p>Advertiser payment instructions: ${settings.integrations.fundingConfigured?"configured; deposits still need manual reconciliation":"not configured"}</p><p>Encrypted bank storage: ${settings.integrations.bankPayoutConfigured?"configured":"not configured; withdrawal form disabled"}</p><p>Automated payouts and bank name enquiry: not configured</p></div></section>
    <section id="panel-audit" hidden><div class="section-head"><h2>Recent audit events</h2></div><div class="table-wrap">${audit.length?`<table><thead><tr><th>Actor</th><th>Action</th><th>Record</th><th>Details</th><th>Time</th></tr></thead><tbody>${audit.map(a=>`<tr><td>${escapeHtml(a.actor_name||"System")}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.entity_type)} ${escapeHtml(a.entity_id||"")}</td><td><code>${escapeHtml(a.details)}</code></td><td>${escapeHtml(a.created_at)}</td></tr>`).join("")}</tbody></table>`:`<div class="empty">No audit events yet.</div>`}</div></section>`);
  document.querySelectorAll("[data-tab]").forEach(button=>button.onclick=()=>{document.querySelectorAll("[data-tab]").forEach(item=>item.classList.toggle("selected",item===button));document.querySelectorAll("[id^='panel-']").forEach(panel=>panel.hidden=panel.id!==`panel-${button.dataset.tab}`);});
  document.getElementById("userSearch").oninput=event=>{const q=event.target.value.toLowerCase();document.querySelectorAll("#usersTable tbody tr").forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(q));};
  document.getElementById("settingsForm").onsubmit=async event=>{event.preventDefault();if(!event.target.reportValidity())return;const f=Object.fromEntries(new FormData(event.target));const msg=document.getElementById("settingsMessage");try{await api("/api/admin/settings",{method:"PATCH",body:JSON.stringify({settings:{coin_rate_rc:Number(f.coinRateRc),coin_rate_kobo:Number(f.coinRateKobo),minimum_withdrawal_rc:Number(f.minimumWithdrawalRc),withdrawal_fee_kobo:Number(f.withdrawalFeeKobo),reward_allocation_bps:Math.round(Number(f.rewardAllocationPercent)*100),variable_cost_bps:Math.round(Number(f.variableCostPercent)*100)}})});msg.className="success";msg.textContent="Settings saved.";await admin();}catch(error){msg.className="error";msg.textContent=error.message;}};
}

async function reviewCampaign(id,status){const reason=status==="rejected"?prompt("Reason for campaign rejection:"):"";if(status==="rejected"&&(!reason||!reason.trim()))return;if(status==="approved"&&!confirm("Approve for funding? The campaign remains inactive until full funding is confirmed."))return;try{await api(`/api/admin/campaigns/${id}`,{method:"PATCH",body:JSON.stringify({approvalStatus:status,reason})});await admin();}catch(error){alert(error.message);}}
async function reviewAdvertiser(id,status){const reason=status==="rejected"?prompt("Reason for advertiser profile rejection:"):"";if(status==="rejected"&&(!reason||!reason.trim()))return;if(status==="approved"&&!confirm("Approve this business to submit campaigns for review?"))return;try{await api(`/api/admin/advertisers/${id}`,{method:"PATCH",body:JSON.stringify({status,reason})});await admin();}catch(error){alert(error.message);}}
async function reconcileFunding(id,maxAmount){const status=maxAmount>0?"confirmed":"rejected",body={status};if(status==="confirmed"){if(!confirm("Only confirm after checking this deposit against the platform account."))return;body.actualAmountNgn=Number(prompt(`Actual amount received in naira (maximum ${maxAmount}):`,String(maxAmount)));body.reconciliationReference=prompt("Bank statement or payment reference:")||"";body.verificationNote=prompt("How was the deposit verified?")||"";}else{body.verificationNote=prompt("Why could this deposit not be reconciled?")||"";if(!body.verificationNote)return;}try{await api(`/api/admin/fundings/${id}/reconcile`,{method:"POST",body:JSON.stringify(body)});await admin();}catch(error){alert(error.message);}}
async function reviewTask(id,decision){const reason=decision==="rejected"?prompt("Reason shown to the user:"):"";if(decision==="rejected"&&(!reason||!reason.trim()))return;if(decision==="approved"&&!confirm("Approve this reward and move its RC into the user's available balance?"))return;try{await api(`/api/admin/task-reviews/${id}`,{method:"PATCH",body:JSON.stringify({decision,reason})});await admin();}catch(error){alert(error.message);}}
async function updateWithdrawal(id,status){const body={status};if(status==="rejected"||status==="failed"){body.reason=prompt("Required reason:")||"";if(!body.reason.trim())return;}if(status==="processing"){body.reason=prompt("Reconciliation note before starting or retrying the external payout:")||"";if(!body.reason.trim())return;}if(status==="paid"){if(!confirm("Confirm the external bank transfer completed and evidence has been checked. This cannot be undone."))return;body.payoutReference=prompt("Verified payout reference:")||"";body.payoutEvidence=prompt("Evidence checked (do not enter credentials):")||"";}if(status==="approved"&&!confirm("Approve for manual processing? RC remains reserved."))return;try{await api(`/api/admin/withdrawals/${id}`,{method:"PATCH",body:JSON.stringify(body)});await admin();}catch(error){alert(error.message);}}
async function setCampaignStatus(id,status){if(status==="active"&&!confirm("Activate only after confirming approval and full funding."))return;try{await api(`/api/admin/campaigns/${id}`,{method:"PATCH",body:JSON.stringify({status})});await admin();}catch(error){alert(error.message);}}
async function resolveSupport(id){const response=prompt("Response to the user:");if(!response||!response.trim())return;try{await api(`/api/admin/support/${id}`,{method:"PATCH",body:JSON.stringify({status:"resolved",response})});await admin();}catch(error){alert(error.message);}}

async function render() {
  await refreshNav();
  const p = location.pathname;
  if (p === "/login") return authPage("login");
  if (p === "/register") return authPage("register");
  if (p === "/forgot-password") return forgotPasswordPage();
  if (p === "/reset-password") return resetPasswordPage();
  if (p === "/dashboard") return dashboard();
  if (p === "/admin") return admin();
  if (p === "/advertiser") return advertiserDashboard();
  if (p === "/withdraw") return withdraw();
  if (p === "/transactions") return transactionsPage();
  if (p === "/faq") return faqPage();
  if (p === "/policies") return policiesPage();
  if (p === "/support") return supportPage();
  return home();
}

render();
