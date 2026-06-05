import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree, extend } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import type { CognitiveType, GraphEdge, GraphNode } from "../hooks/useGraph.js";
import {
  buildGalacticLayout,
  COGNITIVE_META,
  COGNITIVE_ORDER,
  DOMAIN_META,
  updateGalacticPositions,
  type GalacticLayout,
  type GalacticNode,
} from "../lib/galactic/layout.js";
import { zoomLevelForScale } from "../lib/galactic/physics.js";
import type { GalacticZoomLevel } from "./GalacticCanvas.js";

const W = 100;

const LEVEL_DISTANCE: Record<GalacticZoomLevel, number> = {
  0: 32,
  1: 14,
  2: 5,
};

export interface GalacticSceneHandle {
  focusNode: (path: string, scale?: number) => void;
  setZoomLevel: (level: GalacticZoomLevel) => void;
}

export interface GalacticSceneProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId?: string | null;
  zoomLevel?: GalacticZoomLevel;
  onSelectNode?: (id: string | null) => void;
  onHoverNode?: (id: string | null) => void;
  onZoomLevelChange?: (level: GalacticZoomLevel) => void;
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

export const GalacticScene = forwardRef<GalacticSceneHandle, GalacticSceneProps>(
  function GalacticScene(props, ref) {
    const { nodes, edges, selectedNodeId, onSelectNode, onHoverNode, onZoomLevelChange } = props;

    const layout = useMemo(() => buildGalacticLayout(nodes, edges), [nodes, edges]);
    const handleRef = useRef<GalacticSceneHandle | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    useImperativeHandle(ref, () => ({
      focusNode: (path, scale) => handleRef.current?.focusNode(path, scale),
      setZoomLevel: (level) => handleRef.current?.setZoomLevel(level),
    }));

    // R3F's <Canvas> measures its container via ResizeObserver, which can report
    // 0×0 on the first mount inside an absolutely-positioned flex descendant —
    // leaving the canvas stuck at its default 300×150 and the scene rendering
    // black until the next window resize. Kick the observer once the wrapper has
    // a real layout box so the canvas sizes immediately on load.
    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const kick = () => window.dispatchEvent(new Event("resize"));
      const raf = requestAnimationFrame(kick);
      const observer = new ResizeObserver(kick);
      observer.observe(el);
      const timeout = window.setTimeout(kick, 200);
      return () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
        window.clearTimeout(timeout);
      };
    }, []);

    return (
      <div ref={wrapperRef} className="absolute inset-0 overflow-hidden bg-[#050508]">
        <Canvas
          camera={{ position: [0, 0, LEVEL_DISTANCE[0]], fov: 60, near: 0.1, far: 500 }}
          dpr={[1, 1.5]}
          gl={{ antialias: true, alpha: false, toneMapping: THREE.ACESFilmicToneMapping }}
          style={{ width: "100%", height: "100%" }}
        >
          <color attach="background" args={["#030308"]} />
          <ambientLight intensity={0.25} />
          <directionalLight position={[8, 12, 6]} intensity={1.2} color="#fff8f0" />
          <directionalLight position={[-6, -4, -8]} intensity={0.15} color="#3050a0" />
          <SceneContent
            ref={handleRef}
            layout={layout}
            selectedNodeId={selectedNodeId ?? null}
            onSelectNode={onSelectNode}
            onHoverNode={onHoverNode}
            onZoomLevelChange={onZoomLevelChange}
          />
        </Canvas>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Scene content (inside Canvas — has access to R3F hooks)
// ---------------------------------------------------------------------------

interface SceneContentProps {
  layout: GalacticLayout;
  selectedNodeId: string | null;
  onSelectNode?: (id: string | null) => void;
  onHoverNode?: (id: string | null) => void;
  onZoomLevelChange?: (level: GalacticZoomLevel) => void;
}

const SceneContent = forwardRef<GalacticSceneHandle, SceneContentProps>(
  function SceneContent({ layout, selectedNodeId, onSelectNode, onHoverNode, onZoomLevelChange }, ref) {
    const { camera } = useThree();
    const controlsRef = useRef<any>(null);
    const cameraTarget = useRef(new THREE.Vector3(0, 0, LEVEL_DISTANCE[0]));
    const cameraLookAt = useRef(new THREE.Vector3(0, 0, 0));
    const animating = useRef(false);
    const startRef = useRef(0);

    useImperativeHandle(ref, () => ({
      focusNode: (path: string) => {
        const node = layout.nodes.find((n) => n.path === path);
        if (!node) return;
        const pos = new THREE.Vector3(node.x / W, node.y / W, node.z / W);
        cameraLookAt.current.copy(pos);
        cameraTarget.current.set(pos.x, pos.y, pos.z + 6);
        animating.current = true;
        if (controlsRef.current) controlsRef.current.target.copy(pos);
      },
      setZoomLevel: (level: GalacticZoomLevel) => {
        const dist = LEVEL_DISTANCE[level];
        cameraLookAt.current.set(0, 0, 0);
        cameraTarget.current.set(0, 0, dist);
        animating.current = true;
        if (controlsRef.current) controlsRef.current.target.set(0, 0, 0);
        onZoomLevelChange?.(level);
      },
    }));

    // Animate layout positions + camera lerp
    useFrame((state, delta) => {
      const elapsed = state.clock.getElapsedTime() * 1000;
      updateGalacticPositions(layout.nodes, elapsed);

      if (animating.current) {
        camera.position.lerp(cameraTarget.current, 1 - Math.pow(0.05, delta));
        if (camera.position.distanceTo(cameraTarget.current) < 0.05) {
          camera.position.copy(cameraTarget.current);
          animating.current = false;
        }
      }

      // Emit zoom level changes based on camera distance
      const dist = camera.position.length();
      const scale = 5 / dist;
      const level = zoomLevelForScale(scale);
      startRef.current = level;
    });

    return (
      <>
        <Stars radius={200} depth={80} count={6000} factor={3} saturation={0.1} fade speed={0.5} />
        <DustField count={4000} />
        <GalaxyVolumes galaxies={layout.galaxies} />
        <GalaxyCores galaxies={layout.galaxies} />
        <NodeInstances layout={layout} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} onHoverNode={onHoverNode} />
        <EdgeLines layout={layout} selectedNodeId={selectedNodeId} />
        <OrbitControls
          ref={controlsRef}
          enableDamping
          dampingFactor={0.12}
          minDistance={2}
          maxDistance={80}
          maxPolarAngle={Math.PI}
          rotateSpeed={1.0}
          zoomSpeed={1.2}
          panSpeed={0.8}
          zoomToCursor
        />
        <EffectComposer>
          <Bloom
            luminanceThreshold={1.0}
            luminanceSmoothing={0.4}
            intensity={0.9}
            mipmapBlur
            radius={0.75}
          />
        </EffectComposer>
      </>
    );
  },
);

// ---------------------------------------------------------------------------
// Galaxy cores — glowing spheres at each galaxy center
// ---------------------------------------------------------------------------

function GalaxyCores({ galaxies }: { galaxies: GalacticLayout["galaxies"] }) {
  return (
    <>
      {COGNITIVE_ORDER.map((type) => {
        const g = galaxies[type];
        const color = new THREE.Color(g.color);
        return (
          <group key={type} position={[g.cx / W, g.cy / W, g.cz / W]}>
            <mesh>
              <sphereGeometry args={[0.35, 32, 32]} />
              <meshStandardMaterial
                emissive={color}
                emissiveIntensity={4}
                color="#000000"
                toneMapped={false}
              />
            </mesh>
            <pointLight color={g.color} intensity={4} distance={16} decay={2} />
          </group>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Nebula clouds — shader billboards per galaxy
// ---------------------------------------------------------------------------

// Seeded hash so cloud positions are stable across re-renders
function seededFloat(seed: number): number {
  let h = seed ^ 0xdeadbeef;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

// Build a star-cluster: many small sharp points with strong central
// concentration (radius = spread * rand^1.7 packs stars toward the core),
// each given a brightness + white/tint blend so the cluster reads as a real
// galaxy — bright glittering core fading to a sparse halo — not a fuzzy blob.
// Positions are LOCAL (centered on origin); the caller places each cluster at
// its galaxy center and spins it around that local origin — so the cluster
// stays glued to its core instead of orbiting the world origin.
function buildStarCluster(
  spread: number, count: number, baseSeed: number, color: string, flatten: number,
): { positions: Float32Array; colors: Float32Array } {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const tint = new THREE.Color(color);
  let s = baseSeed * 7919;
  for (let i = 0; i < count; i++) {
    // Uniform direction on the unit sphere
    const u = seededFloat(s++) * 2 - 1;
    const theta = seededFloat(s++) * Math.PI * 2;
    const rxy = Math.sqrt(1 - u * u);
    const dirX = rxy * Math.cos(theta);
    const dirY = rxy * Math.sin(theta);
    const dirZ = u;
    // Central concentration: most stars near the core, few at the rim
    const radius = spread * Math.pow(seededFloat(s++), 1.7);
    positions[i * 3]     = dirX * radius;
    positions[i * 3 + 1] = dirY * radius;
    positions[i * 3 + 2] = dirZ * radius * flatten;
    // Brighter toward the core; mix in white stars so it isn't monochrome
    const centerBoost = 1 - radius / spread;
    const bright = (0.4 + seededFloat(s++) * 0.6) * (0.55 + centerBoost * 0.9);
    const whiteMix = Math.pow(seededFloat(s++), 1.5) * 0.7;
    colors[i * 3]     = (tint.r * (1 - whiteMix) + whiteMix) * bright;
    colors[i * 3 + 1] = (tint.g * (1 - whiteMix) + whiteMix) * bright;
    colors[i * 3 + 2] = (tint.b * (1 - whiteMix) + whiteMix) * bright;
  }
  return { positions, colors };
}

const spreadGlow = 7;

function GalaxyVolumes({ galaxies }: { galaxies: GalacticLayout["galaxies"] }) {
  const clouds = useMemo(() => {
    return COGNITIVE_ORDER.map((type, gi) => {
      const g = galaxies[type];
      const spread = 2.6;
      const { positions, colors } = buildStarCluster(spread, 900, gi + 1, g.color, 0.7);
      return { type, color: g.color, positions, colors, center: [g.cx / W, g.cy / W, g.cz / W] as const };
    });
  }, [galaxies]);

  // One ref per galaxy: each cluster spins around its OWN center so it stays
  // locked onto the static core, instead of orbiting the world origin.
  const refs = useRef<(THREE.Group | null)[]>([]);
  useFrame((state) => {
    const t = state.clock.getElapsedTime() * 0.03;
    for (const g of refs.current) {
      if (g) g.rotation.y = t;
    }
  });

  return (
    <>
      {clouds.map(({ type, color, positions, colors, center }, i) => (
        <group key={type} position={center} ref={(el) => { refs.current[i] = el; }}>
          {/* Sharp stars — the glitter */}
          <points frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[positions, 3]} />
              <bufferAttribute attach="attributes-color" args={[colors, 3]} />
            </bufferGeometry>
            <pointsMaterial
              map={getCircleSprite()}
              size={0.085}
              sizeAttenuation
              vertexColors
              transparent
              opacity={0.95}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </points>
          {/* Single smooth glow sprite — the nebula color haze, no graininess */}
          <sprite scale={[spreadGlow, spreadGlow, 1]}>
            <spriteMaterial
              map={getCircleSprite()}
              color={color}
              transparent
              opacity={0.1}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </sprite>
        </group>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Node instances — one InstancedMesh for all planets
// ---------------------------------------------------------------------------

const _tempObj = new THREE.Object3D();
const _tempColor = new THREE.Color();

function buildPlanetMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vObjPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvObjPos = position;");

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vObjPos;
float ph(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float pn(vec3 p){
  vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(mix(ph(i),ph(i+vec3(1,0,0)),f.x),mix(ph(i+vec3(0,1,0)),ph(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(ph(i+vec3(0,0,1)),ph(i+vec3(1,0,1)),f.x),mix(ph(i+vec3(0,1,1)),ph(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float pfbm(vec3 p){float v=0.,a=.5;for(int i=0;i<6;i++){v+=a*pn(p);p*=2.1;a*=.5;}return v;}`,
      )
      .replace(
        "#include <tonemapping_fragment>",
        `// Procedural surface texture
float surf = pfbm(vObjPos * 4.0);
float band = pn(vec3(vObjPos.y * 6.0, 0.0, 0.0)) * 0.18;
gl_FragColor.rgb *= 0.55 + surf * 0.8 + band;
// Atmospheric Fresnel rim
float ndotv = saturate(dot(normalize(vNormal), normalize(vViewPosition)));
float rim = pow(1.0 - ndotv, 2.8);
vec3 atmo = mix(gl_FragColor.rgb * 1.4, vec3(0.2, 0.5, 1.0), 0.45);
gl_FragColor.rgb = mix(gl_FragColor.rgb, atmo, rim * 0.8);
#include <tonemapping_fragment>`,
      );
  };
  return mat;
}

function NodeInstances({
  layout,
  selectedNodeId,
  onSelectNode,
  onHoverNode,
}: {
  layout: GalacticLayout;
  selectedNodeId: string | null;
  onSelectNode?: (id: string | null) => void;
  onHoverNode?: (id: string | null) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const { nodes } = layout;
  const planetMaterial = useMemo(() => buildPlanetMaterial(), []);

  const colorArray = useMemo(() => {
    const arr = new Float32Array(nodes.length * 3);
    nodes.forEach((node, i) => {
      const meta = DOMAIN_META[node.domain];
      _tempColor.set(meta.color);
      _tempColor.toArray(arr, i * 3);
    });
    return arr;
  }, [nodes]);

  // Update positions every frame (nodes orbit)
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const s = node.size / W * 0.6;
      _tempObj.position.set(node.x / W, node.y / W, node.z / W);
      _tempObj.scale.set(s, s, s);
      _tempObj.updateMatrix();
      mesh.setMatrixAt(i, _tempObj.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  // Set initial colors
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < nodes.length; i++) {
      _tempColor.fromArray(colorArray, i * 3);
      mesh.setColorAt(i, _tempColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [colorArray, nodes]);

  const handleClick = useCallback(
    (event: any) => {
      event.stopPropagation();
      const id = event.instanceId;
      if (id !== undefined && id < nodes.length) {
        onSelectNode?.(nodes[id]!.path);
      }
    },
    [nodes, onSelectNode],
  );

  const handlePointerOver = useCallback(
    (event: any) => {
      const id = event.instanceId;
      if (id !== undefined && id < nodes.length) {
        onHoverNode?.(nodes[id]!.path);
        document.body.style.cursor = "pointer";
      }
    },
    [nodes, onHoverNode],
  );

  const handlePointerOut = useCallback(() => {
    onHoverNode?.(null);
    document.body.style.cursor = "auto";
  }, [onHoverNode]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, nodes.length]}
      material={planetMaterial}
      onClick={handleClick}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      <sphereGeometry args={[1, 20, 20]} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Edge lines — BufferGeometry line segments
// ---------------------------------------------------------------------------

function EdgeLines({
  layout,
  selectedNodeId,
}: {
  layout: GalacticLayout;
  selectedNodeId: string | null;
}) {
  const lineRef = useRef<THREE.LineSegments>(null!);
  const { edges } = layout;

  const { positions, colors } = useMemo(() => {
    const pos = new Float32Array(edges.length * 6);
    const col = new Float32Array(edges.length * 6);
    edges.forEach((edge, i) => {
      const off = i * 6;
      pos[off] = edge.source.x / W;
      pos[off + 1] = edge.source.y / W;
      pos[off + 2] = edge.source.z / W;
      pos[off + 3] = edge.target.x / W;
      pos[off + 4] = edge.target.y / W;
      pos[off + 5] = edge.target.z / W;

      const srcColor = new THREE.Color(DOMAIN_META[edge.source.domain].color);
      const tgtColor = new THREE.Color(DOMAIN_META[edge.target.domain].color);
      const crossGalaxy = edge.source.cognitiveType !== edge.target.cognitiveType;
      const alpha = crossGalaxy ? 0.06 : 0.2;
      srcColor.multiplyScalar(alpha);
      tgtColor.multiplyScalar(alpha);
      srcColor.toArray(col, off);
      tgtColor.toArray(col, off + 3);
    });
    return { positions: pos, colors: col };
  }, [edges]);

  // Update positions every frame since nodes orbit
  useFrame(() => {
    const geo = lineRef.current?.geometry;
    if (!geo) return;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i]!;
      const off = i * 6;
      arr[off] = edge.source.x / W;
      arr[off + 1] = edge.source.y / W;
      arr[off + 2] = edge.source.z / W;
      arr[off + 3] = edge.target.x / W;
      arr[off + 4] = edge.target.y / W;
      arr[off + 5] = edge.target.z / W;
    }
    pos.needsUpdate = true;
  });

  return (
    <lineSegments ref={lineRef} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={0.35}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </lineSegments>
  );
}

// ---------------------------------------------------------------------------
// Dust field — ambient floating particles with additive blending
// ---------------------------------------------------------------------------

let _circleSprite: THREE.CanvasTexture | null = null;
function getCircleSprite(): THREE.CanvasTexture {
  if (_circleSprite) return _circleSprite;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.4, "rgba(255,255,255,0.6)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  _circleSprite = new THREE.CanvasTexture(canvas);
  return _circleSprite;
}

function DustField({ count = 4000 }: { count?: number }) {
  const ref = useRef<THREE.Points>(null!);

  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 80;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 80;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 80;
    }
    return arr;
  }, [count]);

  useFrame((state) => {
    ref.current.rotation.y = state.clock.getElapsedTime() * 0.003;
    ref.current.rotation.x = Math.sin(state.clock.getElapsedTime() * 0.002) * 0.02;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        map={getCircleSprite()}
        size={0.08}
        sizeAttenuation
        color="#8899cc"
        transparent
        opacity={0.5}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}
