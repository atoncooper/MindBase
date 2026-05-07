"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PlanetLighting } from "@/lib/three-constants";

interface UranusProps {
  lighting?: PlanetLighting;
}

export default function Uranus({ lighting }: UranusProps) {
  const groupRef = useRef<THREE.Group>(null);
  const uranusRef = useRef<THREE.Mesh>(null);

  const ringParticles = useMemo(() => {
    const count = 120;
    return Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.9 + Math.random() * 0.4;
      return { angle, radius, size: 0.008 + Math.random() * 0.018 };
    });
  }, []);

  useFrame((_, delta) => {
    if (uranusRef.current) uranusRef.current.rotation.y += delta * 0.28;
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.005;
  });

  return (
    <group ref={groupRef} position={[-2, -0.2, 7.5]} rotation={[0, 0, Math.PI * 0.48]}>
      {/* ── Uranus surface ── */}
      <mesh ref={uranusRef}>
        <sphereGeometry args={[0.65, 48, 48]} />
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

              // Faint methane bands
              float bands = sin(latitude * 22.0) * 0.5
                          + sin(latitude * 14.0 + 0.8) * 0.3
                          + sin(latitude * 8.0 + 1.5) * 0.2;
              bands = bands * 0.5 + 0.5;

              float turb = noise(vec2(longitude * 6.0, latitude * 16.0)) * 0.15;
              bands += turb;

              vec3 paleCyan = vec3(0.35, 0.72, 0.78);
              vec3 midCyan  = vec3(0.22, 0.55, 0.62);
              vec3 deepCyan = vec3(0.10, 0.35, 0.42);

              vec3 col = mix(deepCyan, paleCyan, bands);
              col = mix(col, midCyan, smoothstep(0.35, 0.55, bands));

              float fresnel = 1.0 - abs(dot(vNormal, vec3(0,0,1)));
              col += vec3(0.2, 0.5, 0.55) * fresnel * 0.12;

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
      <mesh rotation={[Math.PI * 0.48, 0.03, 0]}>
        <ringGeometry args={[0.85, 1.15, 96]} />
        <meshBasicMaterial
          color="#aaccbb"
          side={THREE.DoubleSide}
          transparent
          opacity={0.35}
          depthWrite={false}
        />
      </mesh>

      {/* ── Outer thin ring ── */}
      <mesh rotation={[Math.PI * 0.48, 0.03, 0]}>
        <ringGeometry args={[1.18, 1.28, 64]} />
        <meshBasicMaterial
          color="#99bbaa"
          side={THREE.DoubleSide}
          transparent
          opacity={0.22}
          depthWrite={false}
        />
      </mesh>

      {/* ── Ring particles ── */}
      {ringParticles.map((p, i) => (
        <mesh
          key={i}
          rotation={[Math.PI * 0.48, 0.03, 0]}
          position={[
            Math.cos(p.angle) * p.radius,
            Math.sin(p.angle) * 0.04,
            -Math.sin(p.angle) * p.radius * 0.12,
          ]}
        >
          <sphereGeometry args={[p.size, 4, 4]} />
          <meshBasicMaterial color="#aaccbb" transparent opacity={0.45} depthWrite={false} />
        </mesh>
      ))}

      {/* ── Atmosphere glow ── */}
      <mesh>
        <sphereGeometry args={[0.74, 40, 40]} />
        <shaderMaterial
          transparent depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={{ uColor: { value: new THREE.Color("#66aabb") } }}
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
              gl_FragColor = vec4(uColor, fresnel * 0.22);
            }
          `}
        />
      </mesh>

      {/* ── Miranda (tiny moon) ── */}
      <mesh position={[1.1, 0.05, -0.3]}>
        <sphereGeometry args={[0.05, 10, 10]} />
        <meshStandardMaterial color="#aaa" roughness={0.6} emissive="#111" emissiveIntensity={0.08} />
      </mesh>
    </group>
  );
}
