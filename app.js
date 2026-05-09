"use strict";

const STORAGE_KEYS = {
  data: "thaitrip:data",
  gistToken: "thaitrip:gist:token",
  gistId: "thaitrip:gist:id",
  autoBackup: "thaitrip:gist:auto",
};

const GIST_FILENAME = "thaitrip-data.json";

const HOME_PROVINCE = "Bangkok Metropolis";
const TRAVELABLE_TOTAL = 76;

const state = {
  data: loadData(),
  provinces: [],
  thaiNames: {},
  selectedProvince: null,
  filter: "all",
  search: "",
  pathByName: new Map(),
  featureByName: new Map(),
  geojson: null,
  projection: null,
  mapInnerNode: null,
  autoBackupTimer: null,
  pinDropMode: false,
  pendingPin: null,
};

document.addEventListener("DOMContentLoaded", () => {
  bindUi();
  Promise.all([
    fetch("data/thailand-provinces.geojson").then((r) => r.json()),
    fetch("data/province-names-th.json").then((r) => r.json()),
  ])
    .then(([geo, namesTh]) => {
      state.geojson = geo;
      state.provinces = geo.features
        .map((f) => f.properties.name)
        .sort((a, b) => a.localeCompare(b));
      state.thaiNames = namesTh;
      geo.features.forEach((f) =>
        state.featureByName.set(f.properties.name, f),
      );
      renderMap(geo);
      renderAll();
      window.addEventListener("resize", () => debounceResize());
      // Pre-fill settings inputs
      document.getElementById("gist-token").value =
        localStorage.getItem(STORAGE_KEYS.gistToken) || "";
      document.getElementById("gist-id").value =
        localStorage.getItem(STORAGE_KEYS.gistId) || "";
      document.getElementById("auto-backup").checked =
        localStorage.getItem(STORAGE_KEYS.autoBackup) === "1";
    })
    .catch((err) => {
      console.error(err);
      document.getElementById("map-container").innerHTML =
        '<div class="p-8 text-sm text-rose-600">Failed to load Thailand map data: ' +
        escapeHtml(err.message) +
        "</div>";
    });
});

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.data);
    if (!raw) return { version: 1, trips: {} };
    const parsed = JSON.parse(raw);
    if (!parsed.trips) parsed.trips = {};
    return parsed;
  } catch {
    return { version: 1, trips: {} };
  }
}

function saveData(opts = {}) {
  state.data.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEYS.data, JSON.stringify(state.data));
  if (
    !opts.skipAutoBackup &&
    localStorage.getItem(STORAGE_KEYS.autoBackup) === "1" &&
    localStorage.getItem(STORAGE_KEYS.gistToken)
  ) {
    scheduleAutoBackup();
  }
}

function tripsForProvince(name) {
  return state.data.trips[name] || [];
}

function totalTrips() {
  return Object.entries(state.data.trips)
    .filter(([name]) => name !== HOME_PROVINCE)
    .reduce((s, [, list]) => s + list.length, 0);
}

function visitedCount() {
  return Object.entries(state.data.trips).filter(
    ([name, list]) => name !== HOME_PROVINCE && list.length > 0,
  ).length;
}

// ----- Map rendering -----

function renderMap(geojson) {
  const container = document.getElementById("map-container");
  const tooltip = document.getElementById("map-tooltip");
  container.innerHTML = "";
  state.pathByName.clear();

  const width = container.clientWidth;
  const height = container.clientHeight;

  const svg = d3
    .select(container)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  const projection = d3
    .geoMercator()
    .fitSize([width - 20, height - 20], geojson);
  const path = d3.geoPath(projection);
  state.projection = projection;

  const inner = svg
    .append("g")
    .attr("class", "map-inner")
    .attr("transform", `translate(10, 10)`);
  state.mapInnerNode = inner.node();

  inner
    .selectAll("path")
    .data(geojson.features)
    .enter()
    .append("path")
    .attr("class", "province-path")
    .attr("d", path)
    .attr("data-name", (d) => d.properties.name)
    .attr("data-home", (d) => (d.properties.name === HOME_PROVINCE ? "1" : null))
    .on("mousemove", (event, d) => {
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left + 12;
      const y = event.clientY - rect.top + 12;
      const name = d.properties.name;
      const th = state.thaiNames[name] || "";
      const count = tripsForProvince(name).length;
      const isHome = name === HOME_PROVINCE;
      tooltip.innerHTML = `<div class="font-medium">${escapeHtml(name)}</div>${
        th ? `<div class="text-slate-300">${escapeHtml(th)}</div>` : ""
      }<div class="text-slate-300">${
        isHome ? "🏠 Home" : count + " trip" + (count === 1 ? "" : "s")
      }</div>`;
      tooltip.style.transform = `translate(${x}px, ${y}px)`;
      tooltip.classList.remove("hidden");
    })
    .on("mouseleave", () => {
      tooltip.classList.add("hidden");
    })
    .on("click", (event, d) => handleProvinceClick(event, d))
    .each(function (d) {
      state.pathByName.set(d.properties.name, this);
    });

  inner.append("g").attr("class", "pins-layer");

  updateMapColors();
  renderPins();
}

let resizeTimer = null;
function debounceResize() {
  if (!state.geojson) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderMap(state.geojson);
  }, 200);
}

function handleProvinceClick(event, d) {
  const name = d.properties.name;
  if (state.pinDropMode) {
    if (name === HOME_PROVINCE) return;
    if (name !== state.selectedProvince) {
      flashBanner(`Pin must be inside ${state.selectedProvince}.`);
      return;
    }
    const [x, y] = d3.pointer(event, state.mapInnerNode);
    const lngLat = state.projection.invert([x, y]);
    if (!lngLat) return;
    const feat = state.featureByName.get(state.selectedProvince);
    if (feat && !d3.geoContains(feat, lngLat)) {
      flashBanner(`That spot isn't inside ${state.selectedProvince}.`);
      return;
    }
    state.pendingPin = { lat: lngLat[1], lng: lngLat[0] };
    finishPinDrop();
    return;
  }
  if (name === HOME_PROVINCE) return;
  openProvinceModal(name);
}

function renderPins() {
  if (!state.projection || !state.mapInnerNode) return;
  const layer = d3.select(state.mapInnerNode).select("g.pins-layer");
  if (layer.empty()) return;
  const tooltip = document.getElementById("map-tooltip");
  const container = document.getElementById("map-container");

  const pins = [];
  for (const [province, trips] of Object.entries(state.data.trips)) {
    for (const t of trips) {
      if (!t.pin || t.pin.lat == null || t.pin.lng == null) continue;
      const xy = state.projection([t.pin.lng, t.pin.lat]);
      if (!xy) continue;
      pins.push({ trip: t, province, x: xy[0], y: xy[1] });
    }
  }

  const sel = layer.selectAll("circle.trip-pin").data(pins, (d) => d.trip.id);
  sel.exit().remove();
  const enter = sel
    .enter()
    .append("circle")
    .attr("class", "trip-pin")
    .attr("r", 4)
    .attr("fill", "#047857")
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 1.5);
  enter
    .merge(sel)
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .on("click", (event, d) => {
      event.stopPropagation();
      if (state.pinDropMode) return;
      openProvinceModal(d.province);
    })
    .on("mousemove", (event, d) => {
      const rect = container.getBoundingClientRect();
      tooltip.innerHTML =
        `<div class="font-medium">📍 ${escapeHtml(
          d.trip.title || "Untitled trip",
        )}</div>` +
        `<div class="text-slate-300">${escapeHtml(d.province)}</div>` +
        `<div class="text-slate-300">${formatDateRange(
          d.trip.startDate,
          d.trip.endDate,
        )}</div>`;
      tooltip.style.transform = `translate(${
        event.clientX - rect.left + 12
      }px, ${event.clientY - rect.top + 12}px)`;
      tooltip.classList.remove("hidden");
    })
    .on("mouseleave", () => {
      tooltip.classList.add("hidden");
    });
}

function updateMapColors() {
  state.pathByName.forEach((node, name) => {
    if (name === HOME_PROVINCE) {
      node.removeAttribute("data-trips");
      node.classList.remove("is-selected");
      return;
    }
    const count = Math.min(5, tripsForProvince(name).length);
    if (count > 0) node.setAttribute("data-trips", String(count));
    else node.removeAttribute("data-trips");
    node.classList.toggle("is-selected", name === state.selectedProvince);
  });
}

// ----- Sidebar rendering -----

function renderAll() {
  renderStats();
  renderProvinceList();
  renderRecentTrips();
  updateMapColors();
  renderPins();
}

function renderStats() {
  const visited = visitedCount();
  const trips = totalTrips();
  const pct = Math.round((visited / TRAVELABLE_TOTAL) * 100);
  document.getElementById("progress-count").textContent =
    `${visited} / ${TRAVELABLE_TOTAL}`;
  document.getElementById("progress-bar").style.width = `${pct}%`;
  document.getElementById("stat-provinces").textContent = String(visited);
  document.getElementById("stat-trips").textContent = String(trips);
  document.getElementById("stat-pct").textContent = `${pct}%`;
}

function renderProvinceList() {
  const list = document.getElementById("province-list");
  const search = state.search.trim().toLowerCase();
  const filtered = state.provinces.filter((name) => {
    if (name === HOME_PROVINCE) return false;
    const visited = tripsForProvince(name).length > 0;
    if (state.filter === "visited" && !visited) return false;
    if (state.filter === "unvisited" && visited) return false;
    if (!search) return true;
    const th = state.thaiNames[name] || "";
    return (
      name.toLowerCase().includes(search) || th.toLowerCase().includes(search)
    );
  });

  if (filtered.length === 0) {
    list.innerHTML =
      '<li class="py-3 text-xs italic text-slate-400">No matches.</li>';
    return;
  }

  list.innerHTML = filtered
    .map((name) => {
      const count = tripsForProvince(name).length;
      const th = state.thaiNames[name] || "";
      const dot =
        count > 0
          ? '<span class="inline-block h-2 w-2 rounded-full bg-emerald-500"></span>'
          : '<span class="inline-block h-2 w-2 rounded-full bg-slate-300"></span>';
      return `<li>
        <button data-province="${escapeHtml(name)}" class="province-row flex w-full items-center justify-between gap-2 py-2 text-left hover:bg-slate-50 px-1 rounded">
          <span class="flex items-center gap-2">${dot}<span><span class="font-medium">${escapeHtml(name)}</span>${
            th ? `<span class="ml-1 text-xs text-slate-400">${escapeHtml(th)}</span>` : ""
          }</span></span>
          <span class="text-xs text-slate-500">${count > 0 ? count + " trip" + (count === 1 ? "" : "s") : ""}</span>
        </button>
      </li>`;
    })
    .join("");

  list.querySelectorAll("button.province-row").forEach((btn) => {
    btn.addEventListener("click", () =>
      openProvinceModal(btn.dataset.province),
    );
  });
}

function renderRecentTrips() {
  const ul = document.getElementById("recent-trips");
  const all = [];
  for (const [province, trips] of Object.entries(state.data.trips)) {
    if (province === HOME_PROVINCE) continue;
    for (const t of trips) all.push({ ...t, province });
  }
  all.sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  const top = all.slice(0, 5);
  if (top.length === 0) {
    ul.innerHTML =
      '<li class="text-xs italic text-slate-400">No trips yet — click a province to add one.</li>';
    return;
  }
  ul.innerHTML = top
    .map(
      (t) => `<li class="rounded-md border border-slate-100 px-2 py-2">
        <button class="recent-trip block w-full text-left" data-province="${escapeHtml(t.province)}">
          <div class="flex items-center justify-between">
            <span class="font-medium">${escapeHtml(t.title || t.province)}</span>
            <span class="text-[11px] text-slate-500">${formatDateRange(t.startDate, t.endDate)}</span>
          </div>
          <div class="text-xs text-slate-500">${escapeHtml(t.province)}</div>
        </button>
      </li>`,
    )
    .join("");
  ul.querySelectorAll("button.recent-trip").forEach((b) =>
    b.addEventListener("click", () => openProvinceModal(b.dataset.province)),
  );
}

// ----- Province modal -----

function openProvinceModal(name) {
  if (name === HOME_PROVINCE) return;
  state.selectedProvince = name;
  updateMapColors();
  const modal = document.getElementById("province-modal");
  document.getElementById("province-modal-title").textContent = name;
  const th = state.thaiNames[name] || "";
  document.getElementById("province-modal-subtitle").textContent = th;
  resetTripForm();
  renderProvinceTrips();
  modal.classList.add("modal-open");
}

function closeProvinceModal() {
  document.getElementById("province-modal").classList.remove("modal-open");
  state.selectedProvince = null;
  updateMapColors();
}

function renderProvinceTrips() {
  const ul = document.getElementById("province-trip-list");
  const trips = tripsForProvince(state.selectedProvince).slice().sort((a, b) =>
    (b.startDate || "").localeCompare(a.startDate || ""),
  );
  if (trips.length === 0) {
    ul.innerHTML =
      '<li class="text-xs italic text-slate-400">No trips yet for this province.</li>';
    return;
  }
  ul.innerHTML = trips
    .map(
      (t) => `<li class="rounded-md border border-slate-200 p-2">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="font-medium">${escapeHtml(t.title || "Untitled trip")}</div>
          <div class="text-xs text-slate-500">${formatDateRange(t.startDate, t.endDate)}</div>
          ${
            t.googlePhotosUrl
              ? `<a class="text-xs text-emerald-700 underline break-all" target="_blank" rel="noopener" href="${escapeHtml(t.googlePhotosUrl)}">📷 Google Photos</a>`
              : ""
          }
          ${
            t.pin
              ? `<div class="mt-1 text-[11px] text-slate-500">📍 ${t.pin.lat.toFixed(4)}, ${t.pin.lng.toFixed(4)}</div>`
              : ""
          }
          ${t.notes ? `<div class="mt-1 whitespace-pre-wrap text-xs text-slate-600">${escapeHtml(t.notes)}</div>` : ""}
        </div>
        <div class="flex shrink-0 gap-1">
          <button data-edit="${escapeHtml(t.id)}" class="rounded p-1 text-xs text-slate-500 hover:bg-slate-100" type="button">Edit</button>
          <button data-delete="${escapeHtml(t.id)}" class="rounded p-1 text-xs text-rose-600 hover:bg-rose-50" type="button">Delete</button>
        </div>
      </div>
    </li>`,
    )
    .join("");

  ul.querySelectorAll("button[data-edit]").forEach((b) =>
    b.addEventListener("click", () => beginEditTrip(b.dataset.edit)),
  );
  ul.querySelectorAll("button[data-delete]").forEach((b) =>
    b.addEventListener("click", () => deleteTrip(b.dataset.delete)),
  );
}

function resetTripForm() {
  const form = document.getElementById("trip-form");
  form.reset();
  form.querySelector("input[name=tripId]").value = "";
  document.getElementById("trip-form-title").textContent = "Add a trip";
  document.getElementById("trip-form-cancel").classList.add("hidden");
  state.pendingPin = null;
  updatePinDisplay();
}

function beginEditTrip(id) {
  const trips = tripsForProvince(state.selectedProvince);
  const trip = trips.find((t) => t.id === id);
  if (!trip) return;
  const form = document.getElementById("trip-form");
  form.querySelector("input[name=tripId]").value = trip.id;
  form.querySelector("input[name=title]").value = trip.title || "";
  form.querySelector("input[name=startDate]").value = trip.startDate || "";
  form.querySelector("input[name=endDate]").value = trip.endDate || "";
  form.querySelector("input[name=googlePhotosUrl]").value =
    trip.googlePhotosUrl || "";
  form.querySelector("textarea[name=notes]").value = trip.notes || "";
  state.pendingPin = trip.pin ? { ...trip.pin } : null;
  updatePinDisplay();
  document.getElementById("trip-form-title").textContent = "Edit trip";
  document.getElementById("trip-form-cancel").classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth", block: "end" });
}

function updatePinDisplay() {
  const coordsEl = document.getElementById("pin-coords");
  const dropBtn = document.getElementById("btn-drop-pin");
  const clearBtn = document.getElementById("btn-clear-pin");
  if (state.pendingPin) {
    coordsEl.classList.remove("italic", "text-slate-400");
    coordsEl.classList.add("font-medium", "text-slate-700");
    coordsEl.textContent = `📍 ${state.pendingPin.lat.toFixed(4)}, ${state.pendingPin.lng.toFixed(4)}`;
    dropBtn.textContent = "📍 Move pin";
    clearBtn.classList.remove("hidden");
  } else {
    coordsEl.classList.add("italic", "text-slate-400");
    coordsEl.classList.remove("font-medium", "text-slate-700");
    coordsEl.textContent = "No pin dropped";
    dropBtn.textContent = "📍 Drop pin on map";
    clearBtn.classList.add("hidden");
  }
}

function showPinBanner(show) {
  const banner = document.getElementById("pin-drop-banner");
  banner.style.display = show ? "flex" : "none";
}

function startPinDrop() {
  if (!state.selectedProvince) return;
  state.pinDropMode = true;
  document.getElementById("province-modal").classList.remove("modal-open");
  document.getElementById("map-container").classList.add("pin-drop-mode");
  document.getElementById("pin-drop-province").textContent =
    state.selectedProvince;
  showPinBanner(true);
}

function cancelPinDrop() {
  if (!state.pinDropMode) return;
  state.pinDropMode = false;
  document.getElementById("map-container").classList.remove("pin-drop-mode");
  showPinBanner(false);
  document.getElementById("province-modal").classList.add("modal-open");
}

function finishPinDrop() {
  state.pinDropMode = false;
  document.getElementById("map-container").classList.remove("pin-drop-mode");
  showPinBanner(false);
  document.getElementById("province-modal").classList.add("modal-open");
  updatePinDisplay();
}

function flashBanner(text) {
  const banner = document.getElementById("pin-drop-banner");
  const original = banner.firstElementChild.innerHTML;
  banner.firstElementChild.textContent = text;
  setTimeout(() => {
    if (state.pinDropMode) banner.firstElementChild.innerHTML = original;
  }, 1500);
}

function deleteTrip(id) {
  if (!confirm("Delete this trip? This cannot be undone.")) return;
  const list = state.data.trips[state.selectedProvince] || [];
  state.data.trips[state.selectedProvince] = list.filter((t) => t.id !== id);
  if (state.data.trips[state.selectedProvince].length === 0)
    delete state.data.trips[state.selectedProvince];
  saveData();
  renderProvinceTrips();
  renderAll();
}

function submitTripForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fd = new FormData(form);
  const id = fd.get("tripId") || genId();
  const trip = {
    id,
    title: (fd.get("title") || "").toString().trim(),
    startDate: (fd.get("startDate") || "").toString(),
    endDate: (fd.get("endDate") || "").toString(),
    googlePhotosUrl: (fd.get("googlePhotosUrl") || "").toString().trim(),
    notes: (fd.get("notes") || "").toString().trim(),
  };
  if (!trip.startDate) {
    alert("Please pick a start date.");
    return;
  }
  if (trip.endDate && trip.endDate < trip.startDate) {
    alert("End date can't be before start date.");
    return;
  }
  if (
    trip.googlePhotosUrl &&
    !/^https?:\/\//i.test(trip.googlePhotosUrl)
  ) {
    alert("Google Photos link should start with http(s)://");
    return;
  }
  if (state.pendingPin) {
    trip.pin = {
      lat: state.pendingPin.lat,
      lng: state.pendingPin.lng,
    };
  } else {
    trip.pin = null;
  }
  const province = state.selectedProvince;
  const list = state.data.trips[province] || [];
  const existing = list.findIndex((t) => t.id === id);
  if (existing >= 0) list[existing] = { ...list[existing], ...trip };
  else list.push({ ...trip, createdAt: new Date().toISOString() });
  state.data.trips[province] = list;
  saveData();
  resetTripForm();
  renderProvinceTrips();
  renderAll();
}

// ----- Settings modal & sync -----

function openSettings() {
  document.getElementById("settings-modal").classList.add("modal-open");
}

function closeSettings() {
  document.getElementById("settings-modal").classList.remove("modal-open");
}

function setSyncMessage(text, kind = "info") {
  const el = document.getElementById("sync-message");
  el.textContent = text;
  el.className =
    "mt-2 min-h-[1rem] text-xs " +
    (kind === "error"
      ? "text-rose-600"
      : kind === "success"
        ? "text-emerald-600"
        : "text-slate-500");
}

function setSyncStatus(text) {
  const el = document.getElementById("sync-status");
  if (!text) {
    el.classList.add("hidden");
    return;
  }
  el.textContent = text;
  el.classList.remove("hidden");
}

function saveTokenSettings() {
  const token = document.getElementById("gist-token").value.trim();
  const gistId = document.getElementById("gist-id").value.trim();
  const auto = document.getElementById("auto-backup").checked;
  if (token) localStorage.setItem(STORAGE_KEYS.gistToken, token);
  else localStorage.removeItem(STORAGE_KEYS.gistToken);
  if (gistId) localStorage.setItem(STORAGE_KEYS.gistId, gistId);
  else localStorage.removeItem(STORAGE_KEYS.gistId);
  localStorage.setItem(STORAGE_KEYS.autoBackup, auto ? "1" : "0");
  setSyncMessage("Saved.", "success");
}

async function gistRequest(path, init = {}) {
  const token = localStorage.getItem(STORAGE_KEYS.gistToken);
  if (!token) throw new Error("No GitHub token saved.");
  const res = await fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try {
      const body = await res.json();
      if (body.message) msg += " — " + body.message;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

async function backupToGist() {
  setSyncStatus("backing up…");
  setSyncMessage("Backing up…");
  try {
    saveTokenSettings();
    const content = JSON.stringify(state.data, null, 2);
    const gistId = localStorage.getItem(STORAGE_KEYS.gistId);
    let result;
    if (gistId) {
      result = await gistRequest("/gists/" + gistId, {
        method: "PATCH",
        body: JSON.stringify({
          files: { [GIST_FILENAME]: { content } },
        }),
      });
    } else {
      result = await gistRequest("/gists", {
        method: "POST",
        body: JSON.stringify({
          description: "ThaiTrip — Thailand travel journal data",
          public: false,
          files: { [GIST_FILENAME]: { content } },
        }),
      });
      localStorage.setItem(STORAGE_KEYS.gistId, result.id);
      document.getElementById("gist-id").value = result.id;
    }
    setSyncMessage(
      "Backed up at " + new Date().toLocaleTimeString() + " ✓",
      "success",
    );
    setSyncStatus("synced");
  } catch (err) {
    setSyncMessage("Backup failed: " + err.message, "error");
    setSyncStatus("error");
  }
}

async function restoreFromGist() {
  const gistId = document.getElementById("gist-id").value.trim();
  if (!gistId) {
    setSyncMessage("Enter a Gist ID first.", "error");
    return;
  }
  if (
    !confirm(
      "Restore will replace all current trips with the Gist contents. Continue?",
    )
  )
    return;
  setSyncStatus("restoring…");
  setSyncMessage("Restoring…");
  try {
    saveTokenSettings();
    const gist = await gistRequest("/gists/" + gistId);
    const file = gist.files && gist.files[GIST_FILENAME];
    if (!file) throw new Error("Gist has no " + GIST_FILENAME + " file.");
    let content = file.content;
    if (file.truncated && file.raw_url) {
      const r = await fetch(file.raw_url);
      content = await r.text();
    }
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || !parsed.trips)
      throw new Error("Unexpected file format.");
    state.data = { version: parsed.version || 1, trips: parsed.trips };
    saveData({ skipAutoBackup: true });
    renderAll();
    setSyncMessage("Restored ✓", "success");
    setSyncStatus("synced");
  } catch (err) {
    setSyncMessage("Restore failed: " + err.message, "error");
    setSyncStatus("error");
  }
}

function scheduleAutoBackup() {
  if (state.autoBackupTimer) clearTimeout(state.autoBackupTimer);
  setSyncStatus("pending…");
  state.autoBackupTimer = setTimeout(() => {
    state.autoBackupTimer = null;
    backupToGist();
  }, 4000);
}

// ----- Export / import / clear -----

function exportJson() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    "thaitrip-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.trips || typeof parsed.trips !== "object")
        throw new Error("Not a ThaiTrip file.");
      if (
        !confirm(
          "Replace all current trips with the contents of this file?",
        )
      )
        return;
      state.data = { version: parsed.version || 1, trips: parsed.trips };
      saveData({ skipAutoBackup: true });
      renderAll();
      setSyncMessage("Imported ✓", "success");
    } catch (err) {
      setSyncMessage("Import failed: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

function clearAll() {
  if (
    !confirm(
      "Permanently erase all locally stored trips? Your Gist (if any) is not deleted.",
    )
  )
    return;
  state.data = { version: 1, trips: {} };
  saveData({ skipAutoBackup: true });
  renderAll();
  setSyncMessage("Local data cleared.", "success");
}

// ----- Helpers -----

function genId() {
  return (
    "trip_" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateRange(start, end) {
  if (!start) return "";
  const s = formatDate(start);
  if (!end || end === start) return s;
  return s + " → " + formatDate(end);
}

function formatDate(d) {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ----- Wire up DOM events -----

function bindUi() {
  document
    .getElementById("open-settings")
    .addEventListener("click", openSettings);

  document.querySelectorAll("[data-close-modal]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.closeModal;
      if (id === "province-modal") closeProvinceModal();
      else document.getElementById(id).classList.remove("modal-open");
    });
  });

  ["province-modal", "settings-modal"].forEach((id) => {
    document.getElementById(id).addEventListener("click", (e) => {
      if (e.target.id === id) {
        if (id === "province-modal") closeProvinceModal();
        else closeSettings();
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.pinDropMode) {
        cancelPinDrop();
        return;
      }
      closeProvinceModal();
      closeSettings();
    }
  });

  document.getElementById("btn-drop-pin").addEventListener("click", startPinDrop);
  document
    .getElementById("btn-clear-pin")
    .addEventListener("click", () => {
      state.pendingPin = null;
      updatePinDisplay();
    });
  document
    .getElementById("pin-drop-cancel")
    .addEventListener("click", cancelPinDrop);

  document
    .getElementById("trip-form")
    .addEventListener("submit", submitTripForm);
  document
    .getElementById("trip-form-cancel")
    .addEventListener("click", resetTripForm);

  document
    .getElementById("province-search")
    .addEventListener("input", (e) => {
      state.search = e.target.value;
      renderProvinceList();
    });

  document.querySelectorAll(".filter-btn").forEach((b) => {
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      document.querySelectorAll(".filter-btn").forEach((x) => {
        x.classList.remove("bg-rose-500", "text-white");
        x.classList.add("border", "border-slate-300", "text-slate-600");
      });
      b.classList.add("bg-rose-500", "text-white");
      b.classList.remove("border", "border-slate-300", "text-slate-600");
      renderProvinceList();
    });
  });

  document
    .getElementById("btn-save-token")
    .addEventListener("click", saveTokenSettings);
  document.getElementById("btn-backup").addEventListener("click", backupToGist);
  document
    .getElementById("btn-restore")
    .addEventListener("click", restoreFromGist);
  document.getElementById("btn-export").addEventListener("click", exportJson);
  document.getElementById("file-import").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importJson(f);
    e.target.value = "";
  });
  document.getElementById("btn-clear").addEventListener("click", clearAll);
}
