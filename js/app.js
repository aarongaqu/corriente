// =========================================================
// CORRIENTE — lógica del mapa
// =========================================================
// Dividido a propósito en capas: sesión, datos, log, ubicación,
// geocodificación. El resto (mapa, formularios, panel lateral)
// solo llama a las funciones de esas capas — no debería
// necesitar cambios cuando se ajuste algo del lado de Clerk o
// Supabase.
//
// DEV_MODE = false usa Clerk + Supabase reales.
// DEV_MODE = true regresa al modo de prueba con localStorage,
// como red de seguridad si algo de la conexión real falla.
// =========================================================

// ---------- Config general ----------
const CITY_CENTER = [20.9674, -89.5926]; // Mérida — cambia esto por tu ciudad
const CITY_ZOOM = 14;
const MAX_ACTIVE_PER_USER = 2;
const EXPIRATION_HOURS = 4;
const REPORT_COOLDOWN_SECONDS = 15; // tiempo mínimo entre reportes, para el mismo usuario
const WELCOME_SEEN_KEY = 'corriente_welcome_seen'; // misma llave que usa welcome.html

// Caja delimitadora aproximada del estado de Yucatán (rectángulo, no el
// contorno exacto del estado — Leaflet solo soporta límites rectangulares).
const YUCATAN_BOUNDS = L.latLngBounds(
  L.latLng(19.4, -90.6),
  L.latLng(21.7, -87.4)
);

// =========================================================
// CAPA DE SESIÓN — lee de Clerk real; DEV_MODE es un respaldo
// reversible por si necesitas seguir probando sin conexión real.
// =========================================================
const DEV_MODE = false; // pon esto en `true` para volver al modo de prueba
const MOCK_USER = { id: 'dev-user-1', email: 'prueba@gmail.com', initials: 'PR', isModerator: false };
const MOCK_MODERATOR = { id: 'dev-mod-1', email: 'admin@gmail.com', initials: 'AD', isModerator: true };
let activeIdentity = MOCK_USER; // solo se usa si DEV_MODE = true

function isLoggedIn() {
  if (DEV_MODE) return true;
  return !!(window.Clerk && window.Clerk.user);
}
function currentUser() {
  if (DEV_MODE) return activeIdentity;
  if (!window.Clerk || !window.Clerk.user) return null;
  const u = window.Clerk.user;
  const email = u.primaryEmailAddress ? u.primaryEmailAddress.emailAddress : '';
  return {
    id: u.id,
    email: email,
    initials: email.slice(0, 2).toUpperCase(),
    isModerator: !!(u.publicMetadata && u.publicMetadata.isModerator === true)
  };
}
function isModerator() {
  const user = currentUser();
  return !!(user && user.isModerator);
}
function signOutUser() {
  if (DEV_MODE) return;
  if (window.Clerk) window.Clerk.signOut(() => { window.location.href = 'welcome.html'; });
}

// =========================================================
// Cliente de Supabase
// =========================================================
let supabaseClient = null;
if (!DEV_MODE && window.supabase && typeof SUPABASE_URL !== 'undefined') {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: async () => {
      if (window.Clerk && window.Clerk.session) return await window.Clerk.session.getToken();
      return null;
    }
  });
}

// =========================================================
// CAPA DE DATOS — puntos del mapa
// =========================================================
// Los datos viven en un caché local sincrónico (pointsCache),
// para que el resto del código pueda seguir leyendo con
// funciones normales, sin await. Ese caché se llena al cargar
// la página y se mantiene al día con Supabase Realtime.
// Las escrituras (insertar/borrar) sí son asíncronas de verdad.
const STORAGE_KEY = 'corriente_dev_points';
let pointsCache = [];

function dbLoadAllLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function dbSaveAllLocal(points) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(points)); } catch (e) {}
}
function mapPointRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    reporter_email: row.reporter_email,
    posted_by_admin: row.posted_by_admin,
    lat: row.lat, lng: row.lng,
    title: row.title, description: row.description,
    image: row.image_url,
    category: row.category,
    created_at: new Date(row.created_at).getTime()
  };
}

async function refreshPointsCache() {
  if (DEV_MODE) { pointsCache = dbLoadAllLocal(); return; }
  const cutoffIso = new Date(Date.now() - EXPIRATION_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseClient
    .from('puntos').select('*').gt('created_at', cutoffIso);
  if (error) { console.error('Error cargando puntos:', error); return; }
  pointsCache = data.map(mapPointRow);
}

function dbActivePoints() {
  const cutoff = Date.now() - EXPIRATION_HOURS * 60 * 60 * 1000;
  return pointsCache.filter(p => p.created_at > cutoff);
}
function dbActivePointsByUser(userId) {
  return dbActivePoints().filter(p => p.user_id === userId);
}

async function dbInsertPoint(point) {
  if (DEV_MODE) {
    const all = dbLoadAllLocal();
    all.push(point);
    dbSaveAllLocal(all);
    pointsCache.push(point);
    return true;
  }
  const { data, error } = await supabaseClient.from('puntos').insert({
    user_id: point.user_id,
    reporter_email: point.reporter_email,
    posted_by_admin: point.posted_by_admin,
    category: point.category,
    title: point.title,
    description: point.description,
    image_url: point.image,
    lat: point.lat, lng: point.lng
  }).select().single();
  if (error) {
    console.error('Error guardando punto:', error);
    alert('No se pudo guardar tu reporte: ' + error.message);
    return false;
  }
  point.id = data.id; // el id real lo asigna Supabase, no lo inventamos nosotros
  pointsCache.push(mapPointRow(data));
  return true;
}

async function dbDeletePoint(id, requestingUser, imageUrl) {
  if (DEV_MODE) {
    const all = dbLoadAllLocal().filter(p => {
      if (p.id !== id) return true;
      const isOwner = p.user_id === requestingUser.id;
      return !(isOwner || requestingUser.isModerator);
    });
    dbSaveAllLocal(all);
    pointsCache = pointsCache.filter(p => p.id !== id);
    return true;
  }
  const { error } = await supabaseClient.from('puntos').delete().eq('id', id);
  if (error) {
    console.error('Error borrando punto:', error);
    alert('No se pudo eliminar: ' + error.message);
    return false;
  }
  pointsCache = pointsCache.filter(p => p.id !== id);
  if (imageUrl) await deletePhotoByUrl(imageUrl); // libera el espacio en Storage
  return true;
}

function extractStoragePathFromUrl(url) {
  // La URL pública tiene la forma: .../storage/v1/object/public/fotos-incidentes/<carpeta>/<archivo>
  const marker = `/object/public/${PHOTOS_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length));
}
async function deletePhotoByUrl(url) {
  const path = extractStoragePathFromUrl(url);
  if (!path) return;
  const { error } = await supabaseClient.storage.from(PHOTOS_BUCKET).remove([path]);
  if (error) console.error('Error borrando la foto del almacenamiento:', error);
}

// =========================================================
// CAPA DEL LOG — historial permanente, solo moderadores
// =========================================================
const LOG_STORAGE_KEY = 'corriente_dev_log';

function logLoadAllLocal() {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function logSaveAllLocal(entries) {
  try { localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(entries)); } catch (e) {}
}
function formatLocalDateTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function logComputedRow(entry) {
  const now = Date.now();
  const endTime = entry.closed_at || Math.min(now, entry.created_at + EXPIRATION_HOURS * 60 * 60 * 1000);
  const tiempoActivoMinutos = Math.max(0, Math.round((endTime - entry.created_at) / 60000));
  const expiro = !entry.closed_at && (now - entry.created_at) >= EXPIRATION_HOURS * 60 * 60 * 1000;
  return {
    tipo_evento: entry.category,
    titulo: entry.title || '',
    descripcion: entry.description || '',
    fecha_hora_creacion: formatLocalDateTime(entry.created_at),
    codigo_postal: entry.codigo_postal || '',
    cancelado_por_usuario: entry.closed_by === 'usuario',
    eliminado_por_moderador: entry.closed_by === 'moderador',
    moderador_email: entry.closed_by_email || '',
    tiempo_activo_minutos: tiempoActivoMinutos,
    expiro: expiro
  };
}

async function logInsert(entry) {
  if (DEV_MODE) {
    const all = logLoadAllLocal();
    all.push(entry);
    logSaveAllLocal(all);
    return;
  }
  const { error } = await supabaseClient.from('log_eventos').insert({
    point_id: entry.point_id,
    user_id: entry.user_id,
    reporter_email: entry.reporter_email,
    category: entry.category,
    title: entry.title,
    description: entry.description
  });
  if (error) console.error('Error creando entrada de log:', error);
}
async function logSetPostcode(pointId, postcode) {
  if (DEV_MODE) {
    const all = logLoadAllLocal();
    const entry = all.find(e => e.point_id === pointId);
    if (entry) entry.codigo_postal = postcode;
    logSaveAllLocal(all);
    return;
  }
  const { error } = await supabaseClient.from('log_eventos')
    .update({ codigo_postal: postcode })
    .eq('point_id', pointId)
    .is('closed_at', null);
  if (error) console.error('Error guardando código postal:', error);
}
async function logCloseEntry(pointId, closedBy, closedByEmail) {
  if (DEV_MODE) {
    const all = logLoadAllLocal();
    const entry = all.find(e => e.point_id === pointId);
    if (entry && !entry.closed_at) {
      entry.closed_at = Date.now();
      entry.closed_by = closedBy;
      entry.closed_by_email = closedBy === 'moderador' ? closedByEmail : null;
    }
    logSaveAllLocal(all);
    return;
  }
  const { error } = await supabaseClient.from('log_eventos')
    .update({
      closed_at: new Date().toISOString(),
      closed_by: closedBy,
      closed_by_email: closedBy === 'moderador' ? closedByEmail : null
    })
    .eq('point_id', pointId)
    .is('closed_at', null);
  if (error) console.error('Error cerrando entrada de log:', error);
}
async function fetchLogRows() {
  if (DEV_MODE) {
    return logLoadAllLocal().map(logComputedRow).sort((a, b) => b.fecha_hora_creacion.localeCompare(a.fecha_hora_creacion));
  }
  const { data, error } = await supabaseClient
    .from('log_eventos_export')
    .select('*')
    .order('fecha_hora_creacion', { ascending: false });
  if (error) { console.error('Error cargando el log:', error); return []; }
  return data;
}

// =========================================================
// CAPA DE UBICACIÓN — ¿el usuario está dentro de Yucatán?
// =========================================================
let locationStatus = 'checking';

function requestUserLocation() {
  if (!navigator.geolocation) {
    locationStatus = 'unavailable';
    renderAuthBox();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const userLatLng = L.latLng(pos.coords.latitude, pos.coords.longitude);
      locationStatus = YUCATAN_BOUNDS.contains(userLatLng) ? 'inside' : 'outside';
      renderAuthBox();
    },
    () => {
      locationStatus = 'unavailable';
      renderAuthBox();
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}
function canReport() { return locationStatus === 'inside'; }
function locationBadge() {
  if (locationStatus === 'checking') return `<span class="locBadge locChecking">📍 Verificando…</span>`;
  if (locationStatus === 'inside') return `<span class="locBadge locInside">📍 En Yucatán</span>`;
  return `<span class="locBadge locOutside">👁 Modo visual</span>`;
}

// =========================================================
// CAPA DE GEOCODIFICACIÓN — Nominatim real (DEV_MODE usa datos falsos)
// =========================================================
const MOCK_POSTAL_CODES = ['97000', '97113', '97127', '97133', '97205', '97219', '97302', '97314'];

function reverseGeocode(lat, lng, callback) {
  if (DEV_MODE) {
    const fakeDelay = 400 + Math.random() * 500;
    setTimeout(() => {
      const fake = MOCK_POSTAL_CODES[Math.floor(Math.random() * MOCK_POSTAL_CODES.length)];
      callback(fake);
    }, fakeDelay);
    return;
  }

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
  fetch(url, { headers: { 'Accept-Language': 'es' } })
    .then(res => res.json())
    .then(data => {
      const postcode = (data && data.address && data.address.postcode) ? data.address.postcode : null;
      callback(postcode);
    })
    .catch(err => {
      console.error('Error consultando Nominatim:', err);
      callback(null); // si falla, el punto se guarda igual, solo sin código postal
    });
}

// =========================================================
// CAPA DE ALMACENAMIENTO — fotos en Supabase Storage
// =========================================================
const PHOTOS_BUCKET = 'fotos-incidentes';

// Reduce el tamaño de la foto antes de subirla (máx. 1280px de
// lado más largo, calidad 75%) — así no se gasta de golpe el
// espacio gratuito con fotos de 8+ megapixeles de un celular.
function compressImage(file, maxDimension = 1280, quality = 0.75) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDimension) {
          height = Math.round(height * (maxDimension / width));
          width = maxDimension;
        } else if (height >= width && height > maxDimension) {
          width = Math.round(width * (maxDimension / height));
          height = maxDimension;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', quality);
      };
      img.onerror = () => resolve(file); // si algo falla, sube el original sin comprimir
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

async function uploadPhoto(file, userId) {
  if (!supabaseClient) return null;
  const compressed = await compressImage(file);
  const path = `${userId}/${Date.now()}.jpg`;
  const { error } = await supabaseClient.storage
    .from(PHOTOS_BUCKET)
    .upload(path, compressed, { contentType: 'image/jpeg', upsert: false });
  if (error) {
    console.error('Error subiendo la foto:', error);
    return null;
  }
  const { data } = supabaseClient.storage.from(PHOTOS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// =========================================================
// Mapa
// =========================================================
const map = L.map('map', {
  zoomControl: false,
  attributionControl: false,
  maxBounds: YUCATAN_BOUNDS,
  maxBoundsViscosity: 1.0,
  minZoom: 8
}).setView(CITY_CENTER, CITY_ZOOM);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '' }).addTo(map);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.control.attribution({ prefix: false }).addAttribution('© OpenStreetMap, © CARTO').addTo(map);

const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 70,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  iconCreateFunction: function (cluster) {
    return L.divIcon({
      html: `<div class="clusterBubble">${cluster.getChildCount()}</div>`,
      className: '',
      iconSize: [40, 40]
    });
  }
}).addTo(map);

let markersById = {};

function redrawAllMarkers() {
  clusterGroup.clearLayers();
  markersById = {};
  dbActivePoints().forEach(addMarkerToMap);
  renderSidebar();
  renderAuthBox();
}

// =========================================================
// Utilidades
// =========================================================
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(s) { return (s || '').replace(/'/g, "%27"); }

function timeLeftLabel(createdAt) {
  const expiresAt = createdAt + EXPIRATION_HOURS * 60 * 60 * 1000;
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) return 'Expirado';
  const hrs = Math.floor(msLeft / 3600000);
  const mins = Math.floor((msLeft % 3600000) / 60000);
  return `Expira en ${hrs}h ${mins}m`;
}

function showToast(msg) {
  const hint = document.getElementById('hint');
  const hintText = document.getElementById('hintText');
  const prevText = hintText.textContent;
  hintText.textContent = msg;
  hint.style.opacity = '1';
  setTimeout(() => { hintText.textContent = prevText; }, 2500);
}

// =========================================================
// Bloqueo del mapa mientras el menú de reporte está abierto
// =========================================================
let reportPopupOpen = false;

function lockMap() {
  reportPopupOpen = true;
  map.dragging.disable();
  map.scrollWheelZoom.disable();
  map.doubleClickZoom.disable();
  map.touchZoom.disable();
  if (map.boxZoom) map.boxZoom.disable();
  if (map.keyboard) map.keyboard.disable();
  document.getElementById('map').classList.add('is-locked');
  document.body.classList.add('report-locked');
}
function unlockMap() {
  reportPopupOpen = false;
  map.dragging.enable();
  map.scrollWheelZoom.enable();
  map.doubleClickZoom.enable();
  map.touchZoom.enable();
  if (map.boxZoom) map.boxZoom.enable();
  if (map.keyboard) map.keyboard.enable();
  document.getElementById('map').classList.remove('is-locked');
  document.body.classList.remove('report-locked');
}
map.on('popupclose', () => { unlockMap(); });

// =========================================================
// Ícono del marcador — distingue Apagón vs Otro
// =========================================================
function buildIcon(point) {
  const isApagon = point.category === 'apagon';
  const bodyClass = isApagon ? '' : ' pin-otro';
  const inner = point.image
    ? `<div class="pin-img" style="background-image:url('${escapeAttr(point.image)}')"></div>`
    : `<div class="pin-emoji">${isApagon ? '⚡' : '❗'}</div>`;
  return L.divIcon({
    className: '',
    html: `<div class="pin-wrap"><div class="pin-body${bodyClass}"></div>${inner}</div>`,
    iconSize: [38, 48], iconAnchor: [19, 44]
  });
}

// =========================================================
// Ficha de detalle (clic en un marcador ya existente)
// =========================================================
function detailHtml(point) {
  const img = point.image ? `<img class="card-photo" src="${escapeAttr(point.image)}" onerror="this.style.display='none'">` : '';
  const user = currentUser();
  const canDelete = user && (point.user_id === user.id || isModerator());
  const delBtn = canDelete ? `<button class="card-delete" data-del="${point.id}">Eliminar</button>` : '';
  const tag = point.category === 'apagon'
    ? `<span class="tag tagApagon">⚡ Apagón</span>`
    : `<span class="tag tagOtro">❗ Otro reporte</span>`;
  const adminTag = point.posted_by_admin ? `<div class="adminTag">🛡️ Agregado por la administración de la página</div>` : '';
  const modInfo = isModerator() ? `<div class="modInfo">👁 Reportado por: ${escapeHtml(point.reporter_email)}</div>` : '';
  return `<div class="card-inner">
    ${img}
    <div class="card-body">
      ${tag}
      ${adminTag}
      <h3>${escapeHtml(point.title || 'Sin título')}</h3>
      ${point.description ? `<p>${escapeHtml(point.description)}</p>` : ''}
      ${modInfo}
      <div class="card-meta">
        <span class="expira">${timeLeftLabel(point.created_at)}</span>
        ${delBtn}
      </div>
    </div>
  </div>`;
}

function bindDetailEvents(popup, point) {
  const el = popup.getElement();
  const delBtn = el.querySelector('[data-del]');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      const user = currentUser();
      const ok = await dbDeletePoint(point.id, user, point.image);
      if (!ok) { delBtn.disabled = false; return; }
      await logCloseEntry(point.id, user.id === point.user_id ? 'usuario' : 'moderador', user.email);
      if (markersById[point.id]) { clusterGroup.removeLayer(markersById[point.id]); delete markersById[point.id]; }
      map.closePopup();
      renderSidebar();
      renderAuthBox();
    });
  }
}

function addMarkerToMap(point) {
  if (markersById[point.id]) return; // ya está en el mapa, evita duplicados
  const marker = L.marker([point.lat, point.lng], { icon: buildIcon(point) });
  marker.on('click', () => {
    if (reportPopupOpen) return;
    marker.bindPopup(detailHtml(point), { closeButton: true, maxWidth: 270 }).openPopup();
    setTimeout(() => bindDetailEvents(marker.getPopup(), point), 10);
  });
  clusterGroup.addLayer(marker);
  markersById[point.id] = marker;
}

// =========================================================
// Guardar un punto nuevo (compartido entre "Apagón" y "Otro")
// =========================================================
let pendingLatLng = null;

// ---------- Cooldown entre reportes (mismo usuario) ----------
const lastPlacedAt = {}; // user.id -> marca de tiempo del último reporte exitoso
function getCooldownRemaining(userId) {
  const elapsed = Date.now() - (lastPlacedAt[userId] || 0);
  const remainingMs = REPORT_COOLDOWN_SECONDS * 1000 - elapsed;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

async function savePoint({ category, title, description, image }) {
  const user = currentUser();
  const point = {
    id: null, // Supabase asigna el id real al guardar (en DEV_MODE se genera aquí abajo)
    user_id: user.id,
    reporter_email: user.email,
    posted_by_admin: isModerator(),
    lat: pendingLatLng.lat, lng: pendingLatLng.lng,
    title, description, image, category,
    created_at: Date.now()
  };
  if (DEV_MODE) point.id = 'p' + Date.now();

  const ok = await dbInsertPoint(point);
  if (!ok) return; // el error ya se mostró dentro de dbInsertPoint

  addMarkerToMap(point);

  await logInsert({
    point_id: point.id,
    user_id: user.id,
    reporter_email: user.email,
    category, title, description,
    created_at: point.created_at,
    codigo_postal: null,
    closed_at: null,
    closed_by: null
  });
  reverseGeocode(point.lat, point.lng, (postcode) => logSetPostcode(point.id, postcode));

  lastPlacedAt[user.id] = Date.now();
  renderSidebar();
  renderAuthBox();
}

function limitWarningHtml(activeCount) {
  return `<div class="form-title">Límite alcanzado</div>
    <div class="form-body">
      <div class="limitWarning">Ya tienes ${MAX_ACTIVE_PER_USER} incidentes activos. Espera a que expiren (4h) o elimina alguno desde el panel lateral para reportar uno nuevo.</div>
    </div>`;
}

// =========================================================
// Paso 1: elegir "Apagón" o "Otro"
// =========================================================
function chooserHtml() {
  const user = currentUser();
  const cooldown = getCooldownRemaining(user.id);
  if (cooldown > 0) return cooldownWarningHtml(cooldown);
  if (!isModerator()) {
    const activeCount = dbActivePointsByUser(user.id).length;
    if (activeCount >= MAX_ACTIVE_PER_USER) return limitWarningHtml(activeCount);
  }
  return `<div class="form-title">¿Qué está pasando?</div>
    <div class="chooser-body">
      <button type="button" class="chooseBtn apagonBtn" id="c_apagon">
        <span class="chooseIcon">⚡</span>
        <span class="chooseLabel">Apagón</span>
        <span class="chooseSub">Sin energía — reporte de un toque</span>
      </button>
      <button type="button" class="chooseBtn otroBtn" id="c_otro">
        <span class="chooseIcon">📝</span>
        <span class="chooseLabel">Otro</span>
        <span class="chooseSub">Describe lo que ves (chispas, cable caído, etc.)</span>
      </button>
    </div>`;
}
function cooldownWarningHtml(seconds) {
  return `<div class="form-title">Espera un momento</div>
    <div class="form-body">
      <div class="limitWarning">Puedes reportar de nuevo en <span id="cooldownSeconds">${seconds}</span>s. Esto ayuda a evitar el spam.</div>
    </div>`;
}

function bindChooserEvents(popup) {
  const el = popup.getElement();
  const cooldownSpan = el.querySelector('#cooldownSeconds');

  if (cooldownSpan) {
    const timer = setInterval(() => {
      const user = currentUser();
      const remaining = getCooldownRemaining(user.id);
      if (remaining <= 0) {
        clearInterval(timer);
        popup.setContent(chooserHtml());
        setTimeout(() => bindChooserEvents(popup), 10);
      } else {
        cooldownSpan.textContent = remaining;
      }
    }, 500);
    map.once('popupclose', () => clearInterval(timer));
    return;
  }

  const apagonBtn = el.querySelector('#c_apagon');
  const otroBtn = el.querySelector('#c_otro');
  if (!apagonBtn) return; // se mostró el aviso de límite, no hay nada que enlazar

  apagonBtn.addEventListener('click', async () => {
    apagonBtn.disabled = true;
    await savePoint({ category: 'apagon', title: 'Apagón', description: '', image: '' });
    map.closePopup();
    showToast('¡Reporte enviado! Gracias por avisar a la comunidad.');
  });

  otroBtn.addEventListener('click', () => {
    popup.setContent(formHtml());
    setTimeout(() => bindFormEvents(popup), 10);
  });
}

// =========================================================
// Paso 2 (solo para "Otro"): formulario detallado
// =========================================================
function formHtml() {
  return `<div class="form-title">Describe el incidente</div>
    <div class="form-body">
      <input id="f_title" type="text" placeholder="Título de incidente" maxlength="60">
      <textarea id="f_desc" placeholder="Describe con detalle qué ocurrió..." maxlength="240"></textarea>
      <input id="f_img_file" type="file" accept="image/*" style="display:none">
      <button type="button" class="fileBtn" id="f_img_btn">📷 Agregar imagen desde el dispositivo</button>
      <div class="imgPreview" id="f_img_preview" style="display:none">
        <img id="f_img_preview_img" src="">
        <span>Imagen lista</span>
        <button type="button" id="f_img_remove" title="Quitar imagen">✕</button>
      </div>
      <button class="saveBtn" id="f_save">Reportar incidente</button>
    </div>`;
}

function bindFormEvents(popup) {
  const el = popup.getElement();
  const saveBtn = el.querySelector('#f_save');
  if (!saveBtn) return;

  let selectedImageData = null; // base64, solo para la vista previa local
  let selectedImageFile = null; // archivo real, este es el que se sube
  const fileInput = el.querySelector('#f_img_file');
  const fileBtn = el.querySelector('#f_img_btn');
  const preview = el.querySelector('#f_img_preview');
  const previewImg = el.querySelector('#f_img_preview_img');

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    selectedImageFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      selectedImageData = e.target.result;
      previewImg.src = selectedImageData;
      preview.style.display = 'flex';
      fileBtn.style.display = 'none';
    };
    reader.readAsDataURL(file);
  });
  el.querySelector('#f_img_remove').addEventListener('click', () => {
    selectedImageData = null;
    selectedImageFile = null;
    fileInput.value = '';
    preview.style.display = 'none';
    fileBtn.style.display = 'flex';
  });

  saveBtn.addEventListener('click', async () => {
    const title = el.querySelector('#f_title').value.trim();
    const desc = el.querySelector('#f_desc').value.trim();
    if (!title) { el.querySelector('#f_title').focus(); return; }
    saveBtn.disabled = true;

    let imageUrl = '';
    if (selectedImageFile) {
      if (DEV_MODE) {
        imageUrl = selectedImageData || ''; // en modo de prueba no hay Storage real, se queda el base64
      } else {
        saveBtn.textContent = 'Subiendo foto…';
        imageUrl = await uploadPhoto(selectedImageFile, currentUser().id) || '';
        saveBtn.textContent = 'Reportar incidente';
      }
    }

    await savePoint({ category: 'otro', title, description: desc, image: imageUrl });
    map.closePopup();
    showToast('¡Reporte enviado! Gracias por avisar a la comunidad.');
  });
}

// =========================================================
// Panel lateral
// =========================================================
function renderSidebar() {
  const list = document.getElementById('pinList');
  const points = dbActivePoints().sort((a, b) => b.created_at - a.created_at);
  document.getElementById('sidebarCount').textContent = points.length;

  if (points.length === 0) {
    list.innerHTML = `<div id="emptyState">
      <div class="bolt">⚡</div>
      <div>Aún no hay incidentes reportados.<br>Toca el mapa para reportar el primero.</div>
    </div>`;
    return;
  }

  const user = currentUser();
  list.innerHTML = points.map(p => {
    const thumbStyle = p.image ? `style="background-image:url('${escapeAttr(p.image)}')"` : '';
    const thumbContent = p.image ? '' : (p.category === 'apagon' ? '⚡' : '❗');
    const canDelete = user && (p.user_id === user.id || isModerator());
    const delBtn = canDelete ? `<button class="delBtn" data-del="${p.id}" title="Eliminar">🗑</button>` : '';
    const adminLine = p.posted_by_admin ? `<br><span class="adminNoteSmall">🛡️ Agregado por la administración</span>` : '';
    const modLine = isModerator() ? `<br><span class="modNoteSmall">👁 ${escapeHtml(p.reporter_email)}</span>` : '';
    return `<div class="pinItem">
      <div class="thumb" ${thumbStyle} data-goto="${p.id}">${thumbContent}</div>
      <div class="txt" data-goto="${p.id}"><b>${escapeHtml(p.title)}</b><small>${timeLeftLabel(p.created_at)}${adminLine}${modLine}</small></div>
      ${delBtn}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-goto]').forEach(node => {
    node.addEventListener('click', () => {
      const point = points.find(p => p.id === node.dataset.goto);
      if (!point) return;
      map.flyTo([point.lat, point.lng], 16, { duration: 0.6 });
      setTimeout(() => markersById[point.id] && markersById[point.id].fire('click'), 650);
    });
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const point = points.find(p => p.id === btn.dataset.del);
      const ok = await dbDeletePoint(btn.dataset.del, user, point ? point.image : null);
      if (!ok) { btn.disabled = false; return; }
      if (point) await logCloseEntry(point.id, user.id === point.user_id ? 'usuario' : 'moderador', user.email);
      if (markersById[btn.dataset.del]) { clusterGroup.removeLayer(markersById[btn.dataset.del]); delete markersById[btn.dataset.del]; }
      renderSidebar();
      renderAuthBox();
    });
  });
}

// =========================================================
// Cabecera: sesión
// =========================================================
function renderAuthBox() {
  const box = document.getElementById('authBox');
  const hintText = document.getElementById('hintText');
  if (isLoggedIn()) {
    const user = currentUser();
    const mod = isModerator();
    const limitLabel = mod ? 'Moderador · sin límite de reportes' : `${dbActivePointsByUser(user.id).length}/${MAX_ACTIVE_PER_USER} incidentes activos`;
    const logBtn = mod ? `<button class="logBtn" id="btnViewLog" title="Ver log de eventos">📋</button>` : '';
    const signOutBtn = DEV_MODE ? '' : `<button class="logBtn" id="btnSignOut" title="Cerrar sesión">⎋</button>`;
    box.innerHTML = `<div class="sessionPill ${mod ? 'sessionPillMod' : ''}">
      <div class="avatar ${mod ? 'avatarMod' : ''}">${user.initials}</div>
      <div><b>${escapeHtml(user.email)}</b><br><span class="limitTag">${limitLabel}</span></div>
      ${locationBadge()}
      ${logBtn}
      ${signOutBtn}
    </div>`;
    if (mod) document.getElementById('btnViewLog').addEventListener('click', openLogModal);
    if (!DEV_MODE) document.getElementById('btnSignOut').addEventListener('click', signOutUser);
    if (locationStatus === 'checking') hintText.textContent = 'Verificando tu ubicación…';
    else if (locationStatus === 'inside') hintText.textContent = 'Toca cualquier punto del mapa para reportar una falla';
    else hintText.textContent = 'Modo visual: tu ubicación no se detecta dentro de Yucatán';
  } else {
    box.innerHTML = `
      <button class="authBtn ghost" id="btnLogin">Iniciar sesión</button>
      <button class="authBtn solid" id="btnRegister">Registrarme</button>`;
    document.getElementById('btnLogin').addEventListener('click', () => window.location.href = 'welcome.html');
    document.getElementById('btnRegister').addEventListener('click', () => window.location.href = 'welcome.html');
    hintText.textContent = 'Inicia sesión para reportar una falla en el mapa';
  }
}

// =========================================================
// Modal (solo se usa para el aviso de ubicación / modo visual)
// =========================================================
const modalOverlay = document.getElementById('modalOverlay');
function openLocationModal() {
  document.getElementById('modalIcon').textContent = '👁';
  document.getElementById('modalTitle').textContent = 'Modo visual únicamente';
  document.getElementById('modalText').textContent = locationStatus === 'outside'
    ? 'Detectamos que tu ubicación está fuera del estado de Yucatán. Puedes ver los incidentes reportados, pero no puedes colocar nuevos puntos.'
    : 'No pudimos confirmar tu ubicación (revisa los permisos de ubicación de tu navegador). Mientras tanto, el sitio funciona en modo de solo lectura.';
  document.getElementById('modalHintRow').style.display = 'none';
  modalOverlay.classList.add('open');
}
document.getElementById('modalClose').addEventListener('click', () => modalOverlay.classList.remove('open'));
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.remove('open'); });

// =========================================================
// Clic en el mapa: abrir selector de "Apagón" / "Otro" (o pedir login)
// =========================================================
map.on('click', (e) => {
  if (reportPopupOpen) return;
  if (!isLoggedIn()) { window.location.href = 'welcome.html'; return; }
  if (!canReport()) { openLocationModal(); return; }
  pendingLatLng = e.latlng;
  const popup = L.popup({ closeButton: true, maxWidth: 270, offset: [0, -4], autoClose: false, closeOnClick: false })
    .setLatLng(e.latlng)
    .setContent(chooserHtml())
    .openOn(map);
  lockMap();
  setTimeout(() => bindChooserEvents(popup), 10);
  document.getElementById('hint').style.opacity = '0';
});

// =========================================================
// Modal del log (solo lectura, solo visible para moderadores)
// =========================================================
function openLogModal() {
  renderLogTable();
  document.getElementById('logModalOverlay').classList.add('open');
}
async function renderLogTable() {
  const tbody = document.getElementById('logTableBody');
  tbody.innerHTML = `<tr><td colspan="10" class="logEmpty">Cargando…</td></tr>`;
  const rows = await fetchLogRows();
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="logEmpty">Aún no hay eventos registrados.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr>
    <td>${r.tipo_evento === 'apagon' ? '⚡ Apagón' : '❗ Otro'}</td>
    <td>${escapeHtml(r.titulo) || '—'}</td>
    <td>${escapeHtml(r.descripcion) || '—'}</td>
    <td>${r.fecha_hora_creacion}</td>
    <td>${r.codigo_postal || '…'}</td>
    <td>${r.cancelado_por_usuario ? '✔️' : ''}</td>
    <td>${r.eliminado_por_moderador ? '✔️' : ''}</td>
    <td>${r.moderador_email || '—'}</td>
    <td>${r.tiempo_activo_minutos}</td>
    <td>${r.expiro ? '✔️' : ''}</td>
  </tr>`).join('');
}
document.getElementById('logModalClose').addEventListener('click', () => document.getElementById('logModalOverlay').classList.remove('open'));
document.getElementById('logModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'logModalOverlay') document.getElementById('logModalOverlay').classList.remove('open');
});

// =========================================================
// Panel lateral: plegar / desplegar (plegado por defecto)
// =========================================================
const sidebarEl = document.getElementById('sidebar');
const sidebarToggleBtn = document.getElementById('sidebarToggle');
sidebarToggleBtn.addEventListener('click', () => {
  const expanded = sidebarEl.classList.toggle('expanded');
  sidebarToggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
});

// =========================================================
// Init
// =========================================================
function applyTopOffset() {
  const banners = document.getElementById('topBanners');
  document.documentElement.style.setProperty('--top-offset', banners.offsetHeight + 'px');
}

async function boot() {
  if (!DEV_MODE) {
    if (!window.Clerk) {
      console.error('Clerk no cargó. Revisa la llave y la URL en el <script> de index.html.');
    } else {
      await window.Clerk.load();
      window.Clerk.addListener(() => { renderAuthBox(); renderSidebar(); });
    }
    if (!supabaseClient) {
      console.error('Supabase no está configurado. Revisa js/config.js.');
    }
  }

  // Puerta de bienvenida: si nunca ha pasado por welcome.html y no tiene
  // sesión, lo mandamos allá primero — una sola vez por navegador. Quien
  // ya inició sesión, o quien ya eligió "ver sin cuenta" antes, entra
  // directo, sin que se le interrumpa de nuevo en cada visita.
  if (!isLoggedIn() && !localStorage.getItem(WELCOME_SEEN_KEY)) {
    window.location.href = 'welcome.html';
    return;
  }

  applyTopOffset();
  window.addEventListener('resize', applyTopOffset);

  await refreshPointsCache();
  dbActivePoints().forEach(addMarkerToMap);
  renderAuthBox();
  requestUserLocation();
  renderSidebar();

  // Actualización en vivo: cuando cualquier usuario agrega o borra un
  // punto, todos los demás lo ven sin recargar la página.
  if (!DEV_MODE && supabaseClient) {
    supabaseClient
      .channel('puntos-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'puntos' }, async () => {
        await refreshPointsCache();
        redrawAllMarkers();
      })
      .subscribe();
  }
}
boot();

// Refresca los contadores de "expira en..." y limpia puntos vencidos cada minuto
setInterval(async () => {
  await refreshPointsCache();
  const activeIds = new Set(dbActivePoints().map(p => p.id));
  Object.keys(markersById).forEach(id => {
    if (!activeIds.has(id)) { clusterGroup.removeLayer(markersById[id]); delete markersById[id]; }
  });
  renderSidebar();
  renderAuthBox();
}, 60000);
