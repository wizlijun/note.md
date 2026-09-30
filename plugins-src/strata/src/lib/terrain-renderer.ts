import * as THREE from 'three'
import type { ContourMultiPolygon } from 'd3-contour'
import { traceContour, elevation } from './contour-path'

export interface CameraView { yaw: number; pitch: number; distance: number; targetX: number; targetY: number; zoom?: number }
export interface TerrainRenderOptions {
  field: Float32Array
  grid: { width: number; height: number; bounds?: { width: number; height: number } }
  contours: ContourMultiPolygon[]
  levels: number[]
  view: CameraView
  verticalScale: number
  contourOpacity: number
  detail: number
}
export interface ProjectedPoint { x: number; y: number; visible: boolean }


/**
 * THREE r160 terrain view of the caller's scalar field; no generated mountains.
 * Coordinates passed to heightAt/project and view.targetX/Y are normalized [0,1].
 * yaw/pitch are radians (pitch is elevation above the map), distance is world units.
 * Pass a NEW field/contours reference after changing their contents. Camera-only
 * renders reuse geometry, heights, normals and the contour texture.
 */
export function createTerrain3D(canvas: HTMLCanvasElement, getInk: (token: string) => string) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 90);
  const worldWidth = 12, worldDepth = 8;
  const segmentsX = 480, segmentsY = 312;
  const geometry = new THREE.PlaneGeometry(worldWidth, worldDepth, segmentsX, segmentsY);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const rawHeights = new Float32Array(positions.count);
  const baseElevations = new Float32Array(positions.count);

  const textureCanvas = document.createElement('canvas');
  textureCanvas.width = 2048;
  textureCanvas.height = 1366;
  const textureContext = textureCanvas.getContext('2d');
  if (!textureContext) {
    geometry.dispose(); renderer.dispose();
    throw new Error('STRATA contour texture could not create a 2D context.');
  }
  const contourTexture = new THREE.CanvasTexture(textureCanvas);
  contourTexture.colorSpace = THREE.SRGBColorSpace;
  contourTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, map: contourTexture,
    roughness: 0.94, metalness: 0, side: THREE.FrontSide,
  });
  const terrain = new THREE.Mesh(geometry, material);
  terrain.castShadow = true;
  terrain.receiveShadow = true;
  scene.add(terrain);

  // A thin skirt connects actual boundary heights to a flat map slab.
  const perimeter: number[] = [];
  for (let x = 0; x <= segmentsX; x++) perimeter.push(x);
  for (let y = 1; y <= segmentsY; y++) perimeter.push(y * (segmentsX + 1) + segmentsX);
  for (let x = segmentsX - 1; x >= 0; x--) perimeter.push(segmentsY * (segmentsX + 1) + x);
  for (let y = segmentsY - 1; y > 0; y--) perimeter.push(y * (segmentsX + 1));
  const skirtGeometry = new THREE.BufferGeometry();
  const skirtPositions = new Float32Array(perimeter.length * 6);
  const skirtIndices: number[] = [];
  for (let i = 0; i < perimeter.length; i++) {
    const j = (i + 1) % perimeter.length;
    skirtIndices.push(i * 2, j * 2, i * 2 + 1, j * 2, j * 2 + 1, i * 2 + 1);
  }
  skirtGeometry.setAttribute('position', new THREE.BufferAttribute(skirtPositions, 3));
  skirtGeometry.setIndex(skirtIndices);
  const skirtMaterial = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide });
  const skirt = new THREE.Mesh(skirtGeometry, skirtMaterial);
  skirt.castShadow = true;
  skirt.receiveShadow = true;
  scene.add(skirt);

  const slabGeometry = new THREE.BoxGeometry(worldWidth + 0.035, 0.2, worldDepth + 0.035);
  const slabMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
  const slab = new THREE.Mesh(slabGeometry, slabMaterial);
  slab.position.y = -0.14;
  slab.castShadow = true;
  slab.receiveShadow = true;
  scene.add(slab);

  const groundGeometry = new THREE.PlaneGeometry(200, 200);
  const groundMaterial = new THREE.ShadowMaterial({ color: 0x1d2923, opacity: 0.16 });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.245;
  ground.receiveShadow = true;
  scene.add(ground);

  const hemisphere = new THREE.HemisphereLight(0xf4f7f1, 0x5a695d, 0.95);
  scene.add(hemisphere);
  const sunlight = new THREE.DirectionalLight(0xfff5df, 2.4);
  sunlight.position.set(-5, 10, 6);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunlight.shadow.camera, { left: -9, right: 9, top: 8, bottom: -8, near: 0.5, far: 32 });
  sunlight.shadow.bias = -0.00015;
  sunlight.shadow.normalBias = 0.028;
  sunlight.shadow.radius = 2;
  scene.add(sunlight);
  scene.add(sunlight.target);

  let field: Float32Array | null = null;
  let gridWidth = 0, gridHeight = 0, verticalScale = 1, spanX = 1, spanY = 1;
  let previousContours: ContourMultiPolygon[] | null = null;
  let previousLevels = '', previousTextureKey = '', previousPalette = '';
  let cssWidth = 1, cssHeight = 1, pixelRatio = 0, disposed = false, hasRendered = false;
  const projected = new THREE.Vector3();
  const target = new THREE.Vector3();
  const interpolatedColor = new THREE.Color();
  const lowColor = new THREE.Color(), midColor = new THREE.Color(), highColor = new THREE.Color();
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const ink = (name: string, fallback: string) => getInk(name) || fallback;

  // D3 contour coordinates place cell i at i + 0.5, rather than at i.
  function heightAt(x: number, y: number) {
    if (!field) return 0;
    const gx = clamp(finite(x, 0) * gridWidth - 0.5, 0, gridWidth - 1);
    const gy = clamp(finite(y, 0) * gridHeight - 0.5, 0, gridHeight - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, gridWidth - 1), y1 = Math.min(y0 + 1, gridHeight - 1);
    const tx = gx - x0, ty = gy - y0;
    const a = finite(field[y0 * gridWidth + x0], 0), b = finite(field[y0 * gridWidth + x1], 0);
    const c = finite(field[y1 * gridWidth + x0], 0), d = finite(field[y1 * gridWidth + x1], 0);
    return Math.max(0, (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty);
  }

  function updateHeights(resample: boolean) {
    for (let i = 0; i < positions.count; i++) {
      if (resample) {
        const x = positions.getX(i) / worldWidth + 0.5;
        const y = positions.getZ(i) / worldDepth + 0.5;
        rawHeights[i] = heightAt(x, y);
        baseElevations[i] = elevation(rawHeights[i]);
      }
      positions.setY(i, baseElevations[i] * verticalScale);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    for (let i = 0; i < perimeter.length; i++) {
      const source = perimeter[i], offset = i * 6;
      skirtPositions[offset] = skirtPositions[offset + 3] = positions.getX(source);
      skirtPositions[offset + 1] = positions.getY(source);
      skirtPositions[offset + 4] = -0.041;
      skirtPositions[offset + 2] = skirtPositions[offset + 5] = positions.getZ(source);
    }
    skirtGeometry.attributes.position.needsUpdate = true;
    skirtGeometry.computeVertexNormals();
    skirtGeometry.computeBoundingSphere();
    renderer.shadowMap.needsUpdate = true;
  }

  function updateColors() {
    const normals = geometry.attributes.normal;
    for (let i = 0; i < positions.count; i++) {
      // Fixed height transfer keeps color comparable across date ranges.
      const band = clamp(baseElevations[i] / 0.98, 0, 1);
      if (band < 0.55) interpolatedColor.copy(lowColor).lerp(midColor, band / 0.55);
      else interpolatedColor.copy(midColor).lerp(highColor, (band - 0.55) / 0.45);
      // Steep slopes expose a restrained rock color; no extra displacement/noise.
      const slope = clamp((1 - normals.getY(i) - 0.18) * 1.5, 0, 0.34);
      interpolatedColor.lerp(highColor, slope);
      interpolatedColor.toArray(colors, i * 3);
    }
    geometry.attributes.color.needsUpdate = true;
  }

  function updateTexture(contours: ContourMultiPolygon[], opacity: number, detail: number, lineColor: string) {
    const ctx = textureContext!, tw = textureCanvas.width, th = textureCanvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff'; // Multiplicative identity for vertex colors.
    ctx.fillRect(0, 0, tw, th);
    if (opacity > 0 && contours.length) {
      const sx = tw / gridWidth, sy = th / gridHeight;
      ctx.scale(sx, sy);
      ctx.strokeStyle = lineColor;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = opacity * 0.43;
      const stride = Math.max(1, Math.ceil(contours.length / detail));
      for (let i = 0; i < contours.length; i++) {
        if (i % stride !== 0 && i !== contours.length - 1) continue;
        ctx.lineWidth = (i % (stride * 4) === 0 ? 1.65 : 1.0) / Math.sqrt(sx * sy);
        ctx.beginPath(); traceContour(ctx, contours[i]); ctx.stroke();
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    contourTexture.needsUpdate = true;
  }

  function render(options: TerrainRenderOptions) {
    if (disposed) throw new Error('STRATA 3D renderer has been disposed.');
    if (renderer.getContext().isContextLost()) throw new Error('STRATA WebGL context was lost.');
    const { field: nextField, grid, contours = [], levels = [], view } = options;
    if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height)
      || grid.width < 1 || grid.height < 1 || !nextField || nextField.length !== grid.width * grid.height) {
      throw new Error('STRATA 3D field dimensions do not match the grid.');
    }
    const nextScale = clamp(finite(options.verticalScale, 1), 0, 6);
    const fieldChanged = nextField !== field || grid.width !== gridWidth || grid.height !== gridHeight;
    const scaleChanged = nextScale !== verticalScale;
    field = nextField; gridWidth = grid.width; gridHeight = grid.height; verticalScale = nextScale;
    const nextSpanX = grid.bounds?.width ?? 1, nextSpanY = grid.bounds?.height ?? 1;
    if (spanX !== nextSpanX || spanY !== nextSpanY) renderer.shadowMap.needsUpdate = true;
    spanX = nextSpanX; spanY = nextSpanY;
    const focused = spanX < 1 || spanY < 1;
    for (const mesh of [terrain, skirt, slab]) mesh.scale.set(spanX, 1, spanY);
    // A cropped high-altitude patch is a surface detail, not a new mountain from zero.
    // Keep its true Y coordinates; omit the artificial full-height wall and ground.
    skirt.visible = slab.visible = ground.visible = !focused;

    const bg = ink('--st-bg', '#f5f4ed');
    const low = ink('--st-terrain-low', '#b8c99b');
    const mid = ink('--st-terrain-mid', '#7b9872');
    const high = ink('--st-terrain-high', '#ddd5bf');
    const border = ink('--st-border', '#d8ddd3');
    const line = ink('--st-green', '#356e58');
    const paletteKey = [bg, low, mid, high, border].join('|');
    const paletteChanged = paletteKey !== previousPalette;
    if (paletteChanged) {
      lowColor.set(low); midColor.set(mid); highColor.set(high);
      scene.background = new THREE.Color(bg);
      skirtMaterial.color.copy(lowColor).multiplyScalar(0.77);
      slabMaterial.color.set(border);
      previousPalette = paletteKey;
    }
    if (fieldChanged || scaleChanged) updateHeights(fieldChanged);
    if (fieldChanged || scaleChanged || paletteChanged) updateColors();

    const opacity = clamp(finite(options.contourOpacity, 0.55), 0, 1);
    const detail = clamp(Math.round(finite(options.detail, 18)), 1, 80);
    const levelsKey = levels.join(',');
    const textureKey = [gridWidth, gridHeight, opacity, detail, line].join('|');
    if (contours !== previousContours || textureKey !== previousTextureKey || levelsKey !== previousLevels) {
      updateTexture(contours, opacity, detail, line);
      previousContours = contours; previousTextureKey = textureKey; previousLevels = levelsKey;
    }

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    if (width !== cssWidth || height !== cssHeight || dpr !== pixelRatio) {
      cssWidth = width; cssHeight = height; pixelRatio = dpr;
      renderer.setPixelRatio(dpr); renderer.setSize(width, height, false);
      camera.aspect = width / height; camera.updateProjectionMatrix();
    }
    const tx = clamp(finite(view.targetX, 0.5), 0, 1), ty = clamp(finite(view.targetY, 0.5), 0, 1);
    const heightBounds = geometry.boundingBox!;
    const targetHeight = focused ? (heightBounds.min.y + heightBounds.max.y) / 2 : Math.min(.8, elevation(heightAt(tx, ty)) * verticalScale * .5) + .12;
    target.set((tx - 0.5) * worldWidth * spanX, targetHeight, (ty - 0.5) * worldDepth * spanY);
    const yaw = finite(view.yaw, -0.38);
    const pitch = clamp(finite(view.pitch, 0.72), 0.12, Math.PI / 2 - 0.025);
    const localDistance = Math.max(14 * Math.max(spanX, spanY), 2.8 * (heightBounds.max.y - heightBounds.min.y)) * Math.max(1, .85 / camera.aspect) / clamp(finite(view.zoom ?? 1, 1), 1, 6);
    const distance = clamp(focused ? localDistance : finite(view.distance, 14), .25, 36);
    const horizontal = Math.cos(pitch) * distance;
    camera.position.set(target.x + Math.sin(yaw) * horizontal,
      target.y + Math.sin(pitch) * distance, target.z + Math.cos(yaw) * horizontal);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    hasRendered = true;
  }

  function project(point: { x: number; y: number }): ProjectedPoint {
    if (!hasRendered || disposed) return { x: 0, y: 0, visible: false };
    const x = finite(point.x, 0), y = finite(point.y, 0);
    const wx = (x - 0.5) * worldWidth * spanX, wz = (y - 0.5) * worldDepth * spanY;
    const wy = elevation(heightAt(x, y)) * verticalScale + 0.028;
    projected.set(wx, wy, wz).project(camera);
    let visible = x >= 0 && x <= 1 && y >= 0 && y <= 1
      && projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
    // Heightfield ray marching avoids labels appearing through foreground ridges.
    if (visible) for (let step = 1; step < 40; step++) {
      const t = step / 40;
      const rx = wx + (camera.position.x - wx) * t, rz = wz + (camera.position.z - wz) * t;
      const nx = rx / (worldWidth * spanX) + 0.5, ny = rz / (worldDepth * spanY) + 0.5;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
      const rayY = wy + (camera.position.y - wy) * t;
      if (elevation(heightAt(nx, ny)) * verticalScale > rayY + 0.035) { visible = false; break; }
    }
    return { x: (projected.x + 1) * cssWidth / 2, y: (1 - projected.y) * cssHeight / 2, visible };
  }

  function dispose() {
    if (disposed) return;
    disposed = true; field = null; previousContours = null;
    geometry.dispose(); skirtGeometry.dispose(); slabGeometry.dispose(); groundGeometry.dispose();
    material.dispose(); skirtMaterial.dispose(); slabMaterial.dispose(); groundMaterial.dispose();
    contourTexture.dispose(); sunlight.shadow.map?.dispose();
    renderer.renderLists.dispose(); renderer.dispose();
    scene.clear();
    textureCanvas.width = textureCanvas.height = 1;
  }

  return { render, project, heightAt, dispose };
}
