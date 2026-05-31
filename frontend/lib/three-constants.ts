import * as THREE from "three";

/**
 * 太阳在场景中的固定位置。Sun.tsx、ThreeJSScene 的 directionalLight、
 * 以及所有行星 shader 的 uSunPos uniform 都从这里取值，避免硬编码漂移。
 */
export const SUN_POSITION: [number, number, number] = [-7.5, 0.8, -2];

/**
 * 太阳位置向量。行星 fragmentShader 中以世界空间方向 (uSunPos - vWorldPos)
 * 计算 lambert 着色，比共用单一方向更符合多行星布局的真实光照。
 */
export const SUN_POSITION_VEC3 = new THREE.Vector3(...SUN_POSITION);

/**
 * 行星 shader 共用的光照 uniforms。由 ThreeJSScene 根据主题计算后下发。
 */
export interface PlanetLighting {
  /** 世界空间太阳位置 */
  sunPos: THREE.Vector3;
  /** 表面环境光底色系数 */
  ambient: number;
  /** 太阳照射强度倍率 */
  sunStrength: number;
}

/**
 * 主题驱动的光照与材质参数。dark 为现状基线，light 在保持宇宙感前提下整体抬亮。
 */
export interface ThemeLightingParams {
  /** Canvas 背景色 */
  background: string;
  /** ambientLight intensity */
  ambientIntensity: number;
  /** ambientLight color */
  ambientColor: string;
  /** 太阳方向 directionalLight intensity */
  sunIntensity: number;
  /** 太阳方向 directionalLight color */
  sunColor: string;
  /** 第二条 directionalLight（正面补光）intensity */
  fillDirectionalIntensity: number;
  /** 顶部 pointLight intensity */
  topPointIntensity: number;
  /** 底部 pointLight intensity（轮廓底光） */
  bottomPointIntensity: number;
  /** Shader uniform：表面环境光底色系数 */
  shaderAmbient: number;
  /** Shader uniform：太阳照射强度倍率 */
  shaderSunStrength: number;
  /** Sun 自发光层级缩放 */
  sunEmissiveScale: number;
  /** ParticleField 粒子透明度 */
  particleOpacity: number;
  /** TechGalaxy 螺旋粒子透明度 */
  galaxyOpacity: number;
}

export const DARK_LIGHTING: ThemeLightingParams = {
  background: "#0d0d0d",
  ambientIntensity: 0.3,
  ambientColor: "#ffd599",
  sunIntensity: 1.2,
  sunColor: "#ffcc66",
  fillDirectionalIntensity: 0.15,
  topPointIntensity: 0.25,
  bottomPointIntensity: 0.2,
  shaderAmbient: 0.25,
  shaderSunStrength: 0.85,
  sunEmissiveScale: 1.0,
  particleOpacity: 0.7,
  galaxyOpacity: 0.75,
};

export const LIGHT_LIGHTING: ThemeLightingParams = {
  background: "#1a2540",
  ambientIntensity: 0.55,
  ambientColor: "#dceaff",
  sunIntensity: 1.8,
  sunColor: "#fff1cc",
  fillDirectionalIntensity: 0.1,
  topPointIntensity: 0.3,
  bottomPointIntensity: 0.1,
  shaderAmbient: 0.42,
  shaderSunStrength: 1.05,
  sunEmissiveScale: 1.15,
  particleOpacity: 0.5,
  galaxyOpacity: 0.55,
};

export function getLightingParams(theme: "dark" | "light"): ThemeLightingParams {
  return theme === "light" ? LIGHT_LIGHTING : DARK_LIGHTING;
}
