"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { PlanetLighting } from "@/lib/three-constants";

interface SaturnProps {
  lighting?: PlanetLighting;
}

export default function Saturn({ lighting }: SaturnProps) {
  const groupRef = useRef<THREE.Group>(null);
  const saturnRef = useRef<THREE.Mesh>(null);

  const ringParticles = useMemo(() => {
    const count = 200;
    return Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.2 + Math.random() * 0.7;
      return { angle, radius, size: 0.01 + Math.random() * 0.025 };
    });
  }, []);

  useFrame((_, delta) => {
    if (saturnRef.current) saturnRef.current.rotation.y += delta * 0.15;
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.01;
  });

  return (
    <group ref={groupRef} position={[5, 0.1, -3]}>
      {/* ── Saturn body ── */}
      <mesh ref={saturnRef}>
        <sphereGeometry args={[0.72, 56, 56]} />
        <shaderMaterial
          uniforms={{
            uSunPos: { value: lighting?.sunPos ?? new THREE.Vector3(-7.5, 0.8, -2) },
            uAmbient: { value: lighting?.ambient ?? 0.25 },
            uSunStrength: { value: lighting?.sunStrength ?? 0.85 },
          }}
          vertexShader={/* glsl */ `
            varying vec3 vPos;
            varying vec3 vNormal;
            varying vec3 vWorldNormal;
            varying vec3 vWorldPos;
            void main() {
              vPos = position;
              vNormal = normalize(normalMatrix * normal);
              vWorldNormal = normalize(mat3(modelMatrix) * normal);
              vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
              gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
            }
          `}
          fragmentShader={/* glsl */ `
            varying vec3 vPos;
            varying vec3 vNormal;
            varying vec3 vWorldNormal;
            varying vec3 vWorldPos;
            uniform vec3 uSunPos;
            uniform float uAmbient;
            uniform float uSunStrength;

            float hash(vec2 p) {
              return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
            }
            float noise(vec2 p) {
              vec2 i = floor(p);
              vec2 f = fract(p);
              f = f * f * (3.0 - 2.0 * f);
              return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                         mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
            }

            void main() {
              float phi = asin(vPos.y / length(vPos));
              float latitude = phi / 3.14159 + 0.5;
              float theta = atan(vPos.z, vPos.x);
              float longitude = theta / 6.28318 + 0.5;

              float bands = sin(latitude * 18.0) * 0.5 + sin(latitude * 10.0 + 1.2) * 0.3;
              bands = bands * 0.5 + 0.5;

              float turb = noise(vec2(longitude * 8.0, latitude * 20.0)) * 0.2;
              bands += turb;

              vec3 paleYellow = vec3(1.0, 0.92, 0.35);
              vec3 midYellow = vec3(0.95, 0.8, 0.2);
              vec3 darkYellow = vec3(0.8, 0.6, 0.08);

              vec3 col = mix(darkYellow, paleYellow, bands);
              col = mix(col, midYellow, smoothstep(0.4, 0.6, bands));

              float fresnel = 1.0 - abs(dot(vNormal, vec3(0,0,1)));
              col += vec3(0.6, 0.45, 0.08) * fresnel * 0.25;

              // Per-fragment lambert from sun
              vec3 lightDir = normalize(uSunPos - vWorldPos);
              float ndl = dot(vWorldNormal, lightDir);
              float lit = uAmbient + uSunStrength * (ndl * 0.5 + 0.5);
              col *= lit;

              gl_FragColor = vec4(col, 1.0);
            }
          `}
        />
      </mesh>

      {/* ── Main ring disk ── */}
      <mesh rotation={[Math.PI * 0.42, 0.05, 0]}>
        <ringGeometry args={[1.1, 1.65, 128]} />
        <meshBasicMaterial
          color="#f0d878"
          side={THREE.DoubleSide}
          transparent
          opacity={0.85}
          depthWrite={false}
        />
      </mesh>

      {/* ── Inner ring ── */}
      <mesh rotation={[Math.PI * 0.42, 0.05, 0]}>
        <ringGeometry args={[0.9, 1.08, 96]} />
        <meshBasicMaterial
          color="#e0c868"
          side={THREE.DoubleSide}
          transparent
          opacity={0.75}
          depthWrite={false}
        />
      </mesh>

      {/* ── Outer thin ring ── */}
      <mesh rotation={[Math.PI * 0.42, 0.05, 0]}>
        <ringGeometry args={[1.67, 1.75, 96]} />
        <meshBasicMaterial
          color="#d4b868"
          side={THREE.DoubleSide}
          transparent
          opacity={0.6}
          depthWrite={false}
        />
      </mesh>

      {/* ── Ring particles ── */}
      {ringParticles.map((p, i) => (
        <mesh
          key={i}
          rotation={[Math.PI * 0.42, 0.05, 0]}
          position={[
            Math.cos(p.angle) * p.radius,
            Math.sin(p.angle) * 0.06,
            -Math.sin(p.angle) * p.radius * 0.15,
          ]}
        >
          <sphereGeometry args={[p.size, 4, 4]} />
          <meshBasicMaterial color="#eedd88" transparent opacity={0.85} depthWrite={false} />
        </mesh>
      ))}

      {/* ── Atmosphere ── */}
      <mesh>
        <sphereGeometry args={[0.82, 40, 40]} />
        <shaderMaterial
          transparent depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={{ uColor: { value: new THREE.Color("#ffcc44") } }}
          vertexShader={/* glsl */ `
            varying vec3 vNormal;
            void main() {
              vNormal = normalize(normalMatrix * normal);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `}
          fragmentShader={/* glsl */ `
            varying vec3 vNormal;
            uniform vec3 uColor;
            void main() {
              float fresnel = 1.0 - abs(dot(vNormal, vec3(0,0,1)));
              fresnel = pow(fresnel, 4.0);
              gl_FragColor = vec4(uColor, fresnel * 0.45);
            }
          `}
        />
      </mesh>

      {/* ── Titan (large moon) ── */}
      <mesh position={[1.3, 0.1, -0.4]}>
        <sphereGeometry args={[0.09, 16, 16]} />
        <meshStandardMaterial color="#ddb" roughness={0.5} emissive="#111" emissiveIntensity={0.1} />
      </mesh>
    </group>
  );
}
