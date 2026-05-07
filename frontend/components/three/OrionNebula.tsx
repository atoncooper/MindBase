"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const NEBULA_PARTICLES = 600;
const FIELD_STARS = 400;

/* ── 猎户座主要亮星（腰带 + 四角）
   以猎户座中心为原点，用近似相对坐标 */
const BRIGHT_STARS: { name: string; pos: [number, number, number]; color: string; size: number }[] = [
  { name: "Betelgeuse",  pos: [-2.2,  1.8, 0],  color: "#ff6633", size: 0.08 }, // 参宿四 红超巨星
  { name: "Rigel",       pos: [ 2.0, -1.9, 0],  color: "#aaccff", size: 0.07 }, // 参宿七 蓝超巨星
  { name: "Bellatrix",   pos: [ 1.6,  1.4, 0],  color: "#ddeeff", size: 0.05 }, // 参宿五
  { name: "Mintaka",     pos: [ 0.0,  0.3, 0],  color: "#e8f0ff", size: 0.045 }, // 参宿三（腰带中）
  { name: "Alnilam",     pos: [-0.4,  0.3, 0],  color: "#e8f0ff", size: 0.045 }, // 参宿二
  { name: "Alnitak",     pos: [ 0.4,  0.3, 0],  color: "#e8f0ff", size: 0.045 }, // 参宿一
  { name: "Saiph",       pos: [-0.3, -1.7, 0],  color: "#ccddee", size: 0.04 }, // 参宿六
];

export default function OrionNebula() {
  const groupRef = useRef<THREE.Group>(null);
  const nebulaRef = useRef<THREE.Points>(null);
  const fieldRef = useRef<THREE.Points>(null);

  /* ── 星云粒子（M42 猎户座大星云）── */
  const { nebulaPositions, nebulaColors } = useMemo(() => {
    const pos = new Float32Array(NEBULA_PARTICLES * 3);
    const col = new Float32Array(NEBULA_PARTICLES * 3);

    for (let i = 0; i < NEBULA_PARTICLES; i++) {
      const i3 = i * 3;
      // 主要集中在腰带下方的一个椭圆形区域
      const angle = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.7) * 1.6;
      const spreadY = (Math.random() - 0.5) * 1.2;
      const spreadZ = (Math.random() - 0.5) * 0.6;

      pos[i3]     = Math.cos(angle) * r * 1.3 + (Math.random() - 0.5) * 0.3;
      pos[i3 + 1] = Math.sin(angle) * r * 0.6 + spreadY - 0.3;
      pos[i3 + 2] = spreadZ;

      // 核心偏粉/红，边缘偏紫/蓝
      const dist = Math.sqrt(pos[i3] * pos[i3] + pos[i3 + 1] * pos[i3 + 1]);
      const t = Math.min(dist / 1.5, 1.0);
      const isCore = Math.random() < 0.3;

      if (isCore) {
        // 核心区：粉红/桃红
        col[i3]     = 0.85 + Math.random() * 0.15;
        col[i3 + 1] = 0.35 + Math.random() * 0.25;
        col[i3 + 2] = 0.45 + Math.random() * 0.20;
      } else {
        // 边缘区：蓝紫/品红
        col[i3]     = 0.55 + t * 0.25 + Math.random() * 0.15;
        col[i3 + 1] = 0.20 + (1 - t) * 0.25 + Math.random() * 0.15;
        col[i3 + 2] = 0.65 + t * 0.20 + Math.random() * 0.15;
      }
    }
    return { nebulaPositions: pos, nebulaColors: col };
  }, []);

  /* ── 背景星场 ── */
  const { fieldPositions, fieldColors } = useMemo(() => {
    const pos = new Float32Array(FIELD_STARS * 3);
    const col = new Float32Array(FIELD_STARS * 3);

    for (let i = 0; i < FIELD_STARS; i++) {
      const i3 = i * 3;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 6 + Math.random() * 5;

      pos[i3]     = r * Math.sin(phi) * Math.cos(theta);
      pos[i3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.5;
      pos[i3 + 2] = r * Math.cos(phi) * 0.4;

      const warmth = Math.random();
      const brightness = 0.4 + Math.random() * 0.6;
      if (warmth < 0.2) {
        // 偏蓝
        col[i3]     = brightness * 0.7;
        col[i3 + 1] = brightness * 0.8;
        col[i3 + 2] = brightness;
      } else if (warmth < 0.5) {
        // 偏白
        col[i3] = col[i3 + 1] = col[i3 + 2] = brightness;
      } else {
        // 偏黄/红
        col[i3]     = brightness;
        col[i3 + 1] = brightness * 0.85;
        col[i3 + 2] = brightness * 0.65;
      }
    }
    return { fieldPositions: pos, fieldColors: col };
  }, []);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.003;
    }
    // 星云轻微脉动
    if (nebulaRef.current) {
      const mat = nebulaRef.current.material as THREE.PointsMaterial;
      mat.opacity = 0.35 + Math.sin(Date.now() * 0.0008) * 0.05;
    }
  });

  return (
    <group ref={groupRef} position={[0, 1.5, -22]}>
      {/* ── 背景星场 ── */}
      <points ref={fieldRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[fieldPositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[fieldColors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.04}
          vertexColors
          transparent
          opacity={0.6}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          sizeAttenuation
        />
      </points>

      {/* ── 猎户座大星云（M42）── */}
      <points ref={nebulaRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[nebulaPositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[nebulaColors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.06}
          vertexColors
          transparent
          opacity={0.35}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          sizeAttenuation
        />
      </points>

      {/* ── 亮星 ── */}
      {BRIGHT_STARS.map((star, i) => (
        <group key={i} position={star.pos}>
          {/* 星体 */}
          <mesh>
            <sphereGeometry args={[star.size, 16, 16]} />
            <meshBasicMaterial
              color={star.color}
              transparent
              opacity={0.9}
              depthWrite={false}
            />
          </mesh>
          {/* 星光晕 */}
          <mesh>
            <sphereGeometry args={[star.size * 3.5, 16, 16]} />
            <meshBasicMaterial
              color={star.color}
              transparent
              opacity={0.12}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
          {/* 外光晕 */}
          <mesh>
            <sphereGeometry args={[star.size * 7, 16, 16]} />
            <meshBasicMaterial
              color={star.color}
              transparent
              opacity={0.04}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        </group>
      ))}

      {/* ── 星座连线（淡淡的线）── */}
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[
              new Float32Array([
                // 左上到右上
                -2.2, 1.8, 0,  1.6, 1.4, 0,
                // 右上到腰带
                1.6, 1.4, 0,   0.4, 0.3, 0,
                // 腰带
                0.4, 0.3, 0,   0.0, 0.3, 0,
                0.0, 0.3, 0,  -0.4, 0.3, 0,
                // 腰带下到左下
                -0.4, 0.3, 0, -0.3, -1.7, 0,
                // 左下到右下
                -0.3, -1.7, 0, 2.0, -1.9, 0,
                // 右下到腰带
                2.0, -1.9, 0,  0.4, 0.3, 0,
              ]),
              3,
            ]}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#8899aa" transparent opacity={0.08} />
      </line>
    </group>
  );
}
