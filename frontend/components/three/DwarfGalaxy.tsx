"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const ARM_COUNT = 2;
const PARTICLES_PER_ARM = 200;
const TOTAL = ARM_COUNT * PARTICLES_PER_ARM;
const GALAXY_RADIUS = 2.8;
const CORE_RADIUS = 0.4;

export default function DwarfGalaxy({ opacity = 0.55 }: { opacity?: number }) {
  const groupRef = useRef<THREE.Group>(null);

  const { positions, colors } = useMemo(() => {
    const pos = new Float32Array(TOTAL * 3);
    const col = new Float32Array(TOTAL * 3);

    const armOffsets = Array.from({ length: ARM_COUNT }, (_, i) =>
      (i / ARM_COUNT) * Math.PI * 2,
    );

    for (let arm = 0; arm < ARM_COUNT; arm++) {
      const baseAngle = armOffsets[arm];
      for (let j = 0; j < PARTICLES_PER_ARM; j++) {
        const idx = (arm * PARTICLES_PER_ARM + j) * 3;
        const t = j / PARTICLES_PER_ARM;
        const r = CORE_RADIUS + t * (GALAXY_RADIUS - CORE_RADIUS);
        const spiralAngle = baseAngle + t * 3.8;
        const spreadAngle = (Math.random() - 0.5) * (0.3 + t * 0.6);
        const angle = spiralAngle + spreadAngle;

        const y = (Math.random() - 0.5) * 0.25 * (1 - t * 0.6);

        pos[idx] = Math.cos(angle) * r;
        pos[idx + 1] = y;
        pos[idx + 2] = Math.sin(angle) * r;

        // Cool blue-white with subtle purple edges
        const brightness = 0.5 + (1 - t) * 0.55;
        col[idx] = brightness * (0.55 + (1 - t) * 0.45);
        col[idx + 1] = brightness * (0.65 + (1 - t) * 0.25);
        col[idx + 2] = brightness * (0.7 + t * 0.3);
      }
    }

    return { positions: pos, colors: col };
  }, []);

  const coreGeo = useMemo(() => {
    const g = new THREE.SphereGeometry(0.35, 32, 32);
    return g;
  }, []);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.025;
      groupRef.current.rotation.x += delta * 0.006;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Spiral particles */}
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.035}
          vertexColors
          transparent
          opacity={opacity}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* Glowing core */}
      <mesh geometry={coreGeo}>
        <meshBasicMaterial
          color="#aaccff"
          transparent
          opacity={0.35}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh geometry={coreGeo}>
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.15}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}
