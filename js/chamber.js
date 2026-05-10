(() => {
  const canvas = document.getElementById("three-canvas");
  if (!canvas) return;

  // Use global encoding if available
  const encodeAddress = (n) => window.encodeAddress ? window.encodeAddress(n) : n.toString();
  const decodeAddress = (s) => window.decodeAddress ? window.decodeAddress(s) : BigInt(1);

  // Use a fallback charset for titles if not initialized
  const titleCharset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  function generateBookTitle(rng) {
    let title = "";
    const maxLength = 200;

    while (title.length < maxLength) {
      const wordLen = Math.floor(rng() * 6) + 3;
      let word = "";
      for (let j = 0; j < wordLen; j++) {
        word += titleCharset[Math.floor(rng() * titleCharset.length)];
      }
      title += word + " ";
    }
    return title.trim() + "...";
  }



  function hashBigInt(n) {
    let hash = 0x811c9dc5;
    let str = n.toString();
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  function mulberry32(a) {
    return function () {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const config = {
    currentAddress: BigInt(1),
    radius: 650,
    wellRadius: 100,
    height: 350,
    depth: 180,
    roughness: 1.0,
    density: 2,
    centerType: "OPEN",
    centerSides: 6,
    spiralMode: "up",
    layout: [],
  };

  const COLOR_PAPER = 0x1a1816;
  const COLOR_FILL_LIGHT = 0x2d2a26;
  const COLOR_FILL_MID = 0x24211e;
  const COLOR_FILL_DARK = 0x1e1c1a;
  const COLOR_ABYSS = 0x121110;
  const COLOR_PILLAR = 0x0a0908;
  const COLOR_BOOK_1 = 0x332f2b;
  const COLOR_BOOK_2 = 0x383430;
  const COLOR_BOOK_3 = 0x2c2926;

  const cVec = (hex, opacity = 1) => {
    const c = new THREE.Color(hex);
    if (opacity < 1) c.lerp(new THREE.Color(COLOR_PAPER), 1 - opacity);
    return c;
  };

  const INK_MAIN = cVec(0xa39a90, 0.7);
  const INK_FAINT = cVec(0x857d74, 0.4);
  const INK_HEAVY = cVec(0xcbc0b4, 0.95);

  class GeometryBuilder {
    constructor() {
      this.solidV = [];
      this.solidC = [];
      this.sketchV = [];
      this.sketchC = [];
    }

    addSketchLine(p1, p2, color = INK_MAIN, densityMulti = 1, thickness = 1) {
      let rng = mulberry32(hashBigInt(config.currentAddress) + p1.x + p1.y + p2.z);
      const passes = Math.ceil(config.density * densityMulti);
      const r = config.roughness;

      for (let i = 0; i < passes; i++) {
        let j1 = new THREE.Vector3((rng() - 0.5) * r, (rng() - 0.5) * r, (rng() - 0.5) * r);
        let j2 = new THREE.Vector3((rng() - 0.5) * r, (rng() - 0.5) * r, (rng() - 0.5) * r);

        let start = p1.clone().add(j1);
        let end = p2.clone().add(j2);

        if (p1.distanceTo(p2) > 40 && r > 0) {
          let mid = p1.clone().lerp(p2, 0.5);
          mid.add(new THREE.Vector3((rng() - 0.5) * r * 2, (rng() - 0.5) * r * 2, (rng() - 0.5) * r * 2));

          this.sketchV.push(start.x, start.y, start.z, mid.x, mid.y, mid.z);
          this.sketchC.push(color.r, color.g, color.b, color.r, color.g, color.b);

          this.sketchV.push(mid.x, mid.y, mid.z, end.x, end.y, end.z);
          this.sketchC.push(color.r, color.g, color.b, color.r, color.g, color.b);
        } else {
          this.sketchV.push(start.x, start.y, start.z, end.x, end.y, end.z);
          this.sketchC.push(color.r, color.g, color.b, color.r, color.g, color.b);
        }

        if (thickness > 1) {
          let offset = new THREE.Vector3((rng() - 0.5) * 1.5, (rng() - 0.5) * 1.5, (rng() - 0.5) * 1.5);
          this.sketchV.push(start.x + offset.x, start.y + offset.y, start.z + offset.z);
          this.sketchV.push(end.x + offset.x, end.y + offset.y, end.z + offset.z);
          this.sketchC.push(color.r, color.g, color.b, color.r, color.g, color.b);
        }
      }
    }

    addSolidQuad(p1, p2, p3, p4, colorHex) {
      const col = new THREE.Color(colorHex);
      this.solidV.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
      this.solidC.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
      this.solidV.push(p1.x, p1.y, p1.z, p3.x, p3.y, p3.z, p4.x, p4.y, p4.z);
      this.solidC.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    }

    addSolidTriangle(p1, p2, p3, colorHex) {
      const col = new THREE.Color(colorHex);
      this.solidV.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
      this.solidC.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    }

    build() {
      const group = new THREE.Group();
      if (this.solidV.length > 0) {
        const solidGeo = new THREE.BufferGeometry();
        solidGeo.setAttribute("position", new THREE.Float32BufferAttribute(this.solidV, 3));
        solidGeo.setAttribute("color", new THREE.Float32BufferAttribute(this.solidC, 3));
        solidGeo.computeVertexNormals();

        const solidMat = new THREE.MeshBasicMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        const solidMesh = new THREE.Mesh(solidGeo, solidMat);
        solidMesh.frustumCulled = false;
        solidMesh.userData = { isBlocker: true };
        group.add(solidMesh);
        interactables.push(solidMesh);
      }

      if (this.sketchV.length > 0) {
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(this.sketchV, 3));
        lineGeo.setAttribute("color", new THREE.Float32BufferAttribute(this.sketchC, 3));

        const lineMat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.85,
        });
        const lineMesh = new THREE.LineSegments(lineGeo, lineMat);
        lineMesh.frustumCulled = false;
        group.add(lineMesh);
      }
      return group;
    }
  }

  function getHexVertices(radius, yLevel) {
    let pts = [];
    const angles = [90, 150, 210, 270, 330, 30];
    for (let i = 0; i < 6; i++) {
      let rad = angles[i] * Math.PI / 180;
      pts.push(new THREE.Vector3(radius * Math.cos(rad), yLevel, radius * -Math.sin(rad)));
    }
    return pts;
  }

  function getPolygonVertices(radius, yLevel, sides, rotationOffset = 0) {
    let pts = [];
    let offset = sides % 2 === 0 ? Math.PI / sides : 0;
    offset += rotationOffset;
    for (let i = 0; i < sides; i++) {
      let rad = i * Math.PI * 2 / sides + offset;
      pts.push(new THREE.Vector3(radius * Math.cos(rad), yLevel, radius * -Math.sin(rad)));
    }
    return pts;
  }

  function getHexXBound(z, R) {
    let absZ = Math.abs(z);
    let halfR = R * 0.5;
    let width = R * Math.cos(Math.PI / 6);
    if (absZ <= halfR) return width;
    if (absZ <= R) {
      let t = (absZ - halfR) / halfR;
      return width * (1 - t);
    }
    return 0;
  }

  function getCircleXBound(z, r) {
    if (Math.abs(z) >= r) return 0;
    return Math.sqrt(r * r - z * z);
  }

  function getRoomBaseData(addrBigInt) {
    let seed = hashBigInt(addrBigInt);
    let rng = mulberry32(seed);

    const minRadius = 550;
    const maxRadius = 850;
    const minHeight = 300;
    const maxHeight = 500;
    const minClearance = 250;
    const sizeBias = 0.6;

    let radius = Math.floor(Math.pow(rng(), sizeBias) * (maxRadius - minRadius)) + minRadius;
    let height = Math.floor(Math.pow(rng(), sizeBias) * (maxHeight - minHeight)) + minHeight;

    let roughness = rng() * 3.0;
    let density = Math.floor(rng() * 4) + 1;

    const centerTypes = ["OPEN", "PILLAR_BOOKS", "READING_PIT", "SPIRAL_STAIRS"];
    let centerType = centerTypes[Math.floor(rng() * centerTypes.length)];
    const sidesOptions = [3, 4, 6, 8];
    let centerSides = sidesOptions[Math.floor(rng() * sidesOptions.length)];

    const minWellRadius = 100;
    if (radius < minWellRadius + minClearance) {
      radius = minWellRadius + minClearance;
    }
    const maxWellRadius = Math.min(160, Math.max(minWellRadius, radius - minClearance));
    let wellRadius = Math.floor(Math.pow(rng(), 0.7) * (maxWellRadius - minWellRadius)) + minWellRadius;

    let isFromSpiralUp = addrBigInt % BigInt(10) === BigInt(7);
    let isFromSpiralDown = addrBigInt % BigInt(10) === BigInt(8);
    if (isFromSpiralUp || isFromSpiralDown) centerType = "SPIRAL_STAIRS";

    let spiralMode = null;
    if (centerType === "SPIRAL_STAIRS") {
      if (isFromSpiralUp) spiralMode = "down";
      else if (isFromSpiralDown) spiralMode = "up";
      else spiralMode = rng() > 0.5 ? "up" : "down";
    }

    let walls = [];
    const passageTypes = ["HALLWAY", "STAIRS_DOWN", "STAIRS_UP"];
    for (let i = 0; i < 6; i++) {
      if (rng() > 0.65) walls.push(passageTypes[Math.floor(rng() * passageTypes.length)]);
      else walls.push("BOOKS");
    }

    if (!walls.some((w) => passageTypes.includes(w))) {
      walls[Math.floor(rng() * 6)] = passageTypes[Math.floor(rng() * passageTypes.length)];
    }
    return { radius, height, roughness, density, walls, centerType, centerSides, wellRadius, spiralMode };
  }

  function generateLayoutForAddress(addr) {
    let room = getRoomBaseData(addr);
    let isFromSpiralUp = addr % BigInt(10) === BigInt(7);
    let isFromSpiralDown = addr % BigInt(10) === BigInt(8);

    if (addr !== BigInt(1) && !isFromSpiralUp && !isFromSpiralDown) {
      let parentAddr = addr / BigInt(6);
      let entryDir = Number(addr % BigInt(6));
      let myDoorToParent = (entryDir + 3) % 6;
      let parentRoom = getRoomBaseData(parentAddr);
      let incomingPassage = parentRoom.walls[entryDir];

      let inverse = "HALLWAY";
      if (incomingPassage === "STAIRS_UP") inverse = "STAIRS_DOWN";
      else if (incomingPassage === "STAIRS_DOWN") inverse = "STAIRS_UP";
      room.walls[myDoorToParent] = inverse;
    }

    config.radius = room.radius;
    config.wellRadius = room.wellRadius;
    config.height = room.height;
    config.roughness = room.roughness;
    config.density = room.density;
    config.layout = room.walls;
    config.centerType = room.centerType;
    config.centerSides = room.centerSides;
    config.spiralMode = room.spiralMode || "up";

    updateChamberInput();
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, (window.innerWidth - 320) / window.innerHeight, 1, 5000);
  camera.position.set(1200, 820, 1200);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  window.__orbitControls = controls; // expose for modal input gating
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 500;
  controls.maxDistance = 2600;

  let preZoomPos = null;
  let preZoomTarget = null;
  let preZoomFOV = 45;
  let interactables = [];

  function onWindowResize() {
    const width = window.innerWidth - 320;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }
  window.addEventListener("resize", onWindowResize);
  onWindowResize();

  function buildBookshelfWall(p1, p2, yBase, yTop, shadeColorHex, wallIndex = 1) {
    const builder = new GeometryBuilder();
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    const nx = dz / length;
    const nz = -dx / length;

    const shelfDepth = 15;
    const p1_back = new THREE.Vector3(p1.x - nx * shelfDepth, yBase, p1.z - nz * shelfDepth);
    const p2_back = new THREE.Vector3(p2.x - nx * shelfDepth, yBase, p2.z - nz * shelfDepth);

    builder.addSolidQuad(p1_back, p2_back, new THREE.Vector3(p2_back.x, yTop, p2_back.z), new THREE.Vector3(p1_back.x, yTop, p1_back.z), shadeColorHex);
    builder.addSolidQuad(new THREE.Vector3(p1.x, yTop, p1.z), new THREE.Vector3(p2.x, yTop, p2.z), new THREE.Vector3(p2_back.x, yTop, p2_back.z), new THREE.Vector3(p1_back.x, yTop, p1_back.z), COLOR_FILL_DARK);

    builder.addSketchLine(p1, p2, INK_HEAVY, 1, 2);
    builder.addSketchLine(new THREE.Vector3(p1.x, yTop, p1.z), new THREE.Vector3(p2.x, yTop, p2.z), INK_HEAVY, 1.5, 2);
    builder.addSketchLine(new THREE.Vector3(p1_back.x, yTop, p1_back.z), new THREE.Vector3(p2_back.x, yTop, p2_back.z), INK_MAIN, 1);
    builder.addSketchLine(new THREE.Vector3(p1.x, yTop, p1.z), new THREE.Vector3(p1_back.x, yTop, p1_back.z), INK_MAIN, 1);
    builder.addSketchLine(new THREE.Vector3(p2.x, yTop, p2.z), new THREE.Vector3(p2_back.x, yTop, p2_back.z), INK_MAIN, 1);

    const numShelves = 7;
    const shelfH = (yTop - yBase) / numShelves;
    const bookColors = [COLOR_BOOK_1, COLOR_BOOK_2, COLOR_BOOK_3, shadeColorHex];
    let rng = mulberry32(hashBigInt(config.currentAddress) + Math.floor(p1.x));
    let generatedBooksData = [];

    for (let s = 1; s < numShelves; s++) {
      let yS = yBase + s * shelfH;
      let s1 = new THREE.Vector3(p1.x, yS, p1.z),
        s2 = new THREE.Vector3(p2.x, yS, p2.z);
      let s1_b = new THREE.Vector3(p1_back.x, yS, p1_back.z),
        s2_b = new THREE.Vector3(p2_back.x, yS, p2_back.z);

      builder.addSolidQuad(s1, s2, s2_b, s1_b, COLOR_FILL_MID);
      builder.addSketchLine(s1, s2, INK_MAIN, 1, 1.5);

      let numBooks = Math.floor(rng() * 22) + 3;
      let slotWidth = 0.96 / numBooks;
      let currentT = 0.02;

      for (let b = 0; b < numBooks; b++) {
        let blockW_t = slotWidth * (0.5 + rng() * 0.45);
        let jitter = rng() * (slotWidth - blockW_t);
        let t = currentT + jitter;

        if (t + blockW_t > 0.98) blockW_t = 0.98 - t;

        if (blockW_t > 0.005) {
          let bookH = shelfH * (0.6 + rng() * 0.35);
          let bookD = shelfDepth * (0.7 + rng() * 0.3);

          let b1x = p1.x + dx * t,
            b1z = p1.z + dz * t;
          let b2x = p1.x + dx * (t + blockW_t),
            b2z = p1.z + dz * (t + blockW_t);

          let bf1 = new THREE.Vector3(b1x, yS, b1z),
            bf2 = new THREE.Vector3(b2x, yS, b2z);
          let bb1 = new THREE.Vector3(b1x - nx * bookD, yS, b1z - nz * bookD),
            bb2 = new THREE.Vector3(b2x - nx * bookD, yS, b2z - nz * bookD);
          let tf1 = new THREE.Vector3(b1x, yS + bookH, b1z),
            tf2 = new THREE.Vector3(b2x, yS + bookH, b2z);
          let tb1 = new THREE.Vector3(b1x - nx * bookD, yS + bookH, b1z - nz * bookD),
            tb2 = new THREE.Vector3(b2x - nx * bookD, yS + bookH, b2z - nz * bookD);
          let bColor = bookColors[Math.floor(rng() * bookColors.length)];

          builder.addSolidQuad(bf1, bf2, tf2, tf1, bColor);
          builder.addSolidQuad(tf1, tf2, tb2, tb1, bColor);
          builder.addSolidQuad(bb1, bf1, tf1, tb1, bColor);
          builder.addSolidQuad(bf2, bb2, tb2, tf2, bColor);
          builder.addSketchLine(bf1, bf2, INK_MAIN, 0.8);
          builder.addSketchLine(tf1, tf2, INK_MAIN, 0.8);
          builder.addSketchLine(bf1, tf1, INK_MAIN, 0.8);
          builder.addSketchLine(bf2, tf2, INK_MAIN, 0.8);
          builder.addSketchLine(tf1, tb1, INK_MAIN, 0.5);
          builder.addSketchLine(tf2, tb2, INK_MAIN, 0.5);

          let innerSpines = Math.floor(blockW_t * length / 5);
          for (let i = 1; i < innerSpines; i++) {
            let st = t + blockW_t * (i / innerSpines);
            let sp1 = new THREE.Vector3(p1.x + dx * st, yS, p1.z + dz * st);
            let sp2 = new THREE.Vector3(sp1.x, yS + bookH, sp1.z);
            builder.addSketchLine(sp1, sp2, INK_FAINT, 0.5);
          }

          let bookSeed = hashBigInt(config.currentAddress) + Math.floor(p1.x) * 1000 + Math.floor(p1.z) * 100 + s * 50 + b;
          generatedBooksData.push({ xStart: t * length, xEnd: (t + blockW_t) * length, yBase: yS, yTop: yS + bookH, seed: bookSeed });
        }

        currentT += slotWidth;
      }
    }

    const group = builder.build();

    const hitOffset = 2;
    const h_p1 = new THREE.Vector3(p1.x + nx * hitOffset, yBase, p1.z + nz * hitOffset);
    const h_p2 = new THREE.Vector3(p2.x + nx * hitOffset, yBase, p2.z + nz * hitOffset);

    const hitGeo = new THREE.BufferGeometry();
    const hitVerts = new Float32Array([
      h_p1.x, yBase, h_p1.z, h_p2.x, yBase, h_p2.z, h_p2.x, yTop, h_p2.z,
      h_p1.x, yBase, h_p1.z, h_p2.x, yTop, h_p2.z, h_p1.x, yTop, h_p1.z,
    ]);
    hitGeo.setAttribute("position", new THREE.BufferAttribute(hitVerts, 3));
    const hitMesh = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
    hitMesh.userData = { isBookshelf: true, p1: p1, p2: p2, nx: nx, nz: nz, books: generatedBooksData, parentGroup: group, length: length, wallIndex: wallIndex };
    hitMesh.frustumCulled = false;

    group.add(hitMesh);
    interactables.push(hitMesh);

    return group;
  }

  function buildPassage(p1, p2, type, passageIndex) {
    const builder = new GeometryBuilder();
    let midX = (p1.x + p2.x) / 2,
      midZ = (p1.z + p2.z) / 2;
    let distToCenter = Math.sqrt(midX * midX + midZ * midZ);
    let nx = midX / distToCenter,
      nz = midZ / distToCenter;

    let extL = config.radius * 0.7;
    let p1_out = new THREE.Vector3(p1.x + nx * extL, 0, p1.z + nz * extL);
    let p2_out = new THREE.Vector3(p2.x + nx * extL, 0, p2.z + nz * extL);
    let yEndFloor = type === "STAIRS_DOWN" ? -config.depth : type === "STAIRS_UP" ? config.height : 0;
    p1_out.y = yEndFloor;
    p2_out.y = yEndFloor;

    builder.addSketchLine(p1, p1_out, INK_MAIN, 1.5);
    builder.addSketchLine(p2, p2_out, INK_MAIN, 1.5);

    if (type === "HALLWAY") {
      builder.addSolidQuad(p1, p2, p2_out, p1_out, COLOR_PAPER);
      builder.addSketchLine(p1_out, p2_out, INK_FAINT, 1);
    } else {
      const steps = 25;
      for (let i = 0; i < steps; i++) {
        let f1 = i / steps;
        let f2 = (i + 1) / steps;
        let y1 = f1 * yEndFloor;
        let y2 = f2 * yEndFloor;

        let pt1_1 = p1.clone().lerp(p1_out, f1).setY(y1);
        let pt2_1 = p2.clone().lerp(p2_out, f1).setY(y1);
        let pt1_2 = p1.clone().lerp(p1_out, f2).setY(y1);
        let pt2_2 = p2.clone().lerp(p2_out, f2).setY(y1);

        builder.addSolidQuad(pt1_1, pt2_1, pt2_2, pt1_2, COLOR_FILL_LIGHT);
        builder.addSketchLine(pt1_1, pt2_1, INK_MAIN, 1, 1.5);

        if (i < steps - 1) {
          let pt1_3 = pt1_2.clone().setY(y2);
          let pt2_3 = pt2_2.clone().setY(y2);
          builder.addSolidQuad(pt1_2, pt2_2, pt2_3, pt1_3, COLOR_FILL_DARK);
          builder.addSketchLine(pt1_2, pt2_2, INK_HEAVY, 1);
        }
      }
    }

    if (type !== "HALLWAY") {
      let yAbyssTop = Math.max(config.height, yEndFloor + 100);
      let yAbyssBot = Math.min(-config.depth, yEndFloor - 100);
      let ab1 = new THREE.Vector3(p1_out.x, yAbyssBot, p1_out.z),
        ab2 = new THREE.Vector3(p2_out.x, yAbyssBot, p2_out.z);
      let ab3 = new THREE.Vector3(p2_out.x, yAbyssTop, p2_out.z),
        ab4 = new THREE.Vector3(p1_out.x, yAbyssTop, p1_out.z);
      builder.addSolidQuad(ab1, ab2, ab3, ab4, COLOR_ABYSS);
      for (let f = 0; f <= 1; f += 0.04) builder.addSketchLine(ab1.clone().lerp(ab2, f), ab4.clone().lerp(ab3, f), INK_MAIN, 1.5);
    }

    builder.addSolidQuad(p1, p1_out, new THREE.Vector3(p1_out.x, config.height, p1_out.z), new THREE.Vector3(p1.x, config.height, p1.z), COLOR_FILL_LIGHT);
    builder.addSolidQuad(p2, p2_out, new THREE.Vector3(p2_out.x, config.height, p2_out.z), new THREE.Vector3(p2.x, config.height, p2.z), COLOR_FILL_DARK);
    builder.addSketchLine(new THREE.Vector3(p1.x, config.height, p1.z), new THREE.Vector3(p1_out.x, config.height, p1_out.z), INK_MAIN, 1);
    builder.addSketchLine(new THREE.Vector3(p2.x, config.height, p2.z), new THREE.Vector3(p2_out.x, config.height, p2_out.z), INK_MAIN, 1);

    const group = builder.build();

    let nextAddr = BigInt(1);
    let myDoorToParent = -1;
    let isFromSpiralUp = config.currentAddress % BigInt(10) === BigInt(7);
    let isFromSpiralDown = config.currentAddress % BigInt(10) === BigInt(8);

    if (config.currentAddress !== BigInt(1) && !isFromSpiralUp && !isFromSpiralDown) {
      myDoorToParent = (Number(config.currentAddress % BigInt(6)) + 3) % 6;
    }

    if (passageIndex === myDoorToParent) nextAddr = config.currentAddress / BigInt(6);
    else nextAddr = config.currentAddress * BigInt(6) + BigInt(passageIndex);

    const hitOffset = 2;
    const hitGeo = new THREE.BufferGeometry();
    const fVerts = new Float32Array([
      p1.x, p1.y + hitOffset, p1.z, p2.x, p2.y + hitOffset, p2.z, p2_out.x, p2_out.y + hitOffset, p2_out.z,
      p1.x, p1.y + hitOffset, p1.z, p2_out.x, p2_out.y + hitOffset, p2_out.z, p1_out.x, p1_out.y + hitOffset, p1_out.z,
    ]);
    hitGeo.setAttribute("position", new THREE.BufferAttribute(fVerts, 3));

    let isReturn = passageIndex === myDoorToParent;
    const hitMesh = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
    hitMesh.userData = { isPassage: true, passageIndex: passageIndex, targetAddress: nextAddr, isReturn: isReturn, type: type, parentGroup: group };
    hitMesh.frustumCulled = false;

    group.add(hitMesh);
    interactables.push(hitMesh);

    return group;
  }

  function buildPillarsAndFloor() {
    const builder = new GeometryBuilder();
    const R = config.radius;
    const rWell = config.wellRadius;
    const H = config.height;
    const V_out = getHexVertices(R, 0);

    if (config.centerType === "SPIRAL_STAIRS" && config.spiralMode === "down") {
      const holeRadius = rWell + 8;
      const V_in = getHexVertices(holeRadius, 0);
      for (let i = 0; i < 6; i++) {
        builder.addSolidQuad(V_in[i], V_in[(i + 1) % 6], V_out[(i + 1) % 6], V_out[i], COLOR_FILL_LIGHT);
      }
    } else {
      for (let i = 0; i < 6; i++) builder.addSolidTriangle(new THREE.Vector3(0, 0, 0), V_out[i], V_out[(i + 1) % 6], COLOR_FILL_LIGHT);
    }

    for (let z = -R; z <= R; z += 12) {
      let limitOut = getHexXBound(z, R);
      let limitIn = config.centerType !== "OPEN" ? getCircleXBound(z, rWell + 10) : 0;
      if (limitOut > 0) {
        if (limitIn > 0) {
          builder.addSketchLine(new THREE.Vector3(-limitOut, 0.2, z), new THREE.Vector3(-limitIn, 0.2, z), INK_FAINT, 0.5);
          builder.addSketchLine(new THREE.Vector3(limitIn, 0.2, z), new THREE.Vector3(limitOut, 0.2, z), INK_FAINT, 0.5);
        } else {
          builder.addSketchLine(new THREE.Vector3(-limitOut, 0.2, z), new THREE.Vector3(limitOut, 0.2, z), INK_FAINT, 0.5);
        }
      }
    }
    for (let i = 0; i < 6; i++) {
      builder.addSketchLine(new THREE.Vector3(0, 0.2, 0), V_out[i], INK_FAINT, 1.0);
      builder.addSketchLine(V_out[i], V_out[(i + 1) % 6], INK_MAIN, 1);
    }

    for (let i = 0; i < 6; i++) {
      const pos = V_out[i];
      const r = 18;
      const angle = Math.atan2(pos.z, pos.x);
      let p1 = new THREE.Vector3(pos.x + Math.cos(angle) * r, pos.y, pos.z + Math.sin(angle) * r);
      let p2 = new THREE.Vector3(pos.x + Math.cos(angle + 2.5) * r * 0.7, pos.y, pos.z + Math.sin(angle + 2.5) * r * 0.7);
      let p3 = new THREE.Vector3(pos.x + Math.cos(angle - 2.5) * r * 0.7, pos.y, pos.z + Math.sin(angle - 2.5) * r * 0.7);
      let p1_t = new THREE.Vector3(p1.x, H, p1.z),
        p2_t = new THREE.Vector3(p2.x, H, p2.z),
        p3_t = new THREE.Vector3(p3.x, H, p3.z);

      builder.addSolidQuad(p1, p2, p2_t, p1_t, COLOR_PILLAR);
      builder.addSolidQuad(p2, p3, p3_t, p2_t, COLOR_PILLAR);
      builder.addSolidQuad(p3, p1, p1_t, p3_t, COLOR_PILLAR);
      builder.addSketchLine(p1, p1_t, INK_HEAVY, 1.5, 2);
      builder.addSketchLine(p2, p2_t, INK_HEAVY, 1.5, 2);
      builder.addSketchLine(p3, p3_t, INK_HEAVY, 1.5, 2);
    }
    return builder.build();
  }

  function buildCenterStructure() {
    const builder = new GeometryBuilder();
    const group = new THREE.Group();
    const rWell = config.wellRadius;
    const H = config.height;
    const wallShades = [COLOR_FILL_LIGHT, COLOR_FILL_DARK, COLOR_FILL_DARK, COLOR_FILL_MID, COLOR_FILL_MID, COLOR_FILL_LIGHT];
    const V_center = getPolygonVertices(rWell, 0.1, config.centerSides);

    if (config.centerType === "READING_PIT") {
      const depth = 50;
      const V_pit_bot = getPolygonVertices(rWell, -depth, config.centerSides);
      for (let i = 0; i < config.centerSides; i++) {
        builder.addSolidTriangle(new THREE.Vector3(0, -depth, 0), V_pit_bot[i], V_pit_bot[(i + 1) % config.centerSides], COLOR_FILL_MID);
        builder.addSolidQuad(V_center[i], V_center[(i + 1) % config.centerSides], V_pit_bot[(i + 1) % config.centerSides], V_pit_bot[i], COLOR_FILL_DARK);
        builder.addSketchLine(V_center[i], V_center[(i + 1) % config.centerSides], INK_HEAVY, 1.5);
        builder.addSketchLine(V_pit_bot[i], V_pit_bot[(i + 1) % config.centerSides], INK_MAIN, 1);
        builder.addSketchLine(V_center[i], V_pit_bot[i], INK_MAIN, 1);
      }
      group.add(builder.build());
    } else if (config.centerType === "PILLAR_BOOKS") {
      for (let i = 0; i < config.centerSides; i++) {
        let shelfGroup = buildBookshelfWall(V_center[(i + 1) % config.centerSides], V_center[i], 0, H, wallShades[i % 6], i + 1);
        group.add(shelfGroup);
      }
      for (let s = 1; s <= 3; s++) {
        let yLevel = s * (H / 4);
        let V_inner = getPolygonVertices(rWell - 2, yLevel, config.centerSides);
        let V_outer = getPolygonVertices(rWell + 28, yLevel, config.centerSides);
        for (let i = 0; i < config.centerSides; i++) {
          builder.addSolidQuad(V_inner[i], V_outer[i], V_outer[(i + 1) % config.centerSides], V_inner[(i + 1) % config.centerSides], COLOR_FILL_LIGHT);
          builder.addSketchLine(V_outer[i], V_outer[(i + 1) % config.centerSides], INK_HEAVY, 1.5);
          builder.addSketchLine(V_outer[i], V_inner[i].clone().setY(yLevel - 30), INK_FAINT, 1);
        }
      }
      group.add(builder.build());
    } else if (config.centerType === "SPIRAL_STAIRS") {
      const isDown = config.spiralMode === "down";
      const stairHeight = isDown ? config.depth : H;
      const yDir = isDown ? -1 : 1;
      for (let i = 0; i < config.centerSides; i++) {
        let p1 = getPolygonVertices(rWell * 0.3, 0, config.centerSides)[i];
        let p2 = getPolygonVertices(rWell * 0.3, 0, config.centerSides)[(i + 1) % config.centerSides];
        builder.addSolidQuad(p1, p2, new THREE.Vector3(p2.x, yDir * stairHeight, p2.z), new THREE.Vector3(p1.x, yDir * stairHeight, p1.z), COLOR_FILL_DARK);
      }
      const numSteps = 40;
      for (let i = 0; i < numSteps; i++) {
        let angle = (i / numSteps) * Math.PI * 4,
          angle2 = ((i + 1) / numSteps) * Math.PI * 4;
        let y1 = yDir * (i / numSteps) * stairHeight,
          y2 = yDir * ((i + 1) / numSteps) * stairHeight;

        let p1 = new THREE.Vector3(Math.cos(angle) * rWell, y1, -Math.sin(angle) * rWell),
          p2 = new THREE.Vector3(Math.cos(angle2) * rWell, y2, -Math.sin(angle2) * rWell);
        let pInner1 = new THREE.Vector3(Math.cos(angle) * rWell * 0.3, y1, -Math.sin(angle) * rWell * 0.3),
          pInner2 = new THREE.Vector3(Math.cos(angle2) * rWell * 0.3, y2, -Math.sin(angle2) * rWell * 0.3);

        builder.addSolidQuad(pInner1, p1, p2, pInner2, COLOR_FILL_LIGHT);
        let pRail1 = p1.clone().setY(y1 + 25),
          pRail2 = p2.clone().setY(y2 + 25);
        builder.addSolidQuad(p1, p2, pRail2, pRail1, COLOR_FILL_MID);
        if (i > 0) {
          let prevY = yDir * ((i - 1) / numSteps) * stairHeight;
          builder.addSolidQuad(pInner1.clone().setY(prevY), p1.clone().setY(prevY), p1, pInner1, COLOR_FILL_DARK);
        }
        builder.addSketchLine(pInner1, p1, INK_MAIN, 1);
        builder.addSketchLine(p1, p2, INK_HEAVY, 1.5);
        builder.addSketchLine(pRail1, pRail2, INK_MAIN, 1.5);
        builder.addSketchLine(p1, pRail1, INK_FAINT, 0.5);
      }

      if (isDown) {
        const V_bottom = getPolygonVertices(rWell, -config.depth, config.centerSides);
        for (let i = 0; i < config.centerSides; i++) {
          builder.addSolidTriangle(new THREE.Vector3(0, -config.depth, 0), V_bottom[i], V_bottom[(i + 1) % config.centerSides], COLOR_FILL_MID);
          builder.addSketchLine(V_bottom[i], V_bottom[(i + 1) % config.centerSides], INK_MAIN, 1);
        }
      }
      group.add(builder.build());

      let isFromUp = config.currentAddress % BigInt(10) === BigInt(7);
      let isFromDown = config.currentAddress % BigInt(10) === BigInt(8);

      if (config.spiralMode === "up") {
        const hitUpMesh = new THREE.Mesh(new THREE.CylinderGeometry(rWell + 2, rWell + 2, H / 2, 12), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
        hitUpMesh.position.set(0, H * 0.75, 0);
        hitUpMesh.frustumCulled = false;
        hitUpMesh.userData = { isPassage: true, type: "SPIRAL_STAIRS_UP", targetAddress: config.currentAddress * BigInt(10) + BigInt(7), isReturn: isFromDown, parentGroup: group };
        group.add(hitUpMesh);
        interactables.push(hitUpMesh);
      } else {
        const hitDownMesh = new THREE.Mesh(new THREE.CylinderGeometry(rWell + 2, rWell + 2, config.depth, 12), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
        hitDownMesh.position.set(0, -config.depth * 0.5, 0);
        hitDownMesh.frustumCulled = false;
        hitDownMesh.userData = { isPassage: true, type: "SPIRAL_STAIRS_DOWN", targetAddress: isFromUp ? config.currentAddress / BigInt(10) : config.currentAddress * BigInt(10) + BigInt(8), isReturn: isFromUp, parentGroup: group };
        group.add(hitDownMesh);
        interactables.push(hitDownMesh);
      }
    }
    return group;
  }

  function buildChamber() {
    while (scene.children.length > 0) {
      scene.remove(scene.children[0]);
    }
    interactables = [];

    const R = config.radius;
    const V_out = getHexVertices(R, 0);
    const wallShades = [COLOR_FILL_LIGHT, COLOR_FILL_DARK, COLOR_FILL_DARK, COLOR_FILL_MID, COLOR_FILL_MID, COLOR_FILL_LIGHT];

    let floorGroup = buildPillarsAndFloor();
    floorGroup.userData.isEnvironment = true;
    scene.add(floorGroup);

    let centerGroup = buildCenterStructure();
    centerGroup.userData.isEnvironment = true;
    scene.add(centerGroup);

    config.layout.forEach((type, i) => {
      let wallGroup;
      if (type === "BOOKS") {
        wallGroup = buildBookshelfWall(V_out[i], V_out[(i + 1) % 6], 0, config.height, wallShades[i], i + 1);
      } else {
        wallGroup = buildPassage(V_out[i], V_out[(i + 1) % 6], type, i);
      }
      wallGroup.userData.isEnvironment = true;
      scene.add(wallGroup);
    });

    let maxShelf = 0;
    for (let obj of interactables) {
      if (obj.userData && obj.userData.isBookshelf && obj.userData.wallIndex !== undefined) {
        maxShelf = Math.max(maxShelf, obj.userData.wallIndex);
      }
    }
    const shelfInput = document.getElementById('input-shelf');
    if (shelfInput) {
      shelfInput.max = maxShelf;
      shelfInput.title = `Max shelves: ${maxShelf}`;
    }
  }

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let hoveredObject = null;
  let hoveredPoint = new THREE.Vector3();
  let activeBookshelf = null;
  let isZoomed = false;

  const tooltip = document.getElementById("nav-tooltip");

  // Guard: ignore all 3D input while any modal is open
  function isModalOpen() {
    return !!document.querySelector(
      '#oracle-modal:not(.hidden), #consent-modal:not(.hidden), #reader-panel:not(.hidden), #error-modal:not(.hidden)'
    );
  }

  function onPointerMove(event) {
    if (isModalOpen()) {
      document.body.style.cursor = 'default';
      hoveredObject = null;
      if (tooltip) tooltip.style.opacity = '0';
      return;
    }
    const sidebarW = 256;
    if (event.clientX < sidebarW) {
      document.body.style.cursor = "default";
      hoveredObject = null;
      tooltip.style.opacity = "0";
      return;
    }

    mouse.x = ((event.clientX - sidebarW) / (window.innerWidth - sidebarW)) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const visibleInteractables = interactables.filter((obj) => {
      let p = obj;
      while (p) {
        if (p.visible === false) return false;
        p = p.parent;
      }
      return true;
    });

    const intersects = raycaster.intersectObjects(visibleInteractables);

    if (intersects.length > 0) {
      const hit = intersects[0].object;

      if (hit.userData.isBlocker) {
        document.body.style.cursor = "default";
        hoveredObject = null;
        tooltip.style.opacity = "0";
      } else if (hit.userData.isPassage || hit.userData.isBookshelf) {
        document.body.style.cursor = "pointer";
        hoveredObject = hit;
        hoveredPoint.copy(intersects[0].point);

        tooltip.style.left = event.clientX + "px";
        tooltip.style.top = event.clientY + "px";

        if (hit.userData.isPassage) {
          tooltip.textContent = hit.userData.type.replace(/_/g, " ");
          tooltip.style.opacity = "1";
        } else if (hit.userData.isBookshelf) {
          tooltip.textContent = isZoomed && activeBookshelf === hit ? "READ BOOK" : "ZOOM WALL";
          tooltip.style.opacity = "1";
        }
      }
    } else {
      document.body.style.cursor = "default";
      hoveredObject = null;
      tooltip.style.opacity = "0";
    }
  }

  let pointerDownPos = { x: 0, y: 0 };
  window.addEventListener("pointerdown", (e) => {
    if (isModalOpen()) return;
    pointerDownPos = { x: e.clientX, y: e.clientY };
  });

  function onPointerClick(event) {
    if (isModalOpen()) return;
    const dist = Math.abs(event.clientX - pointerDownPos.x) + Math.abs(event.clientY - pointerDownPos.y);
    if (dist > 5) return; // Ignore drag

    if (!hoveredObject) {
      if (isZoomed) unzoomCamera();
      return;
    }

    if (hoveredObject.userData.isPassage) {
      triggerTransition(hoveredObject.userData.targetAddress);
    } else if (hoveredObject.userData.isBookshelf) {
      if (!isZoomed || activeBookshelf !== hoveredObject) {
        zoomToBookshelf(hoveredObject, hoveredPoint);
      } else {
        checkBookClick(hoveredObject, hoveredPoint);
      }
    }
  }

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("click", onPointerClick);

  let originalCamPos = new THREE.Vector3();
  let originalCamTarget = new THREE.Vector3();
  let zoomTargetPos = new THREE.Vector3();
  let zoomTargetLook = new THREE.Vector3();
  let targetFOV = 45;
  let cameraLerp = 0;
  let isAnimatingCamera = false;

  function zoomToBookshelf(shelfObj, hitPoint) {
    if (!isZoomed) {
      preZoomPos = camera.position.clone();
      preZoomTarget = controls.target.clone();
      preZoomFOV = camera.fov;
    }
    isZoomed = true;
    activeBookshelf = shelfObj;
    originalCamPos.copy(camera.position);
    originalCamTarget.copy(controls.target);

    const ud = shelfObj.userData;

    const shelfInput = document.getElementById('input-shelf');
    if (shelfInput && ud.wallIndex !== undefined) shelfInput.value = ud.wallIndex;

    const bookInput = document.getElementById('input-book');
    if (bookInput && ud.books) bookInput.max = ud.books.length;

    scene.children.forEach((c) => {
      if (c.userData.isEnvironment) {
        let isParent = c === ud.parentGroup || c.children.includes(ud.parentGroup);
        c.visible = isParent;
      }
    });
    ud.parentGroup.visible = true;

    let targetY = hitPoint.y;
    if (ud.books) {
      for (let book of ud.books) {
        if (hitPoint.y >= book.yBase && hitPoint.y <= book.yTop) {
          targetY = (book.yBase + book.yTop) / 2;
          break;
        }
      }
    }

    const midPoint = ud.p1.clone().lerp(ud.p2, 0.5);
    midPoint.y = targetY;
    zoomTargetLook.copy(midPoint);

    targetFOV = 75;
    const fovRad = THREE.MathUtils.degToRad(targetFOV);
    const aspect = camera.aspect;
    const wallHeight = config.height;
    const wallWidth = ud.length;

    const distV = (wallHeight / 2) / Math.tan(fovRad / 2);
    const distH = (wallWidth / 2) / (Math.tan(fovRad / 2) * aspect);
    let distFromWall = Math.max(distV, distH) * 1.15;

    zoomTargetPos.copy(midPoint).add(new THREE.Vector3(ud.nx * distFromWall, 0, ud.nz * distFromWall));
    cameraLerp = 0;
    isAnimatingCamera = true;

    const labelsContainer = document.getElementById("book-labels");
    labelsContainer.innerHTML = "";

    const dx = ud.p2.x - ud.p1.x;
    const dz = ud.p2.z - ud.p1.z;

    ud.books.forEach((book) => {
      let rng = mulberry32(book.seed);
      let title = generateBookTitle(rng);

      let bWidth = book.xEnd - book.xStart;
      if (bWidth < 2.5) return;

      let t = (book.xStart + book.xEnd) / 2 / ud.length;
      let gx = ud.p1.x + dx * t;
      let gz = ud.p1.z + dz * t;
      let gy = (book.yBase + book.yTop) / 2;

      let px = gx + ud.nx * 0.5;
      let pz = gz + ud.nz * 0.5;

      let span = document.createElement("div");
      span.className = "absolute top-0 left-0 text-[10px] text-[#b5afa5] font-mono tracking-tight whitespace-nowrap opacity-0 transition-opacity duration-500 font-bold select-none text-center";

      let maxW = book.yTop - book.yBase - 8;
      span.style.maxWidth = maxW + "px";
      span.style.overflow = "hidden";
      span.style.textOverflow = "ellipsis";

      span.innerText = title;
      span.dataset.x = px;
      span.dataset.y = gy;
      span.dataset.z = pz;

      labelsContainer.appendChild(span);
    });

    setTimeout(() => {
      if (isZoomed && activeBookshelf === shelfObj) {
        Array.from(labelsContainer.children).forEach((el) => el.classList.remove("opacity-0"));
      }
    }, 800);
  }

  function unzoomCamera() {
    isZoomed = false;
    activeBookshelf = null;
    originalCamPos.copy(camera.position);
    originalCamTarget.copy(controls.target);

    scene.children.forEach((c) => {
      if (c.userData.isEnvironment) c.visible = true;
    });

    const labelsContainer = document.getElementById("book-labels");
    Array.from(labelsContainer.children).forEach((el) => el.classList.add("opacity-0"));
    setTimeout(() => {
      if (!isZoomed) labelsContainer.innerHTML = "";
    }, 700);

    if (preZoomPos) {
      zoomTargetPos.copy(preZoomPos);
      zoomTargetLook.copy(preZoomTarget);
    } else {
      zoomTargetPos.set(0, 500, 800);
      zoomTargetLook.set(0, 0, 0);
    }
    targetFOV = 45;
    cameraLerp = 0;
    isAnimatingCamera = true;
  }

  function checkBookClick(shelfObj, hitPoint) {
    const ud = shelfObj.userData;
    const dx = hitPoint.x - (ud.p1.x + ud.nx * 2);
    const dz = hitPoint.z - (ud.p1.z + ud.nz * 2);
    const localX = Math.sqrt(dx * dx + dz * dz);
    const localY = hitPoint.y;

    for (let i = 0; i < ud.books.length; i++) {
      let book = ud.books[i];
      if (localX >= book.xStart && localX <= book.xEnd && localY >= book.yBase && localY <= book.yTop) {
        const bookInput = document.getElementById('input-book');
        if (bookInput) bookInput.value = i + 1;

        const volInput = document.getElementById('input-vol');
        if (volInput) volInput.value = 1;

        const pgInput = document.getElementById('input-pg');
        if (pgInput) pgInput.value = 1;

        const chamber = encodeAddress(config.currentAddress);
        const panel = document.getElementById('reader-panel');
        if (panel) panel.classList.remove('hidden');
        if (window.__orbitControls) window.__orbitControls.enabled = false;
        if (window.generatePage) window.generatePage(chamber, 1, false);
        return;
      }
    }
    unzoomCamera();
  }

  function triggerTransition(newAddressBigInt) {
    const overlay = document.getElementById("transition-overlay");
    overlay.style.opacity = "1";

    isZoomed = false;
    activeBookshelf = null;
    isAnimatingCamera = false;
    controls.enabled = true;
    tooltip.style.opacity = "0";
    preZoomPos = null;
    preZoomTarget = null;
    targetFOV = 45;
    document.getElementById("book-labels").innerHTML = "";

    setTimeout(() => {
      config.currentAddress = newAddressBigInt;
      generateLayoutForAddress(config.currentAddress);
      buildChamber();

      const startAngle = Math.PI / 4;
      camera.position.set(Math.cos(startAngle) * 1400, 820, Math.sin(startAngle) * 1400);
      controls.target.set(0, 0, 0);
      camera.fov = 45;
      camera.updateProjectionMatrix();
      controls.update();

      overlay.style.opacity = "0";
    }, 300);
  }

  function animate() {
    requestAnimationFrame(animate);

    if (isAnimatingCamera) {
      controls.enabled = false;
      cameraLerp += 0.04;
      if (cameraLerp >= 1) {
        cameraLerp = 1;
        isAnimatingCamera = false;
        controls.enabled = true;
      }
      const t = cameraLerp * cameraLerp * (3 - 2 * cameraLerp);
      camera.position.lerpVectors(originalCamPos, zoomTargetPos, t);
      controls.target.lerpVectors(originalCamTarget, zoomTargetLook, t);
    }

    if (Math.abs(camera.fov - targetFOV) > 0.1) {
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFOV, 0.06);
      camera.updateProjectionMatrix();
    }

    const labelsContainer = document.getElementById("book-labels");
    if (labelsContainer.children.length > 0) {
      const hw = canvas.clientWidth / 2;
      const hh = canvas.clientHeight / 2;
      let vec = new THREE.Vector3();

      Array.from(labelsContainer.children).forEach((el) => {
        vec.set(parseFloat(el.dataset.x), parseFloat(el.dataset.y), parseFloat(el.dataset.z));
        vec.project(camera);

        if (vec.z > 1 || vec.z < -1) {
          el.style.display = "none";
          return;
        }
        el.style.display = "block";

        let x = vec.x * hw + hw;
        let y = -(vec.y * hh) + hh;

        el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) rotate(90deg)`;
      });
    }

    controls.update();
    renderer.render(scene, camera);
  }

  function updateChamberInput() {
    const input = document.getElementById("chamber-input");
    const display = document.getElementById("display-chamber");
    if (input) input.value = encodeAddress(config.currentAddress);
    if (display) display.innerText = encodeAddress(config.currentAddress);
  }

  function setChamber(addressBigInt) {
    config.currentAddress = addressBigInt;
    generateLayoutForAddress(config.currentAddress);
    buildChamber();
    updateChamberInput();
    updateHash();
  }

  function updateHash() {
    if (window.syncURL) window.syncURL();
  }



  function randomChamber() {
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let num = BigInt(0);
    for (let i = 0; i < bytes.length; i++) num = (num << BigInt(8)) | BigInt(bytes[i]);
    if (num === BigInt(0)) num = BigInt(1);
    return num;
  }

  function setChamberFromInput() {
    const input = document.getElementById("chamber-input");
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    setChamber(decodeAddress(value));
  }

  function copyChamberLink() {
    if (window.copyAddress) {
      window.copyAddress();
      return;
    }
    const link = window.location.href;
    navigator.clipboard.writeText(link).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { }
      document.body.removeChild(ta);
    });
  }

  function initFromHash() {
    const hash = window.location.hash.slice(1);
    const parts = hash.split("/");
    if (parts[0] === "reader" && parts[1]) {
      setChamber(decodeAddress(decodeURIComponent(parts[1])));

      // Deep link to shelf/book
      if (parts[2]) {
        const shelfNum = parseInt(parts[2]);
        if (!isNaN(shelfNum)) {
          // Wait a frame for interactables to be populated
          setTimeout(() => {
            const shelfInput = document.getElementById('input-shelf');
            if (shelfInput) shelfInput.value = shelfNum;
            if (window.navigateToShelf) window.navigateToShelf();

            if (parts[3]) {
              const bookNum = parseInt(parts[3]);
              const bookInput = document.getElementById('input-book');
              if (bookInput && !isNaN(bookNum)) {
                bookInput.value = bookNum;
                // Just update input; app.js handles the reader panel/generation
              }
            }
          }, 50);
        }
      }
      return true;
    }
    return false;
  }

  function bindControls() {
    const randomBtn = document.getElementById("btn-chamber-random");
    const copyBtn = document.getElementById("btn-chamber-copy");
    const input = document.getElementById("chamber-input");

    if (randomBtn) randomBtn.addEventListener("click", () => {
      console.log("Random button clicked in chamber.js");
      if (window.navigateToRandomPage) {
        console.log("Found window.navigateToRandomPage, calling it");
        window.navigateToRandomPage();
      } else {
        console.log("window.navigateToRandomPage not found, falling back to setChamber");
        setChamber(randomChamber());
      }
    });
    if (copyBtn) copyBtn.addEventListener("click", copyChamberLink);
    if (input) input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") setChamberFromInput();
    });
  }

  let isInitialized = false;

  function initChamber() {
    if (isInitialized) return;
    isInitialized = true;

    if (!initFromHash()) {
      setChamber(randomChamber());
    }
    bindControls();
    animate();
  }

  function wrapSwitchView() {
    if (typeof window.switchView !== "function") return;
    const original = window.switchView;
    window.switchView = function (viewName) {
      original(viewName);
      if (viewName === "reader") {
        initChamber();
      }
    };
  }

  wrapSwitchView();

  // If we're already on the reader view (deep link), init now
  if (window.location.hash.startsWith("#reader")) {
    initChamber();
  }
  window.setChamberFromInput = setChamberFromInput;

  window.navigateToShelf = function () {
    const shelfNum = parseInt(document.getElementById('input-shelf').value);
    if (!shelfNum || isNaN(shelfNum)) return;

    let targetShelf = null;
    for (let obj of interactables) {
      if (obj.userData && obj.userData.isBookshelf && obj.userData.wallIndex === shelfNum) {
        targetShelf = obj;
        break;
      }
    }

    if (targetShelf) {
      const ud = targetShelf.userData;
      const mid = ud.p1.clone().lerp(ud.p2, 0.5);
      mid.y = config.height / 2;
      zoomToBookshelf(targetShelf, mid);
    }
  };

  window.navigateToBook = function () {
    const bookNum = parseInt(document.getElementById('input-book').value);
    if (!bookNum || isNaN(bookNum) || !isZoomed || !activeBookshelf) return;

    const ud = activeBookshelf.userData;
    if (ud && ud.books) {
      const idx = bookNum - 1;
      if (idx >= 0 && idx < ud.books.length) {
        const book = ud.books[idx];

        const volInput = document.getElementById('input-vol');
        if (volInput) volInput.value = 1;
        const pgInput = document.getElementById('input-pg');
        if (pgInput) pgInput.value = 1;

        const chamber = encodeAddress(config.currentAddress);
        const panel = document.getElementById('reader-panel');
        if (panel) panel.classList.remove('hidden');
        if (window.__orbitControls) window.__orbitControls.enabled = false;
        if (window.generatePage) window.generatePage(chamber, 1, false);
      }
    }
  };
})();
