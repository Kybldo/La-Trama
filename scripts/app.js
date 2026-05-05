import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const SESSION_KEY = "friendsEvents.session";
const COUNT_FIELD = { yes: "confirmed", no: "denied", maybe: "unsure" };

let currentUser = null;
let events = [];
let attendance = new Map();
let unsubscribeEvents = null;
let unsubscribeAttendance = null;
let deferredInstallPrompt = null;

const $ = (id) => document.getElementById(id);
const els = {
  loginView: $("loginView"), appView: $("appView"), loginForm: $("loginForm"),
  loginUsername: $("loginUsername"), loginPassword: $("loginPassword"),
  currentUserLabel: $("currentUserLabel"), accountName: $("accountName"), accountRole: $("accountRole"),
  logoutButton: $("logoutButton"), adminUserPanel: $("adminUserPanel"), createUserForm: $("createUserForm"),
  eventsList: $("eventsList"), historyList: $("historyList"), eventsEmpty: $("eventsEmpty"), historyEmpty: $("historyEmpty"),
  newEventButton: $("newEventButton"), eventForm: $("eventForm"), eventModalTitle: $("eventModalTitle"),
  eventId: $("eventId"), eventName: $("eventName"), eventDescription: $("eventDescription"), eventDate: $("eventDate"),
  newDisplayName: $("newDisplayName"), newUsername: $("newUsername"), newPassword: $("newPassword"), newAdmin: $("newAdmin"),
  installButton: $("installButton"), toastHost: $("toastHost"),
  attendeesModalTitle: $("attendeesModalTitle"), attendeesModalSubtitle: $("attendeesModalSubtitle"), attendeesModalBody: $("attendeesModalBody")
};

bootstrap.Modal.getOrCreateInstance($("eventModal"));
bootstrap.Modal.getOrCreateInstance($("attendeesModal"));

window.addEventListener("DOMContentLoaded", boot);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  els.installButton.classList.remove("d-none");
});

els.installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  els.installButton.classList.add("d-none");
});

async function boot() {
  registerServiceWorker();
  bindEvents();
  const saved = readSession();
  if (saved?.username) {
    const user = await getUser(saved.username);
    if (user) return startSession(user, false);
    clearSession();
  }
  showLogin();
}

function bindEvents() {
  els.loginForm.addEventListener("submit", login);
  els.logoutButton.addEventListener("click", logout);
  els.createUserForm.addEventListener("submit", createUser);
  els.eventForm.addEventListener("submit", saveEvent);
  els.newEventButton.addEventListener("click", prepareNewEvent);
}

async function login(event) {
  event.preventDefault();
  const username = normalizeUsername(els.loginUsername.value);
  const passwordHash = await hashPassword(els.loginPassword.value);
  const user = await getUser(username);

  if (!user || user.passwordHash !== passwordHash) {
    return toast("Nombre de usuario o contraseña incorrectos", "danger");
  }

  saveSession(user);
  startSession(user, true);
}

async function startSession(user, greet) {
  currentUser = user;
  els.currentUserLabel.textContent = user.displayName;
  els.accountName.textContent = user.displayName;
  els.accountRole.textContent = user.admin ? "Administrador" : "Usuario";
  els.newEventButton.classList.toggle("d-none", !user.admin);
  els.adminUserPanel.classList.toggle("d-none", !user.admin);
  els.loginView.classList.add("d-none");
  els.appView.classList.remove("d-none");
  subscribeData();
  if (greet) toast(`Bienvenido/a, ${user.displayName}`, "success");
}

function showLogin() {
  els.appView.classList.add("d-none");
  els.loginView.classList.remove("d-none");
}

function logout() {
  currentUser = null;
  clearSession();
  unsubscribeEvents?.();
  unsubscribeAttendance?.();
  events = [];
  attendance = new Map();
  els.loginForm.reset();
  showLogin();
}

function subscribeData() {
  unsubscribeEvents?.();
  unsubscribeAttendance?.();

  unsubscribeEvents = onSnapshot(query(collection(db, "events"), orderBy("date", "asc")), async (snapshot) => {
    events = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    await archivePastEvents();
    render();
  }, (error) => toast(error.message, "danger"));

  unsubscribeAttendance = onSnapshot(collection(db, "attendance"), (snapshot) => {
    attendance = new Map(snapshot.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    render();
  }, (error) => toast(error.message, "danger"));
}

async function archivePastEvents() {
  if (!currentUser?.admin) return;
  const today = todayIso();
  const updates = events
    .filter(e => e.active !== false && e.date < today)
    .map(e => updateDoc(doc(db, "events", e.id), { active: false, archivedAt: serverTimestamp() }));
  if (updates.length) await Promise.allSettled(updates);
}

function render() {
  if (!currentUser) return;
  const today = todayIso();
  const activeEvents = events.filter(e => e.active !== false && e.date >= today);
  const historyEvents = events.filter(e => e.active === false || e.date < today).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  els.eventsList.innerHTML = activeEvents.map(eventCard).join("");
  els.historyList.innerHTML = historyEvents.map(historyCard).join("");
  els.eventsEmpty.classList.toggle("d-none", activeEvents.length !== 0);
  els.historyEmpty.classList.toggle("d-none", historyEvents.length !== 0);

  document.querySelectorAll("[data-vote]").forEach(btn => btn.addEventListener("click", () => setAttendance(btn.dataset.eventId, btn.dataset.vote)));
  document.querySelectorAll("[data-attendees]").forEach(btn => btn.addEventListener("click", () => showAttendees(btn.dataset.attendees)));
  document.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => prepareEditEvent(btn.dataset.edit)));
  document.querySelectorAll("[data-delete]").forEach(btn => btn.addEventListener("click", () => removeEvent(btn.dataset.delete)));
}

function eventCard(event) {
  const userStatus = getUserAttendance(event.id)?.status;
  const admin = currentUser.admin ? `
    <div class="admin-actions mt-3">
      <button class="btn btn-outline-secondary btn-sm flex-fill" data-edit="${event.id}"><i class="bi bi-pencil"></i> Editar</button>
      <button class="btn btn-outline-danger btn-sm flex-fill" data-delete="${event.id}"><i class="bi bi-trash"></i> Eliminar</button>
    </div>` : "";

  return `<article class="col-12 col-lg-6">
    <div class="event-card shadow-sm h-100">
      <div class="d-flex justify-content-between gap-2 align-items-start mb-2">
        <h3 class="h5 fw-bold mb-0">${escapeHtml(event.name)}</h3>
        <span class="event-date-pill"><i class="bi bi-calendar3"></i>${formatDate(event.date)}</span>
      </div>
      <p class="description mb-3">${escapeHtml(event.description)}</p>
      ${statsMarkup(event)}
      <div class="vote-grid mt-3">
        ${voteButton(event.id, "yes", "success", "bi-check-lg", "Sí", userStatus)}
        ${voteButton(event.id, "no", "danger", "bi-x-lg", "No", userStatus)}
        ${voteButton(event.id, "maybe", "warning", "bi-question-lg", "No sé", userStatus)}
      </div>
      <div class="event-secondary-actions">
        <button class="btn btn-outline-primary btn-sm w-100" data-attendees="${event.id}">
          <i class="bi bi-people-fill"></i> Asistentes
        </button>
      </div>
      ${admin}
    </div>
  </article>`;
}

function historyCard(event) {
  return `<article class="col-12 col-lg-6">
    <div class="history-card shadow-sm h-100 opacity-90">
      <div class="d-flex justify-content-between gap-2 align-items-start mb-2">
        <h3 class="h5 fw-bold mb-0">${escapeHtml(event.name)}</h3>
        <span class="event-date-pill"><i class="bi bi-calendar3"></i>${formatDate(event.date)}</span>
      </div>
      <p class="description mb-3">${escapeHtml(event.description)}</p>
      ${statsMarkup(event)}
      <div class="event-secondary-actions">
        <button class="btn btn-outline-primary btn-sm w-100" data-attendees="${event.id}">
          <i class="bi bi-people-fill"></i> Asistentes
        </button>
      </div>
      ${currentUser.admin ? `<button class="btn btn-outline-danger btn-sm w-100 mt-3" data-delete="${event.id}"><i class="bi bi-trash"></i> Eliminar permanentemente</button>` : ""}
    </div>
  </article>`;
}

function statsMarkup(event) {
  return `<div class="stats">
    <div class="stat-box"><strong>${event.confirmed ?? 0}</strong><span class="small text-success">Sí</span></div>
    <div class="stat-box"><strong>${event.denied ?? 0}</strong><span class="small text-danger">No</span></div>
    <div class="stat-box"><strong>${event.unsure ?? 0}</strong><span class="small text-warning">No sé</span></div>
  </div>`;
}

function voteButton(eventId, status, color, icon, label, selected) {
  const outline = selected === status ? `btn-${color} selected` : `btn-outline-${color}`;
  return `<button class="btn ${outline}" data-event-id="${eventId}" data-vote="${status}"><i class="bi ${icon}"></i> ${label}</button>`;
}

function showAttendees(eventId) {
  const event = events.find(e => e.id === eventId);
  if (!event) return toast("No se ha encontrado el evento", "danger");

  const groups = getAttendanceGroups(eventId);
  const total = groups.yes.length + groups.no.length + groups.maybe.length;

  els.attendeesModalTitle.textContent = "Asistentes";
  els.attendeesModalSubtitle.textContent = `${event.name} · ${formatDate(event.date)} · ${total} respuesta${total === 1 ? "" : "s"}`;
  els.attendeesModalBody.innerHTML = `
    ${attendeeGroupMarkup("Sí", "text-success", "bi-check-circle-fill", groups.yes)}
    ${attendeeGroupMarkup("No", "text-danger", "bi-x-circle-fill", groups.no)}
    ${attendeeGroupMarkup("No sé", "text-warning", "bi-question-circle-fill", groups.maybe)}
  `;

  bootstrap.Modal.getOrCreateInstance($("attendeesModal")).show();
}

function getAttendanceGroups(eventId) {
  const records = [...attendance.values()]
    .filter(item => item.eventId === eventId)
    .sort((a, b) => String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)));

  return {
    yes: records.filter(item => item.status === "yes"),
    no: records.filter(item => item.status === "no"),
    maybe: records.filter(item => item.status === "maybe")
  };
}

function attendeeGroupMarkup(title, colorClass, icon, people) {
  const list = people.length
    ? `<ul class="attendee-list">${people.map(attendeeMarkup).join("")}</ul>`
    : `<div class="attendee-empty">Sin respuestas en esta categoría.</div>`;

  return `<section class="attendee-group">
    <div class="attendee-group-header">
      <span class="${colorClass}"><i class="bi ${icon} me-1"></i>${title}</span>
      <span class="attendee-count-badge">${people.length}</span>
    </div>
    ${list}
  </section>`;
}

function attendeeMarkup(person) {
  const name = person.displayName || person.username || "Usuario";
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return `<li>
    <span class="attendee-avatar-sm">${escapeHtml(initial)}</span>
    <span class="fw-semibold">${escapeHtml(name)}</span>
  </li>`;
}

async function setAttendance(eventId, nextStatus) {
  const username = currentUser.username;
  const attendanceId = `${eventId}_${username}`;
  const eventRef = doc(db, "events", eventId);
  const attendanceRef = doc(db, "attendance", attendanceId);

  await runTransaction(db, async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (!eventSnap.exists()) throw new Error("Evento no encontrado");
    const attendanceSnap = await tx.get(attendanceRef);
    const eventData = eventSnap.data();
    const updates = {};

    if (attendanceSnap.exists()) {
      const previousStatus = attendanceSnap.data().status;
      if (previousStatus === nextStatus) return;
      updates[COUNT_FIELD[previousStatus]] = Math.max(0, (eventData[COUNT_FIELD[previousStatus]] ?? 0) - 1);
    }

    updates[COUNT_FIELD[nextStatus]] = (updates[COUNT_FIELD[nextStatus]] ?? eventData[COUNT_FIELD[nextStatus]] ?? 0) + 1;
    tx.update(eventRef, updates);
    tx.set(attendanceRef, {
      eventId,
      username,
      displayName: currentUser.displayName,
      status: nextStatus,
      updatedAt: serverTimestamp()
    });
  });

  toast("Asistencia guardada", "success");
}

function prepareNewEvent() {
  els.eventModalTitle.textContent = "Crear evento";
  els.eventForm.reset();
  els.eventId.value = "";
  els.eventDate.value = todayIso();
}

function prepareEditEvent(eventId) {
  const event = events.find(e => e.id === eventId);
  if (!event) return;
  els.eventModalTitle.textContent = "Editar evento";
  els.eventId.value = event.id;
  els.eventName.value = event.name ?? "";
  els.eventDescription.value = event.description ?? "";
  els.eventDate.value = event.date ?? todayIso();
  bootstrap.Modal.getOrCreateInstance($("eventModal")).show();
}

async function saveEvent(event) {
  event.preventDefault();
  if (!currentUser?.admin) return toast("Solo los administradores pueden modificar eventos", "danger");

  const payload = {
    name: els.eventName.value.trim(),
    description: els.eventDescription.value.trim(),
    date: els.eventDate.value,
    active: true,
    updatedAt: serverTimestamp()
  };

  if (!payload.name || !payload.description || !payload.date) return toast("Rellena todos los campos del evento", "danger");

  if (els.eventId.value) {
    await updateDoc(doc(db, "events", els.eventId.value), payload);
    toast("Evento actualizado", "success");
  } else {
    await addDoc(collection(db, "events"), {
      ...payload,
      confirmed: 0,
      denied: 0,
      unsure: 0,
      createdAt: serverTimestamp(),
      createdBy: currentUser.username
    });
    toast("Evento creado", "success");
  }

  bootstrap.Modal.getOrCreateInstance($("eventModal")).hide();
  els.eventForm.reset();
}

async function removeEvent(eventId) {
  if (!currentUser?.admin) return;
  if (!confirm("¿Quieres borrar este evento?")) return;

  await deleteDoc(doc(db, "events", eventId));

  const allAttendance = await getDocs(collection(db, "attendance"));
  const deletes = allAttendance.docs
    .filter(d => d.data().eventId === eventId)
    .map(d => deleteDoc(doc(db, "attendance", d.id)));
  await Promise.allSettled(deletes);
  toast("Evento eliminado", "success");
}

async function createUser(event) {
  event.preventDefault();
  if (!currentUser?.admin) return toast("Solo los administradores pueden dar de alta usuarios", "danger");

  const username = normalizeUsername(els.newUsername.value);
  const displayName = els.newDisplayName.value.trim();
  const password = els.newPassword.value;
  if (!username || !displayName || !password) return toast("Rellena todos los campos del usuario", "danger");

  const ref = doc(db, "users", username);
  if ((await getDoc(ref)).exists()) return toast("El nombre de usuario ya existe", "danger");

  await setDoc(ref, {
    displayName,
    username,
    passwordHash: await hashPassword(password),
    admin: els.newAdmin.checked,
    createdAt: serverTimestamp(),
    createdBy: currentUser.username
  });

  els.createUserForm.reset();
  toast("Usuario creado", "success");
}

async function getUser(username) {
  const snap = await getDoc(doc(db, "users", normalizeUsername(username)));
  return snap.exists() ? snap.data() : null;
}

function getUserAttendance(eventId) {
  return attendance.get(`${eventId}_${currentUser.username}`);
}

async function hashPassword(password) {
  const bytes = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function saveSession(user) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username: user.username }));
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function clearSession() { localStorage.removeItem(SESSION_KEY); }
function normalizeUsername(value) { return String(value ?? "").trim().toLowerCase(); }
function todayIso() { return new Date().toISOString().slice(0, 10); }

function formatDate(iso) {
  if (!iso) return "Sin fecha";
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short" }).format(new Date(y, m - 1, d));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[ch]));
}

function toast(message, type = "primary") {
  const node = document.createElement("div");
  node.className = `toast align-items-center text-bg-${type} border-0`;
  node.role = "status";
  node.innerHTML = `<div class="d-flex"><div class="toast-body">${escapeHtml(message)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
  els.toastHost.appendChild(node);
  const instance = new bootstrap.Toast(node, { delay: 2600 });
  node.addEventListener("hidden.bs.toast", () => node.remove());
  instance.show();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(console.warn);
  }
}
