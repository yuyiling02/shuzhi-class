import React, { useRef, useState, useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float } from '@react-three/drei';
import * as THREE from 'three';
import { 
  Search, ChevronRight, Sparkles, Folder, BarChart2, 
  Hand, Mic, Maximize2, FileText, Minus, X, Square,
  Menu, Cpu, Activity, Glasses, Box, Share2, BookOpen,
  Users, Download, ArrowUpRight
} from 'lucide-react';
import { useTheme } from './components/ThemeProvider';

export type MarketingPage = 'home' | 'solutions' | 'cases' | 'pricing' | 'docs' | 'join';

const NAV_ITEMS: { page: Exclude<MarketingPage, 'home'>; label: string; path: string }[] = [
  { page: 'solutions', label: '教学辅助', path: '/solutions' },
  { page: 'cases', label: '教学反馈', path: '/cases' },
  { page: 'pricing', label: '价格', path: '/pricing' },
  { page: 'docs', label: '文档', path: '/docs' },
  { page: 'join', label: '加入我们', path: '/join' },
];

const PAGE_INTROS: Record<Exclude<MarketingPage, 'home'>, { eyebrow: string; title: string; accent: string; description: string }> = {
  solutions: {
    eyebrow: 'AI × 空间计算',
    title: '为每一堂课提供',
    accent: '可触摸的教学辅助',
    description: '从 3D 教具管理、空间手势到 AI 课堂助教，把抽象知识转化为可观察、可操作、可讨论的学习体验。',
  },
  cases: {
    eyebrow: '真实课堂实践',
    title: '好工具的价值，',
    accent: '由教学效果回答',
    description: '来自一线教师与教研团队的真实使用反馈，记录数智课堂如何进入不同学科的日常教学。',
  },
  pricing: {
    eyebrow: '灵活版本',
    title: '从一位教师到一所学校，',
    accent: '按需选择',
    description: '清晰、透明的版本方案，支持个人体验、教研组协作以及学校级部署。',
  },
  docs: {
    eyebrow: '产品文档中心',
    title: '快速了解并用好',
    accent: '数智课堂',
    description: '从首次登录到 3D 教具、手势互动和 AI 助教，按场景查找操作说明与教学建议。',
  },
  join: {
    eyebrow: '与教育创新者同行',
    title: '一起打造下一代',
    accent: '智慧课堂',
    description: '我们期待教师、学校、技术伙伴与教育内容创作者加入，共同让优质互动教学触达更多课堂。',
  },
};

// === 3D Neural Network Background Component ===
function NeuralNetwork({ accent }: { accent: string }) {
  const { particles, lines } = useMemo(() => {
    const particleCount = 300;
    const particles = new Float32Array(particleCount * 3);
    const linePositions: number[] = [];
    const maxDistance = 2.5;

    for (let i = 0; i < particleCount; i++) {
      particles[i * 3] = (Math.random() - 0.5) * 15;
      particles[i * 3 + 1] = (Math.random() - 0.5) * 15;
      particles[i * 3 + 2] = (Math.random() - 0.5) * 15;
    }

    for (let i = 0; i < particleCount; i++) {
      for (let j = i + 1; j < particleCount; j++) {
        const dx = particles[i * 3] - particles[j * 3];
        const dy = particles[i * 3 + 1] - particles[j * 3 + 1];
        const dz = particles[i * 3 + 2] - particles[j * 3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist < maxDistance) {
          linePositions.push(
            particles[i * 3], particles[i * 3 + 1], particles[i * 3 + 2],
            particles[j * 3], particles[j * 3 + 1], particles[j * 3 + 2]
          );
        }
      }
    }

    return { particles, lines: new Float32Array(linePositions) };
  }, []);

  const groupRef = useRef<any>(null);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * 0.03;
      groupRef.current.rotation.x = clock.getElapsedTime() * 0.02;
    }
  });

  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={particles.length / 3} array={particles} itemSize={3} />
        </bufferGeometry>
        <pointsMaterial size={0.04} color={accent} transparent opacity={0.8} sizeAttenuation />
      </points>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={lines.length / 3} array={lines} itemSize={3} />
        </bufferGeometry>
        <lineBasicMaterial color={accent} transparent opacity={0.25} blending={THREE.AdditiveBlending} />
      </lineSegments>
    </group>
  );
}

function ParticleFlow({ accent }: { accent: string }) {
  const pointsRef = useRef<any>(null);
  const count = 1500;
  
  const particles = useMemo(() => {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 20;
    }
    return positions;
  }, []);

  useFrame(({ clock }) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y = clock.getElapsedTime() * 0.02;
      pointsRef.current.position.y = Math.sin(clock.getElapsedTime() * 0.1) * 0.5;
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.015} color={accent} transparent opacity={0.3} sizeAttenuation />
    </points>
  );
}

function EnergyCore({ primary, accent }: { primary: string; accent: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const offset = useMemo(() => Math.random() * 100, []);
  
  useFrame(({ clock }) => {
    if (groupRef.current) {
      const t = clock.getElapsedTime() + offset;
      
      // 自转
      groupRef.current.rotation.y = t * 0.15;
      groupRef.current.rotation.x = t * 0.2;
      
      // 全屏范围内的随机/平滑游走 (Lissajous curve)
      // 左右大幅游走
      const x = Math.sin(t * 0.12) * 14 + Math.cos(t * 0.08) * 4;
      // 上下随机漂浮
      const y = Math.cos(t * 0.15) * 8 + Math.sin(t * 0.1) * 3;
      // 深度随机变化 (忽大忽小，忽远忽近)
      const z = -6 + Math.sin(t * 0.09) * 8; 
      
      groupRef.current.position.set(x, y, z);
    }
  });

  return (
    <group ref={groupRef}>
      {/* 外部辅助能量环 */}
      <mesh>
        <sphereGeometry args={[3.2, 32, 32]} />
        <meshBasicMaterial 
          color={primary} 
          transparent 
          opacity={0.15} 
          wireframe={true}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* 核心网格 */}
      <mesh>
        <sphereGeometry args={[2.8, 64, 64]} />
        <meshBasicMaterial 
          color={accent} 
          transparent 
          opacity={0.35} 
          wireframe={true}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* 核心内发光 */}
      <mesh>
        <sphereGeometry args={[2.2, 32, 32]} />
        <meshBasicMaterial color={primary} transparent opacity={0.15} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

function BackgroundScene({ primary, accent }: { primary: string; accent: string }) {
  return (
    <>
      <fog attach="fog" args={['#000000', 3, 12]} />
      <NeuralNetwork accent={accent} />
      <ParticleFlow accent={accent} />
      <EnergyCore primary={primary} accent={accent} />
      {/* 3D 浮动发光体 - 模拟 3D 光效 */}
      <Float speed={1.5} rotationIntensity={0.5} floatIntensity={1}>
        <mesh position={[3, 2, -4]}>
          <sphereGeometry args={[1.5, 32, 32]} />
          <meshBasicMaterial color={primary} transparent opacity={0.08} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
        <mesh position={[-3, -2, -6]}>
          <sphereGeometry args={[2, 32, 32]} />
          <meshBasicMaterial color={accent} transparent opacity={0.05} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </Float>
    </>
  );
}

// === Primitive UI Components ===
const LogoMark = () => (
  <img src="/brand/smart-cube-tech/mark.svg" alt="数智课堂 Logo" className="w-8 h-8 drop-shadow-[0_0_8px_rgba(var(--theme-accent-rgb),0.4)]" />
);

const AppleLogo = ({ className = "w-3.5 h-3.5" }) => (
  <svg viewBox="0 0 384 512" fill="currentColor" className={className}>
    <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/>
  </svg>
);

const SectionEyebrow = ({ label }: { label: string }) => (
  <div className="flex items-center gap-3">
    <div className="flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
      <span className="text-sm font-medium text-ink tracking-wide">{label}</span>
    </div>
  </div>
);

const HoverText = ({ text, className, style, charClassName, charStyle, gradientSpan }: { text: string, className?: string, style?: React.CSSProperties, charClassName?: string, charStyle?: React.CSSProperties, gradientSpan?: boolean }) => {
  return (
    <span className={className} style={style}>
      {text.split('').map((char, index) => {
        const computedStyle = { ...charStyle };
        if (gradientSpan) {
          computedStyle.backgroundSize = `${text.length * 100}% auto`;
          (computedStyle as any)['--bg-x'] = `${(index / Math.max(1, text.length - 1)) * 100}%`;
        }
        return (
          <motion.span
            key={index}
            className={`inline-block cursor-default ${charClassName || ''}`}
            style={computedStyle}
            whileHover={{ scale: 1.15, y: -8 }}
            transition={{ type: "spring", stiffness: 400, damping: 10 }}
          >
            {char === ' ' ? '\u00A0' : char}
          </motion.span>
        );
      })}
    </span>
  );
};

// === Main Page Component ===
export default function LandingPage({
  page,
  onNavigate,
  onEnter,
}: {
  page: MarketingPage;
  onNavigate: (page: MarketingPage) => void;
  onEnter: () => void;
}) {
  const [time, setTime] = useState("");
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{
    title: string; description: string; meta: string;
    sections: { kind: 'steps' | 'bullets' | 'table' | 'callout'; title?: string; items?: string[]; rows?: string[][]; headers?: string[]; tone?: 'info' | 'tip' | 'warn'; text?: string }[];
  } | null>(null);
  const [selectedScenario, setSelectedScenario] = useState<{
    label: string;
    title: string;
    description: string;
    model: string;
  } | null>(null);
  const { themeDef } = useTheme();

  const handleEnterClick = () => {
    onEnter();
  };

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);
    
    const updateTime = () => {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      setTime(now.toLocaleDateString('zh-CN', options).replace(/,/g, ' '));
    };
    updateTime();
    const timer = setInterval(updateTime, 60000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    setIsMenuOpen(false);
    document.title = page === 'home'
      ? '数智课堂 · AI 互动教学平台'
      : `${NAV_ITEMS.find((item) => item.page === page)?.label || '数智课堂'} · 数智课堂`;
  }, [page]);

  useEffect(() => {
    if (!selectedDoc) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedDoc(null);
    };
    document.body.style.overflow = 'hidden';
    // 切换内容时重置弹窗滚动位置
    requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      dialog?.scrollTo({ top: 0, behavior: 'auto' });
    });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [selectedDoc]);

  const navigateTo = (nextPage: MarketingPage) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(nextPage);
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--theme-bg)] text-ink selection:bg-brand/30">
      
      {/* 1. 全局背景 (深空渐变 + 3D 神经网络粒子流 + 体积光) */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        {/* 深海蓝 -> 黑色径向渐变，制造极致深邃感 */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--theme-bg-soft)_0%,_var(--theme-bg)_80%)]" />
        
        {/* 强化微弱体积光晕 */}
        <div className="absolute top-[-20%] left-[-10%] w-[60vw] h-[60vw] rounded-full bg-[rgba(var(--theme-primary-rgb),0.20)] mix-blend-screen blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50vw] h-[50vw] rounded-full bg-[rgba(var(--theme-accent-rgb),0.15)] mix-blend-screen blur-[130px]" />

        {/* 底部补充环境光 */}
        <div className="absolute inset-x-0 bottom-0 h-64 bg-[radial-gradient(ellipse_at_bottom,rgba(var(--theme-accent-rgb),0.15),transparent_70%)]" />

        <div className="absolute inset-0 opacity-80">
          <Canvas camera={{ position: [0, 0, 5], fov: 60 }}>
            <BackgroundScene primary={themeDef.primary} accent={themeDef.accent} />
          </Canvas>
        </div>
      </div>

      {/* SVG Noise Filter */}
      <svg className="w-0 h-0 absolute pointer-events-none">
        <filter id="noise-filter">
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.25 0" />
          <feComposite in2="SourceGraphic" operator="in" result="noise" />
          <feBlend in="SourceGraphic" in2="noise" mode="screen" />
        </filter>
      </svg>

      <div className="relative z-10 min-h-screen flex flex-col">
        
        {/* 2. Navbar */}
        <motion.nav 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className={`w-full px-10 h-20 flex items-center relative sticky top-0 z-50 transition-all duration-500 ${isScrolled ? 'bg-cyan-50/70 backdrop-blur-2xl border-b border-line/10 shadow-[0_10px_30px_rgba(0,0,0,0.5)]' : 'bg-transparent border-transparent'}`}
        >
          <a href="/" onClick={navigateTo('home')} aria-label="返回首页" className="flex items-center gap-2 cursor-pointer absolute left-6 md:left-10">
            <LogoMark />
          </a>
          <div className="hidden md:flex items-center justify-center gap-8 w-full">
            {NAV_ITEMS.map((item, i) => (
              <motion.a 
                key={item.page}
                href={item.path}
                onClick={navigateTo(item.page)}
                initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + i * 0.1 }}
                aria-current={page === item.page ? 'page' : undefined}
                className={`text-sm font-semibold transition-colors relative group py-2 ${page === item.page ? 'text-cyan' : 'text-ink/70 hover:text-cyan'}`}
              >
                {item.label}
                <div className={`absolute bottom-0 left-0 w-full h-[2px] bg-cyan transition-transform origin-left duration-300 shadow-[0_0_10px_var(--theme-accent)] ${page === item.page ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'}`}></div>
              </motion.a>
            ))}
          </div>
          <button
            type="button"
            aria-label={isMenuOpen ? '关闭导航菜单' : '打开导航菜单'}
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((open) => !open)}
            className="md:hidden absolute right-6 w-10 h-10 flex items-center justify-center rounded-full bg-white/5 border border-line/10"
          >
            {isMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </motion.nav>

        {isMenuOpen && (
          <div className="fixed top-20 inset-x-4 z-50 md:hidden rounded-2xl border border-line/10 bg-cyan-50/95 backdrop-blur-2xl p-3 shadow-2xl">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.page}
                href={item.path}
                onClick={navigateTo(item.page)}
                className={`block rounded-xl px-4 py-3 text-sm font-semibold ${page === item.page ? 'bg-cyan/10 text-cyan' : 'text-ink/70 hover:bg-white/5 hover:text-ink'}`}
              >
                {item.label}
              </a>
            ))}
          </div>
        )}

        {page !== 'home' && (
          <header className="max-w-[76rem] mx-auto px-6 pt-24 pb-16 text-center relative z-20">
            <div className="flex justify-center"><SectionEyebrow label={PAGE_INTROS[page].eyebrow} /></div>
            <h1 className="mt-7 text-4xl md:text-6xl font-black tracking-tight leading-[1.08]">
              {PAGE_INTROS[page].title}<br />
              <span className="text-cyan">{PAGE_INTROS[page].accent}</span>
            </h1>
            <p className="mt-7 mx-auto max-w-2xl text-base md:text-lg leading-relaxed text-ink/60">
              {PAGE_INTROS[page].description}
            </p>
          </header>
        )}

        {/* 3. Hero 首屏 */}
        {page === 'home' && (
        <section className="landing-home-hero pt-28 md:pt-32 pb-12 text-center px-4 flex flex-col items-center relative z-20">
          
          {/* 浮动技术徽章 (填补两侧空洞) */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden max-w-[100vw] hidden md:block z-0 opacity-60">
            <motion.div 
              initial={{ opacity: 0, x: -50 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.8, duration: 1 }}
              className="absolute top-[15%] left-[2%] lg:left-[5%] flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-line/10 backdrop-blur-md shadow-[0_0_15px_rgba(var(--theme-accent-rgb),0.1)]"
            >
              <div className="w-2 h-2 rounded-full bg-cyan shadow-[0_0_8px_var(--theme-accent)] animate-pulse" />
              <span className="text-xs font-semibold text-ink/60 tracking-wider">AI 空间驱动</span>
            </motion.div>
            
            <motion.div 
              initial={{ opacity: 0, x: 50 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 1, duration: 1 }}
              className="absolute top-[20%] right-[2%] lg:right-[5%] flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-line/10 backdrop-blur-md shadow-[0_0_15px_rgba(var(--theme-accent-rgb),0.1)]"
            >
              <Activity className="w-3.5 h-3.5 text-cyan" />
              <span className="text-xs font-semibold text-ink/60 tracking-wider">60FPS 实时渲染</span>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2, duration: 1 }}
              className="absolute bottom-[25%] left-[4%] lg:left-[8%] flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-line/10 backdrop-blur-md shadow-[0_0_15px_rgba(var(--theme-accent-rgb),0.1)]"
            >
              <Hand className="w-3.5 h-3.5 text-cyan" />
              <span className="text-xs font-semibold text-ink/60 tracking-wider">毫秒级手势交互</span>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.4, duration: 1 }}
              className="absolute bottom-[20%] right-[4%] lg:right-[8%] flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-line/10 backdrop-blur-md shadow-[0_0_15px_rgba(var(--theme-accent-rgb),0.1)]"
            >
              <Share2 className="w-3.5 h-3.5 text-cyan" />
              <span className="text-xs font-semibold text-ink/60 tracking-wider">跨端无缝协同</span>
            </motion.div>
          </div>

          <motion.div 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 1, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center leading-[1.15]"
          >
            <HoverText
              text="你的专属 3D 互动教具库"
              className="text-5xl md:text-[5.5rem] font-[900] tracking-tight mb-4 flex justify-center"
              charStyle={{
                backgroundImage: 'linear-gradient(to bottom, #ffffff 30%, #a5d2ff 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                color: 'transparent',
                WebkitTextStroke: '1px rgba(255,255,255,0.25)',
                textShadow: '0 0 30px rgba(165, 210, 255, 0.4)'
              }}
            />
            <div className="relative mt-2 pb-4">
              <HoverText
                text="数智课堂"
                className="text-6xl md:text-[6.5rem] font-black tracking-widest relative z-10 flex justify-center"
                charClassName="animate-shiny"
                gradientSpan={true}
                charStyle={{
                  backgroundImage: 'linear-gradient(to right, #00f0ff, #0055ff, #00f0ff)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  color: 'transparent',
                  textShadow: '0 0 20px rgba(var(--theme-accent-rgb), 0.3), 0 0 40px rgba(0, 85, 255, 0.2)'
                }}
              />
              {/* 发光高亮背板加强 -> 柔和背板以减少视觉疲劳 */}
              <div className="absolute inset-0 bg-cyan/10 blur-[60px] rounded-full pointer-events-none z-0" />
            </div>
          </motion.div>

          <motion.p 
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 1, ease: "easeOut" }}
            className="landing-hero-subtitle mt-8 text-ink/60 max-w-2xl text-lg md:text-xl leading-relaxed font-medium"
          >
            让每个抽象知识点<br />都能被看见、触摸和理解
          </motion.p>

          <motion.div 
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8, duration: 0.8 }}
            className="landing-hero-actions mt-14 flex flex-col items-center gap-6"
          >
            <motion.button 
              onClick={handleEnterClick}
              whileHover={{ scale: 1.02, y: -2 }}
              whileTap={{ scale: 0.98 }}
              className="relative group inline-flex items-center justify-center gap-3 rounded-full px-12 py-4 text-base font-bold text-ink overflow-hidden transition-all duration-300 shadow-[0_0_30px_rgba(var(--theme-accent-rgb),0.2)] hover:shadow-[0_0_50px_rgba(var(--theme-accent-rgb),0.4)]"
            >
              <div className="absolute inset-0 bg-cyan-50/40 backdrop-blur-md rounded-full border border-line/10 group-hover:border-cyan/50 transition-colors duration-300" />
              <div className="absolute inset-0 bg-gradient-to-r from-cyan/0 via-cyan/10 to-cyan/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-md" />
              <div className="absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-cyan/80 to-transparent opacity-50 group-hover:opacity-100 transition-opacity duration-300" />
              
              <span className="relative z-10 flex items-center gap-2 drop-shadow-md group-hover:text-cyan transition-colors duration-300">
                立即体验
                <ChevronRight className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1" />
              </span>
            </motion.button>

            <span className="text-sm font-medium tracking-widest uppercase text-ink/30">
              AI 教具管理 · 手势互动 · 智慧课堂
            </span>
          </motion.div>
        </section>
        )}


        {/* 5. 教学案例展示区 */}
        {page === 'cases' && (
        <section className="max-w-[76rem] mx-auto px-6 py-20 relative z-20">
          <div className="max-w-2xl mb-10">
            <SectionEyebrow label="真实课堂界面" />
            <h2 className="mt-4 text-3xl font-bold">一堂课，这样展开</h2>
            <p className="mt-4 text-ink/60 leading-relaxed">
              3D 教具、手势识别、AI 备课助手——全部在同一个界面里协同工作。
              老师用手势操控模型，学生看到的是会动、会拆解、会高亮的立体知识。
            </p>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.98 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            className="relative rounded-2xl overflow-hidden border border-line/15 bg-cyan-50/80 backdrop-blur-3xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] ring-1 ring-white/5"
          >
            <img
              src="/images/cases-full-mockup.png"
              alt="数智课堂 · 完整教学界面"
              className="w-full h-auto block"
            />
          </motion.div>
        </section>
        )}
        {/* 6. 功能区：AI 教具管理 */}
        {page === 'solutions' && (
        <>
        <section className="max-w-[76rem] mx-auto px-6 py-24 border-t border-line/5">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <motion.div 
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
            >
              <SectionEyebrow label="多模态智能" />
              <h2 className="mt-6 text-4xl md:text-5xl font-bold tracking-tight leading-[1.1]">
                打破屏幕边界的<br/>
                <span className="text-cyan">沉浸教学体验</span>
              </h2>
              <p className="mt-6 text-ink/60 text-lg leading-relaxed max-w-lg">
                数智课堂不仅是一个教具云盘，更是一个懂你的教学引擎。通过空间计算和 AI 大模型，让每个教具都“活”起来。
              </p>
              
              <div className="mt-10 grid grid-cols-2 gap-4">
                {[
                  { icon: Hand, title: "空间手势互动", desc: "无需鼠标，挥手即可拆解模型" },
                  { icon: Mic, title: "语音智能助教", desc: "上课时随时呼叫 AI 回答问题" },
                  { icon: Folder, title: "自动教具分类", desc: "千万级资源，秒级图谱归档" },
                  { icon: BarChart2, title: "课堂行为分析", desc: "实时追踪学生的互动专注度" },
                ].map((feature, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="w-10 h-10 rounded-lg bg-white/5 border border-line/10 flex items-center justify-center shrink-0">
                      <feature.icon className="w-5 h-5 text-cyan" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-ink">{feature.title}</div>
                      <div className="text-xs text-ink/50 mt-1">{feature.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
              className="space-y-4"
            >
              {/* Liquid glass feature cards */}
              <div className="liquid-glass rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-2 h-2 rounded-full bg-[#28c840] shadow-[0_0_10px_#28c840]" />
                  <span className="text-sm font-bold text-ink">今日教具资源库动态</span>
                </div>
                <div className="space-y-3">
                  {[
                    { title: "已自动打标签 42 个新模型", color: "var(--theme-accent)", progress: "100%" },
                    { title: "为 18 个物理实验生成了讲解词", color: "#A4F4FD", progress: "85%" },
                    { title: "3 个生物 3D 模型需要手动确认", color: "#febc2e", progress: "30%" },
                  ].map((item, i) => (
                    <div key={i} className="bg-cyan/30 border border-line/5 rounded-lg p-3">
                      <div className="text-xs text-ink/80 font-medium mb-2">{item.title}</div>
                      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: item.progress, backgroundColor: item.color }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="liquid-glass rounded-2xl p-6 flex flex-col items-center text-center justify-center h-40">
                  <Hand className="w-8 h-8 text-cyan mb-3" />
                  <div className="text-sm font-bold">MediaPipe 引擎</div>
                  <div className="text-xs text-ink/50 mt-1">毫秒级手势追踪就绪</div>
                </div>
                <div className="liquid-glass rounded-2xl p-6 flex flex-col items-center text-center justify-center h-40">
                  <Cpu className="w-8 h-8 text-cyan mb-3" />
                  <div className="text-xs text-ink/50 mt-1">多模态教学认知赋能</div>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* 7. Logo Cloud */}
        <section className="max-w-[76rem] mx-auto px-6 py-20 border-t border-line/5">
          <div className="text-center text-[10px] md:text-xs uppercase tracking-[0.2em] text-ink/40 font-semibold mb-12">
            适用于未来智慧课堂的各种教学场景
          </div>
          <div className="flex flex-wrap justify-center gap-3 md:gap-4">
            {[
              { label: '地理', title: '地理环境模拟', model: '地球内部结构', description: '通过地球内部结构与地形模型，观察圈层关系、地势起伏和地表过程。' },
              { label: '生物', title: '生物结构实验', model: '心脏模型', description: '用可观察的器官模型理解结构、功能和血液循环等关键知识。' },
              { label: '化学', title: '化学分子解析', model: '金刚石模型', description: '旋转、缩放分子与晶体模型，建立键角、配位和空间构型概念。' },
            ].map((scenario, i) => (
              <motion.button
                type="button"
                key={scenario.label}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                onClick={() => setSelectedScenario((current) => current?.label === scenario.label ? null : scenario)}
                aria-expanded={selectedScenario?.label === scenario.label}
                className={`rounded-full border px-5 py-2.5 text-sm md:text-base font-bold transition-colors ${selectedScenario?.label === scenario.label ? 'border-cyan/60 bg-cyan/10 text-cyan' : 'border-line/10 bg-white/[0.03] text-ink/55 hover:border-cyan/35 hover:text-ink'}`}
              >
                {scenario.label}
              </motion.button>
            ))}
          </div>
          {selectedScenario && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mx-auto mt-8 max-w-2xl rounded-2xl border border-cyan/20 bg-cyan-50/10 p-6 text-left backdrop-blur-md"
            >
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan">{selectedScenario.label} · {selectedScenario.model}</p>
                  <h3 className="mt-2 text-lg font-black text-ink">{selectedScenario.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-ink/60">{selectedScenario.description}</p>
                </div>
                <button type="button" onClick={handleEnterClick} className="shrink-0 rounded-lg bg-white px-4 py-2.5 text-sm font-black text-black transition hover:bg-cyan-100">
                  进入数智课堂
                </button>
              </div>
            </motion.div>
          )}
        </section>
        </>
        )}

        {/* 8. Testimonials */}
        {page === 'cases' && (
        <section className="max-w-[76rem] mx-auto px-6 py-24 border-t border-line/5">
          <SectionEyebrow label="教育者的声音" />
          <h2 className="mt-4 text-3xl font-bold mb-12">一线名师的真实反馈</h2>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                quote: "数智课堂让原本干瘪的 PPT 彻底进化。当我用手势在空中旋转地球仪，并放大地壳切面时，班里学生们的眼神里充满了震撼，专注度空前提高。",
                name: "张老师", role: "省级骨干教师", subject: "地理"
              },
              {
                quote: "AI 自动生成讲解词和课堂互动问题，帮我省去了大量的备课时间。我只需要将 3D 模型拖入库中，系统就会自动提取所有重点知识。",
                name: "李主任", role: "信息技术中心主任", subject: "技术组"
              },
              {
                quote: "物理课上的受力分析一直是个难点。现在通过空间手势和 3D 力学模型，原本抽象的概念具象化了，教学效果立竿见影。",
                name: "王老师", role: "高级教师", subject: "物理"
              }
            ].map((t, i) => (
              <motion.figure 
                key={i}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.6 }}
                className="liquid-glass rounded-2xl p-8 flex flex-col justify-between group"
              >
                <blockquote className="text-sm text-ink/80 leading-[1.8] relative z-10">
                  "{t.quote}"
                </blockquote>
                <figcaption className="mt-8 pt-6 border-t border-line/10 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-ink group-hover:text-cyan transition-colors">{t.name}</div>
                    <div className="text-xs text-ink/50 mt-1">{t.role}</div>
                  </div>
                  <div className="px-3 py-1 bg-white/5 border border-line/10 rounded-full text-xs font-semibold text-ink/70">
                    {t.subject}
                  </div>
                </figcaption>
              </motion.figure>
            ))}
          </div>
        </section>
        )}

        {/* 9. Pricing */}
        {page === 'pricing' && (
        <section className="relative border-t border-line/5 py-32 overflow-hidden flex flex-col items-center">
          {/* 巨大的背景水印文字 */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-[1200px] text-center z-0 pointer-events-none px-4">
            <div className="text-6xl md:text-[8rem] font-black tracking-tighter leading-[0.85] opacity-20 pricing-watermark">
              数智课堂
            </div>
            <div className="text-4xl md:text-[5rem] font-bold text-ink/5 tracking-tight mt-4">
              你的专属教具库
            </div>
          </div>
          
          <div className="relative z-10 w-full max-w-[76rem] px-6">
            <div className="grid md:grid-cols-3 gap-6">
              {[
                { tier: "免费版", price: "Free", desc: "适合个人教师初次探索智慧课堂体验。", features: ["10 个高精度教具资源", "基础 AI 模型分类", "标准 3D 课堂展示", "Web 端访问支持"] },
                { tier: "标准版", price: "¥29/月", desc: "适合需要常规授课的教师和小团队教研组。", features: ["100 个高级教具资源", "AI 智能生成讲解词", "手势识别互动展示", "教具云端同步与分享"], highlight: true },
                { tier: "专业版", price: "¥99/月", desc: "专为学校、机构和全学科生态系统打造。", features: ["无限制教具存储空间", "高级语音/手势多模态互动", "课堂专注度大数据分析", "专属学校品牌定制支持"] }
              ].map((plan, i) => (
                <div key={i} className={`liquid-glass rounded-3xl p-8 flex flex-col transition-all duration-500 ${plan.highlight ? 'border-cyan/40 shadow-[0_0_30px_rgba(var(--theme-accent-rgb),0.1)] -translate-y-4' : 'border-line/10'}`}>
                  <div className={`text-sm font-bold ${plan.highlight ? 'text-cyan' : 'text-ink/60'} mb-2`}>{plan.tier}</div>
                  <div className="text-4xl font-bold text-ink mb-4">{plan.price}</div>
                  <div className="text-sm text-ink/50 mb-8 min-h-[40px] leading-relaxed">{plan.desc}</div>
                  <ul className="space-y-4 mb-10 flex-1">
                    {plan.features.map((f, j) => (
                      <li key={j} className="flex items-start gap-3 text-sm text-ink/80">
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${plan.highlight ? 'bg-cyan/20 text-cyan' : 'bg-white/10 text-ink'}`}>
                          <svg width="10" height="8" viewBox="0 0 12 10" fill="none"><path d="M1 5L4.5 8.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                        {f}
                      </li>
                    ))}
                  </ul>
                  <button className={`w-full py-3.5 rounded-xl font-bold text-sm transition-colors ${plan.highlight ? 'bg-white text-black hover:bg-white/90' : 'bg-white/5 text-ink hover:bg-white/10 border border-line/10'}`}>
                    选择计划
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
        )}

        {page === 'docs' && (
          <section className="max-w-[76rem] mx-auto px-6 py-20 border-t border-line/5">
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
              {[
                { icon: BookOpen, title: '快速开始', description: '完成登录、创建教具库，并开始你的第一场 3D 课堂演示。', meta: '约 5 分钟',
                  sections: [
                    { kind: 'steps', title: '三步上手', items: [
                      '选择身份：教师使用 **"用户"标签页**，管理员使用 **"管理员"标签页**。',
                      '进入课堂：登录后点击左侧"教具库"→ 选择一个已有的 3D 教具（心脏、大脑、肺等）。',
                      '开始互动：点击右侧"开始课堂"，启用摄像头后即可使用手势和语音控制模型。',
                    ]},
                    { kind: 'callout', tone: 'tip', text: '首次进入建议用 **Edge 浏览器**（系统级语音识别效果最佳），确保摄像头已授权。' },
                  ]},
                { icon: Box, title: '3D 教具指南', description: '了解模型导入、分类、高亮和拆解的完整流程。', meta: '教具管理',
                  sections: [
                    { kind: 'bullets', title: '模型导入', items: [
                      '**支持格式**：GLB / GLTF（推荐）、FBX。建议单文件 GLB，自带材质贴图。',
                      '**导入入口**：管理员后台 → "教具管理" → "上传新模型"。',
                      '**校验提示**：导入后系统自动检查顶点数和材质，低于 500 面可能导致拆解卡顿。',
                    ]},
                    { kind: 'bullets', title: '分类与打标', items: [
                      '按学科归入：**生物**（心脏/大脑/肺/肝/肾）、**化学**（分子结构）、**物理**（力学/光学）。',
                      '给模型打上"解剖结构"标签后，进入课堂会自动启用拆解面板。',
                    ]},
                    { kind: 'callout', tone: 'warn', text: '⚠️ 只有包含**多个独立 Mesh** 的模型才能拆解。单一 Mesh 的模型只能旋转/缩放/高亮，无法拆成零件。' },
                    { kind: 'bullets', title: '课堂内操作', items: [
                      '**高亮**：语音"打开 XX 模型"或点击左侧面板 → 模型对应部分持续发光。',
                      '**拆解**：双手捏合 / 单手捏合 → 部件沿法线方向飞散。',
                    ]},
                  ]},
                { icon: Hand, title: '空间手势操作', description: '掌握旋转、缩放与模型交互手势，并排查摄像头识别问题。', meta: '互动控制',
                  sections: [
                    { kind: 'callout', tone: 'warn', text: '❗ 单手模式优先。双手模式下右手负责旋转、左手负责缩放，拆解双手均可触发。' },
                    { kind: 'table', title: '单手模式 · Single Hand Mode',
                      headers: ['操作', '手势', 'English'],
                      rows: [
                        ['旋转', '食指中指伸直贴合控制旋转，其余手指握拳闭合', 'spin / rotate'],
                        ['缩放', '拇指食指靠近缩小 | 张开放大，其余手指握拳闭合', 'big / zoom in · small / zoom out'],
                        ['拆解', '拇指食指抓取部位进行拆解，其余手指伸直', 'pinch → explode'],
                      ],
                    },
                    { kind: 'table', title: '双手模式 · Dual Hand Mode',
                      headers: ['部位', '操作', '手势', 'English'],
                      rows: [
                        ['右手', '旋转', '食指中指伸直贴合控制旋转，其余手指握拳闭合', 'spin / rotate'],
                        ['左手', '缩放', '拇指食指靠近缩小 | 张开放大，其余手指握拳闭合', 'big / zoom in · small / zoom out'],
                        ['双手均可', '拆解', '拇指食指抓取部位进行拆解，其余手指伸直', 'pinch → explode'],
                      ],
                    },
                    { kind: 'bullets', title: '常见问题排查', items: [
                      '手势不识别 → 检查光线充足、背景简洁、整只手在画面内。',
                      '旋转不流畅 → 食指和中指并拢贴紧，滑动速度均匀不要太快。',
                      '拆解没反应 → 确认当前模型支持拆解（多 Mesh），或尝试在"设置"里切换单/双手模式。',
                      '课堂内同时支持语音指令：**放大 / 缩小 / 转圈 / 停止旋转**。',
                    ]},
                  ]},
                { icon: Mic, title: '语音与 AI 助教', description: '配置语音交互，生成讲解词、课堂问题与追问回答。', meta: 'AI 助教',
                  sections: [
                    { kind: 'bullets', title: '启用语音', items: [
                      '进入课堂后，点击左侧 🎤 图标启用（首次需授权麦克风）。',
                      '系统默认使用 Edge / Chrome 的 Web Speech API，无需额外安装插件。',
                    ]},
                    { kind: 'bullets', title: 'AI 生成的 5 道选择题（示例）', items: [
                      '**第 1 题**：心脏中连接主动脉的是？A.左心室 B.右心室 C.左心房 D.右心房',
                      '**第 2 题**：下列哪项是左心房与左心室之间的瓣膜？A.肺动脉瓣 B.二尖瓣 C.三尖瓣 D.主动脉瓣',
                      '**第 3 题**：体循环的起始点是？A.右心房 B.右心室 C.左心房 D.左心室',
                      '**第 4 题**：肺循环中血液流经的顺序是？A.右心室→肺动脉→肺部→肺静脉→左心房 B.左心室→主动脉→全身→上下腔静脉→右心房 C.右心房→肺动脉→肺静脉→左心室 D.左心房→肺静脉→肺部→肺动脉→右心室',
                      '**第 5 题**：心脏四腔中壁最厚的是？A.左心房 B.左心室 C.右心房 D.右心室',
                    ]},
                    { kind: 'bullets', title: '完整课堂流程示例（中文版）', items: [
                      '**① 教师开场**：语音"开始今天的心脏解剖课"，AI 生成开场讲解词。',
                      '**② 模型展示**：语音"展示心脏"，模型自动居中；语音"拆解"，部件飞散。',
                      '**③ 互动讲解**：语音"这是左心室"，对应部位高亮，AI 同步讲解左心室功能。',
                      '**④ 提问**：语音"出题"，AI 立即生成 5 道选择题并显示在学生端。',
                      '**⑤ 追问**：语音"为什么"，AI 基于学生答案的正确率生成追问讲解。',
                      '**⑥ 下课**：语音"下课"，系统保存本次课堂的操作日志和学习记忆。',
                    ]},
                  ]},
                { icon: BarChart2, title: '课堂数据', description: '查看互动记录与学习反馈，用数据帮助下一次备课。', meta: '教学分析',
                  sections: [
                    { kind: 'bullets', title: '系统记录什么', items: [
                      '**操作日志**：用户登录/退出、模型切换、小智对话、手势操作事件的语义化日志。',
                      '**学习记忆**：课堂会话、保存的知识点消息、个性化学习设置。',
                      '**错题本**：学生答错的题目和选项记录，便于课后复习。',
                      '**用户反馈**：评分、场景标签、功能勾选和自由文字描述。',
                    ]},
                    { kind: 'bullets', title: '查看与导出', items: [
                      '**管理员后台**：管理员账号登录后，可查看用户操作日志和课堂行为记录。',
                      '**反馈管理**：管理员后台支持查看所有用户反馈，含评分统计和功能分布。',
                    ]},
                    { kind: 'bullets', title: '学生与教师写反馈', items: [
                      '**提交入口**：课堂右上角点 💬 图标，弹出反馈表单。',
                      '**评分**：1–5 星整体打分，系统自动统计平均评分和分布桶。',
                      '**场景标签**：选择反馈所属场景（手势 / 语音 / 模型清晰度 / 课堂体验 / 其他）。',
                      '**功能勾选**：多选框勾选表现好/不好的功能点，帮助我们定位。',
                      '**补充文字**：自由描述具体问题或建议，可附带图片截图（最多 3 张）。',
                      '**管理员后台**：管理员账号登录后，左侧"反馈管理"Tab 可查看所有反馈，含统计图表和逐条详情。',
                    ]},
                  ]},
                { icon: Download, title: '部署与设备', description: '查看浏览器、摄像头及学校网络环境建议。', meta: '环境配置',
                  sections: [
                    { kind: 'table', title: '浏览器支持',
                      headers: ['浏览器', '版本', '说明'],
                      rows: [
                        ['Microsoft Edge', '115+', '🏆 官方首选，系统级语音识别效果最佳'],
                        ['Google Chrome', '115+', '稳定，WebGL 和手势识别兼容性好'],
                        ['Safari', '17+', 'macOS/iPadOS 可用，部分高级手势有限'],
                        ['Firefox', '118+', '基本支持，语音识别需要额外配置'],
                      ],
                    },
                    { kind: 'bullets', title: '硬件建议', items: [
                      '**摄像头**：1080p（推荐 4K），放在屏幕正上方，距离 50–80cm。',
                      '**GPU**：集成显卡即可（Intel UHD / AMD Radeon / Apple M 系列），独立显卡体验更流畅。',
                      '**麦克风**：内置或 3.5mm 外接，距离嘴巴 30cm 以内，避免回声。',
                    ]},
                    { kind: 'callout', tone: 'tip', text: '📌 趁热打铁：通过管理员后台查看操作日志和用户反馈，及时了解课堂互动情况并调整教学方式。' },
                    { kind: 'bullets', title: '快速部署', items: [
                      '学校 IT 管理员运行 `scripts/deploy.py`，自动安装依赖 + 配置 MySQL。',
                      '内网环境下所有教室浏览器访问同一 URL 即可，支持多教室同时上课。',
                      '日常维护命令：`npm start`（开发模式），`pm2 start server/index.js`（生产模式）。',
                    ]},
                  ]},
              ].map((doc) => (
                <button type="button" key={doc.title} onClick={() => setSelectedDoc(doc)} className="liquid-glass rounded-2xl p-7 min-h-56 flex flex-col text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/70">
                  <div className="w-11 h-11 rounded-xl bg-cyan/10 border border-cyan/20 flex items-center justify-center">
                    <doc.icon className="w-5 h-5 text-cyan" />
                  </div>
                  <h2 className="mt-6 text-xl font-bold group-hover:text-cyan transition-colors">{doc.title}</h2>
                  <p className="mt-3 text-sm leading-relaxed text-ink/55 flex-1">{doc.description}</p>
                  <div className="mt-6 flex items-center justify-between text-xs text-ink/40">
                    <span>{doc.meta}</span>
                    <ArrowUpRight className="w-4 h-4" />
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-10 liquid-glass rounded-2xl p-7 md:p-9 flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div>
                <h2 className="text-xl font-bold">准备开始实际操作？</h2>
                <p className="mt-2 text-sm text-ink/55">进入平台后，可以直接使用示例教具熟悉完整课堂流程。</p>
              </div>
              <button onClick={handleEnterClick} className="shrink-0 rounded-full bg-white text-black px-7 py-3 text-sm font-bold hover:bg-white/90 transition-colors">
                进入数智课堂
              </button>
            </div>
          </section>
        )}

        {selectedDoc && (
          <div className="fixed inset-0 z-[80] grid place-items-center bg-black/65 px-5 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedDoc(null); }}>
            <section role="dialog" aria-modal="true" aria-labelledby="doc-dialog-title" className="w-full max-w-3xl rounded-2xl border border-line/15 bg-[var(--theme-bg-soft)] px-7 pb-7 pt-0 shadow-2xl max-h-[85vh] overflow-y-auto">
              <div className="flex items-start justify-between gap-5 pt-7 pb-4">
                <div><div className="text-xs font-bold uppercase tracking-widest text-cyan">{selectedDoc.meta}</div><h2 id="doc-dialog-title" className="mt-2 text-2xl font-black text-ink">{selectedDoc.title}</h2></div>
                <button type="button" onClick={() => setSelectedDoc(null)} aria-label="关闭说明" title="关闭说明" className="grid h-9 w-9 place-items-center rounded-full border border-line/10 text-ink/60 hover:bg-white/10 hover:text-ink"><X size={17} /></button>
              </div>
              <p className="text-sm leading-7 text-ink/70">{selectedDoc.description}</p>

              <div className="mt-6 space-y-6">
                {selectedDoc.sections?.map((sec, idx) => {
                  if (sec.kind === 'callout') {
                    const toneStyles = {
                      info: 'border-cyan/25 bg-cyan/5 text-ink/70',
                      tip: 'border-emerald/25 bg-emerald/5 text-ink/70',
                      warn: 'border-amber/25 bg-amber/5 text-ink/70',
                    }[sec.tone || 'info'];
                    return <div key={idx} className={`rounded-xl border px-4 py-3 text-xs leading-6 ${toneStyles}`}>{sec.text}</div>;
                  }
                  if (sec.kind === 'steps' || sec.kind === 'bullets') {
                    const isSteps = sec.kind === 'steps';
                    return (
                      <div key={idx}>
                        {sec.title && <h3 className="text-sm font-bold text-cyan mb-3">{sec.title}</h3>}
                        <ul className="space-y-2.5">
                          {sec.items?.map((item, i) => (
                            <li key={i} className="flex gap-3 text-[13px] leading-6 text-ink/75">
                              {isSteps && <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan/20 text-cyan text-[11px] font-black grid place-items-center mt-0.5">{i + 1}</span>}
                              {!isSteps && <span className="text-cyan mt-0.5">•</span>}
                              <span dangerouslySetInnerHTML={{ __html: item.replace(/\*\*(.+?)\*\*/g, '<strong class="text-ink">$1</strong>') }} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  }
                  if (sec.kind === 'table') {
                    return (
                      <div key={idx}>
                        {sec.title && <h3 className="text-sm font-bold text-cyan mb-3">{sec.title}</h3>}
                        <div className="overflow-x-auto rounded-xl border border-line/15">
                          <table className="w-full text-[12px]">
                            <thead className="bg-cyan/10">
                              <tr>{sec.headers?.map((h, i) => <th key={i} className="text-left font-bold text-cyan px-3 py-2.5 border-b border-line/15">{h}</th>)}</tr>
                            </thead>
                            <tbody>
                              {sec.rows?.map((row, ri) => (
                                <tr key={ri} className={ri % 2 === 1 ? 'bg-white/5' : ''}>
                                  {row.map((cell, ci) => <td key={ci} className="px-3 py-2 border-b border-line/10 text-ink/70">{cell}</td>)}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })}
              </div>

              <div className="mt-6 flex justify-end"><button type="button" onClick={() => setSelectedDoc(null)} className="rounded-lg bg-white px-4 py-2 text-sm font-bold text-black hover:bg-white/90">关闭</button></div>
            </section>
          </div>
        )}

        {page === 'join' && (
        <>
        <section className="max-w-[76rem] mx-auto px-6 py-20 border-t border-line/5">
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { icon: Users, title: '学校与教研团队', description: '共同设计学科示范课、校本资源库与教师培训方案。' },
              { icon: BookOpen, title: '教师与内容创作者', description: '把优秀教学经验转化为可复用的 3D 互动课程内容。' },
              { icon: Cpu, title: '技术与生态伙伴', description: '围绕硬件、模型资源和教育场景建设开放合作生态。' },
            ].map((item) => (
              <div key={item.title} className="liquid-glass rounded-2xl p-8 text-center">
                <div className="mx-auto w-12 h-12 rounded-xl bg-cyan/10 border border-cyan/20 flex items-center justify-center">
                  <item.icon className="w-6 h-6 text-cyan" />
                </div>
                <h2 className="mt-6 text-lg font-bold">{item.title}</h2>
                <p className="mt-3 text-sm text-ink/55 leading-relaxed">{item.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 10. Final CTA */}
        <section className="max-w-[64rem] mx-auto px-6 py-24 pb-32">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
            className="liquid-glass relative overflow-hidden rounded-[2.5rem] p-12 md:p-20 text-center border border-line/20 shadow-[0_30px_60px_rgba(0,0,0,0.8)]"
          >
            <div className="absolute inset-0 bg-gradient-to-b from-cyan/10 to-transparent opacity-50" />
            
            <h2 className="text-4xl md:text-[4rem] font-bold tracking-tight leading-[1.05] relative z-10 text-ink drop-shadow-2xl">
              把你的教育经验，<br/>
              带进未来课堂。
            </h2>
            <p className="mt-8 text-ink/70 max-w-lg mx-auto text-base md:text-lg leading-relaxed relative z-10">
              无论你来自学校、教研团队还是技术生态，我们都期待与你一起探索更直观、更生动的教学方式。
            </p>
            <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4 relative z-10">
              <button onClick={() => onNavigate('solutions')} className="w-full sm:w-auto flex items-center justify-center gap-2 rounded-full bg-white text-black text-sm font-bold px-8 py-4 transition-all hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(255,255,255,0.4)]">
                查看教学辅助
              </button>
              <button onClick={handleEnterClick} className="w-full sm:w-auto flex items-center justify-center gap-2 rounded-full border border-line/20 text-ink text-sm font-bold px-8 py-4 hover:bg-white/10 transition-colors">
                立即体验产品
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        </section>
        </>
        )}
        
        <footer className={`${page === 'home' ? 'py-4' : 'py-8'} mt-auto border-t border-line/5 text-center flex flex-col items-center`}>
          <a href="/" onClick={navigateTo('home')} aria-label="返回首页"><LogoMark /></a>
          <div className={`${page === 'home' ? 'mt-2' : 'mt-4'} text-xs text-ink/40 font-medium tracking-wide`}>
            &copy; 2026 数智课堂 · AI 互动教学平台. All rights reserved.
          </div>
        </footer>
      </div>
    </div>
  );
}
