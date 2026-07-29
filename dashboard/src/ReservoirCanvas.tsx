import { useEffect, useRef } from "react";
import * as THREE from "three";

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform float u_time;
  uniform vec2 u_resolution;
  varying vec2 vUv;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(
      0.211324865405187,
      0.366025403784439,
      -0.577350269189626,
      0.024390243902439
    );
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0)) +
      i.x + vec3(0.0, i1.x, 1.0)
    );
    vec3 m = max(
      0.5 - vec3(
        dot(x0, x0),
        dot(x12.xy, x12.xy),
        dot(x12.zw, x12.zw)
      ),
      0.0
    );
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 -
      0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vec2 st = gl_FragCoord.xy / u_resolution.xy;
    st.x *= u_resolution.x / u_resolution.y;
    vec2 pos = st * 3.0;
    float t = u_time * 0.2;
    float n = snoise(pos + t);
    n = snoise(pos + n * 2.0 - t * 1.5);
    float discrete = floor(n * 10.0) / 10.0;

    vec3 colorBase = vec3(1.0, 1.0, 1.0);
    vec3 colorDeepBlue = vec3(0.06, 0.04, 0.62);
    vec3 colorBrightBlue = vec3(0.09, 0.08, 0.83);
    vec3 colorCyan = vec3(0.22, 1.0, 0.93);

    vec3 finalColor = mix(
      colorBase,
      colorBrightBlue,
      smoothstep(-0.2, 0.3, discrete)
    );
    finalColor = mix(
      finalColor,
      colorDeepBlue,
      smoothstep(0.4, 0.8, discrete)
    );
    float highlight = smoothstep(0.7, 1.0, n);
    finalColor = mix(finalColor, colorCyan, highlight * 0.8);
    float grid = sin(st.y * 200.0) * sin(st.x * 200.0);
    finalColor -= vec3(grid * 0.03);
    float mask = 1.0 - smoothstep(0.3, 1.0, vUv.x);
    gl_FragColor = vec4(finalColor, mask);
  }
`;

export function ReservoirCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const uniforms = {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2(1, 1) }
    };
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(plane);

    const resize = (): void => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      renderer.setSize(width, height, false);
      uniforms.u_resolution.value.set(width, height);
      renderer.render(scene, camera);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    const clock = new THREE.Clock();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    let frame = 0;
    const animate = (): void => {
      uniforms.u_time.value = reducedMotion ? 1.25 : clock.getElapsedTime();
      renderer.render(scene, camera);
      if (!reducedMotion) frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      plane.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div id="reservoir-canvas-container" ref={containerRef} />;
}
