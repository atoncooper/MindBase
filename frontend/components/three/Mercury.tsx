"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PlanetLighting } from "@/lib/three-constants";

interface MercuryProps {
  lighting?: PlanetLighting;
}

export default function Mercury({ lighting }: MercuryProps) {
  const groupRef = useRef<THREE.Group>(null);
  const mercuryRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (mercuryRef.current) mercuryRef.current.rotation.y += delta * 0.08;
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.012;
  });

  return (
    <group ref={groupRef} position={[-6, 0.5, 0.5]}>
      {/* ── Mercury surface ── */}
      <mesh ref={mercuryRef}>
        <sphereGeometry args={[0.22, 48, 48]} />
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
              float theta = atan(vPos.z, vPos.x);
              float phi = asin(vPos.y / length(vPos));
              vec2 uv = vec2(theta / 6.28318 + 0.5, phi / 3.14159 + 0.5);

              // Crater-like multi-octave noise
              float n1 = noise(uv * 18.0);
              float n2 = noise(uv * 36.0) * 0.5;
              float n3 = noise(uv * 72.0) * 0.25;
              float pattern = n1 + n2 + n3;

              vec3 darkGrey = vec3(0.18, 0.18, 0.20);
              vec3 midGrey  = vec3(0.32, 0.32, 0.34);
              vec3 lightGrey = vec3(0.48, 0.48, 0.50);
              vec3 craterDeep = vec3(0.12, 0.12, 0.14);

              vec3 col = mix(darkGrey, midGrey, pattern);
              col = mix(col, lightGrey, smoothstep(0.55, 0.75, pattern));
              col = mix(col, craterDeep, smoothstep(0.25, 0.35, pattern) * 0.5);

              // Subtle fresnel rim
              float fresnel = 1.0 - abs(dot(vNormal, vec3(0,0,1)));
              col += vec3(0.35, 0.35, 0.38) * fresnel * 0.08;

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

      {/* ── Extremely thin exosphere ── */}
      <mesh>
        <sphereGeometry args={[0.24, 32, 32]} />
        <shaderMaterial
          transparent depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={{ uColor: { value: new THREE.Color("#8899aa") } }}
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
              fresnel = pow(fresnel, 5.0);
              gl_FragColor = vec4(uColor, fresnel * 0.08);
            }
          `}
        />
      </mesh>
    </group>
  );
}
