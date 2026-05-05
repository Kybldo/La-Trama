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
const EVENT_TYPES = ["Comida", "Cena", "Evento"];

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
  typeFilter: $("typeFilter"), sortFilter: $("sortFilter"),
  newEventButton: $("newEventButton"), eventForm: $("eventForm"), eventModalTitle: $("eventModalTitle"),
  eventId: $("eventId"), eventName: $("eventName"), eventDescription: $("eventDescription"), eventType: $("eventType"), eventDate: $("eventDate"), eventTime: $("eventTime"),
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
  els.typeFilter.addEventListener("change", render);
  els.sortFilter.addEventListener("change", render);
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
    events = snapshot.docs.map(d => normalizeEvent({ id: d.id, ...d.data() }));
    await archivePastEvents();
    render();
  }, (error) => toast(error.message, "danger"));

  unsubscribeAttendance = onSnapshot(collection(db, "attendance"), (snapshot) => {
    attendance = new Map(snapshot.docs.map(d => [d.id, normalizeAttendance({ id: d.id, ...d.data() })]));
    render();
  }, (error) => toast(error.message, "danger"));
}

function normalizeEvent(event) {
  return {
    ...event,
    type: EVENT_TYPES.includes(event.type) ? event.type : "Evento",
    time: event.time || "00:00"
  };
}

function normalizeAttendance(record) {
  const isAttending = record.attending === true || record.status === "yes";
  return {
    ...record,
    attending: isAttending,
    guests: Array.isArray(record.guests) ? record.guests.filter(Boolean) : []
  };
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
  const type = els.typeFilter.value;
  const sort = els.sortFilter.value;

  let activeEvents = events.filter(e => e.active !== false && e.date >= today);
  if (type !== "all") activeEvents = activeEvents.filter(e => e.type === type);
  activeEvents.sort((a, b) => compareEvents(a, b, sort));

  const historyEvents = events
    .filter(e => e.active === false || e.date < today)
    .sort((a, b) => compareEvents(a, b, "newest"));

  els.eventsList.innerHTML = activeEvents.map(eventCard).join("");
  els.historyList.innerHTML = historyEvents.map(historyCard).join("");
  els.eventsEmpty.classList.toggle("d-none", activeEvents.length !== 0);
  els.historyEmpty.classList.toggle("d-none", historyEvents.length !== 0);

  document.querySelectorAll("[data-attendance-toggle]").forEach(input => input.addEventListener("change", () => setAttendance(input.dataset.eventId, input.checked)));
  document.querySelectorAll("[data-add-guest]").forEach(btn => btn.addEventListener("click", () => addGuest(btn.dataset.addGuest)));
  document.querySelectorAll("[data-remove-guest]").forEach(btn => btn.addEventListener("click", () => removeGuest(btn.dataset.eventId, Number(btn.dataset.removeGuest))));
  document.querySelectorAll("[data-attendees]").forEach(btn => btn.addEventListener("click", () => showAttendees(btn.dataset.attendees)));
  document.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => prepareEditEvent(btn.dataset.edit)));
  document.querySelectorAll("[data-delete]").forEach(btn => btn.addEventListener("click", () => removeEvent(btn.dataset.delete)));
}

function compareEvents(a, b, direction) {
  const diff = getEventTimestamp(a) - getEventTimestamp(b);
  return direction === "newest" ? -diff : diff;
}

function eventCard(event) {
  const record = getUserAttendance(event.id);
  const isAttending = record?.attending === true;
  const userGuests = record?.guests ?? [];
  const totals = getEventTotals(event.id);
  const admin = currentUser.admin ? `
    <div class="admin-actions mt-3">
      <button class="btn btn-outline-secondary btn-sm flex-fill" data-edit="${event.id}"><i class="bi bi-pencil"></i> Editar</button>
      <button class="btn btn-outline-danger btn-sm flex-fill" data-delete="${event.id}"><i class="bi bi-trash"></i> Eliminar</button>
    </div>` : "";

  return `<article class="col-12 col-lg-6">
    <div class="event-card shadow-sm h-100">
      <div class="d-flex justify-content-between gap-2 align-items-start mb-2">
        <h3 class="h5 fw-bold mb-0">${escapeHtml(event.name)}</h3>
        <div class="d-flex flex-column align-items-end gap-1">
          <span class="event-type-pill"><i class="bi bi-tag-fill"></i>${escapeHtml(event.type)}</span>
          <span class="event-date-pill"><i class="bi bi-calendar3"></i>${formatDateTime(event)}</span>
        </div>
      </div>
      <p class="description mb-3">${escapeHtml(event.description)}</p>
      ${statsMarkup(totals)}
      ${attendancePanel(event.id, isAttending, userGuests)}
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
  const totals = getEventTotals(event.id);
  return `<article class="col-12 col-lg-6">
    <div class="history-card shadow-sm h-100 opacity-90">
      <div class="d-flex justify-content-between gap-2 align-items-start mb-2">
        <h3 class="h5 fw-bold mb-0">${escapeHtml(event.name)}</h3>
        <div class="d-flex flex-column align-items-end gap-1">
          <span class="event-type-pill"><i class="bi bi-tag-fill"></i>${escapeHtml(event.type)}</span>
          <span class="event-date-pill"><i class="bi bi-calendar3"></i>${formatDateTime(event)}</span>
        </div>
      </div>
      <p class="description mb-3">${escapeHtml(event.description)}</p>
      ${statsMarkup(totals)}
      <div class="event-secondary-actions">
        <button class="btn btn-outline-primary btn-sm w-100" data-attendees="${event.id}">
          <i class="bi bi-people-fill"></i> Asistentes
        </button>
      </div>
      ${currentUser.admin ? `<button class="btn btn-outline-danger btn-sm w-100 mt-3" data-delete="${event.id}"><i class="bi bi-trash"></i> Eliminar permanentemente</button>` : ""}
    </div>
  </article>`;
}

function statsMarkup(totals) {
  return `<div class="stats">
    <div class="stat-box"><strong>${totals.users}</strong><span class="small text-success">Asistentes</span></div>
    <div class="stat-box"><strong>${totals.guests}</strong><span class="small text-primary">Invitados</span></div>
  </div>`;
}

function attendancePanel(eventId, isAttending, guests) {
  return `<div class="attendance-panel">
    <div class="attendance-toggle-row">
      <div>
        <div class="fw-bold">¿Vas a asistir?</div>
        <div class="small text-secondary">${isAttending ? "Has confirmado asistencia" : "Ahora mismo estás en No"}</div>
      </div>
      <div class="form-check form-switch attendance-switch m-0">
        <input class="form-check-input" type="checkbox" role="switch" ${isAttending ? "checked" : ""} data-event-id="${eventId}" data-attendance-toggle="true" aria-label="Confirmar asistencia">
      </div>
    </div>
    <div class="guest-tools ${isAttending ? "" : "d-none"}">
      <input class="form-control form-control-sm" id="guestInput_${eventId}" type="text" placeholder="Nombre de invitado/a" maxlength="60" />
      <button class="btn btn-outline-primary btn-sm" data-add-guest="${eventId}" type="button"><i class="bi bi-person-plus"></i> Añadir</button>
    </div>
    <div class="guest-chips ${isAttending && guests.length ? "" : "d-none"}">
      ${guests.map((guest, index) => `<span class="guest-chip">${escapeHtml(guest)} <button type="button" data-event-id="${eventId}" data-remove-guest="${index}" aria-label="Quitar invitado"><i class="bi bi-x-circle-fill"></i></button></span>`).join("")}
    </div>
  </div>`;
}

function showAttendees(eventId) {
  const event = events.find(e => e.id === eventId);
  if (!event) return toast("No se ha encontrado el evento", "danger");

  const people = getAttendingRecords(eventId);
  const guests = getGuestRecords(eventId);
  const total = people.length + guests.length;

  els.attendeesModalTitle.textContent = "Asistentes";
  els.attendeesModalSubtitle.textContent = `${event.name} · ${formatDateTime(event)} · ${total} persona${total === 1 ? "" : "s"}`;
  els.attendeesModalBody.innerHTML = `
    ${attendeeGroupMarkup("Asistentes", "text-success", "bi-check-circle-fill", people, false)}
    ${attendeeGroupMarkup("Invitados", "text-primary", "bi-person-heart", guests, true)}
  `;

  bootstrap.Modal.getOrCreateInstance($("attendeesModal")).show();
}

function attendeeGroupMarkup(title, colorClass, icon, people, showInvitedBy) {
  const list = people.length
    ? `<ul class="attendee-list">${people.map(person => attendeeMarkup(person, showInvitedBy)).join("")}</ul>`
    : `<div class="attendee-empty">Sin personas en esta categoría.</div>`;

  return `<section class="attendee-group">
    <div class="attendee-group-header">
      <span class="${colorClass}"><i class="bi ${icon} me-1"></i>${title}</span>
      <span class="attendee-count-badge">${people.length}</span>
    </div>
    ${list}
  </section>`;
}

function attendeeMarkup(person, showInvitedBy) {
  const name = person.name || "Usuario";
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const badge = showInvitedBy ? `<span class="invited-by-badge">Invita: ${escapeHtml(person.invitedBy)}</span>` : "";
  return `<li>
    <span class="attendee-avatar-sm">${escapeHtml(initial)}</span>
    <span class="fw-semibold">${escapeHtml(name)}</span>
    ${badge}
  </li>`;
}

function getAttendingRecords(eventId) {
  return [...attendance.values()]
    .filter(item => item.eventId === eventId && item.attending === true)
    .map(item => ({ name: item.displayName || item.username || "Usuario" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getGuestRecords(eventId) {
  return [...attendance.values()]
    .filter(item => item.eventId === eventId && item.attending === true)
    .flatMap(item => (item.guests || []).map(guest => ({ name: guest, invitedBy: item.displayName || item.username || "Usuario" })))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getEventTotals(eventId) {
  const people = getAttendingRecords(eventId);
  const guests = getGuestRecords(eventId);
  return { users: people.length, guests: guests.length, total: people.length + guests.length };
}

async function setAttendance(eventId, attending) {
  const username = currentUser.username;
  const attendanceId = `${eventId}_${username}`;
  const eventRef = doc(db, "events", eventId);
  const attendanceRef = doc(db, "attendance", attendanceId);

  await runTransaction(db, async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (!eventSnap.exists()) throw new Error("Evento no encontrado");
    const attendanceSnap = await tx.get(attendanceRef);
    const previous = attendanceSnap.exists() ? normalizeAttendance(attendanceSnap.data()) : null;
    const oldAttending = previous?.attending === true;
    const oldGuestCount = oldAttending ? (previous.guests?.length || 0) : 0;
    const currentConfirmed = eventSnap.data().confirmed ?? 0;
    const currentGuestCount = eventSnap.data().guestCount ?? 0;

    if (attending) {
      const guests = previous?.guests || [];
      tx.set(attendanceRef, {
        eventId,
        username,
        displayName: currentUser.displayName,
        attending: true,
        status: "yes",
        guests,
        updatedAt: serverTimestamp()
      });
      tx.update(eventRef, {
        confirmed: oldAttending ? currentConfirmed : currentConfirmed + 1,
        guestCount: currentGuestCount,
        denied: 0,
        unsure: 0
      });
    } else {
      if (attendanceSnap.exists()) tx.delete(attendanceRef);
      tx.update(eventRef, {
        confirmed: oldAttending ? Math.max(0, currentConfirmed - 1) : currentConfirmed,
        guestCount: Math.max(0, currentGuestCount - oldGuestCount),
        denied: 0,
        unsure: 0
      });
    }
  });

  toast(attending ? "Asistencia confirmada" : "Asistencia cancelada", "success");
}

async function addGuest(eventId) {
  const input = $(`guestInput_${eventId}`);
  const guestName = input?.value.trim();
  if (!guestName) return toast("Escribe el nombre del invitado", "danger");

  const attendanceId = `${eventId}_${currentUser.username}`;
  const eventRef = doc(db, "events", eventId);
  const attendanceRef = doc(db, "attendance", attendanceId);

  await runTransaction(db, async (tx) => {
    const eventSnap = await tx.get(eventRef);
    const attendanceSnap = await tx.get(attendanceRef);
    if (!eventSnap.exists()) throw new Error("Evento no encontrado");
    if (!attendanceSnap.exists()) throw new Error("Primero confirma asistencia");

    const data = normalizeAttendance(attendanceSnap.data());
    const guests = [...(data.guests || []), guestName];
    tx.update(attendanceRef, { guests, attending: true, status: "yes", updatedAt: serverTimestamp() });
    tx.update(eventRef, { guestCount: (eventSnap.data().guestCount ?? 0) + 1 });
  });

  input.value = "";
  toast("Invitado añadido", "success");
}

async function removeGuest(eventId, index) {
  const attendanceId = `${eventId}_${currentUser.username}`;
  const eventRef = doc(db, "events", eventId);
  const attendanceRef = doc(db, "attendance", attendanceId);

  await runTransaction(db, async (tx) => {
    const eventSnap = await tx.get(eventRef);
    const attendanceSnap = await tx.get(attendanceRef);
    if (!eventSnap.exists() || !attendanceSnap.exists()) return;

    const data = normalizeAttendance(attendanceSnap.data());
    const guests = [...(data.guests || [])];
    if (index < 0 || index >= guests.length) return;
    guests.splice(index, 1);
    tx.update(attendanceRef, { guests, updatedAt: serverTimestamp() });
    tx.update(eventRef, { guestCount: Math.max(0, (eventSnap.data().guestCount ?? 0) - 1) });
  });

  toast("Invitado eliminado", "success");
}

function prepareNewEvent() {
  els.eventModalTitle.textContent = "Crear evento";
  els.eventForm.reset();
  els.eventId.value = "";
  els.eventType.value = "Evento";
  els.eventDate.value = todayIso();
  els.eventTime.value = "20:00";
}

function prepareEditEvent(eventId) {
  const event = events.find(e => e.id === eventId);
  if (!event) return;
  els.eventModalTitle.textContent = "Editar evento";
  els.eventId.value = event.id;
  els.eventName.value = event.name ?? "";
  els.eventDescription.value = event.description ?? "";
  els.eventType.value = EVENT_TYPES.includes(event.type) ? event.type : "Evento";
  els.eventDate.value = event.date ?? todayIso();
  els.eventTime.value = event.time ?? "20:00";
  bootstrap.Modal.getOrCreateInstance($("eventModal")).show();
}

async function saveEvent(event) {
  event.preventDefault();
  if (!currentUser?.admin) return toast("Solo los administradores pueden modificar eventos", "danger");

  const payload = {
    name: els.eventName.value.trim(),
    description: els.eventDescription.value.trim(),
    type: els.eventType.value,
    date: els.eventDate.value,
    time: els.eventTime.value,
    active: true,
    updatedAt: serverTimestamp()
  };

  if (!payload.name || !payload.description || !payload.type || !payload.date || !payload.time) {
    return toast("Rellena todos los campos del evento", "danger");
  }

  if (els.eventId.value) {
    await updateDoc(doc(db, "events", els.eventId.value), payload);
    toast("Evento actualizado", "success");
  } else {
    await addDoc(collection(db, "events"), {
      ...payload,
      confirmed: 0,
      guestCount: 0,
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

function getEventTimestamp(event) {
  const date = event.date || "9999-12-31";
  const time = event.time || "00:00";
  return new Date(`${date}T${time}`).getTime();
}

function formatDateTime(event) {
  if (!event.date) return "Sin fecha";
  const [y, m, d] = event.date.split("-").map(Number);
  const [hour, minute] = (event.time || "00:00").split(":").map(Number);
  const date = new Date(y, m - 1, d, hour || 0, minute || 0);
  return new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
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
