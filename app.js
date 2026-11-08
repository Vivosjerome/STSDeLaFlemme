const API_URL = "https://sts-mobilite.stsweb.fr/graphql";
const SESSION_KEY = "sts-flemme-session";
const PREFS_KEY = "sts-flemme-prefs";
const MISSION_NAME = "Livraison";
const POLICE_KEY = "sts-flemme-police";

const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const appView = $("app-view");
const loginForm = $("login-form");
const sendForm = $("send-form");
const loginError = $("login-error");
const sendError = $("send-error");
const sendOk = $("send-ok");
const loginBtn = $("login-btn");
const sendBtn = $("send-btn");

let session = null;
let pendingPolice = null;
let pendingDay = null;
let popupMode = null;

function pad(n) {
  return String(n).padStart(2, "0");
}

function todayValue(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeValue(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeTime(value) {
  const raw = value.trim();
  let hours;
  let minutes;
  const colon = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colon) {
    hours = Number(colon[1]);
    minutes = Number(colon[2]);
  } else {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 3) {
      hours = Number(digits.slice(0, 1));
      minutes = Number(digits.slice(1));
    } else if (digits.length === 4) {
      hours = Number(digits.slice(0, 2));
      minutes = Number(digits.slice(2));
    } else {
      return null;
    }
  }
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

function bindTimeInput(input) {
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 4);
    const formatted = digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`;
    if (formatted !== input.value) input.value = formatted;
  });
  input.addEventListener("blur", () => {
    const normal = normalizeTime(input.value);
    if (normal) input.value = normal;
  });
}

function syncTimeFace(input) {
  const face = input.parentElement?.querySelector(".time-face");
  if (face) face.textContent = input.value || "--:--";
}

function prepareTimeInput(input) {
  const wheel = window.matchMedia("(pointer: coarse)").matches;
  const field = input.closest(".time-field");
  if (wheel) {
    input.type = "time";
    input.step = "60";
    field?.classList.add("is-wheel");
    syncTimeFace(input);
    input.addEventListener("input", () => syncTimeFace(input));
    input.addEventListener("change", () => syncTimeFace(input));
    return;
  }
  field?.classList.remove("is-wheel");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 5;
  input.placeholder = input.id.includes("end") ? "18:00" : "07:00";
  input.autocomplete = "off";
  bindTimeInput(input);
}

function combine(day, time) {
  const [year, month, date] = day.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(year, month - 1, date, hours, minutes, 0, 0);
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(partial) {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...partial }));
}

function show(el, text) {
  el.hidden = !text;
  el.textContent = text || "";
}

async function gql(query, variables, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("STS n'a pas répondu.");
  }
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("\n"));
  }
  return body.data;
}

function planDay(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: "Heures incomplètes." };
  }
  if (end <= start) return { error: "L'arrivée doit être après le départ." };
  if (end.getTime() > Date.now() + 60 * 1000) {
    return { error: "L'arrivée est dans le futur." };
  }

  const spanMin = (end.getTime() - start.getTime()) / 60000;
  const withPause = start.getHours() < 12 && end.getHours() >= 13;
  if (!withPause) return { blocks: [{ type: "work", start, end }], workMin: spanMin };

  const pauseStart = new Date(start);
  pauseStart.setHours(12, 0, 0, 0);
  const pauseEnd = new Date(start);
  pauseEnd.setHours(12, 30, 0, 0);
  if (pauseStart <= start || pauseEnd >= end) return { blocks: [{ type: "work", start, end }], workMin: spanMin };
  return {
    blocks: [
      { type: "work", start, end: pauseStart },
      { type: "work", start: pauseEnd, end },
    ],
    workMin: spanMin - 30,
  };
}

function formatDuration(minutes) {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins) return `${hours}h${pad(mins)}`;
  if (hours) return `${hours}h`;
  return `${mins} min`;
}

function daySummary(plan) {
  let workMin = 0;
  const pauses = [];
  for (let i = 0; i < plan.blocks.length; i += 1) {
    const block = plan.blocks[i];
    if (block.end) workMin += (block.end.getTime() - block.start.getTime()) / 60000;
    const previous = plan.blocks[i - 1];
    if (previous?.end && block.start > previous.end) {
      pauses.push({ start: previous.end, end: block.start });
    }
  }
  const pauseMin = pauses.reduce((sum, pause) => sum + (pause.end - pause.start) / 60000, 0);
  return [`Total : ${formatDuration(workMin + pauseMin)}`, `Avec pause : ${formatDuration(workMin)}`];
}

function showLines(el, lines) {
  el.hidden = false;
  el.replaceChildren();
  for (const line of lines) {
    const row = document.createElement("span");
    row.textContent = line;
    el.append(row);
  }
}

function policePlan(now = new Date()) {
  const start = new Date(now);
  start.setHours(7, 0, 0, 0);
  const end = new Date(now);
  end.setSeconds(0, 0);
  if (end <= start) return { error: "Il n'est pas encore 7h." };

  const sixHours = 6 * 60 * 60 * 1000;
  const pause = 30 * 60 * 1000;
  const blocks = [];
  let cursor = start.getTime();
  const limit = end.getTime();

  while (limit - cursor >= sixHours) {
    let workEnd = cursor + sixHours;
    let pauseEnd = workEnd + pause;
    if (limit < pauseEnd) {
      workEnd = cursor + sixHours - pause;
      pauseEnd = cursor + sixHours;
    }
    if (workEnd <= cursor) break;
    blocks.push({ type: "work", start: new Date(cursor), end: new Date(workEnd) });
    cursor = pauseEnd;
    if (cursor >= limit) break;
  }
  if (cursor <= limit) blocks.push({ type: "work", start: new Date(cursor), end: null });

  return { blocks };
}

function loadPolice() {
  try {
    return JSON.parse(localStorage.getItem(POLICE_KEY)) || null;
  } catch {
    return null;
  }
}

function renderPoliceButton() {
  const active = Boolean(loadPolice());
  $("police-label").textContent = active ? "Police en cours" : "Police";
  $("police-btn").classList.toggle("is-on", active);
}

function readTime(id) {
  const normal = normalizeTime($(id).value);
  if (normal) $(id).value = normal;
  return normal;
}

function currentPlan() {
  const start = readTime("start");
  const end = readTime("end");
  if (!start || !end) return { error: "Heures incomplètes. Exemple : 07:00 et 18:30." };
  return planDay(combine(todayValue(), start), combine(todayValue(), end));
}

function setArrivalNow() {
  $("end").value = timeValue(new Date());
  syncTimeFace($("end"));
}

function closePopup() {
  popupMode = null;
  pendingPolice = null;
  pendingDay = null;
  $("popup").hidden = true;
}

function openPopup(mode, text) {
  popupMode = mode;
  $("popup-text").textContent = text;
  $("popup").hidden = false;
}

function showApp() {
  document.documentElement.classList.remove("booting");
  $("loading-view").hidden = true;
  closePopup();
  renderPoliceButton();
  loginView.hidden = true;
  appView.hidden = false;
  $("who-name").textContent = session.name;
  show(sendError, "");
  show(sendOk, "");
  setArrivalNow();
}

function showLogin({ forget = false } = {}) {
  document.documentElement.classList.remove("booting");
  $("loading-view").hidden = true;
  session = null;
  closePopup();
  sessionStorage.removeItem(SESSION_KEY);
  if (forget) savePrefs({ password: "" });
  const prefs = loadPrefs();
  $("email").value = prefs.email || "";
  $("password").value = forget ? "" : prefs.password || "";
  appView.hidden = true;
  loginView.hidden = false;
  show(loginError, "");
}

function loginMessage(error) {
  return /invalid credentials/i.test(error?.message || "")
    ? "Email ou mot de passe incorrect."
    : error?.message || "Connexion échouée.";
}

async function login(email, password) {
  const data = await gql(
    "mutation login($e: String!, $p: String!) { auth { login(email: $e, password: $p) { accessToken } } }",
    { e: email, p: password }
  );
  const token = data?.auth?.login?.accessToken;
  if (!token) throw new Error("Connexion refusée.");

  const meData = await gql(
    "query { me { id firstName lastName primaryCompany { id name } } }",
    {},
    token
  );
  const me = meData?.me;
  if (!me?.id) throw new Error("Profil introuvable.");
  if (!me.primaryCompany?.id) throw new Error("Aucune entreprise principale sur ce compte.");

  session = {
    token,
    userId: me.id,
    name: `${me.firstName} ${me.lastName}`.trim(),
    companyId: me.primaryCompany.id,
    email,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  savePrefs({ email, password });
}

async function sendDay(plan, { finish = true } = {}) {
  const token = session.token;
  const toUnix = (date) => Math.floor(date.getTime() / 1000);
  const created = await gql(
    "mutation create($n:String!,$c:Int!){activities{createMission(name:$n,companyId:$c){id}}}",
    { n: MISSION_NAME, c: session.companyId },
    token
  );
  const missionId = created?.activities?.createMission?.id;
  if (!missionId) throw new Error("STS n'a pas créé la mission.");
  const activityIds = [];

  const logQuery =
    "mutation log($m:Int!,$t:ActivityTypeEnum!,$s:TimeStamp!,$u:Int!){activities{logActivity(missionId:$m,type:$t,startTime:$s,userId:$u){id}}}";
  const editQuery =
    "mutation edit($id:Int!,$s:TimeStamp!,$e:TimeStamp!){activities{editActivity(activityId:$id,startTime:$s,endTime:$e){id}}}";

  try {
    for (const block of plan.blocks) {
      const logged = await gql(
        logQuery,
        { m: missionId, t: block.type || "work", s: toUnix(block.start), u: session.userId },
        token
      );
      const activityId = logged?.activities?.logActivity?.id;
      if (!activityId) throw new Error("STS n'a pas enregistré une activité.");
      activityIds.push(activityId);
      if (block.end) {
        await gql(editQuery, { id: activityId, s: toUnix(block.start), e: toUnix(block.end) }, token);
      }
    }
    if (finish && plan.blocks.at(-1)?.end) {
      await gql(
        "mutation end($mId:Int!,$eT:TimeStamp!){activities{endMission(missionId:$mId,endTime:$eT){id}}}",
        { mId: missionId, eT: toUnix(plan.blocks.at(-1).end) },
        token
      );
      const validated = await gql(
        "mutation validate($mId:Int!,$u:Int){activities{validateMission(missionId:$mId,userId:$u){mission{id}}}}",
        { mId: missionId, u: session.userId },
        token
      );
      if (!validated?.activities?.validateMission?.mission?.id) {
        throw new Error("STS n'a pas validé la mission.");
      }
    }
  } catch (error) {
    const overlap = /overlap/i.test(error.message || "");
    const detail = overlap
      ? `Il y a déjà des heures sur ce créneau. Supprime-les dans STS, puis réessaie.`
      : error.message;
    throw new Error(`${detail}\nMission ${missionId} a été créée en trop, tu peux l'enlever dans STS.`);
  }
  return { missionId, activityIds };
}

function alreadyGone(error) {
  return /dismiss|already cancel|not found|introuvable|does not exist|n'existe|déjà annul|déjà supprim/i.test(
    error?.message || ""
  );
}

async function cancelPolice() {
  const saved = loadPolice();
  if (!saved?.activityIds?.length) {
    localStorage.removeItem(POLICE_KEY);
    return "removed";
  }
  const query =
    "mutation cancel($id:Int!){activities{cancelActivity(activityId:$id){success}}}";
  const ids = [...saved.activityIds];
  let removed = 0;
  let gone = 0;
  while (ids.length) {
    const id = ids.pop();
    try {
      const data = await gql(query, { id }, session.token);
      if (!data?.activities?.cancelActivity?.success) {
        throw new Error("STS n'a pas annulé une activité.");
      }
      removed += 1;
    } catch (error) {
      if (!alreadyGone(error)) {
        localStorage.setItem(POLICE_KEY, JSON.stringify({ ...saved, activityIds: [...ids, id] }));
        throw error;
      }
      gone += 1;
    }
    localStorage.setItem(POLICE_KEY, JSON.stringify({ ...saved, activityIds: ids }));
  }
  localStorage.removeItem(POLICE_KEY);
  return gone && !removed ? "gone" : "removed";
}

function bootForm() {
  const prefs = loadPrefs();
  $("email").value = prefs.email || "";
  $("password").value = prefs.password || "";
  $("start").value = normalizeTime(prefs.start || "") || "07:00";
  setArrivalNow();
  prepareTimeInput($("start"));
  prepareTimeInput($("end"));
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  show(loginError, "");
  loginBtn.disabled = true;
  try {
    await login($("email").value.trim(), $("password").value);
    showApp();
  } catch (error) {
    show(loginError, loginMessage(error));
  } finally {
    loginBtn.disabled = false;
  }
});

sendForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  show(sendError, "");
  show(sendOk, "");
  if (loadPolice()) {
    show(sendError, "Supprime Police avant d'envoyer tes horaires.");
    return;
  }
  const plan = currentPlan();
  if (plan.error) {
    show(sendError, plan.error);
    return;
  }
  pendingDay = plan;
  openPopup("day", "Êtes-vous sûr de vouloir faire ça ?");
});

$("police-btn").addEventListener("click", () => {
  show(sendError, "");
  show(sendOk, "");
  if (loadPolice()) {
    openPopup("cancel", "Supprimer cet envoi sur STS ?");
    return;
  }
  const plan = policePlan();
  if (plan.error) {
    show(sendError, plan.error);
    return;
  }
  pendingPolice = plan;
  openPopup("send", "Êtes-vous sûr de vouloir faire ça ?");
});

$("popup-no").addEventListener("click", closePopup);

$("popup-yes").addEventListener("click", async () => {
  if (!session) return;
  const mode = popupMode;
  const plan = pendingPolice;
  const day = pendingDay;
  $("popup-yes").disabled = true;
  try {
    if (mode === "day") {
      if (!day) return;
      await sendDay(day);
      savePrefs({ start: $("start").value });
      closePopup();
      showLines(sendOk, ["Envoyé et validé.", ...daySummary(day)]);
    } else if (mode === "send") {
      if (!plan) return;
      const sent = await sendDay(plan, { finish: false });
      localStorage.setItem(POLICE_KEY, JSON.stringify(sent));
      closePopup();
      renderPoliceButton();
      show(sendOk, "Envoyé.");
    } else if (mode === "cancel") {
      const result = await cancelPolice();
      closePopup();
      renderPoliceButton();
      show(sendOk, result === "gone" ? "Déjà supprimé sur STS." : "Supprimé.");
    }
  } catch (error) {
    closePopup();
    show(sendError, error.message || "Échec.");
  } finally {
    $("popup-yes").disabled = false;
  }
});

renderPoliceButton();

$("logout").addEventListener("click", () => showLogin({ forget: true }));

const THEMES = ["1", "2", "13", "17", "19"];
const THEME_KEY = "sts-flemme-theme";

function savedTheme() {
  const theme = localStorage.getItem(THEME_KEY);
  if (THEMES.includes(theme)) return theme;
  const old = Number(localStorage.getItem("sts-flemme-look"));
  const fromOld = String((Number.isFinite(old) ? old : 0) + 1);
  return THEMES.includes(fromOld) ? fromOld : "1";
}

function applyTheme(id) {
  const theme = THEMES.includes(id) ? id : "1";
  document.documentElement.dataset.look = theme;
  localStorage.setItem(THEME_KEY, theme);
  document.querySelectorAll(".theme-choice").forEach((button) => {
    const on = button.dataset.theme === theme;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
  });
}

function setThemeOpen(open) {
  $("theme-panel").hidden = !open;
  $("theme-btn").setAttribute("aria-expanded", String(open));
}

applyTheme(savedTheme());
$("theme-btn").addEventListener("click", () => setThemeOpen($("theme-panel").hidden));
document.querySelectorAll(".theme-choice").forEach((button) => {
  button.addEventListener("click", () => applyTheme(button.dataset.theme));
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".theme-dock")) setThemeOpen(false);
});

bootForm();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session) setArrivalNow();
});

async function bootSession() {
  const prefs = loadPrefs();
  if (prefs.email && prefs.password) {
    loginBtn.disabled = true;
    loginBtn.textContent = "Connexion…";
    try {
      await login(prefs.email, prefs.password);
      showApp();
      return;
    } catch (error) {
      document.documentElement.classList.remove("booting");
      $("loading-view").hidden = true;
      show(loginError, loginMessage(error));
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = "Se connecter";
    }
    return;
  }

  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return;
  try {
    session = JSON.parse(saved);
    showApp();
    await gql("query { me { id } }", {}, session.token);
  } catch {
    showLogin();
  }
}

bootSession();
