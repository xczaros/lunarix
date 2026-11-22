import { useEffect, useRef } from 'react';

/** Calm monochrome starfield with slow drift and occasional shooting stars. */
export function Stars({ density = 0.00018, className, light = false }: { density?: number; className?: string; light?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let w = 0;
    let h = 0;
    let raf = 0;
    let stars: { x: number; y: number; r: number; a: number; s: number; p: number }[] = [];
    let shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(w * h * density);
      stars = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.2 + 0.2, a: Math.random(), s: Math.random() * 0.015 + 0.003, p: Math.random() * Math.PI * 2 }));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const color = light ? '0,0,0' : '255,255,255';
    let t = 0;
    const draw = () => {
      t += 1;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const tw = reduce ? 0.7 : 0.45 + 0.55 * Math.sin(s.p + t * s.s);
        ctx.fillStyle = `rgba(${color},${(0.15 + 0.75 * s.a) * tw})`;
        ctx.beginPath();
        ctx.arc(s.x, (s.y + (reduce ? 0 : t * 0.02 * s.r)) % h, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduce) {
        if (!shooting && Math.random() < 0.0025) shooting = { x: Math.random() * w * 0.7, y: Math.random() * h * 0.4, vx: 7 + Math.random() * 4, vy: 2.5 + Math.random() * 2, life: 1 };
        if (shooting) {
          const g = ctx.createLinearGradient(shooting.x, shooting.y, shooting.x - shooting.vx * 12, shooting.y - shooting.vy * 12);
          g.addColorStop(0, `rgba(${color},${0.8 * shooting.life})`);
          g.addColorStop(1, `rgba(${color},0)`);
          ctx.strokeStyle = g;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(shooting.x, shooting.y);
          ctx.lineTo(shooting.x - shooting.vx * 12, shooting.y - shooting.vy * 12);
          ctx.stroke();
          shooting.x += shooting.vx;
          shooting.y += shooting.vy;
          shooting.life -= 0.018;
          if (shooting.life <= 0 || shooting.x > w + 100) shooting = null;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [density, light]);
  return <canvas ref={ref} className={className} style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }} />;
}
