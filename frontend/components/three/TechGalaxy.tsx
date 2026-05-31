"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const ARM_COUNT = 3;
const PARTICLES_PER_ARM = 400;
const TOTAL = ARM_COUNT * PARTICLES_PER_ARM;
const GALAXY_RADIUS = 5.5;
const CORE_RADIUS = 0.8;

export default function TechGalaxy({ opacity = 0.75 }: { dimmed?: boolean; opacity?: number }) {
  const groupRef = useRef<THREE.Group>(null);
  const pointsRef = useRef<THREE.Points>(null);

  /* ── spiral particle positions & colors ── */
  const { positions, colors } = useMemo(() => {
    const pos = new Float32Array(TOTAL * 3);
    const col = new Float32Array(TOTAL * 3);

    const armOffsets = Array.from({ length: ARM_COUNT }, (_, i) => (i / ARM_COUNT) * Math.PI * 2);

    for (let arm = 0; arm < ARM_COUNT; arm++) {
      const baseAngle = armOffsets[arm];
      for (let j = 0; j < PARTICLES_PER_ARM; j++) {
        const idx = (arm * PARTICLES_PER_ARM + j) * 3;
        // logarithmic spiral: r grows with j, with some randomness
        const t = j / PARTICLES_PER_ARM;
        const r = CORE_RADIUS + t * (GALAXY_RADIUS - CORE_RADIUS);
        const spiralAngle = baseAngle + t * 4.5; // tight spiral
        const spreadAngle = (Math.random() - 0.5) * (0.4 + t * 0.5); // wider spread at edges
        const angle = spiralAngle + spreadAngle;

        // slight vertical scatter
        const y = (Math.random() - 0.5) * 0.3 * (1 - t * 0.7);

        pos[idx] = Math.cos(angle) * r;
        pos[idx + 1] = y;
        pos[idx + 2] = Math.sin(angle) * r;

        // Color: core = bright white/gold, outer = saturated warm gold
        const brightness = 0.65 + (1 - t) * 0.6;
        col[idx] = Math.min(1.0, brightness * 1.05);
        col[idx + 1] = brightness * (0.65 + (1 - t) * 0.35);
        col[idx + 2] = brightness * (0.15 + (1 - t) * 0.18);
      }
    }

    return { positions: pos, colors: col };
  }, []);

  /* ── rotation ── */
  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.04;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Galaxy particles */}
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.045}
          vertexColors
          transparent
          opacity={opacity}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}
