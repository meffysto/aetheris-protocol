// client/galaxy3d.mjs — Vue 3D Three.js de la galaxie LIVE
//
// Branchée sur le `state` réel (calculé par tick-core.mjs). Au-dessus de
// la vue SVG existante : nouveau toggle "✦ 3D" dans la vue Galaxie.
//
// Affiche :
//   - mon système (orbites visibles)
//   - chaque position : planète (sphère colorée par classe) ou astéroïde
//   - halo doré pour MA planète, anneau phosphor pour planètes minées
//   - trails de flottes hostiles incoming
//   - anneau de Saturne pour les gazeuses
//
// Compilation cible : module ESM browser, Three.js via importmap CDN.
// Si Three n'est pas dispo (offline), fallback transparent → la vue SVG
// classique reste affichée.

const THREE_CDN = 'https://esm.sh/three@0.169.0';
const ORBIT_CDN = 'https://esm.sh/three@0.169.0/examples/jsm/controls/OrbitControls.js';

let THREE = null;
let OrbitControls = null;
let scene, camera, renderer, controls, clock;
let starGroup, planetGroup, routeGroup, ambientLight;
let mounted = false;
let mountEl = null;
let resizeObs = null;
let rafId = null;
let pickable = [];
let haloRefs = [];
let routeMeshes = [];
let onPickCallback = null;

const CLASS_COLOR = {
  tellurique: 0x7fa570,
  cristalline: 0x3a8a8a,
  glacee:      0x88c8e0,
  volcanique:  0xa83a25,
  gazeuse:     0x5a3a6a,
  anomalie:    0xc4b48a,
};
const CLASS_SIZE = {
  tellurique: 1.0,
  cristalline: 0.85,
  glacee:      0.9,
  volcanique:  0.95,
  gazeuse:     1.4,
  anomalie:    0.7,
};
const STAR_COLOR = {
  O: 0x9bb0ff, B: 0xaabfff, A: 0xcad7ff, F: 0xf8f7ff,
  G: 0xf7e09a, K: 0xffd2a1, M: 0xffaa6f,
};

async function ensureThree() {
  if (THREE && OrbitControls) return true;
  try {
    THREE = await import(/* @vite-ignore */ THREE_CDN);
    const orbit = await import(/* @vite-ignore */ ORBIT_CDN);
    OrbitControls = orbit.OrbitControls;
    return true;
  } catch (e) {
    console.warn('[galaxy3d] Three.js indisponible (offline ?)', e);
    return false;
  }
}

export async function mount(targetEl, { onPick } = {}) {
  const ok = await ensureThree();
  if (!ok) return false;
  if (mounted && mountEl === targetEl) return true;
  unmount();

  mountEl = targetEl;
  onPickCallback = onPick || null;

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  targetEl.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';

  // Scene
  scene = new THREE.Scene();
  scene.background = null;

  // Camera (perspective avec un FOV calme)
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
  camera.position.set(0, 28, 56);
  camera.lookAt(0, 0, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 0.6;
  controls.minDistance = 18;
  controls.maxDistance = 160;
  controls.maxPolarAngle = Math.PI * 0.95;

  // Lights
  ambientLight = new THREE.AmbientLight(0x556688, 0.4);
  scene.add(ambientLight);

  // Stars backdrop (point cloud)
  const bgStars = new THREE.BufferGeometry();
  const N = 1600;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 400 + Math.random() * 400;
    const t = Math.random() * Math.PI * 2;
    const u = Math.random() * 2 - 1;
    const phi = Math.acos(u);
    pos[i * 3]     = r * Math.sin(phi) * Math.cos(t);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(t);
    pos[i * 3 + 2] = r * Math.cos(phi);
  }
  bgStars.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const bgMat = new THREE.PointsMaterial({
    size: 1.2, color: 0xf4ecdc, transparent: true, opacity: 0.55,
    sizeAttenuation: false,
  });
  scene.add(new THREE.Points(bgStars, bgMat));

  // Groupes
  starGroup = new THREE.Group(); scene.add(starGroup);
  planetGroup = new THREE.Group(); scene.add(planetGroup);
  routeGroup = new THREE.Group(); scene.add(routeGroup);

  clock = new THREE.Clock();

  // Resize observer
  resizeObs = new ResizeObserver(handleResize);
  resizeObs.observe(targetEl);
  handleResize();

  // Picking
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('click', onPointerClick);

  mounted = true;
  loop();
  return true;
}

export function unmount() {
  mounted = false;
  if (rafId) cancelAnimationFrame(rafId), rafId = null;
  if (resizeObs) resizeObs.disconnect(), resizeObs = null;
  if (renderer) {
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('click', onPointerClick);
    renderer.dispose();
    if (renderer.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
  scene = camera = renderer = controls = clock = null;
  starGroup = planetGroup = routeGroup = null;
  pickable = []; haloRefs = []; routeMeshes = [];
  mountEl = null;
  onPickCallback = null;
}

function handleResize() {
  if (!mounted || !mountEl || !renderer) return;
  const r = mountEl.getBoundingClientRect();
  const w = Math.max(64, r.width | 0);
  const h = Math.max(64, r.height | 0);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const raycaster = () => {
  if (!THREE) return null;
  return new THREE.Raycaster();
};
const mouseV = () => {
  if (!THREE) return null;
  return new THREE.Vector2();
};
let _ray = null, _mv = null;
function onPointerMove(e) {
  if (!mounted) return;
  _ray = _ray || raycaster(); _mv = _mv || mouseV();
  const r = renderer.domElement.getBoundingClientRect();
  _mv.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  _mv.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  _ray.setFromCamera(_mv, camera);
  const hits = _ray.intersectObjects(pickable, false);
  renderer.domElement.style.cursor = hits.length ? 'pointer' : 'default';
}
function onPointerClick(e) {
  if (!mounted || !onPickCallback) return;
  _ray = _ray || raycaster(); _mv = _mv || mouseV();
  const r = renderer.domElement.getBoundingClientRect();
  _mv.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  _mv.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  _ray.setFromCamera(_mv, camera);
  const hits = _ray.intersectObjects(pickable, false);
  if (hits.length) onPickCallback(hits[0].object.userData);
}

// ─── Mise à jour du contenu (re-build complet) ─────────────────────
// Re-build seulement quand `update()` est appelé explicitement.
// Le tick d'animation ne touche pas à la scène statique.
export function update({ system, myPlanetCoord, hostileRoutes = [] }) {
  if (!mounted || !THREE) return;

  // Vide les groupes
  for (const g of [starGroup, planetGroup, routeGroup]) {
    while (g.children.length) g.remove(g.children[0]);
  }
  pickable.length = 0;
  haloRefs.length = 0;
  routeMeshes.length = 0;

  if (!system) return;

  // ─── Étoile centrale ──────────────────────────────────────
  const star = system.etoile || {};
  const stColor = STAR_COLOR[(star.type || 'G').toUpperCase()] || 0xf7e09a;
  const starMat = new THREE.MeshBasicMaterial({ color: stColor });
  const starMesh = new THREE.Mesh(new THREE.SphereGeometry(2.2, 32, 32), starMat);
  starGroup.add(starMesh);

  // Glow simple via sprite additif
  const glow = new THREE.PointLight(stColor, 2.0, 240, 1.2);
  starGroup.add(glow);

  // ─── Orbites + corps ──────────────────────────────────────
  const ORB_N = 15, RMIN = 5.5, RMAX = 38;
  const radiusFor = i => RMIN + (i - 1) * (RMAX - RMIN) / (ORB_N - 1);
  const angleFor  = i => i * 137.508 * Math.PI / 180;
  const orbitPoint = (i, t = 0) => {
    const r = radiusFor(i);
    const a = angleFor(i) + t * 0.02 * (1 / (1 + i * 0.3));
    return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
  };

  const planetByName = new Map(); // pour les routes

  for (let i = 1; i <= ORB_N; i++) {
    const pos = system.positions?.[i] || { type: 'empty' };
    if (pos.type === 'empty') continue;
    const r = radiusFor(i);

    // Anneau orbital
    {
      const pts = [];
      const seg = 96;
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const isMine = pos.nom && pos.proprietaire === (system.__currentPlayer || null);
      const m = new THREE.LineBasicMaterial({
        color: isMine ? 0xa83a25 : 0xc4b48a,
        transparent: true,
        opacity: isMine ? 0.45 : 0.18,
      });
      planetGroup.add(new THREE.Line(g, m));
    }

    if (pos.type === 'asteroide') {
      const center = orbitPoint(i);
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.22 + Math.random() * 0.2, 0),
          new THREE.MeshStandardMaterial({
            color: 0xc4b48a, roughness: 0.9, metalness: 0.1, flatShading: true,
          })
        );
        m.position.copy(center).add(new THREE.Vector3((k - 1) * 0.7, Math.random() * 0.3 - 0.15, (k % 2 ? 0.3 : -0.25)));
        m.userData = { kind: 'asteroide', i, coord: system.__coord, pos };
        planetGroup.add(m);
      }
      continue;
    }

    // Planète
    const center = orbitPoint(i);
    const grp = new THREE.Group(); grp.position.copy(center);
    const cls = pos.classe || 'tellurique';
    const color = CLASS_COLOR[cls] || 0x888888;
    const size = (CLASS_SIZE[cls] || 1) * 0.9;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 28, 28),
      new THREE.MeshStandardMaterial({
        color, roughness: 0.55, metalness: 0.05,
        emissive: new THREE.Color(color).multiplyScalar(0.10),
      })
    );
    mesh.userData = { kind: 'planete', coord: `${system.__coord}:${i}`, pos };
    grp.add(mesh);
    pickable.push(mesh);
    planetByName.set(pos.nom, { center, i });

    // Anneau gazeuse
    if (cls === 'gazeuse') {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(size * 1.5, size * 2.3, 64),
        new THREE.MeshBasicMaterial({
          color: 0xc4b48a, side: THREE.DoubleSide,
          transparent: true, opacity: 0.45,
        })
      );
      ring.rotation.x = Math.PI / 2.4;
      grp.add(ring);
    }

    // Halo doré pour MA planète
    const isMine = `${system.__coord}:${i}` === myPlanetCoord;
    if (isMine) {
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(size + 0.4, 0.05, 6, 48),
        new THREE.MeshBasicMaterial({ color: 0xf7e09a, transparent: true, opacity: 0.6 })
      );
      halo.rotation.x = Math.PI / 2;
      grp.add(halo);
      haloRefs.push({ mesh: halo, baseOpacity: 0.6 });
    }

    // Anneau phosphor si ennemi connu (couleur rouge)
    if (pos.proprietaire && pos.proprietaire !== (system.__currentPlayer || null)) {
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(size + 0.6, 0.04, 6, 48),
        new THREE.MeshBasicMaterial({ color: 0xa83a25, transparent: true, opacity: 0.45 })
      );
      halo.rotation.x = Math.PI / 2;
      grp.add(halo);
      haloRefs.push({ mesh: halo, baseOpacity: 0.45 });
    }

    planetGroup.add(grp);
  }

  // ─── Routes hostiles (courbes) ────────────────────────────
  for (const route of hostileRoutes) {
    const a = planetByName.get(route.from);
    const b = planetByName.get(route.to);
    if (!a || !b) continue;
    const mid = a.center.clone().add(b.center).multiplyScalar(0.5);
    mid.y += Math.max(3, a.center.distanceTo(b.center) * 0.18);
    const curve = new THREE.QuadraticBezierCurve3(a.center, mid, b.center);
    const geom = new THREE.TubeGeometry(curve, 64, 0.05, 6, false);
    const mat = new THREE.MeshBasicMaterial({
      color: route.kind === 'hostile' ? 0xa83a25 : 0x7fa570,
      transparent: true, opacity: 0.55,
    });
    routeGroup.add(new THREE.Mesh(geom, mat));
    const ship = new THREE.Mesh(
      new THREE.ConeGeometry(0.25, 0.6, 8),
      new THREE.MeshBasicMaterial({ color: route.kind === 'hostile' ? 0xc64a30 : 0x7fa570 })
    );
    routeGroup.add(ship);
    routeMeshes.push({ curve, ship, kind: route.kind });
  }
}

function loop() {
  if (!mounted) return;
  rafId = requestAnimationFrame(loop);
  const t = clock.elapsedTime;

  // Halo pulse
  for (const ref of haloRefs) {
    const s = 1 + Math.sin(t * 2) * 0.08;
    ref.mesh.scale.set(s, s, 1);
    ref.mesh.material.opacity = ref.baseOpacity * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2)));
  }
  // Vaisseaux le long des routes
  for (let i = 0; i < routeMeshes.length; i++) {
    const r = routeMeshes[i];
    const u = ((t * 0.13) + i * 0.3) % 1;
    const p = r.curve.getPointAt(u);
    const next = r.curve.getPointAt(Math.min(0.999, u + 0.01));
    r.ship.position.copy(p);
    r.ship.lookAt(next);
    r.ship.rotateX(Math.PI / 2);
  }

  controls.update();
  clock.getDelta();
  renderer.render(scene, camera);
}

export function isMounted() { return mounted; }
