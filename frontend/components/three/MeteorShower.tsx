"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const MAX_METEORS = 20;
const MAX_LIFETIME = 5;
const SPAWN_INTERVAL = 1.2;

interface MeteorData {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  length: number;
  age: number;
  lifetime: number;
  color: THREE.Color;
}

export default function MeteorShower() {
  const groupRef = useRef<THREE.Group>(null);
  const spawnTimer = useRef(0);

  const meteors = useRef<MeteorData[]>([]);

  const lineGeo = useMemo(() => new THREE.BufferGeometry(), []);

  const spawnMeteor = (): MeteorData => {
    const side = Math.floor(Math.random() * 4);
    let x: number, y: number, z: number;

    switch (side) {
      case 0: // top
        x = (Math.random() - 0.5) * 20;
        y = 6 + Math.random() * 4;
        z = (Math.random() - 0.5) * 10;
        break;
      case 1: // right
        x = 10 + Math.random() * 3;
        y = (Math.random() - 0.5) * 10;
        z = (Math.random() - 0.5) * 10;
        break;
      case 2: // bottom
        x = (Math.random() - 0.5) * 20;
        y = -6 - Math.random() * 4;
        z = (Math.random() - 0.5) * 10;
        break;
      default: // left
        x = -10 - Math.random() * 3;
        y = (Math.random() - 0.5) * 10;
        z = (Math.random() - 0.5) * 10;
    }

    const dx = (Math.random() - 0.3) * 1.6;
    const dy = -0.3 - Math.random() * 1.2;
    const dz = (Math.random() - 0.5) * 0.8;
    const dir = new THREE.Vector3(dx, dy, dz).normalize();

    // Varied color palette: cyan, gold, white, purple
    const palette = Math.random();
    let color: THREE.Color;
    if (palette < 0.35) {
      // Cyan-blue
      color = new THREE.Color(
        0.3 + Math.random() * 0.25,
        0.65 + Math.random() * 0.35,
        0.8 + Math.random() * 0.2,
      );
    } else if (palette < 0.6) {
      // Gold-amber
      color = new THREE.Color(
        0.85 + Math.random() * 0.15,
        0.55 + Math.random() * 0.35,
        0.15 + Math.random() * 0.2,
      );
    } else if (palette < 0.8) {
      // White-hot
      color = new THREE.Color(
        0.85 + Math.random() * 0.15,
        0.85 + Math.random() * 0.15,
        0.8 + Math.random() * 0.2,
      );
    } else {
      // Purple-pink
      color = new THREE.Color(
        0.6 + Math.random() * 0.35,
        0.2 + Math.random() * 0.2,
        0.7 + Math.random() * 0.3,
      );
    }

    return {
      position: new THREE.Vector3(x, y, z),
      direction: dir,
      speed: 3 + Math.random() * 10,
      length: 0.8 + Math.random() * 2.0,
      age: 0,
      lifetime: 1.2 + Math.random() * MAX_LIFETIME,
      color,
    };
  };

  useFrame((_, delta) => {
    if (!groupRef.current) return;

    spawnTimer.current += delta;
    if (spawnTimer.current > SPAWN_INTERVAL && meteors.current.length < MAX_METEORS) {
      spawnTimer.current = 0;
      meteors.current.push(spawnMeteor());
    }

    if (meteors.current.length === 0) {
      meteors.current.push(spawnMeteor());
    }

    const dt = delta;
    for (let i = meteors.current.length - 1; i >= 0; i--) {
      const m = meteors.current[i];
      m.age += dt;
      if (m.age > m.lifetime) {
        meteors.current.splice(i, 1);
        continue;
      }
      m.position.x += m.direction.x * m.speed * dt;
      m.position.y += m.direction.y * m.speed * dt;
      m.position.z += m.direction.z * m.speed * dt;
    }

    const children = groupRef.current.children;
    while (children.length > meteors.current.length) {
      const last = children[children.length - 1];
      if (last) {
        (last as THREE.Line).geometry.dispose();
        ((last as THREE.Line).material as THREE.Material).dispose();
        groupRef.current.remove(last);
      } else {
        break;
      }
    }

    for (let i = 0; i < meteors.current.length; i++) {
      const m = meteors.current[i];
      const lifeRatio = m.age / m.lifetime;

      let alpha: number;
      if (lifeRatio < 0.08) {
        alpha = lifeRatio / 0.08;
      } else if (lifeRatio > 0.65) {
        alpha = 1 - (lifeRatio - 0.65) / 0.35;
      } else {
        alpha = 1;
      }

      const tail = m.position.clone().addScaledVector(m.direction, -m.length);

      let line: THREE.Line;
      if (i < children.length) {
        line = children[i] as THREE.Line;
      } else {
        line = new THREE.Line(
          lineGeo.clone(),
          new THREE.LineBasicMaterial({
            color: m.color,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        groupRef.current.add(line);
      }

      const geom = line.geometry;
      const positions = new Float32Array([
        tail.x, tail.y, tail.z,
        m.position.x, m.position.y, m.position.z,
      ]);
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setDrawRange(0, 2);

      (line.material as THREE.LineBasicMaterial).opacity = alpha * 0.9;
    }
  });

  return <group ref={groupRef} />;
}
