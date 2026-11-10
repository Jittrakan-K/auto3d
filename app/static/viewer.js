import * as THREE from "three";
import { OrbitControls } from "/vendor/OrbitControls.js";
import { STLLoader } from "/vendor/STLLoader.js";
import { RoomEnvironment } from "/vendor/RoomEnvironment.js";

// Directions follow SOLIDWORKS (Y up). Third angle layout: top above front, right beside it.
const DIRS = {
  iso: { dir: [1, 0.8, 1], up: [0, 1, 0] },
  front: { dir: [0, 0, 1], up: [0, 1, 0] },
  top: { dir: [0, 1, 0], up: [0, 0, -1] },
  right: { dir: [1, 0, 0], up: [0, 1, 0] },
};
const QUAD = [["top", 0, 1], ["iso", 1, 1], ["front", 0, 0], ["right", 1, 0]]; // view, column, row from bottom
const INK = 0x1a1d1c;

export class Viewer {
  constructor(host) {
    this.host = host;
    this.mode = "quad";
    this.single = "iso";
    this.look = "line";
    this.radius = 100;
    this.center = new THREE.Vector3();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xffffff, 0);
    this.renderer.autoClear = false;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.environment = new THREE.PMREMGenerator(this.renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.8;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.cams = {};
    for (const name of Object.keys(DIRS)) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
      const key = new THREE.DirectionalLight(0xffffff, 1.1);
      key.position.set(-0.4, 0.7, 1);
      cam.add(key);
      this.scene.add(cam);
      this.cams[name] = cam;
    }

    this.lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.shadeMat = new THREE.MeshStandardMaterial({
      color: 0xd9dee0, metalness: 0.55, roughness: 0.42, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });

    this.controls = new OrbitControls(this.cams.iso, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  get active() { return this.mode === "quad" ? "iso" : this.single; }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.frame();
  }

  // Every view shares one scale, as on a real drawing.
  frame() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    const pw = this.mode === "quad" ? w / 2 : w;
    const ph = this.mode === "quad" ? h / 2 : h;
    const r = this.radius * (this.mode === "quad" ? 1.2 : 1.1);
    const halfH = Math.max(r, r * (ph / pw));
    const halfW = halfH * (pw / ph);
    for (const cam of Object.values(this.cams)) {
      Object.assign(cam, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
      cam.updateProjectionMatrix();
    }
    this.render();
  }

  place(name) {
    const v = DIRS[name];
    const cam = this.cams[name];
    const dist = this.radius * 6;
    cam.position.copy(this.center).add(new THREE.Vector3(...v.dir).normalize().multiplyScalar(dist));
    cam.up.set(...v.up);
    cam.near = 0.1;
    cam.far = dist * 4;
    cam.zoom = 1;
    cam.lookAt(this.center);
    cam.updateProjectionMatrix();
  }

  setView(name) {
    if (name === "quad") this.mode = "quad";
    else { this.mode = "single"; this.single = name; }
    for (const n of Object.keys(DIRS)) this.place(n);
    this.controls.object = this.cams[this.active];
    this.controls.target.copy(this.center);
    this.controls.update();
    this.frame();
  }

  setLook(look) {
    this.look = look;
    if (this.mesh) this.mesh.material = look === "line" ? this.lineMat : this.shadeMat;
    this.render();
  }

  async load(url) {
    const geometry = await new STLLoader().loadAsync(url);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    this.group.clear();
    this.mesh = new THREE.Mesh(geometry, this.look === "line" ? this.lineMat : this.shadeMat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: INK }));
    this.group.add(this.mesh, edges);
    this.center.copy(geometry.boundingSphere.center);
    this.radius = geometry.boundingSphere.radius || 1;
    this.setView(this.mode === "quad" ? "quad" : this.single);
  }

  render() {
    const { clientWidth: w, clientHeight: h } = this.host;
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.clear();
    if (this.mode !== "quad") {
      r.render(this.scene, this.cams[this.single]);
      return;
    }
    const pw = Math.floor(w / 2), ph = Math.floor(h / 2);
    r.setScissorTest(true);
    for (const [name, col, row] of QUAD) {
      r.setViewport(col * pw, row * ph, pw, ph);
      r.setScissor(col * pw, row * ph, pw, ph);
      r.render(this.scene, this.cams[name]);
    }
    r.setScissorTest(false);
  }
}
