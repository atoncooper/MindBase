"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { PlanetLighting } from "@/lib/three-constants";

interface VenusProps {
  lighting?: PlanetLighting;
}

export default function Venus({ lighting }: VenusProps) {
  const groupRef = useRef<THREE.Group>(null);
  const venusRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (venusRef.current) venusRef.current.rotation.y += delta * 0.05;
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.008;
  });

  return (
    <group ref={groupRef} position={[1, 0.8, 7]}>
      {/* ── Venus surface ── */}
      <mesh ref={venusRef}>
        <sphereGeometry args={[0.58, 48, 48]} />
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

              // Thick cloud patterns
              float n1 = noise(uv * 10.0 + vec2(0.5, 0.2));
              float n2 = noise(uv * 20.0 - vec2(0.3, 0.7)) * 0.5;
              float n3 = noise(uv * 40.0 + vec2(0.1, 0.4)) * 0.25;
              float clouds = n1 + n2 + n3;

              vec3 paleYellow = vec3(0.88, 0.75, 0.40);
              vec3 midYellow  = vec3(0.78, 0.62, 0.22);
              vec3 darkOrange = vec3(0.55, 0.38, 0.10);
              vec3 sulphur = vec3(0.92, 0.82, 0.45);

              vec3 col = mix(darkOrange, midYellow, clouds);
              col = mix(col, paleYellow, smoothstep(0.45, 0.65, clouds));
              col = mix(col, sulphur, smoothstep(0.7, 0.85, clouds) * 0.4);

              float fresnel = 1.0 - abs(dot(vNormal, vec3(0,0,1)));
              col += vec3(0.6, 0.5, 0.2) * fresnel * 0.12;

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

      {/* ── Thick atmosphere glow ── */}
      <mesh>
        <sphereGeometry args={[0.68, 48, 48]} />
        <shaderMaterial
          transparent depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={{ uColor: { value: new THREE.Color("#e6b84d") } }}
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
              fresnel = pow(fresnel, 3.5);
              gl_FragColor = vec4(uColor, fresnel * 0.35);
            }
          `}
        />
      </mesh>

      {/* ── Outer haze ── */}
      <mesh>
        <sphereGeometry args={[0.82, 40, 40]} />
        <shaderMaterial
          transparent depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={{ uColor: { value: new THREE.Color("#cc9933") } }}
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
              fresnel = pow(fresnel, 6.0);
              gl_FragColor = vec4(uColor, fresnel * 0.15);
            }
          `}
        />
      </mesh>
    </group>
  );
}
