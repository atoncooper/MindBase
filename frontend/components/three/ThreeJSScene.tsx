"use client";

import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import ParticleField from "./ParticleField";
import DockModuleOrbit from "./DockModuleOrbit";
import Sun from "./Sun";
import Earth from "./Earth";
import Mars from "./Mars";
import Jupiter from "./Jupiter";
import Saturn from "./Saturn";
import Neptune from "./Neptune";
import MeteorShower from "./MeteorShower";
import TechGalaxy from "./TechGalaxy";
import Mercury from "./Mercury";
import Venus from "./Venus";
import Uranus from "./Uranus";
import OrionNebula from "./OrionNebula";
import { useTheme } from "@/components/ThemeProvider";
import { SUN_POSITION, SUN_POSITION_VEC3, getLightingParams } from "@/lib/three-constants";
import type { DockModule } from "@/lib/dock-registry";

interface ThreeJSSceneProps {
  dimmed?: boolean;
  dockModules: DockModule[];
  activePanelId: string | null;
  onTogglePanel: (id: string) => void;
}

export default function ThreeJSScene({
  dimmed = false,
  dockModules,
  activePanelId,
  onTogglePanel,
}: ThreeJSSceneProps) {
  const { theme } = useTheme();
  const params = useMemo(() => getLightingParams(theme), [theme]);

  // 行星 shader 共用的光照 uniforms（每帧只读，不必频繁更新）
  const planetLighting = useMemo(
    () => ({
      sunPos: SUN_POSITION_VEC3,
      ambient: params.shaderAmbient,
      sunStrength: params.shaderSunStrength,
    }),
    [params.shaderAmbient, params.shaderSunStrength],
  );

  return (
    <div className="three-scene-container" style={{ flex: 1, width: "100%", height: "100%" }}>
      <Canvas
        style={{
          pointerEvents: dimmed ? "none" : "auto",
        }}
        camera={{ position: [0, 0, 12], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: false }}
      >
        <color attach="background" args={[params.background]} />
        <ambientLight intensity={params.ambientIntensity} color={params.ambientColor} />
        {/* Warm sunlight from the sun direction */}
        <directionalLight
          position={SUN_POSITION}
          intensity={params.sunIntensity}
          color={params.sunColor}
        />
        <directionalLight
          position={[0, -2, 5]}
          intensity={params.fillDirectionalIntensity}
          color="#ffaa33"
        />
        {/* Subtle fill to prevent harsh shadows */}
        <pointLight position={[5, 5, 5]} intensity={params.topPointIntensity} color="#ffd599" />
        {/* Bottom rim light for depth */}
        <pointLight position={[0, -8, 2]} intensity={params.bottomPointIntensity} color="#886633" />
        <ParticleField opacity={params.particleOpacity} />
        <DockModuleOrbit
          dockModules={dockModules}
          activePanelId={activePanelId}
          onTogglePanel={onTogglePanel}
          dimmed={dimmed}
        />
        <TechGalaxy dimmed={dimmed} opacity={params.galaxyOpacity} />
        <Sun emissiveScale={params.sunEmissiveScale} />
        <Mercury lighting={planetLighting} />
        <Venus lighting={planetLighting} />
        <Earth lighting={planetLighting} />
        <Mars lighting={planetLighting} />
        <Jupiter lighting={planetLighting} />
        <Saturn lighting={planetLighting} />
        <Uranus lighting={planetLighting} />
        <Neptune lighting={planetLighting} />
        <MeteorShower />
        <OrionNebula />
        <OrbitControls
          enableDamping
          dampingFactor={0.08}
          minDistance={5}
          maxDistance={20}
          maxPolarAngle={Math.PI * 0.7}
          enabled={!dimmed}
        />
      </Canvas>
      {dimmed && <div className="scene-overlay" />}
    </div>
  );
}
